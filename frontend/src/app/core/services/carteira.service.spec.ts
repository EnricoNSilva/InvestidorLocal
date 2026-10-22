import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CarteiraService } from './carteira.service';
import {
  AjusteManualPosicaoDto,
  Ativo,
  AtivoUpdateDto,
  ConversaoTickerDto,
  CotacoesCarteiraResponse,
  PosicaoConsolidada,
  Transacao,
  TransacaoCreateDto,
  TransacaoUpdateDto,
} from '../models/investimento.models';

describe('CarteiraService', () => {
  let service: CarteiraService;
  let httpMock: HttpTestingController;
  const baseUrl = 'http://127.0.0.1:8000/api/v1';

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        CarteiraService,
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });

    service = TestBed.inject(CarteiraService);
    httpMock = TestBed.inject(HttpTestingController);

    // O construtor chama carregarCarteiras()
    const reqInitial = httpMock.expectOne(`${baseUrl}/posicoes/carteiras`);
    expect(reqInitial.request.method).toBe('GET');
    reqInitial.flush([{ id: 1, nome: 'Carteira Principal' }]);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('deve listar carteiras e atualizar o signal carteiras', () => {
    service.getCarteiras().subscribe((carteiras) => {
      expect(carteiras.length).toBe(2);
      expect(carteiras[0].nome).toBe('Carteira A');
    });

    const req = httpMock.expectOne(`${baseUrl}/posicoes/carteiras`);
    expect(req.request.method).toBe('GET');
    req.flush([
      { id: 1, nome: 'Carteira A' },
      { id: 2, nome: 'Carteira B' },
    ]);

    expect(service.carteiras().length).toBe(2);
  });

  it('deve criar carteira via POST e atualizar signal', () => {
    service.criarCarteira({ nome: 'Nova Carteira', descricao: 'Desc' }).subscribe((nova) => {
      expect(nova.id).toBe(3);
      expect(nova.nome).toBe('Nova Carteira');
    });

    const req = httpMock.expectOne(`${baseUrl}/posicoes/carteiras`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ nome: 'Nova Carteira', descricao: 'Desc' });
    req.flush({ id: 3, nome: 'Nova Carteira', descricao: 'Desc' });

    expect(service.carteiraAtivaId()).toBe(3);
  });

  it('deve excluir carteira via DELETE', () => {
    service.excluirCarteira(1).subscribe((resp) => {
      expect(resp.status).toBe('success');
    });

    const req = httpMock.expectOne(`${baseUrl}/posicoes/carteiras/1`);
    expect(req.request.method).toBe('DELETE');
    req.flush({ status: 'success', mensagem: 'Carteira excluída' });
  });

  it('deve limpar carteira via POST /limpar', () => {
    service.limparCarteira(1).subscribe((resp) => {
      expect(resp.status).toBe('success');
    });

    const req = httpMock.expectOne(`${baseUrl}/posicoes/carteiras/1/limpar`);
    expect(req.request.method).toBe('POST');
    req.flush({ status: 'success', mensagem: 'Carteira zerada' });
  });

  it('deve recalcular carteira via POST /recalcular', () => {
    service.recalcularCarteira(1).subscribe((resp) => {
      expect(resp.status).toBe('success');
    });

    const req = httpMock.expectOne(`${baseUrl}/posicoes/carteiras/1/recalcular`);
    expect(req.request.method).toBe('POST');
    req.flush({ status: 'success', mensagem: 'Posições recalculadas' });
  });

  it('deve buscar posições com somente_com_saldo=false e carteira_id', () => {
    service.getPosicoes(1, false).subscribe((posicoes) => {
      expect(posicoes.length).toBe(1);
    });

    const req = httpMock.expectOne((r) =>
      r.url === `${baseUrl}/posicoes` &&
      r.params.get('somente_com_saldo') === 'false' &&
      r.params.get('carteira_id') === '1'
    );
    expect(req.request.method).toBe('GET');
    req.flush([{ id: 1, carteira_id: 1, ativo_id: 10, quantidade_saldo: 10, preco_medio_brl: 25 }]);
  });

  it('deve obter cotações via GET /posicoes/cotacoes', () => {
    service.obterCotacoes(1, true).subscribe((resp: CotacoesCarteiraResponse) => {
      expect(resp.carteira_id).toBe(1);
      expect(resp.cotacoes['PETR4'].preco_atual).toBe(38.5);
    });

    const req = httpMock.expectOne((r) =>
      r.url === `${baseUrl}/posicoes/cotacoes` &&
      r.params.get('carteira_id') === '1' &&
      r.params.get('forcar') === 'true'
    );
    expect(req.request.method).toBe('GET');
    req.flush({
      carteira_id: 1,
      atualizado_em: '2026-10-16T12:00:00Z',
      stale: false,
      cotacoes: {
        PETR4: { ticker: 'PETR4', preco_atual: 38.5, fonte: 'YAHOO', stale: false },
      },
    });
  });

  it('deve ajustar posição manual via PUT /posicoes/carteiras/{cid}/ativos/{aid}/ajuste-manual', () => {
    const payload: AjusteManualPosicaoDto = {
      quantidade_saldo: 100,
      preco_medio_brl: 30,
      proventos_acumulados_brl: 50,
      cotacao_manual: 32,
    };

    service.ajustarPosicaoManual(1, 10, payload).subscribe((pos: PosicaoConsolidada) => {
      expect(pos.ativo_id).toBe(10);
      expect(pos.preco_medio_brl).toBe(30);
    });

    const req = httpMock.expectOne(`${baseUrl}/posicoes/carteiras/1/ativos/10/ajuste-manual`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual(payload);
    req.flush({ id: 1, carteira_id: 1, ativo_id: 10, quantidade_saldo: 100, preco_medio_brl: 30 });
  });

  it('deve atualizar ativo via PUT /ativos/{id}', () => {
    const payload: AtivoUpdateDto = { nome: 'Petrobras ON', setor: 'Petróleo' };

    service.atualizarAtivo(10, payload).subscribe((ativo: Ativo) => {
      expect(ativo.nome).toBe('Petrobras ON');
    });

    const req = httpMock.expectOne(`${baseUrl}/ativos/10`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual(payload);
    req.flush({ id: 10, ticker: 'PETR3', nome: 'Petrobras ON', tipo: 'Acao', setor: 'Petróleo' });
  });

  it('deve definir cotação manual via PATCH /ativos/{id}/cotacao-manual', () => {
    service.definirCotacaoManual(10, 35.5).subscribe((ativo: Ativo) => {
      expect(ativo.cotacao_manual).toBe(35.5);
    });

    const req = httpMock.expectOne(`${baseUrl}/ativos/10/cotacao-manual`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ cotacao_manual: 35.5 });
    req.flush({ id: 10, ticker: 'PETR4', nome: 'Petrobras', tipo: 'Acao', cotacao_manual: 35.5 });
  });

  it('deve excluir ativo via DELETE /ativos/{id}', () => {
    service.excluirAtivo(10).subscribe();

    const req = httpMock.expectOne(`${baseUrl}/ativos/10`);
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
  });

  it('deve converter ticker via POST /ativos/{id}/converter-ticker', () => {
    const payload: ConversaoTickerDto = { novo_ticker: 'ISAE4', fator_conversao: 1.0 };

    service.converterTicker(10, payload).subscribe((ativo: Ativo) => {
      expect(ativo.ticker).toBe('ISAE4');
    });

    const req = httpMock.expectOne(`${baseUrl}/ativos/10/converter-ticker`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(payload);
    req.flush({ id: 10, ticker: 'ISAE4', nome: 'ISA CTEEP', tipo: 'Acao' });
  });

  it('deve listar transações com parâmetros de filtro', () => {
    service.listarTransacoes({ carteiraId: 1, ativoId: 10, tipoOperacao: 'DIVIDENDO' }).subscribe((txs) => {
      expect(txs.length).toBe(1);
      expect(txs[0].tipo_operacao).toBe('DIVIDENDO');
    });

    const req = httpMock.expectOne((r) =>
      r.url === `${baseUrl}/transacoes` &&
      r.params.get('carteira_id') === '1' &&
      r.params.get('ativo_id') === '10' &&
      r.params.get('tipo_operacao') === 'DIVIDENDO'
    );
    expect(req.request.method).toBe('GET');
    req.flush([
      { id: 1, ativo_id: 10, carteira_id: 1, tipo_operacao: 'DIVIDENDO', quantidade: 100, preco_unitario: 0.5 },
    ]);
  });

  it('deve criar transação via POST /transacoes', () => {
    const payload: TransacaoCreateDto = {
      carteira_id: 1,
      ativo_id: 10,
      tipo_operacao: 'BUY',
      quantidade: 100,
      preco_unitario: 35,
    };

    service.criarTransacao(payload).subscribe((tx: Transacao) => {
      expect(tx.id).toBe(5);
    });

    const req = httpMock.expectOne(`${baseUrl}/transacoes`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(payload);
    req.flush({ id: 5, ...payload });
  });

  it('deve atualizar transação via PUT /transacoes/{id}', () => {
    const payload: TransacaoUpdateDto = { quantidade: 150 };

    service.atualizarTransacao(5, payload).subscribe((tx: Transacao) => {
      expect(tx.quantidade).toBe(150);
    });

    const req = httpMock.expectOne(`${baseUrl}/transacoes/5`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual(payload);
    req.flush({ id: 5, quantidade: 150 });
  });

  it('deve excluir transação via DELETE /transacoes/{id}', () => {
    service.excluirTransacao(5).subscribe();

    const req = httpMock.expectOne(`${baseUrl}/transacoes/5`);
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
  });
});
