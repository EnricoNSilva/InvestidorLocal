import io
import json
import urllib.request
from datetime import datetime, date, timedelta, timezone
from decimal import Decimal, getcontext
from pathlib import Path
from typing import BinaryIO, Dict, List, Optional, Union, Any, Tuple
import pandas as pd
from sqlalchemy.orm import Session

from app.models.ativo import Ativo
from app.models.enums import TipoAtivo, TipoOperacao
from app.models.transacao import Transacao
from app.models.posicao import PosicaoConsolidada
from app.schemas.transacao import TransacaoCreate
from app.services.portfolio import processar_transacao, recalcular_posicoes_carteira

getcontext().prec = 28

CACHE_DIR = Path(__file__).resolve().parent.parent.parent.parent / "data" / "cache"

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

    fallback_rate = Decimal("5.1800")
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
    "SXT": "Space and Time",
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

def _obter_ou_criar_ativo_cripto(db: Session, ticker: str) -> Ativo:
    clean_ticker = ticker.strip().upper()
    ativo = db.query(Ativo).filter(Ativo.ticker == clean_ticker).first()
    if not ativo:
        nome_cripto = CRYPTO_NAMES.get(clean_ticker, f"Cripto {clean_ticker}")
        ativo = Ativo(
            ticker=clean_ticker,
            nome=nome_cripto,
            tipo=TipoAtivo.Cripto,
            setor="Criptomoedas"
        )
        db.add(ativo)
        db.flush()
    return ativo

def _calcular_preco_referencia_usd(coin: str, operacoes: List[Dict[str, Any]]) -> Decimal:
    """
    Calcula dinamicamente o preço unitário em USD de referência para um criptoativo
    com base no preço médio de aquisição ponderado móvel em USD ou no último trade executado.
    """
    ops_coin = [o for o in operacoes if o["ticker"] == coin]
    if not ops_coin:
        return Decimal("1.0")

    saldo_u = Decimal("0.0")
    custo_u = Decimal("0.0")
    pm_u = Decimal("0.0")
    ultimo_preco_usd = Decimal("0.0")

    for o in ops_coin:
        rate = o.get("ptax") or Decimal("1.0")
        pu = o["preco_unitario"]
        pu_usd = pu if o.get("moeda") == "USD" else (pu / rate if rate > Decimal("0.0") else pu)
        if pu_usd > Decimal("0.0"):
            ultimo_preco_usd = pu_usd

        if o["tipo"] in (TipoOperacao.BUY, TipoOperacao.BONIFICACAO):
            op_custo = o["quantidade"] * pu_usd
            saldo_u += o["quantidade"]
            custo_u += op_custo
            if saldo_u > Decimal("0.0"):
                pm_u = custo_u / saldo_u
        elif o["tipo"] == TipoOperacao.SELL:
            qtd_b = min(o["quantidade"], saldo_u)
            c_baixa = qtd_b * pm_u
            saldo_u = max(Decimal("0.0"), saldo_u - o["quantidade"])
            custo_u = max(Decimal("0.0"), custo_u - c_baixa)
            if saldo_u > Decimal("0.0"):
                pm_u = custo_u / saldo_u
            else:
                pm_u = Decimal("0.0")

    if pm_u > Decimal("0.0"):
        return pm_u
    if ultimo_preco_usd > Decimal("0.0"):
        return ultimo_preco_usd
    return Decimal("1.0")


