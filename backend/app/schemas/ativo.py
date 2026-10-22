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
    cotacao_manual: Optional[Decimal] = Field(None, ge=0, description="Cotação manual de mercado em R$ (opcional)")

class AtivoCreate(AtivoBase):
    pass

class AtivoUpdate(BaseModel):
    ticker: Optional[str] = Field(None, min_length=1, max_length=30)
    nome: Optional[str] = Field(None, max_length=150)
    tipo: Optional[TipoAtivo] = None
    setor: Optional[str] = Field(None, max_length=100)
    cotacao_manual: Optional[Decimal] = Field(None, ge=0)

class CotacaoManualUpdate(BaseModel):
    cotacao_manual: Optional[Decimal] = Field(None, ge=0, description="Cotação manual de mercado em R$ (null para limpar)")

class ConversaoTickerRequest(BaseModel):
    novo_ticker: str = Field(..., min_length=2, max_length=30, description="Novo ticker de destino, ex: ISAE4")
    novo_nome: Optional[str] = Field(None, max_length=150)
    fator_conversao: Decimal = Field(default=Decimal("1.0"), gt=0, description="Fator multiplicador de quantidade (1.0 = 1 para 1)")
    cotacao_manual: Optional[Decimal] = Field(None, ge=0, description="Cotação manual de mercado em R$ (opcional)")

class AtivoRead(AtivoBase):
    id: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
