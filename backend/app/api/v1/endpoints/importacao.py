from typing import Dict, Any, Optional, List
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status, Query
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.ativo import Ativo
from app.models.enums import TipoAtivo, TipoOperacao
from app.models.posicao import PosicaoConsolidada
from app.models.renda_fixa import DetalhesRendaFixa
from app.models.transacao import Transacao
from app.services.ingestion.parser_b3 import processar_planilha_b3
from app.services.ingestion.parser_binance import processar_planilha_binance
from app.services.ingestion.parser_movimentacao_b3 import processar_planilha_movimentacao_b3
from app.services.portfolio import recalcular_posicoes_carteira, sanear_renda_fixa_banco

router = APIRouter()

@router.post("/b3", summary="Upload e ingestão de negociações da B3 (.xlsx)")
async def upload_b3(
    file: UploadFile = File(..., description="Arquivo Excel (.xlsx) de negociações da B3"),
    carteira_id: Optional[int] = Query(default=1, description="ID da carteira de destino"),
    db: Session = Depends(get_db)
) -> Dict[str, Any]:
    if not file.filename.endswith((".xlsx", ".xls")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Arquivo deve estar no formato Excel (.xlsx ou .xls)."
        )

    try:
        content = await file.read()
        transacoes, pendencias = processar_planilha_b3(db=db, file_content=content, carteira_id=carteira_id)
        return {
            "status": "success",
            "origem": "B3",
            "filename": file.filename,
            "carteira_id": carteira_id,
            "transacoes_processadas": len(transacoes),
            "pendencias": pendencias,
            "mensagem": f"{len(transacoes)} transações da B3 importadas com sucesso. {len(pendencias)} pendências detectadas."
        }
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Erro ao processar planilha da B3: {str(exc)}"
        )

@router.post("/b3-transferencias", summary="Upload e ingestão de transferências/movimentações de custódia da B3 (.xlsx)")
async def upload_b3_transferencias(
    files: Optional[List[UploadFile]] = File(None, description="Múltiplos arquivos Excel (.xlsx) de movimentação/custódia da B3"),
    file: Optional[UploadFile] = File(None, description="Arquivo único Excel (.xlsx) de movimentação/custódia da B3"),
    carteira_id: Optional[int] = Query(default=1, description="ID da carteira de destino"),
    db: Session = Depends(get_db)
) -> Dict[str, Any]:
    lista_arquivos: List[UploadFile] = []
    if files:
        lista_arquivos.extend(files)
    if file:
        lista_arquivos.append(file)
    if not lista_arquivos:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Nenhum arquivo enviado para importação."
        )

    for f in lista_arquivos:
        if not f.filename.endswith((".xlsx", ".xls")):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Arquivo '{f.filename}' deve estar no formato Excel (.xlsx ou .xls)."
            )

    try:
        contents = [await f.read() for f in lista_arquivos]
        payload_content = contents if len(contents) > 1 else contents[0]
        resultado = processar_planilha_movimentacao_b3(db=db, file_content=payload_content, carteira_id=carteira_id)
        transacoes = resultado["transacoes"]
        avisos = resultado["avisos"]
        tipos_transferencia = {
            TipoOperacao.TRANSFERENCIA_ENTRADA,
            TipoOperacao.BONIFICACAO,
            TipoOperacao.DIREITO_SUBSCRICAO,
            TipoOperacao.DIREITO_SUBSCRICAO_EXPIRADO,
            TipoOperacao.DESDOBRO,
            TipoOperacao.GRUPAMENTO,
            TipoOperacao.FRACAO_ATIVOS,
            TipoOperacao.SELL,
            TipoOperacao.BUY,
        }
        qtd_transferencias = len([t for t in transacoes if t.tipo_operacao in tipos_transferencia])
        return {
            "status": "success",
            "origem": "B3-Transferencias",
            "filename": ", ".join(f.filename for f in lista_arquivos if f.filename),
            "carteira_id": carteira_id,
            "transferencias_processadas": qtd_transferencias,
            "proventos_processados": len(transacoes) - qtd_transferencias,
            "transacoes_processadas": len(transacoes),
            "avisos": avisos,
            "mensagem": f"{len(transacoes)} movimentações/transferências da B3 consolidadas com sucesso."
        }
    except Exception as exc:
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Erro ao processar planilha de movimentações da B3: {str(exc)}"
        )

