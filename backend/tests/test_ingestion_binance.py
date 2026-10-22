import io
import json
import pytest
from decimal import Decimal
import pandas as pd
from unittest.mock import patch
from datetime import datetime, timezone

from app.models.ativo import Ativo
from app.models.carteira import Carteira
from app.models.posicao import PosicaoConsolidada
from app.models.transacao import Transacao
from app.models.enums import TipoAtivo, TipoOperacao
from app.services.ingestion.parser_binance import processar_planilha_binance, CACHE_DIR
from app.schemas.transacao import TransacaoCreate
from app.services.portfolio import processar_transacao


def create_market_order_excel() -> bytes:
    """Gera planilha Excel Spot simples com ordens MARKET (Price=0, Average Price>0)."""
    data = [
        {
            "Time": "2024-01-15 14:30:00",
            "Market ID": "BTCUSDT",
            "Side": "BUY",
            "Status": "FILLED",
            "Price": 0.0,
            "Average Price": 42500.50,
            "Trade Qty": 0.01,
            "Fee": 0.42,
            "Fee Coin": "USDT",
            "Amount Unit": "BTC",
            "Price Unit": "USDT",
        },
        {
            "Time": "2024-02-10 10:15:00",
            "Market ID": "BTCUSDT",
            "Side": "SELL",
            "Status": "FILLED",
            "Price": 0.0,
            "Average Price": 48000.00,
            "Trade Qty": 0.005,
            "Fee": 0.24,
            "Fee Coin": "USDT",
            "Amount Unit": "BTC",
            "Price Unit": "USDT",
        }
    ]
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        pd.DataFrame(data).to_excel(writer, index=False, sheet_name="Spot Order History")
    return output.getvalue()


