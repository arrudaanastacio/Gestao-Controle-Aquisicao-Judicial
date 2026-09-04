// =====================================================================
// routes.saidaLotes.js — Movimentações de SAÍDA com Lotes/Validade
// Fonte: Oracle (SCODES), dois blocos de Saída (dispensações + demais
// saídas). Espelha routes.entradaLotes.js. A janela de datas (últimos 12
// meses) é calculada dentro da query SQL — desliza sozinha, sem parâmetro.
//
// Diferenças em relação à Entrada:
//   • Filtros de "tipo de movimentação" e "categoria" aceitam SELEÇÃO
//     MÚLTIPLA (vários valores) — o front manda ?tipo=a&tipo=b&categoria=x.
//   • Endpoint extra /consolidado: soma a quantidade por item (SCODES),
//     respeitando os mesmos filtros da listagem.
// =====================================================================
const express = require('express');
const XLSX = require('xlsx');
const db = require('./db');
const { autenticar, exigirPerfil, exigirOracle } = require('./auth');

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
  'item', 'unidade', 'data_saida', 'tipo_movimentacao', 'unidade_transferencia',
  'fornecedor', 'fornecedor_cnpj', 'documento_transferencia', 'tipo_transferencia',
  'fabricante', 'codigo_item', 'qtde', 'usuario_login', 'observacao',
  'lote', 'validade', 'lote_foi_digitado', 'categoria',
];
const CAMPOS_NUMERICOS = new Set(['qtde']);

