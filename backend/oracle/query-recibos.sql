-- =====================================================================
-- query-recibos.sql  (Extrato de Recibos Emitidos — enxuta)
-- Base do relatório "Consumo x Entrega": traz a ENTREGA REAL por recibo,
-- que cruzamos com o consumo/demanda que já temos no nosso banco.
--
-- Diferente do Extrato oficial (que tem ~34 colunas com subconsultas
-- pesadas de município, telefone, doença e local de tratamento), aqui
-- trazemos SÓ o necessário: SCODES, demanda, unidade, categoria,
-- periodicidade, quantidade REAL entregue e a data do recibo.
--
-- Filtro por período via binds :inicio e :fim (formato DD/MM/YYYY).
-- Mantém a mesma base de junções, unidades e regra REC_SITUACAO='V'
-- do Extrato oficial, para os números baterem.
-- =====================================================================
SELECT
   PRO.PRO_CODIGO                                             AS PRO_CODIGO,
   ( SELECT CASE nm_ite.CAT_ID
              WHEN 4 THEN (nm_ite.ITE_DESCRICAO || ' / ' || nm_esp.ESP_DESCRICAO)
              ELSE CASE nm_prod.PRO_TIPO
                     WHEN 2 THEN (nm_ite.ITE_DESCRICAO||' / '||nm_esp.ESP_DESCRICAO||' / '||nm_apr.APR_DESCRICAO||' / MANIPULADO')
                     WHEN 3 THEN (nm_ite.ITE_DESCRICAO||' / '||nm_esp.ESP_DESCRICAO||' / '||nm_apr.APR_DESCRICAO||' / HOMEOPATICO')
                     ELSE       (nm_ite.ITE_DESCRICAO||' / '||nm_esp.ESP_DESCRICAO||' / '||nm_apr.APR_DESCRICAO||' / '||nm_mar.MAR_DESCRICAO)
                   END
            END
       FROM PRODUTO nm_prod, MARCA nm_mar, ESPECIFICACAO nm_esp, ITEM nm_ite, APRESENTACAO nm_apr
      WHERE nm_prod.PRO_ID = PRO.PRO_ID
        AND nm_prod.MAR_ID = nm_mar.MAR_ID AND nm_prod.ESP_ID = nm_esp.ESP_ID
        AND nm_esp.ITE_ID = nm_ite.ITE_ID AND nm_esp.APR_ID = nm_apr.APR_ID )         AS DESCRICAO_PRODUTO,
   PEA.PEA_ID                                                 AS ID_DEMANDA,
   UD.UND_DESCRICAO                                           AS UND_DESCRICAO,
   NVL(INITCAP(I.CAT_DESCRICAO), 'N/I')                       AS CATEGORIA,
   ( CASE PED.PED_TIPO
       WHEN 0 THEN 'Adm'
       WHEN 1 THEN 'Judicial'
       WHEN 3 THEN 'CF'
       WHEN 4 THEN 'Jefaz'
       WHEN 5 THEN 'Saúde Mental'
       ELSE '-'
     END )                                                     AS TIPO_DEMANDA,
   -- FCN_STATUS_DESC substituída pelo mesmo CASE (código STA_ID -> texto).
   ( CASE PEA.STA_ID
       WHEN 1  THEN 'Demanda Ativa - Autor incluído'
       WHEN 2  THEN 'Demanda Inativa - Aguardando Documentação'
       WHEN 4  THEN 'Demanda Ativa - Determinação Incluída'
       WHEN 6  THEN 'Demanda Inativa - Aguardando Decisão Judicial'
       WHEN 5  THEN 'Demanda Ativa - Avaliação Técnica Incluída'
       WHEN 15 THEN 'Demanda Inativa - Fornecimento Não Autorizado'
       WHEN 7  THEN 'Demanda Ativa - Ordem de Dispensação Incluída'
       WHEN 8  THEN 'Demanda Ativa - Aguardando Fornecimento'
       WHEN 10 THEN 'Demanda Ativa - Demanda em Atendimento'
       WHEN 17 THEN 'Demanda Ativa - Orientar Migração'
       WHEN 11 THEN 'Demanda Inativa - OD Sem Dispensação'
       WHEN 12 THEN 'Demanda Inativa - Suspensão Temporária'
       WHEN 13 THEN 'Demanda Inativa - Suspensão Definitiva'
       WHEN 14 THEN 'Demanda Inativa - Integralmente Atendida'
       WHEN 18 THEN 'Demanda Inativa - Migrado Programa'
       WHEN 19 THEN 'Demanda Inativa - Atendimento no Local da Prescrição'
       WHEN 20 THEN 'Demanda Ativa - Aguardando Avaliação Técnica'
       WHEN 21 THEN 'Demanda Inativa - Reinserido no SUS'
       WHEN 22 THEN 'Demanda Inativa - Atendimento no Município'
       WHEN 23 THEN 'Demanda Inativa - Atendimento na União'
       WHEN 24 THEN 'Demanda Inativa - Suspensa por Improcedência da Ação'
       WHEN 25 THEN 'Demanda Inativa - Suspensa por Extinção da Ação'
       WHEN 26 THEN 'Demanda Inativa - Demanda Judicializada'
       WHEN 27 THEN 'Demanda Inativa - Suspensão Médica'
       WHEN 28 THEN 'Demanda Inativa - Negado na Renovação'
       WHEN 29 THEN 'Demanda Inativa - Aguardando Resposta do Município'
       WHEN 30 THEN 'Demanda Inativa - Aguardando Resposta da União'
     END )                                                     AS STATUS_DEMANDA,
   ORP.ORP_PERIODICIDADE                                      AS PERIODICIDADE,
   ROUND(ROP.ROP_DISPENSADO - NVL(ROE.ROE_ESTORNADO, 0))      AS QTDE_REAL_ENTREGUE,
   TO_CHAR(REC.REC_DTH_ENTREGA, 'YYYY-MM-DD')                 AS DATA_RECIBO
