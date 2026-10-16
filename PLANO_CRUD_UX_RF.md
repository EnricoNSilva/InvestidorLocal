# Plano Técnico: Proteção de UX no Modal e CRUD Completo de Títulos e Lotes de Renda Fixa (`PLANO_CRUD_UX_RF.md`)

**Projeto:** Investidor Local — Módulo de Renda Fixa  
**Status:** Especificação Arquitetural Pronta para Execução  

---

## Visão Geral e Objetivos

Durante os testes de usabilidade e gestão da carteira de Renda Fixa, foram identificadas duas lacunas críticas:
1. **Perda acidental de dados no `NovoTituloRfModalComponent`:** O fechamento imediato ao clicar no `backdrop` descartava todo o preenchimento do formulário.
2. **Ausência de Edição e Exclusão (CRUD Completo):** Não havia endpoints nem controles visuais para corrigir dados cadastrais de um título (`nome`, `ticker`, `produto`, `indexador`, `emissor`, `data_vencimento`, `isento_ir`, `cobra_custodia_b3`), editar todos os atributos de um lote já lançado (`data_compra`, `quantidade`, `preco_unitario`, `taxa_contratada`, `taxas`) ou excluir lotes e títulos com recálculo contábil automático (CMPM + PEPS).

Este documento especifica a solução ponta a ponta dividida em **2 Etapas** determinísticas.

---

## 1. Proteção de UX, Auto-Save de Rascunho e Modos de Edição no Modal (`NovoTituloRfModalComponent`)

### 1.1. Modos de Operação e Inputs
O componente `NovoTituloRfModalComponent` (`frontend/src/app/pages/renda-fixa/components/novo-titulo-modal.component.ts`) passa a suportar 4 modos:

```typescript
export type ModalMode = 'NOVO_TITULO' | 'NOVO_APORTE' | 'EDITAR_TITULO' | 'EDITAR_LOTE';
```

Novos `input()` Signals no componente:
- `initialMode = input<ModalMode>('NOVO_TITULO')`: Define o modo inicial ao abrir o modal.
- `editingAtivo = input<AtivoRendaFixa | null>(null)`: Quando em `'EDITAR_TITULO'`, fornece os dados atuais do ativo e de `detalhes_rf`.
- `editingLote = input<LoteAbertoDto | null>(null)`: Quando em `'EDITAR_LOTE'`, fornece os dados atuais do lote (`transacao_id`, `data_compra`, `quantidade_original`, `preco_unitario`, `taxa_contratada`, `custo_aberto_brl`).

### 1.2. Bloqueio de Fechamento Acidental no Backdrop
- **Remoção do fechamento no clique externo:** O handler `onBackdropClick(e: MouseEvent)` **não** emitirá `this.close.emit()`. O modal só poderá ser fechado pelos botões explícitos **`✕`** (cabeçalho) ou **`Cancelar`** (rodapé), ou após salvar com sucesso.
- **Botão explícito "🗑️ Limpar Campos":** Exibido nos modos de criação (`'NOVO_TITULO'` e `'NOVO_APORTE'`), restaura todos os campos aos valores padrão e remove o rascunho salvo no `localStorage`.

### 1.3. Persistência Automática de Rascunho (`localStorage`)
- **Chave:** `il.rendafixa.modal_draft.v1`
- **Comportamento:**
  1. Nos modos `'NOVO_TITULO'` e `'NOVO_APORTE'`, qualquer alteração nos campos do formulário invoca `saveDraft()`, gravando um objeto JSON sanitizado no `localStorage`.
  2. Ao inicializar o modal em `'NOVO_TITULO'` ou `'NOVO_APORTE'`, caso exista um rascunho válido em `il.rendafixa.modal_draft.v1`, os campos são restaurados automaticamente e um badge sutil `"📝 Rascunho restaurado automaticamente"` é exibido.
  3. Ao concluir `salvar()` com sucesso em `'NOVO_TITULO'` ou `'NOVO_APORTE'`, ou ao clicar em **"🗑️ Limpar Campos"**, `clearDraft()` remove a chave `il.rendafixa.modal_draft.v1`.
  4. Nos modos `'EDITAR_TITULO'` e `'EDITAR_LOTE'`, o modal popula os campos exclusivamente a partir de `editingAtivo()` / `editingLote()`, sem ler nem sobrescrever o rascunho de criação.

---

## 2. Backend FastAPI: Edição e Exclusão com Sincronia Contábil (CMPM + PEPS)

