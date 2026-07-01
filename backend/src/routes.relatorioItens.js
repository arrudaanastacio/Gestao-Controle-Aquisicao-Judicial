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

function importarRelatorioItensDeBuffer(buffer, opcoes = {}) {
  const linhas = processarRelatorioItens(buffer);
  const dataReferencia = (opcoes.dataReferencia || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const usuarioEmail = opcoes.usuarioEmail || 'sistema';
  const usuarioId = opcoes.usuarioId ?? null;

  db.exec('DELETE FROM relatorio_itens');
  const cols = ['data_referencia', ...CAMPOS];
  const stmt = db.prepare(`INSERT INTO relatorio_itens (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  for (const l of linhas) stmt.run(dataReferencia, ...CAMPOS.map((c) => l[c]));

  const resumo = { dataReferencia, totalItens: linhas.length };
  db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
    .run('relatorio_itens', opcoes.nomeArquivo || 'relatorio_itens', usuarioEmail, JSON.stringify(resumo));
  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
    .run(usuarioId, usuarioEmail, 'importar_relatorio_itens', 'relatorio_itens', JSON.stringify(resumo));
  return resumo;
}

// ---------- Listagem com filtros e paginação ----------
router.get('/', (req, res) => {
  const { q, categoria, tipo_item, grupo, situacao, judicial, importado, outras_demandas, page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const cond = [];
  const params = [];
  if (q) {
    cond.push('(descricao_item LIKE ? OR codigo LIKE ? OR siafisico LIKE ? OR catmat LIKE ? OR marca LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  if (categoria) { cond.push('categoria = ?'); params.push(categoria); }
  if (tipo_item) { cond.push('tipo_item = ?'); params.push(tipo_item); }
  if (grupo) { cond.push('grupo = ?'); params.push(grupo); }
  if (situacao) { cond.push('situacao = ?'); params.push(situacao); }
  if (judicial) { cond.push('judicial = ?'); params.push(judicial); }
  if (importado) { cond.push('importado = ?'); params.push(importado); }
  if (outras_demandas) { cond.push('outras_demandas = ?'); params.push(outras_demandas); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) c FROM relatorio_itens ${where}`).get(...params).c;
  const itens = db.prepare(
    `SELECT * FROM relatorio_itens ${where} ORDER BY descricao_item COLLATE NOCASE LIMIT ? OFFSET ?`
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

module.exports = router;
module.exports.importarRelatorioItensDeBuffer = importarRelatorioItensDeBuffer;
