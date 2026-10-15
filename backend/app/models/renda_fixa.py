from datetime import date, datetime, timezone
from decimal import Decimal
from typing import TYPE_CHECKING, Optional

from sqlalchemy import Boolean, CheckConstraint, Date, DateTime, Enum, ForeignKey, Numeric, SmallInteger, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.enums import Indexador, ProdutoRendaFixa

if TYPE_CHECKING:
    from app.models.ativo import Ativo


class DetalhesRendaFixa(Base):
    __tablename__ = "detalhes_renda_fixa"
    __table_args__ = (
        CheckConstraint("num_parcelas IS NULL OR num_parcelas > 0", name="ck_rf_num_parcelas"),
        CheckConstraint("dia_pagamento IS NULL OR dia_pagamento BETWEEN 1 AND 31", name="ck_rf_dia_pagamento"),
        CheckConstraint("percentual_indexador IS NULL OR percentual_indexador > 0", name="ck_rf_pct_indexador"),
    )

    # PK = FK -> garante cardinalidade 1:1 com ativos
    ativo_id: Mapped[int] = mapped_column(ForeignKey("ativos.id", ondelete="CASCADE"), primary_key=True)

    produto: Mapped[ProdutoRendaFixa] = mapped_column(Enum(ProdutoRendaFixa), nullable=False, index=True)
    indexador: Mapped[Indexador] = mapped_column(Enum(Indexador), nullable=False, index=True)
    emissor: Mapped[str] = mapped_column(String(100), nullable=False, default="Tesouro Nacional")

    # Pós-fixados: % do indexador "de prateleira" do título (o do lote fica em transacoes.taxa_contratada)
    percentual_indexador: Mapped[Optional[Decimal]] = mapped_column(Numeric(8, 4, asdecimal=True), nullable=True)

    data_emissao: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    data_vencimento: Mapped[Optional[date]] = mapped_column(Date, nullable=True, index=True)

    # Títulos de desacumulação (RendA+/Educa+)
    ano_conversao: Mapped[Optional[int]] = mapped_column(SmallInteger, nullable=True)   # 2065
    num_parcelas: Mapped[Optional[int]] = mapped_column(SmallInteger, nullable=True)    # 240
    dia_pagamento: Mapped[Optional[int]] = mapped_column(SmallInteger, nullable=True)   # 15

    # Perfil tributário/custódia
    isento_ir: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)          # LCI/LCA PF = True
    cobra_custodia_b3: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)   # Tesouro = True; CDB = False
    carencia_dias: Mapped[Optional[int]] = mapped_column(SmallInteger, nullable=True)

    # Chave de casamento com o bonds.json / fonte de cotação
    codigo_mercado: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), nullable=False
    )

    ativo: Mapped["Ativo"] = relationship("Ativo", back_populates="detalhes_rf")