FROM
   PED_AUTOR pea
   INNER JOIN AUTOR aut                 ON aut.AUT_ID = pea.AUT_ID
   INNER JOIN PEDIDO ped                ON ped.PED_ID = pea.PED_ID
   INNER JOIN RELATORIO_TECNICO RTE     ON PEA.PEA_ID = RTE.PEA_ID
   INNER JOIN ORDEM_DISPENSACAO od      ON od.PEA_ID = pea.PEA_ID
   INNER JOIN ORD_PRO ORP               ON ORP.ORD_ID = od.ORD_ID
   INNER JOIN PRODUTO PRO               ON PRO.PRO_ID = ORP.PRO_ID
   INNER JOIN REC_ORD_PRO ROP           ON ROP.ORP_ID = ORP.ORP_ID
   INNER JOIN RECIBO REC                ON REC.REC_ID = ROP.REC_ID
   INNER JOIN UNIDADE_DISPENSADORA ud   ON ud.UND_ID = od.UND_ID
   INNER JOIN VW_ITENS I                ON I.PRO_ID = ORP.PRO_ID
   LEFT OUTER JOIN ROP_ESTORNO ROE      ON ROE.ROP_ID = ROP.ROP_ID
WHERE
   REC.REC_SITUACAO = 'V'
   AND REC.REC_DTH_ENTREGA BETWEEN
       TO_DATE(:inicio || ' 00:00', 'DD/MM/YYYY HH24:MI')
       AND TO_DATE(:fim || ' 23:59:59', 'DD/MM/YYYY HH24:MI:SS')
   AND I.CAT_ID IN (1, 2, 3, 4, 5)
   AND PED.UNO_ID IN (
      SELECT UNO_ID FROM UNIDADE_ORGANIZACIONAL
      CONNECT BY PRIOR UNO_ID = UNO_ID_PAI START WITH UNO_ID = 1
   )
   AND od.UND_ID IN (
      1, 422, 302, 222, 202, 182, 162, 322, 362, 21, 3, 262, 242, 161, 382,
      5, 6, 7, 342, 8, 9, 282, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 2,
      442, 462, 443, 463, 464, 444, 466, 465, 22, 402
   )
