from datetime import datetime
from typing import Optional
from pydantic import BaseModel, ConfigDict, Field

class CarteiraBase(BaseModel):
    nome: str = Field(..., min_length=1, max_length=100, description="Nome da carteira, ex: Principal, Dividendos, Crypto")
    descricao: Optional[str] = Field(None, max_length=255, description="Descrição ou notas sobre a carteira")

class CarteiraCreate(CarteiraBase):
    pass

class CarteiraUpdate(BaseModel):
    nome: Optional[str] = Field(None, min_length=1, max_length=100)
    descricao: Optional[str] = Field(None, max_length=255)

class CarteiraRead(CarteiraBase):
    id: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
