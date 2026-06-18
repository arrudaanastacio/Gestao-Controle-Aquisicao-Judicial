const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { autenticar, exigirPerfil } = require('./auth');

const router = express.Router();

router.use(autenticar, exigirPerfil('admin'));

router.get('/', (req, res) => {
  const usuarios = db.prepare(
    'SELECT id, nome, email, perfil, ativo, criado_em FROM usuarios ORDER BY nome'
  ).all();
  res.json({ usuarios });
});

router.post('/', (req, res) => {
  const { nome, email, senha, perfil } = req.body || {};
  if (!nome || !email || !senha || !['admin', 'consulta'].includes(perfil)) {
    return res.status(400).json({ erro: 'Dados inválidos. Informe nome, e-mail, senha e perfil (admin|consulta).' });
  }

  const existente = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
  if (existente) {
    return res.status(409).json({ erro: 'Já existe um usuário com este e-mail.' });
  }

  const senhaHash = bcrypt.hashSync(senha, 10);
  const info = db.prepare(
    'INSERT INTO usuarios (nome, email, senha_hash, perfil) VALUES (?, ?, ?, ?)'
  ).run(nome, email, senhaHash, perfil);

  db.prepare(
    'INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.usuario.id, req.usuario.email, 'criar_usuario', 'usuarios', info.lastInsertRowid, JSON.stringify({ nome, email, perfil }));

  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { nome, perfil, ativo, senha } = req.body || {};

  const atual = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
  if (!atual) return res.status(404).json({ erro: 'Usuário não encontrado.' });

  const novoNome = nome ?? atual.nome;
  const novoPerfil = perfil ?? atual.perfil;
  const novoAtivo = ativo === undefined ? atual.ativo : (ativo ? 1 : 0);

  if (senha) {
    const senhaHash = bcrypt.hashSync(senha, 10);
    db.prepare('UPDATE usuarios SET nome = ?, perfil = ?, ativo = ?, senha_hash = ? WHERE id = ?')
      .run(novoNome, novoPerfil, novoAtivo, senhaHash, id);
  } else {
    db.prepare('UPDATE usuarios SET nome = ?, perfil = ?, ativo = ? WHERE id = ?')
      .run(novoNome, novoPerfil, novoAtivo, id);
  }

  db.prepare(
    'INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_antes, dados_depois) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.usuario.id, req.usuario.email, 'editar_usuario', 'usuarios', id, JSON.stringify(atual), JSON.stringify({ novoNome, novoPerfil, novoAtivo }));

  res.json({ ok: true });
});

module.exports = router;
