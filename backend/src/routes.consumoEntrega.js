// =====================================================================
// routes.consumoEntrega.js  —  Relatório "Consumo x Entrega"
// Cruza a ENTREGA REAL (recibos_entregas, vinda do Extrato de Recibos via
// Oracle) com o CONSUMO/DEMANDA por SCODES que já temos no estoque
// (estoque_itens, todas as unidades).
//
// Abas (escopo):
//   tp  -> unidade Tenente Pena
//   od  -> demais unidades (Outras Demandas)
// Um mesmo SCODES pode aparecer nas duas abas (números por escopo).
//
// Período: últimos N dias a PARTIR DE HOJE (30/60/90/120/180/365).
//   consumo_estimado_periodo = consumo_mensal * (N/30)
//   % = soma_real_entregue / consumo_estimado_periodo * 100
// =====================================================================
const express = require('express');
const { exigirPerfil, exigirOracle } = require('./auth');
const db = require('./db');

const router = express.Router();

const PERIODOS_OK = new Set([30, 60, 90, 120, 180, 365]);
const FILTRO_UNID_TP = "unidade LIKE '%Tenente Pena%'";

// Conjunto de itens de cada aba (base do relatório = DEMANDA ATIVA no escopo):
//   TP -> itens da unidade Tenente Pena.
//   OD -> itens marcados "Outras Demandas = Sim" que existem no Relatório de
//         Itens, em TODAS as unidades (inclusive Tenente Pena). Decisão do
//         Rafael: o item define o escopo, não a unidade.
function filtroEstoque(escopo) {
  return escopo === 'od'
    ? `outras_demandas = 'Sim' AND codigo_item IN (SELECT codigo FROM relatorio_itens)`
    : FILTRO_UNID_TP;
}
// Escopo dos recibos (entrega real): TP -> só Tenente Pena; OD -> todas as
// unidades (o recorte é feito pelo conjunto de itens de Outras Demandas).
function filtroRecibos(escopo) {
  return escopo === 'od' ? '1=1' : FILTRO_UNID_TP;
}

// Consumo/demanda por SCODES (foto mais recente do estoque), agregado no escopo.
// Base do relatório = itens com DEMANDA ATIVA no escopo (SUM(demandas) > 0).
function consumoDemandaPorScodes(escopo) {
  const dr = db.prepare('SELECT MAX(data_referencia) m FROM estoque_itens').get().m;
  if (!dr) return { dataReferencia: null, mapa: new Map() };
  const linhas = db.prepare(`
    SELECT codigo_item,
           MAX(descricao) AS descricao,
           SUM(COALESCE(consumo_mensal_total,0)) AS consumo,
           SUM(COALESCE(demandas,0)) AS demanda
    FROM estoque_itens
    WHERE data_referencia = ? AND ${filtroEstoque(escopo)}
    GROUP BY codigo_item
    HAVING SUM(COALESCE(demandas,0)) > 0
  `).all(dr);
  const mapa = new Map();
  for (const l of linhas) mapa.set(l.codigo_item, l);
  return { dataReferencia: dr, mapa };
}

// Entrega real por SCODES no escopo + janela (últimos N dias a partir de hoje).
function entregaPorScodes(escopo, dias) {
  const linhas = db.prepare(`
    SELECT codigo_item,
           COUNT(DISTINCT id_demanda) AS demandas_atendidas,
           SUM(COALESCE(qtde_real_entregue,0)) AS soma_real,
           AVG(periodicidade) AS peri_media
    FROM recibos_entregas
    WHERE ${filtroRecibos(escopo)}
      AND data_recibo >= date('now','localtime','-${dias} days')
      AND data_recibo <= date('now','localtime')
    GROUP BY codigo_item
  `).all();
  const mapa = new Map();
  for (const l of linhas) mapa.set(l.codigo_item, l);
  return mapa;
}

function dataCargaRecibos() {
  const r = db.prepare('SELECT MAX(data_carga) m FROM recibos_entregas').get();
  return r ? r.m : null;
}

