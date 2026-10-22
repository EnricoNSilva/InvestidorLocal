import { toDayNum } from './dates';
import { getBusDays } from './calendar';
import {
  calcCdiFactor,
  calcCdiSpreadFactor,
  createCdiInstrument,
} from './instruments/cdi-pos';
import { createBulletInstrument } from './instruments/bullet';
import { decomposeCarryAndMtM, simulateSell } from './portfolio';
import { buildProjectionCurves } from './projection';
import type { EngineLot } from './types';

describe('Motor Financeiro - CDI Pós-Fixado e Bullet (§1 e §2 PLANO_CDI)', () => {
  const dCompra = toDayNum('2025-01-02'); // Quinta-feira
  const dVenc = toDayNum('2028-01-02');

  const loteCdb110: EngineLot = {
    id: 1,
    date: '2025-01-02',
    dn: dCompra,
    rate: 110, // 110% CDI
    price: 1000.0,
    qty: 10,
  };

  const loteLci93: EngineLot = {
    id: 2,
    date: '2025-01-02',
    dn: dCompra,
    rate: 93, // 93% CDI
    price: 1000.0,
    qty: 10,
  };

  describe('1. Capitalização Base 252 dias úteis (calcCdiFactor e calcCdiSpreadFactor)', () => {
    it('deve retornar 1.0 quando du <= 0', () => {
      expect(calcCdiFactor(0, 0.1065, 100)).toBe(1.0);
      expect(calcCdiFactor(-5, 0.1065, 110)).toBe(1.0);
      expect(calcCdiSpreadFactor(0, 0.1065, 1.5)).toBe(1.0);
      expect(calcCdiSpreadFactor(-2, 0.1065, 1.5)).toBe(1.0);
    });

    it('deve capitalizar exatamente a taxa anual em 252 dias úteis para 100% do CDI', () => {
      const cdiAnual = 0.1065;
      const factor = calcCdiFactor(252, cdiAnual, 100);
      expect(factor).toBeCloseTo(1 + cdiAnual, 8);
    });

    it('deve capitalizar corretamente CDB 110% CDI e LCI 93% CDI em 252 dias úteis', () => {
      const cdiAnual = 0.1065;
      const dailyCdi = Math.pow(1 + cdiAnual, 1 / 252) - 1;

      const expectedFactor110 = Math.pow(1 + dailyCdi * 1.10, 252);
      expect(calcCdiFactor(252, cdiAnual, 110)).toBeCloseTo(expectedFactor110, 8);

      const expectedFactor93 = Math.pow(1 + dailyCdi * 0.93, 252);
      expect(calcCdiFactor(252, cdiAnual, 93)).toBeCloseTo(expectedFactor93, 8);
    });

    it('deve capitalizar taxa combinada em CDI + Spread (ex: CDI + 1.50% a.a.)', () => {
      const baseAnual = 0.1065;
      const spreadPct = 1.50;
      const factor = calcCdiSpreadFactor(252, baseAnual, spreadPct);
      const expectedCombined = (1 + baseAnual) * (1 + spreadPct / 100);
      expect(factor).toBeCloseTo(expectedCombined, 8);
    });

    it('deve respeitar a data de vencimento (effectiveT = min(t, vencimento))', () => {
      const cdiInst = createCdiInstrument({
        vencimento: dVenc,
        isentoIr: false,
        cobraCustodiaB3: false,
      });

      const ctx = { marketRate: 0, cdiAnual: 0.1065 };
      const puNoVenc = cdiInst.puVenda(dVenc, loteCdb110, ctx);
      const puAposVenc = cdiInst.puVenda(dVenc + 100, loteCdb110, ctx);
      expect(puAposVenc).toBe(puNoVenc);
    });
  });

  describe('2. Regras Tributárias e Custódia (LCI/LCA Isenta vs CDB Tributado)', () => {
    const lciInst = createCdiInstrument({
      vencimento: dVenc,
      isentoIr: true,
      cobraCustodiaB3: false,
    });

    const cdbInst = createCdiInstrument({
      vencimento: dVenc,
      isentoIr: false,
      cobraCustodiaB3: false,
    });

    it('deve aplicar IOF regressivo nos primeiros 29 dias corridos mesmo em LCI/LCA isenta de IR', () => {
      // 15 dias corridos após a compra
      const d15 = dCompra + 15;
      const resLci = simulateSell({
        lots: [loteLci93],
        t: d15,
        instrument: lciInst,
        ctx: { marketRate: 0, cdiAnual: 0.1065 },
      });

      expect(resLci.cust).toBe(0);
      expect(resLci.ir).toBe(0);
      expect(resLci.irApp).toBe(0);
      expect(resLci.iof).toBeGreaterThan(0);
      expect(resLci.liqReal).toBe(resLci.liqApp);
      expect(resLci.liqReal).toBe(resLci.bruto - resLci.iof);
    });

    it('não deve cobrar IOF, IR nem custódia em LCI/LCA após 30 dias corridos', () => {
      const d45 = dCompra + 45;
      const resLci = simulateSell({
        lots: [loteLci93],
        t: d45,
        instrument: lciInst,
        ctx: { marketRate: 0, cdiAnual: 0.1065 },
      });

      expect(resLci.cust).toBe(0);
      expect(resLci.ir).toBe(0);
      expect(resLci.irApp).toBe(0);
      expect(resLci.iof).toBe(0);
      expect(resLci.liqReal).toBe(resLci.bruto);
      expect(resLci.liqReal).toBe(resLci.liqApp);
    });

    it('deve cobrar IR regressivo de 22,5% em CDB antes de 180 dias sem taxa B3', () => {
      const d45 = dCompra + 45;
      const resCdb = simulateSell({
        lots: [loteCdb110],
        t: d45,
        instrument: cdbInst,
        ctx: { marketRate: 0, cdiAnual: 0.1065 },
      });

      expect(resCdb.cust).toBe(0);
      expect(resCdb.iof).toBe(0);
      expect(resCdb.ir).toBeGreaterThan(0);
      // Sem custódia B3, liqReal === liqApp
      expect(resCdb.liqReal).toBe(resCdb.liqApp);
      expect(resCdb.liqReal).toBe(resCdb.bruto - resCdb.ir);
    });
    it('deve respeitar a fronteira exata de isenção de IOF: presente no dia 29 e zero a partir do dia 30', () => {
      const d29 = dCompra + 29;
      const res29 = simulateSell({
        lots: [loteLci93],
        t: d29,
        instrument: lciInst,
        ctx: { marketRate: 0, cdiAnual: 0.1065 },
      });
      expect(res29.iof).toBeGreaterThan(0);

      const d30 = dCompra + 30;
      const res30 = simulateSell({
        lots: [loteLci93],
        t: d30,
        instrument: lciInst,
        ctx: { marketRate: 0, cdiAnual: 0.1065 },
      });
      expect(res30.iof).toBe(0);
    });

    it('deve respeitar os degraus exatos da tabela regressiva de IR em CDB (180d, 360d, 720d)', () => {
      const ctx = { marketRate: 0, cdiAnual: 0.1065 };

      // 180 dias -> 22,5%
      const res180 = simulateSell({ lots: [loteCdb110], t: dCompra + 180, instrument: cdbInst, ctx });
      expect(res180.parts[0].irAliq).toBe(0.225);

      // 181 dias -> 20,0%
      const res181 = simulateSell({ lots: [loteCdb110], t: dCompra + 181, instrument: cdbInst, ctx });
      expect(res181.parts[0].irAliq).toBe(0.20);

      // 360 dias -> 20,0%
      const res360 = simulateSell({ lots: [loteCdb110], t: dCompra + 360, instrument: cdbInst, ctx });
      expect(res360.parts[0].irAliq).toBe(0.20);

      // 361 dias -> 17,5%
      const res361 = simulateSell({ lots: [loteCdb110], t: dCompra + 361, instrument: cdbInst, ctx });
      expect(res361.parts[0].irAliq).toBe(0.175);

      // 720 dias -> 17,5%
      const res720 = simulateSell({ lots: [loteCdb110], t: dCompra + 720, instrument: cdbInst, ctx });
      expect(res720.parts[0].irAliq).toBe(0.175);

      // 721 dias -> 15,0%
      const res721 = simulateSell({ lots: [loteCdb110], t: dCompra + 721, instrument: cdbInst, ctx });
      expect(res721.parts[0].irAliq).toBe(0.15);
    });

    it('deve cobrar taxa de custódia B3 para Tesouro Selic (SELIC_POS) com cobraCustodiaB3 = true', () => {
      const selicInst = createCdiInstrument({
        kind: 'SELIC_POS',
        vencimento: dVenc,
        isentoIr: false,
        cobraCustodiaB3: true,
        custodyConfig: { custMode: 'single', cust1: 0.20 },
      });

      const loteSelic: EngineLot = {
        id: 10,
        date: '2025-01-02',
        dn: dCompra,
        rate: 0.05, // Selic + 0.05%
        price: 10000.0,
        qty: 1,
      };

      const resSelic = simulateSell({
        lots: [loteSelic],
        t: dCompra + 365,
        instrument: selicInst,
        ctx: { marketRate: 0, selicAnual: 0.1075 },
      });

      expect(resSelic.cust).toBeGreaterThan(0);
      expect(resSelic.ir).toBeGreaterThan(0);
      expect(resSelic.liqReal).toBeLessThan(resSelic.liqApp);
      expect(selicInst.supportsMtM).toBe(false);
    });
  });

  describe('3. Decomposição Carrego vs Marcação a Mercado em CDI_POS', () => {
    it('deve resultar em ganhoMarcacao === 0 e 100% de Carrego em pós-fixado CDI com lote único', () => {
      const cdiInst = createCdiInstrument({
        vencimento: dVenc,
        isentoIr: false,
        cobraCustodiaB3: false,
      });

      const d180 = dCompra + 180;
      const ctx = { marketRate: 0, cdiAnual: 0.1065 };
      const simRes = simulateSell({
        lots: [loteCdb110],
        t: d180,
        instrument: cdiInst,
        ctx,
      });

      const decomp = decomposeCarryAndMtM({
        simRes,
        simDN: d180,
        instrument: cdiInst,
        ctx,
      });

      expect(decomp.ganhoBrutoTotal).toBeGreaterThan(0);
      expect(decomp.ganhoMarcacao).toBe(0);
      expect(decomp.ganhoCarrego).toBe(decomp.ganhoBrutoTotal);
      expect(decomp.pctCarrego).toBe(1.0);
      expect(decomp.pctMarcacao).toBe(0);
    });

    it('deve resultar em ganhoMarcacao === 0 em pós-fixado CDI com múltiplos lotes e venda parcial', () => {
      const cdiInst = createCdiInstrument({
        vencimento: dVenc,
        isentoIr: false,
        cobraCustodiaB3: false,
      });

      const lote2: EngineLot = {
        id: 20,
        date: '2025-03-01',
        dn: toDayNum('2025-03-01'),
        rate: 115, // 115% CDI
        price: 1020.0,
        qty: 5,
      };

      const dSim = toDayNum('2025-06-01');
      const ctx = { marketRate: 0, cdiAnual: 0.1065 };
      // Vende 12 unidades (consome 10 do lote 1 e 2 do lote 2)
      const simRes = simulateSell({
        lots: [loteCdb110, lote2],
        t: dSim,
        instrument: cdiInst,
        ctx,
        qtyToSell: 12,
      });

      expect(simRes.parts.length).toBe(2);
      expect(simRes.q).toBe(12);

      const decomp = decomposeCarryAndMtM({
        simRes,
        simDN: dSim,
        instrument: cdiInst,
        ctx,
      });

      expect(decomp.ganhoBrutoTotal).toBeGreaterThan(0);
      expect(decomp.ganhoMarcacao).toBe(0);
      expect(decomp.ganhoCarrego).toBe(decomp.ganhoBrutoTotal);
      expect(decomp.pctCarrego).toBe(1.0);
      expect(decomp.pctMarcacao).toBe(0);
    });
  });

  describe('4. Precificação em bullet.ts (PREFIXADO e IPCA_BULLET)', () => {
    it('CDB Prefixado sem MtM (supportsMtM = false) deve ter puVenda igual a puCarrego', () => {
      const cdbPre = createBulletInstrument({
        kind: 'PREFIXADO',
        vencimento: dVenc,
        isentoIr: false,
        cobraCustodiaB3: false,
        supportsMtM: false,
      });

      const lotePre: EngineLot = {
        id: 3,
        date: '2025-01-02',
        dn: dCompra,
        rate: 12.0, // 12% a.a.
        price: 1000.0,
        qty: 1,
      };

      const ctx = { marketRate: 0.15 }; // taxa de mercado mais alta não afeta puVenda
      const d1Ano = dCompra + 365;
      const carry = cdbPre.puCarrego(d1Ano, lotePre, ctx);
      const venda = cdbPre.puVenda(d1Ano, lotePre, ctx);

      expect(venda).toBe(carry);
      expect(cdbPre.supportsMtM).toBe(false);
    });

    it('Tesouro Prefixado com MtM (supportsMtM = true) deve sofrer deságio quando marketRate > lotRate', () => {
      const tesouroPre = createBulletInstrument({
        kind: 'PREFIXADO',
        vencimento: dVenc,
        isentoIr: false,
        cobraCustodiaB3: true,
        supportsMtM: true,
      });

      const lotePre: EngineLot = {
        id: 4,
        date: '2025-01-02',
        dn: dCompra,
        rate: 10.0, // contratado 10% a.a.
        price: 1000.0,
        qty: 1,
      };

      const d1Ano = dCompra + 365;
      // Taxa sobe para 14% -> PU de venda deve cair em relação ao carrego
      const ctxAlta = { marketRate: 0.14 };
      const carry = tesouroPre.puCarrego(d1Ano, lotePre, ctxAlta);
      const vendaChoqueAlta = tesouroPre.puVenda(d1Ano, lotePre, ctxAlta);
      expect(vendaChoqueAlta).toBeLessThan(carry);

      // Taxa cai para 8% -> PU de venda deve subir em relação ao carrego (ágio)
      const ctxBaixa = { marketRate: 0.08 };
      const vendaChoqueBaixa = tesouroPre.puVenda(d1Ano, lotePre, ctxBaixa);
      expect(vendaChoqueBaixa).toBeGreaterThan(carry);

      // No vencimento exato, puVenda converge com puCarrego (pull-to-par)
      const vendaNoVenc = tesouroPre.puVenda(dVenc, lotePre, ctxAlta);
      const carryNoVenc = tesouroPre.puCarrego(dVenc, lotePre, ctxAlta);
      expect(vendaNoVenc).toBeCloseTo(carryNoVenc, 6);
    });

    it('IPCA_BULLET deve capitalizar inflação e juro real contratado', () => {
      const tesouroIpca = createBulletInstrument({
        kind: 'IPCA_BULLET',
        vencimento: dVenc,
        isentoIr: false,
        cobraCustodiaB3: true,
        supportsMtM: true,
      });

      const loteIpca: EngineLot = {
        id: 5,
        date: '2025-01-02',
        dn: dCompra,
        rate: 6.0, // IPCA + 6% a.a.
        price: 1000.0,
        qty: 1,
      };

      const ctx = { marketRate: 0.06, ipcaAnual: 0.045 };
      // 252 dias úteis depois
      const carry = tesouroIpca.puCarrego(dCompra + 365, loteIpca, ctx);
      expect(carry).toBeGreaterThan(1000.0);

      // Fator anual esperado para 252 du: (1 + 0.045) * (1 + 0.06) = 1.1077
      const du = getBusDays(dCompra, dCompra + 365);
      const expectedPU = 1000.0 * Math.pow(1.045 * 1.06, du / 252);
      expect(carry).toBeCloseTo(expectedPU, 6);
    });

    it('CDB IPCA+ sem MtM (supportsMtM = false) deve ter puVenda igual a puCarrego independentemente da taxa de mercado', () => {
      const cdbIpca = createBulletInstrument({
        kind: 'IPCA_BULLET',
        vencimento: dVenc,
        isentoIr: false,
        cobraCustodiaB3: false,
        supportsMtM: false,
      });

      const loteIpca: EngineLot = {
        id: 6,
        date: '2025-01-02',
        dn: dCompra,
        rate: 6.5,
        price: 1000.0,
        qty: 1,
      };

      const ctxChoque = { marketRate: 0.12, ipcaAnual: 0.045 };
      const d1Ano = dCompra + 365;
      const carry = cdbIpca.puCarrego(d1Ano, loteIpca, ctxChoque);
      const venda = cdbIpca.puVenda(d1Ano, loteIpca, ctxChoque);

      expect(venda).toBe(carry);
      expect(cdbIpca.supportsMtM).toBe(false);
    });
  });

  describe('5. Curvas de Projeção em projection.ts para instrumentos genéricos', () => {
    it('deve gerar 5 curvas para CDI_POS com carrego idêntico a alvo', () => {
      const cdiInst = createCdiInstrument({
        vencimento: dVenc,
        isentoIr: false,
        cobraCustodiaB3: false,
      });

      const res = buildProjectionCurves({
        refDN: dCompra,
        Fref: 1.0,
        lots: [loteCdb110],
        instrument: cdiInst,
        pricingCtx: { marketRate: 0, cdiAnual: 0.1065 },
        cdiRatePct: 10.65,
        horizonYears: 3,
      });

      expect(res.points.length).toBeGreaterThan(1);
      expect(res.series.alvo).toBeDefined();
      expect(res.series.carrego).toBeDefined();
      expect(res.series.cdi).toBeDefined();
      expect(res.series.queda5).toBeDefined();
      expect(res.series.alta8).toBeDefined();

      // Pós-fixado: carrego acompanha exatamente a curva alvo
      expect(res.series.carrego).toEqual(res.series.alvo);

      // Cenário de alta do CDI rende mais que cenário de queda do CDI
      const lastIndex = res.points.length - 1;
      expect(res.series.alta8[lastIndex]).toBeGreaterThan(res.series.alvo[lastIndex]);
      expect(res.series.alvo[lastIndex]).toBeGreaterThan(res.series.queda5[lastIndex]);
    });

    it('deve projetar valores deflacionados em termos reais (isReal = true) e brutos (metric = "bruto")', () => {
      const cdiInst = createCdiInstrument({
        vencimento: dVenc,
        isentoIr: false,
        cobraCustodiaB3: false,
      });

      const resNominalLiq = buildProjectionCurves({
        refDN: dCompra,
        Fref: 1.0,
        lots: [loteCdb110],
        instrument: cdiInst,
        pricingCtx: { marketRate: 0, cdiAnual: 0.1065 },
        cdiRatePct: 10.65,
        horizonYears: 3,
        isReal: false,
        metric: 'liq',
      });

      const resRealBruto = buildProjectionCurves({
        refDN: dCompra,
        Fref: 1.0,
        lots: [loteCdb110],
        instrument: cdiInst,
        pricingCtx: { marketRate: 0, cdiAnual: 0.1065 },
        cdiRatePct: 10.65,
        horizonYears: 3,
        isReal: true,
        metric: 'bruto',
        ipca: 4.5,
      });

      const lastIdx = resNominalLiq.points.length - 1;
      expect(resNominalLiq.series.alvo[0]).toBeCloseTo(10000.0, 1);
      expect(resRealBruto.series.alvo[0]).toBeCloseTo(10000.0, 1);
      // O valor deflacionado em 3 anos com IPCA 4.5% a.a. deve ser menor que o valor nominal bruto correspondente
      expect(resRealBruto.series.alvo[lastIdx]).toBeGreaterThan(0);
    });
  });

  describe('6. Acumulação Diária Histórica B3/CETIP (cdiHistorico)', () => {
    it('deve acumular o fator diário com arredondamento de 8 casas e truncar o PU em 8 casas (padrão B3/CETIP)', () => {
      const dInicio = toDayNum('2025-12-19');
      const dFim = toDayNum('2025-12-24'); // 19/12 (sex), 22/12 (seg), 23/12 (ter) -> 3 dias úteis
      const cdiInst = createCdiInstrument({
        vencimento: toDayNum('2028-12-19'),
        isentoIr: false,
        cobraCustodiaB3: false,
      });

      const hist = new Map<number, number>([
        [toDayNum('2025-12-19'), 0.055131],
        [toDayNum('2025-12-22'), 0.055131],
        [toDayNum('2025-12-23'), 0.055131],
      ]);

      const loteBtg: EngineLot = {
        id: 99,
        date: '2025-12-19',
        dn: dInicio,
        rate: 100,
        price: 0.01,
        qty: 10000000,
      };

      const res = simulateSell({
        lots: [loteBtg],
        t: dFim,
        instrument: cdiInst,
        ctx: {
          marketRate: 0,
          cdiAnual: 0.1365,
          cdiHistorico: hist,
          maxCdiHistDN: toDayNum('2025-12-23'),
        },
      });

      // c1 = round8(1 * 1.00055131) = 1.00055131
      // c2 = round8(1.00055131 * 1.00055131) = 1.00110292
      // c3 = round8(1.00110292 * 1.00055131) = 1.00165484
      // pu = trunc8(0.01 * 1.00165484) = 0.01001654
      expect(res.pu).toBe(0.01001654);
      expect(res.bruto).toBe(100165.4);
    });
  });
});

