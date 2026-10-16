import { Injectable, computed, inject, signal, effect } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  AllocationSlice,
  AtivoRendaFixa,
  AtivoRendaFixaUpdateDto,
  CadastroManualRendaFixaDto,
  CotacaoTesouroResponse,
  DetalhesRendaFixa,
  EnvelopeMercado,
  LoteAbertoDto,
  LoteComAtivoDto,
  LoteManualCreateDto,
  LoteManualUpdateDto,
  MacroResponse,
  MercadoSnapshot,
  ModalMode,
  PosicaoRendaFixa,
  Premissas,
  ProjectionSeries,
  SimInputs,
  isLot,
  toEngineLot,
} from '../../../core/models/renda-fixa.models';

export const ATIVO_STORAGE_KEY = 'il.rendafixa.ativo_selecionado.v1';
import { RendaFixaApiService } from '../../../core/services/renda-fixa-api.service';
import {
  AnnuitySchedule,
  FixedIncomeInstrument,
  PricingContext,
  RENDA_MAIS_2065,
  addYearsDN,
  buildProjectionCurves,
  calcBreakevenRate,
  calcModifiedDuration,
  calcRateAtSale,
  calcRealReturn,
  calcReturnPct,
  calcSensitivityTable,
  calcXIRR,
  calibrateModel,
  createAnnuitySchedule,
  createBulletInstrument,
  createCdiInstrument,
  createRendaMaisInstrument,
  decomposeCarryAndMtM,
  generateRateTrajectory,
  getVNAFactor,
  simulateSell,
  simulateSellPEPS,
  toDayNum,
  trunc2,
} from '../../../core/financial-engine';
import { RatePoint, SensitivityRow, SellResult, SellPart } from '../../../core/financial-engine/types';
import {
  loadPremissas,
  savePremissas,
  sanitizePremissas,
} from './premissas.persistence';

export function scheduleFor(detalhes?: DetalhesRendaFixa | null): AnnuitySchedule {
  if (detalhes?.ano_conversao && detalhes.ano_conversao > 0) {
    return createAnnuitySchedule(
      detalhes.ano_conversao,
      detalhes.num_parcelas || 240,
      detalhes.dia_pagamento || 15
    );
  }
  return RENDA_MAIS_2065;
}

export function instrumentFor(
  detalhes: DetalhesRendaFixa | null | undefined,
  premissas: Premissas
): FixedIncomeInstrument {
  const schedule = scheduleFor(detalhes);
  if (
    !detalhes ||
    detalhes.produto === 'TESOURO_RENDA_MAIS' ||
    detalhes.produto === 'TESOURO_EDUCA_MAIS'
  ) {
    return createRendaMaisInstrument(schedule, premissas.custody);
  }

  const vencDN = detalhes.data_vencimento
    ? toDayNum(detalhes.data_vencimento)
    : addYearsDN(toDayNum(premissas.refDate), 3);

  const isentoIr = Boolean(detalhes.isento_ir);
  const cobraCustodiaB3 = Boolean(detalhes.cobra_custodia_b3);

  if (detalhes.indexador === 'CDI' || detalhes.indexador === 'SELIC') {
    const kind = detalhes.indexador === 'SELIC' ? 'SELIC_POS' : 'CDI_POS';
    return createCdiInstrument({
      kind,
      vencimento: vencDN,
      isentoIr,
      cobraCustodiaB3,
      custodyConfig: premissas.custody,
      defaultPctCdi: Number(detalhes.percentual_indexador) || 100,
    });
  }

  return createBulletInstrument({
    kind: detalhes.indexador === 'IPCA' ? 'IPCA_BULLET' : 'PREFIXADO',
    vencimento: vencDN,
    isentoIr,
    cobraCustodiaB3,
    supportsMtM: detalhes.produto.startsWith('TESOURO_'),
    custodyConfig: premissas.custody,
  });
}

@Injectable({
  providedIn: 'root',
})
export class RendaFixaStore {
  private readonly api = inject(RendaFixaApiService);
  private reqSeq = 0;

  // ---------- Estado de Entrada (Writable Signals) ----------
  readonly carteiraId = signal<number>(1);
  readonly ativoId = signal<number | null>(null);
  readonly ativos = signal<AtivoRendaFixa[]>([]);
  readonly posicao = signal<PosicaoRendaFixa | null>(null);
  readonly todasPosicoes = signal<PosicaoRendaFixa[]>([]);
  readonly mercadoTesouro = signal<EnvelopeMercado<CotacaoTesouroResponse> | null>(null);
  readonly mercadoMacro = signal<MacroResponse | null>(null);
  readonly premissas = signal<Premissas>(loadPremissas());
  readonly sim = signal<SimInputs>({
    simYears: 1.0,
    simDN: 0,
    targetRatePct: 6.55,
    convMonths: 24,
    spread: 0,
    qtyToSell: '',
  });
  readonly projView = signal<{ metric: 'liq' | 'bruto'; base: 'nominal' | 'real' }>({
    metric: 'liq',
    base: 'nominal',
  });
  readonly activeTab = signal<
    'posicao' | 'simulador' | 'projecao' | 'sensibilidade' | 'premissas'
  >('posicao');
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly syncStatus = signal<string | null>(null);
  readonly modalState = signal<{
    open: boolean;
    mode: ModalMode;
    lote?: LoteAbertoDto | null;
    ativo?: AtivoRendaFixa | null;
  }>({
    open: false,
    mode: 'NOVO_TITULO',
    lote: null,
    ativo: null,
  });


  // ---------- Derivados (Computed Signals) ----------
  readonly isCarteiraCompleta = computed<boolean>(() => this.ativoId() === 0);

  readonly totalTitulos = computed<number>(() => this.todasPosicoes().length);

  readonly totalLotesAtivos = computed<number>(() =>
    this.todasPosicoes().reduce(
      (acc, p) => acc + (p.lotes?.filter((l) => Number(l.quantidade_aberta) > 0).length || 0),
      0
    )
  );

  readonly mercado = computed<MercadoSnapshot | null>(() => {
    const tesouro = this.mercadoTesouro();
    const macro = this.mercadoMacro();
    if (!tesouro && !macro) return null;
    return { tesouro, macro };
  });

  readonly lots = computed(() =>
    (this.posicao()?.lotes ?? []).map(toEngineLot).filter(isLot)
  );

