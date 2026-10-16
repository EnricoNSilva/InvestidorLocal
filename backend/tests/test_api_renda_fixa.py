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


def test_cadastro_manual_cdb_e_lci_com_lotes_e_cmpm(client):
    # 1. Cadastro manual de CDB 110% CDI sem ticker explícito (geração automática)
    res_cdb = client.post("/api/v1/renda-fixa/cadastro-manual", json={
        "nome": "CDB Banco Inter 110% CDI",
        "detalhes": {
            "produto": "CDB",
            "indexador": "CDI",
            "percentual_indexador": "110.0000",
            "emissor": "Banco Inter",
            "data_vencimento": "2028-01-15",
        },
        "lote_inicial": {
            "carteira_id": 1,
            "data_compra": "2024-01-15",
            "quantidade": "10.00000000",
            "preco_unitario": "1000.00000000",
            "taxa_contratada": "110.0000",
            "taxas": "0.00000000",
        },
    })
    assert res_cdb.status_code == 201, res_cdb.text
    cdb_data = res_cdb.json()
    cdb_id = cdb_data["ativo"]["id"]
    assert cdb_data["ativo"]["ticker"].startswith("CDB-")
    assert cdb_data["ativo"]["detalhes_rf"]["isento_ir"] is False
    assert cdb_data["ativo"]["detalhes_rf"]["cobra_custodia_b3"] is False
    assert Decimal(str(cdb_data["ativo"]["detalhes_rf"]["percentual_indexador"])) == Decimal("110.0000")
    assert len(cdb_data["lotes"]) == 1
    assert Decimal(str(cdb_data["quantidade_total"])) == Decimal("10.00000000")
    assert Decimal(str(cdb_data["custo_total_brl"])) == Decimal("10000.00000000")
    assert cdb_data["pendencias"] == []

    # 2. Adiciona segundo lote no CDB via POST /ativos/{ativo_id}/lotes
    res_lote2 = client.post(f"/api/v1/renda-fixa/ativos/{cdb_id}/lotes", json={
        "carteira_id": 1,
        "data_compra": "2024-06-15",
        "quantidade": "5.00000000",
        "preco_unitario": "1050.00000000",
        "taxa_contratada": "110.0000",
        "taxas": "0.00000000",
    })
    assert res_lote2.status_code == 201, res_lote2.text
    lote2_data = res_lote2.json()
    assert len(lote2_data["lotes"]) == 2
    assert Decimal(str(lote2_data["quantidade_total"])) == Decimal("15.00000000")
    assert Decimal(str(lote2_data["custo_total_brl"])) == Decimal("15250.00000000")

    # Verifica posição consolidada CMPM na carteira
    res_cart = client.get("/api/v1/posicoes")
    assert res_cart.status_code == 200
    pos_cart = next((p for p in res_cart.json() if p["ativo_id"] == cdb_id), None)
    assert pos_cart is not None
    assert Decimal(str(pos_cart["quantidade_saldo"])) == Decimal("15.00000000")
    assert Decimal(str(pos_cart["custo_total_brl"])) == Decimal("15250.00000000")
    assert abs(Decimal(str(pos_cart["preco_medio_brl"])) - (Decimal("15250") / Decimal("15"))) < Decimal("0.0001")

    # 3. Cadastro manual de LCI 93% CDI (isenta de IR, sem taxa B3)
    res_lci = client.post("/api/v1/renda-fixa/cadastro-manual", json={
        "ticker": "LCI-ITAU-20261015",
        "nome": "LCI Itaú 93% CDI",
        "detalhes": {
            "produto": "LCI",
            "indexador": "CDI",
            "percentual_indexador": "93.0000",
            "emissor": "Banco Itaú",
            "data_vencimento": "2026-10-15",
        },
        "lote_inicial": {
            "carteira_id": 1,
            "data_compra": "2025-01-10",
            "quantidade": "20.00000000",
            "preco_unitario": "1000.00000000",
            "taxa_contratada": "93.0000",
            "taxas": "0.00000000",
        },
    })
    assert res_lci.status_code == 201, res_lci.text
    lci_data = res_lci.json()
    assert lci_data["ativo"]["ticker"] == "LCI-ITAU-20261015"
    assert lci_data["ativo"]["detalhes_rf"]["isento_ir"] is True
    assert lci_data["ativo"]["detalhes_rf"]["cobra_custodia_b3"] is False
    assert Decimal(str(lci_data["ativo"]["detalhes_rf"]["percentual_indexador"])) == Decimal("93.0000")
    assert len(lci_data["lotes"]) == 1
    assert Decimal(str(lci_data["quantidade_total"])) == Decimal("20.00000000")

    # 4. GET /api/v1/renda-fixa/lotes deve extrair CDB e LCI corretamente
    res_lotes_peps = client.get("/api/v1/renda-fixa/lotes")
    assert res_lotes_peps.status_code == 200
    posicoes = res_lotes_peps.json()["posicoes"]
    tickers_presentes = [p["ativo"]["ticker"] for p in posicoes]
    assert cdb_data["ativo"]["ticker"] in tickers_presentes
    assert "LCI-ITAU-20261015" in tickers_presentes

    # 5. Validação de erros
    # Lote em ativo inexistente
    res_err_404 = client.post("/api/v1/renda-fixa/ativos/99999/lotes", json={
        "data_compra": "2025-01-10",
        "quantidade": "1.0",
        "preco_unitario": "1000.0",
        "taxa_contratada": "100.0",
    })
    assert res_err_404.status_code == 404

    # Lote em ativo que não é RendaFixa
    res_acao = client.post("/api/v1/ativos", json={
        "ticker": "PETR4",
        "nome": "Petrobras PN",
        "tipo": "Acao",
    })
    acao_id = res_acao.json()["id"]
    res_err_tipo = client.post(f"/api/v1/renda-fixa/ativos/{acao_id}/lotes", json={
        "data_compra": "2025-01-10",
        "quantidade": "1.0",
        "preco_unitario": "1000.0",
        "taxa_contratada": "100.0",
    })
    assert res_err_tipo.status_code == 409