@router.post("/binance", summary="Upload e ingestão de negociações da Binance (.xlsx)")
async def upload_binance(
    file: UploadFile = File(..., description="Arquivo Excel (.xlsx) da Binance com a aba 'Order History'"),
    carteira_id: Optional[int] = Query(default=1, description="ID da carteira de destino"),
    db: Session = Depends(get_db)
) -> Dict[str, Any]:
    if not file.filename.endswith((".xlsx", ".xls")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Arquivo deve estar no formato Excel (.xlsx ou .xls)."
        )

    try:
        content = await file.read()
        resultado = processar_planilha_binance(db=db, file_content=content, carteira_id=carteira_id)
        transacoes = resultado["transacoes"]
        pendencias = resultado["pendencias"]
        aba = resultado.get("aba_processada", "Order History")
        return {
            "status": "success",
            "origem": "Binance",
            "filename": file.filename,
            "carteira_id": carteira_id,
            "transacoes_processadas": len(transacoes),
            "pendencias": pendencias,
            "mensagem": f"{len(transacoes)} ordens da Binance processadas com sucesso a partir da aba '{aba}'." + (f" {len(pendencias)} pendências detectadas." if pendencias else "")
        }
    except Exception as exc:
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Erro ao processar planilha da Binance: {str(exc)}"
        )


@router.post("/reprocessar-renda-fixa", summary="Reprocessamento seletivo de Renda Fixa ou saneamento de banco")
async def reprocessar_renda_fixa(
    files: Optional[List[UploadFile]] = File(None, description="Planilhas Excel (.xlsx) de movimentação B3"),
    file: Optional[UploadFile] = File(None, description="Planilha Excel (.xlsx) única de movimentação B3"),
    carteira_id: Optional[int] = Query(default=1, description="ID da carteira de destino"),
    db: Session = Depends(get_db)
) -> Dict[str, Any]:
    lista_arquivos: List[UploadFile] = []
    if files:
        lista_arquivos.extend([f for f in files if f.filename])
    if file and file.filename:
        lista_arquivos.append(file)

    cid = carteira_id or 1

    if not lista_arquivos:
        return sanear_renda_fixa_banco(db=db, carteira_id=cid)

    for f in lista_arquivos:
        if not f.filename.endswith((".xlsx", ".xls")):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Arquivo '{f.filename}' deve estar no formato Excel (.xlsx ou .xls)."
            )

    try:
        # 1. Remove ativos fantasmas de RF
        ghosts = db.query(Ativo).filter(Ativo.ticker.in_(["CDB-BTG-20271220", "CDB-BTG-20271223"])).all()
        for g in ghosts:
            db.query(Transacao).filter(Transacao.carteira_id == cid, Transacao.ativo_id == g.id).delete(synchronize_session=False)
            db.query(PosicaoConsolidada).filter(PosicaoConsolidada.carteira_id == cid, PosicaoConsolidada.ativo_id == g.id).delete(synchronize_session=False)
            db.query(DetalhesRendaFixa).filter(DetalhesRendaFixa.ativo_id == g.id).delete(synchronize_session=False)
            if db.query(Transacao).filter(Transacao.ativo_id == g.id).count() == 0:
                db.delete(g)

        # 2. Exclui transações e posições existentes de Renda Fixa na carteira (preserva RV intacta)
        rf_ativos = db.query(Ativo).filter(Ativo.tipo == TipoAtivo.RendaFixa).all()
        rf_ids = [a.id for a in rf_ativos]
        if rf_ids:
            db.query(Transacao).filter(
                Transacao.carteira_id == cid,
                Transacao.ativo_id.in_(rf_ids),
            ).delete(synchronize_session=False)
            db.query(PosicaoConsolidada).filter(
                PosicaoConsolidada.carteira_id == cid,
                PosicaoConsolidada.ativo_id.in_(rf_ids),
            ).delete(synchronize_session=False)

        db.flush()

        # 3. Processa planilhas apenas para Renda Fixa
        contents = [await f.read() for f in lista_arquivos]
        payload_content = contents if len(contents) > 1 else contents[0]
        resultado = processar_planilha_movimentacao_b3(
            db=db,
            file_content=payload_content,
            carteira_id=cid,
            apenas_renda_fixa=True,
        )

        recalcular_posicoes_carteira(db=db, carteira_id=cid)
        db.commit()

        return {
            "status": "success",
            "origem": "Reprocessamento-Renda-Fixa",
            "filename": ", ".join(f.filename for f in lista_arquivos if f.filename),
            "carteira_id": cid,
            "transacoes_processadas": len(resultado["transacoes"]),
            "avisos": resultado["avisos"],
            "mensagem": f"Reprocessamento de Renda Fixa concluído com sucesso. {len(resultado['transacoes'])} movimentações consolidadas.",
        }
    except Exception as exc:
        db.rollback()
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Erro ao reprocessar Renda Fixa: {str(exc)}"
        )

