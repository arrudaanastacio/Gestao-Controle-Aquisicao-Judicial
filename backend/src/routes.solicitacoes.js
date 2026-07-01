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

// Lista/busca solicitações com filtros (todos os perfis podem consultar)
router.get('/', (req, res) => {
  const { q, status, ano, mes, atrasados, page = 1, pageSize = 50 } = req.query;
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
  if (status) {
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

  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

  const total = db.prepare(
    `SELECT COUNT(*) as c FROM solicitacoes s JOIN itens i ON s.codigo_item = i.codigo_item ${where}`
  ).get(...params).c;

  const linhas = db.prepare(`
    SELECT s.*, i.descricao, i.codigo_siafisico
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
