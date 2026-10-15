from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.db.session import engine, SessionLocal
from app.db.base import Base
from app.db.migrations import aplicar_migracoes_defensivas
from app.services.portfolio import obter_ou_criar_carteira_padrao
from app.api.v1.endpoints import health, ativos, transacoes, carteira, importacao, renda_fixa

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Garante a criação de todas as tabelas no banco de dados SQLite
    Base.metadata.create_all(bind=engine)

    # Migração defensiva de colunas (ex: taxa_contratada)
    db_path = None
    if engine.url.database and engine.url.database != ":memory:":
        try:
            db_path = Path(engine.url.database)
        except Exception:
            pass
    aplicar_migracoes_defensivas(engine, db_path)

    # Migração defensiva de índices em bancos SQLite já existentes
    with engine.connect() as conn:
        conn.exec_driver_sql("DROP INDEX IF EXISTS ix_posicoes_consolidadas_ativo_id")
        conn.exec_driver_sql("CREATE UNIQUE INDEX IF NOT EXISTS uq_posicao_carteira_ativo ON posicoes_consolidadas (carteira_id, ativo_id)")
        conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_posicoes_consolidadas_ativo_id ON posicoes_consolidadas (ativo_id)")
        conn.commit()

    # Garante a existência da carteira padrão inicial
    db = SessionLocal()
    try:
        obter_ou_criar_carteira_padrao(db, carteira_id=1, nome_padrao="Carteira Principal")
        db.commit()
    finally:
        db.close()
    yield

app = FastAPI(
    title=settings.PROJECT_NAME,
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
    docs_url=f"{settings.API_V1_STR}/docs",
    redoc_url=f"{settings.API_V1_STR}/redoc",
    lifespan=lifespan,
)

# 1. Configuração do CORSMiddleware liberando origens locais (ex: Angular http://localhost:4200)
if settings.BACKEND_CORS_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.BACKEND_CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# 2. Conexão dos roteadores da API v1
app.include_router(health.router, prefix=settings.API_V1_STR, tags=["Health"])
app.include_router(ativos.router, prefix=f"{settings.API_V1_STR}/ativos", tags=["Ativos"])
app.include_router(transacoes.router, prefix=f"{settings.API_V1_STR}/transacoes", tags=["Transações"])
app.include_router(carteira.router, prefix=f"{settings.API_V1_STR}/posicoes", tags=["Carteira / Posições"])
app.include_router(importacao.router, prefix=f"{settings.API_V1_STR}/importacao", tags=["Importação de Planilhas"])
app.include_router(renda_fixa.router, prefix=f"{settings.API_V1_STR}/renda-fixa", tags=["Renda Fixa"])

@app.get("/", summary="Root status")
def root():
    return {
        "app": settings.PROJECT_NAME,
        "version": "1.0.0",
        "docs": f"{settings.API_V1_STR}/docs"
    }
