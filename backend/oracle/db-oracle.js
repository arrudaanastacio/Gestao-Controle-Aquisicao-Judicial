// =====================================================================
// db-oracle.js
// Gerencia um pool de conexões com o Oracle do SCODES (somente leitura).
// Reutiliza conexões em vez de abrir/fechar a cada consulta.
// =====================================================================
require('dotenv').config();
const oracledb = require('oracledb');

// Retorna cada linha como objeto { COLUNA: valor } em vez de array posicional
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

// Dados de conexão (host/porta/serviço) vêm do .env — NUNCA ficam no código,
// para não expor a infraestrutura interna em repositório público.
// Monta a string de conexão a partir de ORACLE_HOST/ORACLE_PORT/ORACLE_SERVICE.
const ORACLE_HOST = process.env.ORACLE_HOST;
const ORACLE_PORT = process.env.ORACLE_PORT || '1521';
const ORACLE_SERVICE = process.env.ORACLE_SERVICE;
if (!ORACLE_HOST || !ORACLE_SERVICE) {
  throw new Error('Defina ORACLE_HOST e ORACLE_SERVICE no backend/.env (veja backend/.env.oracle.example).');
}
const CONNECT_STRING =
  `(DESCRIPTION=(CONNECT_TIMEOUT=10)(RETRY_COUNT=3)` +
  `(ADDRESS_LIST=(ADDRESS=(PROTOCOL=TCP)(HOST=${ORACLE_HOST})(PORT=${ORACLE_PORT})))` +
  `(CONNECT_DATA=(SERVICE_NAME=${ORACLE_SERVICE})(SERVER=DEDICATED)))`;

let pool = null;

// Inicializa o pool (chamar uma vez, no boot da aplicação).
async function iniciarPool() {
  if (pool) return pool;
  pool = await oracledb.createPool({
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
    connectString: CONNECT_STRING,
    poolMin: 1,
    poolMax: 4,
    poolIncrement: 1,
    poolTimeout: 60, // segundos que uma conexão ociosa fica no pool
  });
  console.log('[oracle] pool iniciado');
  return pool;
}

// Executa uma query de leitura. binds é um objeto tipo { und_id: 161 }.
// Garante o pool iniciado sob demanda, então funciona mesmo em scripts avulsos.
async function consultar(sql, binds = {}) {
  if (!pool) await iniciarPool();
  let conn;
  try {
    conn = await pool.getConnection();
    const resultado = await conn.execute(sql, binds);
    return resultado.rows;
  } finally {
    if (conn) await conn.close(); // devolve a conexão ao pool
  }
}

// Fecha o pool (chamar no shutdown da aplicação, ou ao fim de um script).
async function fecharPool() {
  if (pool) {
    await pool.close(5); // aguarda até 5s conexões em uso terminarem
    pool = null;
    console.log('[oracle] pool fechado');
  }
}

module.exports = { iniciarPool, consultar, fecharPool };
