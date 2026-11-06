// =====================================================================
// routes.comprasSeg.js
// Relatório de Compras / Aquisição em Andamento dos SEGMENTOS novos do
// Tenente Pena (Nutrição, Materiais), lidos da tabela `solicitacoes_seg`
// filtrando por `segmento`. Espelha o /consolidado de Medicamentos
// (routes.relatorios.js), cruzando com o elenco `itens` para descrição e
// siafísico. Só leitura — não escreve nada.
// =====================================================================
const express = require('express');
const db = require('./db');
const { enviarXlsxAoa, pediuXlsx } = require('./exportarPlanilha');
const { autenticar } = require('./auth');
const EmpProc = require('./empenhoPorProcesso');

const router = express.Router();
router.use(autenticar);

const ORDEM_MES = {
  Janeiro: 1, Fevereiro: 2, Março: 3, Abril: 4, Maio: 5, Junho: 6,
  Julho: 7, Agosto: 8, Setembro: 9, Outubro: 10, Novembro: 11, Dezembro: 12,
};

// Status "em aberto" (compra em andamento) — igual ao resto do sistema.
const STATUS_ABERTO = ['Planejamento', 'Adjudicado', 'Empenhado', 'Entrega Parcial'];

// Segmentos que este endpoint atende (os guardados em solicitacoes_seg).
const SEGMENTOS = { 'nutricao': 'Nutrição', 'materiais': 'Materiais' };

function resolverSegmento(param) {
  if (!param) return null;
  const chave = String(param).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return SEGMENTOS[chave] || null;
}

