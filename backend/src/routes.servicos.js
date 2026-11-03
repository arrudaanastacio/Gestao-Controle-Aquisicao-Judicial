// =====================================================================
// routes.servicos.js — API da tela "Status dos Serviços".
//
// TODAS as rotas daqui são exclusivas de administrador (a trava está na
// montagem, em server.js: autenticar + exigirPerfil('admin')). É uma tela
// de operação do sistema, não de consulta de dados de compra.
//
// Rotas nomeadas (/logs, /catalogo) vêm ANTES das que usam :id, senão o
// Express casaria "logs" como se fosse o id de um serviço.
// =====================================================================

const express = require('express');
const db = require('./db');
const { enviarXlsxAoa, pediuXlsx } = require('./exportarPlanilha');
const reg = require('./registroServicos');

const router = express.Router();

const VERSAO = (() => {
  try { return require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'VERSION'), 'utf8').trim(); }
  catch { return null; }
})();

function agoraTexto() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// --- Painel principal -------------------------------------------------
router.get('/', (req, res) => {
  try {
    const servicos = reg.listar();
    res.json({
      servicos,
      indicadores: reg.indicadores(servicos),
      alertas: reg.alertas(servicos),
      recursos: reg.recursos(),
      versao: VERSAO,
      ambiente: process.env.NODE_ENV || 'development',
      atualizadoEm: agoraTexto(),
    });
  } catch (e) {
    console.error('[SERVIÇOS] Falha ao montar o painel:', e.message);
    res.status(500).json({ erro: 'Não consegui ler o status dos serviços.' });
  }
});

