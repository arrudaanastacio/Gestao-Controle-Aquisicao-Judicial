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

  const filtros = ['r.data_referencia = ?'];
  const params = [data];
  if (busca) {
    filtros.push('(r.codigo_item LIKE ? OR r.descricao LIKE ? OR r.codigo_protocolo LIKE ? OR r.recebedor LIKE ?)');
    const like = `%${busca}%`;
    params.push(like, like, like, like);
  }
  const onde = filtros.join(' AND ');

  const linhas = db.prepare(`
    SELECT r.codigo_item AS codigoItem, r.codigo_protocolo AS codigoProtocolo,
           r.descricao, r.recebedor, r.saldo_reservado AS saldoReservado
      FROM reservas_itens r
     WHERE ${onde}
     ORDER BY r.descricao COLLATE NOCASE, r.recebedor COLLATE NOCASE
  `).all(...params);

  const resumo = db.prepare(`
    SELECT COUNT(*) AS total,
           COUNT(DISTINCT r.codigo_item) AS itensDistintos,
           COUNT(DISTINCT r.codigo_protocolo) AS protocolosDistintos,
           COALESCE(SUM(r.saldo_reservado), 0) AS quantidadeTotal
      FROM reservas_itens r
     WHERE ${onde}
  `).get(...params);

  const cab = db.prepare(
    'SELECT criado_em FROM reservas_importacoes WHERE data_referencia = ? ORDER BY id DESC LIMIT 1'
  ).get(data);

  res.json({
    dataReferencia: data,
    atualizadoEm: cab ? cab.criado_em : null,
    linhas,
    total: resumo.total,
    itensDistintos: resumo.itensDistintos,
    protocolosDistintos: resumo.protocolosDistintos,
    quantidadeTotal: resumo.quantidadeTotal,
    credenciaisConfiguradas: credenciaisConfiguradas(),
  });
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