def _processar_relatorio_completo_binance(
    db: Session,
    excel_file: pd.ExcelFile,
    carteira_id: int,
    ticker_base: Optional[str] = None
) -> Dict[str, Any]:
    """
    Processa integralmente o relatório de 15 abas da Binance ('user_operation_detail.xlsx'):
    - Pag 5: Fiat Deposit History (Depósitos PIX em BRL)
    - Pag 8 e 15: Binance Pay e Binance Card (Gastos efetivos)
    - Pag 6 e 7: Deposit/Withdrawal History (Autocustódia líquida)
    - Pag 2: Account Balance (Saldos em Earn e Staking Interest)
    - Pag 9: Spot Order History (USDTBRL e ordens de criptoativos)
    - Pag 10: OTC Trading (Ordens executadas via OTC)
    """
    transacoes_criadas: List[Transacao] = []
    pendencias: List[str] = []

    # 1. Pag 5: Fiat Deposit History
    fiat_depositado_brl = Decimal("0.0")
    if "Fiat Deposit History" in excel_file.sheet_names:
        df_fiat = pd.read_excel(excel_file, sheet_name="Fiat Deposit History")
        status_col = next((c for c in df_fiat.columns if "status" in str(c).lower()), "Status")
        curr_col = next((c for c in df_fiat.columns if "currency" in str(c).lower()), "Currency")
        amt_col = next((c for c in df_fiat.columns if "amount" in str(c).lower()), "Amount")
        success_fiat = df_fiat[
            (df_fiat[status_col].astype(str).str.strip().str.upper().isin(["SUCCESS", "SUCCESSFUL", "COMPLETED"])) &
            (df_fiat[curr_col].astype(str).str.strip().str.upper() == "BRL")
        ]
        fiat_depositado_brl = sum((to_decimal(val) for val in success_fiat[amt_col]), Decimal("0.0"))

    # 2. Pag 8 e 15: Binance Pay e Binance Card
    gastos_pay_card_brl = Decimal("0.0")
    if "Binance Pay" in excel_file.sheet_names:
        df_pay = pd.read_excel(excel_file, sheet_name="Binance Pay")
        amt_col = next((c for c in df_pay.columns if "amount" in str(c).lower()), "Amount")
        curr_col = next((c for c in df_pay.columns if "currency" in str(c).lower()), "Currency")
        pay_neg = df_pay[
            (pd.to_numeric(df_pay[amt_col], errors="coerce") < 0) &
            (df_pay[curr_col].astype(str).str.strip().str.upper() == "BRL")
        ]
        gastos_pay_card_brl += sum((abs(to_decimal(v)) for v in pay_neg[amt_col]), Decimal("0.0"))

    card_sheet = next((s for s in excel_file.sheet_names if "card transactions" in s.lower()), None)
    if card_sheet:
        df_card_raw = pd.read_excel(excel_file, sheet_name=card_sheet, header=None)
        header_idx = 0
        for i, row in df_card_raw.iterrows():
            vals = [str(x).strip().upper() for x in row.values]
            if "STATUS" in vals and "TYPE" in vals:
                header_idx = i
                break
        df_card = pd.read_excel(excel_file, sheet_name=card_sheet, header=header_idx)
        status_c = next((c for c in df_card.columns if "status" in str(c).lower()), "Status")
        type_c = next((c for c in df_card.columns if "type" in str(c).lower()), "Type")
        curr_c = next((c for c in df_card.columns if "currency" in str(c).lower()), "Currency")
        total_c = next((c for c in df_card.columns if "total" in str(c).lower()), "Total")
        date_c = next((c for c in df_card.columns if "date" in str(c).lower() or "time" in str(c).lower()), None)

        card_capture = df_card[
            (df_card[status_c].astype(str).str.strip().str.upper() == "SUCCESS") &
            (df_card[type_c].astype(str).str.strip().str.upper() == "CAPTURE")
        ]
        for _, c_row in card_capture.iterrows():
            c_curr = str(c_row[curr_c]).strip().upper()
            c_tot = to_decimal(c_row[total_c])
            if c_curr == "BRL":
                gastos_pay_card_brl += c_tot
            elif c_curr == "USD":
                c_date = pd.to_datetime(c_row[date_c]).date() if date_c and pd.notna(c_row.get(date_c)) else date.today()
                ptax_card = get_ptax_venda(c_date)
                gastos_pay_card_brl += c_tot * ptax_card

    # 3. Pag 2: Account Balance (Seção Earn - 币安宝账户 - 活期)
    earn_balances: Dict[str, Decimal] = {}
    earn_interests: Dict[str, Decimal] = {}
    if "Account Balance" in excel_file.sheet_names:
        df_acc = pd.read_excel(excel_file, sheet_name="Account Balance")
        is_earn = False
        for _, row in df_acc.iterrows():
            val0 = str(row.iloc[0]).strip()
            if "Earn - 币安宝账户 - 活期" in val0 or "活期" in val0:
                is_earn = True
                continue
            if is_earn:
                if val0.startswith("Earn -") or val0.startswith("Fiat") or val0.startswith("Margin") or val0.startswith("Pool"):
                    break
                if val0 not in ("Product Name", "nan", "") and not pd.isna(row.iloc[0]):
                    coin = val0.upper()
                    earn_balances[coin] = to_decimal(row.iloc[1])
                    earn_interests[coin] = to_decimal(row.iloc[5])

    # 4. Pag 6 e 7: Deposit History e Withdrawal History (Autocustódia Líquida)
    autocustodia_liquida: Dict[str, Decimal] = {}
    withdrawals_map: Dict[str, Decimal] = {}
    deposits_map: Dict[str, Decimal] = {}

    if "Withdrawal History" in excel_file.sheet_names:
        df_wdr = pd.read_excel(excel_file, sheet_name="Withdrawal History")
        w_status = next((c for c in df_wdr.columns if "status" in str(c).lower()), "Status")
        w_curr = next((c for c in df_wdr.columns if any(k in str(c).lower() for k in ["curr", "coin", "asset"])), "Currency")
        w_amt = next((c for c in df_wdr.columns if "amount" in str(c).lower()), "Amount")
        w_ok = df_wdr[df_wdr[w_status].astype(str).str.strip().str.upper().isin(["SUCCESS", "COMPLETED"])]
        for _, r in w_ok.iterrows():
            c = str(r[w_curr]).strip().upper()
            withdrawals_map[c] = withdrawals_map.get(c, Decimal("0.0")) + to_decimal(r[w_amt])

    if "Deposit History" in excel_file.sheet_names:
        df_dep = pd.read_excel(excel_file, sheet_name="Deposit History")
        d_status = next((c for c in df_dep.columns if "status" in str(c).lower()), "Status")
        d_curr = next((c for c in df_dep.columns if any(k in str(c).lower() for k in ["curr", "coin", "asset"])), "Currency")
        d_amt = next((c for c in df_dep.columns if "amount" in str(c).lower()), "Amount")
        d_ok = df_dep[df_dep[d_status].astype(str).str.strip().str.upper().isin(["SUCCESS", "COMPLETED"])]
        for _, r in d_ok.iterrows():
            c = str(r[d_curr]).strip().upper()
            deposits_map[c] = deposits_map.get(c, Decimal("0.0")) + to_decimal(r[d_amt])

    all_coins_custodia = set(withdrawals_map.keys()).union(set(deposits_map.keys()))
    for c in all_coins_custodia:
        autocustodia_liquida[c] = withdrawals_map.get(c, Decimal("0.0")) - deposits_map.get(c, Decimal("0.0"))

    # 5. Pag 9: Spot Order History
    spot_sheet = next((s for s in excel_file.sheet_names if "spot" in s.lower() and "order" in s.lower()), "Spot Order History")
    df_spot = pd.read_excel(excel_file, sheet_name=spot_sheet)

    trade_qty_col = next((c for c in df_spot.columns if "trade qty" in str(c).lower() or "executed" in str(c).lower()), "Trade Qty")
    df_spot["_trade_qty_num"] = pd.to_numeric(df_spot[trade_qty_col], errors="coerce").fillna(0)
    df_spot_executed = df_spot[df_spot["_trade_qty_num"] > 0].copy()

    time_col = next((c for c in df_spot_executed.columns if "time" in str(c).lower() or "date" in str(c).lower()), "Time")
    df_spot_executed["_time_dt"] = pd.to_datetime(df_spot_executed[time_col], format="mixed")
    df_spot_executed = df_spot_executed.sort_values("_time_dt").reset_index(drop=True)

    market_col = next((c for c in df_spot_executed.columns if "market" in str(c).lower() or "pair" in str(c).lower() or "symbol" in str(c).lower()), "Market ID")
    side_col = next((c for c in df_spot_executed.columns if "side" in str(c).lower()), "Side")
    # Priorização estrita de average price sobre price para capturar ordens a mercado
    price_col = next((c for c in df_spot_executed.columns if "average price" in str(c).lower() or "avg price" in str(c).lower()), None)
    if not price_col:
        price_col = next((c for c in df_spot_executed.columns if "price" in str(c).lower()), "Price")

    amount_unit_col = next((c for c in df_spot_executed.columns if "amount unit" in str(c).lower()), None)
    price_unit_col = next((c for c in df_spot_executed.columns if "price unit" in str(c).lower()), None)

    # Constrói linha do tempo cambial BRL/USDT das compras reais de USDTBRL
    usdtbrl_rates: List[Tuple[datetime, Decimal]] = []
    df_usdtbrl = df_spot_executed[df_spot_executed[market_col].astype(str).str.strip().str.upper() == "USDTBRL"]
    for _, r in df_usdtbrl.iterrows():
        r_dt = r["_time_dt"].to_pydatetime()
        if r_dt.tzinfo is None:
            r_dt = r_dt.replace(tzinfo=timezone.utc)
        r_rate = to_decimal(r[price_col])
        if r_rate > Decimal("0.0"):
            usdtbrl_rates.append((r_dt, r_rate))
    usdtbrl_rates.sort(key=lambda x: x[0])

    def get_effective_usdt_rate(dt: datetime) -> Decimal:
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        cand = None
        for r_dt, rate in usdtbrl_rates:
            if r_dt <= dt:
                cand = rate
            else:
                break
        if cand is not None:
            return cand
        return get_ptax_venda(dt.date())

    # 6. Pag 10: OTC Trading
    otc_orders: List[Dict[str, Any]] = []
    if "OTC Trading" in excel_file.sheet_names:
        df_otc = pd.read_excel(excel_file, sheet_name="OTC Trading")
        u_status_col = next((c for c in df_otc.columns if "status" in str(c).lower()), None)
        otc_success = df_otc[df_otc[u_status_col].astype(str).str.strip().str.upper().isin(["SUCCESS", "COMPLETED", "FILLED"])] if u_status_col else df_otc
        b_coin_col = next((c for c in df_otc.columns if "basecoin" in str(c).lower() or "base asset" in str(c).lower() or str(c).lower().strip() == "base"), "BaseCoin")
        q_coin_col = next((c for c in df_otc.columns if "quotecoin" in str(c).lower() or "quote asset" in str(c).lower() or str(c).lower().strip() == "quote"), "QuoteCoin")
        p_type_col = next((c for c in df_otc.columns if "paytype" in str(c).lower() or "side" in str(c).lower() or "type" in str(c).lower()), "PayType")
        b_amt_col = next((c for c in df_otc.columns if "basecoinamount" in str(c).lower() or "trade qty" in str(c).lower() or ("base" in str(c).lower() and "amount" in str(c).lower())), "BaseCoinAmount")
        q_amt_col = next((c for c in df_otc.columns if "quotecoinamount" in str(c).lower() or ("quote" in str(c).lower() and "amount" in str(c).lower()) or str(c).lower() == "amount"), "QuoteCoinAmount")
        c_time_col = next((c for c in df_otc.columns if "createtime" in str(c).lower() or "time" in str(c).lower()), "CreateTime")

        for _, otc_r in otc_success.iterrows():
            b_coin = str(otc_r.get(b_coin_col, "")).strip().upper()
            q_coin = str(otc_r.get(q_coin_col, "")).strip().upper()
            p_type = str(otc_r.get(p_type_col, "")).strip().upper()
            b_amt = to_decimal(otc_r.get(b_amt_col))
            q_amt = to_decimal(otc_r.get(q_amt_col))
            c_time_raw = str(otc_r.get(c_time_col, "")).replace("(UTC)", "").strip()
            o_dt = pd.to_datetime(c_time_raw).to_pydatetime()
            if o_dt.tzinfo is None:
                o_dt = o_dt.replace(tzinfo=timezone.utc)
            if b_amt > Decimal("0.0") and q_amt > Decimal("0.0"):
                unit_price = q_amt / b_amt
                otc_orders.append({
                    "dt": o_dt,
                    "ticker": b_coin,
                    "tipo": TipoOperacao.BUY if p_type == "BUY" else TipoOperacao.SELL,
                    "quantidade": b_amt,
                    "preco_unitario": unit_price,
                    "moeda": "USD" if q_coin in STABLECOINS else q_coin,
                })

    # Lista consolidada de operações
    todas_operacoes: List[Dict[str, Any]] = []

    # Adiciona OTC orders
    for otc in otc_orders:
        o_dt = otc["dt"]
        if o_dt.tzinfo is None:
            o_dt = o_dt.replace(tzinfo=timezone.utc)
        todas_operacoes.append({
            "dt": o_dt,
            "ticker": otc["ticker"],
            "tipo": otc["tipo"],
            "quantidade": otc["quantidade"],
            "preco_unitario": otc["preco_unitario"],
            "moeda": otc["moeda"],
            "ptax": get_effective_usdt_rate(o_dt) if otc["moeda"] != "BRL" else Decimal("1.0"),
        })

    # Adiciona Spot orders (exceto USDTBRL para não criar USDT fantasma)
    for _, row in df_spot_executed.iterrows():
        market_raw = str(row[market_col]).strip().upper()
        if market_raw == "USDTBRL":
            continue

        amt_unit = str(row[amount_unit_col]).strip() if amount_unit_col and pd.notna(row.get(amount_unit_col)) else None
        prc_unit = str(row[price_unit_col]).strip() if price_unit_col and pd.notna(row.get(price_unit_col)) else None
        base_ticker, quote_ticker = parse_market_symbol(market_raw, amt_unit, prc_unit)

        if ticker_base and base_ticker != ticker_base.upper():
            continue

        side_raw = str(row[side_col]).strip().upper()
        tipo_op = TipoOperacao.SELL if "SELL" in side_raw else TipoOperacao.BUY
        trade_qty = to_decimal(row[trade_qty_col])
        avg_price = to_decimal(row[price_col])

        if trade_qty <= Decimal("0") or avg_price <= Decimal("0"):
            continue

        time_val = row["_time_dt"]
        o_dt = time_val.to_pydatetime() if hasattr(time_val, "to_pydatetime") else datetime.now(timezone.utc)
        if o_dt.tzinfo is None:
            o_dt = o_dt.replace(tzinfo=timezone.utc)

        ptax = get_effective_usdt_rate(o_dt) if quote_ticker != "BRL" else Decimal("1.0")

        todas_operacoes.append({
            "dt": o_dt,
            "ticker": base_ticker,
            "tipo": tipo_op,
            "quantidade": trade_qty,
            "preco_unitario": avg_price,
            "moeda": "BRL" if quote_ticker == "BRL" else "USD",
            "ptax": ptax,
        })

    # Ordena cronologicamente
    todas_operacoes.sort(key=lambda x: x["dt"])

    # 7. Detecção dinâmica de vendas de Airdrop / Launchpool (ex: ERA e SXT)
    # Se uma venda (SELL) exceder o saldo de aquisições prévias, registra BONIFICACAO a custo zero
    # 1 segundo antes da venda para apurar 100% como lucro realizado
    operacoes_ajustadas: List[Dict[str, Any]] = []
    saldos_rastreados: Dict[str, Decimal] = {}

    for op in todas_operacoes:
        coin = op["ticker"]
        saldo_atual = saldos_rastreados.get(coin, Decimal("0.0"))
        if op["tipo"] in (TipoOperacao.BUY, TipoOperacao.BONIFICACAO):
            saldos_rastreados[coin] = saldo_atual + op["quantidade"]
            operacoes_ajustadas.append(op)
        elif op["tipo"] == TipoOperacao.SELL:
            if op["quantidade"] > saldo_atual:
                falta = op["quantidade"] - saldo_atual
                dt_bonif = op["dt"] - timedelta(seconds=1)
                operacoes_ajustadas.append({
                    "dt": dt_bonif,
                    "ticker": coin,
                    "tipo": TipoOperacao.BONIFICACAO,
                    "quantidade": falta,
                    "preco_unitario": Decimal("0.0"),
                    "moeda": op["moeda"],
                    "ptax": op["ptax"],
                })
                saldos_rastreados[coin] = Decimal("0.0")
            else:
                saldos_rastreados[coin] = saldo_atual - op["quantidade"]
            operacoes_ajustadas.append(op)
        else:
            operacoes_ajustadas.append(op)

    todas_operacoes = operacoes_ajustadas

    # Limpa transações e posições cripto anteriores da carteira para garantir reimportação limpa e idempotente
    cripto_ativos_antigos = db.query(Ativo).filter(Ativo.tipo == TipoAtivo.Cripto).all()
    cripto_ids = [a.id for a in cripto_ativos_antigos]
    if cripto_ids:
        db.query(Transacao).filter(
            Transacao.carteira_id == carteira_id,
            Transacao.ativo_id.in_(cripto_ids)
        ).delete(synchronize_session=False)
        db.query(PosicaoConsolidada).filter(
            PosicaoConsolidada.carteira_id == carteira_id,
            PosicaoConsolidada.ativo_id.in_(cripto_ids)
        ).delete(synchronize_session=False)
        db.flush()

    # Processa operações no banco
    for op in todas_operacoes:
        ativo = _obter_ou_criar_ativo_cripto(db, op["ticker"])
        tx_in = TransacaoCreate(
            carteira_id=carteira_id,
            ativo_id=ativo.id,
            data_hora=op["dt"],
            tipo_operacao=op["tipo"],
            quantidade=op["quantidade"],
            preco_unitario=op["preco_unitario"],
            taxas=Decimal("0.0"),
            moeda=op["moeda"],
            moeda_taxa="BRL",
            ptax_utilizada=op["ptax"] if op["moeda"] != "BRL" else None
        )
        try:
            tx = processar_transacao(db=db, transacao_in=tx_in)
            transacoes_criadas.append(tx)
        except Exception as err:
            db.rollback()
            pendencias.append(f"Erro em {op['tipo'].value} {op['quantidade']} {op['ticker']}: {str(err)}")

    # 8. Reconciliação Física de Custódia (Autocustódia + Earn) para ativos ativos
    # Ignora poeira residual (dust) no Earn para moedas que já foram liquidadas (saldo < 0.1 unidade ou valor residual < US$ 0.50)
    for coin, s_earn in list(earn_balances.items()):
        if s_earn <= Decimal("0.0"):
            continue
        ops_c = [o for o in todas_operacoes if o["ticker"] == coin]
        if ops_c:
            saldo_ops = sum(
                (o["quantidade"] if o["tipo"] in (TipoOperacao.BUY, TipoOperacao.BONIFICACAO) else -o["quantidade"])
                for o in ops_c
            )
            if saldo_ops <= Decimal("0.00000001"):
                ref_u = _calcular_preco_referencia_usd(coin, todas_operacoes)
                val_u = s_earn * ref_u
                if val_u < Decimal("0.50"):
                    earn_balances[coin] = Decimal("0.0")

    moedas_ativas: set[str] = set()
    for coin, s_earn in earn_balances.items():
        if s_earn > Decimal("0.0") and coin not in STABLECOINS and coin != "BRL":
            moedas_ativas.add(coin)
    for coin, s_auto in autocustodia_liquida.items():
        if s_auto > Decimal("0.0") and coin not in STABLECOINS and coin != "BRL":
            moedas_ativas.add(coin)

    for coin in sorted(list(moedas_ativas)):
        ativo = _obter_ou_criar_ativo_cripto(db, coin)
        saldo_earn = earn_balances.get(coin, Decimal("0.0"))
        saldo_auto = autocustodia_liquida.get(coin, Decimal("0.0"))
        qtd_final_esperada = saldo_earn + saldo_auto

        # Calcula saldo atual de trades no banco
        recalcular_posicoes_carteira(db=db, carteira_id=carteira_id)
        pos = db.query(PosicaoConsolidada).filter(
            PosicaoConsolidada.carteira_id == carteira_id,
            PosicaoConsolidada.ativo_id == ativo.id
        ).first()
        saldo_atual = pos.quantidade_saldo if pos else Decimal("0.0")

        diff = qtd_final_esperada - saldo_atual
        now_dt = datetime.now(timezone.utc)
        latest_ptax = usdtbrl_rates[-1][1] if usdtbrl_rates else get_ptax_venda(now_dt.date())

        if diff > Decimal("0.00000001"):
            # Ajuste de entrada a custo zero (ex: bonificações de saldo, juros não transacionados)
            tx_rec = Transacao(
                carteira_id=carteira_id,
                ativo_id=ativo.id,
                data_hora=now_dt,
                tipo_operacao=TipoOperacao.BONIFICACAO,
                quantidade=diff,
                preco_unitario=Decimal("0.0"),
                taxas=Decimal("0.0"),
                moeda="USD",
                moeda_taxa="BRL",
                ptax_utilizada=latest_ptax
            )
            db.add(tx_rec)
            transacoes_criadas.append(tx_rec)
        elif diff < Decimal("-0.00000001"):
            # Ajuste de taxa/fração debitada na moeda física
            tx_rec = Transacao(
                carteira_id=carteira_id,
                ativo_id=ativo.id,
                data_hora=now_dt,
                tipo_operacao=TipoOperacao.FRACAO_ATIVOS,
                quantidade=abs(diff),
                preco_unitario=Decimal("0.0"),
                taxas=Decimal("0.0"),
                moeda="USD",
                moeda_taxa="BRL",
                ptax_utilizada=latest_ptax
            )
            db.add(tx_rec)
            transacoes_criadas.append(tx_rec)

    # 9. Lançamento dos Rendimentos de Staking do Binance Earn
    now_dt = datetime.now(timezone.utc)
    latest_ptax = usdtbrl_rates[-1][1] if usdtbrl_rates else get_ptax_venda(now_dt.date())
    for coin, interest_coin in earn_interests.items():
        if interest_coin <= Decimal("0.0"):
            continue
        if coin in ("USDT",):
            continue  # USDT mantido no resumo global da Binance
        ativo = _obter_ou_criar_ativo_cripto(db, coin)
        # Preço de referência dinâmico calculado com base no PM ou último trade em USD
        ref_price_usd = _calcular_preco_referencia_usd(coin, todas_operacoes)
        valor_brl = interest_coin * ref_price_usd * latest_ptax

        tx_rend = Transacao(
            carteira_id=carteira_id,
            ativo_id=ativo.id,
            data_hora=datetime.now(timezone.utc),
            tipo_operacao=TipoOperacao.RENDIMENTO,
            quantidade=Decimal("1.0"),
            preco_unitario=valor_brl,
            taxas=Decimal("0.0"),
            moeda="BRL",
            moeda_taxa="BRL"
        )
        db.add(tx_rend)
        transacoes_criadas.append(tx_rend)

    earn_usdt = earn_interests.get("USDT", Decimal("0.0"))

    db.commit()
    recalcular_posicoes_carteira(db=db, carteira_id=carteira_id)

    # 10. Cálculo das Métricas em USD e Montagem da Custódia Detalhada
    custodia_detalhada: Dict[str, Any] = {}
    moedas_descobertas: set[str] = set()
    for o in todas_operacoes:
        moedas_descobertas.add(o["ticker"])
    for c, b in earn_balances.items():
        if c not in STABLECOINS and c != "BRL" and b > Decimal("0.0"):
            moedas_descobertas.add(c)
    for c, a in autocustodia_liquida.items():
        if c not in STABLECOINS and c != "BRL" and abs(a) > Decimal("0.0"):
            moedas_descobertas.add(c)
    for c, i in earn_interests.items():
        if c not in STABLECOINS and c != "BRL" and i > Decimal("0.0"):
            moedas_descobertas.add(c)
    todos_tickers = sorted(list(moedas_descobertas))

    for coin in todos_tickers:
        ativo = db.query(Ativo).filter(Ativo.ticker == coin).first()
        if not ativo:
            continue
        pos = db.query(PosicaoConsolidada).filter(
            PosicaoConsolidada.carteira_id == carteira_id,
            PosicaoConsolidada.ativo_id == ativo.id
        ).first()

        qtd_saldo = pos.quantidade_saldo if pos else Decimal("0.0")
        custo_brl = pos.custo_total_brl if pos else Decimal("0.0")

        # Simula histórico de operações para obter PM em USD e valores de venda
        ops_coin = [o for o in todas_operacoes if o["ticker"] == coin]
        saldo_u = Decimal("0.0")
        custo_u = Decimal("0.0")
        pm_u = Decimal("0.0")
        qtd_vend = Decimal("0.0")
        custo_vendas_brl_acum = Decimal("0.0")
        vendas_brl_acum = Decimal("0.0")

        # Rastreia PM em BRL paralelo para apurar custo das frações vendidas
        saldo_b = Decimal("0.0")
        custo_b = Decimal("0.0")
        pm_b = Decimal("0.0")

        for o in ops_coin:
            rate_b = o["ptax"]
            if o["tipo"] in (TipoOperacao.BUY, TipoOperacao.BONIFICACAO):
                op_custo_usd = o["quantidade"] * o["preco_unitario"] if o["moeda"] == "USD" else (o["quantidade"] * o["preco_unitario"] / rate_b)
                op_custo_brl = o["quantidade"] * o["preco_unitario"] * rate_b if o["moeda"] == "USD" else (o["quantidade"] * o["preco_unitario"])
                saldo_u += o["quantidade"]
                custo_u += op_custo_usd
                if saldo_u > Decimal("0.0"):
                    pm_u = custo_u / saldo_u

                saldo_b += o["quantidade"]
                custo_b += op_custo_brl
                if saldo_b > Decimal("0.0"):
                    pm_b = custo_b / saldo_b

            elif o["tipo"] == TipoOperacao.SELL:
                qtd_b = min(o["quantidade"], saldo_u)
                c_baixa_usd = qtd_b * pm_u
                c_baixa_brl = qtd_b * pm_b
                rec_brl = o["quantidade"] * o["preco_unitario"] * rate_b if o["moeda"] == "USD" else (o["quantidade"] * o["preco_unitario"])

                qtd_vend += o["quantidade"]
                custo_vendas_brl_acum += c_baixa_brl
                vendas_brl_acum += rec_brl

                saldo_u = max(Decimal("0.0"), saldo_u - o["quantidade"])
                custo_u = max(Decimal("0.0"), custo_u - c_baixa_usd)
                if saldo_u > Decimal("0.0"):
                    pm_u = custo_u / saldo_u
                else:
                    pm_u = Decimal("0.0")

                saldo_b = max(Decimal("0.0"), saldo_b - o["quantidade"])
                custo_b = max(Decimal("0.0"), custo_b - c_baixa_brl)
                if saldo_b > Decimal("0.0"):
                    pm_b = custo_b / saldo_b
                else:
                    pm_b = Decimal("0.0")

        saldo_earn = earn_balances.get(coin, Decimal("0.0"))
        saldo_auto = autocustodia_liquida.get(coin, Decimal("0.0"))
        qtd_tot = qtd_saldo

        if qtd_tot > Decimal("0.0"):
            pm_u = custo_u / qtd_tot
        else:
            pm_u = Decimal("0.0")
            custo_u = Decimal("0.0")

        pct_e = ((saldo_earn / qtd_tot) * Decimal("100.0")) if qtd_tot > Decimal("0.0") else Decimal("0.0")
        pct_a = ((saldo_auto / qtd_tot) * Decimal("100.0")) if qtd_tot > Decimal("0.0") else Decimal("0.0")

        cod_rfb = "08/01" if coin == "BTC" else "08/02"
        txt_rfb = (
            f"{qtd_tot:.8f} unidades do criptoativo {coin} ({saldo_auto:.8f} em autocustódia externa "
            f"e {saldo_earn:.8f} na corretora Binance), com custo total de aquisição de R$ {custo_brl:.2f}."
        )

        custodia_detalhada[coin] = {
            "qtd_total": float(qtd_tot),
            "qtd_earn": float(saldo_earn),
            "qtd_autocustodia": float(saldo_auto),
            "pct_earn": float(round(pct_e, 2)),
            "pct_autocustodia": float(round(pct_a, 2)),
            "earn_interest_moeda": float(earn_interests.get(coin, Decimal("0.0"))),
            "preco_medio_usd": float(round(pm_u, 4)),
            "custo_total_usd": float(round(custo_u, 2)),
            "quantidade_vendida": float(qtd_vend),
            "custo_vendas_brl": float(round(custo_vendas_brl_acum, 2)),
            "valor_total_vendas_brl": float(round(vendas_brl_acum, 2)),
            "codigo_rfb_irpf": cod_rfb,
            "texto_irpf": txt_rfb,
        }

    # Salva cache de metadados da Binance
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_meta_file = CACHE_DIR / f"binance_metadata_{carteira_id}.json"
    meta_payload = {
        "carteira_id": carteira_id,
        "fiat_depositado_brl": float(round(fiat_depositado_brl, 2)),
        "gastos_pay_card_brl": float(round(gastos_pay_card_brl, 2)),
        "earn_usdt_usd": float(round(earn_usdt, 6)),
        "custodia_detalhada": custodia_detalhada,
        "atualizado_em": datetime.now(timezone.utc).isoformat()
    }
    with open(cache_meta_file, "w", encoding="utf-8") as f:
        json.dump(meta_payload, f, indent=2, ensure_ascii=False)

    return {
        "transacoes": transacoes_criadas,
        "pendencias": pendencias,
        "aba_processada": "Multi-Abas (Spot + OTC + Earn + Autocustódia + Depósitos/Gastos)",
        "fiat_depositado_brl": round(fiat_depositado_brl, 2),
        "gastos_pay_card_brl": round(gastos_pay_card_brl, 2),
        "custodia_detalhada": custodia_detalhada
    }

