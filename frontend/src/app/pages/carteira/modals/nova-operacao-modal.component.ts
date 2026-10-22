import {
  Component,
  ChangeDetectionStrategy,
  EventEmitter,
  Output,
  inject,
  input,
  signal,
  effect,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { CarteiraStore } from '../state/carteira.store';
import {
  Ativo,
  TipoAtivo,
  TipoOperacao,
} from '../../../core/models/investimento.models';

export const MODAL_DRAFT_STORAGE_KEY = 'il.carteira.modal_draft.v1';

export interface OperacaoDraft {
  modoNovoAtivo: boolean;
  ativoSelecionadoId: number | null;
  novoTicker: string;
  novoNome: string;
  novoTipo: TipoAtivo;
  novoSetor: string;
  tipoOperacao: TipoOperacao;
  dataOperacao: string;
  quantidade: number;
  precoUnitario: number;
  taxas: number;
}

@Component({
  selector: 'app-nova-operacao-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal-overlay" *ngIf="isOpen()" (click)="$event.stopPropagation()">
      <div class="modal-container" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <div>
            <h3 class="modal-title">Nova Operação / Lançar Provento</h3>
            <span class="modal-subtitle">
              Cadastre compras, vendas ou proventos em dinheiro na carteira ativa
            </span>
          </div>
          <button type="button" class="btn-close" (click)="onFechar()" [disabled]="salvando()">
            &times;
          </button>
        </div>

        <div class="modal-body">
          <div *ngIf="erro()" class="alert-box error">
            <span>{{ erro() }}</span>
          </div>

          <div *ngIf="rascunhoRecuperado()" class="alert-box draft-hint">
            <span>📝 Rascunho anterior recuperado automaticamente.</span>
          </div>

          <!-- Tipo de Operação -->
          <div class="form-group">
            <label for="opTipo">Tipo de Operação / Evento *</label>
            <select
              id="opTipo"
              class="form-control"
              [(ngModel)]="tipoOperacao"
              (ngModelChange)="salvarRascunho()"
            >
              <optgroup label="Movimentação de Estoque">
                <option value="BUY">🟢 Compra (BUY)</option>
                <option value="SELL">🔴 Venda (SELL)</option>
                <option value="BONIFICACAO">🎁 Bonificação (Ações)</option>
              </optgroup>
              <optgroup label="Proventos em Dinheiro">
                <option value="DIVIDENDO">💵 Dividendo (Isento)</option>
                <option value="JCP">💰 Juros sobre Capital Próprio (JCP)</option>
                <option value="RENDIMENTO">🧱 Rendimento FII / FIAGRO</option>
                <option value="RESTITUICAO_CAPITAL">📉 Restituição de Capital (Amortização)</option>
              </optgroup>
            </select>
          </div>

          <!-- Seleção de Ativo ou Criação de Novo Ticker -->
          <div class="ativo-selection-box">
            <div class="toggle-mode-bar">
              <label class="radio-label">
                <input
                  type="radio"
                  name="modoAtivo"
                  [value]="false"
                  [(ngModel)]="modoNovoAtivo"
                  (ngModelChange)="salvarRascunho()"
                />
                <span>Selecionar Ativo Existente</span>
              </label>
              <label class="radio-label">
                <input
                  type="radio"
                  name="modoAtivo"
                  [value]="true"
                  [(ngModel)]="modoNovoAtivo"
                  (ngModelChange)="salvarRascunho()"
                />
                <span>+ Cadastrar Novo Ticker</span>
              </label>
            </div>

            <!-- Seleção Existente -->
            <div class="form-group" *ngIf="!modoNovoAtivo">
              <label for="opAtivoSelect">Ativo *</label>
              <select
                id="opAtivoSelect"
                class="form-control"
                [(ngModel)]="ativoSelecionadoId"
                (ngModelChange)="salvarRascunho()"
              >
                <option [ngValue]="null" disabled>-- Escolha um ativo da carteira --</option>
                <option *ngFor="let a of ativosDisponiveis()" [ngValue]="a.id">
                  {{ a.ticker }} - {{ a.nome }} ({{ a.tipo }})
                </option>
              </select>
            </div>

            <!-- Formulário Novo Ativo -->
            <div class="novo-ativo-grid" *ngIf="modoNovoAtivo">
              <div class="form-group">
                <label for="novoAtivoTicker">Ticker *</label>
                <input
                  id="novoAtivoTicker"
                  type="text"
                  class="form-control font-mono"
                  [(ngModel)]="novoTicker"
                  placeholder="Ex: PETR4, HGLG11"
                  maxlength="30"
                  (ngModelChange)="salvarRascunho()"
                />
              </div>

              <div class="form-group">
                <label for="novoAtivoTipo">Classe / Tipo *</label>
                <select
                  id="novoAtivoTipo"
                  class="form-control"
                  [(ngModel)]="novoTipo"
                  (ngModelChange)="salvarRascunho()"
                >
                  <option value="Acao">Ação</option>
                  <option value="FII">FII</option>
                  <option value="Cripto">Cripto</option>
                  <option value="RendaFixa">Renda Fixa</option>
                </select>
              </div>

              <div class="form-group">
                <label for="novoAtivoNome">Nome da Empresa / Fundo</label>
                <input
                  id="novoAtivoNome"
                  type="text"
                  class="form-control"
                  [(ngModel)]="novoNome"
                  placeholder="Ex: Petrobras PN"
                  maxlength="150"
                  (ngModelChange)="salvarRascunho()"
                />
              </div>

              <div class="form-group">
                <label for="novoAtivoSetor">Setor</label>
                <input
                  id="novoAtivoSetor"
                  type="text"
                  class="form-control"
                  [(ngModel)]="novoSetor"
                  placeholder="Ex: Energia, Galpões Logísticos"
                  maxlength="100"
                  (ngModelChange)="salvarRascunho()"
                />
              </div>
            </div>
          </div>

          <!-- Campos Numéricos da Transação -->
          <div class="form-grid">
            <div class="form-group">
              <label for="opData">Data da Operação *</label>
              <input
                id="opData"
                type="date"
                class="form-control"
                [(ngModel)]="dataOperacao"
                (ngModelChange)="salvarRascunho()"
              />
            </div>

            <div class="form-group">
              <label for="opQtd">
                {{ ehProvento() ? 'Qtd. de Cotas com Direito' : 'Quantidade *' }}
              </label>
              <input
                id="opQtd"
                type="number"
                step="any"
                min="0.00000001"
                class="form-control font-mono"
                [(ngModel)]="quantidade"
                placeholder="0"
                (ngModelChange)="salvarRascunho()"
              />
            </div>

            <div class="form-group">
              <label for="opPreco">
                {{ ehProvento() ? 'Valor Líquido por Ação/Cota (R$) *' : 'Preço Unitário (R$) *' }}
              </label>
              <input
                id="opPreco"
                type="number"
                step="0.0001"
                min="0"
                class="form-control font-mono"
                [(ngModel)]="precoUnitario"
                placeholder="0.00"
                (ngModelChange)="salvarRascunho()"
              />
            </div>

            <div class="form-group">
              <label for="opTaxas">Taxas / Emolumentos (R$)</label>
              <input
                id="opTaxas"
                type="number"
                step="0.01"
                min="0"
                class="form-control font-mono"
                [(ngModel)]="taxas"
                placeholder="0.00"
                (ngModelChange)="salvarRascunho()"
              />
            </div>
          </div>

          <!-- Resumo Financeiro da Operação -->
          <div class="resumo-box">
            <div class="resumo-item">
              <span class="resumo-label">Total Financeiro Estimado:</span>
              <span class="resumo-val font-mono">
                {{ formatarMoeda(quantidade * precoUnitario + (tipoOperacao === 'BUY' ? taxas : -taxas)) }}
              </span>
            </div>
            <span class="resumo-hint" *ngIf="ehProvento()">
              Proventos creditam caixa e incrementam o YoC sem alterar a quantidade de cotas.
            </span>
          </div>
        </div>

        <div class="modal-footer">
          <button
            type="button"
            class="btn-limpar"
            (click)="limparCampos()"
            [disabled]="salvando()"
            title="Limpar todos os campos e descartar o rascunho automático"
          >
            🗑️ Limpar Campos
          </button>

          <div class="footer-right">
            <button
              type="button"
              class="btn-cancel"
              (click)="onFechar()"
              [disabled]="salvando()"
            >
              Cancelar
            </button>
            <button
              type="button"
              class="btn-save"
              (click)="salvar()"
              [disabled]="!formularioValido() || salvando()"
            >
              <span *ngIf="salvando()" class="spinner-inline"></span>
              <span>{{ salvando() ? 'Salvando...' : 'Confirmar Lançamento' }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .modal-overlay {
      position: fixed;
      inset: 0;
      background-color: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(3px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 1.5rem;
      animation: fadeIn 0.2s ease-out;
    }
    .modal-container {
      background-color: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      width: 100%;
      max-width: 660px;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      overflow: hidden;
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding: 1.25rem 1.5rem;
      border-bottom: 1px solid var(--border-color);
      background: rgba(255, 255, 255, 0.02);
    }
    .modal-title {
      font-size: 1.15rem;
      font-weight: 700;
      color: var(--text-main);
      margin: 0;
    }
    .modal-subtitle {
      font-size: 0.82rem;
      color: var(--text-muted);
      margin-top: 0.2rem;
      display: inline-block;
    }
    .btn-close {
      background: none;
      border: none;
      font-size: 1.5rem;
      line-height: 1;
      color: var(--text-muted);
      cursor: pointer;
      padding: 0;
      &:hover:not(:disabled) {
        color: var(--text-main);
      }
    }
    .modal-body {
      padding: 1.5rem;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }
    .alert-box {
      padding: 0.75rem 1rem;
      border-radius: 6px;
      font-size: 0.85rem;
      &.error {
        background-color: rgba(248, 81, 73, 0.15);
        border: 1px solid rgba(248, 81, 73, 0.4);
        color: #ff7b72;
      }
      &.draft-hint {
        background-color: rgba(56, 139, 253, 0.12);
        border: 1px solid rgba(56, 139, 253, 0.3);
        color: #58a6ff;
      }
    }
    .ativo-selection-box {
      background: var(--bg-main);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.85rem;
    }
    .toggle-mode-bar {
      display: flex;
      gap: 1.5rem;
      align-items: center;
    }
    .radio-label {
      display: flex;
      align-items: center;
      gap: 0.45rem;
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-main);
      cursor: pointer;
    }
    .novo-ativo-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
    }
    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      label {
        font-size: 0.8rem;
        font-weight: 600;
        color: var(--text-main);
      }
    }
    .form-control {
      background-color: var(--bg-card);
      border: 1px solid var(--border-color);
      color: var(--text-main);
      border-radius: 6px;
      padding: 0.55rem 0.8rem;
      font-size: 0.88rem;
      outline: none;
      transition: all 0.2s;
      &:focus {
        border-color: var(--primary);
        box-shadow: 0 0 0 2px rgba(35, 134, 54, 0.25);
      }
    }
    .font-mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .resumo-box {
      background: var(--bg-main);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 0.85rem 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
    }
    .resumo-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .resumo-label {
      font-size: 0.84rem;
      color: var(--text-muted);
      font-weight: 500;
    }
    .resumo-val {
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--text-main);
    }
    .resumo-hint {
      font-size: 0.75rem;
      color: #3fb950;
    }
    .modal-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
      padding: 1rem 1.5rem;
      background-color: rgba(22, 27, 34, 0.5);
      border-top: 1px solid var(--border-color);
    }
    .footer-right {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .btn-limpar {
      background: transparent;
      border: 1px solid rgba(248, 81, 73, 0.4);
      color: #ff7b72;
      padding: 0.55rem 0.9rem;
      border-radius: 6px;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      &:hover:not(:disabled) {
        background: rgba(248, 81, 73, 0.15);
      }
      &:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
    }
    .btn-cancel {
      background: transparent;
      border: 1px solid var(--border-color);
      color: var(--text-muted);
      padding: 0.55rem 1rem;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      &:hover:not(:disabled) {
        color: var(--text-main);
        border-color: #8b949e;
      }
    }
    .btn-save {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      background-color: var(--primary);
      border: none;
      color: #fff;
      padding: 0.55rem 1.25rem;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      transition: background-color 0.2s;
      &:hover:not(:disabled) {
        background-color: var(--primary-hover);
      }
      &:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
    }
    .spinner-inline {
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      100% { transform: rotate(360deg); }
    }
  `],
})
export class NovaOperacaoModalComponent {
  readonly isOpen = input<boolean>(false);
  readonly ativosDisponiveis = input<Ativo[]>([]);

  @Output() readonly fechar = new EventEmitter<void>();
  @Output() readonly salvo = new EventEmitter<void>();

  private readonly store = inject(CarteiraStore);

  readonly salvando = signal<boolean>(false);
  readonly erro = signal<string | null>(null);
  readonly rascunhoRecuperado = signal<boolean>(false);

  // Campos do formulário
  tipoOperacao: TipoOperacao = 'BUY';
  modoNovoAtivo = false;
  ativoSelecionadoId: number | null = null;
  novoTicker = '';
  novoNome = '';
  novoTipo: TipoAtivo = 'Acao';
  novoSetor = '';
  dataOperacao: string = new Date().toISOString().substring(0, 10);
  quantidade = 0;
  precoUnitario = 0;
  taxas = 0;

  constructor() {
    effect(() => {
      const open = this.isOpen();
      if (open) {
        this.carregarRascunho();
      }
    });
  }

  ehProvento(): boolean {
    return [
      'DIVIDENDO',
      'JCP',
      'RENDIMENTO',
      'RESTITUICAO_CAPITAL',
    ].includes(this.tipoOperacao);
  }

  formularioValido(): boolean {
    if (this.modoNovoAtivo) {
      if (!this.novoTicker.trim()) return false;
    } else {
      if (!this.ativoSelecionadoId) return false;
    }
    if (this.quantidade <= 0) return false;
    if (this.precoUnitario < 0) return false;
    if (!this.dataOperacao || isNaN(Date.parse(this.dataOperacao))) return false;
    return true;
  }

  salvarRascunho(): void {
    try {
      const draft: OperacaoDraft = {
        modoNovoAtivo: this.modoNovoAtivo,
        ativoSelecionadoId: this.ativoSelecionadoId,
        novoTicker: this.novoTicker,
        novoNome: this.novoNome,
        novoTipo: this.novoTipo,
        novoSetor: this.novoSetor,
        tipoOperacao: this.tipoOperacao,
        dataOperacao: this.dataOperacao,
        quantidade: this.quantidade,
        precoUnitario: this.precoUnitario,
        taxas: this.taxas,
      };
      localStorage.setItem(MODAL_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch (_) {}
  }

  carregarRascunho(): void {
    try {
      const saved = localStorage.getItem(MODAL_DRAFT_STORAGE_KEY);
      if (saved) {
        const d: OperacaoDraft = JSON.parse(saved);
        this.modoNovoAtivo = Boolean(d.modoNovoAtivo);
        if (!this.modoNovoAtivo && d.ativoSelecionadoId) {
          const ativos = this.ativosDisponiveis();
          const existe = ativos.length === 0 || ativos.some((a) => a.id === d.ativoSelecionadoId);
          this.ativoSelecionadoId = existe ? d.ativoSelecionadoId : null;
        } else {
          this.ativoSelecionadoId = d.ativoSelecionadoId;
        }
        this.novoTicker = d.novoTicker || '';
        this.novoNome = d.novoNome || '';
        this.novoTipo = d.novoTipo || 'Acao';
        this.novoSetor = d.novoSetor || '';
        this.tipoOperacao = d.tipoOperacao || 'BUY';
        this.dataOperacao = d.dataOperacao || new Date().toISOString().substring(0, 10);
        this.quantidade = Number(d.quantidade) || 0;
        this.precoUnitario = Number(d.precoUnitario) || 0;
        this.taxas = Number(d.taxas) || 0;
        this.rascunhoRecuperado.set(true);
        return;
      }
    } catch (_) {}

    this.resetarCampos();
  }

  limparCampos(): void {
    try {
      localStorage.removeItem(MODAL_DRAFT_STORAGE_KEY);
    } catch (_) {}
    this.resetarCampos();
    this.rascunhoRecuperado.set(false);
  }

  resetarCampos(): void {
    this.tipoOperacao = 'BUY';
    this.modoNovoAtivo = false;
    this.ativoSelecionadoId = null;
    this.novoTicker = '';
    this.novoNome = '';
    this.novoTipo = 'Acao';
    this.novoSetor = '';
    this.dataOperacao = new Date().toISOString().substring(0, 10);
    this.quantidade = 0;
    this.precoUnitario = 0;
    this.taxas = 0;
    this.erro.set(null);
  }

  onFechar(): void {
    this.fechar.emit();
  }

  async salvar(): Promise<void> {
    if (!this.formularioValido()) return;

    this.salvando.set(true);
    this.erro.set(null);

    try {
      let ativoId = this.ativoSelecionadoId;

      // Se for novo ativo, cria o ativo antes via service
      if (this.modoNovoAtivo) {
        const novoAtivoResp = await firstValueFrom(
          this.store.carteiraService.criarAtivo({
            ticker: this.novoTicker.trim().toUpperCase(),
            nome: this.novoNome.trim() || this.novoTicker.trim().toUpperCase(),
            tipo: this.novoTipo,
            setor: this.novoSetor.trim() || undefined,
          }),
        );
        if (novoAtivoResp?.id) {
          ativoId = novoAtivoResp.id;
        } else {
          throw new Error('Falha ao cadastrar novo ativo.');
        }
      }

      if (!ativoId) {
        throw new Error('Ativo inválido.');
      }

      const carteiraId = this.store.carteiraService.carteiraAtivaId();

      await this.store.criarTransacao({
        carteira_id: carteiraId,
        ativo_id: ativoId,
        tipo_operacao: this.tipoOperacao,
        data_hora: new Date(this.dataOperacao + 'T12:00:00Z').toISOString(),
        quantidade: Number(this.quantidade),
        preco_unitario: Number(this.precoUnitario),
        taxas: Number(this.taxas) || 0,
      });

      // Limpa o rascunho após sucesso
      try {
        localStorage.removeItem(MODAL_DRAFT_STORAGE_KEY);
      } catch (_) {}

      this.resetarCampos();
      this.salvo.emit();
      this.fechar.emit();
    } catch (err: unknown) {
      const msg =
        (err as { error?: { detail?: string } })?.error?.detail ||
        (err as Error)?.message ||
        'Erro ao lançar operação.';
      this.erro.set(msg);
    } finally {
      this.salvando.set(false);
    }
  }

  formatarMoeda(valor: number): string {
    if (isNaN(valor)) return 'R$ 0,00';
    return valor.toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
      minimumFractionDigits: 2,
    });
  }
}
