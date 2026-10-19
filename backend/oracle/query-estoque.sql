-- =====================================================================
-- Query: Itens em Estoque (SCODES) — VERSÃO SEM FUNÇÕES PL/SQL
-- =====================================================================
-- Contexto: o banco do SCODES migrou e o novo usuário (USU_CONSULTA_CAF)
-- recebeu APENAS direitos de SELECT. O Prodesp não concede EXECUTE nas
-- funções do schema SPAJ (FCN_*), então a query antiga (que chamava
-- FCN_NOME_PRODUTO, FCN_ESTOQUE_AUXILIAR, FCN_VALOR_UNITARIO_ESTOQUE e
-- FCN_EST_AUXILIAR_SOH_LT_VENC) passou a falhar com ORA-00904/ORA-01031.
--
-- Solução: usar a VIEW SPAJ.VW_ITENS_EM_ESTOQUE, que é a MESMA fonte do
-- relatório da macro. Uma view roda com os privilégios do DONO (SPAJ),
-- então as funções chamadas DENTRO dela são calculadas normalmente — o
-- usuário só precisa de SELECT na view. A view já entrega NOME, ESTOQUE,
-- AUTONOMIA, CUSTO_UNITARIO, VALOR_MEDIO, DEMANDAS/CONSUMO (e variações),
-- e já vem no escopo certo (categorias Medicamentos/Nutrição/Materiais/
-- Outros = CAT_ID 1,2,3,5; PRO_TIPO já como texto GENÉRICO/MANIPULADO/...).
--
-- Só faltam, fora da view:
--   * CATMAT  -> join em PRODUTO (PRO_CATMAT), que tem SELECT liberado;
--   * LOTES   -> reconstruído de ESTOQUE_AUXILIAR/LOTE/FABRICANTE (sem
--               funções), agregado por unidade+produto.
--
-- Validado contra o snapshot da macro (Tenente Pena): 0 itens faltando,
-- ~95% de estoque idêntico (as diferenças são movimentação do dia, pois
-- a view é ao vivo e o CSV é de um horário anterior).
-- =====================================================================
SELECT
  v.UND_DESCRICAO,
  v.CAT_DESCRICAO,
  v.TPC_DESCRICAO,
  v.PRO_TIPO            AS ORIGEM,
  v.MAR_DESCRICAO,
  v.PRO_IMPORTADO,
  v.PRO_OUT_DEM,
  v.PRO_ID,
  v.PRO_CODIGO,
  v.NOME,
  v.PRO_SIAFISICO,
  p.PRO_CATMAT          AS CATMAT,
  v.DEMANDAS,
  v.DEMANDAS_AJ,
  v.CONSUMO_MENSAL,
  v.CONSUMO_MENSAL_AJ,
  v.DEMANDAS_CF,
  v.CONSUMO_MENSAL_CF,
  v.DEMANDAS_JEFAZ,
  v.CONSUMO_MENSAL_JEFAZ,
  v.ESTOQUE,
  v.AUTONOMIA,
  v.CUSTO_UNITARIO,
  v.VALOR_MEDIO,
  NVL(L.LOTES, 'Sem Lote') AS LOTES
FROM VW_ITENS_EM_ESTOQUE v
LEFT JOIN PRODUTO p
  ON p.PRO_ID = v.PRO_ID
LEFT JOIN (
  -- Detalhe de lotes por unidade+produto, montado só com colunas de tabela
  -- (sem FCN_*). Mantém o mesmo texto exibido na tela de estoque.
  SELECT
    esa.UND_ID,
    esa.PRO_ID,
    DBMS_LOB.SUBSTR(
      LISTAGG(
        CASE
          WHEN esa.ESA_QTDE_ESTOQUE > 0 THEN
            'Lote N°: ' || NVL(lot.LOT_NUMERO, 'Sem Lote')
            || ' Validade: ' || NVL(TO_CHAR(lot.LOT_DTH_VALIDADE, 'DD/MM/YYYY'), '')
            || ' Fabricante: ' || NVL(fab.FAB_DESCRICAO, '') || '-' || NVL(fab.FAB_CNPJ, '')
            || ' Qtde: ' || TO_CHAR(esa.ESA_QTDE_ESTOQUE)
          ELSE NULL
        END,
        ', ' ON OVERFLOW TRUNCATE
      ) WITHIN GROUP (ORDER BY lot.LOT_DTH_VALIDADE),
      4000, 1
    ) AS LOTES
  FROM ESTOQUE_AUXILIAR esa
  LEFT JOIN LOTE lot ON lot.LOT_ID = esa.LOT_ID
  LEFT JOIN FABRICANTE fab ON fab.FAB_ID = lot.FAB_ID
  GROUP BY esa.UND_ID, esa.PRO_ID
) L
  ON L.UND_ID = v.UND_ID AND L.PRO_ID = v.PRO_ID
ORDER BY v.UND_DESCRICAO, v.NOME
