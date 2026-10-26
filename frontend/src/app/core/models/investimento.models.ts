export type TipoAtivo = 'Acao' | 'FII' | 'Cripto' | 'RendaFixa';

export type FiltroClasseCarteira =
  | 'RV_TOTAL'      // Ações & FIIs (Default)
  | 'ACAO'          // Somente Ações
  | 'FII'           // Somente FIIs
  | 'CRIPTO'        // Criptoativos
  | 'RENDA_FIXA'    // Renda Fixa
  | 'PATRIMONIO';   // Todas as classes juntas

export type TipoOperacao =
  | 'BUY'
  | 'SELL'
  | 'TRANSFERENCIA_ENTRADA'
  | 'BONIFICACAO'
  | 'DIREITO_SUBSCRICAO'
  | 'DIREITO_SUBSCRICAO_EXPIRADO'
  | 'AMORTIZACAO'
  | 'JUROS_CUPOM'
  | 'DIVIDENDO'
  | 'JCP'
  | 'RENDIMENTO'
  | 'RESTITUICAO_CAPITAL';

export interface Ativo {
  id: number;
  ticker: string;
  nome: string;
  tipo: TipoAtivo;
  setor?: string | null;
  cotacao_manual?: string | number | null;
  created_at?: string;
  updated_at?: string;
}

export interface Carteira {
  id: number;
  nome: string;
  descricao?: string | null;
  created_at?: string;
}

export interface LoteTransferenciaPendente {
  transacao_id: number;
  data: string;
  quantidade: string | number;
}

export interface CotacaoHistoricaResponse {
  ticker: string;
  data: string;
  cotacao_fechamento: number | null;
}

export interface PosicaoConsolidada {
  id: number;
  carteira_id: number;
  ativo_id: number;
  quantidade_saldo: string | number;
  custo_total_brl: string | number;
  preco_medio_brl: string | number;
  proventos_acumulados_brl: string | number;
  lucro_realizado_brl: string | number;
  valor_total_venda_brl?: string | number;
  custo_historico_brl?: string | number;
  quantidade_sem_custo?: string | number;
  custo_pendente?: boolean;
  lotes_pendentes?: LoteTransferenciaPendente[];
  dividendo_por_acao_brl: string | number;
  preco_medio_ajustado_brl: string | number;
  yoc_acumulado_pct: string | number;
  data_atualizacao: string;
  ativo?: Ativo | null;
  // Campos Cripto & Binance
  preco_medio_usd?: string | number | null;
  custo_total_usd?: string | number | null;
  quantidade_vendida?: string | number | null;
  custo_vendas_brl?: string | number | null;
  valor_total_vendas_brl?: string | number | null;
  qtd_earn?: string | number | null;
  qtd_autocustodia?: string | number | null;
  pct_earn?: string | number | null;
  pct_autocustodia?: string | number | null;
  earn_interest_moeda?: string | number | null;
  codigo_rfb_irpf?: string | null;
  texto_irpf?: string | null;
}

export interface CotacaoItem {
  ticker: string;
  preco_atual: string | number;
  variacao_diaria_pct?: string | number | null;
  fonte: 'MANUAL' | 'YAHOO' | 'BRAPI' | 'CACHE' | 'INDISPONIVEL' | 'TESOURO' | 'CURVA_CDI' | 'BINANCE';
  atualizado_em?: string | null;
  stale: boolean;
  preco_usd?: string | number | null;
  preco_btc?: string | number | null;
}

export interface ResumoBinanceMetadata {
  carteira_id?: number;
  fiat_depositado_brl?: number;
  gastos_pay_card_brl?: number;
  earn_usdt_usd?: number;
  custodia_detalhada?: Record<string, any>;
  atualizado_em?: string;
}

export interface CotacoesCarteiraResponse {
  carteira_id: number;
  atualizado_em: string;
  stale: boolean;
  cotacoes: Record<string, CotacaoItem>;
  cotacao_usd_brl?: string | number | null;
  cotacao_btc_brl?: string | number | null;
  resumo_binance?: ResumoBinanceMetadata | null;
}

export interface PosicaoEnriquecida {
  posicao: PosicaoConsolidada;
  ativo: Ativo;
  quantidade: number;
  pmContabil: number;
  custoTotal: number;
  custoPendente: boolean;          // true quando quantidadeSemCusto > 0 ou (quantidade > 0 e pmContabil <= 0)
  quantidadeSemCusto: number;
  lotesPendentes: LoteTransferenciaPendente[];
  valorTotalVendaBrl?: number;     // para posições encerradas
  proventosTotal: number;
  dividendoPorAcao: number;
  pmAjustado: number;              // max(0, pmContabil - dividendoPorAcao)
  cotacaoAtual: number;
  fonteCotacao: CotacaoItem['fonte'];
  variacaoDiariaPct: number;
  valorMercado: number;            // quantidade * cotacaoAtual
  lucroNaoRealizadoBrl: number;    // se custoPendente: 0, senão valorMercado - custoTotal
  rentabCotaPct: number;           // se custoTotal > 0: ((valorMercado - custoTotal) / custoTotal) * 100
  retornoTotalBrl: number;         // lucroNaoRealizadoBrl + proventosTotal + lucroRealizadoBrl
  rentabTotalComDivPct: number;    // se custoTotal > 0: ((valorMercado + proventosTotal - custoTotal) / custoTotal) * 100
  yocPct: number;                  // se custoTotal > 0: (proventosTotal / custoTotal) * 100
  lucroRealizadoBrl: number;
  pesoCarteiraPct: number;         // participação % no valor de mercado da aba filtrada
  // Cripto & Binance (Adições 1, 2 e 3)
  pmUsd?: number | null;
  pmAjustadoUsd?: number | null;
  cotacaoUsd?: number | null;
  cotacaoBtc?: number | null;
  valorMercadoUsd?: number | null;
  valorMercadoBtc?: number | null;
  qtdAutocustodia?: number | null;
  qtdEarn?: number | null;
  pctAutocustodia?: number | null;
  pctEarn?: number | null;
  earnInterestMoeda?: number | null;
  codigoRfbIrpf?: string | null;
  textoIrpfBensDireitos?: string | null;
  quantidadeVendida?: number | null;
  custoVendasBrl?: number | null;
  valorTotalVendasBrl?: number | null;
}

