// =====================================================================
// routes.entradaLotes.js — Movimentações de Entrada com Lotes/Validade
// Fonte: Oracle (SCODES), consulta "Entrada" da query enviada pelo Rafael.
// Janela de datas (últimos 12 meses) é calculada dentro da query SQL —
// desliza sozinha a cada dia, sem precisar de parâmetro nem agendamento
// de datas no lado da aplicação.
// =====================================================================
const express = require('express');
const db = require('./db');
const { autenticar, exigirPerfil } = require('./auth');

const router = express.Router();
router.use(autenticar);

function numero(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function texto(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

const CAMPOS = [
  'item', 'unidade', 'data_entrada', 'tipo_movimentacao', 'unidade_transferencia',
  'modalidade_compra', 'nota_empenho', 'nota_fiscal', 'documento_transferencia',
  'fabricante', 'codigo_item', 'qtde', 'qtde_acerto', 'valor_unitario', 'valor_total',
  'usuario_login', 'observacao', 'termolabil', 'fornecedor', 'fornecedor_cnpj',
  'tipo_transferencia', 'lote', 'validade', 'lote_foi_digitado',
];
const CAMPOS_NUMERICOS = new Set(['qtde', 'qtde_acerto', 'valor_unitario', 'valor_total']);

// Substitui TODO o conteúdo da tabela pelas linhas informadas (a query já
// traz só a janela dos últimos 12 meses, então "tudo" = "a janela atual").
function importarEntradaLotesDeLinhas(linhas) {
  const apagar = db.prepare('DELETE FROM entrada_lotes_itens');
  const inserir = db.prepare(
    `INSERT INTO entrada_lotes_itens (${CAMPOS.join(',')}) VALUES (${CAMPOS.map(() => '?').join(',')})`
  );

  db.exec('BEGIN');
  try {
    apagar.run();
    for (const l of linhas) {
      inserir.run(...CAMPOS.map((c) => {
        const v = l[c];
        if (CAMPOS_NUMERICOS.has(c)) return numero(v);
        return texto(v) ?? (v === undefined ? null : v);
      }));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { totalLinhas: linhas.length };
}

// ---------- Consulta ----------
router.get('/resumo', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) c FROM entrada_lotes_itens').get().c;
  const ultima = db.prepare('SELECT MAX(data_entrada) d, MIN(data_entrada) di FROM entrada_lotes_itens').get();
  res.json({ total, dataMaisRecente: ultima.d, dataMaisAntiga: ultima.di });
});

router.get('/', (req, res) => {
  const { q, tipoMovimentacao, dataInicio, dataFim, page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const condicoes = [];
  const params = [];

  if (q) {
    condicoes.push(`(item LIKE ? OR codigo_item LIKE ? OR lote LIKE ? OR fornecedor LIKE ? OR nota_empenho LIKE ? OR nota_fiscal LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }
  if (tipoMovimentacao) { condicoes.push('tipo_movimentacao = ?'); params.push(tipoMovimentacao); }
  if (dataInicio) { condicoes.push('date(data_entrada) >= date(?)'); params.push(dataInicio); }
  if (dataFim) { condicoes.push('date(data_entrada) <= date(?)'); params.push(dataFim); }

  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) c FROM entrada_lotes_itens ${where}`).get(...params).c;
  const linhas = db.prepare(`
    SELECT * FROM entrada_lotes_itens ${where}
    ORDER BY data_entrada DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ entradas: linhas, total, page: Number(page), pageSize: limit });
});

router.get('/filtros', (req, res) => {
  const tipos = db.prepare('SELECT DISTINCT tipo_movimentacao FROM entrada_lotes_itens WHERE tipo_movimentacao IS NOT NULL ORDER BY tipo_movimentacao').all().map((r) => r.tipo_movimentacao);
  res.json({ tipos });
});

// ---------- Atualização via Oracle (SCODES) ----------
const estadoOracle = { rodando: false, inicio: null, ultimoResumo: null, ultimoErro: null };

function executarAtualizacaoEntradaLotesOracle(opcoes = {}) {
  if (estadoOracle.rodando) return Promise.resolve({ pulou: true, motivo: 'já em andamento' });
  const { atualizarEntradaLotesViaOracle } = require('../oracle/sync-entrada-lotes');
  estadoOracle.rodando = true;
  estadoOracle.inicio = new Date().toISOString();
  estadoOracle.ultimoErro = null;

  return atualizarEntradaLotesViaOracle(opcoes)
    .then((resumo) => {
      estadoOracle.ultimoResumo = { ...resumo, fim: new Date().toISOString() };
      console.log(`[SYNC ENTRADA LOTES] Concluido via Oracle: ${resumo.totalLinhas} linhas em ${Math.round((resumo.duracaoMs || 0) / 1000)}s.`);
      return resumo;
    })
    .catch((e) => {
      estadoOracle.ultimoErro = e.message;
      console.error('[SYNC ENTRADA LOTES] Falha via Oracle:', e.message);
      require('./emailAlerta').enviarAlertaFalhaSincronizacao('Movimentações de Entrada (Lotes/Validade)', e.message);
      throw e;
    })
    .finally(() => { estadoOracle.rodando = false; });
}

function iniciarAtualizacaoOracle(opcoes = {}) {
  if (estadoOracle.rodando) return { iniciado: false, jaRodando: true };
  executarAtualizacaoEntradaLotesOracle(opcoes).catch(() => {});
  return { iniciado: true, jaRodando: false };
}

router.post('/atualizar-oracle', exigirPerfil('admin'), (req, res) => {
  const r = iniciarAtualizacaoOracle({ usuarioEmail: req.usuario.email });
  if (!r.iniciado) {
    return res.status(409).json({ erro: 'Já existe uma atualização via Oracle em andamento.', ...estadoOracle });
  }
  res.json({ iniciado: true, inicio: estadoOracle.inicio });
});

router.get('/atualizar-oracle/status', (req, res) => {
  res.json(estadoOracle);
});

module.exports = router;
module.exports.importarEntradaLotesDeLinhas = importarEntradaLotesDeLinhas;
module.exports.executarAtualizacaoEntradaLotesOracle = executarAtualizacaoEntradaLotesOracle;
