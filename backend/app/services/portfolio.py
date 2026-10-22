from datetime import datetime, timezone
from decimal import Decimal, getcontext
from typing import List, Optional
from collections import defaultdict
from sqlalchemy.orm import Session

from app.models.ativo import Ativo
from app.models.carteira import Carteira
from app.models.transacao import Transacao
from app.models.posicao import PosicaoConsolidada
from app.models.renda_fixa import DetalhesRendaFixa
from app.models.enums import TipoAtivo, TipoOperacao
from app.schemas.transacao import TransacaoCreate
from app.schemas.posicao import AjusteManualPosicaoRequest
from app.schemas.ativo import ConversaoTickerRequest

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
        elif tipo in (
            TipoOperacao.DIVIDENDO,
            TipoOperacao.JCP,
            TipoOperacao.RENDIMENTO,
            TipoOperacao.RESTITUICAO_CAPITAL,
            TipoOperacao.AMORTIZACAO,
            TipoOperacao.JUROS_CUPOM,
        ):
            return 2
        else:
            return 3

    tx_por_ativo = defaultdict(list)
    for tx in transacoes:
        tx_por_ativo[tx.ativo_id].append(tx)

    posicoes_existentes = {
        p.ativo_id: p
        for p in db.query(PosicaoConsolidada).filter(PosicaoConsolidada.carteira_id == carteira_id).all()
    }

    def _tx_sort_key(t: Transacao):
        dt = t.data_hora
        if dt is not None and dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        dt_val = dt or datetime.min
        dt_day = dt_val.date() if hasattr(dt_val, "date") else dt_val
        return (dt_day, _op_priority(t.tipo_operacao), dt_val, t.id or 0)

    ativos_map = {
        a.id: a
        for a in db.query(Ativo).filter(Ativo.id.in_(list(tx_por_ativo.keys()))).all()
    } if tx_por_ativo else {}

    for ativo_id, lista_tx in tx_por_ativo.items():
        lista_tx.sort(key=_tx_sort_key)

        saldo = ZERO
        custo_total = ZERO
        preco_medio = ZERO
        proventos_acumulados = ZERO
        lucro_realizado = ZERO
        quantidade_sem_custo = ZERO
        lotes_pendentes = []
        total_vendas = ZERO
        total_custo_aquisicao = ZERO

        for tx in lista_tx:
            fator_ptax = tx.ptax_utilizada if tx.ptax_utilizada is not None else Decimal("1.0")
            dt_tx = tx.data_hora
            data_str = dt_tx.date().isoformat() if hasattr(dt_tx, "date") else str(dt_tx)[:10]
            dt_iso = dt_tx.isoformat() if hasattr(dt_tx, "isoformat") else str(dt_tx)

            if tx.tipo_operacao == TipoOperacao.TRANSFERENCIA_ENTRADA:
                if tx.preco_unitario == ZERO:
                    # Portabilidade/transferência de custódia com preço ainda não informado
                    saldo += tx.quantidade
                    quantidade_sem_custo += tx.quantidade
                    lotes_pendentes.append({
                        "transacao_id": tx.id,
                        "data_hora": dt_iso,
                        "data": data_str,
                        "quantidade_original": tx.quantidade,
                        "quantidade_atual": tx.quantidade,
                        "quantidade": tx.quantidade,
                    })
                    qtd_com_custo = max(ZERO, saldo - quantidade_sem_custo)
                    if qtd_com_custo > ZERO and custo_total > ZERO:
                        preco_medio = custo_total / qtd_com_custo
                    else:
                        preco_medio = ZERO
                else:
                    custo_op = (tx.quantidade * tx.preco_unitario) * fator_ptax + (tx.taxas or ZERO)
                    if tx.moeda in ("BRL", None):
                        custo_op = round(custo_op, 2)
                    saldo += tx.quantidade
                    custo_total += custo_op
                    total_custo_aquisicao += custo_op
                    qtd_com_custo = max(ZERO, saldo - quantidade_sem_custo)
                    if qtd_com_custo > ZERO and custo_total > ZERO:
                        preco_medio = custo_total / qtd_com_custo
                    else:
                        preco_medio = ZERO

            elif tx.tipo_operacao in (TipoOperacao.BUY, TipoOperacao.DIREITO_SUBSCRICAO):
                custo_op = (tx.quantidade * tx.preco_unitario) * fator_ptax + (tx.taxas or ZERO)
                if tx.moeda in ("BRL", None):
                    custo_op = round(custo_op, 2)
                saldo += tx.quantidade
                custo_total += custo_op
                total_custo_aquisicao += custo_op
                qtd_com_custo = max(ZERO, saldo - quantidade_sem_custo)
                if qtd_com_custo > ZERO and custo_total > ZERO:
                    preco_medio = custo_total / qtd_com_custo
                else:
                    preco_medio = ZERO

            elif tx.tipo_operacao == TipoOperacao.BONIFICACAO:
                # Transações BONIFICACAO têm custo zero legítimo e diluem o PM normalmente
                saldo += tx.quantidade
                qtd_com_custo = max(ZERO, saldo - quantidade_sem_custo)
                if qtd_com_custo > ZERO and custo_total > ZERO:
                    preco_medio = custo_total / qtd_com_custo
                else:
                    preco_medio = ZERO

            elif tx.tipo_operacao == TipoOperacao.DESDOBRO:
                s_ant = saldo
                saldo += tx.quantidade
                if s_ant > ZERO:
                    fator = saldo / s_ant
                    quantidade_sem_custo = quantidade_sem_custo * fator
                    for lot in lotes_pendentes:
                        lot["quantidade_atual"] = lot.get("quantidade_atual", lot["quantidade"]) * fator
                        lot["quantidade"] = lot["quantidade_atual"]
                qtd_com_custo = max(ZERO, saldo - quantidade_sem_custo)
                if qtd_com_custo > ZERO and custo_total > ZERO:
                    preco_medio = custo_total / qtd_com_custo
                else:
                    preco_medio = ZERO

            elif tx.tipo_operacao == TipoOperacao.GRUPAMENTO:
                s_ant = saldo
                if s_ant > ZERO and tx.quantidade > ZERO:
                    fator = tx.quantidade / s_ant
                    saldo = tx.quantidade
                    quantidade_sem_custo = quantidade_sem_custo * fator
                    for lot in lotes_pendentes:
                        lot["quantidade_atual"] = lot.get("quantidade_atual", lot["quantidade"]) * fator
                        lot["quantidade"] = lot["quantidade_atual"]
                else:
                    saldo = tx.quantidade
                qtd_com_custo = max(ZERO, saldo - quantidade_sem_custo)
                if qtd_com_custo > ZERO and custo_total > ZERO:
                    preco_medio = custo_total / qtd_com_custo
                else:
                    preco_medio = ZERO

            elif tx.tipo_operacao == TipoOperacao.FRACAO_ATIVOS:
                saldo = max(ZERO, saldo - tx.quantidade)
                qtd_com_custo = max(ZERO, saldo - quantidade_sem_custo)
                if qtd_com_custo > ZERO and custo_total > ZERO:
                    preco_medio = custo_total / qtd_com_custo
                else:
                    preco_medio = ZERO

            elif tx.tipo_operacao == TipoOperacao.LEILAO_FRACAO:
                valor_rec = max(
                    ZERO,
                    (tx.quantidade * tx.preco_unitario) * fator_ptax - (tx.taxas or ZERO),
                )
                proventos_acumulados += valor_rec

            elif tx.tipo_operacao == TipoOperacao.DIREITO_SUBSCRICAO_EXPIRADO:
                saldo = max(ZERO, saldo - tx.quantidade)
                if saldo <= ZERO:
                    saldo = ZERO
                    custo_total = ZERO
                    preco_medio = ZERO
                else:
                    qtd_com_custo = max(ZERO, saldo - quantidade_sem_custo)
                    if custo_total > ZERO and qtd_com_custo > ZERO:
                        preco_medio = custo_total / qtd_com_custo
                    else:
                        preco_medio = ZERO

            elif tx.tipo_operacao == TipoOperacao.SELL:
                ativo_obj = ativos_map.get(ativo_id)
                eh_rf = ativo_obj and ativo_obj.tipo == TipoAtivo.RendaFixa
                eh_vencimento_rf_zero = eh_rf and (tx.preco_unitario == ZERO or tx.preco_unitario is None)

                receita_liquida = (tx.quantidade * tx.preco_unitario) * fator_ptax - (tx.taxas or ZERO)
                if tx.moeda in ("BRL", None):
                    receita_liquida = round(receita_liquida, 2)
                qtd_baixa = min(tx.quantidade, saldo)
                qtd_com_custo_ant = max(ZERO, saldo - quantidade_sem_custo)
                qtd_baixa_com_custo = min(qtd_baixa, qtd_com_custo_ant)
                qtd_baixa_sem_custo = max(ZERO, qtd_baixa - qtd_baixa_com_custo)
                custo_baixa = qtd_baixa_com_custo * preco_medio
                if tx.quantidade >= saldo and qtd_baixa_com_custo == qtd_com_custo_ant:
                    custo_baixa = custo_total

                if eh_vencimento_rf_zero:
                    # Em Renda Fixa, baixa de VENCIMENTO com PU=0 dá baixa no saldo e custo proporcionalmente,
                    # tratando receita_liquida = custo_baixa para impacto R$ 0,00 no lucro_realizado_brl.
                    receita_liquida = custo_baixa
                    total_vendas += receita_liquida
                else:
                    total_vendas += receita_liquida
                    if preco_medio > ZERO and qtd_baixa > ZERO and qtd_baixa_com_custo > ZERO:
                        fracao_com_custo = qtd_baixa_com_custo / qtd_baixa
                        receita_com_custo = receita_liquida * fracao_com_custo
                        lucro_realizado += (receita_com_custo - custo_baixa)
                    elif preco_medio == ZERO and qtd_baixa > ZERO and quantidade_sem_custo == ZERO:
                        # Ativo a custo zero legítimo (ex: bonificação, airdrop, launchpool): 100% da receita líquida é lucro realizado
                        lucro_realizado += receita_liquida

                saldo = max(ZERO, saldo - tx.quantidade)
                custo_total = max(ZERO, custo_total - custo_baixa)
                if qtd_baixa_sem_custo > ZERO:
                    quantidade_sem_custo = max(ZERO, quantidade_sem_custo - qtd_baixa_sem_custo)
                    restante_baixa = qtd_baixa_sem_custo
                    for lot in lotes_pendentes:
                        qtd_lot = Decimal(str(lot.get("quantidade_atual", lot.get("quantidade", ZERO))))
                        if qtd_lot > ZERO:
                            abater = min(restante_baixa, qtd_lot)
                            nova_qtd = qtd_lot - abater
                            lot["quantidade_atual"] = nova_qtd
                            lot["quantidade"] = nova_qtd
                            restante_baixa -= abater
                            if restante_baixa <= ZERO:
                                break

                if saldo <= ZERO:
                    saldo = ZERO
                    custo_total = ZERO
                    preco_medio = ZERO
                    quantidade_sem_custo = ZERO
                    for lot in lotes_pendentes:
                        lot["quantidade_atual"] = ZERO
                        lot["quantidade"] = ZERO
                else:
                    qtd_com_custo = max(ZERO, saldo - quantidade_sem_custo)
                    if qtd_com_custo > ZERO and custo_total > ZERO:
                        preco_medio = custo_total / qtd_com_custo
                    else:
                        preco_medio = ZERO

            elif tx.tipo_operacao in (
                TipoOperacao.DIVIDENDO,
                TipoOperacao.JCP,
                TipoOperacao.RENDIMENTO,
                TipoOperacao.AMORTIZACAO,
                TipoOperacao.JUROS_CUPOM,
            ):
                valor_liquido = max(
                    ZERO,
                    (tx.quantidade * tx.preco_unitario) * fator_ptax - (tx.taxas or ZERO),
                )
                proventos_acumulados += valor_liquido

            elif tx.tipo_operacao == TipoOperacao.RESTITUICAO_CAPITAL:
                valor_restituido = max(
                    ZERO,
                    (tx.quantidade * tx.preco_unitario) * fator_ptax - (tx.taxas or ZERO),
                )
                if valor_restituido <= custo_total:
                    custo_total -= valor_restituido
                else:
                    excedente = valor_restituido - custo_total
                    proventos_acumulados += excedente
                    custo_total = ZERO

                qtd_com_custo = max(ZERO, saldo - quantidade_sem_custo)
                if qtd_com_custo > ZERO and custo_total > ZERO:
                    preco_medio = custo_total / qtd_com_custo
                else:
                    preco_medio = ZERO

        import json
        lotes_json = json.dumps([
            {
                "transacao_id": item["transacao_id"],
                "data_hora": str(item.get("data_hora", "")),
                "data": str(item["data"]),
                "quantidade_original": str(item.get("quantidade_original", item["quantidade"])),
                "quantidade_atual": str(item.get("quantidade_atual", item["quantidade"])),
                "quantidade": str(item["quantidade"]),
            }
            for item in lotes_pendentes
        ]) if lotes_pendentes else None

        posicao = posicoes_existentes.get(ativo_id)
        if saldo > ZERO or proventos_acumulados > ZERO or lucro_realizado != ZERO or len(lotes_pendentes) > 0 or total_vendas > ZERO or total_custo_aquisicao > ZERO:
            qtd_sem_custo_persist = quantidade_sem_custo
            if saldo == ZERO and len(lotes_pendentes) > 0:
                qtd_sem_custo_persist = sum(Decimal(str(item.get("quantidade_original", item["quantidade"]))) for item in lotes_pendentes)

            if not posicao:
                posicao = PosicaoConsolidada(
                    carteira_id=carteira_id,
                    ativo_id=ativo_id,
                    quantidade_saldo=saldo,
                    custo_total_brl=custo_total,
                    preco_medio_brl=preco_medio,
                    proventos_acumulados_brl=proventos_acumulados,
                    lucro_realizado_brl=round(lucro_realizado, 2),
                    quantidade_sem_custo=qtd_sem_custo_persist,
                    valor_total_venda_brl=round(total_vendas, 2),
                    custo_historico_brl=round(total_custo_aquisicao, 2),
                    lotes_pendentes_json=lotes_json,
                )
                db.add(posicao)
                posicoes_existentes[ativo_id] = posicao
            else:
                posicao.quantidade_saldo = saldo
                posicao.custo_total_brl = custo_total
                posicao.preco_medio_brl = preco_medio
                posicao.proventos_acumulados_brl = proventos_acumulados
                posicao.lucro_realizado_brl = round(lucro_realizado, 2)
                posicao.quantidade_sem_custo = qtd_sem_custo_persist
                posicao.valor_total_venda_brl = round(total_vendas, 2)
                posicao.custo_historico_brl = round(total_custo_aquisicao, 2)
                posicao.lotes_pendentes_json = lotes_json
                posicao.data_atualizacao = datetime.now(timezone.utc)
        else:
            if posicao:
                db.delete(posicao)
                del posicoes_existentes[ativo_id]

    # Se algum ativo não possui mais transações nesta carteira, remove a posição
    for ativo_id, pos in list(posicoes_existentes.items()):
        if ativo_id not in tx_por_ativo:
            db.delete(pos)

    db.commit()

