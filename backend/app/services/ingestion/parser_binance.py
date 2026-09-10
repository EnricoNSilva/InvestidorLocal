import io
import json
import urllib.request
from datetime import datetime, date, timedelta, timezone
from decimal import Decimal, getcontext
from typing import BinaryIO, Dict, List, Optional, Union
import pandas as pd
from sqlalchemy.orm import Session

from app.models.ativo import Ativo
from app.models.enums import TipoAtivo, TipoOperacao
from app.models.transacao import Transacao
from app.schemas.transacao import TransacaoCreate
from app.services.portfolio import processar_transacao

getcontext().prec = 28

USD_STABLE_PAIRS = {"BTCUSDT", "BTCUSDC", "BTCBUSD", "BTCFDUSD"}

PTAX_CACHE: Dict[str, Decimal] = {}

def get_ptax_venda(date_obj: date) -> Decimal:
    date_str = date_obj.strftime("%Y-%m-%d")
    if date_str in PTAX_CACHE:
        return PTAX_CACHE[date_str]

    curr = date_obj
    for _ in range(7):
        formatted_date = curr.strftime("%m-%d-%Y")
        url = (
            f"https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/"
            f"CotacaoDolarDia(dataCotacao=@dataCotacao)?@dataCotacao='{formatted_date}'&$top=10&$format=json"
        )
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read().decode("utf-8"))
                values = data.get("value", [])
                if values:
                    cotacao_venda = Decimal(str(values[-1]["cotacaoVenda"]))
                    PTAX_CACHE[date_str] = cotacao_venda
                    return cotacao_venda
        except Exception:
            pass
        curr -= timedelta(days=1)

    fallback_rate = Decimal("5.0000")
    PTAX_CACHE[date_str] = fallback_rate
    return fallback_rate

def to_decimal(val) -> Decimal:
    if val is None or pd.isna(val) or val == "":
        return Decimal("0.0")
    if isinstance(val, (int, str)):
        return Decimal(str(val).strip().replace(",", "."))
    if isinstance(val, float):
        return Decimal(f"{val:.12f}".rstrip("0").rstrip(".") if "." in f"{val:.12f}" else f"{val:.12f}")
    return Decimal(str(val))

# Constantes de pares e moedas
STABLECOINS = {"USDT", "USDC", "FDUSD", "BUSD", "DAI"}

CRYPTO_NAMES = {
    "BTC": "Bitcoin",
    "ETH": "Ethereum",
    "SOL": "Solana",
    "USDT": "Tether USD",
    "USDC": "USD Coin",
    "FDUSD": "First Digital USD",
    "BUSD": "Binance USD",
    "DAI": "Dai",
    "AAVE": "Aave",
    "PENDLE": "Pendle",
    "ERA": "Caldera / Era",
    "BNB": "BNB",
    "ADA": "Cardano",
    "XRP": "XRP",
    "DOT": "Polkadot",
    "AVAX": "Avalanche",
    "LINK": "Chainlink",
}

def parse_market_symbol(market: str, amount_unit: Optional[str] = None, price_unit: Optional[str] = None) -> tuple[str, str]:
    """
    Identifica o ticker do ativo negociado (base) e a moeda de cotação (quote).
    Prioriza as colunas explícitas Amount Unit e Price Unit quando disponíveis.
    """
    market = str(market).strip().upper()
    if amount_unit and str(amount_unit).strip() and str(amount_unit).strip().upper() != "NAN":
        base_ticker = str(amount_unit).strip().upper()
        quote_ticker = str(price_unit).strip().upper() if price_unit and str(price_unit).strip() != "NAN" else "USDT"
        return base_ticker, quote_ticker

    if market.endswith("BRL"):
        return market[:-3], "BRL"
    for s in STABLECOINS:
        if market.endswith(s):
            return market[:-len(s)], s
    return market, "USD"

