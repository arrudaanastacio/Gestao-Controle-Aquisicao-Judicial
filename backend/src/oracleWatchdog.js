// Watchdog das sincronizações via Oracle (SCODES).
//
// Problema que resolve: se a consulta/conexão do Oracle "pendura" (não retorna
// nem dá erro), a Promise nunca resolve, o `.finally()` que libera o lock
// (estadoOracle.rodando) nunca roda, e TODA sincronização seguinte fica
// "pulada (já em andamento)" — além do timer da tela correr indefinidamente
// (caso real: Autores travado por 209 min em 01/10/2026).
//
// Solução: corre a sincronização contra um timeout. Se estourar, rejeita com
// erro de TIMEOUT — aí o .catch/.finally já existentes registram a falha
// (com alerta por e-mail) e LIBERAM o lock, destravando as próximas execuções.
// Obs.: o JS não cancela a Promise original; a consulta pendurada ainda termina
// (ou morre) em segundo plano, mas o sistema volta a funcionar.
//
// Tempo configurável por ORACLE_SYNC_TIMEOUT_MIN (padrão 45 min — o Autores,
// a maior, leva ~20 min normalmente).
const TIMEOUT_MIN = (() => {
  const n = parseInt(process.env.ORACLE_SYNC_TIMEOUT_MIN, 10);
  return Number.isFinite(n) && n > 0 ? n : 45;
})();

function comTimeout(promise, rotulo, ms = TIMEOUT_MIN * 60 * 1000) {
  promise.catch(() => {}); // evita unhandledRejection se o original falhar tarde
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => {
      const err = new Error(
        `Tempo esgotado: "${rotulo}" passou de ${Math.round(ms / 60000)} min sem terminar ` +
        '(possível travamento da conexão com o Oracle). Abortado para liberar a fila de sincronização.'
      );
      err.codigo = 'TIMEOUT_ORACLE';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

module.exports = { comTimeout, TIMEOUT_MIN };
