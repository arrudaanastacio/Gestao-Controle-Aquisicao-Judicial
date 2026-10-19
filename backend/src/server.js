require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

// =====================================================================
// REDE DE SEGURANÇA GLOBAL contra quedas do servidor.
//
// Por que isto existe: o app roda MUITOS processos de fundo (vigias de
// arquivos na rede, agendador Oracle, backup). No Node 15+, um erro
// assíncrono que escape sem tratamento (uncaughtException) ou uma promessa
// rejeitada sem .catch() (unhandledRejection) ENCERRA o processo inteiro —
// e, sem laço de reinício, o sistema simplesmente "cai". Aqui a gente:
//   1) GRAVA o erro num arquivo com data/hora (para achar a causa raiz), e
//   2) MANTÉM o servidor de pé (prioriza disponibilidade — é ferramenta
//      interna de rede; "no ar degradado" é melhor que "fora do ar").
// O laço de reinício na .bat cuida do caso extremo em que o processo
// realmente morra por outro motivo.
// =====================================================================
const CAMINHO_LOG_FATAL = path.join(__dirname, '..', 'erros-fatais.log');
function registrarErroFatal(tipo, err) {
  const quando = new Date().toISOString();
  const detalhe = (err && err.stack) || (err && err.message) || String(err);
  const linha = `\n[${quando}] ${tipo}\n${detalhe}\n`;
  try { fs.appendFileSync(CAMINHO_LOG_FATAL, linha); } catch (_) {}
  try { console.error(`[ERRO FATAL CONTIDO] ${tipo}:`, detalhe); } catch (_) {}
}
process.on('unhandledRejection', (motivo) => registrarErroFatal('unhandledRejection', motivo));
process.on('uncaughtException', (err) => registrarErroFatal('uncaughtException', err));

// Versão do sistema: lida do arquivo VERSION na raiz do projeto.
let VERSAO = '—';
try {
  VERSAO = fs.readFileSync(path.join(__dirname, '..', '..', 'VERSION'), 'utf8').trim() || '—';
} catch (_) {}

const authRoutes = require('./routes.auth');
const usuariosRoutes = require('./routes.usuarios');
const itensRoutes = require('./routes.itens');
const solicitacoesRoutes = require('./routes.solicitacoes');
const relatoriosRoutes = require('./routes.relatorios');
const elencoRoutes = require('./routes.elenco');
const importarSolicitacoesRoutes = require('./routes.importarSolicitacoes');
const alertasRoutes = require('./routes.alertas');
const estoqueRoutes = require('./routes.estoque');
const autoresRoutes = require('./routes.autores');
const relatorioItensRoutes = require('./routes.relatorioItens');
const atasRoutes = require('./routes.atas');
const estoqueODRoutes = require('./routes.estoqueOD');
const solicitacoesODRoutes = require('./routes.solicitacoesOD');
const entradaLotesRoutes = require('./routes.entradaLotes');
const saidaLotesRoutes = require('./routes.saidaLotes');
const importacoesInfoRoutes = require('./routes.importacoesInfo');
const distribuicaoRoutes = require('./routes.distribuicao');
const reservasRoutes = require('./routes.reservas');
const rupturasRoutes = require('./routes.rupturas');
const configRoutes = require('./routes.config');
const { autenticar, exigirModulo, exigirModuloDinamico, exigirPerfil, liberarOracle } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Cabeçalhos de segurança (helmet) ---------------------------------------
// Liga as proteções de cabeçalho (X-Content-Type-Options, X-Frame-Options,
// Referrer-Policy, etc.). Dois recursos ficam DESLIGADOS de propósito por ora:
//   • contentSecurityPolicy: a interface usa muitos estilos inline; uma CSP
//     estrita quebraria a tela. Endurecer a CSP é tarefa futura (precisa
//     revisar o frontend).
//   • hsts: só faz sentido sob HTTPS (ainda rodamos em HTTP na rede). Ligar
//     agora poderia "fixar" HTTPS no navegador antes de termos TLS. Liga na
//     onda de transporte (TLS).
const helmet = require('helmet');
app.use(helmet({ contentSecurityPolicy: false, hsts: false }));

