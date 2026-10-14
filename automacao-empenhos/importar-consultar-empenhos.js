// importar-consultar-empenhos.js — Le o .xlsx mais recente do "Consultar Empenho"
// (baixado pelo baixar-consultar-empenhos.js) e grava na tabela `empenhos_consulta`,
// SUBSTITUINDO toda a foto (DELETE + insert). 1 linha por Nº Empenho (NE).
//
// Uso:  node importar-consultar-empenhos.js [caminho.xlsx]
// Sem argumento, pega o .xlsx mais novo da PASTA_DOWNLOAD_CE do .env.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createRequire } = require('node:module');

const BACKEND_DIR = process.env.BACKEND_DIR || path.join(__dirname, '..', 'backend');
const requireBackend = createRequire(path.join(BACKEND_DIR, 'package.json'));
const XLSX = requireBackend('xlsx');

const BANCO = process.env.BANCO || path.join(BACKEND_DIR, 'data', 'medicamentos_judicial.db');
const PASTA_DOWNLOAD = process.env.PASTA_DOWNLOAD_CE || path.join(__dirname, 'downloads-consultar-empenhos');

// DB (snake_case) <- nome da coluna no relatorio (normalizado: \n -> espaco).
const MAPA = {
  numero_empenho: 'Nº EMPENHO',
  prioridade: 'PRIORIDADE',
  numero_processo: 'Nº PROCESSO',
  valor_total: 'VALOR TOTAL',
  data_emissao: 'DATA EMISSÃO EMPENHO',
  data_publicacao: 'DATA PUBLICAÇÃO EMPENHO',
  data_retorno: 'DATA RETORNO EMPENHO',
  data_envio_fornecedor: 'DATA ENVIO FORNECEDOR',
  data_ateste_recebimento: 'DATA ATESTE RECEBIMENTO',
  data_limite_entrega: 'DATA LIMITE DE ENTREGA',
  data_entrega_final: 'DATA ENTREGA FINAL',
  fornecedor_cnpj: 'FORNECEDOR CNPJ',
  fornecedor: 'FORNECEDOR',
  gerado_por: 'GERADO POR',
  data_gerado: 'DATA',
};
const CAMPOS = Object.keys(MAPA);
const NUMERICOS = new Set(['valor_total']);
const DATAS = new Set(['data_emissao', 'data_publicacao', 'data_retorno', 'data_envio_fornecedor', 'data_ateste_recebimento', 'data_limite_entrega', 'data_entrega_final', 'data_gerado']);

function normCab(s) { return String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase(); }
function normalizar(s) { return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function texto(v) { if (v === undefined || v === null) return null; const t = String(v).trim(); return t === '' ? null : t; }
function numero(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim(); if (s === '') return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); // 9.447,8000 -> 9447.8
  const n = Number(s); return Number.isFinite(n) ? n : null;
}
function dataISO(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/); return iso ? iso[1] : null;
}

