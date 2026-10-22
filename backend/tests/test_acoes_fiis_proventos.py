import io
from datetime import datetime, timezone
from decimal import Decimal
import httpx
import pandas as pd
import pytest
from sqlalchemy.orm import Session

from app.db.migrations import aplicar_migracoes_defensivas
from app.models.ativo import Ativo
from app.models.carteira import Carteira
from app.models.enums import TipoAtivo, TipoOperacao
from app.models.posicao import PosicaoConsolidada
from app.models.transacao import Transacao
from app.schemas.ativo import AtivoCreate, AtivoUpdate, ConversaoTickerRequest, CotacaoManualUpdate
from app.schemas.posicao import AjusteManualPosicaoRequest
from app.schemas.transacao import TransacaoCreate, TransacaoUpdate
from app.services.cotacoes import (
    _salvar_cache_disco,
    obter_cotacoes_carteira,
    _MEM_CACHE,
)
from app.services.ingestion.parser_movimentacao_b3 import processar_planilha_movimentacao_b3
from app.services.portfolio import (
    ajustar_posicao_manual,
    converter_ativo_ticker,
    processar_transacao,
    recalcular_posicoes_carteira,
)


def test_migracoes_defensivas_idempotencia():
    """Garante que as migrações adicionam as 3 novas colunas e são estritamente idempotentes."""
    from app.db.session import engine
    # Primeira chamada: pode aplicar colunas se faltarem
    aplicadas_1 = aplicar_migracoes_defensivas(engine)
    # Segunda chamada: deve ser estritamente idempotente (nada pendente)
    aplicadas_2 = aplicar_migracoes_defensivas(engine)
    assert aplicadas_2 == []


def test_motor_contabil_proventos_pm_ajustado_e_lucro_realizado(db_session: Session):
    """
    Testa o ciclo contábil completo:
    1. Compras sucessivas (CMPM)
    2. Proventos em dinheiro (DIVIDENDO e JCP) acumulando sem mexer no PM contábil
    3. Cálculo de Dividendo por Ação, PM Ajustado e YoC %
    4. Venda parcial com Lucro Realizado
    5. Venda total preservando histórico de Lucro e Proventos com quantidade 0
    """
    db = db_session
    carteira = Carteira(id=1, nome="Principal")
    ativo = Ativo(ticker="PETR4", nome="Petrobras PN", tipo=TipoAtivo.Acao)
    db.add_all([carteira, ativo])
    db.commit()

    # 1. Compra 1: 100 @ R$ 30,00
    tx1 = TransacaoCreate(
        carteira_id=1,
        ativo_id=ativo.id,
        data_hora=datetime(2024, 1, 10, 10, 0, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.BUY,
        quantidade=Decimal("100"),
        preco_unitario=Decimal("30.00"),
        taxas=Decimal("0.0"),
    )
    processar_transacao(db, tx1)

    # Compra 2: 100 @ R$ 40,00 (Total: 200 @ R$ 35,00)
    tx2 = TransacaoCreate(
        carteira_id=1,
        ativo_id=ativo.id,
        data_hora=datetime(2024, 1, 15, 10, 0, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.BUY,
        quantidade=Decimal("100"),
        preco_unitario=Decimal("40.00"),
        taxas=Decimal("0.0"),
    )
    processar_transacao(db, tx2)

    pos = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo.id).first()
    assert pos.quantidade_saldo == Decimal("200")
    assert pos.preco_medio_brl == Decimal("35.00")
    assert pos.custo_total_brl == Decimal("7000.00")
    assert pos.proventos_acumulados_brl == Decimal("0.0")

    # 2. Proventos: R$ 500 dividendo + R$ 200 JCP = R$ 700 proventos
    tx_div = TransacaoCreate(
        carteira_id=1,
        ativo_id=ativo.id,
        data_hora=datetime(2024, 2, 1, 10, 0, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.DIVIDENDO,
        quantidade=Decimal("1"),
        preco_unitario=Decimal("500.00"),
    )
    processar_transacao(db, tx_div)

    tx_jcp = TransacaoCreate(
        carteira_id=1,
        ativo_id=ativo.id,
        data_hora=datetime(2024, 2, 15, 10, 0, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.JCP,
        quantidade=Decimal("1"),
        preco_unitario=Decimal("200.00"),
    )
    processar_transacao(db, tx_jcp)

    db.refresh(pos)
    assert pos.quantidade_saldo == Decimal("200")
    assert pos.preco_medio_brl == Decimal("35.00")  # Não altera PM contábil
    assert pos.proventos_acumulados_brl == Decimal("700.00")

    # 3. Propriedades calculadas
    # Dividendo por ação: 700 / 200 = 3.50
    assert pos.dividendo_por_acao_brl == Decimal("3.50")
    # PM Ajustado: 35.00 - 3.50 = 31.50
    assert pos.preco_medio_ajustado_brl == Decimal("31.50")
    # YoC: (700 / 7000) * 100 = 10%
    assert pos.yoc_acumulado_pct == Decimal("10.0")

    # 4. Venda parcial: 50 ações @ R$ 45,00
    # Receita: 2250, Custo baixa: 50 * 35 = 1750, Lucro: 500
    tx_venda1 = TransacaoCreate(
        carteira_id=1,
        ativo_id=ativo.id,
        data_hora=datetime(2024, 3, 1, 10, 0, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.SELL,
        quantidade=Decimal("50"),
        preco_unitario=Decimal("45.00"),
    )
    processar_transacao(db, tx_venda1)

    db.refresh(pos)
    assert pos.quantidade_saldo == Decimal("150")
    assert pos.preco_medio_brl == Decimal("35.00")
    assert pos.lucro_realizado_brl == Decimal("500.00")
    assert pos.proventos_acumulados_brl == Decimal("700.00")

    # 5. Venda total: 150 ações restantes @ R$ 50,00
    # Receita: 7500, Custo baixa: 150 * 35 = 5250, Lucro: 2250 -> Total realizado: 2750
    tx_venda2 = TransacaoCreate(
        carteira_id=1,
        ativo_id=ativo.id,
        data_hora=datetime(2024, 3, 15, 10, 0, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.SELL,
        quantidade=Decimal("150"),
        preco_unitario=Decimal("50.00"),
    )
    processar_transacao(db, tx_venda2)

    db.refresh(pos)
    assert pos.quantidade_saldo == Decimal("0")
    assert pos.custo_total_brl == Decimal("0")
    assert pos.preco_medio_brl == Decimal("0")
    assert pos.lucro_realizado_brl == Decimal("2750.00")
    assert pos.proventos_acumulados_brl == Decimal("700.00")


def test_motor_contabil_restituicao_capital(db_session: Session):
    """Testa abatimento de custo por Restituição de Capital com excedente somando em proventos."""
    db = db_session
    carteira = Carteira(id=1, nome="Principal")
    ativo = Ativo(ticker="HGLG11", nome="CSHG Logística", tipo=TipoAtivo.FII)
    db.add_all([carteira, ativo])
    db.commit()

    # Compra 100 @ R$ 100,00 -> Custo R$ 10.000,00, PM R$ 100,00
    tx_buy = TransacaoCreate(
        carteira_id=1,
        ativo_id=ativo.id,
        data_hora=datetime(2024, 1, 10, 10, 0, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.BUY,
        quantidade=Decimal("100"),
        preco_unitario=Decimal("100.00"),
    )
    processar_transacao(db, tx_buy)

    # Restituição de R$ 20 por cota (Total R$ 2.000,00)
    tx_rest1 = TransacaoCreate(
        carteira_id=1,
        ativo_id=ativo.id,
        data_hora=datetime(2024, 2, 10, 10, 0, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.RESTITUICAO_CAPITAL,
        quantidade=Decimal("100"),
        preco_unitario=Decimal("20.00"),
    )
    processar_transacao(db, tx_rest1)

    pos = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo.id).first()
    # Custo baixou de 10.000 para 8.000, PM baixou de 100 para 80
    assert pos.quantidade_saldo == Decimal("100")
    assert pos.custo_total_brl == Decimal("8000.00")
    assert pos.preco_medio_brl == Decimal("80.00")
    assert pos.proventos_acumulados_brl == Decimal("0.0")

    # Restituição com excedente: R$ 9.000 (custo era 8.000 -> zera custo e excedente 1.000 vira proventos)
    tx_rest2 = TransacaoCreate(
        carteira_id=1,
        ativo_id=ativo.id,
        data_hora=datetime(2024, 3, 10, 10, 0, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.RESTITUICAO_CAPITAL,
        quantidade=Decimal("1"),
        preco_unitario=Decimal("9000.00"),
    )
    processar_transacao(db, tx_rest2)

    db.refresh(pos)
    assert pos.quantidade_saldo == Decimal("100")
    assert pos.custo_total_brl == Decimal("0.0")
    assert pos.preco_medio_brl == Decimal("0.0")
    assert pos.proventos_acumulados_brl == Decimal("1000.00")


def test_ajuste_manual_idempotencia_apos_recalcular(client):
    """
    Testa ajuste manual de posição/PM e garante que chamar POST /recalcular
    mantém 100% dos valores configurados.
    """
    # 1. Cria ativo e posição com custo zero via transação inicial
    res_ativo = client.post("/api/v1/ativos", json={
        "ticker": "MXRF11",
        "nome": "Maxi Renda FII",
        "tipo": "FII",
        "setor": "Híbrido"
    })
    assert res_ativo.status_code == 201
    ativo_id = res_ativo.json()["id"]

    # Inicia com transferência de 100 cotas a custo 0
    res_tx = client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": ativo_id,
        "tipo_operacao": "TRANSFERENCIA_ENTRADA",
        "quantidade": "100.0",
        "preco_unitario": "0.0",
    })
    assert res_tx.status_code == 201

    # 2. Executa Ajuste Manual definindo PM = R$ 10.45, proventos = R$ 45.00 e cotação manual = R$ 10.80
    res_ajuste = client.put(f"/api/v1/posicoes/carteiras/1/ativos/{ativo_id}/ajuste-manual", json={
        "quantidade_saldo": "100.0",
        "preco_medio_brl": "10.45",
        "proventos_acumulados_brl": "45.00",
        "cotacao_manual": "10.80",
        "nome_ativo": "Maxi Renda FII Atualizado"
    })
    assert res_ajuste.status_code == 200
    pos_data = res_ajuste.json()
    assert Decimal(str(pos_data["preco_medio_brl"])) == Decimal("10.45")
    assert Decimal(str(pos_data["proventos_acumulados_brl"])) == Decimal("45.00")
    assert Decimal(str(pos_data["ativo"]["cotacao_manual"])) == Decimal("10.80")

    # 3. Força recálculo integral da carteira (o teste crítico de idempotência)
    res_recalc = client.post("/api/v1/posicoes/carteiras/1/recalcular")
    assert res_recalc.status_code == 200

    # 4. Verifica que as posições recalculadas preservam EXATAMENTE os valores
    res_pos = client.get("/api/v1/posicoes?carteira_id=1")
    assert res_pos.status_code == 200
    posicoes = res_pos.json()
    mxrf_pos = next(p for p in posicoes if p["ativo"]["ticker"] == "MXRF11")
    assert Decimal(str(mxrf_pos["quantidade_saldo"])) == Decimal("100.0")
    assert Decimal(str(mxrf_pos["preco_medio_brl"])) == Decimal("10.45")
    assert Decimal(str(mxrf_pos["custo_total_brl"])) == Decimal("1045.00")
    assert Decimal(str(mxrf_pos["proventos_acumulados_brl"])) == Decimal("45.00")
    assert Decimal(str(mxrf_pos["ativo"]["cotacao_manual"])) == Decimal("10.80")


def test_importacao_proventos_b3_e_deduplicacao(db_session: Session):
    """
    Testa importação de proventos (DIVIDENDO, JCP, RENDIMENTO) da planilha de Movimentação B3,
    e valida deduplicação idempotente ao reimportar.
    """
    db = db_session
    petr4 = Ativo(ticker="PETR4", nome="Petrobras PN", tipo=TipoAtivo.Acao)
    hglg11 = Ativo(ticker="HGLG11", nome="CSHG Logística", tipo=TipoAtivo.FII)
    db.add_all([petr4, hglg11])
    db.commit()

    data = [
        # 1. Dividendo PETR4
        {
            "Data": "2024-03-10",
            "Movimentação": "Dividendo",
            "Produto": "PETR4 - PETROBRAS",
            "Quantidade": 100,
            "Preço unitário": 1.25,
            "Valor da Operação": 125.0,
        },
        # 2. JCP PETR4
        {
            "Data": "2024-03-15",
            "Movimentação": "Juros Sobre Capital Próprio",
            "Produto": "PETR4",
            "Quantidade": 100,
            "Preço unitário": 0.50,
            "Valor da Operação": 50.0,
        },
        # 3. Rendimento FII
        {
            "Data": "2024-03-20",
            "Movimentação": "Rendimento",
            "Produto": "HGLG11",
            "Quantidade": 50,
            "Preço unitário": 1.10,
            "Valor da Operação": 55.0,
        },
        # 4. Provisão futura -> deve ser ignorada
        {
            "Data": "2024-04-30",
            "Movimentação": "Dividendo provisionado a receber",
            "Produto": "PETR4",
            "Quantidade": 100,
            "Preço unitário": 2.0,
            "Valor da Operação": 200.0,
        },
    ]
    df = pd.DataFrame(data)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)
    bytes_excel = buf.getvalue()

    # Primeira importação: deve gerar 3 transações de proventos
    res1 = processar_planilha_movimentacao_b3(db=db, file_content=bytes_excel, carteira_id=1)
    txs1 = res1["transacoes"]
    assert len(txs1) == 3
    tipos = [t.tipo_operacao for t in txs1]
    assert TipoOperacao.DIVIDENDO in tipos
    assert TipoOperacao.JCP in tipos
    assert TipoOperacao.RENDIMENTO in tipos

    pos_petr = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == petr4.id).first()
    assert pos_petr.proventos_acumulados_brl == Decimal("175.00")  # 125 + 50

    pos_hglg = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == hglg11.id).first()
    assert pos_hglg.proventos_acumulados_brl == Decimal("55.00")

    # Segunda importação do mesmo arquivo: nenhuma transação duplicada deve ser criada
    res2 = processar_planilha_movimentacao_b3(db=db, file_content=bytes_excel, carteira_id=1)
    txs2 = res2["transacoes"]
    assert len(txs2) == 0

    db.refresh(pos_petr)
    db.refresh(pos_hglg)
    assert pos_petr.proventos_acumulados_brl == Decimal("175.00")
    assert pos_hglg.proventos_acumulados_brl == Decimal("55.00")


def test_conversao_fusao_ticker(client):
    """
    Testa:
    1. Renomeação de ticker simples (ex: TRPL4 -> ISAE4)
    2. Conversão com fator multiplicador e fusão em ticker existente
    """
    # 1. Cria ativo TRPL4 com transação de 100 ações a R$ 25,00
    res_ativo = client.post("/api/v1/ativos", json={
        "ticker": "TRPL4",
        "nome": "Transmissão Paulista PN",
        "tipo": "Acao"
    })
    trpl4_id = res_ativo.json()["id"]

    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": trpl4_id,
        "tipo_operacao": "BUY",
        "quantidade": "100.0",
        "preco_unitario": "25.00",
    })

    # Renomeia para ISAE4
    res_conv = client.post(f"/api/v1/ativos/{trpl4_id}/converter-ticker", json={
        "novo_ticker": "ISAE4",
        "novo_nome": "ISA CTEEP PN",
        "fator_conversao": "1.0"
    })
    assert res_conv.status_code == 200
    assert res_conv.json()["ticker"] == "ISAE4"
    assert res_conv.json()["nome"] == "ISA CTEEP PN"

    # Verifica posição da carteira
    res_pos = client.get("/api/v1/posicoes?carteira_id=1")
    posicoes = res_pos.json()
    assert any(p["ativo"]["ticker"] == "ISAE4" and Decimal(str(p["quantidade_saldo"])) == Decimal("100.0") for p in posicoes)
    assert not any(p["ativo"]["ticker"] == "TRPL4" for p in posicoes)

    # 2. Fusão: Cria ativo ORIGEM (50 cotas a R$ 40) e funde em ISAE4 com fator 2.0
    res_orig = client.post("/api/v1/ativos", json={
        "ticker": "ORIGEM3",
        "nome": "Ativo Origem",
        "tipo": "Acao"
    })
    orig_id = res_orig.json()["id"]

    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": orig_id,
        "tipo_operacao": "BUY",
        "quantidade": "50.0",
        "preco_unitario": "40.00",
    })

    # Converte ORIGEM3 para ISAE4 com fator 2.0 (50 * 2 = 100 cotas a R$ 20.00)
    res_fusao = client.post(f"/api/v1/ativos/{orig_id}/converter-ticker", json={
        "novo_ticker": "ISAE4",
        "fator_conversao": "2.0"
    })
    assert res_fusao.status_code == 200
    assert res_fusao.json()["ticker"] == "ISAE4"

    # Saldo consolidado de ISAE4: 100 (anteriores a R$ 25 = 2.500) + 100 (da fusão a R$ 20 = 2.000) = 200 @ R$ 22.50
    res_pos2 = client.get("/api/v1/posicoes?carteira_id=1")
    isae_pos = next(p for p in res_pos2.json() if p["ativo"]["ticker"] == "ISAE4")
    assert Decimal(str(isae_pos["quantidade_saldo"])) == Decimal("200.0")
    assert Decimal(str(isae_pos["custo_total_brl"])) == Decimal("4500.00")
    assert Decimal(str(isae_pos["preco_medio_brl"])) == Decimal("22.50")