  readonly pendencias = computed(() => {
    if (this.isCarteiraCompleta()) {
      const all: string[] = [];
      for (const p of this.todasPosicoes()) {
        if (p.pendencias && p.pendencias.length > 0) {
          all.push(...p.pendencias);
        }
      }
      return all;
    }
    return this.posicao()?.pendencias ?? [];
  });

  readonly lotesPendentes = computed<LoteComAtivoDto[]>(() => {
    const result: LoteComAtivoDto[] = [];
    const posicoes = this.isCarteiraCompleta()
      ? this.todasPosicoes()
      : (this.posicao() ? [this.posicao()!] : []);

    for (const pos of posicoes) {
      for (const lote of pos.lotes ?? []) {
        if (
          lote.taxa_contratada === null ||
          lote.taxa_contratada === undefined ||
          lote.taxa_contratada === ''
        ) {
          result.push({
            ...lote,
            ativo: pos.ativo,
          });
        }
      }
    }
    return result;
  });

  readonly schedule = computed(() => scheduleFor(this.posicao()?.ativo?.detalhes_rf));

  readonly instrument = computed<FixedIncomeInstrument>(() =>
    instrumentFor(this.posicao()?.ativo?.detalhes_rf, this.premissas())
  );

  readonly maxSimDate = computed(() => {
    const inst = this.instrument();
    return inst.maxSimDate || this.schedule().maxSimDate;
  });

  readonly calib = computed(() => {
    const prem = this.premissas();
    return calibrateModel({
      refDate: prem.refDate,
      refPrice: prem.refPrice,
      refRate: prem.refRate,
      lots: this.lots(),
      ipcaCal: prem.ipcaCal,
      schedule: this.schedule(),
    });
  });

  readonly vnaHoje = computed(() => this.calib().Fref);

  readonly cdiHistoricoInfo = computed(() => {
    const hist = this.mercadoMacro()?.cdi?.historico_diario;
    const map = new Map<number, number>();
    let maxDN = 0;
    if (hist && hist.length > 0) {
      for (const pt of hist) {
        const dn = toDayNum(pt.data);
        const val = Number(pt.valor);
        if (!isNaN(dn) && !isNaN(val)) {
          map.set(dn, val);
          if (dn > maxDN) maxDN = dn;
        }
      }
    }
    return { map, maxDN };
  });

  readonly effectiveRefDN = computed(() => {
    const baseDN = this.calib().refDN;
    const inst = this.instrument();
    if (inst.kind === 'RENDA_MAIS' || inst.kind === 'EDUCA_MAIS') {
      return baseDN;
    }
    const maxLotDN = this.lots().reduce(
      (max, l) => Math.max(max, typeof l.dn === 'number' ? l.dn : toDayNum(l.date)),
      baseDN
    );
    const histMaxDN = this.cdiHistoricoInfo().maxDN;
    const refCandidate = histMaxDN > 0 ? Math.max(maxLotDN, histMaxDN + 1) : maxLotDN;
    return Math.min(refCandidate, this.maxSimDate());
  });

  readonly simDN = computed(() => {
    const s = this.sim();
    const dn =
      s.simDN && s.simDN > 0
        ? s.simDN
        : addYearsDN(this.effectiveRefDN(), s.simYears || 1.0);
    return Math.min(dn, this.maxSimDate());
  });

  readonly simDNClamped = computed(() =>
    Math.min(this.simDN(), this.maxSimDate())
  );

  readonly vnaSim = computed(() =>
    getVNAFactor(
      this.simDNClamped(),
      this.calib().refDN,
      this.calib().Fref,
      this.premissas().ipcaProj
    )
  );

  readonly pricingCtx = computed<PricingContext>(() => {
    const prem = this.premissas();
    const cdiDec = prem.cdiRatePct / 100;
    const ipcaDec = prem.ipcaProj / 100;
    const histInfo = this.cdiHistoricoInfo();

    return {
      marketRate: this.calib().rNow,
      refDN: this.effectiveRefDN(),
      vnaFactor: this.vnaHoje(),
      cdiAnual: cdiDec,
      selicAnual: cdiDec,
      ipcaAnual: ipcaDec,
      cdiHistorico: histInfo.map.size > 0 ? histInfo.map : undefined,
      maxCdiHistDN: histInfo.maxDN > 0 ? histInfo.maxDN : undefined,
    };
  });

  readonly rateAtSale = computed(() =>
    calcRateAtSale({
      refDN: this.calib().refDN,
      simDN: this.simDNClamped(),
      rNow: this.calib().rNow,
      targetRatePct: this.sim().targetRatePct,
      convMonths: this.sim().convMonths,
      spread: this.sim().spread,
    })
  );

  readonly todasPosicoesSimuladas = computed(() => {
    const posicoes = this.todasPosicoes();
    const prem = this.premissas();
    const cdiHist = this.cdiHistoricoInfo();

    return posicoes.map((pos) => {
      const inst = instrumentFor(pos.ativo?.detalhes_rf, prem);
      const schedule = scheduleFor(pos.ativo?.detalhes_rf);
      const lots = (pos.lotes ?? []).map(toEngineLot).filter(isLot);

      if (lots.length === 0) {
        return {
          pos,
          inst,
          res: {
            parts: [] as SellPart[],
            pu: 0,
            q: 0,
            bruto: 0,
            custo: 0,
            cust: 0,
            iof: 0,
            ir: 0,
            irApp: 0,
            liqReal: 0,
            liqApp: 0,
          },
        };
      }

      let t: number;
      if (inst.kind === 'RENDA_MAIS' || inst.kind === 'EDUCA_MAIS') {
        t = this.calib().refDN;
      } else {
        const maxLotDN = lots.reduce(
          (max, l) => Math.max(max, typeof l.dn === 'number' ? l.dn : toDayNum(l.date)),
          this.calib().refDN
        );
        const histMaxDN = cdiHist.maxDN;
        const refCandidate = histMaxDN > 0 ? Math.max(maxLotDN, histMaxDN + 1) : maxLotDN;
        const maxSimDate = inst.maxSimDate || schedule.maxSimDate;
        t = Math.min(refCandidate, maxSimDate);
      }

      const ctx: PricingContext = {
        ...this.pricingCtx(),
        refDN: t,
      };

      const isSelectedBond = pos.ativo?.ticker === prem.selectedBond;
      const overridePU =
        (inst.kind === 'RENDA_MAIS' || inst.kind === 'EDUCA_MAIS') &&
        isSelectedBond &&
        this.calib().pNow > 0
          ? this.calib().pNow
          : null;

      const res =
        (inst.kind === 'RENDA_MAIS' || inst.kind === 'EDUCA_MAIS') && overridePU
          ? simulateSellPEPS({
              lots,
              t,
              r: this.calib().rNow,
              vnaFactor: this.vnaHoje(),
              overridePU,
              custodyConfig: prem.custody,
            })
          : simulateSell({
              lots,
              t,
              instrument: inst,
              ctx,
            });

      return {
        pos,
        inst,
        res,
      };
    });
  });

