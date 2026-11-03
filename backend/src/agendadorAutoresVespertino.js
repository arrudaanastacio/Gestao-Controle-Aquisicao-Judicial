// =====================================================================
// agendadorAutoresVespertino.js
// Atualiza SÓ a Listagem de Autores (via Oracle) UMA VEZ no período da
// tarde (padrão 12:15), em dias úteis (seg–sex). Complementa a cadeia
// completa das 06h (agendadorOracleDiario), dando uma foto mais nova das
// demandas no meio do dia.
//
// Reaproveita executarAtualizacaoOracle() de routes.autores.js, que já tem
// guarda anti-sobreposição (estadoOracle.rodando), watchdog (comTimeout) e
// registro no Status dos Serviços.
//
// Horário escolhido (12:15) não colide com o Estoque horário, que dispara
// no TOPO da hora (12:00, ~20s) e já terminou.
//
// Ligado/desligado por variável de ambiente:
//   AGENDAR_AUTORES_VESPERTINO=true -> liga
//   AUTORES_VESPERTINO_HORA=12      -> hora (0-23), padrão 12
//   AUTORES_VESPERTINO_MINUTO=15    -> minuto (0-59), padrão 15
// =====================================================================
const { executarAtualizacaoOracle } = require('./routes.autores');
const { agendarDiariamente, ehDiaUtil } = require('./agendadorUtil');

function iniciarAgendadorAutoresVespertino() {
  if (process.env.AGENDAR_AUTORES_VESPERTINO !== 'true') {
    console.log('[AGENDADOR AUTORES TARDE] Desativado (AGENDAR_AUTORES_VESPERTINO != true).');
    return;
  }
  const hora = Math.min(23, Math.max(0, parseInt(process.env.AUTORES_VESPERTINO_HORA, 10) || 12));
  const minutoRaw = parseInt(process.env.AUTORES_VESPERTINO_MINUTO, 10);
  const minuto = Math.min(59, Math.max(0, Number.isFinite(minutoRaw) ? minutoRaw : 15));
  const hhmm = `${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}`;
  console.log(`[AGENDADOR AUTORES TARDE] Ativo — Listagem de Autores às ${hhmm}, dias úteis (seg–sex).`);

  agendarDiariamente('AGENDADOR AUTORES TARDE', hora, minuto, async () => {
    // Só em dia útil: no fim de semana a demanda muda pouco e evita carga
    // desnecessária no Oracle. (agendarDiariamente roda todo dia; filtramos aqui.)
    if (!ehDiaUtil(new Date())) {
      console.log('[AGENDADOR AUTORES TARDE] Fim de semana — pulado.');
      return;
    }
    const r = await executarAtualizacaoOracle({ usuarioEmail: 'agendador-autores-tarde' });
    if (r && r.pulou) console.log('[AGENDADOR AUTORES TARDE] Pulado:', r.motivo);
    else console.log('[AGENDADOR AUTORES TARDE] Listagem de Autores atualizada.');
  });
}

module.exports = { iniciarAgendadorAutoresVespertino };
