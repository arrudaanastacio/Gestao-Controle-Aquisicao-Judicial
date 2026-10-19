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
    // IMPORTANTE: `tarefa` é assíncrona. Precisa de .catch() — sem ele, uma
    // rejeição que escape do try/catch interno (ex.: falha ao gravar no registro
    // de serviços, fora das etapas protegidas) vira unhandledRejection e, no
    // Node 15+, DERRUBA o processo inteiro. O caminho de recuperação acima já
    // protege; aqui estava faltando.
    Promise.resolve().then(tarefa).catch((e) =>
      console.error(`[${nomeLog}] Falha na atualização automática:`, e && e.message));
    agendarDiariamente(nomeLog, hora, minuto, tarefa, opcoes); // reagenda para o dia seguinte
  }, ms);
}

// --- Agendamento DE HORA EM HORA em dias úteis (seg–sex) ----------------
// Usado para refrescar o Estoque várias vezes ao dia dentro de uma janela
// (ex.: 10h–17h). Dispara no "topo da hora" (minuto 0) e se reagenda sozinho.

// Dia útil = segunda (getDay 1) a sexta (getDay 5).
function ehDiaUtil(d) {
  const g = d.getDay();
  return g >= 1 && g <= 5;
}

// Próximo "topo da hora" (minuto 0) que seja dia útil E com a hora dentro de
// [horaInicio, horaFim] (inclusive). Avança hora a hora até achar — pula noite
// e fim de semana. Sempre retorna um horário no FUTURO.
function proximaHoraUtil(horaInicio, horaFim) {
  const alvo = new Date();
  alvo.setMinutes(0, 0, 0);
  alvo.setHours(alvo.getHours() + 1); // sempre a PRÓXIMA hora cheia
  for (let i = 0; i < 24 * 9; i++) { // margem de 9 dias cobre feriados emendados
    if (ehDiaUtil(alvo) && alvo.getHours() >= horaInicio && alvo.getHours() <= horaFim) return alvo;
    alvo.setHours(alvo.getHours() + 1);
  }
  return alvo; // salvaguarda (não deve chegar aqui)
}

// Agenda `tarefa` para rodar a cada hora cheia dentro da janela, só em dias
// úteis. `nomeLog` aparece no console. A tarefa deve ser idempotente e se
// proteger contra sobreposição (o executor do Estoque já faz isso).
function agendarPorHoraUtil(nomeLog, horaInicio, horaFim, tarefa) {
  const alvo = proximaHoraUtil(horaInicio, horaFim);
  const ms = alvo - new Date();
  console.log(`[${nomeLog}] Próxima execução horária: ${alvo.toLocaleString('pt-BR')}.`);
  setTimeout(() => {
    console.log(`[${nomeLog}] Disparando execução horária via Oracle...`);
    // .catch() obrigatório: sem ele uma rejeição escapa e derruba o processo.
    Promise.resolve().then(tarefa).catch((e) =>
      console.error(`[${nomeLog}] Falha na execução horária:`, e && e.message));
    agendarPorHoraUtil(nomeLog, horaInicio, horaFim, tarefa); // reagenda p/ a próxima
  }, ms);
}

module.exports = { msAteProxima, agendarDiariamente, agendarPorHoraUtil, proximaHoraUtil, ehDiaUtil };
