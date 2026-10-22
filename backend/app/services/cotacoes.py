import asyncio
import json
import os
import re
import time
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Dict, Optional, Tuple

import httpx
from sqlalchemy.orm import Session, joinedload

from app.models.ativo import Ativo
from app.models.enums import TipoAtivo, ProdutoRendaFixa, Indexador
from app.models.posicao import PosicaoConsolidada
from app.schemas.posicao import CotacaoItemRead, CotacoesCarteiraResponse
from app.services.renda_fixa.lotes import extrair_lotes_abertos
from app.services.renda_fixa.mercado import obter_cotacoes_tesouro, obter_dados_macro

CACHE_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "cache"
CACHE_FILE = CACHE_DIR / "cotacoes_b3.json"
CACHE_TTL_SECONDS = 900  # 15 minutos

_MEM_CACHE: Dict[str, dict] = {}


def _carregar_cache_disco() -> Dict[str, dict]:
    if not CACHE_FILE.exists():
        return {}
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _salvar_cache_disco(dados: Dict[str, dict]) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp_file = CACHE_DIR / f"cotacoes_b3_{os.getpid()}_{time.time_ns()}.tmp"
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(dados, f, indent=2, default=str)
        tmp_file.replace(CACHE_FILE)
    except Exception:
        pass


async def _consultar_ativo_online(
    ticker: str,
    tipo: TipoAtivo,
    client: httpx.AsyncClient,
    cotacao_usdt_brl: Optional[Decimal] = None,
    cotacao_btc_usd: Optional[Decimal] = None,
) -> Optional[Tuple[Decimal, Decimal, str, Optional[Decimal], Optional[Decimal]]]:
    """
    Consulta o preço de mercado online do ativo.
    Retorna (preco_atual, variacao_diaria_pct, fonte, preco_usd, preco_btc) ou None se falhar.
    """
    clean_ticker = ticker.strip().upper()

    # Ignora Renda Fixa ou tipos não cotados online
    if tipo not in (TipoAtivo.Acao, TipoAtivo.FII, TipoAtivo.Cripto):
        return None

    # 1. Criptomoedas
    if tipo == TipoAtivo.Cripto:
        symbol = clean_ticker[:-3] if clean_ticker.endswith("BRL") and len(clean_ticker) > 3 else clean_ticker
        symbol = symbol.replace("-", "").replace("/", "")

        usdt_brl = cotacao_usdt_brl or Decimal("5.18")
        btc_usd = cotacao_btc_usd or Decimal("70000.00")

        # 1a. Binance API pública: par {symbol}USDT
        try:
            binance_url = f"https://api.binance.com/api/v3/ticker/24hr?symbol={symbol}USDT"
            resp = await client.get(binance_url, headers={"User-Agent": "Mozilla/5.0"})
            if resp.status_code == 200:
                data = resp.json()
                price_usd = Decimal(str(data["lastPrice"]))
                var_pct = Decimal(str(data.get("priceChangePercent", 0.0)))
                price_brl = price_usd * usdt_brl
                price_btc = (price_usd / btc_usd) if btc_usd > Decimal("0") else None
                return (price_brl, var_pct, "BINANCE", price_usd, price_btc)
        except Exception:
            pass

        # 1b. Binance API pública: par {symbol}BRL
        try:
            binance_url = f"https://api.binance.com/api/v3/ticker/24hr?symbol={symbol}BRL"
            resp = await client.get(binance_url, headers={"User-Agent": "Mozilla/5.0"})
            if resp.status_code == 200:
                data = resp.json()
                price_brl = Decimal(str(data["lastPrice"]))
                var_pct = Decimal(str(data.get("priceChangePercent", 0.0)))
                price_usd = (price_brl / usdt_brl) if usdt_brl > Decimal("0") else None
                price_btc = (price_usd / btc_usd) if (price_usd and btc_usd > Decimal("0")) else None
                return (price_brl, var_pct, "BINANCE", price_usd, price_btc)
        except Exception:
            pass

        # 1c. Fallback Cripto: Yahoo Finance em USD
        try:
            yahoo_url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}-USD?interval=1d&range=5d"
            resp = await client.get(yahoo_url, headers={"User-Agent": "Mozilla/5.0"})
            if resp.status_code == 200:
                chart_res = resp.json().get("chart", {}).get("result")
                if chart_res:
                    meta = chart_res[0]["meta"]
                    if meta.get("regularMarketPrice") is not None:
                        price_usd = Decimal(str(meta["regularMarketPrice"]))
                        prev = Decimal(str(meta.get("chartPreviousClose", price_usd)))
                        var_pct = ((price_usd - prev) / prev * Decimal("100.0")) if prev > 0 else Decimal("0.0")
                        price_brl = price_usd * usdt_brl
                        price_btc = (price_usd / btc_usd) if btc_usd > Decimal("0") else None
                        return (price_brl, var_pct, "YAHOO", price_usd, price_btc)
        except Exception:
            pass

        # 1d. Fallback Cripto: Yahoo Finance em BRL
        try:
            yahoo_url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}-BRL?interval=1d&range=5d"
            resp = await client.get(yahoo_url, headers={"User-Agent": "Mozilla/5.0"})
            if resp.status_code == 200:
                chart_res = resp.json().get("chart", {}).get("result")
                if chart_res:
                    meta = chart_res[0]["meta"]
                    if meta.get("regularMarketPrice") is not None:
                        price_brl = Decimal(str(meta["regularMarketPrice"]))
                        prev = Decimal(str(meta.get("chartPreviousClose", price_brl)))
                        var_pct = ((price_brl - prev) / prev * Decimal("100.0")) if prev > 0 else Decimal("0.0")
                        price_usd = (price_brl / usdt_brl) if usdt_brl > Decimal("0") else None
                        price_btc = (price_usd / btc_usd) if (price_usd and btc_usd > Decimal("0")) else None
                        return (price_brl, var_pct, "YAHOO", price_usd, price_btc)
        except Exception:
            pass
        return None

    # 2. Ações e FIIs da B3
    # Fonte primária: Yahoo Finance com sufixo .SA
    ticker_sa = clean_ticker if clean_ticker.endswith(".SA") else f"{clean_ticker}.SA"
    try:
        yahoo_url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker_sa}?interval=1d&range=5d"
        resp = await client.get(yahoo_url, headers={"User-Agent": "Mozilla/5.0"})
        if resp.status_code == 200:
            chart_res = resp.json().get("chart", {}).get("result")
            if chart_res:
                meta = chart_res[0]["meta"]
                if meta.get("regularMarketPrice") is not None:
                    price = Decimal(str(meta["regularMarketPrice"]))
                    prev = Decimal(str(meta.get("chartPreviousClose", price)))
                    var_pct = ((price - prev) / prev * Decimal("100.0")) if prev > 0 else Decimal("0.0")
                    return (price, var_pct, "YAHOO")
    except Exception:
        pass

    # Fonte secundária: BRAPI pública
    ticker_brapi = clean_ticker.replace(".SA", "")
    try:
        brapi_url = f"https://brapi.dev/api/quote/{ticker_brapi}"
        resp = await client.get(brapi_url, headers={"User-Agent": "Mozilla/5.0"})
        if resp.status_code == 200:
            results = resp.json().get("results", [])
            if results and results[0].get("regularMarketPrice") is not None:
                res = results[0]
                price = Decimal(str(res["regularMarketPrice"]))
                var_pct = Decimal(str(res.get("regularMarketChangePercent", 0.0)))
                return (price, var_pct, "BRAPI")
    except Exception:
        pass

    return None


