const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('./db');
const { autenticar } = require('./auth');

const router = express.Router();
router.use(autenticar);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// Normaliza cabeçalho: minúsculas, sem acento, sem underscore, espaços colapsados
function normalizarCabecalho(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/_/g, ' ')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// Só os campos que interessam para o cruzamento com o Estoque (por Siafísico)
const MAPA_CABECALHOS = {
  ata: ['ata'],
  oc: ['oc'],
  item: ['item'],
  siafisico: ['siafisico'],
  descricao: ['descricao'],
  unidade_fornecimento: ['unidade fornecimento'],
  nome_comercial: ['nome comercial'],
  apresentacao: ['apresentacao'],
  detentor_registro: ['detentor registro'],
  ultimo_valor_publicado: ['ultimo valor publicado'],
  data_publicacao: ['data publicacao'],
  vencimento: ['vencimento'],
  embalagem_primaria: ['embalagem primaria'],
  embalagem_secundaria: ['embalagem secundaria'],
};
const CAMPOS = Object.keys(MAPA_CABECALHOS);

function texto(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

// "19446,00" / "0,0680" -> número (vírgula é decimal; ponto é milhar)
function numero(v) {
  const t = texto(v);
  if (t === null) return null;
  let s = t;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/\./g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// "4/10/25" ou "16/10/2025" -> "2025-10-16" (ano de 2 dígitos vira 20xx,
// já que são sempre datas de licitação recentes)
// Fallback para datas que cheguem como texto puro (sem célula-data por trás,
// ex.: se um dia o relatório vier em CSV). Assume DD/MM/AAAA.
function dataBRparaISO(v) {
  const t = texto(v);
  if (!t) return null;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const [, d, mo, anoStr] = m;
  const ano = anoStr.length === 2 ? `20${anoStr}` : anoStr;
  return `${ano}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// Converte o número serial de data do Excel (dias desde 1899-12-30) para
// "AAAA-MM-DD", usando só a parte inteira (o horário do dia é irrelevante
// aqui e formatos texto tipo "4/10/25" são ambíguos entre DD/MM e MM/DD).
function serialExcelParaISO(serial) {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return null;
  const dias = Math.floor(serial);
  const d = new Date(Date.UTC(1899, 11, 30) + dias * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Lê uma célula de data diretamente da planilha (evita o texto formatado
// ambíguo). Se a célula for numérica (data real do Excel), converte pelo
// serial; senão cai no parser de texto DD/MM/AAAA como último recurso.
function celulaData(sheet, linha, coluna) {
  if (coluna < 0) return null;
  const cel = sheet[XLSX.utils.encode_cell({ r: linha, c: coluna })];
  if (!cel) return null;
  if (cel.t === 'n' && typeof cel.v === 'number') return serialExcelParaISO(cel.v);
  return dataBRparaISO(cel.w ?? cel.v);
}

// Lê o relatório "relatorioAll" (Atas de Registro de Preço) e devolve as linhas mapeadas
function processarAtas(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const brutas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });

  let hc = -1;
  for (let i = 0; i < Math.min(brutas.length, 15); i++) {
    const ln = (brutas[i] || []).map(normalizarCabecalho);
    if (ln.includes('ata') && ln.includes('siafisico')) { hc = i; break; }
  }
  if (hc === -1) throw new Error('Não reconheci o layout do relatório de Atas (não achei as colunas "Ata" e "Siafísico").');

  const cab = (brutas[hc] || []).map(normalizarCabecalho);
  const COL = {};
  for (const [campo, nomes] of Object.entries(MAPA_CABECALHOS)) COL[campo] = cab.findIndex((c) => nomes.includes(c));
  if (COL.ata === -1) throw new Error('Não encontrei a coluna "Ata".');

  const linhas = [];
  for (let i = hc + 1; i < brutas.length; i++) {
    const r = brutas[i];
    if (!r) continue;
    const ata = texto(COL.ata >= 0 ? r[COL.ata] : null);
    if (!ata) continue;
    linhas.push({
      ata,
      oc: COL.oc >= 0 ? texto(r[COL.oc]) : null,
      item: COL.item >= 0 ? texto(r[COL.item]) : null,
      siafisico: COL.siafisico >= 0 ? texto(r[COL.siafisico]) : null,
      descricao: COL.descricao >= 0 ? texto(r[COL.descricao]) : null,
      unidade_fornecimento: COL.unidade_fornecimento >= 0 ? texto(r[COL.unidade_fornecimento]) : null,
      nome_comercial: COL.nome_comercial >= 0 ? texto(r[COL.nome_comercial]) : null,
      apresentacao: COL.apresentacao >= 0 ? texto(r[COL.apresentacao]) : null,
      detentor_registro: COL.detentor_registro >= 0 ? texto(r[COL.detentor_registro]) : null,
      ultimo_valor_publicado: COL.ultimo_valor_publicado >= 0 ? numero(r[COL.ultimo_valor_publicado]) : null,
      data_publicacao: celulaData(sheet, i, COL.data_publicacao),
      vencimento: celulaData(sheet, i, COL.vencimento),
      embalagem_primaria: COL.embalagem_primaria >= 0 ? texto(r[COL.embalagem_primaria]) : null,
      embalagem_secundaria: COL.embalagem_secundaria >= 0 ? texto(r[COL.embalagem_secundaria]) : null,
    });
  }
  return linhas;
}

// Importa (substitui a versão da mesma data) a partir de um buffer.
// Usada tanto pelo vigia de arquivo automático quanto por uma futura rota manual.
function importarAtasDeBuffer(buffer, opcoes = {}) {
  const linhas = processarAtas(buffer);
  const dataReferencia = (opcoes.dataReferencia || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const usuarioEmail = opcoes.usuarioEmail || 'sistema';
  const usuarioId = opcoes.usuarioId ?? null;

  db.prepare('DELETE FROM atas_itens WHERE data_referencia = ?').run(dataReferencia);

  const cols = ['data_referencia', ...CAMPOS];
  const stmt = db.prepare(`INSERT INTO atas_itens (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  for (const l of linhas) stmt.run(dataReferencia, ...CAMPOS.map((c) => l[c]));

  // Mantém só as 2 versões mais recentes (atual + anterior)
  const datas = db.prepare('SELECT DISTINCT data_referencia FROM atas_itens WHERE data_referencia IS NOT NULL ORDER BY data_referencia DESC').all().map((r) => r.data_referencia);
  if (datas.length > 2) {
    const manter = datas.slice(0, 2);
    db.prepare(`DELETE FROM atas_itens WHERE data_referencia NOT IN (${manter.map(() => '?').join(',')})`).run(...manter);
  }

  const totalAtas = db.prepare('SELECT COUNT(DISTINCT ata) c FROM atas_itens WHERE data_referencia = ?').get(dataReferencia).c;
  const resumo = { dataReferencia, totalLinhas: linhas.length, totalAtas };

  db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
    .run('atas', opcoes.nomeArquivo || 'atas', usuarioEmail, JSON.stringify(resumo));
  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
    .run(usuarioId, usuarioEmail, 'importar_atas', 'atas_itens', JSON.stringify(resumo));

  return resumo;
}

// Em qual faixa de vencimento cai um nº de dias restantes (mesma lógica da tela de Validades)
function faixaVencimento(dias) {
  if (dias < 0) return 'vencido';
  if (dias <= 30) return 'd30';
  if (dias <= 60) return 'd60';
  if (dias <= 90) return 'd90';
  return 'mais90';
}

// ---------- Listagem com filtros e paginação (sempre a versão mais recente) ----------
router.get('/', (req, res) => {
  const { q, janela, page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const dataRef = db.prepare('SELECT MAX(data_referencia) v FROM atas_itens').get()?.v || null;
  if (!dataRef) return res.json({ dataReferencia: null, itens: [], total: 0, resumo: null });

  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const hojeISO = hoje.toISOString().slice(0, 10);

  // Só interessam as Atas vigentes: exclui as já vencidas (vencimento no passado).
  // Sem vencimento preenchido continua aparecendo (não dá pra saber se venceu).
  const cond = ['data_referencia = ?', '(vencimento IS NULL OR vencimento >= ?)'];
  const params = [dataRef, hojeISO];
  if (q) {
    cond.push('(descricao LIKE ? OR nome_comercial LIKE ? OR siafisico LIKE ? OR ata LIKE ? OR detentor_registro LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  const where = `WHERE ${cond.join(' AND ')}`;

  // Resumo por faixa de vencimento, calculado sobre o conjunto já filtrado por texto
  const todos = db.prepare(`SELECT vencimento FROM atas_itens ${where}`).all(...params);
  const MS_DIA = 1000 * 60 * 60 * 24;
  const resumo = { total: todos.length, d30: 0, d60: 0, d90: 0, mais90: 0, semData: 0 };
  for (const l of todos) {
    if (!l.vencimento) { resumo.semData++; continue; }
    const dias = Math.floor((new Date(l.vencimento) - hoje) / MS_DIA);
    resumo[faixaVencimento(dias)]++;
  }

  if (janela && ['d30', 'd60', 'd90', 'mais90'].includes(janela)) {
    cond.push(`vencimento IS NOT NULL AND julianday(vencimento) - julianday(?) ${
      janela === 'd30' ? 'BETWEEN 0 AND 30' : janela === 'd60' ? 'BETWEEN 31 AND 60' : janela === 'd90' ? 'BETWEEN 61 AND 90' : '> 90'
    }`);
    params.push(hojeISO);
  }
  const whereFinal = `WHERE ${cond.join(' AND ')}`;

  const total = db.prepare(`SELECT COUNT(*) c FROM atas_itens ${whereFinal}`).get(...params).c;
  const itens = db.prepare(
    `SELECT * FROM atas_itens ${whereFinal} ORDER BY vencimento IS NULL, vencimento ASC, descricao COLLATE NOCASE LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  res.json({ dataReferencia: dataRef, total, itens, resumo, page: Number(page), pageSize: limit });
});

module.exports = router;
module.exports.importarAtasDeBuffer = importarAtasDeBuffer;
