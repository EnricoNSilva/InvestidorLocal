from datetime import datetime, timezone
from decimal import Decimal
from typing import TYPE_CHECKING, Optional
from sqlalchemy import DateTime, ForeignKey, Numeric, UniqueConstraint
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

    data_atualizacao: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), nullable=False
    )

    # Relacionamentos
    ativo: Mapped["Ativo"] = relationship("Ativo", back_populates="posicoes")
    carteira: Mapped["Carteira"] = relationship("Carteira", back_populates="posicoes")

    def __repr__(self) -> str:
        return f"<PosicaoConsolidada carteira_id={self.carteira_id} ativo_id={self.ativo_id} saldo={self.quantidade_saldo} PM={self.preco_medio_brl}>"
