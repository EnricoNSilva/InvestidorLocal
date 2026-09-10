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
from app.services.portfolio import processar_transacao, recalcular_posicoes_carteira
from app.services.ingestion.parser_b3 import inferir_tipo_ativo, to_decimal

def normalize_col(col: str) -> str:
    """Remove acentuações e padroniza string para comparação robusta."""
    return "".join(c for c in unicodedata.normalize("NFKD", str(col)) if not unicodedata.combining(c)).lower().strip()

def processar_planilha_movimentacao_b3(
    db: Session,
    file_content: Union[BinaryIO, bytes],
    carteira_id: Optional[int] = 1,
) -> Dict[str, Union[List[Transacao], List[str]]]:
    """
    Lê a planilha de 'Movimentação' da B3 via Pandas.
    Filtra rigorosamente para considerar APENAS:
      1. 'Transferência' / 'Cessão' / 'Doação': saldo herdado inicial (custo zero se não informado).
      2. 'Bonificação em Ativos': incrementa quantidade com custo zero.
      3. 'Direito de Subscrição': incrementa quantidade com custo zero.
      4. 'Direitos de Subscrição - Não Exercido': subtrai quantidade com custo zero.
    IGNORA expressamente:
      - 'Transferência - Liquidação' (liquidações de pregão que vêm da planilha de Negociação).
      - Proventos financeiros em dinheiro (dividendos, JCP, rendimentos).
    Ao final, executa recalcular_posicoes_carteira() para consolidação integral e precisa.
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

    # Trata data de forma flexível (suporta ISO e DD/MM/YYYY)
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

    # Ordena do passado para o presente
    df = df.sort_values("_data_dt").reset_index(drop=True)

    transacoes_criadas: List[Transacao] = []
    avisos: List[str] = []

    for _, row in df.iterrows():
        mov_str = str(row.get(col_map.get("movimentacao", ""), ""))
        norm_mov = normalize_col(mov_str)

        # 1. Ignora categoricamente liquidações de pregão para não duplicar com o extrato de Negociação
        if "liquida" in norm_mov:
            continue

        # 2. Ignora proventos financeiros em dinheiro
        if any(p in norm_mov for p in ["dividendo", "juros sobre", "rendimento", "amortizacao"]):
            continue

        # 3. Classifica o tipo de evento
        sentido_str = normalize_col(row.get(col_map.get("entrada_saida", ""), ""))
        eh_debito = "debito" in sentido_str or "saida" in sentido_str

        if "nao exercido" in norm_mov:
            tipo_operacao = TipoOperacao.DIREITO_SUBSCRICAO_EXPIRADO
            preco_unitario = Decimal("0.0")
        elif "bonifica" in norm_mov:
            if eh_debito:
                continue
            tipo_operacao = TipoOperacao.BONIFICACAO
            preco_unitario = Decimal("0.0")
        elif "direito" in norm_mov or "subscri" in norm_mov:
            if eh_debito:
                continue
            tipo_operacao = TipoOperacao.DIREITO_SUBSCRICAO
            preco_unitario = Decimal("0.0")
        elif any(t in norm_mov for t in ["transferencia", "cessao", "doacao", "deposito", "custodia"]):
            if eh_debito:
                continue
            tipo_operacao = TipoOperacao.TRANSFERENCIA_ENTRADA
            # Tenta ler preço caso explicitado, senão custo zero (sem fallback de R$ 1.0)
            preco_unitario = Decimal("0.0")
            if "preco" in col_map and pd.notna(row[col_map["preco"]]):
                p_dec = to_decimal(row[col_map["preco"]])
                if p_dec > Decimal("0.0"):
                    preco_unitario = p_dec
            if preco_unitario <= Decimal("0.0") and "valor_total" in col_map and pd.notna(row[col_map["valor_total"]]):
                v_dec = to_decimal(row[col_map["valor_total"]])
                q_dec = to_decimal(row[col_map["quantidade"]])
                if v_dec > Decimal("0.0") and q_dec > Decimal("0.0"):
                    preco_unitario = v_dec / q_dec
        else:
            # Qualquer outro evento não afeta custódia de ativos
            continue

        ticker_raw = str(row[col_map["ticker"]]).strip().upper()
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

        # Garante a existência do ativo
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
            tipo_operacao=tipo_operacao,
            quantidade=quantidade,
            preco_unitario=preco_unitario,
            taxas=Decimal("0.0"),
            moeda="BRL",
            moeda_taxa="BRL",
            ptax_utilizada=None
        )

        tx = processar_transacao(db=db, transacao_in=transacao_in)
        transacoes_criadas.append(tx)

    # Reavalia e consolida todas as posições da carteira de forma idempotente
    recalcular_posicoes_carteira(db=db, carteira_id=carteira_id or 1)

    return {
        "transacoes": transacoes_criadas,
        "avisos": avisos
    }
