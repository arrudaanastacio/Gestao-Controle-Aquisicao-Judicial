// =====================================================================
// routes.rupturas.js — /api/rupturas
//
// Módulo Ruptura: lista as dispensações que não puderam ser atendidas,
// por padrão nos ÚLTIMOS 30 DIAS, cruzando com:
//   - relatorio_itens  -> categoria, tipo de item, importado, outras demandas
//   - autores_itens    -> nome do paciente e unidade (via protocolo)
//
// As classificações NÃO são copiadas para a tabela de rupturas: vêm por
// junção, para acompanharem qualquer correção feita no cadastro de itens.
//
// Rotas nomeadas vêm ANTES de rotas com parâmetro (convenção do projeto).
// =====================================================================
const express = require('express');
const db = require('./db');
const { importarRupturasPeriodo, importarUltimos30Dias, janelaPadrao, DIAS_JANELA_PADRAO } = require('./rupturasUdtp');
const { credenciaisConfiguradas } = require('./udtpApi');

const router = express.Router();

function ultimaData(tabela) {
  const r = db.prepare(`SELECT MAX(data_referencia) AS d FROM ${tabela}`).get();
  return r && r.d ? r.d : null;
}

// Monta o FROM/JOIN comum às consultas.
//
// DESEMPENHO: a tabela de autores tem ~217 mil linhas por data. A versão
// anterior juntava uma subconsulta que normalizava o protocolo com REPLACE e
// agrupava TODAS essas linhas — varredura completa, repetida nas 8 consultas
// da tela (48 s no total). Duas mudanças resolveram:
//   1. o protocolo normalizado passou a ser COLUNA indexada em autores_itens
//      (ver db.js), então a busca do paciente vira acesso por índice;
//   2. a tabela de autores só entra quando é realmente necessária — os KPIs,
//      as quebras e os gráficos não usam o nome do paciente.
// O ? do FROM é a data do relatorio_itens, antes dos parâmetros do WHERE.
function baseConsulta() {
  return `
    FROM rupturas_itens r
    LEFT JOIN relatorio_itens ri
           ON ri.codigo = r.codigo_item AND ri.data_referencia = ?
  `;
}

// Subconsulta escalar que traz um campo do autor pelo protocolo. Usada só na
// lista; por ser escalar, não multiplica linhas quando o mesmo protocolo
// aparece em vários itens da demanda (era para isso que servia o GROUP BY).
function campoAutor(coluna, apelido) {
  return `(SELECT x.${coluna} FROM autores_itens x
            WHERE x.data_referencia = ? AND x.protocolo_norm = r.protocolo_norm
            LIMIT 1) AS ${apelido}`;
}

// Filtros vindos da tela. Devolve { onde, params } para concatenar.
// `dAut` é a data dos autores, necessária só quando a busca pode casar com o
// nome do paciente.
function montarFiltros(q, dAut) {
  const cond = ['r.data >= ?', 'r.data <= ?'];
  const params = [q.inicio, q.fim];

  if (q.busca) {
    const like = `%${q.busca}%`;
    cond.push(`(r.descricao LIKE ? OR r.codigo_item LIKE ? OR r.protocolo LIKE ?
                OR EXISTS (SELECT 1 FROM autores_itens x
                            WHERE x.data_referencia = ?
                              AND x.protocolo_norm = r.protocolo_norm
                              AND x.autor LIKE ?))`);
    params.push(like, like, like, dAut, like);
  }
  if (q.categoria) { cond.push('ri.categoria = ?'); params.push(q.categoria); }
  if (q.tipoItem) { cond.push('ri.tipo_item = ?'); params.push(q.tipoItem); }
  if (q.importado) { cond.push('ri.importado = ?'); params.push(q.importado); }
  if (q.outrasDemandas) { cond.push('ri.outras_demandas = ?'); params.push(q.outrasDemandas); }

  return { onde: cond.join(' AND '), params };
}

