import io
import re
import unicodedata
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone, date
from decimal import Decimal
from typing import BinaryIO, Dict, List, Optional, Union
import pandas as pd
from sqlalchemy.orm import Session

from app.models.ativo import Ativo
from app.models.enums import TipoAtivo, TipoOperacao, ProdutoRendaFixa
from app.models.renda_fixa import DetalhesRendaFixa
from app.models.posicao import PosicaoConsolidada
from app.models.transacao import Transacao
from app.schemas.transacao import TransacaoCreate
from app.services.portfolio import processar_transacao, recalcular_posicoes_carteira, PortfolioError
from app.services.ingestion.parser_b3 import inferir_tipo_ativo, to_decimal
from app.services.ingestion.classificador_renda_fixa import classificar_renda_fixa
from app.services.classificador_setor import obter_setor_padrao

ANO_E_VENCIMENTO_MOVIMENTACAO = False
ZERO = Decimal("0.0")

def normalize_col(col: str) -> str:
    """Remove acentuações e padroniza string para comparação robusta."""
    return "".join(c for c in unicodedata.normalize("NFKD", str(col)) if not unicodedata.combining(c)).lower().strip()

@dataclass
class LinhaMovimentacao:
    idx: int
    data_hora: datetime
    data_dia: date
    mov_str: str
    norm_mov: str
    sentido: str  # "credito" ou "debito"
    raw_produto: str
    ticker_bruto: str
    ticker: str
    quantidade: Decimal
    preco_unitario: Decimal
    valor_total: Decimal
    info_rf: Optional[object]

