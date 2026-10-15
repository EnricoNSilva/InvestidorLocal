from datetime import date
from dataclasses import dataclass
import re
from typing import Optional
import unicodedata

from app.models.enums import Indexador, ProdutoRendaFixa


@dataclass(frozen=True)
class InfoRendaFixa:
    ticker: str                    # TD-RENDA+-2065 (<= 30 chars, limite de ativos.ticker)
    nome: str                      # "Tesouro RendA+ Aposentadoria Extra 2065"
    produto: ProdutoRendaFixa
    indexador: Indexador
    ano_conversao: Optional[int]
    num_parcelas: Optional[int]
    ano_vencimento: Optional[int]
    data_vencimento: Optional[date] = None
    emissor: Optional[str] = None
    codigo_mercado: Optional[str] = None


def _norm(s: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFKD", str(s))
        if not unicodedata.combining(c)
    ).upper().strip()


_RE_TD_TICKER = re.compile(
    r"^TD[\-_](?P<prod>RENDA\+|EDUCA\+|IPCA\+J|IPCA\+|PRE\+J|PRE|SELIC)[\-_]?(?P<ano>\d{4})$"
)

_RE_TESOURO = re.compile(
    r"(?:TESOURO(?:\s+DIRETO)?|TD)[\s\-_]+(?P<prod>RENDA(?:\s*(?:\+|MAIS))?|EDUCA(?:\s*(?:\+|MAIS))?|IPCA(?:\s*(?:\+|MAIS))?(?:\s+COM\s+JUROS\s+SEMESTRAIS)?|SELIC|PREFIXADO(?:\s+COM\s+JUROS\s+SEMESTRAIS)?|PRE(?:\s*(?:\+|MAIS)J|PREFIXADO)?)(?:\s+APOSENTADORIA\s+EXTRA)?\D*(?P<ano>\d{4})?"
)

_RE_BANCARIO = re.compile(r"\b(?P<prod>CDB|LCI|LCA|LC)\b")

OFFSET_VENCIMENTO_CONVERSAO = {
    ProdutoRendaFixa.TESOURO_RENDA_MAIS: 19,
    ProdutoRendaFixa.TESOURO_EDUCA_MAIS: 4,
}


