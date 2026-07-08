-- =====================================================================
-- Query: Itens em Estoque (SCODES)
-- Origem: relatório oficial "Consulta de Itens em Estoque" da macro,
-- ajustado para automação:
--   - As 3 ocorrências da data fixa '02/07/2026' (usada para calcular
--     estoque vencido) foram trocadas por TRUNC(SYSDATE), então a query
--     nunca mais precisa de edição manual de data.
-- Traz TODAS as unidades de uma vez; a separação por unidade já existe
-- na tela (/api/estoque tem seus próprios filtros).
-- =====================================================================
Select
   Consulta.UND_DESCRICAO,
   Consulta.CAT_DESCRICAO,
   Consulta.TPC_DESCRICAO,
   Consulta.ORIGEM,
   Consulta.MAR_DESCRICAO,
   Consulta.PRO_IMPORTADO,
   Consulta.PRO_OUT_DEM,
   Consulta.PRO_ID,
   Consulta.PRO_CODIGO,
   Consulta.NOME,
   Consulta.PRO_SIAFISICO,
   Consulta.CATMAT,
   Consulta.DEMANDAS,
   Consulta.DEMANDAS_AJ,
   Consulta.CONSUMO_MENSAL,
   Consulta.CONSUMO_MENSAL_AJ,
   Consulta.ESTOQUE,
   Consulta.AUTONOMIA,
   Consulta.CUSTO_UNITARIO,
   Consulta.VALOR_MEDIO,
   Case
      When
         Consulta.Lotes is not null
      Then
         Case
            When
               TRIM(Consulta.Lotes) = ''
            Then
               'Sem Lote'
            Else
               Consulta.Lotes
         End
         Else
            -- respescagem
            Case
               when
                  Consulta.ESTOQUE = 0
               then
                  'Sem Lote'
               Else