  readonly vendaHojeConsolidada = computed<SellResult>(() => {
    const simList = this.todasPosicoesSimuladas();
    const allParts: (SellPart & { ativo?: AtivoRendaFixa; instrument?: FixedIncomeInstrument })[] = [];
    let q = 0;
    let bruto = 0;
    let custo = 0;
    let cust = 0;
    let iof = 0;
    let ir = 0;
    let irApp = 0;
    let liqReal = 0;
    let liqApp = 0;

    for (const item of simList) {
      for (const part of item.res.parts) {
        allParts.push({
          ...part,
          ativo: item.pos.ativo,
          instrument: item.inst,
        });
      }
      q += item.res.q;
      bruto += item.res.bruto;
      custo += item.res.custo;
      cust += item.res.cust;
      iof += item.res.iof;
      ir += item.res.ir;
      irApp += item.res.irApp;
      liqReal += item.res.liqReal;
      liqApp += item.res.liqApp;
    }

    allParts.sort((a, b) => {
      const adn = typeof a.lot.dn === 'number' ? a.lot.dn : toDayNum(a.lot.date);
      const bdn = typeof b.lot.dn === 'number' ? b.lot.dn : toDayNum(b.lot.date);
      return adn - bdn;
    });

    return {
      parts: allParts,
      pu: 0,
      q,
      bruto,
      custo,
      cust,
      iof,
      ir,
      irApp,
      liqReal,
      liqApp,
    };
  });

  readonly vendaHoje = computed<SellResult>(() => {
    if (this.isCarteiraCompleta()) {
      return this.vendaHojeConsolidada();
    }
    const inst = this.instrument();
    if (inst.kind === 'RENDA_MAIS' || inst.kind === 'EDUCA_MAIS') {
      return simulateSellPEPS({
        lots: this.lots(),
        t: this.calib().refDN,
        r: this.calib().rNow,
        vnaFactor: this.vnaHoje(),
        overridePU: this.calib().pNow,
        custodyConfig: this.premissas().custody,
      });
    }
    return simulateSell({
      lots: this.lots(),
      t: this.effectiveRefDN(),
      instrument: inst,
      ctx: this.pricingCtx(),
    });
  });

  readonly vendaSim = computed(() => {
    const num = Number(this.sim().qtyToSell);
    const qty = !isNaN(num) && num > 0 ? num : undefined;
    const inst = this.instrument();
    if (inst.kind === 'RENDA_MAIS' || inst.kind === 'EDUCA_MAIS') {
      return simulateSellPEPS({
        lots: this.lots(),
        t: this.simDNClamped(),
        r: this.rateAtSale(),
        vnaFactor: this.vnaSim(),
        qtyToSell: qty,
        custodyConfig: this.premissas().custody,
      });
    }
    const ctx: PricingContext = {
      ...this.pricingCtx(),
      marketRate: this.rateAtSale(),
      vnaFactor: this.vnaSim(),
    };
    return simulateSell({
      lots: this.lots(),
      t: this.simDNClamped(),
      instrument: inst,
      ctx,
      qtyToSell: qty,
    });
  });

  readonly nowResForSoldQty = computed(() => {
    const num = Number(this.sim().qtyToSell);
    const qty = !isNaN(num) && num > 0 ? num : undefined;
    const inst = this.instrument();
    if (inst.kind === 'RENDA_MAIS' || inst.kind === 'EDUCA_MAIS') {
      return simulateSellPEPS({
        lots: this.lots(),
        t: this.calib().refDN,
        r: this.calib().rNow,
        vnaFactor: this.vnaHoje(),
        qtyToSell: qty,
        overridePU: this.calib().pNow,
        custodyConfig: this.premissas().custody,
      });
    }
    return simulateSell({
      lots: this.lots(),
      t: this.effectiveRefDN(),
      instrument: inst,
      ctx: this.pricingCtx(),
      qtyToSell: qty,
    });
  });

  readonly decomposicao = computed(() => {
    const inst = this.instrument();
    const ctx: PricingContext = {
      ...this.pricingCtx(),
      marketRate: this.rateAtSale(),
      vnaFactor: this.vnaSim(),
    };
    return decomposeCarryAndMtM({
      simRes: this.vendaSim(),
      simDN: this.simDNClamped(),
      vnaFactor: this.vnaSim(),
      instrument: inst,
      ctx,
    });
  });

  readonly posLucroReal = computed(() => this.vendaHoje().liqReal - this.vendaHoje().custo);
  readonly posLucroApp = computed(() => this.vendaHoje().liqApp - this.vendaHoje().custo);
  readonly posReturnPctReal = computed(() =>
    calcReturnPct(this.vendaHoje().liqReal, this.vendaHoje().custo)
  );
  readonly posReturnPctApp = computed(() =>
    calcReturnPct(this.vendaHoje().liqApp, this.vendaHoje().custo)
  );
  readonly posRealReturnPct = computed(() =>
    this.vendaHoje().custo > 0
      ? calcRealReturn(this.posReturnPctApp(), this.premissas().ipcaCal / 100)
      : 0
  );

  readonly posAvgRate = computed(() => {
    const v = this.vendaHoje();
    return v.q > 0
      ? v.parts.reduce((acc, p) => acc + p.lot.rate * p.q, 0) / v.q
      : 0;
  });

