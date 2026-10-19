// =====================================================================
// agendadorEstoqueHorario.js
// Atualiza SÓ o Estoque (via Oracle) DE HORA EM HORA, em dias úteis,
// dentro de uma janela (padrão 10h–17h). A query de estoque é leve
// (~20s, usa a view VW_ITENS_EM_ESTOQUE), então refrescar várias vezes
// ao dia dá números mais atuais sem pesar no Oracle.
//
// Como o importador grava por data_referencia = DIA, rodar várias vezes
// no mesmo dia só REFRESCA a foto de hoje (não cria vários snapshots).
//
// A cadeia COMPLETA (Autores, Lotes, Recibos, conciliação) continua 1x/dia
// no agendadorOracleDiario (06h). Aqui é só o Estoque.
//
// Ligado/desligado por variável de ambiente:
//   AGENDAR_ESTOQUE_HORARIO=true  -> liga
//   ESTOQUE_HORARIO_INICIO=10     -> hora de início da janela (0-23)
//   ESTOQUE_HORARIO_FIM=17        -> hora de fim da janela (0-23)
// =====================================================================
const { executarAtualizacaoEstoqueOracle } = require('./routes.estoque');
const { agendarPorHoraUtil } = require('./agendadorUtil');

function iniciarAgendadorEstoqueHorario() {
  if (process.env.AGENDAR_ESTOQUE_HORARIO !== 'true') {
    console.log('[AGENDADOR ESTOQUE HORÁRIO] Desativado (AGENDAR_ESTOQUE_HORARIO != true).');
    return;
  }
  const ini = Math.min(23, Math.max(0, parseInt(process.env.ESTOQUE_HORARIO_INICIO, 10) || 10));
  const fim = Math.min(23, Math.max(ini, parseInt(process.env.ESTOQUE_HORARIO_FIM, 10) || 17));
  console.log(`[AGENDADOR ESTOQUE HORÁRIO] Ativo — Estoque de hora em hora das ${String(ini).padStart(2, '0')}h às ${String(fim).padStart(2, '0')}h, dias úteis (seg–sex).`);

  agendarPorHoraUtil('AGENDADOR ESTOQUE HORÁRIO', ini, fim, async () => {
    // executarAtualizacaoEstoqueOracle já tem guarda anti-sobreposição,
    // watchdog e registro no Status dos Serviços.
    const r = await executarAtualizacaoEstoqueOracle({ usuarioEmail: 'agendador-horario' });
    if (r && r.pulou) console.log('[AGENDADOR ESTOQUE HORÁRIO] Pulado:', r.motivo);
    else console.log('[AGENDADOR ESTOQUE HORÁRIO] Estoque atualizado.');
  });
}

module.exports = { iniciarAgendadorEstoqueHorario };
