// routes.cartasTroca.js — Módulo "Cartas de Troca".
//
// Duas partes:
//  1) Importação do "Relatório Estratégico de Empenhos" (GsnetCompras) → tabela
//     `empenhos` (SUBSTITUI toda a foto a cada importação). Fonte de busca para
//     o cadastro e conteúdo da aba "Empenhos importados". Ver memória
//     relatorio-empenhos-gsnet.
//  2) Cadastro/consulta das cartas de troca (`cartas_troca` + `cartas_troca_lotes`),
//     com FLUXO DE APROVAÇÃO em duas etapas:
//        administrativo (perm. inserir) registra  → "Aguardando avaliação" (e-mail p/ técnicos)
//        técnico (perm. editar) avalia            → Aprovada | Reprovada (e-mail p/ o criador)
//        se Reprovada, administrativo corrige e reenvia (volta a Aguardando).
//     Dois campos independentes: `situacao_analise` (fluxo) e `status_troca`
//     (ciclo físico da troca: Vigente/Trocado/Vencido/Consumido/Cancelado).
//
// Convenção do projeto: rotas nomeadas vêm ANTES das rotas com parâmetro (/:id).
// Mapeamento de ação por método (auth.acaoDaRequisicao): POST=inserir,
// PUT=editar, DELETE=excluir, GET=visualizar/exportar. Por isso:
//   - registrar  = POST /              (inserir  → administrativo)
//   - reenviar   = POST /:id/reenviar  (inserir  → administrativo)
//   - avaliar    = PUT  /:id/avaliar   (editar   → técnico)
//   - status     = POST /:id/status    (inserir  → administrativo acompanha a troca)

const express = require('express');
const XLSX = require('xlsx');
const multer = require('multer');
const db = require('./db');
const { autenticar, exigirPerfil } = require('./auth');
const emailCarta = require('./emailCartaTroca');

const router = express.Router();
router.use(autenticar);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

