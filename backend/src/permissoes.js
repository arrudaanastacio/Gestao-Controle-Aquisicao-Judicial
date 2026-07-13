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

const MODULOS = [
  { chave: 'estoque', rotulo: 'Estoque', acoes: ['visualizar', 'exportar', 'importar'] },
  { chave: 'compras', rotulo: 'Compras / Solicitações', acoes: ['visualizar', 'inserir', 'editar', 'excluir', 'exportar', 'importar'] },
  { chave: 'elenco', rotulo: 'Elenco (Catálogo)', acoes: ['visualizar', 'editar', 'importar'] },
  { chave: 'autores', rotulo: 'Autores / Requisições', acoes: ['visualizar', 'inserir', 'editar', 'excluir', 'exportar', 'importar'] },
  { chave: 'relatorioItens', rotulo: 'Relatório de Itens', acoes: ['visualizar', 'exportar', 'importar'] },
  { chave: 'atas', rotulo: 'Atas de Registro de Preço (SISCOA)', acoes: ['visualizar', 'exportar', 'importar'] },
  { chave: 'entradaLotes', rotulo: 'Movimentação de Entrada Estoque (Tenente Pena)', acoes: ['visualizar', 'exportar', 'importar'] },
  { chave: 'alertas', rotulo: 'Alertas', acoes: ['visualizar', 'editar'] },
];

const MODULO_CHAVES = MODULOS.map((m) => m.chave);

module.exports = { ACOES, ACOES_ROTULO, MODULOS, MODULO_CHAVES };
