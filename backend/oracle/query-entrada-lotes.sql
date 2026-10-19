-- Consulta de Movimentações de ENTRADA com Lotes/Validade — só Unidade
-- Tenente Pena. Baseada em "SCODES - SQL - Consulta de Movimentações com
-- Lotes Validade.sql" (Rafael, 13/07/2026), reduzida ao bloco de Entrada —
-- é o único usado pelo sistema. A janela de datas é sempre os últimos 12
-- meses até hoje, calculada pelo próprio Oracle (SYSDATE) — desliza sozinha
-- a cada dia, sem precisar de parâmetro nem de código no lado da aplicação.
--
-- ATENÇÃO: o join com a tabela CATEGORIA (i.cat_id = cat.cat_id) foi
-- adicionado por analogia com query-estoque.sql, sem poder testar contra o
-- Oracle real neste ambiente. Confirme se "categoria" aparece certo ao
-- clicar em "Atualizar via Oracle" — se der erro de tabela/coluna
-- inexistente, me avise para eu ajustar.
SELECT
  ( SELECT CASE nm_ite.CAT_ID
             WHEN 4 THEN (nm_ite.ITE_DESCRICAO || ' / ' || nm_esp.ESP_DESCRICAO)
             ELSE CASE nm_prod.PRO_TIPO
                    WHEN 2 THEN (nm_ite.ITE_DESCRICAO||' / '||nm_esp.ESP_DESCRICAO||' / '||nm_apr.APR_DESCRICAO||' / MANIPULADO')
                    WHEN 3 THEN (nm_ite.ITE_DESCRICAO||' / '||nm_esp.ESP_DESCRICAO||' / '||nm_apr.APR_DESCRICAO||' / HOMEOPATICO')
                    ELSE       (nm_ite.ITE_DESCRICAO||' / '||nm_esp.ESP_DESCRICAO||' / '||nm_apr.APR_DESCRICAO||' / '||nm_mar.MAR_DESCRICAO)
                  END
           END
      FROM PRODUTO nm_prod, MARCA nm_mar, ESPECIFICACAO nm_esp, ITEM nm_ite, APRESENTACAO nm_apr
     WHERE nm_prod.PRO_ID = q.pro_id
       AND nm_prod.MAR_ID = nm_mar.MAR_ID AND nm_prod.ESP_ID = nm_esp.ESP_ID
       AND nm_esp.ITE_ID = nm_ite.ITE_ID AND nm_esp.APR_ID = nm_apr.APR_ID )         AS ITEM,
  UND.UND_Descricao                                                       AS UND_DESCRICAO,
  ent_dth                                                                 AS ENT_DTH,
  'Entrada'                                                               AS TIPO,
  tpm_descricao                                                           AS TPM_DESCRICAO,
  NVL(unt.unt_descricao, untu.unt_descricao)                              AS UNT_DESCRICAO,
  CASE M.tpm_id WHEN 16 THEN '-' ELSE CM.cmo_descricao END                AS CMO_DESCRICAO,
  com_nota_empenho                                                        AS COM_NOTA_EMPENHO,
  NVL(com_nota_fiscal, tru_nota_fiscal)                                   AS COM_NOTA_FISCAL,
  DECODE(m.tpm_id, 22, a.AJU_DOC, 23, d.DOA_DOC, tra_doc)                 AS TRA_DOC,
  fab.fab_descricao                                                       AS FABRICANTE,
  pro_codigo                                                              AS PRO_CODIGO,
  NVL(estl.ELT_QTDE, est_qtde_entrada)                                    AS QTDE,
  est_qtde_acerto                                                         AS EST_QTDE_ACERTO,
  est_vlr_unitario                                                        AS EST_VLR_UNITARIO,
  NVL(estl.ELT_QTDE, est_qtde_entrada) * est_vlr_unitario                 AS EST_VLR_TOTAL,
  usr_login                                                               AS USR_LOGIN,
  e.ent_motivo                                                            AS OBS,
  est_termolabel                                                         AS EST_TERMOLABEL,
  DECODE(m.tpm_id, 23, fdoa.for_descricao, f.for_descricao)               AS FOR_DESCRICAO,
  -- FCN_FORMATA_CNPJ substituída pela máscara inline (mesma do saida-lotes):
  -- 14 dígitos -> NN.NNN.NNN/NNNN-NN; nulo -> nulo; senão o valor como está.
  DECODE(m.tpm_id, 23,
    CASE WHEN LENGTH(fdoa.for_cnpj) = 14
           THEN SUBSTR(fdoa.FOR_CNPJ,1,2)||'.'||SUBSTR(fdoa.FOR_CNPJ,3,3)||'.'||SUBSTR(fdoa.FOR_CNPJ,6,3)||'/'||SUBSTR(fdoa.FOR_CNPJ,9,4)||'-'||SUBSTR(fdoa.FOR_CNPJ,13,2)
         WHEN fdoa.for_cnpj IS NULL THEN NULL ELSE NVL(fdoa.FOR_CNPJ,'') END,
    CASE WHEN LENGTH(f.for_cnpj) = 14
           THEN SUBSTR(f.FOR_CNPJ,1,2)||'.'||SUBSTR(f.FOR_CNPJ,3,3)||'.'||SUBSTR(f.FOR_CNPJ,6,3)||'/'||SUBSTR(f.FOR_CNPJ,9,4)||'-'||SUBSTR(f.FOR_CNPJ,13,2)
         WHEN f.for_cnpj IS NULL THEN NULL ELSE NVL(f.FOR_CNPJ,'') END
  )                                                                      AS FOR_CNPJ,
  NVL(tra_tipo, tru_tipo)                                                 AS TRA_TIPO,
  m.tpm_id                                                                AS TPM_ID,
  unt.unt_id                                                              AS UNT_ID,
  q.und_id                                                                AS UND_ID,
  d.DOA_TIPO                                                              AS DOA_TIPO,
  DECODE(m.tpm_id, 23, fdoa.for_id, f.for_id)                             AS FOR_ID,
  lot.LOT_NUMERO                                                          AS LOT_NUMERO,
  TO_CHAR(lot.LOT_DTH_VALIDADE, 'DD/MM/YYYY')                             AS LOT_DTH_VALIDADE,
  CASE WHEN lot.LOT_NUMERO IS NOT NULL THEN 'Não' ELSE 'Sem Lote' END     AS LOTE_FOI_DIGITADO,
  INITCAP(cat.CAT_DESCRICAO)                                              AS CATEGORIA