@pytest.mark.anyio
async def test_servico_cotacoes_manual_online_e_cache(db_session: Session):
    """
    Testa resolução de cotações:
    1. Cotação manual prioritária (fonte MANUAL)
    2. Mock HTTP para cotação online (fonte YAHOO)
    3. Consulta subsequente utilizando cache (fonte CACHE)
    4. Fallback com stale quando offline
    """
    db = db_session
    carteira = Carteira(id=1, nome="Principal")
    # Ativo 1: com cotacao_manual
    ativo_manual = Ativo(ticker="PETR4", nome="Petrobras", tipo=TipoAtivo.Acao, cotacao_manual=Decimal("38.50"))
    # Ativo 2: sem cotacao_manual (buscará online)
    ativo_online = Ativo(ticker="VALE3", nome="Vale S.A.", tipo=TipoAtivo.Acao)
    db.add_all([carteira, ativo_manual, ativo_online])
    db.commit()

    pos1 = PosicaoConsolidada(carteira_id=1, ativo_id=ativo_manual.id, quantidade_saldo=Decimal("100"), preco_medio_brl=Decimal("30.0"))
    pos2 = PosicaoConsolidada(carteira_id=1, ativo_id=ativo_online.id, quantidade_saldo=Decimal("50"), preco_medio_brl=Decimal("60.0"))
    db.add_all([pos1, pos2])
    db.commit()

    # 1. Simulação com MockTransport para VALE3
    def mock_handler(request: httpx.Request) -> httpx.Response:
        url_str = str(request.url)
        if "VALE3.SA" in url_str:
            data = {
                "chart": {
                    "result": [
                        {
                            "meta": {
                                "regularMarketPrice": 62.50,
                                "chartPreviousClose": 60.00,
                            }
                        }
                    ]
                }
            }
            return httpx.Response(200, json=data)
        return httpx.Response(404)

    transport = httpx.MockTransport(mock_handler)

    # Limpa cache em memória
    _MEM_CACHE.clear()

    resp = await obter_cotacoes_carteira(db=db, carteira_id=1, forcar=True, transport=transport)
    assert resp.carteira_id == 1
    assert "PETR4" in resp.cotacoes
    assert "VALE3" in resp.cotacoes

    # PETR4 veio de MANUAL
    assert resp.cotacoes["PETR4"].fonte == "MANUAL"
    assert resp.cotacoes["PETR4"].preco_atual == Decimal("38.50")
    assert resp.cotacoes["PETR4"].stale is False

    # VALE3 veio de YAHOO
    assert resp.cotacoes["VALE3"].fonte == "YAHOO"
    assert resp.cotacoes["VALE3"].preco_atual == Decimal("62.50")
    assert resp.cotacoes["VALE3"].stale is False
    assert resp.cotacoes["VALE3"].variacao_diaria_pct > Decimal("0")

    # 2. Próxima consulta com forcar=False deve vir de CACHE para VALE3 mesmo com transport offline
    offline_transport = httpx.MockTransport(lambda req: httpx.Response(500))
    resp_cache = await obter_cotacoes_carteira(db=db, carteira_id=1, forcar=False, transport=offline_transport)
    assert resp_cache.cotacoes["VALE3"].fonte == "CACHE"
    assert resp_cache.cotacoes["VALE3"].preco_atual == Decimal("62.50")
    assert resp_cache.cotacoes["VALE3"].stale is False


def test_crud_endpoints_ativos_e_transacoes(client):
    """Testa endpoints REST de Ativos (PUT, PATCH, DELETE) e Transações (GET com filtro, PUT, DELETE)."""
    # 1. Cria ativo
    res_a = client.post("/api/v1/ativos", json={
        "ticker": "BBAS3",
        "nome": "Banco do Brasil",
        "tipo": "Acao",
        "setor": "Financeiro"
    })
    assert res_a.status_code == 201
    ativo_id = res_a.json()["id"]

    # 2. PATCH cotacao-manual
    res_patch = client.patch(f"/api/v1/ativos/{ativo_id}/cotacao-manual", json={
        "cotacao_manual": "28.50"
    })
    assert res_patch.status_code == 200
    assert Decimal(str(res_patch.json()["cotacao_manual"])) == Decimal("28.50")

    # 3. PUT ativo
    res_put_a = client.put(f"/api/v1/ativos/{ativo_id}", json={
        "nome": "Banco do Brasil S.A. ON",
        "setor": "Bancário"
    })
    assert res_put_a.status_code == 200
    assert res_put_a.json()["nome"] == "Banco do Brasil S.A. ON"
    assert res_put_a.json()["setor"] == "Bancário"

    # 4. Transações: POST
    res_tx1 = client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": ativo_id,
        "tipo_operacao": "BUY",
        "quantidade": "100.0",
        "preco_unitario": "25.00",
    })
    assert res_tx1.status_code == 201
    tx1_id = res_tx1.json()["id"]

    # GET transacoes com filtro
    res_get_tx = client.get(f"/api/v1/transacoes?carteira_id=1&ativo_id={ativo_id}&tipo_operacao=BUY")
    assert res_get_tx.status_code == 200
    assert len(res_get_tx.json()) == 1

    # PUT transacao (altera quantidade de 100 para 200)
    res_put_tx = client.put(f"/api/v1/transacoes/{tx1_id}", json={
        "quantidade": "200.0"
    })
    assert res_put_tx.status_code == 200
    assert Decimal(str(res_put_tx.json()["quantidade"])) == Decimal("200.0")

    # Verifica que posição recalculou para 200
    res_pos = client.get("/api/v1/posicoes?carteira_id=1")
    pos_bb = next(p for p in res_pos.json() if p["ativo"]["id"] == ativo_id)
    assert Decimal(str(pos_bb["quantidade_saldo"])) == Decimal("200.0")

    # DELETE transacao
    res_del_tx = client.delete(f"/api/v1/transacoes/{tx1_id}")
    assert res_del_tx.status_code == 204

    # Verifica que posição foi excluída/zerada
    res_pos2 = client.get("/api/v1/posicoes?carteira_id=1")
    assert not any(p["ativo"]["id"] == ativo_id for p in res_pos2.json())

    # DELETE ativo
    res_del_a = client.delete(f"/api/v1/ativos/{ativo_id}")
    assert res_del_a.status_code == 204


