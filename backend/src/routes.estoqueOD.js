// =====================================================================
// routes.estoqueOD.js — Estoque Outras Demandas (operador logístico)
//
// Cruza 3 planilhas da pasta de rede (G:):
//   1. "Cadastro Itens GSNET - IBL.xlsx" — mapeia nosso codigo_item (SCODES)
//      para o código interno usado pelo GSNET/IBL ("Novo Código GSNET").
//   2. "Estoque_GSNET.xlsx" — posição resumida de estoque por item (1 linha
//      por medicamento), usada só para o saldo comparativo.
//   3. "Estoque_IBL.xlsx" — posição detalhada por LOTE (múltiplas linhas por
//      item), é a base das linhas mostradas na tela.
//
// Cada linha do IBL vira uma linha na tela, enriquecida com o codigo_item
// SCODES (via mapeamento), o saldo do GSNET para aquele item, e uma
// comparação (Bate / Diverge / Sem correspondência) entre o total do IBL
// para o item e o saldo do GSNET.
// =====================================================================
const express = require('express');
const XLSX = require('xlsx');
const db = require('./db');
const { autenticar, exigirPerfil } = require('./auth');

const router = express.Router();
router.use(autenticar);

function texto(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

function numero(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Data já vem como objeto Date quando a planilha é lida com { cellDates: true }.
function dataParaBR(v) {
  if (!(v instanceof Date) || Number.isNaN(v.getTime())) return null;
  const d = String(v.getUTCDate()).padStart(2, '0');
  const m = String(v.getUTCMonth() + 1).padStart(2, '0');
  const a = v.getUTCFullYear();
  return `${d}/${m}/${a}`;
}

// ---------- Leitura das 3 planilhas ----------

// "Cadastro Itens GSNET - IBL.xlsx" -> Map<codigoSku(string), codigoScodes>
function parsearMapeamento(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const mapa = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const codigoScodes = texto(r[0]);
    const codigoSku = texto(r[4]);
    if (codigoScodes && codigoSku) mapa.set(String(codigoSku).trim(), codigoScodes);
  }
  return mapa;
}

// "Estoque_GSNET.xlsx" -> Map<codigoSku(string), saldoDisp>
function parsearGsnet(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const mapa = new Map();
  for (const r of rows) {
    if (typeof r[0] !== 'number') continue; // pula cabeçalhos e a linha "Total Geral"
    mapa.set(String(r[0]), numero(r[5])); // coluna "Saldo Disp."
  }
  return mapa;
}

// "Estoque_IBL.xlsx" -> array de linhas (uma por lote)
function parsearIbl(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  const linhas = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[1]) continue; // sem código do item, linha inválida
    linhas.push({
      codigo_sku: String(r[1]).trim(),
      descricao: texto(r[2]),
      lote: texto(r[6]),
      validade: dataParaBR(r[8]),
      embalagem2: texto(r[11]),
      multiplo_distribuicao: numero(r[13]),
      status_estoque: texto(r[17]),
      tipo_bloqueio: texto(r[18]),
      obs_bloqueio: texto(r[19]),
      qtde_disponivel: numero(r[20]),
      qtde_bloqueado: numero(r[21]),
      qtde_reservada: numero(r[22]),
      qtde_total: numero(r[23]),
    });
  }
  return linhas;
}

