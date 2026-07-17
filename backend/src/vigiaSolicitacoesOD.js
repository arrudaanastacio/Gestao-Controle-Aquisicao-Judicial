// Vigia do arquivo "RELATÓRIO DE COMPRAS OUTRAS DEMANDAS - Macro.xlsm".
// Duas vezes ao dia (12h e 19h) verifica se o arquivo mudou na pasta de rede
// e, se sim, importa automaticamente (abas FRONT PAGE e TABELA são ignoradas).

const fs = require('node:fs');
const { lerAssinatura, salvarAssinatura } = require('./vigiaEstado');
const { agendarDiariamente } = require('./agendadorUtil');

const CAMINHO_PADRAO = 'G:\\CAF\\GAF\\GGAF\\PROGRAMAÇÃO\\CPDAE\\RELATÓRIO DE COMPRAS\\2026\\OUTRAS DEMANDAS\\RELATÓRIO DE COMPRAS OUTRAS DEMANDAS - Macro.xlsm';
const CAMINHO = process.env.CAMINHO_SOLICITACOES_OD || CAMINHO_PADRAO;

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
    console.log('[VIGIA SOLICITAÇÕES OD] Arquivo não encontrado em', CAMINHO);
    return;
  }
  if (assin === ultimaAssinatura) {
    console.log(`[VIGIA SOLICITAÇÕES OD] ${motivo}: sem alterações no arquivo.`);
    return;
  }

  try {
    const buffer = fs.readFileSync(CAMINHO);
    if (assinaturaArquivo() !== assin) return; // arquivo ainda sendo gravado

    const { gravarImportacao } = require('./routes.solicitacoesOD');
    const resumo = gravarImportacao(buffer, 'RELATÓRIO DE COMPRAS OUTRAS DEMANDAS - Macro.xlsm', 'auto-importador');
    ultimaAssinatura = assin;
    salvarAssinatura('solicitacoes_od', ultimaAssinatura);
    console.log(`[VIGIA SOLICITAÇÕES OD] ${motivo}: ${resumo.inseridos} inseridos, ${resumo.atualizados} atualizados.`);
  } catch (e) {
    console.error('[VIGIA SOLICITAÇÕES OD] Falha ao importar:', e.message);
  }
}

function iniciarVigiaSolicitacoesOD() {
  if (process.env.AUTO_IMPORTAR_SOLICITACOES_OD === 'false') {
    console.log('[VIGIA SOLICITAÇÕES OD] Desativado (AUTO_IMPORTAR_SOLICITACOES_OD=false).');
    return;
  }
  ultimaAssinatura = lerAssinatura('solicitacoes_od');
  agendarDiariamente('VIGIA SOLICITAÇÕES OD 12h', 12, 0, () => tentarImportar('Verificação das 12h'));
  agendarDiariamente('VIGIA SOLICITAÇÕES OD 19h', 19, 0, () => tentarImportar('Verificação das 19h'));
  console.log('[VIGIA SOLICITAÇÕES OD] Agendado para checar às 12h e 19h. Arquivo:', CAMINHO);
}

module.exports = { iniciarVigiaSolicitacoesOD };
