import io
from decimal import Decimal
import pandas as pd
import pytest
from sqlalchemy.orm import Session

from app.models.ativo import Ativo
from app.models.transacao import Transacao
from app.models.posicao import PosicaoConsolidada
from app.models.enums import TipoAtivo, TipoOperacao, ProdutoRendaFixa, Indexador
from app.services.ingestion.classificador_renda_fixa import classificar_renda_fixa
from app.services.ingestion.parser_b3 import processar_planilha_b3
from app.services.ingestion.parser_movimentacao_b3 import processar_planilha_movimentacao_b3


def test_classificador_renda_fixa_conversao_e_vencimento():
    # 1. Reconhecimento por ano de conversão comercial
    info1 = classificar_renda_fixa("Tesouro RendA+ Aposentadoria Extra 2065", ano_e_vencimento=False)
    assert info1 is not None
    assert info1.ticker == "TD-RENDA+-2065"
    assert info1.ano_conversao == 2065
    assert info1.ano_vencimento == 2084
    assert info1.num_parcelas == 240
    assert info1.produto == ProdutoRendaFixa.TESOURO_RENDA_MAIS
    assert info1.indexador == Indexador.IPCA

    # 2. Reconhecimento por ano de vencimento com flag ano_e_vencimento=True
    info2 = classificar_renda_fixa("Tesouro RendA+ Aposentadoria Extra 2084", ano_e_vencimento=True)
    assert info2 is not None
    assert info2.ticker == "TD-RENDA+-2065"
    assert info2.ano_conversao == 2065
    assert info2.ano_vencimento == 2084
    assert info2.num_parcelas == 240

    # 3. Reconhecimento inteligente quando ano > 2065 mesmo sem flag explícita
    info3 = classificar_renda_fixa("Tesouro RendA+ Aposentadoria Extra 2084", ano_e_vencimento=False)
    assert info3 is not None
    assert info3.ticker == "TD-RENDA+-2065"
    assert info3.ano_conversao == 2065
    assert info3.ano_vencimento == 2084

    # 4. Outros produtos
    info_ipca = classificar_renda_fixa("Tesouro IPCA+ com Juros Semestrais 2040")
    assert info_ipca is not None
    assert info_ipca.ticker == "TD-IPCA+J-2040"
    assert info_ipca.produto == ProdutoRendaFixa.TESOURO_IPCA_JUROS

    info_cdb = classificar_renda_fixa("CDB BANCO INTER 20261231")
    assert info_cdb is not None
    assert info_cdb.produto == ProdutoRendaFixa.CDB
    assert info_cdb.indexador == Indexador.CDI
    assert "CDB" in info_cdb.ticker


def test_ingestao_negociacao_rf_cria_ativo_e_detalhes(db_session: Session):
    db = db_session
    data = [
        {
            "Data do Negócio": "2024-03-01",
            "Tipo de Movimentação": "Compra",
            "Código de Negociação": "Tesouro RendA+ Aposentadoria Extra 2065",
            "Quantidade": 5,
            "Preço": 240.50,
            "Valor da Operação": 1202.50,
            "Taxas": 1.20,
        }
    ]
    df = pd.DataFrame(data)
    excel_buffer = io.BytesIO()
    with pd.ExcelWriter(excel_buffer, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)
    excel_bytes = excel_buffer.getvalue()

    txs, pendencias = processar_planilha_b3(db=db, file_content=excel_bytes, carteira_id=1)
    assert len(txs) == 1
    assert len(pendencias) == 0

    ativo = db.query(Ativo).filter(Ativo.ticker == "TD-RENDA+-2065").first()
    assert ativo is not None
    assert ativo.tipo == TipoAtivo.RendaFixa
    assert ativo.detalhes_rf is not None
    assert ativo.detalhes_rf.produto == ProdutoRendaFixa.TESOURO_RENDA_MAIS
    assert ativo.detalhes_rf.ano_conversao == 2065
    assert ativo.detalhes_rf.num_parcelas == 240
    assert ativo.detalhes_rf.dia_pagamento == 15
    assert ativo.detalhes_rf.indexador == Indexador.IPCA
    assert ativo.detalhes_rf.cobra_custodia_b3 is True


def test_ingestao_movimentacao_amortizacao_rf_e_nao_rf(db_session: Session):
    db = db_session
    # Prepara ativo PETR4 e TD-RENDA+-2065
    petr4 = Ativo(ticker="PETR4", nome="Petrobras PN", tipo=TipoAtivo.Acao)
    rf = Ativo(ticker="TD-RENDA+-2065", nome="Tesouro RendA+ Aposentadoria Extra 2065", tipo=TipoAtivo.RendaFixa)
    db.add_all([petr4, rf])
    db.commit()

    data = [
        # Amortização de RF -> deve gerar transação AMORTIZACAO
        {
            "Data": "2024-04-15",
            "Movimentação": "Amortização de Renda Fixa",
            "Produto": "Tesouro RendA+ Aposentadoria Extra 2065",
            "Quantidade": 5,
            "Preço unitário": 10.0,
            "Valor da Operação": 50.0,
        },
        # Amortização de Ação -> deve ser descartada (comportamento legado não-RF)
        {
            "Data": "2024-04-16",
            "Movimentação": "Amortização",
            "Produto": "PETR4",
            "Quantidade": 100,
            "Preço unitário": 1.5,
            "Valor da Operação": 150.0,
        },
    ]
    df = pd.DataFrame(data)
    excel_buffer = io.BytesIO()
    with pd.ExcelWriter(excel_buffer, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)
    excel_bytes = excel_buffer.getvalue()

    resultado = processar_planilha_movimentacao_b3(db=db, file_content=excel_bytes, carteira_id=1)
    txs = resultado["transacoes"]

    # Apenas a amortização de RF deve gerar transação
    assert len(txs) == 1
    assert txs[0].tipo_operacao == TipoOperacao.AMORTIZACAO
    assert txs[0].ativo_id == rf.id
    assert txs[0].quantidade == Decimal("5")
    assert txs[0].preco_unitario == Decimal("10")


def test_classificador_variacoes_e_bancarios():
    from datetime import date

    # Tesouro Direto com prefixo completo
    td1 = classificar_renda_fixa("Tesouro Direto RendA+ 2065")
    assert td1 is not None
    assert td1.ticker == "TD-RENDA+-2065"

    td2 = classificar_renda_fixa("Tesouro IPCA 2035")
    assert td2 is not None
    assert td2.ticker == "TD-IPCA+-2035"

    td3 = classificar_renda_fixa("TD RENDA+ 2065")
    assert td3 is not None
    assert td3.ticker == "TD-RENDA+-2065"

    # Banco C6 (alfanumérico com dígito)
    c6 = classificar_renda_fixa("CDB BANCO C6 110% CDI 15/12/2027")
    assert c6 is not None
    assert c6.ticker == "CDB-C6-20271215"
    assert c6.emissor == "C6"
    assert c6.data_vencimento == date(2027, 12, 15)

    # Banco do Brasil (sem preposição DO no ticker)
    bb = classificar_renda_fixa("LCI BANCO DO BRASIL 2025")
    assert bb is not None
    assert bb.ticker == "LCI-BRASIL-2025"
    assert bb.emissor == "BRASIL"


