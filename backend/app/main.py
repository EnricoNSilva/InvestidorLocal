from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.api.v1.endpoints import health, ativos, transacoes, carteira, importacao

app = FastAPI(
    title=settings.PROJECT_NAME,
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
    docs_url=f"{settings.API_V1_STR}/docs",
    redoc_url=f"{settings.API_V1_STR}/redoc",
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
