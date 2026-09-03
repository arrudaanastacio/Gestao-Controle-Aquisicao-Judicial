// =====================================================================
// routes.conciliacao.js — Robô "Associar Entrada" (baixa de ENTREGA)
// 3 fluxos: Pendente de aprovação (propostas do robô) · A associar (manual)
// · Auditoria (aplicado, com Desfazer). Escreve na tabela solicitacoes os
// mesmos campos do layout atual (qtde_entregue/qtde_pendente/data_entrega/
// status), reaproveitando o motor de conciliacao.js.
// =====================================================================
const express = require('express');
const { exigirPerfil } = require('./auth');
const db = require('./db');
const conc = require('./conciliacao');

const router = express.Router();

function num(v){ if(v==null||v==='')return null; const n=Number(String(v).replace(',','.')); return Number.isFinite(n)?n:null; }
function dataEntradaISO(dt){ // '2026-08-31 13:16:00' -> '2026-08-31'
  if(!dt) return null; const s=String(dt); return s.slice(0,10);
}

// A tabela `solicitacoes` é reimportada ("refaz o mês" = DELETE+INSERT), o que
// TROCA o id de cada linha. Uma proposta gerada antes da reimportação passa a
// apontar para um id inexistente → "Solicitação não encontrada" ao aprovar.
// Este helper reencontra a solicitação pela CHAVE NATURAL (codigo_item + ano +
// mes + tipo) guardada no detalhe da proposta, quando o id não existir mais.
function reencontrarSolicitacao(codigoItem, detalhe, opts = {}) {
  if (!codigoItem || !detalhe || detalhe.sol_ano == null || !detalhe.sol_mes) return null;
  const cond = opts.semEmpenho ? "AND (n_empenho IS NULL OR n_empenho='')" : '';
  return db.prepare(
    `SELECT * FROM solicitacoes
      WHERE codigo_item=? AND ano=? AND mes=? AND (tipo IS ? OR tipo=?) ${cond}
      ORDER BY id DESC LIMIT 1`
  ).get(codigoItem, detalhe.sol_ano, detalhe.sol_mes, detalhe.sol_tipo || null, detalhe.sol_tipo || '');
}

