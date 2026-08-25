// caixaAtendimento.js — classifica cada item/solicitação numa "caixa" do
// Relatório de Primeiro Atendimento: Materiais, Medicamentos, Nutrição ou
// Manipulado.
//
// Regra (definida com o Rafael):
//   - subcategoria "Manipulado" ou "Homeopático" (item_classificacao) => caixa
//     Manipulado (são medicamentos manipulados/homeopáticos).
//   - senão, pela CATEGORIA do Relatório de Itens (relatorio_itens.categoria):
//       Materiais -> Materiais | Medicamentos -> Medicamentos | Nutrição -> Nutrição
//   - qualquer outra coisa (Procedimentos, Outros Itens, sem cadastro) => null
//     (sem caixa: só o admin enxerga, na aba "Todas").
//
// A caixa de uma SOLICITAÇÃO é a predominante entre os itens (empate: a do
// primeiro item que tiver caixa). Gravada em requisicoes.caixa na criação.
//
// REGRA_VERSAO: sobe quando a regra muda; routes.autores usa isso para
// reclassificar as solicitações já gravadas (não só as sem caixa).
const db = require('./db');

const CAIXAS = ['Materiais', 'Medicamentos', 'Nutrição', 'Manipulado'];
const REGRA_VERSAO = '2';

// Normaliza subcategoria para comparar sem acento/caixa (Homeopático/Homeopatico).
function norm(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
}

function criarCalculadoraCaixa() {
  const qCat = db.prepare('SELECT categoria FROM relatorio_itens WHERE codigo = ? ORDER BY data_referencia DESC LIMIT 1');
  const qSub = db.prepare('SELECT subcategoria FROM item_classificacao WHERE codigo_item = ?');
  const cache = new Map();

  return function caixaDoItem(codigo) {
    if (!codigo) return null;
    if (cache.has(codigo)) return cache.get(codigo);
    let caixa = null;
    const sub = norm(qSub.get(codigo)?.subcategoria);
    if (sub === 'MANIPULADO' || sub === 'HOMEOPATICO') {
      caixa = 'Manipulado';
    } else {
      const cat = qCat.get(codigo)?.categoria || null;
      if (CAIXAS.includes(cat)) caixa = cat;
    }
    cache.set(codigo, caixa);
    return caixa;
  };
}

// Caixa predominante de uma lista de códigos de item (null = nenhuma caixa).
function caixaPredominante(codigos, calc) {
  const cont = new Map();
  for (const cod of codigos || []) {
    const c = calc(cod);
    if (!c) continue;
    cont.set(c, (cont.get(c) || 0) + 1);
  }
  let melhor = null;
  let max = 0;
  // Percorre na ordem de inserção: o primeiro com maior contagem vence (empate
  // fica com o que apareceu primeiro entre os itens).
  for (const [c, n] of cont) {
    if (n > max) { max = n; melhor = c; }
  }
  return melhor;
}

module.exports = { CAIXAS, REGRA_VERSAO, criarCalculadoraCaixa, caixaPredominante };