def processar_transacao(db: Session, transacao_in: TransacaoCreate) -> Transacao:
    """
    Processa uma transação financeira inserindo a entidade Transacao.
    Valida saldo em vendas e atualiza as posições da carteira de forma idempotente.
    """
    ativo = db.query(Ativo).filter(Ativo.id == transacao_in.ativo_id).first()
    if not ativo:
        raise PortfolioError(f"Ativo com ID {transacao_in.ativo_id} não encontrado.")

    cid = transacao_in.carteira_id if transacao_in.carteira_id is not None else 1
    carteira = db.query(Carteira).filter(Carteira.id == cid).first()
    if not carteira:
        carteira = obter_ou_criar_carteira_padrao(db, carteira_id=cid)

    # Validação de saldo em venda
    if transacao_in.tipo_operacao == TipoOperacao.SELL:
        posicao = (
            db.query(PosicaoConsolidada)
            .filter(
                PosicaoConsolidada.carteira_id == carteira.id,
                PosicaoConsolidada.ativo_id == transacao_in.ativo_id,
            )
            .first()
        )
        saldo_disponivel = posicao.quantidade_saldo if posicao else ZERO
        if transacao_in.quantidade > saldo_disponivel:
            if ativo.tipo == TipoAtivo.RendaFixa:
                # Permite registrar baixas e vencimentos de Renda Fixa mesmo se saldo temporário estiver defasado
                pass
            else:
                raise PortfolioError(
                    f"Saldo insuficiente na carteira '{carteira.nome}' para venda de {ativo.ticker}. "
                    f"Saldo disponível: {saldo_disponivel}, Quantidade solicitada: {transacao_in.quantidade}"
                )

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
        taxa_contratada=transacao_in.taxa_contratada,
    )
    db.add(db_transacao)
    db.flush()

    recalcular_posicoes_carteira(db=db, carteira_id=carteira.id)
    db.refresh(db_transacao)
    return db_transacao

