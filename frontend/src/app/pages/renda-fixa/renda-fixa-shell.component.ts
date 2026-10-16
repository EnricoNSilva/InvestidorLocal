import { Component, ChangeDetectionStrategy, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RendaFixaStore } from './state/renda-fixa.store';
import { PosicaoPepsComponent } from './tabs/posicao-peps/posicao-peps.component';
import { SimuladorComponent } from './tabs/simulador/simulador.component';
import { ProjecaoComponent } from './tabs/projecao/projecao.component';
import { SensibilidadeComponent } from './tabs/sensibilidade/sensibilidade.component';
import { PremissasComponent } from './tabs/premissas/premissas.component';
import { NovoTituloRfModalComponent } from './components/novo-titulo-modal.component';

@Component({
  selector: 'app-renda-fixa-shell',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    PosicaoPepsComponent,
    SimuladorComponent,
    ProjecaoComponent,
    SensibilidadeComponent,
    PremissasComponent,
    NovoTituloRfModalComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './renda-fixa-shell.component.html',
  styleUrl: './renda-fixa-shell.component.scss',
})
export class RendaFixaShellComponent implements OnInit {
  readonly store = inject(RendaFixaStore);
  readonly showModal = signal<boolean>(false);
  readonly confirmandoExclusaoAtivo = signal<boolean>(false);

  ngOnInit(): void {
    try {
      const savedCarteira = localStorage.getItem('carteiraAtivaId');
      if (savedCarteira) {
        const cid = parseInt(savedCarteira, 10);
        if (!isNaN(cid) && cid > 0) {
          this.store.carteiraId.set(cid);
        }
      }
    } catch (_) {}
    this.store.carregar();
  }

  setTab(tab: 'posicao' | 'simulador' | 'projecao' | 'sensibilidade' | 'premissas'): void {
    this.store.setTab(tab);
  }

  onAtivoChange(idVal: any): void {
    const id = Number(idVal);
    if (!isNaN(id) && id >= 0) {
      this.store.selecionarAtivo(id);
    }
  }

  openNovoTituloModal(): void {
    this.showModal.set(true);
    this.store.abrirModal('NOVO_TITULO');
  }

  openNovoAporteModal(): void {
    if (this.store.ativos().length === 0) {
      this.openNovoTituloModal();
      return;
    }
    this.showModal.set(true);
    this.store.abrirModal('NOVO_APORTE');
  }

  openEditarTituloModal(): void {
    this.showModal.set(true);
    this.store.abrirModal('EDITAR_TITULO');
  }

  iniciarExclusaoAtivo(): void {
    this.confirmandoExclusaoAtivo.set(true);
  }

  cancelarExclusaoAtivo(): void {
    this.confirmandoExclusaoAtivo.set(false);
  }

  async confirmarExclusaoAtivo(): Promise<void> {
    const atId = this.store.posicao()?.ativo?.id;
    try {
      if (atId) {
        await this.store.excluirTitulo(atId);
      }
    } finally {
      this.confirmandoExclusaoAtivo.set(false);
    }
  }

  closeNovoTituloModal(): void {
    this.showModal.set(false);
    this.store.fecharModal();
  }

  formatDate(d: string | null | undefined): string {
    if (!d) return '';
    try {
      const [y, m, day] = d.split('T')[0].split('-');
      if (y && m && day) return `${day}/${m}/${y}`;
      return d;
    } catch (_) {
      return d;
    }
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
}
