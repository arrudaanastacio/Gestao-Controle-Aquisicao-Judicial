// =====================================================================
// agendadorUtil.js
// Helper compartilhado pelos agendadores diários (Autores, Estoque, ...).
// =====================================================================

// Calcula quantos milissegundos faltam até a próxima ocorrência de hora:minuto.
function msAteProxima(hora, minuto) {
  const agora = new Date();
  const alvo = new Date(agora);
  alvo.setHours(hora, minuto, 0, 0);
  if (alvo <= agora) alvo.setDate(alvo.getDate() + 1); // já passou hoje -> amanhã
  return alvo - agora;
}

// Agenda uma tarefa para rodar diariamente em hora:minuto, reagendando-se
// sozinha após cada execução. `nomeLog` aparece nas mensagens do console.
function agendarDiariamente(nomeLog, hora, minuto, tarefa) {
  const ms = msAteProxima(hora, minuto);
  const alvo = new Date(Date.now() + ms);
  console.log(`[${nomeLog}] Próxima atualização automática: ${alvo.toLocaleString('pt-BR')}.`);

  setTimeout(() => {
    console.log(`[${nomeLog}] Disparando atualização automática via Oracle...`);
    tarefa();
    agendarDiariamente(nomeLog, hora, minuto, tarefa); // reagenda para o dia seguinte
  }, ms);
}

module.exports = { msAteProxima, agendarDiariamente };
