import type { DayNum, EngineLot } from '../types';
import type { TaxProfile } from '../taxes';

export type InstrumentKind =
  | 'RENDA_MAIS'
  | 'EDUCA_MAIS'
  | 'CDI_POS'
  | 'CDI_SPREAD'
  | 'SELIC_POS'
  | 'PREFIXADO'
  | 'IPCA_BULLET';

export interface PricingContext {
  /** Taxa de mercado em decimal (MtM). Ignorada por pós-fixados puros em % do CDI. */
  marketRate: number;
  /** Fator de escala do VNA (usado por RendA+ / Educa+). */
  vnaFactor?: number;
  /** Taxa CDI anual em decimal (ex.: 0.1065 para 10,65% a.a.). */
  cdiAnual?: number;
  /** Taxa Selic anual em decimal (ex.: 0.1075 para 10,75% a.a.). */
  selicAnual?: number;
  /** IPCA anual projetado em decimal (ex.: 0.045 para 4,50% a.a.) para IPCA_BULLET. */
  ipcaAnual?: number;
  /** Data base de referência (hoje) em DayNum. */
  refDN?: DayNum;
  /** Mapa histórico diário da Série 12 do BCB (DayNum -> taxa diária em %, ex.: 0.055131). */
  cdiHistorico?: ReadonlyMap<DayNum, number>;
  /** Maior DayNum presente em cdiHistorico. */
  maxCdiHistDN?: DayNum;
}

export interface FixedIncomeInstrument {
  readonly kind: InstrumentKind;
  readonly maxSimDate: DayNum;
  readonly taxProfile: TaxProfile;
  /**
   * Indica se o título possui marcação a mercado secundária sensível a choques de taxa.
   * - true: Tesouro RendA+, Educa+, Tesouro Prefixado, Tesouro IPCA+
   * - false: CDB/LCI/LCA/LC pós-fixado em % do CDI ou CDI+Spread bancário levado na curva
   */
  readonly supportsMtM: boolean;
  /** PU de venda (MtM ou curva) do lote na data t */
  puVenda(t: DayNum, lot: EngineLot, ctx: PricingContext): number;
  /** PU "na curva" (carrego puro) do lote na data t, usando a taxa contratada do próprio lote */
  puCarrego(t: DayNum, lot: EngineLot, ctx: PricingContext): number;
}

