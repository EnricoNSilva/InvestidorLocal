import sys
from pathlib import Path
from decimal import Decimal
from datetime import datetime, timezone

# Adiciona o diretório backend ao sys.path para importações relativas
BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

from app.db.base import Base
from app.db.session import engine, SessionLocal
from app.models import Ativo, Transacao, PosicaoConsolidada, TipoAtivo, TipoOperacao

def init_database():
    print("=" * 60)
    print("Iniciando banco de dados SQLite local...")
    print(f"URL de conexao: {engine.url}")
    print("=" * 60)

    # 1. Cria todas as tabelas mapeadas
    print("\n[1/3] Criando tabelas no banco de dados...")
    Base.metadata.create_all(bind=engine)
    from app.db.migrations import aplicar_migracoes_defensivas
    db_path = None
    if engine.url.database and engine.url.database != ":memory:":
        try:
            db_path = Path(engine.url.database)
        except Exception:
            pass
    aplicadas = aplicar_migracoes_defensivas(engine, db_path)
    if aplicadas:
        print(f"  Migrações defensivas aplicadas: {aplicadas}")
    print(" Tabelas criadas com sucesso:")
    for table_name in Base.metadata.tables.keys():
        print(f"  - {table_name}")

    # 2. Teste de inserção e precisão Decimal
    print("\n[2/3] Testando insercao com tipos Decimal (asdecimal=True)...")
    db = SessionLocal()
    try:
        # Verifica se ja existe o ativo de teste
        ticker_teste = "BTC"
        ativo = db.query(Ativo).filter(Ativo.ticker == ticker_teste).first()
        if not ativo:
            ativo = Ativo(
                ticker=ticker_teste,
                nome="Bitcoin",
                tipo=TipoAtivo.Cripto,
                setor="Criptomoedas"
            )
            db.add(ativo)
            db.flush()  # Obtem o ID gerado
            print(f"  Ativo inserido: {ativo.ticker} (ID: {ativo.id})")

            # Cria transação de teste com alta precisão decimal
            transacao = Transacao(
                ativo_id=ativo.id,
                data_hora=datetime.now(timezone.utc),
                tipo_operacao=TipoOperacao.BUY,
                quantidade=Decimal("0.04561234"),
                preco_unitario=Decimal("350000.50123456"),
                taxas=Decimal("15.25000000"),
                moeda="BRL",
                moeda_taxa="BRL",
                ptax_utilizada=None,
                taxa_contratada=None,
            )
            db.add(transacao)

            # Cria posição consolidada inicial de teste
            posicao = PosicaoConsolidada(
                ativo_id=ativo.id,
                quantidade_saldo=Decimal("0.04561234"),
                custo_total_brl=Decimal("15979.5700"),
                preco_medio_brl=Decimal("350335.25123456")
            )
            db.add(posicao)

            db.commit()
            print("  Transacao e PosicaoConsolidada de teste inseridas com sucesso.")
        else:
            print(f"  Ativo '{ticker_teste}' ja existe no banco de dados.")

        # Seed opcional e idempotente para TD-RENDA+-2065
        from datetime import date
        from app.models.enums import Indexador, ProdutoRendaFixa
        from app.models.renda_fixa import DetalhesRendaFixa
        ticker_rf = "TD-RENDA+-2065"
        ativo_rf = db.query(Ativo).filter(Ativo.ticker == ticker_rf).first()
        if not ativo_rf:
            ativo_rf = Ativo(
                ticker=ticker_rf,
                nome="Tesouro RendA+ Aposentadoria Extra 2065",
                tipo=TipoAtivo.RendaFixa,
                setor="Tesouro Direto",
            )
            db.add(ativo_rf)
            db.flush()
            detalhes_rf = DetalhesRendaFixa(
                ativo_id=ativo_rf.id,
                produto=ProdutoRendaFixa.TESOURO_RENDA_MAIS,
                indexador=Indexador.IPCA,
                emissor="Tesouro Nacional",
                data_vencimento=date(2084, 12, 15),
                ano_conversao=2065,
                num_parcelas=240,
                dia_pagamento=15,
                isento_ir=False,
                cobra_custodia_b3=True,
                codigo_mercado="tesouro-renda-mais-2065",
            )
            db.add(detalhes_rf)
            db.commit()
            print(f"  Ativo RF semeado: {ativo_rf.ticker} com DetalhesRendaFixa")
        else:
            print(f"  Ativo RF '{ticker_rf}' ja existe no banco de dados.")

        # 3. Consulta e validação de tipos Decimal
        print("\n[3/3] Validando tipos retornados pelo SQLAlchemy...")
        ativo_db = db.query(Ativo).filter(Ativo.ticker == ticker_teste).first()
        posicao_db = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == ativo_db.id).first()
        transacao_db = db.query(Transacao).filter(Transacao.ativo_id == ativo_db.id).first()

        assert isinstance(posicao_db.quantidade_saldo, Decimal), f"Tipo esperado Decimal, obtido {type(posicao_db.quantidade_saldo)}"
        assert isinstance(posicao_db.preco_medio_brl, Decimal), f"Tipo esperado Decimal, obtido {type(posicao_db.preco_medio_brl)}"
        assert isinstance(transacao_db.quantidade, Decimal), f"Tipo esperado Decimal, obtido {type(transacao_db.quantidade)}"
        assert transacao_db.moeda_taxa == "BRL", f"Moeda da taxa esperada BRL, obtido {transacao_db.moeda_taxa}"

        print(f"  Saldo: {posicao_db.quantidade_saldo} (tipo: {type(posicao_db.quantidade_saldo).__name__})")
        print(f"  Preco Medio: R$ {posicao_db.preco_medio_brl} (tipo: {type(posicao_db.preco_medio_brl).__name__})")
        print(f"  Moeda da Taxa: {transacao_db.moeda_taxa}")
        print("\n Todos os campos Numeric foram carregados com precisao nativa decimal.Decimal!")

    except Exception as exc:
        db.rollback()
        print(f"\n Erro durante inicializacao/teste: {exc}")
        raise exc
    finally:
        db.close()

    print("\nBanco de dados 'investimentos.db' inicializado e validado com sucesso!\n")

if __name__ == "__main__":
    init_database()
