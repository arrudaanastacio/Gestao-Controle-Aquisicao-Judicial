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
//
// opcoes (opcional):
//   recuperarSePerdido: true  -> RECUPERAÇÃO NA INICIALIZAÇÃO. Se, ao subir o
//     sistema, o horário de hoje JÁ PASSOU e a tarefa ainda não rodou hoje,
//     ela é disparada na hora (em vez de esperar até amanhã). Resolve o caso do
//     PC ligado depois do horário: a sincronização deixa de ser pulada no dia.
//   jaRodouHoje: () => boolean -> predicado que informa se a tarefa já rodou
//     com sucesso hoje (ex.: consulta ao banco). Só é consultado na recuperação
//     de inicialização, para não repetir uma sincronização já feita. Se não for
//     passado, assume-se que NÃO rodou (a própria tarefa deve ser idempotente —
//     é o caso dos vigias, que só importam se o arquivo mudou de assinatura).
function agendarDiariamente(nomeLog, hora, minuto, tarefa, opcoes = {}) {
  // --- Recuperação na inicialização -------------------------------------
  if (opcoes.recuperarSePerdido) {
    const agora = new Date();
    const alvoHoje = new Date(agora);
    alvoHoje.setHours(hora, minuto, 0, 0);
    const hhmm = `${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}`;
    if (agora > alvoHoje) {
      let jaRodou = false;
      if (typeof opcoes.jaRodouHoje === 'function') {
        try { jaRodou = !!opcoes.jaRodouHoje(); } catch { jaRodou = false; }
      }
      if (jaRodou) {
        console.log(`[${nomeLog}] Horário de hoje (${hhmm}) já passou, mas já rodou hoje — nada a recuperar.`);
      } else {
        console.log(`[${nomeLog}] Horário de hoje (${hhmm}) já passou e não rodou ainda — recuperando agora.`);
        // Assíncrono, para não travar a subida do servidor.
        Promise.resolve().then(tarefa).catch((e) =>
          console.error(`[${nomeLog}] Falha na recuperação de inicialização:`, e && e.message));
      }
    }
  }

  const ms = msAteProxima(hora, minuto);
  const alvo = new Date(Date.now() + ms);
  console.log(`[${nomeLog}] Próxima atualização automática: ${alvo.toLocaleString('pt-BR')}.`);

  setTimeout(() => {
    console.log(`[${nomeLog}] Disparando atualização automática via Oracle...`);
    tarefa();
    agendarDiariamente(nomeLog, hora, minuto, tarefa, opcoes); // reagenda para o dia seguinte
  }, ms);
}

module.exports = { msAteProxima, agendarDiariamente };
