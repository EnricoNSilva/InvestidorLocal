import { Injectable, computed, inject, signal, effect, untracked } from '@angular/core';
import { firstValueFrom, forkJoin, of, catchError } from 'rxjs';
import { CarteiraService } from '../../../core/services/carteira.service';
import {
  AjusteManualPosicaoDto,
  Ativo,
  AtivoUpdateDto,
  CarteiraKpis,
  ChartAlocacaoData,
  ChartPesoAtivosData,
  ChartRankingProventosData,
  ConversaoTickerDto,
  CotacaoItem,
  CotacoesCarteiraResponse,
  FiltroClasseCarteira,
  PosicaoConsolidada,
  PosicaoEnriquecida,
  ProventosAnuaisCarteiraResponse,
  ProventosAtivoAnual,
  ResumoBinanceMetadata,
  TipoAtivo,
  Transacao,
  TransacaoCreateDto,
  TransacaoUpdateDto,
} from '../../../core/models/investimento.models';

export const FILTRO_CLASSE_STORAGE_KEY = 'il.carteira.filtro_classe.v1';

export function matchClasse(tipo: TipoAtivo | undefined, filtro: FiltroClasseCarteira): boolean {
  switch (filtro) {
    case 'RV_TOTAL':
      return tipo === 'Acao' || tipo === 'FII';
    case 'ACAO':
      return tipo === 'Acao';
    case 'FII':
      return tipo === 'FII';
    case 'CRIPTO':
      return tipo === 'Cripto';
    case 'RENDA_FIXA':
      return tipo === 'RendaFixa';
    case 'PATRIMONIO':
      return true;
    default:
      return true;
  }
}

const SETORES_MAP_FRONTEND: Record<string, string> = {
  BBAS3: 'Bancos', BBDC3: 'Bancos', BBDC4: 'Bancos', ITUB3: 'Bancos', ITUB4: 'Bancos',
  ITSA3: 'Bancos', ITSA4: 'Bancos', SANB3: 'Bancos', SANB4: 'Bancos', SANB11: 'Bancos',
  BEES3: 'Bancos', BEES4: 'Bancos', BPAC11: 'Bancos', BRSR6: 'Bancos',
  BBSE3: 'Seguradoras', CXSE3: 'Seguradoras', IRBR3: 'Seguradoras', PSSA3: 'Seguradoras', WIZC3: 'Seguradoras',
  KLBN3: 'Papel e Celulose', KLBN4: 'Papel e Celulose', KLBN11: 'Papel e Celulose', SUZB3: 'Papel e Celulose', RANI3: 'Papel e Celulose',
  CMIG3: 'Energia Elétrica', CMIG4: 'Energia Elétrica', TAEE11: 'Energia Elétrica', ISAE4: 'Energia Elétrica', TRPL4: 'Energia Elétrica',
  ELET3: 'Energia Elétrica', ELET6: 'Energia Elétrica', AESB3: 'Energia Elétrica', EQTL3: 'Energia Elétrica', CPFE3: 'Energia Elétrica',
  SAPR3: 'Saneamento', SAPR4: 'Saneamento', SAPR11: 'Saneamento', CSMG3: 'Saneamento', SBSP3: 'Saneamento',
  VALE3: 'Mineração e Siderurgia', GGBR4: 'Mineração e Siderurgia', CSNA3: 'Mineração e Siderurgia', USIM5: 'Mineração e Siderurgia',
  PETR3: 'Petróleo e Combustíveis', PETR4: 'Petróleo e Combustíveis', PRIO3: 'Petróleo e Combustíveis', VBBR3: 'Petróleo e Combustíveis', UGPA3: 'Petróleo e Combustíveis',
  LEVE3: 'Automóveis e Peças', MYPK3: 'Automóveis e Peças', RAPT4: 'Automóveis e Peças', TUPY3: 'Automóveis e Peças', POMO4: 'Automóveis e Peças',
  TIMS3: 'Telecomunicações', VIVT3: 'Telecomunicações',
  ALOS3: 'Imobiliário e Shoppings', MULT3: 'Imobiliário e Shoppings', IGTI11: 'Imobiliário e Shoppings', CYRE3: 'Imobiliário e Shoppings',
  MGLU3: 'Comércio e Varejo', LREN3: 'Comércio e Varejo', ARZZ3: 'Comércio e Varejo',
  ABEV3: 'Alimentos e Bebidas', JBSS3: 'Alimentos e Bebidas',
  WEGE3: 'Bens Industriais', EMBR3: 'Bens Industriais',
  RAIL3: 'Logística e Transportes', RENT3: 'Logística e Transportes', CCRO3: 'Logística e Transportes',
  HGLG11: 'Imobiliário (Logística)', HGLG12: 'Imobiliário (Logística)',
  HGBS11: 'Imobiliário (Shoppings)', HGBS12: 'Imobiliário (Shoppings)',
  KNRI11: 'Imobiliário (Híbrido)', KNRI12: 'Imobiliário (Híbrido)',
  XPCI11: 'Imobiliário (Papel / Recebíveis)', PMIS11: 'Imobiliário (Papel / Recebíveis)',
  BTC: 'Criptomoedas', ETH: 'Smart Contracts', SOL: 'Smart Contracts',
  AAVE: 'Finanças Descentralizadas (DeFi)', PENDLE: 'Finanças Descentralizadas (DeFi)',
  USDT: 'Stablecoins', ERA: 'Web3 & Infraestrutura', SXT: 'Web3 & Infraestrutura',
};

export function inferirSetorAtivo(ticker: string, setorOriginal?: string | null, tipo?: string): string {
  const s = (setorOriginal || '').trim();
  if (s && s !== 'Outros') return s;
  const tk = (ticker || '').trim().toUpperCase();
  if (SETORES_MAP_FRONTEND[tk]) return SETORES_MAP_FRONTEND[tk];
  if (tk.startsWith('TD-') || tk.startsWith('TESOURO')) return 'Tesouro Direto';
  if (tk.startsWith('CDB-') || tk.startsWith('CDB')) return 'Títulos Bancários (CDB)';
  if (tipo === 'FII' || (tk.endsWith('11') && tipo !== 'Acao')) return 'Imobiliário';
  if (tipo === 'Cripto') return 'Criptomoedas';
  if (tipo === 'RendaFixa') return 'Renda Fixa';
  return s || 'Outros';
}