  readonly posTIRConsolidada = computed<number>(() => {
    const simList = this.todasPosicoesSimuladas();
    if (simList.length === 0) return 0;
    const flows: { dn: number; amount: number }[] = [];

    for (const item of simList) {
      const lots = (item.pos.lotes ?? []).map(toEngineLot).filter(isLot);
      for (const l of lots) {
        flows.push({
          dn: typeof l.dn === 'number' ? l.dn : toDayNum(l.date),
          amount: -trunc2(l.qty * l.price),
        });
      }
      for (const f of item.pos.fluxos_recebidos ?? []) {
        if (f.tipo === 'SELL') continue;
        flows.push({ dn: toDayNum(f.data), amount: Number(f.valor_brl) });
      }
    }

    if (flows.length === 0) return 0;
    const maxFlowDN = flows.reduce((max, f) => Math.max(max, f.dn), this.calib().refDN);
    const evalDN = Math.max(this.calib().refDN, maxFlowDN, this.cdiHistoricoInfo().maxDN + 1);
    flows.push({ dn: evalDN, amount: this.vendaHojeConsolidada().liqReal });
    flows.sort((a, b) => a.dn - b.dn);
    return calcXIRR(flows);
  });

  readonly posTIR = computed(() => {
    if (this.isCarteiraCompleta()) {
      return this.posTIRConsolidada();
    }
    const lots = this.lots();
    if (lots.length === 0) return 0;
    const flows = lots.map((l) => ({
      dn: typeof l.dn === 'number' ? l.dn : toDayNum(l.date),
      amount: -trunc2(l.qty * l.price),
    }));
    for (const f of this.posicao()?.fluxos_recebidos ?? []) {
      if (f.tipo === 'SELL') continue;
      flows.push({ dn: toDayNum(f.data), amount: Number(f.valor_brl) });
    }
    flows.push({ dn: this.effectiveRefDN(), amount: this.vendaHoje().liqReal });
    return calcXIRR(flows);
  });

  readonly simLucroLiq = computed(() => this.vendaSim().liqReal - this.vendaSim().custo);
  readonly simReturnPct = computed(() =>
    calcReturnPct(this.vendaSim().liqReal, this.vendaSim().custo)
  );
  readonly simDiffHoje = computed(
    () => this.vendaSim().liqReal - this.nowResForSoldQty().liqReal
  );

  readonly simLiqDeflacionado = computed(() => {
    const deflator = getVNAFactor(
      this.simDNClamped(),
      this.calib().refDN,
      1.0,
      this.premissas().ipcaProj
    );
    return deflator > 0 ? this.vendaSim().liqReal / deflator : this.vendaSim().liqReal;
  });

  readonly simTIR = computed(() => {
    const parts = this.vendaSim().parts;
    if (parts.length === 0) return 0;
    const flows = parts.map((p) => ({
      dn: typeof p.lot.dn === 'number' ? p.lot.dn : toDayNum(p.lot.date),
      amount: -trunc2(p.q * p.lot.price),
    }));
    for (const f of this.posicao()?.fluxos_recebidos ?? []) {
      if (f.tipo === 'SELL') continue;
      flows.push({ dn: toDayNum(f.data), amount: Number(f.valor_brl) });
    }
    flows.push({ dn: this.simDNClamped(), amount: this.vendaSim().liqReal });
    return calcXIRR(flows);
  });

  readonly duration = computed(() =>
    calcModifiedDuration(this.calib().refDN, this.calib().rNow, 1e-4, this.schedule())
  );

  readonly breakeven = computed(() =>
    calcBreakevenRate({
      lots: this.lots(),
      simDN: this.simDNClamped(),
      vnaFactor: this.vnaSim(),
      custodyConfig: this.premissas().custody,
    })
  );

  readonly trajetoria = computed<RatePoint[]>(() => {
    const horizon = Math.max(
      this.sim().convMonths + 12,
      Math.ceil(this.sim().simYears * 12) + 6,
      24
    );
    return generateRateTrajectory({
      rNow: this.calib().rNow,
      targetRatePct: this.sim().targetRatePct,
      convMonths: this.sim().convMonths,
      spread: this.sim().spread,
      horizonMonths: horizon,
      stepMonths: 2,
    });
  });

  readonly projecao = computed<ProjectionSeries>(() => {
    const v = this.projView();
    const p = this.premissas();
    const c = this.calib();

    if (this.isCarteiraCompleta()) {
      const simList = this.todasPosicoesSimuladas();
      if (simList.length === 0) {
        return {
          labels: ['Hoje'],
          series: { alvo: [0], carrego: [0], cdi: [0], queda5: [0], alta8: [0] },
        };
      }

      let labels: string[] = [];
      let alvoSum: number[] = [];
      let carregoSum: number[] = [];
      let cdiSum: number[] = [];
      let queda5Sum: number[] = [];
      let alta8Sum: number[] = [];

      for (const item of simList) {
        const lots = (item.pos.lotes ?? []).map(toEngineLot).filter(isLot);
        if (lots.length === 0) continue;

        const inst = item.inst;
        const schedule = scheduleFor(item.pos.ativo?.detalhes_rf);
        const maxSimDate = inst.maxSimDate || schedule.maxSimDate;

        const posTodayVal = v.metric === 'bruto' ? item.res.bruto : item.res.liqReal;

        const ctx: PricingContext = {
          ...this.pricingCtx(),
          refDN: this.calib().refDN,
        };

        const res = buildProjectionCurves({
          refDN: this.calib().refDN,
          Fref: c.Fref,
          lots,
          custodyConfig: p.custody,
          horizonYears: 10,
          isReal: v.base === 'real',
          metric: v.metric,
          ipca: p.ipcaProj,
          targetRatePct: this.sim().targetRatePct,
          cdiRatePct: p.cdiRatePct,
          posLiqToday: posTodayVal,
          maxSimDate,
          instrument: inst,
          pricingCtx: ctx,
        });

        if (labels.length === 0) {
          labels = res.labels;
          alvoSum = [...res.series.alvo];
          carregoSum = [...res.series.carrego];
          cdiSum = [...res.series.cdi];
          queda5Sum = [...res.series.queda5];
          alta8Sum = [...res.series.alta8];
        } else {
          for (let i = 0; i < labels.length; i++) {
            alvoSum[i] = (alvoSum[i] || 0) + (res.series.alvo[i] || 0);
            carregoSum[i] = (carregoSum[i] || 0) + (res.series.carrego[i] || 0);
            cdiSum[i] = (cdiSum[i] || 0) + (res.series.cdi[i] || 0);
            queda5Sum[i] = (queda5Sum[i] || 0) + (res.series.queda5[i] || 0);
            alta8Sum[i] = (alta8Sum[i] || 0) + (res.series.alta8[i] || 0);
          }
        }
      }

      if (labels.length === 0) {
        labels = ['Hoje'];
        alvoSum = [0];
        carregoSum = [0];
        cdiSum = [0];
        queda5Sum = [0];
        alta8Sum = [0];
      }

      return {
        labels,
        series: {
          alvo: alvoSum,
          carrego: carregoSum,
          cdi: cdiSum,
          queda5: queda5Sum,
          alta8: alta8Sum,
        },
      };
    }

    const inst = this.instrument();
    const res = buildProjectionCurves({
      refDN: this.effectiveRefDN(),
      Fref: c.Fref,
      lots: this.lots(),
      custodyConfig: p.custody,
      horizonYears: 10,
      isReal: v.base === 'real',
      metric: v.metric,
      ipca: p.ipcaProj,
      targetRatePct: this.sim().targetRatePct,
      cdiRatePct: p.cdiRatePct,
      posLiqToday: v.metric === 'bruto' ? this.vendaHoje().bruto : this.vendaHoje().liqReal,
      maxSimDate: this.maxSimDate(),
      instrument: inst,
      pricingCtx: this.pricingCtx(),
    });
    return {
      labels: res.labels,
      series: res.series,
    };
  });

