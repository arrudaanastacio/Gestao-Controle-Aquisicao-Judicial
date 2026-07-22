// permissoes.js — Registro central dos módulos e ações do sistema.
//
// Este é o "dicionário" usado tanto pelo backend (para travar as rotas) quanto
// pelo frontend (para montar a grade de permissões na tela de Administração).
// Mantenha as CHAVES estáveis: elas são gravadas no banco (tabela permissoes).
//
// Cada módulo lista só as ações que fazem sentido para ele. Ex.: Alertas não
// tem "importar" nem "exportar", então a grade só mostra Visualizar/Editar.

const ACOES = ['visualizar', 'inserir', 'editar', 'excluir', 'exportar', 'importar'];

// Rótulos amigáveis para a tela (cabeçalho das colunas).
const ACOES_ROTULO = {
  visualizar: 'Visualizar',
  inserir: 'Inserir',
  editar: 'Editar',
  excluir: 'Excluir',
  exportar: 'Exportar',
  importar: 'Importar',
};

// Um módulo por TELA do menu lateral (regra a partir de 13/07/2026): cada
// relatório/tela pode ser liberado ou bloqueado por usuário de forma
// independente das demais. Antes disso, várias telas dividiam o mesmo
// módulo (ex.: "estoque" cobria 6 telas juntas) — ver MIGRACAO_MODULOS em
// db.js para como as permissões antigas foram herdadas pelas telas novas.
const MODULOS = [
  // 🏥 Tenente Pena
  { chave: 'relatorioComprasTP', rotulo: 'Relatório de Compras TP', acoes: ['visualizar', 'exportar'] },
  { chave: 'tabelaAnaliseTP', rotulo: 'Tabela Análise TP', acoes: ['visualizar', 'inserir', 'editar', 'excluir', 'exportar', 'importar'] },
  { chave: 'estoqueTP', rotulo: 'Estoque Tenente Pena', acoes: ['visualizar', 'exportar', 'importar'] },
  { chave: 'validadesTP', rotulo: 'Consultar Validades TP', acoes: ['visualizar', 'exportar'] },
  { chave: 'historicoEstoqueTP', rotulo: 'Histórico de Estoque', acoes: ['visualizar'] },
  { chave: 'evolucaoEstoqueTP', rotulo: 'Evolução de Estoque', acoes: ['visualizar'] },
  { chave: 'autoresTP', rotulo: 'Listagem de Autores Tenente Pena', acoes: ['visualizar', 'exportar'] },
  { chave: 'relatorioReqTP', rotulo: 'Relatório de Primeiro Atendimento', acoes: ['visualizar', 'inserir', 'editar', 'excluir'] },
  { chave: 'comparativoAutoresTP', rotulo: 'Comparativo de Autores', acoes: ['visualizar'] },
  { chave: 'entradaLotes', rotulo: 'Movimentação de Entrada Estoque', acoes: ['visualizar', 'exportar', 'importar'] },
  // "Importar" aqui é o botão "Atualizar agora" da tela de Reservas: marque
  // essa ação para os usuários que puderem forçar a consulta à API UDTP.
  { chave: 'reservas', rotulo: 'Reservas de Estoque', acoes: ['visualizar', 'exportar', 'importar'] },
  { chave: 'alertas', rotulo: 'Alertas', acoes: ['visualizar', 'editar'] },

  // 🏢 Outras Demandas
  { chave: 'relatorioComprasOD', rotulo: 'Relatório de Compras OD', acoes: ['visualizar'] },
  { chave: 'aquisicaoODAndamento', rotulo: 'Aquisição em Andamento OD', acoes: ['visualizar'] },
  { chave: 'estoqueGeral', rotulo: 'Itens em Estoque Geral', acoes: ['visualizar', 'exportar'] },
  { chave: 'autoresGeral', rotulo: 'Listagem de Autores Demais Unidades', acoes: ['visualizar', 'exportar'] },
  { chave: 'estoqueOD', rotulo: 'Estoque GSNET/IBL', acoes: ['visualizar', 'exportar', 'importar'] },
  { chave: 'distribuicao', rotulo: 'Distribuição', acoes: ['visualizar', 'exportar'] },

  // 🔍 Consultas
  { chave: 'relatorioItens', rotulo: 'Relatório de Itens', acoes: ['visualizar', 'exportar', 'importar'] },
  { chave: 'atas', rotulo: 'Atas de Registro de Preço (SISCOA)', acoes: ['visualizar', 'exportar', 'importar'] },

  // Não aparece direto no menu (acessado via Administração > Importação)
  { chave: 'elenco', rotulo: 'Elenco (Catálogo)', acoes: ['visualizar', 'editar', 'importar'] },
];

const MODULO_CHAVES = MODULOS.map((m) => m.chave);

module.exports = { ACOES, ACOES_ROTULO, MODULOS, MODULO_CHAVES };
