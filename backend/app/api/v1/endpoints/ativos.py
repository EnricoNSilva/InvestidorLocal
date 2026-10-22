from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.ativo import Ativo
from app.models.enums import TipoAtivo
from app.schemas.ativo import (
    AtivoCreate,
    AtivoRead,
    AtivoUpdate,
    CotacaoManualUpdate,
    ConversaoTickerRequest,
)
from app.services.portfolio import converter_ativo_ticker, PortfolioError
from app.services.cotacoes import obter_cotacao_historica

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
        setor=ativo_in.setor.strip() if ativo_in.setor else None,
        cotacao_manual=ativo_in.cotacao_manual,
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

@router.put("/{ativo_id}", response_model=AtivoRead, summary="Atualizar ativo existente")
def atualizar_ativo(
    ativo_id: int,
    ativo_in: AtivoUpdate,
    db: Session = Depends(get_db)
):
    ativo = db.query(Ativo).filter(Ativo.id == ativo_id).first()
    if not ativo:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Ativo com ID {ativo_id} não encontrado."
        )

    if ativo_in.ticker is not None:
        ticker_formatado = ativo_in.ticker.strip().upper()
        if ticker_formatado != ativo.ticker:
            existente = db.query(Ativo).filter(Ativo.ticker == ticker_formatado, Ativo.id != ativo_id).first()
            if existente:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"Já existe outro ativo cadastrado com o ticker '{ticker_formatado}'."
                )
            ativo.ticker = ticker_formatado

    if ativo_in.nome is not None:
        ativo.nome = ativo_in.nome.strip()
    if ativo_in.tipo is not None:
        ativo.tipo = ativo_in.tipo
    if ativo_in.setor is not None:
        ativo.setor = ativo_in.setor.strip() if ativo_in.setor else None
    if ativo_in.cotacao_manual is not None:
        ativo.cotacao_manual = ativo_in.cotacao_manual

    db.commit()
    db.refresh(ativo)
    return ativo

@router.patch("/{ativo_id}/cotacao-manual", response_model=AtivoRead, summary="Definir ou limpar cotação manual do ativo")
def atualizar_cotacao_manual(
    ativo_id: int,
    payload: CotacaoManualUpdate,
    db: Session = Depends(get_db)
):
    ativo = db.query(Ativo).filter(Ativo.id == ativo_id).first()
    if not ativo:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Ativo com ID {ativo_id} não encontrado."
        )
    ativo.cotacao_manual = payload.cotacao_manual
    db.commit()
    db.refresh(ativo)
    return ativo

@router.delete("/{ativo_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Excluir ativo e suas transações/posições")
def excluir_ativo(
    ativo_id: int,
    db: Session = Depends(get_db)
):
    ativo = db.query(Ativo).filter(Ativo.id == ativo_id).first()
    if not ativo:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Ativo com ID {ativo_id} não encontrado."
        )
    db.delete(ativo)
    db.commit()
    return None

@router.post("/{ativo_id}/converter-ticker", response_model=AtivoRead, summary="Converter ou unificar ticker de ativo")
def converter_ticker(
    ativo_id: int,
    payload: ConversaoTickerRequest,
    db: Session = Depends(get_db)
):
    try:
        ativo_final = converter_ativo_ticker(db=db, ativo_id=ativo_id, payload=payload)
        return ativo_final
    except PortfolioError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc)
        )

@router.get("/{ativo_id}/cotacao-historica", summary="Obter cotação histórica de fechamento do ativo")
async def obter_cotacao_historica_endpoint(
    ativo_id: int,
    data: str = Query(..., description="Data no formato YYYY-MM-DD", pattern=r"^\d{4}-\d{2}-\d{2}$"),
    db: Session = Depends(get_db)
):
    ativo = db.query(Ativo).filter(Ativo.id == ativo_id).first()
    if not ativo:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Ativo com ID {ativo_id} não encontrado."
        )
    preco = await obter_cotacao_historica(ativo.ticker, data)
    return {
        "ativo_id": ativo.id,
        "ticker": ativo.ticker,
        "data": data,
        "cotacao_fechamento": preco,
    }
