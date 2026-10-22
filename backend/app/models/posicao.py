from datetime import datetime, timezone, date
from decimal import Decimal
import json
from typing import TYPE_CHECKING, Optional, List, Dict, Any
from sqlalchemy import DateTime, ForeignKey, Numeric, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.db.base import Base

if TYPE_CHECKING:
    from app.models.ativo import Ativo
    from app.models.carteira import Carteira

class PosicaoConsolidada(Base):
    __tablename__ = "posicoes_consolidadas"
    __table_args__ = (
        UniqueConstraint("carteira_id", "ativo_id", name="uq_posicao_carteira_ativo"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    carteira_id: Mapped[int] = mapped_column(
        ForeignKey("carteiras.id", ondelete="CASCADE"), default=1, index=True, nullable=False
    )
    ativo_id: Mapped[int] = mapped_column(
        ForeignKey("ativos.id", ondelete="CASCADE"), index=True, nullable=False
    )

    # Valores e saldos calculados pelo Custo Médio Ponderado Móvel (CMPM)
    quantidade_saldo: Mapped[Decimal] = mapped_column(
        Numeric(precision=24, scale=8, asdecimal=True), default=Decimal("0.0"), nullable=False
    )
    custo_total_brl: Mapped[Decimal] = mapped_column(
        Numeric(precision=24, scale=4, asdecimal=True), default=Decimal("0.0"), nullable=False
    )
    preco_medio_brl: Mapped[Decimal] = mapped_column(
        Numeric(precision=24, scale=8, asdecimal=True), default=Decimal("0.0"), nullable=False
    )
    proventos_acumulados_brl: Mapped[Decimal] = mapped_column(
        Numeric(precision=24, scale=4, asdecimal=True), default=Decimal("0.0"), nullable=False
    )
    lucro_realizado_brl: Mapped[Decimal] = mapped_column(
        Numeric(precision=24, scale=4, asdecimal=True), default=Decimal("0.0"), nullable=False
    )
    quantidade_sem_custo: Mapped[Decimal] = mapped_column(
        Numeric(precision=24, scale=8, asdecimal=True), default=Decimal("0.0"), nullable=False
    )
    valor_total_venda_brl: Mapped[Decimal] = mapped_column(
        Numeric(precision=24, scale=4, asdecimal=True), default=Decimal("0.0"), nullable=False
    )
    custo_historico_brl: Mapped[Decimal] = mapped_column(
        Numeric(precision=24, scale=4, asdecimal=True), default=Decimal("0.0"), nullable=False
    )
    lotes_pendentes_json: Mapped[Optional[str]] = mapped_column(
        Text, nullable=True
    )

    data_atualizacao: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), nullable=False
    )

    @property
    def lotes_pendentes(self) -> List[Dict[str, Any]]:
        if not self.lotes_pendentes_json:
            return []
        try:
            raw = json.loads(self.lotes_pendentes_json)
            result = []
            for item in raw:
                d_val = item.get("data")
                if isinstance(d_val, str):
                    try:
                        d_obj = datetime.strptime(d_val[:10], "%Y-%m-%d").date()
                    except Exception:
                        d_obj = date.today()
                elif hasattr(d_val, "date"):
                    d_obj = d_val.date()
                else:
                    d_obj = d_val
                result.append({
                    "transacao_id": int(item["transacao_id"]),
                    "data": d_obj,
                    "quantidade": Decimal(str(item["quantidade"])),
                })
            return result
        except Exception:
            return []

    @property
    def custo_pendente(self) -> bool:
        qtd_sem = self.quantidade_sem_custo or Decimal("0.0")
        if qtd_sem > Decimal("0.0"):
            return True
        if (self.quantidade_saldo or Decimal("0.0")) > Decimal("0.0") and (self.preco_medio_brl or Decimal("0.0")) <= Decimal("0.0"):
            return True
        if (self.quantidade_saldo or Decimal("0.0")) == Decimal("0.0") and len(self.lotes_pendentes) > 0:
            return True
        return False

    @property
    def dividendo_por_acao_brl(self) -> Decimal:
        if self.quantidade_saldo and self.quantidade_saldo > Decimal("0"):
            return (self.proventos_acumulados_brl or Decimal("0.0")) / self.quantidade_saldo
        return Decimal("0.0")

    @property
    def preco_medio_ajustado_brl(self) -> Decimal:
        pm = self.preco_medio_brl or Decimal("0.0")
        if pm <= Decimal("0"):
            return Decimal("0.0")
        return max(Decimal("0.0"), pm - self.dividendo_por_acao_brl)

    @property
    def yoc_acumulado_pct(self) -> Decimal:
        custo = self.custo_total_brl or Decimal("0.0")
        if custo > Decimal("0"):
            return ((self.proventos_acumulados_brl or Decimal("0.0")) / custo) * Decimal("100.0")
        return Decimal("0.0")

    # Relacionamentos
    ativo: Mapped["Ativo"] = relationship("Ativo", back_populates="posicoes")
    carteira: Mapped["Carteira"] = relationship("Carteira", back_populates="posicoes")

    def __repr__(self) -> str:
        return f"<PosicaoConsolidada carteira_id={self.carteira_id} ativo_id={self.ativo_id} saldo={self.quantidade_saldo} PM={self.preco_medio_brl}>"