### 2.1. Blindagem de Ordenação Timezone-Safe em `backend/app/services/portfolio.py`
Em `recalcular_posicoes_carteira(db: Session, carteira_id: int)` (linha 175), normalizar `t.data_hora` para evitar `TypeError: can't compare offset-naive and offset-aware datetimes` quando transações editadas coexistirem com transações antigas no SQLite:

```python
def _tx_sort_key(t: Transacao):
    dt = t.data_hora
    if dt is not None and dt.tzinfo is not None:
        dt = dt.replace(tzinfo=None)
    return (dt or datetime.min, _op_priority(t.tipo_operacao), t.id or 0)

for ativo_id, lista_tx in tx_por_ativo.items():
    lista_tx.sort(key=_tx_sort_key)
```

### 2.2. Novos Schemas em `backend/app/schemas/renda_fixa.py`

```python
class LoteManualUpdate(BaseModel):
    data_compra: date
    quantidade: Decimal = Field(gt=Decimal("0"), max_digits=24, decimal_places=8)
    preco_unitario: Decimal = Field(gt=Decimal("0"), max_digits=24, decimal_places=8)
    taxa_contratada: Decimal = Field(ge=Decimal("-10"), le=Decimal("1000"), max_digits=8, decimal_places=4)
    taxas: Optional[Decimal] = Field(default=Decimal("0"), ge=Decimal("0"), max_digits=18, decimal_places=8)

    @field_validator("taxas", mode="before")
    @classmethod
    def _coerce_taxas(cls, v: Any) -> Decimal:
        if v is None:
            return Decimal("0")
        return v


class AtivoRendaFixaUpdate(BaseModel):
    ticker: Optional[str] = Field(default=None, max_length=30)
    nome: str = Field(min_length=2, max_length=150)
    detalhes: DetalhesRendaFixaUpsert
```

### 2.3. Novos Endpoints em `backend/app/api/v1/endpoints/renda_fixa.py`

1. **`PUT /api/v1/renda-fixa/ativos/{ativo_id}`** (`response_model=PosicaoRendaFixaRead`):
   - Busca `Ativo` por `ativo_id` (`404` se inexistente; `409` se `ativo.tipo != TipoAtivo.RendaFixa`).
   - Se `payload.ticker` for informado e `payload.ticker.strip()`:
     - Normaliza `novo_ticker = payload.ticker.strip().upper()`.
     - Verifica se já existe outro ativo com `Ativo.ticker == novo_ticker` e `Ativo.id != ativo_id` (se existir, lança `409 Conflict`).
     - Atualiza `ativo.ticker = novo_ticker`.
   - Atualiza `ativo.nome = payload.nome.strip()`.
   - Faz upsert de `ativo.detalhes_rf` com `payload.detalhes.model_dump()`.
   - Executa `db.commit()` e retorna `extrair_lotes_abertos(db=db, carteira_id=carteira_id, ativo_id=ativo.id)[0]`.

2. **`DELETE /api/v1/renda-fixa/ativos/{ativo_id}`** (`status_code=status.HTTP_204_NO_CONTENT`):
   - Busca `Ativo` por `ativo_id` (`404` se inexistente; `409` se `ativo.tipo != TipoAtivo.RendaFixa`).
   - Remove em transação atômica:
     - Todas as `PosicaoConsolidada` onde `PosicaoConsolidada.ativo_id == ativo_id`.
     - Todas as `Transacao` onde `Transacao.ativo_id == ativo_id`.
     - O registro `DetalhesRendaFixa` vinculado (`ativo.detalhes_rf`).
     - O próprio `Ativo`.
   - Executa `db.commit()` e retorna `Response(status_code=status.HTTP_204_NO_CONTENT)`.

3. **`PUT /api/v1/renda-fixa/lotes/{transacao_id}`** (`response_model=PosicaoRendaFixaRead`):
   - Busca `Transacao` por `transacao_id` (`404` se inexistente; `422` se `tx.ativo.tipo != TipoAtivo.RendaFixa`).
   - Atualiza:
     - `tx.data_hora = datetime.combine(payload.data_compra, datetime.min.time(), tzinfo=timezone.utc)`
     - `tx.quantidade = payload.quantidade`
     - `tx.preco_unitario = payload.preco_unitario`
     - `tx.taxa_contratada = payload.taxa_contratada`
     - `tx.taxas = payload.taxas or Decimal("0")`
   - Executa `db.flush()` e chama `recalcular_posicoes_carteira(db=db, carteira_id=tx.carteira_id)` para atualizar `posicoes_consolidadas` (CMPM).
   - Retorna `extrair_lotes_abertos(db=db, carteira_id=tx.carteira_id, ativo_id=tx.ativo_id)[0]`.