def test_ingestao_negociacao_cdb_com_detalhes_e_leitura_schema(db_session: Session):
    from datetime import date
    from app.schemas.renda_fixa import AtivoRendaFixaRead

    db = db_session
    data = [
        {
            "Data do Negócio": "2024-03-01",
            "Tipo de Movimentação": "Compra",
            "Código de Negociação": "CDB BANCO INTER 20261231",
            "Quantidade": 10,
            "Preço": 1000.00,
            "Valor da Operação": 10000.00,
            "Taxas": 0.0,
        }
    ]
    df = pd.DataFrame(data)
    excel_buffer = io.BytesIO()
    with pd.ExcelWriter(excel_buffer, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)

    txs, pendencias = processar_planilha_b3(db=db, file_content=excel_buffer.getvalue(), carteira_id=1)
    assert len(txs) == 1
    assert len(pendencias) == 0

    ativo = db.query(Ativo).filter(Ativo.ticker == "CDB-INTER-20261231").first()
    assert ativo is not None
    assert ativo.tipo == TipoAtivo.RendaFixa
    assert ativo.detalhes_rf is not None
    assert ativo.detalhes_rf.produto == ProdutoRendaFixa.CDB
    assert ativo.detalhes_rf.indexador == Indexador.CDI
    assert ativo.detalhes_rf.percentual_indexador is None
    assert ativo.detalhes_rf.emissor == "INTER"
    assert ativo.detalhes_rf.data_vencimento == date(2026, 12, 31)

    # O teste crítico: leitura do schema Pydantic NÃO pode falhar com percentual_indexador=None
    read_dto = AtivoRendaFixaRead.model_validate(ativo)
    assert read_dto.ticker == "CDB-INTER-20261231"
    assert read_dto.detalhes_rf is not None
    assert read_dto.detalhes_rf.percentual_indexador is None
    assert read_dto.detalhes_rf.isento_ir is False
    assert read_dto.detalhes_rf.cobra_custodia_b3 is False


def test_ingestao_movimentacao_cdb_vencimento_pu_zero_sem_falso_prejuizo(db_session: Session):
    """
    Caso 1: Vencimento de CDB com PU=0 e Valor=0 da B3 (ex: CDB-CDBTEST01).
    Deve dar baixa pelo Preço Médio de aquisição (1000.00), zerando a posição
    sem gerar falso prejuízo de -10.000,00 (lucro_realizado == 0.00).
    """
    db = db_session
    data = [
        {
            "Data": "2023-01-10",
            "Movimentação": "Aplicação",
            "Produto": "CDB-CDBTEST01",
            "Quantidade": 10,
            "Preço unitário": 1000.0,
            "Valor da Operação": 10000.0,
            "Entrada/Saída": "Credito",
        },
        {
            "Data": "2025-01-10",
            "Movimentação": "Vencimento",
            "Produto": "CDB-CDBTEST01",
            "Quantidade": 10,
            "Preço unitário": 0.0,
            "Valor da Operação": 0.0,
            "Entrada/Saída": "Debito",
        },
    ]
    df = pd.DataFrame(data)
    excel_buffer = io.BytesIO()
    with pd.ExcelWriter(excel_buffer, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)

    resultado = processar_planilha_movimentacao_b3(db=db, file_content=excel_buffer.getvalue(), carteira_id=1)
    txs = resultado["transacoes"]

    assert len(txs) == 2
    tx_buy, tx_sell = txs[0], txs[1]
    assert tx_buy.tipo_operacao == TipoOperacao.BUY
    assert tx_buy.quantidade == Decimal("10")
    assert tx_buy.preco_unitario == Decimal("1000.00000000")

    assert tx_sell.tipo_operacao == TipoOperacao.SELL
    assert tx_sell.quantidade == Decimal("10")
    # O PU da venda foi corrigido para o PM de aquisição (1000.00) em vez de 0.0
    assert tx_sell.preco_unitario == Decimal("1000.00000000")

    ativo = db.query(Ativo).filter(Ativo.ticker == "CDB-CDBTEST01").first()
    assert ativo is not None
    pos = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo.id).first()
    assert pos is not None
    assert pos.quantidade_saldo == Decimal("0")
    assert pos.lucro_realizado_brl == Decimal("0.00")
    assert pos.valor_total_venda_brl == Decimal("10000.00")
    assert pos.custo_historico_brl == Decimal("10000.00")


def test_ingestao_movimentacao_cdb_resgate_precisao_pu_btg(db_session: Session):
    """
    Caso 2: Resgate de CDB com PU truncado em 0.01 na planilha (CDBTEST02).
    Quantidade = 500.000, Valor = 5.060,00.
    O PU calculado com 8 casas decimais apura exatamente R$ 60,00 de lucro realizado.
    """
    db = db_session
    data = [
        {
            "Data": "2023-01-20",
            "Movimentação": "Aplicação",
            "Produto": "CDB - CDBTEST02",
            "Quantidade": 500000,
            "Preço unitário": 0.01,
            "Valor da Operação": 5000.0,
            "Entrada/Saída": "Credito",
        },
        {
            "Data": "2026-01-23",
            "Movimentação": "Resgate Antecipado",
            "Produto": "CDB - CDBTEST02",
            "Quantidade": 500000,
            "Preço unitário": 0.01,  # truncado pela B3
            "Valor da Operação": 5060.00,
            "Entrada/Saída": "Debito",
        },
    ]
    df = pd.DataFrame(data)
    excel_buffer = io.BytesIO()
    with pd.ExcelWriter(excel_buffer, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)

    resultado = processar_planilha_movimentacao_b3(db=db, file_content=excel_buffer.getvalue(), carteira_id=1)
    txs = resultado["transacoes"]
    assert len(txs) == 2
    tx_buy, tx_sell = txs[0], txs[1]

    assert tx_buy.tipo_operacao == TipoOperacao.BUY
    assert tx_buy.quantidade == Decimal("500000")
    assert tx_buy.preco_unitario == Decimal("0.01000000")

    assert tx_sell.tipo_operacao == TipoOperacao.SELL
    assert tx_sell.quantidade == Decimal("500000")
    # PU calculado com 8 casas decimais a partir de 5060.00 / 500000
    assert tx_sell.preco_unitario == Decimal("0.01012000")

    ativo = db.query(Ativo).filter(Ativo.ticker == "CDB-CDBTEST02").first()
    assert ativo is not None
    pos = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo.id).first()
    assert pos is not None
    assert pos.quantidade_saldo == Decimal("0")
    assert pos.lucro_realizado_brl == Decimal("60.00")
    assert pos.valor_total_venda_brl == Decimal("5060.00")
    assert pos.custo_historico_brl == Decimal("5000.00")


def test_ingestao_movimentacao_cdb_compra_venda_xp(db_session: Session):
    """
    Caso 3: Linhas de CDB com Movimentação == 'COMPRA / VENDA'.
    Devem ser processadas tanto no Credito (BUY) quanto no Debito (SELL).
    """
    db = db_session
    data = [
        {
            "Data": "2024-05-10",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB BANCO XP 20261231",
            "Quantidade": 10,
            "Preço unitário": 1000.0,
            "Valor da Operação": 10000.0,
            "Entrada/Saída": "Credito",
        },
        {
            "Data": "2024-11-10",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB BANCO XP 20261231",
            "Quantidade": 10,
            "Preço unitário": 1050.0,
            "Valor da Operação": 10500.0,
            "Entrada/Saída": "Debito",
        },
    ]
    df = pd.DataFrame(data)
    excel_buffer = io.BytesIO()
    with pd.ExcelWriter(excel_buffer, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)

    resultado = processar_planilha_movimentacao_b3(db=db, file_content=excel_buffer.getvalue(), carteira_id=1)
    txs = resultado["transacoes"]
    assert len(txs) == 2
    assert txs[0].tipo_operacao == TipoOperacao.BUY
    assert txs[0].quantidade == Decimal("10")
    assert txs[0].preco_unitario == Decimal("1000.00000000")

    assert txs[1].tipo_operacao == TipoOperacao.SELL
    assert txs[1].quantidade == Decimal("10")
    assert txs[1].preco_unitario == Decimal("1050.00000000")

    ativo = db.query(Ativo).filter(Ativo.ticker == "CDB-XP-20261231").first()
    assert ativo is not None
    pos = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo.id).first()
    assert pos is not None
    assert pos.quantidade_saldo == Decimal("0")
    assert pos.lucro_realizado_brl == Decimal("500.00")
    assert pos.valor_total_venda_brl == Decimal("10500.00")
    assert pos.custo_historico_brl == Decimal("10000.00")