FROM estoque q,
     entrada e,
     ca_usuario u,
     produto p,
     doacao d,
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
     fabricante fab,
     fornecedor fdoa,
     ajuste a,
     transferencia_uniao tu,
     unidade_transferencia untu,
     estoque_lote estl,
     lote lot
WHERE q.ent_id = e.ent_id
  AND e.usr_id = u.usr_id
  AND e.tpm_id = m.tpm_id
  AND q.pro_id = p.pro_id
  AND p.esp_id = es.esp_id
  AND es.ite_id = i.ite_id
  AND i.cat_id = cat.cat_id(+)
  AND e.com_id = c.com_id(+)
  AND e.tra_id = t.tra_id(+)
  AND e.tru_id = tu.tru_id(+)
  AND e.doa_id = d.doa_id(+)
  AND c.cmo_id = cm.cmo_id(+)
  AND c.for_id = f.for_id(+)
  AND t.unt_id = unt.unt_id(+)
  AND tu.unt_id = untu.unt_id(+)
  AND q.fab_id = fab.fab_id(+)
  AND d.for_id = fdoa.for_id(+)
  AND e.aju_id = a.aju_id(+)
  AND q.EST_ID = estl.EST_ID(+)
  AND estl.LOT_ID = lot.LOT_ID(+)
  AND q.UND_ID = UND.UND_ID
  -- Só Unidade Tenente Pena (mesmo critério usado no resto do sistema)
  AND UND.UND_Descricao LIKE '%Tenente Pena%'
  -- Janela móvel: últimos 12 meses até hoje, recalculada a cada execução
  AND ent_dth >= ADD_MONTHS(TRUNC(SYSDATE), -12)
  AND ent_dth < TRUNC(SYSDATE) + 1
ORDER BY ENT_DTH DESC, PRO_CODIGO, LOT_NUMERO
