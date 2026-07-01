require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

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
const configRoutes = require('./routes.config');
const { autenticar, exigirModulo } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());

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

// Serve o frontend estático (build simples, sem framework)
app.use(express.static(path.join(__dirname, '..', '..', 'frontend')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando em http://0.0.0.0:${PORT}`);
  console.log('Acesse pela rede local usando o IP deste computador, ex: http://192.168.x.x:' + PORT);

  // Importação automática ao detectar atualização dos arquivos CSV
  const { iniciarVigiaEstoque } = require('./vigiaEstoque');
  iniciarVigiaEstoque();
  const { iniciarVigiaAutores } = require('./vigiaAutores');
  iniciarVigiaAutores();
  const { iniciarVigiaRelatorioItens } = require('./vigiaRelatorioItens');
  iniciarVigiaRelatorioItens();
});
