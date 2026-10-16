from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Dict, List, Optional
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.ativo import Ativo
from app.models.enums import TipoAtivo, TipoOperacao
from app.models.transacao import Transacao
from app.schemas.renda_fixa import (
    AtivoRendaFixaRead,
    DetalhesRendaFixaRead,
    FluxoRecebidoRead,
    LoteAbertoRead,
    PosicaoRendaFixaRead,
)

ZERO = Decimal("0")
TIPOS_ENTRADA = {TipoOperacao.BUY, TipoOperacao.TRANSFERENCIA_ENTRADA, TipoOperacao.BONIFICACAO}
TIPOS_CAIXA = {TipoOperacao.AMORTIZACAO, TipoOperacao.JUROS_CUPOM}


@dataclass
class _LoteMutavel:
    transacao_id: int
    data_compra: date
    taxa_contratada: Optional[Decimal]
    preco_unitario_brl: Decimal
    taxa_unitaria_brl: Decimal  # taxas / quantidade_original (rateio na baixa parcial)
    quantidade_original: Decimal
    quantidade_aberta: Decimal
    custo_conhecido: bool       # False em TRANSFERENCIA_ENTRADA com PU 0


def extrair_lotes_abertos(db: Session, carteira_id: int, ativo_id: Optional[int] = None) -> List[PosicaoRendaFixaRead]:
    """PEPS/FIFO em Decimal (prec=28), ordenado por (data_hora, id) por ativo do tipo RendaFixa.

    - BUY / TRANSFERENCIA_ENTRADA / BONIFICACAO -> append no deque (PU convertido p/ BRL via ptax_utilizada)
    - SELL -> consome a partir do lote mais antigo; resto parcial preservado
    - AMORTIZACAO / JUROS_CUPOM -> vão para fluxos_recebidos (não mexem em quantidade)
    - SELL acima do saldo -> NÃO lança exceção; zera os lotes e registra uma pendência
    """
    stmt = (
        select(Transacao)
        .join(Ativo)
        .where(Transacao.carteira_id == carteira_id, Ativo.tipo == TipoAtivo.RendaFixa)
        .order_by(Transacao.ativo_id, Transacao.data_hora, Transacao.id)
        .options(selectinload(Transacao.ativo).selectinload(Ativo.detalhes_rf))
    )
    if ativo_id is not None:
        stmt = stmt.where(Transacao.ativo_id == ativo_id)

    txs = db.scalars(stmt).all()

    # Agrupa transações por ativo_id mantendo a ordem
    tx_por_ativo: Dict[int, List[Transacao]] = defaultdict(list)
    ativos_map: Dict[int, Ativo] = {}

    for tx in txs:
        tx_por_ativo[tx.ativo_id].append(tx)
        if tx.ativo_id not in ativos_map:
            ativos_map[tx.ativo_id] = tx.ativo

    # Se ativo_id específico foi solicitado e não tem transações, busca o ativo direto
    if ativo_id is not None and ativo_id not in ativos_map:
        ativo = (
            db.query(Ativo)
            .filter(Ativo.id == ativo_id, Ativo.tipo == TipoAtivo.RendaFixa)
            .options(selectinload(Ativo.detalhes_rf))
            .first()
        )
        if ativo:
            ativos_map[ativo.id] = ativo
            tx_por_ativo[ativo.id] = []

    posicoes: List[PosicaoRendaFixaRead] = []

    for at_id, lista_tx in tx_por_ativo.items():
        ativo = ativos_map[at_id]
        lotes_queue: deque[_LoteMutavel] = deque()
        fluxos: List[FluxoRecebidoRead] = []
        pendencias: List[str] = []

        for tx in lista_tx:
            fator_ptax = tx.ptax_utilizada if tx.ptax_utilizada is not None else Decimal("1.0")
            pu_brl = tx.preco_unitario * fator_ptax
            taxas_brl = (tx.taxas or ZERO) * fator_ptax
            tx_date = tx.data_hora.date() if isinstance(tx.data_hora, datetime) else tx.data_hora

            if tx.tipo_operacao in TIPOS_ENTRADA:
                taxa_unitaria = (taxas_brl / tx.quantidade) if tx.quantidade > ZERO else ZERO
                custo_conhecido = not (tx.tipo_operacao == TipoOperacao.TRANSFERENCIA_ENTRADA and pu_brl == ZERO)

                lote = _LoteMutavel(
                    transacao_id=tx.id,
                    data_compra=tx_date,
                    taxa_contratada=tx.taxa_contratada,
                    preco_unitario_brl=pu_brl,
                    taxa_unitaria_brl=taxa_unitaria,
                    quantidade_original=tx.quantidade,
                    quantidade_aberta=tx.quantidade,
                    custo_conhecido=custo_conhecido,
                )
                lotes_queue.append(lote)

            elif tx.tipo_operacao == TipoOperacao.SELL:
                qtd_a_vender = tx.quantidade
                valor_brl = (tx.quantidade * pu_brl) - taxas_brl
                fluxos.append(
                    FluxoRecebidoRead(
                        transacao_id=tx.id,
                        data=tx_date,
                        tipo="SELL",
                        valor_brl=valor_brl,
                    )
                )

                while qtd_a_vender > ZERO and lotes_queue:
                    oldest = lotes_queue[0]
                    if oldest.quantidade_aberta <= qtd_a_vender:
                        qtd_a_vender -= oldest.quantidade_aberta
                        lotes_queue.popleft()
                    else:
                        oldest.quantidade_aberta -= qtd_a_vender
                        qtd_a_vender = ZERO

                if qtd_a_vender > ZERO:
                    pendencias.append(
                        f"Venda de {tx.quantidade} em {tx_date} excedeu saldo disponível em {qtd_a_vender}"
                    )

            elif tx.tipo_operacao in TIPOS_CAIXA:
                valor_brl = tx.quantidade * pu_brl
                fluxos.append(
                    FluxoRecebidoRead(
                        transacao_id=tx.id,
                        data=tx_date,
                        tipo=tx.tipo_operacao.value,
                        valor_brl=valor_brl,
                    )
                )

        lotes_lidos: List[LoteAbertoRead] = []
        for lote in lotes_queue:
            custo_aberto = (lote.quantidade_aberta * lote.preco_unitario_brl) + (
                lote.quantidade_aberta * lote.taxa_unitaria_brl
            )
            if lote.taxa_contratada is None:
                pendencias.append(
                    f"Lote {lote.transacao_id} de {lote.data_compra} ({lote.quantidade_aberta} títulos) sem taxa_contratada informada"
                )
            if not lote.custo_conhecido:
                pendencias.append(
                    f"Lote {lote.transacao_id} de {lote.data_compra} ({lote.quantidade_aberta} títulos) com custo de aquisição não informado"
                )

            lotes_lidos.append(
                LoteAbertoRead(
                    transacao_id=lote.transacao_id,
                    data_compra=lote.data_compra,
                    taxa_contratada=lote.taxa_contratada,
                    preco_unitario=lote.preco_unitario_brl,
                    quantidade_original=lote.quantidade_original,
                    quantidade_aberta=lote.quantidade_aberta,
                    custo_aberto_brl=custo_aberto,
                    custo_conhecido=lote.custo_conhecido,
                )
            )

        qtd_total = sum((l.quantidade_aberta for l in lotes_lidos), Decimal("0"))
        custo_total = sum((l.custo_aberto_brl for l in lotes_lidos), Decimal("0"))

        posicao = PosicaoRendaFixaRead(
            ativo=AtivoRendaFixaRead.model_validate(ativo),
            lotes=lotes_lidos,
            fluxos_recebidos=fluxos,
            quantidade_total=qtd_total,
            custo_total_brl=custo_total,
            pendencias=pendencias,
        )
        posicoes.append(posicao)

    return posicoes
