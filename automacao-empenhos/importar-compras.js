// importar-compras.js — Le o .xlsx mais recente do Relatorio Estrategico de
// COMPRAS (baixado pelo baixar-compras.js) e grava na tabela `compras_estrategico`
// do sistema, SUBSTITUINDO toda a foto (DELETE + insert) a cada execucao.
// Guarda apenas as 17 colunas que interessam ao Rafael (casadas pelo NOME da
// coluna no cabecalho, nao pela posicao). Cria a tabela sozinho se nao existir.
//
// Uso:  node importar-compras.js [caminho-do-arquivo.xlsx]
// Sem argumento, pega o .xlsx mais novo da PASTA_DOWNLOAD_COMPRAS do .env.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createRequire } = require('node:module');

const BACKEND_DIR = process.env.BACKEND_DIR || path.join(__dirname, '..', 'backend');
const requireBackend = createRequire(path.join(BACKEND_DIR, 'package.json'));
const XLSX = requireBackend('xlsx');

const BANCO = process.env.BANCO || path.join(BACKEND_DIR, 'data', 'medicamentos_judicial.db');
const PASTA_DOWNLOAD = process.env.PASTA_DOWNLOAD_COMPRAS || path.join(__dirname, 'downloads-compras');

// DB (snake_case) <- nome da coluna no relatorio. So estas 17 sao guardadas.
const MAPA = {
  cd_item_siafisico: 'CD_ITEM_SIAFISICO',
  codigo_item: 'CD_ORIGEM_REGISTRO',            // chave que une o sistema (formato 1B03480/06/...)
  ds_origem_registro: 'DS_ORIGEM_REGISTRO',
  ano_ref: 'ANO_REF',
  mes_ref: 'MES_REF',
  tp_demanda_planilha: 'TP_DEMANDA_PLANILHA',
  nr_qtde_pendente: 'NR_QTDE_PENDENTE',
  nr_requisicao: 'NR_REQUISICAO',
  ds_situacao_item_rc: 'DS_SITUACAO_ITEM_RC',
  protocolo_processo: 'PROTOCOLO_PROCESSO',
  ds_modalidade: 'P_DS_MODALIDADE',
  qt_item_processo: 'QT_ITEM_PROCESSO',
  ds_situacao_it_proc: 'DS_SITUACAO_IT_PROC',
  dt_iniciosessaopub: 'DT_INICIOSESSAOPUB',
  dt_fimsessaopub: 'DT_FIMSESSAOPUB',
  ds_status_item_processo: 'DS_STATUS_ITEM_PROCESSO',
  numero_empenho: 'NUMERO_EMPENHO',
};
const CAMPOS = Object.keys(MAPA);
const NUMERICOS = new Set(['nr_qtde_pendente', 'qt_item_processo']);
const DATAS = new Set(['dt_iniciosessaopub', 'dt_fimsessaopub']);

