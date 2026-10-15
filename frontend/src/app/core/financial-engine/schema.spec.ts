import { parseNumber, sanitizeLot, sanitizeState } from './schema';
import { DEFAULT_STATE } from './defaults';

describe('Financial Engine: Schema & Validação', () => {
  it('converte corretamente números formatados no padrão pt-BR com vírgula e milhar', () => {
    expect(parseNumber('243,38')).toBe(243.38);
    expect(parseNumber('1.250,50')).toBe(1250.5);
    expect(parseNumber(' 35.000,00 ')).toBe(35000);
    expect(parseNumber(123.45)).toBe(123.45);
    expect(parseNumber('', 4.5)).toBe(4.5);
    expect(parseNumber('invalido', 10)).toBe(10);
  });

  it('sanitiza e valida lotes de compras', () => {
    const lot = sanitizeLot({
      date: '2026-03-24',
      rate: '7,14',
      price: '177,03',
      qty: '56,48',
    });

    expect(lot.id).toBeDefined();
    expect(lot.rate).toBe(7.14);
    expect(lot.price).toBe(177.03);
    expect(lot.qty).toBe(56.48);
  });

  it('rejeita lote com quantidade ou preço menor ou igual a zero', () => {
    expect(() => sanitizeLot({ date: '2026-01-01', rate: 6, price: 100, qty: 0 })).toThrow();
    expect(() => sanitizeLot({ date: '2026-01-01', rate: 6, price: 0, qty: 10 })).toThrow();
  });

  it('sanitiza o estado global respeitando os defaults', () => {
    const sanitized = sanitizeState({});
    expect(sanitized.selectedBond).toBe(DEFAULT_STATE.selectedBond);
    expect(sanitized.refPrice).toBe(DEFAULT_STATE.refPrice);
    expect(sanitized.lots.length).toBe(4);
  });
});
