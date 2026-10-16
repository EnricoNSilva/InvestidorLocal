import { Injectable, computed, inject, signal, effect } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  AllocationSlice,
  AtivoRendaFixa,
  CotacaoTesouroResponse,
  DetalhesRendaFixa,
  EnvelopeMercado,
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
  createRendaMaisInstrument,
  decomposeCarryAndMtM,
  generateRateTrajectory,
  getVNAFactor,
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

  readonly instrument = computed(() =>
    createRendaMaisInstrument(this.schedule(), this.premissas().custody)
  );

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

  readonly simDN = computed(() => {
    const s = this.sim();
    const dn =
      s.simDN && s.simDN > 0
        ? s.simDN
        : addYearsDN(this.calib().refDN, s.simYears || 1.0);
    return Math.min(dn, this.schedule().maxSimDate);
  });

  readonly simDNClamped = computed(() =>
    Math.min(this.simDN(), this.schedule().maxSimDate)
  );

  readonly vnaSim = computed(() =>
    getVNAFactor(
      this.simDNClamped(),
      this.calib().refDN,
      this.calib().Fref,
      this.premissas().ipcaProj
    )
  );

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

  readonly vendaHoje = computed(() =>
    simulateSellPEPS({
      lots: this.lots(),
      t: this.calib().refDN,
      r: this.calib().rNow,
      vnaFactor: this.vnaHoje(),
      overridePU: this.calib().pNow,
      custodyConfig: this.premissas().custody,
    })
  );

  readonly vendaSim = computed(() => {
    const num = Number(this.sim().qtyToSell);
    const qty = !isNaN(num) && num > 0 ? num : undefined;
    return simulateSellPEPS({
      lots: this.lots(),
      t: this.simDNClamped(),
      r: this.rateAtSale(),
      vnaFactor: this.vnaSim(),
      qtyToSell: qty,
      custodyConfig: this.premissas().custody,
    });
  });

  readonly nowResForSoldQty = computed(() => {
    const num = Number(this.sim().qtyToSell);
    const qty = !isNaN(num) && num > 0 ? num : undefined;
    return simulateSellPEPS({
      lots: this.lots(),
      t: this.calib().refDN,
      r: this.calib().rNow,
      vnaFactor: this.vnaHoje(),
      qtyToSell: qty,
      overridePU: this.calib().pNow,
      custodyConfig: this.premissas().custody,
    });
  });

  readonly decomposicao = computed(() =>
    decomposeCarryAndMtM({
      simRes: this.vendaSim(),
      simDN: this.simDNClamped(),
      vnaFactor: this.vnaSim(),
    })
  );

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
    flows.push({ dn: this.calib().refDN, amount: this.vendaHoje().liqReal });
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
    const res = buildProjectionCurves({
      refDN: c.refDN,
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
      maxSimDate: this.schedule().maxSimDate,
    });
    return {
      labels: res.labels,
      series: res.series,
    };
  });

  readonly sensibilidade = computed<SensitivityRow[]>(() =>
    calcSensitivityTable({
      refDN: this.calib().refDN,
      rNow: this.calib().rNow,
      pNow: this.calib().pNow,
      vnaFactor: this.vnaHoje(),
      lots: this.lots(),
      custodyConfig: this.premissas().custody,
    })
  );

  readonly alocacaoIndexador = computed<AllocationSlice[]>(() => {
    const v = this.vendaHoje();
    const parts = v.parts || [];
    const indexer = (this.posicao()?.ativo?.detalhes_rf?.indexador || 'IPCA').toUpperCase();
    let ipcaSum = 0;
    let selicSum = 0;
    let preSum = 0;

    for (const p of parts) {
      if (indexer.includes('SELIC')) {
        selicSum += p.liqApp;
      } else if (indexer.includes('PREFIXADO') || indexer.includes('PRE')) {
        preSum += p.liqApp;
      } else {
        ipcaSum += p.liqApp;
      }
    }
    const total = Math.max(0, ipcaSum + selicSum + preSum);
    if (total === 0) {
      return [{ label: 'Sem Ativos', value: 1, pct: 1 }];
    }
    return [
      { label: 'IPCA+ / Renda+', value: ipcaSum, pct: total > 0 ? ipcaSum / total : 0 },
      { label: 'Tesouro Selic', value: selicSum, pct: total > 0 ? selicSum / total : 0 },
      { label: 'Tesouro Prefixado', value: preSum, pct: total > 0 ? preSum / total : 0 },
    ];
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
    this.patchSim({ qtyToSell: '' });

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
