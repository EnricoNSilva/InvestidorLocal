from datetime import datetime
from decimal import Decimal, getcontext
from sqlalchemy.orm import Session

from app.models.ativo import Ativo
from app.models.transacao import Transacao
from app.models.posicao import PosicaoConsolidada
from app.models.enums import TipoOperacao
from app.schemas.transacao import TransacaoCreate

# Garantir contexto de alta precisão decimal
getcontext().prec = 28

ZERO = Decimal("0.0")

class PortfolioError(Exception):
    """Exceção para erros de regras de negócio do portfólio."""
    pass

def processar_transacao(db: Session, transacao_in: TransacaoCreate) -> Transacao:
    """
    Processa uma transação financeira de compra ou venda com atomicidade:
    1. Valida a existência do ativo.
    2. Insere a nova transação no banco.
    3. Busca ou inicializa a PosicaoConsolidada do ativo correspondente.
    4. Se BUY:
       - Incrementa quantidade_saldo.
       - Calcula custo da operação em BRL (incluindo taxas e eventual PTAX).
       - Soma ao custo_total_brl.
       - Recalcula preco_medio_brl = custo_total_brl / quantidade_saldo.
    5. Se SELL:
       - Valida se há saldo suficiente para a venda.
       - Calcula custo_baixa = quantidade * preco_medio_brl atual.
       - Deduz a quantidade vendida de quantidade_saldo.
       - Abate custo_baixa de custo_total_brl.
       - Mantém o preco_medio_brl unitário inalterado.
       - Se zerar o estoque (saldo == 0), zera custo_total_brl e preco_medio_brl.
    6. Atualiza data_atualizacao e comita a transação atômica.
    """
    ativo = db.query(Ativo).filter(Ativo.id == transacao_in.ativo_id).first()
    if not ativo:
        raise PortfolioError(f"Ativo com ID {transacao_in.ativo_id} não encontrado.")

    # 1. Cria a entidade Transacao
    db_transacao = Transacao(
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

    # 2. Busca ou cria PosicaoConsolidada
    posicao = (
        db.query(PosicaoConsolidada)
        .filter(PosicaoConsolidada.ativo_id == transacao_in.ativo_id)
        .first()
    )
    if not posicao:
        posicao = PosicaoConsolidada(
            ativo_id=transacao_in.ativo_id,
            quantidade_saldo=ZERO,
            custo_total_brl=ZERO,
            preco_medio_brl=ZERO,
        )
        db.add(posicao)

    # Fator de conversão para BRL caso necessário
    fator_ptax = transacao_in.ptax_utilizada if transacao_in.ptax_utilizada is not None else Decimal("1.0")

    if transacao_in.tipo_operacao == TipoOperacao.BUY:
        # Custo da compra = (quantidade * preco_unitario) * fator_moeda + taxas_em_brl
        custo_operacao = (transacao_in.quantidade * transacao_in.preco_unitario) * fator_ptax + transacao_in.taxas
        novo_saldo = posicao.quantidade_saldo + transacao_in.quantidade
        novo_custo_total = posicao.custo_total_brl + custo_operacao

        posicao.quantidade_saldo = novo_saldo
        posicao.custo_total_brl = novo_custo_total
        if novo_saldo > ZERO:
            posicao.preco_medio_brl = novo_custo_total / novo_saldo
        else:
            posicao.preco_medio_brl = ZERO

    elif transacao_in.tipo_operacao == TipoOperacao.SELL:
        if transacao_in.quantidade > posicao.quantidade_saldo:
            raise PortfolioError(
                f"Saldo insuficiente para venda de {ativo.ticker}. "
                f"Saldo disponível: {posicao.quantidade_saldo}, Quantidade solicitada: {transacao_in.quantidade}"
            )

        # Custo proporcional baixado pelo Preço Médio vigente
        custo_baixa = transacao_in.quantidade * posicao.preco_medio_brl
        novo_saldo = posicao.quantidade_saldo - transacao_in.quantidade
        novo_custo_total = posicao.custo_total_brl - custo_baixa

        # Se zerar o saldo (ou resíduos de arredondamento próximos de 0)
        if novo_saldo <= ZERO:
            posicao.quantidade_saldo = ZERO
            posicao.custo_total_brl = ZERO
            posicao.preco_medio_brl = ZERO
        else:
            posicao.quantidade_saldo = novo_saldo
            posicao.custo_total_brl = novo_custo_total
            # O Preço Médio unitário permanece inalterado na venda parcial

    posicao.data_atualizacao = datetime.utcnow()

    # Commit atômico de transação + atualização de posição
    db.commit()
    db.refresh(db_transacao)
    db.refresh(posicao)

    return db_transacao
