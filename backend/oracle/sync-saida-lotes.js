// =====================================================================
// sync-saida-lotes.js
// Atualiza as Movimentações de Saída (lotes/validade) puxando direto do
// Oracle (SCODES). Substitui TODO o conteúdo da tabela a cada execução —
// a query já traz só a janela móvel dos últimos 12 meses.
// Espelha o sync-entrada-lotes.js.
// =====================================================================
const { buscarSaidaLotes } = require('./saida-lotes');
const { fecharPool } = require('./db-oracle');
const { importarSaidaLotesDeLinhas } = require('../src/routes.saidaLotes');

// Alias da coluna vinda do Oracle -> campo da tabela saida_lotes_itens.
const MAPA_ORACLE = {
  ITEM: 'item',
  UND_DESCRICAO: 'unidade',
  SAI_DTH: 'data_saida',
  TPM_DESCRICAO: 'tipo_movimentacao',
  UNT_DESCRICAO: 'unidade_transferencia',
  FOR_DESCRICAO: 'fornecedor',
  FOR_CNPJ: 'fornecedor_cnpj',
  TRA_DOC: 'documento_transferencia',
  TRA_TIPO: 'tipo_transferencia',
  FABRICANTE: 'fabricante',
  PRO_CODIGO: 'codigo_item',
  QTDE: 'qtde',
  USR_LOGIN: 'usuario_login',
  OBS: 'observacao',
  LOT_NUMERO: 'lote',
  LOT_DTH_VALIDADE: 'validade',
  LOTE_FOI_DIGITADO: 'lote_foi_digitado',
  CATEGORIA: 'categoria',
};

// Formata um Date em hora LOCAL "AAAA-MM-DD HH:MM:SS" (nunca usar
// toISOString() aqui: ele converte para UTC e desloca 3h a mais no Brasil).
function dataHoraLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function valor(v) {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return dataHoraLocal(v);
  const t = String(v).trim();
  return t === '' ? null : t;
}

/**
 * Atualiza as Movimentações de Saída (lotes/validade) a partir do Oracle.
 * @returns {Promise<Object>} resumo { totalLinhas, duracaoMs }
 */
async function atualizarSaidaLotesViaOracle() {
  const t0 = Date.now();
  const brutas = await buscarSaidaLotes();

  const linhas = brutas.map((r) => {
    const linha = {};
    for (const [aliasOracle, campo] of Object.entries(MAPA_ORACLE)) {
      linha[campo] = valor(r[aliasOracle]);
    }
    return linha;
  });

  const resumo = importarSaidaLotesDeLinhas(linhas);
  resumo.duracaoMs = Date.now() - t0;
  return resumo;
}

module.exports = { atualizarSaidaLotesViaOracle };

// Permite rodar direto pela linha de comando: node oracle/sync-saida-lotes.js
if (require.main === module) {
  require('dotenv').config();
  (async () => {
    try {
      console.log('[SYNC SAIDA LOTES] Buscando movimentações de Saída dos últimos 12 meses no Oracle...');
      const resumo = await atualizarSaidaLotesViaOracle();
      console.log('[SYNC SAIDA LOTES] Concluido:', JSON.stringify(resumo));
    } catch (e) {
      console.error('[SYNC SAIDA LOTES] Falha:', e.message);
      process.exitCode = 1;
    } finally {
      await fecharPool();
    }
  })();
}