4. **`DELETE /api/v1/renda-fixa/lotes/{transacao_id}`** (`response_model=PosicaoRendaFixaRead`):
   - Busca `Transacao` por `transacao_id` (`404` se inexistente; `422` se `tx.ativo.tipo != TipoAtivo.RendaFixa`).
   - Preserva `carteira_id = tx.carteira_id` e `ativo_id = tx.ativo_id`.
   - Executa `db.delete(tx)` e `db.flush()`.
   - Chama `recalcular_posicoes_carteira(db=db, carteira_id=carteira_id)` (que recalcula o CMPM ou remove `PosicaoConsolidada` se não restarem lotes daquele ativo).
   - Retorna `extrair_lotes_abertos(db=db, carteira_id=carteira_id, ativo_id=ativo_id)[0]`.

---

## 3. Controles Visuais na Interface e Actions no `RendaFixaStore`

### 3.1. DTOs e `RendaFixaApiService`
Em `frontend/src/app/core/models/renda-fixa.models.ts`:
```typescript
export interface LoteManualUpdateDto {
  data_compra: string;
  quantidade: number | string;
  preco_unitario: number | string;
  taxa_contratada: number | string;
  taxas?: number | string;
}

export interface AtivoRendaFixaUpdateDto {
  ticker?: string | null;
  nome: string;
  detalhes: DetalhesRendaFixaUpsertDto;
}
```

Em `frontend/src/app/core/services/renda-fixa-api.service.ts`:
- `atualizarTituloRf(ativoId: number, payload: AtivoRendaFixaUpdateDto, carteiraId = 1): Observable<PosicaoRendaFixa>` (`PUT /ativos/${ativoId}?carteira_id=${carteiraId}`)
- `excluirTituloRf(ativoId: number): Observable<void>` (`DELETE /ativos/${ativoId}`)
- `atualizarLoteManual(transacaoId: number, payload: LoteManualUpdateDto): Observable<PosicaoRendaFixa>` (`PUT /lotes/${transacaoId}`)
- `excluirLoteManual(transacaoId: number): Observable<PosicaoRendaFixa>` (`DELETE /lotes/${transacaoId}`)

### 3.2. Novas Actions em `RendaFixaStore` (`renda-fixa.store.ts`)
Todas protegidas pelo contador de concorrência `reqSeq`:
1. **`atualizarTitulo(ativoId: number, dto: AtivoRendaFixaUpdateDto): Promise<PosicaoRendaFixa>`:**
   - Invoca `api.atualizarTituloRf(ativoId, dto, this.carteiraId())`.
   - Recarrega `ativos` e `todasPosicoes`, atualiza `this.posicao.set(posAtualizada)` e retorna a posição.
2. **`excluirTitulo(ativoId: number): Promise<void>`:**
   - Invoca `api.excluirTituloRf(ativoId)`.
   - Recarrega `ativos` (`listarAtivos()`) e `todasPosicoes` (`obterLotesPeps(this.carteiraId())`).
   - Se `ativos.length > 0`, seleciona automaticamente o primeiro disponível (`ativos[0].id`) e carrega sua posição; se `ativos.length === 0`, define `this.ativoId.set(null)` e `this.posicao.set(null)`.
3. **`editarLote(transacaoId: number, dto: LoteManualUpdateDto): Promise<PosicaoRendaFixa>`:**
   - Invoca `api.atualizarLoteManual(transacaoId, dto)`.
   - Atualiza `this.posicao.set(posAtualizada)` e recarrega `todasPosicoes`.
4. **`excluirLote(transacaoId: number): Promise<PosicaoRendaFixa>`:**
   - Invoca `api.excluirLoteManual(transacaoId)`.
   - Atualiza `this.posicao.set(posAtualizada)` e recarrega `todasPosicoes`.