function arquivoMaisNovo(pasta) {
  if (!fs.existsSync(pasta)) return null;
  const xs = fs.readdirSync(pasta).filter((f) => /\.xlsx$/i.test(f) && !/\.crdownload$/i.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(pasta, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  return xs.length ? path.join(pasta, xs[0].f) : null;
}

function garantirTabela(db) {
  const cols = ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'data_referencia TEXT']
    .concat(CAMPOS.map((c) => `${c} ${NUMERICOS.has(c) ? 'REAL' : 'TEXT'}`));
  db.exec(`CREATE TABLE IF NOT EXISTS empenhos_consulta (${cols.join(', ')})`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_emp_consulta_ne ON empenhos_consulta (numero_empenho)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_emp_consulta_proc ON empenhos_consulta (numero_processo)');
}

function tsLocal(d = new Date()) { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function registrarServico({ resultado, mensagem, registros, arquivo, inicioMs, detalhe }) {
  try {
    const dbs = new DatabaseSync(BANCO); const fimMs = Date.now();
    dbs.prepare(`INSERT INTO servico_execucoes (servico, iniciado_em, finalizado_em, duracao_ms, resultado, nivel, mensagem, registros, arquivo, origem, usuario_email, detalhe) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('consultar_empenhos', tsLocal(new Date(inicioMs || fimMs)), tsLocal(new Date(fimMs)), inicioMs ? fimMs - inicioMs : null, resultado, resultado === 'erro' ? 'ERROR' : 'INFO', mensagem || null, registros != null ? registros : null, arquivo ? path.basename(arquivo) : null, 'automatico', 'robo-automacao', detalhe || null);
    dbs.close();
  } catch (_) {}
}

(function main() {
  const inicioMs = Date.now();
  let arquivo = null;
  try {
    arquivo = process.argv[2] || arquivoMaisNovo(PASTA_DOWNLOAD);
    if (!arquivo || !fs.existsSync(arquivo)) throw new Error('nao achei nenhum .xlsx para importar em ' + PASTA_DOWNLOAD);
    console.log('Lendo:', path.basename(arquivo));

    const wb = XLSX.read(fs.readFileSync(arquivo), { type: 'buffer', cellDates: true });
    const nomeAba = wb.SheetNames.find((n) => normalizar(n) === 'dados') || wb.SheetNames[0];
    const brutas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, defval: null, raw: true });
    if (!brutas.length) throw new Error('aba "' + nomeAba + '" vazia.');

    const cab = (brutas[0] || []).map(normCab);
    const COL = {}; const faltando = [];
    for (const [campo, nomeCol] of Object.entries(MAPA)) { const idx = cab.indexOf(normCab(nomeCol)); COL[campo] = idx; if (idx < 0) faltando.push(nomeCol); }
    if (faltando.length) throw new Error('nao achei estas colunas: ' + faltando.join(', '));

    const linhas = [];
    for (let i = 1; i < brutas.length; i++) {
      const r = brutas[i]; if (!r) continue;
      const linha = {};
      for (const campo of CAMPOS) {
        const bruto = COL[campo] >= 0 ? r[COL[campo]] : null;
        linha[campo] = NUMERICOS.has(campo) ? numero(bruto) : DATAS.has(campo) ? dataISO(bruto) : texto(bruto);
      }
      if (!linha.numero_empenho) continue; // linha valida = tem NE
      linhas.push(linha);
    }
    if (!linhas.length) throw new Error('o arquivo nao tinha nenhuma linha de empenho valida.');

    const db = new DatabaseSync(BANCO);
    garantirTabela(db);
    const dataReferencia = new Date().toISOString().slice(0, 10);
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM empenhos_consulta').run();
      const cols = ['data_referencia', ...CAMPOS];
      const stmt = db.prepare(`INSERT INTO empenhos_consulta (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const l of linhas) stmt.run(dataReferencia, ...CAMPOS.map((c) => (l[c] === undefined ? null : l[c])));
      const totalProc = db.prepare("SELECT COUNT(DISTINCT numero_processo) c FROM empenhos_consulta WHERE numero_processo IS NOT NULL AND numero_processo<>''").get().c;
      var resumo = { dataReferencia, totalEmpenhos: linhas.length, totalProcessos: totalProc };
      db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)').run('consultar_empenhos', path.basename(arquivo), 'robo-automacao', JSON.stringify(resumo));
      db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)').run(null, 'robo-automacao', 'importar_consultar_empenhos', 'empenhos_consulta', JSON.stringify(resumo));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw new Error('ao gravar no banco: ' + e.message); } finally { db.close(); }

    console.log(`OK: importados ${resumo.totalEmpenhos} empenhos / ${resumo.totalProcessos} processos (data ${resumo.dataReferencia}).`);
    registrarServico({ resultado: 'sucesso', mensagem: `Importados ${resumo.totalEmpenhos} empenhos / ${resumo.totalProcessos} processos.`, registros: resumo.totalEmpenhos, arquivo, inicioMs });
  } catch (e) {
    console.error('ERRO:', e.message);
    registrarServico({ resultado: 'erro', mensagem: e.message, detalhe: e.stack, arquivo, inicioMs });
    process.exit(1);
  }
})();
