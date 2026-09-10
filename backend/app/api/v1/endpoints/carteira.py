from typing import List, Optional
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.models.posicao import PosicaoConsolidada
from app.schemas.posicao import PosicaoConsolidadaRead

router = APIRouter()

@router.get("", response_model=List[PosicaoConsolidadaRead], summary="Listar posições consolidadas da carteira")
def listar_posicoes(
    somente_com_saldo: bool = True,
    db: Session = Depends(get_db)
):
    """
    Retorna a lista consolidada de ativos com ticker, quantidade em custódia,
    custo total acumulado em BRL e Preço Médio Ponderado Móvel (CMPM).
    Por padrão retorna apenas ativos com saldo > 0.
    """
    query = db.query(PosicaoConsolidada).options(joinedload(PosicaoConsolidada.ativo))
    if somente_com_saldo:
        query = query.filter(PosicaoConsolidada.quantidade_saldo > 0)
    return query.all()