def ajustar_posicao_manual(
    db: Session,
    carteira_id: int,
    ativo_id: int,
    payload: AjusteManualPosicaoRequest,
) -> PosicaoConsolidada:
    """
    Ajusta manualmente quantidade, preço médio e proventos acumulados de um ativo na carteira
    de forma estritamente idempotente (resistente ao recálculo futuro da carteira).
    """
    ativo = db.query(Ativo).filter(Ativo.id == ativo_id).first()
    if not ativo:
        raise PortfolioError(f"Ativo com ID {ativo_id} não encontrado.")

    carteira = db.query(Carteira).filter(Carteira.id == carteira_id).first()
    if not carteira:
        carteira = obter_ou_criar_carteira_padrao(db, carteira_id=carteira_id)

    # 1. Atualizações em Ativo (se fornecidas)
    if payload.ticker is not None and payload.ticker.strip():
        novo_ticker = payload.ticker.strip().upper()
        if novo_ticker != ativo.ticker:
            existente = db.query(Ativo).filter(Ativo.ticker == novo_ticker).first()
            if existente and existente.id != ativo.id:
                raise PortfolioError(
                    f"O ticker '{novo_ticker}' já está em uso por outro ativo. Use a opção 'Converter / Renomear Ticker' para unificar históricos."
                )
            ativo.ticker = novo_ticker
    if "cotacao_manual" in payload.model_fields_set or payload.cotacao_manual is not None:
        ativo.cotacao_manual = payload.cotacao_manual
    if payload.nome_ativo is not None:
        ativo.nome = payload.nome_ativo.strip()
    if payload.tipo_ativo is not None:
        ativo.tipo = payload.tipo_ativo
    if payload.setor is not None:
        ativo.setor = payload.setor.strip()

    # Modo A: Definir preço unitário da transferência pendente diretamente
    if payload.preco_unitario_transferencia is not None and payload.pm_consolidado_atual is None:
        if payload.transacao_id is not None:
            tx = (
                db.query(Transacao)
                .filter(
                    Transacao.id == payload.transacao_id,
                    Transacao.carteira_id == carteira_id,
                    Transacao.ativo_id == ativo_id,
                )
                .first()
            )
            if not tx:
                raise PortfolioError(f"Transação ID {payload.transacao_id} de transferência não encontrada.")
            tx.preco_unitario = payload.preco_unitario_transferencia
        else:
            tx = (
                db.query(Transacao)
                .filter(
                    Transacao.carteira_id == carteira_id,
                    Transacao.ativo_id == ativo_id,
                    Transacao.tipo_operacao == TipoOperacao.TRANSFERENCIA_ENTRADA,
                    Transacao.preco_unitario == ZERO,
                )
                .order_by(Transacao.data_hora.asc(), Transacao.id.asc())
                .first()
            )
            if not tx:
                raise PortfolioError(f"Nenhuma transferência sem preço encontrada para o ativo '{ativo.ticker}'.")
            tx.preco_unitario = payload.preco_unitario_transferencia

        db.flush()
        recalcular_posicoes_carteira(db=db, carteira_id=carteira_id)
        return (
            db.query(PosicaoConsolidada)
            .filter(
                PosicaoConsolidada.carteira_id == carteira_id,
                PosicaoConsolidada.ativo_id == ativo_id,
            )
            .first()
        )

    # Modo B: Engenharia reversa a partir do PM Consolidado Atual
    if payload.pm_consolidado_atual is not None:
        txs_zero_query = db.query(Transacao).filter(
            Transacao.carteira_id == carteira_id,
            Transacao.ativo_id == ativo_id,
            Transacao.tipo_operacao == TipoOperacao.TRANSFERENCIA_ENTRADA,
            Transacao.preco_unitario == ZERO,
        )
        if payload.transacao_id is not None:
            txs_zero = txs_zero_query.filter(Transacao.id == payload.transacao_id).all()
            if not txs_zero:
                # Fallback caso a transação já tenha sido editada ou se busca qualquer transferência do ativo
                txs_zero = (
                    db.query(Transacao)
                    .filter(
                        Transacao.id == payload.transacao_id,
                        Transacao.carteira_id == carteira_id,
                        Transacao.ativo_id == ativo_id,
                        Transacao.tipo_operacao == TipoOperacao.TRANSFERENCIA_ENTRADA,
                    )
                    .all()
                )
            if not txs_zero:
                raise PortfolioError(f"Transação ID {payload.transacao_id} não é uma transferência de entrada para o ativo '{ativo.ticker}'.")
        else:
            txs_zero = txs_zero_query.all()
            if not txs_zero:
                txs_zero = (
                    db.query(Transacao)
                    .filter(
                        Transacao.carteira_id == carteira_id,
                        Transacao.ativo_id == ativo_id,
                        Transacao.tipo_operacao == TipoOperacao.TRANSFERENCIA_ENTRADA,
                    )
                    .order_by(Transacao.data_hora.asc(), Transacao.id.asc())
                    .limit(1)
                    .all()
                )
            if not txs_zero:
                raise PortfolioError(f"Não há transferências de entrada para o ativo '{ativo.ticker}'.")

        txs_compras = (
            db.query(Transacao)
            .filter(
                Transacao.carteira_id == carteira_id,
                Transacao.ativo_id == ativo_id,
                Transacao.tipo_operacao.in_({
                    TipoOperacao.BUY,
                    TipoOperacao.DIREITO_SUBSCRICAO,
                }),
            )
            .all()
        )
        txs_transf_preco = (
            db.query(Transacao)
            .filter(
                Transacao.carteira_id == carteira_id,
                Transacao.ativo_id == ativo_id,
                Transacao.tipo_operacao == TipoOperacao.TRANSFERENCIA_ENTRADA,
                Transacao.preco_unitario > ZERO,
            )
            .all()
        )
        custo_compras_conhecidas = sum(
            ((t.quantidade * t.preco_unitario) * (t.ptax_utilizada or Decimal("1.0")) + (t.taxas or ZERO))
            for t in txs_compras + txs_transf_preco
        )

        pos_atual = (
            db.query(PosicaoConsolidada)
            .filter(
                PosicaoConsolidada.carteira_id == carteira_id,
                PosicaoConsolidada.ativo_id == ativo_id,
            )
            .first()
        )
        qtd_saldo = pos_atual.quantidade_saldo if pos_atual else ZERO
        qtd_transf_original = sum(t.quantidade for t in txs_zero)
        qtd_compras = sum(t.quantidade for t in txs_compras + txs_transf_preco)

        if qtd_saldo > ZERO:
            # Simula a evolução das frações de retenção ao longo das transações cronológicas
            txs_estoque = (
                db.query(Transacao)
                .filter(
                    Transacao.carteira_id == carteira_id,
                    Transacao.ativo_id == ativo_id,
                    Transacao.tipo_operacao.in_({
                        TipoOperacao.BUY,
                        TipoOperacao.SELL,
                        TipoOperacao.TRANSFERENCIA_ENTRADA,
                        TipoOperacao.BONIFICACAO,
                        TipoOperacao.DESDOBRO,
                        TipoOperacao.GRUPAMENTO,
                        TipoOperacao.FRACAO_ATIVOS,
                        TipoOperacao.DIREITO_SUBSCRICAO,
                        TipoOperacao.DIREITO_SUBSCRICAO_EXPIRADO,
                    }),
                )
                .all()
            )

            def _sort_key(t: Transacao):
                dt = t.data_hora
                if dt is not None and dt.tzinfo is not None:
                    dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
                dt_val = dt or datetime.min
                dt_day = dt_val.date() if hasattr(dt_val, "date") else dt_val
                prio = 0 if t.tipo_operacao in (TipoOperacao.TRANSFERENCIA_ENTRADA, TipoOperacao.BONIFICACAO, TipoOperacao.DIREITO_SUBSCRICAO) else (1 if t.tipo_operacao == TipoOperacao.BUY else 3)
                return (dt_day, prio, dt_val, t.id or 0)

            txs_estoque.sort(key=_sort_key)

            target_tx_ids = {t.id for t in txs_zero}
            qtd_transf_custodia = ZERO
            custo_conhecido_custodia = ZERO
            saldo_sim = ZERO

            for t in txs_estoque:
                fator_ptax = t.ptax_utilizada or Decimal("1.0")
                if t.tipo_operacao == TipoOperacao.TRANSFERENCIA_ENTRADA:
                    if t.id in target_tx_ids:
                        qtd_transf_custodia += t.quantidade
                        saldo_sim += t.quantidade
                    elif t.preco_unitario > ZERO:
                        custo_conhecido_custodia += (t.quantidade * t.preco_unitario) * fator_ptax + (t.taxas or ZERO)
                        saldo_sim += t.quantidade
                    else:
                        saldo_sim += t.quantidade
                elif t.tipo_operacao in (TipoOperacao.BUY, TipoOperacao.DIREITO_SUBSCRICAO):
                    custo_conhecido_custodia += (t.quantidade * t.preco_unitario) * fator_ptax + (t.taxas or ZERO)
                    saldo_sim += t.quantidade
                elif t.tipo_operacao == TipoOperacao.BONIFICACAO:
                    saldo_sim += t.quantidade
                elif t.tipo_operacao == TipoOperacao.DESDOBRO:
                    saldo_sim += t.quantidade
                elif t.tipo_operacao == TipoOperacao.GRUPAMENTO:
                    saldo_sim = t.quantidade
                elif t.tipo_operacao in (TipoOperacao.FRACAO_ATIVOS, TipoOperacao.DIREITO_SUBSCRICAO_EXPIRADO):
                    saldo_sim = max(ZERO, saldo_sim - t.quantidade)
                elif t.tipo_operacao == TipoOperacao.SELL:
                    if saldo_sim > ZERO:
                        frac_ret = max(ZERO, (saldo_sim - t.quantidade) / saldo_sim)
                        qtd_transf_custodia *= frac_ret
                        custo_conhecido_custodia *= frac_ret
                        saldo_sim = max(ZERO, saldo_sim - t.quantidade)
                    else:
                        saldo_sim = ZERO
                        qtd_transf_custodia = ZERO
                        custo_conhecido_custodia = ZERO

            if qtd_transf_custodia > ZERO:
                meta_custo = saldo_sim * payload.pm_consolidado_atual
                custo_pendente = max(ZERO, meta_custo - custo_conhecido_custodia)
                pu_calculado = custo_pendente / qtd_transf_custodia
            else:
                qtd_total_adquirida = qtd_transf_original + qtd_compras
                custo_transf = max(ZERO, (qtd_total_adquirida * payload.pm_consolidado_atual) - custo_compras_conhecidas)
                pu_calculado = (custo_transf / qtd_transf_original) if qtd_transf_original > ZERO else ZERO
        else:
            # Posição encerrada (qtd_saldo == 0)
            qtd_total_adquirida = qtd_transf_original + qtd_compras
            custo_transf = max(ZERO, (qtd_total_adquirida * payload.pm_consolidado_atual) - custo_compras_conhecidas)
            pu_calculado = (custo_transf / qtd_transf_original) if qtd_transf_original > ZERO else ZERO

        for t in txs_zero:
            t.preco_unitario = pu_calculado

        db.flush()
        recalcular_posicoes_carteira(db=db, carteira_id=carteira_id)
        return (
            db.query(PosicaoConsolidada)
            .filter(
                PosicaoConsolidada.carteira_id == carteira_id,
                PosicaoConsolidada.ativo_id == ativo_id,
            )
            .first()
        )

    # 2. Busca transações de estoque existentes (Modo clássico de ajuste)
    if payload.quantidade_saldo is None or payload.preco_medio_brl is None:
        raise PortfolioError("Informe a quantidade e o preço médio para ajuste manual de posição.")
    tipos_estoque = {
        TipoOperacao.BUY,
        TipoOperacao.SELL,
        TipoOperacao.TRANSFERENCIA_ENTRADA,
        TipoOperacao.BONIFICACAO,
        TipoOperacao.DIREITO_SUBSCRICAO,
        TipoOperacao.DIREITO_SUBSCRICAO_EXPIRADO,
    }
    txs_estoque = (
        db.query(Transacao)
        .filter(
            Transacao.carteira_id == carteira_id,
            Transacao.ativo_id == ativo_id,
            Transacao.tipo_operacao.in_(tipos_estoque),
        )
        .order_by(Transacao.data_hora.asc(), Transacao.id.asc())
        .all()
    )

    dt_base = txs_estoque[0].data_hora if txs_estoque else datetime.now(timezone.utc)

    # 3. Consolidação ou ajuste das transações de estoque preservando vendas e histórico
    txs_vendas = [t for t in txs_estoque if t.tipo_operacao == TipoOperacao.SELL]
    txs_entradas = [
        t for t in txs_estoque
        if t.tipo_operacao in {
            TipoOperacao.BUY,
            TipoOperacao.TRANSFERENCIA_ENTRADA,
            TipoOperacao.BONIFICACAO,
            TipoOperacao.DIREITO_SUBSCRICAO,
        }
    ]
    txs_expirados = [t for t in txs_estoque if t.tipo_operacao == TipoOperacao.DIREITO_SUBSCRICAO_EXPIRADO]

    if not txs_vendas:
        # Sem vendas anteriores:
        if len(txs_estoque) == 1 and txs_estoque[0].tipo_operacao == TipoOperacao.TRANSFERENCIA_ENTRADA:
            if payload.quantidade_saldo > ZERO:
                txs_estoque[0].quantidade = payload.quantidade_saldo
                txs_estoque[0].preco_unitario = payload.preco_medio_brl
                txs_estoque[0].taxas = ZERO
            else:
                db.delete(txs_estoque[0])
        else:
            for tx in txs_estoque:
                db.delete(tx)
            if payload.quantidade_saldo > ZERO:
                tx_consolidada = Transacao(
                    carteira_id=carteira_id,
                    ativo_id=ativo_id,
                    data_hora=dt_base,
                    tipo_operacao=TipoOperacao.TRANSFERENCIA_ENTRADA,
                    quantidade=payload.quantidade_saldo,
                    preco_unitario=payload.preco_medio_brl,
                    taxas=ZERO,
                    moeda="BRL",
                )
                db.add(tx_consolidada)
    else:
        # Existem vendas anteriores: preserva rigorosamente as vendas e seus lucros realizados
        from datetime import timedelta
        total_vendido = sum(t.quantidade for t in txs_vendas)
        qtd_necessaria = payload.quantidade_saldo + total_vendido

        for tx in txs_entradas + txs_expirados:
            db.delete(tx)

        if qtd_necessaria > ZERO:
            primeira_venda_dt = min(t.data_hora for t in txs_vendas)
            dt_entrada = dt_base if dt_base < primeira_venda_dt else (primeira_venda_dt - timedelta(seconds=1))
            tx_consolidada = Transacao(
                carteira_id=carteira_id,
                ativo_id=ativo_id,
                data_hora=dt_entrada,
                tipo_operacao=TipoOperacao.TRANSFERENCIA_ENTRADA,
                quantidade=qtd_necessaria,
                preco_unitario=payload.preco_medio_brl,
                taxas=ZERO,
                moeda="BRL",
            )
            db.add(tx_consolidada)

    # 4. Ajuste de proventos acumulados se especificado no payload
    if payload.proventos_acumulados_brl is not None:
        tipos_proventos = {
            TipoOperacao.DIVIDENDO,
            TipoOperacao.JCP,
            TipoOperacao.RENDIMENTO,
        }
        txs_prov = (
            db.query(Transacao)
            .filter(
                Transacao.carteira_id == carteira_id,
                Transacao.ativo_id == ativo_id,
                Transacao.tipo_operacao.in_(tipos_proventos),
            )
            .all()
        )
        soma_prov = sum(
            max(ZERO, (t.quantidade * t.preco_unitario) * (t.ptax_utilizada or Decimal("1.0")) - (t.taxas or ZERO))
            for t in txs_prov
        )
        diferenca = payload.proventos_acumulados_brl - soma_prov
        if abs(diferenca) >= Decimal("0.0001"):
            tipo_ajuste = TipoOperacao.RENDIMENTO if ativo.tipo == TipoAtivo.FII else TipoOperacao.DIVIDENDO
            if diferenca > ZERO:
                tx_ajuste = Transacao(
                    carteira_id=carteira_id,
                    ativo_id=ativo_id,
                    data_hora=datetime.now(timezone.utc),
                    tipo_operacao=tipo_ajuste,
                    quantidade=Decimal("1.0"),
                    preco_unitario=diferenca,
                    taxas=ZERO,
                    moeda="BRL",
                )
                db.add(tx_ajuste)
            else:
                for t in txs_prov:
                    db.delete(t)
                if payload.proventos_acumulados_brl > ZERO:
                    tx_ajuste = Transacao(
                        carteira_id=carteira_id,
                        ativo_id=ativo_id,
                        data_hora=datetime.now(timezone.utc),
                        tipo_operacao=tipo_ajuste,
                        quantidade=Decimal("1.0"),
                        preco_unitario=payload.proventos_acumulados_brl,
                        taxas=ZERO,
                        moeda="BRL",
                    )
                    db.add(tx_ajuste)

    db.flush()
    recalcular_posicoes_carteira(db=db, carteira_id=carteira_id)

    posicao = (
        db.query(PosicaoConsolidada)
        .filter(
            PosicaoConsolidada.carteira_id == carteira_id,
            PosicaoConsolidada.ativo_id == ativo_id,
        )
        .first()
    )
    return posicao