def test_ingestao_movimentacao_cdb_multi_lotes_vencimento_e_reimportacao_idempotente(db_session: Session):
    """
    Caso 4 (Break Test): CDB com múltiplos aportes de PMs heterogêneos e reimportação subsequente.
    Passo 1: Compra 10 @ 1000 + Compra 10 @ 1200 -> PM = 1100.
    Vencimento de 20 @ PU=0 -> Baixa pelo PM de 1100 (Custo 22000, Venda 22000, Lucro 0).
    Passo 2: Reimportar a MESMA planilha (idempotência).
    Nenhuma transação duplicada deve ser criada, nenhum aviso de saldo insuficiente deve ocorrer.
    """
    db = db_session
    data = [
        {
            "Data": "2023-01-10",
            "Movimentação": "Aplicação",
            "Produto": "CDB BANCO HETERO 2025",
            "Quantidade": 10,
            "Preço unitário": 1000.0,
            "Valor da Operação": 10000.0,
            "Entrada/Saída": "Credito",
        },
        {
            "Data": "2023-06-10",
            "Movimentação": "Aplicação",
            "Produto": "CDB BANCO HETERO 2025",
            "Quantidade": 10,
            "Preço unitário": 1200.0,
            "Valor da Operação": 12000.0,
            "Entrada/Saída": "Credito",
        },
        {
            "Data": "2025-01-10",
            "Movimentação": "Vencimento",
            "Produto": "CDB BANCO HETERO 2025",
            "Quantidade": 20,
            "Preço unitário": 0.0,
            "Valor da Operação": 0.0,
            "Entrada/Saída": "Debito",
        },
    ]
    df = pd.DataFrame(data)
    excel_buffer = io.BytesIO()
    with pd.ExcelWriter(excel_buffer, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)
    file_bytes = excel_buffer.getvalue()

    # Pass 1: Primeira importação
    res1 = processar_planilha_movimentacao_b3(db=db, file_content=file_bytes, carteira_id=1)
    assert len(res1["transacoes"]) == 3
    assert len(res1["avisos"]) == 1  # Apenas o aviso informando que a baixa foi pelo PM

    ativo = db.query(Ativo).filter(Ativo.ticker == "CDB-HETERO-2025").first()
    assert ativo is not None
    pos = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo.id).first()
    assert pos.quantidade_saldo == Decimal("0")
    assert pos.custo_historico_brl == Decimal("22000.00")
    assert pos.valor_total_venda_brl == Decimal("22000.00")
    assert pos.lucro_realizado_brl == Decimal("0.00")

    # Pass 2: Reimportação idêntica da mesma planilha
    res2 = processar_planilha_movimentacao_b3(db=db, file_content=file_bytes, carteira_id=1)
    assert len(res2["transacoes"]) == 0, "Nenhuma transação nova deveria ser criada na reimportação"
    assert not any("Saldo insuficiente" in a for a in res2["avisos"]), f"Erro de saldo na reimportação: {res2['avisos']}"


def test_ingestao_movimentacao_cdb_reimportacao_atualiza_pu_truncado_btg(db_session: Session):
    """
    Caso 5 (Break Test): O banco já possui transação antiga de SELL com PU truncado em 0.01 (da versão anterior).
    Ao reimportar a planilha com o novo parser, o sistema deve detectar a transação existente,
    atualizar o preco_unitario para 0.01012000 e recalcular a carteira apurando os R$ 60,00 de lucro.
    """
    db = db_session
    from app.services.portfolio import obter_ou_criar_carteira_padrao, recalcular_posicoes_carteira
    obter_ou_criar_carteira_padrao(db, carteira_id=1)

    ativo = Ativo(ticker="CDB-CDBUPG01", nome="CDB CDBUPG01", tipo=TipoAtivo.RendaFixa)
    db.add(ativo)
    db.flush()

    from datetime import datetime, timezone

    tx_buy = Transacao(
        carteira_id=1,
        ativo_id=ativo.id,
        data_hora=datetime(2023, 1, 20, 10, 0, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.BUY,
        quantidade=Decimal("500000"),
        preco_unitario=Decimal("0.01"),
        taxas=Decimal("0.0"),
        moeda="BRL",
    )
    # Transação antiga gravada com PU truncado em 0.01
    tx_sell_antiga = Transacao(
        carteira_id=1,
        ativo_id=ativo.id,
        data_hora=datetime(2026, 1, 23, 10, 0, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.SELL,
        quantidade=Decimal("500000"),
        preco_unitario=Decimal("0.01"),
        taxas=Decimal("0.0"),
        moeda="BRL",
    )
    db.add_all([tx_buy, tx_sell_antiga])
    db.flush()
    recalcular_posicoes_carteira(db=db, carteira_id=1)

    pos_ant = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo.id).first()
    assert pos_ant.lucro_realizado_brl == Decimal("0.00")  # Sem a precisão, lucro era 0

    # Agora importa a planilha com o novo parser
    data = [
        {
            "Data": "2026-01-23",
            "Movimentação": "Resgate Antecipado",
            "Produto": "CDB - CDBUPG01",
            "Quantidade": 500000,
            "Preço unitário": 0.01,  # truncado pela B3
            "Valor da Operação": 5060.00,
            "Entrada/Saída": "Debito",
        },
    ]
    df = pd.DataFrame(data)
    excel_buffer = io.BytesIO()
    with pd.ExcelWriter(excel_buffer, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)

    res = processar_planilha_movimentacao_b3(db=db, file_content=excel_buffer.getvalue(), carteira_id=1)
    # Não deve tentar criar transação duplicada (que falharia com saldo insuficiente)
    assert len(res["transacoes"]) == 0
    assert not any("Saldo insuficiente" in a for a in res["avisos"])

    # Deve ter atualizado o PU da transação antiga
    db.refresh(tx_sell_antiga)
    assert tx_sell_antiga.preco_unitario == Decimal("0.01012000")

    # E recalculado a posição consolidada para R$ 60,00 de lucro
    pos_pos = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo.id).first()
    assert pos_pos.lucro_realizado_brl == Decimal("60.00")


def test_ingestao_movimentacao_cdb_compra_venda_sem_espacos_xp(db_session: Session):
    """
    Caso 6 (Break Test): Linhas com 'COMPRA/VENDA' sem espaços antes/depois da barra.
    Não pode cair na cláusula 'venda' e gerar SELL para Credito.
    """
    db = db_session
    data = [
        {
            "Data": "2024-05-10",
            "Movimentação": "COMPRA/VENDA",  # sem espaços
            "Produto": "CDB BANCO XP 20261231",
            "Quantidade": 10,
            "Preço unitário": 1000.0,
            "Valor da Operação": 10000.0,
            "Entrada/Saída": "Credito",
        },
        {
            "Data": "2024-11-10",
            "Movimentação": "COMPRA/VENDA",  # sem espaços
            "Produto": "CDB BANCO XP 20261231",
            "Quantidade": 10,
            "Preço unitário": 1050.0,
            "Valor da Operação": 10500.0,
            "Entrada/Saída": "Debito",
        },
    ]
    df = pd.DataFrame(data)
    excel_buffer = io.BytesIO()
    with pd.ExcelWriter(excel_buffer, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)

    resultado = processar_planilha_movimentacao_b3(db=db, file_content=excel_buffer.getvalue(), carteira_id=1)
    txs = resultado["transacoes"]
    assert len(txs) == 2
    assert txs[0].tipo_operacao == TipoOperacao.BUY, f"Esperado BUY para Credito, obteve {txs[0].tipo_operacao}"
    assert txs[1].tipo_operacao == TipoOperacao.SELL, f"Esperado SELL para Debito, obteve {txs[1].tipo_operacao}"


