/**
 * Motor Financeiro - Módulo de Calendário ANBIMA
 * Dias úteis (252 d.u./ano), feriados nacionais e algoritmo de Páscoa.
 */

import { MS_DAY, toDayNum } from './dates';
import type { DayNum } from './types';

/**
 * Cálculo da data da Páscoa pelo algoritmo de Meeus/Jones/Butcher.
 * @param y - Ano
 * @returns dia numérico UTC
 */
export function getEaster(y: number): DayNum {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return Math.round(
    Date.UTC(y, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1) /
      MS_DAY
  );
}

export const CAL_START: DayNum = toDayNum('2000-01-01');
export const CAL_END: DayNum = toDayNum('2090-12-31');

export const HOLIDAYS: Set<DayNum> = new Set<DayNum>();

for (let y = 2000; y <= 2090; y++) {
  // Feriados Nacionais Fixos
  const fixedHolidays: [number, number][] = [
    [1, 1], // Confraternização Universal
    [4, 21], // Tiradentes
    [5, 1], // Dia do Trabalho
    [9, 7], // Independência do Brasil
    [10, 12], // Nossa Senhora Aparecida
    [11, 2], // Finados
    [11, 15], // Proclamação da República
    [12, 25], // Natal
  ];

  for (const [m, d] of fixedHolidays) {
    HOLIDAYS.add(toDayNum(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`));
  }

  // Dia Nacional de Zumbi e da Consciência Negra (Lei nº 14.759/2023 - a partir de 2024)
  if (y >= 2024) {
    HOLIDAYS.add(toDayNum(`${y}-11-20`));
  }

  // Feriados móveis derivados da Páscoa
  const e = getEaster(y);
  HOLIDAYS.add(e - 48); // Segunda-feira de Carnaval
  HOLIDAYS.add(e - 47); // Terça-feira de Carnaval
  HOLIDAYS.add(e - 2); // Sexta-feira da Paixão
  HOLIDAYS.add(e + 60); // Corpus Christi
}

// Tabela acumulada de dias úteis para contagem O(1)
const CUM_BUS_DAYS = new Int32Array(CAL_END - CAL_START + 2);
for (let n = CAL_START; n <= CAL_END; n++) {
  const dayOfWeek = new Date(n * MS_DAY).getUTCDay();
  const isBus = dayOfWeek !== 0 && dayOfWeek !== 6 && !HOLIDAYS.has(n);
  CUM_BUS_DAYS[n - CAL_START + 1] = CUM_BUS_DAYS[n - CAL_START] + (isBus ? 1 : 0);
}

/**
 * Verifica se um dia é dia útil segundo o padrão ANBIMA.
 */
export function isBusDay(dn: DayNum): boolean {
  const dow = new Date(dn * MS_DAY).getUTCDay();
  return dow !== 0 && dow !== 6 && !HOLIDAYS.has(dn);
}

/**
 * Retorna a quantidade de dias úteis entre a e b.
 * Se b >= a, resultado positivo; se b < a, negativo.
 */
export function getBusDays(a: DayNum, b: DayNum): number {
  if (a > b) return -getBusDays(b, a);
  const idxA = Math.max(0, Math.min(CAL_END - CAL_START + 1, a - CAL_START));
  const idxB = Math.max(0, Math.min(CAL_END - CAL_START + 1, b - CAL_START));
  return CUM_BUS_DAYS[idxB] - CUM_BUS_DAYS[idxA];
}

/**
 * Avança para o próximo dia útil (ou retorna o próprio dia se já for útil).
 */
export function nextBusDay(dn: DayNum): DayNum {
  let curr = dn;
  while (!isBusDay(curr)) {
    curr++;
  }
  return curr;
}
