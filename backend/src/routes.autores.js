const express = require('express');
const XLSX = require('xlsx');
const multer = require('multer');
const db = require('./db');
const { autenticar, exigirPerfil } = require('./auth');

const router = express.Router();
router.use(autenticar);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

// Normaliza cabeçalho: minúsculas, sem acento, sem pontuação/underscore, espaços colapsados
function normalizar(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[._]/g, ' ')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// campo do banco -> nome(s) de cabeçalho aceitos (normalizados)
const MAPA = {
  unidade_dispensadora: ['unid dispensadora', 'unidade dispensadora'],
  unidade_organizacional: ['unid organizacional', 'unidade organizacional'],
  id_demanda: ['id demanda'],
  autor: ['autor'],
  idade: ['idade'],
  dt_nascimento: ['dt nascimento'],
  data_cadastro: ['data de cadastro'],
  protocolo: ['protocolo'],
  processo: ['processo'],
  status_demanda: ['status da demanda'],
  tipo_demanda: ['tipo da demanda'],
  porta_entrada: ['porta de entrada'],
  codigo_item: ['cod item', 'codigo item'],
  id_item: ['id item'],
  data_inclusao_od: ['data inclusao na od'],
  descricao_item: ['descricao do item'],
  qtde_consumo: ['qtdade de consumo', 'quantidade de consumo'],
  status_item: ['status item'],
  data_inativacao_item: ['data da inativacao item'],
  cobranca_judicial: ['cobranca judicial'],
  servicos_medicos: ['servicos medicos'],
  saude_mental: ['saude mental'],
  dispensacoes: ['dispensacoes'],
  periodicidade: ['periodicidade'],
  prazo: ['prazo'],
  dispensacoes_autorizadas: ['dispensacoes autorizadas'],
  intercambiaveis: ['intercambiaveis'],
  outras_demandas: ['outras demandas'],
  importados: ['importados'],
  categoria: ['categoria'],
  data_ultima_dispensacao: ['data ultima dispensacao'],
  data_ultimo_retorno: ['data ultimo retorno'],
  procurador_estado: ['procurador do estado'],
  cod_siafisico: ['cod siafisico', 'codigo siafisico'],
};
const CAMPOS = Object.keys(MAPA);

