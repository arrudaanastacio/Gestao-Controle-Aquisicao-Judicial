// Vigia de arquivos: importa o Estoque Outras Demandas (GSNET + IBL)
// automaticamente sempre que QUALQUER um dos 3 arquivos monitorados for
// atualizado. Mesma lógica de polling dos outros vigias (mais confiável em
// pasta de rede do que eventos de sistema de arquivos).

const fs = require('node:fs');
const path = require('node:path');
const { lerAssinatura, salvarAssinatura } = require('./vigiaEstado');

const PASTA_PADRAO = 'G:\\CAF\\GAF\\GGAF\\PROGRAMAÇÃO\\CPDAE\\GRADES DISTRIBUIÇÕES\\2026\\OUTRAS DEMANDAS\\Estoque Outras Demandas';
const PASTA = process.env.CAMINHO_ESTOQUE_OD || PASTA_PADRAO;

const CAMINHO_MAPEAMENTO = path.join(PASTA, 'Cadastro Itens GSNET - IBL.xlsx');
const CAMINHO_GSNET = path.join(PASTA, 'Estoque_GSNET.xlsx');
const CAMINHO_IBL = path.join(PASTA, 'Estoque_IBL.xlsx');

const INTERVALO = parseInt(process.env.VIGIA_INTERVALO_MS, 10) || 30000;

let ultimaAssinatura = null;
let importando = false;

function assinaturaArquivo(caminho) {
  try {
    const st = fs.statSync(caminho);
    return `${st.mtimeMs}|${st.size}`;
  } catch {
    return null;
  }
}

function assinaturaConjunta() {
  const a = assinaturaArquivo(CAMINHO_MAPEAMENTO);
  const b = assinaturaArquivo(CAMINHO_GSNET);
  const c = assinaturaArquivo(CAMINHO_IBL);
  if (!a || !b || !c) return null; // algum arquivo ainda não existe
  return `${a}::${b}::${c}`;
}

// Lê os 3 arquivos da pasta de rede e devolve os buffers (usado tanto pelo
// vigia automático quanto pelo botão de importação manual).
function lerArquivosEstoqueOD() {
  try {
    return {
      bufMapeamento: fs.readFileSync(CAMINHO_MAPEAMENTO),
      bufGsnet: fs.readFileSync(CAMINHO_GSNET),
      bufIbl: fs.readFileSync(CAMINHO_IBL),
    };
  } catch {
    return null;
  }
}

function tentarImportar(motivo) {
  if (importando) return;
  const assin = assinaturaConjunta();
  if (!assin || assin === ultimaAssinatura) return;

  importando = true;
  try {
    const arquivos = lerArquivosEstoqueOD();
    if (!arquivos) { importando = false; return; }

    // Confere se os arquivos não mudaram durante a leitura (ainda sendo gravados)
    if (assinaturaConjunta() !== assin) { importando = false; return; }

    const { importarEstoqueOD } = require('./routes.estoqueOD');
    const resumo = importarEstoqueOD(arquivos.bufMapeamento, arquivos.bufGsnet, arquivos.bufIbl, {
      nomeArquivo: 'Estoque Outras Demandas (GSNET + IBL)',
      usuarioEmail: 'auto-importador',
    });
    ultimaAssinatura = assin;
    salvarAssinatura('estoque_od', ultimaAssinatura);
    console.log(`[VIGIA ESTOQUE OD] ${motivo}: ${resumo.totalItens} linhas (${resumo.totalDivergente} divergentes, ${resumo.totalSemCorrespondencia} sem correspondência).`);
  } catch (e) {
    console.error('[VIGIA ESTOQUE OD] Falha ao importar:', e.message);
  } finally {
    importando = false;
  }
}

function iniciarVigiaEstoqueOD() {
  if (process.env.AUTO_IMPORTAR_ESTOQUE_OD === 'false') {
    console.log('[VIGIA ESTOQUE OD] Desativado (AUTO_IMPORTAR_ESTOQUE_OD=false).');
    return;
  }
  ultimaAssinatura = lerAssinatura('estoque_od');
  [CAMINHO_MAPEAMENTO, CAMINHO_GSNET, CAMINHO_IBL].forEach((caminho) => {
    fs.watchFile(caminho, { interval: INTERVALO }, () => tentarImportar('Arquivo atualizado'));
  });
  console.log('[VIGIA ESTOQUE OD] Monitorando atualizações em:', PASTA);
  tentarImportar('Verificação ao iniciar');
}

module.exports = { iniciarVigiaEstoqueOD, lerArquivosEstoqueOD };
