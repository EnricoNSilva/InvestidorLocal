import { Injectable, computed, inject, signal, effect } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  AllocationSlice,
  AtivoRendaFixa,
  CadastroManualRendaFixaDto,
  CotacaoTesouroResponse,
  DetalhesRendaFixa,
  EnvelopeMercado,
  LoteManualCreateDto,
  MacroResponse,
  MercadoSnapshot,
  PosicaoRendaFixa,
  Premissas,
  ProjectionSeries,
  SimInputs,
  isLot,
  toEngineLot,
} from '../../../core/models/renda-fixa.models';
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
import { RatePoint, SensitivityRow } from '../../../core/financial-engine/types';
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

  // ---------- Derivados (Computed Signals) ----------
  readonly mercado = computed<MercadoSnapshot | null>(() => {
    const tesouro = this.mercadoTesouro();
    const macro = this.mercadoMacro();
    if (!tesouro && !macro) return null;
    return { tesouro, macro };
  });

  readonly lots = computed(() =>
    (this.posicao()?.lotes ?? []).map(toEngineLot).filter(isLot)
  );

  readonly pendencias = computed(() => this.posicao()?.pendencias ?? []);

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
    return Math.min(maxLotDN, this.maxSimDate());
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

    return {
      marketRate: this.calib().rNow,
      refDN: this.effectiveRefDN(),
      vnaFactor: this.vnaHoje(),
      cdiAnual: cdiDec,
      selicAnual: cdiDec,
      ipcaAnual: ipcaDec,
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

  readonly vendaHoje = computed(() => {
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
    calcRealReturn(this.posReturnPctApp(), this.premissas().ipcaCal / 100)
  );

  readonly posAvgRate = computed(() => {
    const v = this.vendaHoje();
    return v.q > 0
      ? v.parts.reduce((acc, p) => acc + p.lot.rate * p.q, 0) / v.q
      : 0;
  });

  readonly posTIR = computed(() => {
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

  readonly alocacaoIndexador = computed<AllocationSlice[]>(() => {
    const posicoes = this.todasPosicoes();
    let ipcaSum = 0;
    let cdiSum = 0;
    let selicSum = 0;
    let preSum = 0;

    if (posicoes.length > 0) {
      for (const pos of posicoes) {
        const idx = (pos.ativo?.detalhes_rf?.indexador || 'IPCA').toUpperCase();
        const prod = (pos.ativo?.detalhes_rf?.produto || '').toUpperCase();
        const val = pos.ativo.id === this.posicao()?.ativo?.id
          ? Math.max(0, this.vendaHoje().liqApp)
          : Number(pos.custo_total_brl) || 0;

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
    return parts.map((p, i) => {
      const val = Math.max(0, p.liqApp);
      return {
        label: `Lote ${i + 1} (${p.lot.date})`,
        value: val,
        pct: total > 0 ? val / total : 0,
      };
    });
  });

  constructor() {
    effect(() => {
      savePremissas(this.premissas());
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

      if (ativos.length > 0 && this.ativoId() === null) {
        // Seleciona preferencialmente o RendA+ 2065 ou o primeiro ativo
        const rendaMais = ativos.find(
          (a) =>
            a.ticker.includes('RENDA+') ||
            a.ticker.includes('2065') ||
            a.detalhes_rf?.produto === 'TESOURO_RENDA_MAIS'
        );
        this.ativoId.set(rendaMais ? rendaMais.id : ativos[0].id);
      }

      // 2. Carrega lotes PEPS
      const lotesResp = await firstValueFrom(
        this.api.obterLotesPeps(this.carteiraId(), this.ativoId() ?? undefined)
      );
      if (seq !== this.reqSeq) return;
      this.todasPosicoes.set(lotesResp.posicoes ?? []);

      if (lotesResp.posicoes && lotesResp.posicoes.length > 0) {
        this.posicao.set(lotesResp.posicoes[0]);
        if (this.ativoId() === null) {
          this.ativoId.set(lotesResp.posicoes[0].ativo.id);
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
    this.loading.set(true);
    this.error.set(null);
    this.patchSim({ qtyToSell: '', simDN: 0 });

    try {
      const resp = await firstValueFrom(
        this.api.obterLotesPeps(this.carteiraId(), ativoId)
      );
      if (seq !== this.reqSeq) return;
      this.posicao.set(resp.posicoes?.[0] ?? null);
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
        this.api.obterLotesPeps(this.carteiraId(), this.ativoId() ?? undefined)
      );
      if (seq !== this.reqSeq) return;
      this.todasPosicoes.set(lotesResp.posicoes ?? []);
      const pos = this.ativoId()
        ? lotesResp.posicoes?.find((p) => p.ativo.id === this.ativoId()) ?? lotesResp.posicoes?.[0]
        : lotesResp.posicoes?.[0];
      this.posicao.set(pos ?? null);
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
