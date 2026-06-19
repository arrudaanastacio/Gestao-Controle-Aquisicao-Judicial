const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'medicamentos_judicial.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

// Tabela de usuários (criada se não existir)
db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK(perfil IN ('admin','consulta')),
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS itens (
  codigo_item TEXT PRIMARY KEY,
  codigo_siafisico TEXT,
  descricao TEXT NOT NULL,
  catmat TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  inativado_em TEXT,
  atualizado_em TEXT DEFAULT (datetime('now'))
);
`);

// Migração idempotente: adiciona colunas novas se o banco já existia antes desta versão
const colunasItens = db.prepare("PRAGMA table_info(itens)").all().map((c) => c.name);
if (!colunasItens.includes('catmat')) db.exec("ALTER TABLE itens ADD COLUMN catmat TEXT");
if (!colunasItens.includes('ativo')) db.exec("ALTER TABLE itens ADD COLUMN ativo INTEGER NOT NULL DEFAULT 1");
if (!colunasItens.includes('inativado_em')) db.exec("ALTER TABLE itens ADD COLUMN inativado_em TEXT");
if (!colunasItens.includes('atualizado_em')) db.exec("ALTER TABLE itens ADD COLUMN atualizado_em TEXT");

// Alertas operacionais (ex: item removido do elenco mas com histórico de compra)
db.exec(`
CREATE TABLE IF NOT EXISTS alertas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  codigo_item TEXT,
  mensagem TEXT NOT NULL,
  resolvido INTEGER NOT NULL DEFAULT 0,
  resolvido_por TEXT,
  resolvido_em TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);

// Histórico de importações realizadas (elenco e solicitações)
db.exec(`
CREATE TABLE IF NOT EXISTS importacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  nome_arquivo TEXT,
  usuario_email TEXT,
  resumo TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);

// Log de auditoria de alterações (quem mudou o quê)
db.exec(`
CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER,
  usuario_email TEXT,
  acao TEXT NOT NULL,
  tabela TEXT,
  registro_id INTEGER,
  dados_antes TEXT,
  dados_depois TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);

// Cada importação diária do relatório de estoque vira um "snapshot" datado.
// Mantemos o histórico para acompanhar a evolução do estoque ao longo do tempo.
db.exec(`
CREATE TABLE IF NOT EXISTS estoque_importacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_referencia TEXT NOT NULL,           -- dia do estoque (yyyy-mm-dd)
  nome_arquivo TEXT,
  usuario_email TEXT,
  total_itens INTEGER,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);

// Linhas de estoque de cada importação (uma foto do item naquele dia)
db.exec(`
CREATE TABLE IF NOT EXISTS estoque_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  importacao_id INTEGER NOT NULL,
  data_referencia TEXT NOT NULL,
  codigo_item TEXT,
  id_item_origem TEXT,
  descricao TEXT,
  siafisico TEXT,
  catmat TEXT,
  categoria TEXT,
  tipo_item TEXT,
  marca TEXT,
  outras_demandas TEXT,
  demandas REAL,
  demandas_aj REAL,
  consumo_mensal_total REAL,
  consumo_mensal_aj REAL,
  estoque REAL,
  autonomia REAL,
  custo_unitario REAL,
  valor_medio_unitario REAL,
  lotes TEXT,
  FOREIGN KEY (importacao_id) REFERENCES estoque_importacoes(id)
);
`);

// Colunas adicionais de estoque (controlado / importado) — presentes na planilha
// mas que não eram guardadas antes. Migração idempotente para bancos já em uso.
const colunasEstoque = db.prepare("PRAGMA table_info(estoque_itens)").all().map((c) => c.name);
if (!colunasEstoque.includes('controlado')) db.exec("ALTER TABLE estoque_itens ADD COLUMN controlado TEXT");
if (!colunasEstoque.includes('importado')) db.exec("ALTER TABLE estoque_itens ADD COLUMN importado TEXT");
if (!colunasEstoque.includes('unidade')) db.exec("ALTER TABLE estoque_itens ADD COLUMN unidade TEXT");

db.exec(`CREATE INDEX IF NOT EXISTS idx_estoque_codigo ON estoque_itens(codigo_item);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_estoque_data ON estoque_itens(data_referencia);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_estoque_importacao ON estoque_itens(importacao_id);`);

// Configurações gerais do sistema (ex: limiar de autonomia para alerta de estoque baixo)
db.exec(`
CREATE TABLE IF NOT EXISTS configuracoes (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
`);
// Valor padrão do limiar de autonomia (meses) — só insere se ainda não existir
const cfg = db.prepare("SELECT valor FROM configuracoes WHERE chave = 'autonomia_minima_meses'").get();
if (!cfg) {
  db.prepare("INSERT INTO configuracoes (chave, valor) VALUES ('autonomia_minima_meses', '2')").run();
}

module.exports = db;