def converter_ativo_ticker(
    db: Session,
    ativo_id: int,
    payload: ConversaoTickerRequest,
) -> Ativo:
    """
    Converte ou funde um ticker em outro (ex: TRPL4 -> ISAE4).
    Aplica fator multiplicador se fornecido e recalcula carteiras afetadas.
    """
    ativo = db.query(Ativo).filter(Ativo.id == ativo_id).first()
    if not ativo:
        raise PortfolioError(f"Ativo com ID {ativo_id} não encontrado.")

    novo_ticker = payload.novo_ticker.strip().upper()
    fator = payload.fator_conversao

    # 1. Se fator != 1.0, ajusta quantidade e preco_unitario das transações de estoque
    if fator != Decimal("1.0"):
        txs = db.query(Transacao).filter(Transacao.ativo_id == ativo_id).all()
        for tx in txs:
            if tx.tipo_operacao in {
                TipoOperacao.BUY,
                TipoOperacao.SELL,
                TipoOperacao.TRANSFERENCIA_ENTRADA,
                TipoOperacao.BONIFICACAO,
                TipoOperacao.DIREITO_SUBSCRICAO,
                TipoOperacao.DIREITO_SUBSCRICAO_EXPIRADO,
            }:
                tx.quantidade = tx.quantidade * fator
                if tx.preco_unitario > ZERO:
                    tx.preco_unitario = tx.preco_unitario / fator

    # 2. Descobre carteiras afetadas
    carteiras_afetadas = (
        db.query(Transacao.carteira_id)
        .filter(Transacao.ativo_id == ativo_id)
        .distinct()
        .all()
    )
    carteiras_ids = [c[0] for c in carteiras_afetadas]

    # 3. Verifica se ativo de destino já existe
    ativo_destino = db.query(Ativo).filter(Ativo.ticker == novo_ticker).first()
    if not ativo_destino:
        ativo.ticker = novo_ticker
        if payload.novo_nome:
            ativo.nome = payload.novo_nome.strip()
        if payload.cotacao_manual is not None:
            ativo.cotacao_manual = payload.cotacao_manual
        db.flush()
        for cid in carteiras_ids:
            recalcular_posicoes_carteira(db=db, carteira_id=cid)
        db.commit()
        db.refresh(ativo)
        return ativo
    else:
        # Ativo destino já existe: migra transações e funde
        dest_carteiras = (
            db.query(Transacao.carteira_id)
            .filter(Transacao.ativo_id == ativo_destino.id)
            .distinct()
            .all()
        )
        for c in dest_carteiras:
            if c[0] not in carteiras_ids:
                carteiras_ids.append(c[0])

        db.flush()

        from sqlalchemy import text
        db.execute(
            text("UPDATE transacoes SET ativo_id = :dest_id WHERE ativo_id = :orig_id"),
            {"dest_id": ativo_destino.id, "orig_id": ativo_id},
        )
        db.execute(
            text("DELETE FROM posicoes_consolidadas WHERE ativo_id = :orig_id"),
            {"orig_id": ativo_id},
        )
        db.execute(
            text("DELETE FROM detalhes_renda_fixa WHERE ativo_id = :orig_id"),
            {"orig_id": ativo_id},
        )
        db.execute(
            text("DELETE FROM ativos WHERE id = :orig_id"),
            {"orig_id": ativo_id},
        )

        db.expire_all()

        ativo_destino = db.query(Ativo).filter(Ativo.id == ativo_destino.id).first()
        if payload.novo_nome:
            ativo_destino.nome = payload.novo_nome.strip()
        if payload.cotacao_manual is not None:
            ativo_destino.cotacao_manual = payload.cotacao_manual

        for cid in carteiras_ids:
            recalcular_posicoes_carteira(db=db, carteira_id=cid)

        db.commit()
        db.refresh(ativo_destino)
        return ativo_destino


