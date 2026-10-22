#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Calculador de Preço Médio (PM) para Ordens da Binance
Foco: Alta precisão matemática com decimal.Decimal (sem imprecisões de float binário).
"""

import sys
import os
import json
import urllib.request
from decimal import Decimal, getcontext, ROUND_HALF_UP
from datetime import datetime, timedelta
import openpyxl
import pandas as pd

# Configurar precisão matemática para 28 dígitos significativos
getcontext().prec = 28

# Configurar stdout para UTF-8 se suportado
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

DEFAULT_EXCEL_PATH = "ordens_binance.xlsx"

# Pares pareados a Dólar / Stablecoins reconhecidos
USD_STABLE_PAIRS = {"BTCUSDT", "BTCUSDC", "BTCBUSD", "BTCFDUSD"}

# Cache em memória para cotações PTAX: { "YYYY-MM-DD": Decimal(...) }
PTAX_CACHE: dict[str, Decimal] = {}

def get_ptax_venda(date_obj: datetime.date) -> Decimal:
    """
    Obtém a cotação do Dólar PTAX de Venda oficial do Banco Central do Brasil (BCB)
    para a data informada. Caso seja final de semana ou feriado, recua para o último
    dia útil imediatamente anterior (regra da Receita Federal / IN 1.888 / IRPF).
    Utiliza cache em memória para evitar requisições repetidas.
    """
    date_str = date_obj.strftime("%Y-%m-%d")
    if date_str in PTAX_CACHE:
        return PTAX_CACHE[date_str]

    curr = date_obj
    for _ in range(7):  # Recua até 7 dias para cobrir feriados prolongados (ex: Carnaval)
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

    raise ValueError(f"Não foi possível obter a cotação PTAX para {date_str} ou dias anteriores.")

def to_decimal(val) -> Decimal:
    """Converte valores numéricos ou strings para Decimal de alta precisão."""
    if val is None or pd.isna(val) or val == "":
        return Decimal("0")
    if isinstance(val, (int, str)):
        return Decimal(str(val).strip().replace(",", "."))
    if isinstance(val, float):
        # Converte string formatada para evitar artefatos binários
        return Decimal(f"{val:.12f}".rstrip("0").rstrip(".") if "." in f"{val:.12f}" else f"{val:.12f}")
    return Decimal(str(val))

def format_brl(val: Decimal, decimals: int = 2) -> str:
    """Formata valor monetário no padrão brasileiro R$ 1.234,56."""
    quant = Decimal("10") ** (-decimals)
    rounded = val.quantize(quant, rounding=ROUND_HALF_UP)
    parts = f"{rounded:f}".split(".")
    int_part = parts[0]
    dec_part = parts[1] if len(parts) > 1 else "0" * decimals
    
    # Inserir separadores de milhar com ponto
    is_neg = int_part.startswith("-")
    if is_neg:
        int_part = int_part[1:]
    
    formatted_int = ""
    for i, digit in enumerate(reversed(int_part)):
        if i > 0 and i % 3 == 0:
            formatted_int = "." + formatted_int
        formatted_int = digit + formatted_int
    if is_neg:
        formatted_int = "-" + formatted_int
        
    return f"R$ {formatted_int},{dec_part}"

def format_usd(val: Decimal, decimals: int = 2) -> str:
    """Formata valor em dólares $ 1,234.56."""
    quant = Decimal("10") ** (-decimals)
    rounded = val.quantize(quant, rounding=ROUND_HALF_UP)
    parts = f"{rounded:f}".split(".")
    int_part = parts[0]
    dec_part = parts[1] if len(parts) > 1 else "0" * decimals
    
    is_neg = int_part.startswith("-")
    if is_neg:
        int_part = int_part[1:]
    
    formatted_int = ""
    for i, digit in enumerate(reversed(int_part)):
        if i > 0 and i % 3 == 0:
            formatted_int = "," + formatted_int
        formatted_int = digit + formatted_int
    if is_neg:
        formatted_int = "-" + formatted_int
        
    return f"$ {formatted_int}.{dec_part}"

def format_crypto(val: Decimal, symbol: str = "BTC", decimals: int = 8) -> str:
    """Formata quantidade de criptomoeda com 8 casas decimais (satoshis)."""
    quant = Decimal("10") ** (-decimals)
    rounded = val.quantize(quant, rounding=ROUND_HALF_UP)
    parts = f"{rounded:f}".split(".")
    int_part = parts[0]
    dec_part = parts[1] if len(parts) > 1 else "0" * decimals
    return f"{int_part}.{dec_part} {symbol}"


class OrderBookCalculator:
    def __init__(self, excel_path: str):
        self.excel_path = excel_path
        self.orders = []
        self.executed_orders = []

    def load_orders(self):
        """Carrega e valida as ordens da aba Order History."""
        if not os.path.exists(self.excel_path):
            raise FileNotFoundError(f"Arquivo não encontrado: {self.excel_path}")

        print(f"\n[+] Lendo arquivo: {self.excel_path}")
        df = pd.read_excel(self.excel_path, sheet_name="Order History")
        
        # Converter coluna Time com flexibilidade de formato
        df["Time_dt"] = pd.to_datetime(df["Time"], format="mixed")
        
        # Filtrar apenas ordens executadas
        # Na Binance: Status == FILLED ou Trade Qty > 0
        df_executed = df[df["Trade Qty"] > 0].copy()
        
        # Ordenar rigorosamente de forma cronológica (do mais antigo para o mais recente)
        df_executed = df_executed.sort_values("Time_dt").reset_index(drop=True)
        
        orders_list = []
        for _, row in df_executed.iterrows():
            trade_qty = to_decimal(row["Trade Qty"])
            avg_price = to_decimal(row["Average Price"])
            total_value = trade_qty * avg_price
            
            fee = to_decimal(row.get("Fee", 0)) if "Fee" in row and pd.notna(row.get("Fee")) else Decimal("0")
            fee_coin = str(row.get("Fee Coin", "")).strip().upper() if "Fee Coin" in row and pd.notna(row.get("Fee Coin")) else ""
            
            order = {
                "time": row["Time_dt"],
                "market": str(row["Market ID"]).strip(),
                "side": str(row["Side"]).strip().upper(),
                "status": str(row["Status"]).strip().upper(),
                "price": to_decimal(row["Price"]),
                "avg_price": avg_price,
                "trade_qty": trade_qty,
                "total_value": total_value,
                "price_unit": str(row.get("Price Unit", "")).strip(),
                "amount_unit": str(row.get("Amount Unit", "")).strip(),
                "fee": fee,
                "fee_coin": fee_coin,
            }
            orders_list.append(order)
            
        self.executed_orders = orders_list
        print(f"[OK] Total de ordens executadas carregadas: {len(self.executed_orders)}")
        return self.executed_orders

    def calculate_market_pm(self, market: str):
        """
        Calcula as estatísticas de Preço Médio para um mercado específico:
        1. PM Ponderado Geral de Compras
        2. PM Ponderado Geral de Vendas
        3. Custo Médio Ponderado Móvel de Estoque (CMPM) e PnL Realizado
        """
        market_orders = [o for o in self.executed_orders if o["market"] == market]
        
        buys = [o for o in market_orders if o["side"] == "BUY"]
        sells = [o for o in market_orders if o["side"] == "SELL"]
        
        # Somas de Compras
        total_qty_bought = sum((o["trade_qty"] for o in buys), Decimal("0"))
        total_spent_buy = sum((o["total_value"] for o in buys), Decimal("0"))
        pm_buy_simple = (total_spent_buy / total_qty_bought) if total_qty_bought > Decimal("0") else Decimal("0")
        
        # Somas de Vendas
        total_qty_sold = sum((o["trade_qty"] for o in sells), Decimal("0"))
        total_revenue_sell = sum((o["total_value"] for o in sells), Decimal("0"))
        pm_sell_simple = (total_revenue_sell / total_qty_sold) if total_qty_sold > Decimal("0") else Decimal("0")
        
        # Custo Médio Ponderado Móvel (CMPM) - Linha a Linha
        curr_qty = Decimal("0")
        curr_cost = Decimal("0")
        curr_pm = Decimal("0")
        realized_pnl = Decimal("0")
        
        history = []
        for o in market_orders:
            side = o["side"]
            qty = o["trade_qty"]
            price = o["avg_price"]
            total = o["total_value"]
            
            if side == "BUY":
                curr_cost += total
                curr_qty += qty
                curr_pm = curr_cost / curr_qty if curr_qty > Decimal("0") else Decimal("0")
                pnl = Decimal("0")
            elif side == "SELL":
                cost_of_sold = qty * curr_pm
                pnl = total - cost_of_sold
                realized_pnl += pnl
                curr_cost -= cost_of_sold
                curr_qty -= qty
                if curr_qty <= Decimal("0"):
                    curr_qty = Decimal("0")
                    curr_cost = Decimal("0")
                    curr_pm = Decimal("0")
                    
            history.append({
                "time": o["time"],
                "side": side,
                "price": price,
                "qty": qty,
                "total": total,
                "pos_qty": curr_qty,
                "pos_cost": curr_cost,
                "pos_pm": curr_pm,
                "realized_pnl": pnl
            })
            
        return {
            "market": market,
            "buys_count": len(buys),
            "total_qty_bought": total_qty_bought,
            "total_spent_buy": total_spent_buy,
            "pm_buy_simple": pm_buy_simple,
            "sells_count": len(sells),
            "total_qty_sold": total_qty_sold,
            "total_revenue_sell": total_revenue_sell,
            "pm_sell_simple": pm_sell_simple,
            "current_position_qty": curr_qty,
            "current_position_cost": curr_cost,
            "current_moving_pm": curr_pm,
            "total_realized_pnl": realized_pnl,
            "history": history
        }

    def calculate_consolidated(self, custom_usdt_brl_rate: Decimal = None):
        """
        Calcula a Fila Única Cronológica Consolidada (Custo Médio Ponderado Móvel - CMPM em R$):
        - Une todas as ordens de BTC (BTCBRL, BTCUSDT, BTCUSDC e outros pares de dólar/stablecoins)
          em uma única lista cronológica rigorosa.
        - Converte operações e taxas em moeda estrangeira utilizando o Dólar PTAX de Venda do BCB do dia.
        - Na compra (BUY): soma o custo em R$ (incluindo taxas) e recalcula o PM Atual = custo / qtd.
        - Na venda (SELL): baixa o estoque pelo PM Atual, apura PnL em R$ e mantém o PM unitário.
        - Gera o extrato unificado para a aba 'Consolidado_IRPF' e os dados fiscais de 31/12.
        """
        btc_brl = self.calculate_market_pm("BTCBRL")
        btc_usdt = self.calculate_market_pm("BTCUSDT")
        usdt_brl = self.calculate_market_pm("USDTBRL")
        
        # Selecionar todos os pares de BTC
        btc_pairs = {"BTCBRL"}.union(USD_STABLE_PAIRS)
        btc_orders = [o for o in self.executed_orders if o["market"] in btc_pairs]
        btc_orders = sorted(btc_orders, key=lambda x: x["time"])
        
        curr_qty = Decimal("0")
        curr_cost = Decimal("0")
        curr_pm = Decimal("0")
        total_realized_pnl = Decimal("0")
        
        total_btc_bought = Decimal("0")
        total_btc_sold = Decimal("0")
        total_cost_purchases_brl = Decimal("0")
        total_revenue_sales_brl = Decimal("0")
        
        consolidated_history = []
        print("[i] Processando fila única cronológica consolidada e consultando PTAX do BCB...")
        
        for o in btc_orders:
            market = o["market"]
            side = o["side"]
            trade_qty = o["trade_qty"]
            avg_price = o["avg_price"]
            order_date = o["time"].date()
            fee = o.get("fee", Decimal("0"))
            fee_coin = o.get("fee_coin", "")
            
            # 1. Obter cotação PTAX da operação
            if market == "BTCBRL":
                ptax_used = Decimal("1")
                total_order_brl = trade_qty * avg_price
                if fee_coin == "BTC":
                    fee_brl = fee * avg_price
                else:
                    fee_brl = fee
            else:
                ptax_used = custom_usdt_brl_rate if custom_usdt_brl_rate is not None else get_ptax_venda(order_date)
                total_order_brl = (trade_qty * avg_price) * ptax_used
                if fee_coin == "BRL":
                    fee_brl = fee
                elif fee_coin == "BTC":
                    fee_brl = fee * avg_price * ptax_used
                else:  # USDT, USDC, BUSD, USD, etc.
                    fee_brl = fee * ptax_used
                    
            # 2. Regra Contábil / Fiscal do CMPM
            if side == "BUY":
                # Na compra: custo total inclui as taxas de corretagem
                operacao_brl = total_order_brl + fee_brl
                curr_cost += operacao_brl
                curr_qty += trade_qty
                curr_pm = curr_cost / curr_qty if curr_qty > Decimal("0") else Decimal("0")
                pnl = Decimal("0")
                
                total_btc_bought += trade_qty
                total_cost_purchases_brl += operacao_brl
            elif side == "SELL":
                # Na venda: baixa do estoque é calculada pelo PM Atual vigente
                custo_baixa = trade_qty * curr_pm
                # Receita líquida em R$ deduz a taxa de corretagem
                receita_liquida_brl = total_order_brl - fee_brl
                pnl = receita_liquida_brl - custo_baixa
                total_realized_pnl += pnl
                
                curr_cost -= custo_baixa
                curr_qty -= trade_qty
                if curr_qty <= Decimal("0"):
                    curr_qty = Decimal("0")
                    curr_cost = Decimal("0")
                    curr_pm = Decimal("0")
                operacao_brl = receita_liquida_brl
                
                total_btc_sold += trade_qty
                total_revenue_sales_brl += receita_liquida_brl
                
            consolidated_history.append({
                "Data": o["time"],
                "Mercado": market,
                "Lado": side,
                "Qtd BTC": trade_qty,
                "Cotação Original": avg_price,
                "PTAX Utilizada": ptax_used,
                "Total em R$": operacao_brl,
                "Saldo BTC Acumulado": curr_qty,
                "Custo Acumulado R$": curr_cost,
                "PM Atual R$": curr_pm,
                "PnL R$": pnl
            })
            
        rate_source = (
            f"Taxa Personalizada Informada ({custom_usdt_brl_rate})" if custom_usdt_brl_rate is not None
            else "Dólar PTAX de Venda Oficial do BCB (Fila Única - Regra RFB / IRPF)"
        )
        
        return {
            "rate_source": rate_source,
            "total_orders_count": len(consolidated_history),
            "total_btc_bought": total_btc_bought,
            "total_btc_sold": total_btc_sold,
            "net_btc_position": curr_qty,
            "remaining_cost_brl": curr_cost,
            "current_moving_pm_brl": curr_pm,
            "total_realized_pnl_brl": total_realized_pnl,
            "total_cost_purchases_brl": total_cost_purchases_brl,
            "consolidated_history": consolidated_history,
            "btc_brl_stats": btc_brl,
            "btc_usdt_stats": btc_usdt,
            "usdt_brl_stats": usdt_brl
        }


def print_report(res: dict):
    """Exibe o relatório detalhado e formatado no terminal."""
    btc_brl = res["btc_brl_stats"]
    btc_usdt = res["btc_usdt_stats"]
    usdt_brl = res["usdt_brl_stats"]
    
    print("\n" + "=" * 76)
    print("           RELATÓRIO DE PREÇO MÉDIO - BINANCE (ALTA PRECISÃO)           ")
    print("=" * 76)
    
    # 1. MERCADO BTCBRL
    print("\n" + "-" * 76)
    print(" 1. MERCADO: BTC / BRL (Reais)")
    print("-" * 76)
    print(f"  [COMPRAS]")
    print(f"    * Quantidade de Ordens:       {btc_brl['buys_count']} compras")
    print(f"    * Quantidade Total Adquirida: {format_crypto(btc_brl['total_qty_bought'])}")
    print(f"    * Volume Financeiro Total:    {format_brl(btc_brl['total_spent_buy'])}")
    print(f"    * PREÇO MÉDIO PONDERADO:      {format_brl(btc_brl['pm_buy_simple'], 4)} por BTC")
    print(f"  [VENDAS]")
    print(f"    * Quantidade de Ordens:       {btc_brl['sells_count']} vendas")
    print(f"    * Quantidade Total Vendida:   {format_crypto(btc_brl['total_qty_sold'])}")
    print(f"    * Receita Total Obtida:       {format_brl(btc_brl['total_revenue_sell'])}")
    print(f"    * Preço Médio de Venda:       {format_brl(btc_brl['pm_sell_simple'], 4)} por BTC")
    print(f"  [ESTOQUE & CUSTO MÉDIO MÓVEL (CMPM ISOLADO)]")
    print(f"    * Saldo Líquido Remanescente: {format_crypto(btc_brl['current_position_qty'])}")
    print(f"    * Custo do Estoque Atual:     {format_brl(btc_brl['current_position_cost'])}")
    print(f"    * Custo Médio Móvel Atual:    {format_brl(btc_brl['current_moving_pm'], 4)} por BTC")
    print(f"    * Lucro/Prejuízo Realizado:   {format_brl(btc_brl['total_realized_pnl'])}")

    # 2. MERCADO BTCUSDT
    print("\n" + "-" * 76)
    print(" 2. MERCADO: BTC / USDT (Dólares)")
    print("-" * 76)
    print(f"  [COMPRAS]")
    print(f"    * Quantidade de Ordens:       {btc_usdt['buys_count']} compras")
    print(f"    * Quantidade Total Adquirida: {format_crypto(btc_usdt['total_qty_bought'])}")
    print(f"    * Volume Financeiro Total:    {format_usd(btc_usdt['total_spent_buy'])}")
    print(f"    * PREÇO MÉDIO PONDERADO:      {format_usd(btc_usdt['pm_buy_simple'], 4)} por BTC")
    print(f"  [VENDAS]")
    print(f"    * Quantidade de Ordens:       {btc_usdt['sells_count']} vendas")
    print(f"    * Quantidade Total Vendida:   {format_crypto(btc_usdt['total_qty_sold'])}")
    print(f"    * Receita Total Obtida:       {format_usd(btc_usdt['total_revenue_sell'])}")
    print(f"    * Preço Médio de Venda:       {format_usd(btc_usdt['pm_sell_simple'], 4)} por BTC")
    print(f"  [ESTOQUE & CUSTO MÉDIO MÓVEL (CMPM ISOLADO)]")
    print(f"    * Saldo Líquido Remanescente: {format_crypto(btc_usdt['current_position_qty'])}")
    print(f"    * Custo do Estoque Atual:     {format_usd(btc_usdt['current_position_cost'])}")
    print(f"    * Custo Médio Móvel Atual:    {format_usd(btc_usdt['current_moving_pm'], 4)} por BTC")
    print(f"    * Lucro/Prejuízo Realizado:   {format_usd(btc_usdt['total_realized_pnl'])}")

    # 3. MERCADO USDTBRL (Custo de Aquisição do Dólar)
    print("\n" + "-" * 76)
    print(" 3. MERCADO: USDT / BRL (Aquisição de Dólares)")
    print("-" * 76)
    print(f"  [COMPRAS DE DÓLAR/USDT]")
    print(f"    * Quantidade de Ordens:       {usdt_brl['buys_count']} compras")
    print(f"    * Total de USDT Adquirido:    {format_usd(usdt_brl['total_qty_bought'])} USDT")
    print(f"    * Total Despendido em Reais:  {format_brl(usdt_brl['total_spent_buy'])}")
    print(f"    * PREÇO MÉDIO DO USDT (PM):   {format_brl(usdt_brl['pm_buy_simple'], 4)} por USDT")

    # 4. CONSOLIDAÇÃO IRPF (FILA ÚNICA CRONOLÓGICA - CMPM)
    print("\n" + "=" * 76)
    print(" 4. CONSOLIDAÇÃO IRPF (FILA ÚNICA - CUSTO MÉDIO PONDERADO MÓVEL)")
    print("=" * 76)
    print(f"  * Metodologia Fiscal:           Custo Médio Ponderado Móvel (CMPM)")
    print(f"  * Base de Conversão Cambial:    {res['rate_source']}")
    print(f"  * Total de Ordens de BTC:       {res['total_orders_count']} ordens")
    print(f"  * Total Acumulado Comprado:     {format_crypto(res['total_btc_bought'])}")
    print(f"  * Total Acumulado Vendido:      {format_crypto(res['total_btc_sold'])}")
    print("  " + "-" * 72)
    print(f"  >>> QUANTIDADE EM ESTOQUE:       {format_crypto(res['net_btc_position'])}")
    print(f"  >>> CUSTO TOTAL ('31/12 IRPF'):  {format_brl(res['remaining_cost_brl'])}")
    print(f"  >>> PREÇO MÉDIO ATUAL DO ESTOQUE:{format_brl(res['current_moving_pm_brl'], 2)} / BTC  ({format_brl(res['current_moving_pm_brl'], 4)})")
    print("  " + "-" * 72)
    print(f"  * Lucro/Prejuízo Líquido (PnL): {format_brl(res['total_realized_pnl_brl'])}")
    print(f"  * Volume Bruto Comprado (BRL):  {format_brl(res['total_cost_purchases_brl'])}")
    print("=" * 76 + "\n")


def export_history_to_excel(calc: OrderBookCalculator, res: dict, output_file: str = "Historico_PM_Binance.xlsx"):
    """
    Exporta a evolução do Preço Médio para o Excel:
    - Aba 'Consolidado_IRPF': extrato unificado cronológico exigido para conformidade fiscal.
    - Abas individuais: BTCBRL, BTCUSDT, USDTBRL.
    """
    print(f"[+] Gerando planilha detalhada: {output_file} ...")
    
    target_file = output_file
    for attempt in range(5):
        try:
            with pd.ExcelWriter(target_file, engine="openpyxl") as writer:
                # 1. Aba Consolidado_IRPF
                cons_hist = res.get("consolidated_history", [])
                if cons_hist:
                    df_cons = pd.DataFrame(cons_hist)
                    # Selecionar e ordenar as colunas estritamente requisitadas
                    cols = [
                        "Data", "Mercado", "Lado", "Qtd BTC", "Cotação Original",
                        "PTAX Utilizada", "Total em R$", "Saldo BTC Acumulado",
                        "Custo Acumulado R$", "PM Atual R$"
                    ]
                    # Incluir PnL se presente
                    if "PnL R$" in df_cons.columns:
                        cols.append("PnL R$")
                    df_cons = df_cons[[c for c in cols if c in df_cons.columns]]
                    
                    for col in ["Qtd BTC", "Cotação Original", "PTAX Utilizada", "Total em R$", 
                                "Saldo BTC Acumulado", "Custo Acumulado R$", "PM Atual R$", "PnL R$"]:
                        if col in df_cons.columns:
                            df_cons[col] = df_cons[col].apply(lambda x: float(x))
                    df_cons.to_excel(writer, sheet_name="Consolidado_IRPF", index=False)
                    
                # 2. Abas Individuais dos Mercados
                for market in ["BTCBRL", "BTCUSDT", "USDTBRL"]:
                    stats = calc.calculate_market_pm(market)
                    hist = stats["history"]
                    if hist:
                        df_hist = pd.DataFrame(hist)
                        for col in ["price", "qty", "total", "pos_qty", "pos_cost", "pos_pm", "realized_pnl"]:
                            if col in df_hist.columns:
                                df_hist[col] = df_hist[col].apply(lambda x: float(x))
                        df_hist.to_excel(writer, sheet_name=market, index=False)
                        
            print(f"[OK] Planilha gerada com sucesso: {target_file}")
            return
        except PermissionError:
            base, ext = os.path.splitext(output_file)
            target_file = f"{base}_{datetime.now().strftime('%Y%m%d_%H%M%S')}{ext}"
        except Exception as e:
            print(f"[!] Erro ao exportar planilha: {e}")
            return


def main():
    excel_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_EXCEL_PATH
    
    # Suporte a taxa customizada via argumento: python PM.py [caminho] [taxa_dolar]
    custom_rate = None
    if len(sys.argv) > 2:
        try:
            custom_rate = to_decimal(sys.argv[2])
            print(f"[i] Taxa personalizada USDT/BRL definida: {custom_rate}")
        except Exception:
            pass
            
    calc = OrderBookCalculator(excel_path)
    calc.load_orders()
    res = calc.calculate_consolidated(custom_usdt_brl_rate=custom_rate)
    print_report(res)
    
    # Exportar histórico detalhado com aba Consolidado_IRPF
    export_dir = os.path.dirname(os.path.abspath(__file__))
    output_excel = os.path.join(export_dir, "Historico_PM_Binance.xlsx")
    try:
        export_history_to_excel(calc, res, output_excel)
    except Exception as e:
        print(f"[!] Aviso: Não foi possível exportar a planilha detalhada: {e}")

if __name__ == "__main__":
    main()
