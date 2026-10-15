from decimal import Decimal
from unittest.mock import patch
from app.models.enums import TipoAtivo, TipoOperacao, ProdutoRendaFixa, Indexador
from app.schemas.renda_fixa import MacroResponse, SerieMacroRead
from datetime import date, datetime, timezone


def test_api_renda_fixa_endpoints(client):
    # 1. Cria ativo RF
    res_rf = client.post("/api/v1/ativos", json={
        "ticker": "TD-RENDA+-2065",
        "nome": "Tesouro RendA+ Aposentadoria Extra 2065",
        "tipo": "RendaFixa",
        "setor": "Tesouro Direto",
    })
    assert res_rf.status_code == 201, res_rf.text
    rf_id = res_rf.json()["id"]

    # 1b. Cria ativo Acao para testes de conflito
    res_acao = client.post("/api/v1/ativos", json={
        "ticker": "VALE3",
        "nome": "Vale S.A.",
        "tipo": "Acao",
        "setor": "Mineração",
    })
    assert res_acao.status_code == 201
    acao_id = res_acao.json()["id"]

    # 2. PUT /api/v1/renda-fixa/ativos/{ativo_id}/detalhes
    # Tenta em ativo não-RF -> deve retornar 409
    res_det_acao = client.put(f"/api/v1/renda-fixa/ativos/{acao_id}/detalhes", json={
        "produto": "CDB",
        "indexador": "CDI",
        "percentual_indexador": "100.0000",
    })
    assert res_det_acao.status_code == 409

    # Em ativo RF -> 200
    res_det_rf = client.put(f"/api/v1/renda-fixa/ativos/{rf_id}/detalhes", json={
        "produto": "TESOURO_RENDA_MAIS",
        "indexador": "IPCA",
        "ano_conversao": 2065,
        "num_parcelas": 240,
        "dia_pagamento": 15,
        "emissor": "Tesouro Nacional",
    })
    assert res_det_rf.status_code == 200, res_det_rf.text
    det_data = res_det_rf.json()
    assert det_data["ano_conversao"] == 2065
    assert det_data["num_parcelas"] == 240
    assert det_data["cobra_custodia_b3"] is True

    # 3. GET /api/v1/renda-fixa/ativos
    res_list_rf = client.get("/api/v1/renda-fixa/ativos")
    assert res_list_rf.status_code == 200
    rf_list = res_list_rf.json()
    assert len(rf_list) == 1
    assert rf_list[0]["ticker"] == "TD-RENDA+-2065"
    assert rf_list[0]["detalhes_rf"]["ano_conversao"] == 2065

    # 4. POST /api/v1/transacoes com taxa_contratada
    res_tx1 = client.post("/api/v1/transacoes", json={
        "ativo_id": rf_id,
        "tipo_operacao": "BUY",
        "quantidade": "10.0",
        "preco_unitario": "250.00",
        "taxas": "2.00",
        "moeda": "BRL",
        "taxa_contratada": "6.9900",
    })
    assert res_tx1.status_code == 201, res_tx1.text
    tx1_id = res_tx1.json()["id"]
    assert Decimal(str(res_tx1.json()["taxa_contratada"])) == Decimal("6.9900")

    # Transação sem taxa contratada (pendência)
    res_tx2 = client.post("/api/v1/transacoes", json={
        "ativo_id": rf_id,
        "tipo_operacao": "BUY",
        "quantidade": "5.0",
        "preco_unitario": "260.00",
        "taxas": "1.00",
        "moeda": "BRL",
    })
    assert res_tx2.status_code == 201
    tx2_id = res_tx2.json()["id"]
    assert res_tx2.json()["taxa_contratada"] is None

    # 5. GET /api/v1/renda-fixa/lotes
    res_lotes = client.get("/api/v1/renda-fixa/lotes")
    assert res_lotes.status_code == 200
    lotes_data = res_lotes.json()
    assert len(lotes_data["posicoes"]) == 1
    pos_rf = lotes_data["posicoes"][0]
    assert len(pos_rf["lotes"]) == 2
    assert Decimal(str(pos_rf["quantidade_total"])) == Decimal("15.0")
    # Lote 2 deve ter gerado pendência por falta de taxa_contratada
    assert any(str(tx2_id) in p for p in pos_rf["pendencias"])

    # 6. PATCH /api/v1/renda-fixa/transacoes/{id}/taxa
    # Preenche a taxa faltante
    res_patch = client.patch(f"/api/v1/renda-fixa/transacoes/{tx2_id}/taxa", json={
        "taxa_contratada": "7.1400",
    })
    assert res_patch.status_code == 200
    assert Decimal(str(res_patch.json()["taxa_contratada"])) == Decimal("7.1400")

    # Verifica se pendência desapareceu
    res_lotes_pos = client.get("/api/v1/renda-fixa/lotes")
    assert res_lotes_pos.json()["posicoes"][0]["pendencias"] == []

    # 7. Teste de erro 422 ao tentar taxa_contratada em Ação
    res_tx_acao = client.post("/api/v1/transacoes", json={
        "ativo_id": acao_id,
        "tipo_operacao": "BUY",
        "quantidade": "100.0",
        "preco_unitario": "30.00",
        "moeda": "BRL",
    })
    assert res_tx_acao.status_code == 201
    tx_acao_id = res_tx_acao.json()["id"]

    res_patch_err = client.patch(f"/api/v1/renda-fixa/transacoes/{tx_acao_id}/taxa", json={
        "taxa_contratada": "5.0000",
    })
    assert res_patch_err.status_code == 422


