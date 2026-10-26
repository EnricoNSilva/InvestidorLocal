import io
import re
import unicodedata
from datetime import datetime, timezone
from decimal import Decimal
from typing import BinaryIO, Dict, List, Optional, Tuple, Union
import pandas as pd
from sqlalchemy.orm import Session

from app.models.ativo import Ativo
from app.models.enums import TipoAtivo, TipoOperacao, ProdutoRendaFixa
from app.models.transacao import Transacao
from app.schemas.transacao import TransacaoCreate
from app.services.portfolio import processar_transacao, PortfolioError, recalcular_posicoes_carteira
from app.services.ingestion.classificador_renda_fixa import classificar_renda_fixa
from app.services.classificador_setor import obter_setor_padrao

ANO_E_VENCIMENTO_NEGOCIACAO = False

def inferir_tipo_ativo(ticker: str) -> TipoAtivo:
    if classificar_renda_fixa(ticker, ano_e_vencimento=ANO_E_VENCIMENTO_NEGOCIACAO):
        return TipoAtivo.RendaFixa
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

def normalize_col(col: str) -> str:
    """Remove acentuações e padroniza string para comparação robusta de colunas."""
    return "".join(c for c in unicodedata.normalize("NFKD", str(col)) if not unicodedata.combining(c)).lower().strip()

