import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  AtivoRendaFixa,
  CadastroManualRendaFixaDto,
  CotacaoTesouroResponse,
  DetalhesRendaFixa,
  DetalhesRendaFixaUpsert,
  EnvelopeMercado,
  Indexador,
  LoteManualCreateDto,
  LotesRendaFixaResponse,
  MacroResponse,
  PosicaoRendaFixa,
  TaxaContratadaPatch,
} from '../models/renda-fixa.models';
import { Transacao } from '../models/investimento.models';

export { toEngineLot, isLot } from '../models/renda-fixa.models';

@Injectable({
  providedIn: 'root',
})
export class RendaFixaApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = 'http://127.0.0.1:8000/api/v1/renda-fixa';

  listarAtivos(indexador?: Indexador): Observable<AtivoRendaFixa[]> {
    let params = new HttpParams();
    if (indexador) {
      params = params.set('indexador', indexador);
    }
    return this.http.get<AtivoRendaFixa[]>(`${this.baseUrl}/ativos`, { params });
  }

  upsertDetalhes(ativoId: number, payload: DetalhesRendaFixaUpsert): Observable<DetalhesRendaFixa> {
    return this.http.put<DetalhesRendaFixa>(
      `${this.baseUrl}/ativos/${ativoId}/detalhes`,
      payload
    );
  }

  obterLotesPeps(carteiraId: number = 1, ativoId?: number | null): Observable<LotesRendaFixaResponse> {
    let params = new HttpParams().set('carteira_id', carteiraId.toString());
    if (ativoId) {
      params = params.set('ativo_id', ativoId.toString());
    }
    return this.http.get<LotesRendaFixaResponse>(`${this.baseUrl}/lotes`, { params });
  }

  atualizarTaxaContratada(transacaoId: number, taxaPct: number): Observable<Transacao> {
    const payload: TaxaContratadaPatch = {
      taxa_contratada: taxaPct,
    };
    return this.http.patch<Transacao>(
      `${this.baseUrl}/transacoes/${transacaoId}/taxa`,
      payload
    );
  }

  obterMercadoTesouro(forcar: boolean = false): Observable<EnvelopeMercado<CotacaoTesouroResponse>> {
    const params = new HttpParams().set('forcar', forcar.toString());
    return this.http.get<EnvelopeMercado<CotacaoTesouroResponse>>(
      `${this.baseUrl}/mercado/tesouro`,
      { params }
    );
  }

  obterMercadoMacro(forcar: boolean = false): Observable<MacroResponse> {
    const params = new HttpParams().set('forcar', forcar.toString());
    return this.http.get<MacroResponse>(`${this.baseUrl}/mercado/macro`, { params });
  }

  cadastrarTituloManual(payload: CadastroManualRendaFixaDto): Observable<PosicaoRendaFixa> {
    return this.http.post<PosicaoRendaFixa>(`${this.baseUrl}/cadastro-manual`, payload);
  }

  adicionarLoteManual(ativoId: number, payload: LoteManualCreateDto): Observable<PosicaoRendaFixa> {
    return this.http.post<PosicaoRendaFixa>(`${this.baseUrl}/ativos/${ativoId}/lotes`, payload);
  }
}
