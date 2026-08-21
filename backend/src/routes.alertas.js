const express = require('express');
const db = require('./db');
const { autenticar, exigirPerfil } = require('./auth');

const router = express.Router();
router.use(autenticar);

router.get('/', (req, res) => {
  const { resolvido } = req.query;
  let where = '';
  const params = [];
  if (resolvido === 'false') where = 'WHERE resolvido = 0';
  if (resolvido === 'true') where = 'WHERE resolvido = 1';

  // A categoria não fica na tabela de alertas — vem do item no estoque mais
  // recente (escopo Tenente Pena). Usada para o filtro de categoria na tela.
  const alertas = db.prepare(`
    SELECT a.*,
      (SELECT e.categoria FROM estoque_itens e
        WHERE e.codigo_item = a.codigo_item
          AND (e.unidade IS NULL OR e.unidade LIKE '%Tenente Pena%')
          AND e.categoria IS NOT NULL AND e.categoria <> ''
        ORDER BY e.data_referencia DESC LIMIT 1) AS categoria
    FROM alertas a ${where} ORDER BY a.criado_em DESC
  `).all(...params);
  const totalAbertos = db.prepare('SELECT COUNT(*) c FROM alertas WHERE resolvido = 0').get().c;

  res.json({ alertas, totalAbertos });
});

// Relatório do alerta "siafísico duplicado": itens do Estoque Tenente Pena
// (foto mais recente) com DEMANDA ATIVA cujo siafísico aparece em mais de um
// código de item. Colunas: código, siafísico, descrição, unidade, demandas,
// consumo mensal total, estoque, autonomia.
router.get('/siafisico-duplicado', (req, res) => {
  const d = db.prepare('SELECT MAX(data_referencia) v FROM estoque_itens').get()?.v || null;
  if (!d) return res.json({ dataReferencia: null, total: 0, itens: [] });
  const tp = "(e.unidade IS NULL OR e.unidade LIKE '%Tenente Pena%')";
  const sia = (req.query.siafisico || '').trim();
  const cond = [`e.data_referencia = ?`, tp, 'e.demandas > 0', "e.siafisico IS NOT NULL", "e.siafisico <> ''"];
  const params = [d];
  if (sia) {
    // Um siafísico específico (modal do alerta): mostra os itens dele.
    cond.push('e.siafisico = ?');
    params.push(sia);
  } else {
    // Todos os siafísicos duplicados (relatório geral).
    cond.push(`e.siafisico IN (
      SELECT siafisico FROM estoque_itens
       WHERE data_referencia = ? AND (unidade IS NULL OR unidade LIKE '%Tenente Pena%')
         AND demandas > 0 AND siafisico IS NOT NULL AND siafisico <> ''
       GROUP BY siafisico HAVING COUNT(DISTINCT codigo_item) > 1)`);
    params.push(d);
  }
  const itens = db.prepare(`
    SELECT e.codigo_item, e.siafisico, e.descricao, e.unidade,
           e.demandas, e.consumo_mensal_total, e.estoque, e.autonomia
      FROM estoque_itens e
     WHERE ${cond.join(' AND ')}
     ORDER BY e.siafisico ASC, e.codigo_item ASC
  `).all(...params);
  const siafisicos = new Set(itens.map((i) => i.siafisico)).size;
  res.json({ dataReferencia: d, total: itens.length, siafisicos, itens });
});

router.put('/:id/resolver', (req, res) => {
  const { id } = req.params;
  const atual = db.prepare('SELECT * FROM alertas WHERE id = ?').get(id);
  if (!atual) return res.status(404).json({ erro: 'Alerta não encontrado.' });

  db.prepare(
    "UPDATE alertas SET resolvido = 1, resolvido_por = ?, resolvido_em = datetime('now') WHERE id = ?"
  ).run(req.usuario.email, id);

  res.json({ ok: true });
});

module.exports = router;
