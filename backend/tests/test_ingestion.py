import io
import pytest
from decimal import Decimal
import pandas as pd
from unittest.mock import patch

from app.models.enums import TipoAtivo

def create_b3_excel_in_memory() -> bytes:
    """Gera planilha Excel simulada com padrão da B3 em memória."""
    data = [
        {
            "Data do Negócio": "2024-01-10",
            "Tipo de Movimentação": "Compra",
            "Código de Negociação": "PETR4",
            "Quantidade": 100,
            "Preço": 30.00,
            "Valor da Operação": 3000.00,
            "Taxas": 5.00,
        },
        {
            "Data do Negócio": "2024-01-15",
            "Tipo de Movimentação": "Compra",
            "Código de Negociação": "HGLG11",
            "Quantidade": 10,
            "Preço": 160.00,
            "Valor da Operação": 1600.00,
            "Taxas": 2.00,
        },
        {
            "Data do Negócio": "2024-02-01",
            "Tipo de Movimentação": "Venda",
            "Código de Negociação": "PETR4",
            "Quantidade": 30,
            "Preço": 35.00,
            "Valor da Operação": 1050.00,
            "Taxas": 1.00,
        }
    ]
    df = pd.DataFrame(data)
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="Negociações")
    return output.getvalue()

def create_binance_excel_in_memory() -> bytes:
    """Gera planilha Excel simulada da Binance com aba 'Order History'."""
    data = [
        {
            "Time": "2024-01-10 10:00:00",
            "Market ID": "BTCBRL",
            "Side": "BUY",
            "Status": "FILLED",
            "Price": 200000.00,
            "Average Price": 200000.00,
            "Trade Qty": 0.05,
            "Fee": 0.00005,
            "Fee Coin": "BTC"
        },
        {
            "Time": "2024-01-20 14:30:00",
            "Market ID": "BTCUSDT",
            "Side": "BUY",
            "Status": "FILLED",
            "Price": 42000.00,
            "Average Price": 42000.00,
            "Trade Qty": 0.05,
            "Fee": 2.10,
            "Fee Coin": "USDT"
        },
        {
            "Time": "2024-02-10 16:00:00",
            "Market ID": "BTCUSDT",
            "Side": "SELL",
            "Status": "FILLED",
            "Price": 50000.00,
            "Average Price": 50000.00,
            "Trade Qty": 0.02,
            "Fee": 1.00,
            "Fee Coin": "USDT"
        }
    ]
    df = pd.DataFrame(data)
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="Order History")
    return output.getvalue()

