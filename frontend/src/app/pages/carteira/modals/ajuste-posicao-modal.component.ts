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
import { CarteiraService } from '../../../core/services/carteira.service';
import {
  PosicaoEnriquecida,
  TipoAtivo,
  LoteTransferenciaPendente,
} from '../../../core/models/investimento.models';

export interface AjusteSalvoEvent {
  ativoId: number;
  ticker: string;
  mensagem: string;
}

@Component({
  selector: 'app-ajuste-posicao-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal-overlay" *ngIf="isOpen()" (click)="$event.stopPropagation()">
      <div class="modal-container" [class.wide-mode]="temLotePendente()" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <div>
            <h3 class="modal-title">Ajustar Posição e Preço Médio</h3>
            <span class="modal-subtitle">
              {{ posicao()?.ativo?.ticker }} - {{ posicao()?.ativo?.nome }}
            </span>
          </div>
          <button type="button" class="btn-close" (click)="onFechar()" [disabled]="salvando()">
            &times;
          </button>
        </div>

        <div class="modal-body">
          <div *ngIf="erro()" class="alert-box error">
            <span class="alert-icon">⚠️</span>
            <span>{{ erro() }}</span>
          </div>

          <!-- Bloco Especial: Resolução de Lotes Transferidos sem Preço Médio -->
          <div
            class="transfer-resolution-box"
            *ngIf="temLotePendente()"
          >
            <div class="box-header">
              <span class="box-icon">⚠️</span>
              <div class="box-header-text">
                <h4 class="box-title">Lotes Transferidos com Custo Pendente</h4>
                <p class="box-desc">
                  Este ativo possui <strong>{{ getQuantidadeSemCustoExibicao() }}</strong> ações transferidas com custo R$ 0,00.
                  Defina o custo histórico de aquisição usando uma das opções abaixo:
                </p>
              </div>
            </div>

            <div class="resolution-options">
              <!-- Opção 1 e 2: Preço Unitário Manual ou Cotação Histórica -->
              <div class="resolution-card">
                <div class="card-badge">Modo A / C</div>
                <h5 class="card-title">Preço Unitário da Transferência</h5>
                <p class="card-hint">
                  Informe o PU ou consulte a cotação de fechamento oficial da B3 no dia da transferência.
                </p>

                <button
                  type="button"
                  class="btn-fetch-quote"
                  (click)="buscarCotacaoHistorica(posicao()?.lotesPendentes?.[0])"
                  [disabled]="buscandoCotacaoHistorica() || salvando()"
                >
                  <span *ngIf="buscandoCotacaoHistorica()" class="spinner-inline"></span>
                  <span>🔍 Puxar Cotação Histórica de {{ formatarDataPtBr(posicao()?.lotesPendentes?.[0]?.data) }}</span>
                </button>

                <div *ngIf="mensagemCotacaoHistorica()" class="quote-feedback">
                  {{ mensagemCotacaoHistorica() }}
                </div>

                <div class="input-block">
                  <label for="puTransfInput">Preço Unitário da Transferência (R$)</label>
                  <input
                    id="puTransfInput"
                    type="number"
                    step="0.01"
                    min="0"
                    class="form-control font-mono"
                    [(ngModel)]="precoUnitarioTransf"
                    (ngModelChange)="onPrecoUnitarioTransfChange($event)"
                    (keyup.enter)="aplicarModoA(posicao()?.lotesPendentes?.[0])"
                    placeholder="Ex: 4.15"
                  />
                </div>

                <div *ngIf="precoUnitarioTransf != null && precoUnitarioTransf > 0" class="preview-box info">
                  <span>💡 Custo do lote transferido ({{ getQuantidadeSemCustoExibicao() }} ações):</span>
                  <strong>{{ formatarMoeda((precoUnitarioTransf || 0) * getQtdSemCustoNum()) }}</strong>
                </div>

                <button
                  type="button"
                  class="btn-apply-resolution primary-action"
                  (click)="aplicarModoA(posicao()?.lotesPendentes?.[0])"
                  [disabled]="salvando() || precoUnitarioTransf == null || precoUnitarioTransf < 0"
                >
                  <span *ngIf="salvando()" class="spinner-inline"></span>
                  <span>{{ salvando() ? 'Aplicando...' : '✅ Aplicar Preço na Transferência' }}</span>
                </button>
              </div>

              <!-- Opção 3: Engenharia Reversa pelo PM Consolidado Atual -->
              <div class="resolution-card">
                <div class="card-badge">Modo B</div>
                <h5 class="card-title">Engenharia Reversa pelo PM Atual</h5>
                <p class="card-hint">
                  Informe o PM exibido no BTG ou na corretora atual. O sistema deduzirá as compras e atribuirá o custo histórico exato às ações transferidas.
                </p>

                <div class="input-block">
                  <label for="pmConsolidadoInput">PM Consolidado na Corretora Atual (R$)</label>
                  <input
                    id="pmConsolidadoInput"
                    type="number"
                    step="0.01"
                    min="0"
                    class="form-control font-mono"
                    [(ngModel)]="pmConsolidadoAtual"
                    (ngModelChange)="onPmConsolidadoAtualChange($event)"
                    (keyup.enter)="aplicarModoB(posicao()?.lotesPendentes?.[0])"
                    placeholder="Ex: 5.40"
                  />
                </div>

                <div *ngIf="pmConsolidadoAtual != null && pmConsolidadoAtual > 0" class="preview-box success">
                  <span>💡 Novo Custo Total Alvo ({{ posicao()?.quantidade }} ações):</span>
                  <strong>{{ formatarMoeda((pmConsolidadoAtual || 0) * (posicao()?.quantidade || 0)) }}</strong>
                </div>

                <button
                  type="button"
                  class="btn-apply-resolution secondary-action"
                  (click)="aplicarModoB(posicao()?.lotesPendentes?.[0])"
                  [disabled]="salvando() || pmConsolidadoAtual == null || pmConsolidadoAtual <= 0"
                >
                  <span *ngIf="salvando()" class="spinner-inline"></span>
                  <span>{{ salvando() ? 'Calculando...' : '⚡ Calcular e Aplicar PM Consolidado' }}</span>
                </button>
              </div>
            </div>
          </div>

          <!-- Formulário Principal de Ajuste de Posição -->
          <div class="section-divider" *ngIf="temLotePendente()">
            <span>Ou edite os dados cadastrais da posição diretamente:</span>
          </div>

          <div class="form-grid">
            <div class="form-group">
              <label for="ajusteTicker">Ticker *</label>
              <input
                id="ajusteTicker"
                type="text"
                class="form-control font-mono"
                [(ngModel)]="tickerAtivo"
                placeholder="Ex: PETR4"
                maxlength="30"
              />
            </div>

            <div class="form-group">
              <label for="ajusteNome">Nome do Ativo</label>
              <input
                id="ajusteNome"
                type="text"
                class="form-control"
                [(ngModel)]="nomeAtivo"
                placeholder="Ex: Petrobras PN"
              />
            </div>

            <div class="form-group">
              <label for="ajusteTipo">Classe / Tipo</label>
              <select id="ajusteTipo" class="form-control" [(ngModel)]="tipoAtivo">
                <option value="Acao">Ação</option>
                <option value="FII">FII</option>
                <option value="Cripto">Cripto</option>
                <option value="RendaFixa">Renda Fixa</option>
              </select>
            </div>

            <div class="form-group">
              <label for="ajusteSetor">Setor</label>
              <input
                id="ajusteSetor"
                type="text"
                class="form-control"
                [(ngModel)]="setorAtivo"
                placeholder="Ex: Petróleo, Energia, Logística"
              />
            </div>

            <div class="form-group">
              <label for="ajusteQtd">Quantidade em Custódia *</label>
              <input
                id="ajusteQtd"
                type="number"
                step="any"
                min="0"
                class="form-control font-mono"
                [(ngModel)]="quantidade"
                placeholder="0"
              />
            </div>

            <div class="form-group">
              <label for="ajustePm">
                Preço Médio Contábil (R$) *
                <span *ngIf="posicao()?.custoPendente" class="badge-alerta">⚠️ Custo Pendente</span>
              </label>
              <input
                id="ajustePm"
                type="number"
                step="0.01"
                min="0"
                class="form-control font-mono"
                [(ngModel)]="precoMedio"
                placeholder="0.00"
              />
            </div>

            <div class="form-group">
              <label for="ajusteProventos">Total de Proventos Recebidos (R$)</label>
              <input
                id="ajusteProventos"
                type="number"
                step="0.01"
                min="0"
                class="form-control font-mono"
                [(ngModel)]="proventosAcumulados"
                placeholder="0.00"
              />
            </div>

            <div class="form-group full-width">
              <label for="ajusteCotacaoManual">
                Cotação Manual de Mercado (R$)
                <span class="label-hint">(Substitui a cotação da B3/Yahoo se preenchida)</span>
              </label>
              <input
                id="ajusteCotacaoManual"
                type="number"
                step="0.01"
                min="0"
                class="form-control font-mono"
                [(ngModel)]="cotacaoManual"
                placeholder="Deixe em branco para usar cotação automática da B3"
              />
            </div>
          </div>

          <!-- Seção Colapsável: Conversão / Renomeação de Ticker -->
          <div class="collapsible-section">
            <button
              type="button"
              class="btn-toggle-section"
              (click)="toggleSecaoConversao()"
            >
              <span>{{ secaoConversaoAberta() ? '▼' : '►' }} 🔄 Converter / Renomear Ticker (ex: TRPL4 → ISAE4)</span>
            </button>

            <div class="section-content" *ngIf="secaoConversaoAberta()">
              <p class="section-hint">
                Altera o código do ativo unificando todo o histórico de operações ou convertendo
                por desdobramento/grupamento.
              </p>
              <div class="form-grid">
                <div class="form-group">
                  <label for="novoTicker">Novo Ticker *</label>
                  <input
                    id="novoTicker"
                    type="text"
                    class="form-control font-mono"
                    [(ngModel)]="novoTicker"
                    placeholder="Ex: ISAE4"
                    maxlength="30"
                  />
                </div>
                <div class="form-group">
                  <label for="novoNome">Novo Nome (opcional)</label>
                  <input
                    id="novoNome"
                    type="text"
                    class="form-control"
                    [(ngModel)]="novoNomeTicker"
                    placeholder="Ex: ISA Energia Brasil"
                    maxlength="150"
                  />
                </div>
                <div class="form-group">
                  <label for="fatorConversao">Fator de Conversão</label>
                  <input
                    id="fatorConversao"
                    type="number"
                    step="any"
                    min="0.0001"
                    class="form-control font-mono"
                    [(ngModel)]="fatorConversao"
                    placeholder="1.0"
                  />
                </div>
                <div class="form-group btn-col">
                  <button
                    type="button"
                    class="btn-convert"
                    (click)="executarConversaoTicker()"
                    [disabled]="salvando() || !novoTicker.trim()"
                  >
                    Converter Ticker
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="modal-footer">
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
            (click)="salvarAjuste()"
            [disabled]="salvando() || quantidade < 0 || precoMedio < 0 || !tickerAtivo.trim()"
          >
            <span *ngIf="salvando()" class="spinner-inline"></span>
            <span>{{ salvando() ? 'Salvando...' : 'Salvar Alterações' }}</span>
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .modal-overlay {
      position: fixed;
      inset: 0;
      background-color: rgba(0, 0, 0, 0.78);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 1.25rem;
      animation: fadeIn 0.2s ease-out;
    }
    .modal-container {
      background-color: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      width: 100%;
      max-width: 760px;
      max-height: 92vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.6);
      overflow: hidden;
      transition: max-width 0.2s ease;
      &.wide-mode {
        max-width: min(880px, 95vw);
      }
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding: 1.25rem 1.5rem;
      border-bottom: 1px solid var(--border-color);
      background: rgba(255, 255, 255, 0.02);
      flex-shrink: 0;
    }
    .modal-title {
      font-size: 1.2rem;
      font-weight: 700;
      color: var(--text-main);
      margin: 0;
    }
    .modal-subtitle {
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
      display: inline-block;
    }
    .btn-close {
      background: none;
      border: none;
      font-size: 1.6rem;
      line-height: 1;
      color: var(--text-muted);
      cursor: pointer;
      padding: 0;
      transition: color 0.15s;
      &:hover:not(:disabled) {
        color: var(--text-main);
      }
    }
    .modal-body {
      padding: 1.5rem;
      overflow-y: auto;
      overflow-x: hidden;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }
    .alert-box {
      padding: 0.85rem 1.1rem;
      border-radius: 8px;
      font-size: 0.85rem;
      display: flex;
      align-items: center;
      gap: 0.6rem;
      &.error {
        background-color: rgba(248, 81, 73, 0.15);
        border: 1px solid rgba(248, 81, 73, 0.4);
        color: #ff7b72;
      }
      .alert-icon { font-size: 1.1rem; }
    }
    .transfer-resolution-box {
      background: rgba(210, 153, 34, 0.08);
      border: 1px solid rgba(210, 153, 34, 0.4);
      border-radius: 10px;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      width: 100%;
      box-sizing: border-box;
    }
    .box-header {
      display: flex;
      gap: 0.85rem;
      align-items: flex-start;
    }
    .box-icon {
      font-size: 1.5rem;
      line-height: 1;
      flex-shrink: 0;
    }
    .box-header-text {
      flex: 1;
    }
    .box-title {
      font-size: 1rem;
      font-weight: 700;
      color: #f0b72f;
      margin: 0 0 0.3rem 0;
    }
    .box-desc {
      font-size: 0.84rem;
      color: var(--text-muted);
      margin: 0;
      line-height: 1.4;
      strong { color: var(--text-main); }
    }
    .resolution-options {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
      gap: 1rem;
      width: 100%;
      box-sizing: border-box;
    }
    .resolution-card {
      background: var(--bg-main);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 1.1rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
    }
    .card-title {
      font-size: 0.92rem;
      font-weight: 700;
      color: var(--text-main);
      margin: 0;
    }
    .card-badge {
      font-size: 0.7rem;
      font-weight: 700;
      color: #f0b72f;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .card-hint {
      font-size: 0.78rem;
      color: var(--text-muted);
      margin: 0;
      line-height: 1.35;
      min-height: 2.2rem;
    }
    .btn-fetch-quote {
      background: rgba(56, 139, 253, 0.15);
      border: 1px solid rgba(56, 139, 253, 0.35);
      color: #58a6ff;
      font-size: 0.8rem;
      font-weight: 600;
      padding: 0.55rem 0.8rem;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
      transition: all 0.2s;
      width: 100%;
      box-sizing: border-box;
      &:hover:not(:disabled) {
        background: rgba(56, 139, 253, 0.25);
        border-color: #58a6ff;
      }
      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }
    .quote-feedback {
      font-size: 0.76rem;
      color: #3fb950;
      font-weight: 600;
      padding: 0.35rem 0.6rem;
      background: rgba(63, 185, 80, 0.1);
      border-radius: 4px;
      border-left: 3px solid #3fb950;
    }
    .input-block {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      width: 100%;
      box-sizing: border-box;
      label {
        font-size: 0.78rem;
        color: var(--text-muted);
        font-weight: 600;
      }
      .form-control {
        width: 100%;
        box-sizing: border-box;
      }
    }
    .preview-box {
      font-size: 0.78rem;
      padding: 0.45rem 0.75rem;
      border-radius: 6px;
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      box-sizing: border-box;
      width: 100%;
      &.info {
        background: rgba(56, 139, 253, 0.1);
        border: 1px solid rgba(56, 139, 253, 0.25);
        color: #79c0ff;
        strong { color: #fff; font-size: 0.85rem; }
      }
      &.success {
        background: rgba(63, 185, 80, 0.1);
        border: 1px solid rgba(63, 185, 80, 0.25);
        color: #7ee787;
        strong { color: #fff; font-size: 0.85rem; }
      }
    }
    .btn-apply-resolution {
      border: none;
      color: #fff;
      font-size: 0.82rem;
      font-weight: 600;
      padding: 0.65rem 1rem;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.45rem;
      width: 100%;
      box-sizing: border-box;
      transition: all 0.2s;
      &.primary-action {
        background-color: var(--primary);
        &:hover:not(:disabled) { background-color: var(--primary-hover); }
      }
      &.secondary-action {
        background-color: #1f6feb;
        &:hover:not(:disabled) { background-color: #388bfd; }
      }
      &:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
    }
    .section-divider {
      display: flex;
      align-items: center;
      color: var(--text-muted);
      font-size: 0.78rem;
      font-weight: 600;
      margin: 0.25rem 0;
      &::before, &::after {
        content: '';
        flex: 1;
        border-bottom: 1px solid var(--border-color);
      }
      span {
        padding: 0 0.85rem;
      }
    }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 1rem;
      width: 100%;
      box-sizing: border-box;
    }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      min-width: 0;
      box-sizing: border-box;
      &.full-width {
        grid-column: 1 / -1;
      }
      &.btn-col {
        justify-content: flex-end;
      }
      label {
        font-size: 0.8rem;
        font-weight: 600;
        color: var(--text-main);
        display: flex;
        align-items: center;
        gap: 0.4rem;
        flex-wrap: wrap;
      }
    }
    .badge-alerta {
      font-size: 0.7rem;
      color: #e3b341;
      background: rgba(210, 153, 34, 0.2);
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      border: 1px solid rgba(210, 153, 34, 0.4);
    }
    .label-hint {
      font-size: 0.72rem;
      color: var(--text-muted);
      font-weight: 400;
    }
    .form-control {
      background-color: var(--bg-main);
      border: 1px solid var(--border-color);
      color: var(--text-main);
      border-radius: 6px;
      padding: 0.55rem 0.8rem;
      font-size: 0.88rem;
      outline: none;
      width: 100%;
      box-sizing: border-box;
      min-width: 0;
      transition: all 0.2s;
      &:focus {
        border-color: var(--primary);
        box-shadow: 0 0 0 2px rgba(35, 134, 54, 0.25);
      }
    }
    .font-mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .collapsible-section {
      border: 1px solid var(--border-color);
      border-radius: 8px;
      overflow: hidden;
      width: 100%;
      box-sizing: border-box;
    }
    .btn-toggle-section {
      width: 100%;
      background: var(--bg-main);
      border: none;
      padding: 0.75rem 1rem;
      text-align: left;
      font-size: 0.84rem;
      font-weight: 600;
      color: var(--text-main);
      cursor: pointer;
      display: flex;
      align-items: center;
      transition: background 0.15s ease;
      &:hover {
        background: rgba(255, 255, 255, 0.05);
      }
    }
    .section-content {
      padding: 1rem;
      border-top: 1px solid var(--border-color);
      background: var(--bg-card);
    }
    .section-hint {
      font-size: 0.78rem;
      color: var(--text-muted);
      margin-bottom: 0.85rem;
    }
    .btn-convert {
      background: rgba(139, 92, 246, 0.15);
      border: 1px solid rgba(139, 92, 246, 0.4);
      color: #a78bfa;
      font-weight: 600;
      font-size: 0.82rem;
      padding: 0.55rem 1rem;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
      width: 100%;
      box-sizing: border-box;
      &:hover:not(:disabled) {
        background: rgba(139, 92, 246, 0.25);
        border-color: #a78bfa;
      }
      &:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
    }
    .modal-footer {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 0.75rem;
      padding: 1rem 1.5rem;
      background-color: rgba(22, 27, 34, 0.5);
      border-top: 1px solid var(--border-color);
      flex-shrink: 0;
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
export class AjustePosicaoModalComponent {
  readonly posicao = input<PosicaoEnriquecida | null>(null);
  readonly isOpen = input<boolean>(false);

  @Output() readonly fechar = new EventEmitter<void>();
  @Output() readonly salvo = new EventEmitter<AjusteSalvoEvent>();

  private readonly store = inject(CarteiraStore);
  private readonly carteiraService = inject(CarteiraService);

  readonly salvando = signal<boolean>(false);
  readonly erro = signal<string | null>(null);
  readonly secaoConversaoAberta = signal<boolean>(false);
  readonly buscandoCotacaoHistorica = signal<boolean>(false);
  readonly mensagemCotacaoHistorica = signal<string | null>(null);

  // Campos de Resolução de Transferência
  precoUnitarioTransf: number | null = null;
  pmConsolidadoAtual: number | null = null;

  // Campos do Formulário
  tickerAtivo = '';
  nomeAtivo = '';
  tipoAtivo: TipoAtivo = 'Acao';
  setorAtivo = '';
  quantidade = 0;
  precoMedio = 0;
  proventosAcumulados = 0;
  cotacaoManual: number | null = null;

  // Campos de Conversão de Ticker
  novoTicker = '';
  novoNomeTicker = '';
  fatorConversao = 1.0;

  constructor() {
    effect(() => {
      const p = this.posicao();
      if (p) {
        this.tickerAtivo = p.ativo?.ticker || '';
        this.nomeAtivo = p.ativo?.nome || '';
        this.tipoAtivo = p.ativo?.tipo || 'Acao';
        this.setorAtivo = p.ativo?.setor || '';
        this.quantidade = p.quantidade || 0;
        this.precoMedio = p.pmContabil || 0;
        this.proventosAcumulados = p.proventosTotal || 0;
        this.cotacaoManual =
          p.ativo?.cotacao_manual != null ? Number(p.ativo.cotacao_manual) : null;
        this.novoTicker = '';
        this.novoNomeTicker = '';
        this.fatorConversao = 1.0;
        this.precoUnitarioTransf = null;
        this.pmConsolidadoAtual = null;
        this.buscandoCotacaoHistorica.set(false);
        this.mensagemCotacaoHistorica.set(null);
        this.erro.set(null);
        this.secaoConversaoAberta.set(false);
      }
    });
  }

  temLotePendente(): boolean {
    const p = this.posicao();
    if (!p) return false;
    return Boolean(
      p.custoPendente ||
      (p.quantidadeSemCusto != null && Number(p.quantidadeSemCusto) > 0) ||
      (p.lotesPendentes && p.lotesPendentes.length > 0)
    );
  }

  getQuantidadeSemCustoExibicao(): number | string {
    const p = this.posicao();
    if (!p) return 0;
    if (p.quantidadeSemCusto != null && Number(p.quantidadeSemCusto) > 0) {
      return p.quantidadeSemCusto;
    }
    if (p.lotesPendentes && p.lotesPendentes.length > 0) {
      return p.lotesPendentes[0].quantidade;
    }
    return 0;
  }

  getQtdSemCustoNum(): number {
    const q = this.getQuantidadeSemCustoExibicao();
    const n = Number(q);
    return isNaN(n) ? 0 : n;
  }

  getDataLoteIso(dataStr?: string): string {
    if (!dataStr) return '2022-03-23';
    return String(dataStr).substring(0, 10);
  }

  formatarDataPtBr(dataStr?: string): string {
    const iso = this.getDataLoteIso(dataStr);
    const parts = iso.split('-');
    if (parts.length === 3) {
      return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return iso;
  }

  formatarMoeda(val: number): string {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(val || 0);
  }

  onPrecoUnitarioTransfChange(val: number | null): void {
    // Se o usuário digitou no Modo A, limpa Modo B para não conflitar
    if (val != null && val > 0 && this.pmConsolidadoAtual) {
      this.pmConsolidadoAtual = null;
    }
  }

  onPmConsolidadoAtualChange(val: number | null): void {
    // Se o usuário digitou no Modo B, sincroniza o Preço Médio do form abaixo
    if (val != null && val > 0) {
      this.precoMedio = Number(val);
      if (this.precoUnitarioTransf) {
        this.precoUnitarioTransf = null;
      }
    }
  }

  async buscarCotacaoHistorica(lote?: LoteTransferenciaPendente): Promise<void> {
    const p = this.posicao();
    if (!p) return;
    const dataIso = this.getDataLoteIso(lote?.data);
    this.buscandoCotacaoHistorica.set(true);
    this.mensagemCotacaoHistorica.set(null);
    this.erro.set(null);

    try {
      const res = await firstValueFrom(
        this.carteiraService.obterCotacaoHistorica(p.ativo.id, dataIso),
      );
      if (res && res.cotacao_fechamento != null && res.cotacao_fechamento > 0) {
        this.precoUnitarioTransf = Number(res.cotacao_fechamento);
        this.mensagemCotacaoHistorica.set(
          `Cotação de ${this.formatarDataPtBr(dataIso)}: R$ ${res.cotacao_fechamento.toFixed(2)} (B3/Yahoo)`,
        );
      } else {
        this.mensagemCotacaoHistorica.set(
          `Nenhuma cotação encontrada para ${this.formatarDataPtBr(dataIso)}.`,
        );
      }
    } catch (err: unknown) {
      const msg =
        (err as { error?: { detail?: string } })?.error?.detail ||
        'Erro ao buscar cotação histórica na B3/Yahoo.';
      this.erro.set(msg);
    } finally {
      this.buscandoCotacaoHistorica.set(false);
    }
  }

  async aplicarModoA(lote?: LoteTransferenciaPendente): Promise<void> {
    const p = this.posicao();
    if (!p) return;
    if (this.precoUnitarioTransf == null || this.precoUnitarioTransf < 0) {
      this.erro.set('Informe um preço unitário válido para a transferência.');
      return;
    }
    this.salvando.set(true);
    this.erro.set(null);
    try {
      await this.store.ajustarPosicaoManual(p.ativo.id, {
        transacao_id: lote?.transacao_id ?? null,
        preco_unitario_transferencia: Number(this.precoUnitarioTransf),
      });
      this.salvo.emit({
        ativoId: p.ativo.id,
        ticker: p.ativo.ticker,
        mensagem: `Custo de aquisição de ${p.ativo.ticker} definido para R$ ${Number(this.precoUnitarioTransf).toFixed(2)} na transferência! Posição recalculada.`,
      });
      this.fechar.emit();
    } catch (err: unknown) {
      const msg =
        (err as { error?: { detail?: string } })?.error?.detail ||
        'Erro ao aplicar preço unitário da transferência.';
      this.erro.set(msg);
    } finally {
      this.salvando.set(false);
    }
  }

  async aplicarModoB(lote?: LoteTransferenciaPendente): Promise<void> {
    const p = this.posicao();
    if (!p) return;
    if (this.pmConsolidadoAtual == null || this.pmConsolidadoAtual <= 0) {
      this.erro.set('Informe o Preço Médio Consolidado Atual desejado.');
      return;
    }
    this.salvando.set(true);
    this.erro.set(null);
    try {
      await this.store.ajustarPosicaoManual(p.ativo.id, {
        transacao_id: lote?.transacao_id ?? null,
        pm_consolidado_atual: Number(this.pmConsolidadoAtual),
      });
      this.salvo.emit({
        ativoId: p.ativo.id,
        ticker: p.ativo.ticker,
        mensagem: `Preço Médio de ${p.ativo.ticker} atualizado via Modo B para R$ ${Number(this.pmConsolidadoAtual).toFixed(2)} com sucesso! Lote transferido resolvido.`,
      });
      this.fechar.emit();
    } catch (err: unknown) {
      const msg =
        (err as { error?: { detail?: string } })?.error?.detail ||
        'Erro ao calcular engenharia reversa do preço médio.';
      this.erro.set(msg);
    } finally {
      this.salvando.set(false);
    }
  }

  toggleSecaoConversao(): void {
    this.secaoConversaoAberta.update((v) => !v);
  }

  onFechar(): void {
    this.fechar.emit();
  }

  async salvarAjuste(): Promise<void> {
    const p = this.posicao();
    if (!p) return;

    if (!this.tickerAtivo.trim()) {
      this.erro.set('O ticker é obrigatório.');
      return;
    }

    // Unificação Inteligente: se o usuário preencheu o Modo B, executa o Modo B!
    if (this.pmConsolidadoAtual != null && this.pmConsolidadoAtual > 0) {
      await this.aplicarModoB(p.lotesPendentes?.[0]);
      return;
    }

    // Se o usuário preencheu o Modo A, executa o Modo A!
    if (this.precoUnitarioTransf != null && this.precoUnitarioTransf >= 0) {
      await this.aplicarModoA(p.lotesPendentes?.[0]);
      return;
    }

    this.salvando.set(true);
    this.erro.set(null);

    try {
      await this.store.ajustarPosicaoManual(p.ativo.id, {
        ticker: this.tickerAtivo.trim().toUpperCase() || undefined,
        quantidade_saldo: Number(this.quantidade) || 0,
        preco_medio_brl: Number(this.precoMedio) || 0,
        proventos_acumulados_brl: Number(this.proventosAcumulados) || 0,
        cotacao_manual:
          this.cotacaoManual != null &&
          this.cotacaoManual !== ('' as unknown) &&
          !isNaN(Number(this.cotacaoManual)) &&
          Number(this.cotacaoManual) > 0
            ? Number(this.cotacaoManual)
            : null,
        nome_ativo: this.nomeAtivo.trim() || undefined,
        tipo_ativo: this.tipoAtivo,
        setor: this.setorAtivo.trim() || undefined,
      });

      this.salvo.emit({
        ativoId: p.ativo.id,
        ticker: this.tickerAtivo.toUpperCase(),
        mensagem: `Dados de ${this.tickerAtivo.toUpperCase()} atualizados com sucesso.`,
      });
      this.fechar.emit();
    } catch (err: unknown) {
      const msg =
        (err as { error?: { detail?: string } })?.error?.detail ||
        'Erro ao salvar ajustes da posição.';
      this.erro.set(msg);
    } finally {
      this.salvando.set(false);
    }
  }

  async executarConversaoTicker(): Promise<void> {
    const p = this.posicao();
    if (!p || !this.novoTicker.trim()) return;

    this.salvando.set(true);
    this.erro.set(null);

    try {
      await this.store.converterTicker(p.ativo.id, {
        novo_ticker: this.novoTicker.trim().toUpperCase(),
        novo_nome: this.novoNomeTicker.trim() || undefined,
        fator_conversao: Number(this.fatorConversao) || 1.0,
      });

      this.salvo.emit({
        ativoId: p.ativo.id,
        ticker: this.novoTicker.trim().toUpperCase(),
        mensagem: `Ticker convertido com sucesso para ${this.novoTicker.trim().toUpperCase()}.`,
      });
      this.fechar.emit();
    } catch (err: unknown) {
      const msg =
        (err as { error?: { detail?: string } })?.error?.detail ||
        'Erro ao converter ticker do ativo.';
      this.erro.set(msg);
    } finally {
      this.salvando.set(false);
    }
  }
}