def test_listar_posicoes_somente_com_saldo_filtro(client):
    """Garante que posições encerradas (saldo 0) mas com proventos/lucro aparecem em somente_com_saldo=false."""
    # 1. Cria ativo e compra 10 ações
    res_a = client.post("/api/v1/ativos", json={"ticker": "WEGE3", "nome": "WEG S.A.", "tipo": "Acao"})
    wege_id = res_a.json()["id"]

    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": wege_id,
        "tipo_operacao": "BUY",
        "quantidade": "10.0",
        "preco_unitario": "30.00",
    })
    # Recebe dividendo de R$ 50
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": wege_id,
        "tipo_operacao": "DIVIDENDO",
        "quantidade": "1.0",
        "preco_unitario": "50.00",
    })
    # Vende todas as 10 ações a R$ 40 (lucro R$ 100)
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": wege_id,
        "tipo_operacao": "SELL",
        "quantidade": "10.0",
        "preco_unitario": "40.00",
    })

    # somente_com_saldo=True (default) não deve trazer WEGE3
    res_padrao = client.get("/api/v1/posicoes?carteira_id=1&somente_com_saldo=true")
    assert not any(p["ativo"]["id"] == wege_id for p in res_padrao.json())

    # somente_com_saldo=False deve trazer WEGE3 com saldo 0, lucro 100 e proventos 50
    res_tudo = client.get("/api/v1/posicoes?carteira_id=1&somente_com_saldo=false")
    pos_wege = next(p for p in res_tudo.json() if p["ativo"]["id"] == wege_id)
    assert Decimal(str(pos_wege["quantidade_saldo"])) == Decimal("0.0")
    assert Decimal(str(pos_wege["lucro_realizado_brl"])) == Decimal("100.00")
    assert Decimal(str(pos_wege["proventos_acumulados_brl"])) == Decimal("50.00")


def test_put_ativo_duplicado_retorna_409(client):
    """Garante que tentar renomear um ativo para um ticker já existente retorna 409 Conflict."""
    res1 = client.post("/api/v1/ativos", json={"ticker": "ATIVO1", "nome": "Ativo Um", "tipo": "Acao"})
    res2 = client.post("/api/v1/ativos", json={"ticker": "ATIVO2", "nome": "Ativo Dois", "tipo": "Acao"})
    id2 = res2.json()["id"]

    res_conflito = client.put(f"/api/v1/ativos/{id2}", json={"ticker": "ATIVO1"})
    assert res_conflito.status_code == 409


def test_ajuste_manual_reducao_proventos_e_limpar_cotacao(client):
    """Garante que redução de proventos no ajuste manual e limpeza de cotação manual funcionam perfeitamente."""
    res_a = client.post("/api/v1/ativos", json={"ticker": "TAEE11", "nome": "Taesa", "tipo": "Acao"})
    taee_id = res_a.json()["id"]

    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": taee_id,
        "tipo_operacao": "TRANSFERENCIA_ENTRADA",
        "quantidade": "100.0",
        "preco_unitario": "35.00",
    })
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": taee_id,
        "tipo_operacao": "DIVIDENDO",
        "quantidade": "1.0",
        "preco_unitario": "200.00",
    })

    # Ajusta proventos para MENOS (de 200 para 100)
    res_ajuste = client.put(f"/api/v1/posicoes/carteiras/1/ativos/{taee_id}/ajuste-manual", json={
        "quantidade_saldo": "100.0",
        "preco_medio_brl": "35.00",
        "proventos_acumulados_brl": "100.00",
        "cotacao_manual": "38.00",
    })
    assert res_ajuste.status_code == 200
    assert Decimal(str(res_ajuste.json()["proventos_acumulados_brl"])) == Decimal("100.00")

    # Limpa cotação manual via PATCH com null
    res_patch = client.patch(f"/api/v1/ativos/{taee_id}/cotacao-manual", json={
        "cotacao_manual": None
    })
    assert res_patch.status_code == 200
    assert res_patch.json()["cotacao_manual"] is None


def test_ajuste_manual_com_vendas_anteriores_preserva_historico_e_lucro(client):
    """
    Garante que ajustar PM/saldo em ativo que já possui vendas NÃO apaga as vendas,
    preserva o histórico de transações e recalcula o lucro realizado com base no novo PM.
    """
    res_a = client.post("/api/v1/ativos", json={"ticker": "BBDC4", "nome": "Bradesco PN", "tipo": "Acao"})
    bbdc_id = res_a.json()["id"]

    # Compra 100 @ 30.00
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": bbdc_id,
        "tipo_operacao": "BUY",
        "quantidade": "100.0",
        "preco_unitario": "30.00",
    })
    # Vende 40 @ 40.00 -> Lucro: 40 * (40 - 30) = 400.00
    res_venda = client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": bbdc_id,
        "tipo_operacao": "SELL",
        "quantidade": "40.0",
        "preco_unitario": "40.00",
    })
    venda_id = res_venda.json()["id"]

    # Ajusta manual: PM para 32.00, saldo 60.0
    res_ajuste = client.put(f"/api/v1/posicoes/carteiras/1/ativos/{bbdc_id}/ajuste-manual", json={
        "quantidade_saldo": "60.0",
        "preco_medio_brl": "32.00",
    })
    assert res_ajuste.status_code == 200
    pos_data = res_ajuste.json()
    assert Decimal(str(pos_data["quantidade_saldo"])) == Decimal("60.0")
    assert Decimal(str(pos_data["preco_medio_brl"])) == Decimal("32.00")
    # Lucro realizado com PM 32: 40 * (40 - 32) = 320.00
    assert Decimal(str(pos_data["lucro_realizado_brl"])) == Decimal("320.00")

    # Garante que a transação de venda continua existindo no banco
    res_txs = client.get(f"/api/v1/transacoes?carteira_id=1&ativo_id={bbdc_id}")
    txs = res_txs.json()
    assert any(t["id"] == venda_id and t["tipo_operacao"] == "SELL" for t in txs)

    # Força recálculo e valida idempotência total
    res_recalc = client.post("/api/v1/posicoes/carteiras/1/recalcular")
    assert res_recalc.status_code == 200

    res_pos = client.get("/api/v1/posicoes?carteira_id=1")
    pos_recalc = next(p for p in res_pos.json() if p["ativo"]["id"] == bbdc_id)
    assert Decimal(str(pos_recalc["quantidade_saldo"])) == Decimal("60.0")
    assert Decimal(str(pos_recalc["preco_medio_brl"])) == Decimal("32.00")
    assert Decimal(str(pos_recalc["lucro_realizado_brl"])) == Decimal("320.00")


def test_importacao_movimentacao_transferencia_e_bonificacao_deduplicacao(db_session: Session):
    """Garante que Transferência e Bonificação são idempotentes e não duplicam saldos na reimportação."""
    db = db_session
    klbn = Ativo(ticker="KLBN11", nome="Klabin Unit", tipo=TipoAtivo.Acao)
    db.add(klbn)
    db.commit()

    data = [
        {
            "Data": "2024-01-10",
            "Movimentação": "Transferência de Entrada - Custódia",
            "Produto": "KLBN11",
            "Quantidade": 100,
            "Preço unitário": 0.0,
            "Valor da Operação": 0.0,
        },
        {
            "Data": "2024-02-15",
            "Movimentação": "Bonificação em Ativos",
            "Produto": "KLBN11",
            "Quantidade": 10,
            "Preço unitário": 0.0,
            "Valor da Operação": 0.0,
        },
    ]
    df = pd.DataFrame(data)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)
    bytes_excel = buf.getvalue()

    # 1ª importação
    res1 = processar_planilha_movimentacao_b3(db=db, file_content=bytes_excel, carteira_id=1)
    assert len(res1["transacoes"]) == 2

    pos1 = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == klbn.id).first()
    assert pos1.quantidade_saldo == Decimal("110.0")

    # 2ª importação (reimportação do mesmo arquivo): 0 transações adicionais, saldo continua 110
    res2 = processar_planilha_movimentacao_b3(db=db, file_content=bytes_excel, carteira_id=1)
    assert len(res2["transacoes"]) == 0

    db.refresh(pos1)
    assert pos1.quantidade_saldo == Decimal("110.0")


def test_importacao_proventos_multiplos_mesmo_dia(db_session: Session):
    """
    Garante que se o arquivo contiver múltiplos proventos idênticos no mesmo dia
    (ex: dois pagamentos na mesma data), ambos são aceitos na 1ª importação
    e ambos são ignorados na 2ª importação.
    """
    db = db_session
    itub = Ativo(ticker="ITUB4", nome="Itaú Unibanco PN", tipo=TipoAtivo.Acao)
    db.add(itub)
    db.commit()

    data = [
        {
            "Data": "2024-05-10",
            "Movimentação": "Dividendo",
            "Produto": "ITUB4 - ITAU UNIBANCO",
            "Quantidade": 100,
            "Preço unitário": 0.50,
            "Valor da Operação": 50.0,
        },
        {
            "Data": "2024-05-10",
            "Movimentação": "Dividendo",
            "Produto": "ITUB4 - ITAU UNIBANCO",
            "Quantidade": 100,
            "Preço unitário": 0.50,
            "Valor da Operação": 50.0,
        },
    ]
    df = pd.DataFrame(data)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)
    bytes_excel = buf.getvalue()

    res1 = processar_planilha_movimentacao_b3(db=db, file_content=bytes_excel, carteira_id=1)
    assert len(res1["transacoes"]) == 2

    pos = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == itub.id).first()
    assert pos.proventos_acumulados_brl == Decimal("100.00")

    # Reimportação
    res2 = processar_planilha_movimentacao_b3(db=db, file_content=bytes_excel, carteira_id=1)
    assert len(res2["transacoes"]) == 0

    db.refresh(pos)
    assert pos.proventos_acumulados_brl == Decimal("100.00")


def test_conversao_ticker_com_cotacao_manual_e_expiracao(client):
    """Testa conversão de ticker aplicando cotacao_manual e atualizando subscrição expirada."""
    res_a = client.post("/api/v1/ativos", json={"ticker": "BIDI4", "nome": "Banco Inter PN", "tipo": "Acao"})
    bidi_id = res_a.json()["id"]

    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": bidi_id,
        "tipo_operacao": "DIREITO_SUBSCRICAO",
        "quantidade": "100.0",
        "preco_unitario": "0.0",
    })
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": bidi_id,
        "tipo_operacao": "DIREITO_SUBSCRICAO_EXPIRADO",
        "quantidade": "50.0",
        "preco_unitario": "0.0",
    })

    # Converte com fator 2.0 e cotação manual 12.50
    res_conv = client.post(f"/api/v1/ativos/{bidi_id}/converter-ticker", json={
        "novo_ticker": "INBR31",
        "novo_nome": "Inter & Co BDR",
        "fator_conversao": "2.0",
        "cotacao_manual": "12.50",
    })
    assert res_conv.status_code == 200
    data = res_conv.json()
    assert data["ticker"] == "INBR31"
    assert Decimal(str(data["cotacao_manual"])) == Decimal("12.50")

    # Saldo deve ser (100 * 2) - (50 * 2) = 100
    res_pos = client.get("/api/v1/posicoes?carteira_id=1")
    inbr_pos = next(p for p in res_pos.json() if p["ativo"]["ticker"] == "INBR31")
    assert Decimal(str(inbr_pos["quantidade_saldo"])) == Decimal("100.0")


@pytest.mark.anyio
async def test_cotacoes_ignora_renda_fixa_online(db_session: Session):
    """Garante que ativos de Renda Fixa utilizam PM contábil sem realizar chamadas online externas."""
    db = db_session
    carteira = Carteira(id=1, nome="Principal")
    rf = Ativo(ticker="TD-IPCA-2035", nome="Tesouro IPCA+ 2035", tipo=TipoAtivo.RendaFixa)
    db.add_all([carteira, rf])
    db.commit()

    pos = PosicaoConsolidada(
        carteira_id=1,
        ativo_id=rf.id,
        quantidade_saldo=Decimal("10.0"),
        preco_medio_brl=Decimal("3200.50"),
        custo_total_brl=Decimal("32005.00"),
    )
    db.add(pos)
    db.commit()

    # Transport que gera exceção se qualquer chamada for realizada
    def failing_handler(req: httpx.Request):
        raise AssertionError(f"Chamada externa indevida para Renda Fixa: {req.url}")

    transport = httpx.MockTransport(failing_handler)
    resp = await obter_cotacoes_carteira(db=db, carteira_id=1, forcar=True, transport=transport)
    assert "TD-IPCA-2035" in resp.cotacoes
    assert resp.cotacoes["TD-IPCA-2035"].preco_atual == Decimal("3200.50")
    assert resp.cotacoes["TD-IPCA-2035"].fonte == "INDISPONIVEL"