// ---------- Listagem principal ----------
// GET /?escopo=tp|od&dias=30&scodes=texto
router.get('/', (req, res) => {
  const escopo = req.query.escopo === 'od' ? 'od' : 'tp';
  const dias = parseInt(req.query.dias, 10) || 30;
  if (!PERIODOS_OK.has(dias)) return res.status(400).json({ erro: 'Período inválido.' });
  const scodesFiltro = String(req.query.scodes || '').trim().toLowerCase();

  const { dataReferencia, mapa: cons } = consumoDemandaPorScodes(escopo);
  const entrega = entregaPorScodes(escopo, dias);
  const fator = dias / 30; // meses do período

  const itens = [];
  for (const [codigo, c] of cons) {
    if (scodesFiltro && !codigo.toLowerCase().includes(scodesFiltro)) continue;
    const e = entrega.get(codigo) || { demandas_atendidas: 0, soma_real: 0, peri_media: null };
    const consumoEstimado = (c.consumo || 0) * fator;
    const somaReal = e.soma_real || 0;
    const pct = consumoEstimado > 0 ? (somaReal / consumoEstimado) * 100 : null;
    itens.push({
      codigo_item: codigo,
      descricao: c.descricao || null,
      demanda: c.demanda || 0,
      consumo_mensal: c.consumo || 0,
      consumo_estimado_periodo: +consumoEstimado.toFixed(2),
      demandas_atendidas: e.demandas_atendidas || 0,
      soma_real_entregue: +somaReal.toFixed(2),
      periodicidade_media: e.peri_media != null ? +e.peri_media.toFixed(1) : null,
      percentual: pct != null ? +pct.toFixed(1) : null,
    });
  }
  // Ordena por maior entrega real (mais relevante no topo).
  itens.sort((a, b) => b.soma_real_entregue - a.soma_real_entregue);

  res.json({
    escopo, dias,
    dataReferenciaEstoque: dataReferencia,
    dataCarga: dataCargaRecibos(),
    total: itens.length,
    itens,
  });
});

// ---------- Detalhe (botão Ver): consolidado por mês de um SCODES ----------
// GET /detalhe?escopo=tp|od&dias=90&codigo=SCODES
router.get('/detalhe', (req, res) => {
  const escopo = req.query.escopo === 'od' ? 'od' : 'tp';
  const dias = parseInt(req.query.dias, 10) || 30;
  if (!PERIODOS_OK.has(dias)) return res.status(400).json({ erro: 'Período inválido.' });
  const codigo = String(req.query.codigo || '').trim();
  if (!codigo) return res.status(400).json({ erro: 'Informe o código (SCODES).' });

  const meses = db.prepare(`
    SELECT substr(data_recibo,1,7) AS mes,
           COUNT(DISTINCT id_demanda) AS demandas_atendidas,
           SUM(COALESCE(qtde_real_entregue,0)) AS soma_real,
           AVG(periodicidade) AS peri_media
    FROM recibos_entregas
    WHERE codigo_item = ? AND ${filtroRecibos(escopo)}
      AND data_recibo >= date('now','localtime','-${dias} days')
      AND data_recibo <= date('now','localtime')
    GROUP BY substr(data_recibo,1,7)
    ORDER BY mes
  `).all(codigo);

  // Consolidado por UNIDADE (útil nos itens de Outras Demandas, que aparecem
  // em várias unidades) — cruza DEMANDA/CONSUMO (estoque) com a ENTREGA
  // (recibos), por unidade, para um panorama de estoque × abastecimento.
  const drEst = db.prepare('SELECT MAX(data_referencia) m FROM estoque_itens').get().m;
  const unidMap = new Map();
  const upsert = (u) => {
    const k = u || '(sem unidade)';
    if (!unidMap.has(k)) unidMap.set(k, { unidade: k, demanda: 0, consumo_mensal: 0, demandas_atendidas: 0, soma_real: 0, peri_media: null });
    return unidMap.get(k);
  };
  // Demanda/consumo por unidade (foto mais recente do estoque, mesmo escopo).
  if (drEst) {
    for (const r of db.prepare(`
      SELECT COALESCE(unidade,'(sem unidade)') AS unidade,
             SUM(COALESCE(demandas,0)) AS demanda,
             SUM(COALESCE(consumo_mensal_total,0)) AS consumo
      FROM estoque_itens
      WHERE data_referencia = ? AND codigo_item = ? AND ${filtroEstoque(escopo)}
      GROUP BY COALESCE(unidade,'(sem unidade)')
    `).all(drEst, codigo)) {
      const a = upsert(r.unidade);
      a.demanda = r.demanda || 0;
      a.consumo_mensal = r.consumo || 0;
    }
  }
  // Entrega real por unidade (recibos na janela, mesmo escopo).
  for (const r of db.prepare(`
    SELECT COALESCE(unidade,'(sem unidade)') AS unidade,
           COUNT(DISTINCT id_demanda) AS demandas_atendidas,
           SUM(COALESCE(qtde_real_entregue,0)) AS soma_real,
           AVG(periodicidade) AS peri_media
    FROM recibos_entregas
    WHERE codigo_item = ? AND ${filtroRecibos(escopo)}
      AND data_recibo >= date('now','localtime','-${dias} days')
      AND data_recibo <= date('now','localtime')
    GROUP BY COALESCE(unidade,'(sem unidade)')
  `).all(codigo)) {
    const a = upsert(r.unidade);
    a.demandas_atendidas = r.demandas_atendidas || 0;
    a.soma_real = r.soma_real || 0;
    a.peri_media = r.peri_media != null ? r.peri_media : null;
  }
  const unidades = [...unidMap.values()].sort((a, b) => b.soma_real - a.soma_real);

  const { mapa: cons } = consumoDemandaPorScodes(escopo);
  const c = cons.get(codigo) || {};
  res.json({
    codigo_item: codigo, escopo, dias,
    descricao: c.descricao || null,
    consumo_mensal: c.consumo || 0,
    demanda: c.demanda || 0,
    meses: meses.map((m) => ({
      mes: m.mes,
      demandas_atendidas: m.demandas_atendidas || 0,
      soma_real: +(m.soma_real || 0).toFixed(2),
      periodicidade_media: m.peri_media != null ? +m.peri_media.toFixed(1) : null,
    })),
    unidades: unidades.map((u) => ({
      unidade: u.unidade,
      demanda: u.demanda || 0,
      consumo_mensal: +(u.consumo_mensal || 0).toFixed(2),
      demandas_atendidas: u.demandas_atendidas || 0,
      soma_real: +(u.soma_real || 0).toFixed(2),
      periodicidade_media: u.peri_media != null ? +u.peri_media.toFixed(1) : null,
    })),
  });
});