def processar_planilha_movimentacao_b3(
    db: Session,
    file_content: Union[BinaryIO, bytes, List[Union[BinaryIO, bytes]]],
    carteira_id: Optional[int] = 1,
    apenas_renda_fixa: bool = False,
) -> Dict[str, Union[List[Transacao], List[str]]]:
    """
    Lê uma ou múltiplas planilhas de 'Movimentação' da B3 via Pandas.
    Ordena cronologicamente todos os eventos e aplica as regras:
      1. Rastreamento e diferenciação de Transferência - Liquidação vs. Empréstimo BTC.
      2. Deduplicação e ignorar transferência de custódia XP -> BTG (par débito/crédito).
      3. Criação de TRANSFERENCIA_ENTRADA (PU=0) para saldos iniciais líquidos de 2022.
      4. Sucessão de tickers (TRPL4 -> ISAE4, PMIS15 -> PMIS11).
      5. Resgate de A7RN11 liquidando AESB3.
      6. Exercício de subscrição de ITSA2 convertendo em compra de ITSA4.
      7. Ignorar direitos transitórios sem custo expirados.
      8. Desdobro, Grupamento, Fração em Ativos, Leilão de Fração e Proventos (incluindo Reembolso).
    """
    raw_inputs = file_content if isinstance(file_content, list) else [file_content]
    dfs: List[pd.DataFrame] = []

    for item in raw_inputs:
        if isinstance(item, bytes):
            item = io.BytesIO(item)
        try:
            df_item = pd.read_excel(item)
            if not df_item.empty:
                dfs.append(df_item)
        except Exception as exc:
            pass

    if not dfs:
        return {"transacoes": [], "avisos": ["Nenhum arquivo válido para processar."]}

    df = pd.concat(dfs, ignore_index=True) if len(dfs) > 1 else dfs[0]

    col_map: Dict[str, str] = {}
    for col in df.columns:
        norm = normalize_col(col)
        if "data" in norm and "liquidacao" not in norm:
            col_map["data"] = col
        elif "movimenta" in norm or "tipo" in norm or "evento" in norm or "descri" in norm:
            if "ativo" not in norm and "produto" not in norm:
                col_map["movimentacao"] = col
        elif "codigo" in norm or "ticker" in norm or "produto" in norm or "ativo" in norm:
            if "tipo" not in norm:
                col_map["ticker"] = col
        elif "quantidade" in norm or "qtd" in norm:
            col_map["quantidade"] = col
        elif "preco" in norm or "valor unit" in norm or "cotacao" in norm:
            col_map["preco"] = col
        elif "entrada" in norm or "saida" in norm or "sentido" in norm:
            col_map["entrada_saida"] = col
        elif "valor total" in norm or "operacao" in norm or "valor da op" in norm:
            col_map["valor_total"] = col

    if "ticker" not in col_map or "quantidade" not in col_map:
        raise ValueError(
            f"Formato da planilha de Movimentação B3 inválido. Colunas obrigatórias 'Código/Produto' e 'Quantidade' não localizadas: {list(df.columns)}"
        )

    # Conversão de datas flexível
    if "data" in col_map:
        def _parse_dt(v):
            if pd.isna(v):
                return pd.NaT
            if isinstance(v, (pd.Timestamp, datetime)):
                return v
            s = str(v).strip()
            if re.match(r"^\d{4}-\d{2}-\d{2}", s):
                return pd.to_datetime(s, errors="coerce")
            return pd.to_datetime(s, dayfirst=True, format="mixed", errors="coerce")

        df["_data_dt"] = df[col_map["data"]].apply(_parse_dt)
    else:
        df["_data_dt"] = datetime.now(timezone.utc)

    # Ordenação intra-dia: preservar índice reverso intra-dia e priorizar créditos antes de débitos
    sentido_col = col_map.get("entrada_saida")
    if sentido_col and sentido_col in df.columns:
        sentido_series = df[sentido_col].astype(str).apply(normalize_col)
        df["_sentido_prio"] = sentido_series.apply(lambda s: 1 if ("debito" in s or "saida" in s) else 0)
    else:
        df["_sentido_prio"] = 0

    df["_row_order"] = range(len(df) - 1, -1, -1)
    df = df.sort_values(["_data_dt", "_sentido_prio", "_row_order"]).reset_index(drop=True)

    # Pré-escaneamento e estruturação de linhas
    linhas: List[LinhaMovimentacao] = []
    for idx, row in df.iterrows():
        mov_str = str(row.get(col_map.get("movimentacao", ""), "")).strip()
        norm_mov = normalize_col(mov_str)

        sentido_str = normalize_col(row.get(col_map.get("entrada_saida", ""), ""))
        eh_debito = "debito" in sentido_str or "saida" in sentido_str
        sentido = "debito" if eh_debito else "credito"

        raw_produto = str(row.get(col_map.get("ticker", ""), "")).strip()
        info_rf = classificar_renda_fixa(raw_produto, ano_e_vencimento=ANO_E_VENCIMENTO_MOVIMENTACAO)

        ticker_raw = re.split(r"[\s\-]+", raw_produto.upper())[0].strip()
        if len(ticker_raw) == 6 and ticker_raw.endswith("F") and ticker_raw[:5].isalnum():
            ticker_limpo = ticker_raw[:-1]
        else:
            ticker_limpo = ticker_raw

        # Sucessão de Tickers
        if ticker_limpo == "TRPL4":
            ticker_mapeado = "ISAE4"
        elif ticker_limpo == "PMIS15":
            ticker_mapeado = "PMIS11"
        else:
            ticker_mapeado = ticker_limpo

        q_dec = to_decimal(row[col_map["quantidade"]]) if "quantidade" in col_map and pd.notna(row[col_map["quantidade"]]) else ZERO
        p_dec = to_decimal(row[col_map["preco"]]) if "preco" in col_map and pd.notna(row[col_map["preco"]]) else ZERO
        v_dec = to_decimal(row[col_map["valor_total"]]) if "valor_total" in col_map and pd.notna(row[col_map["valor_total"]]) else ZERO

        dt_val = row["_data_dt"]
        if pd.isna(dt_val):
            dt_val = datetime.now(timezone.utc)
        elif hasattr(dt_val, "to_pydatetime"):
            dt_val = dt_val.to_pydatetime()

        d_dia = dt_val.date() if hasattr(dt_val, "date") else dt_val

        linhas.append(
            LinhaMovimentacao(
                idx=idx,
                data_hora=dt_val,
                data_dia=d_dia,
                mov_str=mov_str,
                norm_mov=norm_mov,
                sentido=sentido,
                raw_produto=raw_produto,
                ticker_bruto=ticker_raw,
                ticker=ticker_mapeado,
                quantidade=q_dec,
                preco_unitario=p_dec,
                valor_total=v_dec,
                info_rf=info_rf,
            )
        )

    # Estado de simulação e processamento contábil
    saldo_custodia = defaultdict(Decimal)
    saldo_custodia_rf = defaultdict(Decimal)
    custo_acum_rf = defaultdict(Decimal)
    qtd_acum_rf = defaultdict(Decimal)
    pm_corrente_rf = defaultdict(Decimal)
    linhas_rf_processadas: set = set()

    transacoes_criadas: List[Transacao] = []
    avisos: List[str] = []
    transacoes_duplicadas_ids: set[int] = set()
    transacoes_criadas_ids: set[int] = set()

    # Helpers de janela deslizante
    def _tem_emprestimo_em_janela(ticker: str, qtd: Decimal, d_base: date, dias_antes: int = 5, dias_depois: int = 1) -> bool:
        for l in linhas:
            if l.ticker == ticker and abs(l.quantidade - qtd) < Decimal("0.0001"):
                diff = (d_base - l.data_dia).days
                if -dias_depois <= diff <= dias_antes:
                    if "emprestimo" in l.norm_mov:
                        return True
        return False

    def _tem_par_transferencia_pu0(ticker: str, qtd: Decimal, d_base: date, dias_antes: int = 5, dias_depois: int = 1) -> bool:
        tem_cred = False
        tem_deb = False
        for l in linhas:
            if l.ticker == ticker and abs(l.quantidade - qtd) < Decimal("0.0001") and (l.preco_unitario == ZERO or l.valor_total == ZERO):
                diff = (d_base - l.data_dia).days
                if -dias_depois <= diff <= dias_antes and "transferencia" in l.norm_mov:
                    if l.sentido == "credito":
                        tem_cred = True
                    elif l.sentido == "debito":
                        tem_deb = True
        return tem_cred and tem_deb

    def _tem_debito_transferencia_janela2d(ticker: str, qtd: Decimal, d_base: date) -> bool:
        for l in linhas:
            if l.ticker == ticker and abs(l.quantidade - qtd) < Decimal("0.0001") and (l.preco_unitario == ZERO or l.valor_total == ZERO) and l.sentido == "debito":
                diff = abs((l.data_dia - d_base).days)
                if diff <= 2 and "transferencia" in l.norm_mov and "liquidacao" not in l.norm_mov:
                    return True
        return False

    # Processamento sequencial
    for linha in linhas:
        # Se apenas_renda_fixa estiver ativo, ignora qualquer ativo que não seja Renda Fixa
        if apenas_renda_fixa and not linha.info_rf:
            continue

        # 1. Ignora previsões/provisões futuras
        if any(p in linha.norm_mov for p in ["provisionado", "previsao", "a receber"]):
            continue

        # 2. Ignora expressamente linhas terminadas em "- Transferido"
        if linha.mov_str.strip().endswith("- Transferido") or linha.norm_mov.endswith("transferido"):
            continue

        # 3. Tratamento de Renda Fixa
        if apenas_renda_fixa and not linha.info_rf:
            continue

        if linha.info_rf:
            info_rf = linha.info_rf
            ticker = info_rf.ticker
            nome_ativo = info_rf.nome
            tipo_ativo = TipoAtivo.RendaFixa

            if "amortizacao" in linha.norm_mov:
                tipo_operacao = TipoOperacao.AMORTIZACAO
            elif "juros" in linha.norm_mov or "rendimento" in linha.norm_mov:
                tipo_operacao = TipoOperacao.JUROS_CUPOM
            elif "vencimento" in linha.norm_mov or "resgate" in linha.norm_mov:
                tipo_operacao = TipoOperacao.SELL
            elif (
                "compra / venda" in linha.norm_mov
                or "compra/venda" in linha.norm_mov
                or "compra e venda" in linha.norm_mov
                or ("compra" in linha.norm_mov and "venda" in linha.norm_mov)
            ):
                tipo_operacao = TipoOperacao.SELL if linha.sentido == "debito" else TipoOperacao.BUY
            elif "venda" in linha.norm_mov:
                tipo_operacao = TipoOperacao.SELL
            elif "aplicacao" in linha.norm_mov or "compra" in linha.norm_mov:
                tipo_operacao = TipoOperacao.SELL if linha.sentido == "debito" else TipoOperacao.BUY
            elif "liquidacao" in linha.norm_mov:
                tipo_operacao = TipoOperacao.SELL if linha.sentido == "debito" else TipoOperacao.BUY
            elif any(t in linha.norm_mov for t in ["transferencia", "cessao", "doacao", "deposito", "custodia"]):
                if linha.sentido == "debito":
                    continue
                tipo_operacao = TipoOperacao.TRANSFERENCIA_ENTRADA
            else:
                continue

            q_dec = linha.quantidade
            v_dec = linha.valor_total
            if v_dec == ZERO and linha.preco_unitario > ZERO and q_dec > ZERO:
                v_dec = (q_dec * linha.preco_unitario).quantize(Decimal("0.01"))

            # Deduplicação de linhas idênticas da B3 no mesmo arquivo/dia para Renda Fixa
            rf_tuple = (linha.data_dia, ticker, tipo_operacao, q_dec, v_dec)
            if rf_tuple in linhas_rf_processadas:
                continue
            linhas_rf_processadas.add(rf_tuple)

            # Precisão Decimal de 8 casas decimais calculando a partir de valor_operacao / quantidade
            preco_calculado = (
                (v_dec / q_dec).quantize(Decimal("0.00000001"))
                if (v_dec > ZERO and q_dec > ZERO)
                else ZERO
            )

            if tipo_operacao in (TipoOperacao.AMORTIZACAO, TipoOperacao.JUROS_CUPOM):
                if q_dec > ZERO:
                    quantidade = q_dec
                    preco_unitario = preco_calculado if preco_calculado > ZERO else linha.preco_unitario
                else:
                    quantidade = Decimal("1.0")
                    preco_unitario = v_dec
            elif tipo_operacao == TipoOperacao.SELL:
                # Inicializa saldo em custódia a partir do banco de dados se for o primeiro evento do ativo
                if ticker not in saldo_custodia_rf:
                    pos_existente_db = (
                        db.query(PosicaoConsolidada)
                        .join(Ativo)
                        .filter(
                            PosicaoConsolidada.carteira_id == (carteira_id or 1),
                            (Ativo.ticker == ticker)
                            | (Ativo.ticker == ticker.replace("CDB-", ""))
                            | (Ativo.ticker == f"CDB-{ticker}"),
                        )
                        .first()
                    )
                    saldo_custodia_rf[ticker] = pos_existente_db.quantidade_saldo if (pos_existente_db and pos_existente_db.quantidade_saldo > ZERO) else ZERO
                    if pos_existente_db and pos_existente_db.preco_medio_brl > ZERO:
                        pm_corrente_rf[ticker] = pos_existente_db.preco_medio_brl
                        custo_acum_rf[ticker] = saldo_custodia_rf[ticker] * pos_existente_db.preco_medio_brl

                # 1. Verifica se a transação já existe gravada no banco (ex.: reimportação da planilha)
                ativo_db = (
                    db.query(Ativo)
                    .filter(
                        (Ativo.ticker == ticker)
                        | (Ativo.ticker == ticker.replace("CDB-", ""))
                        | (Ativo.ticker == f"CDB-{ticker}")
                    )
                    .first()
                )
                d_linha = linha.data_hora.date() if hasattr(linha.data_hora, "date") else linha.data_hora
                tx_ja_gravada = None
                if ativo_db:
                    txs_cand = (
                        db.query(Transacao)
                        .filter(
                            Transacao.carteira_id == (carteira_id or 1),
                            Transacao.ativo_id == ativo_db.id,
                            Transacao.tipo_operacao == TipoOperacao.SELL,
                            Transacao.quantidade == q_dec,
                        )
                        .all()
                    )
                    for cand in txs_cand:
                        if cand.id in transacoes_duplicadas_ids or cand.id in transacoes_criadas_ids:
                            continue
                        d_cand = cand.data_hora.date() if hasattr(cand.data_hora, "date") else cand.data_hora
                        if cand.data_hora == linha.data_hora or (d_cand and d_linha and d_cand == d_linha):
                            tx_ja_gravada = cand
                            break

                if tx_ja_gravada:
                    # Já existe no banco: atualiza PU se aplicável e marca como duplicado sem tentar recriar
                    match_fin = (
                        (v_dec > ZERO and abs((tx_ja_gravada.quantidade * tx_ja_gravada.preco_unitario) - v_dec) < Decimal("0.05"))
                        or (q_dec > ZERO and preco_calculado > ZERO and abs((tx_ja_gravada.quantidade * tx_ja_gravada.preco_unitario) - (q_dec * preco_calculado)) < Decimal("0.05"))
                    )
                    if v_dec > ZERO and q_dec > ZERO and (
                        abs(tx_ja_gravada.preco_unitario - linha.preco_unitario) < Decimal("0.0001")
                        or abs(tx_ja_gravada.preco_unitario - preco_calculado) < Decimal("0.05")
                        or match_fin
                    ):
                        if preco_calculado > ZERO:
                            tx_ja_gravada.preco_unitario = preco_calculado
                    elif v_dec == ZERO and linha.preco_unitario == ZERO and tx_ja_gravada.preco_unitario == ZERO:
                        pm_venc = pm_corrente_rf.get(ticker, ZERO)
                        if pm_venc > ZERO:
                            tx_ja_gravada.preco_unitario = pm_venc
                    if qtd_acum_rf[ticker] > ZERO:
                        saldo_custodia_rf[ticker] = max(ZERO, saldo_custodia_rf[ticker] - q_dec)
                        custo_acum_rf[ticker] = max(ZERO, saldo_custodia_rf[ticker] * pm_corrente_rf.get(ticker, ZERO))
                    transacoes_duplicadas_ids.add(tx_ja_gravada.id)
                    continue

                # 2. Se NÃO existe no banco, é uma nova operação de SELL
                quantidade = q_dec
                saldo_custodia_rf[ticker] = max(ZERO, saldo_custodia_rf[ticker] - quantidade)
                custo_acum_rf[ticker] = max(ZERO, saldo_custodia_rf[ticker] * pm_corrente_rf.get(ticker, ZERO))

                if v_dec > ZERO and q_dec > ZERO:
                    preco_unitario = preco_calculado
                elif v_dec == ZERO and linha.preco_unitario == ZERO:
                    # Baixa por Vencimento / Resgate com PU=0 e Valor=0 da B3:
                    # Dá baixa pelo Preço Médio de aquisição atual
                    pm_atual = pm_corrente_rf.get(ticker, ZERO)
                    if pm_atual == ZERO and ativo_db:
                        pos_existente = (
                            db.query(PosicaoConsolidada)
                            .filter(
                                PosicaoConsolidada.carteira_id == (carteira_id or 1),
                                PosicaoConsolidada.ativo_id == ativo_db.id,
                            )
                            .first()
                        )
                        if pos_existente and pos_existente.quantidade_saldo > ZERO and pos_existente.preco_medio_brl > ZERO:
                            pm_atual = pos_existente.preco_medio_brl
                        elif pos_existente and pos_existente.custo_total_brl > ZERO and pos_existente.quantidade_saldo > ZERO:
                            pm_atual = (pos_existente.custo_total_brl / pos_existente.quantidade_saldo).quantize(Decimal("0.00000001"))

                        if pm_atual == ZERO:
                            txs_compra = (
                                db.query(Transacao)
                                .filter(
                                    Transacao.carteira_id == (carteira_id or 1),
                                    Transacao.ativo_id == ativo_db.id,
                                    Transacao.tipo_operacao.in_([TipoOperacao.BUY, TipoOperacao.TRANSFERENCIA_ENTRADA]),
                                    Transacao.preco_unitario > ZERO,
                                )
                                .all()
                            )
                            if txs_compra:
                                total_qtd_compra = sum(t.quantidade for t in txs_compra)
                                total_custo_compra = sum(t.quantidade * t.preco_unitario for t in txs_compra)
                                if total_qtd_compra > ZERO:
                                    pm_atual = (total_custo_compra / total_qtd_compra).quantize(Decimal("0.00000001"))

                    if pm_atual == ZERO and qtd_acum_rf[ticker] > ZERO and custo_acum_rf[ticker] > ZERO:
                        pm_atual = (custo_acum_rf[ticker] / qtd_acum_rf[ticker]).quantize(Decimal("0.00000001"))

                    preco_unitario = pm_atual
                    if pm_atual > ZERO:
                        avisos.append(
                            f"Baixa/Vencimento de {ticker} registrado pelo Preço Médio (R$ {pm_atual:.4f}) "
                            f"por ausência de valor na B3. Usuário pode editar o valor do resgate se desejar."
                        )
                elif linha.preco_unitario > ZERO:
                    preco_unitario = linha.preco_unitario
                else:
                    preco_unitario = ZERO
            else:  # BUY ou TRANSFERENCIA_ENTRADA
                quantidade = q_dec
                if v_dec > ZERO and q_dec > ZERO:
                    preco_unitario = preco_calculado
                elif linha.preco_unitario > ZERO:
                    preco_unitario = linha.preco_unitario
                else:
                    preco_unitario = ZERO

                saldo_custodia_rf[ticker] += quantidade
                if preco_unitario > ZERO:
                    custo_acum_rf[ticker] += (quantidade * preco_unitario)
                    qtd_acum_rf[ticker] += quantidade
                    if saldo_custodia_rf[ticker] > ZERO:
                        pm_corrente_rf[ticker] = (custo_acum_rf[ticker] / saldo_custodia_rf[ticker]).quantize(Decimal("0.00000001"))

            if quantidade <= ZERO:
                continue

        else:
            # 4. Renda Variável: Ações, FIIs, etc.
            ticker = linha.ticker
            tipo_operacao = None
            tipo_ativo = None
            nome_ativo = None

            # Ignora completamente qualquer linha com Atualização para RV (ex: ITSA4)
            if "atualizacao" in linha.norm_mov:
                continue

            # Ignora completamente qualquer linha cujo ticker seja ITSA10
            if ticker == "ITSA10" or linha.ticker_bruto == "ITSA10":
                continue

            # Para ITSA2: processa UNICAMENTE "Direitos de Subscrição - Exercido" com PU > 0 como BUY em ITSA4
            if ticker == "ITSA2" or linha.ticker_bruto == "ITSA2":
                eh_exercido = (
                    ("exercido" in linha.norm_mov or "exercicio" in linha.norm_mov)
                    and "nao exercido" not in linha.norm_mov
                    and (linha.preco_unitario > ZERO or linha.valor_total > ZERO)
                )
                if eh_exercido:
                    ticker = "ITSA4"
                    tipo_operacao = TipoOperacao.BUY
                    quantidade = linha.quantidade
                    preco_unitario = (
                        linha.preco_unitario
                        if linha.preco_unitario > ZERO
                        else ((linha.valor_total / quantidade) if quantidade > ZERO else Decimal("6.70"))
                    )
                    saldo_custodia["ITSA4"] += quantidade
                    tipo_ativo = TipoAtivo.Acao
                    nome_ativo = "Itaúsa PN"
                else:
                    # Ignora todas as demais linhas de ITSA2 (Direito de Subscrição, Cessão, Solicitação, Sobras, etc.)
                    continue

            # Ignora direitos transitórios sem custo expirados ou cedidos
            elif ticker in {"HGLG12", "HGBS12", "KNRI12", "PMIS12", "BBDC1"}:
                continue

            # Incorporação de AESB3 via A7RN11: Resgate pelo valor total da operação
            elif linha.ticker_bruto == "A7RN11" or ticker == "A7RN11":
                if "resgate" in linha.norm_mov or linha.valor_total > ZERO:
                    ticker = "AESB3"
                    tipo_operacao = TipoOperacao.SELL
                    pos_existente = (
                        db.query(PosicaoConsolidada)
                        .join(Ativo)
                        .filter(
                            PosicaoConsolidada.carteira_id == (carteira_id or 1),
                            Ativo.ticker == "AESB3",
                        )
                        .first()
                    )
                    saldo_disp = pos_existente.quantidade_saldo if pos_existente else ZERO
                    quantidade = (
                        saldo_custodia["AESB3"]
                        if saldo_custodia["AESB3"] > ZERO
                        else (saldo_disp if saldo_disp > ZERO else (linha.quantidade if linha.quantidade > ZERO else Decimal("1.0")))
                    )
                    valor_venda = linha.valor_total if linha.valor_total > ZERO else ZERO
                    preco_unitario = (valor_venda / quantidade) if quantidade > ZERO else valor_venda
                    saldo_custodia["AESB3"] = ZERO
                    tipo_ativo = TipoAtivo.Acao
                    nome_ativo = "AES Brasil ON"
                else:
                    # Ignora linhas intermediárias de A7RN11
                    continue

            elif linha.ticker_bruto == "AESB12" or ticker == "AESB12":
                continue

            elif not ticker or ticker == "NAN":
                continue

            if tipo_ativo is None:
                tipo_ativo = inferir_tipo_ativo(ticker)
            if nome_ativo is None:
                nome_ativo = f"Ativo B3 {ticker}"

            # Regra 2.2: Transferência - Liquidação vs. Empréstimo BTC
            eh_liquidacao = "liquidacao" in linha.norm_mov or "transferencia - liquidacao" in linha.norm_mov

            if tipo_operacao is not None:
                pass
            elif eh_liquidacao:
                if "entrada_saida" not in col_map:
                    continue

                p_calc = linha.preco_unitario
                v_calc = linha.valor_total
                if p_calc > ZERO and v_calc == ZERO and linha.quantidade > ZERO:
                    v_calc = p_calc * linha.quantidade
                elif v_calc > ZERO and p_calc == ZERO and linha.quantidade > ZERO:
                    p_calc = v_calc / linha.quantidade

                # Uma linha Transferência - Liquidação é Empréstimo BTC SE E SOMENTE SE:
                # 1. preco_unitario == 0 (ou valor_operacao == 0), OU
                # 2. Existir em janela [-5, +1] dias linha com Movimentação == "Empréstimo" e mesma quantidade Q, OU
                # 3. Existir na mesma janela [-5, +1] dias par casado de Credito e Debito de Transferência (PU == 0) com mesma quantidade Q.
                eh_btc = (
                    (p_calc == ZERO or v_calc == ZERO)
                    or _tem_emprestimo_em_janela(ticker, linha.quantidade, linha.data_dia, dias_antes=5, dias_depois=1)
                    or _tem_par_transferencia_pu0(ticker, linha.quantidade, linha.data_dia, dias_antes=5, dias_depois=1)
                )

                if eh_btc:
                    continue

                # Caso nenhuma das 3 condições ocorra e preco_unitario > 0, é compra ou venda real
                if p_calc > ZERO:
                    if linha.sentido == "debito":
                        tipo_operacao = TipoOperacao.SELL
                        quantidade = linha.quantidade
                        preco_unitario = p_calc
                        saldo_custodia[ticker] = max(ZERO, saldo_custodia[ticker] - quantidade)
                    else:  # credito
                        tipo_operacao = TipoOperacao.BUY
                        quantidade = linha.quantidade
                        preco_unitario = p_calc
                        saldo_custodia[ticker] += quantidade

            # Regra 2.3: Transferência de custódia entre corretoras (PU == 0)
            elif any(t in linha.norm_mov for t in ["transferencia", "cessao", "doacao", "deposito", "custodia"]):
                if linha.sentido == "debito":
                    # Sempre ignora débito de transferência
                    continue

                # É crédito de transferência
                # Se for com preço preenchido:
                if linha.preco_unitario > ZERO or linha.valor_total > ZERO:
                    tipo_operacao = TipoOperacao.TRANSFERENCIA_ENTRADA
                    quantidade = linha.quantidade
                    preco_unitario = (
                        linha.preco_unitario
                        if linha.preco_unitario > ZERO
                        else ((linha.valor_total / quantidade) if quantidade > ZERO else ZERO)
                    )
                    saldo_custodia[ticker] += quantidade
                else:
                    # PU == 0: verifica se há débito na janela de 2 dias (caso XP -> BTG)
                    tem_debito_par = _tem_debito_transferencia_janela2d(ticker, linha.quantidade, linha.data_dia)
                    if tem_debito_par:
                        continue

                    # Só cria TRANSFERENCIA_ENTRADA se o saldo do ativo ainda for ZERO (caso de 23/03/2022)
                    if saldo_custodia[ticker] == ZERO:
                        tipo_operacao = TipoOperacao.TRANSFERENCIA_ENTRADA
                        quantidade = linha.quantidade
                        preco_unitario = ZERO
                        saldo_custodia[ticker] += quantidade
                    else:
                        continue

            # Regra 2.4: Eventos Corporativos e Proventos
            elif "nao exercido" in linha.norm_mov:
                tipo_operacao = TipoOperacao.DIREITO_SUBSCRICAO_EXPIRADO
                preco_unitario = ZERO
                quantidade = linha.quantidade
                saldo_custodia[ticker] = max(ZERO, saldo_custodia[ticker] - quantidade)

            elif "bonifica" in linha.norm_mov:
                tipo_operacao = TipoOperacao.BONIFICACAO
                preco_unitario = ZERO
                quantidade = linha.quantidade
                saldo_custodia[ticker] += quantidade

            elif "desdobro" in linha.norm_mov:
                tipo_operacao = TipoOperacao.DESDOBRO
                preco_unitario = ZERO
                quantidade = linha.quantidade
                saldo_custodia[ticker] += quantidade

            elif "grupamento" in linha.norm_mov:
                tipo_operacao = TipoOperacao.GRUPAMENTO
                preco_unitario = ZERO
                quantidade = linha.quantidade
                saldo_custodia[ticker] = quantidade

            elif "fracao em ativos" in linha.norm_mov or ("fracao" in linha.norm_mov and "leilao" not in linha.norm_mov):
                tipo_operacao = TipoOperacao.FRACAO_ATIVOS
                preco_unitario = ZERO
                quantidade = linha.quantidade
                saldo_custodia[ticker] = max(ZERO, saldo_custodia[ticker] - quantidade)

            elif "leilao" in linha.norm_mov:
                tipo_operacao = TipoOperacao.LEILAO_FRACAO
                quantidade = linha.quantidade if linha.quantidade > ZERO else Decimal("1.0")
                preco_unitario = (
                    (linha.valor_total / quantidade)
                    if (linha.valor_total > ZERO and quantidade > ZERO)
                    else (linha.preco_unitario if linha.preco_unitario > ZERO else linha.valor_total)
                )

            elif "direito" in linha.norm_mov or "subscri" in linha.norm_mov:
                tipo_operacao = TipoOperacao.DIREITO_SUBSCRICAO
                preco_unitario = linha.preco_unitario if linha.preco_unitario > ZERO else ZERO
                quantidade = linha.quantidade
                saldo_custodia[ticker] += quantidade

            elif "dividendo" in linha.norm_mov or "reembolso" in linha.norm_mov:
                tipo_operacao = TipoOperacao.DIVIDENDO
            elif "juros sobre capital" in linha.norm_mov or "juros s/ capital" in linha.norm_mov or "jcp" in linha.norm_mov:
                tipo_operacao = TipoOperacao.JCP
            elif "rendimento" in linha.norm_mov:
                tipo_operacao = TipoOperacao.RENDIMENTO
            elif "emprestimo" in linha.norm_mov:
                if (
                    linha.sentido == "credito"
                    and linha.valor_total > ZERO
                    and (linha.preco_unitario == ZERO or abs(linha.valor_total - (linha.quantidade * linha.preco_unitario)) > Decimal("0.05"))
                ):
                    tipo_operacao = TipoOperacao.RENDIMENTO
                else:
                    continue
            elif "restituicao de capital" in linha.norm_mov or ("amortizacao" in linha.norm_mov and (tipo_ativo == TipoAtivo.FII or "cota" in linha.norm_mov)):
                tipo_operacao = TipoOperacao.RESTITUICAO_CAPITAL
            else:
                continue

            # Extração de quantidade e valor para Proventos
            if tipo_operacao in (
                TipoOperacao.DIVIDENDO,
                TipoOperacao.JCP,
                TipoOperacao.RENDIMENTO,
                TipoOperacao.RESTITUICAO_CAPITAL,
            ):
                q_dec = linha.quantidade
                v_dec = linha.valor_total
                p_dec = linha.preco_unitario

                if v_dec > ZERO and q_dec > ZERO:
                    quantidade = q_dec
                    preco_unitario = v_dec / q_dec
                elif v_dec > ZERO and q_dec <= ZERO:
                    quantidade = Decimal("1.0")
                    preco_unitario = v_dec
                elif v_dec <= ZERO and q_dec > ZERO and p_dec > ZERO:
                    quantidade = q_dec
                    preco_unitario = p_dec
                else:
                    quantidade = ZERO
                    preco_unitario = ZERO

                if (quantidade * preco_unitario) <= ZERO:
                    continue

            if quantidade <= ZERO and tipo_operacao not in (TipoOperacao.FRACAO_ATIVOS,):
                continue

        # Garante a existência do ativo
        ativo = db.query(Ativo).filter(Ativo.ticker == ticker).first()
        if not ativo:
            ativo = Ativo(
                ticker=ticker,
                nome=nome_ativo,
                tipo=tipo_ativo,
                setor=obter_setor_padrao(ticker, tipo_ativo),
            )
            db.add(ativo)
            db.flush()

        if linha.info_rf:
            detalhes_existentes = db.query(DetalhesRendaFixa).filter(DetalhesRendaFixa.ativo_id == ativo.id).first()
            if not detalhes_existentes:
                info_rf = linha.info_rf
                venc_date = info_rf.data_vencimento
                if not venc_date and info_rf.ano_vencimento:
                    if info_rf.produto in (ProdutoRendaFixa.TESOURO_RENDA_MAIS, ProdutoRendaFixa.TESOURO_EDUCA_MAIS):
                        venc_date = date(info_rf.ano_vencimento, 12, 15)
                    else:
                        venc_date = date(info_rf.ano_vencimento, 1, 1)

                dia_pgto = 15 if info_rf.produto in (ProdutoRendaFixa.TESOURO_RENDA_MAIS, ProdutoRendaFixa.TESOURO_EDUCA_MAIS) else None
                emissor_final = info_rf.emissor or ("Tesouro Nacional" if info_rf.produto.value.startswith("TESOURO_") else "Emissor")

                detalhes = DetalhesRendaFixa(
                    ativo_id=ativo.id,
                    produto=info_rf.produto,
                    indexador=info_rf.indexador,
                    emissor=emissor_final,
                    data_vencimento=venc_date,
                    ano_conversao=info_rf.ano_conversao,
                    num_parcelas=info_rf.num_parcelas,
                    dia_pagamento=dia_pgto,
                    isento_ir=info_rf.produto in (ProdutoRendaFixa.LCI, ProdutoRendaFixa.LCA),
                    cobra_custodia_b3=info_rf.produto.value.startswith("TESOURO_"),
                    codigo_mercado=info_rf.codigo_mercado,
                )
                db.add(detalhes)
                db.flush()

        # Deduplicação idempotente para todas as movimentações e proventos da planilha
        operacoes_busca = [tipo_operacao]
        if linha.info_rf and tipo_operacao in (TipoOperacao.BUY, TipoOperacao.TRANSFERENCIA_ENTRADA):
            operacoes_busca = [TipoOperacao.BUY, TipoOperacao.TRANSFERENCIA_ENTRADA]

        txs_existentes = (
            db.query(Transacao)
            .filter(
                Transacao.carteira_id == (carteira_id or 1),
                Transacao.ativo_id == ativo.id,
                Transacao.tipo_operacao.in_(operacoes_busca),
                Transacao.quantidade == quantidade,
            )
            .all()
        )
        eh_duplicado = False
        for tx_ant in txs_existentes:
            if tx_ant.id in transacoes_duplicadas_ids or tx_ant.id in transacoes_criadas_ids:
                continue
            d1 = tx_ant.data_hora.date() if hasattr(tx_ant.data_hora, "date") else tx_ant.data_hora
            d2 = linha.data_hora.date() if hasattr(linha.data_hora, "date") else linha.data_hora
            dt_match = (
                tx_ant.data_hora == linha.data_hora
                or (d1 is not None and d2 is not None and d1 == d2)
            )
            match_preco = abs(tx_ant.preco_unitario - preco_unitario) < Decimal("0.0001")
            match_financeiro = abs((tx_ant.quantidade * tx_ant.preco_unitario) - (quantidade * preco_unitario)) < Decimal("0.05")
            if match_financeiro:
                match_preco = True

            if (
                not match_preco
                and tipo_operacao == TipoOperacao.TRANSFERENCIA_ENTRADA
                and preco_unitario == ZERO
                and tx_ant.preco_unitario > ZERO
            ):
                match_preco = True
            elif (
                not match_preco
                and linha.info_rf
                and tipo_operacao in (TipoOperacao.BUY, TipoOperacao.TRANSFERENCIA_ENTRADA)
                and tx_ant.preco_unitario == ZERO
                and preco_unitario > ZERO
            ):
                tx_ant.preco_unitario = preco_unitario
                match_preco = True
            elif (
                not match_preco
                and tipo_operacao == TipoOperacao.SELL
                and linha.valor_total == ZERO
                and linha.preco_unitario == ZERO
            ):
                # Vencimento com PU=0 da B3: se já existe SELL gravado, preserva o PU já existente ou atualiza
                if tx_ant.preco_unitario == ZERO and preco_unitario > ZERO:
                    tx_ant.preco_unitario = preco_unitario
                match_preco = True
            elif (
                not match_preco
                and linha.info_rf
                and preco_unitario > ZERO
                and tx_ant.preco_unitario > ZERO
                and (
                    abs(tx_ant.preco_unitario - linha.preco_unitario) < Decimal("0.0001")
                    or abs(tx_ant.preco_unitario - preco_unitario) < Decimal("0.05")
                    or match_financeiro
                )
            ):
                # Atualiza PU truncado antigo da B3 para a precisão calculada de 8 casas
                tx_ant.preco_unitario = preco_unitario
                match_preco = True

            if dt_match and match_preco:
                if linha.info_rf and preco_unitario > ZERO and tx_ant.preco_unitario != preco_unitario:
                    tx_ant.preco_unitario = preco_unitario
                if linha.info_rf and tx_ant.tipo_operacao == TipoOperacao.TRANSFERENCIA_ENTRADA and tipo_operacao == TipoOperacao.BUY:
                    tx_ant.tipo_operacao = TipoOperacao.BUY
                eh_duplicado = True
                transacoes_duplicadas_ids.add(tx_ant.id)
                break
        if eh_duplicado:
            continue

        transacao_in = TransacaoCreate(
            carteira_id=carteira_id or 1,
            ativo_id=ativo.id,
            data_hora=linha.data_hora,
            tipo_operacao=tipo_operacao,
            quantidade=quantidade,
            preco_unitario=preco_unitario,
            taxas=Decimal("0.0"),
            moeda="BRL",
            taxa_contratada=None,
        )

        try:
            tx = processar_transacao(db=db, transacao_in=transacao_in)
            transacoes_criadas.append(tx)
            transacoes_criadas_ids.add(tx.id)
        except PortfolioError as p_err:
            avisos.append(
                f"Aviso ao processar {tipo_operacao.value} de {quantidade} {ticker}: {str(p_err)}"
            )

    # Reavalia e consolida todas as posições da carteira de forma idempotente
    recalcular_posicoes_carteira(db=db, carteira_id=carteira_id or 1)

    return {
        "transacoes": transacoes_criadas,
        "avisos": avisos,
    }