  readonly sensibilidade = computed<SensitivityRow[]>(() => {
    const inst = this.instrument();
    if (inst.kind === 'RENDA_MAIS' || inst.kind === 'EDUCA_MAIS') {
      return calcSensitivityTable({
        refDN: this.calib().refDN,
        rNow: this.calib().rNow,
        pNow: this.calib().pNow,
        vnaFactor: this.vnaHoje(),
        lots: this.lots(),
        custodyConfig: this.premissas().custody,
      });
    }

    if (inst.supportsMtM) {
      const baseRateDec =
        this.posAvgRate() > 0 ? this.posAvgRate() / 100 : this.calib().rNow;
      const baseCtx: PricingContext = { ...this.pricingCtx(), marketRate: baseRateDec };
      const baseRes = simulateSell({
        lots: this.lots(),
        t: this.effectiveRefDN(),
        instrument: inst,
        ctx: baseCtx,
      });
      const shocks = [-2.0, -1.5, -1.0, -0.5, 0.5, 1.0, 1.5, 2.0];
      return shocks.map((s) => {
        const newRate = Math.max(0.005, baseRateDec + s / 100);
        const shockRes = simulateSell({
          lots: this.lots(),
          t: this.effectiveRefDN(),
          instrument: inst,
          ctx: { ...baseCtx, marketRate: newRate },
        });
        return {
          shock: s,
          newRate,
          newPU: shockRes.pu,
          bruto: shockRes.bruto,
          brutoDiff: shockRes.bruto - baseRes.bruto,
          liqApp: shockRes.liqApp,
          liqDiff: shockRes.liqApp - baseRes.liqApp,
          puVarPct: baseRes.pu > 0 ? (shockRes.pu - baseRes.pu) / baseRes.pu : 0,
          liqReturnPct: calcReturnPct(shockRes.liqApp, shockRes.custo),
        };
      });
    }

    const baseCdiPct = this.premissas().cdiRatePct;
    const baseCdiDec = baseCdiPct / 100;
    const baseCtx: PricingContext = {
      ...this.pricingCtx(),
      cdiAnual: baseCdiDec,
      selicAnual: baseCdiDec,
    };
    const baseRes = simulateSell({
      lots: this.lots(),
      t: this.maxSimDate(),
      instrument: inst,
      ctx: baseCtx,
    });

    const shocks = [-3.0, -2.0, -1.0, -0.5, 0.5, 1.0, 2.0, 3.0];
    return shocks.map((s) => {
      const shockedCdiPct = Math.max(0.5, baseCdiPct + s);
      const shockedCdiDec = shockedCdiPct / 100;
      const shockCtx: PricingContext = {
        ...this.pricingCtx(),
        cdiAnual: shockedCdiDec,
        selicAnual: shockedCdiDec,
      };
      const shockRes = simulateSell({
        lots: this.lots(),
        t: this.maxSimDate(),
        instrument: inst,
        ctx: shockCtx,
      });

      const brutoDiff = shockRes.bruto - baseRes.bruto;
      const liqDiff = shockRes.liqApp - baseRes.liqApp;
      const puVarPct = baseRes.pu > 0 ? (shockRes.pu - baseRes.pu) / baseRes.pu : 0;
      const liqReturnPct = calcReturnPct(shockRes.liqApp, shockRes.custo);

      return {
        shock: s,
        newRate: shockedCdiDec,
        newPU: shockRes.pu,
        bruto: shockRes.bruto,
        brutoDiff,
        liqApp: shockRes.liqApp,
        liqDiff,
        puVarPct,
        liqReturnPct,
      };
    });
  });

  readonly alocacaoTitulo = computed<AllocationSlice[]>(() => {
    const simList = this.todasPosicoesSimuladas();
    if (simList.length === 0) {
      return [{ label: 'Sem Ativos', value: 1, pct: 1 }];
    }

    const items = simList
      .map((item) => {
        const label = item.pos.ativo.ticker || item.pos.ativo.nome;
        const val = item.res.liqApp > 0 ? item.res.liqApp : (Number(item.pos.custo_total_brl) || 0);
        return { label, value: val };
      })
      .filter((it) => it.value > 0);

    const total = items.reduce((acc, it) => acc + it.value, 0);
    if (total <= 0) {
      return [{ label: 'Sem Ativos', value: 1, pct: 1 }];
    }

    return items.map((it) => ({
      label: it.label,
      value: it.value,
      pct: it.value / total,
    }));
  });

