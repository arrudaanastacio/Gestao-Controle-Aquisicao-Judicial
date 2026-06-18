const express = require('express');
const db = require('./db');
const { autenticar } = require('./auth');

const router = express.Router();
router.use(autenticar);

// Lista/busca itens do catálogo (todos os perfis podem consultar)
router.get('/', (req, res) => {
  const { q, page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  let where = '';
  let params = [];
  if (q) {
    where = 'WHERE descricao LIKE ? OR codigo_item LIKE ? OR codigo_siafisico LIKE ?';
    const like = `%${q}%`;
    params = [like, like, like];
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM itens ${where}`).get(...params).c;
  const itens = db.prepare(
    `SELECT * FROM itens ${where} ORDER BY descricao LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  res.json({ itens, total, page: Number(page), pageSize: limit });
});

router.get('/:codigo', (req, res) => {
  const item = db.prepare('SELECT * FROM itens WHERE codigo_item = ?').get(req.params.codigo);
  if (!item) return res.status(404).json({ erro: 'Item não encontrado.' });
  res.json({ item });
});

module.exports = router;
