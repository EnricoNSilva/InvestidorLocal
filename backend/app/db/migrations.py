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
    ("ativos", "cotacao_manual", "NUMERIC(24, 8)"),
    ("posicoes_consolidadas", "proventos_acumulados_brl", "NUMERIC(24, 4) NOT NULL DEFAULT 0.0"),
    ("posicoes_consolidadas", "lucro_realizado_brl", "NUMERIC(24, 4) NOT NULL DEFAULT 0.0"),
    ("posicoes_consolidadas", "quantidade_sem_custo", "NUMERIC(24, 8) NOT NULL DEFAULT 0.0"),
    ("posicoes_consolidadas", "valor_total_venda_brl", "NUMERIC(24, 4) NOT NULL DEFAULT 0.0"),
    ("posicoes_consolidadas", "custo_historico_brl", "NUMERIC(24, 4) NOT NULL DEFAULT 0.0"),
    ("posicoes_consolidadas", "lotes_pendentes_json", "TEXT"),
)


def _colunas_pendentes(engine: Engine) -> list[tuple[str, str, str]]:
    insp = inspect(engine)
    tabelas = set(insp.get_table_names())
    pendentes = []
    for tabela, coluna, ddl in MIGRACOES_COLUNAS:
        if tabela in tabelas and coluna not in {c["name"] for c in insp.get_columns(tabela)}:
            pendentes.append((tabela, coluna, ddl))
    return pendentes


def enriquecer_setores_ativos_defensivo(engine: Engine) -> int:
    """Preenche o setor de ativos que estejam com setor NULL, vazio ou 'Outros', usando classificador_setor."""
    from app.services.classificador_setor import obter_setor_padrao

    insp = inspect(engine)
    if "ativos" not in set(insp.get_table_names()):
        return 0

    atualizados = 0
    with engine.begin() as conn:
        rows = conn.execute(text("SELECT id, ticker, tipo, setor FROM ativos")).fetchall()
        for row in rows:
            ativo_id, ticker, tipo, setor_atual = row[0], row[1], row[2], row[3]
            if not setor_atual or setor_atual.strip() in ("", "Outros"):
                setor_sugerido = obter_setor_padrao(ticker, tipo)
                if setor_sugerido and setor_sugerido != "Outros":
                    conn.execute(
                        text('UPDATE "ativos" SET "setor" = :setor WHERE "id" = :id'),
                        {"setor": setor_sugerido, "id": ativo_id},
                    )
                    atualizados += 1
    return atualizados


def aplicar_migracoes_defensivas(engine: Engine, db_path: Optional[Path] = None) -> list[str]:
    """Executar DEPOIS de Base.metadata.create_all(engine).

    create_all cria tabelas novas (detalhes_renda_fixa), mas nunca altera tabelas existentes;
    esta função adiciona as colunas que faltam. É idempotente: a segunda chamada retorna [].
    """
    pendentes = _colunas_pendentes(engine)
    if not pendentes:
        enriquecer_setores_ativos_defensivo(engine)
        return []
    if db_path is not None and db_path.exists():  # backup antes de qualquer ALTER
        shutil.copy2(db_path, db_path.with_suffix(f".db.bak-{datetime.now():%Y%m%d%H%M%S}"))
    aplicadas: list[str] = []
    with engine.begin() as conn:
        for tabela, coluna, ddl in pendentes:
            conn.execute(text(f'ALTER TABLE "{tabela}" ADD COLUMN "{coluna}" {ddl}'))
            aplicadas.append(f"{tabela}.{coluna}")
    enriquecer_setores_ativos_defensivo(engine)
    return aplicadas
