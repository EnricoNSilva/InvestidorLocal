from datetime import datetime
from decimal import Decimal
from typing import Optional
from pydantic import BaseModel, ConfigDict, Field
from app.models.enums import TipoOperacao

class TransacaoBase(BaseModel):
    carteira_id: Optional[int] = Field(default=1, description="ID da carteira associada")
    ativo_id: int = Field(..., description="ID do ativo associado")
    data_hora: datetime = Field(default_factory=datetime.utcnow, description="Data e hora da execução da operação")
    tipo_operacao: TipoOperacao = Field(..., description="Tipo de operação: BUY, SELL, TRANSFERENCIA_ENTRADA")
    quantidade: Decimal = Field(..., gt=0, description="Quantidade negociada (positiva)")
    preco_unitario: Decimal = Field(..., gt=0, description="Preço unitário negociado")
    taxas: Decimal = Field(default=Decimal("0.0"), ge=0, description="Custos operacionais e taxas da transação")
    moeda: str = Field(default="BRL", max_length=10, description="Moeda da negociação")
    moeda_taxa: Optional[str] = Field(default="BRL", max_length=10, description="Moeda das taxas")
    ptax_utilizada: Optional[Decimal] = Field(default=None, description="Cotação PTAX utilizada para conversão em BRL")

class TransacaoCreate(TransacaoBase):
    pass

class TransacaoRead(TransacaoBase):
    id: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
