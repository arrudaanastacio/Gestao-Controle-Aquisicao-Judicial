-- =====================================================================
-- Query: Relatório de Itens (catálogo completo do SCODES)
-- Origem: "SCODES - SQL - Consulta Relatório Outros Itens.sql" (Rafael),
-- reduzida aos campos que a tela "Relatório de Itens" já usa hoje
-- (importação manual via CSV). Removidos os 8 blocos de HISTÓRICO por
-- flag (data/login de início e fim de Importado, Compra Terceirizada,
-- Oncológico, Termolábil, Antimicrobiano, Portaria 34498, Grande Volume)
-- porque o sistema não guarda esse histórico — só o status atual.
-- Mantido apenas HIST1/HIST2 (situação Novo/Alterado e último usuário).
--
-- IMPORTANTE: esta query NÃO traz "Intercambiável" nem "Comissão de
-- Farmacologia" (colunas que hoje só vêm do CSV manual). Esses 2 campos
-- ficam em branco quando a linha é atualizada via Oracle.
--
-- DESCRICAO_ITEM usa FCN_NOME_PRODUTO(PRO_ID) — não PRO_DESCRITIVO_SIAFISICO
-- (esta última só existe quando o item tem SIAFÍSICO cadastrado; a função
-- monta "item / especificação / apresentação / marca", que é o formato
-- que já aparece na planilha CSV manual).
--
-- Aliases de coluna escolhidos para bater com o MAPA de
-- backend/src/routes.relatorioItens.js.
-- =====================================================================
SELECT VW_ITENS.PRO_ID                              AS PRO_ID,
       CASE HIST1.STATUS WHEN '1' THEN 'Novo' WHEN '2' THEN 'Alterado' ELSE '' END AS SITUACAO,
       HIST2.USR_LOGIN                               AS USUARIO,
       VW_ITENS.CAT_DESCRICAO                        AS CATEGORIA,
       VW_ITENS.PRO_CODIGO                           AS CODIGO,
       VW_ITENS.PRO_SIAFISICO                        AS SIAFISICO,
       PROD.PRO_CATMAT                                AS CATMAT,
       FCN_NOME_PRODUTO(VW_ITENS.PRO_ID)             AS DESCRICAO_ITEM,
       PROD.PRO_VMU                                   AS VALOR_MEDIO_UNITARIO,
       VW_ITENS.ITE_DESCRICAO                        AS ITEM,
       VW_ITENS.ESP_DESCRICAO                        AS ESPECIFICACAO,
       VW_ITENS.APR_DESCRICAO                        AS APRESENTACAO,
       VW_ITENS.MAR_DESCRICAO                        AS MARCA,
       VW_ITENS.PRO_IMPORTADO                        AS IMPORTADO,
       FCN_TIPO_PRODUTO(VW_ITENS.PRO_ID)             AS TIPO_ITEM,
       VW_ITENS.GRU_DESCRICAO                        AS GRUPO,
       VW_ITENS.PRG_DESCRICAO                        AS PROGRAMA,
       PROD.GAF_DESCRICAO                             AS GRUPO_AF,
       VW_ITENS.PRO_OBS                              AS OBSERVACOES,
       VW_ITENS.PRO_OUT_DEM                          AS OUTRAS_DEMANDAS,
       VW_ITENS.PRO_ONCOLOGICO                       AS ONCOLOGICO,
       VW_ITENS.PRO_TERMOLABIL                       AS TERMOLABIL,
       VW_ITENS.PRO_ANTIMICROBIANO                   AS ANTIMICROBIANO,
       VW_ITENS.PRO_PORTARIA34498                    AS PORTARIA34498,
       VW_ITENS.PRO_GRANDE_VOLUME                    AS GRANDE_VOLUME,
       (CASE WHEN PROD.PRO_JUDICIAL = 1 THEN 'Sim' ELSE 'Não' END) AS JUDICIAL,
       (CASE WHEN PROD.PRO_JEFAZ = 1 THEN 'Sim' ELSE 'Não' END)    AS JEFAZ
  FROM VW_ITENS

 INNER JOIN (SELECT PRO_ID,
                    PRO_VMU,
                    PRO_JEFAZ,
                    PRO_JUDICIAL,
                    GAF_DESCRICAO,
                    PRO_CATMAT
               FROM PRODUTO
               LEFT OUTER JOIN GRUPO_AF
                 ON PRODUTO.GAF_ID = GRUPO_AF.GAF_ID) PROD ON (PROD.PRO_ID = VW_ITENS.PRO_ID)

  --Histórico Início (só situação + usuário da última alteração) ========
  LEFT OUTER JOIN (SELECT PRO_ID,
                          MAX(PSA_ID) AS MAX_PSA_ID,
                          MAX(PSA_STATUS) AS STATUS
                     FROM PRODUTO_STATUS_ALT
                    GROUP BY PRO_ID) HIST1 ON HIST1.PRO_ID = VW_ITENS.PRO_ID

  LEFT OUTER JOIN (SELECT PSA_ID, PRO_ID, USR_LOGIN
                     FROM PRODUTO_STATUS_ALT) HIST2 ON HIST2.PRO_ID = VW_ITENS.PRO_ID AND HIST2.PSA_ID = HIST1.MAX_PSA_ID
  --Histórico Fim ========================================================

 ORDER BY VW_ITENS.CAT_DESCRICAO,
          VW_ITENS.GRU_FANTASIA,
          VW_ITENS.ITE_DESCRICAO,
          VW_ITENS.ITE_ID,
          VW_ITENS.APR_ID,
          VW_ITENS.ESP_DESCRICAO
