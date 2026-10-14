// =====================================================================
// empenhoPorProcesso.js — Preenche o Nº Empenho VAZIO das solicitações
// (TP e OD) casando pelo Nº PROCESSO (SEI), quando o processo tem UM único
// empenho nas fontes (100% de confiança). Cascata de fontes:
//   1) empenhos            (Relatório Estratégico de Empenhos)  processo_sem_papel / nota_empenho
//   2) empenhos_consulta   (Consultar Empenho)                  numero_processo    / numero_empenho
//   3) compras_estrategico (Relatório Estratégico de Compras)   protocolo_processo / numero_empenho
//
// É um OVERLAY de leitura: não grava nada. As rotas das 4 telas chamam
// `preencher(linhas)` para, nas linhas com n_empenho vazio, colocar o empenho
// sugerido (só quando inequívoco). Sobrevive às reimportações de solicitações.
// =====================================================================
const db = require('./db');

// Extrai o SEI (024.00000000/AAAA-DD) de um texto qualquer (ex.: "SEI 024...").
function extrairSEI(s) {
  if (!s) return null;
  const m = String(s).match(/\d{3}\.\d{6,}\/\d{4}-\d{2}/);
  return m ? m[0] : null;
}
// Normaliza "AAAANE<numero>" tirando zeros a esquerda (2026NE00570 -> 2026NE570),
// para comparar empenhos escritos em formatos diferentes entre as fontes.
function normNE(v) {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase().replace(/\s+/g, '');
  if (!s || s === '—' || s === '-') return null;
  const m = s.match(/^(\d{4})NE0*(\d+)$/);
  return m ? `${m[1]}NE${m[2]}` : s;
}

// Cache do mapa processo(SEI) -> Map(empenhoNormalizado -> empenhoOriginal).
let cache = null;
let cacheEm = 0;
const CACHE_MS = 60 * 1000;

function construirMapa() {
  const mapa = new Map();
  const add = (proc, ne) => {
    const p = extrairSEI(proc); const n = normNE(ne);
    if (!p || !n) return;
    if (!mapa.has(p)) mapa.set(p, new Map());
    if (!mapa.get(p).has(n)) mapa.get(p).set(n, String(ne).trim()); // guarda o 1o formato visto
  };
  const fontes = [
    'SELECT processo_sem_papel AS p, nota_empenho AS e FROM empenhos',
    'SELECT numero_processo AS p, numero_empenho AS e FROM empenhos_consulta',
    'SELECT protocolo_processo AS p, numero_empenho AS e FROM compras_estrategico',
  ];
  for (const sql of fontes) {
    try { for (const r of db.prepare(sql).all()) add(r.p, r.e); }
    catch (_) { /* fonte pode nao existir ainda */ }
  }
  return mapa;
}
function mapa() {
  if (cache && Date.now() - cacheEm < CACHE_MS) return cache;
  cache = construirMapa(); cacheEm = Date.now();
  return cache;
}

// Devolve o empenho ÚNICO do processo contido em `nOficio`, ou null se o processo
// não existe nas fontes OU tem mais de um empenho (ambíguo -> fica para aprovação).
function empenhoUnicoDoOficio(nOficio) {
  const p = extrairSEI(nOficio);
  if (!p) return null;
  const emps = mapa().get(p);
  if (!emps || emps.size !== 1) return null;
  return [...emps.values()][0];
}

// Overlay: preenche n_empenho (e marca n_empenho_auto=true) nas linhas vazias.
// `campoOficio` default 'n_oficio'. Nao altera linhas que ja tem empenho.
function preencher(linhas, campoOficio = 'n_oficio') {
  if (!Array.isArray(linhas) || !linhas.length) return linhas;
  for (const l of linhas) {
    const atual = l.n_empenho == null ? '' : String(l.n_empenho).trim();
    if (atual !== '' && atual !== '-') continue;
    const sugerido = empenhoUnicoDoOficio(l[campoOficio]);
    if (sugerido) { l.n_empenho = sugerido; l.n_empenho_auto = true; }
  }
  return linhas;
}

module.exports = { extrairSEI, normNE, empenhoUnicoDoOficio, preencher, _construirMapa: construirMapa };
