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

// Dois índices em cache:
//   proc:  SEI            -> Map(empenhoNorm -> empenhoOriginal)   (todas as fontes)
//   item:  "codigo|SEI"   -> Map(empenhoNorm -> empenhoOriginal)   (fontes com item: empenhos.scodes, compras_estrategico.codigo_item)
// Casar por ITEM+processo é preciso (pega o empenho DAQUELE item mesmo que o
// processo tenha vários empenhos). Só cai no "por processo" quando o item não
// está nas fontes a nível de item.
let cacheProc = null, cacheItem = null, cacheEm = 0;
const CACHE_MS = 60 * 1000;

function construir() {
  const proc = new Map(); const item = new Map();
  const addProc = (p, ne) => {
    const sei = extrairSEI(p); const n = normNE(ne); if (!sei || !n) return;
    if (!proc.has(sei)) proc.set(sei, new Map());
    if (!proc.get(sei).has(n)) proc.get(sei).set(n, String(ne).trim());
  };
  const addItem = (cod, p, ne) => {
    const sei = extrairSEI(p); const n = normNE(ne); const c = cod && String(cod).trim();
    if (!sei || !n || !c) return;
    const k = c + '|' + sei;
    if (!item.has(k)) item.set(k, new Map());
    if (!item.get(k).has(n)) item.get(k).set(n, String(ne).trim());
  };
  // empenhos: item-level (scodes = codigo_item) + processo
  try { for (const r of db.prepare('SELECT scodes AS c, processo_sem_papel AS p, nota_empenho AS e FROM empenhos').all()) { addProc(r.p, r.e); addItem(r.c, r.p, r.e); } } catch (_) {}
  // empenhos_consulta: só processo (não tem item)
  try { for (const r of db.prepare('SELECT numero_processo AS p, numero_empenho AS e FROM empenhos_consulta').all()) addProc(r.p, r.e); } catch (_) {}
  // compras_estrategico: item-level (codigo_item) + processo
  try { for (const r of db.prepare('SELECT codigo_item AS c, protocolo_processo AS p, numero_empenho AS e FROM compras_estrategico').all()) { addProc(r.p, r.e); addItem(r.c, r.p, r.e); } } catch (_) {}
  return { proc, item };
}
function mapas() {
  if (cacheProc && Date.now() - cacheEm < CACHE_MS) return { proc: cacheProc, item: cacheItem };
  const m = construir(); cacheProc = m.proc; cacheItem = m.item; cacheEm = Date.now();
  return m;
}

// Resolve o empenho de uma solicitação (codigoItem + nOficio), com 100% de
// confiança: 1) item+processo com 1 empenho; 2) senão, processo com 1 empenho.
// Devolve null quando ambíguo (vários empenhos) ou não encontrado.
function resolver(codigoItem, nOficio) {
  const sei = extrairSEI(nOficio);
  if (!sei) return null;
  const { proc, item } = mapas();
  if (codigoItem) {
    const mm = item.get(String(codigoItem).trim() + '|' + sei);
    if (mm && mm.size === 1) return [...mm.values()][0];   // item + processo (preciso)
  }
  const pm = proc.get(sei);
  if (pm && pm.size === 1) return [...pm.values()][0];       // fallback: processo único
  return null;
}
// Compat.: resolve só por processo (sem item).
function empenhoUnicoDoOficio(nOficio) { return resolver(null, nOficio); }

// Overlay: preenche n_empenho (+ flag n_empenho_auto) nas linhas vazias.
function preencher(linhas, campoOficio = 'n_oficio') {
  if (!Array.isArray(linhas) || !linhas.length) return linhas;
  for (const l of linhas) {
    const atual = l.n_empenho == null ? '' : String(l.n_empenho).trim();
    if (atual !== '' && atual !== '-') continue;
    const sugerido = resolver(l.codigo_item, l[campoOficio]);
    if (sugerido) { l.n_empenho = sugerido; l.n_empenho_auto = true; }
  }
  return linhas;
}

module.exports = { extrairSEI, normNE, resolver, empenhoUnicoDoOficio, preencher, _construir: construir };