def create_complete_multi_sheet_excel() -> bytes:
    """Gera planilha Excel simulada com todas as 15 abas / seções do relatório da Binance."""
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        # 1. Account Balance (com seção Earn idêntica à planilha real da Binance)
        rows_acc = [
            ["Spot", None, None, None, None, None, None],
            ["Currency Name", "Currency Code", "All Positions", "Available Positions", "In Withdrawal", "Pending Order", "BTC Equivalent"],
            ["BRL", " ", "0.29759", "0.29759", "0", "0", "7.5E-7"],
            ["Earn - 币安宝账户 - 活期", None, None, None, None, None, None],
            ["Product Name", "Total Amount", "Accruing Interest", "Today Purchased Amount", "Redeeming Amount", "Total Interest", "Average Annual Interest Rate"],
            ["AAVE", "0.68615569", "0.68615569", " ", "0", "0.00084169", " "],
            ["BTC", "0.03331993", "0.03331993", "6E-8", "0", "0.00001784", " "],
            ["ERA", "0.05287865", "0.05287865", " ", "0", "0.22263803", " "],
            ["ETH", "0.06305088", "0.06305088", "1.7E-7", "0", "0.00264288", " "],
            ["PENDLE", "53.87743840", "53.87743840", " ", "0", "0.13123840", " "],
            ["SOL", "2.35153998", "2.35153998", " ", "0", "0.20111941", " "],
            ["SXT", "0.08009479", "0.08009479", " ", "0", "0.05830516", " "],
            ["USDT", "0.85524496", "0.85524496", "0.00009368", "0", "14.01076100", " "],
        ]
        df_acc = pd.DataFrame(rows_acc)
        df_acc.to_excel(writer, index=False, header=False, sheet_name="Account Balance")

        # 3. Fiat Deposit History (PIX)
        df_fiat = pd.DataFrame([
            {"Input Time": "2024-01-05 10:00:00", "Amount": 51162.03, "Fiat Currency": "BRL", "Status": "Successful", "Method": "PIX"},
        ])
        df_fiat.to_excel(writer, index=False, sheet_name="Fiat Deposit History")

        # 4. Crypto Deposits & Withdrawals (Autocustódia)
        df_dep = pd.DataFrame([
            {"Time": "2024-01-20 11:00:00", "Coin": "BTC", "Amount": 0.01, "Status": "Completed"},
        ])
        df_dep.to_excel(writer, index=False, sheet_name="Deposit History")

        df_with = pd.DataFrame([
            {"Time": "2024-02-15 15:00:00", "Coin": "BTC", "Amount": 0.04229884, "Status": "Completed"},
            {"Time": "2024-02-20 16:00:00", "Coin": "ETH", "Amount": 0.53085000, "Status": "Completed"},
            {"Time": "2024-03-01 12:00:00", "Coin": "SOL", "Amount": 22.86095155, "Status": "Completed"},
        ])
        df_with.to_excel(writer, index=False, sheet_name="Withdrawal History")

        # 5. Binance Pay & Card
        df_pay = pd.DataFrame([
            {"Time": "2024-03-05 18:00:00", "Amount": -248.02, "Currency": "BRL", "Status": "Completed", "Type": "Expense"},
        ])
        df_pay.to_excel(writer, index=False, sheet_name="Binance Pay")

        # 6. Spot Order History
        df_spot = pd.DataFrame([
            # Conversão BRL -> USDT
            {
                "Time": "2024-01-05 10:30:00",
                "Market ID": "USDTBRL",
                "Side": "BUY",
                "Status": "FILLED",
                "Price": 5.00,
                "Average Price": 5.00,
                "Trade Qty": 10000.0,
                "Fee": 0.0,
                "Fee Coin": "USDT",
                "Amount Unit": "USDT",
                "Price Unit": "BRL",
            },
            # Compra BTC com Preço Médio (Market order)
            {
                "Time": "2024-01-10 12:00:00",
                "Market ID": "BTCUSDT",
                "Side": "BUY",
                "Status": "FILLED",
                "Price": 0.0,
                "Average Price": 40000.00,
                "Trade Qty": 0.0656,
                "Fee": 0.0,
                "Fee Coin": "BTC",
                "Amount Unit": "BTC",
                "Price Unit": "USDT",
            },
            # Compra ETH
            {
                "Time": "2024-01-12 14:00:00",
                "Market ID": "ETHUSDT",
                "Side": "BUY",
                "Status": "FILLED",
                "Price": 2500.00,
                "Average Price": 2500.00,
                "Trade Qty": 0.5939,
                "Fee": 0.0,
                "Fee Coin": "ETH",
                "Amount Unit": "ETH",
                "Price Unit": "USDT",
            },
            # Compra SOL
            {
                "Time": "2024-01-15 16:00:00",
                "Market ID": "SOLUSDT",
                "Side": "BUY",
                "Status": "FILLED",
                "Price": 100.00,
                "Average Price": 100.00,
                "Trade Qty": 25.212,
                "Fee": 0.0,
                "Fee Coin": "SOL",
                "Amount Unit": "SOL",
                "Price Unit": "USDT",
            },
            # Compra PENDLE
            {
                "Time": "2024-01-18 10:00:00",
                "Market ID": "PENDLEUSDT",
                "Side": "BUY",
                "Status": "FILLED",
                "Price": 1.50,
                "Average Price": 1.50,
                "Trade Qty": 53.877,
                "Fee": 0.0,
                "Fee Coin": "PENDLE",
                "Amount Unit": "PENDLE",
                "Price Unit": "USDT",
            },
            # Compra AAVE
            {
                "Time": "2024-01-19 11:00:00",
                "Market ID": "AAVEUSDT",
                "Side": "BUY",
                "Status": "FILLED",
                "Price": 100.00,
                "Average Price": 100.00,
                "Trade Qty": 0.686,
                "Fee": 0.0,
                "Fee Coin": "AAVE",
                "Amount Unit": "AAVE",
                "Price Unit": "USDT",
            },
        ])
        df_spot.to_excel(writer, index=False, sheet_name="Spot Order History")

        # 7. OTC Trading (ex: SXT venda de airdrop)
        df_otc = pd.DataFrame([
            {
                "Time": "2024-02-01 10:00:00",
                "Base Asset": "SXT",
                "Quote Asset": "USDT",
                "Side": "SELL",
                "Status": "SUCCESS",
                "Price": 0.10,
                "Trade Qty": 16.0,
                "Amount": 1.60,
            }
        ])
        df_otc.to_excel(writer, index=False, sheet_name="OTC Trading")

    return output.getvalue()


@pytest.fixture
def carteira_teste(db_session):
    c = Carteira(nome="Carteira Cripto Teste", descricao="Testes de Cripto")
    db_session.add(c)
    db_session.commit()
    db_session.refresh(c)
    return c


