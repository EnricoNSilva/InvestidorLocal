"""Migrações aditivas e idempotentes para SQLite (sem Alembic)."""
import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

# (tabela, coluna, DDL do tipo). Somente operações ADITIVAS são permitidas aqui.
MIGRACOES_COLUNAS: tuple[tuple[str, str, str], ...] = (
    ("transacoes", "taxa_contratada", "NUMERIC(8, 4)"),
)


def _colunas_pendentes(engine: Engine) -> list[tuple[str, str, str]]:
    insp = inspect(engine)
    tabelas = set(insp.get_table_names())
    pendentes = []
    for tabela, coluna, ddl in MIGRACOES_COLUNAS:
        if tabela in tabelas and coluna not in {c["name"] for c in insp.get_columns(tabela)}:
            pendentes.append((tabela, coluna, ddl))
    return pendentes


def aplicar_migracoes_defensivas(engine: Engine, db_path: Optional[Path] = None) -> list[str]:
    """Executar DEPOIS de Base.metadata.create_all(engine).

    create_all cria tabelas novas (detalhes_renda_fixa), mas nunca altera tabelas existentes;
    esta função adiciona as colunas que faltam. É idempotente: a segunda chamada retorna [].
    """
    pendentes = _colunas_pendentes(engine)
    if not pendentes:
        return []
    if db_path is not None and db_path.exists():  # backup antes de qualquer ALTER
        shutil.copy2(db_path, db_path.with_suffix(f".db.bak-{datetime.now():%Y%m%d%H%M%S}"))
    aplicadas: list[str] = []
    with engine.begin() as conn:
        for tabela, coluna, ddl in pendentes:
            conn.execute(text(f'ALTER TABLE "{tabela}" ADD COLUMN "{coluna}" {ddl}'))
            aplicadas.append(f"{tabela}.{coluna}")
    return aplicadas
