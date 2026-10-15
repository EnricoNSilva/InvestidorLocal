from datetime import datetime, timezone
from typing import TYPE_CHECKING, List, Optional
from sqlalchemy import String, DateTime
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.db.base import Base

if TYPE_CHECKING:
    from app.models.transacao import Transacao
    from app.models.posicao import PosicaoConsolidada

class Carteira(Base):
    __tablename__ = "carteiras"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    nome: Mapped[str] = mapped_column(String(100), nullable=False)
    descricao: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    # Relacionamentos
    transacoes: Mapped[List["Transacao"]] = relationship(
        "Transacao", back_populates="carteira", cascade="all, delete-orphan"
    )
    posicoes: Mapped[List["PosicaoConsolidada"]] = relationship(
        "PosicaoConsolidada", back_populates="carteira", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:
        return f"<Carteira id={self.id} nome='{self.nome}'>"
