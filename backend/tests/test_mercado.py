import asyncio
from datetime import timedelta
from decimal import Decimal
from pathlib import Path
import httpx
import pytest
from fastapi import HTTPException

from app.services.renda_fixa.mercado import (
    CacheMercado,
    anualizar_252,
    fetch_bonds_json,
    fetch_macro_bcb,
    ipca_12m,
)


def test_calculos_macro_em_decimal():
    # 1. IPCA 12m: 12 meses de 0.5%
    pontos = [Decimal("0.5")] * 12
    ipca = ipca_12m(pontos)
    assert isinstance(ipca, Decimal)
    # (1.005^12 - 1) * 100 ≈ 6.167781...
    assert ipca > Decimal("6.16") and ipca < Decimal("6.17")

    # 2. Anualizar 252: taxa diária de 0.04%
    diaria = Decimal("0.04")
    anual = anualizar_252(diaria)
    assert isinstance(anual, Decimal)
    # (1.0004^252 - 1) * 100 ≈ 10.6033...
    assert anual > Decimal("10.59") and anual < Decimal("10.61")


def test_cache_mercado_hit_e_fallback_disco(tmp_path: Path):
    async def _test():
        cache = CacheMercado(cache_dir=tmp_path / "cache")
        call_count = 0

        def mock_handler(request: httpx.Request):
            nonlocal call_count
            call_count += 1
            if "fail" in request.url.path:
                return httpx.Response(500, json={"error": "failed"})
            return httpx.Response(200, json={"results": [{"symbol": "tesouro-renda-mais-2065", "buyRate": 6.49}]})

        transport = httpx.MockTransport(mock_handler)

        # 1. Primeiro fetch: busca da rede -> cache_hit=False, stale=False
        async with httpx.AsyncClient(transport=transport) as client:
            dados, obtido_em, cache_hit, stale = await cache.obter(
                chave="bonds_test",
                ttl=timedelta(hours=1),
                fetch=lambda c: fetch_bonds_json(c),
                client=client,
            )
            assert cache_hit is False
            assert stale is False
            assert dados["results"][0]["symbol"] == "tesouro-renda-mais-2065"
            assert call_count == 1

            # 2. Segundo fetch: deve usar memória (cache hit) sem bater na rede
            dados2, obtido2, cache_hit2, stale2 = await cache.obter(
                chave="bonds_test",
                ttl=timedelta(hours=1),
                fetch=lambda c: fetch_bonds_json(c),
                client=client,
            )
            assert cache_hit2 is True
            assert stale2 is False
            assert call_count == 1  # não chamou a rede novamente

        # 3. Fallback de disco: limpa a memória e simula erro de rede
        cache._mem_cache.clear()

        def mock_fail_handler(request: httpx.Request):
            return httpx.Response(500, json={"error": "server error"})

        fail_transport = httpx.MockTransport(mock_fail_handler)

        async with httpx.AsyncClient(transport=fail_transport) as fail_client:
            dados_disco, _, cache_hit3, stale3 = await cache.obter(
                chave="bonds_test",
                ttl=timedelta(hours=1),
                fetch=lambda c: fetch_bonds_json(c),
                client=fail_client,
            )
            # Recuperou do disco persistido no passo 1!
            assert cache_hit3 is False
            assert stale3 is True
            assert dados_disco["results"][0]["symbol"] == "tesouro-renda-mais-2065"

        # 4. Sem cache e sem disco -> deve lançar 503
        cache._mem_cache.clear()
        arquivo_disco = cache._caminho_disco("bonds_inexistente")
        if arquivo_disco.exists():
            arquivo_disco.unlink()

        async with httpx.AsyncClient(transport=fail_transport) as fail_client:
            with pytest.raises(HTTPException) as exc_info:
                await cache.obter(
                    chave="bonds_inexistente",
                    ttl=timedelta(hours=1),
                    fetch=lambda c: fetch_bonds_json(c),
                    client=fail_client,
                )
            assert exc_info.value.status_code == 503

    asyncio.run(_test())


def test_fetch_macro_bcb_mock():
    async def _test():
        def mock_bcb_handler(request: httpx.Request):
            url = str(request.url)
            if "433" in url:
                # IPCA 12 meses
                dados = [{"data": f"01/{i:02d}/2026", "valor": "0.40"} for i in range(1, 13)]
                return httpx.Response(200, json=dados)
            elif "11" in url:
                # Selic
                dados = [{"data": "06/10/2026", "valor": "0.0401"}]
                return httpx.Response(200, json=dados)
            elif "12" in url:
                # CDI
                dados = [{"data": "06/10/2026", "valor": "0.0399"}]
                return httpx.Response(200, json=dados)
            return httpx.Response(404)

        transport = httpx.MockTransport(mock_bcb_handler)
        async with httpx.AsyncClient(transport=transport) as client:
            macro = await fetch_macro_bcb(client)
            assert macro.ipca_12m.codigo == 433
            assert isinstance(macro.ipca_12m.valor_anualizado_pct, Decimal)
            assert macro.selic.codigo == 11
            assert isinstance(macro.selic.valor_anualizado_pct, Decimal)
            assert macro.cdi is not None
            assert macro.cdi.codigo == 12
            assert isinstance(macro.cdi.valor_anualizado_pct, Decimal)

    asyncio.run(_test())


def test_validacao_real_bonds_json():
    import json
    from app.schemas.renda_fixa import CotacaoTesouroResponse

    bonds_path = Path("c:/Users/eoric/Marcacaoamercado/bonds.json")
    if bonds_path.exists():
        conteudo = json.loads(bonds_path.read_text(encoding="utf-8"))
        resp = CotacaoTesouroResponse.model_validate(conteudo)
        assert len(resp.results) > 0
        symbols = {b.symbol for b in resp.results}
        assert "tesouro-renda-mais-2065" in symbols
        assert "tesouro-selic-01032027" in symbols


def test_parse_bcb_date_e_robustez():
    from app.services.renda_fixa.mercado import _parse_bcb_date
    from datetime import date

    assert _parse_bcb_date("15/10/2026") == date(2026, 10, 15)
    assert _parse_bcb_date("2026-10-15") == date(2026, 10, 15)
    assert _parse_bcb_date("   01/01/2025   ") == date(2025, 1, 1)

