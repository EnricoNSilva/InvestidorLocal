import io
import re
import unicodedata
from datetime import datetime, timezone
from decimal import Decimal
from typing import BinaryIO, Dict, List, Optional, Union
import pandas as pd
from sqlalchemy.orm import Session

from app.models.ativo import Ativo
from app.models.enums import TipoAtivo, TipoOperacao
from app.models.transacao import Transacao
from app.schemas.transacao import TransacaoCreate
from app.services.portfolio import processar_transacao
from app.services.ingestion.parser_b3 import inferir_tipo_ativo, to_decimal

def normalize_col(col: str) -> str:
    """Remove acentuações e padroniza string para comparação robusta."""
    return "".join(c for c in unicodedata.normalize("NFKD", str(col)) if not unicodedata.combining(c)).lower().strip()

# Termos que identificam eventos genuínos de custódia inicial / externa / bonificação
TERMOS_CUSTODIA = [
    "transferencia",
    "doacao",
    "cessao",
    "bonificacao",
    "deposito",
    "custodia"
]

def eh_transferencia_custodia_valida(tipo_mov: str) -> bool:
    """
    Verifica se a movimentação corresponde a uma entrada ou transferência de custódia real.
    CRÍTICO: Exclui expressamente 'Liquidação' / 'Transferência - Liquidação',
    pois estas são liquidações de compras regulares do pregão que já constam na planilha de Negociação!
    Também exclui proventos financeiros em dinheiro (dividendos, JCP, rendimentos) e direitos não exercidos.
    """
    norm = normalize_col(tipo_mov)
    
    # 1. Rejeita liquidação de pregão (para não duplicar com negociacao.xlsx)
    if "liquida" in norm:
        return False

    # 2. Rejeita proventos em dinheiro
    if any(p in norm for p in ["dividendo", "juros sobre", "rendimento", "amortizacao", "direito"]):
        return False

    # 3. Aceita apenas eventos genuínos de custódia
    return any(termo in norm for termo in TERMOS_CUSTODIA)

def processar_planilha_movimentacao_b3(
    db: Session,
    file_content: Union[BinaryIO, bytes],
    carteira_id: Optional[int] = 1,
    preco_fallback_padrao: Decimal = Decimal("1.0")
) -> Dict[str, Union[List[Transacao], List[str]]]:
    """
    Lê o arquivo de 'Movimentação' da B3 via Pandas.
    Filtra linhas cujo tipo contenha termos como 'Transferência', 'Doação', 'Cessão' ou 'Bonificação em Ativos'.
    Ignora liquidações de pregão ('Transferência - Liquidação') para evitar duplicidade com o extrato de Negociação.
    Extrai: Data, Ticker (normalizando fracionários terminados em 'F'), Quantidade e Preço/Valor.
    Caso o preço unitário venha zerado na planilha da B3, define um fallback de R$ 1.0 ou utiliza o preço presente.
    Cria o ativo caso não exista e registra como TRANSFERENCIA_ENTRADA via processar_transacao.
    """
    if isinstance(file_content, bytes):
        file_content = io.BytesIO(file_content)

    df = pd.read_excel(file_content)

    col_map: Dict[str, str] = {}
    for col in df.columns:
        norm = normalize_col(col)
        if "data" in norm and "liquidacao" not in norm:
            col_map["data"] = col
        elif "movimenta" in norm or "tipo" in norm or "evento" in norm or "descri" in norm:
            if "ativo" not in norm and "produto" not in norm:
                col_map["movimentacao"] = col
        elif "codigo" in norm or "ticker" in norm or "produto" in norm or "ativo" in norm:
            if "tipo" not in norm:
                col_map["ticker"] = col
        elif "quantidade" in norm or "qtd" in norm:
            col_map["quantidade"] = col
        elif "preco" in norm or "valor unit" in norm or "cotacao" in norm:
            col_map["preco"] = col
        elif "entrada" in norm or "saida" in norm or "sentido" in norm:
            col_map["entrada_saida"] = col
        elif "valor total" in norm or "operacao" in norm or "valor da op" in norm:
            col_map["valor_total"] = col

    if "ticker" not in col_map or "quantidade" not in col_map:
        raise ValueError(
            f"Formato da planilha de Movimentação B3 inválido. Colunas obrigatórias 'Código/Produto' e 'Quantidade' não localizadas: {list(df.columns)}"
        )

    # Trata data
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

    df = df.sort_values("_data_dt").reset_index(drop=True)

    transacoes_criadas: List[Transacao] = []
    avisos: List[str] = []

    for _, row in df.iterrows():
        # Filtro de sentido: ignora Débito/Saída
        if "entrada_saida" in col_map:
            sentido_str = normalize_col(row[col_map["entrada_saida"]])
            if "debito" in sentido_str or "saida" in sentido_str:
                continue

        # Filtro estrito de transferência de custódia real
        if "movimentacao" in col_map:
            mov_str = str(row[col_map["movimentacao"]])
            if not eh_transferencia_custodia_valida(mov_str):
                continue

        ticker_raw = str(row[col_map["ticker"]]).strip().upper()
        # Se contiver descrição longa (ex: 'PETR4 - PETROLEO BRASILEIRO'), extrai o ticker inicial
        ticker_part = ticker_raw.split()[0].replace("-", "").strip() if " " in ticker_raw else ticker_raw
        if len(ticker_part) == 6 and ticker_part.endswith("F") and ticker_part[:5].isalnum():
            ticker = ticker_part[:-1]
        else:
            ticker = ticker_part

        if not ticker or ticker == "NAN":
            continue

        quantidade = to_decimal(row[col_map["quantidade"]])
        if quantidade <= Decimal("0"):
            continue

        # Extração e fallback de preço unitário
        preco_unitario = Decimal("0")
        if "preco" in col_map and pd.notna(row[col_map["preco"]]):
            preco_unitario = to_decimal(row[col_map["preco"]])

        # Se veio zerado, tenta obter pelo valor_total / quantidade
        if preco_unitario <= Decimal("0") and "valor_total" in col_map and pd.notna(row[col_map["valor_total"]]):
            val_total = to_decimal(row[col_map["valor_total"]])
            if val_total > Decimal("0"):
                preco_unitario = val_total / quantidade

        # Fallback padrão caso permaneça zero (ex: transferência entre custódias sem custo especificado)
        if preco_unitario <= Decimal("0"):
            preco_unitario = preco_fallback_padrao
            avisos.append(f"Ativo {ticker}: Preço unitário zerado na movimentação. Adotado fallback de R$ {preco_fallback_padrao}.")

        # 1. Garante a existência do ativo
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
            carteira_id=carteira_id or 1,
            ativo_id=ativo.id,
            data_hora=data_hora,
            tipo_operacao=TipoOperacao.TRANSFERENCIA_ENTRADA,
            quantidade=quantidade,
            preco_unitario=preco_unitario,
            taxas=Decimal("0.0"),
            moeda="BRL",
            moeda_taxa="BRL",
            ptax_utilizada=None
        )

        tx = processar_transacao(db=db, transacao_in=transacao_in)
        transacoes_criadas.append(tx)

    return {
        "transacoes": transacoes_criadas,
        "avisos": avisos
    }