// GET /api/compras-seg/:segmento/consolidado
// Filtros: q, status, ano, mes, emAberto(=1). Export: ?formato=csv|xlsx.
router.get('/:segmento/consolidado', (req, res) => {
  const segmento = resolverSegmento(req.params.segmento);
  if (!segmento) return res.status(404).json({ erro: 'Segmento inválido (use "nutricao" ou "materiais").' });

  const { q, status, ano, mes, emAberto, formato } = req.query;

  const cond = ['s.segmento = ?'];
  const params = [segmento];

  if (q) {
    cond.push(`(
      i.descricao LIKE ? OR s.codigo_item LIKE ? OR i.codigo_siafisico LIKE ?
      OR s.sei LIKE ? OR s.requisicao_gsnet LIKE ? OR s.n_empenho LIKE ?
    )`);
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }
  if (emAberto === '1') {
    cond.push(`s.status IN (${STATUS_ABERTO.map(() => '?').join(',')})`);
    params.push(...STATUS_ABERTO);
  } else if (status) {
    cond.push('s.status = ?');
    params.push(status);
  }
  if (ano) { cond.push('s.ano = ?'); params.push(ano); }
  if (mes) { cond.push('s.mes = ?'); params.push(mes); }

  const where = `WHERE ${cond.join(' AND ')}`;

  const linhas = db.prepare(`
    SELECT
      s.id,
      i.codigo_item,
      i.codigo_siafisico,
      i.descricao,
      s.ano, s.mes, s.tipo, s.modalidade_compra,
      s.sei, s.qtde_solicitada, s.data_solicitacao, s.requisicao_gsnet,
      s.n_empenho, s.quantidade_empenho, s.data_previsao_entrega, s.data_entrega,
      s.qtde_entregue, s.qtde_pendente, s.status,
      (SELECT ce.ds_status_item_processo FROM compras_estrategico ce
        WHERE ce.codigo_item = s.codigo_item AND TRIM(ce.nr_requisicao) = TRIM(s.requisicao_gsnet)
          AND ce.ds_status_item_processo IS NOT NULL AND ce.ds_status_item_processo <> ''
        ORDER BY ce.id DESC LIMIT 1) AS status_item_processo,
      COALESCE(s.protocolo_processo, (SELECT ce.protocolo_processo FROM compras_estrategico ce
        WHERE ce.codigo_item = s.codigo_item AND TRIM(ce.nr_requisicao) = TRIM(s.requisicao_gsnet)
          AND ce.protocolo_processo IS NOT NULL AND ce.protocolo_processo <> ''
        ORDER BY ce.id DESC LIMIT 1)) AS protocolo_processo,
      (s.protocolo_processo IS NOT NULL AND s.protocolo_processo <> '') AS protocolo_manual,
      s.observacao, s.justificativa
    FROM solicitacoes_seg s
    JOIN itens i ON s.codigo_item = i.codigo_item
    ${where}
  `).all(...params)
    .sort((a, b) => a.ano - b.ano || ORDEM_MES[a.mes] - ORDEM_MES[b.mes] || a.codigo_item.localeCompare(b.codigo_item));
  // Overlay: preenche o Nº Empenho vazio casando codigo_item + SEI (campo `sei`)
  // contra empenhos/empenhos_consulta/compras_estrategico — igual a Medicamentos/OD.
  EmpProc.preencher(linhas, 'sei');

  const resumoPorMes = db.prepare(`
    SELECT s.ano, s.mes, COUNT(*) as qtde
    FROM solicitacoes_seg s
    JOIN itens i ON s.codigo_item = i.codigo_item
    ${where}
    GROUP BY s.ano, s.mes
  `).all(...params)
    .sort((a, b) => a.ano - b.ano || ORDEM_MES[a.mes] - ORDEM_MES[b.mes]);

  if (formato === 'csv' || formato === 'xlsx') {
    const cabecalho = [
      'codigo_item', 'codigo_siafisico', 'descricao', 'ano', 'mes', 'tipo',
      'modalidade_compra', 'sei', 'qtde_solicitada', 'data_solicitacao',
      'requisicao_gsnet', 'n_empenho', 'quantidade_empenho', 'data_previsao_entrega',
      'data_entrega', 'qtde_entregue', 'qtde_pendente', 'status',
      'status_item_processo', 'protocolo_processo', 'observacao', 'justificativa',
    ];
    const nomeBase = `relatorio_compras_${resolverSegmento(req.params.segmento).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()}`;
    if (formato === 'xlsx') {
      const aoa = [cabecalho, ...linhas.map((l) => cabecalho.map((c) => l[c] ?? ''))];
      return enviarXlsxAoa(res, `${nomeBase}.xlsx`, aoa, segmento);
    }
    const escapar = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const csv = [
      cabecalho.join(','),
      ...linhas.map((l) => cabecalho.map((c) => escapar(l[c])).join(',')),
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeBase}.csv"`);
    return res.send('﻿' + csv);
  }

  res.json({ segmento, total: linhas.length, resumoPorMes, solicitacoes: linhas });
});

// PUT /api/compras-seg/:segmento/:id/protocolo  — grava o Protocolo do Processo
// MANUAL de uma solicitação do segmento. Vazio limpa o manual (volta a mostrar o
// do robô). Qualquer usuário logado pode editar (decisão do Rafael).
router.put('/:segmento/:id/protocolo', (req, res) => {
  const segmento = resolverSegmento(req.params.segmento);
  if (!segmento) return res.status(404).json({ erro: 'Segmento inválido.' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ erro: 'Id inválido.' });

  const bruto = (req.body && req.body.protocolo != null) ? String(req.body.protocolo).trim() : '';
  const valor = bruto === '' ? null : bruto;

  const r = db.prepare('UPDATE solicitacoes_seg SET protocolo_processo = ? WHERE id = ? AND segmento = ?')
    .run(valor, id, segmento);
  if (r.changes === 0) return res.status(404).json({ erro: 'Solicitação não encontrada neste segmento.' });

  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?,?,?,?,?,?)')
    .run(req.usuario.id, req.usuario.email, 'editar_protocolo_seg', 'solicitacoes_seg', String(id), JSON.stringify({ protocolo_processo: valor }));

  res.json({ ok: true, protocolo_processo: valor });
});

module.exports = router;