def test_ingestao_movimentacao_cdb_resgates_parciais_e_vencimento(db_session: Session):
    """
    Caso 7: CDBTEST03: compra de 100 (R$ 100.000,00), 4 resgates Debito | COMPRA / VENDA
    somando 80 (R$ 81.600,00) e VENCIMENTO de 20 (Val: 0) -> saldo final 0, lucro realizado +R$ 1.600,00.
    """
    db = db_session
    data = [
        {
            "Data": "2024-12-06",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDBTEST03",
            "Quantidade": 100,
            "Preço unitário": 1000.00,
            "Valor da Operação": 100000.00,
            "Entrada/Saída": "Credito",
        },
        {
            "Data": "2025-02-10",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDBTEST03",
            "Quantidade": 20,
            "Preço unitário": 1020.00,
            "Valor da Operação": 20400.00,
            "Entrada/Saída": "Debito",
        },
        {
            "Data": "2025-04-10",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDBTEST03",
            "Quantidade": 20,
            "Preço unitário": 1020.00,
            "Valor da Operação": 20400.00,
            "Entrada/Saída": "Debito",
        },
        {
            "Data": "2025-06-10",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDBTEST03",
            "Quantidade": 20,
            "Preço unitário": 1020.00,
            "Valor da Operação": 20400.00,
            "Entrada/Saída": "Debito",
        },
        {
            "Data": "2025-08-10",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDBTEST03",
            "Quantidade": 20,
            "Preço unitário": 1020.00,
            "Valor da Operação": 20400.00,
            "Entrada/Saída": "Debito",
        },
        {
            "Data": "2025-12-06",
            "Movimentação": "Vencimento",
            "Produto": "CDB - CDBTEST03",
            "Quantidade": 20,
            "Preço unitário": 0.0,
            "Valor da Operação": 0.0,
            "Entrada/Saída": "Debito",
        },
    ]
    df = pd.DataFrame(data)
    excel_buffer = io.BytesIO()
    with pd.ExcelWriter(excel_buffer, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)

    res = processar_planilha_movimentacao_b3(db=db, file_content=excel_buffer.getvalue(), carteira_id=1)
    txs = res["transacoes"]
    assert len(txs) == 6

    ativo = db.query(Ativo).filter(Ativo.ticker == "CDB-CDBTEST03").first()
    assert ativo is not None
    pos = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo.id).first()
    assert pos is not None
    assert pos.quantidade_saldo == Decimal("0")
    assert pos.lucro_realizado_brl == Decimal("1600.00")


def test_ingestao_movimentacao_cdb_deduplicacao_e_vencimento(db_session: Session):
    """
    Caso 8: CDBTEST04 com linhas duplicadas no mesmo dia e vencimento final.
    Resultado esperado: linhas duplicadas descartadas, saldo final 0, lucro realizado apurado.
    """
    db = db_session
    data = [
        {
            "Data": "2023-10-20",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDBTEST04",
            "Quantidade": 1000,
            "Preço unitário": 1.00,
            "Valor da Operação": 1000.00,
            "Entrada/Saída": "Credito",
        },
        {
            "Data": "2024-09-10",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDBTEST04",
            "Quantidade": 1000,
            "Preço unitário": 1.00,
            "Valor da Operação": 1000.00,
            "Entrada/Saída": "Credito",
        },
        # Resgates 23/09/2024 com linhas duplicadas idênticas da B3 (100.0 duas vezes e 500.0 duas vezes)
        {
            "Data": "2024-09-23",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDBTEST04",
            "Quantidade": 100.0,
            "Preço unitário": 1.10,
            "Valor da Operação": 110.00,
            "Entrada/Saída": "Debito",
        },
        {
            "Data": "2024-09-23",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDBTEST04",
            "Quantidade": 100.0,
            "Preço unitário": 1.10,
            "Valor da Operação": 110.00,
            "Entrada/Saída": "Debito",
        },
        {
            "Data": "2024-09-23",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDBTEST04",
            "Quantidade": 500.0,
            "Preço unitário": 1.10,
            "Valor da Operação": 550.00,
            "Entrada/Saída": "Debito",
        },
        {
            "Data": "2024-09-23",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDBTEST04",
            "Quantidade": 500.0,
            "Preço unitário": 1.10,
            "Valor da Operação": 550.00,
            "Entrada/Saída": "Debito",
        },
        # Resgate 11/10/2024 com linha duplicada idêntica da B3 (400.0 duas vezes)
        {
            "Data": "2024-10-11",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDBTEST04",
            "Quantidade": 400.0,
            "Preço unitário": 1.10,
            "Valor da Operação": 440.00,
            "Entrada/Saída": "Debito",
        },
        {
            "Data": "2024-10-11",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDBTEST04",
            "Quantidade": 400.0,
            "Preço unitário": 1.10,
            "Valor da Operação": 440.00,
            "Entrada/Saída": "Debito",
        },
        # Vencimento final de 1000 unidades
        {
            "Data": "2024-11-07",
            "Movimentação": "Vencimento",
            "Produto": "CDB - CDBTEST04",
            "Quantidade": 1000,
            "Preço unitário": 0.0,
            "Valor da Operação": 0.0,
            "Entrada/Saída": "Debito",
        },
    ]
    df = pd.DataFrame(data)
    excel_buffer = io.BytesIO()
    with pd.ExcelWriter(excel_buffer, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)

    res = processar_planilha_movimentacao_b3(db=db, file_content=excel_buffer.getvalue(), carteira_id=1)
    txs = res["transacoes"]
    # 9 linhas enviadas, 3 duplicatas no mesmo dia descartadas -> 6 transações
    assert len(txs) == 6

    ativo = db.query(Ativo).filter(Ativo.ticker == "CDB-CDBTEST04").first()
    assert ativo is not None
    pos = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo.id).first()
    assert pos is not None
    assert pos.quantidade_saldo == Decimal("0")
    assert pos.lucro_realizado_brl == Decimal("100.00")


def test_cdbs_matured_saldo_zero(db_session: Session):
    """
    Caso 9: CDBs CDBSERIEA, CDBSERIEB, CDBSERIEC que venceram.
    Verifica se Debito | COMPRA / VENDA e Vencimento encerram com saldo 0 sem falso prejuízo.
    """
    db = db_session
    data = [
        {"Data": "2023-09-19", "Movimentação": "COMPRA / VENDA", "Produto": "CDB - CDBSERIEA", "Quantidade": 1000, "Preço unitário": 1.00, "Valor da Operação": 1000.00, "Entrada/Saída": "Credito"},
        {"Data": "2024-09-19", "Movimentação": "COMPRA / VENDA", "Produto": "CDB - CDBSERIEA", "Quantidade": 1000, "Preço unitário": 1.00, "Valor da Operação": 1000.00, "Entrada/Saída": "Debito"},
        {"Data": "2024-01-05", "Movimentação": "COMPRA / VENDA", "Produto": "CDB - CDBSERIEB", "Quantidade": 500, "Preço unitário": 2.00, "Valor da Operação": 1000.00, "Entrada/Saída": "Credito"},
        {"Data": "2025-01-05", "Movimentação": "COMPRA / VENDA", "Produto": "CDB - CDBSERIEB", "Quantidade": 500, "Preço unitário": 2.00, "Valor da Operação": 1000.00, "Entrada/Saída": "Debito"},
        {"Data": "2024-06-21", "Movimentação": "COMPRA / VENDA", "Produto": "CDB - CDBSERIEC", "Quantidade": 10, "Preço unitário": 1000.00, "Valor da Operação": 10000.00, "Entrada/Saída": "Credito"},
        {"Data": "2025-06-21", "Movimentação": "COMPRA / VENDA", "Produto": "CDB - CDBSERIEC", "Quantidade": 10, "Preço unitário": 1000.00, "Valor da Operação": 10000.00, "Entrada/Saída": "Debito"},
    ]
    df = pd.DataFrame(data)
    excel_buffer = io.BytesIO()
    with pd.ExcelWriter(excel_buffer, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)

    res = processar_planilha_movimentacao_b3(db=db, file_content=excel_buffer.getvalue(), carteira_id=1)
    assert len(res["transacoes"]) == 6

    for ticker in ["CDB-CDBSERIEA", "CDB-CDBSERIEB", "CDB-CDBSERIEC"]:
        ativo = db.query(Ativo).filter(Ativo.ticker == ticker).first()
        assert ativo is not None
        pos = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo.id).first()
        assert pos is not None
        assert pos.quantidade_saldo == Decimal("0")
        assert pos.lucro_realizado_brl == Decimal("0.00")


