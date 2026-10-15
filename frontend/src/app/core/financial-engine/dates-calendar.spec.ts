import {
  toDayNum,
  dayNumToIso,
  formatBRLDate,
  addMonthsDN,
  addYearsDN,
  diffDays,
  diffYears,
} from './dates';
import {
  getEaster,
  isBusDay,
  nextBusDay,
  getBusDays,
  HOLIDAYS,
  CAL_START,
  CAL_END,
} from './calendar';

describe('Financial Engine: Dates & Calendar ANBIMA', () => {
  it('converte corretamente entre ISO e número de dias UTC sem derivação de timezone', () => {
    const iso = '2026-10-05';
    const dn = toDayNum(iso);
    expect(dayNumToIso(dn)).toBe(iso);
    expect(formatBRLDate(dn)).toBe('05/10/2026');
  });

  it('calcula a Páscoa e feriados móveis conhecidos com precisão', () => {
    // Em 2026: Páscoa é 05/04/2026
    const easter2026 = getEaster(2026);
    expect(dayNumToIso(easter2026)).toBe('2026-04-05');

    // Sexta-feira da Paixão: 03/04/2026
    expect(HOLIDAYS.has(toDayNum('2026-04-03'))).toBe(true);
    expect(isBusDay(toDayNum('2026-04-03'))).toBe(false);

    // Corpus Christi: 04/06/2026 (60 dias após Páscoa)
    expect(HOLIDAYS.has(toDayNum('2026-06-04'))).toBe(true);
    expect(isBusDay(toDayNum('2026-06-04'))).toBe(false);
  });

  it('inclui o feriado de 20 de Novembro (Consciência Negra) a partir de 2024', () => {
    const nov20_2023 = toDayNum('2023-11-20');
    const nov20_2024 = toDayNum('2024-11-20');
    const nov20_2026 = toDayNum('2026-11-20');

    expect(HOLIDAYS.has(nov20_2023)).toBe(false); // Antes da lei federal
    expect(HOLIDAYS.has(nov20_2024)).toBe(true); // Primeiro ano da lei
    expect(HOLIDAYS.has(nov20_2026)).toBe(true);
    expect(isBusDay(nov20_2026)).toBe(false);
  });

  it('avança fins de semana e feriados para o próximo dia útil (nextBusDay)', () => {
    // Sábado 10/10/2026 -> Segunda-feira 12/10 é feriado (Nossa Sra. Aparecida) -> Terça-feira 13/10/2026
    const sat = toDayNum('2026-10-10');
    const nbd = nextBusDay(sat);
    expect(dayNumToIso(nbd)).toBe('2026-10-13');
  });

  it('calcula a contagem de dias úteis com exatidão O(1)', () => {
    // Segunda 05/10/2026 a Sexta 09/10/2026 = 4 d.u.
    const start = toDayNum('2026-10-05');
    const end = toDayNum('2026-10-09');
    expect(getBusDays(start, end)).toBe(4);
    expect(getBusDays(end, start)).toBe(-4);
    expect(getBusDays(start, start)).toBe(0);
  });
});
