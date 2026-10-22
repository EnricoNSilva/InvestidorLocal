from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional
from pydantic import BaseModel, ConfigDict, Field
from app.models.enums import TipoOperacao
from app.schemas.ativo import AtivoRead

class TransacaoBase(BaseModel):
    carteira_id: Optional[int] = Field(default=1, description="ID da carteira associada")
    ativo_id: int = Field(..., description="ID do ativo associado")
    data_hora: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), description="Data e hora da execução da operação")
    tipo_operacao: TipoOperacao = Field(..., description="Tipo de operação: BUY, SELL, TRANSFERENCIA_ENTRADA")
    quantidade: Decimal = Field(..., gt=0, description="Quantidade negociada (positiva)")
    preco_unitario: Decimal = Field(..., ge=0, description="Preço unitário negociado")
    taxas: Decimal = Field(default=Decimal("0.0"), ge=0, description="Custos operacionais e taxas da transação")
    moeda: str = Field(default="BRL", max_length=10, description="Moeda da negociação")
    moeda_taxa: Optional[str] = Field(default="BRL", max_length=10, description="Moeda das taxas")
    ptax_utilizada: Optional[Decimal] = Field(default=None, description="Cotação PTAX utilizada para conversão em BRL")
    taxa_contratada: Optional[Decimal] = Field(
        default=None,
        ge=Decimal("-10"),
        le=Decimal("1000"),
        max_digits=8,
        decimal_places=4,
        description="% a.a. (IPCA+/Pré) ou % do CDI (pós). Só tem efeito em BUY/TRANSFERENCIA_ENTRADA de ativos RF.",
    )

class TransacaoCreate(TransacaoBase):
    pass

class TransacaoUpdate(BaseModel):
    carteira_id: Optional[int] = None
    ativo_id: Optional[int] = None
    data_hora: Optional[datetime] = None
    tipo_operacao: Optional[TipoOperacao] = None
    quantidade: Optional[Decimal] = Field(None, gt=0)
    preco_unitario: Optional[Decimal] = Field(None, ge=0)
    taxas: Optional[Decimal] = Field(None, ge=0)
    moeda: Optional[str] = Field(None, max_length=10)
    moeda_taxa: Optional[str] = Field(None, max_length=10)
    ptax_utilizada: Optional[Decimal] = None
    taxa_contratada: Optional[Decimal] = Field(None, ge=Decimal("-10"), le=Decimal("1000"))

class TransacaoRead(TransacaoBase):
    id: int
    created_at: datetime
    ativo: Optional[AtivoRead] = None

    model_config = ConfigDict(from_attributes=True)
