// =====================================================================
// agendadorOracleDiario.js
// Roda as atualizações via Oracle (SCODES) automaticamente todo dia, em
// SEQUÊNCIA: Estoque -> Autores -> Movimentações de Entrada (lotes/
// validade) -> Relatório de Itens. Cada uma só começa depois que a
// anterior terminar (sucesso ou falha), assim nunca disputam o Oracle ao
// mesmo tempo, e não é preciso adivinhar quanto tempo cada uma leva para
// calcular horários fixos separados.
//
// Ligado/desligado por variável de ambiente:
//   AGENDAR_ORACLE_DIARIO=true   -> liga o agendamento
//   HORA_SYNC_ESTOQUE=6          -> hora de início (0-23), padrão 6
//   MINUTO_SYNC_ESTOQUE=0        -> minuto de início (0-59), padrão 0
// =====================================================================
const { executarAtualizacaoEstoqueOracle } = require('./routes.estoque');
const { executarAtualizacaoOracle } = require('./routes.autores');
const { executarAtualizacaoEntradaLotesOracle } = require('./routes.entradaLotes');
const { executarAtualizacaoRelatorioItensOracle } = require('./routes.relatorioItens');
const { agendarDiariamente } = require('./agendadorUtil');
const db = require('./db');

// A cadeia diária é "ancorada" no Estoque (é a 1ª e a mais importante). Para a
// recuperação na inicialização, consideramos que a cadeia já rodou hoje se já
// existe uma importação de estoque registrada hoje (qualquer origem). Assim,
// reiniciar o sistema várias vezes no mesmo dia não repuxa o Oracle à toa.
function estoqueImportouHoje() {
  try {
    const agora = new Date();
    const hoje = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}-${String(agora.getDate()).padStart(2, '0')}`;
    const r = db.prepare(
      "SELECT 1 FROM importacoes WHERE tipo = 'estoque' AND substr(criado_em, 1, 10) = ? LIMIT 1"
    ).get(hoje);
    return !!r;
  } catch (e) {
    console.error('[AGENDADOR ORACLE] Não consegui checar se já importou hoje:', e.message);
    return false; // na dúvida, deixa recuperar (idempotência do resto fica com o snapshot do dia)
  }
}

async function rodarCadeiaDiaria() {
  console.log('[AGENDADOR ORACLE] Iniciando Estoque...');
  try {
    const r = await executarAtualizacaoEstoqueOracle({ usuarioEmail: 'agendador-oracle' });
    if (r.pulou) console.log('[AGENDADOR ORACLE] Estoque pulado:', r.motivo);
  } catch (e) {
    console.error('[AGENDADOR ORACLE] Estoque falhou, seguindo para Autores mesmo assim:', e.message);
  }

  console.log('[AGENDADOR ORACLE] Estoque concluído. Iniciando Autores...');
  try {
    const r = await executarAtualizacaoOracle({ usuarioEmail: 'agendador-oracle' });
    if (r.pulou) console.log('[AGENDADOR ORACLE] Autores pulado:', r.motivo);
  } catch (e) {
    console.error('[AGENDADOR ORACLE] Autores falhou:', e.message);
  }

  console.log('[AGENDADOR ORACLE] Autores concluído. Iniciando Movimentações de Entrada...');
  try {
    const r = await executarAtualizacaoEntradaLotesOracle({ usuarioEmail: 'agendador-oracle' });
    if (r.pulou) console.log('[AGENDADOR ORACLE] Entrada (lotes) pulado:', r.motivo);
  } catch (e) {
    console.error('[AGENDADOR ORACLE] Entrada (lotes) falhou:', e.message);
  }
  console.log('[AGENDADOR ORACLE] Entrada (lotes) concluído. Iniciando Relatório de Itens...');
  try {
    const r = await executarAtualizacaoRelatorioItensOracle({ usuarioEmail: 'agendador-oracle' });
    if (r.pulou) console.log('[AGENDADOR ORACLE] Relatório de Itens pulado:', r.motivo);
  } catch (e) {
    console.error('[AGENDADOR ORACLE] Relatório de Itens falhou:', e.message);
  }
  console.log('[AGENDADOR ORACLE] Cadeia diária concluída.');
}

function iniciarAgendadorOracleDiario() {
  if (process.env.AGENDAR_ORACLE_DIARIO !== 'true') {
    console.log('[AGENDADOR ORACLE] Desativado (AGENDAR_ORACLE_DIARIO != true).');
    return;
  }
  const hora = Math.min(23, Math.max(0, parseInt(process.env.HORA_SYNC_ESTOQUE, 10) || 6));
  const minuto = Math.min(59, Math.max(0, parseInt(process.env.MINUTO_SYNC_ESTOQUE, 10) || 0));
  console.log(`[AGENDADOR ORACLE] Ativo — Estoque inicia às ${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}, Autores, Entrada (lotes) e Relatório de Itens em seguida.`);
  agendarDiariamente('AGENDADOR ORACLE', hora, minuto, rodarCadeiaDiaria, {
    recuperarSePerdido: true,
    jaRodouHoje: estoqueImportouHoje,
  });
}

module.exports = { iniciarAgendadorOracleDiario };
