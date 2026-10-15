import json
import os
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

import httpx
from fastapi import HTTPException, status

from app.schemas.renda_fixa import (
    CotacaoTesouroResponse,
    EnvelopeMercado,
    MacroResponse,
    SerieMacroRead,
)

BONDS_URL = "https://enriconsilva.github.io/Marcacaoamercado/bonds.json"
SGS_URL = "https://api.bcb.gov.br/dados/serie/bcdata.sgs.{codigo}/dados/ultimos/{n}?formato=json"

TTL_BONDS = timedelta(hours=1)
TTL_MACRO = timedelta(hours=6)
CACHE_DIR = Path(__file__).resolve().parents[3] / "data" / "cache"


def ipca_12m(pontos_mensais: List[Any]) -> Decimal:
    """Calcula IPCA acumulado 12 meses a partir de pontos percentuais mensais em Decimal."""
    acc = Decimal("1.0")
    for m in pontos_mensais:
        val = Decimal(str(m))
        acc *= (Decimal("1.0") + val / Decimal("100.0"))
    return (acc - Decimal("1.0")) * Decimal("100.0")


def anualizar_252(taxa_diaria_pct: Any) -> Decimal:
    """Anualiza taxa diária útil (base 252) para taxa anualizada em %."""
    val = Decimal(str(taxa_diaria_pct))
    return ((Decimal("1.0") + val / Decimal("100.0")) ** 252 - Decimal("1.0")) * Decimal("100.0")


def _parse_bcb_date(dt_str: str) -> date:
    s = dt_str.strip()
    if "/" in s:
        return datetime.strptime(s, "%d/%m/%Y").date()
    elif "-" in s:
        return datetime.strptime(s, "%Y-%m-%d").date()
    return date.today()


class CacheMercado:
    """Cache em memória com TTL e persistência do último snapshot bom em disco (fallback offline)."""

    def __init__(self, cache_dir: Optional[Path] = None):
        self.cache_dir = cache_dir or CACHE_DIR
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        # chave -> (timestamp_obtido, timestamp_expiracao, dados)
        self._mem_cache: Dict[str, Tuple[datetime, datetime, Any]] = {}

    def _caminho_disco(self, chave: str) -> Path:
        return self.cache_dir / f"{chave}.json"

    def _salvar_disco(self, chave: str, obtido_em: datetime, dados_json: Any) -> None:
        try:
            if hasattr(dados_json, "model_dump"):
                dados_serializados = dados_json.model_dump(mode="json")
            else:
                dados_serializados = dados_json
            arquivo = self._caminho_disco(chave)
            tmp_arquivo = self.cache_dir / f"{chave}.tmp.{os.getpid()}"
            conteudo = {
                "obtido_em": obtido_em.isoformat(),
                "dados": dados_serializados,
            }
            tmp_arquivo.write_text(json.dumps(conteudo, default=str), encoding="utf-8")
            tmp_arquivo.replace(arquivo)
        except Exception:
            pass

    def _ler_disco(self, chave: str) -> Optional[Tuple[datetime, Any]]:
        arquivo = self._caminho_disco(chave)
        if not arquivo.exists():
            return None
        try:
            conteudo = json.loads(arquivo.read_text(encoding="utf-8"))
            obtido_em = datetime.fromisoformat(conteudo["obtido_em"])
            return obtido_em, conteudo["dados"]
        except Exception:
            return None

    async def obter(
        self,
        chave: str,
        ttl: timedelta,
        fetch: Callable[[httpx.AsyncClient], Awaitable[Any]],
        client: Optional[httpx.AsyncClient] = None,
        forcar: bool = False,
        desserializar_disco: Optional[Callable[[Any], Any]] = None,
        serializar_disco: Optional[Callable[[Any], Any]] = None,
    ) -> Tuple[Any, datetime, bool, bool]:
        """Retorna (dados, obtido_em, cache_hit, stale)."""
        agora = datetime.now(timezone.utc)

        # 1. Se não forçar e o cache em memória for válido
        if not forcar and chave in self._mem_cache:
            obtido_em, expira_em, dados = self._mem_cache[chave]
            if agora < expira_em:
                return dados, obtido_em, True, False

        # 2. Tenta buscar da rede
        try:
            async def _exec_fetch(c: httpx.AsyncClient):
                return await fetch(c)

            if client is not None:
                dados_rede = await _exec_fetch(client)
            else:
                async with httpx.AsyncClient(timeout=10.0) as default_client:
                    dados_rede = await _exec_fetch(default_client)

            obtido_em = datetime.now(timezone.utc)
            self._mem_cache[chave] = (obtido_em, obtido_em + ttl, dados_rede)

            # Persiste no disco
            disco_dados = serializar_disco(dados_rede) if serializar_disco else dados_rede
            self._salvar_disco(chave, obtido_em, disco_dados)

            return dados_rede, obtido_em, False, False

        except Exception as exc:
            # 3. Fallback: cache em memória mesmo que expirado
            if chave in self._mem_cache:
                obtido_em, _, dados = self._mem_cache[chave]
                return dados, obtido_em, True, True

            # 4. Fallback: snapshot em disco
            snapshot_disco = self._ler_disco(chave)
            if snapshot_disco is not None:
                obtido_em, raw_dados = snapshot_disco
                dados = desserializar_disco(raw_dados) if desserializar_disco else raw_dados
                self._mem_cache[chave] = (obtido_em, agora + ttl, dados)
                return dados, obtido_em, False, True

            # 5. Sem fallback disponível
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Fonte de mercado indisponível e sem snapshot offline ({chave}): {str(exc)}",
            )


