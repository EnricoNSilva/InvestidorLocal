import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import {
  AjusteManualPosicaoDto,
  Ativo,
  AtivoUpdateDto,
  Carteira,
  ConversaoTickerDto,
  CotacaoHistoricaResponse,
  CotacoesCarteiraResponse,
  PosicaoConsolidada,
  RetornoImportacao,
  TipoAtivo,
  TipoOperacao,
  Transacao,
  TransacaoCreateDto,
  TransacaoUpdateDto,
} from '../models/investimento.models';

@Injectable({
  providedIn: 'root',
})
export class CarteiraService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = 'http://127.0.0.1:8000/api/v1';

  // Gerenciamento reativo de carteiras
  readonly carteiras = signal<Carteira[]>([]);
  readonly carteiraAtivaId = signal<number>(this.getInitialCarteiraId());

  private getInitialCarteiraId(): number {
    try {
      const saved = localStorage.getItem('carteiraAtivaId');
      if (saved) {
        const val = parseInt(saved, 10);
        if (!isNaN(val)) return val;
      }
    } catch (_) {}
    return 1;
  }

  constructor() {
    this.carregarCarteiras();
  }

  carregarCarteiras(): void {
    this.getCarteiras().subscribe({
      next: (list) => {
        this.carteiras.set(list);
        if (list.length > 0) {
          const existe = list.some((c) => c.id === this.carteiraAtivaId());
          if (!existe) {
            this.selecionarCarteira(list[0].id);
          }
        }
      },
      error: (err) => console.error('Erro ao carregar lista de carteiras:', err),
    });
  }

  selecionarCarteira(id: number): void {
    this.carteiraAtivaId.set(id);
    try {
      localStorage.setItem('carteiraAtivaId', id.toString());
    } catch (_) {}
  }

  getCarteiras(): Observable<Carteira[]> {
    return this.http
      .get<Carteira[]>(`${this.baseUrl}/posicoes/carteiras`)
      .pipe(tap((list) => this.carteiras.set(list)));
  }

  criarCarteira(payload: { nome: string; descricao?: string }): Observable<Carteira> {
    return this.http.post<Carteira>(`${this.baseUrl}/posicoes/carteiras`, payload).pipe(
      tap((nova) => {
        this.carteiras.update((anteriores) => [...anteriores, nova]);
        this.carteiraAtivaId.set(nova.id);
      }),
    );
  }

  excluirCarteira(carteiraId: number): Observable<{ status: string; mensagem: string }> {
    return this.http
      .delete<{
        status: string;
        mensagem: string;
      }>(`${this.baseUrl}/posicoes/carteiras/${carteiraId}`)
      .pipe(
        tap(() => {
          this.carteiras.update((anteriores) => anteriores.filter((c) => c.id !== carteiraId));
          const restantes = this.carteiras();
          if (restantes.length > 0 && this.carteiraAtivaId() === carteiraId) {
            this.carteiraAtivaId.set(restantes[0].id);
          }
        }),
      );
  }

  limparCarteira(carteiraId: number): Observable<{ status: string; mensagem: string }> {
    return this.http.post<{ status: string; mensagem: string }>(
      `${this.baseUrl}/posicoes/carteiras/${carteiraId}/limpar`,
      {},
    );
  }

  recalcularCarteira(carteiraId?: number): Observable<{ status: string; mensagem: string }> {
    const id = carteiraId !== undefined ? carteiraId : this.carteiraAtivaId();
    return this.http.post<{ status: string; mensagem: string }>(
      `${this.baseUrl}/posicoes/carteiras/${id}/recalcular`,
      {},
    );
  }

  getPosicoes(
    carteiraId?: number,
    somenteComSaldo: boolean = true,
  ): Observable<PosicaoConsolidada[]> {
    const id = carteiraId !== undefined ? carteiraId : this.carteiraAtivaId();
    let params = new HttpParams().set('somente_com_saldo', somenteComSaldo.toString());
    if (id) {
      params = params.set('carteira_id', id.toString());
    }
    return this.http.get<PosicaoConsolidada[]>(`${this.baseUrl}/posicoes`, { params });
  }

  obterCotacoes(carteiraId?: number, forcar: boolean = false): Observable<CotacoesCarteiraResponse> {
    const id = carteiraId !== undefined ? carteiraId : this.carteiraAtivaId();
    let params = new HttpParams().set('carteira_id', id.toString()).set('forcar', forcar.toString());
    return this.http.get<CotacoesCarteiraResponse>(`${this.baseUrl}/posicoes/cotacoes`, { params });
  }

  ajustarPosicaoManual(
    carteiraId: number,
    ativoId: number,
    payload: AjusteManualPosicaoDto,
  ): Observable<PosicaoConsolidada> {
    return this.http.put<PosicaoConsolidada>(
      `${this.baseUrl}/posicoes/carteiras/${carteiraId}/ativos/${ativoId}/ajuste-manual`,
      payload,
    );
  }

  getAtivos(): Observable<Ativo[]> {
    return this.http.get<Ativo[]>(`${this.baseUrl}/ativos`);
  }

  criarAtivo(payload: {
    ticker: string;
    nome: string;
    tipo: TipoAtivo;
    setor?: string | null;
    cotacao_manual?: number | null;
  }): Observable<Ativo> {
    return this.http.post<Ativo>(`${this.baseUrl}/ativos`, payload);
  }

  atualizarAtivo(ativoId: number, payload: AtivoUpdateDto): Observable<Ativo> {
    return this.http.put<Ativo>(`${this.baseUrl}/ativos/${ativoId}`, payload);
  }

  definirCotacaoManual(ativoId: number, cotacaoManual: number | null): Observable<Ativo> {
    return this.http.patch<Ativo>(`${this.baseUrl}/ativos/${ativoId}/cotacao-manual`, {
      cotacao_manual: cotacaoManual,
    });
  }

  excluirAtivo(ativoId: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/ativos/${ativoId}`);
  }

  converterTicker(ativoId: number, payload: ConversaoTickerDto): Observable<Ativo> {
    return this.http.post<Ativo>(`${this.baseUrl}/ativos/${ativoId}/converter-ticker`, payload);
  }

  listarTransacoes(params?: {
    carteiraId?: number;
    ativoId?: number;
    tipoOperacao?: TipoOperacao;
  }): Observable<Transacao[]> {
    let httpParams = new HttpParams();
    const cid = params?.carteiraId !== undefined ? params.carteiraId : this.carteiraAtivaId();
    if (cid !== undefined && cid !== null) {
      httpParams = httpParams.set('carteira_id', cid.toString());
    }
    if (params?.ativoId !== undefined && params.ativoId !== null) {
      httpParams = httpParams.set('ativo_id', params.ativoId.toString());
    }
    if (params?.tipoOperacao) {
      httpParams = httpParams.set('tipo_operacao', params.tipoOperacao);
    }
    return this.http.get<Transacao[]>(`${this.baseUrl}/transacoes`, { params: httpParams });
  }

  criarTransacao(payload: TransacaoCreateDto): Observable<Transacao> {
    const finalPayload = {
      ...payload,
      carteira_id: payload.carteira_id !== undefined ? payload.carteira_id : this.carteiraAtivaId(),
    };
    return this.http.post<Transacao>(`${this.baseUrl}/transacoes`, finalPayload);
  }

  atualizarTransacao(transacaoId: number, payload: TransacaoUpdateDto): Observable<Transacao> {
    return this.http.put<Transacao>(`${this.baseUrl}/transacoes/${transacaoId}`, payload);
  }

  excluirTransacao(transacaoId: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/transacoes/${transacaoId}`);
  }

  uploadB3(file: File, carteiraId?: number): Observable<RetornoImportacao> {
    const id = carteiraId !== undefined ? carteiraId : this.carteiraAtivaId();
    const formData = new FormData();
    formData.append('file', file, file.name);
    let params = new HttpParams();
    if (id) {
      params = params.set('carteira_id', id.toString());
    }
    return this.http.post<RetornoImportacao>(`${this.baseUrl}/importacao/b3`, formData, { params });
  }

  obterCotacaoHistorica(ativoId: number, data: string): Observable<CotacaoHistoricaResponse> {
    const params = new HttpParams().set('data', data);
    return this.http.get<CotacaoHistoricaResponse>(
      `${this.baseUrl}/ativos/${ativoId}/cotacao-historica`,
      { params },
    );
  }

  uploadB3Transferencias(file: File | File[], carteiraId?: number): Observable<RetornoImportacao> {
    const id = carteiraId !== undefined ? carteiraId : this.carteiraAtivaId();
    const formData = new FormData();
    if (Array.isArray(file)) {
      file.forEach((f) => formData.append('files', f, f.name));
    } else {
      formData.append('file', file, file.name);
    }
    let params = new HttpParams();
    if (id) {
      params = params.set('carteira_id', id.toString());
    }
    return this.http.post<RetornoImportacao>(
      `${this.baseUrl}/importacao/b3-transferencias`,
      formData,
      { params },
    );
  }

  uploadBinance(file: File, carteiraId?: number): Observable<RetornoImportacao> {
    const id = carteiraId !== undefined ? carteiraId : this.carteiraAtivaId();
    const formData = new FormData();
    formData.append('file', file, file.name);
    let params = new HttpParams();
    if (id) {
      params = params.set('carteira_id', id.toString());
    }
    return this.http.post<RetornoImportacao>(`${this.baseUrl}/importacao/binance`, formData, {
      params,
    });
  }

  resetarRendaFixa(carteiraId?: number): Observable<{ status: string; mensagem: string }> {
    const id = carteiraId !== undefined ? carteiraId : this.carteiraAtivaId();
    return this.http.post<{ status: string; mensagem: string }>(
      `${this.baseUrl}/posicoes/carteiras/${id}/resetar-renda-fixa`,
      {}
    );
  }
}
