from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.transacao import Transacao
from app.schemas.transacao import TransacaoCreate, TransacaoRead
from app.services.portfolio import processar_transacao, PortfolioError

router = APIRouter()

@router.get("", response_model=List[TransacaoRead], summary="Listar histórico de transações")
def listar_transacoes(
    ativo_id: Optional[int] = None,
    db: Session = Depends(get_db)
):
    query = db.query(Transacao)
    if ativo_id is not None:
        query = query.filter(Transacao.ativo_id == ativo_id)
    return query.order_by(Transacao.data_hora.desc()).all()

@router.post("", response_model=TransacaoRead, status_code=status.HTTP_201_CREATED, summary="Registrar e processar transação")
def registrar_transacao(
    transacao_in: TransacaoCreate,
    db: Session = Depends(get_db)
):
    try:
        return processar_transacao(db=db, transacao_in=transacao_in)
    except PortfolioError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc)
        )