function lerPeriodo(req) {
  const padrao = janelaPadrao(DIAS_JANELA_PADRAO);
  const inicio = /^\d{4}-\d{2}-\d{2}$/.test(req.query.inicio || '') ? req.query.inicio : padrao.inicio;
  const fim = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fim || '') ? req.query.fim : padrao.fim;
  return { inicio, fim };
}

// ---------- Consulta principal: lista + KPIs + quebra por categoria ----------
router.get('/', (req, res) => {
  const { inicio, fim } = lerPeriodo(req);
  const dRel = ultimaData('relatorio_itens');
  const dAut = ultimaData('autores_itens');

  const q = {
    inicio, fim,
    busca: (req.query.busca || '').trim(),
    categoria: (req.query.categoria || '').trim(),
    tipoItem: (req.query.tipoItem || '').trim(),
    importado: (req.query.importado || '').trim(),
    outrasDemandas: (req.query.outrasDemandas || '').trim(),
  };
  const { onde, params } = montarFiltros(q, dAut);
  const base = baseConsulta();
  const pre = [dRel];             // parâmetro do JOIN (vem antes do WHERE)

  // Aqui as duas subconsultas do autor entram no SELECT, então as datas delas
  // vêm ANTES do parâmetro do JOIN de relatorio_itens.
  const linhas = db.prepare(`
    SELECT r.data, r.codigo_item AS codigoItem, r.descricao,
           r.unidade_medida AS unidade, r.quantidade, r.protocolo,
           ${campoAutor('autor', 'paciente')},
           ${campoAutor('unidade_dispensadora', 'unidadePaciente')},
           ri.categoria, ri.tipo_item AS tipoItem,
           ri.importado, ri.outras_demandas AS outrasDemandas
    ${base}
     WHERE ${onde}
     ORDER BY r.data DESC, r.descricao COLLATE NOCASE
     LIMIT 3000
  `).all(dAut, dAut, ...pre, ...params);

  const kpis = db.prepare(`
    SELECT COUNT(*) AS totalRupturas,
           COALESCE(SUM(r.quantidade), 0) AS quantidadeTotal,
           COUNT(DISTINCT r.protocolo_norm) AS pacientes,
           COUNT(DISTINCT r.codigo_item) AS itens
    ${base}
     WHERE ${onde}
  `).get(...pre, ...params);

  // Quebra por categoria: itens e pacientes distintos em cada uma.
  const porCategoria = db.prepare(`
    SELECT COALESCE(NULLIF(ri.categoria, ''), 'Sem categoria') AS categoria,
           COUNT(*) AS rupturas,
           COUNT(DISTINCT r.codigo_item) AS itens,
           COUNT(DISTINCT r.protocolo_norm) AS pacientes,
           COALESCE(SUM(r.quantidade), 0) AS quantidade
    ${base}
     WHERE ${onde}
     GROUP BY categoria
     ORDER BY rupturas DESC
  `).all(...pre, ...params);

  // Quebra por tipo de item (Genérico/Marca/Manipulado/Homeopático)
  const porTipo = db.prepare(`
    SELECT COALESCE(NULLIF(ri.tipo_item, ''), 'Sem tipo') AS tipo,
           COUNT(*) AS rupturas,
           COUNT(DISTINCT r.codigo_item) AS itens,
           COUNT(DISTINCT r.protocolo_norm) AS pacientes
    ${base}
     WHERE ${onde}
     GROUP BY tipo
     ORDER BY rupturas DESC
  `).all(...pre, ...params);

  // Série diária (para o gráfico de evolução no período filtrado)
  const porDia = db.prepare(`
    SELECT r.data,
           COUNT(*) AS rupturas,
           COUNT(DISTINCT r.protocolo_norm) AS pacientes,
           COALESCE(SUM(r.quantidade), 0) AS quantidade
    ${base}
     WHERE ${onde}
     GROUP BY r.data
     ORDER BY r.data
  `).all(...pre, ...params);

  // Itens que mais romperam (para o gráfico de barras "top itens")
  const topItens = db.prepare(`
    SELECT r.codigo_item AS codigoItem,
           MAX(r.descricao) AS descricao,
           COUNT(*) AS rupturas,
           COUNT(DISTINCT r.protocolo_norm) AS pacientes,
           COALESCE(SUM(r.quantidade), 0) AS quantidade
    ${base}
     WHERE ${onde}
     GROUP BY r.codigo_item
     ORDER BY rupturas DESC
     LIMIT 10
  `).all(...pre, ...params);

  const cab = db.prepare(
    'SELECT criado_em FROM rupturas_importacoes ORDER BY id DESC LIMIT 1'
  ).get();

  // Opções dos filtros, a partir do que existe no período
  const opcoes = {
    categorias: db.prepare(`SELECT DISTINCT ri.categoria AS v ${base} WHERE r.data >= ? AND r.data <= ? AND ri.categoria IS NOT NULL AND ri.categoria <> '' ORDER BY v`)
      .all(dRel, inicio, fim).map((x) => x.v),
    tiposItem: db.prepare(`SELECT DISTINCT ri.tipo_item AS v ${base} WHERE r.data >= ? AND r.data <= ? AND ri.tipo_item IS NOT NULL AND ri.tipo_item <> '' ORDER BY v`)
      .all(dRel, inicio, fim).map((x) => x.v),
  };

  res.json({
    periodo: { inicio, fim },
    atualizadoEm: cab ? cab.criado_em : null,
    dataRelatorioItens: dRel,
    dataAutores: dAut,
    linhas,
    kpis,
    porCategoria,
    porTipo,
    porDia,
    topItens,
    opcoes,
    credenciaisConfiguradas: credenciaisConfiguradas(),
  });
});

