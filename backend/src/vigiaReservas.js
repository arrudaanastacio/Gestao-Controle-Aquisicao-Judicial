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
const { importarReservasMaisRecente } = require('./reservasUdtp');

// Já rodou uma importação há pouco? Evita repuxar a API a cada reinício do
// sistema. Olhamos QUANDO a importação rodou (criado_em), e não a data de
// referência — porque a data importada é a do último dia fechado (ontem, em
// geral), então comparar com "hoje" nunca casaria.
// Usa uma janela de 18h em vez de "data igual a hoje" para não depender do
// fuso (criado_em é gravado em UTC pelo SQLite).
function importouRecentemente() {
  try {
    const r = db.prepare(
      "SELECT 1 FROM reservas_importacoes WHERE criado_em >= datetime('now', '-18 hours') LIMIT 1"
    ).get();
    return !!r;
  } catch (e) {
    console.error('[VIGIA RESERVAS] Não consegui checar a última importação:', e.message);
    return false;
  }
}

async function importarHoje() {
  if (!credenciaisConfiguradas()) {
    console.log('[VIGIA RESERVAS] Pulado: credenciais da API UDTP não configuradas no .env.');
    return;
  }
  try {
    // A API só publica o dia depois que ele fecha (consultar "hoje" devolve
    // 404), então importamos a data mais recente que existir.
    const r = await importarReservasMaisRecente('auto-importador');
    console.log(`[VIGIA RESERVAS] ${r.dataReferencia}: ${r.totalRegistros} reserva(s) importada(s).`);
    if (r.semCodigoItem > 0) {
      console.warn(`[VIGIA RESERVAS] Atenção: ${r.semCodigoItem} registro(s) sem código do item (mapeamento pode precisar de ajuste).`);
    }
    if (r.camposNaoMapeados.length) {
      console.warn('[VIGIA RESERVAS] Campos da API ainda não mapeados:', r.camposNaoMapeados.join(', '));
    }
  } catch (e) {
    console.error(`[VIGIA RESERVAS] Falha ao importar [${e.codigo || 'ERRO'}]:`, e.message);
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
    jaRodouHoje: importouRecentemente,
  });
}

module.exports = { iniciarVigiaReservas, importarHoje };
