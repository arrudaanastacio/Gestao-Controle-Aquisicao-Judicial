// Vigia do arquivo "RELATÓRIO DE COMPRAS TENENTE PENA - Macro.xlsm".
// Duas vezes ao dia (12h e 19h) verifica se o arquivo mudou na pasta de rede
// e, se sim, importa automaticamente em modo "substituir" (status pode mudar
// e novas linhas de solicitação são inseridas).

const fs = require('node:fs');
const { lerAssinatura, salvarAssinatura } = require('./vigiaEstado');
const { agendarDiariamente } = require('./agendadorUtil');

const CAMINHO_PADRAO = 'G:\\CAF\\GAF\\GGAF\\PROGRAMAÇÃO\\CPDAE\\RELATÓRIO DE COMPRAS\\2026\\MEDICAMENTO\\RELATÓRIO DE COMPRAS TENENTE PENA - Macro.xlsm';
const CAMINHO = process.env.CAMINHO_SOLICITACOES || CAMINHO_PADRAO;

let ultimaAssinatura = null;

function assinaturaArquivo() {
  try {
    const st = fs.statSync(CAMINHO);
    return `${st.mtimeMs}|${st.size}`;
  } catch {
    return null;
  }
}

function tentarImportar(motivo) {
  const assin = assinaturaArquivo();
  if (!assin) {
    console.log('[VIGIA SOLICITAÇÕES] Arquivo não encontrado em', CAMINHO);
    return;
  }
  if (assin === ultimaAssinatura) {
    console.log(`[VIGIA SOLICITAÇÕES] ${motivo}: sem alterações no arquivo.`);
    return;
  }

  try {
    const buffer = fs.readFileSync(CAMINHO);
    if (assinaturaArquivo() !== assin) return; // arquivo ainda sendo gravado

    const { gravarImportacao } = require('./routes.importarSolicitacoes');
    const resumo = gravarImportacao(buffer, 'substituir', 'RELATÓRIO DE COMPRAS TENENTE PENA - Macro.xlsm', 'auto-importador');
    ultimaAssinatura = assin;
    salvarAssinatura('solicitacoes', ultimaAssinatura);
    console.log(`[VIGIA SOLICITAÇÕES] ${motivo}: ${resumo.inseridos} inseridos, ${resumo.atualizados} atualizados, ${resumo.itensInexistentes} itens não encontrados no elenco.`);
  } catch (e) {
    console.error('[VIGIA SOLICITAÇÕES] Falha ao importar:', e.message);
  }
}

// Importação manual "agora" (botão admin nas telas de Compras TP / Análise TP).
// Ignora a assinatura: importa sempre a versão mais recente do arquivo, mesmo
// que o vigia já tenha visto essa versão. Roda dentro do processo do app, que
// já detém o banco (síncrono) — seguro, sem lock externo.
function forcarImportacaoSolicitacoes(usuarioEmail, usuarioId = null) {
  const assin = assinaturaArquivo();
  if (!assin) {
    const err = new Error('Arquivo do Relatório de Compras TP não encontrado na pasta de rede.');
    err.codigo = 'ARQUIVO_NAO_ENCONTRADO';
    throw err;
  }
  const buffer = fs.readFileSync(CAMINHO);
  if (assinaturaArquivo() !== assin) {
    const err = new Error('O arquivo está sendo gravado neste momento. Tente de novo em alguns segundos.');
    err.codigo = 'ARQUIVO_EM_GRAVACAO';
    throw err;
  }
  const { gravarImportacao } = require('./routes.importarSolicitacoes');
  const resumo = gravarImportacao(buffer, 'substituir', 'RELATÓRIO DE COMPRAS TENENTE PENA - Macro.xlsm', usuarioEmail || 'atualizacao-manual', usuarioId);
  ultimaAssinatura = assin;
  salvarAssinatura('solicitacoes', ultimaAssinatura);
  console.log(`[VIGIA SOLICITAÇÕES] Atualização manual por ${usuarioEmail}: ${resumo.inseridos} inseridos, ${resumo.atualizados} atualizados.`);
  return resumo;
}

function iniciarVigiaSolicitacoes() {
  if (process.env.AUTO_IMPORTAR_SOLICITACOES === 'false') {
    console.log('[VIGIA SOLICITAÇÕES] Desativado (AUTO_IMPORTAR_SOLICITACOES=false).');
    return;
  }
  ultimaAssinatura = lerAssinatura('solicitacoes');
  agendarDiariamente('VIGIA SOLICITAÇÕES 12h', 12, 0, () => tentarImportar('Verificação das 12h'));
  agendarDiariamente('VIGIA SOLICITAÇÕES 19h', 19, 0, () => tentarImportar('Verificação das 19h'));
  console.log('[VIGIA SOLICITAÇÕES] Agendado para checar às 12h e 19h. Arquivo:', CAMINHO);
}

module.exports = { iniciarVigiaSolicitacoes, forcarImportacaoSolicitacoes };
