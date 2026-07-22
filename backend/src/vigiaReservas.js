// =====================================================================
// vigiaReservas.js
// Atualização diária automática das RESERVAS a partir da API UDTP.
//
// Liga/desliga e horário pelo .env:
//   AUTO_IMPORTAR_RESERVAS=false  -> desliga (padrão é ligado)
//   HORA_SYNC_RESERVAS=7          -> hora de início (0-23), padrão 7
//   MINUTO_SYNC_RESERVAS=0        -> minuto (0-59), padrão 0
//
// Usa a recuperação na inicialização do agendadorUtil: se o sistema subir
// depois do horário e ainda não tiver importado hoje, importa na hora.
// =====================================================================
const db = require('./db');
const { agendarDiariamente } = require('./agendadorUtil');
const { credenciaisConfiguradas } = require('./udtpApi');
const { importarReservasDoDia } = require('./reservasUdtp');

function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Já existe foto de reservas de hoje? (evita repuxar a API a cada reinício)
function jaImportouHoje() {
  try {
    const r = db.prepare(
      'SELECT 1 FROM reservas_importacoes WHERE data_referencia = ? LIMIT 1'
    ).get(hojeISO());
    return !!r;
  } catch (e) {
    console.error('[VIGIA RESERVAS] Não consegui checar se já importou hoje:', e.message);
    return false;
  }
}

async function importarHoje() {
  if (!credenciaisConfiguradas()) {
    console.log('[VIGIA RESERVAS] Pulado: credenciais da API UDTP não configuradas no .env.');
    return;
  }
  const dia = hojeISO();
  try {
    const r = await importarReservasDoDia(dia, 'auto-importador');
    console.log(`[VIGIA RESERVAS] ${dia}: ${r.totalRegistros} reserva(s) importada(s).`);
    if (r.semCodigoScodes > 0) {
      console.warn(`[VIGIA RESERVAS] Atenção: ${r.semCodigoScodes} registro(s) sem código SCODES (mapeamento pode precisar de ajuste).`);
    }
    if (r.camposNaoMapeados.length) {
      console.warn('[VIGIA RESERVAS] Campos da API ainda não mapeados:', r.camposNaoMapeados.join(', '));
    }
  } catch (e) {
    console.error(`[VIGIA RESERVAS] Falha ao importar ${dia} [${e.codigo || 'ERRO'}]:`, e.message);
  }
}

function iniciarVigiaReservas() {
  if (process.env.AUTO_IMPORTAR_RESERVAS === 'false') {
    console.log('[VIGIA RESERVAS] Desativado (AUTO_IMPORTAR_RESERVAS=false).');
    return;
  }
  if (!credenciaisConfiguradas()) {
    console.log('[VIGIA RESERVAS] Sem credenciais da API UDTP no .env — agendamento não iniciado.');
    return;
  }
  const hora = Math.min(23, Math.max(0, parseInt(process.env.HORA_SYNC_RESERVAS, 10) || 7));
  const minuto = Math.min(59, Math.max(0, parseInt(process.env.MINUTO_SYNC_RESERVAS, 10) || 0));
  console.log(`[VIGIA RESERVAS] Ativo — atualização diária às ${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}.`);
  agendarDiariamente('VIGIA RESERVAS', hora, minuto, importarHoje, {
    recuperarSePerdido: true,
    jaRodouHoje: jaImportouHoje,
  });
}

module.exports = { iniciarVigiaReservas, importarHoje };
