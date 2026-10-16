import {
  Component,
  ChangeDetectionStrategy,
  OnInit,
  inject,
  signal,
  input,
  output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RendaFixaStore } from '../state/renda-fixa.store';
import {
  AtivoRendaFixa,
  AtivoRendaFixaUpdateDto,
  CadastroManualRendaFixaDto,
  Indexador,
  LoteAbertoDto,
  LoteManualCreateDto,
  LoteManualUpdateDto,
  ModalMode,
  ProdutoRendaFixa,
} from '../../../core/models/renda-fixa.models';

export type { ModalMode } from '../../../core/models/renda-fixa.models';

export const DRAFT_STORAGE_KEY = 'il.rendafixa.modal_draft.v1';

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
            @if (mode() === 'EDITAR_TITULO') {
              <span class="icon">✏️</span>
              <h3>Editar Título de Renda Fixa</h3>
            } @else if (mode() === 'EDITAR_LOTE') {
              <span class="icon">✏️</span>
              <h3>Editar Lote de Renda Fixa</h3>
            } @else {
              <span class="icon">💼</span>
              <h3>Cadastro de Renda Fixa</h3>
            }
          </div>
          <button class="close-btn" (click)="close.emit()" title="Fechar">✕</button>
        </div>

        <!-- Mode Toggle (Apenas em modos de criação) -->
        @if (mode() === 'NOVO_TITULO' || mode() === 'NOVO_APORTE') {
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
        }

        <div class="modal-body">
          @if (errorMessage()) {
            <div class="alert alert-danger">{{ errorMessage() }}</div>
          }

          @if (hasRestoredDraft() && (mode() === 'NOVO_TITULO' || mode() === 'NOVO_APORTE')) {
            <div class="alert alert-info draft-banner">
              <span>📝 Rascunho restaurado automaticamente</span>
              <button type="button" class="btn-link" (click)="limparCampos()">Descartar Rascunho</button>
            </div>
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
                  (ngModelChange)="saveDraft()"
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
                  (ngModelChange)="saveDraft()"
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
                  (ngModelChange)="saveDraft()"
                  placeholder="Ex.: Banco Inter"
                  class="form-control"
                />
              </div>

              <div class="form-group">
                <label for="tituloProduto">Produto</label>
                <select
                  id="tituloProduto"
                  [(ngModel)]="produto"
                  (ngModelChange)="onProdutoChange($event); saveDraft()"
                  class="form-control"
                >
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
                <select
                  id="tituloIndexador"
                  [(ngModel)]="indexador"
                  (ngModelChange)="saveDraft()"
                  class="form-control"
                >
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
                  (ngModelChange)="saveDraft()"
                  class="form-control"
                />
              </div>

              <div class="form-group checkboxes-group">
                <label class="checkbox-label">
                  <input type="checkbox" [(ngModel)]="isentoIr" (ngModelChange)="saveDraft()" />
                  <span>Isento de Imposto de Renda (LCI/LCA/CRI/CRA)</span>
                </label>
                <label class="checkbox-label">
                  <input type="checkbox" [(ngModel)]="cobraCustodiaB3" (ngModelChange)="saveDraft()" />
                  <span>Cobra taxa de custódia B3 (0,20% a.a.)</span>
                </label>
              </div>
            </div>

            <!-- Lote Inicial -->
            <div class="lote-section">
              <div class="section-header">
                <h4>💵 Lote Inicial de Aplicação</h4>
                <label class="checkbox-label sub-toggle">
                  <input type="checkbox" [(ngModel)]="incluirLoteInicial" (ngModelChange)="saveDraft()" />
                  <span>Registrar compra inicial agora</span>
                </label>
              </div>

              @if (incluirLoteInicial) {
                <div class="form-grid lote-grid">
                  <div class="form-group">
                    <label for="loteData">Data da Aplicação *</label>
                    <input
                      id="loteData"
                      type="date"
                      [(ngModel)]="loteData"
                      (ngModelChange)="saveDraft()"
                      class="form-control"
                      required
                    />
                  </div>

                  <div class="form-group">
                    <label for="lotePreco">Preço Unitário (R$) *</label>
                    <input
                      id="lotePreco"
                      type="number"
                      step="0.01"
                      [(ngModel)]="lotePreco"
                      (ngModelChange)="saveDraft()"
                      class="form-control"
                      required
                    />
                  </div>

                  <div class="form-group">
                    <label for="loteQtd">Quantidade *</label>
                    <input
                      id="loteQtd"
                      type="number"
                      step="0.00000001"
                      [(ngModel)]="loteQtd"
                      (ngModelChange)="saveDraft()"
                      class="form-control"
                      required
                    />
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
                      (ngModelChange)="saveDraft()"
                      placeholder="Ex: 110 para 110% CDI ou 12.5"
                      class="form-control"
                      required
                    />
                  </div>

                  <div class="form-group">
                    <label for="loteTaxas">Custos / Taxas (R$)</label>
                    <input
                      id="loteTaxas"
                      type="number"
                      step="0.01"
                      [(ngModel)]="loteTaxas"
                      (ngModelChange)="saveDraft()"
                      class="form-control"
                    />
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
                <select
                  id="aporteAtivo"
                  [(ngModel)]="selectedAtivoId"
                  (ngModelChange)="saveDraft()"
                  class="form-control"
                  required
                >
                  @for (a of store.ativos(); track a.id) {
                    <option [value]="a.id">
                      {{ a.ticker }} — {{ a.nome }} ({{ a.detalhes_rf?.indexador || 'RF' }})
                    </option>
                  }
                </select>
              </div>

              <div class="form-group">
                <label for="aporteData">Data da Aplicação *</label>
                <input
                  id="aporteData"
                  type="date"
                  [(ngModel)]="loteData"
                  (ngModelChange)="saveDraft()"
                  class="form-control"
                  required
                />
              </div>

              <div class="form-group">
                <label for="aportePreco">Preço Unitário (R$) *</label>
                <input
                  id="aportePreco"
                  type="number"
                  step="0.01"
                  [(ngModel)]="lotePreco"
                  (ngModelChange)="saveDraft()"
                  class="form-control"
                  required
                />
              </div>

              <div class="form-group">
                <label for="aporteQtd">Quantidade *</label>
                <input
                  id="aporteQtd"
                  type="number"
                  step="0.00000001"
                  [(ngModel)]="loteQtd"
                  (ngModelChange)="saveDraft()"
                  class="form-control"
                  required
                />
              </div>

              <div class="form-group">
                <label for="aporteTaxa">Taxa Contratada (% a.a. ou % do CDI) *</label>
                <input
                  id="aporteTaxa"
                  type="number"
                  step="0.01"
                  [(ngModel)]="loteTaxa"
                  (ngModelChange)="saveDraft()"
                  placeholder="Ex: 110 para 110% CDI"
                  class="form-control"
                  required
                />
              </div>

              <div class="form-group">
                <label for="aporteCustos">Custos / Taxas (R$)</label>
                <input
                  id="aporteCustos"
                  type="number"
                  step="0.01"
                  [(ngModel)]="loteTaxas"
                  (ngModelChange)="saveDraft()"
                  class="form-control"
                />
              </div>
            </div>
          }

          <!-- Modo 3: Editar Título -->
          @if (mode() === 'EDITAR_TITULO') {
            <div class="form-grid">
              <div class="form-group full-width">
                <label for="editTituloNome">Nome do Título *</label>
                <input
                  id="editTituloNome"
                  type="text"
                  [(ngModel)]="nome"
                  placeholder="Ex.: CDB Banco Inter 110% CDI 2028"
                  class="form-control"
                  required
                />
              </div>

              <div class="form-group">
                <label for="editTituloTicker">Código / Ticker</label>
                <input
                  id="editTituloTicker"
                  type="text"
                  [(ngModel)]="ticker"
                  placeholder="Ex.: CDB-INTER-20280115"
                  class="form-control"
                />
              </div>

              <div class="form-group">
                <label for="editTituloEmissor">Emissor</label>
                <input
                  id="editTituloEmissor"
                  type="text"
                  [(ngModel)]="emissor"
                  placeholder="Ex.: Banco Inter"
                  class="form-control"
                />
              </div>

              <div class="form-group">
                <label for="editTituloProduto">Produto</label>
                <select
                  id="editTituloProduto"
                  [(ngModel)]="produto"
                  (ngModelChange)="onProdutoChange($event)"
                  class="form-control"
                >
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
                <label for="editTituloIndexador">Indexador</label>
                <select id="editTituloIndexador" [(ngModel)]="indexador" class="form-control">
                  <option value="CDI">CDI (% ou spread)</option>
                  <option value="SELIC">Selic</option>
                  <option value="PREFIXADO">Prefixado (% a.a.)</option>
                  <option value="IPCA">IPCA+ (% a.a.)</option>
                </select>
              </div>

              <div class="form-group">
                <label for="editTituloVencimento">Data de Vencimento</label>
                <input
                  id="editTituloVencimento"
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
          }

          <!-- Modo 4: Editar Lote -->
          @if (mode() === 'EDITAR_LOTE') {
            <div class="form-grid">
              <div class="form-group">
                <label for="editLoteData">Data da Aplicação *</label>
                <input id="editLoteData" type="date" [(ngModel)]="loteData" class="form-control" required />
              </div>

              <div class="form-group">
                <label for="editLotePreco">Preço Unitário (R$) *</label>
                <input id="editLotePreco" type="number" step="0.01" [(ngModel)]="lotePreco" class="form-control" required />
              </div>

              <div class="form-group">
                <label for="editLoteQtd">Quantidade *</label>
                <input id="editLoteQtd" type="number" step="0.00000001" [(ngModel)]="loteQtd" class="form-control" required />
              </div>

              <div class="form-group">
                <label for="editLoteTaxa">Taxa Contratada (% a.a. ou % do CDI) *</label>
                <input
                  id="editLoteTaxa"
                  type="number"
                  step="0.01"
                  [(ngModel)]="loteTaxa"
                  placeholder="Ex: 110 para 110% CDI ou 12.5"
                  class="form-control"
                  required
                />
              </div>

              <div class="form-group full-width">
                <label for="editLoteTaxas">Custos / Taxas (R$)</label>
                <input id="editLoteTaxas" type="number" step="0.01" [(ngModel)]="loteTaxas" class="form-control" />
              </div>
            </div>
          }
        </div>

        <!-- Footer -->
        <div class="modal-footer">
          @if (mode() === 'NOVO_TITULO' || mode() === 'NOVO_APORTE') {
            <button
              type="button"
              class="btn btn-secondary btn-clear"
              (click)="limparCampos()"
              [disabled]="submitting()"
              title="Limpar formulário e remover rascunho salvo"
            >
              🗑️ Limpar Campos
            </button>
          }
          <div class="footer-actions">
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
              } @else if (mode() === 'EDITAR_TITULO') {
                <span>💾 Salvar Alterações do Título</span>
              } @else if (mode() === 'EDITAR_LOTE') {
                <span>💾 Salvar Alterações do Lote</span>
              } @else {
                <span>💾 Confirmar e Salvar</span>
              }
            </button>
          </div>
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

    .draft-banner {
      background: rgba(56, 189, 248, 0.12);
      border: 1px solid rgba(56, 189, 248, 0.3);
      color: #7dd3fc;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12.5px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .btn-link {
      background: none;
      border: none;
      color: #f87171;
      font-size: 12px;
      cursor: pointer;
      text-decoration: underline;
      padding: 0;
    }

    .btn-link:hover {
      color: #ef4444;
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
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      border-top: 1px solid var(--border-subtle, #1e2c47);
      background: rgba(15, 23, 42, 0.4);
    }

    .footer-actions {
      display: flex;
      gap: 12px;
      margin-left: auto;
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

    .btn-clear {
      background: rgba(239, 68, 68, 0.1);
      border-color: rgba(239, 68, 68, 0.3);
      color: #fca5a5;
    }

    .btn-clear:hover:not(:disabled) {
      background: rgba(239, 68, 68, 0.2);
      border-color: #ef4444;
      color: #fff;
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
export class NovoTituloRfModalComponent implements OnInit {
  readonly store = inject(RendaFixaStore);
  readonly initialMode = input<ModalMode>('NOVO_TITULO');
  readonly editingAtivo = input<AtivoRendaFixa | null>(null);
  readonly editingLote = input<LoteAbertoDto | null>(null);
  readonly close = output<void>();

  readonly mode = signal<ModalMode>('NOVO_TITULO');
  readonly submitting = signal<boolean>(false);
  readonly errorMessage = signal<string | null>(null);
  readonly hasRestoredDraft = signal<boolean>(false);

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
  loteData = this.toLocalIsoDate(new Date());
  lotePreco = 1000;
  loteQtd = 1;
  loteTaxa = 110;
  loteTaxas = 0;

  // Aporte em ativo existente
  selectedAtivoId: number | null = null;

  constructor() {
    const currentAtId = this.store.ativoId();
    const defaultAtivo = currentAtId && currentAtId > 0 ? currentAtId : (this.store.ativos()[0]?.id ?? null);
    this.selectedAtivoId = defaultAtivo;
    this.setDefaultVencimento(3);
  }

  ngOnInit(): void {
    const initMode = this.initialMode();
    this.mode.set(initMode);

    if (initMode === 'EDITAR_TITULO') {
      const at = this.editingAtivo();
      if (at) {
        this.nome = at.nome || '';
        this.ticker = at.ticker || '';
        if (at.detalhes_rf) {
          this.produto = at.detalhes_rf.produto || 'CDB';
          this.indexador = at.detalhes_rf.indexador || 'CDI';
          this.emissor = at.detalhes_rf.emissor || '';
          this.dataVencimento = at.detalhes_rf.data_vencimento || '';
          this.isentoIr = Boolean(at.detalhes_rf.isento_ir);
          this.cobraCustodiaB3 = Boolean(at.detalhes_rf.cobra_custodia_b3);
          if (at.detalhes_rf.percentual_indexador) {
            this.loteTaxa = Number(at.detalhes_rf.percentual_indexador);
          }
        }
      }
    } else if (initMode === 'EDITAR_LOTE') {
      const lote = this.editingLote();
      if (lote) {
        this.loteData = lote.data_compra || this.toLocalIsoDate(new Date());
        this.lotePreco = Number(lote.preco_unitario) || 1000;
        this.loteQtd = Number(lote.quantidade_original) || Number(lote.quantidade_aberta) || 1;
        this.loteTaxa =
          lote.taxa_contratada !== null && lote.taxa_contratada !== undefined
            ? Number(lote.taxa_contratada)
            : 100;
        this.loteTaxas = Number(lote.taxas) || 0;
      }
    } else {
      this.restoreDraft();
    }
  }

  private toLocalIsoDate(d: Date): string {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  setMode(m: ModalMode): void {
    this.mode.set(m);
    this.errorMessage.set(null);
    this.saveDraft();
  }

  onBackdropClick(_e: MouseEvent): void {
    // Proteção de UX (PLANO_CRUD_UX_RF.md §1.2):
    // Clique no backdrop não fecha o modal para evitar descarte acidental de formulário.
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
    this.saveDraft();
  }

  private setDefaultVencimento(years: number): void {
    const d = new Date();
    d.setFullYear(d.getFullYear() + years);
    this.dataVencimento = this.toLocalIsoDate(d);
  }

  saveDraft(): void {
    if (this.mode() === 'EDITAR_TITULO' || this.mode() === 'EDITAR_LOTE') return;
    try {
      const draft = {
        mode: this.mode(),
        nome: this.nome,
        ticker: this.ticker,
        emissor: this.emissor,
        produto: this.produto,
        indexador: this.indexador,
        dataVencimento: this.dataVencimento,
        isentoIr: this.isentoIr,
        cobraCustodiaB3: this.cobraCustodiaB3,
        incluirLoteInicial: this.incluirLoteInicial,
        loteData: this.loteData,
        lotePreco: this.lotePreco,
        loteQtd: this.loteQtd,
        loteTaxa: this.loteTaxa,
        loteTaxas: this.loteTaxas,
        selectedAtivoId: this.selectedAtivoId,
      };
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch (_) {}
  }

  clearDraft(): void {
    try {
      localStorage.removeItem(DRAFT_STORAGE_KEY);
    } catch (_) {}
    this.hasRestoredDraft.set(false);
  }

  restoreDraft(): void {
    try {
      const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d && typeof d === 'object') {
        const hasContent = Boolean(
          (d.nome && d.nome.trim()) ||
          (d.ticker && d.ticker.trim()) ||
          (d.emissor && d.emissor.trim()) ||
          (d.loteQtd && d.loteQtd > 1) ||
          (d.lotePreco && d.lotePreco !== 1000)
        );
        if (!hasContent) return;

        if (d.mode === 'NOVO_TITULO' || d.mode === 'NOVO_APORTE') this.mode.set(d.mode);
        if (d.nome !== undefined) this.nome = d.nome;
        if (d.ticker !== undefined) this.ticker = d.ticker;
        if (d.emissor !== undefined) this.emissor = d.emissor;
        if (d.produto !== undefined) this.produto = d.produto;
        if (d.indexador !== undefined) this.indexador = d.indexador;
        if (d.dataVencimento !== undefined) this.dataVencimento = d.dataVencimento;
        if (d.isentoIr !== undefined) this.isentoIr = d.isentoIr;
        if (d.cobraCustodiaB3 !== undefined) this.cobraCustodiaB3 = d.cobraCustodiaB3;
        if (d.incluirLoteInicial !== undefined) this.incluirLoteInicial = d.incluirLoteInicial;
        if (d.loteData !== undefined) this.loteData = d.loteData;
        if (d.lotePreco !== undefined) this.lotePreco = d.lotePreco;
        if (d.loteQtd !== undefined) this.loteQtd = d.loteQtd;
        if (d.loteTaxa !== undefined) this.loteTaxa = d.loteTaxa;
        if (d.loteTaxas !== undefined) this.loteTaxas = d.loteTaxas;
        if (
          d.selectedAtivoId &&
          this.store.ativos().some((a) => a.id === Number(d.selectedAtivoId))
        ) {
          this.selectedAtivoId = Number(d.selectedAtivoId);
        }
        this.hasRestoredDraft.set(true);
      }
    } catch (_) {}
  }

  limparCampos(): void {
    this.clearDraft();
    this.nome = '';
    this.ticker = '';
    this.emissor = '';
    this.produto = 'CDB';
    this.indexador = 'CDI';
    this.isentoIr = false;
    this.cobraCustodiaB3 = false;
    this.incluirLoteInicial = true;
    this.loteData = this.toLocalIsoDate(new Date());
    this.lotePreco = 1000;
    this.loteQtd = 1;
    this.loteTaxa = 110;
    this.loteTaxas = 0;
    const currentAtId = this.store.ativoId();
    this.selectedAtivoId = currentAtId && currentAtId > 0 ? currentAtId : (this.store.ativos()[0]?.id ?? null);
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
    } else if (this.mode() === 'NOVO_APORTE') {
      if (!this.selectedAtivoId) return false;
      if (!this.loteData) return false;
      if (this.lotePreco <= 0) return false;
      if (this.loteQtd <= 0) return false;
      if (this.loteTaxa === null || isNaN(this.loteTaxa)) return false;
      return true;
    } else if (this.mode() === 'EDITAR_TITULO') {
      if (!this.nome.trim()) return false;
      return true;
    } else if (this.mode() === 'EDITAR_LOTE') {
      if (!this.loteData) return false;
      if (this.lotePreco <= 0) return false;
      if (this.loteQtd <= 0) return false;
      if (this.loteTaxa === null || isNaN(this.loteTaxa)) return false;
      return true;
    }
    return false;
  }

  async salvar(): Promise<void> {
    if (!this.isFormValid()) return;
    this.submitting.set(true);
    this.errorMessage.set(null);

    try {
      if (this.mode() === 'EDITAR_TITULO') {
        const at = this.editingAtivo();
        if (!at) throw new Error('Ativo não especificado para edição');
        const exDet = at.detalhes_rf;
        const payload: AtivoRendaFixaUpdateDto = {
          nome: this.nome.trim(),
          ticker: this.ticker.trim() || undefined,
          detalhes: {
            produto: this.produto,
            indexador: this.indexador,
            emissor: this.emissor.trim() || undefined,
            percentual_indexador:
              this.indexador === 'CDI'
                ? (Number(this.loteTaxa) || 100)
                : (exDet?.percentual_indexador != null ? Number(exDet.percentual_indexador) : null),
            data_vencimento: this.dataVencimento || undefined,
            ano_conversao: exDet?.ano_conversao ?? undefined,
            num_parcelas: exDet?.num_parcelas ?? undefined,
            dia_pagamento: exDet?.dia_pagamento ?? undefined,
            carencia_dias: exDet?.carencia_dias ?? undefined,
            codigo_mercado: exDet?.codigo_mercado ?? undefined,
            data_emissao: exDet?.data_emissao ?? undefined,
            isento_ir: this.isentoIr,
            cobra_custodia_b3: this.cobraCustodiaB3,
          },
        };
        await this.store.atualizarTitulo(at.id, payload);
      } else if (this.mode() === 'EDITAR_LOTE') {
        const lote = this.editingLote();
        if (!lote) throw new Error('Lote não especificado para edição');
        const payload: LoteManualUpdateDto = {
          data_compra: this.loteData,
          quantidade: this.loteQtd,
          preco_unitario: this.lotePreco,
          taxa_contratada: this.loteTaxa,
          taxas: this.loteTaxas || 0,
        };
        await this.store.editarLote(lote.transacao_id, payload);
      } else if (this.mode() === 'NOVO_TITULO') {
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
        this.clearDraft();
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
        this.clearDraft();
      }
      this.close.emit();
    } catch (err: any) {
      this.errorMessage.set(err?.message || 'Falha ao salvar registro');
    } finally {
      this.submitting.set(false);
    }
  }
}