// --- Freio contra força-bruta no login --------------------------------------
// Limita tentativas por IP numa janela de tempo. Aplicado SÓ aos endpoints
// sensíveis (login e definição de senha por convite) — não afeta o uso normal
// do sistema. Valor folgado para não atrapalhar quem erra a senha algumas vezes.
const rateLimit = require('express-rate-limit');
const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutos
  limit: 20,                  // até 20 tentativas por IP na janela
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' },
});

// Limite ampliado: salvar um planejamento envia todas as linhas (milhares de
// itens) num único JSON, o que passa do padrão de 100kb do Express.
app.use(express.json({ limit: '25mb' }));
app.use(cookieParser());

// O freio precisa vir ANTES do mount de /api/auth para interceptar o login.
app.use('/api/auth/login', limiteLogin);
app.use('/api/auth/convite/definir-senha', limiteLogin);

// Informa o ambiente (produção/homologação) e a versão. Público de propósito:
// o frontend usa para mostrar o selo "HOMOLOGAÇÃO" mesmo na tela de login.
// Em produção (NODE_ENV=production) a faixa não aparece.
app.get('/api/ambiente', (req, res) => {
  res.json({ ambiente: process.env.NODE_ENV || 'producao', versao: VERSAO });
});

// Rotas sem trava de módulo (autenticação/admin tratada dentro do próprio arquivo)
app.use('/api/auth', authRoutes);
app.use('/api/usuarios', usuariosRoutes);   // só admin (guarda interna)
app.use('/api/itens', itensRoutes);         // consulta de apoio do catálogo
app.use('/api/config', configRoutes);       // leitura aberta, escrita só admin
app.use('/api/sigem', require('./routes.integracaoSigem')); // integração SIGEM (chave de API própria, sem login JWT)
app.use('/api/importacoes', autenticar, importacoesInfoRoutes); // só data/hora, sem trava de módulo

// Rotas de dados: travadas por MÓDULO. A ação (ver/inserir/editar/excluir/
// exportar/importar) é deduzida do método+caminho em auth.js. Admin passa sempre.
//
// Um módulo por TELA do menu (13/07/2026): quando uma única rota atende
// mais de uma tela (ex.: /api/estoque atende Estoque TP e Itens em Estoque
// Geral), usa-se exigirModuloDinamico para escolher o módulo certo a partir
// do próprio pedido (query ou sub-caminho) — sem precisar duplicar rota.
app.use('/api/solicitacoes', autenticar, exigirModulo('tabelaAnaliseTP'), solicitacoesRoutes);
app.use('/api/relatorios', autenticar, exigirModulo('relatorioComprasTP'), relatoriosRoutes);
app.use('/api/importar-solicitacoes', autenticar, exigirModulo('tabelaAnaliseTP'), importarSolicitacoesRoutes);
app.use('/api/elenco', autenticar, exigirModulo('elenco'), elencoRoutes);
app.use('/api/alertas', autenticar, exigirModulo('alertas'), alertasRoutes);

// /api/estoque atende 4 telas: Estoque TP (padrão), Itens em Estoque Geral
// (?escopoUnidade=geral), Consultar Validades TP (/validades), Histórico de
// Estoque (/historico...) e Evolução de Estoque (/evolucao).
app.use('/api/estoque', autenticar, liberarOracle(exigirModuloDinamico((req) => {
  if (req.path.startsWith('/monitoramento')) return 'monitoramentoEstoque';
  if (req.query.escopoUnidade === 'geral') return 'estoqueGeral';
  if (req.path.startsWith('/validades')) return 'validadesTP';
  if (req.path.startsWith('/historico')) return 'historicoEstoqueTP';
  if (req.path.startsWith('/evolucao')) return 'evolucaoEstoqueTP';
  return 'estoqueTP';
})), estoqueRoutes);

