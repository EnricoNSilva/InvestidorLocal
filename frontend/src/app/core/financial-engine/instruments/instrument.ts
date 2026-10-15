import type { DayNum, EngineLot } from '../types';
import type { TaxProfile } from '../taxes';

export interface PricingContext {
  marketRate: number; // taxa de mercado em decimal (MtM). Ignorada por pós-fixados.
  vnaFactor?: number; // RendA+/IPCA+
  cdiAnual?: number; // decimal, ex.: 0.1065 (futuro, pós-fixado CDI)
}

export interface FixedIncomeInstrument {
  readonly kind: 'RENDA_MAIS' | 'EDUCA_MAIS' | 'CDI_POS' | 'PREFIXADO';
  readonly maxSimDate: DayNum;
  readonly taxProfile: TaxProfile;
  /** PU de venda (MtM) do lote em t */
  puVenda(t: DayNum, lot: EngineLot, ctx: PricingContext): number;
  /** PU "na curva" (carrego) do lote em t, usando a taxa contratada do próprio lote */
  puCarrego(t: DayNum, lot: EngineLot, ctx: PricingContext): number;
}