@Injectable({
  providedIn: 'root',
})
export class CarteiraStore {
  readonly carteiraService = inject(CarteiraService);

  // ---------- Writable Signals ----------
  readonly filtroClasse = signal<FiltroClasseCarteira>(this.getInitialFiltroClasse());
  readonly buscaTexto = signal<string>('');
  readonly ordenacao = signal<{ campo: string; direcao: 'asc' | 'desc' }>({
    campo: 'valorMercado',
    direcao: 'desc',
  });
  readonly todasPosicoes = signal<PosicaoConsolidada[]>([]);
  readonly visaoCustodia = signal<'ATIVAS' | 'ENCERRADAS'>('ATIVAS');
  readonly cotacoesMap = signal<Record<string, CotacaoItem>>({});
  readonly cotacoesMeta = signal<{ atualizadoEm: string | null; stale: boolean }>({
    atualizadoEm: null,
    stale: false,
  });
  readonly resumoBinance = signal<ResumoBinanceMetadata | null>(null);
  readonly cotacaoUsdBrl = signal<number | null>(null);
  readonly cotacaoBtcBrl = signal<number | null>(null);
  readonly transacoesAtivoModal = signal<Transacao[]>([]);
  readonly proventosAnuaisAtivos = signal<ProventosAtivoAnual[]>([]);
  readonly loading = signal<boolean>(false);
  readonly syncingCotacoes = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  private getInitialFiltroClasse(): FiltroClasseCarteira {
    try {
      const saved = localStorage.getItem(FILTRO_CLASSE_STORAGE_KEY) as FiltroClasseCarteira;
      const validos: FiltroClasseCarteira[] = [
        'RV_TOTAL',
        'ACAO',
        'FII',
        'CRIPTO',
        'RENDA_FIXA',
        'PATRIMONIO',
      ];
      if (saved && validos.includes(saved)) {
        return saved;
      }
    } catch (_) {}
    return 'RV_TOTAL';
  }

  private carregandoEmAndamento: number | null = null;
  ultimaCarteiraIdCarregada: number | null = null;

  constructor() {
    effect(() => {
      const id = this.carteiraService.carteiraAtivaId();
      if (id) {
        untracked(() => {
          this.carregarDados(id).catch(() => {});
        });
      }
    });
  }

  // ---------- Computed Signals ----------

