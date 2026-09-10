from datetime import datetime
from decimal import Decimal, getcontext
from typing import List, Optional
from collections import defaultdict
from sqlalchemy.orm import Session

from app.models.ativo import Ativo
from app.models.carteira import Carteira
from app.models.transacao import Transacao
from app.models.posicao import PosicaoConsolidada
from app.models.enums import TipoOperacao
from app.schemas.transacao import TransacaoCreate

# Contexto de alta precisão decimal
getcontext().prec = 28

ZERO = Decimal("0.0")

class PortfolioError(Exception):
    """Exceção para erros de regras de negócio do portfólio."""
    pass

def obter_ou_criar_carteira_padrao(db: Session, carteira_id: int = 1, nome_padrao: str = "Carteira Principal") -> Carteira:
    """Garante que a carteira solicitada ou a carteira padrão ID=1 exista no banco."""
    carteira = db.query(Carteira).filter(Carteira.id == carteira_id).first()
    if not carteira:
        carteira = Carteira(id=carteira_id, nome=nome_padrao, descricao="Carteira inicial padrão")
        db.add(carteira)
        db.flush()
    return carteira

def processar_transacao(db: Session, transacao_in: TransacaoCreate) -> Transacao:
    """
    Processa uma transação financeira inserindo a entidade Transacao.
    Atualiza a posição incrementalmente e comita a alteração.
    """
    ativo = db.query(Ativo).filter(Ativo.id == transacao_in.ativo_id).first()
    if not ativo:
        raise PortfolioError(f"Ativo com ID {transacao_in.ativo_id} não encontrado.")

    cid = transacao_in.carteira_id if transacao_in.carteira_id is not None else 1
    carteira = db.query(Carteira).filter(Carteira.id == cid).first()
    if not carteira:
        carteira = obter_ou_criar_carteira_padrao(db, carteira_id=cid)

    # 1. Cria a entidade Transacao vinculada à carteira
    db_transacao = Transacao(
        carteira_id=carteira.id,
        ativo_id=transacao_in.ativo_id,
        data_hora=transacao_in.data_hora,
        tipo_operacao=transacao_in.tipo_operacao,
        quantidade=transacao_in.quantidade,
        preco_unitario=transacao_in.preco_unitario,
        taxas=transacao_in.taxas,
        moeda=transacao_in.moeda,
        moeda_taxa=transacao_in.moeda_taxa,
        ptax_utilizada=transacao_in.ptax_utilizada,
    )
    db.add(db_transacao)

    # 2. Busca ou cria PosicaoConsolidada para este ativo e esta carteira
    posicao = (
        db.query(PosicaoConsolidada)
        .filter(
            PosicaoConsolidada.carteira_id == carteira.id,
            PosicaoConsolidada.ativo_id == transacao_in.ativo_id
        )
        .first()
    )
    if not posicao:
        posicao = PosicaoConsolidada(
            carteira_id=carteira.id,
            ativo_id=transacao_in.ativo_id,
            quantidade_saldo=ZERO,
            custo_total_brl=ZERO,
            preco_medio_brl=ZERO,
        )
        db.add(posicao)

    fator_ptax = transacao_in.ptax_utilizada if transacao_in.ptax_utilizada is not None else Decimal("1.0")

    if transacao_in.tipo_operacao in (
        TipoOperacao.BUY,
        TipoOperacao.TRANSFERENCIA_ENTRADA,
        TipoOperacao.BONIFICACAO,
        TipoOperacao.DIREITO_SUBSCRICAO
    ):
        custo_operacao = (transacao_in.quantidade * transacao_in.preco_unitario) * fator_ptax + (transacao_in.taxas or ZERO)
        novo_saldo = posicao.quantidade_saldo + transacao_in.quantidade
        novo_custo_total = posicao.custo_total_brl + custo_operacao

        posicao.quantidade_saldo = novo_saldo
        posicao.custo_total_brl = novo_custo_total
        if novo_saldo > ZERO and novo_custo_total > ZERO:
            posicao.preco_medio_brl = novo_custo_total / novo_saldo
        else:
            posicao.preco_medio_brl = ZERO

    elif transacao_in.tipo_operacao == TipoOperacao.DIREITO_SUBSCRICAO_EXPIRADO:
        novo_saldo = max(ZERO, posicao.quantidade_saldo - transacao_in.quantidade)
        if novo_saldo <= ZERO:
            posicao.quantidade_saldo = ZERO
            posicao.custo_total_brl = ZERO
            posicao.preco_medio_brl = ZERO
        else:
            posicao.quantidade_saldo = novo_saldo
            if posicao.custo_total_brl > ZERO and novo_saldo > ZERO:
                posicao.preco_medio_brl = posicao.custo_total_brl / novo_saldo
            else:
                posicao.preco_medio_brl = ZERO

    elif transacao_in.tipo_operacao == TipoOperacao.SELL:
        if transacao_in.quantidade > posicao.quantidade_saldo:
            raise PortfolioError(
                f"Saldo insuficiente na carteira '{carteira.nome}' para venda de {ativo.ticker}. "
                f"Saldo disponível: {posicao.quantidade_saldo}, Quantidade solicitada: {transacao_in.quantidade}"
            )

        custo_baixa = transacao_in.quantidade * posicao.preco_medio_brl
        novo_saldo = posicao.quantidade_saldo - transacao_in.quantidade
        novo_custo_total = max(ZERO, posicao.custo_total_brl - custo_baixa)

        if novo_saldo <= ZERO:
            posicao.quantidade_saldo = ZERO
            posicao.custo_total_brl = ZERO
            posicao.preco_medio_brl = ZERO
        else:
            posicao.quantidade_saldo = novo_saldo
            posicao.custo_total_brl = novo_custo_total
            if novo_custo_total > ZERO:
                posicao.preco_medio_brl = novo_custo_total / novo_saldo
            else:
                posicao.preco_medio_brl = ZERO

    posicao.data_atualizacao = datetime.utcnow()

    db.commit()
    db.refresh(db_transacao)
    db.refresh(posicao)

    return db_transacao

