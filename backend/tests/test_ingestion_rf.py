import io
from decimal import Decimal
import pandas as pd
from sqlalchemy.orm import Session

from app.models.ativo import Ativo
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

