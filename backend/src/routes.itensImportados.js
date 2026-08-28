// =====================================================================
// routes.itensImportados.js — /api/itens-importados
//
// Relatório de Itens Importados (grupo Importados). Lista, uma linha por
// item (SCODES), os itens que hoje são IMPORTADOS (relatorio_itens.importado
// = 'Sim' na foto mais recente) E têm DEMANDA ATIVA (algum autor com
// status "Demanda Ativa - ..." na foto mais recente de autores_itens) —
// mesma regra da Listagem de Autores Importados.
//
// Colunas: SCODES | CATMAT | SIAFÍSICO | Descrição | Categoria | Código GSNET.
// O "Código GSNET" NÃO vem das importações: é digitado aqui e guardado na
// tabela itens_gsnet (um por SCODES). Editar exige a ação "editar" do módulo.
//
// DESEMPENHO: o filtro de demanda ativa usa substr(status_demanda,1,13) —
// nativo e rápido — em vez de LIKE (que aqui é sobrescrito e roda em JS por
// linha, custoso nas ~217 mil linhas de autores).
// =====================================================================
const express = require('express');
const db = require('./db');

const router = express.Router();

function ultimaData(tabela, coluna = 'data_referencia') {
  const r = db.prepare(`SELECT MAX(${coluna}) v FROM ${tabela}`).get();
  return r && r.v ? r.v : null;
}

// Monta a lista de itens (importado + demanda ativa) com o Código GSNET.
function listar(busca, categoria) {
  const dRi = ultimaData('relatorio_itens');
  const dAut = ultimaData('autores_itens');
  if (!dRi || !dAut) return { dataReferencia: dRi, dataAutores: dAut, itens: [] };

  const sql = `
    WITH ativos AS (
      SELECT DISTINCT codigo_item FROM autores_itens
       WHERE data_referencia = ? AND substr(status_demanda, 1, 13) = 'Demanda Ativa'
    )
    SELECT ri.codigo                     AS codigo,
           MAX(ri.catmat)                AS catmat,
           MAX(ri.siafisico)             AS siafisico,
           MAX(ri.descricao_item)        AS descricao,
           MAX(ri.categoria)             AS categoria,
           (SELECT g.codigo_gsnet FROM itens_gsnet g WHERE g.codigo_item = ri.codigo) AS codigoGsnet
      FROM relatorio_itens ri
      JOIN ativos ON ativos.codigo_item = ri.codigo
     WHERE ri.data_referencia = ? AND ri.importado = 'Sim'
     GROUP BY ri.codigo
     ${categoria ? 'HAVING categoria = ?' : ''}
     ORDER BY descricao COLLATE NOCASE`;
  const p = categoria ? [dAut, dRi, categoria] : [dAut, dRi];
  let itens = db.prepare(sql).all(...p);

  if (busca) {
    const alvo = db.normalizarBusca(busca);
    itens = itens.filter((i) => {
      const t = db.normalizarBusca(`${i.codigo} ${i.catmat || ''} ${i.siafisico || ''} ${i.descricao || ''} ${i.categoria || ''} ${i.codigoGsnet || ''}`);
      return t.includes(alvo);
    });
  }
  return { dataReferencia: dRi, dataAutores: dAut, itens };
}

// GET /api/itens-importados
router.get('/', (req, res) => {
  const busca = (req.query.busca || '').trim();
  const categoria = (req.query.categoria || '').trim();
  const { dataReferencia, dataAutores, itens } = listar(busca, categoria);
  // Opções de categoria (a partir do universo, sem filtro de categoria).
  const universo = categoria ? listar('', '').itens : itens;
  const categorias = [...new Set(universo.map((i) => i.categoria).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt'));
  // Data + hora da última importação do Relatório de Itens (fonte dos dados).
  const _imp = db.prepare("SELECT datetime(criado_em,'localtime') q FROM importacoes WHERE tipo='relatorio_itens' ORDER BY criado_em DESC LIMIT 1").get();
  res.json({ dataReferencia, dataAutores, dataImportacao: _imp ? _imp.q : null, total: itens.length, itens, categorias });
});

// GET /api/itens-importados/csv
router.get('/csv', (req, res) => {
  const { itens } = listar((req.query.busca || '').trim(), (req.query.categoria || '').trim());
  const esc = (v) => {
    const t = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const cab = 'Codigo SCODES;CATMAT;Siafisico;Descricao do Item;Categoria;Codigo GSNET';
  const corpo = itens.map((i) => [i.codigo, i.catmat, i.siafisico, i.descricao, i.categoria, i.codigoGsnet]
    .map(esc).join(';')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="itens_importados.csv"');
  res.send('﻿' + cab + '\n' + corpo);
});

// PUT /api/itens-importados/gsnet  { codigo_item, codigo_gsnet }
// Grava/atualiza o Código GSNET do item. Exige a ação "editar" do módulo
// (garantida pelo exigirModulo no server.js — PUT => editar).
router.put('/gsnet', (req, res) => {
  const codigo = String((req.body && req.body.codigo_item) || '').trim();
  if (!codigo) return res.status(400).json({ erro: 'Informe o código do item.' });
  const gsnet = req.body && req.body.codigo_gsnet != null ? String(req.body.codigo_gsnet).trim() : '';

  db.prepare(`
    INSERT INTO itens_gsnet (codigo_item, codigo_gsnet, atualizado_em, atualizado_por_email)
    VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(codigo_item) DO UPDATE SET
      codigo_gsnet = excluded.codigo_gsnet,
      atualizado_em = excluded.atualizado_em,
      atualizado_por_email = excluded.atualizado_por_email
  `).run(codigo, gsnet || null, req.usuario ? req.usuario.email : null);

  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.usuario.id, req.usuario.email, 'editar_codigo_gsnet', 'itens_gsnet', codigo, JSON.stringify({ codigo_item: codigo, codigo_gsnet: gsnet }));

  res.json({ ok: true, codigo_item: codigo, codigo_gsnet: gsnet });
});

module.exports = router;
