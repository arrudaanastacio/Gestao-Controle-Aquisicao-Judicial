const express = require('express');
const crypto = require('crypto');
const os = require('os');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { autenticar, exigirPerfil } = require('./auth');
const { enviarConviteAcesso } = require('./emailAlerta');
const { MODULOS, ACOES, ACOES_ROTULO, MODULO_CHAVES } = require('./permissoes');

const router = express.Router();

const VALIDADE_CONVITE_HORAS = 48;

// Gera um token de convite (aleatório, uso único) e a data de expiração.
function novoTokenConvite() {
  const token = crypto.randomBytes(24).toString('hex');
  const expira = new Date(Date.now() + VALIDADE_CONVITE_HORAS * 60 * 60 * 1000).toISOString();
  return { token, expira };
}

// Descobre o IPv4 da máquina na rede local (ex.: 192.168.x.x). Prefere as
// faixas privadas comuns e ignora adaptadores virtuais/internos quando possível.
function ipLanDaMaquina() {
  const candidatos = [];
  const ifaces = os.networkInterfaces();
  for (const nome of Object.keys(ifaces)) {
    for (const ni of ifaces[nome] || []) {
      if (ni.family === 'IPv4' && !ni.internal) candidatos.push(ni.address);
    }
  }
  // Prioriza 192.168.*, depois 10.*, depois 172.16-31.*, senão o primeiro que houver.
  return (
    candidatos.find((ip) => ip.startsWith('192.168.')) ||
    candidatos.find((ip) => ip.startsWith('10.')) ||
    candidatos.find((ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) ||
    candidatos[0] ||
    null
  );
}

// Monta o link de definição de senha. O colega acessa pelo IP da máquina, então
// o link NUNCA pode sair como "localhost". Ordem de decisão:
//   1) SISTEMA_URL_BASE no .env (ideal; serve também p/ túnel externo no futuro);
//   2) se o admin abriu por localhost/127.0.0.1, troca pelo IP da máquina na rede;
//   3) senão, usa o próprio host da requisição.
function montarLinkConvite(req, token) {
  const base = (process.env.SISTEMA_URL_BASE || '').trim().replace(/\/+$/, '');
  if (base) return `${base}/definir-senha.html?token=${token}`;

  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  let host = req.get('host') || '';
  const ehLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
  if (ehLocal) {
    const ip = ipLanDaMaquina();
    if (ip) {
      const porta = host.split(':')[1] || process.env.PORT || '3000';
      host = `${ip}:${porta}`;
    }
  }
  return `${proto}://${host}/definir-senha.html?token=${token}`;
}

router.use(autenticar, exigirPerfil('admin'));

router.get('/', (req, res) => {
  const usuarios = db.prepare(
    `SELECT id, nome, email, perfil, ativo, criado_em, ultimo_acesso,
            CASE WHEN (senha_hash IS NULL OR senha_hash = '') AND token_convite IS NOT NULL THEN 1 ELSE 0 END AS pendente
     FROM usuarios ORDER BY nome`
  ).all();
  res.json({ usuarios });
});

router.post('/', async (req, res) => {
  const { nome, email, senha, perfil, modo } = req.body || {};
  // modo = 'convite' (envia e-mail p/ o colega criar a senha) ou 'senha' (admin define agora).
  const usarConvite = modo === 'convite';

  if (!nome || !email || !['admin', 'consulta'].includes(perfil)) {
    return res.status(400).json({ erro: 'Dados inválidos. Informe nome, e-mail e perfil (admin|consulta).' });
  }
  if (!usarConvite && !senha) {
    return res.status(400).json({ erro: 'Informe a senha ou escolha enviar convite por e-mail.' });
  }

  const existente = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
  if (existente) {
    return res.status(409).json({ erro: 'Já existe um usuário com este e-mail.' });
  }

  // No convite: senha_hash fica vazio (login nunca casa) até o colega criar a senha.
  const senhaHash = usarConvite ? '' : bcrypt.hashSync(senha, 10);
  const convite = usarConvite ? novoTokenConvite() : null;

  const info = db.prepare(
    'INSERT INTO usuarios (nome, email, senha_hash, perfil, token_convite, token_expira) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(nome, email, senhaHash, perfil, convite ? convite.token : null, convite ? convite.expira : null);

  // Cria as linhas de permissão do novo usuário (não-admin) TODAS EM BRANCO:
  // módulo desabilitado e nenhuma ação marcada. O usuário não enxerga nada até
  // o admin abrir "Permissões" e habilitar o que ele deve ver.
  if (perfil !== 'admin') {
    const insPerm = db.prepare(
      'INSERT OR IGNORE INTO permissoes (usuario_id, modulo, habilitado, visualizar) VALUES (?, ?, 0, 0)'
    );
    for (const modulo of MODULO_CHAVES) insPerm.run(info.lastInsertRowid, modulo);
  }

  db.prepare(
    'INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.usuario.id, req.usuario.email, 'criar_usuario', 'usuarios', info.lastInsertRowid, JSON.stringify({ nome, email, perfil, modo: usarConvite ? 'convite' : 'senha' }));

  // Modo senha: pronto.
  if (!usarConvite) return res.status(201).json({ id: info.lastInsertRowid, modo: 'senha' });

  // Modo convite: tenta enviar o e-mail. Se falhar, o usuário JÁ foi criado com
  // token — devolvemos o link para o admin copiar manualmente e avisamos o erro.
  const link = montarLinkConvite(req, convite.token);
  try {
    await enviarConviteAcesso({ nome, email, link, validadeHoras: VALIDADE_CONVITE_HORAS });
    res.status(201).json({ id: info.lastInsertRowid, modo: 'convite', emailEnviado: true });
  } catch (e) {
    console.error('[CONVITE] Falha ao enviar e-mail:', e.message);
    res.status(201).json({ id: info.lastInsertRowid, modo: 'convite', emailEnviado: false, erroEmail: e.message, link });
  }
});

// Reenvia o convite (gera token novo) para um usuário que ainda não criou senha.
router.post('/:id/reenviar-convite', async (req, res) => {
  const usuario = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.params.id);
  if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado.' });
  if (usuario.senha_hash) {
    return res.status(400).json({ erro: 'Este usuário já criou a senha. Use "editar" para redefinir, se necessário.' });
  }

  const convite = novoTokenConvite();
  db.prepare('UPDATE usuarios SET token_convite = ?, token_expira = ? WHERE id = ?')
    .run(convite.token, convite.expira, usuario.id);

  const link = montarLinkConvite(req, convite.token);
  try {
    await enviarConviteAcesso({ nome: usuario.nome, email: usuario.email, link, validadeHoras: VALIDADE_CONVITE_HORAS });
    res.json({ ok: true, emailEnviado: true });
  } catch (e) {
    console.error('[CONVITE] Falha ao reenviar e-mail:', e.message);
    res.json({ ok: true, emailEnviado: false, erroEmail: e.message, link });
  }
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
