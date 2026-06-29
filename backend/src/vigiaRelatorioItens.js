// Vigia de arquivo: importa o Relatório de Itens automaticamente quando o CSV
// monitorado for atualizado. Mesma lógica dos demais vigias (polling).

const fs = require('node:fs');
const path = require('node:path');
const { importarRelatorioItensDeBuffer } = require('./routes.relatorioItens');
const { lerAssinatura, salvarAssinatura } = require('./vigiaEstado');

const CAMINHO_PADRAO = 'G:\\CAF\\GAF\\GGAF\\PROGRAMAÇÃO\\CPDAE\\RELATÓRIO DE COMPRAS\\2026\\MEDICAMENTO\\MACRO\\Relatório de Itens.csv';
const CAMINHO = process.env.CAMINHO_RELATORIO_ITENS_CSV || CAMINHO_PADRAO;
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
    if (st2.size !== st.size) { importando = false; return; }

    const d = new Date(st2.mtime);
    const dataReferencia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const resumo = importarRelatorioItensDeBuffer(buffer, {
      dataReferencia,
      nomeArquivo: path.basename(CAMINHO),
      usuarioEmail: 'auto-importador',
    });
    ultimaAssinatura = assinatura(st2);
    salvarAssinatura('relatorio_itens', ultimaAssinatura);
    console.log(`[VIGIA RELATÓRIO ITENS] ${motivo}: ${resumo.totalItens} itens (ref ${resumo.dataReferencia}).`);
  } catch (e) {
    console.error('[VIGIA RELATÓRIO ITENS] Falha ao importar:', e.message);
  } finally {
    importando = false;
  }
}

function iniciarVigiaRelatorioItens() {
  if (process.env.AUTO_IMPORTAR_RELATORIO_ITENS === 'false') {
    console.log('[VIGIA RELATÓRIO ITENS] Desativado.');
    return;
  }
  ultimaAssinatura = lerAssinatura('relatorio_itens');
  fs.watchFile(CAMINHO, { interval: INTERVALO }, () => tentarImportar('Arquivo atualizado'));
  console.log('[VIGIA RELATÓRIO ITENS] Monitorando atualizações em:', CAMINHO);
  tentarImportar('Verificação ao iniciar');
}

module.exports = { iniciarVigiaRelatorioItens };