def test_cadastro_manual_sem_lote_inicial_e_taxas_nulas(client):
    # 1. Cadastro manual de CDB sem lote inicial e com emissor com acentuação ("Banco Itaú S.A.")
    res = client.post("/api/v1/renda-fixa/cadastro-manual", json={
        "nome": "CDB Banco Itaú 120% CDI 2029",
        "detalhes": {
            "produto": "CDB",
            "indexador": "CDI",
            "percentual_indexador": "120.0000",
            "emissor": "Banco Itaú S.A.",
            "data_vencimento": "2029-01-01",
        },
        "lote_inicial": None,
    })
    assert res.status_code == 201, res.text
    data = res.json()
    ativo = data["ativo"]
    assert ativo["ticker"].startswith("CDB-BANCOITAUSA-20290101")
    assert data["lotes"] == []
    assert Decimal(str(data["quantidade_total"])) == Decimal("0")
    assert Decimal(str(data["custo_total_brl"])) == Decimal("0")
    ativo_id = ativo["id"]

    # 2. Adiciona lote com taxas = None (null no JSON)
    res_lote = client.post(f"/api/v1/renda-fixa/ativos/{ativo_id}/lotes", json={
        "carteira_id": 1,
        "data_compra": "2025-01-15",
        "quantidade": "8.00000000",
        "preco_unitario": "1000.00000000",
        "taxa_contratada": "120.0000",
        "taxas": None,
    })
    assert res_lote.status_code == 201, res_lote.text
    lote_data = res_lote.json()
    assert len(lote_data["lotes"]) == 1
    assert Decimal(str(lote_data["quantidade_total"])) == Decimal("8.00000000")
    assert Decimal(str(lote_data["custo_total_brl"])) == Decimal("8000.00000000")

    # 3. Validação de regras de negócio em LoteManualCreate: quantidade <= 0, preco_unitario <= 0, taxa fora da faixa
    res_qtd_invalida = client.post(f"/api/v1/renda-fixa/ativos/{ativo_id}/lotes", json={
        "data_compra": "2025-01-15",
        "quantidade": "0.0",
        "preco_unitario": "1000.0",
        "taxa_contratada": "120.0",
    })
    assert res_qtd_invalida.status_code == 422

    res_preco_invalido = client.post(f"/api/v1/renda-fixa/ativos/{ativo_id}/lotes", json={
        "data_compra": "2025-01-15",
        "quantidade": "1.0",
        "preco_unitario": "0.0",
        "taxa_contratada": "120.0",
    })
    assert res_preco_invalido.status_code == 422

    res_taxa_invalida = client.post(f"/api/v1/renda-fixa/ativos/{ativo_id}/lotes", json={
        "data_compra": "2025-01-15",
        "quantidade": "1.0",
        "preco_unitario": "1000.0",
        "taxa_contratada": "1500.0",
    })
    assert res_taxa_invalida.status_code == 422


