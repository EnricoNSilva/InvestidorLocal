from datetime import datetime
from decimal import Decimal, getcontext
from sqlalchemy.orm import Session

from app.models.ativo import Ativo
from app.models.carteira import Carteira
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

def obter_ou_criar_carteira_padrao(db: Session, carteira_id: int = 1, nome_padrao: str = "Carteira Principal") -> Carteira:
    """Garante que a carteira solicitada ou a carteira padrão ID=1 exista no banco."""
    carteira = db.query(Carteira).filter(Carteira.id == carteira_id).first()
    if not carteira:
        # Se tentou ID 1 ou qualquer ID e não achou, cria
        carteira = Carteira(id=carteira_id, nome=nome_padrao, descricao="Carteira inicial padrão")
        db.add(carteira)
        db.flush()
    return carteira

def processar_transacao(db: Session, transacao_in: TransacaoCreate) -> Transacao:
    """
    Processa uma transação financeira de compra ou venda com atomicidade para uma Carteira específica:
    1. Valida a existência do ativo e da carteira.
    2. Insere a nova transação no banco.
    3. Busca ou inicializa a PosicaoConsolidada do ativo na carteira correspondente.
    4. Se BUY ou TRANSFERENCIA_ENTRADA:
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

    # Fator de conversão para BRL caso necessário
    fator_ptax = transacao_in.ptax_utilizada if transacao_in.ptax_utilizada is not None else Decimal("1.0")

    if transacao_in.tipo_operacao in (TipoOperacao.BUY, TipoOperacao.TRANSFERENCIA_ENTRADA):
        # Custo da aquisição/transferência = (quantidade * preco_unitario) * fator_moeda + taxas_em_brl
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
                f"Saldo insuficiente na carteira '{carteira.nome}' para venda de {ativo.ticker}. "
                f"Saldo disponível: {posicao.quantidade_saldo}, Quantidade solicitada: {transacao_in.quantidade}"
            )

        # Custo proporcional baixado pelo Preço Médio vigente
        custo_baixa = transacao_in.quantidade * posicao.preco_medio_brl
        novo_saldo = posicao.quantidade_saldo - transacao_in.quantidade
        novo_custo_total = posicao.custo_total_brl - custo_baixa

        # Se zerar o saldo
        if novo_saldo <= ZERO:
            posicao.quantidade_saldo = ZERO
            posicao.custo_total_brl = ZERO
            posicao.preco_medio_brl = ZERO
        else:
            posicao.quantidade_saldo = novo_saldo
            posicao.custo_total_brl = novo_custo_total

    posicao.data_atualizacao = datetime.utcnow()

    # Commit atômico de transação + atualização de posição
    db.commit()
    db.refresh(db_transacao)
    db.refresh(posicao)

    return db_transacao
