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

  const alertas = db.prepare(`SELECT * FROM alertas ${where} ORDER BY criado_em DESC`).all(...params);
  const totalAbertos = db.prepare('SELECT COUNT(*) c FROM alertas WHERE resolvido = 0').get().c;

  res.json({ alertas, totalAbertos });
});

router.put('/:id/resolver', exigirPerfil('admin'), (req, res) => {
  const { id } = req.params;
  const atual = db.prepare('SELECT * FROM alertas WHERE id = ?').get(id);
  if (!atual) return res.status(404).json({ erro: 'Alerta não encontrado.' });

  db.prepare(
    "UPDATE alertas SET resolvido = 1, resolvido_por = ?, resolvido_em = datetime('now') WHERE id = ?"
  ).run(req.usuario.email, id);

  res.json({ ok: true });
});

module.exports = router;