// ---------- Helpers ----------
function normalizar(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[._]/g, ' ')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
function texto(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}
function numero(v) {
  if (v === undefined || v === null || v === '') return null;
  let s = String(v).trim();
  if (s === '') return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const MAPA_EMPENHO = {
  numero_requisicao: ['numero requisicao'], nome_requisicao: ['nome requisicao'],
  codigo_unico: ['codigo unico'], processo_sem_papel: ['processo sem papel'],
  nota_empenho: ['nota empenho'], empresa: ['empresa'], scodes: ['scodes'],
  siafisico: ['siafisico'], medicamento: ['medicamento'], apresentacao: ['apresentacao'],
  quantidade: ['quantidade'], valor_unitario: ['valor unitario'], valor_total: ['valor total'],
  data_limite_entrega: ['data limite entrega'], data_entrega_ne: ['data entrega ne'],
  quantidade_entrega: ['quantidade entrega'], quantidade_total: ['quantidade total'],
  data_entrega_item: ['data entrega item'], status_entrega: ['status entrega'],
  local_entrega: ['local entrega'], atraso: ['atraso'], dias_atraso: ['dias atraso'],
  data_publicacao: ['data publicacao'], data_retorno: ['data retorno'],
  data_envio: ['data envio'], data_retirada: ['data retirada'],
};
const CAMPOS_EMPENHO = Object.keys(MAPA_EMPENHO);
const NUMERICOS = new Set(['quantidade', 'valor_unitario', 'valor_total', 'quantidade_entrega', 'quantidade_total', 'dias_atraso']);

// ---------- Importar o Relatório Estratégico de Empenhos ----------
router.post('/importar-empenhos/confirmar', exigirPerfil('admin'), upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie o arquivo .xlsx do Relatório Estratégico de Empenhos.' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', raw: false });
    const nomeAba = wb.SheetNames.find((n) => normalizar(n) === 'dados') || wb.SheetNames[0];
    const brutas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, defval: null, raw: false });

    let hc = -1;
    for (let i = 0; i < Math.min(brutas.length, 15); i++) {
      const ln = (brutas[i] || []).map(normalizar);
      if (ln.includes('nota empenho') && ln.includes('scodes')) { hc = i; break; }
    }
    if (hc === -1) throw new Error('Não reconheci o layout do relatório (não achei "NOTA_EMPENHO" e "SCODES"). Confirme que exportou o Tipo Planilha "Completo".');

    const cab = (brutas[hc] || []).map(normalizar);
    const COL = {};
    for (const [campo, nomes] of Object.entries(MAPA_EMPENHO)) COL[campo] = cab.findIndex((c) => nomes.includes(c));

    const linhas = [];
    for (let i = hc + 1; i < brutas.length; i++) {
      const r = brutas[i];
      if (!r) continue;
      const nota = COL.nota_empenho >= 0 ? texto(r[COL.nota_empenho]) : null;
      const scodes = COL.scodes >= 0 ? texto(r[COL.scodes]) : null;
      if (!nota && !scodes) continue;
      const linha = {};
      for (const campo of CAMPOS_EMPENHO) {
        const bruto = COL[campo] >= 0 ? texto(r[COL[campo]]) : null;
        linha[campo] = NUMERICOS.has(campo) ? numero(bruto) : bruto;
      }
      linhas.push(linha);
    }
    if (linhas.length === 0) throw new Error('O arquivo não tinha nenhuma linha de empenho válida.');

    const dataReferencia = new Date().toISOString().slice(0, 10);
    let resumo;
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM empenhos').run();
      const cols = ['data_referencia', ...CAMPOS_EMPENHO];
      const stmt = db.prepare(`INSERT INTO empenhos (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const l of linhas) stmt.run(dataReferencia, ...CAMPOS_EMPENHO.map((c) => (l[c] === undefined ? null : l[c])));
      const empenhos = db.prepare('SELECT COUNT(DISTINCT nota_empenho) c FROM empenhos').get().c;
      resumo = { dataReferencia, totalLinhas: linhas.length, totalEmpenhos: empenhos };
      db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
        .run('empenhos', req.file.originalname || 'empenhos', req.usuario.email, JSON.stringify(resumo));
      db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
        .run(req.usuario.id, req.usuario.email, 'importar_empenhos', 'empenhos', JSON.stringify(resumo));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.json(resumo);
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

// ---------- Buscar linhas de empenho (para o cadastro) ----------
router.get('/empenhos/buscar', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ empenhos: [] });
  const like = `%${q}%`;
  const campos = ['nota_empenho', 'numero_requisicao', 'processo_sem_papel', 'siafisico',
    'empresa', 'medicamento', 'scodes', 'nome_requisicao', 'codigo_unico'];
  const where = campos.map((c) => `${c} LIKE ?`).join(' OR ');
  const empenhos = db.prepare(`
    SELECT id, nota_empenho, numero_requisicao, nome_requisicao, processo_sem_papel,
           empresa, scodes, siafisico, medicamento, apresentacao, quantidade,
           local_entrega, valor_unitario, valor_total, status_entrega, data_entrega_item
    FROM empenhos WHERE ${where}
    ORDER BY empresa COLLATE NOCASE, nota_empenho, medicamento LIMIT 50
  `).all(...campos.map(() => like));
  res.json({ empenhos });
});

router.get('/empenhos/info', (req, res) => {
  const row = db.prepare('SELECT MAX(data_referencia) dataReferencia, COUNT(*) total FROM empenhos').get();
  res.json(row || { dataReferencia: null, total: 0 });
});

// Lista paginada dos empenhos importados (aba "Empenhos importados").
router.get('/empenhos', (req, res) => {
  const { page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 300);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;
  const q = (req.query.q || '').trim();
  let where = '', params = [];
  if (q) {
    const campos = ['nota_empenho', 'numero_requisicao', 'processo_sem_papel', 'siafisico', 'empresa', 'medicamento', 'scodes', 'nome_requisicao'];
    where = 'WHERE ' + campos.map((c) => `${c} LIKE ?`).join(' OR ');
    params = campos.map(() => `%${q}%`);
  }
  const total = db.prepare(`SELECT COUNT(*) c FROM empenhos ${where}`).get(...params).c;
  const itens = db.prepare(`
    SELECT nota_empenho, empresa, scodes, siafisico, medicamento, apresentacao, quantidade,
           valor_unitario, valor_total, status_entrega, local_entrega, numero_requisicao,
           processo_sem_papel, data_entrega_item, atraso
    FROM empenhos ${where}
    ORDER BY empresa COLLATE NOCASE, nota_empenho, medicamento LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const dataRef = db.prepare('SELECT MAX(data_referencia) v FROM empenhos').get()?.v || null;
  res.json({ total, itens, dataReferencia: dataRef, page: Number(page), pageSize: limit });
});

