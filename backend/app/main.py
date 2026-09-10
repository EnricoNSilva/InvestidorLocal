from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.db.session import engine, SessionLocal
from app.db.base import Base
from app.services.portfolio import obter_ou_criar_carteira_padrao
from app.api.v1.endpoints import health, ativos, transacoes, carteira, importacao

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Garante a criação de todas as tabelas no banco de dados SQLite
    Base.metadata.create_all(bind=engine)
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

@app.get("/", summary="Root status")
def root():
    return {
        "app": settings.PROJECT_NAME,
        "version": "1.0.0",
        "docs": f"{settings.API_V1_STR}/docs"
    }
