const express = require('express');
const db = require('./db');
const { autenticar } = require('./auth');

const router = express.Router();
router.use(autenticar);

const ORDEM_MES = {
  Janeiro: 1, Fevereiro: 2, Março: 3, Abril: 4, Maio: 5, Junho: 6,
  Julho: 7, Agosto: 8, Setembro: 9, Outubro: 10, Novembro: 11, Dezembro: 12,
};

/**
 * Relatório consolidado: junta TODOS os meses/anos em uma única lista,
 * trazendo apenas solicitações cuja modalidade de compra é diferente de "-"
 * (ou seja, itens que de fato tiveram movimento de compra, não apenas
 * linhas em branco do catálogo).
 *
 * Aceita os mesmos filtros da listagem normal (q, status, ano, mes) para
 * permitir consolidações parciais, mas por padrão devolve a base completa.
 */
router.get('/consolidado', (req, res) => {
  const { q, status, ano, mes, formato } = req.query;

  const condicoes = [
    "s.modalidade_compra IS NOT NULL",
    "TRIM(s.modalidade_compra) != ''",
    "s.modalidade_compra != '-'",
  ];
  const params = [];

  if (q) {
    condicoes.push('(i.descricao LIKE ? OR s.codigo_item LIKE ? OR s.n_oficio LIKE ? OR s.n_empenho LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (status) {
    condicoes.push('s.status = ?');
    params.push(status);
  }
  if (ano) {
    condicoes.push('s.ano = ?');
    params.push(ano);
  }
  if (mes) {
    condicoes.push('s.mes = ?');
    params.push(mes);
  }

  const where = `WHERE ${condicoes.join(' AND ')}`;

  const linhas = db.prepare(`
    SELECT
      i.codigo_item,
      i.codigo_siafisico,
      i.descricao,
      s.ano,
      s.mes,
      s.tipo,
      s.modalidade_compra,
      s.n_oficio,
      s.qtde_solicitada,
      s.data_solicitacao,
      s.requisicao_gsnet,
      s.n_empenho,
      s.quantidade_empenho,
      s.data_previsao_entrega,
      s.data_entrega,
      s.qtde_entregue,
      s.qtde_pendente,
      s.status,
      s.observacao,
      s.justificativa
    FROM solicitacoes s
    JOIN itens i ON s.codigo_item = i.codigo_item
    ${where}
  `).all(...params)
    .sort((a, b) => a.ano - b.ano || ORDEM_MES[a.mes] - ORDEM_MES[b.mes] || a.codigo_item.localeCompare(b.codigo_item));

  // Resumo por mês, útil para conferir o controle mês a mês na mesma resposta
  const resumoPorMes = db.prepare(`
    SELECT s.ano, s.mes, COUNT(*) as qtde
    FROM solicitacoes s
    ${where}
    GROUP BY s.ano, s.mes
  `).all(...params)
    .sort((a, b) => a.ano - b.ano || ORDEM_MES[a.mes] - ORDEM_MES[b.mes]);

  if (formato === 'csv') {
    const cabecalho = [
      'codigo_item', 'codigo_siafisico', 'descricao', 'ano', 'mes', 'tipo',
      'modalidade_compra', 'n_oficio', 'qtde_solicitada', 'data_solicitacao',
      'requisicao_gsnet', 'n_empenho', 'quantidade_empenho', 'data_previsao_entrega',
      'data_entrega', 'qtde_entregue', 'qtde_pendente', 'status', 'observacao', 'justificativa',
    ];
    const escapar = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const csv = [
      cabecalho.join(','),
      ...linhas.map((l) => cabecalho.map((c) => escapar(l[c])).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="relatorio_consolidado.csv"');
    return res.send('\uFEFF' + csv); // BOM para abrir corretamente acentos no Excel
  }

  res.json({ total: linhas.length, resumoPorMes, solicitacoes: linhas });
});

module.exports = router;