// ---------- Aba "Andamento de compra" ----------
// Lista os ITENS que romperam no período (uma linha por item, não por
// ocorrência) e diz, para cada um, se existe compra em andamento.
//
// A separação que interessa na prática:
//   - SEM compra em aberto -> ninguém está resolvendo; é fila de trabalho.
//   - COM compra em aberto -> o processo existe, o que falta é prazo/entrega.
const STATUS_ABERTO = ['Planejamento', 'Adjucado', 'Empenhado', 'Entrega Parcial'];
const EM_ABERTO_SQL = STATUS_ABERTO.map(() => '?').join(',');

// A compra do mesmo item pode estar em QUALQUER um dos dois fluxos: Tenente
// Pena (solicitacoes) ou Outras Demandas (solicitacoes_od). Olhar só o
// primeiro marcaria como "nunca comprado" itens que estão sendo comprados
// pelo outro — conferido no dado real: 10 itens caíam nessa armadilha.
// A coluna `fluxo` preserva a origem, para a tela poder mostrar de onde vem.
// Escopo Tenente Pena no estoque (mesma regra das telas de estoque: linhas sem
// unidade ou da própria unidade). Sem isso, o estoque de OUTRAS unidades
// entraria na conta e mascararia a falta aqui.
const ESCOPO_TP = "(e.unidade IS NULL OR e.unidade LIKE '%Tenente Pena%')";

const COMPRAS_CTE = `
  WITH compras AS (
    SELECT codigo_item, status, ano, mes, 'TP' AS fluxo FROM solicitacoes
    UNION ALL
    SELECT codigo_item, status, ano, mes, 'OD' AS fluxo FROM solicitacoes_od
  )`;

// Ordem cronológica do mês, que no banco é o NOME por extenso.
const ordemMes = (col = 'mes') => `CASE ${col}
    WHEN 'Janeiro' THEN 1 WHEN 'Fevereiro' THEN 2 WHEN 'Março' THEN 3 WHEN 'Abril' THEN 4
    WHEN 'Maio' THEN 5 WHEN 'Junho' THEN 6 WHEN 'Julho' THEN 7 WHEN 'Agosto' THEN 8
    WHEN 'Setembro' THEN 9 WHEN 'Outubro' THEN 10 WHEN 'Novembro' THEN 11 WHEN 'Dezembro' THEN 12
  END`;

