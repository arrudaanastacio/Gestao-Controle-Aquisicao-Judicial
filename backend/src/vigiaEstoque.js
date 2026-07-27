// Vigia de arquivo: importa o estoque automaticamente sempre que o CSV
// monitorado for atualizado. Usa polling (fs.watchFile), mais confiável em
// drives de rede/nuvem (G:) do que eventos de sistema de arquivos.

const fs = require('node:fs');
const path = require('node:path');
const { importarEstoqueDeBuffer } = require('./routes.estoque');
const { lerAssinatura, salvarAssinatura } = require('./vigiaEstado');
const reg = require('./registroServicos');

const CAMINHO_PADRAO = 'G:\\CAF\\GAF\\GGAF\\PROGRAMAÇÃO\\CPDAE\\RELATÓRIO DE COMPRAS\\2026\\MEDICAMENTO\\MACRO\\itens em estoque.csv';
const CAMINHO = process.env.CAMINHO_ESTOQUE_CSV || CAMINHO_PADRAO;
const INTERVALO = parseInt(process.env.VIGIA_INTERVALO_MS, 10) || 30000; // checa a cada 30s

let ultimaAssinatura = null; // "mtime|size" da última importação
let importando = false;

function assinatura(st) {
  return `${st.mtimeMs}|${st.size}`;
}

function tentarImportar(motivo) {
  if (importando) return;
  reg.marcarVerificacao('estoqueTP'); // sinal de vida para a tela de Status

  let st;
  try { st = fs.statSync(CAMINHO); }
  catch { return; } // arquivo não disponível agora (drive desconectado etc.)

  const assin = assinatura(st);
  if (assin === ultimaAssinatura) return; // nada mudou desde a última vez
  if (st.size < 1000) return;             // arquivo muito pequeno/incompleto

  importando = true;
  const inicioMs = reg.marcarInicio('estoqueTP');
  try {
    // Confirma estabilidade: o tamanho não pode estar mudando (gravação em curso)
    const buffer = fs.readFileSync(CAMINHO);
    const st2 = fs.statSync(CAMINHO);
    if (st2.size !== st.size) { importando = false; return; } // ainda gravando; tenta na próxima

    // Data de referência = data de modificação do arquivo (data de coleta do relatório)
    const d = new Date(st2.mtime);
    const dataReferencia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const resumo = importarEstoqueDeBuffer(buffer, {
      dataReferencia,
      nomeArquivo: path.basename(CAMINHO),
      usuarioEmail: 'auto-importador',
    });
    ultimaAssinatura = assinatura(st2);
    salvarAssinatura('estoque', ultimaAssinatura);
    const hist = resumo.arquivadoComoHistorico ? ` | ARQUIVADO histórico ref ${resumo.arquivadoComoHistorico}` : '';
    console.log(`[VIGIA ESTOQUE] ${motivo}: ${resumo.totalItens} itens importados (ref ${resumo.dataReferencia})${hist}.`);
    reg.registrarExecucao('estoqueTP', {
      resultado: 'sucesso',
      mensagem: `${resumo.totalItens} itens importados (referência ${resumo.dataReferencia})${hist}.`,
      registros: resumo.totalItens,
      arquivo: path.basename(CAMINHO),
      inicioMs,
    });
  } catch (e) {
    console.error('[VIGIA ESTOQUE] Falha ao importar:', e.message);
    reg.registrarExecucao('estoqueTP', {
      resultado: 'erro',
      mensagem: e.message,
      detalhe: e.stack,
      arquivo: path.basename(CAMINHO),
      inicioMs,
    });
  } finally {
    reg.marcarFim('estoqueTP');
    importando = false;
  }
}

function iniciarVigiaEstoque() {
  if (process.env.AUTO_IMPORTAR_ESTOQUE === 'false') {
    console.log('[VIGIA ESTOQUE] Desativado (AUTO_IMPORTAR_ESTOQUE=false).');
    return;
  }

  // Recupera a assinatura do último arquivo já importado. Se o arquivo atual
  // estiver diferente (ex.: atualizado com o sistema desligado), importa agora.
  ultimaAssinatura = lerAssinatura('estoque');
  fs.watchFile(CAMINHO, { interval: INTERVALO }, () => tentarImportar('Arquivo atualizado'));
  console.log('[VIGIA ESTOQUE] Monitorando atualizações em:', CAMINHO);
  console.log(`[VIGIA ESTOQUE] Verificação a cada ${Math.round(INTERVALO / 1000)}s. Importa sozinho quando o arquivo mudar.`);
  tentarImportar('Verificação ao iniciar');
}

// "Executar agora" da tela de Status dos Serviços: reimporta mesmo que o
// arquivo não tenha mudado (zerando a assinatura), que é justamente o que se
// espera de um disparo manual.
function executarAgora() {
  ultimaAssinatura = null;
  tentarImportar('Execução manual');
}

module.exports = { iniciarVigiaEstoque, executarAgora };
