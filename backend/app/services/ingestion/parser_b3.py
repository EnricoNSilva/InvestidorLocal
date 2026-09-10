import io
import re
from datetime import datetime, timezone
from decimal import Decimal
from typing import BinaryIO, Dict, List, Tuple, Union
import pandas as pd
from sqlalchemy.orm import Session

from app.models.ativo import Ativo
from app.models.enums import TipoAtivo, TipoOperacao
from app.models.transacao import Transacao
from app.schemas.transacao import TransacaoCreate
from app.services.portfolio import processar_transacao, PortfolioError

def inferir_tipo_ativo(ticker: str) -> TipoAtivo:
    clean_ticker = ticker.strip().upper()
    if clean_ticker.endswith("11") or clean_ticker.endswith("12") or clean_ticker.endswith("13") or clean_ticker.endswith("14"):
        return TipoAtivo.FII
    match = re.search(r"[3456]$", clean_ticker)
    if match:
        return TipoAtivo.Acao
    return TipoAtivo.Acao

def to_decimal(val) -> Decimal:
    if val is None or pd.isna(val) or val == "":
        return Decimal("0.0")
    if isinstance(val, (int, str)):
        cleaned = str(val).strip().replace("R$", "").replace(" ", "")
        if cleaned in ("", "-", "--", "N/A", "NA", "NAN", "NONE", "null"):
            return Decimal("0.0")
        if "," in cleaned and "." in cleaned:
            cleaned = cleaned.replace(".", "").replace(",", ".")
        elif "," in cleaned:
            cleaned = cleaned.replace(",", ".")
        try:
            return Decimal(cleaned)
        except Exception:
            return Decimal("0.0")
    if isinstance(val, float):
        return Decimal(f"{val:.8f}".rstrip("0").rstrip(".") if "." in f"{val:.8f}" else f"{val:.8f}")
    try:
        return Decimal(str(val))
    except Exception:
        return Decimal("0.0")

def processar_planilha_b3(db: Session, file_content: Union[BinaryIO, bytes]) -> Tuple[List[Transacao], List[str]]:
    if isinstance(file_content, bytes):
        file_content = io.BytesIO(file_content)

    df = pd.read_excel(file_content)

    col_map = {}
    for col in df.columns:
        norm = str(col).strip().lower()
        if "data" in norm and ("negocia" in norm or "opera" in norm or norm == "data"):
            col_map["data"] = col
        elif "movimenta" in norm or "tipo" in norm or "compra" in norm or "venda" in norm:
            if "ativo" not in norm:
                col_map["operacao"] = col
        elif "código" in norm or "codigo" in norm or "ticker" in norm or "ativo" in norm:
            if "tipo" not in norm:
                col_map["ticker"] = col
        elif "quantidade" in norm or "qtd" in norm:
            col_map["quantidade"] = col
        elif "preço" in norm or "preco" in norm or "valor unit" in norm:
            col_map["preco"] = col
        elif "taxa" in norm or "custo" in norm or "emolumentos" in norm or "corretagem" in norm:
            col_map["taxas"] = col

    if "ticker" not in col_map or "quantidade" not in col_map or "preco" not in col_map:
        raise ValueError(f"Formato da planilha B3 inválido ou colunas obrigatórias não encontradas: {list(df.columns)}")

    if "data" in col_map:
        df["_data_dt"] = pd.to_datetime(df[col_map["data"]], dayfirst=True, format="mixed")
    else:
        df["_data_dt"] = datetime.now(timezone.utc)

    df = df.sort_values("_data_dt").reset_index(drop=True)

    transacoes_criadas: List[Transacao] = []
    pendencias: List[str] = []

    for _, row in df.iterrows():
        ticker_raw = str(row[col_map["ticker"]]).strip().upper()
        if len(ticker_raw) == 6 and ticker_raw.endswith("F") and ticker_raw[:5].isalnum():
            ticker = ticker_raw[:-1]
        else:
            ticker = ticker_raw

        tipo_op_str = str(row.get(col_map.get("operacao", ""), "")).strip().upper()
        if "COMPRA" in tipo_op_str or "BUY" in tipo_op_str or tipo_op_str == "C":
            tipo_operacao = TipoOperacao.BUY
        elif "VENDA" in tipo_op_str or "SELL" in tipo_op_str or tipo_op_str == "V":
            tipo_operacao = TipoOperacao.SELL
        else:
            tipo_operacao = TipoOperacao.BUY

        quantidade = to_decimal(row[col_map["quantidade"]])
        preco_unitario = to_decimal(row[col_map["preco"]])
        taxas = to_decimal(row.get(col_map.get("taxas", ""), 0)) if "taxas" in col_map else Decimal("0.0")

        if quantidade <= 0 or preco_unitario <= 0:
            continue

        ativo = db.query(Ativo).filter(Ativo.ticker == ticker).first()
        if not ativo:
            tipo_ativo = inferir_tipo_ativo(ticker)
            ativo = Ativo(
                ticker=ticker,
                nome=f"Ativo B3 {ticker}",
                tipo=tipo_ativo,
                setor=None
            )
            db.add(ativo)
            db.flush()

        data_hora = row["_data_dt"]
        if pd.isna(data_hora):
            data_hora = datetime.now(timezone.utc)
        elif hasattr(data_hora, "to_pydatetime"):
            data_hora = data_hora.to_pydatetime()

        transacao_in = TransacaoCreate(
            ativo_id=ativo.id,
            data_hora=data_hora,
            tipo_operacao=tipo_operacao,
            quantidade=quantidade,
            preco_unitario=preco_unitario,
            taxas=taxas,
            moeda="BRL",
            moeda_taxa="BRL",
            ptax_utilizada=None
        )

        try:
            tx = processar_transacao(db=db, transacao_in=transacao_in)
            transacoes_criadas.append(tx)
        except PortfolioError as p_err:
            db.rollback()
            pendencias.append(
                f"Operação {tipo_operacao.value} de {quantidade} {ticker} em {data_hora.strftime('%d/%m/%Y')}: {str(p_err)}"
            )

    return transacoes_criadas, pendencias