def classificar_renda_fixa(descricao: str, *, ano_e_vencimento: bool = False) -> Optional[InfoRendaFixa]:
    """Retorna InfoRendaFixa ou None se a descrição não for de RF.

    Suporta reconhecimento tanto por ano de conversão comercial (ex: RendA+ 2065 -> conversão 2065, vencimento 2084)
    quanto por ano de vencimento (subtraindo offset de 19 anos no RendA+ e 4 anos no Educa+).
    """
    if not descricao:
        return None

    norm = _norm(descricao)

    # 1. Caso direto pelo ticker canônico (ex.: TD-RENDA+-2065, TD-IPCA+-2035)
    td_match = _RE_TD_TICKER.match(norm)
    if td_match:
        prod_key = td_match.group("prod")
        ano = int(td_match.group("ano"))
        if prod_key == "RENDA+":
            ano_conversao = ano if ano <= 2065 else ano - 19
            ano_vencimento = ano_conversao + 19
            return InfoRendaFixa(
                ticker=f"TD-RENDA+-{ano_conversao}",
                nome=f"Tesouro RendA+ Aposentadoria Extra {ano_conversao}",
                produto=ProdutoRendaFixa.TESOURO_RENDA_MAIS,
                indexador=Indexador.IPCA,
                ano_conversao=ano_conversao,
                num_parcelas=240,
                ano_vencimento=ano_vencimento,
                data_vencimento=date(ano_vencimento, 12, 15),
                emissor="Tesouro Nacional",
                codigo_mercado=f"tesouro-renda-mais-{ano_conversao}",
            )
        elif prod_key == "EDUCA+":
            ano_conversao = ano if ano <= 2044 else ano - 4
            ano_vencimento = ano_conversao + 4
            return InfoRendaFixa(
                ticker=f"TD-EDUCA+-{ano_conversao}",
                nome=f"Tesouro Educa+ {ano_conversao}",
                produto=ProdutoRendaFixa.TESOURO_EDUCA_MAIS,
                indexador=Indexador.IPCA,
                ano_conversao=ano_conversao,
                num_parcelas=60,
                ano_vencimento=ano_vencimento,
                data_vencimento=date(ano_vencimento, 12, 15),
                emissor="Tesouro Nacional",
                codigo_mercado=f"tesouro-educa-mais-{ano_conversao}",
            )
        elif prod_key == "IPCA+":
            return InfoRendaFixa(
                ticker=f"TD-IPCA+-{ano}",
                nome=f"Tesouro IPCA+ {ano}",
                produto=ProdutoRendaFixa.TESOURO_IPCA,
                indexador=Indexador.IPCA,
                ano_conversao=None,
                num_parcelas=None,
                ano_vencimento=ano,
                data_vencimento=date(ano, 1, 1),
                emissor="Tesouro Nacional",
                codigo_mercado=f"tesouro-ipca-mais-{ano}",
            )
        elif prod_key == "IPCA+J":
            return InfoRendaFixa(
                ticker=f"TD-IPCA+J-{ano}",
                nome=f"Tesouro IPCA+ com Juros Semestrais {ano}",
                produto=ProdutoRendaFixa.TESOURO_IPCA_JUROS,
                indexador=Indexador.IPCA,
                ano_conversao=None,
                num_parcelas=None,
                ano_vencimento=ano,
                data_vencimento=date(ano, 1, 1),
                emissor="Tesouro Nacional",
                codigo_mercado=f"tesouro-ipca-mais-juros-semestrais-{ano}",
            )
        elif prod_key == "PRE":
            return InfoRendaFixa(
                ticker=f"TD-PRE-{ano}",
                nome=f"Tesouro Prefixado {ano}",
                produto=ProdutoRendaFixa.TESOURO_PREFIXADO,
                indexador=Indexador.PREFIXADO,
                ano_conversao=None,
                num_parcelas=None,
                ano_vencimento=ano,
                data_vencimento=date(ano, 1, 1),
                emissor="Tesouro Nacional",
                codigo_mercado=f"tesouro-prefixado-{ano}",
            )
        elif prod_key == "PRE+J":
            return InfoRendaFixa(
                ticker=f"TD-PRE+J-{ano}",
                nome=f"Tesouro Prefixado com Juros Semestrais {ano}",
                produto=ProdutoRendaFixa.TESOURO_PREFIXADO_JUROS,
                indexador=Indexador.PREFIXADO,
                ano_conversao=None,
                num_parcelas=None,
                ano_vencimento=ano,
                data_vencimento=date(ano, 1, 1),
                emissor="Tesouro Nacional",
                codigo_mercado=f"tesouro-prefixado-juros-semestrais-{ano}",
            )
        elif prod_key == "SELIC":
            return InfoRendaFixa(
                ticker=f"TD-SELIC-{ano}",
                nome=f"Tesouro Selic {ano}",
                produto=ProdutoRendaFixa.TESOURO_SELIC,
                indexador=Indexador.SELIC,
                ano_conversao=None,
                num_parcelas=None,
                ano_vencimento=ano,
                data_vencimento=date(ano, 1, 1),
                emissor="Tesouro Nacional",
                codigo_mercado=f"tesouro-selic-{ano}",
            )

    # 2. Caso Tesouro Direto por descrição textual
    tesouro_match = _RE_TESOURO.search(norm)
    if tesouro_match:
        prod_raw = tesouro_match.group("prod")
        ano_raw = tesouro_match.group("ano")
        ano_num = int(ano_raw) if ano_raw else None

        if "RENDA" in prod_raw:
            produto = ProdutoRendaFixa.TESOURO_RENDA_MAIS
            indexador = Indexador.IPCA
            num_parcelas = 240
            if ano_num:
                if ano_e_vencimento or ano_num > 2065:
                    ano_vencimento = ano_num
                    ano_conversao = ano_num - 19
                else:
                    ano_conversao = ano_num
                    ano_vencimento = ano_num + 19
            else:
                ano_conversao = None
                ano_vencimento = None
            ticker = f"TD-RENDA+-{ano_conversao}" if ano_conversao else "TD-RENDA+"
            nome = f"Tesouro RendA+ Aposentadoria Extra {ano_conversao}" if ano_conversao else "Tesouro RendA+"
            return InfoRendaFixa(
                ticker=ticker[:30],
                nome=nome[:150],
                produto=produto,
                indexador=indexador,
                ano_conversao=ano_conversao,
                num_parcelas=num_parcelas,
                ano_vencimento=ano_vencimento,
                data_vencimento=date(ano_vencimento, 12, 15) if ano_vencimento else None,
                emissor="Tesouro Nacional",
                codigo_mercado=f"tesouro-renda-mais-{ano_conversao}" if ano_conversao else None,
            )

        elif "EDUCA" in prod_raw:
            produto = ProdutoRendaFixa.TESOURO_EDUCA_MAIS
            indexador = Indexador.IPCA
            num_parcelas = 60
            if ano_num:
                if ano_e_vencimento or ano_num > 2044:
                    ano_vencimento = ano_num
                    ano_conversao = ano_num - 4
                else:
                    ano_conversao = ano_num
                    ano_vencimento = ano_num + 4
            else:
                ano_conversao = None
                ano_vencimento = None
            ticker = f"TD-EDUCA+-{ano_conversao}" if ano_conversao else "TD-EDUCA+"
            nome = f"Tesouro Educa+ {ano_conversao}" if ano_conversao else "Tesouro Educa+"
            return InfoRendaFixa(
                ticker=ticker[:30],
                nome=nome[:150],
                produto=produto,
                indexador=indexador,
                ano_conversao=ano_conversao,
                num_parcelas=num_parcelas,
                ano_vencimento=ano_vencimento,
                data_vencimento=date(ano_vencimento, 12, 15) if ano_vencimento else None,
                emissor="Tesouro Nacional",
                codigo_mercado=f"tesouro-educa-mais-{ano_conversao}" if ano_conversao else None,
            )

        elif "IPCA" in prod_raw:
            has_juros = "JUROS" in prod_raw or "JUROS" in norm
            produto = ProdutoRendaFixa.TESOURO_IPCA_JUROS if has_juros else ProdutoRendaFixa.TESOURO_IPCA
            indexador = Indexador.IPCA
            ano_vencimento = ano_num
            prefix = "TD-IPCA+J-" if has_juros else "TD-IPCA+-"
            ticker = f"{prefix}{ano_vencimento}" if ano_vencimento else ("TD-IPCA+J" if has_juros else "TD-IPCA+")
            nome = f"Tesouro IPCA+ com Juros Semestrais {ano_vencimento}" if has_juros else f"Tesouro IPCA+ {ano_vencimento}"
            return InfoRendaFixa(
                ticker=ticker[:30],
                nome=nome[:150],
                produto=produto,
                indexador=indexador,
                ano_conversao=None,
                num_parcelas=None,
                ano_vencimento=ano_vencimento,
                data_vencimento=date(ano_vencimento, 1, 1) if ano_vencimento else None,
                emissor="Tesouro Nacional",
                codigo_mercado=f"tesouro-ipca-mais-juros-semestrais-{ano_vencimento}" if has_juros else (f"tesouro-ipca-mais-{ano_vencimento}" if ano_vencimento else None),
            )

        elif "PREFIXADO" in prod_raw or "PRE" in prod_raw:
            has_juros = "JUROS" in prod_raw or "JUROS" in norm
            produto = ProdutoRendaFixa.TESOURO_PREFIXADO_JUROS if has_juros else ProdutoRendaFixa.TESOURO_PREFIXADO
            indexador = Indexador.PREFIXADO
            ano_vencimento = ano_num
            prefix = "TD-PRE+J-" if has_juros else "TD-PRE-"
            ticker = f"{prefix}{ano_vencimento}" if ano_vencimento else ("TD-PRE+J" if has_juros else "TD-PRE")
            nome = f"Tesouro Prefixado com Juros Semestrais {ano_vencimento}" if has_juros else f"Tesouro Prefixado {ano_vencimento}"
            return InfoRendaFixa(
                ticker=ticker[:30],
                nome=nome[:150],
                produto=produto,
                indexador=indexador,
                ano_conversao=None,
                num_parcelas=None,
                ano_vencimento=ano_vencimento,
                data_vencimento=date(ano_vencimento, 1, 1) if ano_vencimento else None,
                emissor="Tesouro Nacional",
                codigo_mercado=f"tesouro-prefixado-juros-semestrais-{ano_vencimento}" if has_juros else (f"tesouro-prefixado-{ano_vencimento}" if ano_vencimento else None),
            )

        elif "SELIC" in prod_raw:
            produto = ProdutoRendaFixa.TESOURO_SELIC
            indexador = Indexador.SELIC
            ano_vencimento = ano_num
            ticker = f"TD-SELIC-{ano_vencimento}" if ano_vencimento else "TD-SELIC"
            nome = f"Tesouro Selic {ano_vencimento}" if ano_vencimento else "Tesouro Selic"
            return InfoRendaFixa(
                ticker=ticker[:30],
                nome=nome[:150],
                produto=produto,
                indexador=indexador,
                ano_conversao=None,
                num_parcelas=None,
                ano_vencimento=ano_vencimento,
                data_vencimento=date(ano_vencimento, 1, 1) if ano_vencimento else None,
                emissor="Tesouro Nacional",
                codigo_mercado=f"tesouro-selic-{ano_vencimento}" if ano_vencimento else None,
            )

    # 3. Caso Renda Fixa Bancária (CDB, LCI, LCA, LC)
    banc_match = _RE_BANCARIO.search(norm)
    if banc_match:
        prod_str = banc_match.group("prod")
        produto = ProdutoRendaFixa[prod_str]

        if "IPCA" in norm:
            indexador = Indexador.IPCA
        elif "PRE" in norm or "PREFIXADO" in norm:
            indexador = Indexador.PREFIXADO
        elif "SELIC" in norm:
            indexador = Indexador.SELIC
        else:
            indexador = Indexador.CDI

        # Extrai data AAAAMMDD ou DD/MM/AAAA ou ano
        exact_date = None
        date_match = re.search(r"\b(\d{4})(\d{2})(\d{2})\b", norm)
        if not date_match:
            date_match = re.search(r"\b(\d{2})[/.-](\d{2})[/.-](\d{4})\b", norm)
            if date_match:
                d, m, y = date_match.groups()
                date_slug = f"{y}{m}{d}"
                ano_venc = int(y)
                try:
                    exact_date = date(int(y), int(m), int(d))
                except Exception:
                    exact_date = None
            else:
                ano_match = re.search(r"\b(20\d{2})\b", norm)
                if ano_match:
                    date_slug = ano_match.group(1)
                    ano_venc = int(date_slug)
                else:
                    date_slug = ""
                    ano_venc = None
        else:
            y, m, d = date_match.groups()
            date_slug = f"{y}{m}{d}"
            ano_venc = int(y)
            try:
                exact_date = date(int(y), int(m), int(d))
            except Exception:
                exact_date = None

        # Extrai emissor
        # Remove produto, indexador, datas e tokens comuns preservando C6, XP, etc.
        cleaned = re.sub(
            r"\b(CDB|LCI|LCA|LC|BANCO|BCO|S/?A|LTDA|IPCA|CDI|SELIC|PREFIXADO|PRE|POS|DEBENTURE|FINANCEIRA|DISTRIBUIDORA|DTVM|CORRETORA|CTVM)\b",
            " ",
            norm,
        )
        cleaned = re.sub(r"\b\d+\b|[%/\.\-]+", " ", cleaned)
        tokens = [t for t in cleaned.split() if len(t) >= 2 and t.lower() not in ("do", "da", "de", "e", "dos", "das")]
        emissor_slug = tokens[0] if tokens else "EMISSOR"

        ticker_parts = [prod_str, emissor_slug]
        if date_slug:
            ticker_parts.append(date_slug)
        ticker = "-".join(ticker_parts)[:30]

        return InfoRendaFixa(
            ticker=ticker,
            nome=f"{prod_str} {emissor_slug} {date_slug}".strip(),
            produto=produto,
            indexador=indexador,
            ano_conversao=None,
            num_parcelas=None,
            ano_vencimento=ano_venc,
            data_vencimento=exact_date,
            emissor=emissor_slug,
            codigo_mercado=None,
        )

    return None