  readonly alocacaoIndexador = computed<AllocationSlice[]>(() => {
    const posicoes = this.todasPosicoes();
    let ipcaSum = 0;
    let cdiSum = 0;
    let selicSum = 0;
    let preSum = 0;

    if (posicoes.length > 0) {
      const simList = this.todasPosicoesSimuladas();
      for (const item of simList) {
        const idx = (item.pos.ativo?.detalhes_rf?.indexador || 'IPCA').toUpperCase();
        const prod = (item.pos.ativo?.detalhes_rf?.produto || '').toUpperCase();
        const val = item.res.liqApp > 0 ? item.res.liqApp : (Number(item.pos.custo_total_brl) || 0);

        if (idx.includes('SELIC') || prod.includes('SELIC')) {
          selicSum += val;
        } else if (idx.includes('CDI') || prod === 'CDB' || prod === 'LCI' || prod === 'LCA' || prod === 'LC') {
          cdiSum += val;
        } else if (idx.includes('PRE') || prod.includes('PREFIXADO')) {
          preSum += val;
        } else {
          ipcaSum += val;
        }
      }
    } else {
      const v = this.vendaHoje();
      const idx = (this.posicao()?.ativo?.detalhes_rf?.indexador || 'IPCA').toUpperCase();
      const prod = (this.posicao()?.ativo?.detalhes_rf?.produto || '').toUpperCase();
      const val = Math.max(0, v.liqApp);
      if (idx.includes('SELIC') || prod.includes('SELIC')) {
        selicSum = val;
      } else if (idx.includes('CDI') || prod === 'CDB' || prod === 'LCI' || prod === 'LCA' || prod === 'LC') {
        cdiSum = val;
      } else if (idx.includes('PRE') || prod.includes('PREFIXADO')) {
        preSum = val;
      } else {
        ipcaSum = val;
      }
    }

    const total = ipcaSum + cdiSum + selicSum + preSum;
    if (total <= 0) {
      return [{ label: 'Sem Ativos', value: 1, pct: 1 }];
    }
    const slices: AllocationSlice[] = [];
    if (ipcaSum > 0) slices.push({ label: 'IPCA+ / RendA+', value: ipcaSum, pct: ipcaSum / total });
    if (cdiSum > 0) slices.push({ label: 'Pós-Fixado CDI', value: cdiSum, pct: cdiSum / total });
    if (selicSum > 0) slices.push({ label: 'Tesouro Selic', value: selicSum, pct: selicSum / total });
    if (preSum > 0) slices.push({ label: 'Prefixado', value: preSum, pct: preSum / total });

    return slices.length > 0 ? slices : [{ label: 'Sem Ativos', value: 1, pct: 1 }];
  });

  readonly alocacaoLotes = computed<AllocationSlice[]>(() => {
    const v = this.vendaHoje();
    const parts = v.parts || [];
    const total = v.liqApp > 0 ? v.liqApp : 0;
    if (parts.length === 0 || total === 0) {
      return [{ label: 'Sem Ativos', value: 1, pct: 1 }];
    }
    return parts.map((p: any, i) => {
      const val = Math.max(0, p.liqApp);
      const assetLabel = this.isCarteiraCompleta() && (p.ativo?.ticker || p.ativo?.nome) ? `${p.ativo.ticker || p.ativo.nome} · ` : '';
      return {
        label: `Lote ${i + 1} (${assetLabel}${p.lot.date})`,
        value: val,
        pct: total > 0 ? val / total : 0,
      };
    });
  });

  constructor() {
    effect(() => {
      savePremissas(this.premissas());
    });
    effect(() => {
      const atId = this.ativoId();
      if (atId !== null) {
        try {
          localStorage.setItem(ATIVO_STORAGE_KEY, String(atId));
        } catch (_) {}
      }
    });
  }

  // ---------- Ações ----------
  async carregar(): Promise<void> {
    const seq = ++this.reqSeq;
    this.loading.set(true);
    this.error.set(null);

    try {
      // 1. Carrega ativos de renda fixa
      const ativos = await firstValueFrom(this.api.listarAtivos());
      if (seq !== this.reqSeq) return;
      this.ativos.set(ativos);

      if (this.ativoId() === null) {
        let savedAtivoId: number | null = null;
        try {
          const raw = localStorage.getItem(ATIVO_STORAGE_KEY);
          if (raw !== null && raw !== '') {
            const parsed = parseInt(raw, 10);
            if (!isNaN(parsed) && parsed >= 0) {
              savedAtivoId = parsed;
            }
          }
        } catch (_) {}

        if (savedAtivoId === 0) {
          this.ativoId.set(0);
        } else if (savedAtivoId !== null && ativos.some((a) => a.id === savedAtivoId)) {
          this.ativoId.set(savedAtivoId);
        } else if (ativos.length > 0) {
          const rendaMais = ativos.find(
            (a) =>
              a.ticker.includes('RENDA+') ||
              a.ticker.includes('2065') ||
              a.detalhes_rf?.produto === 'TESOURO_RENDA_MAIS'
          );
          this.ativoId.set(rendaMais ? rendaMais.id : ativos[0].id);
        }
      }

      // 2. Carrega lotes PEPS
      const lotesResp = await firstValueFrom(
        this.api.obterLotesPeps(
          this.carteiraId(),
          this.ativoId() === 0 ? undefined : (this.ativoId() ?? undefined)
        )
      );
      if (seq !== this.reqSeq) return;
      this.todasPosicoes.set(lotesResp.posicoes ?? []);

      if (this.ativoId() === 0) {
        this.posicao.set(null);
      } else if (lotesResp.posicoes && lotesResp.posicoes.length > 0) {
        const found = this.ativoId()
          ? lotesResp.posicoes.find((p) => p.ativo.id === this.ativoId()) ?? lotesResp.posicoes[0]
          : lotesResp.posicoes[0];
        this.posicao.set(found);
        if (this.ativoId() === null) {
          this.ativoId.set(found.ativo.id);
        }
      } else {
        this.posicao.set(null);
      }

      // 3. Carrega cotações e macro em paralelo
      try {
        const [tesouro, macro] = await Promise.all([
          firstValueFrom(this.api.obterMercadoTesouro(false)),
          firstValueFrom(this.api.obterMercadoMacro(false)),
        ]);
        if (seq !== this.reqSeq) return;
        this.mercadoTesouro.set(tesouro);
        this.mercadoMacro.set(macro);

        // Preenche refPrice e refRate a partir do bonds.json se vazios (§4.2)
        if (tesouro?.dados?.cotacoes) {
          const bond = tesouro.dados.cotacoes.find(
            (b) => b.symbol === this.premissas().selectedBond
          );
          if (bond) {
            const currentPrem = this.premissas();
            const shouldUpdatePrice = !currentPrem.refPrice || currentPrem.refPrice <= 0.01;
            const shouldUpdateRate =
              currentPrem.refRate === '' ||
              currentPrem.refRate === null ||
              currentPrem.refRate === undefined;
            if (shouldUpdatePrice || shouldUpdateRate) {
              this.premissas.update((p) => ({
                ...p,
                refPrice: shouldUpdatePrice && bond.sellPrice ? bond.sellPrice : p.refPrice,
                refRate: shouldUpdateRate && bond.sellRate ? bond.sellRate : p.refRate,
                refDate: bond.baseDate || p.refDate,
              }));
            }
          }
        }

        // Atualiza CDI da macro se presente
        if (macro?.cdi?.valor_anualizado_pct) {
          const cdiVal = Number(macro.cdi.valor_anualizado_pct);
          if (!isNaN(cdiVal) && cdiVal > 0) {
            this.premissas.update((p) => ({ ...p, cdiRatePct: cdiVal }));
          }
        }
      } catch (errMercado) {
        console.warn('Mercado offline ou indisponível:', errMercado);
      }
    } catch (err: any) {
      if (seq === this.reqSeq) {
        console.error('Erro ao carregar dados de renda fixa:', err);
        this.error.set(err?.message || 'Falha ao carregar dados de Renda Fixa');
      }
    } finally {
      if (seq === this.reqSeq) {
        this.loading.set(false);
      }
    }
  }