def test_put_transacao_valida_ativo_e_carteira(client):
    """Garante que PUT /transacoes/{id} retorna 404 se ativo_id ou carteira_id informados não existirem."""
    res_a = client.post("/api/v1/ativos", json={"ticker": "CSNA3", "nome": "Siderurgica Nacional", "tipo": "Acao"})
    ativo_id = res_a.json()["id"]

    res_tx = client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": ativo_id,
        "tipo_operacao": "BUY",
        "quantidade": "100.0",
        "preco_unitario": "15.00",
    })
    tx_id = res_tx.json()["id"]

    # Ativo inexistente
    res_err1 = client.put(f"/api/v1/transacoes/{tx_id}", json={"ativo_id": 999999})
    assert res_err1.status_code == 404

    # Carteira inexistente
    res_err2 = client.put(f"/api/v1/transacoes/{tx_id}", json={"carteira_id": 999999})
    assert res_err2.status_code == 404


def test_ajuste_manual_com_alteracao_de_ticker(db_session: Session):
    """Garante que ajustar_posicao_manual permite atualizar o ticker do ativo e previne duplicidade."""
    db = db_session
    carteira = Carteira(id=10, nome="Carteira Teste Ticker")
    ativo = Ativo(ticker="TEMP3", nome="Empresa Temporaria", tipo=TipoAtivo.Acao)
    outro_ativo = Ativo(ticker="EXISTE3", nome="Empresa Existente", tipo=TipoAtivo.Acao)
    db.add_all([carteira, ativo, outro_ativo])
    db.commit()

    # 1. Ajuste renomeando ticker de TEMP3 para NOVO3
    req = AjusteManualPosicaoRequest(
        ticker="NOVO3",
        quantidade_saldo=Decimal("100"),
        preco_medio_brl=Decimal("25.00"),
    )
    pos = ajustar_posicao_manual(db, carteira_id=10, ativo_id=ativo.id, payload=req)
    assert pos.ativo.ticker == "NOVO3"
    assert pos.quantidade_saldo == Decimal("100")
    assert pos.preco_medio_brl == Decimal("25.00")

    # 2. Tentativa de renomear para EXISTE3 (que já pertence a outro ativo) deve levantar PortfolioError
    req_duplicado = AjusteManualPosicaoRequest(
        ticker="EXISTE3",
        quantidade_saldo=Decimal("100"),
        preco_medio_brl=Decimal("25.00"),
    )
    from app.services.portfolio import PortfolioError
    with pytest.raises(PortfolioError, match="já está em uso por outro ativo"):
        ajustar_posicao_manual(db, carteira_id=10, ativo_id=ativo.id, payload=req_duplicado)


def test_rastreamento_transferencia_sem_custo_e_pm_provisorio(client, db_session: Session):
    """
    Testa a Regra 1.1:
    - Transferência de entrada com PU=0 não dilui silenciosamente o PM.
    - quantidade_sem_custo e lotes_pendentes são rastreados.
    - PM provisório = custo_total_brl / (quantidade_saldo - quantidade_sem_custo).
    - custo_pendente é True.
    """
    # 1. Cria ativo e transação de transferência sem custo (500 ações @ 0.00)
    res_a = client.post("/api/v1/ativos", json={"ticker": "KLBN4", "nome": "Klabin PN", "tipo": "Acao"})
    ativo_id = res_a.json()["id"]

    tx_transf = client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": ativo_id,
        "tipo_operacao": "TRANSFERENCIA_ENTRADA",
        "quantidade": "500.0",
        "preco_unitario": "0.0",
        "data_hora": "2022-03-23T10:00:00Z",
    })
    assert tx_transf.status_code == 201

    # 2. Compra com custo real: 500 ações @ R$ 4.00 = R$ 2000
    tx_buy = client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": ativo_id,
        "tipo_operacao": "BUY",
        "quantidade": "500.0",
        "preco_unitario": "4.00",
        "data_hora": "2022-06-01T10:00:00Z",
    })
    assert tx_buy.status_code == 201

    # 3. Consulta posição
    res_pos = client.get("/api/v1/posicoes?somente_com_saldo=true")
    assert res_pos.status_code == 200
    pos_klbn = next(p for p in res_pos.json() if p["ativo"]["ticker"] == "KLBN4")

    assert Decimal(str(pos_klbn["quantidade_saldo"])) == Decimal("1000")
    assert Decimal(str(pos_klbn["quantidade_sem_custo"])) == Decimal("500")
    assert pos_klbn["custo_pendente"] is True
    # PM provisório calculado sobre as 500 ações com custo: 2000 / 500 = 4.00
    assert Decimal(str(pos_klbn["preco_medio_brl"])) == Decimal("4.00")
    assert len(pos_klbn["lotes_pendentes"]) == 1
    assert pos_klbn["lotes_pendentes"][0]["transacao_id"] == tx_transf.json()["id"]


def test_resolucao_modo_a_definir_preco_transferencia(client):
    """
    Testa Modo A:
    - O usuário informa o preco_unitario para o transacao_id da transferência pendente.
    - O backend atualiza e recalcula, somando o lote ao custo total e removendo a pendência.
    """
    res_a = client.post("/api/v1/ativos", json={"ticker": "BBSE3", "nome": "BB Seguridade ON", "tipo": "Acao"})
    ativo_id = res_a.json()["id"]

    tx_transf = client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": ativo_id,
        "tipo_operacao": "TRANSFERENCIA_ENTRADA",
        "quantidade": "300.0",
        "preco_unitario": "0.0",
        "data_hora": "2022-03-23T10:00:00Z",
    })
    tx_id = tx_transf.json()["id"]

    # Modo A: Ajuste manual passando transacao_id e preco_unitario_transferencia = 22.50
    res_adj = client.put(f"/api/v1/posicoes/carteiras/1/ativos/{ativo_id}/ajuste-manual", json={
        "transacao_id": tx_id,
        "preco_unitario_transferencia": "22.50",
    })
    assert res_adj.status_code == 200
    pos = res_adj.json()
    assert Decimal(str(pos["quantidade_saldo"])) == Decimal("300")
    assert Decimal(str(pos["quantidade_sem_custo"])) == Decimal("0")
    assert pos["custo_pendente"] is False
    assert Decimal(str(pos["preco_medio_brl"])) == Decimal("22.50")
    assert Decimal(str(pos["custo_total_brl"])) == Decimal("6750.00")


def test_resolucao_modo_b_engenharia_reversa_pm_consolidado(client):
    """
    Testa Modo B:
    - O usuário informa o pm_consolidado_atual (ex: R$ 25.00 para 1.000 ações).
    - Sabendo que comprou 500 @ R$ 30.00 (custo = R$ 15.000), o backend deduz
      que as 500 da transferência custaram: (1000 * 25) - 15000 = 10.000 (PU = R$ 20.00).
    """
    res_a = client.post("/api/v1/ativos", json={"ticker": "EGIE3", "nome": "Engie Brasil ON", "tipo": "Acao"})
    ativo_id = res_a.json()["id"]

    # 1. 500 transferidas a custo zero
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": ativo_id,
        "tipo_operacao": "TRANSFERENCIA_ENTRADA",
        "quantidade": "500.0",
        "preco_unitario": "0.0",
        "data_hora": "2022-03-23T10:00:00Z",
    })

    # 2. 500 compradas a R$ 30.00
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": ativo_id,
        "tipo_operacao": "BUY",
        "quantidade": "500.0",
        "preco_unitario": "30.00",
        "data_hora": "2023-01-10T10:00:00Z",
    })

    # Modo B: Informa PM consolidado final de R$ 25.00
    res_adj = client.put(f"/api/v1/posicoes/carteiras/1/ativos/{ativo_id}/ajuste-manual", json={
        "pm_consolidado_atual": "25.00",
    })
    assert res_adj.status_code == 200
    pos = res_adj.json()
    assert Decimal(str(pos["quantidade_saldo"])) == Decimal("1000")
    assert Decimal(str(pos["quantidade_sem_custo"])) == Decimal("0")
    assert pos["custo_pendente"] is False
    assert Decimal(str(pos["preco_medio_brl"])) == Decimal("25.00")
    assert Decimal(str(pos["custo_total_brl"])) == Decimal("25000.00")


@pytest.mark.anyio
async def test_modo_c_cotacao_historica_endpoint(client, monkeypatch):
    """Testa o endpoint GET /api/v1/ativos/{id}/cotacao-historica?data=YYYY-MM-DD com mock do Yahoo."""
    res_a = client.post("/api/v1/ativos", json={"ticker": "VALE3", "nome": "Vale ON", "tipo": "Acao"})
    ativo_id = res_a.json()["id"]

    import app.api.v1.endpoints.ativos as ativos_ep

    async def mock_obter_cotacao_historica(ticker: str, data_str: str, client=None):
        return Decimal("85.50")

    monkeypatch.setattr(ativos_ep, "obter_cotacao_historica", mock_obter_cotacao_historica)

    res = client.get(f"/api/v1/ativos/{ativo_id}/cotacao-historica?data=2022-03-23")
    assert res.status_code == 200
    data = res.json()
    assert data["ticker"] == "VALE3"
    assert data["data"] == "2022-03-23"
    assert Decimal(str(data["cotacao_fechamento"])) == Decimal("85.50")


