// =====================================================================
// exportarPlanilha.js — Helper único para exportar relatórios em XLSX.
// Mantém o CSV existente intocado: cada rota continua gerando o CSV como
// antes e, quando vier ?formato=xlsx, chama enviarXlsxAoa() com os MESMOS
// dados (cabeçalho + linhas), garantindo conteúdo idêntico ao CSV.
// =====================================================================
const XLSX = require('xlsx');

// Envia uma planilha .xlsx a partir de um AOA (array de arrays):
//   aoa[0] = cabeçalho (títulos das colunas); aoa[1..] = linhas de dados.
// nomeArquivo deve incluir a extensão .xlsx. aba = nome da planilha.
function enviarXlsxAoa(res, nomeArquivo, aoa, aba = 'Dados') {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  // Nome da aba no Excel tem limite de 31 caracteres e não aceita alguns símbolos.
  const abaLimpa = String(aba).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Dados';
  XLSX.utils.book_append_sheet(wb, ws, abaLimpa);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
  res.send(buf);
}

// True quando o cliente pediu XLSX (?formato=xlsx ou ?xlsx=1).
function pediuXlsx(req) {
  return req.query.formato === 'xlsx' || req.query.xlsx === '1';
}

module.exports = { enviarXlsxAoa, pediuXlsx };
