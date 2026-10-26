from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.models.carteira import Carteira
from app.models.posicao import PosicaoConsolidada
from app.models.ativo import Ativo
from app.models.enums import TipoAtivo
from app.models.transacao import Transacao
from app.models.renda_fixa import DetalhesRendaFixa
from app.schemas.carteira import CarteiraCreate, CarteiraRead, CarteiraUpdate
from app.schemas.posicao import (
    PosicaoConsolidadaRead,
    AjusteManualPosicaoRequest,
    CotacoesCarteiraResponse,
    ProventosAnuaisCarteiraResponse,
)
from app.services.portfolio import (
    obter_ou_criar_carteira_padrao,
    recalcular_posicoes_carteira,
    ajustar_posicao_manual,
    calcular_proventos_anuais_carteira,
    PortfolioError,
)
from app.services.cotacoes import obter_cotacoes_carteira

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

@router.post("/carteiras/{carteira_id}/limpar", status_code=status.HTTP_200_OK, summary="Limpar histórico e posições de uma carteira")
def limpar_carteira(
    carteira_id: int,
    db: Session = Depends(get_db)
):
    carteira = db.query(Carteira).filter(Carteira.id == carteira_id).first()
    if not carteira:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Carteira com ID {carteira_id} não encontrada."
        )

    carteira.transacoes.clear()
    carteira.posicoes.clear()
    db.commit()
    return {"status": "success", "mensagem": f"Histórico e posições da carteira '{carteira.nome}' foram zerados com sucesso."}

@router.post("/carteiras/{carteira_id}/recalcular", status_code=status.HTTP_200_OK, summary="Recalcular posições consolidadas da carteira")
def recalcular_carteira(
    carteira_id: int,
    db: Session = Depends(get_db)
):
    carteira = db.query(Carteira).filter(Carteira.id == carteira_id).first()
    if not carteira:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Carteira com ID {carteira_id} não encontrada."
        )
    recalcular_posicoes_carteira(db=db, carteira_id=carteira_id)
    return {"status": "success", "mensagem": f"Posições da carteira '{carteira.nome}' recalculadas com sucesso."}

# --- Endpoint de Posições Consolidadas ---

@router.get("", response_model=List[PosicaoConsolidadaRead], summary="Listar posições consolidadas por carteira")
def listar_posicoes(
    carteira_id: Optional[int] = None,
    somente_com_saldo: bool = True,
    db: Session = Depends(get_db)
):
    """
    Retorna a lista consolidada de ativos com ticker, quantidade em custódia,
    custo total acumulado em BRL e Preço Médio Ponderado Móvel (CMPM),
    enriquecendo ativos Cripto com dados de Autocustódia, Earn, USD e RFB.
    """
    query = db.query(PosicaoConsolidada).options(joinedload(PosicaoConsolidada.ativo))
    if carteira_id is not None:
        query = query.filter(PosicaoConsolidada.carteira_id == carteira_id)
    if somente_com_saldo:
        query = query.filter(PosicaoConsolidada.quantidade_saldo > 0)

    posicoes = query.all()
    cid = carteira_id or 1

    import json
    from decimal import Decimal
    from app.services.cotacoes import CACHE_DIR
    meta_path = CACHE_DIR / f"binance_metadata_{cid}.json"
    binance_meta = {}
    if meta_path.exists():
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                binance_meta = json.load(f)
        except Exception as e:
            pass

    custodia_map = binance_meta.get("custodia_detalhada", {})

    resultado: List[PosicaoConsolidadaRead] = []
    for p in posicoes:
        p_read = PosicaoConsolidadaRead.model_validate(p)
        ticker = p.ativo.ticker if p.ativo else ""
        if ticker in custodia_map:
            c_info = custodia_map[ticker]
            p_read.preco_medio_usd = Decimal(str(c_info["preco_medio_usd"])) if c_info.get("preco_medio_usd") is not None else None
            p_read.custo_total_usd = Decimal(str(c_info["custo_total_usd"])) if c_info.get("custo_total_usd") is not None else None
            p_read.quantidade_vendida = Decimal(str(c_info["quantidade_vendida"])) if c_info.get("quantidade_vendida") is not None else None
            p_read.custo_vendas_brl = Decimal(str(c_info["custo_vendas_brl"])) if c_info.get("custo_vendas_brl") is not None else None
            p_read.valor_total_vendas_brl = Decimal(str(c_info["valor_total_vendas_brl"])) if c_info.get("valor_total_vendas_brl") is not None else None
            p_read.qtd_earn = Decimal(str(c_info["qtd_earn"])) if c_info.get("qtd_earn") is not None else None
            p_read.qtd_autocustodia = Decimal(str(c_info["qtd_autocustodia"])) if c_info.get("qtd_autocustodia") is not None else None
            p_read.pct_earn = Decimal(str(c_info["pct_earn"])) if c_info.get("pct_earn") is not None else None
            p_read.pct_autocustodia = Decimal(str(c_info["pct_autocustodia"])) if c_info.get("pct_autocustodia") is not None else None
            p_read.earn_interest_moeda = Decimal(str(c_info["earn_interest_moeda"])) if c_info.get("earn_interest_moeda") is not None else None
            p_read.codigo_rfb_irpf = c_info.get("codigo_rfb_irpf")
            p_read.texto_irpf = c_info.get("texto_irpf")
        elif p.ativo and p.ativo.tipo == TipoAtivo.Cripto:
            p_read.codigo_rfb_irpf = "08/01" if ticker == "BTC" else "08/02"
        resultado.append(p_read)

    return resultado

