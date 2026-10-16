import { Component, ChangeDetectionStrategy, inject, signal, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RendaFixaStore } from '../state/renda-fixa.store';
import {
  Indexador,
  ProdutoRendaFixa,
  CadastroManualRendaFixaDto,
  LoteManualCreateDto,
} from '../../../core/models/renda-fixa.models';

export type ModalMode = 'NOVO_TITULO' | 'NOVO_APORTE';

@Component({
  selector: 'app-novo-titulo-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal-backdrop" (click)="onBackdropClick($event)">
      <div class="modal-dialog">
        <!-- Header -->
        <div class="modal-header">
          <div class="modal-title">
            <span class="icon">💼</span>
            <h3>Cadastro de Renda Fixa</h3>
          </div>
          <button class="close-btn" (click)="close.emit()" title="Fechar">✕</button>
        </div>

        <!-- Mode Toggle -->
        <div class="mode-tabs">
          <button
            type="button"
            class="mode-btn"
            [class.active]="mode() === 'NOVO_TITULO'"
            (click)="setMode('NOVO_TITULO')"
          >
            ➕ Cadastrar Novo Título
          </button>
          <button
            type="button"
            class="mode-btn"
            [class.active]="mode() === 'NOVO_APORTE'"
            (click)="setMode('NOVO_APORTE')"
            [disabled]="store.ativos().length === 0"
          >
            📥 Novo Aporte / Lote
          </button>
        </div>

        <div class="modal-body">
          @if (errorMessage()) {
            <div class="alert alert-danger">{{ errorMessage() }}</div>
          }

          <!-- Modo 1: Novo Título -->
          @if (mode() === 'NOVO_TITULO') {
            <!-- Quick Presets -->
            <div class="presets-section">
              <span class="section-label">⚡ Modelos Rápidos (Presets):</span>
              <div class="preset-chips">
                <button type="button" class="chip-btn" (click)="applyPreset('CDB_CDI')">
                  🏦 CDB 110% CDI
                </button>
                <button type="button" class="chip-btn" (click)="applyPreset('LCI_CDI')">
                  🛡️ LCI 93% CDI (Isenta)
                </button>
                <button type="button" class="chip-btn" (click)="applyPreset('CDB_PRE')">
                  📊 CDB Prefixado 12,5%
                </button>
                <button type="button" class="chip-btn" (click)="applyPreset('TESOURO_SELIC')">
                  🏛️ Tesouro Selic
                </button>
              </div>
            </div>

            <!-- Dados do Ativo -->
            <div class="form-grid">
              <div class="form-group full-width">
                <label for="tituloNome">Nome do Título *</label>
                <input
                  id="tituloNome"
                  type="text"
                  [(ngModel)]="nome"
                  placeholder="Ex.: CDB Banco Inter 110% CDI 2028"
                  class="form-control"
                  required
                />
              </div>

              <div class="form-group">
                <label for="tituloTicker">Código / Ticker (opcional)</label>
                <input
                  id="tituloTicker"
                  type="text"
                  [(ngModel)]="ticker"
                  placeholder="Ex.: CDB-INTER-20280115"
                  class="form-control"
                />
              </div>

              <div class="form-group">
                <label for="tituloEmissor">Emissor</label>
                <input
                  id="tituloEmissor"
                  type="text"
                  [(ngModel)]="emissor"
                  placeholder="Ex.: Banco Inter"
                  class="form-control"
                />
              </div>

              <div class="form-group">
                <label for="tituloProduto">Produto</label>
                <select id="tituloProduto" [(ngModel)]="produto" (ngModelChange)="onProdutoChange($event)" class="form-control">
                  <option value="CDB">CDB</option>
                  <option value="LCI">LCI (Isento)</option>
                  <option value="LCA">LCA (Isento)</option>
                  <option value="LC">LC</option>
                  <option value="TESOURO_SELIC">Tesouro Selic</option>
                  <option value="TESOURO_PREFIXADO">Tesouro Prefixado</option>
                  <option value="TESOURO_IPCA">Tesouro IPCA+</option>
                  <option value="TESOURO_RENDA_MAIS">Tesouro RendA+</option>
                  <option value="OUTRO">Outro</option>
                </select>
              </div>

              <div class="form-group">
                <label for="tituloIndexador">Indexador</label>
                <select id="tituloIndexador" [(ngModel)]="indexador" class="form-control">
                  <option value="CDI">CDI (% ou spread)</option>
                  <option value="SELIC">Selic</option>
                  <option value="PREFIXADO">Prefixado (% a.a.)</option>
                  <option value="IPCA">IPCA+ (% a.a.)</option>
                </select>
              </div>

              <div class="form-group">
                <label for="tituloVencimento">Data de Vencimento</label>
                <input
                  id="tituloVencimento"
                  type="date"
                  [(ngModel)]="dataVencimento"
                  class="form-control"
                />
              </div>

              <div class="form-group checkboxes-group">
                <label class="checkbox-label">
                  <input type="checkbox" [(ngModel)]="isentoIr" />
                  <span>Isento de Imposto de Renda (LCI/LCA/CRI/CRA)</span>
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" [(ngModel)]="cobraCustodiaB3" />
                  <span>Cobra taxa de custódia B3 (0,20% a.a.)</span>
                </label>
              </div>
            </div>

            <!-- Lote Inicial (Opcional mas recomendado) -->
            <div class="lote-section">
              <div class="section-header">
                <h4>💵 Lote Inicial de Aplicação</h4>
                <label class="checkbox-label sub-toggle">
                  <input type="checkbox" [(ngModel)]="incluirLoteInicial" />
                  <span>Registrar compra inicial agora</span>
                </label>
              </div>

              @if (incluirLoteInicial) {
                <div class="form-grid lote-grid">
                  <div class="form-group">
                    <label for="loteData">Data da Aplicação *</label>
                    <input id="loteData" type="date" [(ngModel)]="loteData" class="form-control" required />
                  </div>

                  <div class="form-group">
                    <label for="lotePreco">Preço Unitário (R$) *</label>
                    <input id="lotePreco" type="number" step="0.01" [(ngModel)]="lotePreco" class="form-control" required />
                  </div>

                  <div class="form-group">
                    <label for="loteQtd">Quantidade *</label>
                    <input id="loteQtd" type="number" step="0.00000001" [(ngModel)]="loteQtd" class="form-control" required />
                  </div>

                  <div class="form-group">
                    <label for="loteTaxa">
                      {{ indexador === 'CDI' ? 'Taxa Contratada (% do CDI) *' : 'Taxa Contratada (% a.a.) *' }}
                    </label>
                    <input
                      id="loteTaxa"
                      type="number"
                      step="0.01"
                      [(ngModel)]="loteTaxa"
                      placeholder="Ex: 110 para 110% CDI ou 12.5"
                      class="form-control"
                      required
                    />
                  </div>

                  <div class="form-group">
                    <label for="loteTaxas">Custos / Taxas (R$)</label>
                    <input id="loteTaxas" type="number" step="0.01" [(ngModel)]="loteTaxas" class="form-control" />
                  </div>
                </div>
              }
            </div>
          }

          <!-- Modo 2: Novo Aporte em Ativo Existente -->
          @if (mode() === 'NOVO_APORTE') {
            <div class="form-grid">
              <div class="form-group full-width">
                <label for="aporteAtivo">Selecione o Título de Renda Fixa *</label>
                <select id="aporteAtivo" [(ngModel)]="selectedAtivoId" class="form-control" required>
                  @for (a of store.ativos(); track a.id) {
                    <option [value]="a.id">
                      {{ a.ticker }} — {{ a.nome }} ({{ a.detalhes_rf?.indexador || 'RF' }})
                    </option>
                  }
                </select>
              </div>

              <div class="form-group">
                <label for="aporteData">Data da Aplicação *</label>
                <input id="aporteData" type="date" [(ngModel)]="loteData" class="form-control" required />
              </div>

              <div class="form-group">
                <label for="aportePreco">Preço Unitário (R$) *</label>
                <input id="aportePreco" type="number" step="0.01" [(ngModel)]="lotePreco" class="form-control" required />
              </div>

              <div class="form-group">
                <label for="aporteQtd">Quantidade *</label>
                <input id="aporteQtd" type="number" step="0.00000001" [(ngModel)]="loteQtd" class="form-control" required />
              </div>

              <div class="form-group">
                <label for="aporteTaxa">Taxa Contratada (% a.a. ou % do CDI) *</label>
                <input
                  id="aporteTaxa"
                  type="number"
                  step="0.01"
                  [(ngModel)]="loteTaxa"
                  placeholder="Ex: 110 para 110% CDI"
                  class="form-control"
                  required
                />
              </div>

              <div class="form-group">
                <label for="aporteCustos">Custos / Taxas (R$)</label>
                <input id="aporteCustos" type="number" step="0.01" [(ngModel)]="loteTaxas" class="form-control" />
              </div>
            </div>
          }
        </div>

        <!-- Footer -->
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" (click)="close.emit()" [disabled]="submitting()">
            Cancelar
          </button>
          <button
            type="button"
            class="btn btn-primary"
            (click)="salvar()"
            [disabled]="submitting() || !isFormValid()"
          >
            @if (submitting()) {
              <span>Salvando...</span>
            } @else {
              <span>💾 Confirmar e Salvar</span>
            }
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(10, 15, 29, 0.75);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 16px;
    }

    .modal-dialog {
      background: var(--bg-surface, #141c2e);
      border: 1px solid var(--border-subtle, #1e2c47);
      border-radius: 12px;
      width: 100%;
      max-width: 680px;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
      color: var(--text-primary, #f1f5f9);
      overflow: hidden;
    }

    .modal-header {
      padding: 18px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border-subtle, #1e2c47);
      background: rgba(15, 23, 42, 0.4);
    }

    .modal-title {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .modal-title .icon {
      font-size: 20px;
    }

    .modal-title h3 {
      margin: 0;
      font-size: 18px;
      font-weight: 700;
      color: var(--text-primary, #f1f5f9);
    }

    .close-btn {
      background: none;
      border: none;
      color: var(--text-secondary, #94a3b8);
      font-size: 18px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      transition: background 0.15s, color 0.15s;
    }

    .close-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }

    .mode-tabs {
      display: flex;
      border-bottom: 1px solid var(--border-subtle, #1e2c47);
      background: rgba(15, 23, 42, 0.25);
    }

    .mode-btn {
      flex: 1;
      padding: 12px 16px;
      background: none;
      border: none;
      color: var(--text-secondary, #94a3b8);
      font-weight: 600;
      font-size: 13.5px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.15s ease;
    }

    .mode-btn.active {
      color: #38bdf8;
      border-bottom-color: #38bdf8;
      background: rgba(56, 189, 248, 0.05);
    }

    .mode-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .modal-body {
      padding: 20px 24px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    .alert-danger {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #fca5a5;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
    }

    .presets-section {
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: rgba(30, 41, 59, 0.4);
      padding: 12px 14px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }

    .section-label {
      font-size: 11.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #94a3b8;
    }

    .preset-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .chip-btn {
      background: #1e293b;
      border: 1px solid #334155;
      color: #e2e8f0;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .chip-btn:hover {
      background: #334155;
      border-color: #38bdf8;
      color: #38bdf8;
      transform: translateY(-1px);
    }

    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 14px;
    }

    .full-width {
      grid-column: span 2;
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .form-group label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary, #94a3b8);
    }

    .form-control {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 6px;
      color: #f8fafc;
      padding: 8px 12px;
      font-size: 13.5px;
      outline: none;
      transition: border-color 0.15s;
    }

    .form-control:focus {
      border-color: #38bdf8;
    }

    .checkboxes-group {
      grid-column: span 2;
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 4px;
    }

    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: #cbd5e1;
      cursor: pointer;
    }

    .checkbox-label input {
      accent-color: #38bdf8;
      cursor: pointer;
      width: 16px;
      height: 16px;
    }

    .lote-section {
      background: rgba(15, 23, 42, 0.4);
      border: 1px solid var(--border-subtle, #1e2c47);
      border-radius: 8px;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .section-header h4 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: #e2e8f0;
    }

    .sub-toggle {
      font-size: 12px;
    }

    .modal-footer {
      padding: 16px 24px;
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      border-top: 1px solid var(--border-subtle, #1e2c47);
      background: rgba(15, 23, 42, 0.4);
    }

    .btn {
      padding: 9px 18px;
      border-radius: 6px;
      font-size: 13.5px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.15s ease;
    }

    .btn-secondary {
      background: #1e293b;
      color: #cbd5e1;
      border: 1px solid #334155;
    }

    .btn-secondary:hover:not(:disabled) {
      background: #334155;
    }

    .btn-primary {
      background: #0284c7;
      color: #fff;
    }

    .btn-primary:hover:not(:disabled) {
      background: #0369a1;
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `],
})
export class NovoTituloRfModalComponent {
  readonly store = inject(RendaFixaStore);
  readonly close = output<void>();

  readonly mode = signal<ModalMode>('NOVO_TITULO');
  readonly submitting = signal<boolean>(false);
  readonly errorMessage = signal<string | null>(null);

  // Form Fields - Ativo
  nome = '';
  ticker = '';
  emissor = '';
  produto: ProdutoRendaFixa = 'CDB';
  indexador: Indexador = 'CDI';
  dataVencimento = '';
  isentoIr = false;
  cobraCustodiaB3 = false;

  // Form Fields - Lote
  incluirLoteInicial = true;
  loteData = new Date().toISOString().split('T')[0];
  lotePreco = 1000;
  loteQtd = 1;
  loteTaxa = 110;
  loteTaxas = 0;

  // Aporte em ativo existente
  selectedAtivoId: number | null = null;

  constructor() {
    const defaultAtivo = this.store.ativoId() ?? this.store.ativos()[0]?.id ?? null;
    this.selectedAtivoId = defaultAtivo;
    this.setDefaultVencimento(3);
  }

  setMode(m: ModalMode): void {
    this.mode.set(m);
    this.errorMessage.set(null);
  }

  onBackdropClick(e: MouseEvent): void {
    if ((e.target as HTMLElement).classList.contains('modal-backdrop')) {
      this.close.emit();
    }
  }

  onProdutoChange(prod: ProdutoRendaFixa): void {
    if (prod === 'LCI' || prod === 'LCA') {
      this.isentoIr = true;
      this.cobraCustodiaB3 = false;
    } else if (prod.startsWith('TESOURO_')) {
      this.emissor = 'Tesouro Nacional';
      this.cobraCustodiaB3 = true;
      this.isentoIr = false;
    } else {
      this.isentoIr = false;
      this.cobraCustodiaB3 = false;
    }
  }

  applyPreset(preset: 'CDB_CDI' | 'LCI_CDI' | 'CDB_PRE' | 'TESOURO_SELIC'): void {
    switch (preset) {
      case 'CDB_CDI':
        this.nome = 'CDB Banco Inter 110% CDI';
        this.ticker = '';
        this.emissor = 'Banco Inter';
        this.produto = 'CDB';
        this.indexador = 'CDI';
        this.isentoIr = false;
        this.cobraCustodiaB3 = false;
        this.lotePreco = 1000;
        this.loteQtd = 1;
        this.loteTaxa = 110;
        this.setDefaultVencimento(3);
        break;
      case 'LCI_CDI':
        this.nome = 'LCI Banco Daycoval 93% CDI';
        this.ticker = '';
        this.emissor = 'Banco Daycoval';
        this.produto = 'LCI';
        this.indexador = 'CDI';
        this.isentoIr = true;
        this.cobraCustodiaB3 = false;
        this.lotePreco = 1000;
        this.loteQtd = 1;
        this.loteTaxa = 93;
        this.setDefaultVencimento(2);
        break;
      case 'CDB_PRE':
        this.nome = 'CDB Sofisa Prefixado 12,50%';
        this.ticker = '';
        this.emissor = 'Banco Sofisa';
        this.produto = 'CDB';
        this.indexador = 'PREFIXADO';
        this.isentoIr = false;
        this.cobraCustodiaB3 = false;
        this.lotePreco = 1000;
        this.loteQtd = 1;
        this.loteTaxa = 12.5;
        this.setDefaultVencimento(3);
        break;
      case 'TESOURO_SELIC':
        this.nome = 'Tesouro Selic 2029';
        this.ticker = 'LFT-2029';
        this.emissor = 'Tesouro Nacional';
        this.produto = 'TESOURO_SELIC';
        this.indexador = 'SELIC';
        this.isentoIr = false;
        this.cobraCustodiaB3 = true;
        this.lotePreco = 14500;
        this.loteQtd = 0.1;
        this.loteTaxa = 0.05;
        this.dataVencimento = '2029-03-01';
        break;
    }
  }

  private setDefaultVencimento(years: number): void {
    const d = new Date();
    d.setFullYear(d.getFullYear() + years);
    this.dataVencimento = d.toISOString().split('T')[0];
  }

  isFormValid(): boolean {
    if (this.mode() === 'NOVO_TITULO') {
      if (!this.nome.trim()) return false;
      if (this.incluirLoteInicial) {
        if (!this.loteData) return false;
        if (this.lotePreco <= 0) return false;
        if (this.loteQtd <= 0) return false;
        if (this.loteTaxa === null || isNaN(this.loteTaxa)) return false;
      }
      return true;
    } else {
      if (!this.selectedAtivoId) return false;
      if (!this.loteData) return false;
      if (this.lotePreco <= 0) return false;
      if (this.loteQtd <= 0) return false;
      if (this.loteTaxa === null || isNaN(this.loteTaxa)) return false;
      return true;
    }
  }

  async salvar(): Promise<void> {
    if (!this.isFormValid()) return;
    this.submitting.set(true);
    this.errorMessage.set(null);

    try {
      if (this.mode() === 'NOVO_TITULO') {
        const payload: CadastroManualRendaFixaDto = {
          nome: this.nome.trim(),
          ticker: this.ticker.trim() || undefined,
          detalhes: {
            produto: this.produto,
            indexador: this.indexador,
            emissor: this.emissor.trim() || undefined,
            percentual_indexador: this.indexador === 'CDI' ? Number(this.loteTaxa) || 100 : null,
            data_vencimento: this.dataVencimento || undefined,
            isento_ir: this.isentoIr,
            cobra_custodia_b3: this.cobraCustodiaB3,
          },
          lote_inicial: this.incluirLoteInicial
            ? {
                carteira_id: this.store.carteiraId(),
                data_compra: this.loteData,
                quantidade: this.loteQtd,
                preco_unitario: this.lotePreco,
                taxa_contratada: this.loteTaxa,
                taxas: this.loteTaxas || 0,
              }
            : null,
        };
        await this.store.criarTituloManual(payload);
      } else {
        const ativoId = Number(this.selectedAtivoId);
        const lotePayload: LoteManualCreateDto = {
          carteira_id: this.store.carteiraId(),
          data_compra: this.loteData,
          quantidade: this.loteQtd,
          preco_unitario: this.lotePreco,
          taxa_contratada: this.loteTaxa,
          taxas: this.loteTaxas || 0,
        };
        await this.store.adicionarLote(ativoId, lotePayload);
      }
      this.close.emit();
    } catch (err: any) {
      this.errorMessage.set(err?.message || 'Falha ao salvar registro');
    } finally {
      this.submitting.set(false);
    }
  }
}