// /api/autores atende 4 telas: Listagem de Autores TP (padrão), Listagem de
// Autores Demais Unidades (?escopoUnidade=geral), Relatório de Primeiro
// Atendimento (/requisicoes) e Comparativo de Autores (/comparacao).
app.use('/api/autores', autenticar, liberarOracle(exigirModuloDinamico((req) => {
  if (req.query.escopoUnidade === 'geral') return 'autoresGeral';
  // Detalhe do item (estoque/consumo/autonomia) é compartilhado: usado tanto no
  // Comparativo de Autores quanto no modal do Relatório de Primeiro Atendimento.
  // Libera para quem tiver acesso a QUALQUER uma dessas duas telas.
  if (req.path.startsWith('/comparacao/item-detalhe')) return ['comparativoAutoresTP', 'relatorioReqTP'];
  if (req.path.startsWith('/requisicoes')) return 'relatorioReqTP';
  if (req.path.startsWith('/comparacao')) return 'comparativoAutoresTP';
  return 'autoresTP';
})), autoresRoutes);

app.use('/api/itens-importados', autenticar, exigirModulo('relatorioItensImportados'), require('./routes.itensImportados'));
app.use('/api/consumo-entrega', autenticar, liberarOracle(exigirModulo('consumoEntrega')), require('./routes.consumoEntrega'));
app.use('/api/conciliacao', autenticar, exigirModuloDinamico((req) => {
  if (req.path.startsWith('/empenho')) return 'roboEmpenhos';
  if (req.path.startsWith('/entrada')) return 'associarEntrada';
  return ['associarEntrada', 'roboEmpenhos']; // /auditoria e /desfazer: qualquer um
}), require('./routes.conciliacao'));
app.use('/api/relatorio-itens', autenticar, liberarOracle(exigirModulo('relatorioItens')), relatorioItensRoutes);
app.use('/api/atas', autenticar, exigirModulo('atas'), atasRoutes);
app.use('/api/planejamento', autenticar, exigirModulo('planejamento'), require('./routes.planejamento'));
app.use('/api/cartas-troca', autenticar, exigirModulo('cartasTroca'), require('./routes.cartasTroca'));
app.use('/api/estoque-od', autenticar, exigirModulo('estoqueOD'), estoqueODRoutes);
app.use('/api/ibl', autenticar, exigirModulo('estoqueIblApi'), require('./routes.ibl'));
// Saldo IBL (Outras Demandas) por item — enriquecimento leve dos modais "Ver"
// de Estoque TP, Estoque Geral e Listagem de Autores. Sem trava de módulo.
app.use('/api/ibl-item', autenticar, require('./routes.iblItem'));

// /api/solicitacoes-od atende 2 telas: Relatório de Compras OD (padrão) e
// Aquisição em Andamento OD (?emAberto=true).
app.use('/api/solicitacoes-od', autenticar, exigirModuloDinamico((req) =>
  req.query.emAberto === 'true' ? 'aquisicaoODAndamento' : 'relatorioComprasOD'
), solicitacoesODRoutes);

app.use('/api/entrada-lotes', autenticar, liberarOracle(exigirModulo('entradaLotes')), entradaLotesRoutes);
app.use('/api/saida-lotes', autenticar, liberarOracle(exigirModulo('saidaLotes')), saidaLotesRoutes);
app.use('/api/distribuicao', autenticar, exigirModulo('distribuicao'), distribuicaoRoutes);
app.use('/api/reservas', autenticar, exigirModulo('reservas'), reservasRoutes);
app.use('/api/rupturas', autenticar, exigirModulo('rupturas'), rupturasRoutes);