def test_importacao_b3(client):
    """Valida ingestão da planilha B3 via endpoint HTTP."""
    excel_bytes = create_b3_excel_in_memory()
    files = {"file": ("negociacoes_b3.xlsx", excel_bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}

    response = client.post("/api/v1/importacao/b3", files=files)
    assert response.status_code == 200, response.text
    res_data = response.json()
    assert res_data["status"] == "success"
    assert res_data["transacoes_processadas"] == 3

    # Verificar ativos criados
    res_ativos = client.get("/api/v1/ativos")
    assert res_ativos.status_code == 200
    tickers = {a["ticker"]: a["tipo"] for a in res_ativos.json()}
    assert "PETR4" in tickers
    assert tickers["PETR4"] == TipoAtivo.Acao.value
    assert "HGLG11" in tickers
    assert tickers["HGLG11"] == TipoAtivo.FII.value

    # Verificar consolidação das posições
    res_pos = client.get("/api/v1/posicoes")
    assert res_pos.status_code == 200
    posicoes_map = {p["ativo"]["ticker"]: p for p in res_pos.json()}

    # PETR4: Compra 100 @ 30 + 5 taxas = 3005; Venda 30 -> saldo 70; PM = 30.05
    pos_petr4 = posicoes_map["PETR4"]
    assert Decimal(str(pos_petr4["quantidade_saldo"])) == Decimal("70")
    assert Decimal(str(pos_petr4["preco_medio_brl"])) == Decimal("30.05000000")

    # HGLG11: Compra 10 @ 160 + 2 taxas = 1602; PM = 160.20
    pos_hglg = posicoes_map["HGLG11"]
    assert Decimal(str(pos_hglg["quantidade_saldo"])) == Decimal("10")
    assert Decimal(str(pos_hglg["preco_medio_brl"])) == Decimal("160.20000000")

@patch("app.services.ingestion.parser_binance.get_ptax_venda")
def test_importacao_binance(mock_ptax, client):
    """Valida ingestão da planilha Binance via endpoint HTTP com simulação de PTAX."""
    mock_ptax.return_value = Decimal("5.0000")

    excel_bytes = create_binance_excel_in_memory()
    files = {"file": ("binance_orders.xlsx", excel_bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}

    response = client.post("/api/v1/importacao/binance", files=files)
    assert response.status_code == 200, response.text
    res_data = response.json()
    assert res_data["status"] == "success"
    assert res_data["transacoes_processadas"] == 3

    # Verificar ativo BTC
    res_ativos = client.get("/api/v1/ativos")
    assert any(a["ticker"] == "BTC" and a["tipo"] == TipoAtivo.Cripto.value for a in res_ativos.json())

    # Verificar posição de BTC consolidada
    res_pos = client.get("/api/v1/posicoes")
    btc_pos = next(p for p in res_pos.json() if p["ativo"]["ticker"] == "BTC")
    assert Decimal(str(btc_pos["quantidade_saldo"])) == Decimal("0.08")
    assert Decimal(str(btc_pos["preco_medio_brl"])) == Decimal("205205.00000000")
def create_b3_movimentacao_excel_in_memory() -> bytes:
    """Gera planilha Excel simulada de Movimentação de Custódia da B3."""
    data = [
        {
            "Data": "2023-12-20",
            "Movimentação": "Transferência - Liquidação",
            "Produto": "VALE3 - VALE S.A.",
            "Quantidade": 50,
            "Preço unitário": 65.00,
            "Valor da Operação": 3250.00
        },
        {
            "Data": "2023-12-22",
            "Movimentação": "Cessão / Doação de Ativos",
            "Produto": "MXRF11",
            "Quantidade": 100,
            "Preço unitário": 0.0,  # Preço zerado para validar fallback
            "Valor da Operação": 0.0
        },
        {
            "Data": "2023-12-23",
            "Movimentação": "Rendimento / JCP",  # Não deve ser importado como entrada de custódia
            "Produto": "ITUB4",
            "Quantidade": 0,
            "Preço unitário": 0.0,
            "Valor da Operação": 150.00
        }
    ]
    df = pd.DataFrame(data)
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="Movimentação")
    return output.getvalue()

def test_importacao_b3_transferencias(client):
    """Valida ingestão de transferências/entradas de custódia da B3."""
    excel_bytes = create_b3_movimentacao_excel_in_memory()
    files = {"file": ("movimentacoes_b3.xlsx", excel_bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}

    response = client.post("/api/v1/importacao/b3-transferencias", files=files)
    assert response.status_code == 200, response.text
    res_data = response.json()
    assert res_data["status"] == "success"
    assert res_data["transferencias_processadas"] == 2
    assert len(res_data["avisos"]) == 1

    # Verificar ativos criados e saldos
    res_pos = client.get("/api/v1/posicoes")
    assert res_pos.status_code == 200
    posicoes_map = {p["ativo"]["ticker"]: p for p in res_pos.json()}

    assert "VALE3" in posicoes_map
    pos_vale = posicoes_map["VALE3"]
    assert Decimal(str(pos_vale["quantidade_saldo"])) == Decimal("50")
    assert Decimal(str(pos_vale["preco_medio_brl"])) == Decimal("65.00000000")

    assert "MXRF11" in posicoes_map
    pos_mxrf = posicoes_map["MXRF11"]
    assert Decimal(str(pos_mxrf["quantidade_saldo"])) == Decimal("100")
    # Fallback padrão de R$ 1.00
    assert Decimal(str(pos_mxrf["preco_medio_brl"])) == Decimal("1.00000000")

def test_importacao_b3_resiliente_pendencias(client):
    """Valida que uma venda sem saldo registra pendência e não aborta as outras ordens válidas."""
    data = [
        {
            "Data do Negócio": "2024-01-10",
            "Tipo de Movimentação": "Compra",
            "Código de Negociação": "BBDC4",
            "Quantidade": 100,
            "Preço": 15.00,
            "Taxas": 2.00,
        },
        {
            "Data do Negócio": "2024-01-12",
            "Tipo de Movimentação": "Venda",
            "Código de Negociação": "WEGE3",  # Sem saldo prévio
            "Quantidade": 50,
            "Preço": 40.00,
            "Taxas": 1.00,
        },
        {
            "Data do Negócio": "2024-01-15",
            "Tipo de Movimentação": "Compra",
            "Código de Negociação": "BBDC4",
            "Quantidade": 50,
            "Preço": 16.00,
            "Taxas": 1.00,
        }
    ]
    df = pd.DataFrame(data)
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="Negociações")

    files = {"file": ("negociacoes_parciais.xlsx", output.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    response = client.post("/api/v1/importacao/b3", files=files)
    assert response.status_code == 200, response.text
    res_data = response.json()

    assert res_data["transacoes_processadas"] == 2
    assert len(res_data["pendencias"]) == 1
    assert "WEGE3" in res_data["pendencias"][0]
