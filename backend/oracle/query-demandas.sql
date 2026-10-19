-- =====================================================================
-- Query: Demandas Judiciais (nível item) — VERSÃO SEM FUNÇÕES PL/SQL
-- =====================================================================
-- O novo usuário SCODES (USU_CONSULTA_CAF) só tem SELECT; o Prodesp não
-- concede EXECUTE. As duas funções de data usadas aqui foram substituídas
-- por subconsultas equivalentes (lidas do código-fonte original em ALL_SOURCE):
--   * data_ultima_dispensacao  <- FCN_DATA_ULTIMO_RECIBO_ITEM
--       MAX(REC_DTH_ENTREGA) de recibos válidos sem motivo (dispensação normal).
--   * data_ultimo_retorno      <- FCN_DATA_ULTIMO_RETORNO_ITEM
--       r1 = MAX(ROP_RETORNO) [motivo nulo]; se nulo, MAX(REC_DTH_ENTREGA)
--       [motivo não nulo]; resultado = NULL se r1 nulo, senão o maior entre
--       r1 e a última dispensação (nunca antes dela) -> GREATEST(r1,NVL(d,r1)).
-- O nome do produto JÁ era montado inline (não usava FCN_NOME_PRODUTO).
-- Validado contra o CSV da macro (Tenente Pena): ~96,8% das datas idênticas;
-- as diferenças são dispensações do próprio dia (o Oracle é ao vivo).
--
-- (Cabeçalho original abaixo.)
-- Origem: relatório oficial SCODES, enxugado para 20 colunas. Aliases batem
-- com o MAPA de importarAutoresDeBuffer() (routes.autores.js). Sempre roda
-- SEM filtro de unidade (:und_id = NULL): traz todas as unidades de uma vez.
-- =====================================================================
SELECT
    reg.und_id_filtro         AS "Und_Id",
    reg.und_descricao         AS "Unid_Dispensadora",
    reg.uno_descricao         AS "Unid_Organizacional",
    reg.pea_id                AS "ID_Demanda",
    reg.aut_nome              AS "Autor",
    reg.ped_num_protocolo     AS "Protocolo",
    reg.ped_num_processo      AS "Processo",
    reg.status                AS "Status_da_Demanda",
    reg.tipo_pedido           AS "Tipo_da_Demanda",
    reg.orp_dth               AS "Data_Inclusao_na_OD",
    reg.pro_codigo            AS "Cod_Item",
    reg.desc_produto          AS "Descricao_do_Item",
    reg.consumo               AS "Qtdade_de_Consumo",
    reg.dispensacao           AS "Dispensacoes",
    reg.periodicidade         AS "Periodicidade",
    reg.prazo                 AS "Prazo",
    reg.dis_autorizada        AS "Dispensacoes_Autorizadas",
    reg.categoria             AS "Categoria",
    reg.data_ultima_dispensacao AS "Data_Ultima_Dispensacao",
    reg.data_ultimo_retorno   AS "Data_Ultimo_Retorno",
    reg.pro_siafisico         AS "Cod_SIAFISICO",
    reg.status_item           AS "Status_Item",
    reg.data_inativacao_item  AS "Data_Inativacao_Item"