@router.get("/cotacoes", response_model=CotacoesCarteiraResponse, summary="Obter cotações B3/Cripto com cache para a carteira")
async def obter_cotacoes(
    carteira_id: int = 1,
    forcar: bool = False,
    db: Session = Depends(get_db)
):
    return await obter_cotacoes_carteira(db=db, carteira_id=carteira_id, forcar=forcar)

@router.get("/proventos-anuais", response_model=ProventosAnuaisCarteiraResponse, summary="Obter detalhamento anual de proventos por empresa")
def obter_proventos_anuais(
    carteira_id: int = 1,
    ativo_id: Optional[int] = None,
    somente_em_custodia: bool = False,
    db: Session = Depends(get_db)
):
    """
    Retorna o total anual e percentual recebido de Dividendos vs. JCP (e Rendimentos)
    por empresa ano a ano (2022, 2023, 2024, etc.).
    """
    return calcular_proventos_anuais_carteira(
        db=db,
        carteira_id=carteira_id,
        ativo_id=ativo_id,
        somente_em_custodia=somente_em_custodia,
    )

@router.put(
    "/carteiras/{carteira_id}/ativos/{ativo_id}/ajuste-manual",
    response_model=PosicaoConsolidadaRead,
    summary="Ajuste manual idempotente de posição, preço médio e proventos",
)
def ajustar_posicao(
    carteira_id: int,
    ativo_id: int,
    payload: AjusteManualPosicaoRequest,
    db: Session = Depends(get_db)
):
    try:
        posicao = ajustar_posicao_manual(
            db=db,
            carteira_id=carteira_id,
            ativo_id=ativo_id,
            payload=payload,
        )
        if not posicao:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Posição para ativo ID {ativo_id} na carteira {carteira_id} não encontrada."
            )
        return posicao
    except PortfolioError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc)
        )

@router.post(
    "/carteiras/{carteira_id}/resetar-renda-fixa",
    status_code=status.HTTP_200_OK,
    summary="Excluir unicamente ativos, posições, transações e detalhes de Renda Fixa da carteira",
)
def resetar_renda_fixa_carteira(
    carteira_id: int,
    todas_carteiras: bool = False,
    db: Session = Depends(get_db),
):
    carteira = db.query(Carteira).filter(Carteira.id == carteira_id).first()
    if not carteira and not todas_carteiras:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Carteira com ID {carteira_id} não encontrada.",
        )

    rf_ativos = db.query(Ativo).filter(Ativo.tipo == TipoAtivo.RendaFixa).all()
    rf_ids = [a.id for a in rf_ativos]

    if rf_ids:
        if todas_carteiras:
            db.query(Transacao).filter(Transacao.ativo_id.in_(rf_ids)).delete(synchronize_session=False)
            db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id.in_(rf_ids)).delete(synchronize_session=False)
            db.query(DetalhesRendaFixa).filter(DetalhesRendaFixa.ativo_id.in_(rf_ids)).delete(synchronize_session=False)
            for a in rf_ativos:
                db.delete(a)
        else:
            db.query(Transacao).filter(
                Transacao.carteira_id == carteira_id,
                Transacao.ativo_id.in_(rf_ids),
            ).delete(synchronize_session=False)

            db.query(PosicaoConsolidada).filter(
                PosicaoConsolidada.carteira_id == carteira_id,
                PosicaoConsolidada.ativo_id.in_(rf_ids),
            ).delete(synchronize_session=False)

            # Deleta DetalhesRendaFixa e Ativo se não houver mais transações ou posições em nenhuma carteira
            for a in rf_ativos:
                restante_tx = db.query(Transacao).filter(Transacao.ativo_id == a.id).count()
                restante_pos = db.query(PosicaoConsolidada).filter(PosicaoConsolidada.ativo_id == a.id).count()
                if restante_tx == 0 and restante_pos == 0:
                    db.query(DetalhesRendaFixa).filter(DetalhesRendaFixa.ativo_id == a.id).delete(synchronize_session=False)
                    db.delete(a)

    if todas_carteiras:
        for c in db.query(Carteira).all():
            recalcular_posicoes_carteira(db=db, carteira_id=c.id)
    else:
        recalcular_posicoes_carteira(db=db, carteira_id=carteira_id)
    db.commit()

    return {
        "status": "success",
        "carteira_id": carteira_id,
        "mensagem": f"Renda Fixa resetada com sucesso para a carteira '{carteira.nome if carteira else carteira_id}'. Renda Variável (Ações, FIIs e Cripto) permaneceu 100% intocada.",
    }

