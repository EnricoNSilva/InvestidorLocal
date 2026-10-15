from datetime import datetime, timezone
from decimal import Decimal
from typing import TYPE_CHECKING, Optional
from sqlalchemy import String, DateTime, Enum, ForeignKey, Numeric
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.db.base import Base
from app.models.enums import TipoOperacao

if TYPE_CHECKING:
    from app.models.ativo import Ativo
    from app.models.carteira import Carteira

class Transacao(Base):
    __tablename__ = "transacoes"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    carteira_id: Mapped[int] = mapped_column(
        ForeignKey("carteiras.id", ondelete="CASCADE"), default=1, index=True, nullable=False
    )
    ativo_id: Mapped[int] = mapped_column(ForeignKey("ativos.id", ondelete="CASCADE"), index=True, nullable=False)
    data_hora: Mapped[datetime] = mapped_column(DateTime, index=True, nullable=False)
    tipo_operacao: Mapped[TipoOperacao] = mapped_column(Enum(TipoOperacao), nullable=False)

    # Alta precisão com Decimal nativo Python (asdecimal=True)
    quantidade: Mapped[Decimal] = mapped_column(Numeric(precision=24, scale=8, asdecimal=True), nullable=False)
    preco_unitario: Mapped[Decimal] = mapped_column(Numeric(precision=24, scale=8, asdecimal=True), nullable=False)
    taxas: Mapped[Decimal] = mapped_column(
        Numeric(precision=18, scale=8, asdecimal=True), default=Decimal("0.0"), nullable=False
    )
    moeda: Mapped[str] = mapped_column(String(10), default="BRL", nullable=False)
    moeda_taxa: Mapped[Optional[str]] = mapped_column(String(10), default="BRL", nullable=True)
    ptax_utilizada: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(precision=18, scale=6, asdecimal=True), nullable=True
    )
    # Taxa pactuada do lote, em PERCENTUAL:
    #   IPCA+/Prefixado -> % a.a. (ex.: Decimal("6.9900"))
    #   Pós-fixado CDI  -> % do CDI (ex.: Decimal("110.0000"))
    #   NULL            -> não-RF ou taxa ainda não informada (pendência exibida na UI)
    taxa_contratada: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(precision=8, scale=4, asdecimal=True), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    # Relacionamentos
    ativo: Mapped["Ativo"] = relationship("Ativo", back_populates="transacoes")
    carteira: Mapped["Carteira"] = relationship("Carteira", back_populates="transacoes")

    def __repr__(self) -> str:
        return f"<Transacao {self.tipo_operacao.value} {self.quantidade} @ {self.preco_unitario} {self.moeda}>"
