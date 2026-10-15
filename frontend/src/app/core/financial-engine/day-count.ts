import { getBusDays } from './calendar';
import type { DayNum } from './types';

/** 1) Desconto de fluxos/PU e 2) projeção do VNA: dias úteis ANBIMA / 252 */
export const BUS_DAYS_YEAR = 252;
export const yearFracBus252 = (a: DayNum, b: DayNum): number => getBusDays(a, b) / BUS_DAYS_YEAR;

/** 3) Custódia B3: dias corridos / 365.0, com faixas em 3652.5 e 7305.0 dias */
export const CUSTODY_DAYS_YEAR = 365.0;
export const CUSTODY_TIER_10Y = 3652.5;
export const CUSTODY_TIER_20Y = 7305.0;

/** 4) Faixas de IR (≤180, ≤360, ≤720) e IOF (30d): dias corridos inteiros */
export const calendarDays = (a: DayNum, b: DayNum): number => b - a;

/** 5) XIRR: dias corridos / 365.25 */
export const XIRR_DAYS_YEAR = 365.25;
export const yearFracAct36525 = (a: DayNum, b: DayNum): number => (b - a) / XIRR_DAYS_YEAR;

/** 6) Convergência da taxa (cenário): meses = dias corridos / 30.4375 */
export const AVG_DAYS_MONTH = 30.4375; // 365.25 / 12
export const monthsElapsed = (a: DayNum, b: DayNum): number => Math.max(0, b - a) / AVG_DAYS_MONTH;
