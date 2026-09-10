import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import {
  Ativo,
  Carteira,
  PosicaoConsolidada,
  RetornoImportacao,
} from '../models/investimento.models';

@Injectable({
  providedIn: 'root',
})
export class CarteiraService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = 'http://127.0.0.1:8000/api/v1';

  // Gerenciamento reativo de carteiras
  readonly carteiras = signal<Carteira[]>([]);
  readonly carteiraAtivaId = signal<number>(1);

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
            this.carteiraAtivaId.set(list[0].id);
          }
        }
      },
      error: (err) => console.error('Erro ao carregar lista de carteiras:', err),
    });
  }

  selecionarCarteira(id: number): void {
    this.carteiraAtivaId.set(id);
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

  getAtivos(): Observable<Ativo[]> {
    return this.http.get<Ativo[]>(`${this.baseUrl}/ativos`);
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

  uploadB3Transferencias(file: File, carteiraId?: number): Observable<RetornoImportacao> {
    const id = carteiraId !== undefined ? carteiraId : this.carteiraAtivaId();
    const formData = new FormData();
    formData.append('file', file, file.name);
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
}