def test_cadastro_manual_sem_ticker_e_sem_emissor(client):
    """Garante que o cadastro manual sem ticker e sem emissor não gera TypeError no slug."""
    res = client.post("/api/v1/renda-fixa/cadastro-manual", json={
        "nome": "CDB Genérico Sem Emissor 105% CDI",
        "ticker": None,
        "detalhes": {
            "produto": "CDB",
            "indexador": "CDI",
            "percentual_indexador": "105.0000",
            "emissor": None,
            "data_vencimento": "2028-06-01",
        },
        "lote_inicial": {
            "carteira_id": 1,
            "data_compra": "2026-10-15",
            "quantidade": "2.00000000",
            "preco_unitario": "1000.00000000",
            "taxa_contratada": "105.0000",
            "taxas": "0.00000000",
        },
    })
    assert res.status_code == 201, res.text
    data = res.json()
    assert data["ativo"]["ticker"] == "CDB-EMISSOR-20280601"
    assert len(data["lotes"]) == 1
    assert Decimal(str(data["quantidade_total"])) == Decimal("2.00000000")


def test_crud_ativo_renda_fixa(client):
    # 1. Cria ativo RF
    res1 = client.post("/api/v1/renda-fixa/cadastro-manual", json={
        "ticker": "CDB-TEST-20270101",
        "nome": "CDB Banco Teste 100% CDI",
        "detalhes": {
            "produto": "CDB",
            "indexador": "CDI",
            "percentual_indexador": "100.0000",
            "emissor": "Banco Teste",
            "data_vencimento": "2027-01-01",
        },
        "lote_inicial": {
            "carteira_id": 1,
            "data_compra": "2025-01-01",
            "quantidade": "5.0",
            "preco_unitario": "1000.0",
            "taxa_contratada": "100.0",
            "taxas": "0.0",
        },
    })
    assert res1.status_code == 201, res1.text
    ativo_id = res1.json()["ativo"]["id"]

    # 2. Cria outro ativo RF para teste de conflito de ticker
    res2 = client.post("/api/v1/renda-fixa/cadastro-manual", json={
        "ticker": "LCI-OTHER-20261231",
        "nome": "LCI Outro Banco 90% CDI",
        "detalhes": {
            "produto": "LCI",
            "indexador": "CDI",
            "percentual_indexador": "90.0000",
            "emissor": "Outro Banco",
            "data_vencimento": "2026-12-31",
        },
    })
    assert res2.status_code == 201, res2.text

    # 3. PUT em ativo inexistente -> 404
    res_404 = client.put("/api/v1/renda-fixa/ativos/99999", json={
        "ticker": "CDB-NOVO",
        "nome": "Novo Nome",
        "detalhes": {
            "produto": "CDB",
            "indexador": "CDI",
            "emissor": "Banco",
        },
    })
    assert res_404.status_code == 404

    # 4. PUT tentando usar ticker do outro ativo -> 409
    res_409 = client.put(f"/api/v1/renda-fixa/ativos/{ativo_id}", json={
        "ticker": "LCI-OTHER-20261231",
        "nome": "Tentativa Ticker Conflitante",
        "detalhes": {
            "produto": "CDB",
            "indexador": "CDI",
            "emissor": "Banco Teste",
        },
    })
    assert res_409.status_code == 409

    # 5. PUT bem sucedido atualizando ticker, nome e detalhes
    res_up = client.put(f"/api/v1/renda-fixa/ativos/{ativo_id}", json={
        "ticker": "CDB-TEST-UPDATED-2027",
        "nome": "CDB Banco Teste Atualizado 115% CDI",
        "detalhes": {
            "produto": "CDB",
            "indexador": "CDI",
            "percentual_indexador": "115.0000",
            "emissor": "Banco Teste S.A.",
            "data_vencimento": "2027-06-30",
        },
    })
    assert res_up.status_code == 200, res_up.text
    data_up = res_up.json()
    assert data_up["ativo"]["ticker"] == "CDB-TEST-UPDATED-2027"
    assert data_up["ativo"]["nome"] == "CDB Banco Teste Atualizado 115% CDI"
    assert data_up["ativo"]["detalhes_rf"]["emissor"] == "Banco Teste S.A."
    assert Decimal(str(data_up["ativo"]["detalhes_rf"]["percentual_indexador"])) == Decimal("115.0000")
    assert len(data_up["lotes"]) == 1


