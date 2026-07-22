// =====================================================================
// estoqueUdtp.js
// Importa o ESTOQUE POR LOTE da API UDTP (/api/estoque/{data}).
//
// É a fonte de LOTE, VALIDADE e UNIDADE DE MEDIDA — campos que a API de
// reservas não devolve. Liga-se às reservas pelo codigo_item.
//
// Campos confirmados na API em 22/07/2026:
//   codigoItem, comMarca, descricao, lote, saldo, unidadeMedida, validade
// Observações do dado real:
//   - ~8.4k linhas/dia para ~7.4k itens: uma linha por LOTE;
//   - só itens com saldo > 0 trazem lote/validade (os zerados vêm nulos);
//   - a API devolve 404 para o dia de hoje (só publica o dia fechado).
// =====================================================================
const db = require('./db');
const { buscarEstoque, normalizarData } = require('./udtpApi');
const { paraNumero, paraDataISO, extrairLista } = require('./reservasUdtp');

// Mapeamento tolerante (mesma filosofia do importador de reservas).
function normalizarChave(k) {
  return String(k).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const SINONIMOS = {
  codigo_item: ['codigoitem', 'codigo', 'codigoproduto', 'coditem'],
  descricao: ['descricao', 'nomemedicamento', 'medicamento', 'nome', 'produto'],
  lote: ['lote', 'numerolote', 'nrolote', 'numlote'],
  validade: ['validade', 'datavalidade', 'dtvalidade', 'vencimento'],
  saldo: ['saldo', 'quantidade', 'qtd', 'qtde', 'saldoestoque'],
  unidade_medida: ['unidademedida', 'unidade', 'und', 'unid', 'um'],
  com_marca: ['commarca', 'marca'],
};

function mapearLinha(reg) {
  const porChave = new Map();
  for (const k of Object.keys(reg || {})) porChave.set(normalizarChave(k), k);

  const linha = {};
  const usados = new Set();
  for (const [campo, nomes] of Object.entries(SINONIMOS)) {
    for (const nome of nomes) {
      if (porChave.has(nome)) {
        const orig = porChave.get(nome);
        linha[campo] = reg[orig];
        usados.add(orig);
        break;
      }
    }
    if (!(campo in linha)) linha[campo] = null;
  }

  linha.saldo = paraNumero(linha.saldo);
  linha.validade = paraDataISO(linha.validade);
  linha.com_marca = linha.com_marca === true ? 1 : (linha.com_marca === false ? 0 : null);
  for (const c of ['codigo_item', 'descricao', 'lote', 'unidade_medida']) {
    linha[c] = linha[c] === null || linha[c] === undefined ? null : String(linha[c]).trim();
  }

  const naoUsados = Object.keys(reg || {}).filter((k) => !usados.has(k));
  return { linha, naoUsados };
}

// Grava a foto do dia, refazendo a data (API = fonte da verdade).
function gravarSnapshotEstoque(dataISO, registros, usuarioEmail) {
  const camposNaoMapeados = new Set();
  const linhas = [];
  for (const r of registros) {
    const { linha, naoUsados } = mapearLinha(r);
    naoUsados.forEach((c) => camposNaoMapeados.add(c));
    linhas.push(linha);
  }

  let importacaoId;
  db.exec('BEGIN');
  try {
    const antigas = db.prepare('SELECT id FROM estoque_udtp_importacoes WHERE data_referencia = ?').all(dataISO);
    for (const a of antigas) {
      db.prepare('DELETE FROM estoque_udtp_lotes WHERE importacao_id = ?').run(a.id);
      db.prepare('DELETE FROM estoque_udtp_importacoes WHERE id = ?').run(a.id);
    }

    const info = db.prepare(
      'INSERT INTO estoque_udtp_importacoes (data_referencia, origem, usuario_email, total_itens) VALUES (?, ?, ?, ?)'
    ).run(dataISO, 'API UDTP', usuarioEmail || 'sistema', linhas.length);
    importacaoId = info.lastInsertRowid;

    const ins = db.prepare(`
      INSERT INTO estoque_udtp_lotes
        (importacao_id, data_referencia, codigo_item, descricao, lote, validade, saldo, unidade_medida, com_marca)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const l of linhas) {
      ins.run(importacaoId, dataISO, l.codigo_item, l.descricao, l.lote, l.validade, l.saldo, l.unidade_medida, l.com_marca);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return {
    dataReferencia: dataISO,
    importacaoId,
    totalRegistros: linhas.length,
    comLote: linhas.filter((l) => l.lote).length,
    semCodigoItem: linhas.filter((l) => !l.codigo_item).length,
    camposNaoMapeados: [...camposNaoMapeados],
  };
}

async function importarEstoqueDoDia(data, usuarioEmail) {
  const dataISO = normalizarData(data);
  const dados = await buscarEstoque(dataISO);
  const lista = extrairLista(dados);
  if (!lista) {
    const err = new Error('A API de Estoque devolveu um formato inesperado (não é lista nem {content:[...]}).');
    err.codigo = 'FORMATO_INESPERADO';
    throw err;
  }
  const resumo = gravarSnapshotEstoque(dataISO, lista, usuarioEmail);
  db.prepare(
    'INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)'
  ).run('estoque_udtp', 'API UDTP', usuarioEmail || 'sistema', JSON.stringify(resumo));
  return resumo;
}

// Igual às reservas: anda para trás até achar a data mais recente publicada.
async function importarEstoqueMaisRecente(usuarioEmail, diasParaTras = 7) {
  const tentativas = [];
  const hoje = new Date();
  for (let i = 0; i <= diasParaTras; i++) {
    const d = new Date(hoje);
    d.setDate(d.getDate() - i);
    const dia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    try {
      const resumo = await importarEstoqueDoDia(dia, usuarioEmail);
      return { ...resumo, tentativas };
    } catch (e) {
      tentativas.push(`${dia}: ${e.codigo || 'ERRO'}`);
      if (e.codigo !== 'NAO_ENCONTRADO') throw e;
    }
  }
  const err = new Error(`Nenhuma data com estoque encontrada nos últimos ${diasParaTras + 1} dias.`);
  err.codigo = 'SEM_DATA_DISPONIVEL';
  throw err;
}

module.exports = {
  importarEstoqueDoDia,
  importarEstoqueMaisRecente,
  gravarSnapshotEstoque,
  mapearLinha,
};
