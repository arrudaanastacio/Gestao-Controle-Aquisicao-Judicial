// =====================================================================
// vigiaAtasSiscoa.js
// Busca diária automática das Atas de Registro de Preço DIRETO do SISCOA
// (via HTTP autenticado), sem depender do arquivo "Atas SISCOA.xls" copiado
// na pasta de rede.
//
// É o "irmão pela internet" do vigiaAtas.js (que observa o arquivo local):
// baixa o relatório do site e joga no MESMO importador (importarAtasDeBuffer),
// então tabela, regras de vigência e a tela de Atas continuam idênticas.
//
// Liga/desliga e horário pelo .env:
//   AUTO_IMPORTAR_ATAS_SISCOA=false  -> desliga (padrão é ligado)
//   HORA_SYNC_ATAS=6                 -> hora de início (0-23), padrão 6
//   MINUTO_SYNC_ATAS=0               -> minuto (0-59), padrão 0
//   SISCOA_USUARIO / SISCOA_SENHA    -> credenciais (obrigatórias)
// =====================================================================
const db = require('./db');
const { agendarDiariamente } = require('./agendadorUtil');
const { baixarRelatorioAtas, credenciaisConfiguradas } = require('./siscoaApi');
const { importarAtasDeBuffer } = require('./routes.atas');
const reg = require('./registroServicos');

const ID = 'atasSiscoa';

// Já buscou do SISCOA com sucesso nas últimas 18h? Evita repuxar o site a
// cada reinício. Olha o histórico de execuções deste serviço específico.
function jaBuscouHoje() {
  try {
    const r = db.prepare(
      "SELECT 1 FROM servico_execucoes WHERE servico = ? AND resultado = 'sucesso' AND iniciado_em >= datetime('now','localtime','-18 hours') LIMIT 1"
    ).get(ID);
    return !!r;
  } catch {
    return false;
  }
}

// Baixa o relatório do SISCOA e importa. Registra UMA execução na tela de
// Status (sucesso ou erro), como os demais serviços.
async function buscarEImportar(opcoesRegistro = {}) {
  if (!credenciaisConfiguradas()) {
    console.log('[ATAS SISCOA] Pulado: credenciais do SISCOA não configuradas no .env.');
    reg.registrarExecucao(ID, {
      resultado: 'erro',
      nivel: 'WARNING',
      mensagem: 'Credenciais do SISCOA não configuradas no .env (SISCOA_USUARIO / SISCOA_SENHA) — busca pulada.',
      arquivo: 'SISCOA',
      ...opcoesRegistro,
    });
    return null;
  }

  const inicioMs = reg.marcarInicio(ID);
  try {
    const { buffer, tamanho } = await baixarRelatorioAtas();
    // Data de referência = hoje (o download é "agora"). O importador substitui
    // a foto do mesmo dia, então rodar de novo no mesmo dia não duplica.
    const resumo = importarAtasDeBuffer(buffer, {
      nomeArquivo: 'SISCOA (download direto)',
      usuarioEmail: opcoesRegistro.usuarioEmail || 'auto-importador',
      usuarioId: opcoesRegistro.usuarioId ?? null,
    });
    reg.marcarFim(ID);
    console.log(`[ATAS SISCOA] ${resumo.totalLinhas} linhas / ${resumo.totalAtas} atas (ref ${resumo.dataReferencia}, ${tamanho} bytes).`);
    reg.registrarExecucao(ID, {
      resultado: 'sucesso',
      mensagem: `${resumo.totalLinhas} linhas / ${resumo.totalAtas} atas (referência ${resumo.dataReferencia}).`,
      registros: resumo.totalLinhas,
      arquivo: 'SISCOA (download direto)',
      inicioMs,
      ...opcoesRegistro,
    });
    return resumo;
  } catch (e) {
    reg.marcarFim(ID);
    console.error(`[ATAS SISCOA] Falha [${e.codigo || 'ERRO'}]:`, e.message);
    reg.registrarExecucao(ID, {
      resultado: 'erro',
      nivel: 'ERROR',
      mensagem: e.message,
      detalhe: e.stack || null,
      arquivo: 'SISCOA',
      inicioMs,
      ...opcoesRegistro,
    });
    throw e;
  }
}

function iniciarVigiaAtasSiscoa() {
  if (process.env.AUTO_IMPORTAR_ATAS_SISCOA === 'false') {
    console.log('[ATAS SISCOA] Desativado (AUTO_IMPORTAR_ATAS_SISCOA=false).');
    return;
  }
  if (!credenciaisConfiguradas()) {
    console.log('[ATAS SISCOA] Sem credenciais do SISCOA no .env — agendamento não iniciado.');
    return;
  }
  const hora = Math.min(23, Math.max(0, parseInt(process.env.HORA_SYNC_ATAS, 10) || 6));
  const minuto = Math.min(59, Math.max(0, parseInt(process.env.MINUTO_SYNC_ATAS, 10) || 0));
  console.log(`[ATAS SISCOA] Ativo — busca diária às ${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}.`);
  agendarDiariamente('ATAS SISCOA', hora, minuto, buscarEImportar, {
    recuperarSePerdido: true,
    jaRodouHoje: jaBuscouHoje,
  });
}

// "Executar agora" da tela de Status e do botão na tela de Atas.
async function executarAgora(usuarioEmail, usuarioId) {
  return buscarEImportar({ origem: 'manual', usuarioEmail: usuarioEmail || null, usuarioId: usuarioId ?? null });
}

module.exports = { iniciarVigiaAtasSiscoa, buscarEImportar, executarAgora };
