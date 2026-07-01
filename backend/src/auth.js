const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'troque-este-segredo-em-producao';

function gerarToken(usuario) {
  return jwt.sign(
    { id: usuario.id, nome: usuario.nome, email: usuario.email, perfil: usuario.perfil },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}

function autenticar(req, res, next) {
  const token = req.cookies?.token;
  if (!token) {
    return res.status(401).json({ erro: 'Não autenticado. Faça login.' });
  }
  try {
    req.usuario = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ erro: 'Sessão expirada ou inválida. Faça login novamente.' });
  }
}

function exigirPerfil(...perfis) {
  return (req, res, next) => {
    if (!req.usuario || !perfis.includes(req.usuario.perfil)) {
      return res.status(403).json({ erro: 'Você não tem permissão para esta ação.' });
    }
    next();
  };
}

// Descobre qual AÇÃO (visualizar/inserir/editar/excluir/exportar/importar) a
// requisição representa, a partir do método HTTP e do caminho. Centralizar isso
// evita ter que anotar permissão em cada rota uma a uma.
function acaoDaRequisicao(req) {
  const caminho = (req.path || '').toLowerCase();
  const metodo = req.method;
  if (metodo === 'GET') {
    if (caminho.includes('csv') || caminho.includes('export')) return 'exportar';
    return 'visualizar';
  }
  if (metodo === 'POST') {
    if (caminho.includes('import')) return 'importar';
    return 'inserir';
  }
  if (metodo === 'PUT' || metodo === 'PATCH') {
    if (caminho.includes('cancel') || caminho.includes('excluir') || caminho.includes('remover')) {
      return 'excluir';
    }
    return 'editar';
  }
  if (metodo === 'DELETE') return 'excluir';
  return 'visualizar';
}

// Trava de acesso por MÓDULO. Usado em server.js ao montar cada rota de dados.
// Regras: admin sempre passa; demais usuários precisam ter a ação marcada na
// tabela permissoes para aquele módulo.
function exigirModulo(modulo) {
  const db = require('./db');
  return (req, res, next) => {
    if (!req.usuario) {
      return res.status(401).json({ erro: 'Não autenticado. Faça login.' });
    }
    if (req.usuario.perfil === 'admin') return next();

    const acao = acaoDaRequisicao(req);
    const perm = db.prepare(
      'SELECT * FROM permissoes WHERE usuario_id = ? AND modulo = ?'
    ).get(req.usuario.id, modulo);

    // Precisa do módulo habilitado E da ação específica marcada.
    if (perm && perm.habilitado === 1 && perm[acao] === 1) return next();

    return res.status(403).json({
      erro: 'Você não tem permissão para esta ação neste módulo.',
    });
  };
}

module.exports = { gerarToken, autenticar, exigirPerfil, exigirModulo, acaoDaRequisicao, JWT_SECRET };
