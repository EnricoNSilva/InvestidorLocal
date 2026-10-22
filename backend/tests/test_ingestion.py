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

def create_b3_movimentacao_excel_in_memory() -> bytes:
    """Gera planilha Excel simulada com padrão de Movimentação da B3 em memória."""
    data = [
        {
            "Data": "2023-12-20",
            "Movimentação": "Transferência de Custódia",
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
            "Preço unitário": 0.0,
            "Valor da Operação": 0.0
        },
        {
            "Data": "2023-12-23",
            "Movimentação": "Rendimento / JCP",
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

def test_importacao_b3_transferencias(client):
    """Valida ingestão de transferências/entradas de custódia da B3."""
    excel_bytes = create_b3_movimentacao_excel_in_memory()
    files = {"file": ("movimentacoes_b3.xlsx", excel_bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}

    response = client.post("/api/v1/importacao/b3-transferencias", files=files)
    assert response.status_code == 200, response.text
    res_data = response.json()
    assert res_data["status"] == "success"
    assert res_data["transferencias_processadas"] == 2
    assert len(res_data["avisos"]) == 0

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
    # Custo zero pois veio sem preço
    assert Decimal(str(pos_mxrf["preco_medio_brl"])) == Decimal("0.00000000")

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

def test_transferencia_seguida_de_venda_total_zera_posicao(client):
    """Garante que transferência seguida de venda total zera a posição e a remove da carteira ativa."""
    # 1. Entrada de 200 MGLU3 via Movimentação (Transferência)
    mov_data = [
        {
            "Data": "2022-03-23",
            "Movimentação": "Transferência",
            "Produto": "MGLU3 - MAGAZINE LUIZA S.A.",
            "Quantidade": 200,
            "Preço unitário": 6.50,
            "Valor da Operação": 1300.00
        },
        # Entrada de liquidação que DEVE ser ignorada (não duplicar compra)
        {
            "Data": "2022-05-19",
            "Movimentação": "Transferência - Liquidação",
            "Produto": "MGLU3 - MAGAZINE LUIZA S.A.",
            "Quantidade": 200,
            "Preço unitário": 4.00,
            "Valor da Operação": 800.00
        }
    ]
    df_mov = pd.DataFrame(mov_data)
    out_mov = io.BytesIO()
    with pd.ExcelWriter(out_mov, engine="openpyxl") as writer:
        df_mov.to_excel(writer, index=False, sheet_name="Movimentação")

    res_mov = client.post(
        "/api/v1/importacao/b3-transferencias",
        files={"file": ("mov.xlsx", out_mov.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    )
    assert res_mov.status_code == 200
    assert res_mov.json()["transferencias_processadas"] == 1  # Apenas a transferência pura, liquidação ignorada!

    # 2. Venda de 200 MGLU3 via Negociação
    neg_data = [
        {
            "Data do Negócio": "2022-08-15",
            "Tipo de Movimentação": "Venda",
            "Código de Negociação": "MGLU3",
            "Quantidade": 200,
            "Preço": 4.50,
            "Taxas": 1.50
        }
    ]
    df_neg = pd.DataFrame(neg_data)
    out_neg = io.BytesIO()
    with pd.ExcelWriter(out_neg, engine="openpyxl") as writer:
        df_neg.to_excel(writer, index=False, sheet_name="Negociações")

    res_neg = client.post(
        "/api/v1/importacao/b3",
        files={"file": ("neg.xlsx", out_neg.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    )
    assert res_neg.status_code == 200
    assert res_neg.json()["transacoes_processadas"] == 1

    # 3. Consulta de posições ativas (somente_com_saldo=true)
    res_pos = client.get("/api/v1/posicoes?somente_com_saldo=true")
    assert res_pos.status_code == 200
    tickers_em_custodia = [p["ativo"]["ticker"] for p in res_pos.json()]
    assert "MGLU3" not in tickers_em_custodia

    # Consulta de todas as posições (com saldo zerado)
    res_todas = client.get("/api/v1/posicoes?somente_com_saldo=false")
    mglu_pos = next(p for p in res_todas.json() if p["ativo"]["ticker"] == "MGLU3")
    assert Decimal(str(mglu_pos["quantidade_saldo"])) == Decimal("0")
    assert Decimal(str(mglu_pos["preco_medio_brl"])) == Decimal("0")
    assert Decimal(str(mglu_pos["custo_total_brl"])) == Decimal("0")

def test_consolidacao_casos_reais_usuario(client):
    """
    Testa exatamente os casos solicitados pelo usuário:
    - IRBR3: 500 (transf) + 500 + 700 + 700 (neg) = 2400
    - VBBR3: 50 (neg, normalizado de VBBR3F)
    - BBDC3: 100 (neg)
    - MGLU3: 200 compra - 200 venda = 0 (não aparece)
    - AESB1: 70 direito - 70 expirado + 2 direito = 2
    - ITSA4: 1520 (transf) + 152 (bonificação) = 1672
    """
    # 1. Movimentação
    mov_data = [
        {"Data": "23/03/2022", "Movimentação": "Transferência", "Produto": "IRBR3 - IRB BRASIL", "Quantidade": 500, "Preço unitário": "-", "Valor da Operação": "-"},
        {"Data": "23/03/2022", "Movimentação": "Transferência", "Produto": "ITSA4 - ITAUSA", "Quantidade": 1520, "Preço unitário": "-", "Valor da Operação": "-"},
        {"Data": "15/08/2022", "Movimentação": "Direito de Subscrição", "Produto": "AESB1", "Quantidade": 70, "Preço unitário": "-", "Valor da Operação": "-"},
        {"Data": "12/09/2022", "Movimentação": "Direitos de Subscrição - Não Exercido", "Produto": "AESB1", "Quantidade": 70, "Preço unitário": "-", "Valor da Operação": "-"},
        {"Data": "12/12/2022", "Movimentação": "Direito de Subscrição", "Produto": "AESB1", "Quantidade": 2, "Preço unitário": "-", "Valor da Operação": "-"},
        {"Data": "14/11/2022", "Movimentação": "Bonificação em Ativos", "Produto": "ITSA4", "Quantidade": 152, "Preço unitário": "-", "Valor da Operação": "-"},
        # Linha que deve ser ignorada:
        {"Data": "14/11/2022", "Movimentação": "Transferência - Liquidação", "Produto": "VBBR3", "Quantidade": 50, "Preço unitário": 17.29, "Valor da Operação": 864.50},
    ]
    df_mov = pd.DataFrame(mov_data)
    out_mov = io.BytesIO()
    with pd.ExcelWriter(out_mov, engine="openpyxl") as writer:
        df_mov.to_excel(writer, index=False, sheet_name="Movimentação")

    res_mov = client.post("/api/v1/importacao/b3-transferencias", files={"file": ("mov.xlsx", out_mov.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert res_mov.status_code == 200

    # 2. Negociação
    neg_data = [
        {"Data do Negócio": "02/05/2022", "Tipo de Movimentação": "Compra", "Código de Negociação": "IRBR3", "Quantidade": 500, "Preço": 2.71, "Valor": 1355.0},
        {"Data do Negócio": "17/05/2022", "Tipo de Movimentação": "Compra", "Código de Negociação": "MGLU3", "Quantidade": 200, "Preço": 3.95, "Valor": 790.0},
        {"Data do Negócio": "05/07/2022", "Tipo de Movimentação": "Compra", "Código de Negociação": "BBDC3", "Quantidade": 100, "Preço": 14.13, "Valor": 1413.0},
        {"Data do Negócio": "15/08/2022", "Tipo de Movimentação": "Venda", "Código de Negociação": "MGLU3", "Quantidade": 200, "Preço": 3.91, "Valor": 782.0},
        {"Data do Negócio": "29/08/2022", "Tipo de Movimentação": "Compra", "Código de Negociação": "IRBR3", "Quantidade": 700, "Preço": 1.90, "Valor": 1330.0},
        {"Data do Negócio": "01/09/2022", "Tipo de Movimentação": "Compra", "Código de Negociação": "IRBR3", "Quantidade": 700, "Preço": 1.42, "Valor": 994.0},
        {"Data do Negócio": "10/11/2022", "Tipo de Movimentação": "Compra", "Código de Negociação": "VBBR3F", "Quantidade": 50, "Preço": 17.29, "Valor": 864.5},
    ]
    df_neg = pd.DataFrame(neg_data)
    out_neg = io.BytesIO()
    with pd.ExcelWriter(out_neg, engine="openpyxl") as writer:
        df_neg.to_excel(writer, index=False, sheet_name="Negociações")

    res_neg = client.post("/api/v1/importacao/b3", files={"file": ("neg.xlsx", out_neg.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert res_neg.status_code == 200

    # 3. Validar posições ativas consolidadas
    res_pos = client.get("/api/v1/posicoes?somente_com_saldo=true")
    assert res_pos.status_code == 200
    pos_map = {p["ativo"]["ticker"]: p for p in res_pos.json()}

    # IRBR3: 500 + 500 + 700 + 700 = 2400
    assert "IRBR3" in pos_map
    assert Decimal(str(pos_map["IRBR3"]["quantidade_saldo"])) == Decimal("2400")
    assert Decimal(str(pos_map["IRBR3"]["custo_total_brl"])) == Decimal("3679.0000")
    # Regra 1.1: Preço Médio provisório sobre quantidade_com_custo (1900): 3679 / 1900 = 1.93631579
    assert Decimal(str(pos_map["IRBR3"]["preco_medio_brl"])) == Decimal("1.93631579")
    assert pos_map["IRBR3"]["custo_pendente"] is True
    assert Decimal(str(pos_map["IRBR3"]["quantidade_sem_custo"])) == Decimal("500")

    # VBBR3: normalizado de VBBR3F, 50 unidades
    assert "VBBR3" in pos_map
    assert Decimal(str(pos_map["VBBR3"]["quantidade_saldo"])) == Decimal("50")
    assert Decimal(str(pos_map["VBBR3"]["custo_total_brl"])) == Decimal("864.5000")

    # BBDC3: 100 unidades
    assert "BBDC3" in pos_map
    assert Decimal(str(pos_map["BBDC3"]["quantidade_saldo"])) == Decimal("100")
    assert Decimal(str(pos_map["BBDC3"]["custo_total_brl"])) == Decimal("1413.0000")

    # MGLU3: 200 - 200 = 0 -> NÃO DEVE APARECER
    assert "MGLU3" not in pos_map

    # AESB1: 70 - 70 + 2 = 2 unidades
    assert "AESB1" in pos_map
    assert Decimal(str(pos_map["AESB1"]["quantidade_saldo"])) == Decimal("2")
    assert Decimal(str(pos_map["AESB1"]["custo_total_brl"])) == Decimal("0.0000")

    # ITSA4: 1520 + 152 bonificação = 1672 unidades
    assert "ITSA4" in pos_map
    assert Decimal(str(pos_map["ITSA4"]["quantidade_saldo"])) == Decimal("1672")
    assert Decimal(str(pos_map["ITSA4"]["custo_total_brl"])) == Decimal("0.0000")
