import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CarteiraService } from '../../core/services/carteira.service';
import { RetornoImportacao } from '../../core/models/investimento.models';

@Component({
  selector: 'app-importacao',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './importacao.component.html',
  styleUrl: './importacao.component.scss',
})
export class ImportacaoComponent {
  readonly carteiraService = inject(CarteiraService);

  readonly carteiraAtiva = computed(() => {
    const ativas = this.carteiraService.carteiras();
    const id = this.carteiraService.carteiraAtivaId();
    return ativas.find((c) => c.id === id) || ativas[0] || null;
  });

  onCarteiraChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const novoId = Number(select.value);
    if (!isNaN(novoId)) {
      this.carteiraService.selecionarCarteira(novoId);
    }
  }

  // Estado B3 Transferências / Movimentação
  readonly filesB3Transf = signal<File[]>([]);
  readonly loadingB3Transf = signal<boolean>(false);
  readonly resultadoB3Transf = signal<RetornoImportacao | null>(null);
  readonly erroB3Transf = signal<string | null>(null);

  // Estado B3 Negociações
  readonly fileB3 = signal<File | null>(null);
  readonly loadingB3 = signal<boolean>(false);
  readonly resultadoB3 = signal<RetornoImportacao | null>(null);
  readonly erroB3 = signal<string | null>(null);

  // Estado Binance
  readonly fileBinance = signal<File | null>(null);
  readonly loadingBinance = signal<boolean>(false);
  readonly resultadoBinance = signal<RetornoImportacao | null>(null);
  readonly erroBinance = signal<string | null>(null);

  onFileB3TransfSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.filesB3Transf.set(Array.from(input.files));
      this.resultadoB3Transf.set(null);
      this.erroB3Transf.set(null);
    }
  }

  onFileB3Selected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.fileB3.set(input.files[0]);
      this.resultadoB3.set(null);
      this.erroB3.set(null);
    }
  }

  onFileBinanceSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.fileBinance.set(input.files[0]);
      this.resultadoBinance.set(null);
      this.erroBinance.set(null);
    }
  }

  // Estado Reset Renda Fixa
  readonly loadingResetRF = signal<boolean>(false);
  readonly resultadoResetRF = signal<string | null>(null);
  readonly erroResetRF = signal<string | null>(null);
  readonly limparRFAntesImportar = signal<boolean>(false);

  enviarB3Transferencias(): void {
    const files = this.filesB3Transf();
    if (!files || files.length === 0) return;

    this.loadingB3Transf.set(true);
    this.erroB3Transf.set(null);

    if (this.limparRFAntesImportar()) {
      this.carteiraService.resetarRendaFixa().subscribe({
        next: () => this.executarEnvioB3Transf(files),
        error: (err) => {
          this.erroB3Transf.set('Falha ao resetar Renda Fixa antes da importação: ' + (err.error?.detail || err.message));
          this.loadingB3Transf.set(false);
        },
      });
    } else {
      this.executarEnvioB3Transf(files);
    }
  }

  private executarEnvioB3Transf(files: File[]): void {
    this.carteiraService.uploadB3Transferencias(files).subscribe({
      next: (res) => {
        this.resultadoB3Transf.set(res);
        this.loadingB3Transf.set(false);
      },
      error: (err) => {
        console.error('Erro na importação de transferências B3:', err);
        const detail = err.error?.detail || 'Erro ao processar planilha de movimentações da B3.';
        this.erroB3Transf.set(detail);
        this.loadingB3Transf.set(false);
      },
    });
  }

  resetarRendaFixa(): void {
    const nomeCarteira = this.carteiraAtiva()?.nome || 'ativa';
    if (!confirm(`Tem certeza que deseja resetar todas as operações e posições de Renda Fixa da carteira '${nomeCarteira}'? Suas ações, FIIs e criptomoedas permanecerão 100% intactas.`)) {
      return;
    }
    this.loadingResetRF.set(true);
    this.resultadoResetRF.set(null);
    this.erroResetRF.set(null);

    this.carteiraService.resetarRendaFixa().subscribe({
      next: (res) => {
        this.resultadoResetRF.set(res.mensagem);
        this.loadingResetRF.set(false);
      },
      error: (err) => {
        console.error('Erro ao resetar Renda Fixa:', err);
        const detail = err.error?.detail || 'Erro ao resetar Renda Fixa.';
        this.erroResetRF.set(detail);
        this.loadingResetRF.set(false);
      },
    });
  }

  enviarB3(): void {
    const file = this.fileB3();
    if (!file) return;

    this.loadingB3.set(true);
    this.erroB3.set(null);

    this.carteiraService.uploadB3(file).subscribe({
      next: (res) => {
        this.resultadoB3.set(res);
        this.loadingB3.set(false);
      },
      error: (err) => {
        console.error('Erro na importação B3:', err);
        const detail = err.error?.detail || 'Erro ao processar planilha da B3.';
        this.erroB3.set(detail);
        this.loadingB3.set(false);
      },
    });
  }

  enviarBinance(): void {
    const file = this.fileBinance();
    if (!file) return;

    this.loadingBinance.set(true);
    this.erroBinance.set(null);

    this.carteiraService.uploadBinance(file).subscribe({
      next: (res) => {
        this.resultadoBinance.set(res);
        this.loadingBinance.set(false);
      },
      error: (err) => {
        console.error('Erro na importação Binance:', err);
        const detail = err.error?.detail || 'Erro ao processar planilha da Binance.';
        this.erroBinance.set(detail);
        this.loadingBinance.set(false);
      },
    });
  }
}