// ---------- Junta as 3 fontes e grava no banco ----------
function importarEstoqueOD(bufMapeamento, bufGsnet, bufIbl, opcoes = {}) {
  const mapaScodes = parsearMapeamento(bufMapeamento);
  const mapaGsnet = parsearGsnet(bufGsnet);
  const linhasIbl = parsearIbl(bufIbl);

  // Soma o total do IBL por SKU, para comparar com o saldo do GSNET (que é por item, não por lote).
  const totalPorSku = new Map();
  for (const l of linhasIbl) {
    totalPorSku.set(l.codigo_sku, (totalPorSku.get(l.codigo_sku) || 0) + (l.qtde_total || 0));
  }

  const dataReferencia = opcoes.dataReferencia || new Date().toISOString().slice(0, 10);

  const linhasFinais = linhasIbl.map((l) => {
    const saldoGsnet = mapaGsnet.has(l.codigo_sku) ? mapaGsnet.get(l.codigo_sku) : null;
    const totalIbl = totalPorSku.get(l.codigo_sku) || 0;
    let statusComparativo = 'Sem correspondência';
    let diferenca = null;
    if (saldoGsnet !== null) {
      diferenca = Math.round((totalIbl - saldoGsnet) * 100) / 100;
      statusComparativo = diferenca === 0 ? 'Bate' : 'Diverge';
    }
    return {
      ...l,
      codigo_item: mapaScodes.get(l.codigo_sku) || null,
      saldo_gsnet: saldoGsnet,
      status_comparativo: statusComparativo,
      diferenca,
    };
  });

  db.prepare('DELETE FROM estoque_od_itens WHERE data_referencia = ?').run(dataReferencia);
  db.prepare('DELETE FROM estoque_od_importacoes WHERE data_referencia = ?').run(dataReferencia);

  const importacaoId = db.prepare(
    'INSERT INTO estoque_od_importacoes (data_referencia, total_itens) VALUES (?, ?)'
  ).run(dataReferencia, linhasFinais.length).lastInsertRowid;

  const stmt = db.prepare(`
    INSERT INTO estoque_od_itens (
      importacao_id, data_referencia, codigo_item, codigo_sku, descricao, lote, validade,
      embalagem2, multiplo_distribuicao, status_estoque, tipo_bloqueio, obs_bloqueio,
      qtde_disponivel, qtde_bloqueado, qtde_reservada, qtde_total, saldo_gsnet,
      status_comparativo, diferenca
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const v = (x) => (x === undefined ? null : x);
  for (const l of linhasFinais) {
    stmt.run(
      importacaoId, dataReferencia, v(l.codigo_item), v(l.codigo_sku), v(l.descricao), v(l.lote), v(l.validade),
      v(l.embalagem2), v(l.multiplo_distribuicao), v(l.status_estoque), v(l.tipo_bloqueio), v(l.obs_bloqueio),
      v(l.qtde_disponivel), v(l.qtde_bloqueado), v(l.qtde_reservada), v(l.qtde_total), v(l.saldo_gsnet),
      v(l.status_comparativo), v(l.diferenca)
    );
  }

  const totalDivergente = linhasFinais.filter((l) => l.status_comparativo === 'Diverge').length;
  const totalSemCorrespondencia = linhasFinais.filter((l) => l.status_comparativo === 'Sem correspondência').length;

  const resumo = { dataReferencia, totalItens: linhasFinais.length, totalDivergente, totalSemCorrespondencia };

  db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
    .run('estoque_od', opcoes.nomeArquivo || 'estoque outras demandas', opcoes.usuarioEmail || 'sistema', JSON.stringify(resumo));

  return resumo;
}

// ---------- Listagem com filtros e paginação ----------
router.get('/', (req, res) => {
  const { data, q, status_comparativo, status_estoque, page = 1, pageSize = 50 } = req.query;

  let dataRef = data;
  if (!dataRef) {
    const ultima = db.prepare('SELECT data_referencia FROM estoque_od_importacoes ORDER BY data_referencia DESC LIMIT 1').get();
    if (!ultima) return res.json({ dataReferencia: null, itens: [], total: 0, datasDisponiveis: [] });
    dataRef = ultima.data_referencia;
  }

  const condicoes = ['data_referencia = ?'];
  const params = [dataRef];

  if (q) {
    condicoes.push('(descricao LIKE ? OR codigo_item LIKE ? OR codigo_sku LIKE ? OR lote LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (status_comparativo) { condicoes.push('status_comparativo = ?'); params.push(status_comparativo); }
  if (status_estoque) { condicoes.push('status_estoque = ?'); params.push(status_estoque); }

  const where = `WHERE ${condicoes.join(' AND ')}`;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const total = db.prepare(`SELECT COUNT(*) c FROM estoque_od_itens ${where}`).get(...params).c;
  const itens = db.prepare(`
    SELECT * FROM estoque_od_itens ${where}
    ORDER BY descricao COLLATE NOCASE ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const datasDisponiveis = db.prepare('SELECT data_referencia, total_itens FROM estoque_od_importacoes ORDER BY data_referencia DESC').all();

  res.json({ dataReferencia: dataRef, total, itens, page: Number(page), pageSize: limit, datasDisponiveis });
});

