import re
import unicodedata
from datetime import datetime, timezone
from decimal import Decimal
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
    CadastroManualRendaFixaRequest,
    CotacaoTesouroResponse,
    DetalhesRendaFixaRead,
    DetalhesRendaFixaUpsert,
    EnvelopeMercado,
    LoteManualCreate,
    LotesRendaFixaResponse,
    MacroResponse,
    PosicaoRendaFixaRead,
    TaxaContratadaPatch,
)
from app.schemas.transacao import TransacaoCreate, TransacaoRead
from app.services.portfolio import PortfolioError, processar_transacao
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


@router.post(
    "/cadastro-manual",
    response_model=PosicaoRendaFixaRead,
    status_code=status.HTTP_201_CREATED,
    summary="Cadastrar ativo de Renda Fixa manualmente e opcionalmente lote inicial",
)
def cadastrar_renda_fixa_manual(
    payload: CadastroManualRendaFixaRequest,
    db: Session = Depends(get_db),
):
    if payload.ticker and payload.ticker.strip():
        ticker = payload.ticker.strip().upper()
    else:
        prod_str = payload.detalhes.produto.value.replace("TESOURO_", "TD-")
        emissor_norm = (
            unicodedata.normalize("NFKD", payload.detalhes.emissor).encode("ASCII", "ignore").decode("ASCII")
        )
        emissor_slug = re.sub(r"[^A-Za-z0-9]", "", emissor_norm).upper() or "EMISSOR"
        date_slug = (
            payload.detalhes.data_vencimento.strftime("%Y%m%d")
            if payload.detalhes.data_vencimento
            else (str(payload.detalhes.ano_conversao) if payload.detalhes.ano_conversao else "PERP")
        )
        ticker = f"{prod_str}-{emissor_slug}-{date_slug}"[:30]

    ativo = db.query(Ativo).filter(Ativo.ticker == ticker).first()
    if ativo:
        if ativo.tipo != TipoAtivo.RendaFixa:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Ativo '{ticker}' já existe e não é do tipo RendaFixa",
            )
        ativo.nome = payload.nome.strip()
    else:
        ativo = Ativo(
            ticker=ticker,
            nome=payload.nome.strip(),
            tipo=TipoAtivo.RendaFixa,
            setor="Renda Fixa",
        )
        db.add(ativo)
        db.flush()

    dados = payload.detalhes.model_dump()
    if ativo.detalhes_rf:
        for k, v in dados.items():
            setattr(ativo.detalhes_rf, k, v)
    else:
        detalhes = DetalhesRendaFixa(ativo_id=ativo.id, **dados)
        db.add(detalhes)
        ativo.detalhes_rf = detalhes
    db.flush()

    carteira_id = 1
    if payload.lote_inicial:
        carteira_id = payload.lote_inicial.carteira_id
        tx_in = TransacaoCreate(
            carteira_id=carteira_id,
            ativo_id=ativo.id,
            data_hora=datetime.combine(payload.lote_inicial.data_compra, datetime.min.time(), tzinfo=timezone.utc),
            tipo_operacao=TipoOperacao.BUY,
            quantidade=payload.lote_inicial.quantidade,
            preco_unitario=payload.lote_inicial.preco_unitario,
            taxas=payload.lote_inicial.taxas or Decimal("0"),
            taxa_contratada=payload.lote_inicial.taxa_contratada,
            moeda="BRL",
            moeda_taxa="BRL",
            ptax_utilizada=Decimal("1.0"),
        )
        try:
            processar_transacao(db=db, transacao_in=tx_in)
        except PortfolioError as exc:
            db.rollback()
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    else:
        db.commit()
        db.refresh(ativo)

    posicoes = extrair_lotes_abertos(db=db, carteira_id=carteira_id, ativo_id=ativo.id)
    if not posicoes:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Posição não encontrada")
    return posicoes[0]


@router.post(
    "/ativos/{ativo_id}/lotes",
    response_model=PosicaoRendaFixaRead,
    status_code=status.HTTP_201_CREATED,
    summary="Adicionar lote manual a um ativo de Renda Fixa existente",
)
def adicionar_lote_manual(
    ativo_id: int,
    payload: LoteManualCreate,
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

    tx_in = TransacaoCreate(
        carteira_id=payload.carteira_id,
        ativo_id=ativo.id,
        data_hora=datetime.combine(payload.data_compra, datetime.min.time(), tzinfo=timezone.utc),
        tipo_operacao=TipoOperacao.BUY,
        quantidade=payload.quantidade,
        preco_unitario=payload.preco_unitario,
        taxas=payload.taxas or Decimal("0"),
        taxa_contratada=payload.taxa_contratada,
        moeda="BRL",
        moeda_taxa="BRL",
        ptax_utilizada=Decimal("1.0"),
    )
    try:
        processar_transacao(db=db, transacao_in=tx_in)
    except PortfolioError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    posicoes = extrair_lotes_abertos(db=db, carteira_id=payload.carteira_id, ativo_id=ativo.id)
    if not posicoes:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Posição não encontrada")
    return posicoes[0]


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
