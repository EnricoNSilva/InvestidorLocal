from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session, selectinload

from app.db.session import get_db
from app.models.ativo import Ativo
from app.models.enums import Indexador, TipoAtivo, TipoOperacao
from app.models.renda_fixa import DetalhesRendaFixa
from app.models.transacao import Transacao
from app.schemas.renda_fixa import (
    AtivoRendaFixaRead,
    CotacaoTesouroResponse,
    DetalhesRendaFixaRead,
    DetalhesRendaFixaUpsert,
    EnvelopeMercado,
    LotesRendaFixaResponse,
    MacroResponse,
    TaxaContratadaPatch,
)
from app.schemas.transacao import TransacaoRead
from app.services.renda_fixa.lotes import extrair_lotes_abertos
from app.services.renda_fixa.mercado import obter_cotacoes_tesouro, obter_dados_macro

router = APIRouter()


@router.get("/ativos", response_model=List[AtivoRendaFixaRead], summary="Listar ativos de Renda Fixa")
def listar_ativos_rf(
    indexador: Optional[Indexador] = Query(None, description="Filtrar por indexador"),
    db: Session = Depends(get_db),
):
    query = (
        db.query(Ativo)
        .filter(Ativo.tipo == TipoAtivo.RendaFixa)
        .options(selectinload(Ativo.detalhes_rf))
    )
    if indexador is not None:
        query = query.join(Ativo.detalhes_rf).filter(DetalhesRendaFixa.indexador == indexador)
    return query.order_by(Ativo.ticker).all()


@router.put("/ativos/{ativo_id}/detalhes", response_model=DetalhesRendaFixaRead, summary="Upsert de detalhes de Renda Fixa")
def upsert_detalhes_rf(
    ativo_id: int,
    payload: DetalhesRendaFixaUpsert,
    db: Session = Depends(get_db),
):
    ativo = db.query(Ativo).filter(Ativo.id == ativo_id).first()
    if not ativo:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Ativo ID {ativo_id} não encontrado")
    if ativo.tipo != TipoAtivo.RendaFixa:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Operação permitida exclusivamente para ativos do tipo RendaFixa",
        )

    dados = payload.model_dump()
    if ativo.detalhes_rf:
        for k, v in dados.items():
            setattr(ativo.detalhes_rf, k, v)
        detalhes = ativo.detalhes_rf
    else:
        detalhes = DetalhesRendaFixa(ativo_id=ativo.id, **dados)
        db.add(detalhes)

    db.commit()
    db.refresh(detalhes)
    return DetalhesRendaFixaRead.model_validate(detalhes)


@router.get("/lotes", response_model=LotesRendaFixaResponse, summary="Obter lotes abertos PEPS e fluxos recebidos")
def obter_lotes_peps(
    carteira_id: int = Query(1, description="ID da carteira"),
    ativo_id: Optional[int] = Query(None, description="Filtrar por ativo específico"),
    db: Session = Depends(get_db),
):
    posicoes = extrair_lotes_abertos(db=db, carteira_id=carteira_id, ativo_id=ativo_id)
    return LotesRendaFixaResponse(
        carteira_id=carteira_id,
        gerado_em=datetime.now(timezone.utc),
        posicoes=posicoes,
    )


@router.patch("/transacoes/{transacao_id}/taxa", response_model=TransacaoRead, summary="Atualizar taxa contratada de um lote")
def atualizar_taxa_contratada(
    transacao_id: int,
    payload: TaxaContratadaPatch,
    db: Session = Depends(get_db),
):
    tx = db.query(Transacao).filter(Transacao.id == transacao_id).first()
    if not tx:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Transação {transacao_id} não encontrada")

    if tx.ativo.tipo != TipoAtivo.RendaFixa:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Só é permitida taxa contratada em ativos de Renda Fixa",
        )

    if tx.tipo_operacao not in (TipoOperacao.BUY, TipoOperacao.TRANSFERENCIA_ENTRADA):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Só é permitida taxa contratada em transações de compra ou entrada",
        )

    tx.taxa_contratada = payload.taxa_contratada
    db.commit()
    db.refresh(tx)
    return TransacaoRead.model_validate(tx)


@router.get("/mercado/tesouro", response_model=EnvelopeMercado[CotacaoTesouroResponse], summary="Proxy de cotações do Tesouro Direto")
async def proxy_mercado_tesouro(
    forcar: bool = Query(False, description="Forçar busca da rede ignorando cache"),
):
    return await obter_cotacoes_tesouro(forcar=forcar)


@router.get("/mercado/macro", response_model=MacroResponse, summary="Indicadores macroeconômicos (SGS BCB: IPCA, Selic, CDI)")
async def proxy_mercado_macro(
    forcar: bool = Query(False, description="Forçar busca da rede ignorando cache"),
):
    return await obter_dados_macro(forcar=forcar)
