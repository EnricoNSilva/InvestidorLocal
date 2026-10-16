import { Ativo } from './investimento.models';
import { toDayNum } from '../financial-engine/dates';
import type { CustodyConfig, EngineLot } from '../financial-engine/types';

export type Indexador = 'IPCA' | 'CDI' | 'SELIC' | 'PREFIXADO';

export type ProdutoRendaFixa =
  | 'TESOURO_RENDA_MAIS'
  | 'TESOURO_EDUCA_MAIS'
  | 'TESOURO_IPCA'
  | 'TESOURO_IPCA_JUROS'
  | 'TESOURO_SELIC'
  | 'TESOURO_PREFIXADO'
  | 'TESOURO_PREFIXADO_JUROS'
  | 'CDB'
  | 'LCI'
  | 'LCA'
  | 'LC'
  | 'OUTRO';

export interface DetalhesRendaFixa {
  ativo_id: number;
  produto: ProdutoRendaFixa;
  indexador: Indexador;
  emissor: string;
  percentual_indexador?: string | number | null;
  data_emissao?: string | null;
  data_vencimento?: string | null;
  ano_conversao?: number | null;
  num_parcelas?: number | null;
  dia_pagamento?: number | null;
  isento_ir: boolean;
  cobra_custodia_b3: boolean;
  carencia_dias?: number | null;
  codigo_mercado?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AtivoRendaFixa extends Ativo {
  detalhes_rf?: DetalhesRendaFixa | null;
}

export interface LoteAbertoDto {
  transacao_id: number;
  data_compra: string; // 'AAAA-MM-DD'
  taxa_contratada: string | number | null;
  preco_unitario: string | number;
  quantidade_original: string | number;
  quantidade_aberta: string | number;
  custo_aberto_brl: string | number;
  custo_conhecido: boolean;
}

export interface FluxoRecebidoDto {
  transacao_id: number;
  data: string;
  tipo: 'AMORTIZACAO' | 'JUROS_CUPOM' | 'SELL' | string;
  valor_brl: string | number;
}

export interface PosicaoRendaFixa {
  ativo: AtivoRendaFixa;
  lotes: LoteAbertoDto[];
  fluxos_recebidos: FluxoRecebidoDto[];
  quantidade_total: string | number;
  custo_total_brl: string | number;
  pendencias: string[];
}

export interface LotesRendaFixaResponse {
  carteira_id: number;
  gerado_em: string;
  posicoes: PosicaoRendaFixa[];
}

export interface EnvelopeMercado<T = any> {
  fonte: string;
  obtido_em: string;
  cache_hit: boolean;
  stale: boolean;
  dados: T;
}

export interface SerieMacroRead {
  codigo: number;
  nome: string;
  ultima_data: string;
  valor_bruto: string | number;
  valor_anualizado_pct: string | number;
}

export interface MacroResponse {
  obtido_em: string;
  ipca_12m: SerieMacroRead;
  selic: SerieMacroRead;
  cdi?: SerieMacroRead | null;
}

export interface TaxaContratadaPatch {
  taxa_contratada: number | string;
}

export interface LoteManualCreateDto {
  carteira_id?: number;
  data_compra: string; // 'AAAA-MM-DD'
  quantidade: number | string;
  preco_unitario: number | string;
  taxa_contratada: number | string;
  taxas?: number | string;
}

export interface CadastroManualRendaFixaDto {
  ticker?: string | null;
  nome: string;
  detalhes: DetalhesRendaFixaUpsert;
  lote_inicial?: LoteManualCreateDto | null;
}

export interface DetalhesRendaFixaUpsert {
  produto: ProdutoRendaFixa;
  indexador: Indexador;
  emissor?: string;
  percentual_indexador?: number | null;
  data_emissao?: string | null;
  data_vencimento?: string | null;
  ano_conversao?: number | null;
  num_parcelas?: number | null;
  dia_pagamento?: number | null;
  isento_ir?: boolean;
  cobra_custodia_b3?: boolean;
  carencia_dias?: number | null;
  codigo_mercado?: string | null;
}

export interface CotacaoTesouroItem {
  symbol: string;
  name: string;
  indexer: string;
  sellPrice: number;
  sellRate: number;
  baseDate?: string;
}

export interface CotacaoTesouroResponse {
  data_referencia: string;
  cotacoes: CotacaoTesouroItem[];
}

export interface Premissas {
  selectedBond: string;
  refDate: string;
  refPrice: number;
  refRate: number | string;
  spread: number;
  ipcaCal: number;
  ipcaProj: number;
  cdiRatePct: number;
  custody: CustodyConfig;
}

export interface SimInputs {
  simDN: number;
  simYears: number;
  targetRatePct: number;
  convMonths: number;
  spread: number;
  qtyToSell: number | '';
}

export interface MercadoSnapshot {
  tesouro: EnvelopeMercado<CotacaoTesouroResponse> | null;
  macro: MacroResponse | null;
}

export interface ProjectionSeries {
  labels: string[];
  series: {
    alvo: number[];
    carrego: number[];
    cdi: number[];
    queda5: number[];
    alta8: number[];
  };
}

export interface AllocationSlice {
  label: string;
  value: number;
  pct: number;
}

export function toEngineLot(l: LoteAbertoDto): EngineLot | null {
  if (
    l.taxa_contratada === null ||
    l.taxa_contratada === undefined ||
    l.taxa_contratada === '' ||
    !l.custo_conhecido
  ) {
    return null;
  }
  return {
    id: l.transacao_id,
    date: l.data_compra,
    dn: toDayNum(l.data_compra),
    rate: Number(l.taxa_contratada),
    price: Number(l.preco_unitario),
    qty: Number(l.quantidade_aberta),
  };
}

export function isLot(l: EngineLot | null): l is EngineLot {
  return l !== null;
}