  /**
   * 1. posicoesEnriquecidas:
   * Mapeia todas as posições (incluindo encerradas com saldo = 0) com dados calculados de PM Ajustado,
   * YoC, Rentabilidade, Proventos e status de cotação.
   */
  readonly posicoesEnriquecidas = computed<PosicaoEnriquecida[]>(() => {
    const posicoes = this.todasPosicoes();
    const cotacoes = this.cotacoesMap();

    return posicoes.map((p) => {
      const ativo: Ativo = p.ativo ?? {
        id: p.ativo_id,
        ticker: `ATIVO-${p.ativo_id}`,
        nome: `Ativo ${p.ativo_id}`,
        tipo: 'Acao',
      };

      const quantidade = Number(p.quantidade_saldo) || 0;
      const pmContabil = Number(p.preco_medio_brl) || 0;
      let custoTotal = Number(p.custo_total_brl) || 0;
      if (custoTotal <= 0 && quantidade > 0 && pmContabil > 0) {
        custoTotal = quantidade * pmContabil;
      }

      const quantidadeSemCusto = Number(p.quantidade_sem_custo) || 0;
      const lotesPendentes = p.lotes_pendentes || [];
      const custoPendente =
        Boolean(p.custo_pendente) ||
        (quantidade > 0 && pmContabil <= 0) ||
        quantidadeSemCusto > 0;

      const proventosTotal = Number(p.proventos_acumulados_brl) || 0;
      const dividendoPorAcao = quantidade > 0 ? proventosTotal / quantidade : 0;
      const pmAjustado = pmContabil > 0 ? Math.max(0, pmContabil - dividendoPorAcao) : 0;

      // Resolução da cotação
      const tickerKey = (ativo.ticker || '').toUpperCase().trim();
      const cotacaoItem = cotacoes[tickerKey];
      let cotacaoAtual = 0;
      let fonteCotacao: CotacaoItem['fonte'] = 'INDISPONIVEL';
      let variacaoDiariaPct = 0;

      if (ativo.cotacao_manual != null && Number(ativo.cotacao_manual) > 0) {
        cotacaoAtual = Number(ativo.cotacao_manual);
        fonteCotacao = 'MANUAL';
        variacaoDiariaPct =
          cotacaoItem && Number(cotacaoItem.variacao_diaria_pct)
            ? Number(cotacaoItem.variacao_diaria_pct)
            : 0;
      } else if (cotacaoItem && Number(cotacaoItem.preco_atual) > 0) {
        cotacaoAtual = Number(cotacaoItem.preco_atual);
        fonteCotacao = cotacaoItem.fonte;
        variacaoDiariaPct = Number(cotacaoItem.variacao_diaria_pct) || 0;
      } else if (pmContabil > 0) {
        cotacaoAtual = pmContabil;
        fonteCotacao = 'INDISPONIVEL';
        variacaoDiariaPct = 0;
      } else {
        cotacaoAtual = 0;
        fonteCotacao = 'INDISPONIVEL';
        variacaoDiariaPct = 0;
      }

      const valorMercado = quantidade * cotacaoAtual;
      const lucroRealizadoBrl = Number(p.lucro_realizado_brl) || 0;
      const valorTotalVendaBrl = Number(p.valor_total_venda_brl) || (
        (custoTotal > 0 || lucroRealizadoBrl !== 0) ? Math.max(0, custoTotal + lucroRealizadoBrl) : 0
      );
      if (quantidade === 0) {
        if (p.custo_historico_brl != null && Number(p.custo_historico_brl) > 0) {
          custoTotal = Number(p.custo_historico_brl);
        } else if (custoPendente && lucroRealizadoBrl === 0) {
          custoTotal = 0;
        } else if (valorTotalVendaBrl > 0 || lucroRealizadoBrl !== 0) {
          custoTotal = Math.max(0, valorTotalVendaBrl - lucroRealizadoBrl);
        } else if (p.custo_total_brl != null && Number(p.custo_total_brl) > 0) {
          custoTotal = Number(p.custo_total_brl);
        } else {
          custoTotal = 0;
        }
      }
      const lucroNaoRealizadoBrl = (quantidade === 0 || custoPendente) ? 0 : valorMercado - custoTotal;
      const rentabCotaPct = custoTotal > 0 ? ((valorMercado - custoTotal) / custoTotal) * 100 : 0;
      const retornoTotalBrl = lucroNaoRealizadoBrl + proventosTotal + lucroRealizadoBrl;
      const rentabTotalComDivPct =
        custoTotal > 0 ? ((valorMercado + proventosTotal - custoTotal) / custoTotal) * 100 : 0;
      const yocPct = custoTotal > 0 ? (proventosTotal / custoTotal) * 100 : 0;

      // Resolução de Criptoativos (USD, Staking Earn, Autocustódia e IRPF)
      const cotacaoUsd = cotacaoItem?.preco_usd != null ? Number(cotacaoItem.preco_usd) : null;
      const cotacaoBtc = cotacaoItem?.preco_btc != null ? Number(cotacaoItem.preco_btc) : null;
      const valorMercadoUsd = cotacaoUsd != null ? quantidade * cotacaoUsd : null;
      const valorMercadoBtc = cotacaoBtc != null ? quantidade * cotacaoBtc : null;

      const pmUsd = p.preco_medio_usd != null ? Number(p.preco_medio_usd) : null;
      const pmAjustadoUsd =
        pmUsd != null && pmContabil > 0
          ? Math.max(0, pmUsd * (pmAjustado / pmContabil))
          : pmUsd;

      const qtdAutocustodia = p.qtd_autocustodia != null ? Number(p.qtd_autocustodia) : null;
      const qtdEarn = p.qtd_earn != null ? Number(p.qtd_earn) : null;
      const pctAutocustodia =
        p.pct_autocustodia != null
          ? Number(p.pct_autocustodia)
          : (quantidade > 0 && qtdAutocustodia != null ? (qtdAutocustodia / quantidade) * 100 : null);
      const pctEarn =
        p.pct_earn != null
          ? Number(p.pct_earn)
          : (quantidade > 0 && qtdEarn != null ? (qtdEarn / quantidade) * 100 : null);

      const earnInterestMoeda = p.earn_interest_moeda != null ? Number(p.earn_interest_moeda) : null;
      const codigoRfbIrpf = p.codigo_rfb_irpf || (ativo.tipo === 'Cripto' ? (ativo.ticker === 'BTC' ? '08/01' : '08/02') : null);
      const textoIrpfBensDireitos =
        p.texto_irpf ||
        (codigoRfbIrpf
          ? `${quantidade.toLocaleString('pt-BR', { maximumFractionDigits: 8 })} unidades do criptoativo ${ativo.ticker} (${qtdAutocustodia != null ? qtdAutocustodia.toLocaleString('pt-BR', { maximumFractionDigits: 8 }) : '0'} em autocustódia externa e ${qtdEarn != null ? qtdEarn.toLocaleString('pt-BR', { maximumFractionDigits: 8 }) : '0'} na corretora Binance), com custo total de aquisição de R$ ${custoTotal.toFixed(2)}.`
          : null);

      const quantidadeVendida = p.quantidade_vendida != null ? Number(p.quantidade_vendida) : null;
      const custoVendasBrl = p.custo_vendas_brl != null ? Number(p.custo_vendas_brl) : null;
      const valorTotalVendasBrl = p.valor_total_vendas_brl != null ? Number(p.valor_total_vendas_brl) : null;

      return {
        posicao: p,
        ativo,
        quantidade,
        pmContabil,
        custoTotal,
        custoPendente,
        quantidadeSemCusto,
        lotesPendentes,
        valorTotalVendaBrl,
        proventosTotal,
        dividendoPorAcao,
        pmAjustado,
        cotacaoAtual,
        fonteCotacao,
        variacaoDiariaPct,
        valorMercado,
        lucroNaoRealizadoBrl,
        rentabCotaPct,
        retornoTotalBrl,
        rentabTotalComDivPct,
        yocPct,
        lucroRealizadoBrl,
        pesoCarteiraPct: 0,
        pmUsd,
        pmAjustadoUsd,
        cotacaoUsd,
        cotacaoBtc,
        valorMercadoUsd,
        valorMercadoBtc,
        qtdAutocustodia,
        qtdEarn,
        pctAutocustodia,
        pctEarn,
        earnInterestMoeda,
        codigoRfbIrpf,
        textoIrpfBensDireitos,
        quantidadeVendida,
        custoVendasBrl,
        valorTotalVendasBrl,
      };
    });
  });

