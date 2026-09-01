// =====================================================================
// recibos.js
// Carrega a query do Extrato de Recibos e a executa por período.
// Base do relatório "Consumo x Entrega" (entrega real por recibo).
// =====================================================================
const fs = require('fs');
const path = require('path');
const { consultar } = require('./db-oracle');

const SQL_RECIBOS = fs.readFileSync(
  path.join(__dirname, 'query-recibos.sql'),
  'utf8'
);

// Formata uma Date -> 'DD/MM/YYYY' (formato esperado pelos binds da query).
function ddmmyyyy(d) {
  const dia = String(d.getDate()).padStart(2, '0');
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  return `${dia}/${mes}/${d.getFullYear()}`;
}

/**
 * Busca os recibos entre duas datas (inclusive).
 * @param {Object} opcoes
 * @param {Date|string} [opcoes.inicio]  Início do período (Date ou 'DD/MM/YYYY').
 * @param {Date|string} [opcoes.fim]     Fim do período (Date ou 'DD/MM/YYYY').
 * @param {number} [opcoes.dias]         Alternativa: últimos N dias a partir de hoje.
 * @returns {Promise<Array<Object>>} linhas como objetos { COLUNA: valor }
 */
async function buscarRecibos({ inicio, fim, dias = 366 } = {}) {
  const hoje = new Date();
  const dFim = fim instanceof Date ? fim : (fim ? null : hoje);
  const dIni = inicio instanceof Date
    ? inicio
    : (inicio ? null : new Date(hoje.getTime() - dias * 24 * 60 * 60 * 1000));
  const binds = {
    inicio: typeof inicio === 'string' ? inicio : ddmmyyyy(dIni),
    fim: typeof fim === 'string' ? fim : ddmmyyyy(dFim),
  };
  return consultar(SQL_RECIBOS, binds);
}

module.exports = { buscarRecibos, ddmmyyyy };
