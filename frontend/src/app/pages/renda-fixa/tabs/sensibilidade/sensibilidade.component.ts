import { Component, ChangeDetectionStrategy, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RendaFixaStore } from '../../state/renda-fixa.store';
import { InfoTipComponent } from '../../components/info-tip.component';
import {
  addYearsDN,
  calcPU,
  getVNAFactor,
  MAX_SIM_DATE,
  simulateSellPEPS,
} from '../../../../core/financial-engine';

export interface MatrixCellData {
  liqReal: number;
  pctGain: number;
  bg: string;
  isPositive: boolean;
}

export interface MatrixRowData {
  rate: number;
  rateLabel: string;
  isCurrent: boolean;
  cells: MatrixCellData[];
}

export interface CarryRowData {
  cells: MatrixCellData[];
}

@Component({
  selector: 'app-sensibilidade',
  standalone: true,
  imports: [CommonModule, InfoTipComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sensibilidade.component.html',
  styleUrl: './sensibilidade.component.scss',
})
export class SensibilidadeComponent {
  readonly store = inject(RendaFixaStore);

  readonly horizons = [0, 1, 2, 3, 5, 10, 15, 20, 30];
  readonly rates = [0.045, 0.05, 0.055, 0.06, 0.065, 0.07, 0.075, 0.08, 0.085];

  // Matriz de Cenários Futuros (Heatmap)
  readonly matrixData = computed(() => {
    const c = this.store.calib();
    const lots = this.store.lots();
    const custody = this.store.premissas().custody;
    const ipca = this.store.premissas().ipcaProj;
    const rNow = c.rNow;
    const refDN = c.refDN;
    const Fref = c.Fref;
    const maxSimDate = this.store.schedule().maxSimDate;

    // Linha de Carrego Puro
    const carryCells: MatrixCellData[] = this.horizons.map((h) => {
      const d = Math.min(addYearsDN(refDN, h), maxSimDate);
      const vna = getVNAFactor(d, refDN, Fref, ipca);
      const carryRes = simulateSellPEPS({
        lots,
        t: d,
        r: rNow,
        vnaFactor: vna,
        custodyConfig: custody,
      });
      const lucroLiqCarrego = carryRes.liqReal - carryRes.custo;
      const pctCarrego = carryRes.custo > 0 ? lucroLiqCarrego / carryRes.custo : 0;
      const bg =
        lucroLiqCarrego >= 0 ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)';

      return {
        liqReal: carryRes.liqReal,
        pctGain: pctCarrego,
        bg,
        isPositive: lucroLiqCarrego >= 0,
      };
    });

    // Linhas por Taxa Alvo de Mercado
    const rows: MatrixRowData[] = this.rates.map((r) => {
      const isCurrent = Math.abs(r - rNow) < 0.0025;
      const cells: MatrixCellData[] = this.horizons.map((h) => {
        const d = Math.min(addYearsDN(refDN, h), maxSimDate);
        const vna = getVNAFactor(d, refDN, Fref, ipca);
        const res = simulateSellPEPS({
          lots,
          t: d,
          r,
          vnaFactor: vna,
          custodyConfig: custody,
        });

        const lucro = res.liqReal - res.custo;
        const pctGain = res.custo > 0 ? lucro / res.custo : 0;
        const alpha = Math.min(Math.abs(pctGain) / 0.8, 1) * 0.35 + 0.08;
        const bg =
          pctGain >= 0 ? `rgba(16, 185, 129, ${alpha})` : `rgba(239, 68, 68, ${alpha})`;

        return {
          liqReal: res.liqReal,
          pctGain,
          bg,
          isPositive: pctGain >= 0,
        };
      });

      return {
        rate: r,
        rateLabel: `IPCA + ${(r * 100).toFixed(2).replace('.', ',')}%`,
        isCurrent,
        cells,
      };
    });

    return { carryCells, rows };
  });

  // Tabela de Sensibilidade a Choques Imediatos
  readonly shockRows = computed(() => {
    const c = this.store.calib();
    const lots = this.store.lots();
    const custody = this.store.premissas().custody;
    const vnaToday = this.store.vnaHoje();
    const baseRes = this.store.vendaHoje();
    const baseReturnPct =
      baseRes.custo > 0 ? (baseRes.liqApp - baseRes.custo) / baseRes.custo : 0;

    const shocks = [-1.0, -0.5, -0.25, -0.1, 0.1, 0.25, 0.5, 1.0];

    return shocks.map((s) => {
      const newRate = c.rNow + s / 100;
      const newPU = calcPU(c.refDN, newRate, vnaToday);
      const puVarPct = (newPU - c.pNow) / c.pNow;

      const shockRes = simulateSellPEPS({
        lots,
        t: c.refDN,
        r: newRate,
        vnaFactor: vnaToday,
        custodyConfig: custody,
        overridePU: newPU,
      });

      const brutoDiff = shockRes.bruto - baseRes.bruto;
      const shockReturnPct =
        shockRes.custo > 0 ? (shockRes.liqApp - shockRes.custo) / shockRes.custo : 0;
      const returnDiffPP = (shockReturnPct - baseReturnPct) * 100;

      return {
        shock: s,
        shockLabel: `${s > 0 ? '+' : ''}${s.toFixed(2)} p.p.`,
        newRate,
        newPU,
        puVarPct,
        brutoDiff,
        shockReturnPct,
        returnDiffPP,
      };
    });
  });

  fmtBRL(v: number | undefined | null): string {
    return (Number(v) || 0).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });
  }

  fmtPct(v: number | undefined | null, decimals = 1): string {
    const num = (Number(v) || 0) * 100;
    return (
      num.toLocaleString('pt-BR', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }) + '%'
    );
  }

  fmtNum(v: number | undefined | null, decimals = 1): string {
    return (Number(v) || 0).toLocaleString('pt-BR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }
}