@pytest.mark.anyio
async def test_cdb_ativos_curva_cdi(db_session: Session):
    """
    Caso 10: CDBATIVO01 (10.000.000 un.) e CDBATIVO02 (2.000.000 un.)
    permanecendo como os únicos 2 CDBs ativos em custódia com cotação pela CURVA_CDI.
    """
    db = db_session
    from app.services.cotacoes import obter_cotacoes_carteira
    from app.models.renda_fixa import DetalhesRendaFixa
    from app.services.portfolio import obter_ou_criar_carteira_padrao, recalcular_posicoes_carteira
    from datetime import date, datetime, timezone

    obter_ou_criar_carteira_padrao(db, carteira_id=1)

    # 1. Ativo CDBATIVO01
    ativo_aj6 = Ativo(ticker="CDB-CDBATIVO01", nome="CDB CDBATIVO01", tipo=TipoAtivo.RendaFixa)
    db.add(ativo_aj6)
    db.flush()
    detalhes_aj6 = DetalhesRendaFixa(
        ativo_id=ativo_aj6.id,
        produto=ProdutoRendaFixa.CDB,
        indexador=Indexador.CDI,
        percentual_indexador=Decimal("100.0"),
        emissor="BANCO A",
        data_vencimento=date(2027, 12, 20),
    )
    db.add(detalhes_aj6)

    # 2. Ativo CDBATIVO02
    ativo_c8t = Ativo(ticker="CDB-CDBATIVO02", nome="CDB CDBATIVO02", tipo=TipoAtivo.RendaFixa)
    db.add(ativo_c8t)
    db.flush()
    detalhes_c8t = DetalhesRendaFixa(
        ativo_id=ativo_c8t.id,
        produto=ProdutoRendaFixa.CDB,
        indexador=Indexador.CDI,
        percentual_indexador=Decimal("100.0"),
        emissor="BANCO B",
        data_vencimento=date(2027, 12, 23),
    )
    db.add(detalhes_c8t)

    t1 = Transacao(
        carteira_id=1,
        ativo_id=ativo_aj6.id,
        data_hora=datetime(2025, 12, 19, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.BUY,
        quantidade=Decimal("10000000"),
        preco_unitario=Decimal("0.01"),
        taxas=Decimal("0.0"),
        moeda="BRL",
        taxa_contratada=Decimal("100.0"),
    )
    t2 = Transacao(
        carteira_id=1,
        ativo_id=ativo_c8t.id,
        data_hora=datetime(2025, 12, 23, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.BUY,
        quantidade=Decimal("2000000"),
        preco_unitario=Decimal("0.01"),
        taxas=Decimal("0.0"),
        moeda="BRL",
        taxa_contratada=Decimal("100.0"),
    )
    db.add_all([t1, t2])
    db.flush()

    recalcular_posicoes_carteira(db=db, carteira_id=1)

    pos_aj6 = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo_aj6.id).first()
    pos_c8t = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo_c8t.id).first()
    assert pos_aj6.quantidade_saldo == Decimal("10000000")
    assert pos_c8t.quantidade_saldo == Decimal("2000000")

    cdbs_em_custodia = (
        db.query(PosicaoConsolidada)
        .join(Ativo)
        .filter(
            PosicaoConsolidada.carteira_id == 1,
            PosicaoConsolidada.quantidade_saldo > Decimal("0"),
            Ativo.ticker.like("CDB-%"),
        )
        .all()
    )
    tickers_ativos = {p.ativo.ticker for p in cdbs_em_custodia}
    assert tickers_ativos == {"CDB-CDBATIVO01", "CDB-CDBATIVO02"}

    cotacoes_resp = await obter_cotacoes_carteira(db=db, carteira_id=1)
    cotacoes = cotacoes_resp.cotacoes

    assert "CDB-CDBATIVO01" in cotacoes
    assert cotacoes["CDB-CDBATIVO01"].fonte == "CURVA_CDI"
    assert Decimal(str(cotacoes["CDB-CDBATIVO01"].preco_atual)) >= Decimal("0.01")

    assert "CDB-CDBATIVO02" in cotacoes
    assert cotacoes["CDB-CDBATIVO02"].fonte == "CURVA_CDI"
    assert Decimal(str(cotacoes["CDB-CDBATIVO02"].preco_atual)) >= Decimal("0.01")