(
                  Select
                     NVL(DBMS_LOB.SUBSTR( LISTAGG(
                     Case
                        When
                           esa.ESA_QTDE_ESTOQUE > 0
                        then
                           'Lote N°: ' || nvl(lot.LOT_NUMERO, 'Sem Lote') || ' Validade: ' || nvl(to_char(lot.LOT_DTH_VALIDADE, 'DD/MM/YYYY'), '') || ' Fabricante: ' || nvl(fab.FAB_DESCRICAO, '') || '-' || nvl(fab.FAB_CNPJ, '') || ' Qtde: ' || TO_CHAR(esa.ESA_QTDE_ESTOQUE)
                        else
                           null
                     end
, ', '  ON OVERFLOW TRUNCATE )
 WITHIN GROUP (
                  ORDER BY
                     lot.LOT_DTH_VALIDADE), 4000, 1), 'Sem Lote') AS LOTES
                  from
                     ESTOQUE_AUXILIAR esa
                     left join
                        LOTE lot
                        on lot.LOT_ID = esa.LOT_ID
                     left join
                        FABRICANTE fab
                        on fab.FAB_ID = lot.FAB_ID
                  where
                     esa.UND_ID = Consulta.UND_ID
                     AND esa.PRO_ID = Consulta.PRO_ID
                  Group By
                     esa.UND_ID, esa.PRO_ID, FCN_VALOR_UNITARIO_ESTOQUE(esa.PRO_ID, esa.UND_ID), FCN_ESTOQUE_AUXILIAR(esa.UND_ID, esa.PRO_ID), FCN_EST_AUXILIAR_SOH_LT_VENC(esa.UND_ID, esa.PRO_ID, TRUNC(SYSDATE)) )
            End
            -- repescagem
   End
   LOTES
                  from
                     (
                        SELECT
                           UND_DESCRICAO,
                           INITCAP(CAT_DESCRICAO) CAT_DESCRICAO,
                           TPC_DESCRICAO,
                           CASE
                              I.PRO_TIPO
                              WHEN
                                 0
                              THEN
                                 'N/A'
                              WHEN
                                 1
                              THEN
                                 'GENÉRICO'
                              WHEN
                                 2
                              THEN
                                 'MANIPULADO'
                              WHEN
                                 3
                              THEN
                                 'HOMEOPÁTICO'
                              WHEN
                                 4
                              THEN
                                 'MARCA'
                           END
                           ORIGEM, I.MAR_DESCRICAO, I.PRO_IMPORTADO, I.PRO_OUT_DEM, I.PRO_ID, PRO_CODIGO, FCN_NOME_PRODUTO(I.PRO_ID) NOME, PRO_SIAFISICO, P.PRO_CATMAT as CATMAT, NVL(SUM(DEMANDAS), 0) DEMANDAS, NVL(SUM(DECODE(PED_TIPO, 1, DEMANDAS)), 0) DEMANDAS_AJ, NVL(SUM(CONSUMOMENSAL), 0) CONSUMO_MENSAL, NVL(SUM(DECODE(PED_TIPO, 1, CONSUMOMENSAL)), 0) CONSUMO_MENSAL_AJ, ESTOQUE - ESTOQUE_VENCIDO AS ESTOQUE,
                           CASE
                              WHEN
                                 NVL(SUM(CONSUMOMENSAL), 0) = 0
                              THEN
                                 0
                              ELSE
                                 TRUNC(NVL((ESTOQUE - ESTOQUE_VENCIDO) / NVL(SUM(CONSUMOMENSAL), 0), 0), 2)
                           END
                           AUTONOMIA, ESTOQUE_VENCIDO, CUSTOUNITARIO CUSTO_UNITARIO, P.PRO_VMU VALOR_MEDIO, UND.UND_ID,
                           REGEXP_REPLACE( LISTAGG(C.LOTES, ', ') WITHIN GROUP (
                        ORDER BY
                           C.LOTES), '([^,]+)(,\1)+', '\1' ) AS Lotes
                        FROM
                           VW_ITENS I,
                           (
                              --ITENS EM ESTOQUE SEM DEMANDA OS-9504
                              SELECT DISTINCT
                                 est.PRO_ID,
                                 est.UND_ID,
                                 0 DEMANDAS,
                                 0 CONSUMOMENSAL,
                                 FCN_VALOR_UNITARIO_ESTOQUE(est.PRO_ID, est.UND_ID) CUSTOUNITARIO,
                                 FCN_ESTOQUE_AUXILIAR(est.UND_ID, est.PRO_ID) ESTOQUE,
                                 FCN_EST_AUXILIAR_SOH_LT_VENC(est.UND_ID, est.PRO_ID, TRUNC(SYSDATE)) ESTOQUE_VENCIDO,
                                 NULL AS PED_TIPO,
                                 cast(NULL AS VARCHAR2(4000)) AS Lotes
                              FROM
                                 ESTOQUE est
                              WHERE 1=1
                                 -- O ITEM NÃO EXISTA EM DEMANDAS DA UNIDADE
                                 AND NOT EXISTS
                                 (
                                    SELECT
                                       OP.PRO_ID
                                    FROM
                                       VW_ORD_PRO_AT_NC OP
                                    WHERE
                                       OP.PRO_ID = est.PRO_ID
                                       AND OP.UND_ID = est.UND_ID
                                 )
                                 --INÍCIO
                              UNION ALL
                              Select
                                 esa.PRO_ID,
                                 esa.UND_ID,
                                 NULL AS DEMANDAS,
                                 NULL AS CONSUMOMENSAL,
                                 FCN_VALOR_UNITARIO_ESTOQUE(esa.PRO_ID, esa.UND_ID) CUSTOUNITARIO,
                                 FCN_ESTOQUE_AUXILIAR(esa.UND_ID, esa.PRO_ID) ESTOQUE,
                                 FCN_EST_AUXILIAR_SOH_LT_VENC(esa.UND_ID, esa.PRO_ID, TRUNC(SYSDATE)) ESTOQUE_VENCIDO,
                                 NULL AS PED_TIPO,
                                 DBMS_LOB.SUBSTR( LISTAGG(
                                 Case
                                    When
                                       esa.ESA_QTDE_ESTOQUE > 0
                                    then
                                       'Lote N°: ' || nvl(lot.LOT_NUMERO, 'Sem Lote') || ' Validade: ' || nvl(to_char(lot.LOT_DTH_VALIDADE, 'DD/MM/YYYY'), '') || ' Fabricante: ' || nvl(fab.FAB_DESCRICAO, '') || '-' || nvl(fab.FAB_CNPJ, '') || ' Qtde: ' || TO_CHAR(esa.ESA_QTDE_ESTOQUE)
                                    else
                                       null
                                 end
, ', '  ON OVERFLOW TRUNCATE )
 WITHIN GROUP (
                              ORDER BY
                                 lot.LOT_DTH_VALIDADE), 4000, 1) AS LOTES
                              from
                                 ESTOQUE_AUXILIAR esa
                                 left join
                                    LOTE lot
                                    on lot.LOT_ID = esa.LOT_ID
                                 left join
                                    FABRICANTE fab
                                    on fab.FAB_ID = lot.FAB_ID
                              where 1=1
                              Group By
                                 esa.UND_ID, esa.PRO_ID, FCN_VALOR_UNITARIO_ESTOQUE(esa.PRO_ID, esa.UND_ID), FCN_ESTOQUE_AUXILIAR(esa.UND_ID, esa.PRO_ID), FCN_EST_AUXILIAR_SOH_LT_VENC(esa.UND_ID, esa.PRO_ID, TRUNC(SYSDATE))
                              UNION ALL
                              --ITENS EM DEMANDA
                              SELECT
                                 OP.PRO_ID, OP.UND_ID, COUNT(OP.PEA_ID) DEMANDAS, SUM(ROUND((30 * ORP_QTDE) / (
                                 CASE
                                    WHEN
                                       ORP_RETORNO IS NOT NULL
                                       AND ORP_RETORNO > 0
                                    THEN
                                       ORP_RETORNO
                                    WHEN
                                       ORP_PERIODICIDADE IS NOT NULL
                                    THEN
                                       ORP_PERIODICIDADE
                                    ELSE
                                       30
                                 END
), 2)) CONSUMOMENSAL, FCN_VALOR_UNITARIO_ESTOQUE(OP.PRO_ID, OP.UND_ID) CUSTOUNITARIO, FCN_ESTOQUE_AUXILIAR(OP.UND_ID, PRO_ID) ESTOQUE, FCN_EST_AUXILIAR_SOH_LT_VENC(OP.UND_ID, PRO_ID, TRUNC(SYSDATE)) ESTOQUE_VENCIDO, PED.PED_TIPO, cast(NULL AS VARCHAR2(4000)) AS Lotes
                              FROM
                                 VW_ORD_PRO_AT_NC OP
                                 INNER JOIN
                                    PED_AUTOR PEA
                                    ON PEA.PEA_ID = OP.PEA_ID
                                 INNER JOIN
                                    PEDIDO PED
                                    ON PED.PED_ID = PEA.PED_ID
                              WHERE 1=1
                              GROUP BY
                                 OP.PRO_ID, OP.UND_ID, PED.PED_TIPO ) C, UNIDADE_DISPENSADORA UND,
                                 (
                                    SELECT
                                       PRO_ID,
                                       PRO_VMU,
                                       PRO_CATMAT
                                    FROM
                                       PRODUTO
                                 )
                                 P
                              WHERE
                                 I.PRO_ID = C.PRO_ID
                                 AND C.UND_ID = UND.UND_ID
                                 AND P.PRO_ID = I.PRO_ID
                                 AND I.CAT_ID IN
                                 (
                                    1,
                                    2,
                                    3,
                                    5
                                 )
                              GROUP BY
                                 UND_DESCRICAO,
                                 INITCAP(CAT_DESCRICAO),
                                 TPC_DESCRICAO,
                                 I.PRO_TIPO,
                                 I.MAR_DESCRICAO,
                                 I.PRO_IMPORTADO,
                                 I.PRO_OUT_DEM,
                                 I.PRO_ID,
                                 PRO_CODIGO,
                                 FCN_NOME_PRODUTO(I.PRO_ID),
                                 PRO_SIAFISICO,
                                 P.PRO_CATMAT,
                                 ESTOQUE,
                                 ESTOQUE_VENCIDO,
                                 CUSTOUNITARIO,
                                 P.PRO_VMU,
                                 UND.UND_ID
                           )
                           Consulta
                        ORDER BY
                           UND_DESCRICAO,
                           NOME
