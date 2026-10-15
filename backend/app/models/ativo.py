from datetime import datetime, timezone
from typing import TYPE_CHECKING, List, Optional
from sqlalchemy import String, DateTime, Enum
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.db.base import Base
from app.models.enums import TipoAtivo

if TYPE_CHECKING:
    from app.models.transacao import Transacao
    from app.models.posicao import PosicaoConsolidada
    from app.models.renda_fixa import DetalhesRendaFixa

class Ativo(Base):
    __tablename__ = "ativos"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    ticker: Mapped[str] = mapped_column(String(30), unique=True, index=True, nullable=False)
    nome: Mapped[str] = mapped_column(String(150), nullable=False)
    tipo: Mapped[TipoAtivo] = mapped_column(Enum(TipoAtivo), nullable=False, index=True)
    setor: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), nullable=False
    )

    # Relacionamentos
    transacoes: Mapped[List["Transacao"]] = relationship(
        "Transacao", back_populates="ativo", cascade="all, delete-orphan"
    )
    posicoes: Mapped[List["PosicaoConsolidada"]] = relationship(
        "PosicaoConsolidada", back_populates="ativo", cascade="all, delete-orphan"
    )
    detalhes_rf: Mapped[Optional["DetalhesRendaFixa"]] = relationship(
        "DetalhesRendaFixa", back_populates="ativo", uselist=False, cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:
        return f"<Ativo {self.ticker} ({self.tipo.value})>"
