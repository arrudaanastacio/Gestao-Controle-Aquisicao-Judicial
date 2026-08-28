// =====================================================================
// routes.iblItem.js — Saldo IBL (Outras Demandas) consolidado por SCODES
//
// Usado pelos modais "Ver" de Estoque TP, Estoque Geral e Listagem de Autores
// para mostrar, quando o item existe no IBL (locais 2999/3004), o saldo
// disponível consolidado + a validade mais próxima e os lotes.
//
// Consulta a API IBL AO VIVO, mas com CACHE curto em memória (5 min): abrir
// vários modais em sequência não dispara uma chamada por clique.
// Montado com apenas `autenticar` (sem trava de módulo) porque é um
// enriquecimento leve exibido em telas de módulos diferentes.
// =====================================================================
const express = require('express');
const ibl = require('./iblApi');
const db = require('./db');

const router = express.Router();

const TTL_MS = 5 * 60 * 1000;
let cache = { at: 0, mapa: new Map(), geradoEm: null };
let construindo = null; // promessa em andamento (evita buscas simultâneas)

// "dd/mm/aaaa" -> "aaaa-mm-dd".
function iso(br) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(br || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Mapa codigo_sku -> codigo_item (SCODES) da última importação do Estoque OD.
function mapaSkuScodes() {
  const ultima = db.prepare('SELECT MAX(data_referencia) d FROM estoque_od_importacoes').get()?.d;
  const mapa = new Map();
  if (!ultima) return mapa;
  for (const l of db.prepare(
    'SELECT DISTINCT codigo_sku, codigo_item FROM estoque_od_itens WHERE data_referencia = ? AND codigo_item IS NOT NULL'
  ).all(ultima)) if (l.codigo_sku) mapa.set(String(l.codigo_sku).trim(), l.codigo_item);
  return mapa;
}

// Busca a API (2999/3004), pivota por lote e consolida por SCODES.
async function construirMapa() {
  const r = await ibl.iblLinhasNoFormatoOD();
  const msk = mapaSkuScodes();
  const m = new Map();
  // Só considera lotes com validade VIGENTE. Vencido (validade < hoje) é
  // ignorado no saldo e na lista. Lote sem validade preenchida é mantido
  // (não dá para provar que venceu). Corte inclui o próprio dia (>= hoje).
  const hojeIso = new Date().toISOString().slice(0, 10);
  for (const l of r.linhasOD) {
    const ivFiltro = iso(l.validade);
    if (ivFiltro && ivFiltro < hojeIso) continue; // lote vencido: descarta
    const disp = Number(l.qtde_disponivel) || 0;
    if (disp <= 0) continue; // só estoque DISPONÍVEL
    const scodes = msk.get(String(l.codigo_sku).trim());
    if (!scodes) continue; // só itens com correspondência ao nosso catálogo
    let a = m.get(scodes);
    if (!a) { a = { disponivel: 0, validadeMinIso: null, validadeMinBr: null, locais: new Set(), lotes: [] }; m.set(scodes, a); }
    a.disponivel += disp;
    if (l.projeto_codigo) a.locais.add(l.projeto_codigo);
    const iv = iso(l.validade);
    if (iv && (!a.validadeMinIso || iv < a.validadeMinIso)) { a.validadeMinIso = iv; a.validadeMinBr = l.validade; }
    a.lotes.push({ local: l.projeto_codigo, lote: l.lote, validade: l.validade, disponivel: disp });
  }
  return { mapa: m, geradoEm: r.geradoEm };
}

async function obterMapa() {
  if (cache.mapa.size && Date.now() - cache.at < TTL_MS) return cache;
  if (!construindo) {
    construindo = construirMapa()
      .then(({ mapa, geradoEm }) => { cache = { at: Date.now(), mapa, geradoEm }; return cache; })
      .finally(() => { construindo = null; });
  }
  return construindo;
}

// GET /api/ibl-item/saldo?codigo=<SCODES>
router.get('/saldo', async (req, res) => {
  const codigo = String(req.query.codigo || '').trim();
  if (!codigo) return res.json({ disponivel: null });
  try {
    const c = await obterMapa();
    const a = c.mapa.get(codigo);
    if (!a) return res.json({ disponivel: null, geradoEm: c.geradoEm });
    const lotes = a.lotes.slice().sort((x, y) => (iso(x.validade) || '9').localeCompare(iso(y.validade) || '9'));
    res.json({
      disponivel: a.disponivel,
      validadeProxima: a.validadeMinBr, locais: [...a.locais], lotes, geradoEm: c.geradoEm,
    });
  } catch (e) {
    res.status(502).json({ erro: 'Falha ao consultar a API IBL: ' + e.message });
  }
});

// =====================================================================
// Importados (IBL local 2999 "IBL IMPORTADOS"): esse local NÃO usa codigo_sku
// e tem schema próprio (cod_item, quantidade, situacao_qualidade, lote,
// data_validade). O `cod_item` é o CÓDIGO GSNET; casamos com o SCODES pela
// tabela itens_gsnet (Relatório de Itens Importados). Cache curto próprio.
// =====================================================================
let cacheImp = { at: 0, mapa: new Map(), geradoEm: null };
let construindoImp = null;

async function construirMapaImportado() {
  const snap = await ibl.buscarSnapshot(['2999']);
  const g2s = new Map(); // Código GSNET -> SCODES
  for (const r of db.prepare("SELECT codigo_item, codigo_gsnet FROM itens_gsnet WHERE codigo_gsnet IS NOT NULL AND codigo_gsnet <> ''").all()) {
    g2s.set(String(r.codigo_gsnet).trim(), r.codigo_item);
  }
  // Conta APENAS o estoque DISPONÍVEL e DENTRO da validade (lote vencido não
  // entra). Itens sem nenhum lote disponível/vigente não aparecem no bloco.
  const hojeIso = new Date().toISOString().slice(0, 10);
  const m = new Map();
  for (const l of snap.linhas) {
    const scodes = g2s.get(String(l.cod_item || '').trim());
    if (!scodes) continue; // sem correspondência com o nosso catálogo/GSNET
    if (String(l.situacao_qualidade || '').toUpperCase() !== 'DISPONIVEL') continue; // só disponível
    const iv = l.data_validade || null; // já vem em ISO (aaaa-mm-dd)
    if (!iv || iv < hojeIso) continue; // fora da validade: não apresenta
    let a = m.get(scodes);
    if (!a) { a = { disponivel: 0, validadeMinIso: null, validadeMinBr: null, lotes: [] }; m.set(scodes, a); }
    const q = Number(l.quantidade) || 0;
    a.disponivel += q;
    if (!a.validadeMinIso || iv < a.validadeMinIso) { a.validadeMinIso = iv; a.validadeMinBr = ibl.isoParaBR(iv); }
    a.lotes.push({ lote: l.lote, validade: ibl.isoParaBR(iv), quantidade: q });
  }
  return { mapa: m, geradoEm: snap.geradoEm };
}

async function obterMapaImportado() {
  if (cacheImp.mapa.size && Date.now() - cacheImp.at < TTL_MS) return cacheImp;
  if (!construindoImp) {
    construindoImp = construirMapaImportado()
      .then(({ mapa, geradoEm }) => { cacheImp = { at: Date.now(), mapa, geradoEm }; return cacheImp; })
      .finally(() => { construindoImp = null; });
  }
  return construindoImp;
}

// GET /api/ibl-item/saldo-importado?codigo=<SCODES>
router.get('/saldo-importado', async (req, res) => {
  const codigo = String(req.query.codigo || '').trim();
  if (!codigo) return res.json({ disponivel: null });
  try {
    const c = await obterMapaImportado();
    const a = c.mapa.get(codigo);
    if (!a) return res.json({ disponivel: null, geradoEm: c.geradoEm });
    const lotes = a.lotes.slice().sort((x, y) => (iso(x.validade) || '9').localeCompare(iso(y.validade) || '9'));
    res.json({ disponivel: a.disponivel, validadeProxima: a.validadeMinBr, lotes, geradoEm: c.geradoEm });
  } catch (e) {
    res.status(502).json({ erro: 'Falha ao consultar a API IBL: ' + e.message });
  }
});

module.exports = router;