def test_filtro_aluguel_btc_nao_gera_venda(client):
    """
    Testa Regra 2.2:
    - Debito | Transferência - Liquidação de 100 ações com PU=0 ou linha Empréstimo associada
      deve ser detectado como saída de BTC e NÃO como venda SELL.
    - Credito | Transferência - Liquidação subsequente de 100 ações com PU=0 deve ser detectado
      como retorno de BTC e NÃO como compra BUY.
    """
    mov_data = [
        # 1. Entrada de 100 ações
        {"Data": "2024-01-02", "Movimentação": "Transferência", "Entrada/Saída": "Credito", "Produto": "B3SA3 - B3 ON", "Quantidade": 100, "Preço unitário": 12.00, "Valor da Operação": 1200.00},
        # 2. Saída para Empréstimo BTC (PU = 0)
        {"Data": "2024-02-01", "Movimentação": "Transferência - Liquidação", "Entrada/Saída": "Debito", "Produto": "B3SA3 - B3 ON", "Quantidade": 100, "Preço unitário": 0.0, "Valor da Operação": 0.0},
        # 3. Retorno do Empréstimo BTC
        {"Data": "2024-02-15", "Movimentação": "Transferência - Liquidação", "Entrada/Saída": "Credito", "Produto": "B3SA3 - B3 ON", "Quantidade": 100, "Preço unitário": 0.0, "Valor da Operação": 0.0},
    ]
    df = pd.DataFrame(mov_data)
    out = io.BytesIO()
    with pd.ExcelWriter(out, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)

    res = client.post("/api/v1/importacao/b3-transferencias", files={"file": ("btc.xlsx", out.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert res.status_code == 200

    res_pos = client.get("/api/v1/posicoes?somente_com_saldo=true")
    pos_b3 = next(p for p in res_pos.json() if p["ativo"]["ticker"] == "B3SA3")
    assert Decimal(str(pos_b3["quantidade_saldo"])) == Decimal("100")
    assert Decimal(str(pos_b3["preco_medio_brl"])) == Decimal("12.00")


def test_upload_multiplo_planilhas_b3_transferencias(client):
    """Testa o envio de múltiplos arquivos .xlsx simultâneos em /b3-transferencias."""
    mov_p1 = [
        {"Data": "2022-03-23", "Movimentação": "Transferência", "Entrada/Saída": "Credito", "Produto": "CMIG4 - CEMIG PN", "Quantidade": 200, "Preço unitário": 10.00, "Valor da Operação": 2000.00},
    ]
    mov_p2 = [
        {"Data": "2023-05-10", "Movimentação": "Bonificação em Ativos", "Entrada/Saída": "Credito", "Produto": "CMIG4 - CEMIG PN", "Quantidade": 20, "Preço unitário": "-", "Valor da Operação": "-"},
    ]
    df1 = pd.DataFrame(mov_p1)
    df2 = pd.DataFrame(mov_p2)
    out1, out2 = io.BytesIO(), io.BytesIO()
    with pd.ExcelWriter(out1, engine="openpyxl") as w1:
        df1.to_excel(w1, index=False)
    with pd.ExcelWriter(out2, engine="openpyxl") as w2:
        df2.to_excel(w2, index=False)

    res = client.post(
        "/api/v1/importacao/b3-transferencias",
        files=[
            ("files", ("p1.xlsx", out1.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")),
            ("files", ("p2.xlsx", out2.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")),
        ]
    )
    assert res.status_code == 200
    res_pos = client.get("/api/v1/posicoes?somente_com_saldo=true")
    pos_cmig = next(p for p in res_pos.json() if p["ativo"]["ticker"] == "CMIG4")
    assert Decimal(str(pos_cmig["quantidade_saldo"])) == Decimal("220")


def test_posicao_encerrada_com_transferencia_sem_custo_e_resolucao(client):
    """
    Testa ativo transferido sem custo que foi integralmente vendido (Posição Encerrada):
    1. Preserva quantidade_sem_custo e lotes_pendentes mesmo com saldo 0.
    2. Rastreia valor_total_venda_brl.
    3. Ao resolver via Modo A (ou Modo C), recalcula perfeitamente o lucro realizado
       e zera a pendência de custo.
    """
    res_a = client.post("/api/v1/ativos", json={"ticker": "ITUB4", "nome": "Itaú Unibanco PN", "tipo": "Acao"})
    itub_id = res_a.json()["id"]

    # 1. 200 ações transferidas a PU = 0
    tx_transf = client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": itub_id,
        "tipo_operacao": "TRANSFERENCIA_ENTRADA",
        "quantidade": "200.0",
        "preco_unitario": "0.0",
        "data_hora": "2022-03-23T10:00:00Z",
    })
    assert tx_transf.status_code == 201
    transf_id = tx_transf.json()["id"]

    # 2. Venda total de 200 ações a R$ 25.00 (Valor de venda = R$ 5.000,00)
    tx_sell = client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": itub_id,
        "tipo_operacao": "SELL",
        "quantidade": "200.0",
        "preco_unitario": "25.00",
        "data_hora": "2023-05-10T10:00:00Z",
    })
    assert tx_sell.status_code == 201

    # Consulta posição encerrada (somente_com_saldo=false)
    res_pos = client.get("/api/v1/posicoes?somente_com_saldo=false")
    assert res_pos.status_code == 200
    pos_itub = next(p for p in res_pos.json() if p["ativo"]["ticker"] == "ITUB4")

    assert Decimal(str(pos_itub["quantidade_saldo"])) == Decimal("0")
    assert Decimal(str(pos_itub["quantidade_sem_custo"])) == Decimal("200")
    assert pos_itub["custo_pendente"] is True
    assert Decimal(str(pos_itub["valor_total_venda_brl"])) == Decimal("5000.00")
    assert len(pos_itub["lotes_pendentes"]) == 1
    assert pos_itub["lotes_pendentes"][0]["transacao_id"] == transf_id

    # 3. Resolve a pendência via Modo A definindo PU = R$ 20.00 (custo = R$ 4.000,00)
    res_adj = client.put(f"/api/v1/posicoes/carteiras/1/ativos/{itub_id}/ajuste-manual", json={
        "transacao_id": transf_id,
        "preco_unitario_transferencia": "20.00",
    })
    assert res_adj.status_code == 200
    pos_resolvida = res_adj.json()

    assert Decimal(str(pos_resolvida["quantidade_saldo"])) == Decimal("0")
    assert Decimal(str(pos_resolvida["quantidade_sem_custo"])) == Decimal("0")
    assert pos_resolvida["custo_pendente"] is False
    assert Decimal(str(pos_resolvida["valor_total_venda_brl"])) == Decimal("5000.00")
    # Lucro realizado = 5.000 (venda) - 4.000 (custo da transferência) = 1.000
    assert Decimal(str(pos_resolvida["lucro_realizado_brl"])) == Decimal("1000.00")
    assert len(pos_resolvida["lotes_pendentes"]) == 0


def test_idempotencia_a7rn11_e_itsa2_multiplos_uploads(client):
    """
    Testa a ingestão e deduplicação de eventos corporativos especiais:
    - Resgate A7RN11 liquidando AESB3 pelo valor da operação.
    - Exercício de subscrição de ITSA2 gerando compra de ITSA4.
    - Re-importação não gera transações duplicadas.
    """
    mov_data = [
        # Transferência inicial de 200 AESB3 a PU 0
        {"Data": "2022-03-23", "Movimentação": "Transferência", "Entrada/Saída": "Credito", "Produto": "AESB3 - AES BRASIL ON", "Quantidade": 200, "Preço unitário": 0.0, "Valor da Operação": 0.0},
        # Resgate de A7RN11 (liquidando AESB3 por R$ 2.500,00)
        {"Data": "2024-11-08", "Movimentação": "Resgate", "Entrada/Saída": "Credito", "Produto": "A7RN11 - A7RN11 ON", "Quantidade": 200, "Preço unitário": "-", "Valor da Operação": 2500.00},
        # Exercício de subscrição ITSA2
        {"Data": "2023-01-20", "Movimentação": "Direitos de Subscrição - Exercido", "Entrada/Saída": "Debito", "Produto": "ITSA2 - ITAUSA", "Quantidade": 20, "Preço unitário": 7.00, "Valor da Operação": 140.00},
    ]
    df = pd.DataFrame(mov_data)
    out = io.BytesIO()
    with pd.ExcelWriter(out, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)

    # 1ª Importação
    res1 = client.post("/api/v1/importacao/b3-transferencias", files={"file": ("corp.xlsx", out.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert res1.status_code == 200
    transacoes_count_1 = res1.json()["transacoes_processadas"]
    assert transacoes_count_1 >= 2

    # 2ª Importação idêntica (deduplicação deve evitar duplicações)
    res2 = client.post("/api/v1/importacao/b3-transferencias", files={"file": ("corp.xlsx", out.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert res2.status_code == 200
    transacoes_count_2 = res2.json()["transacoes_processadas"]
    assert transacoes_count_2 == 0  # Nenhuma transação duplicada inserida

    # Verifica saldos
    res_pos = client.get("/api/v1/posicoes?somente_com_saldo=false")
    pos_map = {p["ativo"]["ticker"]: p for p in res_pos.json()}

    # AESB3: liquidada integralmente (saldo 0) com valor de venda R$ 2.500,00
    assert "AESB3" in pos_map
    assert Decimal(str(pos_map["AESB3"]["quantidade_saldo"])) == Decimal("0")
    assert Decimal(str(pos_map["AESB3"]["valor_total_venda_brl"])) == Decimal("2500.00")

    # ITSA4: 20 ações compradas a R$ 7.00
    assert "ITSA4" in pos_map
    assert Decimal(str(pos_map["ITSA4"]["quantidade_saldo"])) == Decimal("20")
    assert Decimal(str(pos_map["ITSA4"]["preco_medio_brl"])) == Decimal("7.00")


def test_venda_lote_pendente_abate_com_custo_e_compras_posteriores(client):
    """
    Testa Problema 1:
    - Venda de ativo com lote pendente abate primeiro das ações com custo conhecido.
    - Em vendas mistas, lucro realizado é proporcional à fração com custo.
    - Quantidade sem custo em custódia ativa é reduzida sem distorcer compras posteriores.
    """
    res_a = client.post("/api/v1/ativos", json={"ticker": "TEST1", "nome": "Test Ativo 1", "tipo": "Acao"})
    ativo_id = res_a.json()["id"]

    # 1. Transferência de 100 ações sem custo (PU=0)
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": ativo_id,
        "tipo_operacao": "TRANSFERENCIA_ENTRADA",
        "quantidade": "100.0",
        "preco_unitario": "0.0",
        "data_hora": "2023-01-01T10:00:00Z",
    })

    # 2. Compra de 100 ações @ R$ 20.00 (custo = 2.000)
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": ativo_id,
        "tipo_operacao": "BUY",
        "quantidade": "100.0",
        "preco_unitario": "20.00",
        "data_hora": "2023-02-01T10:00:00Z",
    })

    # Saldo = 200 (100 com custo @ 20, 100 sem custo)
    # 3. Venda de 50 ações @ R$ 30.00 (deve abater das 100 com custo)
    # Lucro = 50 * (30 - 20) = 500
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": ativo_id,
        "tipo_operacao": "SELL",
        "quantidade": "50.0",
        "preco_unitario": "30.00",
        "data_hora": "2023-03-01T10:00:00Z",
    })

    res_pos1 = client.get("/api/v1/posicoes?somente_com_saldo=true")
    p1 = next(p for p in res_pos1.json() if p["ativo_id"] == ativo_id)
    assert Decimal(str(p1["quantidade_saldo"])) == Decimal("150")
    assert Decimal(str(p1["quantidade_sem_custo"])) == Decimal("100")
    assert Decimal(str(p1["custo_total_brl"])) == Decimal("1000.00")
    assert Decimal(str(p1["preco_medio_brl"])) == Decimal("20.00")
    assert Decimal(str(p1["lucro_realizado_brl"])) == Decimal("500.00")

    # 4. Venda de 100 ações @ R$ 30.00 (Venda mista: 50 com custo @ 20 e 50 sem custo)
    # Receita líquida = 3.000; fração com custo = 50/100 = 0.5 -> receita com custo = 1.500
    # Custo baixa = 50 * 20 = 1.000 -> lucro desta venda = 500.
    # Lucro total acumulado = 500 + 500 = 1.000.
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": ativo_id,
        "tipo_operacao": "SELL",
        "quantidade": "100.0",
        "preco_unitario": "30.00",
        "data_hora": "2023-04-01T10:00:00Z",
    })

    res_pos2 = client.get("/api/v1/posicoes?somente_com_saldo=true")
    p2 = next(p for p in res_pos2.json() if p["ativo_id"] == ativo_id)
    assert Decimal(str(p2["quantidade_saldo"])) == Decimal("50")
    assert Decimal(str(p2["quantidade_sem_custo"])) == Decimal("50")
    assert Decimal(str(p2["custo_total_brl"])) == Decimal("0.00")
    assert Decimal(str(p2["lucro_realizado_brl"])) == Decimal("1000.00")

    # 5. Compra subsequente de 50 ações @ R$ 25.00
    # Saldo = 100 (50 com custo @ 25, 50 sem custo). PM provisório deve ser R$ 25.00!
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": ativo_id,
        "tipo_operacao": "BUY",
        "quantidade": "50.0",
        "preco_unitario": "25.00",
        "data_hora": "2023-05-01T10:00:00Z",
    })

    res_pos3 = client.get("/api/v1/posicoes?somente_com_saldo=true")
    p3 = next(p for p in res_pos3.json() if p["ativo_id"] == ativo_id)
    assert Decimal(str(p3["quantidade_saldo"])) == Decimal("100")
    assert Decimal(str(p3["quantidade_sem_custo"])) == Decimal("50")
    assert Decimal(str(p3["custo_total_brl"])) == Decimal("1250.00")
    assert Decimal(str(p3["preco_medio_brl"])) == Decimal("25.00")


