from datetime import datetime, timezone
from decimal import Decimal
from sqlalchemy.orm import Session

from app.models.ativo import Ativo
from app.models.carteira import Carteira
from app.models.enums import TipoAtivo, TipoOperacao, ProdutoRendaFixa, Indexador
from app.models.renda_fixa import DetalhesRendaFixa
from app.models.transacao import Transacao
from app.schemas.transacao import TransacaoCreate
from app.services.portfolio import processar_transacao
from app.services.renda_fixa.lotes import extrair_lotes_abertos


def test_peps_renda_fixa_compras_e_baixa_parcial(db_session: Session):
    db = db_session

    carteira = Carteira(id=1, nome="Carteira Principal")
    db.add(carteira)

    ativo = Ativo(
        ticker="TD-RENDA+-2065",
        nome="Tesouro RendA+ Aposentadoria Extra 2065",
        tipo=TipoAtivo.RendaFixa,
        setor="Tesouro Direto",
    )
    db.add(ativo)
    db.flush()

    detalhes = DetalhesRendaFixa(
        ativo_id=ativo.id,
        produto=ProdutoRendaFixa.TESOURO_RENDA_MAIS,
        indexador=Indexador.IPCA,
        emissor="Tesouro Nacional",
        ano_conversao=2065,
        num_parcelas=240,
        dia_pagamento=15,
    )
    db.add(detalhes)
    db.commit()

    # 1. Quatro compras cronológicas com as taxas pactuadas: 6.99, 7.14, 7.27, 7.37
    compras = [
        (datetime(2024, 1, 10, 10, 0, tzinfo=timezone.utc), Decimal("10.0"), Decimal("200.00"), Decimal("2.00"), Decimal("6.9900")),
        (datetime(2024, 2, 10, 10, 0, tzinfo=timezone.utc), Decimal("15.0"), Decimal("210.00"), Decimal("3.00"), Decimal("7.1400")),
        (datetime(2024, 3, 10, 10, 0, tzinfo=timezone.utc), Decimal("20.0"), Decimal("220.00"), Decimal("4.00"), Decimal("7.2700")),
        (datetime(2024, 4, 10, 10, 0, tzinfo=timezone.utc), Decimal("25.0"), Decimal("230.00"), Decimal("5.00"), Decimal("7.3700")),
    ]

    for dt, qtd, pu, taxa, rate in compras:
        tx_in = TransacaoCreate(
            carteira_id=1,
            ativo_id=ativo.id,
            data_hora=dt,
            tipo_operacao=TipoOperacao.BUY,
            quantidade=qtd,
            preco_unitario=pu,
            taxas=taxa,
            moeda="BRL",
            ptax_utilizada=None,
            taxa_contratada=rate,
        )
        processar_transacao(db=db, transacao_in=tx_in)

    # 2. Venda parcial de 16 unidades:
    # Consome o Lote 1 inteiro (10 un) e 6 un do Lote 2 (restando 9 un abertas no Lote 2)
    venda_in = TransacaoCreate(
        carteira_id=1,
        ativo_id=ativo.id,
        data_hora=datetime(2024, 5, 10, 10, 0, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.SELL,
        quantidade=Decimal("16.0"),
        preco_unitario=Decimal("250.00"),
        taxas=Decimal("0.0"),
        moeda="BRL",
        ptax_utilizada=None,
    )
    processar_transacao(db=db, transacao_in=venda_in)

    # 3. Executa a extração PEPS
    posicoes = extrair_lotes_abertos(db=db, carteira_id=1, ativo_id=ativo.id)
    assert len(posicoes) == 1
    pos = posicoes[0]

    # Devem restar 3 lotes abertos (Lote 2 parcial, Lote 3 e Lote 4 intactos)
    assert len(pos.lotes) == 3

    lote2 = pos.lotes[0]
    assert lote2.taxa_contratada == Decimal("7.1400")
    assert lote2.quantidade_original == Decimal("15.0")
    assert lote2.quantidade_aberta == Decimal("9.0")
    assert lote2.preco_unitario == Decimal("210.00")
    # Custo aberto Lote 2: 9 * 210 + 9 * (3 / 15) = 1890 + 1.80 = 1891.80
    assert lote2.custo_aberto_brl == Decimal("1891.80")

    lote3 = pos.lotes[1]
    assert lote3.taxa_contratada == Decimal("7.2700")
    assert lote3.quantidade_original == Decimal("20.0")
    assert lote3.quantidade_aberta == Decimal("20.0")
    # Custo aberto Lote 3: 20 * 220 + 20 * (4 / 20) = 4400 + 4 = 4404.00
    assert lote3.custo_aberto_brl == Decimal("4404.00")

    lote4 = pos.lotes[2]
    assert lote4.taxa_contratada == Decimal("7.3700")
    assert lote4.quantidade_original == Decimal("25.0")
    assert lote4.quantidade_aberta == Decimal("25.0")
    # Custo aberto Lote 4: 25 * 230 + 25 * (5 / 25) = 5750 + 5 = 5755.00
    assert lote4.custo_aberto_brl == Decimal("5755.00")

    # Totais
    assert pos.quantidade_total == Decimal("54.0")
    assert pos.custo_total_brl == Decimal("12050.80")
    assert len(pos.fluxos_recebidos) == 1
    assert pos.fluxos_recebidos[0].tipo == "SELL"
    assert pos.fluxos_recebidos[0].valor_brl == Decimal("4000.00")
    assert pos.pendencias == []

    # 4. Venda acima do saldo: venda de 60 unidades quando só restam 54
    # Não lança exceção em extrair_lotes_abertos e registra pendência
    venda_excedente = Transacao(
        carteira_id=1,
        ativo_id=ativo.id,
        data_hora=datetime(2024, 6, 10, 10, 0, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.SELL,
        quantidade=Decimal("60.0"),
        preco_unitario=Decimal("260.00"),
        taxas=Decimal("0.0"),
        moeda="BRL",
    )
    db.add(venda_excedente)
    db.commit()

    posicoes_pos = extrair_lotes_abertos(db=db, carteira_id=1, ativo_id=ativo.id)
    assert len(posicoes_pos) == 1
    pos_pos = posicoes_pos[0]

    assert pos_pos.quantidade_total == Decimal("0")
    assert pos_pos.custo_total_brl == Decimal("0")
    assert len(pos_pos.lotes) == 0
    assert any("excedeu saldo" in p for p in pos_pos.pendencias)


def test_peps_lote_custo_desconhecido_gera_pendencia(db_session: Session):
    db = db_session
    carteira = Carteira(id=2, nome="Carteira Transferencia")
    db.add(carteira)

    ativo = Ativo(
        ticker="TD-RENDA+-2065-CUSTO",
        nome="Tesouro RendA+ Aposentadoria Extra 2065",
        tipo=TipoAtivo.RendaFixa,
    )
    db.add(ativo)
    db.flush()

    # Transferência de entrada com preço zero (custo não conhecido)
    tx = Transacao(
        carteira_id=2,
        ativo_id=ativo.id,
        data_hora=datetime(2024, 1, 15, 10, 0, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.TRANSFERENCIA_ENTRADA,
        quantidade=Decimal("10.0"),
        preco_unitario=Decimal("0.0"),
        taxas=Decimal("0.0"),
        moeda="BRL",
        taxa_contratada=Decimal("6.9900"),
    )
    db.add(tx)
    db.commit()

    posicoes = extrair_lotes_abertos(db=db, carteira_id=2, ativo_id=ativo.id)
    assert len(posicoes) == 1
    pos = posicoes[0]
    assert len(pos.lotes) == 1
    lote = pos.lotes[0]
    assert lote.custo_conhecido is False
    assert any("custo de aquisição não informado" in p for p in pos.pendencias)


def test_peps_venda_com_taxas_descontadas_do_fluxo(db_session: Session):
    db = db_session
    carteira = Carteira(id=3, nome="Carteira Venda Taxas")
    db.add(carteira)

    ativo = Ativo(
        ticker="TD-RENDA+-2065-TAXAS",
        nome="Tesouro RendA+ Aposentadoria Extra 2065",
        tipo=TipoAtivo.RendaFixa,
    )
    db.add(ativo)
    db.flush()

    # Compra 10 unidades a R$ 200 com taxa R$ 2.00
    tx_buy = Transacao(
        carteira_id=3,
        ativo_id=ativo.id,
        data_hora=datetime(2024, 1, 10, 10, 0, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.BUY,
        quantidade=Decimal("10.0"),
        preco_unitario=Decimal("200.00"),
        taxas=Decimal("2.00"),
        moeda="BRL",
        taxa_contratada=Decimal("6.50"),
    )
    db.add(tx_buy)

    # Venda de 5 unidades a R$ 250 com taxa R$ 15.00
    tx_sell = Transacao(
        carteira_id=3,
        ativo_id=ativo.id,
        data_hora=datetime(2024, 2, 10, 10, 0, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.SELL,
        quantidade=Decimal("5.0"),
        preco_unitario=Decimal("250.00"),
        taxas=Decimal("15.00"),
        moeda="BRL",
    )
    db.add(tx_sell)
    db.commit()

    posicoes = extrair_lotes_abertos(db=db, carteira_id=3, ativo_id=ativo.id)
    assert len(posicoes) == 1
    pos = posicoes[0]

    # Verifica fluxo de SELL: valor_brl deve ser (5.0 * 250.00) - 15.00 = 1250.00 - 15.00 = 1235.00
    assert len(pos.fluxos_recebidos) == 1
    fluxo = pos.fluxos_recebidos[0]
    assert fluxo.tipo == "SELL"
    assert fluxo.valor_brl == Decimal("1235.00")

    # Venda adicional de 2 unidades a R$ 260.00 sem taxas (taxas=None)
    tx_sell2 = Transacao(
        carteira_id=3,
        ativo_id=ativo.id,
        data_hora=datetime(2024, 3, 10, 10, 0, tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.SELL,
        quantidade=Decimal("2.0"),
        preco_unitario=Decimal("260.00"),
        taxas=None,
        moeda="BRL",
    )
    db.add(tx_sell2)
    db.commit()

    posicoes2 = extrair_lotes_abertos(db=db, carteira_id=3, ativo_id=ativo.id)
    assert len(posicoes2) == 1
    pos2 = posicoes2[0]
    assert len(pos2.fluxos_recebidos) == 2
    fluxo2 = pos2.fluxos_recebidos[1]
    assert fluxo2.tipo == "SELL"
    # (2.0 * 260.00) - 0 = 520.00
    assert fluxo2.valor_brl == Decimal("520.00")