// --- Agendamento (quando cada serviço roda) ---------------------------
// Reúne, numa visão só, o horário/cadência de cada serviço do catálogo mais
// os dois agendamentos que não têm entrada própria no catálogo (Estoque de
// hora em hora e Listagem de Autores à tarde). Tudo derivado do .env.
router.get('/agendamentos', (req, res) => {
  try {
    const { proximaHoraUtil, msAteProxima } = require('./agendadorUtil');
    const p2 = (n) => String(n).padStart(2, '0');
    const isoLocal = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:00`;

    // 1) Serviços do catálogo — reaproveita agendamento, proximaExecucao e habilitado.
    const base = reg.listar().map((s) => ({
      nome: s.nome,
      categoria: s.categoria,
      tipo: s.tipo === 'vigia' ? 'continuo' : 'agendado',
      quando: s.agendamento,
      proxima: s.proximaExecucao || null,
      ativo: s.habilitado,
    }));

    // 2) Agendamentos extras (sem entrada no catálogo), lidos do .env.
    const extras = [];
    const ehAtivo = process.env.AGENDAR_ESTOQUE_HORARIO === 'true';
    const ehIni = Math.min(23, Math.max(0, parseInt(process.env.ESTOQUE_HORARIO_INICIO, 10) || 10));
    const ehFim = Math.min(23, Math.max(ehIni, parseInt(process.env.ESTOQUE_HORARIO_FIM, 10) || 17));
    extras.push({
      nome: 'Estoque de hora em hora (Oracle)',
      categoria: 'Integração',
      tipo: 'agendado',
      quando: `De hora em hora, ${p2(ehIni)}h–${p2(ehFim)}h (dias úteis)`,
      proxima: ehAtivo ? isoLocal(proximaHoraUtil(ehIni, ehFim)) : null,
      ativo: ehAtivo,
    });
    const avAtivo = process.env.AGENDAR_AUTORES_VESPERTINO === 'true';
    const avH = Math.min(23, Math.max(0, parseInt(process.env.AUTORES_VESPERTINO_HORA, 10) || 12));
    const avMraw = parseInt(process.env.AUTORES_VESPERTINO_MINUTO, 10);
    const avM = Math.min(59, Math.max(0, Number.isFinite(avMraw) ? avMraw : 15));
    extras.push({
      nome: 'Listagem de Autores (tarde)',
      categoria: 'Integração',
      tipo: 'agendado',
      quando: `Diário às ${p2(avH)}:${p2(avM)} (dias úteis)`,
      proxima: avAtivo ? isoLocal(new Date(Date.now() + msAteProxima(avH, avM))) : null,
      ativo: avAtivo,
    });

    res.json({ agendamentos: [...base, ...extras] });
  } catch (e) {
    console.error('[SERVIÇOS] Falha ao montar agendamentos:', e.message);
    res.status(500).json({ erro: 'Não consegui montar os agendamentos.' });
  }
});

// --- Logs (todas as execuções de todos os serviços) -------------------
// Filtros: nivel, servico, busca (texto na mensagem), de/ate (datas).
function consultarLogs(q) {
  const where = [];
  const params = [];
  if (q.nivel) { where.push('nivel = ?'); params.push(String(q.nivel).toUpperCase()); }
  if (q.servico) { where.push('servico = ?'); params.push(String(q.servico)); }
  if (q.busca) { where.push('(mensagem LIKE ? OR arquivo LIKE ?)'); params.push(`%${q.busca}%`, `%${q.busca}%`); }
  if (q.de) { where.push('iniciado_em >= ?'); params.push(`${q.de} 00:00:00`); }
  if (q.ate) { where.push('iniciado_em <= ?'); params.push(`${q.ate} 23:59:59`); }
  const limite = Math.min(2000, Math.max(1, parseInt(q.limite, 10) || 300));
  const sql = `
    SELECT id, servico, iniciado_em, duracao_ms, resultado, nivel, mensagem,
           registros, arquivo, origem, usuario_email
      FROM servico_execucoes
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY iniciado_em DESC, id DESC
     LIMIT ${limite}`;
  return db.prepare(sql).all(...params);
}

router.get('/logs', (req, res) => {
  try {
    const linhas = consultarLogs(req.query);
    const nomes = Object.fromEntries(reg.CATALOGO.map((s) => [s.id, s.nome]));
    res.json({ linhas: linhas.map((l) => ({ ...l, servicoNome: nomes[l.servico] || l.servico })) });
  } catch (e) {
    console.error('[SERVIÇOS] Falha ao consultar logs:', e.message);
    res.status(500).json({ erro: 'Não consegui consultar os logs.' });
  }
});

// Exportação dos logs em CSV (mesmo separador/BOM do resto do sistema, para
// abrir direto no Excel em português).
router.get('/logs/csv', (req, res) => {
  try {
    const linhas = consultarLogs({ ...req.query, limite: 5000 });
    const nomes = Object.fromEntries(reg.CATALOGO.map((s) => [s.id, s.nome]));
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const t = String(v).replace(/"/g, '""');
      return /[";\n]/.test(t) ? `"${t}"` : t;
    };
    const cab = ['Data/Hora', 'Serviço', 'Nível', 'Resultado', 'Duração (ms)', 'Registros', 'Origem', 'Usuário', 'Arquivo', 'Mensagem'];
    const valores = (l) => [
      l.iniciado_em, nomes[l.servico] || l.servico, l.nivel, l.resultado,
      l.duracao_ms, l.registros, l.origem, l.usuario_email, l.arquivo, l.mensagem,
    ];
    if (pediuXlsx(req)) {
      const aoa = [cab, ...linhas.map((l) => valores(l).map((v) => v ?? ''))];
      return enviarXlsxAoa(res, 'logs-servicos.xlsx', aoa, 'Logs Servicos');
    }
    const corpo = linhas.map((l) => valores(l).map(esc).join(';'));
    const csv = '﻿' + [cab.join(';'), ...corpo].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="logs-servicos.csv"');
    res.send(csv);
  } catch (e) {
    console.error('[SERVIÇOS] Falha ao exportar logs:', e.message);
    res.status(500).json({ erro: 'Não consegui gerar o CSV.' });
  }
});

// --- Detalhe de um serviço (painel lateral) ---------------------------
router.get('/:id/detalhe', (req, res) => {
  const s = reg.PORID.get(req.params.id);
  if (!s) return res.status(404).json({ erro: 'Serviço não encontrado.' });
  try {
    const linha = reg.linhaServico(s);
    const ultima = db.prepare(
      'SELECT * FROM servico_execucoes WHERE servico = ? ORDER BY iniciado_em DESC, id DESC LIMIT 1'
    ).get(s.id) || null;
    res.json({
      ...linha,
      podeExecutar: !!EXECUTORES[s.id],
      ultimaExecucaoCompleta: ultima,
      detalheErro: ultima && ultima.resultado === 'erro' ? ultima.detalhe : null,
      recursos: reg.recursos(),
      versao: VERSAO,
    });
  } catch (e) {
    console.error('[SERVIÇOS] Falha no detalhe:', e.message);
    res.status(500).json({ erro: 'Não consegui carregar o detalhe do serviço.' });
  }
});

// --- Histórico de execuções de um serviço -----------------------------
router.get('/:id/historico', (req, res) => {
  const s = reg.PORID.get(req.params.id);
  if (!s) return res.status(404).json({ erro: 'Serviço não encontrado.' });
  try {
    const linhas = consultarLogs({ ...req.query, servico: s.id, limite: req.query.limite || 200 });
    res.json({ servico: s.id, nome: s.nome, linhas });
  } catch (e) {
    console.error('[SERVIÇOS] Falha no histórico:', e.message);
    res.status(500).json({ erro: 'Não consegui carregar o histórico.' });
  }
});

// --- Executar agora ---------------------------------------------------
// Mapa id -> função que dispara o serviço. Carregamos com require preguiçoso
// para não criar dependência circular na subida do sistema.
const EXECUTORES = {
  estoqueTP: () => require('./vigiaEstoque').executarAgora(),
  autores: () => require('./vigiaAutores').executarAgora(),
  relatorioItens: () => require('./vigiaRelatorioItens').executarAgora(),
  atas: () => require('./vigiaAtas').executarAgora(),
  atasSiscoa: (email, id) => require('./vigiaAtasSiscoa').executarAgora(email, id),
  estoqueOD: () => require('./vigiaEstoqueOD').executarAgora(),
  distribuicao: () => require('./vigiaDistribuicao').executarAgora(),
  solicitacoesTP: (email, id) => require('./vigiaSolicitacoes').forcarImportacaoSolicitacoes(email, id),
  solicitacoesOD: (email) => require('./vigiaSolicitacoesOD').forcarImportacaoSolicitacoesOD(email),
  reservasUdtp: (email) => require('./vigiaReservas').importarHoje({ origem: 'manual', usuarioEmail: email }),
  oracleDiario: (email) => require('./agendadorOracleDiario').rodarCadeiaDiaria({ origem: 'manual', usuarioEmail: email }),
  backup: (email) => require('./backupBanco').rodarBackup({ origem: 'manual', usuarioEmail: email }),
};

router.post('/:id/executar', async (req, res) => {
  const s = reg.PORID.get(req.params.id);
  if (!s) return res.status(404).json({ erro: 'Serviço não encontrado.' });

  const executar = EXECUTORES[s.id];
  if (!executar) return res.status(400).json({ erro: 'Este serviço não pode ser disparado manualmente.' });

  if (!reg.habilitado(s)) {
    return res.status(409).json({
      erro: `${s.nome} está desativado na configuração (.env). Ligue o serviço antes de executá-lo.`,
    });
  }
  // Trava contra clique duplo: se já está rodando, não dispara de novo.
  if (reg.estaExecutando(s.id)) {
    return res.status(409).json({ erro: `${s.nome} já está em execução neste momento. Aguarde terminar.` });
  }

  const email = (req.usuario && req.usuario.email) || 'admin';
  try {
    const resultado = await executar(email, req.usuario && req.usuario.id);
    res.json({
      ok: true,
      mensagem: `${s.nome}: execução concluída.`,
      resultado: resultado || null,
      servico: reg.linhaServico(s),
    });
  } catch (e) {
    console.error(`[SERVIÇOS] Execução manual de ${s.id} falhou:`, e.message);
    // O próprio serviço já registrou a falha no histórico quando pôde; aqui
    // garantimos o registro dos casos que estouram antes disso (ex.: arquivo
    // não encontrado, que os "forçar" lançam direto).
    if (!reg.estaExecutando(s.id)) {
      reg.registrarExecucao(s.id, {
        resultado: 'erro',
        mensagem: e.message,
        detalhe: e.stack,
        origem: 'manual',
        usuarioEmail: email,
      });
    }
    res.status(500).json({ erro: e.message || 'Falha ao executar o serviço.' });
  }
});

module.exports = router;