router.get('/compras', (req, res) => {
  const { inicio, fim } = lerPeriodo(req);
  const dRel = ultimaData('relatorio_itens');
  const dAut = ultimaData('autores_itens');
  const q = {
    inicio, fim,
    busca: (req.query.busca || '').trim(),
    categoria: (req.query.categoria || '').trim(),
    tipoItem: (req.query.tipoItem || '').trim(),
    importado: (req.query.importado || '').trim(),
    outrasDemandas: (req.query.outrasDemandas || '').trim(),
  };
  const { onde, params } = montarFiltros(q, dAut);
  const dEstoque = ultimaData('estoque_importacoes');

  const itens = db.prepare(`
    ${COMPRAS_CTE}
    SELECT r.codigo_item AS codigoItem,
           MAX(r.descricao) AS descricao,
           COUNT(*) AS rupturas,
           COUNT(DISTINCT r.protocolo_norm) AS pacientes,
           COALESCE(SUM(r.quantidade), 0) AS quantidade,
           MAX(r.data) AS ultimaRuptura,
           MAX(ri.categoria) AS categoria,
           MAX(ri.tipo_item) AS tipoItem,
           (SELECT COUNT(*) FROM compras c
             WHERE c.codigo_item = r.codigo_item
               AND c.status IN (${EM_ABERTO_SQL})) AS comprasAbertas,
           (SELECT COUNT(*) FROM compras c
             WHERE c.codigo_item = r.codigo_item) AS comprasTotal,
           (SELECT c.status FROM compras c
             WHERE c.codigo_item = r.codigo_item AND c.status IN (${EM_ABERTO_SQL})
             ORDER BY c.ano DESC, ${ordemMes('c.mes')} DESC LIMIT 1) AS statusAtual,
           (SELECT c.fluxo FROM compras c
             WHERE c.codigo_item = r.codigo_item AND c.status IN (${EM_ABERTO_SQL})
             ORDER BY c.ano DESC, ${ordemMes('c.mes')} DESC LIMIT 1) AS fluxoAtual,
           (SELECT c.ano || '/' || c.mes FROM compras c
             WHERE c.codigo_item = r.codigo_item
             ORDER BY c.ano DESC, ${ordemMes('c.mes')} DESC LIMIT 1) AS ultimaCompra,
           (SELECT MAX(e.autonomia) FROM estoque_itens e
             WHERE e.codigo_item = r.codigo_item AND e.data_referencia = ?
               AND ${ESCOPO_TP}) AS autonomiaHoje,
           (SELECT SUM(e.estoque) FROM estoque_itens e
             WHERE e.codigo_item = r.codigo_item AND e.data_referencia = ?
               AND ${ESCOPO_TP}) AS estoqueHoje
    ${baseConsulta()}
     WHERE ${onde}
     GROUP BY r.codigo_item
     ORDER BY pacientes DESC, rupturas DESC
  `).all(
    // ATENÇÃO: os ? são posicionais e as subconsultas do SELECT vêm ANTES do
    // FROM. Ordem: os três blocos de status, as duas datas de estoque, a data
    // do relatorio_itens (JOIN) e só então os filtros do WHERE.
    ...STATUS_ABERTO, ...STATUS_ABERTO, ...STATUS_ABERTO,
    dEstoque, dEstoque, dRel, ...params,
  );

  // REGRA DE NEGÓCIO (pedido do Rafael): a ruptura é um fato do passado. Se
  // hoje o item já voltou a ter autonomia SUFICIENTE, deixou de estar em falta
  // e não deve poluir a fila de trabalho — ex.: rompeu em 01/07 e em 23/07 já
  // repôs. O corte NÃO é "autonomia > 0", e sim o mesmo limiar configurável
  // usado pelos alertas de estoque (padrão 2 meses): um item com estoque para
  // poucos dias tecnicamente tem autonomia, mas na prática rompe de novo já.
  // Os itens normalizados não somem do sistema: continuam na aba Lista e
  // podem ser trazidos de volta com "incluirNormalizados".
  const limiarAutonomia = Number(
    db.prepare("SELECT valor FROM configuracoes WHERE chave = 'autonomia_minima_meses'").get()?.valor || '2'
  );
  const jaNormalizado = (i) => Number(i.autonomiaHoje) >= limiarAutonomia;
  const incluirNormalizados = req.query.incluirNormalizados === '1';
  const normalizados = itens.filter(jaNormalizado);
  const visiveis = incluirNormalizados ? itens : itens.filter((i) => !jaNormalizado(i));

  // Três situações, porque exigem ações diferentes:
  //   aberta    -> o processo existe; cobrar prazo/entrega.
  //   semAberta -> já se comprou antes e hoje não há nada; recomprar.
  //   nunca     -> nunca passou por compra; pode ser item de outro fluxo
  //                ou cadastro faltando. Merece conferência antes de agir.
  const situacaoDe = (i) => (i.comprasAbertas > 0 ? 'aberta' : (i.comprasTotal > 0 ? 'semAberta' : 'nunca'));
  const resumo = {
    aberta: { itens: 0, rupturas: 0, pacientes: 0 },
    semAberta: { itens: 0, rupturas: 0, pacientes: 0 },
    nunca: { itens: 0, rupturas: 0, pacientes: 0 },
  };
  for (const i of visiveis) {
    i.situacao = situacaoDe(i);
    const alvo = resumo[i.situacao];
    alvo.itens += 1;
    alvo.rupturas += i.rupturas;
    alvo.pacientes += i.pacientes;   // soma por item (um paciente pode contar em 2 itens)
  }

  res.json({
    periodo: { inicio, fim },
    itens: visiveis,
    resumo,
    dataEstoque: dEstoque,
    limiarAutonomia,
    normalizados: {
      itens: normalizados.length,
      pacientes: normalizados.reduce((s, i) => s + i.pacientes, 0),
      incluidos: incluirNormalizados,
    },
  });
});

