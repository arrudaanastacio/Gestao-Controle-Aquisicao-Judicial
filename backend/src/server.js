require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

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
const configRoutes = require('./routes.config');
const { autenticar, exigirModulo } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());

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

// Rotas de dados: travadas por MÓDULO. A ação (ver/inserir/editar/excluir/
// exportar/importar) é deduzida do método+caminho em auth.js. Admin passa sempre.
app.use('/api/solicitacoes', autenticar, exigirModulo('compras'), solicitacoesRoutes);
app.use('/api/relatorios', autenticar, exigirModulo('compras'), relatoriosRoutes);
app.use('/api/importar-solicitacoes', autenticar, exigirModulo('compras'), importarSolicitacoesRoutes);
app.use('/api/elenco', autenticar, exigirModulo('elenco'), elencoRoutes);
app.use('/api/alertas', autenticar, exigirModulo('alertas'), alertasRoutes);
app.use('/api/estoque', autenticar, exigirModulo('estoque'), estoqueRoutes);
app.use('/api/autores', autenticar, exigirModulo('autores'), autoresRoutes);
app.use('/api/relatorio-itens', autenticar, exigirModulo('relatorioItens'), relatorioItensRoutes);
app.use('/api/atas', autenticar, exigirModulo('atas'), atasRoutes);
app.use('/api/estoque-od', autenticar, exigirModulo('estoque'), estoqueODRoutes);
app.use('/api/solicitacoes-od', autenticar, exigirModulo('compras'), solicitacoesODRoutes);
app.use('/api/entrada-lotes', autenticar, exigirModulo('entradaLotes'), entradaLotesRoutes);

// Serve o frontend estático (build simples, sem framework)
app.use(express.static(path.join(__dirname, '..', '..', 'frontend')));

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
  const { iniciarVigiaEstoqueOD } = require('./vigiaEstoqueOD');
  iniciarVigiaEstoqueOD();
  const { iniciarVigiaSolicitacoes } = require('./vigiaSolicitacoes');
  iniciarVigiaSolicitacoes();
  const { iniciarVigiaSolicitacoesOD } = require('./vigiaSolicitacoesOD');
  iniciarVigiaSolicitacoesOD();

  // Atualização automática diária via Oracle (SCODES): Estoque primeiro,
  // Autores em seguida (encadeado, nunca ao mesmo tempo).
  const { iniciarAgendadorOracleDiario } = require('./agendadorOracleDiario');
  iniciarAgendadorOracleDiario();
});