FROM (
    SELECT
        UND.und_descricao,
        UNO.uno_descricao,
        PEA.pea_id,
        AUT.aut_nome,
        Nvl2(PED.ped_num_protocolo, 'N: ' || PED.ped_num_protocolo, PED.ped_num_protocolo) AS ped_num_protocolo,
        Nvl2(PED.ped_num_processo,  'N: ' || PED.ped_num_processo,  PED.ped_num_processo)  AS ped_num_processo,
        STA.sta_descricao AS status,
        TPD.tpd_descricao AS tipo_pedido,

        ( CASE
            WHEN STA.classificacao_status = 1
             AND ORP.orp_concluido = 0
             AND REI.rei_id IS NULL THEN 'Item em Atendimento'
            ELSE Nvl(REI.rei_descricao, 'Inativação')
          END ) AS status_item,

        ( CASE
            WHEN REI.rei_id = 5 THEN NULL
            ELSE To_char(ORP.orp_dth_suspensao, 'DD/MM/YYYY')
          END ) AS data_inativacao_item,

        (SELECT Min(orp_dth)
           FROM ord_pro OP
          WHERE ORP.ord_id = OP.ord_id
            AND I.pro_id  = OP.pro_id) AS orp_dth,

        I.pro_codigo,

        ( CASE I.cat_id
            WHEN 4 THEN (I.ite_descricao || ' / ' || I.esp_descricao)
            ELSE ( CASE I.pro_tipo
                     WHEN 2 THEN (I.ite_descricao || ' / ' || I.esp_descricao || ' / ' || I.apr_descricao || ' / MANIPULADO')
                     WHEN 3 THEN (I.ite_descricao || ' / ' || I.esp_descricao || ' / ' || I.apr_descricao || ' / HOMEOPATICO')
                     ELSE       (I.ite_descricao || ' / ' || I.esp_descricao || ' / ' || I.apr_descricao || ' / ' || I.mar_descricao)
                   END )
          END ) AS desc_produto,

        ORP.orp_qtde AS consumo,

        Nvl(DISPENSACOES.total, 0) AS dispensacao,

        Nvl(Nvl(To_char(ORP.orp_periodicidade), To_char(ORP.orp_retorno)), 'N/I') AS periodicidade,

        ( CASE
            WHEN ORP.orp_prazo = 2 THEN 'Indeterminado'
            WHEN ORP.orp_prazo = 4 THEN 'Dispensações'
            ELSE 'Único'
          END ) AS prazo,

        ( CASE ORP.orp_prazo
            WHEN 2 THEN 'N/I'
            WHEN 1 THEN 'N/I'
            WHEN 4 THEN To_char(Nvl(ORP.orp_prazo_qtde, 0))
          END ) AS dis_autorizada,

        Initcap(I.cat_descricao) AS categoria,

        -- data_ultima_dispensacao: MAX(REC_DTH_ENTREGA) dos recibos válidos,
        -- sem motivo (dispensação normal). Reproduz FCN_DATA_ULTIMO_RECIBO_ITEM.
        To_char((
            SELECT MAX(dri_rec.rec_dth_entrega)
              FROM ordem_dispensacao dri_od
             INNER JOIN ord_pro dri_orp ON dri_orp.ord_id = dri_od.ord_id
             LEFT OUTER JOIN rec_ord_pro dri_rop ON dri_rop.orp_id = dri_orp.orp_id AND dri_rop.mot_id IS NULL
             LEFT OUTER JOIN recibo dri_rec ON dri_rec.rec_id = dri_rop.rec_id AND dri_rec.rec_situacao = 'V'
             WHERE dri_od.pea_id = PEA.pea_id AND dri_orp.pro_id = ORP.pro_id AND dri_rop.mot_id IS NULL
          ), 'DD/MM/YYYY') AS data_ultima_dispensacao,

        -- data_ultimo_retorno: reproduz FCN_DATA_ULTIMO_RETORNO_ITEM:
        --   r1 = MAX(ROP_RETORNO) [motivo nulo]; se nulo, MAX(REC_DTH_ENTREGA) [motivo não nulo];
        --   d  = última dispensação (igual acima);
        --   resultado = NULL se r1 nulo; senão o maior entre r1 e d (nunca antes de d).
        To_char((
            SELECT CASE WHEN r.r1 IS NULL THEN NULL ELSE GREATEST(r.r1, NVL(r.d, r.r1)) END
              FROM (
                SELECT
                  NVL(
                    (SELECT MAX(ret_rop.rop_retorno)
                       FROM ordem_dispensacao ret_od
                      INNER JOIN ord_pro ret_orp ON ret_orp.ord_id = ret_od.ord_id
                      INNER JOIN rec_ord_pro ret_rop ON ret_rop.orp_id = ret_orp.orp_id AND ret_rop.mot_id IS NULL
                      INNER JOIN recibo ret_rec ON ret_rec.rec_id = ret_rop.rec_id AND ret_rec.rec_situacao = 'V'
                      WHERE ret_od.pea_id = PEA.pea_id AND ret_orp.pro_id = ORP.pro_id),
                    (SELECT MAX(ret_rec2.rec_dth_entrega)
                       FROM ordem_dispensacao ret_od2
                      INNER JOIN ord_pro ret_orp2 ON ret_orp2.ord_id = ret_od2.ord_id
                      INNER JOIN rec_ord_pro ret_rop2 ON ret_rop2.orp_id = ret_orp2.orp_id AND ret_rop2.mot_id IS NOT NULL
                      INNER JOIN recibo ret_rec2 ON ret_rec2.rec_id = ret_rop2.rec_id AND ret_rec2.rec_situacao = 'V'
                      WHERE ret_od2.pea_id = PEA.pea_id AND ret_orp2.pro_id = ORP.pro_id)
                  ) AS r1,
                  (SELECT MAX(drr_rec.rec_dth_entrega)
                     FROM ordem_dispensacao drr_od
                    INNER JOIN ord_pro drr_orp ON drr_orp.ord_id = drr_od.ord_id
                    LEFT OUTER JOIN rec_ord_pro drr_rop ON drr_rop.orp_id = drr_orp.orp_id AND drr_rop.mot_id IS NULL
                    LEFT OUTER JOIN recibo drr_rec ON drr_rec.rec_id = drr_rop.rec_id AND drr_rec.rec_situacao = 'V'
                    WHERE drr_od.pea_id = PEA.pea_id AND drr_orp.pro_id = ORP.pro_id AND drr_rop.mot_id IS NULL) AS d
                FROM dual
              ) r
          ), 'DD/MM/YYYY') AS data_ultimo_retorno,

        I.pro_siafisico,

        ORD.und_id AS und_id_filtro

    FROM ped_autor PEA
         INNER JOIN autor AUT                   ON AUT.aut_id = PEA.aut_id
         INNER JOIN pedido PED                  ON PED.ped_id = PEA.ped_id
         INNER JOIN ordem_dispensacao ORD       ON ORD.pea_id = PEA.pea_id
         INNER JOIN unidade_dispensadora UND    ON UND.und_id = ORD.und_id
         INNER JOIN unidade_organizacional UNO  ON UNO.uno_id = PED.uno_id
         INNER JOIN status STA                  ON STA.sta_id = PEA.sta_id
         INNER JOIN tipo_demanda TPD            ON TPD.tpd_id = PED.ped_tipo
         INNER JOIN ord_pro ORP                 ON ORP.ord_id = ORD.ord_id
                                               AND ORP.orp_ativo_atual = 1
         INNER JOIN vw_itens I                  ON I.pro_id = ORP.pro_id
         LEFT OUTER JOIN recusa_item REI        ON REI.rei_id = ORP.rei_id
         LEFT JOIN (
             SELECT OD9.pea_id AS pea_id, ORDPRO9.pro_id AS pro_id, Count(*) AS total
               FROM rec_ord_pro ROP
                    INNER JOIN ord_pro ORDPRO9       ON ORDPRO9.orp_id = ROP.orp_id
                    INNER JOIN recibo RECS           ON RECS.rec_id = ROP.rec_id
                    LEFT OUTER JOIN rec_ord_pro ROP2 ON ROP2.rop_id = ROP.rop_conta_disp
                    INNER JOIN ordem_dispensacao OD9 ON OD9.ord_id = ORDPRO9.ord_id
              WHERE (ROP.mot_id = 2 OR ROP.mot_id IS NULL)
                AND (ROP.rop_conta_disp IS NULL
                     OR (ROP.rop_conta_disp IS NOT NULL
                         AND (ROP2.rop_dispensado IS NULL OR ROP2.rop_dispensado = 0)))
                AND RECS.rec_situacao = 'V'
              GROUP BY OD9.pea_id, ORDPRO9.pro_id
         ) DISPENSACOES ON DISPENSACOES.pea_id = ORD.pea_id
                       AND DISPENSACOES.pro_id = ORP.pro_id

    WHERE PEA.pea_dth_entrada BETWEEN To_date('01/01/2000', 'DD/MM/YYYY') AND Trunc(SYSDATE + 1)
      AND I.cat_id IN (1, 2, 3, 4, 5)
      AND STA.sta_descricao LIKE 'Demanda Ativa%'
      AND (:und_id IS NULL OR ORD.und_id = :und_id)
) reg
WHERE reg.status_item = 'Item em Atendimento'
ORDER BY reg.und_descricao, reg.aut_nome, reg.desc_produto
