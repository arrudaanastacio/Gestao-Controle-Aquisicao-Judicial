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

module.exports = { gerarToken, autenticar, exigirPerfil, JWT_SECRET };
