from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.ativo import Ativo
from app.models.enums import TipoAtivo
from app.schemas.ativo import AtivoCreate, AtivoRead

router = APIRouter()

@router.get("", response_model=List[AtivoRead], summary="Listar todos os ativos cadastrados")
def listar_ativos(
    tipo: Optional[TipoAtivo] = None,
    db: Session = Depends(get_db)
):
    query = db.query(Ativo)
    if tipo:
        query = query.filter(Ativo.tipo == tipo)
    return query.order_by(Ativo.ticker.asc()).all()

@router.post("", response_model=AtivoRead, status_code=status.HTTP_201_CREATED, summary="Cadastrar novo ativo")
def criar_ativo(
    ativo_in: AtivoCreate,
    db: Session = Depends(get_db)
):
    ticker_formatado = ativo_in.ticker.strip().upper()
    ativo_existente = db.query(Ativo).filter(Ativo.ticker == ticker_formatado).first()
    if ativo_existente:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Ativo com o ticker '{ticker_formatado}' já está cadastrado."
        )

    db_ativo = Ativo(
        ticker=ticker_formatado,
        nome=ativo_in.nome.strip(),
        tipo=ativo_in.tipo,
        setor=ativo_in.setor.strip() if ativo_in.setor else None
    )
    db.add(db_ativo)
    db.commit()
    db.refresh(db_ativo)
    return db_ativo

@router.get("/{ativo_id}", response_model=AtivoRead, summary="Obter detalhes de um ativo específico")
def obter_ativo(
    ativo_id: int,
    db: Session = Depends(get_db)
):
    ativo = db.query(Ativo).filter(Ativo.id == ativo_id).first()
    if not ativo:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Ativo com ID {ativo_id} não encontrado."
        )
    return ativo