// Detalhe de UM item para o modal: rupturas do período + histórico de compra.
// O código vai por query string (e não na URL) porque contém barras.
router.get('/compras/detalhe', (req, res) => {
  const codigo = req.query.codigo;
  if (!codigo) return res.status(400).json({ erro: 'Informe o código do item.' });
  const { inicio, fim } = lerPeriodo(req);
  const dAut = ultimaData('autores_itens');
  const dRel = ultimaData('relatorio_itens');

  const item = db.prepare(`
    SELECT r.codigo_item AS codigoItem, MAX(r.descricao) AS descricao,
           COUNT(*) AS rupturas, COUNT(DISTINCT r.protocolo_norm) AS pacientes,
           COALESCE(SUM(r.quantidade), 0) AS quantidade,
           MAX(ri.categoria) AS categoria, MAX(ri.tipo_item) AS tipoItem,
           MAX(ri.importado) AS importado, MAX(ri.outras_demandas) AS outrasDemandas
    ${baseConsulta()}
     WHERE r.codigo_item = ? AND r.data >= ? AND r.data <= ?
  `).get(dRel, codigo, inicio, fim);

  const rupturas = db.prepare(`
    SELECT r.data, r.quantidade, r.protocolo,
           ${campoAutor('autor', 'paciente')}
      FROM rupturas_itens r
     WHERE r.codigo_item = ? AND r.data >= ? AND r.data <= ?
     ORDER BY r.data DESC
  `).all(dAut, codigo, inicio, fim);

  // Histórico dos DOIS fluxos numa lista só, marcando a origem.
  // (solicitacoes_od não tem a coluna quantidade_empenho; vai como NULL para
  //  as duas metades terem o mesmo formato no UNION.)
  const compras = db.prepare(`
    SELECT * FROM (
      SELECT 'TP' AS fluxo, ano, mes, tipo, modalidade_compra, n_oficio,
             qtde_solicitada, data_solicitacao, n_empenho, quantidade_empenho,
             data_previsao_entrega, data_entrega, qtde_entregue, qtde_pendente,
             status, observacao
        FROM solicitacoes WHERE codigo_item = ?
      UNION ALL
      SELECT 'OD' AS fluxo, ano, mes, tipo, modalidade_compra, n_oficio,
             qtde_solicitada, data_solicitacao, n_empenho, NULL AS quantidade_empenho,
             data_previsao_entrega, data_entrega, qtde_entregue, qtde_pendente,
             status, observacao
        FROM solicitacoes_od WHERE codigo_item = ?
    )
     ORDER BY ano DESC, ${ordemMes()} DESC
  `).all(codigo, codigo);

  // Situação de estoque na foto mais recente, para dar contexto ao modal.
  const ultEstoque = ultimaData('estoque_importacoes');
  const estoque = ultEstoque ? db.prepare(`
    SELECT SUM(e.estoque) AS estoque, MAX(e.autonomia) AS autonomia,
           SUM(e.demandas) AS demandas
      FROM estoque_itens e
     WHERE e.codigo_item = ? AND e.data_referencia = ? AND ${ESCOPO_TP}
  `).get(codigo, ultEstoque) : null;

  res.json({ item, rupturas, compras, estoque, dataEstoque: ultEstoque, periodo: { inicio, fim } });
});

