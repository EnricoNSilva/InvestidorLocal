from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.models.carteira import Carteira
from app.models.posicao import PosicaoConsolidada
from app.schemas.carteira import CarteiraCreate, CarteiraRead, CarteiraUpdate
from app.schemas.posicao import PosicaoConsolidadaRead
from app.services.portfolio import obter_ou_criar_carteira_padrao

router = APIRouter()

# --- Endpoints de Gerenciamento de Carteiras ---

@router.get("/carteiras", response_model=List[CarteiraRead], summary="Listar todas as carteiras")
def listar_carteiras(db: Session = Depends(get_db)):
    carteiras = db.query(Carteira).order_by(Carteira.id.asc()).all()
    if not carteiras:
        # Cria carteira inicial se o banco estiver vazio
        c_padrao = obter_ou_criar_carteira_padrao(db, carteira_id=1, nome_padrao="Carteira Principal")
        db.commit()
        db.refresh(c_padrao)
        carteiras = [c_padrao]
    return carteiras

@router.post("/carteiras", response_model=CarteiraRead, status_code=status.HTTP_201_CREATED, summary="Criar nova carteira")
def criar_carteira(
    carteira_in: CarteiraCreate,
    db: Session = Depends(get_db)
):
    nome_formatado = carteira_in.nome.strip()
    existente = db.query(Carteira).filter(Carteira.nome == nome_formatado).first()
    if existente:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Já existe uma carteira com o nome '{nome_formatado}'."
        )

    nova_carteira = Carteira(
        nome=nome_formatado,
        descricao=carteira_in.descricao.strip() if carteira_in.descricao else None
    )
    db.add(nova_carteira)
    db.commit()
    db.refresh(nova_carteira)
    return nova_carteira

@router.delete("/carteiras/{carteira_id}", status_code=status.HTTP_200_OK, summary="Excluir carteira e suas posições/transações")
def excluir_carteira(
    carteira_id: int,
    db: Session = Depends(get_db)
):
    carteira = db.query(Carteira).filter(Carteira.id == carteira_id).first()
    if not carteira:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Carteira com ID {carteira_id} não encontrada."
        )

    # Não permitir excluir se for a única carteira
    total = db.query(Carteira).count()
    if total <= 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Não é possível excluir a única carteira do sistema. Crie outra carteira antes de excluir esta."
        )

    db.delete(carteira)
    db.commit()
    return {"status": "success", "mensagem": f"Carteira '{carteira.nome}' excluída com sucesso."}

# --- Endpoint de Posições Consolidadas ---

@router.get("", response_model=List[PosicaoConsolidadaRead], summary="Listar posições consolidadas por carteira")
def listar_posicoes(
    carteira_id: Optional[int] = None,
    somente_com_saldo: bool = True,
    db: Session = Depends(get_db)
):
    """
    Retorna a lista consolidada de ativos com ticker, quantidade em custódia,
    custo total acumulado em BRL e Preço Médio Ponderado Móvel (CMPM).
    Permite filtrar por carteira_id (padrão: carteira principal ou primeira encontrada).
    """
    query = db.query(PosicaoConsolidada).options(joinedload(PosicaoConsolidada.ativo))
    if carteira_id is not None:
        query = query.filter(PosicaoConsolidada.carteira_id == carteira_id)
    if somente_com_saldo:
        query = query.filter(PosicaoConsolidada.quantidade_saldo > 0)
    return query.all()
