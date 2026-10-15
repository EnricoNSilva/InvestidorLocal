import { Component, ChangeDetectionStrategy, inject, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RendaFixaStore } from '../../state/renda-fixa.store';
import { KpiCardComponent } from '../../components/kpi-card.component';
import { InfoTipComponent } from '../../components/info-tip.component';
import { RateTrajectoryChartComponent } from '../../charts/rate-trajectory-chart.component';
import { SimInputs } from '../../../../core/models/renda-fixa.models';
import { formatBRLDate } from '../../../../core/financial-engine/dates';

@Component({
  selector: 'app-simulador',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    KpiCardComponent,
    InfoTipComponent,
    RateTrajectoryChartComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './simulador.component.html',
  styleUrl: './simulador.component.scss',
})
export class SimuladorComponent implements OnDestroy {
  readonly store = inject(RendaFixaStore);

  private rafId = 0;
  private pendingSim: Partial<SimInputs> = {};
  private ipcaRafId = 0;
  private pendingIpca: number | null = null;

  ngOnDestroy(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.ipcaRafId) cancelAnimationFrame(this.ipcaRafId);
  }

  onSlider(patch: Partial<SimInputs>): void {
    Object.assign(this.pendingSim, patch);
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.store.patchSim(this.pendingSim);
      this.pendingSim = {};
      this.rafId = 0;
    });
  }

  onIpcaSlider(val: number): void {
    this.pendingIpca = val;
    if (this.ipcaRafId) return;
    this.ipcaRafId = requestAnimationFrame(() => {
      if (this.pendingIpca !== null) {
        this.store.patchPremissas({ ipcaProj: this.pendingIpca });
        this.pendingIpca = null;
      }
      this.ipcaRafId = 0;
    });
  }

  setPresetNow(): void {
    const rNowPct = Number((this.store.calib().rNow * 100).toFixed(2));
    this.store.patchSim({ targetRatePct: rNowPct });
  }

  setPresetAvg(): void {
    const avg = Number(this.store.posAvgRate().toFixed(2));
    this.store.patchSim({ targetRatePct: avg > 0 ? avg : 6.55 });
  }

  setPresetLow(): void {
    this.store.patchSim({ targetRatePct: 5.0 });
  }

  sellAll(): void {
    this.store.patchSim({ qtyToSell: '' });
  }

  fmtBRL(v: number | undefined | null): string {
    return (Number(v) || 0).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });
  }

  fmtPct(v: number | undefined | null, decimals = 2): string {
    const num = (Number(v) || 0) * 100;
    return (
      num.toLocaleString('pt-BR', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }) + '%'
    );
  }

  fmtPctDirect(v: number | undefined | null, decimals = 2): string {
    const num = Number(v) || 0;
    return (
      num.toLocaleString('pt-BR', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }) + '%'
    );
  }

  fmtNum(v: number | undefined | null, decimals = 2): string {
    return (Number(v) || 0).toLocaleString('pt-BR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  formatDateBRL(dStr: string): string {
    if (!dStr) return '--';
    const parts = dStr.split('-');
    if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
    return dStr;
  }

  formatSimDate(dn: number | undefined | null): string {
    if (!dn || isNaN(dn)) return '--';
    return formatBRLDate(dn);
  }
}
