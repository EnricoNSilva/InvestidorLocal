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
import { CarteiraStore } from '../state/carteira.store';
import {
  PosicaoEnriquecida,
  TipoOperacao,
  Transacao,
} from '../../../core/models/investimento.models';

@Component({
  selector: 'app-historico-ativo-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal-overlay" *ngIf="isOpen()" (click)="$event.stopPropagation()">
      <div class="modal-container" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <div>
            <h3 class="modal-title">Histórico de Operações e Proventos</h3>
            <span class="modal-subtitle">
              {{ posicao()?.ativo?.ticker }} - {{ posicao()?.ativo?.nome }}
            </span>
          </div>
          <button type="button" class="btn-close" (click)="onFechar()" [disabled]="processando()">
            &times;
          </button>
        </div>

        <div class="modal-body">
          <div *ngIf="erro()" class="alert-box error">
            <span>{{ erro() }}</span>
          </div>

          <!-- Formulário Rápido de Novo Lançamento para o Ativo -->
          <div class="novo-lancamento-card">
            <h4 class="card-title">+ Lançar Nova Operação / Provento para {{ posicao()?.ativo?.ticker }}</h4>
            <div class="form-row">
              <div class="form-group">
                <label for="histTipo">Tipo</label>
                <select id="histTipo" class="form-control" [(ngModel)]="novoTipo">
                  <option value="BUY">Compra (BUY)</option>
                  <option value="SELL">Venda (SELL)</option>
                  <option value="BONIFICACAO">Bonificação</option>
                  <option value="DIVIDENDO">Dividendo</option>
                  <option value="JCP">JCP</option>
                  <option value="RENDIMENTO">Rendimento FII</option>
                  <option value="RESTITUICAO_CAPITAL">Restituição Capital</option>
                </select>
              </div>

              <div class="form-group">
                <label for="histData">Data</label>
                <input
                  id="histData"
                  type="date"
                  class="form-control"
                  [(ngModel)]="novaData"
                />
              </div>

              <div class="form-group">
                <label for="histQtd">Quantidade</label>
                <input
                  id="histQtd"
                  type="number"
                  step="any"
                  min="0.00000001"
                  class="form-control font-mono"
                  [(ngModel)]="novaQtd"
                  placeholder="Qtd"
                />
              </div>

              <div class="form-group">
                <label for="histPreco">Preço Unit. (R$)</label>
                <input
                  id="histPreco"
                  type="number"
                  step="0.01"
                  min="0"
                  class="form-control font-mono"
                  [(ngModel)]="novoPreco"
                  placeholder="0.00"
                />
              </div>

              <div class="form-group">
                <label for="histTaxas">Taxas (R$)</label>
                <input
                  id="histTaxas"
                  type="number"
                  step="0.01"
                  min="0"
                  class="form-control font-mono"
                  [(ngModel)]="novasTaxas"
                  placeholder="0.00"
                />
              </div>

              <div class="form-group btn-col">
                <button
                  type="button"
                  class="btn-add-op"
                  (click)="adicionarTransacao()"
                  [disabled]="processando() || !novaData || novaQtd <= 0 || novoPreco < 0"
                >
                  Adicionar
                </button>
              </div>
            </div>
          </div>

          <!-- Tabela de Transações -->
          <div class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Tipo</th>
                  <th class="text-right">Quantidade</th>
                  <th class="text-right">Preço Unit. (R$)</th>
                  <th class="text-right">Taxas (R$)</th>
                  <th class="text-right">Total (R$)</th>
                  <th class="text-center">Ações</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngIf="transacoes().length === 0">
                  <td colspan="7" class="text-center empty-cell">
                    Nenhuma operação registrada para este ativo.
                  </td>
                </tr>

                <tr *ngFor="let tx of transacoes()">
                  <ng-container *ngIf="editandoId() !== tx.id; else editRow">
                    <td>{{ formatarData(tx.data_hora) }}</td>
                    <td>
                      <span class="badge" [ngClass]="getBadgeClass(tx.tipo_operacao)">
                        {{ formatarTipo(tx.tipo_operacao) }}
                      </span>
                    </td>
                    <td class="text-right font-mono">{{ formatarNumero(tx.quantidade) }}</td>
                    <td class="text-right font-mono">{{ formatarMoeda(tx.preco_unitario) }}</td>
                    <td class="text-right font-mono">{{ formatarMoeda(tx.taxas) }}</td>
                    <td class="text-right font-mono font-bold">
                      {{ formatarTotal(tx) }}
                    </td>
                    <td class="text-center actions-cell">
                      <button
                        type="button"
                        class="btn-icon"
                        title="Editar transação"
                        (click)="iniciarEdicao(tx)"
                        [disabled]="processando()"
                      >
                        ✏️
                      </button>
                      <button
                        type="button"
                        class="btn-icon delete"
                        title="Excluir transação"
                        (click)="excluirTransacao(tx)"
                        [disabled]="processando()"
                      >
                        🗑️
                      </button>
                    </td>
                  </ng-container>

                  <ng-template #editRow>
                    <td>
                      <input
                        type="date"
                        class="form-control form-control-sm"
                        [(ngModel)]="editData"
                      />
                    </td>
                    <td>
                      <span class="badge" [ngClass]="getBadgeClass(tx.tipo_operacao)">
                        {{ formatarTipo(tx.tipo_operacao) }}
                      </span>
                    </td>
                    <td>
                      <input
                        type="number"
                        step="any"
                        class="form-control form-control-sm font-mono text-right"
                        [(ngModel)]="editQtd"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.01"
                        class="form-control form-control-sm font-mono text-right"
                        [(ngModel)]="editPreco"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.01"
                        class="form-control form-control-sm font-mono text-right"
                        [(ngModel)]="editTaxas"
                      />
                    </td>
                    <td class="text-right font-mono">
                      {{ formatarMoeda(editQtd * editPreco) }}
                    </td>
                    <td class="text-center actions-cell">
                      <button
                        type="button"
                        class="btn-icon save"
                        title="Salvar alterações"
                        (click)="salvarEdicao(tx.id)"
                        [disabled]="processando() || !editData || editQtd <= 0 || editPreco < 0"
                      >
                        💾
                      </button>
                      <button
                        type="button"
                        class="btn-icon cancel"
                        title="Cancelar"
                        (click)="cancelarEdicao()"
                        [disabled]="processando()"
                      >
                        ✕
                      </button>
                    </td>
                  </ng-template>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn-cancel" (click)="onFechar()" [disabled]="processando()">
            Fechar
          </button>
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
      max-width: 820px;
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
    }
    .novo-lancamento-card {
      background: var(--bg-main);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 1rem;
      .card-title {
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text-main);
        margin: 0 0 0.75rem 0;
      }
    }
    .form-row {
      display: flex;
      gap: 0.6rem;
      flex-wrap: wrap;
      align-items: flex-end;
    }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      flex: 1;
      min-width: 100px;
      &.btn-col {
        flex: 0 0 auto;
      }
      label {
        font-size: 0.74rem;
        font-weight: 600;
        color: var(--text-muted);
      }
    }
    .form-control {
      background-color: var(--bg-card);
      border: 1px solid var(--border-color);
      color: var(--text-main);
      border-radius: 6px;
      padding: 0.45rem 0.65rem;
      font-size: 0.82rem;
      outline: none;
      transition: all 0.2s;
      &:focus {
        border-color: var(--primary);
        box-shadow: 0 0 0 2px rgba(35, 134, 54, 0.25);
      }
      &.form-control-sm {
        padding: 0.25rem 0.5rem;
        font-size: 0.78rem;
      }
    }
    .font-mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .font-bold {
      font-weight: 600;
    }
    .btn-add-op {
      background: var(--primary);
      color: #fff;
      border: none;
      padding: 0.5rem 0.9rem;
      border-radius: 6px;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.2s;
      &:hover:not(:disabled) {
        background: var(--primary-hover);
      }
      &:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
    }
    .table-wrapper {
      border: 1px solid var(--border-color);
      border-radius: 8px;
      overflow-x: auto;
      background: var(--bg-card);
    }
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.82rem;
      th, td {
        padding: 0.65rem 0.85rem;
        text-align: left;
      }
      th {
        background-color: rgba(22, 27, 34, 0.8);
        color: var(--text-muted);
        font-weight: 600;
        text-transform: uppercase;
        font-size: 0.72rem;
        letter-spacing: 0.05em;
        border-bottom: 1px solid var(--border-color);
      }
      tr:not(:last-child) td {
        border-bottom: 1px solid var(--border-color);
      }
      tbody tr:hover {
        background-color: var(--bg-card-hover);
      }
    }
    .empty-cell {
      padding: 2rem !important;
      color: var(--text-muted);
    }
    .text-right { text-align: right; }
    .text-center { text-align: center; }
    .actions-cell {
      white-space: nowrap;
    }
    .btn-icon {
      background: none;
      border: none;
      font-size: 0.9rem;
      cursor: pointer;
      padding: 0.2rem 0.35rem;
      border-radius: 4px;
      transition: background 0.15s;
      &:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.1);
      }
      &:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    }
    .badge {
      display: inline-block;
      font-size: 0.72rem;
      font-weight: 600;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
      &.badge-buy {
        background: rgba(56, 139, 253, 0.15);
        color: #58a6ff;
        border: 1px solid rgba(56, 139, 253, 0.4);
      }
      &.badge-sell {
        background: rgba(248, 81, 73, 0.15);
        color: #ff7b72;
        border: 1px solid rgba(248, 81, 73, 0.4);
      }
      &.badge-prov {
        background: rgba(35, 134, 54, 0.15);
        color: #3fb950;
        border: 1px solid rgba(35, 134, 54, 0.4);
      }
      &.badge-other {
        background: rgba(139, 148, 158, 0.15);
        color: #8b949e;
        border: 1px solid var(--border-color);
      }
    }
    .modal-footer {
      display: flex;
      justify-content: flex-end;
      padding: 1rem 1.5rem;
      background-color: rgba(22, 27, 34, 0.5);
      border-top: 1px solid var(--border-color);
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
  `],
})
export class HistoricoAtivoModalComponent {
  readonly posicao = input<PosicaoEnriquecida | null>(null);
  readonly isOpen = input<boolean>(false);

  @Output() readonly fechar = new EventEmitter<void>();
  @Output() readonly atualizado = new EventEmitter<void>();

  private readonly store = inject(CarteiraStore);

  readonly transacoes = this.store.transacoesAtivoModal;
  readonly processando = signal<boolean>(false);
  readonly erro = signal<string | null>(null);

  // Form de Novo Lançamento
  novoTipo: TipoOperacao = 'DIVIDENDO';
  novaData: string = new Date().toISOString().substring(0, 10);
  novaQtd = 1;
  novoPreco = 0;
  novasTaxas = 0;

  // Estado de Edição Inline
  readonly editandoId = signal<number | null>(null);
  editData = '';
  editQtd = 0;
  editPreco = 0;
  editTaxas = 0;

  constructor() {
    effect(() => {
      const p = this.posicao();
      const open = this.isOpen();
      if (open && p) {
        this.store.carregarTransacoesAtivo(p.ativo.id);
        this.erro.set(null);
        this.editandoId.set(null);
        this.novaData = new Date().toISOString().substring(0, 10);
        this.novaQtd = p.quantidade > 0 ? p.quantidade : 1;
        this.novoPreco = 0;
        this.novasTaxas = 0;
      }
    });
  }

  onFechar(): void {
    this.fechar.emit();
  }

  async adicionarTransacao(): Promise<void> {
    const p = this.posicao();
    if (!p) return;

    if (!this.novaData || isNaN(Date.parse(this.novaData))) {
      this.erro.set('Data da operação inválida.');
      return;
    }
    if (this.novaQtd <= 0) {
      this.erro.set('A quantidade deve ser maior que zero.');
      return;
    }
    if (this.novoPreco < 0) {
      this.erro.set('O preço unitário não pode ser negativo.');
      return;
    }

    this.processando.set(true);
    this.erro.set(null);

    try {
      await this.store.criarTransacao({
        carteira_id: this.store.carteiraService.carteiraAtivaId(),
        ativo_id: p.ativo.id,
        tipo_operacao: this.novoTipo,
        data_hora: new Date(this.novaData + 'T12:00:00Z').toISOString(),
        quantidade: Number(this.novaQtd),
        preco_unitario: Number(this.novoPreco),
        taxas: Number(this.novasTaxas) || 0,
      });

      this.novoPreco = 0;
      this.novasTaxas = 0;
      this.atualizado.emit();
    } catch (err: unknown) {
      const msg =
        (err as { error?: { detail?: string } })?.error?.detail ||
        'Erro ao adicionar operação.';
      this.erro.set(msg);
    } finally {
      this.processando.set(false);
    }
  }

  iniciarEdicao(tx: Transacao): void {
    this.editandoId.set(tx.id);
    this.editData = (tx.data_hora || '').substring(0, 10);
    this.editQtd = Number(tx.quantidade) || 0;
    this.editPreco = Number(tx.preco_unitario) || 0;
    this.editTaxas = Number(tx.taxas) || 0;
  }

  cancelarEdicao(): void {
    this.editandoId.set(null);
  }

  async salvarEdicao(transacaoId: number): Promise<void> {
    if (!this.editData || isNaN(Date.parse(this.editData))) {
      this.erro.set('Data da operação inválida.');
      return;
    }
    if (this.editQtd <= 0) {
      this.erro.set('A quantidade deve ser maior que zero.');
      return;
    }
    if (this.editPreco < 0) {
      this.erro.set('O preço unitário não pode ser negativo.');
      return;
    }

    this.processando.set(true);
    this.erro.set(null);

    try {
      await this.store.atualizarTransacao(transacaoId, {
        data_hora: new Date(this.editData + 'T12:00:00Z').toISOString(),
        quantidade: Number(this.editQtd),
        preco_unitario: Number(this.editPreco),
        taxas: Number(this.editTaxas) || 0,
      });

      this.editandoId.set(null);
      this.atualizado.emit();
    } catch (err: unknown) {
      const msg =
        (err as { error?: { detail?: string } })?.error?.detail ||
        'Erro ao atualizar operação.';
      this.erro.set(msg);
    } finally {
      this.processando.set(false);
    }
  }

  async excluirTransacao(tx: Transacao): Promise<void> {
    const confirmou = confirm(
      `Deseja realmente excluir a operação de ${this.formatarTipo(tx.tipo_operacao)} de ${this.formatarData(tx.data_hora)}?\nA carteira será recalculada automaticamente.`
    );
    if (!confirmou) return;

    this.processando.set(true);
    this.erro.set(null);

    try {
      await this.store.excluirTransacao(tx.id);
      this.atualizado.emit();
    } catch (err: unknown) {
      const msg =
        (err as { error?: { detail?: string } })?.error?.detail ||
        'Erro ao excluir operação.';
      this.erro.set(msg);
    } finally {
      this.processando.set(false);
    }
  }

  formatarData(data: string): string {
    if (!data) return '-';
    try {
      const d = new Date(data);
      return d.toLocaleDateString('pt-BR');
    } catch {
      return data;
    }
  }

  formatarNumero(valor: string | number): string {
    const num = Number(valor);
    if (isNaN(num)) return '0';
    return num.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
  }

  formatarMoeda(valor: string | number): string {
    const num = Number(valor);
    if (isNaN(num)) return 'R$ 0,00';
    return num.toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
      minimumFractionDigits: 2,
    });
  }

  formatarTotal(tx: Transacao): string {
    const q = Number(tx.quantidade) || 0;
    const p = Number(tx.preco_unitario) || 0;
    return this.formatarMoeda(q * p);
  }

  formatarTipo(tipo: TipoOperacao): string {
    switch (tipo) {
      case 'BUY': return 'Compra';
      case 'SELL': return 'Venda';
      case 'TRANSFERENCIA_ENTRADA': return 'Transferência';
      case 'BONIFICACAO': return 'Bonificação';
      case 'DIREITO_SUBSCRICAO': return 'Subscrição';
      case 'DIVIDENDO': return 'Dividendo';
      case 'JCP': return 'JCP';
      case 'RENDIMENTO': return 'Rendimento';
      case 'RESTITUICAO_CAPITAL': return 'Restituição';
      default: return tipo;
    }
  }

  getBadgeClass(tipo: TipoOperacao): string {
    switch (tipo) {
      case 'BUY':
        return 'badge-buy';
      case 'SELL':
        return 'badge-sell';
      case 'DIVIDENDO':
      case 'JCP':
      case 'RENDIMENTO':
      case 'RESTITUICAO_CAPITAL':
        return 'badge-prov';
      default:
        return 'badge-other';
    }
  }
}
