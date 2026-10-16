from datetime import date, datetime
from decimal import Decimal
from typing import Any, Generic, List, Optional, TypeVar

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

T = TypeVar("T")

from app.models.enums import Indexador, ProdutoRendaFixa
from app.schemas.ativo import AtivoRead

PRODUTOS_DESACUMULACAO = {ProdutoRendaFixa.TESOURO_RENDA_MAIS, ProdutoRendaFixa.TESOURO_EDUCA_MAIS}
PRODUTOS_ISENTOS_PF = {ProdutoRendaFixa.LCI, ProdutoRendaFixa.LCA}


class DetalhesRendaFixaBase(BaseModel):
    produto: ProdutoRendaFixa
    indexador: Indexador
    emissor: str = "Tesouro Nacional"
    percentual_indexador: Optional[Decimal] = Field(default=None, gt=0, max_digits=8, decimal_places=4)
    data_emissao: Optional[date] = None
    data_vencimento: Optional[date] = None
    ano_conversao: Optional[int] = Field(default=None, ge=2025, le=2090)
    num_parcelas: Optional[int] = Field(default=None, gt=0, le=600)
    dia_pagamento: Optional[int] = Field(default=None, ge=1, le=31)
    isento_ir: Optional[bool] = None            # None -> deduzido do produto
    cobra_custodia_b3: Optional[bool] = None    # None -> True para TESOURO_*, False caso contrário
    carencia_dias: Optional[int] = Field(default=None, ge=0)
    codigo_mercado: Optional[str] = Field(default=None, max_length=80)

    @model_validator(mode="after")
    def _regras_por_produto(self):
        if self.isento_ir is None:
            self.isento_ir = self.produto in PRODUTOS_ISENTOS_PF
        if self.cobra_custodia_b3 is None:
            self.cobra_custodia_b3 = self.produto.value.startswith("TESOURO_")
        return self


class DetalhesRendaFixaUpsert(DetalhesRendaFixaBase):
    @model_validator(mode="after")
    def _regras_upsert(self):
        if self.produto in PRODUTOS_DESACUMULACAO and (self.ano_conversao is None or self.num_parcelas is None):
            raise ValueError("RendA+/Educa+ exigem ano_conversao e num_parcelas")
        return self


class DetalhesRendaFixaRead(DetalhesRendaFixaBase):
    model_config = ConfigDict(from_attributes=True)
    ativo_id: int
    isento_ir: bool
    cobra_custodia_b3: bool


class AtivoRendaFixaRead(AtivoRead):
    detalhes_rf: Optional[DetalhesRendaFixaRead] = None


class LoteAbertoRead(BaseModel):
    """Lote PEPS em aberto. O frontend converte para o formato do motor ({id, dn, rate, price, qty})."""
    transacao_id: int
    data_compra: date
    taxa_contratada: Optional[Decimal] = None   # None -> pendência
    preco_unitario: Decimal                     # PU de aquisição (já em BRL)
    quantidade_original: Decimal
    quantidade_aberta: Decimal
    custo_aberto_brl: Decimal                   # quantidade_aberta * PU + taxas proporcionais
    custo_conhecido: bool                       # False em TRANSFERENCIA_ENTRADA com PU 0


class FluxoRecebidoRead(BaseModel):
    transacao_id: int
    data: date
    tipo: str                                   # AMORTIZACAO | JUROS_CUPOM | SELL
    valor_brl: Decimal


class PosicaoRendaFixaRead(BaseModel):
    ativo: AtivoRendaFixaRead
    lotes: List[LoteAbertoRead]
    fluxos_recebidos: List[FluxoRecebidoRead]   # alimenta a XIRR realizada
    quantidade_total: Decimal
    custo_total_brl: Decimal
    pendencias: List[str]                       # ex.: "lote 42 sem taxa_contratada"


class LotesRendaFixaResponse(BaseModel):
    carteira_id: int
    gerado_em: datetime
    posicoes: List[PosicaoRendaFixaRead]


class TaxaContratadaPatch(BaseModel):
    taxa_contratada: Decimal = Field(ge=Decimal("-10"), le=Decimal("1000"), max_digits=8, decimal_places=4)


class LoteManualCreate(BaseModel):
    carteira_id: int = 1
    data_compra: date
    quantidade: Decimal = Field(gt=Decimal("0"), max_digits=24, decimal_places=8)
    preco_unitario: Decimal = Field(gt=Decimal("0"), max_digits=24, decimal_places=8)
    taxa_contratada: Decimal = Field(ge=Decimal("-10"), le=Decimal("1000"), max_digits=8, decimal_places=4)
    taxas: Optional[Decimal] = Field(default=Decimal("0"), ge=Decimal("0"), max_digits=18, decimal_places=8)

    @field_validator("taxas", mode="before")
    @classmethod
    def _coerce_taxas(cls, v: Any) -> Decimal:
        if v is None:
            return Decimal("0")
        return v


class CadastroManualRendaFixaRequest(BaseModel):
    ticker: Optional[str] = Field(default=None, max_length=30)  # se None, gera ex.: CDB-INTER-20280115
    nome: str = Field(min_length=2, max_length=150)
    detalhes: DetalhesRendaFixaUpsert
    lote_inicial: Optional[LoteManualCreate] = None


class CotacaoTesouroItem(BaseModel):
    symbol: str
    name: str = ""
    bondType: str = ""
    indexer: str = "ipca"
    sellRate: float = 0.0
    buyRate: float = 0.0
    sellPrice: float = 0.0
    buyPrice: float = 0.0
    baseDate: str = ""

    def __getitem__(self, item: str):
        return getattr(self, item)


class CotacaoTesouroResponse(BaseModel):
    results: List[CotacaoTesouroItem]

    def __getitem__(self, item: str):
        return getattr(self, item)


class EnvelopeMercado(BaseModel, Generic[T]):
    fonte: str
    obtido_em: datetime
    cache_hit: bool
    stale: bool                                 # True se for o último snapshot bom (a fonte falhou)
    dados: T


class SerieMacroRead(BaseModel):
    codigo: int
    nome: str
    ultima_data: date
    valor_bruto: Decimal                        # último ponto da série, em %
    valor_anualizado_pct: Decimal               # IPCA: acumulado 12m; Selic/CDI: (1+d/100)^252 - 1


class MacroResponse(BaseModel):
    obtido_em: datetime
    ipca_12m: SerieMacroRead                    # SGS 433
    selic: SerieMacroRead                       # SGS 11
    cdi: Optional[SerieMacroRead] = None        # SGS 12
