from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING
from sqlalchemy import DateTime, ForeignKey, Numeric
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.db.base import Base

if TYPE_CHECKING:
    from app.models.ativo import Ativo

class PosicaoConsolidada(Base):
    __tablename__ = "posicoes_consolidadas"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    ativo_id: Mapped[int] = mapped_column(
        ForeignKey("ativos.id", ondelete="CASCADE"), unique=True, index=True, nullable=False
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
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    # Relacionamentos
    ativo: Mapped["Ativo"] = relationship("Ativo", back_populates="posicao")

    def __repr__(self) -> str:
        return f"<PosicaoConsolidada ativo_id={self.ativo_id} saldo={self.quantidade_saldo} PM={self.preco_medio_brl}>"