export interface AjusteManualPosicaoDto {
  ticker?: string | null;
  quantidade_saldo?: number | null;
  preco_medio_brl?: number | null;
  proventos_acumulados_brl?: number | null;
  cotacao_manual?: number | null;
  nome_ativo?: string | null;
  tipo_ativo?: TipoAtivo | null;
  setor?: string | null;
  transacao_id?: number | null;
  preco_unitario_transferencia?: number | null;
  pm_consolidado_atual?: number | null;
}

export interface ConversaoTickerDto {
  novo_ticker: string;
  novo_nome?: string | null;
  fator_conversao?: number;
  cotacao_manual?: number | null;
}

export interface AtivoUpdateDto {
  ticker?: string;
  nome?: string;
  tipo?: TipoAtivo;
  setor?: string | null;
  cotacao_manual?: number | null;
}

export interface TransacaoUpdateDto {
  carteira_id?: number | null;
  ativo_id?: number | null;
  data_hora?: string | null;
  tipo_operacao?: TipoOperacao | null;
  quantidade?: number | null;
  preco_unitario?: number | null;
  taxas?: number | null;
  moeda?: string | null;
  moeda_taxa?: string | null;
  ptax_utilizada?: number | null;
  taxa_contratada?: number | null;
}

export interface TransacaoCreateDto {
  carteira_id?: number;
  ativo_id: number;
  data_hora?: string;
  tipo_operacao: TipoOperacao;
  quantidade: number;
  preco_unitario: number;
  taxas?: number;
  moeda?: string;
  moeda_taxa?: string;
  ptax_utilizada?: number | null;
  taxa_contratada?: number | null;
}

export interface CarteiraKpis {
  montanteAportadoBrl: number;
  qtdAtivosCustoPendente: number;
  qtdAtivosCustodia: number;
  patrimonioMercadoBrl: number;
  valorizacaoCotaBrl: number;
  valorizacaoCotaPct: number;
  proventosRecebidosBrl: number;
  yocCarteiraPct: number;
  reducaoMediaPmPct: number;
  retornoTotalBrl: number;
  retornoTotalPct: number;
  lucroRealizadoTotalBrl: number;
  patrimonioMercadoUsd?: number;
  patrimonioMercadoBtc?: number;
}

export interface ChartAlocacaoData {
  porAtivo: { labels: string[]; data: number[]; percentual: number[] };
  porSetor: { labels: string[]; data: number[]; percentual: number[] };
  porClasse: { labels: string[]; data: number[]; percentual: number[] };
}

export interface ChartPesoAtivosData {
  labels: string[];
  data: number[];
  percentual: number[];
}

export interface ChartRankingProventosData {
  labels: string[];
  proventos: number[];
  yoc: number[];
}

export interface Transacao {
  id: number;
  ativo_id: number;
  carteira_id?: number;
  data_hora: string;
  tipo_operacao: TipoOperacao;
  quantidade: string | number;
  preco_unitario: string | number;
  taxas: string | number;
  moeda: string;
  moeda_taxa?: string | null;
  ptax_utilizada?: string | number | null;
  taxa_contratada?: string | number | null;
  created_at?: string;
  ativo?: Ativo | null;
}

export interface RetornoImportacao {
  status: string;
  origem: string;
  filename: string;
  transacoes_processadas?: number;
  transferencias_processadas?: number;
  mensagem: string;
  pendencias?: string[];
  avisos?: string[];
}

export interface ProventoAnoItem {
  ano: number;
  dividendos_brl: string | number;
  jcp_brl: string | number;
  rendimentos_brl: string | number;
  total_div_jcp_brl: string | number;
  total_geral_brl: string | number;
  pct_dividendo: string | number;
  pct_jcp: string | number;
  qtd_pagamentos_dividendo: number;
  qtd_pagamentos_jcp: number;
  qtd_pagamentos_rendimento: number;
}

export interface ProventosAtivoAnual {
  ativo_id: number;
  ticker: string;
  nome: string;
  tipo_ativo: TipoAtivo;
  em_custodia: boolean;
  quantidade_saldo: string | number;
  total_dividendos_brl: string | number;
  total_jcp_brl: string | number;
  total_rendimentos_brl: string | number;
  total_div_jcp_brl: string | number;
  total_geral_brl: string | number;
  pct_dividendo_total: string | number;
  pct_jcp_total: string | number;
  anos: ProventoAnoItem[];
}

export interface ProventosAnuaisCarteiraResponse {
  carteira_id: number;
  ativos: ProventosAtivoAnual[];
}