  /**
   * 2. posicoesFiltradasAtivas:
   * Filtra as posições enriquecidas com quantidade > 0 pela classe selecionada,
   * calcula o peso % individual sobre o valor total da aba filtrada,
   * e aplica a busca por texto e ordenação.
   */
  readonly posicoesFiltradasAtivas = computed<PosicaoEnriquecida[]>(() => {
    const filtro = this.filtroClasse();
    const todas = this.posicoesEnriquecidas();

    // Filtra quantidade > 0 e classe
    const ativasNaClasse = todas.filter(
      (p) => p.quantidade > 0 && matchClasse(p.ativo.tipo, filtro),
    );

    // Calcula peso relativo sobre o valor de mercado total da aba
    const totalMercadoAba = ativasNaClasse.reduce((acc, p) => acc + p.valorMercado, 0);
    const comPeso = ativasNaClasse.map((p) => ({
      ...p,
      pesoCarteiraPct: totalMercadoAba > 0 ? (p.valorMercado / totalMercadoAba) * 100 : 0,
    }));

    // Aplica busca por texto
    const busca = this.buscaTexto().trim().toLowerCase();
    const filtradas = busca
      ? comPeso.filter((p) => {
          const ticker = (p.ativo.ticker || '').toLowerCase();
          const nome = (p.ativo.nome || '').toLowerCase();
          const setor = (p.ativo.setor || '').toLowerCase();
          return ticker.includes(busca) || nome.includes(busca) || setor.includes(busca);
        })
      : comPeso;

    // Aplica ordenação
    const { campo, direcao } = this.ordenacao();
    const mult = direcao === 'asc' ? 1 : -1;

    return [...filtradas].sort((a, b) => {
      let valA: unknown;
      let valB: unknown;

      switch (campo) {
        case 'ticker':
          valA = a.ativo.ticker;
          valB = b.ativo.ticker;
          return mult * String(valA).localeCompare(String(valB));
        case 'nome':
          valA = a.ativo.nome;
          valB = b.ativo.nome;
          return mult * String(valA).localeCompare(String(valB));
        case 'tipo':
          valA = a.ativo.tipo;
          valB = b.ativo.tipo;
          return mult * String(valA).localeCompare(String(valB));
        case 'setor':
          valA = a.ativo.setor || '';
          valB = b.ativo.setor || '';
          return mult * String(valA).localeCompare(String(valB));
        case 'quantidade':
          valA = a.quantidade;
          valB = b.quantidade;
          break;
        case 'pmContabil':
          valA = a.pmContabil;
          valB = b.pmContabil;
          break;
        case 'dividendoPorAcao':
          valA = a.dividendoPorAcao;
          valB = b.dividendoPorAcao;
          break;
        case 'pmAjustado':
          valA = a.pmAjustado;
          valB = b.pmAjustado;
          break;
        case 'cotacaoAtual':
          valA = a.cotacaoAtual;
          valB = b.cotacaoAtual;
          break;
        case 'custoTotal':
          valA = a.custoTotal;
          valB = b.custoTotal;
          break;
        case 'valorMercado':
          valA = a.valorMercado;
          valB = b.valorMercado;
          break;
        case 'lucroNaoRealizadoBrl':
          valA = a.lucroNaoRealizadoBrl;
          valB = b.lucroNaoRealizadoBrl;
          break;
        case 'rentabCotaPct':
          valA = a.rentabCotaPct;
          valB = b.rentabCotaPct;
          break;
        case 'proventosTotal':
          valA = a.proventosTotal;
          valB = b.proventosTotal;
          break;
        case 'retornoTotalBrl':
          valA = a.retornoTotalBrl;
          valB = b.retornoTotalBrl;
          break;
        case 'rentabTotalComDivPct':
          valA = a.rentabTotalComDivPct;
          valB = b.rentabTotalComDivPct;
          break;
        case 'yocPct':
          valA = a.yocPct;
          valB = b.yocPct;
          break;
        case 'pesoCarteiraPct':
          valA = a.pesoCarteiraPct;
          valB = b.pesoCarteiraPct;
          break;
        default:
          valA = (a as unknown as Record<string, unknown>)[campo] ?? 0;
          valB = (b as unknown as Record<string, unknown>)[campo] ?? 0;
      }

      if (typeof valA === 'string' && typeof valB === 'string') {
        return mult * valA.localeCompare(valB);
      }
      const numA = valA != null && !isNaN(Number(valA)) ? Number(valA) : 0;
      const numB = valB != null && !isNaN(Number(valB)) ? Number(valB) : 0;
      return mult * (numA - numB);
    });
  });

  /**
   * 2b. posicoesFiltradasEncerradas:
   * Filtra as posições enriquecidas com quantidade === 0 (posições encerradas/já vendidas)
   * que possuem histórico na carteira (lucro realizado, proventos recebidos ou lotes transferidos pendentes),
   * aplicando a classe selecionada, busca por texto e ordenação.
   */
  readonly posicoesFiltradasEncerradas = computed<PosicaoEnriquecida[]>(() => {
    const filtro = this.filtroClasse();
    const todas = this.posicoesEnriquecidas();

    const encerradasNaClasse = todas.filter(
      (p) =>
        (p.quantidade === 0 || (p.ativo.tipo === 'Cripto' && ((p.quantidadeVendida || 0) > 0 || p.lucroRealizadoBrl !== 0))) &&
        matchClasse(p.ativo.tipo, filtro) &&
        (p.lucroRealizadoBrl !== 0 ||
          p.proventosTotal > 0 ||
          p.custoTotal > 0 ||
          p.quantidadeSemCusto > 0 ||
          p.lotesPendentes.length > 0 ||
          (p.valorTotalVendaBrl || 0) > 0 ||
          (p.quantidadeVendida || 0) > 0),
    );

    const busca = this.buscaTexto().trim().toLowerCase();
    const filtradas = busca
      ? encerradasNaClasse.filter((p) => {
          const ticker = (p.ativo.ticker || '').toLowerCase();
          const nome = (p.ativo.nome || '').toLowerCase();
          const setor = (p.ativo.setor || '').toLowerCase();
          return ticker.includes(busca) || nome.includes(busca) || setor.includes(busca);
        })
      : encerradasNaClasse;

    const { campo, direcao } = this.ordenacao();
    const mult = direcao === 'asc' ? 1 : -1;

    return [...filtradas].sort((a, b) => {
      let valA: unknown;
      let valB: unknown;

      switch (campo) {
        case 'ticker':
          return mult * String(a.ativo.ticker).localeCompare(String(b.ativo.ticker));
        case 'nome':
          return mult * String(a.ativo.nome).localeCompare(String(b.ativo.nome));
        case 'tipo':
          return mult * String(a.ativo.tipo).localeCompare(String(b.ativo.tipo));
        case 'custoTotal':
          valA = a.custoVendasBrl != null ? a.custoVendasBrl : a.custoTotal;
          valB = b.custoVendasBrl != null ? b.custoVendasBrl : b.custoTotal;
          break;
        case 'valorTotalVendaBrl':
          valA = a.valorTotalVendasBrl != null ? a.valorTotalVendasBrl : (a.valorTotalVendaBrl || 0);
          valB = b.valorTotalVendasBrl != null ? b.valorTotalVendasBrl : (b.valorTotalVendaBrl || 0);
          break;
        case 'lucroRealizadoBrl':
          valA = a.lucroRealizadoBrl;
          valB = b.lucroRealizadoBrl;
          break;
        case 'proventosTotal':
          valA = a.proventosTotal;
          valB = b.proventosTotal;
          break;
        default:
          valA = (a as unknown as Record<string, unknown>)[campo] ?? a.ativo.ticker;
          valB = (b as unknown as Record<string, unknown>)[campo] ?? b.ativo.ticker;
      }

      if (typeof valA === 'string' && typeof valB === 'string') {
        return mult * valA.localeCompare(valB);
      }
      const numA = valA != null && !isNaN(Number(valA)) ? Number(valA) : 0;
      const numB = valB != null && !isNaN(Number(valB)) ? Number(valB) : 0;
      return mult * (numA - numB);
    });
  });