def test_spot_market_order_average_price_priority(db_session, carteira_teste):
    """Verifica que ordens MARKET com Price=0 e Average Price>0 são devidamente importadas."""
    content = create_market_order_excel()
    with patch("app.services.ingestion.parser_binance.get_ptax_venda", return_value=Decimal("5.00")):
        res = processar_planilha_binance(db=db_session, file_content=content, carteira_id=carteira_teste.id)

    assert len(res["transacoes"]) == 2
    assert len(res["pendencias"]) == 0

    tx_buy = res["transacoes"][0]
    assert tx_buy.tipo_operacao == TipoOperacao.BUY
    assert tx_buy.quantidade == Decimal("0.01")
    assert tx_buy.preco_unitario == Decimal("42500.5")

    tx_sell = res["transacoes"][1]
    assert tx_sell.tipo_operacao == TipoOperacao.SELL
    assert tx_sell.quantidade == Decimal("0.005")
    assert tx_sell.preco_unitario == Decimal("48000")


def test_complete_multi_sheet_ingestion(db_session, carteira_teste):
    """Testa a ingestão completa com reconciliação física de 8 decimais, autocustódia, earn e IRPF."""
    content = create_complete_multi_sheet_excel()
    with patch("app.services.ingestion.parser_binance.get_ptax_venda", return_value=Decimal("5.20")):
        res = processar_planilha_binance(db=db_session, file_content=content, carteira_id=carteira_teste.id)

    assert round(res["fiat_depositado_brl"], 2) == Decimal("51162.03")
    assert round(res["gastos_pay_card_brl"], 2) == Decimal("248.02")
    assert "custodia_detalhada" in res

    custodia = res["custodia_detalhada"]
    assert "BTC" in custodia
    assert "ETH" in custodia
    assert "SOL" in custodia
    assert "PENDLE" in custodia
    assert "AAVE" in custodia

    # Reconciliação física dos 8 decimais
    assert pytest.approx(custodia["BTC"]["qtd_total"], 1e-8) == 0.06561877
    assert pytest.approx(custodia["ETH"]["qtd_total"], 1e-8) == 0.59390088
    assert pytest.approx(custodia["SOL"]["qtd_total"], 1e-8) == 25.21249153
    assert pytest.approx(custodia["PENDLE"]["qtd_total"], 1e-8) == 53.87743840
    assert pytest.approx(custodia["AAVE"]["qtd_total"], 1e-8) == 0.68615569

    # Divisão entre Autocustódia e Earn
    assert custodia["BTC"]["pct_earn"] > 0
    assert custodia["BTC"]["pct_autocustodia"] > 0
    assert pytest.approx(custodia["BTC"]["pct_earn"] + custodia["BTC"]["pct_autocustodia"], 0.1) == 100.0

    # Códigos RFB
    assert custodia["BTC"]["codigo_rfb_irpf"] == "08/01"
    assert custodia["ETH"]["codigo_rfb_irpf"] == "08/02"
    assert custodia["SOL"]["codigo_rfb_irpf"] == "08/02"

    # Lucro realizado no airdrop SXT (custo zero, venda positiva)
    assert "SXT" in custodia
    assert custodia["SXT"]["valor_total_vendas_brl"] > 0

    # Verifica persistência no arquivo de cache JSON
    meta_file = CACHE_DIR / f"binance_metadata_{carteira_teste.id}.json"
    assert meta_file.exists()
    with open(meta_file, "r", encoding="utf-8") as f:
        meta_data = json.load(f)
    assert meta_data["carteira_id"] == carteira_teste.id
    assert meta_data["fiat_depositado_brl"] == 51162.03