def test_reprocessar_renda_fixa_preserva_renda_variavel(db_session: Session):
    """
    Caso 11: Reprocessamento seletivo de RF via API preserva integralmente
    as posições e Preços Médios de Renda Variável (Ações, FIIs).
    """
    db = db_session
    from fastapi.testclient import TestClient
    from app.main import app
    from datetime import datetime, timezone
    from app.services.portfolio import recalcular_posicoes_carteira, obter_ou_criar_carteira_padrao

    obter_ou_criar_carteira_padrao(db, carteira_id=1)

    petr4 = Ativo(ticker="PETR4", nome="Petrobras PN", tipo=TipoAtivo.Acao)
    hglg11 = Ativo(ticker="HGLG11", nome="CSHG Logística", tipo=TipoAtivo.FII)
    cdb_antigo = Ativo(ticker="CDB-TESTE-OLD", nome="CDB Teste Old", tipo=TipoAtivo.RendaFixa)
    cdb_btg = Ativo(ticker="CDB-BANCO-20271220", nome="CDB Banco", tipo=TipoAtivo.RendaFixa)
    cdb_real = Ativo(ticker="CDB-CDBATIVO01", nome="CDB CDBATIVO01", tipo=TipoAtivo.RendaFixa)

    db.add_all([petr4, hglg11, cdb_antigo, cdb_btg, cdb_real])
    db.flush()

    tx_petr4 = Transacao(
        carteira_id=1,
        ativo_id=petr4.id,
        data_hora=datetime(2023, 5, 10, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.BUY,
        quantidade=Decimal("100"),
        preco_unitario=Decimal("30.00"),
        taxas=Decimal("0.0"),
        moeda="BRL",
    )
    tx_hglg11 = Transacao(
        carteira_id=1,
        ativo_id=hglg11.id,
        data_hora=datetime(2023, 6, 15, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.BUY,
        quantidade=Decimal("50"),
        preco_unitario=Decimal("160.00"),
        taxas=Decimal("0.0"),
        moeda="BRL",
    )
    tx_cdb_buy = Transacao(
        carteira_id=1,
        ativo_id=cdb_antigo.id,
        data_hora=datetime(2023, 1, 1, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.BUY,
        quantidade=Decimal("10"),
        preco_unitario=Decimal("1000.00"),
        taxas=Decimal("0.0"),
        moeda="BRL",
    )
    tx_cdb_sell_zero = Transacao(
        carteira_id=1,
        ativo_id=cdb_antigo.id,
        data_hora=datetime(2024, 1, 1, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.SELL,
        quantidade=Decimal("10"),
        preco_unitario=Decimal("0.0"),
        taxas=Decimal("0.0"),
        moeda="BRL",
    )
    tx_btg = Transacao(
        carteira_id=1,
        ativo_id=cdb_btg.id,
        data_hora=datetime(2025, 12, 19, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.BUY,
        quantidade=Decimal("100000"),
        preco_unitario=Decimal("0.01"),
        taxas=Decimal("0.0"),
        moeda="BRL",
    )
    tx_real = Transacao(
        carteira_id=1,
        ativo_id=cdb_real.id,
        data_hora=datetime(2025, 12, 19, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.BUY,
        quantidade=Decimal("100000"),
        preco_unitario=Decimal("0.01"),
        taxas=Decimal("0.0"),
        moeda="BRL",
    )
    db.add_all([tx_petr4, tx_hglg11, tx_cdb_buy, tx_cdb_sell_zero, tx_btg, tx_real])
    db.flush()
    recalcular_posicoes_carteira(db=db, carteira_id=1)
    db.commit()

    pos_petr4_antes = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == petr4.id).first()
    assert pos_petr4_antes.quantidade_saldo == Decimal("100")
    assert pos_petr4_antes.preco_medio_brl == Decimal("30.00")

    pos_hglg11_antes = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == hglg11.id).first()
    assert pos_hglg11_antes.quantidade_saldo == Decimal("50")
    assert pos_hglg11_antes.preco_medio_brl == Decimal("160.00")

    client = TestClient(app)

    # 1. Chamada de reprocessamento SEM arquivos -> aciona saneamento de banco
    resp = client.post("/api/v1/importacao/reprocessar-renda-fixa?carteira_id=1")
    assert resp.status_code == 200
    res_data = resp.json()
    assert res_data["status"] == "success"

    # PETR4 e HGLG11 devem estar 100% inalterados
    db.expire_all()
    pos_petr4_depois = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == petr4.id).first()
    assert pos_petr4_depois.quantidade_saldo == Decimal("100")
    assert pos_petr4_depois.preco_medio_brl == Decimal("30.00")
    assert pos_petr4_depois.custo_total_brl == Decimal("3000.00")

    pos_hglg11_depois = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == hglg11.id).first()
    assert pos_hglg11_depois.quantidade_saldo == Decimal("50")
    assert pos_hglg11_depois.preco_medio_brl == Decimal("160.00")
    assert pos_hglg11_depois.custo_total_brl == Decimal("8000.00")

    # Fantasma duplicado deve ter sido removido
    btg_ativo = db.query(Ativo).filter(Ativo.ticker == "CDB-BANCO-20271220").first()
    assert btg_ativo is None

    # Transação zerada do cdb_antigo deve ter sido corrigida
    db.refresh(tx_cdb_sell_zero)
    assert tx_cdb_sell_zero.preco_unitario == Decimal("1000.00000000")
    pos_cdb_antigo = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == cdb_antigo.id).first()
    assert pos_cdb_antigo.lucro_realizado_brl == Decimal("0.00")

    # 2. Chamada de reprocessamento COM upload de planilha Excel de RF
    df_rf = pd.DataFrame([
        {
            "Data": "2024-05-10",
            "Movimentação": "Aplicação",
            "Produto": "CDB BANCO NOVO 2026",
            "Quantidade": 5,
            "Preço unitário": 1000.0,
            "Valor da Operação": 5000.0,
            "Entrada/Saída": "Credito",
        }
    ])
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as w:
        df_rf.to_excel(w, index=False)
    buf.seek(0)

    resp2 = client.post(
        "/api/v1/importacao/reprocessar-renda-fixa?carteira_id=1",
        files={"file": ("movimentacao_rf.xlsx", buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    )
    assert resp2.status_code == 200

    # RV permanece intacto após reprocessamento por arquivo!
    db.expire_all()
    pos_petr4_final = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == petr4.id).first()
    assert pos_petr4_final.quantidade_saldo == Decimal("100")
    assert pos_petr4_final.preco_medio_brl == Decimal("30.00")
    assert pos_petr4_final.custo_total_brl == Decimal("3000.00")


def test_endpoint_resetar_renda_fixa_preserva_rv(db_session: Session):
    """
    Verifica que POST /api/v1/posicoes/carteiras/{carteira_id}/resetar-renda-fixa
    remove UNICAMENTE ativos, transações, posições e detalhes de Renda Fixa,
    preservando 100% de Ações, FIIs e Cripto intactos.
    """
    db = db_session
    from fastapi.testclient import TestClient
    from app.main import app
    from datetime import datetime, timezone
    from app.models.renda_fixa import DetalhesRendaFixa
    from app.services.portfolio import recalcular_posicoes_carteira, obter_ou_criar_carteira_padrao

    obter_ou_criar_carteira_padrao(db, carteira_id=1)

    petr4 = Ativo(ticker="PETR4", nome="Petrobras PN", tipo=TipoAtivo.Acao)
    hglg11 = Ativo(ticker="HGLG11", nome="CSHG Logística", tipo=TipoAtivo.FII)
    btc = Ativo(ticker="BTC", nome="Bitcoin", tipo=TipoAtivo.Cripto)

    cdb = Ativo(ticker="CDB-CDBATIVO01", nome="CDB CDBATIVO01", tipo=TipoAtivo.RendaFixa)
    db.add_all([petr4, hglg11, btc, cdb])
    db.flush()

    det_cdb = DetalhesRendaFixa(
        ativo_id=cdb.id,
        produto=ProdutoRendaFixa.CDB,
        indexador=Indexador.CDI,
        emissor="Banco XP",
    )
    db.add(det_cdb)

    db.add_all([
        Transacao(carteira_id=1, ativo_id=petr4.id, data_hora=datetime(2023, 1, 10, tzinfo=timezone.utc), tipo_operacao=TipoOperacao.BUY, quantidade=Decimal("100"), preco_unitario=Decimal("30.0"), taxas=Decimal("0.0"), moeda="BRL"),
        Transacao(carteira_id=1, ativo_id=hglg11.id, data_hora=datetime(2023, 2, 10, tzinfo=timezone.utc), tipo_operacao=TipoOperacao.BUY, quantidade=Decimal("50"), preco_unitario=Decimal("160.0"), taxas=Decimal("0.0"), moeda="BRL"),
        Transacao(carteira_id=1, ativo_id=btc.id, data_hora=datetime(2023, 3, 10, tzinfo=timezone.utc), tipo_operacao=TipoOperacao.BUY, quantidade=Decimal("0.5"), preco_unitario=Decimal("150000.0"), taxas=Decimal("0.0"), moeda="BRL"),
        Transacao(carteira_id=1, ativo_id=cdb.id, data_hora=datetime(2023, 4, 10, tzinfo=timezone.utc), tipo_operacao=TipoOperacao.BUY, quantidade=Decimal("1000"), preco_unitario=Decimal("1.0"), taxas=Decimal("0.0"), moeda="BRL"),
    ])
    db.flush()
    recalcular_posicoes_carteira(db=db, carteira_id=1)
    db.commit()

    petr4_id = petr4.id
    hglg11_id = hglg11.id
    btc_id = btc.id
    cdb_id = cdb.id

    client = TestClient(app)
    resp = client.post("/api/v1/posicoes/carteiras/1/resetar-renda-fixa")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"

    db.expire_all()
    pos_petr = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.carteira_id == 1, PosicaoConsolidada.ativo_id == petr4_id).first()
    assert pos_petr is not None
    assert pos_petr.quantidade_saldo == Decimal("100")
    assert pos_petr.custo_total_brl == Decimal("3000.00")

    pos_hglg = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.carteira_id == 1, PosicaoConsolidada.ativo_id == hglg11_id).first()
    assert pos_hglg is not None
    assert pos_hglg.quantidade_saldo == Decimal("50")

    pos_btc = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.carteira_id == 1, PosicaoConsolidada.ativo_id == btc_id).first()
    assert pos_btc is not None
    assert pos_btc.quantidade_saldo == Decimal("0.5")

    pos_cdb = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.carteira_id == 1, PosicaoConsolidada.ativo_id == cdb_id).first()
    assert pos_cdb is None
    txs_cdb = db.query(Transacao).filter(Transacao.carteira_id == 1, Transacao.ativo_id == cdb_id).all()
    assert len(txs_cdb) == 0
    detalhes_cdb = db.query(DetalhesRendaFixa).filter(DetalhesRendaFixa.ativo_id == cdb_id).first()
    assert detalhes_cdb is None
    cdb_db = db.query(Ativo).filter(Ativo.ticker == "CDB-CDBATIVO01").first()
    assert cdb_db is None


