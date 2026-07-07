// =====================================================================
// agendadorAutores.js
// Roda a atualização da Listagem de Autores via Oracle automaticamente
// todos os dias num horário fixo (padrão 06:00). Assim, quando os colegas
// chegam de manhã, a listagem já está atualizada direto do SCODES, sem
// precisar da extração manual (que hoje leva 40+ min pela aplicação).
//
// Ligado/desligado por variável de ambiente:
//   AGENDAR_AUTORES_ORACLE=true   -> liga o agendamento
//   HORA_SYNC_AUTORES=6           -> hora do dia (0-23), padrão 6
//   MINUTO_SYNC_AUTORES=0         -> minuto (0-59), padrão 0
// =====================================================================
const { iniciarAtualizacaoOracle } = require('./routes.autores');

// Calcula quantos milissegundos faltam até a próxima ocorrência de hora:minuto.
function msAteProxima(hora, minuto) {
  const agora = new Date();
  const alvo = new Date(agora);
  alvo.setHours(hora, minuto, 0, 0);
  if (alvo <= agora) alvo.setDate(alvo.getDate() + 1); // já passou hoje -> amanhã
  return alvo - agora;
}

function agendarProxima(hora, minuto) {
  const ms = msAteProxima(hora, minuto);
  const alvo = new Date(Date.now() + ms);
  console.log(`[AGENDADOR AUTORES] Próxima atualização automática: ${alvo.toLocaleString('pt-BR')}.`);

  setTimeout(() => {
    console.log('[AGENDADOR AUTORES] Disparando atualização automática via Oracle...');
    const r = iniciarAtualizacaoOracle({ usuarioEmail: 'agendador-6h' });
    if (!r.iniciado) {
      console.log('[AGENDADOR AUTORES] Já havia uma atualização em andamento; pulando esta.');
    }
    agendarProxima(hora, minuto); // reagenda para o dia seguinte
  }, ms);
}

function iniciarAgendadorAutores() {
  if (process.env.AGENDAR_AUTORES_ORACLE !== 'true') {
    console.log('[AGENDADOR AUTORES] Desativado (AGENDAR_AUTORES_ORACLE != true).');
    return;
  }
  const hora = Math.min(23, Math.max(0, parseInt(process.env.HORA_SYNC_AUTORES, 10) || 6));
  const minuto = Math.min(59, Math.max(0, parseInt(process.env.MINUTO_SYNC_AUTORES, 10) || 0));
  console.log(`[AGENDADOR AUTORES] Ativo — atualização diária às ${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}.`);
  agendarProxima(hora, minuto);
}

module.exports = { iniciarAgendadorAutores };
