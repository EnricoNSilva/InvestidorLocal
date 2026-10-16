import { Component, ChangeDetectionStrategy, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RendaFixaStore } from '../../state/renda-fixa.store';
import { KpiCardComponent } from '../../components/kpi-card.component';
import { InfoTipComponent } from '../../components/info-tip.component';
import { AllocationChartComponent } from '../../charts/allocation-chart.component';
import { getIRSchedule } from '../../../../core/financial-engine';
import { LoteAbertoDto } from '../../../../core/models/renda-fixa.models';

@Component({
  selector: 'app-posicao-peps',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    KpiCardComponent,
    InfoTipComponent,
    AllocationChartComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './posicao-peps.component.html',
  styleUrl: './posicao-peps.component.scss',
})
export class PosicaoPepsComponent {
  readonly store = inject(RendaFixaStore);
  readonly allocationMode = signal<'indexador' | 'lote'>('indexador');
  readonly taxaDrafts: Record<number, number> = {};
  readonly salvandoId = signal<number | null>(null);
  readonly salvarErro = signal<string | null>(null);

  readonly isentoIr = computed(() => Boolean(this.store.posicao()?.ativo?.detalhes_rf?.isento_ir));
  readonly isCdi = computed(() => this.store.instrument().kind === 'CDI_POS');

  readonly equivalenciaFiscal = computed(() => {
    const isento = this.isentoIr();
    const avgRate = this.store.posAvgRate() || Number(this.store.posicao()?.ativo?.detalhes_rf?.percentual_indexador) || 100;
    if (isento) {
      const equiv15 = avgRate / (1 - 0.15);
      const equiv225 = avgRate / (1 - 0.225);
      return {
        isento: true,
        taxa: avgRate,
        equiv15,
        equiv225,
        texto: `${avgRate.toFixed(1).replace('.', ',')}% do CDI isento equivale a ${equiv15.toFixed(1).replace('.', ',')}% do CDI de um CDB tributado na alíquota de 15% (e ${equiv225.toFixed(1).replace('.', ',')}% na alíquota inicial de 22,5%).`,
      };
    } else {
      const equivIsenta15 = avgRate * (1 - 0.15);
      const equivIsenta225 = avgRate * (1 - 0.225);
      return {
        isento: false,
        taxa: avgRate,
        equivIsenta15,
        equivIsenta225,
        texto: `${avgRate.toFixed(1).replace('.', ',')}% do CDI tributado em CDB equivale a ${equivIsenta15.toFixed(1).replace('.', ',')}% do CDI de uma LCI/LCA isenta de IR na alíquota de 15% (e ${equivIsenta225.toFixed(1).replace('.', ',')}% na alíquota de 22,5%).`,
      };
    }
  });

  getIRSchedule(days: number) {
    return getIRSchedule(days);
  }

  setAllocationMode(mode: 'indexador' | 'lote') {
    this.allocationMode.set(mode);
  }

  fmtBRL(v: number | string | undefined | null): string {
    return (Number(v) || 0).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });
  }

  fmtPct(v: number | string | undefined | null, decimals = 2): string {
    const num = (Number(v) || 0) * 100;
    return (
      num.toLocaleString('pt-BR', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }) + '%'
    );
  }

  fmtPctDirect(v: number | string | undefined | null, decimals = 2): string {
    const num = Number(v) || 0;
    return (
      num.toLocaleString('pt-BR', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }) + '%'
    );
  }

  fmtNum(v: number | string | undefined | null, decimals = 2): string {
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

  async salvarTaxa(lote: LoteAbertoDto) {
    const val = this.taxaDrafts[lote.transacao_id];
    if (val === undefined || isNaN(val) || val <= 0) {
      this.salvarErro.set('Por favor, informe uma taxa contratada válida em % a.a.');
      return;
    }
    this.salvarErro.set(null);
    this.salvandoId.set(lote.transacao_id);
    try {
      await this.store.salvarTaxa(lote.transacao_id, val);
      delete this.taxaDrafts[lote.transacao_id];
    } catch (e: any) {
      this.salvarErro.set('Erro ao salvar taxa: ' + (e?.message || 'erro desconhecido'));
    } finally {
      this.salvandoId.set(null);
    }
  }
}
