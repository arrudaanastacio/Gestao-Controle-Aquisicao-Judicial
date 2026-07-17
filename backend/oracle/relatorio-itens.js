// =====================================================================
// relatorio-itens.js
// Carrega a query do catálogo completo (Relatório de Itens) e expõe uma
// função para buscá-lo. Sem filtro de data/unidade — traz o catálogo
// inteiro do SCODES, igual à importação manual por planilha.
// =====================================================================
const fs = require('fs');
const path = require('path');
const { consultar } = require('./db-oracle');

const SQL_RELATORIO_ITENS = fs.readFileSync(
  path.join(__dirname, 'query-relatorio-itens.sql'),
  'utf8'
);

/**
 * Busca o catálogo completo de itens do SCODES.
 * @returns {Promise<Array<Object>>} linhas como objetos { COLUNA: valor }
 */
async function buscarRelatorioItens() {
  return consultar(SQL_RELATORIO_ITENS);
}

module.exports = { buscarRelatorioItens };
