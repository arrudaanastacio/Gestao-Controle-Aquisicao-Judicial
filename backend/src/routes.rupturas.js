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