function texto(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

// Lê o CSV/planilha de autores e devolve as linhas mapeadas
function processarAutores(buffer) {
  // raw:true preserva texto original (datas, números BR) sem o SheetJS converter
  const wb = XLSX.read(buffer, { type: 'buffer', raw: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const brutas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });

  // acha a linha de cabeçalho (contém "autor" e "processo")
  let hc = -1;
  for (let i = 0; i < Math.min(brutas.length, 15); i++) {
    const ln = (brutas[i] || []).map(normalizar);
    if (ln.includes('autor') && ln.includes('processo')) { hc = i; break; }
  }
  if (hc === -1) throw new Error('Não reconheci o layout da Listagem de Autores (não achei as colunas "Autor" e "Processo").');

  const cab = (brutas[hc] || []).map(normalizar);
  const COL = {};
  for (const [campo, nomes] of Object.entries(MAPA)) COL[campo] = cab.findIndex((c) => nomes.includes(c));
  if (COL.autor === -1) throw new Error('Não encontrei a coluna "Autor".');

  const linhas = [];
  for (let i = hc + 1; i < brutas.length; i++) {
    const r = brutas[i];
    if (!r) continue;
    const autor = texto(r[COL.autor]);
    if (!autor) continue;
    const linha = {};
    for (const campo of CAMPOS) linha[campo] = COL[campo] >= 0 ? texto(r[COL[campo]]) : null;
    linhas.push(linha);
  }
  return linhas;
}

// Importa (substitui toda a listagem) a partir de um buffer de CSV/planilha
function importarAutoresDeBuffer(buffer, opcoes = {}) {
  const linhas = processarAutores(buffer);
  return importarAutoresDeLinhas(linhas, opcoes);
}

// Importa (substitui toda a listagem) a partir de linhas já mapeadas
// (objetos com as chaves de CAMPOS). Usado tanto pelo CSV quanto pelo
// atualizador via Oracle. Toda a lógica de gravação vive aqui.
function importarAutoresDeLinhas(linhas, opcoes = {}) {
  const dataReferencia = (opcoes.dataReferencia || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const usuarioEmail = opcoes.usuarioEmail || 'sistema';
  const usuarioId = opcoes.usuarioId ?? null;

  // Tudo numa única transação: com milhares de linhas, gravar uma a uma (cada
  // INSERT como commit separado) prendia o banco por minutos e colidia com
  // qualquer outra escrita concorrente ("database is locked"), mesmo com
  // busy_timeout. Em transação, o commit final é único e quase instantâneo.
  let resumo;
  db.exec('BEGIN');
  try {
    // Substitui a versão da mesma data (se reimportar no mesmo dia)
    db.prepare('DELETE FROM autores_itens WHERE data_referencia = ?').run(dataReferencia);

    const cols = ['data_referencia', ...CAMPOS];
    const stmt = db.prepare(
      `INSERT INTO autores_itens (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    );
    for (const l of linhas) {
      // undefined não pode ser vinculado no SQLite; normaliza para null.
      stmt.run(dataReferencia, ...CAMPOS.map((c) => (l[c] === undefined ? null : l[c])));
    }

    // Mantém só as 2 versões mais recentes (atual + anterior, para o comparativo)
    const datas = db.prepare('SELECT DISTINCT data_referencia FROM autores_itens WHERE data_referencia IS NOT NULL ORDER BY data_referencia DESC').all().map((r) => r.data_referencia);
    if (datas.length > 2) {
      const manter = datas.slice(0, 2);
      db.prepare(`DELETE FROM autores_itens WHERE data_referencia NOT IN (${manter.map(() => '?').join(',')})`).run(...manter);
    }

    // contagens úteis (só da versão atual)
    const totalAutores = db.prepare('SELECT COUNT(DISTINCT autor) c FROM autores_itens WHERE data_referencia = ?').get(dataReferencia).c;
    resumo = { dataReferencia, totalLinhas: linhas.length, totalAutores };

    db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
      .run('autores', opcoes.nomeArquivo || 'autores', usuarioEmail, JSON.stringify(resumo));
    db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
      .run(usuarioId, usuarioEmail, 'importar_autores', 'autores_itens', JSON.stringify(resumo));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return resumo;
}

// ---------- Listagem com filtros e paginação ----------
// Monta o WHERE (escopo + filtros) usado na listagem, no KPI e na exportação —
// assim o card de resumo SEMPRE bate com a tabela filtrada.
function montarFiltroAutores(query) {
  const cond = ['data_referencia = (SELECT MAX(data_referencia) FROM autores_itens)'];
  const params = [];
  if (query.escopoUnidade === 'geral') {
    cond.push("unidade_dispensadora NOT LIKE '%Tenente Pena%'");
  } else if (query.escopoUnidade === 'udtp') {
    // Listagem principal: SOMENTE a Tenente Pena (ex.: "UD 01 - Tenente Pena")
    cond.push("unidade_dispensadora LIKE '%Tenente Pena%'");
  }
  if (query.q) {
    cond.push('(autor LIKE ? OR processo LIKE ? OR protocolo LIKE ? OR descricao_item LIKE ? OR codigo_item LIKE ?)');
    const like = `%${query.q}%`;
    params.push(like, like, like, like, like);
  }
  if (query.unidade) { cond.push('unidade_dispensadora = ?'); params.push(query.unidade); }
  if (query.status_demanda) { cond.push('status_demanda = ?'); params.push(query.status_demanda); }
  if (query.status_item) { cond.push('status_item = ?'); params.push(query.status_item); }
  if (query.categoria) { cond.push('categoria = ?'); params.push(query.categoria); }
  return { where: `WHERE ${cond.join(' AND ')}`, params };
}

router.get('/', (req, res) => {
  const { page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 300);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const { where, params } = montarFiltroAutores(req.query);

  const total = db.prepare(`SELECT COUNT(*) c FROM autores_itens ${where}`).get(...params).c;
  // KPI de autores distintos AGORA respeita escopo + filtros (bate com a tabela)
  const totalAutores = db.prepare(`SELECT COUNT(DISTINCT autor) c FROM autores_itens ${where}`).get(...params).c;
  const itens = db.prepare(
    `SELECT * FROM autores_itens ${where} ORDER BY autor COLLATE NOCASE, descricao_item LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  const dataRef = db.prepare('SELECT MAX(data_referencia) v FROM autores_itens').get()?.v || null;

  res.json({ total, totalAutores, dataReferencia: dataRef, itens, page: Number(page), pageSize: limit });
});

// Exportação CSV (abre no Excel) respeitando escopo + filtros atuais.
router.get('/exportar', (req, res) => {
  const { where, params } = montarFiltroAutores(req.query);
  const linhas = db.prepare(
    `SELECT * FROM autores_itens ${where} ORDER BY autor COLLATE NOCASE, descricao_item`
  ).all(...params);

  const cols = [
    ['autor', 'Autor'], ['unidade_dispensadora', 'Unidade Dispensadora'],
    ['id_demanda', 'ID Demanda'], ['protocolo', 'Protocolo'], ['processo', 'Processo'],
    ['status_demanda', 'Status da Demanda'], ['tipo_demanda', 'Tipo da Demanda'],
    ['codigo_item', 'Cód. Item'], ['cod_siafisico', 'Cód. SIAFÍSICO'],
    ['descricao_item', 'Descrição do Item'], ['qtde_consumo', 'Qtde de Consumo'],
    ['prazo', 'Prazo'], ['periodicidade', 'Periodicidade'], ['categoria', 'Categoria'],
  ];
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const header = cols.map((c) => esc(c[1])).join(';');
  const corpo = linhas.map((l) => cols.map((c) => esc(l[c[0]])).join(';')).join('\r\n');
  const csv = '﻿' + header + '\r\n' + corpo;

  const escopo = req.query.escopoUnidade === 'geral' ? 'demais_unidades' : 'tenente_pena';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="autores_${escopo}.csv"`);
  res.send(csv);
});

// ---------- Valores distintos para os filtros ----------
router.get('/filtros', (req, res) => {
  const esc = req.query.escopoUnidade;
  const filtroUnidade = esc === 'geral' ? "AND unidade_dispensadora NOT LIKE '%Tenente Pena%'"
    : esc === 'udtp' ? "AND unidade_dispensadora LIKE '%Tenente Pena%'" : '';
  const distintos = (col) => db.prepare(
    `SELECT DISTINCT ${col} v FROM autores_itens WHERE data_referencia = (SELECT MAX(data_referencia) FROM autores_itens) ${filtroUnidade} AND ${col} IS NOT NULL AND ${col} <> '' ORDER BY v`
  ).all().map((r) => r.v);
  res.json({
    unidade: distintos('unidade_dispensadora'),
    status_demanda: distintos('status_demanda'),
    status_item: distintos('status_item'),
    categoria: distintos('categoria'),
  });
});

// ---------- Importação manual ----------
router.post('/importar/confirmar', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie o arquivo .csv da Listagem de Autores.' });
  try {
    const resumo = importarAutoresDeBuffer(req.file.buffer, {
      nomeArquivo: req.file.originalname,
      usuarioEmail: req.usuario.email,
      usuarioId: req.usuario.id,
    });
    res.json(resumo);
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

// ---------- Atualização via Oracle (SCODES) ----------
// Estado em memória do processo (dura enquanto o servidor estiver de pé).
const estadoOracle = { rodando: false, inicio: null, ultimoResumo: null, ultimoErro: null };

// Executa a atualização e ESPERA terminar (devolve a Promise). Usado pelo
// agendador diário, que dispara Autores só depois que Estoque terminar.
function executarAtualizacaoOracle(opcoes = {}) {
  if (estadoOracle.rodando) return Promise.resolve({ pulou: true, motivo: 'já em andamento' });
  const { atualizarAutoresViaOracle } = require('../oracle/sync-demandas');
  estadoOracle.rodando = true;
  estadoOracle.inicio = new Date().toISOString();
  estadoOracle.ultimoErro = null;

  return atualizarAutoresViaOracle(opcoes)
    .then((resumo) => {
      estadoOracle.ultimoResumo = { ...resumo, fim: new Date().toISOString() };
      console.log(`[SYNC AUTORES] Concluido via Oracle: ${resumo.totalLinhas} linhas / ${resumo.totalAutores} autores em ${Math.round((resumo.duracaoMs || 0) / 1000)}s.`);
      return resumo;
    })
    .catch((e) => {
      estadoOracle.ultimoErro = e.message;
      console.error('[SYNC AUTORES] Falha via Oracle:', e.message);
      require('./emailAlerta').enviarAlertaFalhaSincronizacao('Listagem de Autores', e.message);
      throw e;
    })
    .finally(() => { estadoOracle.rodando = false; });
}

// Dispara a atualização em segundo plano (não espera terminar). Usado pelo
// botão (rota abaixo) — não prende a resposta do navegador por ~9-34 min.
function iniciarAtualizacaoOracle(opcoes = {}) {
  if (estadoOracle.rodando) return { iniciado: false, jaRodando: true };
  executarAtualizacaoOracle(opcoes).catch(() => {}); // erro já registrado em estadoOracle
  return { iniciado: true, jaRodando: false };
}

// Botão "Atualizar via Oracle": dispara e responde na hora (não prende ~9 min).
router.post('/atualizar-oracle', exigirPerfil('admin'), (req, res) => {
  const r = iniciarAtualizacaoOracle({ usuarioEmail: req.usuario.email, usuarioId: req.usuario.id });
  if (!r.iniciado) {
    return res.status(409).json({ erro: 'Já existe uma atualização via Oracle em andamento.', ...estadoOracle });
  }
  res.json({ iniciado: true, inicio: estadoOracle.inicio });
});

// A tela consulta este status a cada poucos segundos para saber quando terminou.
router.get('/atualizar-oracle/status', (req, res) => {
  res.json(estadoOracle);
});

// ---------- Requisição de compra: busca de pacientes (autores distintos) ----------
router.get('/pacientes', (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json({ pacientes: [] });
  const like = `%${q.trim()}%`;
  const pacientes = db.prepare(`
    SELECT autor, COUNT(*) AS qtde_itens, MAX(processo) AS processo
    FROM autores_itens
    WHERE data_referencia = (SELECT MAX(data_referencia) FROM autores_itens)
      AND (autor LIKE ? OR processo LIKE ? OR protocolo LIKE ?)
    GROUP BY autor
    ORDER BY autor COLLATE NOCASE
    LIMIT 30
  `).all(like, like, like);
  res.json({ pacientes });
});

// ---------- Requisição de compra: itens de um paciente + situação de estoque ----------
router.get('/paciente', (req, res) => {
  const { autor } = req.query;
  if (!autor) return res.status(400).json({ erro: 'Informe o autor.' });

  const escTP = "(e.unidade IS NULL OR e.unidade LIKE '%Tenente Pena%')";
  const itens = db.prepare(`
    SELECT a.id_demanda, a.processo, a.protocolo, a.codigo_item, a.cod_siafisico,
           a.descricao_item, a.qtde_consumo, a.periodicidade, a.prazo, a.status_item, a.categoria,
           a.tipo_demanda, a.dispensacoes_autorizadas,
           (SELECT ri.catmat FROM relatorio_itens ri WHERE ri.codigo = a.codigo_item AND ri.catmat IS NOT NULL AND ri.catmat <> '' ORDER BY ri.data_referencia DESC LIMIT 1) AS catmat,
           (SELECT e.estoque   FROM estoque_itens e WHERE e.codigo_item = a.codigo_item AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1) AS estoque_atual,
           (SELECT e.autonomia FROM estoque_itens e WHERE e.codigo_item = a.codigo_item AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1) AS autonomia_atual
    FROM autores_itens a
    WHERE a.autor = ? AND a.data_referencia = (SELECT MAX(data_referencia) FROM autores_itens)
    ORDER BY a.descricao_item
  `).all(autor);

  const info = db.prepare(
    'SELECT autor, idade, dt_nascimento, unidade_dispensadora, procurador_estado, protocolo, processo, tipo_demanda FROM autores_itens WHERE autor = ? AND data_referencia = (SELECT MAX(data_referencia) FROM autores_itens) LIMIT 1'
  ).get(autor) || { autor };

  res.json({ info, itens });
});

// ---------- Requisições: salvar (gera ID de controle) ----------
router.post('/requisicoes', (req, res) => {
  const { autor, idade, unidade, procurador, sei, itens, protocolo, processo, tipo_demanda } = req.body || {};
  if (!autor || !Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ erro: 'Informe o paciente e ao menos um item.' });
  }

  const info = db.prepare(`
    INSERT INTO requisicoes (autor, idade, unidade, procurador, sei, operador_nome, operador_email, total_itens, protocolo, processo, tipo_demanda)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(autor, idade || null, unidade || null, procurador || null, sei || null,
    req.usuario.nome, req.usuario.email, itens.length, protocolo || null, processo || null, tipo_demanda || null);

  const id = info.lastInsertRowid;
  const ano = new Date().getFullYear();
  const codigoControle = `REQ-${ano}-${String(id).padStart(5, '0')}`;
  db.prepare('UPDATE requisicoes SET codigo_controle = ? WHERE id = ?').run(codigoControle, id);

  const stmt = db.prepare(`
    INSERT INTO requisicao_itens (requisicao_id, codigo_item, cod_siafisico, descricao_item, categoria, quantidade,
                                  tipo_demanda, qtde_consumo, prazo, periodicidade, dispensacoes_autorizadas, autonomia_compra, catmat)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const it of itens) {
    stmt.run(id, it.codigo_item || null, it.cod_siafisico || null, it.descricao_item || null, it.categoria || null, String(it.quantidade ?? ''),
      it.tipo_demanda || null, it.qtde_consumo != null ? String(it.qtde_consumo) : null, it.prazo || null, it.periodicidade || null, it.dispensacoes_autorizadas || null,
      it.autonomia_compra != null ? String(it.autonomia_compra) : null, it.catmat || null);
  }

  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.usuario.id, req.usuario.email, 'gerar_requisicao', 'requisicoes', id, JSON.stringify({ codigoControle, autor, sei, total: itens.length }));

  res.status(201).json({ id, codigo_controle: codigoControle });
});

// ---------- Requisições: listar com filtros (Relatório Primeiro Atendimento) ----------
router.get('/requisicoes', (req, res) => {
  const { paciente, sei, codigo_item, descricao, categoria, page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const cond = [];
  const params = [];
  if (paciente) { cond.push('r.autor LIKE ?'); params.push(`%${paciente}%`); }
  if (sei) { cond.push('r.sei LIKE ?'); params.push(`%${sei}%`); }
  // filtros por item: a requisição precisa conter um item que casa
  const itemCond = [];
  const itemParams = [];
  if (codigo_item) { itemCond.push('ri.codigo_item LIKE ?'); itemParams.push(`%${codigo_item}%`); }
  if (descricao) { itemCond.push('ri.descricao_item LIKE ?'); itemParams.push(`%${descricao}%`); }
  if (categoria) { itemCond.push('ri.categoria = ?'); itemParams.push(categoria); }
  if (itemCond.length) {
    cond.push(`EXISTS (SELECT 1 FROM requisicao_itens ri WHERE ri.requisicao_id = r.id AND ${itemCond.join(' AND ')})`);
    params.push(...itemParams);
  }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) c FROM requisicoes r ${where}`).get(...params).c;
  const requisicoes = db.prepare(`
    SELECT r.* FROM requisicoes r ${where} ORDER BY r.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ total, requisicoes, page: Number(page), pageSize: limit });
});

// ---------- Requisições: itens (visão por item + situação de estoque) ----------
router.get('/requisicoes/itens', (req, res) => {
  const { paciente, sei, codigo_item, descricao, categoria, page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const cond = [];
  const params = [];
  if (paciente) { cond.push('r.autor LIKE ?'); params.push(`%${paciente}%`); }
  if (sei) { cond.push('r.sei LIKE ?'); params.push(`%${sei}%`); }
  if (codigo_item) { cond.push('ri.codigo_item LIKE ?'); params.push(`%${codigo_item}%`); }
  if (descricao) { cond.push('ri.descricao_item LIKE ?'); params.push(`%${descricao}%`); }
  if (categoria) { cond.push('ri.categoria = ?'); params.push(categoria); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const escTP = "(e.unidade IS NULL OR e.unidade LIKE '%Tenente Pena%')";
  const total = db.prepare(`SELECT COUNT(*) c FROM requisicao_itens ri JOIN requisicoes r ON r.id = ri.requisicao_id ${where}`).get(...params).c;
  const itens = db.prepare(`
    SELECT ri.id, ri.requisicao_id, r.codigo_controle, r.autor, r.sei,
           ri.codigo_item, ri.descricao_item, ri.categoria,
           COALESCE((SELECT e.siafisico FROM estoque_itens e WHERE e.codigo_item = ri.codigo_item AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1), ri.cod_siafisico) AS siafisico,
           (SELECT e.estoque   FROM estoque_itens e WHERE e.codigo_item = ri.codigo_item AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1) AS estoque_atual,
           (SELECT e.autonomia FROM estoque_itens e WHERE e.codigo_item = ri.codigo_item AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1) AS autonomia_atual,
           ri.quantidade, ri.status_atendimento, ri.telegrama_enviado, ri.data_envio, ri.requisicao_gsnet,
           ri.telegrama_enviado_por, ri.telegrama_enviado_em
    FROM requisicao_itens ri
    JOIN requisicoes r ON r.id = ri.requisicao_id
    ${where}
    ORDER BY r.id DESC, ri.id
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ total, itens, page: Number(page), pageSize: limit });
});

// ---------- Requisições: atualizar o atendimento de um item ----------
router.put('/requisicoes/item/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM requisicao_itens WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ erro: 'Item não encontrado.' });

  const eAdmin = req.usuario.perfil === 'admin';
  const jaEnviado = item.telegrama_enviado === 'Sim';

  // Trava: depois que o telegrama foi marcado como "Sim", só um admin pode
  // mexer no item (corrigir um telegrama enviado por engano).
  if (jaEnviado && !eAdmin) {
    return res.status(403).json({ erro: 'Telegrama já enviado. Apenas um administrador pode alterar este item.' });
  }

  const { status_atendimento, telegrama_enviado, data_envio, requisicao_gsnet } = req.body || {};
  let status = status_atendimento ?? item.status_atendimento;
  const telegrama = telegrama_enviado ?? item.telegrama_enviado;
  let dataEnvio = data_envio !== undefined ? (data_envio || null) : item.data_envio;
  const gsnet = requisicao_gsnet !== undefined ? (requisicao_gsnet || null) : item.requisicao_gsnet;
  let enviadoPor = item.telegrama_enviado_por;
  let enviadoEm = item.telegrama_enviado_em;

  const agora = new Date();
  const hojeISO = agora.toISOString().slice(0, 10);

  if (telegrama === 'Sim' && !jaEnviado) {
    // Acabou de enviar o telegrama: finaliza, data de hoje e registra quem foi.
    status = 'Finalizado';
    if (!dataEnvio) dataEnvio = hojeISO;
    enviadoPor = req.usuario.nome || req.usuario.email;
    enviadoEm = agora.toISOString();
  } else if (telegrama !== 'Sim' && jaEnviado) {
    // Admin desfazendo um telegrama enviado por engano: limpa o registro.
    dataEnvio = data_envio !== undefined ? (data_envio || null) : null;
    enviadoPor = null;
    enviadoEm = null;
  }

  db.prepare('UPDATE requisicao_itens SET status_atendimento = ?, telegrama_enviado = ?, data_envio = ?, requisicao_gsnet = ?, telegrama_enviado_por = ?, telegrama_enviado_em = ? WHERE id = ?')
    .run(status, telegrama, dataEnvio, gsnet, enviadoPor, enviadoEm, item.id);

  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.usuario.id, req.usuario.email, 'atualizar_atendimento_item', 'requisicao_itens', item.id,
      JSON.stringify({ status_atendimento: status, telegrama_enviado: telegrama, data_envio: dataEnvio, telegrama_enviado_por: enviadoPor }));

  res.json({ ok: true });
});

