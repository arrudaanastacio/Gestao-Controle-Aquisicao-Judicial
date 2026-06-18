const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { gerarToken, autenticar } = require('./auth');

const router = express.Router();
const isProd = process.env.NODE_ENV === 'production';

router.post('/login', (req, res) => {
  const { email, senha } = req.body || {};
  if (!email || !senha) {
    return res.status(400).json({ erro: 'Informe e-mail e senha.' });
  }

  const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ? AND ativo = 1').get(email);
  if (!usuario || !bcrypt.compareSync(senha, usuario.senha_hash)) {
    return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
  }

  const token = gerarToken(usuario);
  // O cookie só recebe a flag Secure quando a conexão é realmente HTTPS.
  // Em acesso local via http://IP:3000 (sem HTTPS), Secure faria o navegador
  // descartar o cookie e a sessão nunca persistiria. Detectamos o protocolo
  // real da requisição (considerando proxy/túnel via X-Forwarded-Proto).
  const conexaoHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: conexaoHttps,
    maxAge: 8 * 60 * 60 * 1000,
  });

  res.json({
    usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, perfil: usuario.perfil },
  });
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

router.get('/me', autenticar, (req, res) => {
  res.json({ usuario: req.usuario });
});

module.exports = router;
