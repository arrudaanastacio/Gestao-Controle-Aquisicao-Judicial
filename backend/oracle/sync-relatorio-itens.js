// =====================================================================
// sync-relatorio-itens.js
// Atualiza o catálogo completo (Relatório de Itens) puxando direto do
// Oracle (SCODES). Substitui TODO o conteúdo da tabela a cada execução,
// igual à importação manual por planilha.
//
// "Intercambiável" e "Comissão de Farmacologia" não vêm nesta query
// (só existiam no CSV manual) — ficam em branco quando atualizado via
// Oracle. Se precisar deles, reimportar o CSV por cima preenche esses
// dois campos sem apagar o resto.
// =====================================================================
const { buscarRelatorioItens } = require('./relatorio-itens');
const { fecharPool } = require('./db-oracle');
const { importarRelatorioItensDeLinhas } = require('../src/routes.relatorioItens');

// Alias da coluna vinda do Oracle -> campo da tabela relatorio_itens.
const MAPA_ORACLE = {
  PRO_ID: 'pro_id',
  SITUACAO: 'situacao',
  USUARIO: 'usuario',
  CATEGORIA: 'categoria',
  CODIGO: 'codigo',
  SIAFISICO: 'siafisico',
  CATMAT: 'catmat',
  DESCRICAO_ITEM: 'descricao_item',
  VALOR_MEDIO_UNITARIO: 'valor_medio_unitario',
  ITEM: 'item',
  ESPECIFICACAO: 'especificacao',
  APRESENTACAO: 'apresentacao',
  MARCA: 'marca',
  IMPORTADO: 'importado',
  TIPO_ITEM: 'tipo_item',
  GRUPO: 'grupo',
  PROGRAMA: 'programa',
  GRUPO_AF: 'grupo_af',
  OBSERVACOES: 'observacoes',
  OUTRAS_DEMANDAS: 'outras_demandas',
  ONCOLOGICO: 'oncologico',
  TERMOLABIL: 'termolabil',
  ANTIMICROBIANO: 'antimicrobiano',
  PORTARIA34498: 'portaria34498',
  GRANDE_VOLUME: 'grande_volume',
  JUDICIAL: 'judicial',
  JEFAZ: 'jefaz',
};

function texto(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

/**
 * Atualiza o Relatório de Itens (catálogo completo) a partir do Oracle.
 * @returns {Promise<Object>} resumo { dataReferencia, totalItens, duracaoMs }
 */
async function atualizarRelatorioItensViaOracle(opcoes = {}) {
  const t0 = Date.now();
  const brutas = await buscarRelatorioItens();

  const linhas = brutas.map((r) => {
    const linha = {};
    for (const [aliasOracle, campo] of Object.entries(MAPA_ORACLE)) {
      linha[campo] = texto(r[aliasOracle]);
    }
    return linha;
  });

  const resumo = importarRelatorioItensDeLinhas(linhas, {
    nomeArquivo: 'Oracle (SCODES)',
    usuarioEmail: 'oracle-scodes',
    ...opcoes,
  });
  resumo.duracaoMs = Date.now() - t0;
  return resumo;
}

module.exports = { atualizarRelatorioItensViaOracle };

// Permite rodar direto pela linha de comando: node oracle/sync-relatorio-itens.js
if (require.main === module) {
  require('dotenv').config();
  (async () => {
    try {
      console.log('[SYNC RELATÓRIO ITENS] Buscando catálogo completo no Oracle...');
      const resumo = await atualizarRelatorioItensViaOracle();
      console.log('[SYNC RELATÓRIO ITENS] Concluido:', JSON.stringify(resumo));
    } catch (e) {
      console.error('[SYNC RELATÓRIO ITENS] Falha:', e.message);
      process.exitCode = 1;
    } finally {
      await fecharPool();
    }
  })();
}
