from datetime import datetime
from decimal import Decimal
from typing import Optional
from pydantic import BaseModel, ConfigDict, Field
from app.models.enums import TipoAtivo

class AtivoBase(BaseModel):
    ticker: str = Field(..., max_length=30, description="Ticker ou símbolo do ativo, ex: PETR4, HGLG11, BTC")
    nome: str = Field(..., max_length=150, description="Nome descritivo da empresa ou ativo")
    tipo: TipoAtivo = Field(..., description="Tipo do ativo: Acao, FII, Cripto, RendaFixa")
    setor: Optional[str] = Field(None, max_length=100, description="Setor de atuação")

class AtivoCreate(AtivoBase):
    pass

class AtivoUpdate(BaseModel):
    nome: Optional[str] = Field(None, max_length=150)
    tipo: Optional[TipoAtivo] = None
    setor: Optional[str] = Field(None, max_length=100)

class AtivoRead(AtivoBase):
    id: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
