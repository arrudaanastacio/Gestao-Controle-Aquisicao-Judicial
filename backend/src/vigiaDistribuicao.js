// Vigia de arquivos: importa o módulo Distribuição (Status de Faturas +
// Extrato de Movimentações + Itens Elegíveis por unidade + Conversão OD)
// automaticamente sempre que QUALQUER um dos 4 arquivos monitorados for
// atualizado. Mesma lógica de polling dos outros vigias (mais confiável em
// pasta de rede do que eventos de sistema de arquivos).

const fs = require('node:fs');
const path = require('node:path');
const { lerAssinatura, salvarAssinatura } = require('./vigiaEstado');

const PASTA_PADRAO = 'G:\\CAF\\GAF\\GGAF\\PROGRAMAÇÃO\\CPDAE\\GRADES DISTRIBUIÇÕES\\2026\\BANCO DE DADOS\\RELATÓRIOS';
const PASTA = process.env.CAMINHO_DISTRIBUICAO || PASTA_PADRAO;

const CAMINHO_EXTRATO = path.join(PASTA, '1.Extrato Simples.xls');
const CAMINHO_STATUS_FATURA = path.join(PASTA, '2.Status Fatura WMS_IBL.xlsx');
const CAMINHO_ELEGIVEIS = path.join(PASTA, '6.Elenco CEDMAC.xlsx');
const CAMINHO_CONVERSAO_OD = path.join(PASTA, '7.Conversão OD.xlsx');

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
  const a = assinaturaArquivo(CAMINHO_EXTRATO);
  const b = assinaturaArquivo(CAMINHO_STATUS_FATURA);
  const c = assinaturaArquivo(CAMINHO_ELEGIVEIS);
  const d = assinaturaArquivo(CAMINHO_CONVERSAO_OD);
  if (!a || !b || !c || !d) return null; // algum arquivo ainda não existe
  return `${a}::${b}::${c}::${d}`;
}

function tentarImportar(motivo) {
  if (importando) return;
  const assin = assinaturaConjunta();
  if (!assin || assin === ultimaAssinatura) return;

  importando = true;
  try {
    const bufExtrato = fs.readFileSync(CAMINHO_EXTRATO);
    const bufStatus = fs.readFileSync(CAMINHO_STATUS_FATURA);
    const bufElegiveis = fs.readFileSync(CAMINHO_ELEGIVEIS);
    const bufConversaoOD = fs.readFileSync(CAMINHO_CONVERSAO_OD);

    // Confere se os arquivos não mudaram durante a leitura (ainda sendo gravados)
    if (assinaturaConjunta() !== assin) { importando = false; return; }

    const {
      parsearExtratoSimples, parsearStatusFaturas, parsearItensElegiveis, parsearConversaoOD,
      importarExtratoSimples, importarStatusFaturas, importarItensElegiveis, importarConversaoOD,
      carregarMapeamentoGsnet,
    } = require('./routes.distribuicao');

    const mapaGsnet = carregarMapeamentoGsnet();
    const opcoes = { usuarioEmail: 'auto-importador', mapaGsnet };

    const linhasExtrato = parsearExtratoSimples(bufExtrato);
    const resumoExtrato = importarExtratoSimples(linhasExtrato, { ...opcoes, nomeArquivo: '1.Extrato Simples.xls' });

    const linhasStatus = parsearStatusFaturas(bufStatus);
    const resumoStatus = importarStatusFaturas(linhasStatus, { ...opcoes, nomeArquivo: '2.Status Fatura WMS_IBL.xlsx' });

    const linhasElegiveis = parsearItensElegiveis(bufElegiveis);
    const resumoElegiveis = importarItensElegiveis(linhasElegiveis, { usuarioEmail: 'auto-importador', nomeArquivo: '6.Elenco CEDMAC.xlsx' });

    const linhasConversaoOD = parsearConversaoOD(bufConversaoOD);
    const resumoConversaoOD = importarConversaoOD(linhasConversaoOD, { usuarioEmail: 'auto-importador', nomeArquivo: '7.Conversão OD.xlsx' });

    ultimaAssinatura = assin;
    salvarAssinatura('distribuicao', ultimaAssinatura);
    console.log(`[VIGIA DISTRIBUIÇÃO] ${motivo}: Extrato ${resumoExtrato.totalLinhas} linhas, Status Fatura ${resumoStatus.totalLinhas} linhas, Elegíveis ${resumoElegiveis.totalLinhas} linhas, Conversão OD ${resumoConversaoOD.totalLinhas} linhas.`);
  } catch (e) {
    console.error('[VIGIA DISTRIBUIÇÃO] Falha ao importar:', e.message);
  } finally {
    importando = false;
  }
}

function iniciarVigiaDistribuicao() {
  if (process.env.AUTO_IMPORTAR_DISTRIBUICAO === 'false') {
    console.log('[VIGIA DISTRIBUIÇÃO] Desativado (AUTO_IMPORTAR_DISTRIBUICAO=false).');
    return;
  }
  ultimaAssinatura = lerAssinatura('distribuicao');
  [CAMINHO_EXTRATO, CAMINHO_STATUS_FATURA, CAMINHO_ELEGIVEIS, CAMINHO_CONVERSAO_OD].forEach((caminho) => {
    fs.watchFile(caminho, { interval: INTERVALO }, () => tentarImportar('Arquivo atualizado'));
  });
  console.log('[VIGIA DISTRIBUIÇÃO] Monitorando atualizações em:', PASTA);
  tentarImportar('Verificação ao iniciar');
}

module.exports = { iniciarVigiaDistribuicao };
