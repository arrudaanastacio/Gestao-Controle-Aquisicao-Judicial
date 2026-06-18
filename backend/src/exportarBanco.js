// Gera um "dump" SQL completo do banco: estrutura (CREATE) + todos os dados
// (INSERT). O arquivo resultante recria o banco inteiro em qualquer SQLite.
//
// Uso:  node src/exportarBanco.js
// Saída: data/export/dump_completo_AAAA-MM-DD.sql
//        data/export/esquema.sql   (apenas a estrutura, sem dados)

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'medicamentos_judicial.db'));

const pastaExport = path.join(__dirname, '..', 'data', 'export');
fs.mkdirSync(pastaExport, { recursive: true });

// Formata um valor JS para literal SQL
function sql(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (Buffer.isBuffer(v)) return "X'" + v.toString('hex') + "'";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

// Estrutura: tabelas, índices e triggers (na ordem em que o SQLite os guarda)
const objetos = db.prepare(
  "SELECT type, name, sql FROM sqlite_master " +
  "WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' " +
  "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name"
).all();

const tabelas = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map((t) => t.name);

const cabecalho =
  '-- Dump do banco de Compras Judiciais (Tenente Pena)\n' +
  '-- Gerado em ' + new Date().toLocaleString('pt-BR') + '\n' +
  '-- Recria estrutura e dados em qualquer SQLite.\n\n' +
  'PRAGMA foreign_keys = OFF;\nBEGIN TRANSACTION;\n\n';

// ----- Arquivo só com a estrutura -----
let esquema = cabecalho;
for (const o of objetos) esquema += o.sql.trim() + ';\n';
esquema += '\nCOMMIT;\n';
fs.writeFileSync(path.join(pastaExport, 'esquema.sql'), esquema, 'utf8');

// ----- Arquivo completo: estrutura + dados -----
let dump = cabecalho;

// 1) Estrutura primeiro
for (const o of objetos) {
  if (o.type === 'table') dump += o.sql.trim() + ';\n';
}
dump += '\n';

// 2) Dados (INSERT) tabela por tabela
for (const tabela of tabelas) {
  const colunas = db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name);
  const linhas = db.prepare(`SELECT * FROM ${tabela}`).all();
  if (linhas.length === 0) continue;
  dump += `-- ${linhas.length} registro(s) em ${tabela}\n`;
  for (const linha of linhas) {
    const valores = colunas.map((c) => sql(linha[c])).join(', ');
    dump += `INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES (${valores});\n`;
  }
  dump += '\n';
}

// 3) Índices/triggers por último (depois dos dados, mais rápido)
for (const o of objetos) {
  if (o.type !== 'table') dump += o.sql.trim() + ';\n';
}
dump += '\nCOMMIT;\nPRAGMA foreign_keys = ON;\n';

const dataHoje = new Date().toISOString().slice(0, 10);
const arquivoDump = path.join(pastaExport, `dump_completo_${dataHoje}.sql`);
fs.writeFileSync(arquivoDump, dump, 'utf8');

console.log('Exportação concluída:');
console.log('  Estrutura : ' + path.join(pastaExport, 'esquema.sql'));
console.log('  Completo  : ' + arquivoDump);
console.log('  Tabelas   : ' + tabelas.length);
