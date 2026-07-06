-- =====================================================================
-- Query: Demandas Judiciais (nível item)
-- Origem: relatório oficial SCODES, enxugado para 20 colunas
-- Granularidade: uma linha por item da demanda
-- Aliases de coluna escolhidos para bater exatamente com o MAPA de
-- importarAutoresDeBuffer() em routes.autores.js (após normalizar():
-- '.', '_' -> espaço, minúsculas). Isso permite que o CSV gerado por
-- sync-demandas.js seja importado pelo pipeline já existente (vigiaAutores.js).
-- Sempre roda SEM filtro de unidade (:und_id = NULL): traz todas as
-- unidades de uma vez. O filtro por unidade já existe no /api/autores
-- (?unidade=...), então não é preciso gerar arquivos separados.
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
    reg.pro_siafisico         AS "Cod_SIAFISICO"
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

        To_char(Fcn_data_ultimo_recibo_item(PEA.pea_id, ORP.pro_id),  'DD/MM/YYYY') AS data_ultima_dispensacao,
        To_char(Fcn_data_ultimo_retorno_item(PEA.pea_id, ORP.pro_id), 'DD/MM/YYYY') AS data_ultimo_retorno,

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
ORDER BY reg.und_descricao, reg.aut_nome, reg.desc_produto
