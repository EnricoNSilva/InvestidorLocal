from pathlib import Path
from sqlalchemy import create_engine, inspect, text
from app.db.base import Base
from app.db.migrations import aplicar_migracoes_defensivas


def test_migracao_defensiva_idempotente(tmp_path: Path):
    db_file = tmp_path / "schema_antigo.db"
    temp_engine = create_engine(f"sqlite:///{db_file.as_posix()}")

    # 1. Cria schema antigo sem taxa_contratada e sem detalhes_renda_fixa
    with temp_engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE ativos (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ticker VARCHAR(30) NOT NULL UNIQUE,
                    nome VARCHAR(150) NOT NULL,
                    tipo VARCHAR(20) NOT NULL,
                    setor VARCHAR(100),
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL
                )
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE TABLE carteiras (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    nome VARCHAR(100) NOT NULL,
                    descricao VARCHAR(255),
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL
                )
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE TABLE transacoes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    carteira_id INTEGER NOT NULL,
                    ativo_id INTEGER NOT NULL,
                    data_hora DATETIME NOT NULL,
                    tipo_operacao VARCHAR(30) NOT NULL,
                    quantidade NUMERIC(24, 8) NOT NULL,
                    preco_unitario NUMERIC(24, 8) NOT NULL,
                    taxas NUMERIC(18, 8) NOT NULL,
                    moeda VARCHAR(10) NOT NULL,
                    moeda_taxa VARCHAR(10),
                    ptax_utilizada NUMERIC(18, 6),
                    created_at DATETIME NOT NULL
                )
                """
            )
        )

    # Verifica estado pré-migração
    insp_inicial = inspect(temp_engine)
    assert "detalhes_renda_fixa" not in insp_inicial.get_table_names()
    colunas_tx_inicial = {c["name"] for c in insp_inicial.get_columns("transacoes")}
    assert "taxa_contratada" not in colunas_tx_inicial

    # 2. Executa create_all (cria detalhes_renda_fixa) e aplicar_migracoes_defensivas (adiciona taxa_contratada)
    Base.metadata.create_all(bind=temp_engine)
    aplicadas = aplicar_migracoes_defensivas(temp_engine, db_path=db_file)

    assert "transacoes.taxa_contratada" in aplicadas

    # Verifica se taxa_contratada foi adicionada e detalhes_renda_fixa criada
    insp_pos = inspect(temp_engine)
    assert "detalhes_renda_fixa" in insp_pos.get_table_names()
    colunas_tx_pos = {c["name"] for c in insp_pos.get_columns("transacoes")}
    assert "taxa_contratada" in colunas_tx_pos

    # Verifica se arquivo de backup foi gerado antes do ALTER TABLE
    backups = list(tmp_path.glob("schema_antigo.db.bak-*"))
    assert len(backups) == 1

    # 3. Segunda execução deve ser estritamente idempotente (retornar [])
    aplicadas_segunda_vez = aplicar_migracoes_defensivas(temp_engine, db_path=db_file)
    assert aplicadas_segunda_vez == []
