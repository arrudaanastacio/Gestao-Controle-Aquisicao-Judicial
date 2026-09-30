// Unidades dispensadoras que NÃO devem aparecer nas telas "gerais" (Itens em
// Estoque Geral e Listagens de Autores). Decisão do Rafael (30/09/2026).
//
// Igualdade EXATA de propósito: existem várias "UD 01 - DRS I (...)" de outras
// cidades que DEVEM continuar aparecendo — só a "(Central de dispensação)" sai.
// Um LIKE '%DRS I%' derrubaria todas por engano.
const UNIDADES_OCULTAS = [
  'UD 01 - CRT Dst/Aids',
  'UD 01 - DRS I (Central de dispensação)',
  'UD 01 - Oncológicos HE',
  'UD 01 - SMS de São Paulo',
  'UD 01 - Várzea do Carmo',
];

// Monta um trecho SQL "coluna NOT IN ('...', ...)" com os nomes escapados.
// (São constantes nossas, sem aspas hoje; o escape é só defensivo.)
function condNotInOcultas(coluna) {
  const lista = UNIDADES_OCULTAS.map((u) => `'${u.replace(/'/g, "''")}'`).join(', ');
  return `${coluna} NOT IN (${lista})`;
}

module.exports = { UNIDADES_OCULTAS, condNotInOcultas };
