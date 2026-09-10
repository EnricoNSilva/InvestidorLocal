from datetime import datetime
from decimal import Decimal
from typing import Optional
from pydantic import BaseModel, ConfigDict, Field
from app.schemas.ativo import AtivoRead

class PosicaoConsolidadaBase(BaseModel):
    carteira_id: int = Field(default=1, description="ID da carteira associada")
    ativo_id: int = Field(..., description="ID do ativo associado")
    quantidade_saldo: Decimal = Field(..., description="Saldo de custódia consolidado")
    custo_total_brl: Decimal = Field(..., description="Custo acumulado total de aquisição em BRL")
    preco_medio_brl: Decimal = Field(..., description="Preço médio unitário ponderado móvel em BRL")

class PosicaoConsolidadaRead(PosicaoConsolidadaBase):
    id: int
    data_atualizacao: datetime
    ativo: Optional[AtivoRead] = None

    model_config = ConfigDict(from_attributes=True)
