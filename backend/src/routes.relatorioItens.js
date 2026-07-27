const express = require('express');
const XLSX = require('xlsx');
const multer = require('multer');
const db = require('./db');
const { autenticar, exigirPerfil } = require('./auth');

const router = express.Router();
router.use(autenticar);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

function normalizar(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[._]/g, ' ')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// campo do banco -> nome(s) de cabeçalho aceitos (normalizados)
const MAPA = {
  pro_id: ['pro id'],
  situacao: ['situacao'],
  usuario: ['usuario'],
  categoria: ['categoria'],
  codigo: ['codigo'],
  siafisico: ['siafisico'],
  catmat: ['catmat'],
  descricao_item: ['descricao do item'],
  valor_medio_unitario: ['valor medio unitario'],
  item: ['item'],
  especificacao: ['especificacao'],
  apresentacao: ['apresentacao'],
  marca: ['marca'],
  importado: ['importado'],
  tipo_item: ['tipo item'],
  grupo: ['grupo'],
  programa: ['programa'],
  grupo_af: ['grupo af'],
  intercambiavel: ['intercambiavel'],
  observacoes: ['observacoes'],
  outras_demandas: ['outras demandas'],
  oncologico: ['oncologico'],
  termolabil: ['termolabil'],
  antimicrobiano: ['antimicrobiano'],
  portaria34498: ['portaria34498'],
  grande_volume: ['grandevolume', 'grande volume'],
  comissao_farmacologia: ['comissao de farmacologia'],
  judicial: ['judicial'],
  jefaz: ['jefaz'],
};
const CAMPOS = Object.keys(MAPA);

function texto(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

function processarRelatorioItens(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const brutas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });

  let hc = -1;
  for (let i = 0; i < Math.min(brutas.length, 15); i++) {
    const ln = (brutas[i] || []).map(normalizar);
    if (ln.includes('codigo') && ln.includes('descricao do item')) { hc = i; break; }
  }
  if (hc === -1) throw new Error('Não reconheci o layout do Relatório de Itens (não achei "Código" e "Descrição do Item").');

  const cab = (brutas[hc] || []).map(normalizar);
  const COL = {};
  for (const [campo, nomes] of Object.entries(MAPA)) COL[campo] = cab.findIndex((c) => nomes.includes(c));
  if (COL.codigo === -1) throw new Error('Não encontrei a coluna "Código".');

  const linhas = [];
  for (let i = hc + 1; i < brutas.length; i++) {
    const r = brutas[i];
    if (!r) continue;
    const codigo = texto(r[COL.codigo]);
    if (!codigo) continue;
    const linha = {};
    for (const campo of CAMPOS) linha[campo] = COL[campo] >= 0 ? texto(r[COL[campo]]) : null;
    linhas.push(linha);
  }
  return linhas;
}