  /**
   * 3. kpis:
   * Calcula os 6 KPI Cards sobre o conjunto filtrado da aba selecionada,
   * preservando proventosTotal e lucroRealizadoBrl de posições encerradas (saldo = 0) da mesma classe.
   */
  readonly kpis = computed<CarteiraKpis>(() => {
    const filtro = this.filtroClasse();
    const todas = this.posicoesEnriquecidas();

    // Todas as posições da classe (ativas + encerradas)
    const todasDaClasse = todas.filter((p) => matchClasse(p.ativo.tipo, filtro));
    // Posições com saldo positivo (em custódia)
    const ativas = todasDaClasse.filter((p) => p.quantidade > 0);

    const qtdAtivosCustodia = ativas.length;
    const qtdAtivosCustoPendente = ativas.filter((p) => p.custoPendente).length;
    const montanteAportadoBrl = ativas.reduce((acc, p) => acc + p.custoTotal, 0);
    const patrimonioMercadoBrl = ativas.reduce((acc, p) => acc + p.valorMercado, 0);
    const valorizacaoCotaBrl = ativas.reduce((acc, p) => acc + p.lucroNaoRealizadoBrl, 0);

    // Variação % da cota calculada sobre ativos com custo conhecido > 0 para não distorcer com ativos "A definir"
    const ativosComCusto = ativas.filter((p) => !p.custoPendente && p.custoTotal > 0);
    const custoConhecidoTotal = ativosComCusto.reduce((acc, p) => acc + p.custoTotal, 0);
    const valorizacaoConhecida = ativosComCusto.reduce((acc, p) => acc + p.lucroNaoRealizadoBrl, 0);
    const valorizacaoCotaPct =
      custoConhecidoTotal > 0 ? (valorizacaoConhecida / custoConhecidoTotal) * 100 : 0;

    // Proventos e Lucro Realizado agregam tanto ativos em custódia quanto encerrados
    const proventosRecebidosBrl = todasDaClasse.reduce((acc, p) => acc + p.proventosTotal, 0);
    const lucroRealizadoTotalBrl = todasDaClasse.reduce((acc, p) => acc + p.lucroRealizadoBrl, 0);

    // Yield on Cost acumulado da carteira
    const yocCarteiraPct =
      montanteAportadoBrl > 0 ? (proventosRecebidosBrl / montanteAportadoBrl) * 100 : 0;

    // Redução média do preço médio contábil pelos dividendos
    const custoAjustadoTotal = ativas.reduce((acc, p) => acc + p.pmAjustado * p.quantidade, 0);
    const reducaoMediaPmPct =
      montanteAportadoBrl > 0
        ? Math.max(0, ((montanteAportadoBrl - custoAjustadoTotal) / montanteAportadoBrl) * 100)
        : 0;

    // Retorno Total = Cota Aberta + Proventos Recebidos + Lucro Realizado de Vendas
    const retornoTotalBrl = valorizacaoCotaBrl + proventosRecebidosBrl + lucroRealizadoTotalBrl;
    const baseRetorno = custoConhecidoTotal > 0 ? custoConhecidoTotal : montanteAportadoBrl;
    const retornoTotalPct = baseRetorno > 0 ? (retornoTotalBrl / baseRetorno) * 100 : 0;

    const patrimonioMercadoUsd = ativas.reduce((acc, p) => acc + (p.valorMercadoUsd || 0), 0);
    const patrimonioMercadoBtc = ativas.reduce((acc, p) => acc + (p.valorMercadoBtc || 0), 0);

    return {
      montanteAportadoBrl,
      qtdAtivosCustoPendente,
      qtdAtivosCustodia,
      patrimonioMercadoBrl,
      valorizacaoCotaBrl,
      valorizacaoCotaPct,
      proventosRecebidosBrl,
      yocCarteiraPct,
      reducaoMediaPmPct,
      retornoTotalBrl,
      retornoTotalPct,
      lucroRealizadoTotalBrl,
      patrimonioMercadoUsd,
      patrimonioMercadoBtc,
    };
  });

