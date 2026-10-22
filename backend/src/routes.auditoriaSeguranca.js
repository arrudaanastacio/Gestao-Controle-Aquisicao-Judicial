// =====================================================================
// routes.auditoriaSeguranca.js — API da tela "Auditoria de Segurança".
//
// Mostra os EVENTOS DE SEGURANÇA que a Onda B passou a gravar: login_ok,
// login_falho, logout e acesso_negado. Todos ficam na tabela `auditoria`
// com tabela='seguranca' (o helper registrarSeguranca de auth.js grava
// assim). Esta tela é só um VISUALIZADOR filtrado — não grava nada.
//
// TODAS as rotas aqui são exclusivas de administrador: a trava está na
// montagem (server.js: autenticar + exigirPerfil('admin')).
//
// A rota nomeada /csv vem ANTES de qualquer /:id (não há :id aqui, mas
// mantemos a convenção do projeto).
// =====================================================================

const express = require('express');
const db = require('./db');
const { enviarXlsxAoa, pediuXlsx } = require('./exportarPlanilha');

const router = express.Router();

// Ações de segurança que conhecemos, com rótulo amigável para o filtro/UI.
const ACOES = {
  login_ok: 'Login bem-sucedido',
  login_falho: 'Login falhou',
  logout: 'Logout',
  acesso_negado: 'Acesso negado (403)',
};

// Monta o WHERE comum a listagem/resumo/CSV a partir dos filtros da query.
// SEMPRE restringe a tabela='seguranca' — esta tela nunca mostra o resto da
// auditoria operacional (alterações de dados), só eventos de segurança.
function montarWhere(q) {
  const where = ["tabela = 'seguranca'"];
  const params = [];
  if (q.acao && ACOES[q.acao]) { where.push('acao = ?'); params.push(q.acao); }
  if (q.busca) {
    // Busca livre no e-mail, no IP de origem e no detalhe (caminho/motivo).
    where.push('(usuario_email LIKE ? OR origem LIKE ? OR dados_depois LIKE ?)');
    const t = `%${q.busca}%`;
    params.push(t, t, t);
  }
  if (q.de) { where.push('criado_em >= ?'); params.push(`${q.de} 00:00:00`); }
  if (q.ate) { where.push('criado_em <= ?'); params.push(`${q.ate} 23:59:59`); }
  return { sql: 'WHERE ' + where.join(' AND '), params };
}

function consultar(q, limitePadrao = 300) {
  const { sql, params } = montarWhere(q);
  const limite = Math.min(5000, Math.max(1, parseInt(q.limite, 10) || limitePadrao));
  const linhas = db.prepare(`
    SELECT id, usuario_id, usuario_email, acao, origem AS ip, dados_depois AS detalhe, criado_em
      FROM auditoria
      ${sql}
     ORDER BY criado_em DESC, id DESC
     LIMIT ${limite}
  `).all(...params);
  // O detalhe é JSON (ou null). Devolvemos já parseado para o front não precisar.
  return linhas.map((l) => {
    let detalhe = null;
    if (l.detalhe) { try { detalhe = JSON.parse(l.detalhe); } catch { detalhe = l.detalhe; } }
    return { ...l, detalhe, acaoRotulo: ACOES[l.acao] || l.acao };
  });
}

// --- Listagem + resumo -----------------------------------------------
router.get('/', (req, res) => {
  try {
    const linhas = consultar(req.query);
    const { sql, params } = montarWhere(req.query);
    // Resumo por ação no MESMO período filtrado (para os cartões do topo).
    const porAcao = db.prepare(`
      SELECT acao, COUNT(*) AS total FROM auditoria ${sql} GROUP BY acao
    `).all(...params);
    const resumo = { total: 0, login_ok: 0, login_falho: 0, logout: 0, acesso_negado: 0 };
    porAcao.forEach((r) => { resumo[r.acao] = r.total; resumo.total += r.total; });
    res.json({ linhas, resumo, acoes: ACOES, limitado: linhas.length >= (parseInt(req.query.limite, 10) || 300) });
  } catch (e) {
    console.error('[AUDITORIA-SEG] Falha ao listar:', e.message);
    res.status(500).json({ erro: 'Não consegui carregar a auditoria de segurança.' });
  }
});

// --- Exportação CSV (mesmo BOM/; do resto do sistema, abre no Excel) ---
router.get('/csv', (req, res) => {
  try {
    const linhas = consultar(req.query, 5000);
    // Anti CSV/Formula Injection: a trilha guarda texto hostil (ex.: o e-mail
    // tentado num login_falho). Blindagem em três camadas:
    //  1) achata CR/LF/Tab em espaço — impedem que o conteúdo quebre a linha ou
    //     a célula (e tiram o truque de "fórmula após nova linha");
    //  2) prefixa "'" quando começa com = + - @, para o Excel não tratar como
    //     fórmula;
    //  3) SEMPRE envolve em aspas (com "" escapado), independente do conteúdo.
    // Não altera o dado original gravado no banco — só a forma exportada.
    const esc = (v) => {
      if (v === null || v === undefined) return '""';
      let t = String(v).replace(/[\r\n\t]+/g, ' ');
      if (/^[=+\-@]/.test(t)) t = "'" + t;
      return '"' + t.replace(/"/g, '""') + '"';
    };
    const cab = ['Data/Hora', 'Evento', 'Usuário (e-mail)', 'IP de origem', 'Detalhe'];
    const valores = (l) => [
      l.criado_em,
      l.acaoRotulo,
      l.usuario_email,
      l.ip,
      l.detalhe ? (typeof l.detalhe === 'object' ? JSON.stringify(l.detalhe) : l.detalhe) : '',
    ];
    if (pediuXlsx(req)) {
      // No XLSX o SheetJS grava células como texto (não interpreta fórmula),
      // então não há risco de "formula injection" — usamos os valores crus.
      const aoa = [cab, ...linhas.map((l) => valores(l).map((v) => v ?? ''))];
      return enviarXlsxAoa(res, 'auditoria-seguranca.xlsx', aoa, 'Auditoria Seguranca');
    }
    const corpo = linhas.map((l) => valores(l).map(esc).join(';'));
    const csv = '﻿' + [cab.join(';'), ...corpo].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="auditoria-seguranca.csv"');
    res.send(csv);
  } catch (e) {
    console.error('[AUDITORIA-SEG] Falha ao exportar:', e.message);
    res.status(500).json({ erro: 'Não consegui gerar o CSV.' });
  }
});

module.exports = router;