def test_crud_lote_renda_fixa_e_sincronia_cmpm_peps(client):
    # 1. Cria ativo RF com lote inicial: 10 @ 1000 = 10000
    res_ativo = client.post("/api/v1/renda-fixa/cadastro-manual", json={
        "ticker": "CDB-SINCRONIA-2028",
        "nome": "CDB Sincronia CMPM e PEPS",
        "detalhes": {
            "produto": "CDB",
            "indexador": "CDI",
            "percentual_indexador": "110.0000",
            "emissor": "Banco Sincronia",
            "data_vencimento": "2028-12-31",
        },
        "lote_inicial": {
            "carteira_id": 1,
            "data_compra": "2025-01-10",
            "quantidade": "10.0",
            "preco_unitario": "1000.0",
            "taxa_contratada": "110.0",
            "taxas": "0.0",
        },
    })
    assert res_ativo.status_code == 201
    ativo_id = res_ativo.json()["ativo"]["id"]
    lote1_id = res_ativo.json()["lotes"][0]["transacao_id"]

    # 2. Adiciona segundo lote: 5 @ 1100 + 50 de taxas = 5550. Total = 15550
    res_lote2 = client.post(f"/api/v1/renda-fixa/ativos/{ativo_id}/lotes", json={
        "carteira_id": 1,
        "data_compra": "2025-02-10",
        "quantidade": "5.0",
        "preco_unitario": "1100.0",
        "taxa_contratada": "112.0",
        "taxas": "50.0",
    })
    assert res_lote2.status_code == 201
    lote2_id = res_lote2.json()["lotes"][1]["transacao_id"]

    # Valida PEPS e CMPM antes da edição
    pos_cart = next(p for p in client.get("/api/v1/posicoes").json() if p["ativo_id"] == ativo_id)
    assert Decimal(str(pos_cart["quantidade_saldo"])) == Decimal("15.0")
    assert Decimal(str(pos_cart["custo_total_brl"])) == Decimal("15550.0")

    # 3. Edita o segundo lote via PUT /lotes/{transacao_id}
    # Altera para: 8 @ 1200 + 0 taxas = 9600. Novo total: 10000 + 9600 = 19600, qtd = 18.0
    res_edit_lote2 = client.put(f"/api/v1/renda-fixa/lotes/{lote2_id}", json={
        "data_compra": "2025-02-15",
        "quantidade": "8.0",
        "preco_unitario": "1200.0",
        "taxa_contratada": "125.0",
        "taxas": "0.0",
    })
    assert res_edit_lote2.status_code == 200, res_edit_lote2.text
    peps_pos = res_edit_lote2.json()
    assert Decimal(str(peps_pos["quantidade_total"])) == Decimal("18.0")
    assert Decimal(str(peps_pos["custo_total_brl"])) == Decimal("19600.0")

    # Sincronia contábil com CMPM (/posicoes)
    pos_cart_pos = next(p for p in client.get("/api/v1/posicoes").json() if p["ativo_id"] == ativo_id)
    assert Decimal(str(pos_cart_pos["quantidade_saldo"])) == Decimal("18.0")
    assert Decimal(str(pos_cart_pos["custo_total_brl"])) == Decimal("19600.0")
    assert abs(Decimal(str(pos_cart_pos["preco_medio_brl"])) - (Decimal("19600.0") / Decimal("18.0"))) < Decimal("0.0001")

    # 4. Exclui o segundo lote via DELETE /lotes/{transacao_id}
    res_del_lote2 = client.delete(f"/api/v1/renda-fixa/lotes/{lote2_id}")
    assert res_del_lote2.status_code == 200
    peps_pos_pos_del = res_del_lote2.json()
    assert len(peps_pos_pos_del["lotes"]) == 1
    assert Decimal(str(peps_pos_pos_del["quantidade_total"])) == Decimal("10.0")
    assert Decimal(str(peps_pos_pos_del["custo_total_brl"])) == Decimal("10000.0")

    # Verifica CMPM após exclusão do segundo lote
    pos_cart_del = next(p for p in client.get("/api/v1/posicoes").json() if p["ativo_id"] == ativo_id)
    assert Decimal(str(pos_cart_del["quantidade_saldo"])) == Decimal("10.0")
    assert Decimal(str(pos_cart_del["custo_total_brl"])) == Decimal("10000.0")
    assert Decimal(str(pos_cart_del["preco_medio_brl"])) == Decimal("1000.0")

    # 5. Exclui o primeiro lote (agora não restam lotes)
    res_del_lote1 = client.delete(f"/api/v1/renda-fixa/lotes/{lote1_id}")
    assert res_del_lote1.status_code == 200
    peps_pos_vazia = res_del_lote1.json()
    assert peps_pos_vazia["lotes"] == []
    assert Decimal(str(peps_pos_vazia["quantidade_total"])) == Decimal("0")
    assert Decimal(str(peps_pos_vazia["custo_total_brl"])) == Decimal("0")

    # Verifica CMPM: a posição consolidada deste ativo deve ter sido excluída
    pos_cart_restantes = [p for p in client.get("/api/v1/posicoes").json() if p["ativo_id"] == ativo_id]
    assert len(pos_cart_restantes) == 0

    # 6. Testes de erro 404
    res_err_put = client.put("/api/v1/renda-fixa/lotes/99999", json={
        "data_compra": "2025-01-01",
        "quantidade": "1.0",
        "preco_unitario": "100.0",
        "taxa_contratada": "100.0",
    })
    assert res_err_put.status_code == 404

    res_err_del = client.delete("/api/v1/renda-fixa/lotes/99999")
    assert res_err_del.status_code == 404