def processar_planilha_b3(
    db: Session,
    file_content: Union[BinaryIO, bytes],
    carteira_id: Optional[int] = 1
) -> Tuple[List[Transacao], List[str]]:
    """
    Processa o extrato de Negociação da B3 (compras e vendas regulares de ações/FIIs).
    Normaliza nomes de colunas, ordena cronologicamente com prioridade para compras no mesmo dia,
    e efetua rollback por linha com registro de pendências em caso de inconsistência de saldo.
    """
    if isinstance(file_content, bytes):
        file_content = io.BytesIO(file_content)

    df = pd.read_excel(file_content)

    col_map: Dict[str, str] = {}
    for col in df.columns:
        norm = normalize_col(col)
        if "data" in norm and ("negoc" in norm or "opera" in norm or "pregao" in norm or norm == "data"):
            col_map["data"] = col
        elif ("movimenta" in norm or "tipo" in norm or norm in ["operacao", "c/v"]) and "ativo" not in norm and "codigo" not in norm and "valor" not in norm and "mercado" not in norm:
            col_map["operacao"] = col
        elif "codigo" in norm or "ticker" in norm or "ativo" in norm:
            if "tipo" not in norm:
                col_map["ticker"] = col
        elif "quantidade" in norm or "qtd" in norm:
            col_map["quantidade"] = col
        elif "preco" in norm or "valor unit" in norm or "cotacao" in norm:
            col_map["preco"] = col
        elif "taxa" in norm or "custo" in norm or "emolumento" in norm or "corretagem" in norm:
            col_map["taxas"] = col

    # Fallback para coluna de data se não tiver casado com os termos específicos
    if "data" not in col_map:
        for col in df.columns:
            norm = normalize_col(col)
            if "data" in norm and "vencimento" not in norm and "liquidacao" not in norm:
                col_map["data"] = col
                break

    if "ticker" not in col_map or "quantidade" not in col_map or "preco" not in col_map:
        raise ValueError(f"Formato da planilha B3 inválido ou colunas obrigatórias não encontradas: {list(df.columns)}")

    if "data" in col_map:
        def _parse_dt(v):
            if pd.isna(v):
                return pd.NaT
            if isinstance(v, (pd.Timestamp, datetime)):
                return v
            s = str(v).strip()
            if re.match(r"^\d{4}-\d{2}-\d{2}", s):
                return pd.to_datetime(s, errors="coerce")
            return pd.to_datetime(s, dayfirst=True, format="mixed", errors="coerce")

        df["_data_dt"] = df[col_map["data"]].apply(_parse_dt)
    else:
        df["_data_dt"] = datetime.now(timezone.utc)

    # Identifica o tipo de operação para ordenar compras antes de vendas na mesma data
    def identificar_operacao(val) -> TipoOperacao:
        norm_op = normalize_col(val)
        if "venda" in norm_op or "sell" in norm_op or norm_op == "v":
            return TipoOperacao.SELL
        return TipoOperacao.BUY

    operacao_col = col_map.get("operacao")
    if operacao_col:
        df["_tipo_op"] = df[operacao_col].apply(identificar_operacao)
    else:
        df["_tipo_op"] = TipoOperacao.BUY

    # Prioridade 0 para BUY e 1 para SELL, garantindo que aquisições no mesmo dia venham antes
    df["_priority"] = df["_tipo_op"].apply(lambda op: 0 if op == TipoOperacao.BUY else 1)
    df = df.sort_values(["_data_dt", "_priority"]).reset_index(drop=True)

    transacoes_criadas: List[Transacao] = []
    pendencias: List[str] = []

    for _, row in df.iterrows():
        raw_val = str(row[col_map["ticker"]]).strip()
        info_rf = classificar_renda_fixa(raw_val, ano_e_vencimento=ANO_E_VENCIMENTO_NEGOCIACAO)
        if info_rf:
            ticker = info_rf.ticker
            nome_ativo = info_rf.nome
            tipo_ativo = TipoAtivo.RendaFixa
        else:
            raw_ticker = raw_val.split()[0].replace("-", "").strip().upper()
            if len(raw_ticker) == 6 and raw_ticker.endswith("F") and raw_ticker[:5].isalnum():
                ticker = raw_ticker[:-1]
            else:
                ticker = raw_ticker
            nome_ativo = f"Ativo B3 {ticker}"
            tipo_ativo = inferir_tipo_ativo(ticker)

        tipo_operacao = row["_tipo_op"]
        quantidade = to_decimal(row[col_map["quantidade"]])
        preco_unitario = to_decimal(row[col_map["preco"]])
        taxas = to_decimal(row.get(col_map.get("taxas", ""), 0)) if "taxas" in col_map else Decimal("0.0")

        if quantidade <= 0 or preco_unitario <= 0:
            continue

        ativo = db.query(Ativo).filter(Ativo.ticker == ticker).first()
        if not ativo:
            ativo = Ativo(
                ticker=ticker,
                nome=nome_ativo,
                tipo=tipo_ativo,
                setor=obter_setor_padrao(ticker, tipo_ativo)
            )
            db.add(ativo)
            db.flush()

        if info_rf and not ativo.detalhes_rf:
            from datetime import date
            from app.models.renda_fixa import DetalhesRendaFixa
            venc_date = info_rf.data_vencimento
            if not venc_date and info_rf.ano_vencimento:
                if info_rf.produto in (ProdutoRendaFixa.TESOURO_RENDA_MAIS, ProdutoRendaFixa.TESOURO_EDUCA_MAIS):
                    venc_date = date(info_rf.ano_vencimento, 12, 15)
                else:
                    venc_date = date(info_rf.ano_vencimento, 1, 1)

            dia_pgto = 15 if info_rf.produto in (ProdutoRendaFixa.TESOURO_RENDA_MAIS, ProdutoRendaFixa.TESOURO_EDUCA_MAIS) else None
            emissor_final = info_rf.emissor or ("Tesouro Nacional" if info_rf.produto.value.startswith("TESOURO_") else "Emissor")

            detalhes = DetalhesRendaFixa(
                ativo_id=ativo.id,
                produto=info_rf.produto,
                indexador=info_rf.indexador,
                emissor=emissor_final,
                data_vencimento=venc_date,
                ano_conversao=info_rf.ano_conversao,
                num_parcelas=info_rf.num_parcelas,
                dia_pagamento=dia_pgto,
                isento_ir=info_rf.produto in (ProdutoRendaFixa.LCI, ProdutoRendaFixa.LCA),
                cobra_custodia_b3=info_rf.produto.value.startswith("TESOURO_"),
                codigo_mercado=info_rf.codigo_mercado,
            )
            db.add(detalhes)
            db.flush()

        data_hora = row["_data_dt"]
        if pd.isna(data_hora):
            data_hora = datetime.now(timezone.utc)
        elif hasattr(data_hora, "to_pydatetime"):
            data_hora = data_hora.to_pydatetime()

        transacao_in = TransacaoCreate(
            carteira_id=carteira_id or 1,
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

    recalcular_posicoes_carteira(db=db, carteira_id=carteira_id or 1)
    return transacoes_criadas, pendencias