def test_api_mercado_endpoints(client):
    # Mock das funções obter_cotacoes_tesouro e obter_dados_macro
    from app.schemas.renda_fixa import EnvelopeMercado

    mock_envelope = EnvelopeMercado(
        fonte="https://fake/bonds.json",
        obtido_em=datetime.now(timezone.utc),
        cache_hit=True,
        stale=False,
        dados={"results": [{"symbol": "tesouro-renda-mais-2065", "buyRate": 6.49}]},
    )

    mock_macro = MacroResponse(
        obtido_em=datetime.now(timezone.utc),
        ipca_12m=SerieMacroRead(
            codigo=433,
            nome="IPCA 12m",
            ultima_data=date(2026, 9, 1),
            valor_bruto=Decimal("0.44"),
            valor_anualizado_pct=Decimal("4.50"),
        ),
        selic=SerieMacroRead(
            codigo=11,
            nome="Taxa Selic",
            ultima_data=date(2026, 10, 6),
            valor_bruto=Decimal("0.0401"),
            valor_anualizado_pct=Decimal("10.60"),
        ),
        cdi=SerieMacroRead(
            codigo=12,
            nome="Taxa CDI",
            ultima_data=date(2026, 10, 6),
            valor_bruto=Decimal("0.0399"),
            valor_anualizado_pct=Decimal("10.55"),
        ),
    )

    with patch("app.api.v1.endpoints.renda_fixa.obter_cotacoes_tesouro", return_value=mock_envelope):
        res_tesouro = client.get("/api/v1/renda-fixa/mercado/tesouro")
        assert res_tesouro.status_code == 200
        assert res_tesouro.json()["cache_hit"] is True
        assert res_tesouro.json()["dados"]["results"][0]["symbol"] == "tesouro-renda-mais-2065"

    with patch("app.api.v1.endpoints.renda_fixa.obter_dados_macro", return_value=mock_macro):
        res_macro = client.get("/api/v1/renda-fixa/mercado/macro")
        assert res_macro.status_code == 200
        assert res_macro.json()["ipca_12m"]["codigo"] == 433
        assert res_macro.json()["cdi"]["codigo"] == 12


def test_api_renda_fixa_cdb_e_filtro_indexador(client):
    # Cria ativo CDB
    res_cdb = client.post("/api/v1/ativos", json={
        "ticker": "CDB-INTER-20261231",
        "nome": "CDB Banco Inter 20261231",
        "tipo": "RendaFixa",
        "setor": "Bancário",
    })
    assert res_cdb.status_code == 201
    cdb_id = res_cdb.json()["id"]

    # Upsert de detalhes sem percentual_indexador inicial
    res_det = client.put(f"/api/v1/renda-fixa/ativos/{cdb_id}/detalhes", json={
        "produto": "CDB",
        "indexador": "CDI",
        "emissor": "Banco Inter",
    })
    assert res_det.status_code == 200
    assert res_det.json()["percentual_indexador"] is None
    assert res_det.json()["isento_ir"] is False
    assert res_det.json()["cobra_custodia_b3"] is False

    # Filtrar por indexador CDI
    res_cdi = client.get("/api/v1/renda-fixa/ativos?indexador=CDI")
    assert res_cdi.status_code == 200
    ativos_cdi = res_cdi.json()
    assert any(a["ticker"] == "CDB-INTER-20261231" for a in ativos_cdi)