  async selecionarAtivo(ativoId: number): Promise<void> {
    const seq = ++this.reqSeq;
    this.ativoId.set(ativoId);
    try {
      localStorage.setItem(ATIVO_STORAGE_KEY, String(ativoId));
    } catch (_) {}
    this.loading.set(true);
    this.error.set(null);
    this.patchSim({ qtyToSell: '', simDN: 0 });

    try {
      if (ativoId === 0) {
        const resp = await firstValueFrom(
          this.api.obterLotesPeps(this.carteiraId())
        );
        if (seq !== this.reqSeq) return;
        this.todasPosicoes.set(resp.posicoes ?? []);
        this.posicao.set(null);
      } else {
        const resp = await firstValueFrom(
          this.api.obterLotesPeps(this.carteiraId(), ativoId)
        );
        if (seq !== this.reqSeq) return;
        this.posicao.set(resp.posicoes?.[0] ?? null);
      }
    } catch (err: any) {
      if (seq === this.reqSeq) {
        this.error.set(err?.message || 'Erro ao carregar ativo');
      }
    } finally {
      if (seq === this.reqSeq) {
        this.loading.set(false);
      }
    }
  }

  async salvarTaxa(transacaoId: number, taxaPct: number): Promise<void> {
    const seq = ++this.reqSeq;
    this.loading.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.api.atualizarTaxaContratada(transacaoId, taxaPct));
      if (seq !== this.reqSeq) return;
      // Recarrega os lotes
      const lotesResp = await firstValueFrom(
        this.api.obterLotesPeps(
          this.carteiraId(),
          this.ativoId() === 0 ? undefined : (this.ativoId() ?? undefined)
        )
      );
      if (seq !== this.reqSeq) return;
      if (this.ativoId() === 0) {
        this.todasPosicoes.set(lotesResp.posicoes ?? []);
        this.posicao.set(null);
      } else {
        const pos = this.ativoId()
          ? lotesResp.posicoes?.find((p) => p.ativo.id === this.ativoId()) ?? lotesResp.posicoes?.[0]
          : lotesResp.posicoes?.[0];
        this.posicao.set(pos ?? null);
        if (pos) {
          this.todasPosicoes.update((list) =>
            list.map((p) => (p.ativo.id === pos.ativo.id ? pos : p))
          );
        }
      }
    } catch (err: any) {
      if (seq === this.reqSeq) {
        this.error.set(err?.message || 'Erro ao salvar taxa contratada');
      }
      throw err;
    } finally {
      if (seq === this.reqSeq) {
        this.loading.set(false);
      }
    }
  }

  async criarTituloManual(dto: CadastroManualRendaFixaDto): Promise<PosicaoRendaFixa> {
    const seq = ++this.reqSeq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const novaPos = await firstValueFrom(this.api.cadastrarTituloManual(dto));
      if (seq !== this.reqSeq) return novaPos;

      const [ativos, lotesResp] = await Promise.all([
        firstValueFrom(this.api.listarAtivos()),
        firstValueFrom(this.api.obterLotesPeps(this.carteiraId())),
      ]);
      if (seq !== this.reqSeq) return novaPos;

      this.ativos.set(ativos);
      this.todasPosicoes.set(lotesResp.posicoes ?? []);
      this.ativoId.set(novaPos.ativo.id);
      this.posicao.set(novaPos);
      this.patchSim({ qtyToSell: '', simDN: 0 });
      return novaPos;
    } catch (err: any) {
      if (seq === this.reqSeq) {
        this.error.set(err?.message || 'Erro ao cadastrar título manual');
      }
      throw err;
    } finally {
      if (seq === this.reqSeq) {
        this.loading.set(false);
      }
    }
  }

  async adicionarLote(ativoId: number, dto: LoteManualCreateDto): Promise<PosicaoRendaFixa> {
    const seq = ++this.reqSeq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const posAtualizada = await firstValueFrom(this.api.adicionarLoteManual(ativoId, dto));
      if (seq !== this.reqSeq) return posAtualizada;

      const lotesResp = await firstValueFrom(this.api.obterLotesPeps(this.carteiraId()));
      if (seq !== this.reqSeq) return posAtualizada;

      this.todasPosicoes.set(lotesResp.posicoes ?? []);
      if (this.ativoId() === ativoId) {
        this.posicao.set(posAtualizada);
      }
      return posAtualizada;
    } catch (err: any) {
      if (seq === this.reqSeq) {
        this.error.set(err?.message || 'Erro ao adicionar lote');
      }
      throw err;
    } finally {
      if (seq === this.reqSeq) {
        this.loading.set(false);
      }
    }
  }

  async atualizarTitulo(ativoId: number, dto: AtivoRendaFixaUpdateDto): Promise<PosicaoRendaFixa> {
    const seq = ++this.reqSeq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const posAtualizada = await firstValueFrom(
        this.api.atualizarTituloRf(ativoId, dto, this.carteiraId())
      );
      if (seq !== this.reqSeq) return posAtualizada;

      const [ativos, lotesResp] = await Promise.all([
        firstValueFrom(this.api.listarAtivos()),
        firstValueFrom(this.api.obterLotesPeps(this.carteiraId())),
      ]);
      if (seq !== this.reqSeq) return posAtualizada;

      this.ativos.set(ativos);
      this.todasPosicoes.set(lotesResp.posicoes ?? []);
      this.posicao.set(posAtualizada);
      return posAtualizada;
    } catch (err: any) {
      if (seq === this.reqSeq) {
        this.error.set(err?.message || 'Erro ao atualizar título');
      }
      throw err;
    } finally {
      if (seq === this.reqSeq) {
        this.loading.set(false);
      }
    }
  }

  async excluirTitulo(ativoId: number): Promise<void> {
    const seq = ++this.reqSeq;
    this.loading.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.api.excluirTituloRf(ativoId));
      if (seq !== this.reqSeq) return;

      const [ativos, lotesResp] = await Promise.all([
        firstValueFrom(this.api.listarAtivos()),
        firstValueFrom(this.api.obterLotesPeps(this.carteiraId())),
      ]);
      if (seq !== this.reqSeq) return;

      this.ativos.set(ativos);
      this.todasPosicoes.set(lotesResp.posicoes ?? []);

      if (ativos.length > 0) {
        const currentActiveId = this.ativoId();
        if (currentActiveId === 0) {
          this.ativoId.set(0);
          this.posicao.set(null);
        } else {
          const stillExists = currentActiveId && ativos.some((a) => a.id === currentActiveId);
          const nextId = stillExists ? currentActiveId! : ativos[0].id;
          this.ativoId.set(nextId);
          const nextPos = lotesResp.posicoes?.find((p) => p.ativo.id === nextId) ?? lotesResp.posicoes?.[0] ?? null;
          this.posicao.set(nextPos);
        }
      } else {
        this.ativoId.set(null);
        this.posicao.set(null);
      }
      this.patchSim({ qtyToSell: '', simDN: 0 });
    } catch (err: any) {
      if (seq === this.reqSeq) {
        this.error.set(err?.message || 'Erro ao excluir título');
      }
      throw err;
    } finally {
      if (seq === this.reqSeq) {
        this.loading.set(false);
      }
    }
  }

  async editarLote(transacaoId: number, dto: LoteManualUpdateDto): Promise<PosicaoRendaFixa> {
    const seq = ++this.reqSeq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const posAtualizada = await firstValueFrom(this.api.atualizarLoteManual(transacaoId, dto));
      if (seq !== this.reqSeq) return posAtualizada;

      const lotesResp = await firstValueFrom(this.api.obterLotesPeps(this.carteiraId()));
      if (seq !== this.reqSeq) return posAtualizada;

      this.todasPosicoes.set(lotesResp.posicoes ?? []);
      if (this.ativoId() === 0) {
        this.posicao.set(null);
      } else {
        this.posicao.set(posAtualizada);
      }
      return posAtualizada;
    } catch (err: any) {
      if (seq === this.reqSeq) {
        this.error.set(err?.message || 'Erro ao editar lote');
      }
      throw err;
    } finally {
      if (seq === this.reqSeq) {
        this.loading.set(false);
      }
    }
  }

  async excluirLote(transacaoId: number): Promise<PosicaoRendaFixa> {
    const seq = ++this.reqSeq;
    this.loading.set(true);
    this.error.set(null);
    try {
      const posAtualizada = await firstValueFrom(this.api.excluirLoteManual(transacaoId));
      if (seq !== this.reqSeq) return posAtualizada;

      const lotesResp = await firstValueFrom(this.api.obterLotesPeps(this.carteiraId()));
      if (seq !== this.reqSeq) return posAtualizada;

      this.todasPosicoes.set(lotesResp.posicoes ?? []);
      if (this.ativoId() === 0) {
        this.posicao.set(null);
      } else {
        this.posicao.set(posAtualizada);
      }
      return posAtualizada;
    } catch (err: any) {
      if (seq === this.reqSeq) {
        this.error.set(err?.message || 'Erro ao excluir lote');
      }
      throw err;
    } finally {
      if (seq === this.reqSeq) {
        this.loading.set(false);
      }
    }
  }

  abrirModal(
    mode: ModalMode = 'NOVO_TITULO',
    lote?: LoteAbertoDto | null,
    ativo?: AtivoRendaFixa | null
  ): void {
    let at = ativo ?? null;
    if (!at && lote) {
      for (const pos of this.todasPosicoes()) {
        if (pos.lotes?.some((l) => Number(l.transacao_id) === Number(lote.transacao_id))) {
          at = pos.ativo;
          break;
        }
      }
    }
    this.modalState.set({ open: true, mode, lote: lote ?? null, ativo: at });
  }

  fecharModal(): void {
    this.modalState.set({ open: false, mode: 'NOVO_TITULO', lote: null, ativo: null });
  }


  async sincronizarMercado(forcar: boolean = true): Promise<void> {
    this.syncStatus.set('🔄 Consultando dados de mercado...');
    try {
      const [tesouro, macro] = await Promise.all([
        firstValueFrom(this.api.obterMercadoTesouro(forcar)),
        firstValueFrom(this.api.obterMercadoMacro(forcar)),
      ]);
      this.mercadoTesouro.set(tesouro);
      this.mercadoMacro.set(macro);

      const isStale = tesouro.stale || tesouro.cache_hit;
      const statusNote = isStale ? 'dados de cache' : 'dados ao vivo';
      this.syncStatus.set(`✅ Atualizado (${statusNote}) às ${new Date().toLocaleTimeString()}`);

      // Atualiza valores de referência a partir de bonds.json se disponível
      if (tesouro?.dados?.cotacoes) {
        const bond = tesouro.dados.cotacoes.find(
          (b) => b.symbol === this.premissas().selectedBond
        );
        if (bond) {
          this.premissas.update((p) => ({
            ...p,
            refPrice: bond.sellPrice || p.refPrice,
            refRate: bond.sellRate || p.refRate,
            refDate: bond.baseDate || p.refDate,
          }));
        }
      }
    } catch (err: any) {
      this.syncStatus.set('⚠️ Falha ao consultar mercado online. Mantidos dados de cache.');
    }
  }

  patchSim(p: Partial<SimInputs>): void {
    this.sim.update((s) => ({ ...s, ...p }));
  }

  patchPremissas(p: Partial<Premissas>): void {
    this.premissas.update((s) => sanitizePremissas({ ...s, ...p }));
  }

  setTab(tab: 'posicao' | 'simulador' | 'projecao' | 'sensibilidade' | 'premissas'): void {
    this.activeTab.set(tab);
  }

  setProjView(view: Partial<{ metric: 'liq' | 'bruto'; base: 'nominal' | 'real' }>): void {
    this.projView.update((v) => ({ ...v, ...view }));
  }
}