// Status dos Serviços: tela de operação do sistema (monitoramento dos vigias,
// agendadores e backup). Exclusiva de administrador — não entra na matriz de
// permissões por módulo porque não expõe dados de compra, e sim a saúde do
// próprio sistema.
app.use('/api/servicos', autenticar, exigirPerfil('admin'), require('./routes.servicos'));

// Serve o frontend estático (build simples, sem framework)
const PASTA_FRONT = path.join(__dirname, '..', '..', 'frontend');

// Cache-buster automático: serve o index.html trocando a versão dos assets
// (app.js / estilo.css) pela data de modificação do arquivo. Assim, toda vez
// que o frontend muda, o navegador rebusca sozinho — sem precisar de Ctrl+F5.
function versaoArquivo(rel) {
  try { return fs.statSync(path.join(PASTA_FRONT, rel)).mtimeMs.toString(36); } catch { return '0'; }
}
function servirIndex(req, res) {
  try {
    let html = fs.readFileSync(path.join(PASTA_FRONT, 'index.html'), 'utf8');
    const vApp = versaoArquivo(path.join('js', 'app.js'));
    const vCss = versaoArquivo(path.join('css', 'estilo.css'));
    html = html
      .replace(/\/js\/app\.js(\?v=[^"']*)?/g, `/js/app.js?v=${vApp}`)
      .replace(/\/css\/estilo\.css(\?v=[^"']*)?/g, `/css/estilo.css?v=${vCss}`);
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(html);
  } catch (e) {
    res.sendFile(path.join(PASTA_FRONT, 'index.html'));
  }
}
app.get(['/', '/index.html'], servirIndex);

app.use(express.static(PASTA_FRONT));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sistema v${VERSAO} — ambiente: ${process.env.NODE_ENV || 'producao'}`);
  console.log(`Servidor rodando em http://0.0.0.0:${PORT}`);
  console.log('Acesse pela rede local usando o IP deste computador, ex: http://192.168.x.x:' + PORT);

  // Importação automática ao detectar atualização dos arquivos CSV
  const { iniciarVigiaEstoque } = require('./vigiaEstoque');
  iniciarVigiaEstoque();
  const { iniciarVigiaAutores } = require('./vigiaAutores');
  iniciarVigiaAutores();
  const { iniciarVigiaRelatorioItens } = require('./vigiaRelatorioItens');
  iniciarVigiaRelatorioItens();
  const { iniciarVigiaAtas } = require('./vigiaAtas');
  iniciarVigiaAtas();
  const { iniciarVigiaAtasSiscoa } = require('./vigiaAtasSiscoa');
  iniciarVigiaAtasSiscoa();
  const { iniciarVigiaEstoqueOD } = require('./vigiaEstoqueOD');
  iniciarVigiaEstoqueOD();
  const { iniciarVigiaSolicitacoes } = require('./vigiaSolicitacoes');
  iniciarVigiaSolicitacoes();
  const { iniciarVigiaSolicitacoesOD } = require('./vigiaSolicitacoesOD');
  iniciarVigiaSolicitacoesOD();
  const { iniciarVigiaDistribuicao } = require('./vigiaDistribuicao');
  iniciarVigiaDistribuicao();
  const { iniciarVigiaReservas } = require('./vigiaReservas');
  iniciarVigiaReservas();

  // Atualização automática diária via Oracle (SCODES): Estoque primeiro,
  // Autores em seguida (encadeado, nunca ao mesmo tempo).
  const { iniciarAgendadorOracleDiario } = require('./agendadorOracleDiario');
  iniciarAgendadorOracleDiario();

  // Backup diário do banco (antes das sincronizações via Oracle, por padrão).
  const { iniciarBackupDiario } = require('./backupBanco');
  iniciarBackupDiario();

  // Monitor de segurança: observa login_falho/acesso_negado e saúde do backup,
  // registra no Status dos Serviços e alerta por e-mail nos casos críticos.
  const { iniciarMonitorSeguranca } = require('./monitorSeguranca');
  iniciarMonitorSeguranca();
});
