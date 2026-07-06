// Vigia de arquivo: importa as Atas de Registro de Preço (SISCOA) automaticamente
// sempre que o arquivo monitorado for atualizado. Mesma lógica dos outros vigias
// (polling, mais confiável em drives de rede/nuvem do que eventos de sistema de arquivos).

const fs = require('node:fs');
const path = require('node:path');
const { importarAtasDeBuffer } = require('./routes.atas');
const { lerAssinatura, salvarAssinatura } = require('./vigiaEstado');

const CAMINHO_PADRAO = 'G:\\CAF\\GAF\\GGAF\\PROGRAMAÇÃO\\CPDAE\\RELATÓRIO DE COMPRAS\\2026\\MEDICAMENTO\\MACRO\\Atas SISCOA.xls';
const CAMINHO = process.env.CAMINHO_ATAS_CSV || CAMINHO_PADRAO;
const INTERVALO = parseInt(process.env.VIGIA_INTERVALO_MS, 10) || 30000;

let ultimaAssinatura = null;
let importando = false;

function assinatura(st) { return `${st.mtimeMs}|${st.size}`; }

function tentarImportar(motivo) {
  if (importando) return;
  let st;
  try { st = fs.statSync(CAMINHO); } catch { return; }

  const assin = assinatura(st);
  if (assin === ultimaAssinatura) return;
  if (st.size < 1000) return;

  importando = true;
  try {
    const buffer = fs.readFileSync(CAMINHO);
    const st2 = fs.statSync(CAMINHO);
    if (st2.size !== st.size) { importando = false; return; } // ainda gravando

    const d = new Date(st2.mtime);
    const dataReferencia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const resumo = importarAtasDeBuffer(buffer, {
      dataReferencia,
      nomeArquivo: path.basename(CAMINHO),
      usuarioEmail: 'auto-importador',
    });
    ultimaAssinatura = assinatura(st2);
    salvarAssinatura('atas', ultimaAssinatura);
    console.log(`[VIGIA ATAS] ${motivo}: ${resumo.totalLinhas} linhas / ${resumo.totalAtas} atas (ref ${resumo.dataReferencia}).`);
  } catch (e) {
    console.error('[VIGIA ATAS] Falha ao importar:', e.message);
  } finally {
    importando = false;
  }
}

function iniciarVigiaAtas() {
  if (process.env.AUTO_IMPORTAR_ATAS === 'false') {
    console.log('[VIGIA ATAS] Desativado (AUTO_IMPORTAR_ATAS=false).');
    return;
  }
  ultimaAssinatura = lerAssinatura('atas');
  fs.watchFile(CAMINHO, { interval: INTERVALO }, () => tentarImportar('Arquivo atualizado'));
  console.log('[VIGIA ATAS] Monitorando atualizações em:', CAMINHO);
  tentarImportar('Verificação ao iniciar');
}

module.exports = { iniciarVigiaAtas };
