// =====================================================================
// routes.reservas.js — /api/reservas
// Tela de consulta das RESERVAS (quantidade do estoque já separada para
// pacientes), vindas da API UDTP. Cada consulta à API vira uma foto datada.
//
// Rotas nomeadas vêm ANTES de rotas com parâmetro (convenção do projeto).
// =====================================================================
const express = require('express');
const db = require('./db');
const { importarReservasDoDia, importarReservasMaisRecente } = require('./reservasUdtp');
const { importarEstoqueDoDia, importarEstoqueMaisRecente } = require('./estoqueUdtp');
const { credenciaisConfiguradas } = require('./udtpApi');

const router = express.Router();

// Data mais recente já importada (ou null se nunca importou).
function dataMaisRecente() {
  const r = db.prepare('SELECT MAX(data_referencia) AS d FROM reservas_itens').get();
  return r && r.d ? r.d : null;
}

// Qual foto de estoque por lote usar para uma data de reservas: a do mesmo
// dia, se existir; senão a mais recente que não seja posterior; senão a mais
// recente que houver. Evita ficar sem lote/validade se uma das duas
// importações tiver falhado num dia.
function dataEstoqueUsar(dataReservas) {
  const igual = db.prepare(
    'SELECT 1 FROM estoque_udtp_lotes WHERE data_referencia = ? LIMIT 1'
  ).get(dataReservas);
  if (igual) return dataReservas;

  const anterior = db.prepare(
    'SELECT MAX(data_referencia) AS d FROM estoque_udtp_lotes WHERE data_referencia <= ?'
  ).get(dataReservas);
  if (anterior && anterior.d) return anterior.d;

  const qualquer = db.prepare('SELECT MAX(data_referencia) AS d FROM estoque_udtp_lotes').get();
  return qualquer && qualquer.d ? qualquer.d : dataReservas;
}

// ---------- Datas disponíveis (para o seletor da tela) ----------
router.get('/datas', (req, res) => {
  const linhas = db.prepare(`
    SELECT i.data_referencia AS data,
           i.criado_em       AS atualizadoEm,
           i.total_itens     AS totalItens
      FROM reservas_importacoes i
     ORDER BY i.data_referencia DESC
     LIMIT 400
  `).all();
  res.json({ datas: linhas, credenciaisConfiguradas: credenciaisConfiguradas() });
});

// ---------- Consulta das reservas de uma data ----------
// ?data=AAAA-MM-DD (padrão: a mais recente) &busca=texto &unidade=...
router.get('/', (req, res) => {
  const data = req.query.data || dataMaisRecente();
  if (!data) {
    return res.json({
      dataReferencia: null, atualizadoEm: null, linhas: [],
      total: 0, itensDistintos: 0, quantidadeTotal: 0, lotesDistintos: 0,
      credenciaisConfiguradas: credenciaisConfiguradas(),
      aviso: 'Nenhuma reserva importada ainda. Use o botão "Atualizar agora".',
    });
  }

  const busca = (req.query.busca || '').trim();
  const soComprometidos = req.query.comprometidos === 'true';

  // Snapshot de estoque a usar: o do mesmo dia, se existir; senão o mais
  // recente disponível (as duas fontes são importadas juntas, mas uma pode
  // ter falhado num dia).
  const dataEstoque = dataEstoqueUsar(data);

  const like = `%${busca}%`;
  const params = [data, dataEstoque];
  let filtroBusca = '';
  if (busca) {
    filtroBusca = 'AND (res.codigoItem LIKE ? OR res.descricao LIKE ?)';
    params.push(like, like);
  }
  const filtroComp = soComprometidos ? 'AND (COALESCE(est.estoque, 0) - res.reservado) <= 0' : '';

  // Uma linha por ITEM: quantidade reservada somada, estoque total do dia e o
  // DISPONÍVEL (estoque - reservado). A validade mais próxima é a que atende a
  // reserva, já que a separação segue FEFO (confirmado pelo Rafael em 22/07).
  const linhas = db.prepare(`
    WITH res AS (
      SELECT codigo_item AS codigoItem, MAX(descricao) AS descricao,
             SUM(saldo_reservado) AS reservado,
             COUNT(*) AS qtdReservas,
             COUNT(DISTINCT codigo_protocolo) AS protocolos
        FROM reservas_itens
       WHERE data_referencia = ?
       GROUP BY codigo_item
    ),
    est AS (
      SELECT codigo_item,
             SUM(COALESCE(saldo, 0)) AS estoque,
             MIN(CASE WHEN lote IS NOT NULL AND saldo > 0 THEN validade END) AS validadeMaisProxima,
             MAX(unidade_medida) AS unidade,
             SUM(CASE WHEN lote IS NOT NULL THEN 1 ELSE 0 END) AS lotes
        FROM estoque_udtp_lotes
       WHERE data_referencia = ?
       GROUP BY codigo_item
    )
    SELECT res.codigoItem, res.descricao, res.reservado, res.qtdReservas, res.protocolos,
           COALESCE(est.estoque, 0) AS estoque,
           COALESCE(est.estoque, 0) - res.reservado AS disponivel,
           est.validadeMaisProxima, est.unidade, COALESCE(est.lotes, 0) AS lotes
      FROM res LEFT JOIN est ON est.codigo_item = res.codigoItem
     WHERE 1=1 ${filtroBusca} ${filtroComp}
     ORDER BY res.descricao COLLATE NOCASE
  `).all(...params);

  const cab = db.prepare(
    'SELECT criado_em FROM reservas_importacoes WHERE data_referencia = ? ORDER BY id DESC LIMIT 1'
  ).get(data);

  res.json({
    dataReferencia: data,
    dataEstoque,
    atualizadoEm: cab ? cab.criado_em : null,
    linhas,
    total: linhas.length,
    itensDistintos: linhas.length,
    protocolosDistintos: linhas.reduce((s, l) => s + l.protocolos, 0),
    quantidadeTotal: linhas.reduce((s, l) => s + (l.reservado || 0), 0),
    comprometidos: linhas.filter((l) => l.disponivel <= 0).length,
    credenciaisConfiguradas: credenciaisConfiguradas(),
  });
});

