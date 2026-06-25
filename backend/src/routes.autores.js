const express = require('express');
const XLSX = require('xlsx');
const multer = require('multer');
const db = require('./db');
const { autenticar, exigirPerfil } = require('./auth');

const router = express.Router();
router.use(autenticar);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

// Normaliza cabeçalho: minúsculas, sem acento, sem pontuação/underscore, espaços colapsados
function normalizar(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[._]/g, ' ')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// campo do banco -> nome(s) de cabeçalho aceitos (normalizados)
const MAPA = {
  unidade_dispensadora: ['unid dispensadora', 'unidade dispensadora'],
  unidade_organizacional: ['unid organizacional', 'unidade organizacional'],
  id_demanda: ['id demanda'],
  autor: ['autor'],
  idade: ['idade'],
  dt_nascimento: ['dt nascimento'],
  data_cadastro: ['data de cadastro'],
  protocolo: ['protocolo'],
  processo: ['processo'],
  status_demanda: ['status da demanda'],
  tipo_demanda: ['tipo da demanda'],
  porta_entrada: ['porta de entrada'],
  codigo_item: ['cod item', 'codigo item'],
  id_item: ['id item'],
  data_inclusao_od: ['data inclusao na od'],
  descricao_item: ['descricao do item'],
  qtde_consumo: ['qtdade de consumo', 'quantidade de consumo'],
  status_item: ['status item'],
  data_inativacao_item: ['data da inativacao item'],
  cobranca_judicial: ['cobranca judicial'],
  servicos_medicos: ['servicos medicos'],
  saude_mental: ['saude mental'],
  dispensacoes: ['dispensacoes'],
  periodicidade: ['periodicidade'],
  prazo: ['prazo'],
  dispensacoes_autorizadas: ['dispensacoes autorizadas'],
  intercambiaveis: ['intercambiaveis'],
  outras_demandas: ['outras demandas'],
  importados: ['importados'],
  categoria: ['categoria'],
  data_ultima_dispensacao: ['data ultima dispensacao'],
  data_ultimo_retorno: ['data ultimo retorno'],
  procurador_estado: ['procurador do estado'],
  cod_siafisico: ['cod siafisico', 'codigo siafisico'],
};
const CAMPOS = Object.keys(MAPA);

function texto(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

// Lê o CSV/planilha de autores e devolve as linhas mapeadas
function processarAutores(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const brutas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

  // acha a linha de cabeçalho (contém "autor" e "processo")
  let hc = -1;
  for (let i = 0; i < Math.min(brutas.length, 15); i++) {
    const ln = (brutas[i] || []).map(normalizar);
    if (ln.includes('autor') && ln.includes('processo')) { hc = i; break; }
  }
  if (hc === -1) throw new Error('Não reconheci o layout da Listagem de Autores (não achei as colunas "Autor" e "Processo").');

  const cab = (brutas[hc] || []).map(normalizar);
  const COL = {};
  for (const [campo, nomes] of Object.entries(MAPA)) COL[campo] = cab.findIndex((c) => nomes.includes(c));
  if (COL.autor === -1) throw new Error('Não encontrei a coluna "Autor".');

  const linhas = [];
  for (let i = hc + 1; i < brutas.length; i++) {
    const r = brutas[i];
    if (!r) continue;
    const autor = texto(r[COL.autor]);
    if (!autor) continue;
    const linha = {};
    for (const campo of CAMPOS) linha[campo] = COL[campo] >= 0 ? texto(r[COL[campo]]) : null;
    linhas.push(linha);
  }
  return linhas;
}

// Importa (substitui toda a listagem) a partir de um buffer
function importarAutoresDeBuffer(buffer, opcoes = {}) {
  const linhas = processarAutores(buffer);
  const dataReferencia = (opcoes.dataReferencia || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const usuarioEmail = opcoes.usuarioEmail || 'sistema';
  const usuarioId = opcoes.usuarioId ?? null;

  db.exec('DELETE FROM autores_itens');

  const cols = ['data_referencia', ...CAMPOS];
  const stmt = db.prepare(
    `INSERT INTO autores_itens (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  );
  for (const l of linhas) {
    stmt.run(dataReferencia, ...CAMPOS.map((c) => l[c]));
  }

  // contagens úteis
  const totalAutores = db.prepare('SELECT COUNT(DISTINCT autor) c FROM autores_itens').get().c;
  const resumo = { dataReferencia, totalLinhas: linhas.length, totalAutores };

  db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
    .run('autores', opcoes.nomeArquivo || 'autores', usuarioEmail, JSON.stringify(resumo));
  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
    .run(usuarioId, usuarioEmail, 'importar_autores', 'autores_itens', JSON.stringify(resumo));

  return resumo;
}

// ---------- Listagem com filtros e paginação ----------
router.get('/', (req, res) => {
  const { q, unidade, status_demanda, status_item, categoria, page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const cond = [];
  const params = [];
  if (q) {
    cond.push('(autor LIKE ? OR processo LIKE ? OR protocolo LIKE ? OR descricao_item LIKE ? OR codigo_item LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  if (unidade) { cond.push('unidade_dispensadora = ?'); params.push(unidade); }
  if (status_demanda) { cond.push('status_demanda = ?'); params.push(status_demanda); }
  if (status_item) { cond.push('status_item = ?'); params.push(status_item); }
  if (categoria) { cond.push('categoria = ?'); params.push(categoria); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) c FROM autores_itens ${where}`).get(...params).c;
  const itens = db.prepare(
    `SELECT * FROM autores_itens ${where} ORDER BY autor COLLATE NOCASE, descricao_item LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  const dataRef = db.prepare('SELECT data_referencia FROM autores_itens LIMIT 1').get()?.data_referencia || null;
  const totalAutores = db.prepare('SELECT COUNT(DISTINCT autor) c FROM autores_itens').get().c;

  res.json({ total, totalAutores, dataReferencia: dataRef, itens, page: Number(page), pageSize: limit });
});

// ---------- Valores distintos para os filtros ----------
router.get('/filtros', (req, res) => {
  const distintos = (col) => db.prepare(
    `SELECT DISTINCT ${col} v FROM autores_itens WHERE ${col} IS NOT NULL AND ${col} <> '' ORDER BY v`
  ).all().map((r) => r.v);
  res.json({
    unidade: distintos('unidade_dispensadora'),
    status_demanda: distintos('status_demanda'),
    status_item: distintos('status_item'),
    categoria: distintos('categoria'),
  });
});

// ---------- Importação manual ----------
router.post('/importar/confirmar', exigirPerfil('admin'), upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie o arquivo .csv da Listagem de Autores.' });
  try {
    const resumo = importarAutoresDeBuffer(req.file.buffer, {
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
module.exports.importarAutoresDeBuffer = importarAutoresDeBuffer;