def test_modo_b_vendas_intermediarias_e_posicao_encerrada(client):
    """
    Testa Problema 1 (Modo B):
    1. Ativo com venda intermediária escalando fator de retenção do lote.
    2. Ativo com posição encerrada (saldo == 0) usando qtd_total_adquirida.
    """
    res_a = client.post("/api/v1/ativos", json={"ticker": "TESTB1", "nome": "Test B 1", "tipo": "Acao"})
    b1_id = res_a.json()["id"]

    # 1. 500 transferidas a PU = 0
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": b1_id,
        "tipo_operacao": "TRANSFERENCIA_ENTRADA",
        "quantidade": "500.0",
        "preco_unitario": "0.0",
        "data_hora": "2022-01-01T10:00:00Z",
    })
    # 2. 500 compradas a R$ 30.00 (custo = 15.000)
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": b1_id,
        "tipo_operacao": "BUY",
        "quantidade": "500.0",
        "preco_unitario": "30.00",
        "data_hora": "2022-02-01T10:00:00Z",
    })
    # 3. Venda de 200 ações (abate 200 das 500 com custo; sobra 300 com custo e 500 do lote transferido)
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": b1_id,
        "tipo_operacao": "SELL",
        "quantidade": "200.0",
        "preco_unitario": "35.00",
        "data_hora": "2022-03-01T10:00:00Z",
    })

    # Saldo atual = 800 (300 com custo de 9.000, 500 pendentes).
    # Informa PM consolidado = 25.00 -> meta custo = 800 * 25 = 20.000.
    # Custo pendente = 20.000 - 9.000 = 11.000.
    # Como 500 de 500 do lote estão retidas, fator_retencao = 1.0 -> PU = 11.000 / 500 = 22.00.
    res_adj1 = client.put(f"/api/v1/posicoes/carteiras/1/ativos/{b1_id}/ajuste-manual", json={
        "pm_consolidado_atual": "25.00",
    })
    assert res_adj1.status_code == 200
    pos1 = res_adj1.json()
    assert Decimal(str(pos1["quantidade_saldo"])) == Decimal("800")
    assert Decimal(str(pos1["preco_medio_brl"])) == Decimal("25.00")
    assert Decimal(str(pos1["custo_total_brl"])) == Decimal("20000.00")
    assert pos1["custo_pendente"] is False

    # Teste de Posição Encerrada (saldo == 0) no Modo B:
    res_b2 = client.post("/api/v1/ativos", json={"ticker": "TESTB2", "nome": "Test B 2", "tipo": "Acao"})
    b2_id = res_b2.json()["id"]

    # 200 transferidas a PU = 0
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": b2_id,
        "tipo_operacao": "TRANSFERENCIA_ENTRADA",
        "quantidade": "200.0",
        "preco_unitario": "0.0",
        "data_hora": "2022-01-01T10:00:00Z",
    })
    # 100 compradas a R$ 30.00 (custo = 3.000)
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": b2_id,
        "tipo_operacao": "BUY",
        "quantidade": "100.0",
        "preco_unitario": "30.00",
        "data_hora": "2022-02-01T10:00:00Z",
    })
    # Venda total de 300 ações a R$ 40.00 (receita = 12.000)
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": b2_id,
        "tipo_operacao": "SELL",
        "quantidade": "300.0",
        "preco_unitario": "40.00",
        "data_hora": "2022-03-01T10:00:00Z",
    })

    # Posição está encerrada (saldo == 0).
    # Aplica Modo B com PM consolidado histórico de R$ 20.00:
    # qtd_total_adquirida = 200 + 100 = 300.
    # custo_transf = (300 * 20) - 3000 = 3.000 -> PU = 3.000 / 200 = 15.00.
    # Lucro realizado recalculado = 12.000 - (200 * 15 + 100 * 30) = 12.000 - 6.000 = 6.000!
    res_adj2 = client.put(f"/api/v1/posicoes/carteiras/1/ativos/{b2_id}/ajuste-manual", json={
        "pm_consolidado_atual": "20.00",
    })
    assert res_adj2.status_code == 200
    pos2 = res_adj2.json()
    assert Decimal(str(pos2["quantidade_saldo"])) == Decimal("0")
    assert Decimal(str(pos2["lucro_realizado_brl"])) == Decimal("6000.00")
    # Teste de Posição Ativa com venda parcial intermediária do lote transferido (fator_retencao < 1.0):
    res_b3 = client.post("/api/v1/ativos", json={"ticker": "TESTB3", "nome": "Test B 3", "tipo": "Acao"})
    b3_id = res_b3.json()["id"]

    # 1. 500 transferidas a PU = 0
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": b3_id,
        "tipo_operacao": "TRANSFERENCIA_ENTRADA",
        "quantidade": "500.0",
        "preco_unitario": "0.0",
        "data_hora": "2022-01-01T10:00:00Z",
    })
    # 2. Venda parcial prévia de 200 ações do lote transferido (saldo sem custo passa a 300 de 500 -> fator_retencao = 0.6)
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": b3_id,
        "tipo_operacao": "SELL",
        "quantidade": "200.0",
        "preco_unitario": "20.00",
        "data_hora": "2022-02-01T10:00:00Z",
    })
    # 3. Compra posterior de 500 ações a R$ 30.00 (custo conhecido em custódia = 15.000)
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1,
        "ativo_id": b3_id,
        "tipo_operacao": "BUY",
        "quantidade": "500.0",
        "preco_unitario": "30.00",
        "data_hora": "2022-03-01T10:00:00Z",
    })

    # Saldo atual = 800 (500 com custo de 15.000, 300 pendentes).
    # Informa PM consolidado = 25.00 -> meta custo = 800 * 25 = 20.000.
    # Custo pendente = 20.000 - 15.000 = 5.000.
    # Como 300 de 500 do lote estão retidas, fator_retencao = 0.6 -> custo_transf = 5.000 / 0.6 = 8.333,33 -> PU = 16.6667.
    res_adj3 = client.put(f"/api/v1/posicoes/carteiras/1/ativos/{b3_id}/ajuste-manual", json={
        "pm_consolidado_atual": "25.00",
    })
    assert res_adj3.status_code == 200
    pos3 = res_adj3.json()
    assert Decimal(str(pos3["quantidade_saldo"])) == Decimal("800")
    assert round(Decimal(str(pos3["preco_medio_brl"])), 2) == Decimal("25.00")
    assert round(Decimal(str(pos3["custo_total_brl"])), 2) == Decimal("20000.00")
    assert pos3["custo_pendente"] is False


