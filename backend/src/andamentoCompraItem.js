// =====================================================================
// andamentoCompraItem.js
// Consulta reutilizável do "andamento de compra" de UM item pelo código:
//   - estoque atual (escopo Tenente Pena), autonomia, demanda e consumo total
//   - compras EM ABERTO nos dois fluxos (Tenente Pena + Outras Demandas)
//   - contexto de demanda do item na Listagem de Autores (opcional)
//
// Usado pela aba de Rupturas e pelo Comparativo de Autores, para não repetir
// a mesma junção de dois fluxos em cada tela.
// =====================================================================
const db = require('./db');

const STATUS_ABERTO = ['Planejamento', 'Adjucado', 'Empenhado', 'Entrega Parcial'];
const EM_ABERTO_SQL = STATUS_ABERTO.map(() => '?').join(',');

// Escopo Tenente Pena no estoque (linhas sem unidade ou da própria unidade).
const ESCOPO_TP = "(e.unidade IS NULL OR e.unidade LIKE '%Tenente Pena%')";

// Ordem cronológica do mês por extenso, como está gravado no banco.
function ordemMes(col = 'mes') {
  return `CASE ${col}
    WHEN 'Janeiro' THEN 1 WHEN 'Fevereiro' THEN 2 WHEN 'Março' THEN 3 WHEN 'Abril' THEN 4
    WHEN 'Maio' THEN 5 WHEN 'Junho' THEN 6 WHEN 'Julho' THEN 7 WHEN 'Agosto' THEN 8
    WHEN 'Setembro' THEN 9 WHEN 'Outubro' THEN 10 WHEN 'Novembro' THEN 11 WHEN 'Dezembro' THEN 12
  END`;
}

function ultimaData(tabela) {
  const r = db.prepare(`SELECT MAX(data_referencia) AS d FROM ${tabela}`).get();
  return r && r.d ? r.d : null;
}

// Estoque/autonomia/consumo do item na foto mais recente (escopo Tenente Pena).
function estoqueDoItem(codigo) {
  const data = ultimaData('estoque_importacoes');
  if (!data) return { estoque: null, dataEstoque: null };
  const e = db.prepare(`
    SELECT SUM(e.estoque) AS estoque, MAX(e.autonomia) AS autonomia,
           SUM(e.demandas) AS demandas,
           SUM(e.consumo_mensal_total) AS consumoMensalTotal
      FROM estoque_itens e
     WHERE e.codigo_item = ? AND e.data_referencia = ? AND ${ESCOPO_TP}
  `).get(codigo, data);
  return { estoque: e, dataEstoque: data };
}

// Compras EM ABERTO do item, nos dois fluxos, mais recentes primeiro.
function comprasEmAbertoDoItem(codigo) {
  return db.prepare(`
    WITH compras AS (
      SELECT 'TP' AS fluxo, codigo_item, ano, mes, status, n_oficio, n_empenho,
             qtde_solicitada, qtde_entregue, qtde_pendente, data_previsao_entrega
        FROM solicitacoes
      UNION ALL
      SELECT 'OD' AS fluxo, codigo_item, ano, mes, status, n_oficio, n_empenho,
             qtde_solicitada, qtde_entregue, qtde_pendente, data_previsao_entrega
        FROM solicitacoes_od
    )
    SELECT * FROM compras
     WHERE codigo_item = ? AND status IN (${EM_ABERTO_SQL})
     ORDER BY ano DESC, ${ordemMes()} DESC
  `).all(codigo, ...STATUS_ABERTO);
}

// Contexto de demanda do item na Listagem de Autores mais recente. Casa por
// código + protocolo quando o protocolo é informado; senão, só pelo código.
function demandaDoItem(codigo, protocolo) {
  const data = ultimaData('autores_itens');
  if (!data) return null;
  if (protocolo) {
    const comProt = db.prepare(`
      SELECT tipo_demanda, status_demanda, status_item, qtde_consumo,
             dispensacoes, periodicidade, prazo, descricao_item, categoria
        FROM autores_itens
       WHERE data_referencia = ? AND codigo_item = ? AND protocolo = ? LIMIT 1
    `).get(data, codigo, protocolo);
    if (comProt) return comProt;
  }
  return db.prepare(`
    SELECT tipo_demanda, status_demanda, status_item, qtde_consumo,
           dispensacoes, periodicidade, prazo, descricao_item, categoria
      FROM autores_itens
     WHERE data_referencia = ? AND codigo_item = ? LIMIT 1
  `).get(data, codigo);
}

// Junta tudo para o modal.
function detalheItem(codigo, protocolo) {
  const { estoque, dataEstoque } = estoqueDoItem(codigo);
  return {
    codigo,
    estoque,
    dataEstoque,
    compras: comprasEmAbertoDoItem(codigo),
    demanda: demandaDoItem(codigo, protocolo),
  };
}

module.exports = { detalheItem, estoqueDoItem, comprasEmAbertoDoItem, demandaDoItem, STATUS_ABERTO };
