require('dotenv').config();
const oracledb = require('oracledb');

// Vem do .env (backend/.env) — não deixar IP/serviço no código.
const connectString = process.env.ORA_CONNECT_STRING;

async function testar() {
  let conn;
  try {
    conn = await oracledb.getConnection({
      user: process.env.ORA_USER,
      password: process.env.ORA_PASSWORD,
      connectString
    });
    const r = await conn.execute('SELECT 1 AS OK FROM DUAL');
    console.log('Conexão OK:', r.rows);
  } catch (e) {
    console.error('Erro:', e.message);
  } finally {
    if (conn) await conn.close();
  }
}
testar();