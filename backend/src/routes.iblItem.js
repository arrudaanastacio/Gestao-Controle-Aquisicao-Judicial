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
    const scodes = msk.get(String(l.codigo_sku).trim());
    if (!scodes) continue; // só itens com correspondência ao nosso catálogo
    let a = m.get(scodes);
    if (!a) { a = { disponivel: 0, bloqueado: 0, reservada: 0, total: 0, validadeMinIso: null, validadeMinBr: null, locais: new Set(), lotes: [] }; m.set(scodes, a); }
    a.disponivel += Number(l.qtde_disponivel) || 0;
    a.bloqueado += Number(l.qtde_bloqueado) || 0;
    a.reservada += Number(l.qtde_reservada) || 0;
    a.total += Number(l.qtde_total) || 0;
    if (l.projeto_codigo) a.locais.add(l.projeto_codigo);
    const iv = iso(l.validade);
    if (iv && (!a.validadeMinIso || iv < a.validadeMinIso)) { a.validadeMinIso = iv; a.validadeMinBr = l.validade; }
    a.lotes.push({ local: l.projeto_codigo, lote: l.lote, validade: l.validade, disponivel: Number(l.qtde_disponivel) || 0, total: Number(l.qtde_total) || 0 });
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
      disponivel: a.disponivel, bloqueado: a.bloqueado, reservada: a.reservada, total: a.total,
      validadeProxima: a.validadeMinBr, locais: [...a.locais], lotes, geradoEm: c.geradoEm,
    });
  } catch (e) {
    res.status(502).json({ erro: 'Falha ao consultar a API IBL: ' + e.message });
  }
});

module.exports = router;