### 3.3. Controles Visuais em `RendaFixaShellComponent` e `PosicaoPepsComponent`
1. **Cabeçalho do `RendaFixaShellComponent`:**
   - Ao lado do `<select>` de escolha do título e do botão `+ Novo Título / Aporte RF`, adicionar botões contextuais (ativos quando `store.posicao()` existir):
     - **`✏️ Editar Título`**: Abre o `NovoTituloRfModalComponent` com `initialMode='EDITAR_TITULO'` e `editingAtivo=store.posicao()!.ativo`.
     - **`🗑️ Excluir Título`**: Alterna um estado de confirmação inline (`confirmandoExclusaoAtivo = signal<boolean>(false)`) exibindo `"Excluir título e todos os seus lotes? [Confirmar Exclusão] [Cancelar]"` para evitar `window.confirm` nativo e garantir UX consistente e testável.
2. **Tabela de Lotes em `PosicaoPepsComponent`:**
   - Nova coluna **"Ações"** na tabela de lotes PEPS:
     - **`✏️ Editar`**: Emite evento ou aciona abertura do `NovoTituloRfModalComponent` em modo `'EDITAR_LOTE'` passando o `LoteAbertoDto` selecionado. Para manter o desacoplamento limpo, o `RendaFixaStore` (ou sinais de controle de modal) pode expor `modalState = signal<{ open: boolean; mode: ModalMode; lote?: LoteAbertoDto | null }>({ open: false, mode: 'NOVO_TITULO' })` ou `PosicaoPepsComponent` pode abrir diretamente / emitir para o Shell.
     - **`🗑️ Excluir`**: Exibe confirmação inline na própria linha (`excluindoLoteId = signal<number | null>(null)` $\rightarrow$ `"Confirmar? [Sim] [Não]"`) e invoca `store.excluirLote(lote.transacao_id)`.

---

## 4. Roteiro de Execução em 2 Etapas

### Etapa 1: Backend FastAPI + Sincronia Contábil CMPM/PEPS + Testes `pytest`
1. Atualizar `recalcular_posicoes_carteira` em `backend/app/services/portfolio.py` com ordenação *timezone-safe*.
2. Adicionar `LoteManualUpdate` e `AtivoRendaFixaUpdate` em `backend/app/schemas/renda_fixa.py`.
3. Implementar `PUT /ativos/{ativo_id}`, `DELETE /ativos/{ativo_id}`, `PUT /lotes/{transacao_id}` e `DELETE /lotes/{transacao_id}` em `backend/app/api/v1/endpoints/renda_fixa.py`.
4. Adicionar testes automatizados em `backend/tests/test_api_renda_fixa.py` cobrindo:
   - Edição de metadados e ticker de um ativo RF (`PUT /ativos/{id}`).
   - Edição de data, quantidade, PU e taxa de um lote (`PUT /lotes/{id}`) verificando o recálculo exato de `posicoes_consolidadas` (CMPM) e `extrair_lotes_abertos` (PEPS).
   - Exclusão de um lote (`DELETE /lotes/{id}`) e verificação de que o saldo CMPM e PEPS diminui exatamente na proporção do lote removido.
   - Exclusão completa de um ativo RF (`DELETE /ativos/{id}`) verificando remoção em cascata de transações, detalhes e posição consolidada.
5. Executar `..\.venv\Scripts\python.exe -m pytest -q` garantindo 100% de aprovação.

### Etapa 2: Frontend Store, Modal com Auto-Save/Edição, Ações na UI e Testes Karma
1. Adicionar `LoteManualUpdateDto` e `AtivoRendaFixaUpdateDto` em `renda-fixa.models.ts` e os 4 métodos HTTP em `renda-fixa-api.service.ts`.
2. Implementar `atualizarTitulo`, `excluirTitulo`, `editarLote` e `excluirLote` (além do sinal compartilhado de controle de abertura/edição do modal, se desejado) em `renda-fixa.store.ts`.
3. Evoluir `NovoTituloRfModalComponent` com:
   - Bloqueio de fechamento ao clicar no backdrop.
   - Auto-save e restauração automática de rascunho no `localStorage` (`il.rendafixa.modal_draft.v1`) + botão `"🗑️ Limpar Campos"`.
   - Suporte aos modos `'EDITAR_TITULO'` e `'EDITAR_LOTE'`.
4. Adicionar botões de Editar/Excluir Título em `RendaFixaShellComponent` e coluna de Editar/Excluir Lote em `PosicaoPepsComponent`.
5. Adicionar testes unitários em `novo-titulo-modal.component.spec.ts` (não fechamento no backdrop, persistência/limpeza de rascunho, modos de edição) e `renda-fixa.store.spec.ts` (`atualizarTitulo`, `excluirTitulo`, `editarLote`, `excluirLote`).
6. Validar com `npm test -- --watch=false --browsers=ChromeHeadless` e `npx ng build`.