def test_exclusao_ativo_em_cascata(client):
    # 1. Cria ativo RF com 2 lotes
    res = client.post("/api/v1/renda-fixa/cadastro-manual", json={
        "ticker": "CDB-CASCATA-2029",
        "nome": "CDB Cascata Teste",
        "detalhes": {
            "produto": "CDB",
            "indexador": "CDI",
            "percentual_indexador": "100.0000",
            "emissor": "Banco Cascata",
            "data_vencimento": "2029-01-01",
        },
        "lote_inicial": {
            "carteira_id": 1,
            "data_compra": "2025-01-01",
            "quantidade": "10.0",
            "preco_unitario": "1000.0",
            "taxa_contratada": "100.0",
        },
    })
    assert res.status_code == 201
    ativo_id = res.json()["ativo"]["id"]

    client.post(f"/api/v1/renda-fixa/ativos/{ativo_id}/lotes", json={
        "carteira_id": 1,
        "data_compra": "2025-02-01",
        "quantidade": "5.0",
        "preco_unitario": "1000.0",
        "taxa_contratada": "100.0",
    })

    # Confirma existência
    assert any(a["id"] == ativo_id for a in client.get("/api/v1/renda-fixa/ativos").json())
    assert any(p["ativo_id"] == ativo_id for p in client.get("/api/v1/posicoes").json())

    # 2. Exclui ativo via DELETE /ativos/{ativo_id}
    res_del = client.delete(f"/api/v1/renda-fixa/ativos/{ativo_id}")
    assert res_del.status_code == 204

    # 3. Confirma remoção completa
    assert not any(a["id"] == ativo_id for a in client.get("/api/v1/renda-fixa/ativos").json())
    assert not any(p["ativo_id"] == ativo_id for p in client.get("/api/v1/posicoes").json())
    res_peps = client.get(f"/api/v1/renda-fixa/lotes?ativo_id={ativo_id}")
    assert len(res_peps.json()["posicoes"]) == 0

    # 4. Tentar excluir novamente -> 404
    res_del_404 = client.delete(f"/api/v1/renda-fixa/ativos/{ativo_id}")
    assert res_del_404.status_code == 404


