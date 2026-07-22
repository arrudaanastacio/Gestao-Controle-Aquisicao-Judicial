// =====================================================================
// rupturasUdtp.js
// Importa as RUPTURAS da API UDTP (/api/rupturas?periodoInicio=&periodoFim=).
//
// Ruptura = o paciente veio buscar e o item não pôde ser atendido. É o fato
// consumado — diferente do alerta `estoque_ruptura`, que o sistema calcula a
// partir de estoque ≤ 0 com demanda > 0.
//
// Estratégia de importação: janela móvel dos últimos N dias (padrão 30).
// A cada importação, as linhas DAQUELA janela são refeitas (API = fonte da
// verdade), mas o que estiver FORA dela é preservado — assim o histórico vai
// se acumulando com o tempo, sem depender de a API manter dados antigos.
// =====================================================================
const db = require('./db');
const { buscarRupturas, normalizarData } = require('./udtpApi');
const { paraNumero, paraDataISO, extrairLista } = require('./reservasUdtp');

const DIAS_JANELA_PADRAO = 30;

// O protocolo do paciente vem "puro" na API e com prefixo "N: " no cadastro
// de autores. Normalizar só o prefixo e os espaços já casa 100% (testado com
// 750 pacientes) — não é preciso mexer em zeros à esquerda.
function normalizarProtocolo(v) {
  return String(v == null ? '' : v).replace(/^N:\s*/i, '').replace(/\s/g, '');
}

function mapearLinha(reg) {
  const r = reg || {};
  return {
    data: paraDataISO(r.data),
    codigo_item: r.codigoItem == null ? null : String(r.codigoItem).trim(),
    descricao: r.descricao == null ? null : String(r.descricao).trim(),
    unidade_medida: r.unidadeMedida == null ? null : String(r.unidadeMedida).trim(),
    quantidade: paraNumero(r.ruptura),
    protocolo: r.numeroDocumentoSaida == null ? null : String(r.numeroDocumentoSaida).trim(),
    protocolo_norm: normalizarProtocolo(r.numeroDocumentoSaida),
    demanda_id: r.demandaId == null ? null : String(r.demandaId).trim(),
    com_marca: r.comMarca === true ? 1 : (r.comMarca === false ? 0 : null),
  };
}

function gravarSnapshot(inicio, fim, registros, usuarioEmail) {
  const linhas = registros.map(mapearLinha);

  let importacaoId;
  db.exec('BEGIN');
  try {
    // Refaz só a janela importada; o histórico anterior fica intacto.
    db.prepare('DELETE FROM rupturas_itens WHERE data >= ? AND data <= ?').run(inicio, fim);

    const info = db.prepare(
      'INSERT INTO rupturas_importacoes (periodo_inicio, periodo_fim, origem, usuario_email, total_itens) VALUES (?, ?, ?, ?, ?)'
    ).run(inicio, fim, 'API UDTP', usuarioEmail || 'sistema', linhas.length);
    importacaoId = info.lastInsertRowid;

    const ins = db.prepare(`
      INSERT INTO rupturas_itens
        (importacao_id, data, codigo_item, descricao, unidade_medida, quantidade,
         protocolo, protocolo_norm, demanda_id, com_marca)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const l of linhas) {
      ins.run(importacaoId, l.data, l.codigo_item, l.descricao, l.unidade_medida,
        l.quantidade, l.protocolo, l.protocolo_norm, l.demanda_id, l.com_marca);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return {
    periodoInicio: inicio,
    periodoFim: fim,
    importacaoId,
    totalRegistros: linhas.length,
    semCodigoItem: linhas.filter((l) => !l.codigo_item).length,
    semProtocolo: linhas.filter((l) => !l.protocolo_norm).length,
    pacientes: new Set(linhas.map((l) => l.protocolo_norm).filter(Boolean)).size,
    itens: new Set(linhas.map((l) => l.codigo_item).filter(Boolean)).size,
  };
}

// Importa um período explícito.
async function importarRupturasPeriodo(inicio, fim, usuarioEmail) {
  const i = normalizarData(inicio);
  const f = normalizarData(fim);
  const dados = await buscarRupturas(i, f);
  const lista = extrairLista(dados);
  if (!lista) {
    const err = new Error('A API de Rupturas devolveu um formato inesperado (não é lista nem {content:[...]}).');
    err.codigo = 'FORMATO_INESPERADO';
    throw err;
  }
  const resumo = gravarSnapshot(i, f, lista, usuarioEmail);
  db.prepare(
    'INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)'
  ).run('rupturas', 'API UDTP', usuarioEmail || 'sistema', JSON.stringify(resumo));
  return resumo;
}

// Janela móvel: dos últimos `dias` até ontem (hoje ainda não tem movimento
// fechado — a API devolve vazio para o próprio dia).
function janelaPadrao(dias = DIAS_JANELA_PADRAO) {
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fim = new Date();
  const inicio = new Date();
  inicio.setDate(inicio.getDate() - dias);
  return { inicio: fmt(inicio), fim: fmt(fim) };
}

async function importarUltimos30Dias(usuarioEmail, dias = DIAS_JANELA_PADRAO) {
  const { inicio, fim } = janelaPadrao(dias);
  return importarRupturasPeriodo(inicio, fim, usuarioEmail);
}

module.exports = {
  importarRupturasPeriodo,
  importarUltimos30Dias,
  janelaPadrao,
  normalizarProtocolo,
  mapearLinha,
  DIAS_JANELA_PADRAO,
};