def _calcular_dias_uteis(d_ini: date, d_fim: date) -> int:
    if d_ini >= d_fim:
        return 0
    cur = d_ini
    uteis = 0
    while cur < d_fim:
        cur += timedelta(days=1)
        if cur.weekday() < 5:  # Segunda a sexta-feira
            uteis += 1
    return uteis


async def _obter_cotacao_renda_fixa(
    ativo: Ativo,
    pos: PosicaoConsolidada,
    db: Session,
    carteira_id: int,
    client: Optional[httpx.AsyncClient] = None,
    forcar: bool = False,
) -> CotacaoItemRead:
    now_dt = datetime.now(timezone.utc)
    ticker = ativo.ticker
    pm = pos.preco_medio_brl if pos.preco_medio_brl > Decimal("0.0") else Decimal("0.0")

    # 1. Cotação manual
    if ativo.cotacao_manual is not None and ativo.cotacao_manual > Decimal("0.0"):
        return CotacaoItemRead(
            ticker=ticker,
            preco_atual=ativo.cotacao_manual,
            variacao_diaria_pct=Decimal("0.0"),
            fonte="MANUAL",
            atualizado_em=now_dt,
            stale=False,
        )

    detalhes = ativo.detalhes_rf
    eh_tesouro = (
        ticker.startswith("TD-RENDA+")
        or (ativo.setor == "Tesouro Direto")
        or (
            detalhes
            and detalhes.produto
            and (
                detalhes.produto == ProdutoRendaFixa.TESOURO_RENDA_MAIS
                or str(detalhes.produto.value).startswith("TESOURO_")
            )
        )
    )

    # 2. Tesouro Direto: busca preço de resgate no bonds.json
    if eh_tesouro:
        try:
            env_tesouro = await obter_cotacoes_tesouro(forcar=forcar, client=client)
            items = env_tesouro.dados.results
            codigo_procurado = (
                detalhes.codigo_mercado.lower().strip()
                if (detalhes and detalhes.codigo_mercado)
                else ""
            )
            t_clean = ticker.upper()

            item_encontrado = None
            for it in items:
                sym = it.symbol.lower().strip()
                if codigo_procurado and sym == codigo_procurado:
                    item_encontrado = it
                    break
                ano_match = re.search(r"\b(20\d{2})\b", ticker)
                ano_str = ano_match.group(1) if ano_match else ""
                if ano_str and ano_str in sym:
                    if "renda" in t_clean.lower() and "renda" in sym:
                        item_encontrado = it
                        break
                    elif "educa" in t_clean.lower() and "educa" in sym:
                        item_encontrado = it
                        break
                    elif "ipca" in t_clean.lower() and "ipca" in sym:
                        item_encontrado = it
                        break
                    elif "selic" in t_clean.lower() and "selic" in sym:
                        item_encontrado = it
                        break
                    elif "pre" in t_clean.lower() and "prefixado" in sym:
                        item_encontrado = it
                        break

            if item_encontrado and getattr(item_encontrado, "sellPrice", 0) > 0:
                pu_resgate = Decimal(str(item_encontrado.sellPrice))
                return CotacaoItemRead(
                    ticker=ticker,
                    preco_atual=pu_resgate,
                    variacao_diaria_pct=Decimal("0.0"),
                    fonte="TESOURO",
                    atualizado_em=now_dt,
                    stale=env_tesouro.stale,
                )
        except Exception:
            pass

        return CotacaoItemRead(
            ticker=ticker,
            preco_atual=pm,
            variacao_diaria_pct=Decimal("0.0"),
            fonte="TESOURO" if pm > Decimal("0.0") else "INDISPONIVEL",
            atualizado_em=now_dt,
            stale=False,
        )

    # 3. CDB / LCI / LCA pós-fixado em CDI via Curva do CDI
    eh_bancario = (
        ticker.startswith(("CDB-", "CDB", "LCI-", "LCI", "LCA-", "LCA", "LC-", "LC"))
        or (
            detalhes
            and detalhes.produto
            in (
                ProdutoRendaFixa.CDB,
                ProdutoRendaFixa.LCI,
                ProdutoRendaFixa.LCA,
                ProdutoRendaFixa.LC,
            )
        )
    )

    if eh_bancario:
        try:
            posicoes_rf = extrair_lotes_abertos(db=db, carteira_id=carteira_id, ativo_id=ativo.id)
            lotes_abertos = posicoes_rf[0].lotes if posicoes_rf else []

            if lotes_abertos:
                cdi_anual = Decimal("10.65")  # fallback 10,65% a.a.
                try:
                    macro = await obter_dados_macro(forcar=forcar, client=client)
                    if macro and macro.cdi and macro.cdi.valor_anualizado_pct > Decimal("0.0"):
                        cdi_anual = macro.cdi.valor_anualizado_pct
                except Exception:
                    pass

                hoje = date.today()
                valor_total_curva = Decimal("0.0")
                qtd_total_aberta = Decimal("0.0")

                for lote in lotes_abertos:
                    dias_uteis = _calcular_dias_uteis(lote.data_compra, hoje)
                    taxa_pct_cdi = (
                        lote.taxa_contratada
                        if (lote.taxa_contratada is not None and lote.taxa_contratada > Decimal("0.0"))
                        else Decimal("100.0")
                    )
                    if dias_uteis > 0:
                        cdi_diario = (
                            Decimal("1.0") + (cdi_anual / Decimal("100.0"))
                        ) ** (Decimal("1.0") / Decimal("252.0")) - Decimal("1.0")
                        taxa_efetiva = cdi_diario * (taxa_pct_cdi / Decimal("100.0"))
                        fator_curva = (Decimal("1.0") + taxa_efetiva) ** Decimal(dias_uteis)
                        pu_lote = (lote.preco_unitario * fator_curva).quantize(Decimal("0.00000001"))
                    else:
                        pu_lote = lote.preco_unitario

                    valor_total_curva += lote.quantidade_aberta * pu_lote
                    qtd_total_aberta += lote.quantidade_aberta

                if qtd_total_aberta > Decimal("0.0"):
                    pu_curva = (valor_total_curva / qtd_total_aberta).quantize(Decimal("0.00000001"))
                    return CotacaoItemRead(
                        ticker=ticker,
                        preco_atual=pu_curva,
                        variacao_diaria_pct=Decimal("0.0"),
                        fonte="CURVA_CDI",
                        atualizado_em=now_dt,
                        stale=False,
                    )
        except Exception:
            pass

        return CotacaoItemRead(
            ticker=ticker,
            preco_atual=pm,
            variacao_diaria_pct=Decimal("0.0"),
            fonte="CURVA_CDI" if pm > Decimal("0.0") else "INDISPONIVEL",
            atualizado_em=now_dt,
            stale=False,
        )

    # Fallback genérico para Renda Fixa não classificada
    return CotacaoItemRead(
        ticker=ticker,
        preco_atual=pm,
        variacao_diaria_pct=Decimal("0.0"),
        fonte="INDISPONIVEL",
        atualizado_em=now_dt,
        stale=False,
    )