// Substitui TODO o conteúdo da tabela pelas linhas informadas (a query já
// traz só a janela dos últimos 12 meses, então "tudo" = "a janela atual").
function importarSaidaLotesDeLinhas(linhas) {
  const apagar = db.prepare('DELETE FROM saida_lotes_itens');
  const inserir = db.prepare(
    `INSERT INTO saida_lotes_itens (${CAMPOS.join(',')}) VALUES (${CAMPOS.map(() => '?').join(',')})`
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

// Normaliza um parâmetro que pode vir como valor único, lista repetida
// (?x=a&x=b) ou undefined — devolve sempre um array de strings não-vazias.
function comoLista(v) {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((s) => String(s).trim()).filter((s) => s !== '');
}

// Monta a cláusula WHERE compartilhada por listagem e consolidado.
function montarFiltros(query) {
  const { q, tipoMovimentacao, categoria, dataInicio, dataFim } = query;
  const condicoes = [];
  const params = [];

  if (q) {
    condicoes.push(`(item LIKE ? OR codigo_item LIKE ? OR lote LIKE ? OR fornecedor LIKE ? OR usuario_login LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }

  const tipos = comoLista(tipoMovimentacao);
  if (tipos.length) {
    condicoes.push(`tipo_movimentacao IN (${tipos.map(() => '?').join(',')})`);
    params.push(...tipos);
  }

  const categorias = comoLista(categoria);
  if (categorias.length) {
    condicoes.push(`categoria IN (${categorias.map(() => '?').join(',')})`);
    params.push(...categorias);
  }

  if (dataInicio) { condicoes.push('date(data_saida) >= date(?)'); params.push(dataInicio); }
  if (dataFim) { condicoes.push('date(data_saida) <= date(?)'); params.push(dataFim); }

  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
  return { where, params };
}

// ---------- Consulta ----------
router.get('/resumo', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) c FROM saida_lotes_itens').get().c;
  const ultima = db.prepare('SELECT MAX(data_saida) d, MIN(data_saida) di FROM saida_lotes_itens').get();
  res.json({ total, dataMaisRecente: ultima.d, dataMaisAntiga: ultima.di });
});

router.get('/filtros', (req, res) => {
  const tipos = db.prepare('SELECT DISTINCT tipo_movimentacao FROM saida_lotes_itens WHERE tipo_movimentacao IS NOT NULL ORDER BY tipo_movimentacao').all().map((r) => r.tipo_movimentacao);
  const categorias = db.prepare('SELECT DISTINCT categoria FROM saida_lotes_itens WHERE categoria IS NOT NULL ORDER BY categoria').all().map((r) => r.categoria);
  res.json({ tipos, categorias });
});

// Consolidado: soma a quantidade por item (SCODES), com os mesmos filtros.
router.get('/consolidado', (req, res) => {
  const { where, params } = montarFiltros(req.query);
  const linhas = db.prepare(`
    SELECT codigo_item, MAX(item) item, MAX(categoria) categoria,
           SUM(qtde) qtde_total, COUNT(*) movimentacoes
    FROM saida_lotes_itens ${where}
    GROUP BY codigo_item
    ORDER BY qtde_total DESC, item
  `).all(...params);
  const totalItens = linhas.length;
  const totalQtde = linhas.reduce((s, l) => s + (l.qtde_total || 0), 0);
  const totalMovimentacoes = linhas.reduce((s, l) => s + (l.movimentacoes || 0), 0);
  res.json({ linhas, totalItens, totalQtde, totalMovimentacoes });
});

// Exporta a lista detalhada em Excel (.xlsx), respeitando os filtros ativos.
router.get('/exportar', (req, res) => {
  const { where, params } = montarFiltros(req.query);
  const rows = db.prepare(`
    SELECT * FROM saida_lotes_itens ${where}
    ORDER BY data_saida DESC, id DESC
  `).all(...params);

  const linhas = rows.map((s) => ({
    'Data Saída': s.data_saida || '',
    'Medicamento': s.item || '',
    'Código Item': s.codigo_item || '',
    'Lote': s.lote || '',
    'Validade': s.validade || '',
    'Qtde': s.qtde != null ? s.qtde : '',
    'Tipo Movimentação': s.tipo_movimentacao || '',
    'Categoria': s.categoria || '',
    'Fabricante': s.fabricante || '',
    'Un. Transferência': s.unidade_transferencia || '',
    'Fornecedor': s.fornecedor || '',
    'Documento': s.documento_transferencia || '',
    'Usuário': s.usuario_login || '',
    'Observação': s.observacao || '',
  }));

  const ws = XLSX.utils.json_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Saídas');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const nome = `Movimentacao_Saida_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`;
  res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Exporta o consolidado por item em Excel (.xlsx), respeitando os filtros.
router.get('/consolidado/exportar', (req, res) => {
  const { where, params } = montarFiltros(req.query);
  const rows = db.prepare(`
    SELECT codigo_item, MAX(item) item, MAX(categoria) categoria,
           SUM(qtde) qtde_total, COUNT(*) movimentacoes
    FROM saida_lotes_itens ${where}
    GROUP BY codigo_item
    ORDER BY qtde_total DESC, item
  `).all(...params);

  const linhas = rows.map((l) => ({
    'Código Item': l.codigo_item || '',
    'Medicamento': l.item || '',
    'Categoria': l.categoria || '',
    'Qtde Total Saída': l.qtde_total != null ? l.qtde_total : '',
    'Nº de Movimentações': l.movimentacoes != null ? l.movimentacoes : '',
  }));

  const ws = XLSX.utils.json_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Consolidado Saídas');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const nome = `Saida_Consolidado_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`;
  res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.get('/', (req, res) => {
  const { page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const { where, params } = montarFiltros(req.query);

  const total = db.prepare(`SELECT COUNT(*) c FROM saida_lotes_itens ${where}`).get(...params).c;
  const linhas = db.prepare(`
    SELECT * FROM saida_lotes_itens ${where}
    ORDER BY data_saida DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ saidas: linhas, total, page: Number(page), pageSize: limit });
});

// ---------- Atualização via Oracle (SCODES) ----------
const estadoOracle = { rodando: false, inicio: null, ultimoResumo: null, ultimoErro: null };

function executarAtualizacaoSaidaLotesOracle(opcoes = {}) {
  if (estadoOracle.rodando) return Promise.resolve({ pulou: true, motivo: 'já em andamento' });
  const { atualizarSaidaLotesViaOracle } = require('../oracle/sync-saida-lotes');
  estadoOracle.rodando = true;
  estadoOracle.inicio = new Date().toISOString();
  estadoOracle.ultimoErro = null;

  return atualizarSaidaLotesViaOracle(opcoes)
    .then((resumo) => {
      estadoOracle.ultimoResumo = { ...resumo, fim: new Date().toISOString() };
      console.log(`[SYNC SAIDA LOTES] Concluido via Oracle: ${resumo.totalLinhas} linhas em ${Math.round((resumo.duracaoMs || 0) / 1000)}s.`);
      return resumo;
    })
    .catch((e) => {
      estadoOracle.ultimoErro = e.message;
      console.error('[SYNC SAIDA LOTES] Falha via Oracle:', e.message);
      require('./emailAlerta').enviarAlertaFalhaSincronizacao('Movimentações de Saída (Lotes/Validade)', e.message);
      throw e;
    })
    .finally(() => { estadoOracle.rodando = false; });
}

function iniciarAtualizacaoOracle(opcoes = {}) {
  if (estadoOracle.rodando) return { iniciado: false, jaRodando: true };
  executarAtualizacaoSaidaLotesOracle(opcoes).catch(() => {});
  return { iniciado: true, jaRodando: false };
}

router.post('/atualizar-oracle', exigirOracle, (req, res) => {
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
module.exports.importarSaidaLotesDeLinhas = importarSaidaLotesDeLinhas;
module.exports.executarAtualizacaoSaidaLotesOracle = executarAtualizacaoSaidaLotesOracle;
