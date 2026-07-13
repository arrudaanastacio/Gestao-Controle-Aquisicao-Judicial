// =====================================================================
// sync-entrada-lotes.js
// Atualiza as Movimentações de Entrada (lotes/validade) puxando direto
// do Oracle (SCODES). Substitui TODO o conteúdo da tabela a cada
// execução — a query já traz só a janela móvel dos últimos 12 meses.
// =====================================================================
const { buscarEntradaLotes } = require('./entrada-lotes');
const { fecharPool } = require('./db-oracle');
const { importarEntradaLotesDeLinhas } = require('../src/routes.entradaLotes');

// Alias da coluna vinda do Oracle -> campo da tabela entrada_lotes_itens.
const MAPA_ORACLE = {
  ITEM: 'item',
  UND_DESCRICAO: 'unidade',
  ENT_DTH: 'data_entrada',
  TPM_DESCRICAO: 'tipo_movimentacao',
  UNT_DESCRICAO: 'unidade_transferencia',
  CMO_DESCRICAO: 'modalidade_compra',
  COM_NOTA_EMPENHO: 'nota_empenho',
  COM_NOTA_FISCAL: 'nota_fiscal',
  TRA_DOC: 'documento_transferencia',
  FABRICANTE: 'fabricante',
  PRO_CODIGO: 'codigo_item',
  QTDE: 'qtde',
  EST_QTDE_ACERTO: 'qtde_acerto',
  EST_VLR_UNITARIO: 'valor_unitario',
  EST_VLR_TOTAL: 'valor_total',
  USR_LOGIN: 'usuario_login',
  OBS: 'observacao',
  EST_TERMOLABEL: 'termolabil',
  FOR_DESCRICAO: 'fornecedor',
  FOR_CNPJ: 'fornecedor_cnpj',
  TRA_TIPO: 'tipo_transferencia',
  LOT_NUMERO: 'lote',
  LOT_DTH_VALIDADE: 'validade',
  LOTE_FOI_DIGITADO: 'lote_foi_digitado',
};

function valor(v) {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  const t = String(v).trim();
  return t === '' ? null : t;
}

/**
 * Atualiza as Movimentações de Entrada (lotes/validade) a partir do Oracle.
 * @returns {Promise<Object>} resumo { totalLinhas, duracaoMs }
 */
async function atualizarEntradaLotesViaOracle() {
  const t0 = Date.now();
  const brutas = await buscarEntradaLotes();

  const linhas = brutas.map((r) => {
    const linha = {};
    for (const [aliasOracle, campo] of Object.entries(MAPA_ORACLE)) {
      linha[campo] = valor(r[aliasOracle]);
    }
    return linha;
  });

  const resumo = importarEntradaLotesDeLinhas(linhas);
  resumo.duracaoMs = Date.now() - t0;
  return resumo;
}

module.exports = { atualizarEntradaLotesViaOracle };

// Permite rodar direto pela linha de comando: node oracle/sync-entrada-lotes.js
if (require.main === module) {
  require('dotenv').config();
  (async () => {
    try {
      console.log('[SYNC ENTRADA LOTES] Buscando movimentações de Entrada dos últimos 12 meses no Oracle...');
      const resumo = await atualizarEntradaLotesViaOracle();
      console.log('[SYNC ENTRADA LOTES] Concluido:', JSON.stringify(resumo));
    } catch (e) {
      console.error('[SYNC ENTRADA LOTES] Falha:', e.message);
      process.exitCode = 1;
    } finally {
      await fecharPool();
    }
  })();
}
