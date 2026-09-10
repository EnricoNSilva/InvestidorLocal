import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { CarteiraService } from '../../core/services/carteira.service';
import { PosicaoConsolidada } from '../../core/models/investimento.models';

@Component({
  selector: 'app-carteira',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './carteira.component.html',
  styleUrl: './carteira.component.scss'
})
export class CarteiraComponent implements OnInit {
  private readonly carteiraService = inject(CarteiraService);

  readonly posicoes = signal<PosicaoConsolidada[]>([]);
  readonly loading = signal<boolean>(true);
  readonly errorMessage = signal<string | null>(null);

  readonly totalPatrimonioCusto = computed(() => {
    return this.posicoes().reduce((acc, pos) => {
      const custo = typeof pos.custo_total_brl === 'string'
        ? parseFloat(pos.custo_total_brl)
        : pos.custo_total_brl;
      return acc + (isNaN(custo) ? 0 : custo);
    }, 0);
  });

  readonly totalAtivos = computed(() => this.posicoes().length);

  ngOnInit(): void {
    this.carregarPosicoes();
  }

  carregarPosicoes(): void {
    this.loading.set(true);
    this.errorMessage.set(null);

    this.carteiraService.getPosicoes(true).subscribe({
      next: (dados) => {
        this.posicoes.set(dados);
        this.loading.set(false);
      },
      error: (err) => {
        console.error('Erro ao carregar posições:', err);
        this.errorMessage.set('Não foi possível carregar a carteira. Verifique se o backend está ativo.');
        this.loading.set(false);
      }
    });
  }

  formatarMoeda(valor: string | number): string {
    const num = typeof valor === 'string' ? parseFloat(valor) : valor;
    if (isNaN(num)) return 'R$ 0,00';
    return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }

  formatarQuantidade(valor: string | number, tipo?: string): string {
    const num = typeof valor === 'string' ? parseFloat(valor) : valor;
    if (isNaN(num)) return '0';
    if (tipo === 'Cripto') {
      return num.toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 8 });
    }
    return num.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
  }

  getBadgeClass(tipo?: string): string {
    switch (tipo) {
      case 'Acao': return 'badge-acao';
      case 'FII': return 'badge-fii';
      case 'Cripto': return 'badge-cripto';
      case 'RendaFixa': return 'badge-rf';
      default: return 'badge-default';
    }
  }
}
