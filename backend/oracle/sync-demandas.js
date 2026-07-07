// =====================================================================
// sync-demandas.js
// Atualiza a Listagem de Autores puxando as demandas direto do Oracle
// (SCODES/Prodesp), em vez do CSV gerado pela macro do Excel no G:\.
// Busca TODAS as unidades de uma vez; a separação Tenente Pena x Demais
// Unidades continua sendo feita na tela (filtro escopoUnidade).
// Grava na MESMA tabela autores_itens usada pela importação de CSV,
// reaproveitando importarAutoresDeLinhas() de routes.autores.js.
// =====================================================================
const { buscarDemandasTodasUnidades } = require('./demandas');
const { fecharPool } = require('./db-oracle');
const { importarAutoresDeLinhas } = require('../src/routes.autores');

// Alias da coluna vinda do Oracle -> campo da tabela autores_itens.
// A query enxuta (query-demandas.sql) traz só estas colunas; os demais
// campos do banco ficam nulos (idade, procurador etc. não são trazidos).
const MAPA_ORACLE = {
  Unid_Dispensadora: 'unidade_dispensadora',
  Unid_Organizacional: 'unidade_organizacional',
  ID_Demanda: 'id_demanda',
  Autor: 'autor',
  Protocolo: 'protocolo',
  Processo: 'processo',
  Status_da_Demanda: 'status_demanda',
  Tipo_da_Demanda: 'tipo_demanda',
  Data_Inclusao_na_OD: 'data_inclusao_od',
  Cod_Item: 'codigo_item',
  Descricao_do_Item: 'descricao_item',
  Qtdade_de_Consumo: 'qtde_consumo',
  Dispensacoes: 'dispensacoes',
  Periodicidade: 'periodicidade',
  Prazo: 'prazo',
  Dispensacoes_Autorizadas: 'dispensacoes_autorizadas',
  Categoria: 'categoria',
  Data_Ultima_Dispensacao: 'data_ultima_dispensacao',
  Data_Ultimo_Retorno: 'data_ultimo_retorno',
  Cod_SIAFISICO: 'cod_siafisico',
};

// Converte o valor do Oracle em texto limpo (ou null).
function texto(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

/**
 * Atualiza a Listagem de Autores a partir do Oracle.
 * @param {Object} opcoes  Repassado a importarAutoresDeLinhas
 *   (dataReferencia, usuarioEmail, usuarioId, nomeArquivo).
 * @returns {Promise<Object>} resumo { dataReferencia, totalLinhas, totalAutores, duracaoMs }
 */
async function atualizarAutoresViaOracle(opcoes = {}) {
  const t0 = Date.now();
  const brutas = await buscarDemandasTodasUnidades();

  const linhas = brutas.map((r) => {
    const linha = {};
    for (const [aliasOracle, campo] of Object.entries(MAPA_ORACLE)) {
      linha[campo] = texto(r[aliasOracle]);
    }
    return linha;
  });

  const resumo = importarAutoresDeLinhas(linhas, {
    nomeArquivo: 'Oracle (SCODES)',
    usuarioEmail: 'oracle-scodes',
    ...opcoes,
  });
  resumo.duracaoMs = Date.now() - t0;
  return resumo;
}

module.exports = { atualizarAutoresViaOracle };

// Permite rodar direto pela linha de comando:  node oracle/sync-demandas.js
if (require.main === module) {
  require('dotenv').config();
  (async () => {
    try {
      console.log('[SYNC AUTORES] Buscando demandas de TODAS as unidades no Oracle (pode levar minutos)...');
      const resumo = await atualizarAutoresViaOracle();
      console.log('[SYNC AUTORES] Concluido:', JSON.stringify(resumo));
    } catch (e) {
      console.error('[SYNC AUTORES] Falha:', e.message);
      process.exitCode = 1;
    } finally {
      await fecharPool();
    }
  })();
}
