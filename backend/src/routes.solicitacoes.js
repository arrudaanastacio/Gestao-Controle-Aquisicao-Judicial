const express = require('express');
const db = require('./db');
const { autenticar, exigirPerfil } = require('./auth');

const router = express.Router();
router.use(autenticar);

const ORDEM_MES = {
  Janeiro: 1, Fevereiro: 2, Março: 3, Abril: 4, Maio: 5, Junho: 6,
  Julho: 7, Agosto: 8, Setembro: 9, Outubro: 10, Novembro: 11, Dezembro: 12,
};

const STATUS_FINALIZADOS = ['Finalizado', 'Cancelado', 'Revogado', 'Fracassado', 'Deserto'];
const STATUS_EM_ABERTO = ['Planejamento', 'Adjudicado', 'Empenhado', 'Entrega Parcial'];

// Status do item NO PROCESSO (GSNET, via robô de Compras) que indicam pendência
// — usados na aba de Alertas "Pendências no processo".
const STATUS_PROC_PENDENCIA = ['Descontinuado', 'Cancelado', 'Deserto', 'Fracassado', 'Revogado'];
// Sub-select que resolve o "Status Item Processo" de uma solicitação (alias s).
const SUB_STATUS_PROC = `(SELECT ce.ds_status_item_processo FROM compras_estrategico ce
  WHERE ce.codigo_item = s.codigo_item AND TRIM(ce.nr_requisicao) = TRIM(s.requisicao_gsnet)
    AND ce.ds_status_item_processo IS NOT NULL AND ce.ds_status_item_processo <> ''
  ORDER BY ce.id DESC LIMIT 1)`;