// ---------- Requisições: categorias distintas (para o filtro) ----------
router.get('/requisicoes/categorias', (req, res) => {
  const cats = db.prepare(
    "SELECT DISTINCT categoria v FROM requisicao_itens WHERE categoria IS NOT NULL AND categoria <> '' ORDER BY v"
  ).all().map((r) => r.v);
  res.json({ categorias: cats });
});

// ---------- Requisições: editar (atualiza SEI e itens; mantém ID de controle) ----------
router.put('/requisicoes/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM requisicoes WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ erro: 'Requisição não encontrada.' });
  if (r.status === 'Cancelada') return res.status(400).json({ erro: 'Requisição cancelada não pode ser editada.' });

  const { sei, itens, protocolo, processo, tipo_demanda } = req.body || {};
  if (!Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ erro: 'Informe ao menos um item.' });
  }

  db.prepare("UPDATE requisicoes SET sei = ?, total_itens = ?, protocolo = ?, processo = ?, tipo_demanda = ?, atualizado_em = datetime('now') WHERE id = ?")
    .run(sei || null, itens.length, protocolo ?? r.protocolo, processo ?? r.processo, tipo_demanda ?? r.tipo_demanda, r.id);

  db.prepare('DELETE FROM requisicao_itens WHERE requisicao_id = ?').run(r.id);
  const stmt = db.prepare(`
    INSERT INTO requisicao_itens (requisicao_id, codigo_item, cod_siafisico, descricao_item, categoria, quantidade,
                                  tipo_demanda, qtde_consumo, prazo, periodicidade, dispensacoes_autorizadas, autonomia_compra, catmat)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const it of itens) {
    stmt.run(r.id, it.codigo_item || null, it.cod_siafisico || null, it.descricao_item || null, it.categoria || null, String(it.quantidade ?? ''),
      it.tipo_demanda || null, it.qtde_consumo != null ? String(it.qtde_consumo) : null, it.prazo || null, it.periodicidade || null, it.dispensacoes_autorizadas || null,
      it.autonomia_compra != null ? String(it.autonomia_compra) : null, it.catmat || null);
  }

  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.usuario.id, req.usuario.email, 'editar_requisicao', 'requisicoes', r.id, JSON.stringify({ sei, total: itens.length }));

  res.json({ id: r.id, codigo_controle: r.codigo_controle });
});

// ---------- Requisições: cancelar (mantém o histórico) ----------
router.put('/requisicoes/:id/cancelar', (req, res) => {
  const r = db.prepare('SELECT * FROM requisicoes WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ erro: 'Requisição não encontrada.' });
  if (r.status === 'Cancelada') return res.status(400).json({ erro: 'Requisição já está cancelada.' });

  db.prepare("UPDATE requisicoes SET status = 'Cancelada', cancelado_em = datetime('now'), cancelado_por = ? WHERE id = ?")
    .run(req.usuario.email, r.id);

  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_antes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.usuario.id, req.usuario.email, 'cancelar_requisicao', 'requisicoes', r.id, JSON.stringify({ codigo_controle: r.codigo_controle }));

  res.json({ ok: true });
});

// ---------- Requisições: detalhe (cabeçalho + itens) para reabrir/imprimir ----------
router.get('/requisicoes/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM requisicoes WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ erro: 'Requisição não encontrada.' });
  const itens = db.prepare('SELECT * FROM requisicao_itens WHERE requisicao_id = ? ORDER BY id').all(r.id);
  res.json({ requisicao: r, itens });
});

// ---------- Comparação entre a versão anterior e a atual ----------
router.get('/comparacao', (req, res) => {
  const datas = db.prepare(
    'SELECT DISTINCT data_referencia FROM autores_itens WHERE data_referencia IS NOT NULL ORDER BY data_referencia DESC LIMIT 2'
  ).all().map((r) => r.data_referencia);

  if (datas.length < 2) {
    return res.json({ temAnterior: false, atual: datas[0] || null });
  }

  const atual = datas[0];
  const anterior = datas[1];

  const carregar = (data) => db.prepare(
    `SELECT id_demanda, autor, protocolo, processo, tipo_demanda, codigo_item, descricao_item,
            qtde_consumo, categoria, data_cadastro, status_demanda, status_item
     FROM autores_itens WHERE data_referencia = ?`
  ).all(data);

  const linhasAtual = carregar(atual);
  const linhasAnt = carregar(anterior);

  // Agrupa por autor
  const porAutor = (linhas) => {
    const m = new Map();
    for (const l of linhas) {
      if (!m.has(l.autor)) m.set(l.autor, { autor: l.autor, processo: l.processo, itens: new Map(), linhas: [] });
      const g = m.get(l.autor);
      g.linhas.push(l);
      if (l.codigo_item) g.itens.set(l.codigo_item, l);
    }
    return m;
  };
  const mapAtual = porAutor(linhasAtual);
  const mapAnt = porAutor(linhasAnt);

  // Novos pacientes (no atual, não no anterior) — detalhado por item
  const novos = [];
  const novosAutores = [];
  for (const [autor, g] of mapAtual) {
    if (!mapAnt.has(autor)) {
      novosAutores.push(autor);
      for (const l of g.linhas) {
        novos.push({
          id_demanda: l.id_demanda || '—',
          autor: l.autor,
          protocolo: l.protocolo || '—',
          processo: l.processo || '—',
          tipo_demanda: l.tipo_demanda || '—',
          codigo_item: l.codigo_item || '—',
          descricao_item: l.descricao_item || '—',
          qtde_consumo: l.qtde_consumo || '—',
        });
      }
    }
  }
  const totalNovosPacientes = novosAutores.length;

  // Pacientes encerrados (no anterior, não no atual)
  const encerrados = [];
  for (const [autor, g] of mapAnt) {
    if (!mapAtual.has(autor)) {
      const ultimo = g.linhas[g.linhas.length - 1] || {};
      encerrados.push({ autor, processo: g.processo, ultimo_item: ultimo.descricao_item || '—' });
    }
  }

  // Alterações (autores em ambos, com diferença de itens/status)
  const alteracoes = [];
  for (const [autor, gA] of mapAtual) {
    const gP = mapAnt.get(autor);
    if (!gP) continue;
    // itens novos
    for (const [cod, it] of gA.itens) {
      if (!gP.itens.has(cod)) alteracoes.push({ autor, protocolo: it.protocolo || '—', codigo_item: cod, categoria: it.categoria || '—', qtde_consumo: it.qtde_consumo || '—', alteracao: 'Novo medicamento', detalhe: it.descricao_item || cod });
    }
    // itens removidos
    for (const [cod, it] of gP.itens) {
      if (!gA.itens.has(cod)) alteracoes.push({ autor, protocolo: it.protocolo || '—', codigo_item: cod, categoria: it.categoria || '—', qtde_consumo: it.qtde_consumo || '—', alteracao: 'Item removido', detalhe: it.descricao_item || cod });
    }
    // status alterado (mesmo item, status diferente)
    for (const [cod, itA] of gA.itens) {
      const itP = gP.itens.get(cod);
      if (!itP) continue;
      const mudouDemanda = (itA.status_demanda || '') !== (itP.status_demanda || '');
      const mudouItem = (itA.status_item || '') !== (itP.status_item || '');
      if (mudouDemanda || mudouItem) {
        const partes = [];
        if (mudouDemanda) partes.push(`demanda: "${itP.status_demanda || '—'}" → "${itA.status_demanda || '—'}"`);
        if (mudouItem) partes.push(`item: "${itP.status_item || '—'}" → "${itA.status_item || '—'}"`);
        alteracoes.push({ autor, protocolo: itA.protocolo || '—', codigo_item: cod, categoria: itA.categoria || '—', qtde_consumo: itA.qtde_consumo || '—', alteracao: 'Status alterado', detalhe: `${it_desc(itA)} — ${partes.join('; ')}` });
      }
    }
  }
  function it_desc(it) { return it.descricao_item || it.codigo_item || '—'; }

  novos.sort((a, b) => a.autor.localeCompare(b.autor));
  encerrados.sort((a, b) => a.autor.localeCompare(b.autor));
  alteracoes.sort((a, b) => a.autor.localeCompare(b.autor));

  res.json({
    temAnterior: true,
    anterior,
    atual,
    totalAnterior: mapAnt.size,
    totalAtual: mapAtual.size,
    totalNovosPacientes,
    novos,
    encerrados,
    alteracoes,
  });
});

module.exports = router;
module.exports.importarAutoresDeBuffer = importarAutoresDeBuffer;
module.exports.importarAutoresDeLinhas = importarAutoresDeLinhas;
module.exports.CAMPOS = CAMPOS;
module.exports.iniciarAtualizacaoOracle = iniciarAtualizacaoOracle;
module.exports.executarAtualizacaoOracle = executarAtualizacaoOracle;
