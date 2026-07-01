const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { autenticar, exigirPerfil } = require('./auth');
const { MODULOS, ACOES, ACOES_ROTULO, MODULO_CHAVES } = require('./permissoes');

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

  // Cria as linhas de permissão do novo usuário (não-admin): por padrão só
  // "visualizar" ligado em todos os módulos. O admin ajusta na grade depois.
  if (perfil !== 'admin') {
    const insPerm = db.prepare(
      'INSERT OR IGNORE INTO permissoes (usuario_id, modulo, visualizar) VALUES (?, ?, 1)'
    );
    for (const modulo of MODULO_CHAVES) insPerm.run(info.lastInsertRowid, modulo);
  }

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

// ---------- Catálogo de módulos/ações (para montar a grade na tela) ----------
router.get('/modulos', (req, res) => {
  res.json({ modulos: MODULOS, acoes: ACOES, acoesRotulo: ACOES_ROTULO });
});

// ---------- Lê a grade de permissões de um usuário ----------
router.get('/:id/permissoes', (req, res) => {
  const usuario = db.prepare('SELECT id, nome, email, perfil FROM usuarios WHERE id = ?').get(req.params.id);
  if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado.' });

  const permissoes = {};
  const habilitado = {};
  if (usuario.perfil === 'admin') {
    // Admin é super-usuário: tudo marcado (e a tela mostra como bloqueado).
    for (const m of MODULOS) {
      permissoes[m.chave] = {};
      for (const a of ACOES) permissoes[m.chave][a] = true;
      habilitado[m.chave] = true;
    }
  } else {
    const linhas = db.prepare('SELECT * FROM permissoes WHERE usuario_id = ?').all(usuario.id);
    for (const m of MODULOS) {
      const l = linhas.find((x) => x.modulo === m.chave) || {};
      habilitado[m.chave] = l.habilitado === 1;
      permissoes[m.chave] = {};
      for (const a of ACOES) permissoes[m.chave][a] = l[a] === 1;
    }
  }
  res.json({ usuario, permissoes, habilitado });
});

// ---------- Salva a grade de permissões de um usuário ----------
router.put('/:id/permissoes', (req, res) => {
  const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
  if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado.' });
  if (usuario.perfil === 'admin') {
    return res.status(400).json({ erro: 'Admin é super-usuário: já pode tudo e não usa a grade de permissões.' });
  }

  const entrada = (req.body && req.body.permissoes) || {};
  const entradaHab = (req.body && req.body.habilitado) || {};
  const upsert = db.prepare(`
    INSERT INTO permissoes (usuario_id, modulo, habilitado, visualizar, inserir, editar, excluir, exportar, importar)
    VALUES (@uid, @modulo, @habilitado, @visualizar, @inserir, @editar, @excluir, @exportar, @importar)
    ON CONFLICT(usuario_id, modulo) DO UPDATE SET
      habilitado=@habilitado, visualizar=@visualizar, inserir=@inserir, editar=@editar,
      excluir=@excluir, exportar=@exportar, importar=@importar
  `);

  for (const m of MODULOS) {
    const dados = entrada[m.chave] || {};
    // Se "habilitado" não vier no corpo, assume habilitado (1) para não travar sem querer.
    const linha = { uid: usuario.id, modulo: m.chave, habilitado: (entradaHab[m.chave] === false ? 0 : 1) };
    for (const a of ACOES) {
      // Só liga ações válidas para o módulo; o resto fica 0.
      linha[a] = (m.acoes.includes(a) && dados[a]) ? 1 : 0;
    }
    upsert.run(linha);
  }

  db.prepare(
    'INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.usuario.id, req.usuario.email, 'editar_permissoes', 'permissoes', usuario.id, JSON.stringify(entrada));

  res.json({ ok: true });
});

module.exports = router;