function normalizar(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
function texto(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}
function numero(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (s === '') return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
// Converte celula de data para 'YYYY-MM-DD'. Aceita Date (cellDates), serial do
// Excel (numero) ou texto dd/mm/aaaa. Vazio -> null.
function dataISO(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 0) {
    const d = XLSX.SSF && XLSX.SSF.parse_date_code ? XLSX.SSF.parse_date_code(v) : null;
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1] : null;
}

function arquivoMaisNovo(pasta) {
  if (!fs.existsSync(pasta)) return null;
  const xlsx = fs.readdirSync(pasta)
    .filter((f) => /\.xlsx$/i.test(f) && !/\.crdownload$/i.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(pasta, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return xlsx.length ? path.join(pasta, xlsx[0].f) : null;
}

function tsLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Cria a tabela se ainda nao existir (importador e auto-suficiente).
function garantirTabela(db) {
  const cols = ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'data_referencia TEXT']
    .concat(CAMPOS.map((c) => `${c} ${NUMERICOS.has(c) ? 'REAL' : 'TEXT'}`));
  db.exec(`CREATE TABLE IF NOT EXISTS compras_estrategico (${cols.join(', ')})`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_compras_estrat_item ON compras_estrategico (codigo_item)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_compras_estrat_empenho ON compras_estrategico (numero_empenho)');
}

// Registra a execucao em servico_execucoes (tela "Status dos Servicos").
function registrarServico({ resultado, mensagem, registros, arquivo, inicioMs, detalhe }) {
  try {
    const dbs = new DatabaseSync(BANCO);
    const fimMs = Date.now();
    dbs.prepare(`INSERT INTO servico_execucoes
        (servico, iniciado_em, finalizado_em, duracao_ms, resultado, nivel,
         mensagem, registros, arquivo, origem, usuario_email, detalhe)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'compras',
      tsLocal(new Date(inicioMs || fimMs)),
      tsLocal(new Date(fimMs)),
      inicioMs ? fimMs - inicioMs : null,
      resultado,
      resultado === 'erro' ? 'ERROR' : 'INFO',
      mensagem || null,
      registros != null ? registros : null,
      arquivo ? path.basename(arquivo) : null,
      'automatico',
      'robo-automacao',
      detalhe || null,
    );
    dbs.close();
  } catch (_) { /* status e opcional; nunca atrapalha a importacao */ }
}

(function main() {
  const inicioMs = Date.now();
  let arquivo = null;
  try {
    arquivo = process.argv[2] || arquivoMaisNovo(PASTA_DOWNLOAD);
    if (!arquivo || !fs.existsSync(arquivo)) {
      throw new Error('nao achei nenhum .xlsx para importar em ' + PASTA_DOWNLOAD);
    }
    console.log('Lendo:', arquivo);

    const wb = XLSX.read(fs.readFileSync(arquivo), { type: 'buffer', cellDates: true });
    const nomeAba = wb.SheetNames.find((n) => normalizar(n) === 'dados') || wb.SheetNames[0];
    const brutas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, defval: null, raw: true });
    if (!brutas.length) throw new Error('a aba "' + nomeAba + '" esta vazia.');

    // Cabecalho = 1a linha; acha a coluna de cada campo pelo NOME.
    const cab = (brutas[0] || []).map((c) => String(c ?? '').trim().toUpperCase());
    const COL = {};
    const faltando = [];
    for (const [campo, nomeCol] of Object.entries(MAPA)) {
      const idx = cab.indexOf(nomeCol.toUpperCase());
      COL[campo] = idx;
      if (idx < 0) faltando.push(nomeCol);
    }
    if (faltando.length) throw new Error('nao achei estas colunas no relatorio: ' + faltando.join(', '));

    const linhas = [];
    for (let i = 1; i < brutas.length; i++) {
      const r = brutas[i];
      if (!r) continue;
      const linha = {};
      for (const campo of CAMPOS) {
        const bruto = COL[campo] >= 0 ? r[COL[campo]] : null;
        linha[campo] = NUMERICOS.has(campo) ? numero(bruto) : DATAS.has(campo) ? dataISO(bruto) : texto(bruto);
      }
      // Linha valida = tem ao menos o codigo do item.
      if (!linha.codigo_item && !linha.cd_item_siafisico) continue;
      linhas.push(linha);
    }
    if (linhas.length === 0) throw new Error('o arquivo nao tinha nenhuma linha de compra valida.');

    const db = new DatabaseSync(BANCO);
    garantirTabela(db);
    const dataReferencia = new Date().toISOString().slice(0, 10);
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM compras_estrategico').run();
      const cols = ['data_referencia', ...CAMPOS];
      const stmt = db.prepare(`INSERT INTO compras_estrategico (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const l of linhas) stmt.run(dataReferencia, ...CAMPOS.map((c) => (l[c] === undefined ? null : l[c])));
      const totalEmpenhos = db.prepare("SELECT COUNT(DISTINCT numero_empenho) c FROM compras_estrategico WHERE numero_empenho IS NOT NULL AND numero_empenho <> ''").get().c;
      const totalItens = db.prepare('SELECT COUNT(DISTINCT codigo_item) c FROM compras_estrategico').get().c;
      var resumo = { dataReferencia, totalLinhas: linhas.length, totalItens, totalEmpenhos };
      db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
        .run('compras', path.basename(arquivo), 'robo-automacao', JSON.stringify(resumo));
      db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
        .run(null, 'robo-automacao', 'importar_compras', 'compras_estrategico', JSON.stringify(resumo));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error('ao gravar no banco: ' + e.message);
    } finally {
      db.close();
    }

    console.log(`OK: importadas ${resumo.totalLinhas} linhas / ${resumo.totalItens} itens / ${resumo.totalEmpenhos} empenhos (data ${resumo.dataReferencia}).`);
    registrarServico({
      resultado: 'sucesso',
      mensagem: `Importadas ${resumo.totalLinhas} linhas / ${resumo.totalItens} itens / ${resumo.totalEmpenhos} empenhos.`,
      registros: resumo.totalLinhas,
      arquivo,
      inicioMs,
    });
  } catch (e) {
    console.error('ERRO:', e.message);
    registrarServico({ resultado: 'erro', mensagem: e.message, detalhe: e.stack, arquivo, inicioMs });
    process.exit(1);
  }
})();