def test_timezone_safe_sorting_recalcular_posicoes(client, db_session):
    from app.models.ativo import Ativo
    from app.models.carteira import Carteira
    from app.models.transacao import Transacao
    from app.services.portfolio import recalcular_posicoes_carteira

    carteira = Carteira(id=1, nome="Carteira Principal")
    db_session.add(carteira)
    db_session.flush()

    # Cria ativo
    ativo = Ativo(ticker="TZ-SAFE-TEST", nome="Ativo Timezone Safe", tipo=TipoAtivo.RendaFixa)
    db_session.add(ativo)
    db_session.flush()

    # Cria transação 1 com timezone (aware)
    tx1 = Transacao(
        carteira_id=1,
        ativo_id=ativo.id,
        data_hora=datetime(2024, 1, 1, 10, 0, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.BUY,
        quantidade=Decimal("10"),
        preco_unitario=Decimal("100"),
        taxas=Decimal("0"),
        moeda="BRL",
    )
    # Cria transação 2 sem timezone (naive)
    tx2 = Transacao(
        carteira_id=1,
        ativo_id=ativo.id,
        data_hora=datetime(2024, 1, 2, 10, 0),
        tipo_operacao=TipoOperacao.BUY,
        quantidade=Decimal("5"),
        preco_unitario=Decimal("110"),
        taxas=Decimal("0"),
        moeda="BRL",
    )
    db_session.add_all([tx1, tx2])
    db_session.commit()

    # Executa recalcular_posicoes_carteira; não deve lançar TypeError
    recalcular_posicoes_carteira(db=db_session, carteira_id=1)


def test_editar_lote_reordenacao_cronologica_peps_e_preservacao_taxas(client):
    # 1. Cria ativo RF com lote 1 em 2025-02-01 com taxas de R$ 25,00
    res_ativo = client.post("/api/v1/renda-fixa/cadastro-manual", json={
        "ticker": "CDB-PEPS-REORDER",
        "nome": "CDB Reordenacao PEPS",
        "detalhes": {
            "produto": "CDB",
            "indexador": "CDI",
            "percentual_indexador": "100.0000",
            "emissor": "Banco Reorder",
            "data_vencimento": "2028-12-31",
        },
        "lote_inicial": {
            "carteira_id": 1,
            "data_compra": "2025-02-01",
            "quantidade": "10.0",
            "preco_unitario": "1000.0",
            "taxa_contratada": "100.0",
            "taxas": "25.0",
        },
    })
    assert res_ativo.status_code == 201
    ativo_id = res_ativo.json()["ativo"]["id"]
    lote1_id = res_ativo.json()["lotes"][0]["transacao_id"]
    assert Decimal(str(res_ativo.json()["lotes"][0]["taxas"])) == Decimal("25.0")

    # 2. Adiciona segundo lote em 2025-03-01 com taxas de R$ 15,00
    res_lote2 = client.post(f"/api/v1/renda-fixa/ativos/{ativo_id}/lotes", json={
        "carteira_id": 1,
        "data_compra": "2025-03-01",
        "quantidade": "5.0",
        "preco_unitario": "1100.0",
        "taxa_contratada": "105.0",
        "taxas": "15.0",
    })
    assert res_lote2.status_code == 201
    lote2_id = res_lote2.json()["lotes"][1]["transacao_id"]
    assert Decimal(str(res_lote2.json()["lotes"][1]["taxas"])) == Decimal("15.0")

    # Ordem inicial no PEPS: Lote 1 (2025-02-01), depois Lote 2 (2025-03-01)
    lotes_peps = res_lote2.json()["lotes"]
    assert lotes_peps[0]["transacao_id"] == lote1_id
    assert lotes_peps[1]["transacao_id"] == lote2_id

    # 3. Edita lote 2 alterando data para 2025-01-15 (ANTERIOR ao lote 1) e preservando taxas de R$ 15,00
    res_edit = client.put(f"/api/v1/renda-fixa/lotes/{lote2_id}", json={
        "data_compra": "2025-01-15",
        "quantidade": "5.0",
        "preco_unitario": "1100.0",
        "taxa_contratada": "105.0",
        "taxas": "15.0",
    })
    assert res_edit.status_code == 200, res_edit.text
    lotes_reordenados = res_edit.json()["lotes"]

    # Agora o Lote 2 deve ser o PRIMEIRO na fila PEPS!
    assert lotes_reordenados[0]["transacao_id"] == lote2_id
    assert lotes_reordenados[0]["data_compra"] == "2025-01-15"
    assert Decimal(str(lotes_reordenados[0]["taxas"])) == Decimal("15.0")

    assert lotes_reordenados[1]["transacao_id"] == lote1_id
    assert lotes_reordenados[1]["data_compra"] == "2025-02-01"
    assert Decimal(str(lotes_reordenados[1]["taxas"])) == Decimal("25.0")


def test_editar_ativo_renda_mais_com_ano_conversao(client):
    # 1. Cadastra Tesouro RendA+ 2065
    res_rm = client.post("/api/v1/renda-fixa/cadastro-manual", json={
        "ticker": "NTNB-RENDA-2065",
        "nome": "Tesouro RendA+ 2065 Original",
        "detalhes": {
            "produto": "TESOURO_RENDA_MAIS",
            "indexador": "IPCA",
            "emissor": "Tesouro Nacional",
            "ano_conversao": 2065,
            "num_parcelas": 240,
            "dia_pagamento": 15,
        },
        "lote_inicial": {
            "carteira_id": 1,
            "data_compra": "2025-01-10",
            "quantidade": "1.0",
            "preco_unitario": "2000.0",
            "taxa_contratada": "6.5",
        },
    })
    assert res_rm.status_code == 201
    ativo_id = res_rm.json()["ativo"]["id"]

    # 2. Edita nome e ticker mantendo ano_conversao e num_parcelas
    res_up = client.put(f"/api/v1/renda-fixa/ativos/{ativo_id}", json={
        "ticker": "NTNB-RENDA-2065-MOD",
        "nome": "Tesouro RendA+ 2065 Modificado",
        "detalhes": {
            "produto": "TESOURO_RENDA_MAIS",
            "indexador": "IPCA",
            "emissor": "Tesouro Nacional",
            "ano_conversao": 2065,
            "num_parcelas": 240,
            "dia_pagamento": 15,
        },
    })
    assert res_up.status_code == 200, res_up.text
    data_up = res_up.json()
    assert data_up["ativo"]["nome"] == "Tesouro RendA+ 2065 Modificado"
    assert data_up["ativo"]["ticker"] == "NTNB-RENDA-2065-MOD"
    assert data_up["ativo"]["detalhes_rf"]["ano_conversao"] == 2065
    assert data_up["ativo"]["detalhes_rf"]["num_parcelas"] == 240