// ---------- Atualização via Oracle (SCODES) — em segundo plano ----------
const estadoOracle = { rodando: false, inicio: null, ultimoResumo: null, ultimoErro: null };

function executarAtualizacaoRecibosOracle() {
  if (estadoOracle.rodando) return Promise.resolve({ pulou: true });
  const { atualizarRecibosViaOracle } = require('../oracle/sync-recibos');
  estadoOracle.rodando = true;
  estadoOracle.inicio = new Date().toISOString();
  estadoOracle.ultimoErro = null;
  return atualizarRecibosViaOracle({ dias: 396 }) // ~13 meses (cobre 365 dias com margem)
    .then((resumo) => {
      estadoOracle.ultimoResumo = { ...resumo, fim: new Date().toISOString() };
      console.log(`[SYNC RECIBOS] Concluido via Oracle: ${resumo.gravadas} linhas em ${Math.round((resumo.duracaoMs || 0) / 1000)}s.`);
      return resumo;
    })
    .catch((e) => {
      estadoOracle.ultimoErro = e.message;
      console.error('[SYNC RECIBOS] Falha via Oracle:', e.message);
      try { require('./emailAlerta').enviarAlertaFalhaSincronizacao('Recibos (Consumo x Entrega)', e.message); } catch (_) { /* opcional */ }
      throw e;
    })
    .finally(() => { estadoOracle.rodando = false; });
}

router.post('/atualizar-oracle', exigirOracle, (req, res) => {
  if (estadoOracle.rodando) {
    return res.status(409).json({ erro: 'Já existe uma atualização via Oracle em andamento.', ...estadoOracle });
  }
  executarAtualizacaoRecibosOracle().catch(() => {});
  res.json({ iniciado: true, inicio: estadoOracle.inicio });
});

router.get('/atualizar-oracle/status', (req, res) => {
  res.json(estadoOracle);
});

module.exports = router;
module.exports.executarAtualizacaoRecibosOracle = executarAtualizacaoRecibosOracle;
