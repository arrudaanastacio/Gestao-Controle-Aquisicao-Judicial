// Vigia de arquivo: importa a Listagem de Autores automaticamente sempre que
// o CSV monitorado for atualizado. Mesma lógica do vigia de estoque (polling).

const fs = require('node:fs');
const path = require('node:path');
const { importarAutoresDeBuffer } = require('./routes.autores');

const CAMINHO_PADRAO = 'G:\\CAF\\GAF\\GGAF\\PROGRAMAÇÃO\\CPDAE\\RELATÓRIO DE COMPRAS\\2026\\MEDICAMENTO\\MACRO\\Listagem de Autores.csv';
const CAMINHO = process.env.CAMINHO_AUTORES_CSV || CAMINHO_PADRAO;
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

    const resumo = importarAutoresDeBuffer(buffer, {
      dataReferencia,
      nomeArquivo: path.basename(CAMINHO),
      usuarioEmail: 'auto-importador',
    });
    ultimaAssinatura = assinatura(st2);
    console.log(`[VIGIA AUTORES] ${motivo}: ${resumo.totalLinhas} linhas / ${resumo.totalAutores} autores (ref ${resumo.dataReferencia}).`);
  } catch (e) {
    console.error('[VIGIA AUTORES] Falha ao importar:', e.message);
  } finally {
    importando = false;
  }
}

function iniciarVigiaAutores() {
  if (process.env.AUTO_IMPORTAR_AUTORES === 'false') {
    console.log('[VIGIA AUTORES] Desativado (AUTO_IMPORTAR_AUTORES=false).');
    return;
  }
  try { ultimaAssinatura = assinatura(fs.statSync(CAMINHO)); }
  catch { ultimaAssinatura = null; }

  fs.watchFile(CAMINHO, { interval: INTERVALO }, () => tentarImportar('Arquivo atualizado'));
  console.log('[VIGIA AUTORES] Monitorando atualizações em:', CAMINHO);
}

module.exports = { iniciarVigiaAutores };
