// =====================================================================
// demandas.js
// Carrega a query de demandas judiciais e expõe uma função para buscá-las,
// nos dois modos: Tenente Pena (und_id = 161) ou todas (und_id = null).
// =====================================================================
const fs = require('fs');
const path = require('path');
const { consultar } = require('./db-oracle');

// UND_ID da unidade Tenente Pena (confirmado na UNIDADE_DISPENSADORA)
const UND_TENENTE_PENA = 161;

// Lê o SQL do arquivo uma vez, na carga do módulo
const SQL_DEMANDAS = fs.readFileSync(
  path.join(__dirname, 'query-demandas.sql'),
  'utf8'
);

/**
 * Busca as demandas judiciais.
 * @param {Object} opts
 * @param {number|null} opts.undId  UND_ID da unidade. Passe null para todas.
 * @returns {Promise<Array<Object>>} linhas como objetos { COLUNA: valor }
 */
async function buscarDemandas({ undId = null } = {}) {
  // bind nomeado :und_id — nunca concatenamos valor na string SQL
  return consultar(SQL_DEMANDAS, { und_id: undId });
}

// Atalhos para os dois módulos
function buscarDemandasTenentePena() {
  return buscarDemandas({ undId: UND_TENENTE_PENA });
}

function buscarDemandasTodasUnidades() {
  return buscarDemandas({ undId: null });
}

module.exports = {
  buscarDemandas,
  buscarDemandasTenentePena,
  buscarDemandasTodasUnidades,
  UND_TENENTE_PENA,
};
