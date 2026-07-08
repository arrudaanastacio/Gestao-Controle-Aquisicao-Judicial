// =====================================================================
// sync-estoque.js
// Atualiza os Itens em Estoque puxando direto do Oracle (SCODES), em vez
// do relatório extraído manualmente pela aplicação (G:\...\MACRO\).
// Busca TODAS as unidades de uma vez. Grava na MESMA tabela usada pela
// importação de planilha, reaproveitando importarEstoqueDeLinhas() de
// routes.estoque.js (histórico, alertas e limpeza continuam iguais).
// =====================================================================
const { buscarEstoque } = require('./estoque');
const { fecharPool } = require('./db-oracle');
const { importarEstoqueDeLinhas } = require('../src/routes.estoque');

// Alias da coluna vinda do Oracle -> campo da tabela estoque_itens.
// TPC_DESCRICAO = tipo de controlado (Portaria 344); ORIGEM = tipo do item
// (GENÉRICO/MANIPULADO/HOMEOPÁTICO/MARCA), confirmado com o Rafael.
const MAPA_ORACLE = {
  UND_DESCRICAO: 'unidade',
  CAT_DESCRICAO: 'categoria',
  TPC_DESCRICAO: 'controlado',
  ORIGEM: 'tipo_item',
  MAR_DESCRICAO: 'marca',
  PRO_IMPORTADO: 'importado',
  PRO_OUT_DEM: 'outras_demandas',
  PRO_ID: 'id_item_origem',
  PRO_CODIGO: 'codigo_item',
  NOME: 'descricao',
  PRO_SIAFISICO: 'siafisico',
  CATMAT: 'catmat',
  DEMANDAS: 'demandas',
  DEMANDAS_AJ: 'demandas_aj',
  CONSUMO_MENSAL: 'consumo_mensal_total',
  CONSUMO_MENSAL_AJ: 'consumo_mensal_aj',
  ESTOQUE: 'estoque',
  AUTONOMIA: 'autonomia',
  CUSTO_UNITARIO: 'custo_unitario',
  VALOR_MEDIO: 'valor_medio_unitario',
  LOTES: 'lotes',
};

// Campos numéricos: o driver Oracle já devolve number, mas garante o tipo.
const CAMPOS_NUMERICOS = new Set([
  'demandas', 'demandas_aj', 'consumo_mensal_total', 'consumo_mensal_aj',
  'estoque', 'autonomia', 'custo_unitario', 'valor_medio_unitario',
]);

function valor(campo, v) {
  if (v === undefined || v === null) return null;
  if (CAMPOS_NUMERICOS.has(campo)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  const t = String(v).trim();
  return t === '' ? null : t;
}

/**
 * Atualiza os Itens em Estoque a partir do Oracle.
 * @param {Object} opcoes  Repassado a importarEstoqueDeLinhas
 *   (dataReferencia, usuarioEmail, usuarioId, nomeArquivo).
 * @returns {Promise<Object>} resumo (mesmo formato da importação por planilha) + duracaoMs
 */
async function atualizarEstoqueViaOracle(opcoes = {}) {
  const t0 = Date.now();
  const brutas = await buscarEstoque();

  const linhas = brutas.map((r) => {
    const linha = {};
    for (const [aliasOracle, campo] of Object.entries(MAPA_ORACLE)) {
      linha[campo] = valor(campo, r[aliasOracle]);
    }
    return linha;
  });

  const resumo = importarEstoqueDeLinhas(linhas, {
    nomeArquivo: 'Oracle (SCODES)',
    usuarioEmail: 'oracle-scodes',
    ...opcoes,
  });
  resumo.duracaoMs = Date.now() - t0;
  return resumo;
}

module.exports = { atualizarEstoqueViaOracle };

// Permite rodar direto pela linha de comando:  node oracle/sync-estoque.js
if (require.main === module) {
  require('dotenv').config();
  (async () => {
    try {
      console.log('[SYNC ESTOQUE] Buscando itens em estoque de TODAS as unidades no Oracle...');
      const resumo = await atualizarEstoqueViaOracle();
      console.log('[SYNC ESTOQUE] Concluido:', JSON.stringify(resumo));
    } catch (e) {
      console.error('[SYNC ESTOQUE] Falha:', e.message);
      process.exitCode = 1;
    } finally {
      await fecharPool();
    }
  })();
}
