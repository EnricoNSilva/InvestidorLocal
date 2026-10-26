from datetime import datetime, date
from decimal import Decimal
from typing import Optional, Dict, List, Any
from pydantic import BaseModel, ConfigDict, Field
from app.models.enums import TipoAtivo
from app.schemas.ativo import AtivoRead

class LoteTransferenciaPendenteRead(BaseModel):
    transacao_id: int
    data: date
    quantidade: Decimal
    data_hora: Optional[datetime] = None
    quantidade_original: Optional[Decimal] = None
    quantidade_atual: Optional[Decimal] = None

    model_config = ConfigDict(from_attributes=True)

class PosicaoConsolidadaBase(BaseModel):
    carteira_id: int = Field(default=1, description="ID da carteira associada")
    ativo_id: int = Field(..., description="ID do ativo associado")
    quantidade_saldo: Decimal = Field(..., description="Saldo de custódia consolidado")
    custo_total_brl: Decimal = Field(..., description="Custo acumulado total de aquisição em BRL")
    preco_medio_brl: Decimal = Field(..., description="Preço médio unitário ponderado móvel em BRL")
    proventos_acumulados_brl: Decimal = Field(default=Decimal("0.0"), description="Total de proventos acumulados em BRL")
    lucro_realizado_brl: Decimal = Field(default=Decimal("0.0"), description="Lucro líquido realizado em BRL")
    valor_total_venda_brl: Decimal = Field(default=Decimal("0.0"), description="Total de vendas realizadas em BRL")
    custo_historico_brl: Decimal = Field(default=Decimal("0.0"), description="Custo histórico total investido em BRL")

class PosicaoConsolidadaRead(PosicaoConsolidadaBase):
    id: int
    data_atualizacao: datetime
    quantidade_sem_custo: Decimal = Field(default=Decimal("0.0"), description="Quantidade transferida sem custo informado")
    custo_pendente: bool = Field(default=False, description="Indica se há pendência de preço médio")
    lotes_pendentes: List[LoteTransferenciaPendenteRead] = Field(default_factory=list, description="Lista de lotes transferidos pendentes")
    dividendo_por_acao_brl: Decimal = Field(default=Decimal("0.0"), description="Dividendo por cota/ação em BRL")
    preco_medio_ajustado_brl: Decimal = Field(default=Decimal("0.0"), description="Preço médio ajustado por proventos em BRL")
    yoc_acumulado_pct: Decimal = Field(default=Decimal("0.0"), description="Yield on cost acumulado em %")
    ativo: Optional[AtivoRead] = None

    # Metadados de Criptoativos (USD, Binance Earn, Autocustódia e IRPF)
    preco_medio_usd: Optional[Decimal] = Field(default=None, description="Preço médio ponderado móvel em USD")
    custo_total_usd: Optional[Decimal] = Field(default=None, description="Custo acumulado total de aquisição em USD")
    quantidade_vendida: Optional[Decimal] = Field(default=None, description="Quantidade total alienada/vendida")
    custo_vendas_brl: Optional[Decimal] = Field(default=None, description="Custo histórico total das frações alienadas em BRL")
    valor_total_vendas_brl: Optional[Decimal] = Field(default=None, description="Receita bruta total das vendas em BRL")
    qtd_earn: Optional[Decimal] = Field(default=None, description="Quantidade sob custódia no Binance Earn")
    qtd_autocustodia: Optional[Decimal] = Field(default=None, description="Quantidade em autocustódia externa")
    pct_earn: Optional[Decimal] = Field(default=None, description="Percentual em Binance Earn")
    pct_autocustodia: Optional[Decimal] = Field(default=None, description="Percentual em autocustódia externa")
    earn_interest_moeda: Optional[Decimal] = Field(default=None, description="Rendimentos acumulados de staking na moeda")
    codigo_rfb_irpf: Optional[str] = Field(default=None, description="Código da Receita Federal (ex: 08/01 ou 08/02)")
    texto_irpf: Optional[str] = Field(default=None, description="Texto pronto para declaração IRPF Bens e Direitos")

    model_config = ConfigDict(from_attributes=True)