  /**
   * 4. chartAlocacaoClasseSetor:
   * Dados para o gráfico Donut de alocação por Classe e por Setor.
   */
  readonly chartAlocacaoClasseSetor = computed<ChartAlocacaoData>(() => {
    const filtro = this.filtroClasse();
    const todas = this.posicoesEnriquecidas();
    const ativas = todas.filter((p) => p.quantidade > 0 && matchClasse(p.ativo.tipo, filtro));
    const totalMercado = ativas.reduce((acc, p) => acc + p.valorMercado, 0);

    // Agrupamento por Ativo (cada ativo individual, ordenado por maior valor de mercado)
    const ordenadoAtivos = [...ativas].sort((a, b) => b.valorMercado - a.valorMercado);
    const labelsAtivo = ordenadoAtivos.map((p) => p.ativo.ticker);
    const dataAtivo = ordenadoAtivos.map((p) => p.valorMercado);
    const pctAtivo = dataAtivo.map((v) => (totalMercado > 0 ? (v / totalMercado) * 100 : 0));

    // Agrupamento por Setor
    const mapaSetores: Record<string, number> = {};
    for (const item of ativas) {
      const setor = inferirSetorAtivo(item.ativo.ticker, item.ativo.setor, item.ativo.tipo);
      mapaSetores[setor] = (mapaSetores[setor] || 0) + item.valorMercado;
    }
    const ordenadoSetores = Object.entries(mapaSetores).sort((a, b) => b[1] - a[1]);
    const labelsSetor = ordenadoSetores.map(([s]) => s);
    const dataSetor = ordenadoSetores.map(([, val]) => val);
    const pctSetor = dataSetor.map((v) => (totalMercado > 0 ? (v / totalMercado) * 100 : 0));

    // Agrupamento por Classe
    const mapaClasses: Record<string, number> = {};
    for (const item of ativas) {
      const cls = item.ativo?.tipo || 'Outros';
      mapaClasses[cls] = (mapaClasses[cls] || 0) + item.valorMercado;
    }
    const ordenadoClasses = Object.entries(mapaClasses).sort((a, b) => b[1] - a[1]);
    const labelsClasse = ordenadoClasses.map(([cls]) => cls);
    const dataClasse = ordenadoClasses.map(([, val]) => val);
    const pctClasse = dataClasse.map((v) => (totalMercado > 0 ? (v / totalMercado) * 100 : 0));

    return {
      porAtivo: { labels: labelsAtivo, data: dataAtivo, percentual: pctAtivo },
      porSetor: { labels: labelsSetor, data: dataSetor, percentual: pctSetor },
      porClasse: { labels: labelsClasse, data: dataClasse, percentual: pctClasse },
    };
  });

  /**
   * 5. chartPesoAtivos:
   * Top 12 ativos por peso % no Patrimônio Atual (+ fatia "Outros" se houver mais de 12).
   */
  readonly chartPesoAtivos = computed<ChartPesoAtivosData>(() => {
    const filtro = this.filtroClasse();
    const todas = this.posicoesEnriquecidas();
    const ativas = todas
      .filter((p) => p.quantidade > 0 && matchClasse(p.ativo.tipo, filtro))
      .sort((a, b) => b.valorMercado - a.valorMercado);

    const totalMercado = ativas.reduce((acc, p) => acc + p.valorMercado, 0);

    if (ativas.length <= 12) {
      return {
        labels: ativas.map((p) => p.ativo.ticker),
        data: ativas.map((p) => p.valorMercado),
        percentual: ativas.map((p) =>
          totalMercado > 0 ? (p.valorMercado / totalMercado) * 100 : 0,
        ),
      };
    }

    const top11 = ativas.slice(0, 11);
    const restantes = ativas.slice(11);
    const outrosMercado = restantes.reduce((acc, p) => acc + p.valorMercado, 0);
    const outrosPct = totalMercado > 0 ? (outrosMercado / totalMercado) * 100 : 0;

    return {
      labels: [...top11.map((p) => p.ativo.ticker), 'Outros'],
      data: [...top11.map((p) => p.valorMercado), outrosMercado],
      percentual: [
        ...top11.map((p) => (totalMercado > 0 ? (p.valorMercado / totalMercado) * 100 : 0)),
        outrosPct,
      ],
    };
  });

  /**
   * 6. chartRankingProventos:
   * Top 10 ativos geradores de proventos com proventosTotal (R$) e yocPct (%).
   */
  readonly chartRankingProventos = computed<ChartRankingProventosData>(() => {
    const filtro = this.filtroClasse();
    const todas = this.posicoesEnriquecidas();

    const comProventos = todas
      .filter((p) => matchClasse(p.ativo.tipo, filtro) && p.proventosTotal > 0)
      .sort((a, b) => b.proventosTotal - a.proventosTotal)
      .slice(0, 10);

    return {
      labels: comProventos.map((p) => p.ativo.ticker),
      proventos: comProventos.map((p) => p.proventosTotal),
      yoc: comProventos.map((p) => p.yocPct),
    };
  });

  /**
   * 7. proventosAnuaisCustodiaFiltrados:
   * Retorna os ativos que estão em custódia ativa (quantidade_saldo > 0)
   * que pertencem à classe filtrada e possuem proventos registrados,
   * ordenados por maior total de Dividendos + JSCP.
   */
  readonly proventosAnuaisCustodiaFiltrados = computed<ProventosAtivoAnual[]>(() => {
    const filtro = this.filtroClasse();
    const todos = this.proventosAnuaisAtivos();
    return todos
      .filter(
        (a) =>
          a.em_custodia &&
          Number(a.quantidade_saldo) > 0 &&
          matchClasse(a.tipo_ativo, filtro) &&
          Number(a.total_geral_brl) > 0,
      )
      .sort(
        (a, b) =>
          Number(b.total_div_jcp_brl) - Number(a.total_div_jcp_brl) ||
          Number(b.total_geral_brl) - Number(a.total_geral_brl) ||
          (a.ticker || '').localeCompare(b.ticker || ''),
      );
  });

  // ---------- Ações de Estado ----------

  setVisaoCustodia(visao: 'ATIVAS' | 'ENCERRADAS'): void {
    this.visaoCustodia.set(visao);
  }

  setFiltroClasse(filtro: FiltroClasseCarteira): void {
    this.filtroClasse.set(filtro);
    try {
      localStorage.setItem(FILTRO_CLASSE_STORAGE_KEY, filtro);
    } catch (_) {}
  }

  setBuscaTexto(texto: string): void {
    this.buscaTexto.set(texto);
  }