def test_reconstrucao_completa_renda_fixa_multiplos_ativos(db_session: Session):
    """
    Verifica a reconstituição completa de Renda Fixa com múltiplos ativos simulados:
    - Em Custódia Ativa (>0): EXATAMENTE 3 ativos (CDBATIVO01, CDBATIVO02, TD-RENDA+-2065).
    - Em Posições Encerradas (==0): ativos liquidados/vencidos com seus respectivos lucros realizados.
    - Idempotência: reimportação subsequente não duplica lotes nem altera posições.
    """
    db = db_session
    from app.services.portfolio import obter_ou_criar_carteira_padrao
    obter_ou_criar_carteira_padrao(db, carteira_id=1)

    linhas = [
        # 1. CDB-CDBATIVO01: compra de 10.000.000 un e resgate de 1.000.000 -> saldo 9.000.000, lucro 500.00
        {"Data": "2025-12-19", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBATIVO01", "Quantidade": 10000000, "Preço unitário": 0.01, "Valor da Operação": 100000.00, "Entrada/Saída": "Credito"},
        {"Data": "2026-06-15", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBATIVO01", "Quantidade": 1000000, "Preço unitário": 0.0105, "Valor da Operação": 10500.00, "Entrada/Saída": "Debito"},

        # 2. CDB-CDBATIVO02: compra de 5.000.000 un e resgate de 2.000.000 -> saldo 3.000.000, lucro 1000.00
        {"Data": "2025-12-23", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBATIVO02", "Quantidade": 5000000, "Preço unitário": 0.01, "Valor da Operação": 50000.00, "Entrada/Saída": "Credito"},
        {"Data": "2026-06-03", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBATIVO02", "Quantidade": 2000000, "Preço unitário": 0.0105, "Valor da Operação": 21000.00, "Entrada/Saída": "Debito"},

        # 3. TD-RENDA+-2065: 2 compras somando 100.00 un e R$ 20.000,00 -> saldo 100.00, lucro 0.00
        {"Data": "2026-01-26", "Movimentação": "Transferência - Liquidação", "Produto": "Tesouro RendA+ Aposentadoria Extra 2065", "Quantidade": 50.00, "Preço unitário": 200.00, "Valor da Operação": 10000.00, "Entrada/Saída": "Credito"},
        {"Data": "2026-03-25", "Movimentação": "Transferência - Liquidação", "Produto": "Tesouro RendA+ Aposentadoria Extra 2065", "Quantidade": 50.00, "Preço unitário": 200.00, "Valor da Operação": 10000.00, "Entrada/Saída": "Credito"},

        # 4. CDB-CDBENC01: compra de 20 e Vencimento de 20 com PU=0 e Val=0 -> saldo 0, lucro 0.00
        {"Data": "2023-05-09", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBENC01", "Quantidade": 20, "Preço unitário": 1000.0, "Valor da Operação": 20000.0, "Entrada/Saída": "Credito"},
        {"Data": "2023-08-08", "Movimentação": "Vencimento", "Produto": "CDB - CDBENC01", "Quantidade": 20, "Preço unitário": 0.0, "Valor da Operação": 0.0, "Entrada/Saída": "Debito"},

        # 5. CDB-CDBENC02: compra de 1000 e resgate de 1000 -> saldo 0, lucro 50.00
        {"Data": "2023-09-19", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBENC02", "Quantidade": 1000, "Preço unitário": 1.00, "Valor da Operação": 1000.00, "Entrada/Saída": "Credito"},
        {"Data": "2023-10-05", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBENC02", "Quantidade": 1000, "Preço unitário": 1.05, "Valor da Operação": 1050.00, "Entrada/Saída": "Debito"},
    ]

    df = pd.DataFrame(linhas)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as w:
        df.to_excel(w, index=False)
    file_bytes = buf.getvalue()

    res = processar_planilha_movimentacao_b3(db=db, file_content=file_bytes, carteira_id=1)
    assert len(res["transacoes"]) > 0

    pos_aj6 = db.query(PosicaoConsolidada).join(Ativo).filter(PosicaoConsolidada.carteira_id == 1, Ativo.ticker == "CDB-CDBATIVO01").first()
    assert pos_aj6 is not None
    assert pos_aj6.quantidade_saldo == Decimal("9000000")
    assert pos_aj6.custo_total_brl == Decimal("90000.00")
    assert pos_aj6.lucro_realizado_brl == Decimal("500.00")

    pos_c8t = db.query(PosicaoConsolidada).join(Ativo).filter(PosicaoConsolidada.carteira_id == 1, Ativo.ticker == "CDB-CDBATIVO02").first()
    assert pos_c8t is not None
    assert pos_c8t.quantidade_saldo == Decimal("3000000")
    assert pos_c8t.custo_total_brl == Decimal("30000.00")
    assert pos_c8t.lucro_realizado_brl == Decimal("1000.00")

    pos_td = db.query(PosicaoConsolidada).join(Ativo).filter(PosicaoConsolidada.carteira_id == 1, Ativo.ticker == "TD-RENDA+-2065").first()
    assert pos_td is not None
    assert pos_td.quantidade_saldo == Decimal("100.00")
    assert pos_td.custo_total_brl == Decimal("20000.00")
    assert pos_td.lucro_realizado_brl == Decimal("0.00")

    total_custo_ativo = pos_aj6.custo_total_brl + pos_c8t.custo_total_brl + pos_td.custo_total_brl
    assert total_custo_ativo == Decimal("140000.00")

    ativos_em_custodia = (
        db.query(PosicaoConsolidada)
        .join(Ativo)
        .filter(
            PosicaoConsolidada.carteira_id == 1,
            PosicaoConsolidada.quantidade_saldo > Decimal("0"),
            Ativo.tipo == TipoAtivo.RendaFixa,
        )
        .all()
    )
    tickers_em_custodia = {p.ativo.ticker for p in ativos_em_custodia}
    assert tickers_em_custodia == {"CDB-CDBATIVO01", "CDB-CDBATIVO02", "TD-RENDA+-2065"}
    assert len(ativos_em_custodia) == 3

    esperados_encerrados = {
        "CDB-CDBENC01": Decimal("0.00"),
        "CDB-CDBENC02": Decimal("50.00"),
    }
    for ticker, lucro_esp in esperados_encerrados.items():
        pos = db.query(PosicaoConsolidada).join(Ativo).filter(PosicaoConsolidada.carteira_id == 1, Ativo.ticker == ticker).first()
        assert pos is not None, f"Posição para {ticker} não encontrada"
        assert pos.quantidade_saldo == Decimal("0"), f"{ticker} saldo esperado 0, obteve {pos.quantidade_saldo}"
        assert pos.lucro_realizado_brl == lucro_esp, f"{ticker} lucro esperado {lucro_esp}, obteve {pos.lucro_realizado_brl}"

    res_reimport = processar_planilha_movimentacao_b3(db=db, file_content=file_bytes, carteira_id=1)
    assert len(res_reimport["transacoes"]) == 0

    db.expire_all()
    pos_aj6_depois = db.query(PosicaoConsolidada).join(Ativo).filter(PosicaoConsolidada.carteira_id == 1, Ativo.ticker == "CDB-CDBATIVO01").first()
    assert pos_aj6_depois.quantidade_saldo == Decimal("9000000")
    assert pos_aj6_depois.custo_total_brl == Decimal("90000.00")

    pos_c8t_depois = db.query(PosicaoConsolidada).join(Ativo).filter(PosicaoConsolidada.carteira_id == 1, Ativo.ticker == "CDB-CDBATIVO02").first()
    assert pos_c8t_depois.quantidade_saldo == Decimal("3000000")
    assert pos_c8t_depois.custo_total_brl == Decimal("30000.00")

    pos_td_depois = db.query(PosicaoConsolidada).join(Ativo).filter(PosicaoConsolidada.carteira_id == 1, Ativo.ticker == "TD-RENDA+-2065").first()
    assert pos_td_depois.quantidade_saldo == Decimal("100.00")
    assert pos_td_depois.custo_total_brl == Decimal("20000.00")


def test_ingestao_rf_venda_parcial_com_venda_previa_no_banco(db_session: Session):
    """
    Garante que ao importar uma planilha contendo uma venda já gravada e uma nova venda parcial,
    a nova venda NÃO seja incorretamente descartada com aviso de saldo zero.
    """
    db = db_session
    from app.services.portfolio import obter_ou_criar_carteira_padrao, recalcular_posicoes_carteira
    from datetime import datetime, timezone
    obter_ou_criar_carteira_padrao(db, carteira_id=1)

    ativo = Ativo(ticker="CDB-TESTEPARCIAL", nome="CDB Teste Parcial", tipo=TipoAtivo.RendaFixa)
    db.add(ativo)
    db.flush()

    tx_buy = Transacao(carteira_id=1, ativo_id=ativo.id, data_hora=datetime(2023, 1, 1, tzinfo=timezone.utc), tipo_operacao=TipoOperacao.BUY, quantidade=Decimal("100"), preco_unitario=Decimal("1000"), taxas=Decimal("0"), moeda="BRL")
    tx_sell1 = Transacao(carteira_id=1, ativo_id=ativo.id, data_hora=datetime(2023, 6, 1, tzinfo=timezone.utc), tipo_operacao=TipoOperacao.SELL, quantidade=Decimal("30"), preco_unitario=Decimal("1050"), taxas=Decimal("0"), moeda="BRL")
    db.add_all([tx_buy, tx_sell1])
    db.commit()
    recalcular_posicoes_carteira(db, carteira_id=1)

    pos_inicial = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.carteira_id == 1, PosicaoConsolidada.ativo_id == ativo.id).first()
    assert pos_inicial.quantidade_saldo == Decimal("70")

    linhas = [
        {"Data": "2023-06-01", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - TESTEPARCIAL", "Quantidade": 30, "Preço unitário": 1050.0, "Valor da Operação": 31500.0, "Entrada/Saída": "Debito"},
        {"Data": "2023-09-01", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - TESTEPARCIAL", "Quantidade": 40, "Preço unitário": 1080.0, "Valor da Operação": 43200.0, "Entrada/Saída": "Debito"},
    ]
    df = pd.DataFrame(linhas)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as w:
        df.to_excel(w, index=False)

    res = processar_planilha_movimentacao_b3(db=db, file_content=buf.getvalue(), carteira_id=1)
    assert len(res["transacoes"]) == 1
    assert res["transacoes"][0].quantidade == Decimal("40")

    db.expire_all()
    pos_final = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.carteira_id == 1, PosicaoConsolidada.ativo_id == ativo.id).first()
    assert pos_final.quantidade_saldo == Decimal("30")
    assert pos_final.custo_total_brl == Decimal("30000.00")
    assert pos_final.lucro_realizado_brl == Decimal("4700.00")


def test_deduplicacao_rf_pu_zero_para_pu_calculado(db_session: Session):
    """
    Garante que se uma transferência de entrada antiga de RF existia no banco com PU=0,
    uma nova importação de compra com PU > 0 e mesmo dia/qtd atualize o PU sem duplicar.
    """
    db = db_session
    from app.services.portfolio import obter_ou_criar_carteira_padrao, recalcular_posicoes_carteira
    from datetime import datetime, timezone
    obter_ou_criar_carteira_padrao(db, carteira_id=1)

    ativo = Ativo(ticker="CDB-TESTEPU0", nome="CDB Teste PU Zero", tipo=TipoAtivo.RendaFixa)
    db.add(ativo)
    db.flush()

    tx_antiga = Transacao(
        carteira_id=1,
        ativo_id=ativo.id,
        data_hora=datetime(2024, 1, 15, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.TRANSFERENCIA_ENTRADA,
        quantidade=Decimal("50"),
        preco_unitario=Decimal("0.0"),
        taxas=Decimal("0.0"),
        moeda="BRL",
    )
    db.add(tx_antiga)
    db.commit()
    recalcular_posicoes_carteira(db, carteira_id=1)

    linhas = [
        {"Data": "2024-01-15", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - TESTEPU0", "Quantidade": 50, "Preço unitário": 1000.0, "Valor da Operação": 50000.0, "Entrada/Saída": "Credito"}
    ]
    df = pd.DataFrame(linhas)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as w:
        df.to_excel(w, index=False)

    res = processar_planilha_movimentacao_b3(db=db, file_content=buf.getvalue(), carteira_id=1)
    assert len(res["transacoes"]) == 0

    db.expire_all()
    txs = db.query(Transacao).filter(Transacao.carteira_id == 1, Transacao.ativo_id == ativo.id).all()
    assert len(txs) == 1
    assert txs[0].preco_unitario == Decimal("1000")
    assert txs[0].tipo_operacao == TipoOperacao.BUY


def test_endpoint_resetar_renda_fixa_todas_carteiras(db_session: Session):
    """
    Verifica o parâmetro todas_carteiras=True no endpoint resetar-renda-fixa.
    """
    from starlette.testclient import TestClient
    from app.main import app
    from datetime import datetime, timezone
    from app.services.portfolio import obter_ou_criar_carteira_padrao, recalcular_posicoes_carteira
    from app.models.renda_fixa import DetalhesRendaFixa

    db = db_session
    obter_ou_criar_carteira_padrao(db, carteira_id=1, nome_padrao="Carteira 1")
    obter_ou_criar_carteira_padrao(db, carteira_id=2, nome_padrao="Carteira 2")

    rf = Ativo(ticker="CDB-CDBCLEANALL", nome="CDB Clean All", tipo=TipoAtivo.RendaFixa)
    acao = Ativo(ticker="WEGE3", nome="WEG ON", tipo=TipoAtivo.Acao)
    db.add_all([rf, acao])
    db.flush()

    db.add(DetalhesRendaFixa(ativo_id=rf.id, produto=ProdutoRendaFixa.CDB, indexador=Indexador.CDI))

    db.add_all([
        Transacao(carteira_id=1, ativo_id=rf.id, data_hora=datetime(2024, 1, 10, tzinfo=timezone.utc), tipo_operacao=TipoOperacao.BUY, quantidade=Decimal("10"), preco_unitario=Decimal("100"), taxas=Decimal("0"), moeda="BRL"),
        Transacao(carteira_id=2, ativo_id=rf.id, data_hora=datetime(2024, 1, 10, tzinfo=timezone.utc), tipo_operacao=TipoOperacao.BUY, quantidade=Decimal("20"), preco_unitario=Decimal("100"), taxas=Decimal("0"), moeda="BRL"),
        Transacao(carteira_id=1, ativo_id=acao.id, data_hora=datetime(2024, 1, 10, tzinfo=timezone.utc), tipo_operacao=TipoOperacao.BUY, quantidade=Decimal("100"), preco_unitario=Decimal("35"), taxas=Decimal("0"), moeda="BRL"),
    ])
    db.commit()
    recalcular_posicoes_carteira(db, carteira_id=1)
    recalcular_posicoes_carteira(db, carteira_id=2)

    rf_id = rf.id
    acao_id = acao.id

    client = TestClient(app)
    resp = client.post("/api/v1/posicoes/carteiras/1/resetar-renda-fixa?todas_carteiras=true")
    assert resp.status_code == 200

    db.expire_all()
    assert db.query(Transacao).filter(Transacao.ativo_id == rf_id).count() == 0
    assert db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == rf_id).count() == 0
    assert db.query(Ativo).filter(Ativo.id == rf_id).first() is None

    pos_acao = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.carteira_id == 1, PosicaoConsolidada.ativo_id == acao_id).first()
    assert pos_acao is not None
    assert pos_acao.quantidade_saldo == Decimal("100")
