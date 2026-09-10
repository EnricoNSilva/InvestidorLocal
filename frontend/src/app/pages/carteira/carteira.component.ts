import { Component, OnInit, inject, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CarteiraService } from '../../core/services/carteira.service';
import { PosicaoConsolidada, Carteira } from '../../core/models/investimento.models';

@Component({
  selector: 'app-carteira',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './carteira.component.html',
  styleUrl: './carteira.component.scss',
})
export class CarteiraComponent implements OnInit {
  readonly carteiraService = inject(CarteiraService);

  readonly posicoes = signal<PosicaoConsolidada[]>([]);
  readonly loading = signal<boolean>(true);
  readonly errorMessage = signal<string | null>(null);

  // Controle de Modal / Form de Nova Carteira
  readonly showModalNovaCarteira = signal<boolean>(false);
  novoNomeCarteira = '';
  novaDescricaoCarteira = '';
  readonly salvandoCarteira = signal<boolean>(false);
  readonly erroModalCarteira = signal<string | null>(null);

  // Controle de Exclusão de Carteira
  readonly excluindoCarteira = signal<boolean>(false);
  readonly limpandoCarteira = signal<boolean>(false);

  readonly carteiraAtiva = computed<Carteira | null>(() => {
    const ativas = this.carteiraService.carteiras();
    const id = this.carteiraService.carteiraAtivaId();
    return ativas.find((c) => c.id === id) ?? ativas[0] ?? null;
  });

  readonly carteiraNome = computed(() => this.carteiraAtiva()?.nome || 'Carteira Consolidada');
  readonly carteiraDescricao = computed(
    () =>
      this.carteiraAtiva()?.descricao ||
      'Posições ativas com cálculo de Custo Médio Ponderado Móvel (CMPM)',
  );

  readonly totalPatrimonioCusto = computed(() => {
    return this.posicoes().reduce((acc, pos) => {
      const custo =
        typeof pos.custo_total_brl === 'string'
          ? parseFloat(pos.custo_total_brl)
          : pos.custo_total_brl;
      return acc + (isNaN(custo) ? 0 : custo);
    }, 0);
  });

  readonly totalAtivos = computed(() => this.posicoes().length);

  constructor() {
    // Reage automaticamente à mudança da carteira ativa
    effect(() => {
      const activeId = this.carteiraService.carteiraAtivaId();
      if (activeId) {
        this.carregarPosicoes(activeId);
      }
    });
  }

  ngOnInit(): void {
    this.carregarPosicoes();
  }

  onCarteiraChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const novoId = Number(select.value);
    if (!isNaN(novoId)) {
      this.carteiraService.selecionarCarteira(novoId);
    }
  }

  carregarPosicoes(carteiraId?: number): void {
    this.loading.set(true);
    this.errorMessage.set(null);

    this.carteiraService.getPosicoes(carteiraId, true).subscribe({
      next: (dados) => {
        this.posicoes.set(dados);
        this.loading.set(false);
      },
      error: (err) => {
        console.error('Erro ao carregar posições:', err);
        this.errorMessage.set(
          'Não foi possível carregar a carteira. Verifique se o backend está ativo.',
        );
        this.loading.set(false);
      },
    });
  }

  abrirModalNovaCarteira(): void {
    this.novoNomeCarteira = '';
    this.novaDescricaoCarteira = '';
    this.erroModalCarteira.set(null);
    this.showModalNovaCarteira.set(true);
  }

  fecharModalNovaCarteira(): void {
    this.showModalNovaCarteira.set(false);
    this.erroModalCarteira.set(null);
  }

  salvarNovaCarteira(): void {
    if (!this.novoNomeCarteira.trim()) {
      this.erroModalCarteira.set('O nome da carteira é obrigatório.');
      return;
    }

    this.salvandoCarteira.set(true);
    this.erroModalCarteira.set(null);

    this.carteiraService
      .criarCarteira({
        nome: this.novoNomeCarteira.trim(),
        descricao: this.novaDescricaoCarteira.trim() || undefined,
      })
      .subscribe({
        next: () => {
          this.salvandoCarteira.set(false);
          this.fecharModalNovaCarteira();
        },
        error: (err) => {
          this.salvandoCarteira.set(false);
          const msg = err.error?.detail || 'Erro ao criar nova carteira.';
          this.erroModalCarteira.set(msg);
        },
      });
  }

  confirmarExcluirCarteira(): void {
    const carteira = this.carteiraAtiva();
    if (!carteira) return;

    if (this.carteiraService.carteiras().length <= 1) {
      alert('Você possui apenas uma carteira cadastrada. Não é possível excluí-la.');
      return;
    }

    const confirmou = confirm(
      `Deseja realmente excluir a carteira "${carteira.nome}"?\nTodas as posições e transações vinculadas a ela serão excluídas definitivamente.`,
    );
    if (!confirmou) return;

    this.excluindoCarteira.set(true);
    this.carteiraService.excluirCarteira(carteira.id).subscribe({
      next: () => {
        this.excluindoCarteira.set(false);
      },
      error: (err) => {
        this.excluindoCarteira.set(false);
        const msg = err.error?.detail || 'Erro ao excluir carteira.';
        alert(msg);
      },
    });
  }

  confirmarLimparCarteira(): void {
    const carteira = this.carteiraAtiva();
    if (!carteira) return;

    const confirmou = confirm(
      `Deseja realmente zerar todas as transações e posições da carteira "${carteira.nome}"?\nOs ativos serão limpos para permitir uma nova importação limpa.`,
    );
    if (!confirmou) return;

    this.limpandoCarteira.set(true);
    this.carteiraService.limparCarteira(carteira.id).subscribe({
      next: () => {
        this.limpandoCarteira.set(false);
        this.carregarPosicoes(carteira.id);
      },
      error: (err) => {
        this.limpandoCarteira.set(false);
        const msg = err.error?.detail || 'Erro ao limpar dados da carteira.';
        alert(msg);
      },
    });
  }

  formatarMoeda(valor: string | number): string {
    const num = typeof valor === 'string' ? parseFloat(valor) : valor;
    if (isNaN(num)) return 'R$ 0,00';
    return num.toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  }

  formatarPrecoMedio(pos: PosicaoConsolidada): string {
    const custo =
      typeof pos.custo_total_brl === 'string'
        ? parseFloat(pos.custo_total_brl)
        : pos.custo_total_brl;
    const pm =
      typeof pos.preco_medio_brl === 'string'
        ? parseFloat(pos.preco_medio_brl)
        : pos.preco_medio_brl;
    if (isNaN(custo) || custo <= 0 || isNaN(pm) || pm <= 0) {
      return 'R$ 0,00 (A definir)';
    }
    return this.formatarMoeda(pm);
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
      case 'Acao':
        return 'badge-acao';
      case 'FII':
        return 'badge-fii';
      case 'Cripto':
        return 'badge-cripto';
      case 'RendaFixa':
        return 'badge-rf';
      default:
        return 'badge-default';
    }
  }
}
