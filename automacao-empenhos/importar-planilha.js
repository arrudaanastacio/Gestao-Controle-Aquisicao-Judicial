// importar-planilha.js — Le o .xlsx mais recente do Relatorio Estrategico de
// Empenhos (baixado pelo baixar-empenhos.js) e grava na tabela `empenhos` do
// sistema, SUBSTITUINDO toda a foto (DELETE + insert) — igualzinho ao importador
// da tela "Controle de Empenhos". NAO mexe nas cartas de troca ja registradas.
//
// Uso:  node importar-planilha.js [caminho-do-arquivo.xlsx]
// Sem argumento, pega o .xlsx mais novo da PASTA_DOWNLOAD do .env.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createRequire } = require('node:module');

// Reaproveita a biblioteca xlsx que ja esta instalada no backend do sistema.
// Por padrao, acha o backend na pasta irma (../backend) — assim funciona igual
// em teste (C:\Compras Judiciais - TESTE) e em producao (C:\Compras Judiciais)
// sem precisar configurar caminho. Da para sobrescrever no .env se necessario.
const BACKEND_DIR = process.env.BACKEND_DIR || path.join(__dirname, '..', 'backend');
const requireBackend = createRequire(path.join(BACKEND_DIR, 'package.json'));
const XLSX = requireBackend('xlsx');

const BANCO = process.env.BANCO || path.join(BACKEND_DIR, 'data', 'medicamentos_judicial.db');
const PASTA_DOWNLOAD = process.env.PASTA_DOWNLOAD || path.join(__dirname, 'downloads');

// ---------- Helpers (copiados de routes.cartasTroca.js) ----------
function normalizar(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[._]/g, ' ')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
function texto(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}
function numero(v) {
  if (v === undefined || v === null || v === '') return null;
  let s = String(v).trim();
  if (s === '') return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const MAPA_EMPENHO = {
  numero_requisicao: ['numero requisicao'], nome_requisicao: ['nome requisicao'],
  codigo_unico: ['codigo unico'], processo_sem_papel: ['processo sem papel'],
  nota_empenho: ['nota empenho'], empresa: ['empresa'], scodes: ['scodes'],
  siafisico: ['siafisico'], medicamento: ['medicamento'], apresentacao: ['apresentacao'],
  quantidade: ['quantidade'], valor_unitario: ['valor unitario'], valor_total: ['valor total'],
  data_limite_entrega: ['data limite entrega'], data_entrega_ne: ['data entrega ne'],
  quantidade_entrega: ['quantidade entrega'], quantidade_total: ['quantidade total'],
  data_entrega_item: ['data entrega item'], status_entrega: ['status entrega'],
  local_entrega: ['local entrega'], atraso: ['atraso'], dias_atraso: ['dias atraso'],
  data_publicacao: ['data publicacao'], data_retorno: ['data retorno'],
  data_envio: ['data envio'], data_retirada: ['data retirada'],
};
const CAMPOS_EMPENHO = Object.keys(MAPA_EMPENHO);
const NUMERICOS = new Set(['quantidade', 'valor_unitario', 'valor_total', 'quantidade_entrega', 'quantidade_total', 'dias_atraso']);

function arquivoMaisNovo(pasta) {
  if (!fs.existsSync(pasta)) return null;
  const xlsx = fs.readdirSync(pasta)
    .filter((f) => /\.xlsx$/i.test(f) && !/\.crdownload$/i.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(pasta, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return xlsx.length ? path.join(pasta, xlsx[0].f) : null;
}

(function main() {
  const arquivo = process.argv[2] || arquivoMaisNovo(PASTA_DOWNLOAD);
  if (!arquivo || !fs.existsSync(arquivo)) {
    console.error('ERRO: nao achei nenhum .xlsx para importar em', PASTA_DOWNLOAD);
    process.exit(1);
  }
  console.log('Lendo:', arquivo);

  const wb = XLSX.read(fs.readFileSync(arquivo), { type: 'buffer', raw: false });
  const nomeAba = wb.SheetNames.find((n) => normalizar(n) === 'dados') || wb.SheetNames[0];
  const brutas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, defval: null, raw: false });

  let hc = -1;
  for (let i = 0; i < Math.min(brutas.length, 15); i++) {
    const ln = (brutas[i] || []).map(normalizar);
    if (ln.includes('nota empenho') && ln.includes('scodes')) { hc = i; break; }
  }
  if (hc === -1) {
    console.error('ERRO: nao reconheci o layout (nao achei "NOTA_EMPENHO" e "SCODES"). Exportou o Tipo Planilha "Completo"?');
    process.exit(1);
  }

  const cab = (brutas[hc] || []).map(normalizar);
  const COL = {};
  for (const [campo, nomes] of Object.entries(MAPA_EMPENHO)) COL[campo] = cab.findIndex((c) => nomes.includes(c));

  const linhas = [];
  for (let i = hc + 1; i < brutas.length; i++) {
    const r = brutas[i];
    if (!r) continue;
    const nota = COL.nota_empenho >= 0 ? texto(r[COL.nota_empenho]) : null;
    const scodes = COL.scodes >= 0 ? texto(r[COL.scodes]) : null;
    if (!nota && !scodes) continue;
    const linha = {};
    for (const campo of CAMPOS_EMPENHO) {
      const bruto = COL[campo] >= 0 ? texto(r[COL[campo]]) : null;
      linha[campo] = NUMERICOS.has(campo) ? numero(bruto) : bruto;
    }
    linhas.push(linha);
  }
  if (linhas.length === 0) {
    console.error('ERRO: o arquivo nao tinha nenhuma linha de empenho valida.');
    process.exit(1);
  }

  const db = new DatabaseSync(BANCO);
  const dataReferencia = new Date().toISOString().slice(0, 10);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM empenhos').run();
    const cols = ['data_referencia', ...CAMPOS_EMPENHO];
    const stmt = db.prepare(`INSERT INTO empenhos (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    for (const l of linhas) stmt.run(dataReferencia, ...CAMPOS_EMPENHO.map((c) => (l[c] === undefined ? null : l[c])));
    const totalEmpenhos = db.prepare('SELECT COUNT(DISTINCT nota_empenho) c FROM empenhos').get().c;
    const resumo = { dataReferencia, totalLinhas: linhas.length, totalEmpenhos };
    db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
      .run('empenhos', path.basename(arquivo), 'robo-automacao', JSON.stringify(resumo));
    db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
      .run(null, 'robo-automacao', 'importar_empenhos', 'empenhos', JSON.stringify(resumo));
    db.exec('COMMIT');
    console.log(`OK: importadas ${resumo.totalLinhas} linhas / ${resumo.totalEmpenhos} empenhos (data ${dataReferencia}).`);
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('ERRO ao gravar no banco:', e.message);
    process.exit(1);
  } finally {
    db.close();
  }
})();
