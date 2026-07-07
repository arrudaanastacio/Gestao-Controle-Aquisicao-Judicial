// =====================================================================
// testar-oracle.js
// Teste rápido de conexão com o Oracle do SCODES (somente leitura).
// Uso:  node testar-oracle.js
// Lê ORACLE_HOST, ORACLE_PORT, ORACLE_SERVICE, ORACLE_USER e
// ORACLE_PASSWORD do backend/.env. NÃO imprime a senha.
// Serve só para confirmar que a credencial conecta.
// =====================================================================
require('dotenv').config();
const oracledb = require('oracledb');

// Se o driver precisar do modo "thick" (Instant Client), descomente:
// oracledb.initOracleClient({ libDir: 'C:\\oracle\\instantclient_21_13' });

const host = process.env.ORACLE_HOST;
const port = process.env.ORACLE_PORT || '1521';
const service = process.env.ORACLE_SERVICE;
const user = process.env.ORACLE_USER;

// Monta a string de conexão a partir de host/porta/serviço.
const connectString =
  `(DESCRIPTION=(CONNECT_TIMEOUT=10)(RETRY_COUNT=3)` +
  `(ADDRESS_LIST=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port})))` +
  `(CONNECT_DATA=(SERVICE_NAME=${service})(SERVER=DEDICATED)))`;

(async () => {
  if (!host || !service || !user || !process.env.ORACLE_PASSWORD) {
    console.error('Faltam variaveis no .env: ORACLE_HOST, ORACLE_SERVICE, ORACLE_USER e/ou ORACLE_PASSWORD.');
    process.exit(1);
  }

  console.log('Usuario:', user);
  console.log('Host/Porta:', host + ':' + port);
  console.log('Service:', service);
  console.log('Conectando...\n');

  let conn;
  try {
    conn = await oracledb.getConnection({
      user,
      password: process.env.ORACLE_PASSWORD,
      connectString,
    });
    console.log('>>> CONECTOU! A credencial esta valida. <<<\n');

    const r = await conn.execute(
      "SELECT USER AS usuario_logado, SYSDATE AS data_banco FROM DUAL"
    );
    console.log('Resposta do banco:', r.rows);
  } catch (err) {
    console.error('>>> FALHOU <<<');
    console.error(err.message);
  } finally {
    if (conn) await conn.close();
  }
})();