  setOrdenacao(campo: string, direcao?: 'asc' | 'desc'): void {
    const atual = this.ordenacao();
    if (direcao) {
      this.ordenacao.set({ campo, direcao });
    } else if (atual.campo === campo) {
      this.ordenacao.set({
        campo,
        direcao: atual.direcao === 'asc' ? 'desc' : 'asc',
      });
    } else {
      const defaultAsc = ['ticker', 'nome', 'tipo', 'setor'].includes(campo);
      this.ordenacao.set({ campo, direcao: defaultAsc ? 'asc' : 'desc' });
    }
  }

  async carregarDados(carteiraId?: number, forcarCotacoes: boolean = false, silencioso: boolean = false): Promise<void> {
    const id = carteiraId !== undefined ? carteiraId : this.carteiraService.carteiraAtivaId();
    if (!id) return;

    if (this.carregandoEmAndamento === id && !forcarCotacoes) {
      return;
    }
    this.carregandoEmAndamento = id;

    if (!silencioso && this.todasPosicoes().length === 0) {
      this.loading.set(true);
    }
    this.error.set(null);

    try {
      const cotacoesExistentes = this.cotacoesMap();
      const temCotacoes = Object.keys(cotacoesExistentes).length > 0;

      // 1. Busca sempre as posições consolidadas da carteira
      const posicoes = await firstValueFrom(this.carteiraService.getPosicoes(id, false));
      this.todasPosicoes.set(posicoes || []);

      // Se a carteira estiver vazia (sem posições), interrompe sem buscar cotações ou proventos desnecessários
      if (!posicoes || posicoes.length === 0) {
        this.cotacoesMap.set({});
        this.proventosAnuaisAtivos.set([]);
        this.cotacoesMeta.set({
          atualizadoEm: new Date().toISOString(),
          stale: false,
        });
        return;
      }

      // 2. Se a carteira possui ativos, busca proventos e cotações de acordo com a estratégia de cache
      const proventosReq = this.carteiraService.obterProventosAnuais(id, undefined, false).pipe(
        catchError((provErr) => {
          console.warn('Falha ao obter proventos anuais:', provErr);
          return of({ carteira_id: id, ativos: [] } as ProventosAnuaisCarteiraResponse);
        }),
      );

      let cotacoesResp: CotacoesCarteiraResponse | null = null;
      let provResp: ProventosAnuaisCarteiraResponse | null = null;

      if (silencioso && temCotacoes && !forcarCotacoes) {
        provResp = await firstValueFrom(proventosReq);
      } else {
        const [cot, prov] = await firstValueFrom(
          forkJoin([
            this.carteiraService.obterCotacoes(id, forcarCotacoes).pipe(
              catchError((cotacaoErr) => {
                console.warn('Falha ao obter cotações, usando fallback offline:', cotacaoErr);
                return of({
                  carteira_id: id,
                  atualizado_em: new Date().toISOString(),
                  stale: true,
                  cotacoes: {},
                } as CotacoesCarteiraResponse);
              }),
            ),
            proventosReq,
          ]),
        );
        cotacoesResp = cot;
        provResp = prov;
      }

      if (provResp) {
        this.proventosAnuaisAtivos.set(provResp.ativos || []);
      }
      if (cotacoesResp) {
        this.cotacoesMap.set(cotacoesResp?.cotacoes || {});
        this.cotacoesMeta.set({
          atualizadoEm: cotacoesResp?.atualizado_em || null,
          stale: Boolean(cotacoesResp?.stale),
        });
        if (cotacoesResp.resumo_binance) {
          this.resumoBinance.set(cotacoesResp.resumo_binance);
        }
        if (cotacoesResp.cotacao_usd_brl != null) {
          this.cotacaoUsdBrl.set(Number(cotacoesResp.cotacao_usd_brl));
        }
        if (cotacoesResp.cotacao_btc_brl != null) {
          this.cotacaoBtcBrl.set(Number(cotacoesResp.cotacao_btc_brl));
        }
      }
    } catch (err: unknown) {
      console.error('Erro ao carregar dados da carteira:', err);
      const msg =
        (err as { error?: { detail?: string } })?.error?.detail ||
        'Não foi possível carregar as posições e cotações da carteira.';
      this.error.set(msg);
    } finally {
      this.carregandoEmAndamento = null;
      this.ultimaCarteiraIdCarregada = id;
      this.loading.set(false);
    }
  }

  async atualizarCotacoes(forcar: boolean = true): Promise<void> {
    const id = this.carteiraService.carteiraAtivaId();
    this.syncingCotacoes.set(true);
    try {
      const cotacoesResp = await firstValueFrom(
        this.carteiraService.obterCotacoes(id, forcar),
      );
      this.cotacoesMap.set(cotacoesResp?.cotacoes || {});
      this.cotacoesMeta.set({
        atualizadoEm: cotacoesResp?.atualizado_em || null,
        stale: Boolean(cotacoesResp?.stale),
      });
      if (cotacoesResp.resumo_binance) {
        this.resumoBinance.set(cotacoesResp.resumo_binance);
      }
      if (cotacoesResp.cotacao_usd_brl != null) {
        this.cotacaoUsdBrl.set(Number(cotacoesResp.cotacao_usd_brl));
      }
      if (cotacoesResp.cotacao_btc_brl != null) {
        this.cotacaoBtcBrl.set(Number(cotacoesResp.cotacao_btc_brl));
      }
    } catch (err: unknown) {
      console.error('Erro ao atualizar cotações:', err);
      const msg =
        (err as { error?: { detail?: string } })?.error?.detail ||
        'Não foi possível atualizar as cotações no momento.';
      this.error.set(msg);
    } finally {
      this.syncingCotacoes.set(false);
    }
  }

  async recalcular(): Promise<void> {
    const id = this.carteiraService.carteiraAtivaId();
    if (this.todasPosicoes().length === 0) {
      this.loading.set(true);
    }
    try {
      await firstValueFrom(this.carteiraService.recalcularCarteira(id));
      await this.carregarDados(id, false, true);
    } catch (err: unknown) {
      console.error('Erro ao recalcular carteira:', err);
      const msg =
        (err as { error?: { detail?: string } })?.error?.detail ||
        'Erro ao recalcular carteira.';
      this.error.set(msg);
    } finally {
      this.loading.set(false);
    }
  }