// ---------- Filtros distintos ----------
router.get('/filtros', (req, res) => {
  const dist = (col) => db.prepare(
    `SELECT DISTINCT ${col} v FROM cartas_troca WHERE ${col} IS NOT NULL AND ${col} <> '' ORDER BY v`
  ).all().map((r) => r.v);
  res.json({ empresa: dist('empresa'), status_troca: dist('status_troca') });
});

// ---------- Lotes: helpers ----------
function lotesDaCarta(cartaId) {
  return db.prepare('SELECT id, lote, data_validade, quantidade FROM cartas_troca_lotes WHERE carta_id = ? ORDER BY id').all(cartaId);
}
// Normaliza/valida a lista de lotes vinda do cliente. Cada lote precisa de
// validade; quantidade é obrigatória para fechar com a quantidade da carta.
function prepararLotes(lotesBrutos) {
  const lotes = (Array.isArray(lotesBrutos) ? lotesBrutos : [])
    .map((l) => ({ lote: texto(l.lote), data_validade: texto(l.data_validade), quantidade: numero(l.quantidade) }))
    .filter((l) => l.data_validade || l.lote || l.quantidade != null);
  return lotes;
}
function gravarLotes(cartaId, lotes) {
  db.prepare('DELETE FROM cartas_troca_lotes WHERE carta_id = ?').run(cartaId);
  const stmt = db.prepare('INSERT INTO cartas_troca_lotes (carta_id, lote, data_validade, quantidade) VALUES (?, ?, ?, ?)');
  for (const l of lotes) stmt.run(cartaId, l.lote, l.data_validade, l.quantidade);
}
// Validade mais próxima (menor data) entre os lotes — derivada, para o alerta.
function validadeMaisProxima(lotes) {
  const datas = lotes.map((l) => l.data_validade).filter(Boolean).sort();
  return datas.length ? datas[0] : null;
}

// Resolve a quantidade da carta conforme Total/Parcial e valida a soma dos lotes.
// Total  → quantidade = quantidade do empenho (coluna QUANTIDADE).
// Parcial→ quantidade = informada pelo usuário.
// Em ambos, a soma das quantidades dos lotes deve fechar com a quantidade.
function resolverQuantidade(tipo, quantidadeInformada, empenhoQtd, lotes) {
  const soma = lotes.reduce((s, l) => s + (l.quantidade || 0), 0);
  let qtd;
  if (tipo === 'Parcial') {
    qtd = numero(quantidadeInformada);
    if (qtd == null) qtd = soma; // se não informou, usa a soma dos lotes
  } else {
    qtd = numero(empenhoQtd);
    if (qtd == null) qtd = numero(quantidadeInformada); // empenho sem qtd: cai no informado
  }
  return { qtd, soma };
}

// ---------- Montagem do filtro da listagem ----------
function montarFiltro(query) {
  const cond = [];
  const params = [];
  if (query.q) {
    const like = `%${query.q}%`;
    cond.push(`(nota_empenho LIKE ? OR empresa LIKE ? OR medicamento LIKE ? OR codigo_item LIKE ?
               OR siafisico LIKE ? OR numero_protocolo LIKE ? OR numero_requisicao LIKE ? OR codigo_controle LIKE ?)`);
    params.push(like, like, like, like, like, like, like, like);
  }
  if (query.empresa) { cond.push('empresa = ?'); params.push(query.empresa); }
  if (query.status_troca) { cond.push('status_troca = ?'); params.push(query.status_troca); }
  if (query.situacao) { cond.push('situacao_analise = ?'); params.push(query.situacao); }
  return { where: cond.length ? `WHERE ${cond.join(' AND ')}` : '', params };
}