async def obter_cotacoes_carteira(
    db: Session,
    carteira_id: int = 1,
    forcar: bool = False,
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> CotacoesCarteiraResponse:
    """
    Retorna as cotações de mercado para todos os ativos em custódia na carteira especificada.
    Hierarquia:
      1. Cotação manual (ativo.cotacao_manual) -> imediato, stale=False
      2. Cache em memória / disco (idade < 15 min se forcar=False) -> fonte="CACHE", stale=False
      3. Renda Fixa: Tesouro Direto (bonds.json, fonte="TESOURO") e Bancários pós CDI (fonte="CURVA_CDI")
      4. Consulta HTTP assíncrona paralela (Yahoo Finance / brapi / Binance)
      5. Fallback offline (último valor no cache com stale=True ou PM contábil com fonte="INDISPONIVEL")
    """
    posicoes = (
        db.query(PosicaoConsolidada)
        .options(
            joinedload(PosicaoConsolidada.ativo).joinedload(Ativo.detalhes_rf)
        )
        .filter(PosicaoConsolidada.carteira_id == carteira_id)
        .all()
    )

    disk_cache = _carregar_cache_disco()
    now_ts = time.time()
    now_dt = datetime.now(timezone.utc)

    cotacoes_resultado: Dict[str, CotacaoItemRead] = {}
    tickers_para_buscar: list[Tuple[str, TipoAtivo, PosicaoConsolidada]] = []
    posicoes_rf: list[Tuple[Ativo, PosicaoConsolidada]] = []

    for pos in posicoes:
        ativo = pos.ativo
        if not ativo:
            continue
        ticker = ativo.ticker

        # 1. Cotação manual
        if ativo.cotacao_manual is not None and ativo.cotacao_manual > Decimal("0.0"):
            cotacoes_resultado[ticker] = CotacaoItemRead(
                ticker=ticker,
                preco_atual=ativo.cotacao_manual,
                variacao_diaria_pct=Decimal("0.0"),
                fonte="MANUAL",
                atualizado_em=now_dt,
                stale=False,
            )
            continue

        # 2. Cache em memória ou em disco (se not forcar)
        if not forcar:
            cache_entry = _MEM_CACHE.get(ticker) or disk_cache.get(ticker)
            if cache_entry:
                ts = cache_entry.get("timestamp", 0)
                if (now_ts - ts) < CACHE_TTL_SECONDS:
                    fonte_cached = "CACHE" if ativo.tipo != TipoAtivo.RendaFixa else cache_entry.get("fonte", "CACHE")
                    cotacoes_resultado[ticker] = CotacaoItemRead(
                        ticker=ticker,
                        preco_atual=Decimal(str(cache_entry["preco_atual"])),
                        variacao_diaria_pct=Decimal(str(cache_entry.get("variacao_diaria_pct", "0.0"))),
                        fonte=fonte_cached,
                        atualizado_em=datetime.fromtimestamp(ts, tz=timezone.utc),
                        stale=False,
                        preco_usd=Decimal(str(cache_entry["preco_usd"])) if cache_entry.get("preco_usd") is not None else None,
                        preco_btc=Decimal(str(cache_entry["preco_btc"])) if cache_entry.get("preco_btc") is not None else None,
                    )
                    continue

        # Renda Fixa: avaliada pela Curva CDI ou Tesouro Direto
        if ativo.tipo == TipoAtivo.RendaFixa:
            posicoes_rf.append((ativo, pos))
            continue

        # Precisa buscar online (RV e Cripto)
        tickers_para_buscar.append((ticker, ativo.tipo, pos))

    # 3. Consulta online em paralelo (Ações, FIIs e Cripto)
    cotacao_usdt_brl_online: Optional[Decimal] = None
    cotacao_btc_usd_online: Optional[Decimal] = None

    if not forcar:
        cached_usdt = _MEM_CACHE.get("__USDTBRL__") or disk_cache.get("__USDTBRL__")
        if cached_usdt:
            ts_u = cached_usdt.get("timestamp", 0)
            if (now_ts - ts_u) < CACHE_TTL_SECONDS:
                cotacao_usdt_brl_online = Decimal(str(cached_usdt["preco_atual"]))
        cached_btc = _MEM_CACHE.get("__BTCUSDT__") or disk_cache.get("__BTCUSDT__")
        if cached_btc:
            ts_b = cached_btc.get("timestamp", 0)
            if (now_ts - ts_b) < CACHE_TTL_SECONDS:
                cotacao_btc_usd_online = Decimal(str(cached_btc["preco_atual"]))

    if tickers_para_buscar:
        client_kwargs: dict = {"timeout": 6.0}
        if transport is not None:
            client_kwargs["transport"] = transport

        async with httpx.AsyncClient(**client_kwargs) as client:
            tem_cripto = any(tipo == TipoAtivo.Cripto for _, tipo, _ in tickers_para_buscar)
            precisa_taxas = tem_cripto or (cotacao_usdt_brl_online is None) or (cotacao_btc_usd_online is None)
            if precisa_taxas:
                if cotacao_usdt_brl_online is None or tem_cripto:
                    try:
                        r_usdt = await client.get("https://api.binance.com/api/v3/ticker/24hr?symbol=USDTBRL", headers={"User-Agent": "Mozilla/5.0"})
                        if r_usdt.status_code == 200:
                            cotacao_usdt_brl_online = Decimal(str(r_usdt.json()["lastPrice"]))
                            payload_usdt = {"preco_atual": str(cotacao_usdt_brl_online), "timestamp": now_ts}
                            _MEM_CACHE["__USDTBRL__"] = payload_usdt
                            disk_cache["__USDTBRL__"] = payload_usdt
                    except Exception:
                        pass
                if cotacao_btc_usd_online is None or tem_cripto:
                    try:
                        r_btc = await client.get("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT", headers={"User-Agent": "Mozilla/5.0"})
                        if r_btc.status_code == 200:
                            cotacao_btc_usd_online = Decimal(str(r_btc.json()["lastPrice"]))
                            payload_btc = {"preco_atual": str(cotacao_btc_usd_online), "timestamp": now_ts}
                            _MEM_CACHE["__BTCUSDT__"] = payload_btc
                            disk_cache["__BTCUSDT__"] = payload_btc
                    except Exception:
                        pass

            tasks = [
                _consultar_ativo_online(
                    t,
                    tipo,
                    client,
                    cotacao_usdt_brl=cotacao_usdt_brl_online,
                    cotacao_btc_usd=cotacao_btc_usd_online,
                )
                for t, tipo, _ in tickers_para_buscar
            ]
            respostas = await asyncio.gather(*tasks, return_exceptions=True)

        for (ticker, _, pos), resp in zip(tickers_para_buscar, respostas):
            if isinstance(resp, tuple) and resp is not None:
                preco = resp[0]
                var_pct = resp[1]
                fonte = resp[2]
                preco_usd = resp[3] if len(resp) > 3 else None
                preco_btc = resp[4] if len(resp) > 4 else None

                item = CotacaoItemRead(
                    ticker=ticker,
                    preco_atual=preco,
                    variacao_diaria_pct=var_pct,
                    fonte=fonte,
                    atualizado_em=now_dt,
                    stale=False,
                    preco_usd=preco_usd,
                    preco_btc=preco_btc,
                )
                cotacoes_resultado[ticker] = item

                # Atualiza memória e disco
                cache_payload = {
                    "preco_atual": str(preco),
                    "variacao_diaria_pct": str(var_pct),
                    "fonte": fonte,
                    "preco_usd": str(preco_usd) if preco_usd is not None else None,
                    "preco_btc": str(preco_btc) if preco_btc is not None else None,
                    "timestamp": now_ts,
                }
                _MEM_CACHE[ticker] = cache_payload
                disk_cache[ticker] = cache_payload
            else:
                # 4. Fallback Offline
                cached = disk_cache.get(ticker) or _MEM_CACHE.get(ticker)
                if cached:
                    ts = cached.get("timestamp", now_ts)
                    cotacoes_resultado[ticker] = CotacaoItemRead(
                        ticker=ticker,
                        preco_atual=Decimal(str(cached["preco_atual"])),
                        variacao_diaria_pct=Decimal(str(cached.get("variacao_diaria_pct", "0.0"))),
                        fonte=cached.get("fonte", "CACHE"),
                        atualizado_em=datetime.fromtimestamp(ts, tz=timezone.utc),
                        stale=True,
                        preco_usd=Decimal(str(cached["preco_usd"])) if cached.get("preco_usd") is not None else None,
                        preco_btc=Decimal(str(cached["preco_btc"])) if cached.get("preco_btc") is not None else None,
                    )
                else:
                    pm = pos.preco_medio_brl if pos.preco_medio_brl > Decimal("0.0") else Decimal("0.0")
                    cotacoes_resultado[ticker] = CotacaoItemRead(
                        ticker=ticker,
                        preco_atual=pm,
                        variacao_diaria_pct=Decimal("0.0"),
                        fonte="INDISPONIVEL",
                        atualizado_em=now_dt,
                        stale=True,
                    )

        _salvar_cache_disco(disk_cache)

    # 4. Consulta e precificação de Renda Fixa (Tesouro Direto e Curva CDI)
    if posicoes_rf:
        client_kwargs_rf: dict = {"timeout": 10.0}
        if transport is not None:
            client_kwargs_rf["transport"] = transport

        async with httpx.AsyncClient(**client_kwargs_rf) as rf_client:
            rf_tasks = [
                _obter_cotacao_renda_fixa(
                    ativo=at,
                    pos=p,
                    db=db,
                    carteira_id=carteira_id,
                    client=rf_client,
                    forcar=forcar,
                )
                for at, p in posicoes_rf
            ]
            rf_respostas = await asyncio.gather(*rf_tasks, return_exceptions=True)

        for (at, p), resp in zip(posicoes_rf, rf_respostas):
            if isinstance(resp, CotacaoItemRead):
                cotacoes_resultado[at.ticker] = resp
                if resp.fonte in ("TESOURO", "CURVA_CDI"):
                    cache_payload = {
                        "preco_atual": str(resp.preco_atual),
                        "variacao_diaria_pct": str(resp.variacao_diaria_pct or Decimal("0.0")),
                        "fonte": resp.fonte,
                        "timestamp": now_ts,
                    }
                    _MEM_CACHE[at.ticker] = cache_payload
                    disk_cache[at.ticker] = cache_payload
            else:
                pm = p.preco_medio_brl if p.preco_medio_brl > Decimal("0.0") else Decimal("0.0")
                cotacoes_resultado[at.ticker] = CotacaoItemRead(
                    ticker=at.ticker,
                    preco_atual=pm,
                    variacao_diaria_pct=Decimal("0.0"),
                    fonte="INDISPONIVEL",
                    atualizado_em=now_dt,
                    stale=False,
                )

        _salvar_cache_disco(disk_cache)

    tem_stale = any(item.stale for item in cotacoes_resultado.values())

    # Metadados de resumo da Binance se existirem no cache
    meta_file = CACHE_DIR / f"binance_metadata_{carteira_id}.json"
    resumo_binance: Optional[Dict[str, Any]] = None
    if meta_file.exists():
        try:
            with open(meta_file, "r", encoding="utf-8") as f:
                resumo_binance = json.load(f)
        except Exception:
            pass

    if cotacao_usdt_brl_online is None:
        cached_usdt = _MEM_CACHE.get("__USDTBRL__") or disk_cache.get("__USDTBRL__")
        if cached_usdt:
            cotacao_usdt_brl_online = Decimal(str(cached_usdt["preco_atual"]))

    if cotacao_btc_usd_online is None:
        cached_btc = _MEM_CACHE.get("__BTCUSDT__") or disk_cache.get("__BTCUSDT__")
        if cached_btc:
            cotacao_btc_usd_online = Decimal(str(cached_btc["preco_atual"]))

    cotacao_usd_brl = cotacao_usdt_brl_online or Decimal("5.18")
    cotacao_btc_brl = (
        (cotacao_btc_usd_online * cotacao_usd_brl)
        if (cotacao_btc_usd_online and cotacao_usd_brl)
        else None
    )
    if cotacao_btc_brl is None and "BTC" in cotacoes_resultado and cotacoes_resultado["BTC"].preco_atual > Decimal("0.0"):
        cotacao_btc_brl = cotacoes_resultado["BTC"].preco_atual

    return CotacoesCarteiraResponse(
        carteira_id=carteira_id,
        atualizado_em=now_dt,
        stale=tem_stale,
        cotacoes=cotacoes_resultado,
        cotacao_usd_brl=cotacao_usd_brl,
        cotacao_btc_brl=cotacao_btc_brl,
        resumo_binance=resumo_binance,
    )


HISTORICAL_TICKER_FALLBACKS: Dict[str, list[str]] = {
    "ISAE4": ["ISAE4", "TRPL4"],
    "TRPL4": ["TRPL4", "ISAE4"],
    "ELET3": ["ELET3", "AXIA3"],
}


async def obter_cotacao_historica(
    ticker: str,
    data_str: str,
    client: Optional[httpx.AsyncClient] = None,
) -> Optional[Decimal]:
    """
    Consulta a cotação de fechamento histórica de um ativo na data especificada via Yahoo Finance.
    Se a data exata não tiver pregão (fim de semana ou feriado), seleciona o pregão mais próximo.
    Suporta fallback de tickers históricos e desajusta eventos de splits ocorridos após a data.
    """
    clean_ticker = ticker.strip().upper()
    try:
        dt = datetime.strptime(data_str, "%Y-%m-%d")
    except ValueError:
        return None

    target_date = dt.date()
    # Janela de busca: 5 dias antes até hoje para capturar o pregão alvo e todos os splits subsequentes
    ts_start = int(dt.replace(hour=0, minute=0, second=0).timestamp()) - (86400 * 5)
    ts_now = int(datetime.now(timezone.utc).timestamp())
    ts_end = max(ts_now, int(dt.replace(hour=23, minute=59, second=59).timestamp()) + (86400 * 3))

    candidate_tickers = HISTORICAL_TICKER_FALLBACKS.get(clean_ticker, [clean_ticker])

    async def _fetch(c: httpx.AsyncClient, t_cand: str) -> Optional[Decimal]:
        ticker_sa = t_cand if t_cand.endswith(".SA") else f"{t_cand}.SA"
        yahoo_url = (
            f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker_sa}"
            f"?period1={ts_start}&period2={ts_end}&interval=1d&events=capitalGain|div|split"
        )
        resp = await c.get(yahoo_url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
        if resp.status_code != 200:
            return None
        data = resp.json()
        chart_res = data.get("chart", {}).get("result")
        if not chart_res:
            return None
        result_obj = chart_res[0]
        timestamps = result_obj.get("timestamp", [])
        indicators = result_obj.get("indicators", {})
        quotes = indicators.get("quote", [{}])[0]
        closes = quotes.get("close", [])

        if not timestamps or not closes:
            return None

        # Procura a data exata ou o dia de pregão mais próximo anterior/na data
        melhor_preco: Optional[Decimal] = None

        for ts, close_val in zip(timestamps, closes):
            if close_val is None:
                continue
            d_ts = datetime.fromtimestamp(ts, tz=timezone.utc).date()
            if d_ts == target_date:
                melhor_preco = Decimal(str(round(close_val, 4)))
                break
            elif d_ts < target_date:
                melhor_preco = Decimal(str(round(close_val, 4)))
            elif d_ts > target_date and melhor_preco is None:
                melhor_preco = Decimal(str(round(close_val, 4)))
                break

        if melhor_preco is None:
            return None

        # Desajustar eventos de splits que ocorreram após a data histórica consultada
        # No Yahoo Finance: preço_ajustado = preço_nominal / (numerator / denominator)
        # Logo: preço_nominal_original = preço_ajustado * (numerator / denominator)
        events = result_obj.get("events", {})
        splits = events.get("splits", {}) if isinstance(events, dict) else {}
        split_items = []
        if isinstance(splits, dict):
            for split_key, split_info in splits.items():
                if isinstance(split_info, dict):
                    item = dict(split_info)
                    if "date" not in item:
                        try:
                            item["date"] = int(split_key)
                        except (ValueError, TypeError):
                            pass
                    split_items.append(item)
        elif isinstance(splits, list):
            split_items = [s for s in splits if isinstance(s, dict)]

        for split_info in split_items:
            split_ts = split_info.get("date")
            if split_ts is not None:
                try:
                    split_ts = int(split_ts)
                    split_dt = datetime.fromtimestamp(split_ts, tz=timezone.utc).date()
                except Exception:
                    continue

                if split_dt > target_date:
                    num_raw = split_info.get("numerator")
                    den_raw = split_info.get("denominator")
                    if num_raw is None or den_raw is None:
                        ratio_str = str(split_info.get("splitRatio", ""))
                        if ":" in ratio_str:
                            p_num, p_den = ratio_str.split(":", 1)
                            num_raw = num_raw or p_num
                            den_raw = den_raw or p_den
                        elif "/" in ratio_str:
                            p_num, p_den = ratio_str.split("/", 1)
                            num_raw = num_raw or p_num
                            den_raw = den_raw or p_den
                    try:
                        num = Decimal(str(num_raw)) if num_raw is not None else Decimal("1")
                        den = Decimal(str(den_raw)) if den_raw is not None else Decimal("1")
                        if num > Decimal("0") and den > Decimal("0"):
                            melhor_preco = melhor_preco * (num / den)
                    except Exception:
                        pass

        return Decimal(str(round(melhor_preco, 4)))

    async def _run():
        if client is not None:
            for cand in candidate_tickers:
                res = await _fetch(client, cand)
                if res is not None:
                    return res
            return None
        else:
            async with httpx.AsyncClient(timeout=8.0) as c:
                for cand in candidate_tickers:
                    res = await _fetch(c, cand)
                    if res is not None:
                        return res
                return None

    try:
        return await _run()
    except Exception:
        return None
