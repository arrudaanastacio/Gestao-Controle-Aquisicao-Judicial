const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'troque-este-segredo-em-producao';

function gerarToken(usuario) {
  return jwt.sign(
    { id: usuario.id, nome: usuario.nome, email: usuario.email, perfil: usuario.perfil },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}

// Corte global de sessões: tokens emitidos ANTES deste instante (em segundos
// unix) são rejeitados. Um admin pode "derrubar" todas as sessões definindo o
// corte para agora — usado ao subir uma atualização. Persistido em
// configuracoes (chave 'sessoes_validas_apos') e mantido em memória.
let corteSessoes = 0;
let corteCarregado = false;

function carregarCorteSessoes() {
  try {
    const db = require('./db');
    const r = db.prepare("SELECT valor FROM configuracoes WHERE chave = 'sessoes_validas_apos'").get();
    corteSessoes = r && r.valor ? Number(r.valor) || 0 : 0;
    corteCarregado = true;
  } catch (_) { /* banco ainda não pronto; tenta de novo na próxima requisição */ }
}

function definirCorteSessoes(tsSegundos) {
  corteSessoes = Number(tsSegundos) || 0;
  corteCarregado = true;
  const db = require('./db');
  const existe = db.prepare("SELECT 1 FROM configuracoes WHERE chave = 'sessoes_validas_apos'").get();
  if (existe) db.prepare("UPDATE configuracoes SET valor = ? WHERE chave = 'sessoes_validas_apos'").run(String(corteSessoes));
  else db.prepare("INSERT INTO configuracoes (chave, valor) VALUES ('sessoes_validas_apos', ?)").run(String(corteSessoes));
}

function autenticar(req, res, next) {
  const token = req.cookies?.token;
  if (!token) {
    return res.status(401).json({ erro: 'Não autenticado. Faça login.' });
  }
  try {
    req.usuario = jwt.verify(token, JWT_SECRET);
    // Sessão derrubada por atualização? (token anterior ao corte global)
    if (!corteCarregado) carregarCorteSessoes();
    if (corteSessoes && req.usuario.iat && req.usuario.iat < corteSessoes) {
      return res.status(401).json({ erro: 'Sessão encerrada por atualização do sistema. Faça login novamente.' });
    }
    // Registra a última atividade (para o painel mostrar quem está online).
    // Em bloco protegido: se falhar, não pode derrubar a autenticação.
    try {
      const db = require('./db');
      db.prepare('UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?')
        .run(new Date().toISOString(), req.usuario.id);
    } catch (_) { /* silencioso */ }
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

// Como exigirModulo, mas o módulo é descoberto a partir da própria requisição
// (query/sub-caminho). Usado quando uma única rota de dados atende mais de
// uma tela do menu (ex.: /api/estoque atende Estoque TP e Itens em Estoque
// Geral, diferenciados por ?escopoUnidade=). `resolver(req)` deve devolver a
// chave do módulo (uma das listadas em permissoes.js).
function exigirModuloDinamico(resolver) {
  const db = require('./db');
  return (req, res, next) => {
    if (!req.usuario) {
      return res.status(401).json({ erro: 'Não autenticado. Faça login.' });
    }
    if (req.usuario.perfil === 'admin') return next();

    // O resolver pode devolver UM módulo ou uma LISTA de módulos aceitáveis
    // (para endpoints compartilhados por mais de uma tela). Passa se o usuário
    // tiver a ação habilitada em QUALQUER um deles.
    const modulos = [].concat(resolver(req)).filter(Boolean);
    const acao = acaoDaRequisicao(req);
    const temAlgum = modulos.some((modulo) => {
      const perm = db.prepare(
        'SELECT * FROM permissoes WHERE usuario_id = ? AND modulo = ?'
      ).get(req.usuario.id, modulo);
      return perm && perm.habilitado === 1 && perm[acao] === 1;
    });

    if (temAlgum) return next();

    return res.status(403).json({
      erro: 'Você não tem permissão para esta ação neste módulo.',
    });
  };
}

module.exports = { gerarToken, autenticar, exigirPerfil, exigirModulo, exigirModuloDinamico, acaoDaRequisicao, definirCorteSessoes, carregarCorteSessoes, JWT_SECRET };