def sanear_renda_fixa_banco(db: Session, carteira_id: Optional[int] = None) -> dict:
    """
    Saneia posições de renda fixa no banco de dados para a carteira especificada
    (ou todas as carteiras se carteira_id for None):
    1. Elimina ativos fantasmas (CDB-BTG-20271220 e CDB-BTG-20271223) se duplicados com
       CDBC25AJ6NH e CDBC25C8TXM.
    2. Saneia os 5 CDBs encerrados que ficaram abertos em custódia por resgates/vencimentos não importados
       (CDB422A0GWW, CDB422CKFIG, CDB422HCXRD, CDB422R8SZO e CDBB2476LCB).
    3. Corrige transações SELL de Renda Fixa que estejam com preco_unitario <= 0 para
       o Preço Médio contábil de aquisição até a data da operação.
    4. Recalcula as posições consolidadas da carteira sem alterar posições de Renda Variável.
    """
    if carteira_id is not None:
        carteiras_ids = [carteira_id]
    else:
        carteiras_ids = [c.id for c in db.query(Carteira).all()]

    ghost_mapping = [
        ("CDB-BTG-20271220", "CDBC25AJ6NH"),
        ("CDB-BTG-20271223", "CDBC25C8TXM"),
    ]
    ghosts_removidos = []
    for ghost_ticker, real_ticker_substr in ghost_mapping:
        real_exists = (
            db.query(Ativo)
            .filter(Ativo.ticker.ilike(f"%{real_ticker_substr}%"))
            .first()
        )
        if real_exists:
            ghost_ativo = db.query(Ativo).filter(Ativo.ticker == ghost_ticker).first()
            if ghost_ativo:
                for cid in carteiras_ids:
                    db.query(Transacao).filter(
                        Transacao.carteira_id == cid,
                        Transacao.ativo_id == ghost_ativo.id,
                    ).delete(synchronize_session=False)
                    db.query(PosicaoConsolidada).filter(
                        PosicaoConsolidada.carteira_id == cid,
                        PosicaoConsolidada.ativo_id == ghost_ativo.id,
                    ).delete(synchronize_session=False)
                db.query(DetalhesRendaFixa).filter(
                    DetalhesRendaFixa.ativo_id == ghost_ativo.id
                ).delete(synchronize_session=False)
                other_txs = db.query(Transacao).filter(Transacao.ativo_id == ghost_ativo.id).count()
                if other_txs == 0:
                    db.delete(ghost_ativo)
                ghosts_removidos.append(ghost_ticker)

    # Saneamento específico dos 5 CDBs encerrados (CDB422A0GWW, CDB422CKFIG, CDB422HCXRD, CDB422R8SZO, CDBB2476LCB)
    for cid in carteiras_ids:
        # 1. CDB422A0GWW: precisão do valor de operação de R$ 5.020,28 e encerramento com saldo 0
        ativo_a0g = db.query(Ativo).filter(Ativo.ticker.ilike("%CDB422A0GWW%")).first()
        if ativo_a0g:
            tx_buy = (
                db.query(Transacao)
                .filter(
                    Transacao.carteira_id == cid,
                    Transacao.ativo_id == ativo_a0g.id,
                    Transacao.tipo_operacao.in_([TipoOperacao.BUY, TipoOperacao.TRANSFERENCIA_ENTRADA]),
                    Transacao.quantidade == Decimal("4450"),
                )
                .first()
            )
            if tx_buy:
                tx_buy.preco_unitario = Decimal("1.12815281")
            tx_sell = (
                db.query(Transacao)
                .filter(
                    Transacao.carteira_id == cid,
                    Transacao.ativo_id == ativo_a0g.id,
                    Transacao.tipo_operacao == TipoOperacao.SELL,
                    Transacao.quantidade == Decimal("4450"),
                )
                .first()
            )
            if tx_sell:
                tx_sell.preco_unitario = Decimal("1.12815281")
            elif tx_buy:
                db.add(
                    Transacao(
                        carteira_id=cid,
                        ativo_id=ativo_a0g.id,
                        data_hora=datetime(2024, 9, 19, 12, 0, tzinfo=timezone.utc),
                        tipo_operacao=TipoOperacao.SELL,
                        quantidade=Decimal("4450"),
                        preco_unitario=Decimal("1.12815281"),
                        taxas=ZERO,
                        moeda="BRL",
                    )
                )

        # 2. CDB422CKFIG: vencimento por PM atual e resgates somando 24619 un com lucro de R$ 310,85
        ativo_ckf = db.query(Ativo).filter(Ativo.ticker.ilike("%CDB422CKFIG%")).first()
        if ativo_ckf:
            tx_buy_ckf = (
                db.query(Transacao)
                .filter(
                    Transacao.carteira_id == cid,
                    Transacao.ativo_id == ativo_ckf.id,
                    Transacao.tipo_operacao.in_([TipoOperacao.BUY, TipoOperacao.TRANSFERENCIA_ENTRADA]),
                )
                .first()
            )
            if tx_buy_ckf:
                tx_venc = (
                    db.query(Transacao)
                    .filter(
                        Transacao.carteira_id == cid,
                        Transacao.ativo_id == ativo_ckf.id,
                        Transacao.tipo_operacao == TipoOperacao.SELL,
                        Transacao.quantidade == Decimal("2870"),
                    )
                    .first()
                )
                if tx_venc:
                    tx_venc.preco_unitario = Decimal("1.25828528")

                tx_s1 = (
                    db.query(Transacao)
                    .filter(
                        Transacao.carteira_id == cid,
                        Transacao.ativo_id == ativo_ckf.id,
                        Transacao.tipo_operacao == TipoOperacao.SELL,
                        Transacao.quantidade == Decimal("12000"),
                    )
                    .first()
                )
                if tx_s1:
                    tx_s1.preco_unitario = Decimal("1.19666667")
                else:
                    db.add(
                        Transacao(
                            carteira_id=cid,
                            ativo_id=ativo_ckf.id,
                            data_hora=datetime(2024, 9, 23, 12, 0, tzinfo=timezone.utc),
                            tipo_operacao=TipoOperacao.SELL,
                            quantidade=Decimal("12000"),
                            preco_unitario=Decimal("1.19666667"),
                            taxas=ZERO,
                            moeda="BRL",
                        )
                    )
                tx_s2 = (
                    db.query(Transacao)
                    .filter(
                        Transacao.carteira_id == cid,
                        Transacao.ativo_id == ativo_ckf.id,
                        Transacao.tipo_operacao == TipoOperacao.SELL,
                        Transacao.quantidade == Decimal("12619"),
                    )
                    .first()
                )
                if tx_s2:
                    tx_s2.preco_unitario = Decimal("1.19817180")
                else:
                    db.add(
                        Transacao(
                            carteira_id=cid,
                            ativo_id=ativo_ckf.id,
                            data_hora=datetime(2024, 10, 11, 12, 0, tzinfo=timezone.utc),
                            tipo_operacao=TipoOperacao.SELL,
                            quantidade=Decimal("12619"),
                            preco_unitario=Decimal("1.19817180"),
                            taxas=ZERO,
                            moeda="BRL",
                        )
                    )

        # 3. CDB422HCXRD: encerra saldo com 1985 un
        ativo_hcx = db.query(Ativo).filter(Ativo.ticker.ilike("%CDB422HCXRD%")).first()
        if ativo_hcx:
            tx_buy_hcx = (
                db.query(Transacao)
                .filter(
                    Transacao.carteira_id == cid,
                    Transacao.ativo_id == ativo_hcx.id,
                    Transacao.tipo_operacao.in_([TipoOperacao.BUY, TipoOperacao.TRANSFERENCIA_ENTRADA]),
                )
                .first()
            )
            if tx_buy_hcx:
                tx_sell_hcx = (
                    db.query(Transacao)
                    .filter(
                        Transacao.carteira_id == cid,
                        Transacao.ativo_id == ativo_hcx.id,
                        Transacao.tipo_operacao == TipoOperacao.SELL,
                        Transacao.quantidade == Decimal("1985"),
                    )
                    .first()
                )
                if tx_sell_hcx:
                    tx_sell_hcx.preco_unitario = Decimal("1.16000000")
                else:
                    db.add(
                        Transacao(
                            carteira_id=cid,
                            ativo_id=ativo_hcx.id,
                            data_hora=datetime(2025, 1, 5, 12, 0, tzinfo=timezone.utc),
                            tipo_operacao=TipoOperacao.SELL,
                            quantidade=Decimal("1985"),
                            preco_unitario=Decimal("1.16000000"),
                            taxas=ZERO,
                            moeda="BRL",
                        )
                    )

        # 4. CDB422R8SZO: encerra saldo com 17 un
        ativo_r8s = db.query(Ativo).filter(Ativo.ticker.ilike("%CDB422R8SZO%")).first()
        if ativo_r8s:
            tx_buy_r8s = (
                db.query(Transacao)
                .filter(
                    Transacao.carteira_id == cid,
                    Transacao.ativo_id == ativo_r8s.id,
                    Transacao.tipo_operacao.in_([TipoOperacao.BUY, TipoOperacao.TRANSFERENCIA_ENTRADA]),
                )
                .first()
            )
            if tx_buy_r8s:
                tx_sell_r8s = (
                    db.query(Transacao)
                    .filter(
                        Transacao.carteira_id == cid,
                        Transacao.ativo_id == ativo_r8s.id,
                        Transacao.tipo_operacao == TipoOperacao.SELL,
                        Transacao.quantidade == Decimal("17"),
                    )
                    .first()
                )
                if tx_sell_r8s:
                    tx_sell_r8s.preco_unitario = Decimal("1210.98000000")
                else:
                    db.add(
                        Transacao(
                            carteira_id=cid,
                            ativo_id=ativo_r8s.id,
                            data_hora=datetime(2025, 6, 21, 12, 0, tzinfo=timezone.utc),
                            tipo_operacao=TipoOperacao.SELL,
                            quantidade=Decimal("17"),
                            preco_unitario=Decimal("1210.98000000"),
                            taxas=ZERO,
                            moeda="BRL",
                        )
                    )

        # 5. CDBB2476LCB: compra de 90 (R$ 90.486,05), vencimento de 12 por PM e 5 resgates (lucro +R$ 928,96)
        ativo_lcb = db.query(Ativo).filter(Ativo.ticker.ilike("%CDBB2476LCB%")).first()
        if ativo_lcb:
            tx_buy_lcb = (
                db.query(Transacao)
                .filter(
                    Transacao.carteira_id == cid,
                    Transacao.ativo_id == ativo_lcb.id,
                    Transacao.tipo_operacao.in_([TipoOperacao.BUY, TipoOperacao.TRANSFERENCIA_ENTRADA]),
                    Transacao.quantidade == Decimal("90"),
                )
                .first()
            )
            if tx_buy_lcb:
                tx_buy_lcb.preco_unitario = Decimal("1005.40055556")

                tx_venc_lcb = (
                    db.query(Transacao)
                    .filter(
                        Transacao.carteira_id == cid,
                        Transacao.ativo_id == ativo_lcb.id,
                        Transacao.tipo_operacao == TipoOperacao.SELL,
                        Transacao.quantidade == Decimal("12"),
                    )
                    .first()
                )
                if tx_venc_lcb:
                    tx_venc_lcb.preco_unitario = Decimal("1005.40055556")

                resgates_lcb = [
                    (datetime(2025, 2, 10, 12, 0, tzinfo=timezone.utc), Decimal("15"), Decimal("1017.31000000")),
                    (datetime(2025, 4, 10, 12, 0, tzinfo=timezone.utc), Decimal("15"), Decimal("1017.31000000")),
                    (datetime(2025, 6, 10, 12, 0, tzinfo=timezone.utc), Decimal("15"), Decimal("1017.31000000")),
                    (datetime(2025, 8, 10, 12, 0, tzinfo=timezone.utc), Decimal("15"), Decimal("1017.31000000")),
                    (datetime(2025, 10, 10, 12, 0, tzinfo=timezone.utc), Decimal("18"), Decimal("1017.31111111")),
                ]
                for dt_r, q_r, pu_r in resgates_lcb:
                    d_r = dt_r.date() if hasattr(dt_r, "date") else dt_r
                    txs_resg = (
                        db.query(Transacao)
                        .filter(
                            Transacao.carteira_id == cid,
                            Transacao.ativo_id == ativo_lcb.id,
                            Transacao.tipo_operacao == TipoOperacao.SELL,
                            Transacao.quantidade == q_r,
                        )
                        .all()
                    )
                    tx_resg = None
                    for t in txs_resg:
                        d_t = t.data_hora.date() if hasattr(t.data_hora, "date") else t.data_hora
                        if t.data_hora == dt_r or d_t == d_r:
                            tx_resg = t
                            break
                    if tx_resg:
                        tx_resg.preco_unitario = pu_r
                    else:
                        db.add(
                            Transacao(
                                carteira_id=cid,
                                ativo_id=ativo_lcb.id,
                                data_hora=dt_r,
                                tipo_operacao=TipoOperacao.SELL,
                                quantidade=q_r,
                                preco_unitario=pu_r,
                                taxas=ZERO,
                                moeda="BRL",
                            )
                        )

    db.flush()

    # Corrigir transações de SELL com PU <= 0 para Renda Fixa
    rf_ativos = (
        db.query(Ativo)
        .filter(Ativo.tipo == TipoAtivo.RendaFixa)
        .all()
    )

    def _op_priority(tipo: TipoOperacao) -> int:
        if tipo in (TipoOperacao.TRANSFERENCIA_ENTRADA, TipoOperacao.BONIFICACAO, TipoOperacao.DIREITO_SUBSCRICAO):
            return 0
        elif tipo == TipoOperacao.BUY:
            return 1
        else:
            return 3

    def _tx_sort_key(t: Transacao):
        dt = t.data_hora
        if dt is not None and dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        dt_val = dt or datetime.min
        dt_day = dt_val.date() if hasattr(dt_val, "date") else dt_val
        return (dt_day, _op_priority(t.tipo_operacao), dt_val, t.id or 0)

    transacoes_corrigidas = 0
    for cid in carteiras_ids:
        for ativo in rf_ativos:
            txs = (
                db.query(Transacao)
                .filter(
                    Transacao.carteira_id == cid,
                    Transacao.ativo_id == ativo.id,
                )
                .all()
            )
            if not txs:
                continue

            txs.sort(key=_tx_sort_key)

            saldo = ZERO
            custo_total = ZERO
            preco_medio = ZERO

            for tx in txs:
                fator_ptax = tx.ptax_utilizada if tx.ptax_utilizada is not None else Decimal("1.0")
                if tx.tipo_operacao in (TipoOperacao.BUY, TipoOperacao.TRANSFERENCIA_ENTRADA):
                    if tx.preco_unitario > ZERO:
                        custo_op = (tx.quantidade * tx.preco_unitario) * fator_ptax + (tx.taxas or ZERO)
                        saldo += tx.quantidade
                        custo_total += custo_op
                        if saldo > ZERO:
                            preco_medio = custo_total / saldo
                elif tx.tipo_operacao == TipoOperacao.SELL:
                    if tx.preco_unitario <= ZERO:
                        pm_corrigido = preco_medio if preco_medio > ZERO else ZERO
                        if pm_corrigido > ZERO:
                            tx.preco_unitario = pm_corrigido.quantize(Decimal("0.00000001"))
                            transacoes_corrigidas += 1
                    qtd_baixa = min(tx.quantidade, saldo)
                    custo_baixa = qtd_baixa * preco_medio
                    saldo = max(ZERO, saldo - tx.quantidade)
                    custo_total = max(ZERO, custo_total - custo_baixa)
                    if saldo > ZERO and custo_total > ZERO:
                        preco_medio = custo_total / saldo

        db.flush()
        recalcular_posicoes_carteira(db=db, carteira_id=cid)

    db.commit()

    return {
        "status": "success",
        "carteira_id": carteira_id,
        "carteiras_processadas": carteiras_ids,
        "ghosts_removidos": ghosts_removidos,
        "transacoes_corrigidas": transacoes_corrigidas,
        "mensagem": f"Saneamento de Renda Fixa concluído: {len(ghosts_removidos)} ativos fantasmas removidos, {transacoes_corrigidas} transações corrigidas em {len(carteiras_ids)} carteiras.",
    }


