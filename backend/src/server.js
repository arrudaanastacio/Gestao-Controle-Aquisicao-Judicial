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

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/usuarios', usuariosRoutes);
app.use('/api/itens', itensRoutes);
app.use('/api/solicitacoes', solicitacoesRoutes);
app.use('/api/relatorios', relatoriosRoutes);
app.use('/api/elenco', elencoRoutes);
app.use('/api/importar-solicitacoes', importarSolicitacoesRoutes);
app.use('/api/alertas', alertasRoutes);
app.use('/api/estoque', estoqueRoutes);
app.use('/api/autores', autoresRoutes);
app.use('/api/relatorio-itens', relatorioItensRoutes);
app.use('/api/config', configRoutes);

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