// ---------- Aplicar / desfazer a BAIXA DE ENTREGA numa solicitação ----------
// Núcleo compartilhado por "aprovar proposta" e "associar manual".
function aplicarEntrega({ solicitacaoId, quantidade, chaveOrigem, detalhe, como, usuarioEmail, codigoItem }) {
  let s = db.prepare('SELECT * FROM solicitacoes WHERE id = ?').get(solicitacaoId);
  if (!s) s = reencontrarSolicitacao(codigoItem, detalhe);
  if (!s) throw new Error('Solicitação não encontrada.');
  const pend = conc.pendenteSolicitacao(s);
  const q = Math.min(num(quantidade) || 0, pend);
  if (q <= 0) throw new Error('Quantidade a baixar inválida ou compra sem pendência.');

  const entregueAnt = num(s.qtde_entregue) || 0;
  const novoEntregue = entregueAnt + q;
  const solicitada = num(s.qtde_solicitada) || 0;
  const novoPendente = Math.max(0, solicitada - novoEntregue);
  const novoStatus = novoPendente <= 0 ? 'Finalizado' : 'Entrega Parcial';
  const dataEntrega = detalhe && detalhe.data_entrada ? dataEntradaISO(detalhe.data_entrada) : null;

  const info = db.prepare(`
    INSERT INTO associacoes
      (origem, codigo_item, solicitacao_id, sol_ano, sol_mes, sol_tipo, quantidade,
       chave_origem, detalhe_json, status_anterior, status_novo,
       qtde_entregue_anterior, qtde_pendente_anterior, data_entrega_anterior, como, usuario_email)
    VALUES ('entrega', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.codigo_item, s.id, s.ano, s.mes, s.tipo, q,
    chaveOrigem || null, detalhe ? JSON.stringify(detalhe) : null,
    s.status, novoStatus, entregueAnt, num(s.qtde_pendente), s.data_entrega, como, usuarioEmail || null
  );

  db.prepare(`UPDATE solicitacoes SET qtde_entregue=?, qtde_pendente=?, status=?, data_entrega=COALESCE(?, data_entrega) WHERE id=?`)
    .run(novoEntregue, novoPendente, novoStatus, dataEntrega, s.id);

  db.prepare('INSERT INTO auditoria (usuario_email, acao, tabela, registro_id) VALUES (?,?,?,?)')
    .run(usuarioEmail || 'robo', 'associar_entrega', 'solicitacoes', String(s.id));

  return { associacaoId: info.lastInsertRowid, status: novoStatus, quantidade: q, pendente: novoPendente };
}

// ---------- Aplicar a BAIXA DE EMPENHO numa solicitação ----------
function aplicarEmpenho({ solicitacaoId, chaveOrigem, detalhe, como, usuarioEmail, codigoItem }) {
  let s = db.prepare('SELECT * FROM solicitacoes WHERE id = ?').get(solicitacaoId);
  if (!s) s = reencontrarSolicitacao(codigoItem, detalhe, { semEmpenho: true });
  if (!s) throw new Error('Solicitação não encontrada.');
  const nEmp = detalhe && detalhe.nota_empenho ? String(detalhe.nota_empenho) : null;
  if (!nEmp) throw new Error('Empenho sem número.');
  const qtdeEmp = detalhe && detalhe.quantidade != null ? num(detalhe.quantidade) : null;
  // Planejamento/Adjudicado passam a Empenhado; os demais mantêm o status.
  const novoStatus = (s.status === 'Planejamento' || s.status === 'Adjudicado') ? 'Empenhado' : s.status;

  const info = db.prepare(`
    INSERT INTO associacoes
      (origem, codigo_item, solicitacao_id, sol_ano, sol_mes, sol_tipo, quantidade,
       chave_origem, detalhe_json, status_anterior, status_novo,
       n_empenho_anterior, quantidade_empenho_anterior, como, usuario_email)
    VALUES ('empenho', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.codigo_item, s.id, s.ano, s.mes, s.tipo, qtdeEmp,
    chaveOrigem || null, detalhe ? JSON.stringify(detalhe) : null,
    s.status, novoStatus, s.n_empenho, num(s.quantidade_empenho), como, usuarioEmail || null
  );

  db.prepare('UPDATE solicitacoes SET n_empenho=?, quantidade_empenho=?, status=? WHERE id=?')
    .run(nEmp, qtdeEmp, novoStatus, s.id);
  db.prepare('INSERT INTO auditoria (usuario_email, acao, tabela, registro_id) VALUES (?,?,?,?)')
    .run(usuarioEmail || 'robo', 'associar_empenho', 'solicitacoes', String(s.id));

  return { associacaoId: info.lastInsertRowid, n_empenho: nEmp, quantidade_empenho: qtdeEmp, status: novoStatus };
}

function desfazerAssociacao(id, usuarioEmail) {
  const a = db.prepare('SELECT * FROM associacoes WHERE id=? AND desfeita=0').get(id);
  if (!a) throw new Error('Associação não encontrada ou já desfeita.');
  if (a.origem === 'entrega') {
    db.prepare('UPDATE solicitacoes SET qtde_entregue=?, qtde_pendente=?, status=?, data_entrega=? WHERE id=?')
      .run(a.qtde_entregue_anterior, a.qtde_pendente_anterior, a.status_anterior, a.data_entrega_anterior, a.solicitacao_id);
  } else if (a.origem === 'empenho') {
    db.prepare('UPDATE solicitacoes SET n_empenho=?, quantidade_empenho=?, status=? WHERE id=?')
      .run(a.n_empenho_anterior, a.quantidade_empenho_anterior, a.status_anterior, a.solicitacao_id);
  }
  db.prepare("UPDATE associacoes SET desfeita=1, desfeita_em=datetime('now','localtime'), desfeita_por=? WHERE id=?")
    .run(usuarioEmail || null, id);
  db.prepare('INSERT INTO auditoria (usuario_email, acao, tabela, registro_id) VALUES (?,?,?,?)')
    .run(usuarioEmail || null, 'desfazer_associacao', 'associacoes', String(id));
}

// ---------- Gerar propostas (robô) ----------
// Regenera a fila 'pendente' de ENTREGA, preservando o que já foi rejeitado
// (não reaparece) e o que já foi aprovado/associado (o motor já ignora).
router.post('/entrada/gerar', exigirPerfil('admin'), (req, res) => {
  res.json({ ok: true, ...conc.regenerarEntrada() });
});

// ---------- Listas ----------
router.get('/entrada/propostas', (req, res) => {
  const ignoradas = conc.chavesIgnoradas();
  const linhas = db.prepare(
    "SELECT * FROM propostas_conciliacao WHERE origem='entrega' AND situacao='pendente' ORDER BY (confianca='alta') DESC, id"
  ).all().filter((p) => !ignoradas.has(p.chave_origem));
  res.json({ propostas: linhas.map((p) => ({
    id: p.id, chave_origem: p.chave_origem, codigo_item: p.codigo_item, solicitacao_id: p.solicitacao_id,
    quantidade: p.quantidade, confianca: p.confianca,
    sinais: JSON.parse(p.sinais_json || '{}'), resultado_previsto: p.resultado_previsto,
    detalhe: JSON.parse(p.detalhe_json || '{}'),
  })) });
});

router.get('/auditoria', (req, res) => {
  const origem = req.query.origem === 'empenho' ? 'empenho' : 'entrega';
  const linhas = db.prepare(
    "SELECT * FROM associacoes WHERE origem=? ORDER BY desfeita ASC, id DESC LIMIT 500"
  ).all(origem);
  res.json({ auditoria: linhas.map((a) => ({
    id: a.id, codigo_item: a.codigo_item, ano: a.sol_ano, mes: a.sol_mes, tipo: a.sol_tipo,
    quantidade: a.quantidade, status: a.status_novo, como: a.como,
    detalhe: JSON.parse(a.detalhe_json || '{}'),
    usuario: a.usuario_email, criado_em: a.criado_em, desfeita: !!a.desfeita, desfeita_em: a.desfeita_em,
  })) });
});

// Compras em aberto de um SCODES (para o modal manual).
router.get('/entrada/compras-abertas', (req, res) => {
  const codigo = String(req.query.codigo || '').trim();
  if (!codigo) return res.status(400).json({ erro: 'Informe o SCODES.' });
  const ph = conc.STATUS_ABERTO.map(() => '?').join(',');
  const linhas = db.prepare(
    `SELECT id, ano, mes, tipo, status, n_empenho, qtde_solicitada, qtde_entregue, qtde_pendente
     FROM solicitacoes WHERE codigo_item=? AND status IN (${ph}) ORDER BY ano DESC, id DESC`
  ).all(codigo, ...conc.STATUS_ABERTO);
  res.json({ compras: linhas.map((s) => ({
    id: s.id, ano: s.ano, mes: s.mes, tipo: s.tipo, status: s.status, n_empenho: s.n_empenho,
    solicitada: num(s.qtde_solicitada), pendente: conc.pendenteSolicitacao(s),
  })) });
});

// Fila "A associar": entradas TP com compra em aberto do mesmo SCODES, ainda
// não associadas e sem proposta pendente (inclui as rejeitadas pelo robô).
// ?incluirIgnoradas=true -> modo revisao: devolve SO as marcadas como Ignorar.
router.get('/entrada/a-associar', (req, res) => {
  const incluirIgnoradas = req.query.incluirIgnoradas === 'true';
  const abertas = conc.solicitacoesAbertasPorItem();
  const jaAssoc = new Set(db.prepare("SELECT chave_origem FROM associacoes WHERE origem='entrega' AND desfeita=0").all().map(r => r.chave_origem));
  const emProposta = new Set(db.prepare("SELECT chave_origem FROM propostas_conciliacao WHERE origem='entrega' AND situacao='pendente'").all().map(r => r.chave_origem));
  const ignoradas = conc.chavesIgnoradas();
  const entradas = db.prepare("SELECT * FROM entrada_lotes_itens WHERE unidade LIKE '%Tenente Pena%'").all();
  const fila = [];
  for (const e of entradas) {
    if (!abertas.get(e.codigo_item)) continue;
    const chave = conc.chaveEntrada(e);
    if (jaAssoc.has(chave) || emProposta.has(chave)) continue;
    const ign = ignoradas.has(chave);
    if (incluirIgnoradas ? !ign : ign) continue; // normal esconde ignoradas; revisao mostra so elas
    fila.push({
      chave_origem: chave, codigo_item: e.codigo_item, item: e.item,
      data_entrada: e.data_entrada, qtde: num(e.qtde), nota_fiscal: e.nota_fiscal,
      nota_empenho: e.nota_empenho, lote: e.lote, ignorada: ign,
    });
  }
  res.json({ fila });
});

// Marca/desmarca uma entrada como "Ignorar" (nao deve ser associada). Some das
// abas Pendente e "A associar" e nao volta. Chave = chaveEntrada (estavel).
router.post('/entrada/ignorar', (req, res) => {
  const b = req.body || {};
  const chave = String(b.chave_origem || '').trim();
  const codigo = String(b.codigo_item || '').trim();
  const ignorar = b.ignorar !== false; // padrao: marcar como ignorada
  if (!chave) return res.status(400).json({ erro: 'Informe a entrada (chave_origem).' });
  const email = (req.usuario && req.usuario.email) || null;
  try {
    if (ignorar) {
      db.prepare(`INSERT INTO entradas_ignoradas (chave_origem, codigo_item, ignorado_por, ignorado_em)
        VALUES (?, ?, ?, datetime('now','localtime'))
        ON CONFLICT(chave_origem) DO UPDATE SET codigo_item=excluded.codigo_item, ignorado_por=excluded.ignorado_por, ignorado_em=excluded.ignorado_em`)
        .run(chave, codigo || null, email);
    } else {
      db.prepare('DELETE FROM entradas_ignoradas WHERE chave_origem=?').run(chave);
    }
    db.prepare('INSERT INTO auditoria (usuario_email, acao, tabela, registro_id) VALUES (?,?,?,?)')
      .run(email, ignorar ? 'ignorar_entrada' : 'reativar_entrada', 'entradas_ignoradas', chave.slice(0, 120));
  } catch (e) { return res.status(400).json({ erro: 'Nao consegui salvar: ' + e.message }); }
  res.json({ ok: true, ignorada: ignorar });
});

// ---------- Ações ----------
router.post('/entrada/aprovar/:id', (req, res) => {
  const p = db.prepare("SELECT * FROM propostas_conciliacao WHERE id=? AND origem='entrega' AND situacao='pendente'").get(req.params.id);
  if (!p) return res.status(404).json({ erro: 'Proposta não encontrada.' });
  try {
    const r = aplicarEntrega({
      solicitacaoId: p.solicitacao_id, quantidade: p.quantidade,
      chaveOrigem: p.chave_origem, detalhe: JSON.parse(p.detalhe_json || '{}'),
      como: 'robo', usuarioEmail: req.usuario.email, codigoItem: p.codigo_item,
    });
    db.prepare("UPDATE propostas_conciliacao SET situacao='aprovada' WHERE id=?").run(p.id);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

router.post('/entrada/rejeitar/:id', (req, res) => {
  const p = db.prepare("SELECT id FROM propostas_conciliacao WHERE id=? AND origem='entrega' AND situacao='pendente'").get(req.params.id);
  if (!p) return res.status(404).json({ erro: 'Proposta não encontrada.' });
  db.prepare("UPDATE propostas_conciliacao SET situacao='rejeitada' WHERE id=?").run(p.id);
  res.json({ ok: true });
});

router.post('/entrada/associar-manual', (req, res) => {
  const b = req.body || {};
  if (!b.solicitacao_id || !b.chave_origem) return res.status(400).json({ erro: 'Informe a compra e a entrada.' });
  try {
    const r = aplicarEntrega({
      solicitacaoId: b.solicitacao_id, quantidade: b.quantidade, chaveOrigem: b.chave_origem,
      detalhe: b.detalhe || {}, como: 'manual', usuarioEmail: req.usuario.email,
    });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

router.post('/desfazer/:id', (req, res) => {
  try { desfazerAssociacao(req.params.id, req.usuario.email); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ erro: e.message }); }
});

// ======================= ROBÔ DE EMPENHOS =======================
router.post('/empenho/gerar', exigirPerfil('admin'), (req, res) => {
  res.json({ ok: true, ...conc.regenerarEmpenho() });
});

router.get('/empenho/propostas', (req, res) => {
  const linhas = db.prepare("SELECT * FROM propostas_conciliacao WHERE origem='empenho' AND situacao='pendente' ORDER BY (confianca='alta') DESC, id").all();
  res.json({ propostas: linhas.map((p) => ({
    id: p.id, codigo_item: p.codigo_item, solicitacao_id: p.solicitacao_id, quantidade: p.quantidade,
    confianca: p.confianca, sinais: JSON.parse(p.sinais_json || '{}'), resultado_previsto: p.resultado_previsto,
    detalhe: JSON.parse(p.detalhe_json || '{}'),
  })) });
});

router.post('/empenho/aprovar/:id', (req, res) => {
  const p = db.prepare("SELECT * FROM propostas_conciliacao WHERE id=? AND origem='empenho' AND situacao='pendente'").get(req.params.id);
  if (!p) return res.status(404).json({ erro: 'Proposta não encontrada.' });
  try {
    const r = aplicarEmpenho({ solicitacaoId: p.solicitacao_id, chaveOrigem: p.chave_origem, detalhe: JSON.parse(p.detalhe_json || '{}'), como: 'robo', usuarioEmail: req.usuario.email, codigoItem: p.codigo_item });
    db.prepare("UPDATE propostas_conciliacao SET situacao='aprovada' WHERE id=?").run(p.id);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

router.post('/empenho/rejeitar/:id', (req, res) => {
  const p = db.prepare("SELECT id FROM propostas_conciliacao WHERE id=? AND origem='empenho' AND situacao='pendente'").get(req.params.id);
  if (!p) return res.status(404).json({ erro: 'Proposta não encontrada.' });
  db.prepare("UPDATE propostas_conciliacao SET situacao='rejeitada' WHERE id=?").run(p.id);
  res.json({ ok: true });
});

// Fila manual: compras em aberto SEM empenho, sem proposta pendente.
router.get('/empenho/a-associar', (req, res) => {
  const emProposta = new Set(db.prepare("SELECT solicitacao_id FROM propostas_conciliacao WHERE origem='empenho' AND situacao='pendente'").all().map(r => r.solicitacao_id));
  const ph = conc.STATUS_ABERTO.map(() => '?').join(',');
  const linhas = db.prepare(
    `SELECT id, codigo_item, ano, mes, tipo, status, n_oficio, requisicao_gsnet, qtde_solicitada
     FROM solicitacoes WHERE status IN (${ph}) AND (n_empenho IS NULL OR n_empenho='') ORDER BY ano DESC, id DESC`
  ).all(...conc.STATUS_ABERTO);
  const fila = linhas.filter(s => !emProposta.has(s.id)).map(s => ({
    solicitacao_id: s.id, codigo_item: s.codigo_item, ano: s.ano, mes: s.mes, tipo: s.tipo,
    status: s.status, requisicao_gsnet: s.requisicao_gsnet, solicitada: num(s.qtde_solicitada),
  }));
  res.json({ fila });
});

// Empenhos candidatos para uma compra (por SCODES ou Siafísico).
router.get('/empenho/candidatos', (req, res) => {
  const codigo = String(req.query.codigo || '').trim();
  if (!codigo) return res.status(400).json({ erro: 'Informe o SCODES.' });
  const it = db.prepare("SELECT codigo_siafisico FROM itens WHERE codigo_item=?").get(codigo);
  const siaf = it && it.codigo_siafisico ? String(it.codigo_siafisico).trim() : null;
  const jaAssoc = new Set(db.prepare("SELECT chave_origem FROM associacoes WHERE origem='empenho' AND desfeita=0").all().map(r => r.chave_origem));
  const emps = db.prepare(
    "SELECT * FROM empenhos WHERE scodes=? OR (siafisico IS NOT NULL AND siafisico=?) ORDER BY data_referencia DESC, id DESC LIMIT 100"
  ).all(codigo, siaf);
  const lista = emps.map((e) => ({
    chave_origem: conc.chaveEmpenho(e), nota_empenho: e.nota_empenho, quantidade: num(e.quantidade),
    empresa: e.empresa, numero_requisicao: e.numero_requisicao, processo: e.processo_sem_papel,
    medicamento: e.medicamento, data_referencia: e.data_referencia,
    ja_associado: jaAssoc.has(conc.chaveEmpenho(e)),
  }));
  res.json({ empenhos: lista });
});

router.post('/empenho/associar-manual', (req, res) => {
  const b = req.body || {};
  if (!b.solicitacao_id || !b.detalhe || !b.detalhe.nota_empenho) return res.status(400).json({ erro: 'Informe a compra e o empenho.' });
  try {
    const r = aplicarEmpenho({ solicitacaoId: b.solicitacao_id, chaveOrigem: b.chave_origem, detalhe: b.detalhe, como: 'manual', usuarioEmail: req.usuario.email });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

module.exports = router;