// ---------- Detalhe de um item (linha expansível da tela) ----------
// Devolve os LOTES em ordem FEFO (vence primeiro em cima) e as RESERVAS
// (pacientes) daquele item. Como a separação segue FEFO, dá para indicar
// qual lote atende cada reserva: consumimos os lotes na ordem de validade.
router.get('/detalhe', (req, res) => {
  const codigoItem = (req.query.codigoItem || '').trim();
  if (!codigoItem) return res.status(400).json({ erro: 'Informe o codigoItem.' });
  const data = req.query.data || dataMaisRecente();
  if (!data) return res.status(404).json({ erro: 'Nenhuma reserva importada ainda.' });
  const dataEstoque = dataEstoqueUsar(data);

  const lotes = db.prepare(`
    SELECT lote, validade, saldo, unidade_medida AS unidade
      FROM estoque_udtp_lotes
     WHERE codigo_item = ? AND data_referencia = ? AND lote IS NOT NULL
     ORDER BY validade IS NULL, validade, lote
  `).all(codigoItem, dataEstoque);

  const reservas = db.prepare(`
    SELECT codigo_protocolo AS codigoProtocolo, recebedor,
           saldo_reservado AS saldoReservado
      FROM reservas_itens
     WHERE codigo_item = ? AND data_referencia = ?
     ORDER BY saldo_reservado DESC, recebedor COLLATE NOCASE
  `).all(codigoItem, data);

  // Atribuição FEFO: distribui as reservas nos lotes que vencem primeiro.
  // É uma indicação (a API não diz o lote da reserva), mas reflete a regra
  // real de separação confirmada com a operação.
  const restante = lotes.map((l) => ({ lote: l.lote, validade: l.validade, resta: Number(l.saldo) || 0 }));
  for (const r of reservas) {
    let falta = Number(r.saldoReservado) || 0;
    const usados = [];
    for (const l of restante) {
      if (falta <= 0) break;
      if (l.resta <= 0) continue;
      const usa = Math.min(l.resta, falta);
      l.resta -= usa;
      falta -= usa;
      usados.push({ lote: l.lote, validade: l.validade, quantidade: usa });
    }
    r.lotesFefo = usados;
    r.naoCoberto = falta > 0 ? falta : 0;
  }

  res.json({ codigoItem, dataReferencia: data, dataEstoque, lotes, reservas });
});

// ---------- Exportar CSV ----------
router.get('/csv', (req, res) => {
  const data = req.query.data || dataMaisRecente();
  if (!data) return res.status(404).json({ erro: 'Nenhuma reserva importada ainda.' });

  const linhas = db.prepare(`
    SELECT codigo_item, codigo_protocolo, descricao, recebedor, saldo_reservado
      FROM reservas_itens
     WHERE data_referencia = ?
     ORDER BY descricao COLLATE NOCASE, recebedor COLLATE NOCASE
  `).all(data);

  const esc = (v) => {
    const t = v === null || v === undefined ? '' : String(v);
    return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const cabecalho = 'Codigo do Item;Protocolo;Medicamento;Recebedor;Saldo Reservado';
  const corpo = linhas.map((l) => [
    l.codigo_item, l.codigo_protocolo, l.descricao, l.recebedor, l.saldo_reservado,
  ].map(esc).join(';')).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="reservas_${data}.csv"`);
  res.send('﻿' + cabecalho + '\n' + corpo); // BOM: Excel abre com acento certo
});

// ---------- Atualizar agora (botão da tela) ----------
// Caminho contém "importar" de propósito: o auth deduz a ação "importar",
// que pode ser liberada por usuário na tela de Administração > Permissões.
router.post('/importar-agora', async (req, res) => {
  const data = (req.body && req.body.data) || null;
  const email = req.usuario ? req.usuario.email : 'sistema';
  try {
    // Sem data explícita, busca a mais recente disponível: a API só publica o
    // dia depois que ele fecha, então "hoje" costuma devolver 404.
    const resumo = data
      ? await importarReservasDoDia(data, email)
      : await importarReservasMaisRecente(email);

    // Atualiza também o estoque por lote (lote/validade/unidade). É a outra
    // metade do dado; se falhar, a tela de reservas ainda fica correta.
    let estoque = null;
    try {
      estoque = data
        ? await importarEstoqueDoDia(data, email)
        : await importarEstoqueMaisRecente(email);
    } catch (e) {
      estoque = { erro: e.message, codigo: e.codigo || 'ERRO' };
    }

    res.json({ ok: true, ...resumo, estoque });
  } catch (e) {
    const porCodigo = {
      SEM_CREDENCIAL: 400, NAO_AUTORIZADO: 401, SEM_PERMISSAO: 403,
      NAO_ENCONTRADO: 404, TIMEOUT: 504, FALHA_CONEXAO: 502,
      FORMATO_INESPERADO: 502, DATA_INVALIDA: 400, SEM_DATA_DISPONIVEL: 404,
    };
    res.status(porCodigo[e.codigo] || 500).json({ erro: e.message, codigo: e.codigo || 'ERRO' });
  }
});

module.exports = router;
