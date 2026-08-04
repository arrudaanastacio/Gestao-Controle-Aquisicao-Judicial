-- Consulta de Movimentações de SAÍDA com Lotes/Validade — só Unidade
-- Tenente Pena. Baseada em "SCODES - SQL - Consulta de Movimentações com
-- Lotes Validade.sql" (Rafael), reaproveitando os DOIS blocos de Saída do
-- UNION original:
--   Bloco 1) Dispensações — tabela MOVIMENTACAO, tipos de dispensação (7,8,9).
--   Bloco 2) Demais saídas — tabela SAIDA (transferências, perdas, ajustes...).
-- O bloco de Entrada do arquivo original NÃO entra aqui (já é a tela
-- "Movimentação de Entrada", com sua própria query).
--
-- Ajustes feitos em relação ao arquivo original (iguais aos da query de
-- Entrada), para casar com o resto do sistema:
--   • Só Tenente Pena (UND_Descricao LIKE '%Tenente Pena%').
--   • Janela móvel: últimos 12 meses até hoje, calculada pelo próprio Oracle
--     (SYSDATE) — desliza sozinha a cada dia (no original a janela começava
--     em 01/01/2000).
--   • Join com CATEGORIA (i.cat_id = cat.cat_id) para alimentar o filtro de
--     Categoria da tela — ATENÇÃO: adicionado por analogia com a query de
--     Entrada, sem poder testar contra o Oracle real neste ambiente. Se der
--     erro de tabela/coluna inexistente ao "Atualizar via Oracle", me avise.
--   • QUANTIDADE sempre POSITIVA (o total do que saiu). No bloco de SAÍDA o
--     original multiplicava por -1; aqui mantemos o valor positivo para que o
--     "Consolidar (somar por item)" some corretamente.
--   • Removida a tabela ESTOQUE (q) do bloco de SAÍDA: no original ela entrava
--     só por "p.pro_id = q.pro_id" (sem filtro de unidade), o que multiplicava
--     as linhas. Como nenhuma coluna do resultado vem dela, foi retirada para
--     não inflar as quantidades. Validar as quantidades contra o relatório
--     real do SCODES após a primeira atualização.
SELECT * FROM (
  -- ===== Bloco 1: DISPENSAÇÕES (tabela MOVIMENTACAO, tipos 7,8,9) =====
  SELECT
    fcn_nome_produto(mov.pro_id)                                     AS ITEM,
    und.UND_Descricao                                               AS UND_DESCRICAO,
    mov.MOV_DTH                                                     AS SAI_DTH,
    'Saída'                                                         AS TIPO,
    tpm.tpm_descricao                                              AS TPM_DESCRICAO,
    NULL                                                           AS UNT_DESCRICAO,
    NULL                                                           AS FOR_DESCRICAO,
    NULL                                                           AS FOR_CNPJ,
    NULL                                                           AS TRA_DOC,
    NULL                                                           AS TRA_TIPO,
    NVL(fabLot.FAB_DESCRICAO, fabDig.FAB_DESCRICAO)                AS FABRICANTE,
    pro.PRO_CODIGO                                                 AS PRO_CODIGO,
    mov.MOV_QTDE                                                   AS QTDE,
    NULL                                                           AS USR_LOGIN,
    NULL                                                           AS OBS,
    mov.TPM_ID                                                     AS TPM_ID,
    mov.UND_ID                                                     AS UND_ID,
    NVL(rpl.RPL_NUMERO_DIGITADO, lot.LOT_NUMERO)                  AS LOT_NUMERO,
    TO_CHAR(NVL(rpl.RPL_DTH_VALIDADE_DIGITADA, lot.LOT_DTH_VALIDADE), 'DD/MM/YYYY') AS LOT_DTH_VALIDADE,
    CASE WHEN rpl.RPL_NUMERO_DIGITADO IS NOT NULL THEN 'Sim'
         ELSE CASE WHEN lot.LOT_NUMERO IS NOT NULL THEN 'Não' ELSE 'Sem Lote' END
    END                                                            AS LOTE_FOI_DIGITADO,
    INITCAP(cat.CAT_DESCRICAO)                                     AS CATEGORIA
  FROM MOVIMENTACAO mov
    INNER JOIN UNIDADE_DISPENSADORA und ON und.UND_ID = mov.UND_ID
    INNER JOIN TIPO_MOVIMENTACAO tpm    ON tpm.TPM_ID = mov.TPM_ID
    INNER JOIN PRODUTO pro              ON pro.PRO_ID = mov.PRO_ID
    INNER JOIN ESPECIFICACAO esp        ON esp.ESP_ID = pro.ESP_ID
    INNER JOIN ITEM ite                 ON ite.ITE_ID = esp.ITE_ID
    LEFT JOIN CATEGORIA cat             ON cat.CAT_ID = ite.CAT_ID
    LEFT JOIN LOTE lot                  ON lot.LOT_ID = mov.LOT_ID
    LEFT JOIN RECIBO rec                ON rec.REC_ID = mov.REC_ID
    LEFT JOIN REC_ORD_PRO rop           ON rop.REC_ID = rec.REC_ID AND rop.ROP_ID = mov.ROP_ID
    LEFT JOIN REC_ORD_PRO_LOTE rpl      ON rpl.ROP_ID = rop.ROP_ID AND rpl.RPL_ID = mov.RPL_ID
    LEFT JOIN FABRICANTE fabLot         ON fabLot.FAB_ID = lot.FAB_ID
    LEFT JOIN FABRICANTE fabDig         ON fabDig.FAB_ID = rpl.RPL_FAB_ID_DIGITADO
  WHERE mov.ENT_ID IS NULL
    AND mov.SAI_ID IS NULL
    AND NVL(mov.MOV_QTDE, 0) <> 0
    AND mov.TPM_ID IN (7, 8, 9)   -- Tipos de Dispensação
    AND und.UND_Descricao LIKE '%Tenente Pena%'
    AND mov.MOV_DTH >= ADD_MONTHS(TRUNC(SYSDATE), -12)
    AND mov.MOV_DTH <  TRUNC(SYSDATE) + 1

  UNION ALL

  -- ===== Bloco 2: DEMAIS SAÍDAS (tabela SAIDA) =====
  SELECT
    fcn_nome_produto(em.pro_id)                                     AS ITEM,
    UND.UND_Descricao                                              AS UND_DESCRICAO,
    s.sai_dth                                                      AS SAI_DTH,
    'Saída'                                                        AS TIPO,
    m.tpm_descricao                                               AS TPM_DESCRICAO,
    unt.unt_descricao                                             AS UNT_DESCRICAO,
    f.for_descricao                                               AS FOR_DESCRICAO,
    CASE WHEN LENGTH(f.for_cnpj) = 14
           THEN SUBSTR(f.FOR_CNPJ,1,2) || '.' || SUBSTR(f.FOR_CNPJ,3,3) || '.' || SUBSTR(f.FOR_CNPJ,6,3) || '/' || SUBSTR(f.FOR_CNPJ,9,4) || '-' || SUBSTR(f.FOR_CNPJ,13,2)
         WHEN f.for_cnpj IS NULL THEN NULL
         ELSE NVL(f.FOR_CNPJ, '')
    END                                                            AS FOR_CNPJ,
    DECODE(m.tpm_id, 13, a.AJU_DOC, t.tra_doc)                     AS TRA_DOC,
    t.tra_tipo                                                     AS TRA_TIPO,
    NVL(
      (SELECT FAB_DESCRICAO FROM FABRICANTE WHERE FAB_ID = lot.FAB_ID),
      (SELECT FAB_DESCRICAO FROM FABRICANTE WHERE FAB_ID = estsl.ESL_FAB_ID_DIGITADO)
    )                                                              AS FABRICANTE,
    p.pro_codigo                                                  AS PRO_CODIGO,
    NVL(estsl.ESL_QTDE, si.ess_qtde)                              AS QTDE,
    u.usr_login                                                   AS USR_LOGIN,
    s.sai_motivo                                                  AS OBS,
    m.tpm_id                                                      AS TPM_ID,
    em.und_id                                                     AS UND_ID,
    NVL(lot.LOT_NUMERO, estsl.ESL_NUMERO_DIGITADO)               AS LOT_NUMERO,
    TO_CHAR(NVL(lot.LOT_DTH_VALIDADE, estsl.ESL_DTH_VALIDADE_DIGITADA), 'DD/MM/YYYY') AS LOT_DTH_VALIDADE,
    CASE WHEN estsl.ESL_NUMERO_DIGITADO IS NOT NULL THEN 'Sim'
         ELSE CASE WHEN lot.LOT_NUMERO IS NOT NULL THEN 'Não' ELSE 'Sem Lote' END
    END                                                            AS LOTE_FOI_DIGITADO,
    INITCAP(cat.CAT_DESCRICAO)                                     AS CATEGORIA
  FROM saida s,
       ca_usuario u,
       estoque_saida si,
       estoque_menor em,
       produto p,
       compra_troca c,
       transferencia t,
       tipo_movimentacao m,
       fornecedor f,
       compra_modalidade cm,
       especificacao es,
       item i,
       categoria cat,
       unidade_dispensadora und,
       unidade_transferencia unt,
       ajuste a,
       estoque_saida_lote estsl,
       lote lot
  WHERE s.sai_id = si.sai_id
    AND s.usr_id = u.usr_id
    AND s.tpm_id = m.tpm_id
    AND si.esm_id = em.esm_id
    AND em.pro_id = p.pro_id
    AND p.esp_id = es.esp_id
    AND es.ite_id = i.ite_id
    AND i.cat_id = cat.cat_id(+)
    AND s.com_id = c.com_id(+)
    AND s.tra_id = t.tra_id(+)
    AND c.cmo_id = cm.cmo_id(+)
    AND c.for_id = f.for_id(+)
    AND t.unt_id = unt.unt_id(+)
    AND und.und_id = em.und_id
    AND s.aju_id = a.aju_id(+)
    AND si.ESS_ID = estsl.ESS_ID(+)
    AND estsl.LOT_ID = lot.LOT_ID(+)
    AND und.UND_Descricao LIKE '%Tenente Pena%'
    AND s.sai_dth >= ADD_MONTHS(TRUNC(SYSDATE), -12)
    AND s.sai_dth <  TRUNC(SYSDATE) + 1
) MOVIMENTACAO_SAIDA
ORDER BY SAI_DTH DESC, PRO_CODIGO, LOT_NUMERO