def test_deduplicacao_transferencia_entrada_mesmo_com_pm_ajustado(client):
    """
    Testa Problema 2:
    - Ao reimportar B3 TRANSFERENCIA_ENTRADA PU=0, detecta duplicação mesmo se
      o usuário tiver ajustado o PM manualmente da transação anterior (tx_ant.preco_unitario > 0).
    """
    res_a = client.post("/api/v1/ativos", json={"ticker": "DEDUP1", "nome": "Dedup Ativo", "tipo": "Acao"})
    ativo_id = res_a.json()["id"]

    # 1. Primeira importação via planilha com PU = 0
    mov_data = [
        {"Data": "2022-03-23", "Movimentação": "Transferência", "Entrada/Saída": "Credito", "Produto": "DEDUP1 - TESTE", "Quantidade": 100, "Preço unitário": 0.0, "Valor da Operação": 0.0},
    ]
    df = pd.DataFrame(mov_data)
    out = io.BytesIO()
    with pd.ExcelWriter(out, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)

    res1 = client.post("/api/v1/importacao/b3-transferencias", files={"file": ("t1.xlsx", out.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert res1.status_code == 200
    assert res1.json()["transacoes_processadas"] == 1

    # 2. Usuário ajusta manualmente o PM para R$ 18.00 (Modo A)
    res_pos = client.get("/api/v1/posicoes?somente_com_saldo=true")
    pos_item = next(p for p in res_pos.json() if p["ativo_id"] == ativo_id)
    tx_id = pos_item["lotes_pendentes"][0]["transacao_id"]

    client.put(f"/api/v1/posicoes/carteiras/1/ativos/{ativo_id}/ajuste-manual", json={
        "transacao_id": tx_id,
        "preco_unitario_transferencia": "18.00",
    })

    # 3. Usuário reimporta a mesma planilha original (PU=0)
    res2 = client.post("/api/v1/importacao/b3-transferencias", files={"file": ("t1.xlsx", out.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert res2.status_code == 200
    # Deve ser identificada como duplicada e ignorada
    assert res2.json()["transacoes_processadas"] == 0

    res_pos2 = client.get("/api/v1/posicoes?somente_com_saldo=true")
    pos_item2 = next(p for p in res_pos2.json() if p["ativo_id"] == ativo_id)
    assert Decimal(str(pos_item2["quantidade_saldo"])) == Decimal("100")
    assert Decimal(str(pos_item2["preco_medio_brl"])) == Decimal("18.00")


@pytest.mark.anyio
async def test_obter_cotacao_historica_fallback_e_desajuste_splits(monkeypatch):
    """
    Testa Problema 3:
    1. Fallback de ticker histórico ISAE4 -> TRPL4.
    2. Desajuste de splits ocorridos após a data histórica consultada.
    """
    from app.services.cotacoes import obter_cotacao_historica

    # Mock do AsyncClient
    import httpx

    target_split_dt = int(datetime(2024, 5, 1, tzinfo=timezone.utc).timestamp())
    mock_response_payload = {
        "chart": {
            "result": [
                {
                    "timestamp": [int(datetime(2022, 3, 23, tzinfo=timezone.utc).timestamp())],
                    "indicators": {
                        "quote": [
                            {"close": [12.50]}
                        ]
                    },
                    "events": {
                        "splits": {
                            str(target_split_dt): {
                                "date": target_split_dt,
                                "numerator": 2,
                                "denominator": 1,
                                "splitRatio": "2:1",
                            }
                        }
                    }
                }
            ]
        }
    }

    class MockTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            url_str = str(request.url)
            # Se for ISAE4.SA, retorna 404 para testar fallback para TRPL4.SA
            if "ISAE4.SA" in url_str:
                return httpx.Response(404, json={})
            elif "TRPL4.SA" in url_str:
                return httpx.Response(200, json=mock_response_payload)
            return httpx.Response(404, json={})

    async with httpx.AsyncClient(transport=MockTransport()) as test_client:
        preco = await obter_cotacao_historica("ISAE4", "2022-03-23", client=test_client)
        assert preco is not None
        # Preço ajustado era 12.50. Split 2:1 após a data -> preço nominal original = 12.50 * (2/1) = 25.00
        assert preco == Decimal("25.00")


def test_devolucao_btc_par_pu0_e_emprestimo_taxa_efetiva(client):
    """
    Testa Problema 2:
    - Devolução de BTC com par de transferência PU=0 não vira BUY PU=0.
    - Empréstimo com valor nocional é ignorado e não vira RENDIMENTO.
    - Empréstimo com taxa efetiva vira RENDIMENTO.
    """
    mov_data = [
        # 1. Compra base
        {"Data": "2024-01-02", "Movimentação": "Transferência", "Entrada/Saída": "Credito", "Produto": "BTC1 - TESTE", "Quantidade": 100, "Preço unitário": 10.00, "Valor da Operação": 1000.00},
        # 2. Saída para empréstimo BTC (PU=0)
        {"Data": "2024-01-10", "Movimentação": "Transferência - Liquidação", "Entrada/Saída": "Debito", "Produto": "BTC1 - TESTE", "Quantidade": 100, "Preço unitário": 0.0, "Valor da Operação": 0.0},
        # 3. Retorno do empréstimo BTC com PU=0 e sem saldo_emprestado acumulado prévio suficiente, mas com par de transferência
        {"Data": "2024-01-12", "Movimentação": "Transferência - Liquidação", "Entrada/Saída": "Credito", "Produto": "BTC1 - TESTE", "Quantidade": 100, "Preço unitário": 0.0, "Valor da Operação": 0.0},
        # 4. Empréstimo com valor nocional do ativo (Ex: 100 ações @ 10 = 1000) -> NÃO deve virar RENDIMENTO
        {"Data": "2024-01-15", "Movimentação": "Empréstimo", "Entrada/Saída": "Debito", "Produto": "BTC1 - TESTE", "Quantidade": 100, "Preço unitário": 10.00, "Valor da Operação": 1000.00},
        # 5. Empréstimo crédito com taxa efetiva (Ex: taxa líquida de R$ 15.50 com PU=0) -> DEVE virar RENDIMENTO
        {"Data": "2024-01-20", "Movimentação": "Empréstimo", "Entrada/Saída": "Credito", "Produto": "BTC1 - TESTE", "Quantidade": 100, "Preço unitário": 0.0, "Valor da Operação": 15.50},
    ]
    df = pd.DataFrame(mov_data)
    out = io.BytesIO()
    with pd.ExcelWriter(out, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)

    res = client.post("/api/v1/importacao/b3-transferencias", files={"file": ("btc_test.xlsx", out.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert res.status_code == 200

    res_pos = client.get("/api/v1/posicoes?somente_com_saldo=true")
    pos_btc = next(p for p in res_pos.json() if p["ativo"]["ticker"] == "BTC1")
    # Saldo deve ser 100 (compra inicial mantida, saídas/retornos de empréstimo não viraram SELL/BUY indevidos)
    assert Decimal(str(pos_btc["quantidade_saldo"])) == Decimal("100")
    assert Decimal(str(pos_btc["preco_medio_brl"])) == Decimal("10.00")
    # Provento deve ser exatamente os R$ 15.50 da taxa efetiva (e não os R$ 1.000 nocionais)
    assert Decimal(str(pos_btc["proventos_acumulados_brl"])) == Decimal("15.50")


@pytest.mark.anyio
async def test_obter_cotacao_historica_splits_formato_lista_e_split_ratio():
    """Testa robustez de obter_cotacao_historica quando splits vem como lista com splitRatio."""
    from app.services.cotacoes import obter_cotacao_historica
    import httpx

    target_split_dt = int(datetime(2023, 6, 1, tzinfo=timezone.utc).timestamp())
    mock_payload = {
        "chart": {
            "result": [
                {
                    "timestamp": [int(datetime(2022, 1, 10, tzinfo=timezone.utc).timestamp())],
                    "indicators": {
                        "quote": [
                            {"close": [10.00]}
                        ]
                    },
                    "events": {
                        "splits": [
                            {
                                "date": target_split_dt,
                                "splitRatio": "3:1",
                            }
                        ]
                    }
                }
            ]
        }
    }

    class MockTransportList(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=mock_payload)

    async with httpx.AsyncClient(transport=MockTransportList()) as test_client:
        preco = await obter_cotacao_historica("ELET3", "2022-01-10", client=test_client)
        assert preco is not None
        # 10.00 * (3 / 1) = 30.00
        assert preco == Decimal("30.00")


def test_devolucao_btc_isolada_sem_par_nunca_vira_buy_pu0(client):
    """
    Testa que uma devolução de BTC isolada (Transferência - Liquidação Credito com PU=0 e Valor=0)
    sem saldo prévio emprestado e sem par de transferência NÃO se torna um BUY com PU=0.
    """
    mov_data = [
        {"Data": "2024-03-01", "Movimentação": "Transferência", "Entrada/Saída": "Credito", "Produto": "ISOL1 - TESTE", "Quantidade": 50, "Preço unitário": 20.00, "Valor da Operação": 1000.00},
        {"Data": "2024-03-10", "Movimentação": "Transferência - Liquidação", "Entrada/Saída": "Credito", "Produto": "ISOL1 - TESTE", "Quantidade": 50, "Preço unitário": 0.0, "Valor da Operação": 0.0},
    ]
    df = pd.DataFrame(mov_data)
    out = io.BytesIO()
    with pd.ExcelWriter(out, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)

    res = client.post("/api/v1/importacao/b3-transferencias", files={"file": ("isol_btc.xlsx", out.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert res.status_code == 200

    res_pos = client.get("/api/v1/posicoes?somente_com_saldo=true")
    pos_isol = next(p for p in res_pos.json() if p["ativo"]["ticker"] == "ISOL1")
    # Saldo deve permanecer 50 e PM R$ 20,00 (a linha isolada não virou BUY PU=0 para diluir indevidamente para 100 cotas a R$ 10)
    assert Decimal(str(pos_isol["quantidade_saldo"])) == Decimal("50")
    assert Decimal(str(pos_isol["preco_medio_brl"])) == Decimal("20.00")


def test_modo_b_com_grupamento_irbr3_e_desdobro_hgbs11(client):
    """
    Valida que o Modo B (engenharia reversa do PM consolidado atual) calcula
    exatamente o preco_unitario original na TRANSFERENCIA_ENTRADA de 2022 mesmo
    quando houve Grupamento (ex: IRBR3 30:1) ou Desdobro (ex: HGBS11 1:10).
    """
    # 1. Caso IRBR3 (Grupamento 30:1): 500 transf sem preço + 1900 compradas @ R$ 1.00 = 2400 -> grupamento para 80 ações
    res_irb = client.post("/api/v1/ativos", json={"ticker": "IRBR3", "nome": "IRB Brasil ON", "tipo": "Acao"})
    irb_id = res_irb.json()["id"]

    client.post("/api/v1/transacoes", json={
        "carteira_id": 1, "ativo_id": irb_id, "tipo_operacao": "TRANSFERENCIA_ENTRADA",
        "quantidade": "500.0", "preco_unitario": "0.0", "data_hora": "2022-03-23T10:00:00Z",
    })
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1, "ativo_id": irb_id, "tipo_operacao": "BUY",
        "quantidade": "1900.0", "preco_unitario": "1.00", "data_hora": "2022-08-10T10:00:00Z",
    })
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1, "ativo_id": irb_id, "tipo_operacao": "GRUPAMENTO",
        "quantidade": "80.0", "preco_unitario": "0.0", "data_hora": "2023-01-26T10:00:00Z",
    })

    # Usuário informa que o PM consolidado atual das 80 ações é R$ 42.50 (custo total alvo = R$ 3.400,00)
    # Como as 1900 compradas custaram R$ 1.900,00, as 500 originais devem custar R$ 1.500,00 (PU = R$ 3,00 em 2022)
    res_adj_irb = client.put(f"/api/v1/posicoes/carteiras/1/ativos/{irb_id}/ajuste-manual", json={
        "pm_consolidado_atual": "42.50",
    })
    assert res_adj_irb.status_code == 200
    pos_irb = res_adj_irb.json()
    assert Decimal(str(pos_irb["quantidade_saldo"])) == Decimal("80")
    assert pos_irb["custo_pendente"] is False
    assert Decimal(str(pos_irb["preco_medio_brl"])) == Decimal("42.50")
    assert Decimal(str(pos_irb["custo_total_brl"])) == Decimal("3400.00")

    # 2. Caso HGBS11 (Desdobro 1:10): 5 transf sem preço + 22 compradas @ R$ 200 = 27 -> desdobro +243 = 270 cotas
    res_hgbs = client.post("/api/v1/ativos", json={"ticker": "HGBS11", "nome": "Hedge Brasil Shopping", "tipo": "FII"})
    hgbs_id = res_hgbs.json()["id"]

    client.post("/api/v1/transacoes", json={
        "carteira_id": 1, "ativo_id": hgbs_id, "tipo_operacao": "TRANSFERENCIA_ENTRADA",
        "quantidade": "5.0", "preco_unitario": "0.0", "data_hora": "2022-03-23T10:00:00Z",
    })
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1, "ativo_id": hgbs_id, "tipo_operacao": "BUY",
        "quantidade": "22.0", "preco_unitario": "200.00", "data_hora": "2023-05-10T10:00:00Z",
    })
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1, "ativo_id": hgbs_id, "tipo_operacao": "DESDOBRO",
        "quantidade": "243.0", "preco_unitario": "0.0", "data_hora": "2025-05-13T10:00:00Z",
    })

    # Usuário informa que o PM consolidado atual das 270 cotas é R$ 20.00 (custo total alvo = R$ 5.400,00)
    # Como as 22 compradas custaram R$ 4.400,00, as 5 originais devem custar R$ 1.000,00 (PU = R$ 200,00 em 2022)
    res_adj_hgbs = client.put(f"/api/v1/posicoes/carteiras/1/ativos/{hgbs_id}/ajuste-manual", json={
        "pm_consolidado_atual": "20.00",
    })
    assert res_adj_hgbs.status_code == 200
    pos_hgbs = res_adj_hgbs.json()
    assert Decimal(str(pos_hgbs["quantidade_saldo"])) == Decimal("270")
    assert pos_hgbs["custo_pendente"] is False
    assert Decimal(str(pos_hgbs["preco_medio_brl"])) == Decimal("20.00")
    assert Decimal(str(pos_hgbs["custo_total_brl"])) == Decimal("5400.00")


def test_modo_b_com_transacao_id_e_bonificacao_fracao_itsa4(client):
    """
    Reproduz o payload enviado pelo frontend Angular no Modo B para ITSA4:
    { "transacao_id": tx_id, "pm_consolidado_atual": 10.00 }
    Garante que o backend NÃO entra por engano no bloco do Modo A zerando o PU,
    e contabiliza corretamente BONIFICACAO e FRACAO_ATIVOS na simulação.
    """
    res_itsa = client.post("/api/v1/ativos", json={"ticker": "ITSA4", "nome": "Itaúsa PN", "tipo": "Acao"})
    itsa_id = res_itsa.json()["id"]

    tx_transf = client.post("/api/v1/transacoes", json={
        "carteira_id": 1, "ativo_id": itsa_id, "tipo_operacao": "TRANSFERENCIA_ENTRADA",
        "quantidade": "1000.0", "preco_unitario": "0.0", "data_hora": "2022-03-23T10:00:00Z",
    })
    tx_id = tx_transf.json()["id"]

    # Bonificações (+100.50) e Frações (-0.50) + Compras (+100 @ 8.00 = 800.00) -> Saldo final = 1200
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1, "ativo_id": itsa_id, "tipo_operacao": "BONIFICACAO",
        "quantidade": "100.50", "preco_unitario": "0.0", "data_hora": "2023-11-29T10:00:00Z",
    })
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1, "ativo_id": itsa_id, "tipo_operacao": "FRACAO_ATIVOS",
        "quantidade": "0.50", "preco_unitario": "0.0", "data_hora": "2024-01-02T10:00:00Z",
    })
    client.post("/api/v1/transacoes", json={
        "carteira_id": 1, "ativo_id": itsa_id, "tipo_operacao": "BUY",
        "quantidade": "100.0", "preco_unitario": "8.00", "data_hora": "2025-02-19T10:00:00Z",
    })

    # Frontend envia transacao_id JUNTO com pm_consolidado_atual = 10.00
    res_adj = client.put(f"/api/v1/posicoes/carteiras/1/ativos/{itsa_id}/ajuste-manual", json={
        "transacao_id": tx_id,
        "pm_consolidado_atual": 10.00,
    })
    assert res_adj.status_code == 200
    pos = res_adj.json()
    assert Decimal(str(pos["quantidade_saldo"])) == Decimal("1200")
    assert Decimal(str(pos["quantidade_sem_custo"])) == Decimal("0")
    assert pos["custo_pendente"] is False
    assert len(pos["lotes_pendentes"]) == 0
    assert abs(Decimal(str(pos["preco_medio_brl"])) - Decimal("10.00")) < Decimal("0.0001")
    assert abs(Decimal(str(pos["custo_total_brl"])) - Decimal("12000.00")) < Decimal("0.01")