// ---------- Consolidado por Código (SKU) — soma as quantidades dos lotes, ----------
// mas NUNCA soma o Saldo Disp. GSNET (é um valor por item, não por lote —
// somar geraria contagem duplicada, uma vez por lote).
router.get('/consolidado', (req, res) => {
  const { data, q, status_comparativo, page = 1, pageSize = 50 } = req.query;

  let dataRef = data;
  if (!dataRef) {
    const ultima = db.prepare('SELECT data_referencia FROM estoque_od_importacoes ORDER BY data_referencia DESC LIMIT 1').get();
    if (!ultima) return res.json({ dataReferencia: null, itens: [], total: 0, datasDisponiveis: [] });
    dataRef = ultima.data_referencia;
  }

  const condicoes = ['data_referencia = ?'];
  const params = [dataRef];
  if (q) {
    condicoes.push('(descricao LIKE ? OR codigo_item LIKE ? OR codigo_sku LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (status_comparativo) { condicoes.push('status_comparativo = ?'); params.push(status_comparativo); }
  const where = `WHERE ${condicoes.join(' AND ')}`;

  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const total = db.prepare(`SELECT COUNT(DISTINCT codigo_sku) c FROM estoque_od_itens ${where}`).get(...params).c;
  const itens = db.prepare(`
    SELECT
      codigo_sku,
      MAX(codigo_item) AS codigo_item,
      MAX(descricao) AS descricao,
      SUM(qtde_disponivel) AS qtde_disponivel,
      SUM(qtde_bloqueado) AS qtde_bloqueado,
      SUM(qtde_reservada) AS qtde_reservada,
      SUM(qtde_total) AS qtde_total,
      MAX(saldo_gsnet) AS saldo_gsnet,
      MAX(status_comparativo) AS status_comparativo,
      MAX(diferenca) AS diferenca,
      COUNT(*) AS total_lotes
    FROM estoque_od_itens
    ${where}
    GROUP BY codigo_sku
    ORDER BY descricao COLLATE NOCASE ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ dataReferencia: dataRef, total, itens, page: Number(page), pageSize: limit });
});

// ---------- Detalhe de um item (todos os lotes) ----------
router.get('/item/:sku', (req, res) => {
  const { sku } = req.params;
  const { data } = req.query;
  let dataRef = data;
  if (!dataRef) {
    const ultima = db.prepare('SELECT data_referencia FROM estoque_od_importacoes ORDER BY data_referencia DESC LIMIT 1').get();
    if (!ultima) return res.json({ codigoSku: sku, lotes: [] });
    dataRef = ultima.data_referencia;
  }
  const lotes = db.prepare(`
    SELECT lote, validade, embalagem2, multiplo_distribuicao, status_estoque, tipo_bloqueio,
           obs_bloqueio, qtde_disponivel, qtde_bloqueado, qtde_reservada, qtde_total
    FROM estoque_od_itens
    WHERE codigo_sku = ? AND data_referencia = ?
    ORDER BY validade
  `).all(sku, dataRef);
  const cabecalho = db.prepare(`
    SELECT codigo_item, descricao, saldo_gsnet, status_comparativo, diferenca
    FROM estoque_od_itens WHERE codigo_sku = ? AND data_referencia = ? LIMIT 1
  `).get(sku, dataRef);
  res.json({ codigoSku: sku, ...cabecalho, lotes });
});

// ---------- Resumo (cards) ----------
router.get('/resumo', (req, res) => {
  const { data } = req.query;
  let dataRef = data;
  if (!dataRef) {
    const ultima = db.prepare('SELECT data_referencia FROM estoque_od_importacoes ORDER BY data_referencia DESC LIMIT 1').get();
    if (!ultima) return res.json({ dataReferencia: null, totalItens: 0, divergente: 0, semCorrespondencia: 0 });
    dataRef = ultima.data_referencia;
  }
  const totalItens = db.prepare('SELECT COUNT(*) c FROM estoque_od_itens WHERE data_referencia = ?').get(dataRef).c;
  const divergente = db.prepare("SELECT COUNT(*) c FROM estoque_od_itens WHERE data_referencia = ? AND status_comparativo = 'Diverge'").get(dataRef).c;
  const semCorrespondencia = db.prepare("SELECT COUNT(*) c FROM estoque_od_itens WHERE data_referencia = ? AND status_comparativo = 'Sem correspondência'").get(dataRef).c;
  res.json({ dataReferencia: dataRef, totalItens, divergente, semCorrespondencia });
});

// ---------- Filtros disponíveis (dropdowns) ----------
router.get('/filtros', (req, res) => {
  const { data } = req.query;
  let dataRef = data;
  if (!dataRef) {
    const ultima = db.prepare('SELECT data_referencia FROM estoque_od_importacoes ORDER BY data_referencia DESC LIMIT 1').get();
    if (!ultima) return res.json({ status_estoque: [], status_comparativo: [] });
    dataRef = ultima.data_referencia;
  }
  const statusEstoque = db.prepare('SELECT DISTINCT status_estoque v FROM estoque_od_itens WHERE data_referencia = ? AND status_estoque IS NOT NULL ORDER BY v').all(dataRef).map((r) => r.v);
  const statusComparativo = db.prepare('SELECT DISTINCT status_comparativo v FROM estoque_od_itens WHERE data_referencia = ? AND status_comparativo IS NOT NULL ORDER BY v').all(dataRef).map((r) => r.v);
  res.json({ status_estoque: statusEstoque, status_comparativo: statusComparativo });
});

// ---------- Importação manual (admin) — relê os 3 arquivos da pasta de rede ----------
router.post('/importar-manual', exigirPerfil('admin'), (req, res) => {
  try {
    const { lerArquivosEstoqueOD } = require('./vigiaEstoqueOD');
    const resultado = lerArquivosEstoqueOD();
    if (!resultado) return res.status(404).json({ erro: 'Um ou mais arquivos não foram encontrados na pasta de rede.' });
    const { bufMapeamento, bufGsnet, bufIbl } = resultado;
    const resumo = importarEstoqueOD(bufMapeamento, bufGsnet, bufIbl, {
      usuarioEmail: req.usuario.email,
    });
    res.json(resumo);
  } catch (e) {
    res.status(500).json({ erro: 'Falha ao importar: ' + e.message });
  }
});

module.exports = router;
module.exports.importarEstoqueOD = importarEstoqueOD;
