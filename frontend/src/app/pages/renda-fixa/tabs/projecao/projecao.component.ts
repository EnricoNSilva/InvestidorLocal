import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RendaFixaStore } from '../../state/renda-fixa.store';
import { ProjectionChartComponent } from '../../charts/projection-chart.component';

@Component({
  selector: 'app-projecao',
  standalone: true,
  imports: [CommonModule, FormsModule, ProjectionChartComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './projecao.component.html',
  styleUrl: './projecao.component.scss',
})
export class ProjecaoComponent {
  readonly store = inject(RendaFixaStore);

  setMetric(metric: 'liq' | 'bruto'): void {
    this.store.setProjView({ metric });
  }

  setBase(base: 'nominal' | 'real'): void {
    this.store.setProjView({ base });
  }
}