// Lista/busca solicitações com filtros (todos os perfis podem consultar)
router.get('/', (req, res) => {
  const { q, status, ano, mes, atrasados, statusProcesso, page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const condicoes = [];
  const params = [];

  if (q) {
    condicoes.push(`(
      i.descricao LIKE ? OR s.codigo_item LIKE ? OR i.codigo_siafisico LIKE ?
      OR s.n_oficio LIKE ? OR s.requisicao_gsnet LIKE ? OR s.n_empenho LIKE ?
    )`);
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }
  if (status === '__em_aberto__') {
    condicoes.push(`s.status IN (${STATUS_EM_ABERTO.map(() => '?').join(',')})`);
    params.push(...STATUS_EM_ABERTO);
  } else if (status) {
    condicoes.push('s.status = ?');
    params.push(status);
  }
  if (ano) {
    condicoes.push('s.ano = ?');
    params.push(ano);
  }
  if (mes) {
    condicoes.push('s.mes = ?');
    params.push(mes);
  }
  if (atrasados === 'true') {
    condicoes.push(`s.data_previsao_entrega IS NOT NULL
      AND date(s.data_previsao_entrega) < date('now')
      AND (s.status IS NULL OR s.status NOT IN (${STATUS_FINALIZADOS.map(() => '?').join(',')}))`);
    params.push(...STATUS_FINALIZADOS);
  }
  if (statusProcesso) {
    condicoes.push(`(SELECT ce.ds_status_item_processo FROM compras_estrategico ce
      WHERE ce.codigo_item = s.codigo_item AND TRIM(ce.nr_requisicao) = TRIM(s.requisicao_gsnet)
        AND ce.ds_status_item_processo IS NOT NULL AND ce.ds_status_item_processo <> ''
      ORDER BY ce.id DESC LIMIT 1) = ?`);
    params.push(statusProcesso);
  }

  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

  const total = db.prepare(
    `SELECT COUNT(*) as c FROM solicitacoes s JOIN itens i ON s.codigo_item = i.codigo_item ${where}`
  ).get(...params).c;

  const linhas = db.prepare(`
    SELECT s.*, i.descricao, i.codigo_siafisico,
      (SELECT ce.ds_status_item_processo
         FROM compras_estrategico ce
        WHERE ce.codigo_item = s.codigo_item
          AND TRIM(ce.nr_requisicao) = TRIM(s.requisicao_gsnet)
          AND ce.ds_status_item_processo IS NOT NULL AND ce.ds_status_item_processo <> ''
        ORDER BY ce.id DESC LIMIT 1) AS status_item_processo,
      (SELECT ce.protocolo_processo
         FROM compras_estrategico ce
        WHERE ce.codigo_item = s.codigo_item
          AND TRIM(ce.nr_requisicao) = TRIM(s.requisicao_gsnet)
          AND ce.protocolo_processo IS NOT NULL AND ce.protocolo_processo <> ''
        ORDER BY ce.id DESC LIMIT 1) AS protocolo_processo
    FROM solicitacoes s
    JOIN itens i ON s.codigo_item = i.codigo_item
    ${where}
    ORDER BY s.ano DESC, s.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ solicitacoes: linhas, total, page: Number(page), pageSize: limit });
});

// Indicadores gerais para o painel
router.get('/resumo', (req, res) => {
  const porStatus = db.prepare(`
    SELECT COALESCE(status, 'Em andamento') as status, COUNT(*) as qtde
    FROM solicitacoes GROUP BY status
  `).all();

  const atrasados = db.prepare(`
    SELECT COUNT(*) as qtde FROM solicitacoes
    WHERE data_previsao_entrega IS NOT NULL
      AND date(data_previsao_entrega) < date('now')
      AND (status IS NULL OR status NOT IN (${STATUS_FINALIZADOS.map(() => '?').join(',')}))
  `).get(...STATUS_FINALIZADOS).qtde;

  const porMes = db.prepare(`
    SELECT ano, mes, COUNT(*) as qtde
    FROM solicitacoes GROUP BY ano, mes
  `).all().sort((a, b) => a.ano - b.ano || ORDEM_MES[a.mes] - ORDEM_MES[b.mes]);

  res.json({ porStatus, atrasados, porMes });
});

// Valores distintos de "Status Item Processo" (do robô de Compras) para popular
// o filtro nas telas de Aquisição em Andamento e Relatório de Compras Geral.
router.get('/status-processo', (req, res) => {
  let valores = [];
  try {
    valores = db.prepare(
      `SELECT DISTINCT ds_status_item_processo AS v FROM compras_estrategico
       WHERE ds_status_item_processo IS NOT NULL AND ds_status_item_processo <> ''
       ORDER BY v`
    ).all().map((r) => r.v);
  } catch (_) { valores = []; }
  res.json({ valores });
});

// Pendências no processo (para a aba de Alertas): solicitações cujo Status Item
// Processo (GSNET) é um dos STATUS_PROC_PENDENCIA. Devolve a contagem de cada
// status (para os "badges" das abas) e, se `status` for um deles, TODAS as
// linhas daquele status (sem paginação — são poucas centenas).
// Condição SQL: a solicitação (alias s) NÃO foi marcada como tratada.
const NAO_TRATADO = `NOT EXISTS (SELECT 1 FROM pendencias_processo_resolvidas r
  WHERE r.codigo_item = s.codigo_item AND TRIM(r.requisicao_gsnet) = TRIM(s.requisicao_gsnet))`;

router.get('/pendencias-processo', (req, res) => {
  const status = String(req.query.status || '').trim();
  const incluirTratados = req.query.incluirTratados === 'true';
  const contagens = {};
  try {
    for (const st of STATUS_PROC_PENDENCIA) {
      contagens[st] = db.prepare(
        `SELECT COUNT(*) c FROM solicitacoes s JOIN itens i ON s.codigo_item = i.codigo_item
         WHERE ${SUB_STATUS_PROC} = ? AND ${NAO_TRATADO}`
      ).get(st).c;
    }
  } catch (_) { /* sem compras_estrategico ainda */ }

  let solicitacoes = [];
  if (STATUS_PROC_PENDENCIA.includes(status)) {
    try {
      const filtro = incluirTratados ? '' : `AND ${NAO_TRATADO}`;
      solicitacoes = db.prepare(
        `SELECT s.*, i.descricao, i.codigo_siafisico, ${SUB_STATUS_PROC} AS status_item_processo,
           (CASE WHEN ${NAO_TRATADO} THEN 0 ELSE 1 END) AS tratado
         FROM solicitacoes s JOIN itens i ON s.codigo_item = i.codigo_item
         WHERE ${SUB_STATUS_PROC} = ? ${filtro}
         ORDER BY s.ano DESC, s.id DESC`
      ).all(status);
    } catch (_) { solicitacoes = []; }
  }
  res.json({ statuses: STATUS_PROC_PENDENCIA, contagens, status, incluirTratados, solicitacoes });
});

// Marca/desmarca uma pendência como "tratada" (some da lista e não volta).
// Só admin. Chave estável = codigo_item + requisicao_gsnet.
router.post('/pendencias-processo/resolver', exigirPerfil('admin'), (req, res) => {
  const b = req.body || {};
  const codigo_item = String(b.codigo_item || '').trim();
  const requisicao = String(b.requisicao_gsnet || '').trim();
  const statusProc = String(b.status_item_processo || '').trim();
  const tratar = b.tratado !== false; // padrão: marcar como tratado
  if (!codigo_item || !requisicao) return res.status(400).json({ erro: 'Informe codigo_item e requisicao_gsnet.' });
  const email = (req.usuario && req.usuario.email) || null;
  try {
    if (tratar) {
      db.prepare(`INSERT INTO pendencias_processo_resolvidas
          (codigo_item, requisicao_gsnet, status_item_processo, resolvido_por, resolvido_em)
        VALUES (?, ?, ?, ?, datetime('now','localtime'))
        ON CONFLICT(codigo_item, requisicao_gsnet) DO UPDATE SET
          status_item_processo=excluded.status_item_processo,
          resolvido_por=excluded.resolvido_por, resolvido_em=excluded.resolvido_em`)
        .run(codigo_item, requisicao, statusProc || null, email);
    } else {
      db.prepare('DELETE FROM pendencias_processo_resolvidas WHERE codigo_item=? AND TRIM(requisicao_gsnet)=TRIM(?)')
        .run(codigo_item, requisicao);
    }
    db.prepare('INSERT INTO auditoria (usuario_email, acao, tabela, registro_id) VALUES (?,?,?,?)')
      .run(email, tratar ? 'tratar_pendencia_processo' : 'reabrir_pendencia_processo',
        'pendencias_processo_resolvidas', codigo_item + '|' + requisicao);
  } catch (e) {
    return res.status(400).json({ erro: 'Não consegui salvar: ' + e.message });
  }
  res.json({ ok: true, tratado: tratar });
});

// Busca do andamento de um medicamento específico por código ou descrição,
// retornando o histórico completo em todos os meses (ordem cronológica)
router.get('/historico-medicamento', (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.status(400).json({ erro: 'Informe ao menos 2 caracteres para buscar.' });
  }
  const like = `%${q.trim()}%`;

  const itensEncontrados = db.prepare(`
    SELECT codigo_item, codigo_siafisico, descricao
    FROM itens
    WHERE codigo_item LIKE ? OR codigo_siafisico LIKE ? OR descricao LIKE ?
    ORDER BY descricao
    LIMIT 30
  `).all(like, like, like);

  const resultado = itensEncontrados.map((item) => {
    const historico = db.prepare(`
      SELECT ano, mes, tipo, modalidade_compra, n_oficio, qtde_solicitada,
             data_solicitacao, requisicao_gsnet, n_empenho, quantidade_empenho,
             data_previsao_entrega, data_entrega, qtde_entregue, qtde_pendente,
             status, observacao, justificativa
      FROM solicitacoes
      WHERE codigo_item = ?
      ORDER BY ano,
        CASE mes
          WHEN 'Janeiro' THEN 1 WHEN 'Fevereiro' THEN 2 WHEN 'Março' THEN 3 WHEN 'Abril' THEN 4
          WHEN 'Maio' THEN 5 WHEN 'Junho' THEN 6 WHEN 'Julho' THEN 7 WHEN 'Agosto' THEN 8
          WHEN 'Setembro' THEN 9 WHEN 'Outubro' THEN 10 WHEN 'Novembro' THEN 11 WHEN 'Dezembro' THEN 12
        END
    `).all(item.codigo_item);

    return { item, historico };
  });

  res.json({ resultados: resultado });
});

router.get('/:id', (req, res) => {
  const item = db.prepare(`
    SELECT s.*, i.descricao, i.codigo_siafisico
    FROM solicitacoes s JOIN itens i ON s.codigo_item = i.codigo_item
    WHERE s.id = ?
  `).get(req.params.id);
  if (!item) return res.status(404).json({ erro: 'Solicitação não encontrada.' });
  res.json({ solicitacao: item });
});

// A escrita (inserir/editar/excluir) é controlada pela permissão do módulo
// "compras" (ver server.js / exigirModulo). Admin sempre pode.

const CAMPOS_EDITAVEIS = [
  'tipo', 'modalidade_compra', 'n_oficio', 'qtde_solicitada', 'data_solicitacao',
  'requisicao_gsnet', 'n_empenho', 'quantidade_empenho', 'data_previsao_entrega',
  'data_entrega', 'qtde_entregue', 'qtde_pendente', 'status', 'observacao', 'justificativa',
];

router.post('/', (req, res) => {
  const { codigo_item, ano, mes } = req.body || {};
  if (!codigo_item || !ano || !mes) {
    return res.status(400).json({ erro: 'codigo_item, ano e mes são obrigatórios.' });
  }
  const itemExiste = db.prepare('SELECT 1 FROM itens WHERE codigo_item = ?').get(codigo_item);
  if (!itemExiste) {
    return res.status(400).json({ erro: 'codigo_item não existe no catálogo.' });
  }

  const campos = ['codigo_item', 'ano', 'mes', ...CAMPOS_EDITAVEIS];
  const valores = campos.map((c) => req.body[c] ?? null);

  const info = db.prepare(
    `INSERT INTO solicitacoes (${campos.join(',')}) VALUES (${campos.map(() => '?').join(',')})`
  ).run(...valores);

  db.prepare(
    'INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.usuario.id, req.usuario.email, 'criar_solicitacao', 'solicitacoes', info.lastInsertRowid, JSON.stringify(req.body));

  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const { id } = req.params;
  const atual = db.prepare('SELECT * FROM solicitacoes WHERE id = ?').get(id);
  if (!atual) return res.status(404).json({ erro: 'Solicitação não encontrada.' });

  const sets = [];
  const valores = [];
  for (const campo of CAMPOS_EDITAVEIS) {
    if (campo in req.body) {
      sets.push(`${campo} = ?`);
      valores.push(req.body[campo]);
    }
  }
  if (sets.length === 0) {
    return res.status(400).json({ erro: 'Nenhum campo válido para atualizar.' });
  }

  db.prepare(`UPDATE solicitacoes SET ${sets.join(', ')} WHERE id = ?`).run(...valores, id);

  db.prepare(
    'INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_antes, dados_depois) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.usuario.id, req.usuario.email, 'editar_solicitacao', 'solicitacoes', id, JSON.stringify(atual), JSON.stringify(req.body));

  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const atual = db.prepare('SELECT * FROM solicitacoes WHERE id = ?').get(id);
  if (!atual) return res.status(404).json({ erro: 'Solicitação não encontrada.' });

  db.prepare('DELETE FROM solicitacoes WHERE id = ?').run(id);

  db.prepare(
    'INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_antes) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.usuario.id, req.usuario.email, 'excluir_solicitacao', 'solicitacoes', id, JSON.stringify(atual));

  res.json({ ok: true });
});

module.exports = router;
