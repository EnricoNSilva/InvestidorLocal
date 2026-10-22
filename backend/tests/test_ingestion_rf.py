import io
from decimal import Decimal
import pandas as pd
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
    Caso 1: Vencimento de CDB com PU=0 e Valor=0 da B3 (ex: CDB-CDB223DOLTM).
    Deve dar baixa pelo Preço Médio de aquisição (1000.00), zerando a posição
    sem gerar falso prejuízo de -25.000,00 (lucro_realizado == 0.00).
    """
    db = db_session
    data = [
        {
            "Data": "2023-01-10",
            "Movimentação": "Aplicação",
            "Produto": "CDB-CDB223DOLTM",
            "Quantidade": 25,
            "Preço unitário": 1000.0,
            "Valor da Operação": 25000.0,
            "Entrada/Saída": "Credito",
        },
        {
            "Data": "2025-01-10",
            "Movimentação": "Vencimento",
            "Produto": "CDB-CDB223DOLTM",
            "Quantidade": 25,
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
    assert tx_buy.quantidade == Decimal("25")
    assert tx_buy.preco_unitario == Decimal("1000.00000000")

    assert tx_sell.tipo_operacao == TipoOperacao.SELL
    assert tx_sell.quantidade == Decimal("25")
    # O PU da venda foi corrigido para o PM de aquisição (1000.00) em vez de 0.0
    assert tx_sell.preco_unitario == Decimal("1000.00000000")

    from app.models.posicao import PosicaoConsolidada
    ativo = db.query(Ativo).filter(Ativo.ticker == "CDB-CDB223DOLTM").first()
    assert ativo is not None
    pos = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo.id).first()
    assert pos is not None
    assert pos.quantidade_saldo == Decimal("0")
    # Não pode ter gerado prejuízo de -25000!
    assert pos.lucro_realizado_brl == Decimal("0.00")
    assert pos.valor_total_venda_brl == Decimal("25000.00")
    assert pos.custo_historico_brl == Decimal("25000.00")


def test_ingestao_movimentacao_cdb_resgate_precisao_pu_btg(db_session: Session):
    """
    Caso 2: Resgate de CDB do BTG com PU truncado em 0.01 na planilha (CDBC25AIK2H).
    Quantidade = 450.000, Valor = 4.557,40.
    O PU calculado com 8 casas decimais apura exatamente R$ 57,40 de lucro realizado.
    """
    db = db_session
    data = [
        {
            "Data": "2023-01-20",
            "Movimentação": "Aplicação",
            "Produto": "CDB - CDBC25AIK2H",
            "Quantidade": 450000,
            "Preço unitário": 0.01,
            "Valor da Operação": 4500.0,
            "Entrada/Saída": "Credito",
        },
        {
            "Data": "2026-01-23",
            "Movimentação": "Resgate Antecipado",
            "Produto": "CDB - CDBC25AIK2H",
            "Quantidade": 450000,
            "Preço unitário": 0.01,  # truncado pela B3
            "Valor da Operação": 4557.40,
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
    assert tx_buy.quantidade == Decimal("450000")
    assert tx_buy.preco_unitario == Decimal("0.01000000")

    assert tx_sell.tipo_operacao == TipoOperacao.SELL
    assert tx_sell.quantidade == Decimal("450000")
    # PU calculado com 8 casas decimais a partir de 4557.40 / 450000
    assert tx_sell.preco_unitario == Decimal("0.01012756")

    from app.models.posicao import PosicaoConsolidada
    ativo = db.query(Ativo).filter(Ativo.ticker == "CDB-CDBC25AIK2H").first()
    assert ativo is not None
    pos = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo.id).first()
    assert pos is not None
    assert pos.quantidade_saldo == Decimal("0")
    # Lucro realizado apurado exatamente em R$ 57,40
    assert pos.lucro_realizado_brl == Decimal("57.40")
    assert pos.valor_total_venda_brl == Decimal("4557.40")
    assert pos.custo_historico_brl == Decimal("4500.00")


def test_ingestao_movimentacao_cdb_compra_venda_xp(db_session: Session):
    """
    Caso 3: Linhas de CDB da XP com Movimentação == 'COMPRA / VENDA'.
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

    from app.models.posicao import PosicaoConsolidada
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

    from app.models.posicao import PosicaoConsolidada
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
    atualizar o preco_unitario para 0.01012756 e recalcular a carteira apurando os R$ 57,40 de lucro.
    """
    db = db_session
    from app.services.portfolio import obter_ou_criar_carteira_padrao, recalcular_posicoes_carteira
    obter_ou_criar_carteira_padrao(db, carteira_id=1)

    ativo = Ativo(ticker="CDB-CDBC25UPG", nome="CDB CDBC25UPG", tipo=TipoAtivo.RendaFixa)
    db.add(ativo)
    db.flush()

    from datetime import datetime, timezone
    from app.models.transacao import Transacao

    tx_buy = Transacao(
        carteira_id=1,
        ativo_id=ativo.id,
        data_hora=datetime(2023, 1, 20, 10, 0, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.BUY,
        quantidade=Decimal("450000"),
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
        quantidade=Decimal("450000"),
        preco_unitario=Decimal("0.01"),
        taxas=Decimal("0.0"),
        moeda="BRL",
    )
    db.add_all([tx_buy, tx_sell_antiga])
    db.flush()
    recalcular_posicoes_carteira(db=db, carteira_id=1)

    from app.models.posicao import PosicaoConsolidada
    pos_ant = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo.id).first()
    assert pos_ant.lucro_realizado_brl == Decimal("0.00")  # Sem a precisão, lucro era 0

    # Agora importa a planilha com o novo parser
    data = [
        {
            "Data": "2026-01-23",
            "Movimentação": "Resgate Antecipado",
            "Produto": "CDB - CDBC25UPG",
            "Quantidade": 450000,
            "Preço unitário": 0.01,  # truncado pela B3
            "Valor da Operação": 4557.40,
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
    assert tx_sell_antiga.preco_unitario == Decimal("0.01012756")

    # E recalculado a posição consolidada para R$ 57,40 de lucro
    pos_pos = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo.id).first()
    assert pos_pos.lucro_realizado_brl == Decimal("57.40")


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


def test_ingestao_movimentacao_cdb_b2476lcb_resgates_e_vencimento(db_session: Session):
    """
    Caso 7: CDBB2476LCB: compra de 90 (R$ 90.486,05), 5 resgates Debito | COMPRA / VENDA
    somando 78 (R$ 79.350,20) e VENCIMENTO de 12 (Val: 0) -> saldo final 0, lucro realizado +R$ 928,96.
    """
    db = db_session
    data = [
        {
            "Data": "2024-12-06",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDBB2476LCB",
            "Quantidade": 90,
            "Preço unitário": 1005.40,
            "Valor da Operação": 90486.05,
            "Entrada/Saída": "Credito",
        },
        # 5 resgates Debito | COMPRA / VENDA somando 78 unidades e valor total de R$ 79.350,20
        {
            "Data": "2025-02-10",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDBB2476LCB",
            "Quantidade": 15,
            "Preço unitário": 1017.31,
            "Valor da Operação": 15259.65,
            "Entrada/Saída": "Debito",
        },
        {
            "Data": "2025-04-10",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDBB2476LCB",
            "Quantidade": 15,
            "Preço unitário": 1017.31,
            "Valor da Operação": 15259.65,
            "Entrada/Saída": "Debito",
        },
        {
            "Data": "2025-06-10",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDBB2476LCB",
            "Quantidade": 15,
            "Preço unitário": 1017.31,
            "Valor da Operação": 15259.65,
            "Entrada/Saída": "Debito",
        },
        {
            "Data": "2025-08-10",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDBB2476LCB",
            "Quantidade": 15,
            "Preço unitário": 1017.31,
            "Valor da Operação": 15259.65,
            "Entrada/Saída": "Debito",
        },
        {
            "Data": "2025-10-10",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDBB2476LCB",
            "Quantidade": 18,
            "Preço unitário": 1017.31,
            "Valor da Operação": 18311.60,
            "Entrada/Saída": "Debito",
        },
        # Vencimento das 12 unidades restantes com PU=0 e Valor=0 da B3
        {
            "Data": "2025-12-06",
            "Movimentação": "Vencimento",
            "Produto": "CDB - CDBB2476LCB",
            "Quantidade": 12,
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
    assert len(txs) == 7

    ativo = db.query(Ativo).filter(Ativo.ticker == "CDB-CDBB2476LCB").first()
    assert ativo is not None
    from app.models.posicao import PosicaoConsolidada
    pos = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo.id).first()
    assert pos is not None
    assert pos.quantidade_saldo == Decimal("0")
    assert pos.lucro_realizado_brl == Decimal("928.96")


def test_ingestao_movimentacao_cdb_422ckfig_deduplicacao_e_vencimento(db_session: Session):
    """
    Caso 8: CDB422CKFIG com linhas duplicadas no mesmo dia (23/09/2024: 20.0 duas vezes e 7892.0 duas vezes;
    11/10/2024: 1774.0 duas vezes) e vencimento de 2.870 unidades.
    Resultado esperado: linhas duplicadas descartadas, saldo final 0, lucro de +R$ 310,85.
    """
    db = db_session
    data = [
        # Aquisições
        {
            "Data": "2023-10-20",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDB422CKFIG",
            "Quantidade": 14933,
            "Preço unitário": 1.13,
            "Valor da Operação": 16874.29,
            "Entrada/Saída": "Credito",
        },
        {
            "Data": "2024-09-10",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDB422CKFIG",
            "Quantidade": 12556,
            "Preço unitário": 1.25,
            "Valor da Operação": 15695.00,
            "Entrada/Saída": "Credito",
        },
        # Resgates 23/09/2024 com linhas duplicadas idênticas da B3 (20.0 duas vezes e 7892.0 duas vezes)
        {
            "Data": "2024-09-23",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDB422CKFIG",
            "Quantidade": 20.0,
            "Preço unitário": 1.1965,
            "Valor da Operação": 23.93,
            "Entrada/Saída": "Debito",
        },
        {
            "Data": "2024-09-23",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDB422CKFIG",
            "Quantidade": 20.0,
            "Preço unitário": 1.1965,
            "Valor da Operação": 23.93,
            "Entrada/Saída": "Debito",
        },
        {
            "Data": "2024-09-23",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDB422CKFIG",
            "Quantidade": 7892.0,
            "Preço unitário": 1.19666624,
            "Valor da Operação": 9444.09,
            "Entrada/Saída": "Debito",
        },
        {
            "Data": "2024-09-23",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDB422CKFIG",
            "Quantidade": 7892.0,
            "Preço unitário": 1.19666624,
            "Valor da Operação": 9444.09,
            "Entrada/Saída": "Debito",
        },
        {
            "Data": "2024-09-23",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDB422CKFIG",
            "Quantidade": 4088.0,
            "Preço unitário": 1.19666830,
            "Valor da Operação": 4891.98,
            "Entrada/Saída": "Debito",
        },
        # Resgates 11/10/2024 com linha duplicada idêntica da B3 (1774.0 duas vezes)
        {
            "Data": "2024-10-11",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDB422CKFIG",
            "Quantidade": 1774.0,
            "Preço unitário": 1.19817362,
            "Valor da Operação": 2125.56,
            "Entrada/Saída": "Debito",
        },
        {
            "Data": "2024-10-11",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDB422CKFIG",
            "Quantidade": 1774.0,
            "Preço unitário": 1.19817362,
            "Valor da Operação": 2125.56,
            "Entrada/Saída": "Debito",
        },
        {
            "Data": "2024-10-11",
            "Movimentação": "COMPRA / VENDA",
            "Produto": "CDB - CDB422CKFIG",
            "Quantidade": 10845.0,
            "Preço unitário": 1.19817151,
            "Valor da Operação": 12994.17,
            "Entrada/Saída": "Debito",
        },
        # Vencimento final de 2870 unidades
        {
            "Data": "2024-11-07",
            "Movimentação": "Vencimento",
            "Produto": "CDB - CDB422CKFIG",
            "Quantidade": 2870,
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
    # 11 linhas enviadas, 3 duplicatas no mesmo dia descartadas -> 8 transações
    assert len(txs) == 8

    ativo = db.query(Ativo).filter(Ativo.ticker == "CDB-CDB422CKFIG").first()
    assert ativo is not None
    from app.models.posicao import PosicaoConsolidada
    pos = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo.id).first()
    assert pos is not None
    assert pos.quantidade_saldo == Decimal("0")
    assert pos.lucro_realizado_brl == Decimal("310.85")


def test_cdbs_matured_saldo_zero(db_session: Session):
    """
    Caso 9: CDBs CDB422A0GWW, CDB422HCXRD, CDB422R8SZO que venceram.
    Verifica se Debito | COMPRA / VENDA e Vencimento encerram com saldo 0 sem falso prejuízo.
    """
    db = db_session
    data = [
        # CDB422A0GWW (R$ 5.020,28 de valor real de compra)
        {"Data": "2023-09-19", "Movimentação": "COMPRA / VENDA", "Produto": "CDB - CDB422A0GWW", "Quantidade": 4450, "Preço unitário": 1.12, "Valor da Operação": 5020.28, "Entrada/Saída": "Credito"},
        {"Data": "2024-09-19", "Movimentação": "COMPRA / VENDA", "Produto": "CDB - CDB422A0GWW", "Quantidade": 4450, "Preço unitário": 1.12815281, "Valor da Operação": 5020.28, "Entrada/Saída": "Debito"},
        # CDB422HCXRD
        {"Data": "2024-01-05", "Movimentação": "COMPRA / VENDA", "Produto": "CDB - CDB422HCXRD", "Quantidade": 1985, "Preço unitário": 1.16, "Valor da Operação": 2302.6, "Entrada/Saída": "Credito"},
        {"Data": "2025-01-05", "Movimentação": "COMPRA / VENDA", "Produto": "CDB - CDB422HCXRD", "Quantidade": 1985, "Preço unitário": 1.16, "Valor da Operação": 2302.6, "Entrada/Saída": "Debito"},
        # CDB422R8SZO
        {"Data": "2024-06-21", "Movimentação": "COMPRA / VENDA", "Produto": "CDB - CDB422R8SZO", "Quantidade": 17, "Preço unitário": 1210.98, "Valor da Operação": 20586.66, "Entrada/Saída": "Credito"},
        {"Data": "2025-06-21", "Movimentação": "COMPRA / VENDA", "Produto": "CDB - CDB422R8SZO", "Quantidade": 17, "Preço unitário": 1210.98, "Valor da Operação": 20586.66, "Entrada/Saída": "Debito"},
    ]
    df = pd.DataFrame(data)
    excel_buffer = io.BytesIO()
    with pd.ExcelWriter(excel_buffer, engine="openpyxl") as writer:
        df.to_excel(writer, index=False)

    res = processar_planilha_movimentacao_b3(db=db, file_content=excel_buffer.getvalue(), carteira_id=1)
    assert len(res["transacoes"]) == 6

    from app.models.posicao import PosicaoConsolidada
    for ticker in ["CDB-CDB422A0GWW", "CDB-CDB422HCXRD", "CDB-CDB422R8SZO"]:
        ativo = db.query(Ativo).filter(Ativo.ticker == ticker).first()
        assert ativo is not None
        pos = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo.id).first()
        assert pos is not None
        assert pos.quantidade_saldo == Decimal("0")
        assert pos.lucro_realizado_brl == Decimal("0.00")


import pytest

@pytest.mark.anyio
async def test_cdb_cdbc25aj6nh_e_c8txm_curva_cdi(db_session: Session):
    """
    Caso 10: CDBC25AJ6NH (18.836.239 un.) e CDBC25C8TXM (1.847.008 un.)
    permanecendo como os únicos 2 CDBs ativos em custódia com cotação pela CURVA_CDI.
    """
    db = db_session
    from app.services.cotacoes import obter_cotacoes_carteira
    from app.models.renda_fixa import DetalhesRendaFixa
    from app.services.portfolio import obter_ou_criar_carteira_padrao
    from datetime import date, datetime, timezone

    obter_ou_criar_carteira_padrao(db, carteira_id=1)

    # 1. Ativo CDBC25AJ6NH
    ativo_aj6 = Ativo(ticker="CDB-CDBC25AJ6NH", nome="CDB CDBC25AJ6NH", tipo=TipoAtivo.RendaFixa)
    db.add(ativo_aj6)
    db.flush()
    detalhes_aj6 = DetalhesRendaFixa(
        ativo_id=ativo_aj6.id,
        produto=ProdutoRendaFixa.CDB,
        indexador=Indexador.CDI,
        percentual_indexador=Decimal("100.0"),
        emissor="BTG",
        data_vencimento=date(2027, 12, 20),
    )
    db.add(detalhes_aj6)

    # 2. Ativo CDBC25C8TXM
    ativo_c8t = Ativo(ticker="CDB-CDBC25C8TXM", nome="CDB CDBC25C8TXM", tipo=TipoAtivo.RendaFixa)
    db.add(ativo_c8t)
    db.flush()
    detalhes_c8t = DetalhesRendaFixa(
        ativo_id=ativo_c8t.id,
        produto=ProdutoRendaFixa.CDB,
        indexador=Indexador.CDI,
        percentual_indexador=Decimal("100.0"),
        emissor="BTG",
        data_vencimento=date(2027, 12, 23),
    )
    db.add(detalhes_c8t)

    # Transações para gerar exatamente 18.836.239 e 1.847.008 de saldo
    from app.models.transacao import Transacao
    t1 = Transacao(
        carteira_id=1,
        ativo_id=ativo_aj6.id,
        data_hora=datetime(2025, 12, 19, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.BUY,
        quantidade=Decimal("18836239"),
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
        quantidade=Decimal("1847008"),
        preco_unitario=Decimal("0.01"),
        taxas=Decimal("0.0"),
        moeda="BRL",
        taxa_contratada=Decimal("100.0"),
    )
    db.add_all([t1, t2])
    db.flush()

    from app.services.portfolio import recalcular_posicoes_carteira
    recalcular_posicoes_carteira(db=db, carteira_id=1)

    from app.models.posicao import PosicaoConsolidada
    pos_aj6 = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo_aj6.id).first()
    pos_c8t = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo_c8t.id).first()
    assert pos_aj6.quantidade_saldo == Decimal("18836239")
    assert pos_c8t.quantidade_saldo == Decimal("1847008")

    # Verifica que são os únicos 2 CDBs ativos em custódia
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
    assert tickers_ativos == {"CDB-CDBC25AJ6NH", "CDB-CDBC25C8TXM"}

    # Obter cotações da carteira
    cotacoes_resp = await obter_cotacoes_carteira(db=db, carteira_id=1)
    cotacoes = cotacoes_resp.cotacoes

    assert "CDB-CDBC25AJ6NH" in cotacoes
    assert cotacoes["CDB-CDBC25AJ6NH"].fonte == "CURVA_CDI"
    assert Decimal(str(cotacoes["CDB-CDBC25AJ6NH"].preco_atual)) >= Decimal("0.01")

    assert "CDB-CDBC25C8TXM" in cotacoes
    assert cotacoes["CDB-CDBC25C8TXM"].fonte == "CURVA_CDI"
    assert Decimal(str(cotacoes["CDB-CDBC25C8TXM"].preco_atual)) >= Decimal("0.01")


def test_reprocessar_renda_fixa_preserva_renda_variavel(db_session: Session):
    """
    Caso 11: Reprocessamento seletivo de RF via API preserva integralmente
    as posições e Preços Médios de Renda Variável (Ações, FIIs).
    """
    db = db_session
    from fastapi.testclient import TestClient
    from app.main import app
    from datetime import datetime, timezone
    from app.models.transacao import Transacao
    from app.models.posicao import PosicaoConsolidada
    from app.services.portfolio import recalcular_posicoes_carteira, obter_ou_criar_carteira_padrao

    obter_ou_criar_carteira_padrao(db, carteira_id=1)

    # Prepara PETR4 (Ação)
    petr4 = Ativo(ticker="PETR4", nome="Petrobras PN", tipo=TipoAtivo.Acao)
    # Prepara HGLG11 (FII)
    hglg11 = Ativo(ticker="HGLG11", nome="CSHG Logística", tipo=TipoAtivo.FII)
    # Prepara CDB com PU=0 de venda antiga
    cdb_antigo = Ativo(ticker="CDB-TESTE-OLD", nome="CDB Teste Old", tipo=TipoAtivo.RendaFixa)
    # Prepara fantasma CDB BTG
    cdb_btg = Ativo(ticker="CDB-BTG-20271220", nome="CDB BTG", tipo=TipoAtivo.RendaFixa)
    cdb_real = Ativo(ticker="CDB-CDBC25AJ6NH", nome="CDB CDBC25AJ6NH", tipo=TipoAtivo.RendaFixa)

    db.add_all([petr4, hglg11, cdb_antigo, cdb_btg, cdb_real])
    db.flush()

    # Transações de RV
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
    # Transações do cdb_antigo com venda zerada
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
    # Transações do fantasma BTG
    tx_btg = Transacao(
        carteira_id=1,
        ativo_id=cdb_btg.id,
        data_hora=datetime(2025, 12, 19, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.BUY,
        quantidade=Decimal("18836239"),
        preco_unitario=Decimal("0.01"),
        taxas=Decimal("0.0"),
        moeda="BRL",
    )
    db.add_all([tx_petr4, tx_hglg11, tx_cdb_buy, tx_cdb_sell_zero, tx_btg])
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

    # Fantasma BTG deve ter sido removido
    btg_ativo = db.query(Ativo).filter(Ativo.ticker == "CDB-BTG-20271220").first()
    assert btg_ativo is None

    # Transação zerada do cdb_antigo deve ter sido corrigida
    db.refresh(tx_cdb_sell_zero)
    assert tx_cdb_sell_zero.preco_unitario == Decimal("1000.00000000")
    pos_cdb_antigo = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == cdb_antigo.id).first()
    assert pos_cdb_antigo.lucro_realizado_brl == Decimal("0.00")

    # 2. Chamada de reprocessamento COM upload de planilha Excel de RF
    # Prepara planilha com nova aplicação de CDB
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
    from app.models.transacao import Transacao
    from app.models.posicao import PosicaoConsolidada
    from app.models.renda_fixa import DetalhesRendaFixa
    from app.services.portfolio import recalcular_posicoes_carteira, obter_ou_criar_carteira_padrao

    obter_ou_criar_carteira_padrao(db, carteira_id=1)

    # 1. Ativos de RV
    petr4 = Ativo(ticker="PETR4", nome="Petrobras PN", tipo=TipoAtivo.Acao)
    hglg11 = Ativo(ticker="HGLG11", nome="CSHG Logística", tipo=TipoAtivo.FII)
    btc = Ativo(ticker="BTC", nome="Bitcoin", tipo=TipoAtivo.Cripto)

    # 2. Ativo de RF com Detalhes
    cdb = Ativo(ticker="CDB-CDBC25AJ6NH", nome="CDB CDBC25AJ6NH", tipo=TipoAtivo.RendaFixa)
    db.add_all([petr4, hglg11, btc, cdb])
    db.flush()

    det_cdb = DetalhesRendaFixa(
        ativo_id=cdb.id,
        produto=ProdutoRendaFixa.CDB,
        indexador=Indexador.CDI,
        emissor="Banco XP",
    )
    db.add(det_cdb)

    # Transações
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
    # Verifica que RV continua intacta
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

    # Verifica que RF foi completamente excluída
    pos_cdb = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.carteira_id == 1, PosicaoConsolidada.ativo_id == cdb_id).first()
    assert pos_cdb is None
    txs_cdb = db.query(Transacao).filter(Transacao.carteira_id == 1, Transacao.ativo_id == cdb_id).all()
    assert len(txs_cdb) == 0
    detalhes_cdb = db.query(DetalhesRendaFixa).filter(DetalhesRendaFixa.ativo_id == cdb_id).first()
    assert detalhes_cdb is None
    cdb_db = db.query(Ativo).filter(Ativo.ticker == "CDB-CDBC25AJ6NH").first()
    assert cdb_db is None


def test_reconstrucao_completa_renda_fixa_2023_a_2026(db_session: Session):
    """
    Verifica a reconstituição completa da Renda Fixa com os 11 ativos reais (2023 a 2026):
    - Em Custódia Ativa (>0): EXATAMENTE 3 ativos (CDBC25AJ6NH, CDBC25C8TXM, TD-RENDA+-2065),
      total aportado = R$ 231.491,39.
    - Em Posições Encerradas (==0): 8 ativos com seus respectivos lucros realizados.
    - Idempotência: reimportação subsequente não duplica lotes nem altera posições.
    """
    db = db_session
    from app.services.portfolio import obter_ou_criar_carteira_padrao
    obter_ou_criar_carteira_padrao(db, carteira_id=1)

    linhas = [
        # 1. CDB-CDBC25AJ6NH: compra de 19.450.000 un e 2 resgates (332.874 e 280.887) -> saldo 18.836.239, lucro 459.89
        {"Data": "2025-12-19", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBC25AJ6NH", "Quantidade": 19450000, "Preço unitário": 0.01, "Valor da Operação": 194500.00, "Entrada/Saída": "Credito"},
        {"Data": "2026-06-15", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBC25AJ6NH", "Quantidade": 332874, "Preço unitário": 0.01066385, "Valor da Operação": 3549.72, "Entrada/Saída": "Debito"},
        {"Data": "2026-07-30", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBC25AJ6NH", "Quantidade": 280887, "Preço unitário": 0.01085056, "Valor da Operação": 3047.78, "Entrada/Saída": "Debito"},

        # 2. CDB-CDBC25C8TXM: compra de 5.000.017 un e 7 resgates -> saldo 1.847.008, lucro 2522.18
        {"Data": "2025-12-23", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBC25C8TXM", "Quantidade": 5000017, "Preço unitário": 0.01, "Valor da Operação": 50000.17, "Entrada/Saída": "Credito"},
        {"Data": "2026-06-03", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBC25C8TXM", "Quantidade": 143204, "Preço unitário": 0.01061241, "Valor da Operação": 1519.74, "Entrada/Saída": "Debito"},
        {"Data": "2026-06-08", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBC25C8TXM", "Quantidade": 524640, "Preço unitário": 0.01062370, "Valor da Operação": 5573.62, "Entrada/Saída": "Debito"},
        {"Data": "2026-06-08", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBC25C8TXM", "Quantidade": 476946, "Preço unitário": 0.01062372, "Valor da Operação": 5066.94, "Entrada/Saída": "Debito"},
        {"Data": "2026-08-11", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBC25C8TXM", "Quantidade": 497797, "Preço unitário": 0.01088395, "Valor da Operação": 5418.00, "Entrada/Saída": "Debito"},
        {"Data": "2026-08-13", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBC25C8TXM", "Quantidade": 867848, "Preço unitário": 0.01089521, "Valor da Operação": 9455.39, "Entrada/Saída": "Debito"},
        {"Data": "2026-08-17", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBC25C8TXM", "Quantidade": 596727, "Preço unitário": 0.01090648, "Valor da Operação": 6508.19, "Entrada/Saída": "Debito"},
        {"Data": "2026-10-14", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBC25C8TXM", "Quantidade": 45847, "Preço unitário": 0.01113246, "Valor da Operação": 510.39, "Entrada/Saída": "Debito"},

        # 3. TD-RENDA+-2065: 4 compras somando 140.33 un e R$ 24.658,92 -> saldo 140.33, lucro 0.00
        {"Data": "2026-01-26", "Movimentação": "Transferência - Liquidação", "Produto": "Tesouro RendA+ Aposentadoria Extra 2065", "Quantidade": 25.35, "Preço unitário": 185.02, "Valor da Operação": 4690.26, "Entrada/Saída": "Credito"},
        {"Data": "2026-03-25", "Movimentação": "Transferência - Liquidação", "Produto": "Tesouro RendA+ Aposentadoria Extra 2065", "Quantidade": 56.48, "Preço unitário": 177.03, "Valor da Operação": 9998.65, "Entrada/Saída": "Credito"},
        {"Data": "2026-06-09", "Movimentação": "Transferência - Liquidação", "Produto": "Tesouro RendA+ Aposentadoria Extra 2065", "Quantidade": 28.92, "Preço unitário": 172.89, "Valor da Operação": 5000.00, "Entrada/Saída": "Credito"},
        {"Data": "2026-07-31", "Movimentação": "Transferência - Liquidação", "Produto": "Tesouro RendA+ Aposentadoria Extra 2065", "Quantidade": 29.58, "Preço unitário": 168.02, "Valor da Operação": 4970.01, "Entrada/Saída": "Credito"},

        # 4. CDB-CDB223DOLTM: compra de 25 e Vencimento de 25 com PU=0 e Val=0 -> saldo 0, lucro 0.00
        {"Data": "2023-05-09", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDB223DOLTM", "Quantidade": 25, "Preço unitário": 1000.0, "Valor da Operação": 25000.0, "Entrada/Saída": "Credito"},
        {"Data": "2023-08-08", "Movimentação": "Vencimento", "Produto": "CDB - CDB223DOLTM", "Quantidade": 25, "Preço unitário": 0.0, "Valor da Operação": 0.0, "Entrada/Saída": "Debito"},

        # 5. CDB-CDB422A0GWW: compra de 4450 e 2 resgates -> saldo 0, lucro 30.50
        {"Data": "2023-09-19", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDB422A0GWW", "Quantidade": 4450, "Preço unitário": 1.12815281, "Valor da Operação": 5020.28, "Entrada/Saída": "Credito"},
        {"Data": "2023-10-05", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDB422A0GWW", "Quantidade": 3350, "Preço unitário": 1.13460896, "Valor da Operação": 3800.94, "Entrada/Saída": "Debito"},
        {"Data": "2023-10-10", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDB422A0GWW", "Quantidade": 1100, "Preço unitário": 1.13621818, "Valor da Operação": 1249.84, "Entrada/Saída": "Debito"},

        # 6. CDB-CDB422CKFIG: compras de 14933 e 12556, resgates somando 24619 e vencimento de 2870 -> saldo 0, lucro 310.85
        {"Data": "2023-10-20", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDB422CKFIG", "Quantidade": 14933, "Preço unitário": 1.13843836, "Valor da Operação": 17000.30, "Entrada/Saída": "Credito"},
        {"Data": "2023-11-03", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDB422CKFIG", "Quantidade": 8858, "Preço unitário": 1.14338903, "Valor da Operação": 10128.14, "Entrada/Saída": "Debito"},
        {"Data": "2023-11-23", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDB422CKFIG", "Quantidade": 2179, "Preço unitário": 1.15030748, "Valor da Operação": 2506.52, "Entrada/Saída": "Debito"},
        {"Data": "2023-12-08", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDB422CKFIG", "Quantidade": 955, "Preço unitário": 1.15618848, "Valor da Operação": 1104.16, "Entrada/Saída": "Debito"},
        {"Data": "2024-01-29", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDB422CKFIG", "Quantidade": 429, "Preço unitário": 1.17393939, "Valor da Operação": 503.62, "Entrada/Saída": "Debito"},
        {"Data": "2024-03-12", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDB422CKFIG", "Quantidade": 1275, "Preço unitário": 1.18866667, "Valor da Operação": 1515.55, "Entrada/Saída": "Debito"},
        {"Data": "2024-05-13", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDB422CKFIG", "Quantidade": 1237, "Preço unitário": 1.20942603, "Valor da Operação": 1496.06, "Entrada/Saída": "Debito"},
        {"Data": "2024-09-10", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDB422CKFIG", "Quantidade": 12556, "Preço unitário": 1.25828528, "Valor da Operação": 15799.03, "Entrada/Saída": "Credito"},
        {"Data": "2024-09-23", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDB422CKFIG", "Quantidade": 20, "Preço unitário": 1.26250000, "Valor da Operação": 25.25, "Entrada/Saída": "Debito"},
        {"Data": "2024-09-23", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDB422CKFIG", "Quantidade": 7892, "Preço unitário": 1.26285099, "Valor da Operação": 9966.42, "Entrada/Saída": "Debito"},
        {"Data": "2024-10-11", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDB422CKFIG", "Quantidade": 1774, "Preço unitário": 1.27011274, "Valor da Operação": 2253.18, "Entrada/Saída": "Debito"},
        {"Data": "2024-11-07", "Movimentação": "Vencimento", "Produto": "CDB - CDB422CKFIG", "Quantidade": 2870, "Preço unitário": 0.0, "Valor da Operação": 0.0, "Entrada/Saída": "Debito"},

        # 7. CDB-CDB422HCXRD: compra de 1985 e resgate de 1985 -> saldo 0, lucro 16.59
        {"Data": "2024-01-05", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDB422HCXRD", "Quantidade": 1985, "Preço unitário": 1.16083123, "Valor da Operação": 2304.25, "Entrada/Saída": "Credito"},
        {"Data": "2024-01-29", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDB422HCXRD", "Quantidade": 1985, "Preço unitário": 1.16918892, "Valor da Operação": 2320.84, "Entrada/Saída": "Debito"},

        # 8. CDB-CDB422R8SZO: compra de 17 e 2 resgates -> saldo 0, lucro 256.67
        {"Data": "2024-06-21", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDB422R8SZO", "Quantidade": 17, "Preço unitário": 1210.98470588, "Valor da Operação": 20586.74, "Entrada/Saída": "Credito"},
        {"Data": "2024-08-02", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDB422R8SZO", "Quantidade": 9, "Preço unitário": 1225.62111111, "Valor da Operação": 11030.59, "Entrada/Saída": "Debito"},
        {"Data": "2024-08-06", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDB422R8SZO", "Quantidade": 8, "Preço unitário": 1226.60250000, "Valor da Operação": 9812.82, "Entrada/Saída": "Debito"},

        # 9. CDB-CDBB2476LCB: compra de 90, resgates somando 78 e vencimento de 12 -> saldo 0, lucro 928.96
        {"Data": "2024-12-06", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBB2476LCB", "Quantidade": 90, "Preço unitário": 1005.40055556, "Valor da Operação": 90486.05, "Entrada/Saída": "Credito"},
        {"Data": "2024-12-20", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBB2476LCB", "Quantidade": 50, "Preço unitário": 1009.97560000, "Valor da Operação": 50498.78, "Entrada/Saída": "Debito"},
        {"Data": "2025-01-07", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBB2476LCB", "Quantidade": 13, "Preço unitário": 1014.72000000, "Valor da Operação": 13191.36, "Entrada/Saída": "Debito"},
        {"Data": "2025-01-09", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBB2476LCB", "Quantidade": 10, "Preço unitário": 1015.67100000, "Valor da Operação": 10156.71, "Entrada/Saída": "Debito"},
        {"Data": "2025-08-05", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBB2476LCB", "Quantidade": 2, "Preço unitário": 1095.80000000, "Valor da Operação": 2191.60, "Entrada/Saída": "Debito"},
        {"Data": "2025-08-22", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBB2476LCB", "Quantidade": 3, "Preço unitário": 1103.91666667, "Valor da Operação": 3311.75, "Entrada/Saída": "Debito"},
        {"Data": "2025-11-19", "Movimentação": "Vencimento", "Produto": "CDB - CDBB2476LCB", "Quantidade": 12, "Preço unitário": 0.0, "Valor da Operação": 0.0, "Entrada/Saída": "Debito"},

        # 10. CDB-CDBC251U1A1: compra de 1.500.000 e 3 resgates -> saldo 0, lucro 745.56
        {"Data": "2025-12-02", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBC251U1A1", "Quantidade": 1500000, "Preço unitário": 0.01, "Valor da Operação": 15000.00, "Entrada/Saída": "Credito"},
        {"Data": "2026-03-17", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBC251U1A1", "Quantidade": 135800, "Preço unitário": 0.01039904, "Valor da Operação": 1412.19, "Entrada/Saída": "Debito"},
        {"Data": "2026-03-24", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBC251U1A1", "Quantidade": 967931, "Preço unitário": 0.01042750, "Valor da Operação": 10093.10, "Entrada/Saída": "Debito"},
        {"Data": "2026-06-03", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBC251U1A1", "Quantidade": 396269, "Preço unitário": 0.01070048, "Valor da Operação": 4240.27, "Entrada/Saída": "Debito"},

        # 11. CDB-CDBC25AIK2H: compra de 450.000 e resgate de 450.000 -> saldo 0, lucro 57.40
        {"Data": "2025-12-19", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBC25AIK2H", "Quantidade": 450000, "Preço unitário": 0.01, "Valor da Operação": 4500.00, "Entrada/Saída": "Credito"},
        {"Data": "2026-01-23", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - CDBC25AIK2H", "Quantidade": 450000, "Preço unitário": 0.01012756, "Valor da Operação": 4557.40, "Entrada/Saída": "Debito"},
    ]

    df = pd.DataFrame(linhas)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as w:
        df.to_excel(w, index=False)
    file_bytes = buf.getvalue()

    # 1. Primeira importação
    res = processar_planilha_movimentacao_b3(db=db, file_content=file_bytes, carteira_id=1)
    assert len(res["transacoes"]) > 0

    from app.models.posicao import PosicaoConsolidada

    # 1. Validação dos 3 Ativos em Custódia Ativa
    pos_aj6 = db.query(PosicaoConsolidada).join(Ativo).filter(PosicaoConsolidada.carteira_id == 1, Ativo.ticker == "CDB-CDBC25AJ6NH").first()
    assert pos_aj6 is not None
    assert pos_aj6.quantidade_saldo == Decimal("18836239")
    assert pos_aj6.custo_total_brl == Decimal("188362.39")
    assert pos_aj6.lucro_realizado_brl == Decimal("459.89")

    pos_c8t = db.query(PosicaoConsolidada).join(Ativo).filter(PosicaoConsolidada.carteira_id == 1, Ativo.ticker == "CDB-CDBC25C8TXM").first()
    assert pos_c8t is not None
    assert pos_c8t.quantidade_saldo == Decimal("1847008")
    assert pos_c8t.custo_total_brl == Decimal("18470.08")
    assert pos_c8t.lucro_realizado_brl == Decimal("2522.18")

    pos_td = db.query(PosicaoConsolidada).join(Ativo).filter(PosicaoConsolidada.carteira_id == 1, Ativo.ticker == "TD-RENDA+-2065").first()
    assert pos_td is not None
    assert pos_td.quantidade_saldo == Decimal("140.33")
    assert pos_td.custo_total_brl == Decimal("24658.92")
    assert pos_td.lucro_realizado_brl == Decimal("0.00")

    # Montante total em custódia ativa = R$ 231.491,39
    total_custo_ativo = pos_aj6.custo_total_brl + pos_c8t.custo_total_brl + pos_td.custo_total_brl
    assert total_custo_ativo == Decimal("231491.39")

    # Garante que EXATAMENTE esses 3 ativos estão ativos em custódia (> 0)
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
    assert tickers_em_custodia == {"CDB-CDBC25AJ6NH", "CDB-CDBC25C8TXM", "TD-RENDA+-2065"}
    assert len(ativos_em_custodia) == 3

    # 2. Validação dos 8 Ativos Encerrados (saldo == 0)
    esperados_encerrados = {
        "CDB-CDB223DOLTM": Decimal("0.00"),
        "CDB-CDB422A0GWW": Decimal("30.50"),
        "CDB-CDB422CKFIG": Decimal("310.85"),
        "CDB-CDB422HCXRD": Decimal("16.59"),
        "CDB-CDB422R8SZO": Decimal("256.67"),
        "CDB-CDBB2476LCB": Decimal("928.96"),
        "CDB-CDBC251U1A1": Decimal("745.56"),
        "CDB-CDBC25AIK2H": Decimal("57.40"),
    }
    for ticker, lucro_esp in esperados_encerrados.items():
        pos = db.query(PosicaoConsolidada).join(Ativo).filter(PosicaoConsolidada.carteira_id == 1, Ativo.ticker == ticker).first()
        assert pos is not None, f"Posição para {ticker} não encontrada"
        assert pos.quantidade_saldo == Decimal("0"), f"{ticker} saldo esperado 0, obteve {pos.quantidade_saldo}"
        assert pos.lucro_realizado_brl == lucro_esp, f"{ticker} lucro esperado {lucro_esp}, obteve {pos.lucro_realizado_brl}"

    # 3. Idempotência: reimportar o mesmo arquivo NÃO duplica nem altera nada
    res_reimport = processar_planilha_movimentacao_b3(db=db, file_content=file_bytes, carteira_id=1)
    assert len(res_reimport["transacoes"]) == 0

    # Confirma que após reimportar, todos os saldos e custos continuam estritamente idênticos
    db.expire_all()
    pos_aj6_depois = db.query(PosicaoConsolidada).join(Ativo).filter(PosicaoConsolidada.carteira_id == 1, Ativo.ticker == "CDB-CDBC25AJ6NH").first()
    assert pos_aj6_depois.quantidade_saldo == Decimal("18836239")
    assert pos_aj6_depois.custo_total_brl == Decimal("188362.39")

    pos_c8t_depois = db.query(PosicaoConsolidada).join(Ativo).filter(PosicaoConsolidada.carteira_id == 1, Ativo.ticker == "CDB-CDBC25C8TXM").first()
    assert pos_c8t_depois.quantidade_saldo == Decimal("1847008")
    assert pos_c8t_depois.custo_total_brl == Decimal("18470.08")

    pos_td_depois = db.query(PosicaoConsolidada).join(Ativo).filter(PosicaoConsolidada.carteira_id == 1, Ativo.ticker == "TD-RENDA+-2065").first()
    assert pos_td_depois.quantidade_saldo == Decimal("140.33")
    assert pos_td_depois.custo_total_brl == Decimal("24658.92")


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

    # Importa planilha contendo a venda 1 (já no banco) e a venda 2 (nova, 40 unidades)
    linhas = [
        {"Data": "2023-06-01", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - TESTEPARCIAL", "Quantidade": 30, "Preço unitário": 1050.0, "Valor da Operação": 31500.0, "Entrada/Saída": "Debito"},
        {"Data": "2023-09-01", "Movimentação": "Transferência - Liquidação", "Produto": "CDB - TESTEPARCIAL", "Quantidade": 40, "Preço unitário": 1080.0, "Valor da Operação": 43200.0, "Entrada/Saída": "Debito"},
    ]
    df = pd.DataFrame(linhas)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as w:
        df.to_excel(w, index=False)

    res = processar_planilha_movimentacao_b3(db=db, file_content=buf.getvalue(), carteira_id=1)
    assert len(res["transacoes"]) == 1  # Apenas a nova venda de 40 unidades deve ser criada!
    assert res["transacoes"][0].quantidade == Decimal("40")

    db.expire_all()
    pos_final = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.carteira_id == 1, PosicaoConsolidada.ativo_id == ativo.id).first()
    assert pos_final.quantidade_saldo == Decimal("30")
    assert pos_final.custo_total_brl == Decimal("30000.00")
    assert pos_final.lucro_realizado_brl == Decimal("4700.00")  # (50 * 30) + (80 * 40) = 1500 + 3200 = 4700


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
    assert len(res["transacoes"]) == 0  # Deduplicado!

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

    # Transações em ambas as carteiras
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
    # Verifica que RF foi excluída de AMBAS as carteiras
    assert db.query(Transacao).filter(Transacao.ativo_id == rf_id).count() == 0
    assert db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == rf_id).count() == 0
    assert db.query(Ativo).filter(Ativo.id == rf_id).first() is None

    # Verifica que Ação continua intacta
    pos_acao = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.carteira_id == 1, PosicaoConsolidada.ativo_id == acao_id).first()
    assert pos_acao is not None
    assert pos_acao.quantidade_saldo == Decimal("100")