// ---------- Exportar CSV ----------
router.get('/csv', (req, res) => {
  const { inicio, fim } = lerPeriodo(req);
  const dRel = ultimaData('relatorio_itens');
  const dAut = ultimaData('autores_itens');
  const q = {
    inicio, fim,
    busca: (req.query.busca || '').trim(),
    categoria: (req.query.categoria || '').trim(),
    tipoItem: (req.query.tipoItem || '').trim(),
    importado: (req.query.importado || '').trim(),
    outrasDemandas: (req.query.outrasDemandas || '').trim(),
  };
  const { onde, params } = montarFiltros(q, dAut);

  const linhas = db.prepare(`
    SELECT r.data, r.codigo_item, r.descricao, r.unidade_medida, r.quantidade,
           r.protocolo, ${campoAutor('autor', 'autor')},
           ri.categoria, ri.tipo_item, ri.importado, ri.outras_demandas
    ${baseConsulta()}
     WHERE ${onde}
     ORDER BY r.data DESC, r.descricao COLLATE NOCASE
  `).all(dAut, dRel, ...params);

  const esc = (v) => {
    const t = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const cab = 'Data;Codigo do Item;Medicamento;Unidade;Qtde em falta;Protocolo;Paciente;Categoria;Tipo de item;Importado;Outras demandas';
  const corpo = linhas.map((l) => [
    l.data, l.codigo_item, l.descricao, l.unidade_medida, l.quantidade,
    l.protocolo, l.autor, l.categoria, l.tipo_item, l.importado, l.outras_demandas,
  ].map(esc).join(';')).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="rupturas_${inicio}_a_${fim}.csv"`);
  res.send('﻿' + cab + '\n' + corpo);
});

// ---------- Atualizar agora ----------
router.post('/importar-agora', async (req, res) => {
  const email = req.usuario ? req.usuario.email : 'sistema';
  const { inicio, fim } = (req.body || {});
  try {
    const resumo = (inicio && fim)
      ? await importarRupturasPeriodo(inicio, fim, email)
      : await importarUltimos30Dias(email);
    res.json({ ok: true, ...resumo });
  } catch (e) {
    const porCodigo = {
      SEM_CREDENCIAL: 400, NAO_AUTORIZADO: 401, SEM_PERMISSAO: 403,
      NAO_ENCONTRADO: 404, TIMEOUT: 504, FALHA_CONEXAO: 502,
      FORMATO_INESPERADO: 502, DATA_INVALIDA: 400,
    };
    res.status(porCodigo[e.codigo] || 500).json({ erro: e.message, codigo: e.codigo || 'ERRO' });
  }
});

module.exports = router;