// ---------- Listar cartas ----------
router.get('/', (req, res) => {
  const { page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 300);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;
  const { where, params } = montarFiltro(req.query);

  const total = db.prepare(`SELECT COUNT(*) c FROM cartas_troca ${where}`).get(...params).c;
  const cartas = db.prepare(
    `SELECT * FROM cartas_troca ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  for (const c of cartas) c.lotes = lotesDaCarta(c.id);

  // KPIs (sempre da base inteira, para as abas mostrarem os totais reais).
  const contar = (col) => {
    const m = {};
    db.prepare(`SELECT ${col} k, COUNT(*) c FROM cartas_troca GROUP BY ${col}`).all().forEach((r) => { m[r.k] = r.c; });
    return m;
  };
  res.json({
    total, cartas,
    porSituacao: contar('situacao_analise'),
    porStatus: contar('status_troca'),
    totalGeral: db.prepare('SELECT COUNT(*) c FROM cartas_troca').get().c,
    page: Number(page), pageSize: limit,
  });
});

// ---------- Exportar CSV ----------
router.get('/exportar', (req, res) => {
  const { where, params } = montarFiltro(req.query);
  const linhas = db.prepare(`SELECT * FROM cartas_troca ${where} ORDER BY id DESC`).all(...params);
  const cols = [
    ['codigo_controle', 'Controle'], ['situacao_analise', 'Situação da Análise'], ['status_troca', 'Status da Troca'],
    ['empresa', 'Fornecedor'], ['nota_empenho', 'Nota de Empenho'], ['numero_requisicao', 'Requisição'],
    ['nome_requisicao', 'Nome da Requisição'], ['processo_sem_papel', 'Processo Sem Papel/SEI'],
    ['codigo_item', 'SCODES'], ['siafisico', 'SIAFÍSICO'], ['medicamento', 'Medicamento'],
    ['apresentacao', 'Apresentação'], ['local_entrega', 'Local de Entrega'],
    ['tipo_quantidade', 'Total/Parcial'], ['quantidade', 'Quantidade'],
    ['numero_protocolo', 'Nº Protocolo'], ['data_protocolo', 'Data do Protocolo'],
    ['motivo_reprovacao', 'Motivo da Reprovação'], ['avaliado_por', 'Avaliado por'], ['avaliado_em', 'Avaliado em'],
    ['observacao', 'Observação'], ['criado_por', 'Registrado por'], ['criado_em', 'Registrado em'],
  ];
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const header = [...cols.map((c) => esc(c[1])), esc('Lotes (lote|validade|qtd)')].join(';');
  const corpo = linhas.map((l) => {
    const lotes = lotesDaCarta(l.id).map((x) => `${x.lote || '-'}|${x.data_validade || '-'}|${x.quantidade ?? '-'}`).join(' / ');
    return [...cols.map((c) => esc(l[c[0]])), esc(lotes)].join(';');
  }).join('\r\n');
  const csv = '﻿' + header + '\r\n' + corpo;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="cartas_troca.csv"');
  res.send(csv);
});

// ---------- Criar carta (administrativo → Aguardando avaliação) ----------
router.post('/', (req, res) => {
  const b = req.body || {};
  if (!b.empresa || !b.codigo_item) return res.status(400).json({ erro: 'Selecione um empenho (fornecedor e medicamento) antes de registrar a carta.' });
  if (!b.numero_protocolo) return res.status(400).json({ erro: 'Informe o Nº do protocolo.' });

  const lotes = prepararLotes(b.lotes);
  if (!lotes.length || lotes.some((l) => !l.data_validade)) {
    return res.status(400).json({ erro: 'Informe ao menos um lote com data de validade.' });
  }
  const tipo = b.tipo_quantidade === 'Parcial' ? 'Parcial' : 'Total';
  const { qtd, soma } = resolverQuantidade(tipo, b.quantidade, b.empenho_quantidade, lotes);
  if (qtd != null && soma > 0 && Math.abs(soma - qtd) > 0.001) {
    return res.status(400).json({ erro: `A soma das quantidades dos lotes (${soma}) não fecha com a quantidade da carta (${qtd}).` });
  }
  const validade = validadeMaisProxima(lotes);

  let id;
  db.exec('BEGIN');
  try {
    const info = db.prepare(`
      INSERT INTO cartas_troca
        (empenho_id, nota_empenho, numero_requisicao, nome_requisicao, processo_sem_papel, empresa,
         codigo_item, siafisico, medicamento, apresentacao, local_entrega, numero_protocolo, data_protocolo,
         data_validade, quantidade, tipo_quantidade, status_troca, situacao_analise, observacao,
         criado_por, criado_por_email, enviado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Aguardando avaliação', ?, ?, ?, datetime('now','localtime'))
    `).run(
      b.empenho_id || null, b.nota_empenho || null, b.numero_requisicao || null, b.nome_requisicao || null,
      b.processo_sem_papel || null, b.empresa, b.codigo_item, b.siafisico || null, b.medicamento || null,
      b.apresentacao || null, b.local_entrega || null, b.numero_protocolo, b.data_protocolo || null,
      validade, qtd, tipo, b.status_troca || 'Vigente', b.observacao || null,
      req.usuario.nome || req.usuario.email, req.usuario.email
    );
    id = info.lastInsertRowid;
    const codigo = `CT-${new Date().getFullYear()}-${String(id).padStart(5, '0')}`;
    db.prepare('UPDATE cartas_troca SET codigo_controle = ? WHERE id = ?').run(codigo, id);
    gravarLotes(id, lotes);
    db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.usuario.id, req.usuario.email, 'criar_carta_troca', 'cartas_troca', id,
        JSON.stringify({ codigo, empresa: b.empresa, medicamento: b.medicamento, nota_empenho: b.nota_empenho }));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  const carta = db.prepare('SELECT * FROM cartas_troca WHERE id = ?').get(id);
  emailCarta.notificarAguardandoAvaliacao(carta).catch(() => {});
  res.status(201).json({ id, codigo_controle: carta.codigo_controle });
});

// ---------- Detalhe ----------
router.get('/:id', (req, res) => {
  const carta = db.prepare('SELECT * FROM cartas_troca WHERE id = ?').get(req.params.id);
  if (!carta) return res.status(404).json({ erro: 'Carta não encontrada.' });
  carta.lotes = lotesDaCarta(carta.id);
  res.json({ carta });
});

// Aplica os campos editáveis (comum a reenviar e avaliar). Retorna erro (string) ou null.
function aplicarCamposEditaveis(carta, b) {
  const lotes = prepararLotes(b.lotes);
  if (!lotes.length || lotes.some((l) => !l.data_validade)) return { erro: 'Informe ao menos um lote com data de validade.' };
  const tipo = b.tipo_quantidade === 'Parcial' ? 'Parcial' : 'Total';
  const { qtd, soma } = resolverQuantidade(tipo, b.quantidade, b.empenho_quantidade ?? carta.quantidade, lotes);
  if (qtd != null && soma > 0 && Math.abs(soma - qtd) > 0.001) {
    return { erro: `A soma das quantidades dos lotes (${soma}) não fecha com a quantidade da carta (${qtd}).` };
  }
  const validade = validadeMaisProxima(lotes);
  db.prepare(`
    UPDATE cartas_troca SET
      empresa = ?, nota_empenho = ?, numero_requisicao = ?, nome_requisicao = ?, processo_sem_papel = ?,
      codigo_item = ?, siafisico = ?, medicamento = ?, apresentacao = ?, local_entrega = ?,
      numero_protocolo = ?, data_protocolo = ?, data_validade = ?, quantidade = ?, tipo_quantidade = ?,
      status_troca = ?, observacao = ?, atualizado_em = datetime('now','localtime')
    WHERE id = ?
  `).run(
    b.empresa ?? carta.empresa, b.nota_empenho ?? carta.nota_empenho, b.numero_requisicao ?? carta.numero_requisicao,
    b.nome_requisicao ?? carta.nome_requisicao, b.processo_sem_papel ?? carta.processo_sem_papel,
    b.codigo_item ?? carta.codigo_item, b.siafisico ?? carta.siafisico, b.medicamento ?? carta.medicamento,
    b.apresentacao ?? carta.apresentacao, b.local_entrega ?? carta.local_entrega,
    b.numero_protocolo ?? carta.numero_protocolo, b.data_protocolo ?? carta.data_protocolo,
    validade, qtd, tipo, b.status_troca ?? carta.status_troca, b.observacao ?? carta.observacao, carta.id
  );
  gravarLotes(carta.id, lotes);
  return { erro: null };
}

// ---------- Reenviar (administrativo corrige uma Reprovada e reenvia) ----------
router.post('/:id/reenviar', (req, res) => {
  const carta = db.prepare('SELECT * FROM cartas_troca WHERE id = ?').get(req.params.id);
  if (!carta) return res.status(404).json({ erro: 'Carta não encontrada.' });

  db.exec('BEGIN');
  try {
    const r = aplicarCamposEditaveis(carta, req.body || {});
    if (r.erro) { db.exec('ROLLBACK'); return res.status(400).json({ erro: r.erro }); }
    db.prepare("UPDATE cartas_troca SET situacao_analise = 'Aguardando avaliação', motivo_reprovacao = NULL, avaliado_por = NULL, avaliado_em = NULL, enviado_em = datetime('now','localtime') WHERE id = ?").run(carta.id);
    db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.usuario.id, req.usuario.email, 'reenviar_carta_troca', 'cartas_troca', carta.id, JSON.stringify({ codigo: carta.codigo_controle }));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  const atual = db.prepare('SELECT * FROM cartas_troca WHERE id = ?').get(carta.id);
  emailCarta.notificarAguardandoAvaliacao(atual).catch(() => {});
  res.json({ ok: true });
});

// ---------- Avaliar (técnico: edita o que precisar e Aprova/Reprova) ----------
router.put('/:id/avaliar', (req, res) => {
  const carta = db.prepare('SELECT * FROM cartas_troca WHERE id = ?').get(req.params.id);
  if (!carta) return res.status(404).json({ erro: 'Carta não encontrada.' });
  const b = req.body || {};
  const resultado = b.resultado === 'Reprovada' ? 'Reprovada' : (b.resultado === 'Aprovada' ? 'Aprovada' : null);
  if (!resultado) return res.status(400).json({ erro: 'Informe o resultado da avaliação (Aprovada ou Reprovada).' });
  if (resultado === 'Reprovada' && !texto(b.motivo_reprovacao)) {
    return res.status(400).json({ erro: 'Para reprovar, informe o motivo.' });
  }

  db.exec('BEGIN');
  try {
    // O técnico pode editar todos os campos (inclusive os que vieram do empenho).
    const r = aplicarCamposEditaveis(carta, b);
    if (r.erro) { db.exec('ROLLBACK'); return res.status(400).json({ erro: r.erro }); }
    db.prepare("UPDATE cartas_troca SET situacao_analise = ?, motivo_reprovacao = ?, avaliado_por = ?, avaliado_em = datetime('now','localtime') WHERE id = ?")
      .run(resultado, resultado === 'Reprovada' ? texto(b.motivo_reprovacao) : null, req.usuario.nome || req.usuario.email, carta.id);
    db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.usuario.id, req.usuario.email, 'avaliar_carta_troca', 'cartas_troca', carta.id,
        JSON.stringify({ codigo: carta.codigo_controle, resultado }));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  const atual = db.prepare('SELECT * FROM cartas_troca WHERE id = ?').get(carta.id);
  emailCarta.notificarResultado(atual).catch(() => {});
  res.json({ ok: true, situacao_analise: resultado });
});

// ---------- Atualizar só o status físico da troca (acompanhamento) ----------
router.post('/:id/status', (req, res) => {
  const carta = db.prepare('SELECT * FROM cartas_troca WHERE id = ?').get(req.params.id);
  if (!carta) return res.status(404).json({ erro: 'Carta não encontrada.' });
  const st = texto((req.body || {}).status_troca);
  const validos = ['Vigente', 'Vencido no estoque', 'Trocado', 'Consumido', 'Cancelado'];
  if (!validos.includes(st)) return res.status(400).json({ erro: 'Status da troca inválido.' });
  db.prepare("UPDATE cartas_troca SET status_troca = ?, atualizado_em = datetime('now','localtime') WHERE id = ?").run(st, carta.id);
  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.usuario.id, req.usuario.email, 'status_carta_troca', 'cartas_troca', carta.id, JSON.stringify({ status_troca: st }));
  res.json({ ok: true });
});

// ---------- Excluir ----------
router.delete('/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM cartas_troca WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ erro: 'Carta não encontrada.' });
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM cartas_troca_lotes WHERE carta_id = ?').run(c.id);
    db.prepare('DELETE FROM cartas_troca WHERE id = ?').run(c.id);
    db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_antes) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.usuario.id, req.usuario.email, 'excluir_carta_troca', 'cartas_troca', c.id, JSON.stringify({ codigo_controle: c.codigo_controle, empresa: c.empresa }));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true });
});

module.exports = router;
