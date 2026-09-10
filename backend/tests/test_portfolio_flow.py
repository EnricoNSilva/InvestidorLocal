import pytest
from datetime import datetime
from decimal import Decimal

def test_portfolio_flow_cmpm(client):
    """
    Simulação e validação matemática de:
    1. Cadastro de ativo (PETR4).
    2. Compra 1: 100 ações @ R$ 30,00, taxas R$ 5,00.
       - Custo = (100 * 30) + 5 = R$ 3005,00.
       - Saldo = 100.
       - PM = 3005 / 100 = R$ 30,05.
    3. Compra 2: 100 ações @ R$ 40,00, taxas R$ 5,00.
       - Custo da compra = (100 * 40) + 5 = R$ 4005,00.
       - Novo custo total = 3005 + 4005 = R$ 7010,00.
       - Novo saldo = 200.
       - Novo PM = 7010 / 200 = R$ 35,05.
    4. Venda Parcial: 50 ações @ R$ 50,00, taxas R$ 5,00.
       - Custo baixado = 50 * 35,05 = R$ 1752,50.
       - Saldo restante = 150.
       - Custo restante = 7010 - 1752,50 = R$ 5257,50.
       - PM unitário inalterado = R$ 35,05.
    5. Venda Total restante: 150 ações.
       - Saldo = 0.
       - Custo total = 0.
       - PM = 0.
    """
    # 1. Cadastrar Ativo
    res_ativo = client.post("/api/v1/ativos", json={
        "ticker": "PETR4",
        "nome": "Petróleo Brasileiro S.A.",
        "tipo": "Acao",
        "setor": "Petróleo e Gás"
    })
    assert res_ativo.status_code == 201, res_ativo.text
    ativo_data = res_ativo.json()
    ativo_id = ativo_data["id"]
    assert ativo_data["ticker"] == "PETR4"

    # 2. Primeira Compra: 100 @ R$ 30,00, taxas R$ 5,00
    res_compra1 = client.post("/api/v1/transacoes", json={
        "ativo_id": ativo_id,
        "tipo_operacao": "BUY",
        "quantidade": "100",
        "preco_unitario": "30.00",
        "taxas": "5.00",
        "moeda": "BRL"
    })
    assert res_compra1.status_code == 201, res_compra1.text

    # Verifica posição após compra 1
    res_pos = client.get("/api/v1/posicoes")
    assert res_pos.status_code == 200
    posicoes = res_pos.json()
    assert len(posicoes) == 1
    pos1 = posicoes[0]
    assert Decimal(str(pos1["quantidade_saldo"])) == Decimal("100")
    assert Decimal(str(pos1["custo_total_brl"])) == Decimal("3005.0000")
    assert Decimal(str(pos1["preco_medio_brl"])) == Decimal("30.05000000")

    # 3. Segunda Compra: 100 @ R$ 40,00, taxas R$ 5,00
    res_compra2 = client.post("/api/v1/transacoes", json={
        "ativo_id": ativo_id,
        "tipo_operacao": "BUY",
        "quantidade": "100",
        "preco_unitario": "40.00",
        "taxas": "5.00",
        "moeda": "BRL"
    })
    assert res_compra2.status_code == 201

    # Verifica posição após compra 2
    res_pos = client.get("/api/v1/posicoes")
    pos2 = res_pos.json()[0]
    assert Decimal(str(pos2["quantidade_saldo"])) == Decimal("200")
    assert Decimal(str(pos2["custo_total_brl"])) == Decimal("7010.0000")
    assert Decimal(str(pos2["preco_medio_brl"])) == Decimal("35.05000000")

    # 4. Venda Parcial: 50 @ R$ 50,00
    res_venda1 = client.post("/api/v1/transacoes", json={
        "ativo_id": ativo_id,
        "tipo_operacao": "SELL",
        "quantidade": "50",
        "preco_unitario": "50.00",
        "taxas": "5.00",
        "moeda": "BRL"
    })
    assert res_venda1.status_code == 201

    res_pos = client.get("/api/v1/posicoes")
    pos3 = res_pos.json()[0]
    assert Decimal(str(pos3["quantidade_saldo"])) == Decimal("150")
    assert Decimal(str(pos3["custo_total_brl"])) == Decimal("5257.5000")
    # PM se mantém rigorosamente em 35.05
    assert Decimal(str(pos3["preco_medio_brl"])) == Decimal("35.05000000")

    # 5. Tentativa de Venda a Descoberto (Acima do saldo) -> Deve retornar 400
    res_venda_invalida = client.post("/api/v1/transacoes", json={
        "ativo_id": ativo_id,
        "tipo_operacao": "SELL",
        "quantidade": "200",
        "preco_unitario": "50.00",
        "taxas": "0.00",
        "moeda": "BRL"
    })
    assert res_venda_invalida.status_code == 400
    assert "Saldo insuficiente" in res_venda_invalida.json()["detail"]

    # 6. Venda total restante: 150
    res_venda_total = client.post("/api/v1/transacoes", json={
        "ativo_id": ativo_id,
        "tipo_operacao": "SELL",
        "quantidade": "150",
        "preco_unitario": "45.00",
        "taxas": "0.00",
        "moeda": "BRL"
    })
    assert res_venda_total.status_code == 201

    # Ao listar com somente_com_saldo=True (default), não deve vir na lista
    res_pos = client.get("/api/v1/posicoes")
    assert len(res_pos.json()) == 0

    # Ao listar com somente_com_saldo=False, traz a posição zerada
    res_pos_todas = client.get("/api/v1/posicoes?somente_com_saldo=false")
    pos_zerada = res_pos_todas.json()[0]
    assert Decimal(str(pos_zerada["quantidade_saldo"])) == Decimal("0")
    assert Decimal(str(pos_zerada["custo_total_brl"])) == Decimal("0")
    assert Decimal(str(pos_zerada["preco_medio_brl"])) == Decimal("0")

    # 7. Verifica histórico de transações
    res_historico = client.get(f"/api/v1/transacoes?ativo_id={ativo_id}")
    assert res_historico.status_code == 200
    historico = res_historico.json()
    assert len(historico) == 4
