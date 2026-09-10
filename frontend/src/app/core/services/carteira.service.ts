import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Ativo, PosicaoConsolidada, RetornoImportacao } from '../models/investimento.models';

@Injectable({
  providedIn: 'root'
})
export class CarteiraService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = 'http://127.0.0.1:8000/api/v1';

  getPosicoes(somenteComSaldo: boolean = true): Observable<PosicaoConsolidada[]> {
    const params = new HttpParams().set('somente_com_saldo', somenteComSaldo.toString());
    return this.http.get<PosicaoConsolidada[]>(`${this.baseUrl}/posicoes`, { params });
  }

  getAtivos(): Observable<Ativo[]> {
    return this.http.get<Ativo[]>(`${this.baseUrl}/ativos`);
  }

  uploadB3(file: File): Observable<RetornoImportacao> {
    const formData = new FormData();
    formData.append('file', file, file.name);
    return this.http.post<RetornoImportacao>(`${this.baseUrl}/importacao/b3`, formData);
  }

  uploadB3Transferencias(file: File): Observable<RetornoImportacao> {
    const formData = new FormData();
    formData.append('file', file, file.name);
    return this.http.post<RetornoImportacao>(`${this.baseUrl}/importacao/b3-transferencias`, formData);
  }

  uploadBinance(file: File): Observable<RetornoImportacao> {
    const formData = new FormData();
    formData.append('file', file, file.name);
    return this.http.post<RetornoImportacao>(`${this.baseUrl}/importacao/binance`, formData);
  }
}
