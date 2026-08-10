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

// ---------- Convite por e-mail: criar a própria senha (rotas públicas) ----------
// Valida o token e devolve os dados básicos para a tela mostrar "Olá, Fulano".
router.get('/convite/:token', (req, res) => {
  const usuario = db.prepare(
    'SELECT nome, email, token_expira FROM usuarios WHERE token_convite = ? AND ativo = 1'
  ).get(req.params.token);
  if (!usuario) return res.status(404).json({ erro: 'Convite inválido ou já utilizado.' });
  if (usuario.token_expira && new Date(usuario.token_expira) < new Date()) {
    return res.status(410).json({ erro: 'Convite expirado. Peça ao administrador para reenviar.' });
  }
  res.json({ nome: usuario.nome, email: usuario.email });
});

// Define a senha a partir de um token válido e queima o token (uso único).
router.post('/convite/definir-senha', (req, res) => {
  const { token, senha } = req.body || {};
  if (!token || !senha) return res.status(400).json({ erro: 'Informe o token e a nova senha.' });
  if (String(senha).length < 6) {
    return res.status(400).json({ erro: 'A senha deve ter pelo menos 6 caracteres.' });
  }

  const usuario = db.prepare(
    'SELECT * FROM usuarios WHERE token_convite = ? AND ativo = 1'
  ).get(token);
  if (!usuario) return res.status(404).json({ erro: 'Convite inválido ou já utilizado.' });
  if (usuario.token_expira && new Date(usuario.token_expira) < new Date()) {
    return res.status(410).json({ erro: 'Convite expirado. Peça ao administrador para reenviar.' });
  }

  const senhaHash = bcrypt.hashSync(senha, 10);
  db.prepare('UPDATE usuarios SET senha_hash = ?, token_convite = NULL, token_expira = NULL WHERE id = ?')
    .run(senhaHash, usuario.id);

  db.prepare(
    'INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(usuario.id, usuario.email, 'definir_senha_convite', 'usuarios', usuario.id, JSON.stringify({ via: 'convite' }));

  res.json({ ok: true, email: usuario.email });
});

router.get('/me', autenticar, (req, res) => {
  // Junta as permissões por módulo para o frontend decidir o que mostrar.
  // Admin é super-usuário: marcamos tudo como permitido.
  const { MODULOS, ACOES } = require('./permissoes');
  const permissoes = {};
  const habilitado = {};
  if (req.usuario.perfil === 'admin') {
    for (const m of MODULOS) {
      permissoes[m.chave] = {};
      for (const a of ACOES) permissoes[m.chave][a] = true;
      habilitado[m.chave] = true;
    }
  } else {
    const linhas = db.prepare('SELECT * FROM permissoes WHERE usuario_id = ?').all(req.usuario.id);
    for (const m of MODULOS) {
      const l = linhas.find((x) => x.modulo === m.chave) || {};
      habilitado[m.chave] = l.habilitado === 1;
      permissoes[m.chave] = {};
      for (const a of ACOES) permissoes[m.chave][a] = l[a] === 1;
    }
  }
  res.json({ usuario: { ...req.usuario, permissoes, habilitado } });
});

module.exports = router;
