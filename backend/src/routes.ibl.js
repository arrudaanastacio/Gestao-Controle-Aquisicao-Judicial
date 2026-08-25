// =====================================================================
// routes.ibl.js — Tela "Estoque IBL (API)"
//
// Consulta AO VIVO a API somente-leitura do WMS IBL (CEAF/SES-SP) e devolve
// o estoque dos locais configurados (default 2999 e 3004), já pivotado por
// lote (Disponível/Bloqueado/Reservada/Total). Não grava no banco — cada
// consulta reflete o saldo no momento da chamada.
// =====================================================================
const express = require('express');
const ibl = require('./iblApi');
const db = require('./db');

const router = express.Router();

// Mapa codigo_sku -> codigo_item (SCODES) a partir da ÚLTIMA importação do
// Estoque OD (que já resolve essa correspondência via a planilha de cadastro
// GSNET-IBL). Reaproveita o mapeamento existente, sem duplicar fonte.
function mapaSkuParaScodes() {
  const ultima = db.prepare('SELECT MAX(data_referencia) d FROM estoque_od_importacoes').get()?.d;
  const mapa = new Map();
  if (!ultima) return mapa;
  const linhas = db.prepare(
    'SELECT DISTINCT codigo_sku, codigo_item FROM estoque_od_itens WHERE data_referencia = ? AND codigo_item IS NOT NULL'
  ).all(ultima);
  for (const l of linhas) if (l.codigo_sku) mapa.set(String(l.codigo_sku).trim(), l.codigo_item);
  return mapa;
}

// GET /api/ibl/estoque?projetos=2999,3004
// Retorna { geradoEm, projetos, porProjeto, total, itens }.
router.get('/estoque', async (req, res) => {
  try {
    const projetos = (req.query.projetos
      ? String(req.query.projetos).split(',').map((s) => s.trim()).filter(Boolean)
      : ibl.projetosPadrao());
    const r = await ibl.iblLinhasNoFormatoOD(projetos);
    // Enriquece com o código SCODES (codigo_item) via mapeamento do Estoque OD.
    const mapaScodes = mapaSkuParaScodes();
    let semScodes = 0;
    for (const l of r.linhasOD) {
      l.codigo_item = mapaScodes.get(String(l.codigo_sku).trim()) || null;
      if (!l.codigo_item) semScodes += 1;
    }
    // Ordena por local e depois descrição, para uma leitura estável.
    const itens = r.linhasOD.sort((a, b) =>
      String(a.projeto_codigo).localeCompare(String(b.projeto_codigo)) ||
      String(a.descricao || '').localeCompare(String(b.descricao || '')) ||
      String(a.lote || '').localeCompare(String(b.lote || '')));
    res.json({
      geradoEm: r.geradoEm,
      projetos,
      porProjeto: r.porProjeto,   // linhas cruas por local (antes do pivot)
      totalCruas: r.linhas.length,
      total: itens.length,        // linhas por lote (após pivot)
      semScodes,                  // quantas linhas ficaram sem correspondência SCODES
      itens,
    });
  } catch (e) {
    res.status(502).json({ erro: 'Falha ao consultar a API IBL: ' + e.message });
  }
});

// GET /api/ibl/programas — lista os locais/projetos com saldo (conferência).
router.get('/programas', async (req, res) => {
  try {
    res.json({ programas: await ibl.listarProgramas() });
  } catch (e) {
    res.status(502).json({ erro: 'Falha ao consultar a API IBL: ' + e.message });
  }
});

module.exports = router;
