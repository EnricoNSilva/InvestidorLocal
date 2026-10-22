from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.models.ativo import Ativo
from app.models.carteira import Carteira
from app.models.transacao import Transacao
from app.models.enums import TipoOperacao
from app.schemas.transacao import TransacaoCreate, TransacaoRead, TransacaoUpdate
from app.services.portfolio import processar_transacao, recalcular_posicoes_carteira, PortfolioError

router = APIRouter()

@router.get("", response_model=List[TransacaoRead], summary="Listar histórico de transações")
def listar_transacoes(
    carteira_id: Optional[int] = None,
    ativo_id: Optional[int] = None,
    tipo_operacao: Optional[TipoOperacao] = None,
    db: Session = Depends(get_db)
):
    query = db.query(Transacao).options(joinedload(Transacao.ativo))
    if carteira_id is not None:
        query = query.filter(Transacao.carteira_id == carteira_id)
    if ativo_id is not None:
        query = query.filter(Transacao.ativo_id == ativo_id)
    if tipo_operacao is not None:
        query = query.filter(Transacao.tipo_operacao == tipo_operacao)
    return query.order_by(Transacao.data_hora.desc(), Transacao.id.desc()).all()

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

@router.put("/{transacao_id}", response_model=TransacaoRead, summary="Editar transação existente com recálculo automático")
def atualizar_transacao(
    transacao_id: int,
    transacao_in: TransacaoUpdate,
    db: Session = Depends(get_db)
):
    tx = db.query(Transacao).filter(Transacao.id == transacao_id).first()
    if not tx:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Transação com ID {transacao_id} não encontrada."
        )

    cid_anterior = tx.carteira_id

    if transacao_in.carteira_id is not None:
        carteira = db.query(Carteira).filter(Carteira.id == transacao_in.carteira_id).first()
        if not carteira:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Carteira com ID {transacao_in.carteira_id} não encontrada."
            )
        tx.carteira_id = transacao_in.carteira_id

    if transacao_in.ativo_id is not None:
        ativo = db.query(Ativo).filter(Ativo.id == transacao_in.ativo_id).first()
        if not ativo:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Ativo com ID {transacao_in.ativo_id} não encontrado."
            )
        tx.ativo_id = transacao_in.ativo_id
    if transacao_in.data_hora is not None:
        tx.data_hora = transacao_in.data_hora
    if transacao_in.tipo_operacao is not None:
        tx.tipo_operacao = transacao_in.tipo_operacao
    if transacao_in.quantidade is not None:
        tx.quantidade = transacao_in.quantidade
    if transacao_in.preco_unitario is not None:
        tx.preco_unitario = transacao_in.preco_unitario
    if transacao_in.taxas is not None:
        tx.taxas = transacao_in.taxas
    if transacao_in.moeda is not None:
        tx.moeda = transacao_in.moeda
    if transacao_in.moeda_taxa is not None:
        tx.moeda_taxa = transacao_in.moeda_taxa
    if transacao_in.ptax_utilizada is not None:
        tx.ptax_utilizada = transacao_in.ptax_utilizada
    if transacao_in.taxa_contratada is not None:
        tx.taxa_contratada = transacao_in.taxa_contratada

    db.flush()

    recalcular_posicoes_carteira(db=db, carteira_id=tx.carteira_id)
    if cid_anterior != tx.carteira_id:
        recalcular_posicoes_carteira(db=db, carteira_id=cid_anterior)

    db.refresh(tx)
    return tx

@router.delete("/{transacao_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Excluir transação com recálculo automático")
def excluir_transacao(
    transacao_id: int,
    db: Session = Depends(get_db)
):
    tx = db.query(Transacao).filter(Transacao.id == transacao_id).first()
    if not tx:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Transação com ID {transacao_id} não encontrada."
        )

    cid = tx.carteira_id
    db.delete(tx)
    db.flush()

    recalcular_posicoes_carteira(db=db, carteira_id=cid)
    db.commit()
    return None