  async ajustarPosicaoManual(
    ativoId: number,
    payload: AjusteManualPosicaoDto,
  ): Promise<void> {
    const id = this.carteiraService.carteiraAtivaId();
    try {
      const posAtualizada = await firstValueFrom(
        this.carteiraService.ajustarPosicaoManual(id, ativoId, payload),
      );
      if (posAtualizada && posAtualizada.ativo_id) {
        this.todasPosicoes.update((lista) =>
          lista.map((p) => (p.ativo_id === ativoId ? posAtualizada : p)),
        );
      }
      await this.carregarDados(id, false, true);
    } catch (err: unknown) {
      console.error('Erro ao ajustar posição manual:', err);
      const msg =
        (err as { error?: { detail?: string } })?.error?.detail ||
        'Erro ao ajustar posição manual.';
      this.error.set(msg);
      throw err;
    }
  }

  async atualizarAtivo(ativoId: number, payload: AtivoUpdateDto): Promise<void> {
    try {
      await firstValueFrom(this.carteiraService.atualizarAtivo(ativoId, payload));
      await this.carregarDados(this.carteiraService.carteiraAtivaId(), false, true);
    } catch (err: unknown) {
      console.error('Erro ao atualizar ativo:', err);
      const msg =
        (err as { error?: { detail?: string } })?.error?.detail ||
        'Erro ao atualizar ativo.';
      this.error.set(msg);
      throw err;
    }
  }

  async definirCotacaoManual(
    ativoId: number,
    cotacaoManual: number | null,
  ): Promise<void> {
    try {
      await firstValueFrom(
        this.carteiraService.definirCotacaoManual(ativoId, cotacaoManual),
      );
      await this.carregarDados(this.carteiraService.carteiraAtivaId(), false, true);
    } catch (err: unknown) {
      console.error('Erro ao definir cotação manual:', err);
      const msg =
        (err as { error?: { detail?: string } })?.error?.detail ||
        'Erro ao definir cotação manual.';
      this.error.set(msg);
      throw err;
    }
  }

  async converterTicker(ativoId: number, payload: ConversaoTickerDto): Promise<void> {
    try {
      await firstValueFrom(this.carteiraService.converterTicker(ativoId, payload));
      await this.carregarDados(this.carteiraService.carteiraAtivaId(), false, true);
    } catch (err: unknown) {
      console.error('Erro ao converter ticker:', err);
      const msg =
        (err as { error?: { detail?: string } })?.error?.detail ||
        'Erro ao converter ticker.';
      this.error.set(msg);
      throw err;
    }
  }

  async excluirAtivo(ativoId: number): Promise<void> {
    try {
      await firstValueFrom(this.carteiraService.excluirAtivo(ativoId));
      this.transacoesAtivoModal.update((txs) => txs.filter((t) => t.ativo_id !== ativoId));
      await this.carregarDados(this.carteiraService.carteiraAtivaId(), false, true);
    } catch (err: unknown) {
      console.error('Erro ao excluir ativo:', err);
      const msg =
        (err as { error?: { detail?: string } })?.error?.detail ||
        'Erro ao excluir ativo.';
      this.error.set(msg);
      throw err;
    }
  }

  async carregarTransacoesAtivo(ativoId: number): Promise<void> {
    const id = this.carteiraService.carteiraAtivaId();
    try {
      const txs = await firstValueFrom(
        this.carteiraService.listarTransacoes({ carteiraId: id, ativoId }),
      );
      this.transacoesAtivoModal.set(txs || []);
    } catch (err: unknown) {
      console.error('Erro ao carregar transações do ativo:', err);
      this.transacoesAtivoModal.set([]);
    }
  }

  async criarTransacao(payload: TransacaoCreateDto): Promise<void> {
    try {
      const novaTx = await firstValueFrom(this.carteiraService.criarTransacao(payload));
      const modalTxs = this.transacoesAtivoModal();
      if (modalTxs.length > 0 && modalTxs[0].ativo_id === payload.ativo_id) {
        this.transacoesAtivoModal.set([novaTx, ...modalTxs]);
      }
      await this.carregarDados(this.carteiraService.carteiraAtivaId(), false, true);
    } catch (err: unknown) {
      console.error('Erro ao criar transação:', err);
      const msg =
        (err as { error?: { detail?: string } })?.error?.detail ||
        'Erro ao registrar transação.';
      this.error.set(msg);
      throw err;
    }
  }

  async atualizarTransacao(
    transacaoId: number,
    payload: TransacaoUpdateDto,
  ): Promise<void> {
    try {
      const updatedTx = await firstValueFrom(
        this.carteiraService.atualizarTransacao(transacaoId, payload),
      );
      this.transacoesAtivoModal.update((txs) =>
        txs.map((t) => (t.id === transacaoId ? { ...t, ...updatedTx } : t)),
      );
      await this.carregarDados(this.carteiraService.carteiraAtivaId(), false, true);
    } catch (err: unknown) {
      console.error('Erro ao atualizar transação:', err);
      const msg =
        (err as { error?: { detail?: string } })?.error?.detail ||
        'Erro ao atualizar transação.';
      this.error.set(msg);
      throw err;
    }
  }

  async excluirTransacao(transacaoId: number): Promise<void> {
    try {
      await firstValueFrom(this.carteiraService.excluirTransacao(transacaoId));
      this.transacoesAtivoModal.update((txs) => txs.filter((t) => t.id !== transacaoId));
      await this.carregarDados(this.carteiraService.carteiraAtivaId(), false, true);
    } catch (err: unknown) {
      console.error('Erro ao excluir transação:', err);
      const msg =
        (err as { error?: { detail?: string } })?.error?.detail ||
        'Erro ao excluir transação.';
      this.error.set(msg);
      throw err;
    }
  }
}