def test_non_crypto_assets_preserved_during_binance_ingestion(db_session, carteira_teste):
    """Garante que posições e transações de Ações e FIIs permanecem 100% intocadas."""
    # Cria uma ação PETR4 e um FII HGLG11
    ativo_petr4 = Ativo(ticker="PETR4", nome="Petrobras PN", tipo=TipoAtivo.Acao)
    ativo_hglg11 = Ativo(ticker="HGLG11", nome="CSHG Logística", tipo=TipoAtivo.FII)
    db_session.add_all([ativo_petr4, ativo_hglg11])
    db_session.commit()

    # Cria transação de compra para PETR4
    tx_petr4 = TransacaoCreate(
        carteira_id=carteira_teste.id,
        ativo_id=ativo_petr4.id,
        data_hora=datetime(2024, 1, 1, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.BUY,
        quantidade=Decimal("100"),
        preco_unitario=Decimal("30.00"),
        taxas=Decimal("0.0"),
        moeda="BRL"
    )
    processar_transacao(db=db_session, transacao_in=tx_petr4)

    # Executa ingestão Binance
    content = create_market_order_excel()
    with patch("app.services.ingestion.parser_binance.get_ptax_venda", return_value=Decimal("5.00")):
        processar_planilha_binance(db=db_session, file_content=content, carteira_id=carteira_teste.id)

    # Verifica que PETR4 continua exatamente com 100 ações e R$ 30,00 de PM
    pos_petr4 = db_session.query(PosicaoConsolidada).filter(
        PosicaoConsolidada.carteira_id == carteira_teste.id,
        PosicaoConsolidada.ativo_id == ativo_petr4.id
    ).first()
    assert pos_petr4 is not None
    assert pos_petr4.quantidade_saldo == Decimal("100")
    assert pos_petr4.preco_medio_brl == Decimal("30.00")


def test_api_upload_binance_endpoint(client, db_session, carteira_teste):
    """Testa a rota HTTP POST /api/v1/importacao/binance enviando a planilha simulada."""
    content = create_complete_multi_sheet_excel()
    files = {
        "file": ("user_operation_detail.xlsx", content, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    }
    with patch("app.services.ingestion.parser_binance.get_ptax_venda", return_value=Decimal("5.20")):
        response = client.post(f"/api/v1/importacao/binance?carteira_id={carteira_teste.id}", files=files)

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "success"
    assert data["origem"] == "Binance"
    assert data["transacoes_processadas"] > 0


def test_posicoes_endpoint_enriches_crypto_metadata(client, db_session, carteira_teste):
    """Garante que o endpoint GET /api/v1/posicoes resolve o cache e enriquece os metadados de Cripto."""
    content = create_complete_multi_sheet_excel()
    with patch("app.services.ingestion.parser_binance.get_ptax_venda", return_value=Decimal("5.20")):
        processar_planilha_binance(db=db_session, file_content=content, carteira_id=carteira_teste.id)

    response = client.get(f"/api/v1/posicoes?carteira_id={carteira_teste.id}&somente_com_saldo=false")
    assert response.status_code == 200
    posicoes = response.json()
    cripto_pos = {p["ativo"]["ticker"]: p for p in posicoes if p.get("ativo", {}).get("tipo") == "Cripto"}

    assert "BTC" in cripto_pos
    btc = cripto_pos["BTC"]
    assert btc["preco_medio_usd"] is not None
    assert float(btc["preco_medio_usd"]) > 0
    assert btc["qtd_earn"] is not None
    assert btc["qtd_autocustodia"] is not None
    assert btc["codigo_rfb_irpf"] == "08/01"
    assert btc["texto_irpf"] is not None
    assert "autocustódia" in btc["texto_irpf"] or "autocust" in btc["texto_irpf"].lower()

    assert "SOL" in cripto_pos
    sol = cripto_pos["SOL"]
    assert sol["codigo_rfb_irpf"] == "08/02"
    assert sol["qtd_autocustodia"] is not None
    assert sol["qtd_earn"] is not None


def test_airdrop_dust_ignored_keeps_positions_closed(db_session, carteira_teste):
    """
    Garante que frações residuais de poeira (dust) em Earn para moedas liquidadas
    (ERA e SXT) são ignoradas na reconciliação, mantendo quantidade_saldo == 0
    e preservando o status de posição encerrada com lucro realizado.
    """
    content = create_complete_multi_sheet_excel()
    with patch("app.services.ingestion.parser_binance.get_ptax_venda", return_value=Decimal("5.20")):
        res = processar_planilha_binance(db=db_session, file_content=content, carteira_id=carteira_teste.id)

    ativo_sxt = db_session.query(Ativo).filter(Ativo.ticker == "SXT").first()
    assert ativo_sxt is not None
    pos_sxt = db_session.query(PosicaoConsolidada).filter(
        PosicaoConsolidada.carteira_id == carteira_teste.id,
        PosicaoConsolidada.ativo_id == ativo_sxt.id
    ).first()
    assert pos_sxt is not None
    assert pos_sxt.quantidade_saldo == Decimal("0.0")
    assert pos_sxt.preco_medio_brl == Decimal("0.0")
    assert pos_sxt.lucro_realizado_brl > Decimal("0.0")

    custodia = res["custodia_detalhada"]
    assert custodia["SXT"]["qtd_total"] == 0.0
    assert custodia["SXT"]["preco_medio_usd"] == 0.0
    assert custodia["SXT"]["custo_total_usd"] == 0.0
    assert custodia["SXT"]["quantidade_vendida"] == 16.0


def test_usdt_interest_not_injected_into_sol(db_session, carteira_teste):
    """
    Garante que os rendimentos de USDT em Earn não são atribuídos à Solana (SOL),
    ficando restritos ao resumo global da Binance e mantendo os proventos da SOL
    estritamente vinculados aos seus próprios rendimentos de staking.
    """
    content = create_complete_multi_sheet_excel()
    with patch("app.services.ingestion.parser_binance.get_ptax_venda", return_value=Decimal("5.20")):
        res = processar_planilha_binance(db=db_session, file_content=content, carteira_id=carteira_teste.id)

    ativo_sol = db_session.query(Ativo).filter(Ativo.ticker == "SOL").first()
    assert ativo_sol is not None
    pos_sol = db_session.query(PosicaoConsolidada).filter(
        PosicaoConsolidada.carteira_id == carteira_teste.id,
        PosicaoConsolidada.ativo_id == ativo_sol.id
    ).first()

    assert pos_sol is not None
    assert pos_sol.proventos_acumulados_brl < Decimal("150.0")
    meta_file = CACHE_DIR / f"binance_metadata_{carteira_teste.id}.json"
    with open(meta_file, "r", encoding="utf-8") as f:
        meta_data = json.load(f)
    assert meta_data["earn_usdt_usd"] == 14.010761


@pytest.mark.anyio
async def test_cotacoes_cache_persists_and_restores_usdt_and_btc_rates(db_session, carteira_teste):
    """
    Garante que quando as cotações vêm do cache (< 15 min), cotacao_usd_brl não cai
    para o fallback fixo 5.18 e cotacao_btc_brl não fica null.
    """
    from app.services.cotacoes import (
        obter_cotacoes_carteira,
        _MEM_CACHE,
    )
    import time

    now_ts = time.time()
    _MEM_CACHE["__USDTBRL__"] = {"preco_atual": "5.65", "timestamp": now_ts}
    _MEM_CACHE["__BTCUSDT__"] = {"preco_atual": "65000.00", "timestamp": now_ts}
    _MEM_CACHE["BTC"] = {
        "preco_atual": "367250.00",
        "variacao_diaria_pct": "1.5",
        "fonte": "BINANCE",
        "preco_usd": "65000.00",
        "preco_btc": "1.0",
        "timestamp": now_ts,
    }

    resp = await obter_cotacoes_carteira(db=db_session, carteira_id=carteira_teste.id, forcar=False)

    assert resp.cotacao_usd_brl == Decimal("5.65")
    assert resp.cotacao_btc_brl is not None
    assert resp.cotacao_btc_brl == Decimal("65000.00") * Decimal("5.65")


def test_valuable_residual_crypto_not_zeroed_by_dust_filter(db_session, carteira_teste):
    """
    Garante que frações residuais de alto valor financeiro (ex: 0.05 BTC = ~US$ 3.250),
    mesmo que inferiores a 0.1 unidade em moedas com histórico liquidado, NÃO são
    erroneamente classificadas como poeira (dust), enquanto airdrops residuais com
    valor < US$ 0,50 (ex: ERA e SXT) são devidamente zerados.
    """
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        # Account Balance com 0.05 BTC em Earn e 0.05 ERA
        rows_acc = [
            ["Spot", None, None, None, None, None, None],
            ["Currency Name", "Currency Code", "All Positions", "Available Positions", "In Withdrawal", "Pending Order", "BTC Equivalent"],
            ["BRL", " ", "0.0", "0.0", "0", "0", "0"],
            ["Earn - 币安宝账户 - 活期", None, None, None, None, None, None],
            ["Product Name", "Total Amount", "Accruing Interest", "Today Purchased Amount", "Redeeming Amount", "Total Interest", "Average Annual Interest Rate"],
            ["BTC", "0.05000000", "0.05000000", " ", "0", "0.00001000", " "],
            ["ERA", "0.05287865", "0.05287865", " ", "0", "0.00001000", " "],
        ]
        pd.DataFrame(rows_acc).to_excel(writer, index=False, header=False, sheet_name="Account Balance")

        # Spot: Compra e venda de 1 BTC a US$ 65.000 (posição liquidada nos trades)
        df_spot = pd.DataFrame([
            {"Time": "2024-01-10 10:00:00", "Market ID": "BTCUSDT", "Side": "BUY", "Status": "FILLED", "Price": 65000.0, "Average Price": 65000.0, "Trade Qty": 1.0, "Fee": 0.0, "Amount Unit": "BTC", "Price Unit": "USDT"},
            {"Time": "2024-01-15 10:00:00", "Market ID": "BTCUSDT", "Side": "SELL", "Status": "FILLED", "Price": 70000.0, "Average Price": 70000.0, "Trade Qty": 1.0, "Fee": 0.0, "Amount Unit": "BTC", "Price Unit": "USDT"},
        ])
        df_spot.to_excel(writer, index=False, sheet_name="Spot Order History")

        # OTC: Venda do airdrop ERA a US$ 0.10
        df_otc = pd.DataFrame([
            {"Time": "2024-02-01 10:00:00", "Base Asset": "ERA", "Quote Asset": "USDT", "Side": "SELL", "Status": "SUCCESS", "Price": 0.10, "Trade Qty": 50.0, "Amount": 5.0}
        ])
        df_otc.to_excel(writer, index=False, sheet_name="OTC Trading")

    content = output.getvalue()
    with patch("app.services.ingestion.parser_binance.get_ptax_venda", return_value=Decimal("5.20")):
        res = processar_planilha_binance(db=db_session, file_content=content, carteira_id=carteira_teste.id)

    custodia = res["custodia_detalhada"]
    # 0.05 BTC tem valor de US$ 3.250 (> US$ 0,50) -> NÃO deve ser zerado!
    assert custodia["BTC"]["qtd_total"] == 0.05
    assert custodia["BTC"]["preco_medio_usd"] == 0.0  # bonificação física a custo zero

    # 0.0528 ERA tem valor de ~US$ 0,005 (< US$ 0,50) -> DEVE ser zerado mantendo posição encerrada
    assert custodia["ERA"]["qtd_total"] == 0.0
    assert custodia["ERA"]["preco_medio_usd"] == 0.0


def test_dynamic_coin_discovery_without_hardcoded_defaults(db_session, carteira_teste):
    """
    Garante que uma planilha contendo apenas SOL e USDT não gera entradas fantasmas
    para moedas não negociadas (ex: PENDLE, AAVE) na custódia detalhada.
    """
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        rows_acc = [
            ["Spot", None, None, None, None, None, None],
            ["Currency Name", "Currency Code", "All Positions", "Available Positions", "In Withdrawal", "Pending Order", "BTC Equivalent"],
            ["BRL", " ", "0.0", "0.0", "0", "0", "0"],
            ["Earn - 币安宝账户 - 活期", None, None, None, None, None, None],
            ["Product Name", "Total Amount", "Accruing Interest", "Today Purchased Amount", "Redeeming Amount", "Total Interest", "Average Annual Interest Rate"],
            ["SOL", "5.00000000", "5.00000000", " ", "0", "0.10000000", " "],
        ]
        pd.DataFrame(rows_acc).to_excel(writer, index=False, header=False, sheet_name="Account Balance")

        df_spot = pd.DataFrame([
            {"Time": "2024-01-10 10:00:00", "Market ID": "SOLUSDT", "Side": "BUY", "Status": "FILLED", "Price": 120.0, "Average Price": 120.0, "Trade Qty": 5.0, "Fee": 0.0, "Amount Unit": "SOL", "Price Unit": "USDT"},
        ])
        df_spot.to_excel(writer, index=False, sheet_name="Spot Order History")

    content = output.getvalue()
    with patch("app.services.ingestion.parser_binance.get_ptax_venda", return_value=Decimal("5.20")):
        res = processar_planilha_binance(db=db_session, file_content=content, carteira_id=carteira_teste.id)

    custodia = res["custodia_detalhada"]
    assert "SOL" in custodia
    assert "PENDLE" not in custodia
    assert "AAVE" not in custodia
    assert "ERA" not in custodia
    assert "SXT" not in custodia



