import { Ativo } from './investimento.models';

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