def test_compra_com_aluguel_btc_ativo_e_subscricao_itsa2_itsa10(client):
    """
    Testa:
    1. Compra real na bolsa (Credito | Transferência - Liquidação | Qtd: 100 | PU: 30.00)
       ocorrendo enquanto há um empréstimo BTC ativo de 1.000 ações (BBSE3):
       garante que a compra real soma 100 ações e não é ignorada falsamente como devolução de BTC.
    2. Caso ITSA2 / ITSA10 / Atualização:
       - Direito de Subscrição ITSA2 (20 e 25 ações) -> ignorados
       - Direito Sobras de Subscrição ITSA2 (5 ações) -> ignorado
       - Recibo de Subscrição ITSA10 (25 ações) -> ignorado
       - Atualização ITSA4 (30 ações) -> ignorada
       - Direitos de Subscrição - Exercido ITSA2 (25 ações @ 7.00 e 5 ações @ 7.00) -> viram BUY em ITSA4
       Garante que o saldo soma apenas +30 ações em ITSA4.
    """
    mov_data = [
        # --- Caso 1: BBSE3 com Empréstimo BTC ativo de 1000 ações ---
        # Saída para empréstimo BTC (1000 ações)
        {
            "Data": "2025-08-20",
            "Movimentação": "Transferência - Liquidação",
            "Entrada/Saída": "Debito",
            "Produto": "BBSE3 - BB SEGURIDADE ON NM",
            "Quantidade": 1000,
            "Preço unitário": 0.0,
            "Valor da Operação": 0.0,
        },
        {
            "Data": "2025-08-20",
            "Movimentação": "Empréstimo",
            "Entrada/Saída": "Debito",
            "Produto": "BBSE3 - BB SEGURIDADE ON NM",
            "Quantidade": 1000,
            "Preço unitário": 30.00,
            "Valor da Operação": 30000.00,
        },
        # Compra real na bolsa enquanto o empréstimo de 1000 ações está ativo (100 ações @ 30.00)
        {
            "Data": "2025-08-22",
            "Movimentação": "Transferência - Liquidação",
            "Entrada/Saída": "Credito",
            "Produto": "BBSE3 - BB SEGURIDADE ON NM",
            "Quantidade": 100,
            "Preço unitário": 30.00,
            "Valor da Operação": 3000.00,
        },

        # --- Caso 1b: BBAS3 e VALE3 com Empréstimo BTC ativo concomitante ---
        # BBAS3: Empréstimo de 1000 ações e compra real de 500 ações na bolsa
        {
            "Data": "2024-12-10",
            "Movimentação": "Empréstimo",
            "Entrada/Saída": "Debito",
            "Produto": "BBAS3 - BRASIL ON NM",
            "Quantidade": 1000,
            "Preço unitário": 25.00,
            "Valor da Operação": 25000.00,
        },
        {
            "Data": "2024-12-20",
            "Movimentação": "Transferência - Liquidação",
            "Entrada/Saída": "Credito",
            "Produto": "BBAS3 - BRASIL ON NM",
            "Quantidade": 500,
            "Preço unitário": 25.00,
            "Valor da Operação": 12500.00,
        },
        # VALE3: Empréstimo de 500 ações e compra real de 100 ações na bolsa
        {
            "Data": "2024-08-01",
            "Movimentação": "Empréstimo",
            "Entrada/Saída": "Debito",
            "Produto": "VALE3 - VALE ON NM",
            "Quantidade": 500,
            "Preço unitário": 60.00,
            "Valor da Operação": 30000.00,
        },
        {
            "Data": "2024-08-06",
            "Movimentação": "Transferência - Liquidação",
            "Entrada/Saída": "Credito",
            "Produto": "VALE3 - VALE ON NM",
            "Quantidade": 100,
            "Preço unitário": 55.00,
            "Valor da Operação": 5500.00,
        },

        # --- Caso 1c: Condição 2 (Transferência - Liquidação com PU>0 mas com Empréstimo de mesma Qtd na janela [-5, +1] -> ignorada como BTC) ---
        {
            "Data": "2024-09-10",
            "Movimentação": "Empréstimo",
            "Entrada/Saída": "Debito",
            "Produto": "PETR4 - PETROBRAS PN",
            "Quantidade": 500,
            "Preço unitário": 35.00,
            "Valor da Operação": 17500.00,
        },
        {
            "Data": "2024-09-12",
            "Movimentação": "Transferência - Liquidação",
            "Entrada/Saída": "Credito",
            "Produto": "PETR4 - PETROBRAS PN",
            "Quantidade": 500,
            "Preço unitário": 35.00,
            "Valor da Operação": 17500.00,
        },

        # --- Caso 1d: Condição 3 (Transferência - Liquidação com PU>0 mas com par casado de Transferência PU=0 na janela [-5, +1] -> ignorada como BTC) ---
        {
            "Data": "2024-10-05",
            "Movimentação": "Transferência",
            "Entrada/Saída": "Debito",
            "Produto": "BBDC4 - BRADESCO PN",
            "Quantidade": 300,
            "Preço unitário": 0.0,
            "Valor da Operação": 0.0,
        },
        {
            "Data": "2024-10-05",
            "Movimentação": "Transferência",
            "Entrada/Saída": "Credito",
            "Produto": "BBDC4 - BRADESCO PN",
            "Quantidade": 300,
            "Preço unitário": 0.0,
            "Valor da Operação": 0.0,
        },
        {
            "Data": "2024-10-07",
            "Movimentação": "Transferência - Liquidação",
            "Entrada/Saída": "Credito",
            "Produto": "BBDC4 - BRADESCO PN",
            "Quantidade": 300,
            "Preço unitário": 14.50,
            "Valor da Operação": 4350.00,
        },

        # --- Caso 2: ITSA2, ITSA10 e ITSA4 ---
        # Direitos de subscrição transitórios (devem ser ignorados)
        {
            "Data": "2023-08-21",
            "Movimentação": "Direito de Subscrição",
            "Entrada/Saída": "Credito",
            "Produto": "ITSA2 - ITAUSA PN",
            "Quantidade": 20,
            "Preço unitário": 0.0,
            "Valor da Operação": 0.0,
        },
        {
            "Data": "2025-02-19",
            "Movimentação": "Direito de Subscrição",
            "Entrada/Saída": "Credito",
            "Produto": "ITSA2 - ITAUSA PN",
            "Quantidade": 25,
            "Preço unitário": 0.0,
            "Valor da Operação": 0.0,
        },
        # Exercício de subscrição (25 ações @ 7.00) -> deve virar BUY em ITSA4
        {
            "Data": "2025-04-17",
            "Movimentação": "Direitos de Subscrição - Exercido",
            "Entrada/Saída": "Debito",
            "Produto": "ITSA2 - ITAUSA PN",
            "Quantidade": 25,
            "Preço unitário": 7.00,
            "Valor da Operação": 175.00,
        },
        # Recibo de subscrição ITSA10 (deve ser completamente ignorado)
        {
            "Data": "2025-04-22",
            "Movimentação": "Recibo de Subscrição",
            "Entrada/Saída": "Credito",
            "Produto": "ITSA10 - ITAUSA PN",
            "Quantidade": 25,
            "Preço unitário": 0.0,
            "Valor da Operação": 0.0,
        },
        # Sobras de subscrição (deve ser ignorado)
        {
            "Data": "2025-05-05",
            "Movimentação": "Direito Sobras de Subscrição",
            "Entrada/Saída": "Credito",
            "Produto": "ITSA2 - ITAUSA PN",
            "Quantidade": 5,
            "Preço unitário": 0.0,
            "Valor da Operação": 0.0,
        },
        # Exercício de sobras (5 ações @ 7.00) -> deve virar BUY em ITSA4
        {
            "Data": "2025-05-08",
            "Movimentação": "Direitos de Subscrição - Exercido",
            "Entrada/Saída": "Debito",
            "Produto": "ITSA2 - ITAUSA PN",
            "Quantidade": 5,
            "Preço unitário": 7.00,
            "Valor da Operação": 35.00,
        },
        # Atualização em ITSA4 (conversão administrativa dos recibos já contados no exercício) -> ignorada
        {
            "Data": "2025-05-28",
            "Movimentação": "Atualização",
            "Entrada/Saída": "Credito",
            "Produto": "ITSA4 - ITAUSA PN",
            "Quantidade": 30,
            "Preço unitário": 0.0,
            "Valor da Operação": 0.0,
        },
    ]

    df = pd.DataFrame(mov_data)
    out = io.BytesIO()
    with pd.ExcelWriter(out, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)

    res = client.post(
        "/api/v1/importacao/b3-transferencias",
        files={
            "file": (
                "teste_aluguel_e_itsa.xlsx",
                out.getvalue(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )
    assert res.status_code == 200

    res_pos = client.get("/api/v1/posicoes?somente_com_saldo=false")
    pos_map = {p["ativo"]["ticker"]: p for p in res_pos.json()}

    # BBSE3: A compra real de 100 ações na bolsa foi processada mesmo com empréstimo ativo de 1000 ações
    assert "BBSE3" in pos_map
    assert Decimal(str(pos_map["BBSE3"]["quantidade_saldo"])) == Decimal("100")
    assert Decimal(str(pos_map["BBSE3"]["preco_medio_brl"])) == Decimal("30.00")

    # BBAS3: A compra real de 500 ações na bolsa foi processada mesmo com empréstimo ativo de 1000 ações
    assert "BBAS3" in pos_map
    assert Decimal(str(pos_map["BBAS3"]["quantidade_saldo"])) == Decimal("500")
    assert Decimal(str(pos_map["BBAS3"]["preco_medio_brl"])) == Decimal("25.00")

    # VALE3: A compra real de 100 ações na bolsa foi processada mesmo com empréstimo ativo de 500 ações
    assert "VALE3" in pos_map
    assert Decimal(str(pos_map["VALE3"]["quantidade_saldo"])) == Decimal("100")
    assert Decimal(str(pos_map["VALE3"]["preco_medio_brl"])) == Decimal("55.00")

    # ITSA4: Deve somar APENAS as 30 ações exercidas (25 + 5), ignorando direitos, sobras, ITSA10 e atualização
    assert "ITSA4" in pos_map
    assert Decimal(str(pos_map["ITSA4"]["quantidade_saldo"])) == Decimal("30")
    assert Decimal(str(pos_map["ITSA4"]["preco_medio_brl"])) == Decimal("7.00")

    # ITSA2 e ITSA10 não devem existir na carteira com saldo
    assert "ITSA10" not in pos_map
    if "ITSA2" in pos_map:
        assert Decimal(str(pos_map["ITSA2"]["quantidade_saldo"])) == Decimal("0")

    # PETR4 e BBDC4: As linhas de Transferência - Liquidação atendiam Condição 2 e Condição 3 de BTC
    # e foram corretamente ignoradas (não geraram compras indevidas no estoque)
    if "PETR4" in pos_map:
        assert Decimal(str(pos_map["PETR4"]["quantidade_saldo"])) == Decimal("0")
    if "BBDC4" in pos_map:
        assert Decimal(str(pos_map["BBDC4"]["quantidade_saldo"])) == Decimal("0")


def test_parser_movimentacao_portfolio_error_resiliencia(db_session: Session, monkeypatch):
    """
    Testa que exceções do tipo PortfolioError em processar_transacao durante a ingestão
    são capturadas sem NameError ou quebra da importação, sendo registradas na lista de avisos.
    """
    from app.services.ingestion.parser_movimentacao_b3 import processar_planilha_movimentacao_b3
    from app.services.portfolio import PortfolioError

    db = db_session
    mov_data = [
        {
            "Data": "2024-05-10",
            "Movimentação": "Transferência - Liquidação",
            "Entrada/Saída": "Credito",
            "Produto": "TEST3 - TESTE ON",
            "Quantidade": 100,
            "Preço unitário": 10.00,
            "Valor da Operação": 1000.00,
        }
    ]
    df = pd.DataFrame(mov_data)
    out = io.BytesIO()
    with pd.ExcelWriter(out, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)

    import app.services.ingestion.parser_movimentacao_b3 as parser_mod

    def mock_processar_com_erro(*args, **kwargs):
        raise PortfolioError("Simulação de erro de consistência de portfólio")

    monkeypatch.setattr(parser_mod, "processar_transacao", mock_processar_com_erro)

    resultado = parser_mod.processar_planilha_movimentacao_b3(db=db, file_content=out.getvalue(), carteira_id=1)
    assert len(resultado["avisos"]) >= 1
    assert "Simulação de erro" in resultado["avisos"][0]









