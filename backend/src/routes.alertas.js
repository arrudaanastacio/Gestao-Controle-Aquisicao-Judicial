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