def recalcular_posicoes_carteira(db: Session, carteira_id: int) -> None:
    """
    Recalcula integralmente todas as posições consolidadas de uma carteira
    reprocessando todas as suas transações em ordem cronológica estrita.
    Garante idempotência, consolidação exata de Movimentação + Negociação e
    independência total da ordem em que os arquivos foram enviados.
    """
    transacoes = (
        db.query(Transacao)
        .filter(Transacao.carteira_id == carteira_id)
        .all()
    )

    def _op_priority(tipo: TipoOperacao) -> int:
        if tipo in (TipoOperacao.TRANSFERENCIA_ENTRADA, TipoOperacao.BONIFICACAO, TipoOperacao.DIREITO_SUBSCRICAO):
            return 0
        elif tipo == TipoOperacao.BUY:
            return 1
        else:
            return 2

    tx_por_ativo = defaultdict(list)
    for tx in transacoes:
        tx_por_ativo[tx.ativo_id].append(tx)

    posicoes_existentes = {
        p.ativo_id: p
        for p in db.query(PosicaoConsolidada).filter(PosicaoConsolidada.carteira_id == carteira_id).all()
    }

    for ativo_id, lista_tx in tx_por_ativo.items():
        lista_tx.sort(key=lambda t: (t.data_hora or datetime.min, _op_priority(t.tipo_operacao)))

        saldo = ZERO
        custo_total = ZERO
        preco_medio = ZERO

        for tx in lista_tx:
            fator_ptax = tx.ptax_utilizada if tx.ptax_utilizada is not None else Decimal("1.0")

            if tx.tipo_operacao in (
                TipoOperacao.BUY,
                TipoOperacao.TRANSFERENCIA_ENTRADA,
                TipoOperacao.BONIFICACAO,
                TipoOperacao.DIREITO_SUBSCRICAO,
            ):
                custo_op = (tx.quantidade * tx.preco_unitario) * fator_ptax + (tx.taxas or ZERO)
                saldo += tx.quantidade
                custo_total += custo_op
                if saldo > ZERO and custo_total > ZERO:
                    preco_medio = custo_total / saldo
                else:
                    preco_medio = ZERO

            elif tx.tipo_operacao == TipoOperacao.DIREITO_SUBSCRICAO_EXPIRADO:
                saldo = max(ZERO, saldo - tx.quantidade)
                if saldo <= ZERO:
                    saldo = ZERO
                    custo_total = ZERO
                    preco_medio = ZERO
                else:
                    if custo_total > ZERO and saldo > ZERO:
                        preco_medio = custo_total / saldo
                    else:
                        preco_medio = ZERO

            elif tx.tipo_operacao == TipoOperacao.SELL:
                custo_baixa = tx.quantidade * preco_medio
                saldo = max(ZERO, saldo - tx.quantidade)
                custo_total = max(ZERO, custo_total - custo_baixa)
                if saldo <= ZERO:
                    saldo = ZERO
                    custo_total = ZERO
                    preco_medio = ZERO
                else:
                    if custo_total > ZERO and saldo > ZERO:
                        preco_medio = custo_total / saldo
                    else:
                        preco_medio = ZERO

        posicao = posicoes_existentes.get(ativo_id)
        if not posicao:
            posicao = PosicaoConsolidada(
                carteira_id=carteira_id,
                ativo_id=ativo_id,
                quantidade_saldo=saldo,
                custo_total_brl=custo_total,
                preco_medio_brl=preco_medio,
            )
            db.add(posicao)
            posicoes_existentes[ativo_id] = posicao
        else:
            posicao.quantidade_saldo = saldo
            posicao.custo_total_brl = custo_total
            posicao.preco_medio_brl = preco_medio
            posicao.data_atualizacao = datetime.utcnow()

    # Se algum ativo não possui mais transações nesta carteira, remove a posição
    for ativo_id, pos in posicoes_existentes.items():
        if ativo_id not in tx_por_ativo:
            db.delete(pos)

    db.commit()
