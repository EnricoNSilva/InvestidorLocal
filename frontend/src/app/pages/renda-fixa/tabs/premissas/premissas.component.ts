import { Component, ChangeDetectionStrategy, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RendaFixaStore } from '../../state/renda-fixa.store';
import { InfoTipComponent } from '../../components/info-tip.component';
import { DEFAULT_TREASURY_BONDS } from '../../../../core/financial-engine/api';
import { CustodyTieredMode } from '../../../../core/financial-engine/types';

@Component({
  selector: 'app-premissas',
  standalone: true,
  imports: [CommonModule, FormsModule, InfoTipComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './premissas.component.html',
  styleUrl: './premissas.component.scss',
})
export class PremissasComponent {
  readonly store = inject(RendaFixaStore);
  readonly sincronizando = signal(false);

  readonly availableBonds = computed(() => {
    const cotacoes = this.store.mercadoTesouro()?.dados?.cotacoes;
    return cotacoes && cotacoes.length > 0 ? cotacoes : DEFAULT_TREASURY_BONDS;
  });

  onBondSelect(symbol: string): void {
    const bond = this.availableBonds().find((b) => b.symbol === symbol);

    if (bond) {
      this.store.patchPremissas({
        selectedBond: symbol,
        refPrice: bond.sellPrice,
        refRate: bond.sellRate,
        refDate: bond.baseDate || this.store.premissas().refDate,
      });
    }
  }

  async sincronizar(): Promise<void> {
    this.sincronizando.set(true);
    try {
      await this.store.sincronizarMercado(true);
    } finally {
      this.sincronizando.set(false);
    }
  }

  updateCustMode(mode: string): void {
    const custMode = (
      ['single', 'marginal', 'none'].includes(mode) ? mode : 'single'
    ) as CustodyTieredMode;
    this.store.patchPremissas({
      custody: {
        ...this.store.premissas().custody,
        custMode,
      },
    });
  }

  updateCustField(field: 'cust1' | 'cust2' | 'cust3', val: any): void {
    const num = Number(val) || 0;
    this.store.patchPremissas({
      custody: {
        ...this.store.premissas().custody,
        [field]: num,
      },
    });
  }
}