# Instância global do cache
mercado_cache = CacheMercado()


async def fetch_bonds_json(client: httpx.AsyncClient) -> CotacaoTesouroResponse:
    r = await client.get(BONDS_URL, timeout=10.0)
    r.raise_for_status()
    raw = r.json()
    if isinstance(raw, dict) and "results" in raw:
        return CotacaoTesouroResponse.model_validate(raw)
    raise ValueError("Resposta do bonds.json inválida ou vazia")


async def obter_cotacoes_tesouro(
    forcar: bool = False,
    client: Optional[httpx.AsyncClient] = None,
) -> EnvelopeMercado[CotacaoTesouroResponse]:
    dados, obtido_em, cache_hit, stale = await mercado_cache.obter(
        chave="bonds",
        ttl=TTL_BONDS,
        fetch=fetch_bonds_json,
        client=client,
        forcar=forcar,
        desserializar_disco=lambda d: CotacaoTesouroResponse.model_validate(d),
        serializar_disco=lambda m: m.model_dump(mode="json") if hasattr(m, "model_dump") else m,
    )
    if isinstance(dados, dict):
        dados = CotacaoTesouroResponse.model_validate(dados)
    return EnvelopeMercado[CotacaoTesouroResponse](
        fonte=BONDS_URL,
        obtido_em=obtido_em,
        cache_hit=cache_hit,
        stale=stale,
        dados=dados,
    )


async def fetch_macro_bcb(client: httpx.AsyncClient) -> MacroResponse:
    # 1. IPCA SGS 433 (últimos 12 meses)
    r_ipca = await client.get(SGS_URL.format(codigo=433, n=12), timeout=10.0)
    r_ipca.raise_for_status()
    dados_ipca = r_ipca.json()
    if not dados_ipca:
        raise ValueError("SGS 433 retornou lista vazia")
    pontos_ipca = [Decimal(str(x["valor"])) for x in dados_ipca]
    dt_ipca = _parse_bcb_date(dados_ipca[-1]["data"])
    ipca_read = SerieMacroRead(
        codigo=433,
        nome="IPCA 12m",
        ultima_data=dt_ipca,
        valor_bruto=Decimal(str(dados_ipca[-1]["valor"])),
        valor_anualizado_pct=ipca_12m(pontos_ipca),
    )

    # 2. Selic SGS 11 (último dia útil)
    r_selic = await client.get(SGS_URL.format(codigo=11, n=1), timeout=10.0)
    r_selic.raise_for_status()
    dados_selic = r_selic.json()
    if not dados_selic:
        raise ValueError("SGS 11 retornou lista vazia")
    dt_selic = _parse_bcb_date(dados_selic[-1]["data"])
    bruto_selic = Decimal(str(dados_selic[-1]["valor"]))
    selic_read = SerieMacroRead(
        codigo=11,
        nome="Taxa Selic",
        ultima_data=dt_selic,
        valor_bruto=bruto_selic,
        valor_anualizado_pct=anualizar_252(bruto_selic),
    )

    # 3. CDI SGS 12 (último dia útil)
    cdi_read = None
    try:
        r_cdi = await client.get(SGS_URL.format(codigo=12, n=1), timeout=10.0)
        r_cdi.raise_for_status()
        dados_cdi = r_cdi.json()
        if dados_cdi:
            dt_cdi = _parse_bcb_date(dados_cdi[-1]["data"])
            bruto_cdi = Decimal(str(dados_cdi[-1]["valor"]))
            cdi_read = SerieMacroRead(
                codigo=12,
                nome="Taxa CDI",
                ultima_data=dt_cdi,
                valor_bruto=bruto_cdi,
                valor_anualizado_pct=anualizar_252(bruto_cdi),
            )
    except Exception:
        pass

    return MacroResponse(
        obtido_em=datetime.now(timezone.utc),
        ipca_12m=ipca_read,
        selic=selic_read,
        cdi=cdi_read,
    )


async def obter_dados_macro(
    forcar: bool = False,
    client: Optional[httpx.AsyncClient] = None,
) -> MacroResponse:
    dados, obtido_em, _, _ = await mercado_cache.obter(
        chave="macro",
        ttl=TTL_MACRO,
        fetch=fetch_macro_bcb,
        client=client,
        forcar=forcar,
        desserializar_disco=lambda d: MacroResponse.model_validate(d),
        serializar_disco=lambda m: m.model_dump(mode="json"),
    )
    if isinstance(dados, dict):
        dados = MacroResponse.model_validate(dados)
    return dados