def processar_planilha_binance(
    db: Session,
    file_content: Union[BinaryIO, bytes],
    carteira_id: Optional[int] = 1,
    ticker_base: Optional[str] = None,
    nome_ativo: Optional[str] = None
) -> Dict[str, Any]:
    """
    Processa ordens da Binance a partir de exportações de 'Order History' ou relatórios de dados do usuário ('Spot Order History').
    Processa todos os pares negociados (ex: BTC, ETH, SOL, USDTBRL, etc.), convertendo cotações em USD/stables para BRL via PTAX oficial.
    """
    if isinstance(file_content, bytes):
        file_content = io.BytesIO(file_content)

    excel_file = pd.ExcelFile(file_content)
    
    # Descoberta inteligente da aba de ordens Spot
    sheet_name = None
    candidates = ["spot order history", "order history", "spot order", "spot history", "orders"]
    for s in excel_file.sheet_names:
        if s.lower().strip() in candidates:
            sheet_name = s
            break
    if not sheet_name:
        for s in excel_file.sheet_names:
            if "spot" in s.lower() and "order" in s.lower():
                sheet_name = s
                break
    if not sheet_name:
        # Fallback: primeira aba
        sheet_name = excel_file.sheet_names[0]

    df = pd.read_excel(excel_file, sheet_name=sheet_name)

    trade_qty_col = next((c for c in df.columns if "trade qty" in str(c).lower() or "executed" in str(c).lower()), None)
    if not trade_qty_col:
        raise ValueError(
            f"Coluna de quantidade executada ('Trade Qty' ou 'Executed') não encontrada na aba '{sheet_name}'. "
            f"Colunas disponíveis: {list(df.columns)}"
        )

    df["_trade_qty_num"] = pd.to_numeric(df[trade_qty_col], errors="coerce").fillna(0)
    df_executed = df[df["_trade_qty_num"] > 0].copy()

    time_col = next((c for c in df_executed.columns if "time" in str(c).lower() or "date" in str(c).lower()), None)
    if not time_col:
        raise ValueError(f"Coluna de data/hora ('Time' ou 'Date') não encontrada na aba '{sheet_name}'.")

    df_executed["_time_dt"] = pd.to_datetime(df_executed[time_col], format="mixed")
    df_executed = df_executed.sort_values("_time_dt").reset_index(drop=True)

    market_col = next((c for c in df_executed.columns if "market" in str(c).lower() or "pair" in str(c).lower() or "symbol" in str(c).lower()), "Market ID")
    side_col = next((c for c in df_executed.columns if "side" in str(c).lower() or "type" in str(c).lower()), "Side")
    price_col = next((c for c in df_executed.columns if "average price" in str(c).lower() or "avg price" in str(c).lower() or "price" in str(c).lower()), "Average Price")
    fee_col = next((c for c in df_executed.columns if str(c).strip().lower() == "fee"), None)
    fee_coin_col = next((c for c in df_executed.columns if "fee coin" in str(c).lower() or "fee asset" in str(c).lower()), None)
    amount_unit_col = next((c for c in df_executed.columns if "amount unit" in str(c).lower()), None)
    price_unit_col = next((c for c in df_executed.columns if "price unit" in str(c).lower()), None)

    transacoes_criadas: List[Transacao] = []
    pendencias: List[str] = []

    for _, row in df_executed.iterrows():
        market_raw = str(row[market_col]).strip().upper()
        amount_unit_val = str(row[amount_unit_col]).strip() if amount_unit_col and pd.notna(row.get(amount_unit_col)) else None
        price_unit_val = str(row[price_unit_col]).strip() if price_unit_col and pd.notna(row.get(price_unit_col)) else None

        base_ticker, quote_ticker = parse_market_symbol(market_raw, amount_unit_val, price_unit_val)

        # Se um ticker específico foi solicitado e difere do identificado
        if ticker_base and base_ticker != ticker_base.upper():
            continue

        side_raw = str(row[side_col]).strip().upper()
        tipo_operacao = TipoOperacao.SELL if "SELL" in side_raw else TipoOperacao.BUY

        trade_qty = to_decimal(row[trade_qty_col])
        avg_price = to_decimal(row[price_col])

        if trade_qty <= Decimal("0") or avg_price <= Decimal("0"):
            continue

        time_val = row["_time_dt"]
        if pd.isna(time_val):
            dt_obj = datetime.now(timezone.utc)
        elif hasattr(time_val, "to_pydatetime"):
            dt_obj = time_val.to_pydatetime()
        else:
            dt_obj = datetime.now(timezone.utc)

        order_date = dt_obj.date()

        fee = to_decimal(row[fee_col]) if fee_col and pd.notna(row.get(fee_col)) else Decimal("0.0")
        fee_coin = str(row[fee_coin_col]).strip().upper() if fee_coin_col and pd.notna(row.get(fee_coin_col)) else ""

        # Obtenção ou cadastro do Ativo
        ativo = db.query(Ativo).filter(Ativo.ticker == base_ticker).first()
        if not ativo:
            nome_cripto = CRYPTO_NAMES.get(base_ticker, f"Cripto {base_ticker}")
            ativo = Ativo(
                ticker=base_ticker,
                nome=nome_cripto,
                tipo=TipoAtivo.Cripto,
                setor="Criptomoedas"
            )
            db.add(ativo)
            db.flush()

        # Determinação de Moeda e Cotação PTAX
        if quote_ticker == "BRL":
            ptax_used = Decimal("1.0")
            moeda = "BRL"
            if fee_coin == base_ticker:
                fee_brl = fee * avg_price
            else:
                fee_brl = fee
        else:
            ptax_used = get_ptax_venda(order_date)
            moeda = "USD"
            if fee_coin == "BRL":
                fee_brl = fee
            elif fee_coin == base_ticker:
                fee_brl = fee * avg_price * ptax_used
            else:
                fee_brl = fee * ptax_used

        transacao_in = TransacaoCreate(
            carteira_id=carteira_id or 1,
            ativo_id=ativo.id,
            data_hora=dt_obj,
            tipo_operacao=tipo_operacao,
            quantidade=trade_qty,
            preco_unitario=avg_price,
            taxas=fee_brl,
            moeda=moeda,
            moeda_taxa="BRL",
            ptax_utilizada=ptax_used if quote_ticker != "BRL" else None
        )

        try:
            tx = processar_transacao(db=db, transacao_in=transacao_in)
            transacoes_criadas.append(tx)
        except Exception as p_err:
            db.rollback()
            pendencias.append(
                f"Ordem {tipo_operacao.value} de {trade_qty} {base_ticker} em {dt_obj.strftime('%d/%m/%Y %H:%M')}: {str(p_err)}"
            )

    return {
        "transacoes": transacoes_criadas,
        "pendencias": pendencias,
        "aba_processada": sheet_name
    }