class AjusteManualPosicaoRequest(BaseModel):
    ticker: Optional[str] = Field(None, min_length=1, max_length=30, description="Código de negociação / Ticker (opcional)")
    quantidade_saldo: Optional[Decimal] = Field(None, ge=0, description="Nova quantidade total em custódia")
    preco_medio_brl: Optional[Decimal] = Field(None, ge=0, description="Novo Preço Médio Contábil/Fiscal em R$")
    proventos_acumulados_brl: Optional[Decimal] = Field(None, ge=0, description="Total de proventos acumulados em R$ (opcional)")
    cotacao_manual: Optional[Decimal] = Field(None, ge=0, description="Cotação manual de mercado em R$ (opcional)")
    nome_ativo: Optional[str] = Field(None, max_length=150)
    tipo_ativo: Optional[TipoAtivo] = None
    setor: Optional[str] = Field(None, max_length=100)
    # Suporte aos modos de resolução de lotes transferidos pendentes:
    transacao_id: Optional[int] = Field(None, description="ID da transação TRANSFERENCIA_ENTRADA (Modo A)")
    preco_unitario_transferencia: Optional[Decimal] = Field(None, ge=0, description="Preço unitário informado para a transferência (Modo A)")
    pm_consolidado_atual: Optional[Decimal] = Field(None, ge=0, description="Preço Médio Consolidado atual para cálculo reverso (Modo B)")

class CotacaoItemRead(BaseModel):
    ticker: str
    preco_atual: Decimal
    variacao_diaria_pct: Optional[Decimal] = Decimal("0.0")
    fonte: str  # "MANUAL" | "YAHOO" | "BRAPI" | "CACHE" | "INDISPONIVEL" | "BINANCE" | "TESOURO" | "CURVA_CDI"
    atualizado_em: Optional[datetime] = None
    stale: bool = False
    preco_usd: Optional[Decimal] = None
    preco_btc: Optional[Decimal] = None

class CotacoesCarteiraResponse(BaseModel):
    carteira_id: int
    atualizado_em: datetime
    stale: bool
    cotacoes: Dict[str, CotacaoItemRead]
    cotacao_usd_brl: Optional[Decimal] = None
    cotacao_btc_brl: Optional[Decimal] = None
    resumo_binance: Optional[Dict[str, Any]] = None

class ProventoAnoItemRead(BaseModel):
    ano: int = Field(..., description="Ano de recebimento")
    dividendos_brl: Decimal = Field(default=Decimal("0.0"), description="Total de dividendos no ano em R$")
    jcp_brl: Decimal = Field(default=Decimal("0.0"), description="Total de JCP no ano em R$")
    rendimentos_brl: Decimal = Field(default=Decimal("0.0"), description="Total de rendimentos/aluguel no ano em R$")
    total_div_jcp_brl: Decimal = Field(default=Decimal("0.0"), description="Soma de dividendos e JCP no ano em R$")
    total_geral_brl: Decimal = Field(default=Decimal("0.0"), description="Total geral de proventos no ano em R$")
    pct_dividendo: Decimal = Field(default=Decimal("0.0"), description="Percentual de dividendos sobre (Div + JCP)")
    pct_jcp: Decimal = Field(default=Decimal("0.0"), description="Percentual de JCP sobre (Div + JCP)")
    qtd_pagamentos_dividendo: int = Field(default=0, description="Quantidade de pagamentos de dividendos no ano")
    qtd_pagamentos_jcp: int = Field(default=0, description="Quantidade de pagamentos de JCP no ano")
    qtd_pagamentos_rendimento: int = Field(default=0, description="Quantidade de pagamentos de rendimentos no ano")

    model_config = ConfigDict(from_attributes=True)

class ProventosAtivoAnualRead(BaseModel):
    ativo_id: int
    ticker: str
    nome: str
    tipo_ativo: TipoAtivo
    em_custodia: bool = Field(default=True, description="True se quantidade_saldo > 0")
    quantidade_saldo: Decimal = Field(default=Decimal("0.0"), description="Quantidade atual em custódia")
    total_dividendos_brl: Decimal = Field(default=Decimal("0.0"))
    total_jcp_brl: Decimal = Field(default=Decimal("0.0"))
    total_rendimentos_brl: Decimal = Field(default=Decimal("0.0"))
    total_div_jcp_brl: Decimal = Field(default=Decimal("0.0"))
    total_geral_brl: Decimal = Field(default=Decimal("0.0"))
    pct_dividendo_total: Decimal = Field(default=Decimal("0.0"))
    pct_jcp_total: Decimal = Field(default=Decimal("0.0"))
    anos: List[ProventoAnoItemRead] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)

class ProventosAnuaisCarteiraResponse(BaseModel):
    carteira_id: int
    ativos: List[ProventosAtivoAnualRead] = Field(default_factory=list)

