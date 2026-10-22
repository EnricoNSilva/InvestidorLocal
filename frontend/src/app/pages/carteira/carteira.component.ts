import {
  Component,
  OnInit,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CarteiraStore } from './state/carteira.store';
import { CarteiraService } from '../../core/services/carteira.service';
import {
  Ativo,
  Carteira,
  FiltroClasseCarteira,
  PosicaoEnriquecida,
} from '../../core/models/investimento.models';
import { CarteiraAllocationChartComponent } from './charts/carteira-allocation-chart.component';
import { CarteiraConcentrationChartComponent } from './charts/carteira-concentration-chart.component';
import { CarteiraProventosChartComponent } from './charts/carteira-proventos-chart.component';
import { AjustePosicaoModalComponent, AjusteSalvoEvent } from './modals/ajuste-posicao-modal.component';
import { HistoricoAtivoModalComponent } from './modals/historico-ativo-modal.component';
import { NovaOperacaoModalComponent } from './modals/nova-operacao-modal.component';

@Component({
  selector: 'app-carteira',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    CarteiraAllocationChartComponent,
    CarteiraConcentrationChartComponent,
    CarteiraProventosChartComponent,
    AjustePosicaoModalComponent,
    HistoricoAtivoModalComponent,
    NovaOperacaoModalComponent,
  ],
  templateUrl: './carteira.component.html',
  styleUrl: './carteira.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CarteiraComponent implements OnInit {
  readonly store = inject(CarteiraStore);
  readonly carteiraService = inject(CarteiraService);

  // Filtro extra opcional: Somente ativos com PM a definir
  readonly filtrarApenasCustoPendente = signal<boolean>(false);

  // Feedback Visual / Responsividade
  readonly toastSucesso = signal<string | null>(null);
  readonly ultimoAtivoAtualizadoId = signal<number | null>(null);
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  // Modais de Gestão de Ativos / Operações
  readonly modalAjusteAberto = signal<boolean>(false);
  readonly ativoParaAjuste = signal<PosicaoEnriquecida | null>(null);

  readonly modalHistoricoAberto = signal<boolean>(false);
  readonly ativoParaHistorico = signal<PosicaoEnriquecida | null>(null);

  readonly modalNovaOperacaoAberto = signal<boolean>(false);

  // Modal Nova Carteira
  readonly showModalNovaCarteira = signal<boolean>(false);
  novoNomeCarteira = '';
  novaDescricaoCarteira = '';
  readonly salvandoCarteira = signal<boolean>(false);
  readonly erroModalCarteira = signal<string | null>(null);

  // Ações de Carteira
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
      'Posições consolidadas com foco em Ações, FIIs, Cotações B3 e Proventos',
  );

  // Posições exibidas na tabela (Ativas ou Encerradas)
  readonly posicoesTabela = computed<PosicaoEnriquecida[]>(() => {
    if (this.store.visaoCustodia() === 'ENCERRADAS') {
      const pos = this.store.posicoesFiltradasEncerradas();
      if (this.filtrarApenasCustoPendente()) {
        return pos.filter((p) => p.custoPendente || p.quantidadeSemCusto > 0);
      }
      return pos;
    }
    const pos = this.store.posicoesFiltradasAtivas();
    if (this.filtrarApenasCustoPendente()) {
      return pos.filter((p) => p.custoPendente);
    }
    return pos;
  });

  getDataPrimeiroLote(pos: PosicaoEnriquecida): string {
    if (pos.lotesPendentes && pos.lotesPendentes.length > 0) {
      const d = pos.lotesPendentes[0].data;
      if (d) {
        const parts = String(d).substring(0, 10).split('-');
        if (parts.length === 3) {
          return `${parts[2]}/${parts[1]}/${parts[0]}`;
        }
        return String(d);
      }
    }
    return '23/03/2022';
  }

  selecionarVisaoCustodia(visao: 'ATIVAS' | 'ENCERRADAS'): void {
    this.store.setVisaoCustodia(visao);
  }

  // Lista de ativos únicos para o modal de nova operação
  readonly ativosDisponiveis = computed<Ativo[]>(() => {
    const mapa = new Map<number, Ativo>();
    for (const p of this.store.posicoesEnriquecidas()) {
      if (p.ativo && !mapa.has(p.ativo.id)) {
        mapa.set(p.ativo.id, p.ativo);
      }
    }
    return Array.from(mapa.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
  });

  ngOnInit(): void {
    const id = this.carteiraService.carteiraAtivaId();
    if (id) {
      this.store.carregarDados(id).catch(() => {});
    }
  }

  // ---------- Filtros e Ações de Header ----------

  selecionarAbaClasse(classe: FiltroClasseCarteira): void {
    this.store.setFiltroClasse(classe);
  }

  onBuscaChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.store.setBuscaTexto(input.value);
  }

  limparBusca(): void {
    this.store.setBuscaTexto('');
  }

  toggleFiltroCustoPendente(): void {
    this.filtrarApenasCustoPendente.update((v) => !v);
  }

  atualizarCotacoes(): void {
    this.store.atualizarCotacoes(true);
  }

  recalcularCarteira(): void {
    this.store.recalcular();
  }

  // ---------- Feedback Visual e Toasts ----------

  onPosicaoSalva(evento?: AjusteSalvoEvent | { mensagem?: string; ativoId?: number }): void {
    if (evento?.mensagem) {
      this.exibirToast(evento.mensagem);
    }
    if (evento?.ativoId) {
      this.ultimoAtivoAtualizadoId.set(evento.ativoId);
      setTimeout(() => {
        if (this.ultimoAtivoAtualizadoId() === evento.ativoId) {
          this.ultimoAtivoAtualizadoId.set(null);
        }
      }, 4000);
    }
  }

  exibirToast(msg: string): void {
    this.toastSucesso.set(msg);
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
    }
    this.toastTimer = setTimeout(() => {
      this.toastSucesso.set(null);
    }, 5000);
  }

  fecharToast(): void {
    this.toastSucesso.set(null);
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
  }

  // ---------- Ordenação de Tabela ----------

  ordenarPor(campo: string): void {
    this.store.setOrdenacao(campo);
  }

  // ---------- Modais ----------

  abrirModalNovaOperacao(): void {
    this.modalNovaOperacaoAberto.set(true);
  }

  fecharModalNovaOperacao(): void {
    this.modalNovaOperacaoAberto.set(false);
  }

  abrirModalAjuste(pos: PosicaoEnriquecida): void {
    this.ativoParaAjuste.set(pos);
    this.modalAjusteAberto.set(true);
  }

  fecharModalAjuste(): void {
    this.modalAjusteAberto.set(false);
    this.ativoParaAjuste.set(null);
  }

  abrirModalHistorico(pos: PosicaoEnriquecida): void {
    this.ativoParaHistorico.set(pos);
    this.modalHistoricoAberto.set(true);
  }

  fecharModalHistorico(): void {
    this.modalHistoricoAberto.set(false);
    this.ativoParaHistorico.set(null);
  }

  confirmarExcluirAtivo(pos: PosicaoEnriquecida): void {
    const confirmou = confirm(
      `Deseja realmente excluir o ativo "${pos.ativo.ticker}" e todas as suas operações desta carteira?\nEssa ação não pode ser desfeita.`
    );
    if (!confirmou) return;

    this.store.excluirAtivo(pos.ativo.id).catch((err) => {
      alert((err as { error?: { detail?: string } })?.error?.detail || 'Erro ao excluir ativo.');
    });
  }

  // ---------- Gestão de Carteira (Barra Superior) ----------

  onCarteiraChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const novoId = Number(select.value);
    if (!isNaN(novoId)) {
      this.carteiraService.selecionarCarteira(novoId);
    }
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
      `Deseja realmente excluir a carteira "${carteira.nome}"?\nTodas as posições e transações vinculadas a ela serão excluídas definitivamente.`
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
      `Deseja realmente zerar todas as transações e posições da carteira "${carteira.nome}"?\nOs ativos serão limpos para permitir uma nova importação limpa.`
    );
    if (!confirmou) return;

    this.limpandoCarteira.set(true);
    this.carteiraService.limparCarteira(carteira.id).subscribe({
      next: () => {
        this.limpandoCarteira.set(false);
        this.store.carregarDados(carteira.id, false);
      },
      error: (err) => {
        this.limpandoCarteira.set(false);
        const msg = err.error?.detail || 'Erro ao limpar dados da carteira.';
        alert(msg);
      },
    });
  }

  // ---------- Formatadores Visuais ----------

  formatarMoeda(valor: number): string {
    if (isNaN(valor)) return 'R$ 0,00';
    return valor.toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
      minimumFractionDigits: 2,
    });
  }

  formatarUsd(valor: number | null | undefined): string {
    if (valor == null || isNaN(valor)) return 'US$ 0,00';
    return 'US$ ' + valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  formatarPercentual(valor: number, comSinal = true): string {
    if (isNaN(valor)) return '0,00%';
    const sinal = comSinal && valor > 0 ? '+' : '';
    return `${sinal}${valor.toFixed(2).replace('.', ',')}%`;
  }

  formatarQuantidade(valor: number, tipo?: string): string {
    if (isNaN(valor)) return '0';
    if (tipo === 'Cripto') {
      return valor.toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 8 });
    }
    return valor.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
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

  getBadgeCotacao(pos: PosicaoEnriquecida): { text: string; classe: string } {
    switch (pos.fonteCotacao) {
      case 'MANUAL':
        return { text: '✏️ Manual', classe: 'quote-manual' };
      case 'YAHOO':
        return { text: '🟢 B3', classe: 'quote-b3' };
      case 'BRAPI':
        return { text: '🟢 BRAPI', classe: 'quote-b3' };
      case 'CACHE':
        return { text: '🟡 Cache', classe: 'quote-cache' };
      case 'TESOURO':
        return { text: '🏛️ Tesouro', classe: 'quote-tesouro' };
      case 'CURVA_CDI':
        return { text: '📈 Curva CDI', classe: 'quote-cdi' };
      case 'BINANCE':
        return { text: '🟡 Binance Spot', classe: 'quote-binance' };
      default:
        return { text: '⚠️ N/D', classe: 'quote-none' };
    }
  }

  copiarTextoIrpf(pos: PosicaoEnriquecida, event?: Event): void {
    if (event) {
      event.stopPropagation();
    }
    const txt = pos.textoIrpfBensDireitos;
    if (!txt) return;

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(txt).then(() => {
        this.exibirToast(`Declaração IRPF (${pos.codigoRfbIrpf}) copiada com sucesso!`);
      }).catch(() => {
        this.copiarFallback(txt, pos.codigoRfbIrpf || '');
      });
    } else {
      this.copiarFallback(txt, pos.codigoRfbIrpf || '');
    }
  }

  private copiarFallback(txt: string, codigo: string): void {
    try {
      const textArea = document.createElement('textarea');
      textArea.value = txt;
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const copiou = document.execCommand('copy');
      document.body.removeChild(textArea);
      if (copiou) {
        this.exibirToast(`Declaração IRPF (${codigo}) copiada com sucesso!`);
        return;
      }
    } catch (_) {}
    this.exibirToast(`Declaração IRPF (${codigo}): ${txt}`);
  }

  getStatusGeralCotacoes(): { text: string; classe: string } {
    if (this.store.filtroClasse() === 'CRIPTO') {
      const meta = this.store.cotacoesMeta();
      if (this.store.syncingCotacoes()) {
        return { text: '🔄 Sincronizando...', classe: 'badge-syncing' };
      }
      if (meta.stale) {
        return { text: '🟡 Cache Binance', classe: 'quote-binance' };
      }
      return { text: '🟡 Binance API', classe: 'quote-binance' };
    }
    const meta = this.store.cotacoesMeta();
    if (this.store.syncingCotacoes()) {
      return { text: '🔄 Sincronizando...', classe: 'badge-syncing' };
    }
    if (meta.stale) {
      return { text: '🟡 Cache B3', classe: 'badge-cache' };
    }
    return { text: '🟢 B3 / Yahoo', classe: 'badge-online' };
  }
}
