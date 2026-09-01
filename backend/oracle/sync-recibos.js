// =====================================================================
// sync-recibos.js
// Atualiza a base de recibos (entrega real) puxando o Extrato de Recibos
// direto do Oracle (SCODES). Base do relatório "Consumo x Entrega".
//
// - Puxa os últimos ~12 meses de recibos (cobre a maior janela: 365 dias).
// - Mantém só as categorias Materiais, Medicamentos e Nutrição.
// - Agrega por (SCODES, demanda, unidade, data do recibo): soma a quantidade
//   REAL entregue e guarda a periodicidade média — granularidade de DIA,
//   para a tela recortar qualquer janela a partir de hoje.
// - SUBSTITUI todo o conteúdo da tabela a cada sincronização.
// =====================================================================
const { buscarRecibos } = require('./recibos');
const { fecharPool } = require('./db-oracle');
const db = require('../src/db');

// Categorias que entram no relatório (decidido com o Rafael).
const CATEGORIAS_OK = new Set(['materiais', 'medicamentos', 'nutricao', 'nutrição']);

function normCat(s) {
  return String(s || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, ''); // remove acento p/ comparar
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Atualiza a tabela recibos_entregas a partir do Oracle.
 * @param {Object} opcoes
 * @param {number} [opcoes.dias=366]  Janela puxada (últimos N dias até hoje).
 * @returns {Promise<Object>} resumo { linhasOracle, agregadas, gravadas, duracaoMs }
 */
async function atualizarRecibosViaOracle({ dias = 366 } = {}) {
  const t0 = Date.now();
  const brutas = await buscarRecibos({ dias });

  // Agrega por (SCODES | demanda | unidade | data). Soma qtde real e mantém
  // a soma/contagem de periodicidade para tirar a média.
  const mapa = new Map();
  let consideradas = 0;
  for (const r of brutas) {
    const categoria = r.CATEGORIA;
    if (!CATEGORIAS_OK.has(normCat(categoria))) continue; // fora do escopo (ex.: Procedimentos)
    const codigo = r.PRO_CODIGO ? String(r.PRO_CODIGO).trim() : null;
    const data = r.DATA_RECIBO ? String(r.DATA_RECIBO).trim() : null;
    if (!codigo || !data) continue;
    consideradas++;
    const idDemanda = r.ID_DEMANDA != null ? String(r.ID_DEMANDA).trim() : '';
    const unidade = r.UND_DESCRICAO ? String(r.UND_DESCRICAO).trim() : null;
    const chave = codigo + '|' + idDemanda + '|' + (unidade || '') + '|' + data;
    let ag = mapa.get(chave);
    if (!ag) {
      ag = {
        codigo_item: codigo,
        descricao_item: r.DESCRICAO_PRODUTO ? String(r.DESCRICAO_PRODUTO).trim() : null,
        id_demanda: idDemanda || null,
        unidade,
        categoria: categoria ? String(categoria).trim() : null,
        tipo_demanda: r.TIPO_DEMANDA ? String(r.TIPO_DEMANDA).trim() : null,
        status_demanda: r.STATUS_DEMANDA ? String(r.STATUS_DEMANDA).trim() : null,
        data_recibo: data,
        qtde: 0,
        periSoma: 0,
        periN: 0,
      };
      mapa.set(chave, ag);
    }
    ag.qtde += num(r.QTDE_REAL_ENTREGUE) || 0;
    const peri = num(r.PERIODICIDADE);
    if (peri != null) { ag.periSoma += peri; ag.periN++; }
  }

  const agregadas = [...mapa.values()];

  // Substitui todo o conteúdo numa transação.
  const del = db.prepare('DELETE FROM recibos_entregas');
  const ins = db.prepare(`
    INSERT INTO recibos_entregas
      (codigo_item, descricao_item, id_demanda, unidade, categoria,
       tipo_demanda, status_demanda, periodicidade, qtde_real_entregue, data_recibo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  try {
    del.run();
    for (const a of agregadas) {
      const peri = a.periN ? +(a.periSoma / a.periN).toFixed(2) : null;
      ins.run(
        a.codigo_item, a.descricao_item, a.id_demanda, a.unidade, a.categoria,
        a.tipo_demanda, a.status_demanda, peri, +a.qtde.toFixed(2), a.data_recibo
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return {
    linhasOracle: brutas.length,
    consideradas,
    gravadas: agregadas.length,
    duracaoMs: Date.now() - t0,
  };
}

module.exports = { atualizarRecibosViaOracle };

// Permite rodar direto pela linha de comando:  node oracle/sync-recibos.js [dias]
if (require.main === module) {
  require('dotenv').config();
  const dias = Number(process.argv[2]) || 366;
  (async () => {
    try {
      console.log(`[SYNC RECIBOS] Buscando recibos dos últimos ${dias} dias no Oracle...`);
      const resumo = await atualizarRecibosViaOracle({ dias });
      console.log('[SYNC RECIBOS] Concluido:', JSON.stringify(resumo));
    } catch (e) {
      console.error('[SYNC RECIBOS] Falha:', e.message);
      process.exitCode = 1;
    } finally {
      await fecharPool();
    }
  })();
}