// Importa (substitui todo o catálogo) a partir de linhas já mapeadas
// (objetos com as chaves de CAMPOS). Usado tanto pelo CSV quanto pelo
// atualizador via Oracle. Tudo numa única transação: gravar milhares de
// linhas uma a uma sem transação prende o banco por muito tempo e colide
// com outras escritas ("database is locked" — mesma causa já corrigida
// na sincronização de Autores).
function importarRelatorioItensDeLinhas(linhas, opcoes = {}) {
  const dataReferencia = (opcoes.dataReferencia || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const usuarioEmail = opcoes.usuarioEmail || 'sistema';
  const usuarioId = opcoes.usuarioId ?? null;

  let resumo;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM relatorio_itens');
    const cols = ['data_referencia', ...CAMPOS];
    const stmt = db.prepare(`INSERT INTO relatorio_itens (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    for (const l of linhas) stmt.run(dataReferencia, ...CAMPOS.map((c) => (l[c] === undefined ? null : l[c])));

    resumo = { dataReferencia, totalItens: linhas.length };
    db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
      .run('relatorio_itens', opcoes.nomeArquivo || 'relatorio_itens', usuarioEmail, JSON.stringify(resumo));
    db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
      .run(usuarioId, usuarioEmail, 'importar_relatorio_itens', 'relatorio_itens', JSON.stringify(resumo));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return resumo;
}

function importarRelatorioItensDeBuffer(buffer, opcoes = {}) {
  const linhas = processarRelatorioItens(buffer);
  return importarRelatorioItensDeLinhas(linhas, opcoes);
}

// =====================================================================
// CLASSIFICAÇÃO PERMANENTE (Dose Certa / Doença Rara / Unidade de
// Fornecimento / Embalagem de Conversão) — tabela item_classificacao.
// NÃO é apagada pela reimportação diária do relatório. Origem: aba
// "Status-Siafisico" (importação) ou edição manual pela tela.
// =====================================================================

// Converte texto BR/planilha em número (tolera "1.234,56", "-", vazio).
function numero(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let t = String(v).trim();
  if (t === '' || t === '-') return null;
  if (t.includes(',') && t.includes('.')) t = t.replace(/\./g, '').replace(',', '.');
  else if (t.includes(',')) t = t.replace(',', '.');
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

// Normaliza "Sim"/"Não"/"-"/vazio -> 'Sim' | 'Não' | null.
function simNao(v) {
  const t = String(v ?? '').trim();
  if (t === '' || t === '-') return null;
  if (/^s/i.test(t)) return 'Sim';
  if (/^n/i.test(t)) return 'Não';
  return null;
}

// Faz o upsert de UM item na classificação. `direto=false` (importação)
// preserva o valor antigo quando o novo vem nulo (COALESCE); `direto=true`
// (edição manual) grava exatamente o que veio, permitindo limpar um campo.
function upsertClassificacao(reg, usuarioEmail, direto = false) {
  const set = direto
    ? `dose_certa = excluded.dose_certa,
       doenca_rara = excluded.doenca_rara,
       unidade_fornecimento = excluded.unidade_fornecimento,
       embalagem_conversao = excluded.embalagem_conversao`
    : `dose_certa = COALESCE(excluded.dose_certa, item_classificacao.dose_certa),
       doenca_rara = COALESCE(excluded.doenca_rara, item_classificacao.doenca_rara),
       unidade_fornecimento = COALESCE(excluded.unidade_fornecimento, item_classificacao.unidade_fornecimento),
       embalagem_conversao = COALESCE(excluded.embalagem_conversao, item_classificacao.embalagem_conversao)`;
  db.prepare(`
    INSERT INTO item_classificacao
      (codigo_item, dose_certa, doenca_rara, unidade_fornecimento, embalagem_conversao, atualizado_em, usuario_email)
    VALUES (?, ?, ?, ?, ?, datetime('now','localtime'), ?)
    ON CONFLICT(codigo_item) DO UPDATE SET
      ${set},
      atualizado_em = datetime('now','localtime'),
      usuario_email = excluded.usuario_email
  `).run(reg.codigo_item, reg.dose_certa, reg.doenca_rara, reg.unidade_fornecimento, reg.embalagem_conversao, usuarioEmail);
}

// Lê a aba "Status-Siafisico" e devolve as linhas de classificação.
function processarStatusSiafisico(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false });
  const nomeAba = wb.SheetNames.find((n) => /status/i.test(n) && /siafisico/i.test(n))
    || wb.SheetNames.find((n) => /siafisico/i.test(n));
  if (!nomeAba) throw new Error('Não encontrei a aba "Status-Siafisico" na planilha.');
  const brutas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, defval: null, raw: false });

  let hc = -1;
  for (let i = 0; i < Math.min(brutas.length, 12); i++) {
    const ln = (brutas[i] || []).map(normalizar);
    if (ln.includes('codigo') && ln.some((c) => c.includes('embalagem de conversao'))) { hc = i; break; }
  }
  if (hc === -1) throw new Error('Não reconheci o layout da aba Status-Siafisico (não achei "Código" e "Embalagem de Conversão").');

  const cab = (brutas[hc] || []).map(normalizar);
  const acha = (nomes) => cab.findIndex((c) => nomes.some((n) => c === n || c.includes(n)));
  const COL = {
    codigo: acha(['codigo']),
    dose_certa: acha(['programa']),
    doenca_rara: acha(['doencas raras', 'doenca rara']),
    unidade_fornecimento: acha(['unidade de fornecimento']),
    embalagem_conversao: acha(['embalagem de conversao']),
  };
  if (COL.codigo === -1) throw new Error('Não encontrei a coluna "Código" na aba Status-Siafisico.');

  const linhas = [];
  for (let i = hc + 1; i < brutas.length; i++) {
    const r = brutas[i]; if (!r) continue;
    const codigo = texto(r[COL.codigo]);
    if (!codigo) continue;
    linhas.push({
      codigo_item: codigo,
      dose_certa: COL.dose_certa >= 0 ? simNao(r[COL.dose_certa]) : null,
      doenca_rara: COL.doenca_rara >= 0 ? simNao(r[COL.doenca_rara]) : null,
      unidade_fornecimento: COL.unidade_fornecimento >= 0 ? texto(r[COL.unidade_fornecimento]) : null,
      embalagem_conversao: COL.embalagem_conversao >= 0 ? numero(r[COL.embalagem_conversao]) : null,
    });
  }
  return linhas;
}

// Importa a classificação da aba Status-Siafisico (upsert, preserva o antigo
// quando o novo vem em branco). Transação única para não prender o banco.
function importarStatusSiafisicoDeBuffer(buffer, opcoes = {}) {
  const linhas = processarStatusSiafisico(buffer);
  const usuarioEmail = opcoes.usuarioEmail || 'sistema';
  let novos = 0;
  db.exec('BEGIN');
  try {
    const existe = db.prepare('SELECT 1 FROM item_classificacao WHERE codigo_item = ?');
    for (const l of linhas) {
      if (!existe.get(l.codigo_item)) novos++;
      upsertClassificacao(l, usuarioEmail, false);
    }
    const resumo = { total: linhas.length, novos, atualizados: linhas.length - novos };
    db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
      .run('item_classificacao', opcoes.nomeArquivo || 'status_siafisico', usuarioEmail, JSON.stringify(resumo));
    db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
      .run(opcoes.usuarioId ?? null, usuarioEmail, 'importar_classificacao', 'item_classificacao', JSON.stringify(resumo));
    db.exec('COMMIT');
    return resumo;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- Listagem com filtros e paginação ----------
router.get('/', (req, res) => {
  const { q, categoria, tipo_item, grupo, situacao, judicial, importado, outras_demandas,
    dose_certa, doenca_rara, classificacao, page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  // JOIN com a classificação permanente (item_classificacao) por código.
  const FROM = `FROM relatorio_itens ri
    LEFT JOIN item_classificacao c ON c.codigo_item = ri.codigo`;

  const cond = [];
  const params = [];
  if (q) {
    cond.push('(ri.descricao_item LIKE ? OR ri.codigo LIKE ? OR ri.siafisico LIKE ? OR ri.catmat LIKE ? OR ri.marca LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  if (categoria) { cond.push('ri.categoria = ?'); params.push(categoria); }
  if (tipo_item) { cond.push('ri.tipo_item = ?'); params.push(tipo_item); }
  if (grupo) { cond.push('ri.grupo = ?'); params.push(grupo); }
  if (situacao) { cond.push('ri.situacao = ?'); params.push(situacao); }
  if (judicial) { cond.push('ri.judicial = ?'); params.push(judicial); }
  if (importado) { cond.push('ri.importado = ?'); params.push(importado); }
  if (outras_demandas) { cond.push('ri.outras_demandas = ?'); params.push(outras_demandas); }
  if (dose_certa) { cond.push('c.dose_certa = ?'); params.push(dose_certa); }
  if (doenca_rara) { cond.push('c.doenca_rara = ?'); params.push(doenca_rara); }
  // Classificação: 'pendentes' = item que EXISTE no Estoque TP mais recente
  // (com demanda > 0 — o universo real de planejamento) e ainda não tem a
  // Embalagem de Conversão preenchida. Assim o filtro mostra só os itens de
  // TP que faltam classificar, não o catálogo inteiro. Cruzamento pelo código
  // SCODES (relatorio_itens.codigo = estoque_itens.codigo_item).
  // 'ok' = já classificado (embalagem preenchida).
  if (classificacao === 'pendentes') {
    cond.push(`(c.codigo_item IS NULL OR c.embalagem_conversao IS NULL)
      AND ri.codigo IN (
        SELECT e.codigo_item FROM estoque_itens e
        WHERE e.data_referencia = (SELECT MAX(data_referencia) FROM estoque_itens)
          AND e.demandas > 0)`);
  } else if (classificacao === 'ok') cond.push('c.embalagem_conversao IS NOT NULL');
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) cc ${FROM} ${where}`).get(...params).cc;
  const itens = db.prepare(
    `SELECT ri.*,
       c.dose_certa AS clas_dose_certa,
       c.doenca_rara AS clas_doenca_rara,
       c.unidade_fornecimento AS clas_unidade_fornecimento,
       c.embalagem_conversao AS clas_embalagem_conversao
     ${FROM} ${where}
     ORDER BY ri.descricao_item COLLATE NOCASE LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  const dataRef = db.prepare('SELECT data_referencia FROM relatorio_itens LIMIT 1').get()?.data_referencia || null;

  res.json({ total, dataReferencia: dataRef, itens, page: Number(page), pageSize: limit });
});

// ---------- Valores distintos para os filtros ----------
router.get('/filtros', (req, res) => {
  const distintos = (col) => db.prepare(
    `SELECT DISTINCT ${col} v FROM relatorio_itens WHERE ${col} IS NOT NULL AND ${col} <> '' ORDER BY v`
  ).all().map((r) => r.v);
  res.json({
    categoria: distintos('categoria'),
    tipo_item: distintos('tipo_item'),
    importado: distintos('importado'),
    outras_demandas: distintos('outras_demandas'),
  });
});

// ---------- Importação manual ----------
router.post('/importar/confirmar', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie o arquivo .csv do Relatório de Itens.' });
  try {
    const resumo = importarRelatorioItensDeBuffer(req.file.buffer, {
      nomeArquivo: req.file.originalname,
      usuarioEmail: req.usuario.email,
      usuarioId: req.usuario.id,
    });
    res.json(resumo);
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

// ---------- Atualização via Oracle (SCODES) ----------
const estadoOracle = { rodando: false, inicio: null, ultimoResumo: null, ultimoErro: null };

function executarAtualizacaoRelatorioItensOracle(opcoes = {}) {
  if (estadoOracle.rodando) return Promise.resolve({ pulou: true, motivo: 'já em andamento' });
  const { atualizarRelatorioItensViaOracle } = require('../oracle/sync-relatorio-itens');
  estadoOracle.rodando = true;
  estadoOracle.inicio = new Date().toISOString();
  estadoOracle.ultimoErro = null;

  return atualizarRelatorioItensViaOracle(opcoes)
    .then((resumo) => {
      estadoOracle.ultimoResumo = { ...resumo, fim: new Date().toISOString() };
      console.log(`[SYNC RELATÓRIO ITENS] Concluido via Oracle: ${resumo.totalItens} itens em ${Math.round((resumo.duracaoMs || 0) / 1000)}s.`);
      return resumo;
    })
    .catch((e) => {
      estadoOracle.ultimoErro = e.message;
      console.error('[SYNC RELATÓRIO ITENS] Falha via Oracle:', e.message);
      require('./emailAlerta').enviarAlertaFalhaSincronizacao('Relatório de Itens', e.message);
      throw e;
    })
    .finally(() => { estadoOracle.rodando = false; });
}

function iniciarAtualizacaoOracle(opcoes = {}) {
  if (estadoOracle.rodando) return { iniciado: false, jaRodando: true };
  executarAtualizacaoRelatorioItensOracle(opcoes).catch(() => {});
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

// ---------- Classificação: importar aba Status-Siafisico ----------
router.post('/classificacao/importar', exigirPerfil('admin'), upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie a planilha com a aba "Status-Siafisico".' });
  try {
    const resumo = importarStatusSiafisicoDeBuffer(req.file.buffer, {
      nomeArquivo: req.file.originalname,
      usuarioEmail: req.usuario.email,
      usuarioId: req.usuario.id,
    });
    res.json(resumo);
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

// ---------- Classificação: consultar um item ----------
router.get('/classificacao/:codigo', (req, res) => {
  const c = db.prepare('SELECT * FROM item_classificacao WHERE codigo_item = ?').get(req.params.codigo);
  res.json(c || { codigo_item: req.params.codigo, dose_certa: null, doenca_rara: null, unidade_fornecimento: null, embalagem_conversao: null });
});

// ---------- Classificação: editar/gravar um item manualmente ----------
router.put('/classificacao/:codigo', exigirPerfil('admin'), (req, res) => {
  const codigo = String(req.params.codigo || '').trim();
  if (!codigo) return res.status(400).json({ erro: 'Código do item ausente.' });
  const b = req.body || {};
  const reg = {
    codigo_item: codigo,
    dose_certa: simNao(b.dose_certa),
    doenca_rara: simNao(b.doenca_rara),
    unidade_fornecimento: texto(b.unidade_fornecimento),
    embalagem_conversao: numero(b.embalagem_conversao),
  };
  try {
    upsertClassificacao(reg, req.usuario.email, true);
    db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
      .run(req.usuario.id ?? null, req.usuario.email, 'editar_classificacao', 'item_classificacao', JSON.stringify(reg));
    res.json({ ok: true, classificacao: db.prepare('SELECT * FROM item_classificacao WHERE codigo_item = ?').get(codigo) });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

module.exports = router;
module.exports.importarRelatorioItensDeBuffer = importarRelatorioItensDeBuffer;
module.exports.importarStatusSiafisicoDeBuffer = importarStatusSiafisicoDeBuffer;
module.exports.importarRelatorioItensDeLinhas = importarRelatorioItensDeLinhas;
module.exports.executarAtualizacaoRelatorioItensOracle = executarAtualizacaoRelatorioItensOracle;
