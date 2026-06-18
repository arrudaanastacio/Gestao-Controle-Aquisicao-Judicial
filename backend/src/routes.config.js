const express = require('express');
const db = require('./db');
const { autenticar, exigirPerfil } = require('./auth');

const router = express.Router();
router.use(autenticar);

router.get('/', (req, res) => {
  const linhas = db.prepare('SELECT chave, valor FROM configuracoes').all();
  const config = {};
  for (const l of linhas) config[l.chave] = l.valor;
  res.json({ config });
});

router.put('/:chave', exigirPerfil('admin'), (req, res) => {
  const { chave } = req.params;
  const { valor } = req.body || {};
  if (valor === undefined || valor === null || String(valor).trim() === '') {
    return res.status(400).json({ erro: 'Informe um valor.' });
  }

  const permitidas = ['autonomia_minima_meses'];
  if (!permitidas.includes(chave)) {
    return res.status(400).json({ erro: 'Configuração não reconhecida.' });
  }

  db.prepare('INSERT INTO configuracoes (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor')
    .run(chave, String(valor));

  res.json({ ok: true, chave, valor: String(valor) });
});

module.exports = router;