def processar_planilha_binance(
    db: Session,
    file_content: Union[BinaryIO, bytes],
    carteira_id: Optional[int] = 1,
    ticker_base: Optional[str] = None,
    nome_ativo: Optional[str] = None
) -> Dict[str, Any]:
    """
    Ponto de entrada para importação de relatórios da Binance.
    Detecta automaticamente se é o relatório completo multi-abas ou exportação simples de ordens Spot.
    """
    if isinstance(file_content, bytes):
        file_content = io.BytesIO(file_content)

    excel_file = pd.ExcelFile(file_content)
    cid = carteira_id or 1

    # Identifica se é o relatório completo de dados da conta (user_operation_detail.xlsx)
    markers = ["fiat deposit history", "account balance", "otc trading", "withdrawal history", "binance pay"]
    is_multi_sheet = any(s.lower().strip() in markers for s in excel_file.sheet_names)

    if is_multi_sheet:
        return _processar_relatorio_completo_binance(
            db=db,
            excel_file=excel_file,
            carteira_id=cid,
            ticker_base=ticker_base
        )

    # Fallback para planilha simples de ordens Spot
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
    price_col = next((c for c in df_executed.columns if "average price" in str(c).lower() or "avg price" in str(c).lower()), None)
    if not price_col:
        price_col = next((c for c in df_executed.columns if "price" in str(c).lower()), "Price")

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
        if ticker_base and base_ticker != ticker_base.upper():
            continue

        side_raw = str(row[side_col]).strip().upper()
        tipo_operacao = TipoOperacao.SELL if "SELL" in side_raw else TipoOperacao.BUY

        trade_qty = to_decimal(row[trade_qty_col])
        avg_price = to_decimal(row[price_col])
        if trade_qty <= Decimal("0") or avg_price <= Decimal("0"):
            continue

        time_val = row["_time_dt"]
        dt_obj = time_val.to_pydatetime() if hasattr(time_val, "to_pydatetime") else datetime.now(timezone.utc)
        if dt_obj.tzinfo is None:
            dt_obj = dt_obj.replace(tzinfo=timezone.utc)

        order_date = dt_obj.date()
        fee = to_decimal(row[fee_col]) if fee_col and pd.notna(row.get(fee_col)) else Decimal("0.0")
        fee_coin = str(row[fee_coin_col]).strip().upper() if fee_coin_col and pd.notna(row.get(fee_coin_col)) else ""

        ativo = _obter_ou_criar_ativo_cripto(db, base_ticker)
        if quote_ticker == "BRL":
            ptax_used = Decimal("1.0")
            moeda = "BRL"
            fee_brl = fee * avg_price if fee_coin == base_ticker else fee
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
            carteira_id=cid,
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
            pendencias.append(f"Ordem {tipo_operacao.value} de {trade_qty} {base_ticker} em {dt_obj.strftime('%d/%m/%Y %H:%M')}: {str(p_err)}")

    recalcular_posicoes_carteira(db=db, carteira_id=cid)
    return {
        "transacoes": transacoes_criadas,
        "pendencias": pendencias,
        "aba_processada": sheet_name
    }
