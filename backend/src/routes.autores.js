const express = require('express');
const XLSX = require('xlsx');
const multer = require('multer');
const db = require('./db');
const { autenticar, exigirPerfil } = require('./auth');
const { criarCalculadoraAta } = require('./ataSituacao');
const { CAIXAS, REGRA_VERSAO, criarCalculadoraCaixa, caixaPredominante } = require('./caixaAtendimento');

const router = express.Router();
router.use(autenticar);

// Caixa (Materiais/Medicamentos/Nutrição) que o usuário pode ver no Relatório
// de Primeiro Atendimento. Admin => todas. Não-admin: coluna usuarios.caixas_req
// (JSON). NULL/ausente => todas (mantém quem já usava). '' guardado numa
// requisição = "sem caixa" (só admin, na aba Todas).
function caixasDoUsuario(usuario) {
  if (!usuario || usuario.perfil === 'admin') return null; // null = todas + sem-caixa
  try {
    const raw = db.prepare('SELECT caixas_req FROM usuarios WHERE id = ?').get(usuario.id)?.caixas_req;
    if (raw == null || raw === '') return CAIXAS.slice(); // não definido => todas as 3
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((c) => CAIXAS.includes(c)) : CAIXAS.slice();
  } catch {
    return CAIXAS.slice();
  }
}

// Classificação de caixa das solicitações já gravadas. Recalcula TODAS quando a
// versão da regra muda (REGRA_VERSAO); caso contrário, só preenche as que ainda
// estão NULL. Guarda '' quando não cai em nenhuma caixa (para não recalcular à
// toa). A versão aplicada fica em configuracoes.caixa_regra_versao.
(function classificarCaixaRequisicoes() {
  try {
    const versaoAplicada = db.prepare("SELECT valor FROM configuracoes WHERE chave = 'caixa_regra_versao'").get()?.valor;
    const reclassificarTudo = versaoAplicada !== REGRA_VERSAO;
    const pend = db.prepare(reclassificarTudo ? 'SELECT id FROM requisicoes' : 'SELECT id FROM requisicoes WHERE caixa IS NULL').all();
    if (pend.length) {
      const calc = criarCalculadoraCaixa();
      const qItens = db.prepare('SELECT codigo_item FROM requisicao_itens WHERE requisicao_id = ?');
      const upd = db.prepare('UPDATE requisicoes SET caixa = ? WHERE id = ?');
      db.exec('BEGIN');
      for (const r of pend) {
        const cods = qItens.all(r.id).map((x) => x.codigo_item);
        upd.run(caixaPredominante(cods, calc) || '', r.id);
      }
      db.exec('COMMIT');
      console.log(`[CAIXA] ${reclassificarTudo ? 'Reclassificacao (regra v' + REGRA_VERSAO + ')' : 'Backfill'} em ${pend.length} requisicao(oes).`);
    }
    if (reclassificarTudo) {
      db.prepare("INSERT OR REPLACE INTO configuracoes (chave, valor) VALUES ('caixa_regra_versao', ?)").run(REGRA_VERSAO);
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('[CAIXA] Falha ao classificar caixas:', e.message);
  }
})();

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

    // protocolo_norm: protocolo sem o prefixo "N: " e sem espaços. É a chave
    // que liga o paciente à ruptura; gravada aqui (e não calculada na consulta)
    // porque normalizar 217 mil linhas a cada consulta inviabilizava a tela.
    const cols = ['data_referencia', ...CAMPOS, 'protocolo_norm'];
    const stmt = db.prepare(
      `INSERT INTO autores_itens (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    );
    const normProt = (v) => (v === null || v === undefined
      ? null
      : String(v).replace(/^N:\s*/i, '').replace(/\s/g, ''));
    for (const l of linhas) {
      // undefined não pode ser vinculado no SQLite; normaliza para null.
      stmt.run(dataReferencia, ...CAMPOS.map((c) => (l[c] === undefined ? null : l[c])),
        normProt(l.protocolo));
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
  } else if (query.escopoUnidade === 'importados') {
    // Listagem de Autores Importados: TODAS as unidades, só pacientes ATIVOS,
    // e só itens IMPORTADOS (flag do catálogo: relatorio_itens.importado = 'Sim').
    cond.push("status_demanda LIKE 'Demanda Ativa%'");
    cond.push("EXISTS (SELECT 1 FROM relatorio_itens ri WHERE ri.codigo = autores_itens.codigo_item AND ri.importado = 'Sim')");
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
  // Hora da última importação (mesmo padrão do Estoque): vem do log de importacoes.
  const imp = db.prepare("SELECT datetime(criado_em,'localtime') q FROM importacoes WHERE tipo='autores' ORDER BY criado_em DESC LIMIT 1").get();
  const dataImportacao = imp ? imp.q : null;

  res.json({ total, totalAutores, dataReferencia: dataRef, dataImportacao, itens, page: Number(page), pageSize: limit });
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
    : esc === 'udtp' ? "AND unidade_dispensadora LIKE '%Tenente Pena%'"
      : esc === 'importados' ? "AND status_demanda LIKE 'Demanda Ativa%' AND EXISTS (SELECT 1 FROM relatorio_itens ri WHERE ri.codigo = autores_itens.codigo_item AND ri.importado = 'Sim')"
        : '';
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

// ---------- Estoque da UNIDADE de uma linha da Listagem de Autores ----------
// Para o modal "Ver": demanda, consumo, estoque e autonomia daquele item NA
// UNIDADE DISPENSADORA daquela linha (não é só a Tenente Pena — na listagem
// das demais unidades cada linha tem a sua). Casa estoque_itens.unidade com
// autores_itens.unidade_dispensadora (mesmo texto, ex.: "UD 01 - Tenente Pena").
router.get('/estoque-unidade', (req, res) => {
  const { codigo_item, unidade } = req.query;
  if (!codigo_item) return res.status(400).json({ erro: 'Informe o codigo_item.' });

  // Se a unidade não veio, cai na Tenente Pena (comportamento da tela principal).
  const temUnidade = unidade && String(unidade).trim() !== '';
  const cond = temUnidade
    ? 'e.codigo_item = ? AND e.unidade = ?'
    : "e.codigo_item = ? AND (e.unidade IS NULL OR e.unidade LIKE '%Tenente Pena%')";
  const params = temUnidade ? [codigo_item, unidade] : [codigo_item];

  const linha = db.prepare(`
    SELECT e.demandas AS demanda, e.consumo_mensal_total AS consumo,
           e.estoque, e.autonomia, e.unidade, e.data_referencia
      FROM estoque_itens e
     WHERE ${cond}
     ORDER BY e.data_referencia DESC
     LIMIT 1
  `).get(...params);

  // Etiquetas de programa/subcategoria do item (mesma fonte do Estoque):
  // subcategoria + Dose Certa/Inex de item_classificacao, Outras Demandas de
  // relatorio_itens. Independem da unidade — dependem só do código do item.
  const clas = db.prepare(`
    SELECT (SELECT ri.outras_demandas FROM relatorio_itens ri WHERE ri.codigo = ? ORDER BY ri.data_referencia DESC LIMIT 1) AS prog_outras_demandas,
           (SELECT ic.dose_certa   FROM item_classificacao ic WHERE ic.codigo_item = ?) AS prog_dose_certa,
           (SELECT ic.inex         FROM item_classificacao ic WHERE ic.codigo_item = ?) AS prog_inex,
           (SELECT ic.subcategoria FROM item_classificacao ic WHERE ic.codigo_item = ?) AS subcategoria
  `).get(codigo_item, codigo_item, codigo_item, codigo_item) || {};

  const base = linha || { demanda: null, consumo: null, estoque: null, autonomia: null, unidade: temUnidade ? unidade : null, data_referencia: null, semDados: true };
  res.json({ ...base, ...clas });
});

// ---------- Relatório de Compras Importados ----------
// Alimentado pelo botão "+" da Listagem de Autores Importados: captura a linha
// do autor (autor × item) + os dados do modal. Colunas editáveis
// (quantidade_solicitada, sei, status) são preenchidas na própria tela.
const CAMPOS_COMPRA_IMP = [
  'codigo_item', 'cod_siafisico', 'descricao_item', 'categoria', 'autor',
  'unidade_dispensadora', 'id_demanda', 'protocolo', 'processo', 'status_demanda',
  'tipo_demanda', 'qtde_consumo', 'prazo', 'periodicidade',
  'data_ultima_dispensacao', 'data_ultimo_retorno',
];

router.get('/compras-importados', (req, res) => {
  const itens = db.prepare('SELECT * FROM compras_importados ORDER BY id DESC').all();
  res.json({ total: itens.length, itens });
});

router.post('/compras-importados', (req, res) => {
  const b = req.body || {};
  if (!b.autor || !b.codigo_item) return res.status(400).json({ erro: 'Informe ao menos o autor e o item.' });

  // Já existe uma solicitação para este paciente/item? Importados são
  // recorrentes, mas a nova aquisição depende do STATUS da última:
  //   - Finalizado / Cancelado => processo encerrado; libera nova aquisição
  //     (recorrência) pela Listagem, com confirmação.
  //   - Deserto/Fracassado     => negativa; refazer pelo botão "+ Nova" do Relatório.
  //   - EM ABERTO (Solicitado, Embarque, Instrução Processual, Pendência,
  //     Sem cotação, e demais) => bloqueia até encerrar (evita duplicar solicitação aberta).
  // forcar=true (confirmação do usuário) cria o novo ciclo.
  const anteriores = db.prepare(
    "SELECT COUNT(*) n, MAX(COALESCE(ciclo,1)) maxc FROM compras_importados WHERE autor = ? AND codigo_item = ? AND IFNULL(protocolo,'') = IFNULL(?,'')"
  ).get(b.autor, b.codigo_item, b.protocolo || null);
  const forcar = b.forcar === true || b.forcar === 'true' || b.forcar === 1;
  if (anteriores.n > 0 && !forcar) {
    const ultimo = db.prepare(
      "SELECT status FROM compras_importados WHERE autor = ? AND codigo_item = ? AND IFNULL(protocolo,'') = IFNULL(?,'') ORDER BY COALESCE(ciclo,1) DESC, id DESC LIMIT 1"
    ).get(b.autor, b.codigo_item, b.protocolo || null);
    const st = (ultimo && ultimo.status) || 'Solicitado';
    if (st === 'Finalizado' || st === 'Cancelado') {
      return res.status(409).json({ erro: `Última aquisição encerrada (${st}).`, jaExiste: true, podeNova: true, motivo: 'encerrado', statusAnterior: st, ciclos: anteriores.n });
    }
    if (st === 'Deserto' || st === 'Fracassado') {
      return res.status(409).json({ erro: `Há uma solicitação com status "${st}". Refaça a aquisição pelo botão "➕ Nova" no Relatório de Compras Importados.`, jaExiste: true, podeNova: false, motivo: 'negativo' });
    }
    return res.status(409).json({ erro: `Este paciente/item já tem uma solicitação em aberto (${st}) no Relatório de Compras Importados. Só é possível uma nova aquisição após Cancelado ou Finalizado.`, jaExiste: true, podeNova: false, motivo: 'aberto' });
  }
  const ciclo = anteriores.n > 0 ? (anteriores.maxc + 1) : 1;

  // CATMAT e Valor Médio Unitário vêm do Relatório de Itens (foto mais recente).
  const cat = db.prepare('SELECT catmat, valor_medio_unitario FROM relatorio_itens WHERE codigo = ? ORDER BY data_referencia DESC LIMIT 1').get(b.codigo_item) || {};
  const catmat = (cat.catmat != null && String(cat.catmat).trim() !== '') ? String(cat.catmat).trim() : null;
  const valorMedio = (cat.valor_medio_unitario != null && String(cat.valor_medio_unitario).trim() !== '') ? String(cat.valor_medio_unitario) : null;

  const cols = [...CAMPOS_COMPRA_IMP, 'catmat', 'valor_medio_unitario', 'ciclo', 'criado_por'];
  const stmt = db.prepare(`INSERT INTO compras_importados (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  const info = stmt.run(...CAMPOS_COMPRA_IMP.map((c) => (b[c] != null && b[c] !== '' ? String(b[c]) : null)), catmat, valorMedio, ciclo, req.usuario.email);
  db.prepare("UPDATE compras_importados SET status_desde = datetime('now','localtime') WHERE id = ?").run(info.lastInsertRowid);
  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.usuario.id, req.usuario.email, 'add_compra_importado', 'compras_importados', info.lastInsertRowid, JSON.stringify({ autor: b.autor, codigo_item: b.codigo_item }));
  res.status(201).json({ id: info.lastInsertRowid });
});

// ---- Modo "Por Item" da Listagem de Autores Importados ----
// Busca de ITENS (distintos) do escopo importados que casam com o termo, com a
// contagem de pacientes ativos de cada um. Alimenta o seletor de item do modal.
router.get('/importados/itens', (req, res) => {
  const { where, params } = montarFiltroAutores({ escopoUnidade: 'importados', q: req.query.q || undefined });
  const itens = db.prepare(`
    SELECT codigo_item,
           MAX(descricao_item) AS descricao_item,
           MAX(cod_siafisico) AS cod_siafisico,
           MAX(categoria) AS categoria,
           COUNT(*) AS n_pacientes
      FROM autores_itens ${where}
     GROUP BY codigo_item
     ORDER BY descricao_item COLLATE NOCASE
     LIMIT 50
  `).all(...params);
  res.json({ itens });
});

// PACIENTES ativos de UM item (escopo importados), anotados com se já constam
// no Relatório de Compras Importados e se cabe nova aquisição.
router.get('/importados/por-item', (req, res) => {
  const codigo = String(req.query.codigo || '').trim();
  if (!codigo) return res.status(400).json({ erro: 'Informe o código do item.' });
  const { where, params } = montarFiltroAutores({ escopoUnidade: 'importados' });
  const pacientes = db.prepare(
    `SELECT * FROM autores_itens ${where} AND codigo_item = ? ORDER BY autor COLLATE NOCASE`
  ).all(...params, codigo);

  // Última situação por (autor, protocolo) no Compras Importados deste item.
  const compras = db.prepare(
    'SELECT autor, protocolo, status FROM compras_importados WHERE codigo_item = ? ORDER BY COALESCE(ciclo,1) DESC, id DESC'
  ).all(codigo);
  const ultimo = new Map();
  for (const c of compras) {
    const k = (c.autor || '') + '|' + (c.protocolo || '');
    if (!ultimo.has(k)) ultimo.set(k, c.status || 'Solicitado');
  }
  const itens = pacientes.map((p) => {
    const st = ultimo.get((p.autor || '') + '|' + (p.protocolo || ''));
    const jaExiste = st !== undefined;
    const podeNova = jaExiste && (st === 'Finalizado' || st === 'Cancelado');
    return { ...p, ja_existe: jaExiste, status_anterior: st || null, pode_nova: podeNova };
  });
  const ref = pacientes[0] || {};
  // Valor médio unitário do item (foto mais recente do Relatório de Itens) —
  // igual ao que o POST usa; serve para pré-preencher a etapa de valores.
  const cat = db.prepare('SELECT valor_medio_unitario FROM relatorio_itens WHERE codigo = ? ORDER BY data_referencia DESC LIMIT 1').get(codigo) || {};
  const valorMedio = (cat.valor_medio_unitario != null && String(cat.valor_medio_unitario).trim() !== '') ? String(cat.valor_medio_unitario) : null;
  res.json({
    codigo_item: codigo,
    descricao_item: ref.descricao_item || null,
    cod_siafisico: ref.cod_siafisico || null,
    valor_medio_unitario: valorMedio,
    total: itens.length,
    itens,
  });
});

router.put('/compras-importados/:id', (req, res) => {
  const item = db.prepare('SELECT id, status FROM compras_importados WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ erro: 'Registro não encontrado.' });
  const b = req.body || {};
  const editaveis = [
    'quantidade_solicitada', 'sei', 'req_gsnet', 'valor_medio_unitario',
    'solicitacao_drs_sei', 'data_solicitacao', 'numero_empenho', 'numero_recibo',
    'data_entrega', 'status', 'justificativa', 'data_inativacao', 'data_embarque',
    'numero_fatura_gsnet', 'data_fatura',
    'motivo_pendencia', 'lote', 'validade', 'num_tentativas', 'tentativas_datas',
    'telegrama_enviado', 'data_envio_telegrama',
    'num_doc_entrada_gsnet', 'data_entrada',
  ];
  const sets = [];
  const vals = [];
  for (const c of editaveis) {
    if (c in b) { sets.push(`${c} = ?`); vals.push(b[c] === '' || b[c] == null ? null : String(b[c])); }
  }
  if (!sets.length) return res.json({ ok: true });
  sets.push("atualizado_em = datetime('now','localtime')");
  // Se o status mudou, registra "status_desde = agora" (base dos alertas).
  if ('status' in b && String(b.status || '') !== String(item.status || '')) {
    sets.push("status_desde = datetime('now','localtime')");
  }
  db.prepare(`UPDATE compras_importados SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
  res.json({ ok: true });
});

router.delete('/compras-importados/:id', (req, res) => {
  const item = db.prepare('SELECT id FROM compras_importados WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ erro: 'Registro não encontrado.' });
  db.prepare('DELETE FROM compras_importados WHERE id = ?').run(req.params.id);
  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id) VALUES (?, ?, ?, ?, ?)')
    .run(req.usuario.id, req.usuario.email, 'remover_compra_importado', 'compras_importados', req.params.id);
  res.json({ ok: true });
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
           (SELECT ic.subcategoria FROM item_classificacao ic WHERE ic.codigo_item = a.codigo_item) AS subcategoria,
           (SELECT ri.catmat FROM relatorio_itens ri WHERE ri.codigo = a.codigo_item AND ri.catmat IS NOT NULL AND ri.catmat <> '' ORDER BY ri.data_referencia DESC LIMIT 1) AS catmat,
           (SELECT e.estoque   FROM estoque_itens e WHERE e.codigo_item = a.codigo_item AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1) AS estoque_atual,
           (SELECT e.autonomia FROM estoque_itens e WHERE e.codigo_item = a.codigo_item AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1) AS autonomia_atual,
           (SELECT e.demandas  FROM estoque_itens e WHERE e.codigo_item = a.codigo_item AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1) AS demanda_atual,
           (SELECT NULLIF(e.valor_medio_unitario,0) FROM estoque_itens e WHERE e.codigo_item = a.codigo_item AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1) AS valor_medio
    FROM autores_itens a
    WHERE a.autor = ? AND a.data_referencia = (SELECT MAX(data_referencia) FROM autores_itens)
    ORDER BY a.descricao_item
  `).all(autor);

  const info = db.prepare(
    'SELECT autor, idade, dt_nascimento, unidade_dispensadora, procurador_estado, protocolo, processo, tipo_demanda FROM autores_itens WHERE autor = ? AND data_referencia = (SELECT MAX(data_referencia) FROM autores_itens) LIMIT 1'
  ).get(autor) || { autor };

  // Etiqueta de ATA (cruza siafísico × atas vigentes × marca do estoque).
  const calcAta = criarCalculadoraAta();
  for (const it of itens) it.ata = calcAta(it.codigo_item, it.cod_siafisico);

  res.json({ info, itens });
});

// ---------- Ação coletiva: buscar itens (medicamentos) da base de autores ----------
// Lista itens distintos (por código) presentes na demanda da Tenente Pena,
// para o operador escolher UM medicamento e cadastrar vários pacientes.
router.get('/itens-busca', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ itens: [] });
  const like = `%${q}%`;
  const itens = db.prepare(`
    SELECT a.codigo_item, a.descricao_item,
           MAX(a.cod_siafisico) AS cod_siafisico, MAX(a.categoria) AS categoria,
           (SELECT ic.subcategoria FROM item_classificacao ic WHERE ic.codigo_item = a.codigo_item) AS subcategoria,
           COUNT(DISTINCT a.autor) AS n_pacientes
    FROM autores_itens a
    WHERE a.data_referencia = (SELECT MAX(data_referencia) FROM autores_itens)
      AND (a.unidade_dispensadora IS NULL OR a.unidade_dispensadora LIKE '%Tenente Pena%')
      AND (a.descricao_item LIKE ? OR a.codigo_item LIKE ? OR a.cod_siafisico LIKE ?)
    GROUP BY a.codigo_item, a.descricao_item
    ORDER BY a.descricao_item
    LIMIT 30
  `).all(like, like, like);
  res.json({ itens });
});

// ---------- Solicitação coletiva: pacientes que têm QUALQUER um dos itens ----------
// Recebe uma lista de códigos e devolve os pacientes (Tenente Pena) agrupados,
// cada um com os itens (dos escolhidos) que ele realmente tem na demanda.
router.get('/itens-pacientes', (req, res) => {
  const codigos = String(req.query.codigos || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!codigos.length) return res.status(400).json({ erro: 'Informe ao menos um código de item.' });
  const escTP = "(e.unidade IS NULL OR e.unidade LIKE '%Tenente Pena%')";
  const ph = codigos.map(() => '?').join(',');
  const linhas = db.prepare(`
    SELECT a.autor, a.idade, a.unidade_dispensadora, a.procurador_estado,
           a.protocolo, a.processo, a.tipo_demanda,
           a.codigo_item, a.cod_siafisico, a.descricao_item, a.categoria,
           a.qtde_consumo, a.prazo, a.periodicidade, a.dispensacoes_autorizadas,
           (SELECT ri.catmat FROM relatorio_itens ri WHERE ri.codigo = a.codigo_item AND ri.catmat IS NOT NULL AND ri.catmat <> '' ORDER BY ri.data_referencia DESC LIMIT 1) AS catmat,
           (SELECT e.estoque   FROM estoque_itens e WHERE e.codigo_item = a.codigo_item AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1) AS estoque_atual,
           (SELECT e.autonomia FROM estoque_itens e WHERE e.codigo_item = a.codigo_item AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1) AS autonomia_atual,
           (SELECT e.demandas  FROM estoque_itens e WHERE e.codigo_item = a.codigo_item AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1) AS demanda_atual,
           (SELECT NULLIF(e.valor_medio_unitario,0) FROM estoque_itens e WHERE e.codigo_item = a.codigo_item AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1) AS valor_medio
    FROM autores_itens a
    WHERE a.codigo_item IN (${ph})
      AND a.data_referencia = (SELECT MAX(data_referencia) FROM autores_itens)
      AND (a.unidade_dispensadora IS NULL OR a.unidade_dispensadora LIKE '%Tenente Pena%')
    ORDER BY a.autor, a.descricao_item
  `).all(...codigos);

  // Agrupa por paciente (autor), acumulando os itens de cada um.
  const calcAta = criarCalculadoraAta();
  const mapa = new Map();
  for (const r of linhas) {
    if (!mapa.has(r.autor)) {
      mapa.set(r.autor, {
        autor: r.autor, idade: r.idade, unidade_dispensadora: r.unidade_dispensadora,
        procurador_estado: r.procurador_estado, protocolo: r.protocolo, processo: r.processo,
        tipo_demanda: r.tipo_demanda, itens: [],
      });
    }
    mapa.get(r.autor).itens.push({
      codigo_item: r.codigo_item, cod_siafisico: r.cod_siafisico, descricao_item: r.descricao_item,
      categoria: r.categoria, catmat: r.catmat, qtde_consumo: r.qtde_consumo, prazo: r.prazo,
      periodicidade: r.periodicidade, dispensacoes_autorizadas: r.dispensacoes_autorizadas,
      estoque_atual: r.estoque_atual, autonomia_atual: r.autonomia_atual,
      demanda_atual: r.demanda_atual, valor_medio: r.valor_medio,
      ata: calcAta(r.codigo_item, r.cod_siafisico),
    });
  }
  res.json({ pacientes: [...mapa.values()] });
});

// ---------- Solicitação coletiva: gera UMA requisição consolidada ----------
// Um único controle, vários pacientes e itens somados por medicamento.
// Status/telegrama é ÚNICO (nível da requisição).
router.post('/requisicoes/coletiva', (req, res) => {
  const { sei, pacientes } = req.body || {};
  const lista = (Array.isArray(pacientes) ? pacientes : []).filter((p) => Array.isArray(p.itens) && p.itens.length);
  if (!lista.length) return res.status(400).json({ erro: 'Informe ao menos um paciente com item marcado.' });

  const num = (v) => { const n = parseFloat(String(v ?? '').replace(/\./g, '').replace(',', '.')); return isNaN(n) ? 0 : n; };

  // Consolida os itens por código, somando quantidade e consumo, e guardando o
  // detalhe por paciente.
  const mapaItem = new Map();
  for (const p of lista) {
    for (const it of p.itens) {
      const k = it.codigo_item;
      if (!mapaItem.has(k)) {
        mapaItem.set(k, {
          codigo_item: it.codigo_item, cod_siafisico: it.cod_siafisico, descricao_item: it.descricao_item,
          categoria: it.categoria, catmat: it.catmat, quantidade: 0, qtde_consumo: 0, detalhe: [],
          situacao_ata: it.situacao_ata || null, escolha_ata: it.escolha_ata || null,
          valor_unitario: it.valor_unitario != null ? it.valor_unitario : null,
        });
      }
      const agg = mapaItem.get(k);
      agg.quantidade += num(it.quantidade);
      agg.qtde_consumo += num(it.qtde_consumo);
      agg.detalhe.push({ autor: p.autor, qtde_consumo: it.qtde_consumo, autonomia_compra: it.autonomia_compra, quantidade: it.quantidade });
    }
  }
  const itensConsolidados = [...mapaItem.values()];
  const pacientesInfo = lista.map((p) => ({ autor: p.autor, protocolo: p.protocolo, processo: p.processo, tipo_demanda: p.tipo_demanda }));

  const caixaReq = caixaPredominante(itensConsolidados.map((i) => i.codigo_item), criarCalculadoraCaixa()) || '';

  db.exec('BEGIN');
  let id, codigoControle;
  try {
    const primeiro = lista[0];
    const info = db.prepare(`
      INSERT INTO requisicoes (autor, unidade, sei, operador_nome, operador_email, total_itens,
                               coletiva, total_pacientes, pacientes_json, status_atendimento, telegrama_enviado, caixa)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'Solicitado', 'Não', ?)`).run(
      primeiro.autor, primeiro.unidade_dispensadora || null, sei || null, req.usuario.nome, req.usuario.email,
      itensConsolidados.length, lista.length, JSON.stringify(pacientesInfo), caixaReq);
    id = info.lastInsertRowid;
    codigoControle = `REQ-${new Date().getFullYear()}-${String(id).padStart(5, '0')}`;
    db.prepare('UPDATE requisicoes SET codigo_controle = ? WHERE id = ?').run(codigoControle, id);

    const insItem = db.prepare(`
      INSERT INTO requisicao_itens (requisicao_id, codigo_item, cod_siafisico, descricao_item, categoria, quantidade,
                                    qtde_consumo, catmat, detalhe_json, n_pacientes, situacao_ata, escolha_ata, valor_unitario)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const it of itensConsolidados) {
      insItem.run(id, it.codigo_item || null, it.cod_siafisico || null, it.descricao_item || null, it.categoria || null,
        String(+it.quantidade.toFixed(2)), String(+it.qtde_consumo.toFixed(2)), it.catmat || null,
        JSON.stringify(it.detalhe), it.detalhe.length, it.situacao_ata || null, it.escolha_ata || null,
        it.valor_unitario != null ? String(it.valor_unitario) : null);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ erro: 'Falha ao gerar a solicitação coletiva: ' + e.message });
  }

  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.usuario.id, req.usuario.email, 'gerar_solicitacao_coletiva', 'requisicoes', id,
      JSON.stringify({ codigo_controle: codigoControle, sei, pacientes: lista.length, itens: itensConsolidados.length }));

  res.status(201).json({ id, codigo_controle: codigoControle, totalPacientes: lista.length, totalItens: itensConsolidados.length });
});

// ---------- Requisições: salvar (gera ID de controle) ----------
router.post('/requisicoes', (req, res) => {
  const { autor, idade, unidade, procurador, sei, itens, protocolo, processo, tipo_demanda } = req.body || {};
  if (!autor || !Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ erro: 'Informe o paciente e ao menos um item.' });
  }

  const caixaReq = caixaPredominante(itens.map((i) => i.codigo_item), criarCalculadoraCaixa()) || '';
  const info = db.prepare(`
    INSERT INTO requisicoes (autor, idade, unidade, procurador, sei, operador_nome, operador_email, total_itens, protocolo, processo, tipo_demanda, caixa)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(autor, idade || null, unidade || null, procurador || null, sei || null,
    req.usuario.nome, req.usuario.email, itens.length, protocolo || null, processo || null, tipo_demanda || null, caixaReq);

  const id = info.lastInsertRowid;
  const ano = new Date().getFullYear();
  const codigoControle = `REQ-${ano}-${String(id).padStart(5, '0')}`;
  db.prepare('UPDATE requisicoes SET codigo_controle = ? WHERE id = ?').run(codigoControle, id);

  const stmt = db.prepare(`
    INSERT INTO requisicao_itens (requisicao_id, codigo_item, cod_siafisico, descricao_item, categoria, quantidade,
                                  tipo_demanda, qtde_consumo, prazo, periodicidade, dispensacoes_autorizadas, autonomia_compra, catmat,
                                  situacao_ata, escolha_ata, valor_unitario)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const it of itens) {
    stmt.run(id, it.codigo_item || null, it.cod_siafisico || null, it.descricao_item || null, it.categoria || null, String(it.quantidade ?? ''),
      it.tipo_demanda || null, it.qtde_consumo != null ? String(it.qtde_consumo) : null, it.prazo || null, it.periodicidade || null, it.dispensacoes_autorizadas || null,
      it.autonomia_compra != null ? String(it.autonomia_compra) : null, it.catmat || null,
      it.situacao_ata || null, it.escolha_ata || null, it.valor_unitario != null ? String(it.valor_unitario) : null);
  }

  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.usuario.id, req.usuario.email, 'gerar_requisicao', 'requisicoes', id, JSON.stringify({ codigoControle, autor, sei, total: itens.length }));

  res.status(201).json({ id, codigo_controle: codigoControle });
});

// ---------- Requisições: listar com filtros (Relatório Primeiro Atendimento) ----------
router.get('/requisicoes', (req, res) => {
  const { paciente, sei, codigo_item, descricao, categoria, caixa, page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  // Filtros "base" (não incluem a aba de caixa) — usados também nas contagens.
  const condBase = [];
  const paramsBase = [];
  if (paciente) { condBase.push('r.autor LIKE ?'); paramsBase.push(`%${paciente}%`); }
  if (sei) { condBase.push('r.sei LIKE ?'); paramsBase.push(`%${sei}%`); }
  const itemCond = [];
  const itemParams = [];
  if (codigo_item) { itemCond.push('ri.codigo_item LIKE ?'); itemParams.push(`%${codigo_item}%`); }
  if (descricao) { itemCond.push('ri.descricao_item LIKE ?'); itemParams.push(`%${descricao}%`); }
  if (categoria) { itemCond.push('ri.categoria = ?'); itemParams.push(categoria); }
  if (itemCond.length) {
    condBase.push(`EXISTS (SELECT 1 FROM requisicao_itens ri WHERE ri.requisicao_id = r.id AND ${itemCond.join(' AND ')})`);
    paramsBase.push(...itemParams);
  }

  // Permissão de caixa
  const permitidas = caixasDoUsuario(req.usuario); // null = admin (todas + sem-caixa)
  const ehAdmin = permitidas === null;

  // Contagens por caixa (rótulos das abas), aplicando só os filtros base.
  const whereBase = condBase.length ? `WHERE ${condBase.join(' AND ')}` : '';
  const linhasCont = db.prepare(`SELECT COALESCE(NULLIF(r.caixa, ''), '(sem)') AS cx, COUNT(*) c FROM requisicoes r ${whereBase} GROUP BY cx`).all(...paramsBase);
  const contagens = {};
  let totalPermitido = 0;
  for (const l of linhasCont) {
    const cx = l.cx === '(sem)' ? 'sem' : l.cx;
    contagens[cx] = l.c;
    if (ehAdmin || permitidas.includes(cx)) totalPermitido += l.c;
  }
  const caixasVisiveis = ehAdmin ? CAIXAS : permitidas;

  // Filtro da listagem: base + restrição de caixa (permissão + aba ativa).
  const cond = [...condBase];
  const params = [...paramsBase];
  if (!ehAdmin) {
    if (caixa && caixa !== 'todas' && permitidas.includes(caixa)) {
      cond.push('r.caixa = ?'); params.push(caixa);
    } else if (permitidas.length) {
      cond.push(`r.caixa IN (${permitidas.map(() => '?').join(',')})`); params.push(...permitidas);
    } else {
      cond.push('1 = 0');
    }
  } else if (caixa && caixa !== 'todas') {
    if (caixa === 'sem') cond.push("(r.caixa IS NULL OR r.caixa = '')");
    else { cond.push('r.caixa = ?'); params.push(caixa); }
  }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) c FROM requisicoes r ${where}`).get(...params).c;
  const requisicoes = db.prepare(`
    SELECT r.* FROM requisicoes r ${where} ORDER BY r.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({
    total, requisicoes, page: Number(page), pageSize: limit,
    caixas: { ehAdmin, visiveis: caixasVisiveis, contagens, totalPermitido },
  });
});

// ---------- Requisições: itens (visão por item + situação de estoque) ----------
router.get('/requisicoes/itens', (req, res) => {
  const { paciente, sei, codigo_item, descricao, categoria, caixa, page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;
  const escTP = "(e.unidade IS NULL OR e.unidade LIKE '%Tenente Pena%')";

  // Permissão de caixa (Materiais/Medicamentos/Nutrição). Admin => todas.
  const permitidas = caixasDoUsuario(req.usuario);
  const ehAdmin = permitidas === null;
  const aplicaCaixa = (cond, params) => {
    if (!ehAdmin) {
      if (caixa && caixa !== 'todas' && permitidas.includes(caixa)) { cond.push('r.caixa = ?'); params.push(caixa); }
      else if (permitidas.length) { cond.push(`r.caixa IN (${permitidas.map(() => '?').join(',')})`); params.push(...permitidas); }
      else cond.push('1 = 0');
    } else if (caixa && caixa !== 'todas') {
      if (caixa === 'sem') cond.push("(r.caixa IS NULL OR r.caixa = '')");
      else { cond.push('r.caixa = ?'); params.push(caixa); }
    }
  };

  // --- Requisições INDIVIDUAIS: uma linha por item (coletiva = 0) ---
  const condI = ['r.coletiva = 0'];
  const paramsI = [];
  if (paciente) { condI.push('r.autor LIKE ?'); paramsI.push(`%${paciente}%`); }
  if (sei) { condI.push('r.sei LIKE ?'); paramsI.push(`%${sei}%`); }
  if (codigo_item) { condI.push('ri.codigo_item LIKE ?'); paramsI.push(`%${codigo_item}%`); }
  if (descricao) { condI.push('ri.descricao_item LIKE ?'); paramsI.push(`%${descricao}%`); }
  if (categoria) { condI.push('ri.categoria = ?'); paramsI.push(categoria); }

  // --- Requisições COLETIVAS (base, sem filtro de caixa ainda) ---
  const condC = ['r.coletiva = 1'];
  const paramsC = [];
  if (paciente) { condC.push('(r.autor LIKE ? OR r.pacientes_json LIKE ?)'); paramsC.push(`%${paciente}%`, `%${paciente}%`); }
  if (sei) { condC.push('r.sei LIKE ?'); paramsC.push(`%${sei}%`); }
  const existsC = (campo, op, val) => { condC.push(`EXISTS (SELECT 1 FROM requisicao_itens ri WHERE ri.requisicao_id = r.id AND ri.${campo} ${op} ?)`); paramsC.push(val); };
  if (codigo_item) existsC('codigo_item', 'LIKE', `%${codigo_item}%`);
  if (descricao) existsC('descricao_item', 'LIKE', `%${descricao}%`);
  if (categoria) existsC('categoria', '=', categoria);

  // Contagens por caixa (rótulos das abas), com os filtros base mas SEM a aba.
  const contagens = {};
  const somaCont = (rows) => { for (const l of rows) { const cx = (l.caixa == null || l.caixa === '') ? 'sem' : l.caixa; contagens[cx] = (contagens[cx] || 0) + l.c; } };
  somaCont(db.prepare(`SELECT r.caixa, COUNT(*) c FROM requisicao_itens ri JOIN requisicoes r ON r.id = ri.requisicao_id WHERE ${condI.join(' AND ')} GROUP BY r.caixa`).all(...paramsI));
  somaCont(db.prepare(`SELECT r.caixa, COUNT(*) c FROM requisicoes r WHERE ${condC.join(' AND ')} GROUP BY r.caixa`).all(...paramsC));
  const caixasVisiveis = ehAdmin ? CAIXAS : permitidas;
  let totalPermitido = 0;
  for (const [cx, n] of Object.entries(contagens)) {
    if (ehAdmin || (cx !== 'sem' && permitidas.includes(cx))) totalPermitido += n;
  }

  // Aplica a restrição de caixa (permissão + aba) às duas consultas.
  aplicaCaixa(condI, paramsI);
  aplicaCaixa(condC, paramsC);

  const individuais = db.prepare(`
    SELECT 'item' AS tipo, ri.id, ri.requisicao_id, r.codigo_controle, r.autor, r.sei, r.protocolo,
           ri.codigo_item, ri.descricao_item, ri.categoria,
           COALESCE((SELECT e.siafisico FROM estoque_itens e WHERE e.codigo_item = ri.codigo_item AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1), ri.cod_siafisico) AS siafisico,
           (SELECT e.estoque   FROM estoque_itens e WHERE e.codigo_item = ri.codigo_item AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1) AS estoque_atual,
           (SELECT e.autonomia FROM estoque_itens e WHERE e.codigo_item = ri.codigo_item AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1) AS autonomia_atual,
           ri.quantidade, ri.status_atendimento, ri.telegrama_enviado, ri.data_envio, ri.requisicao_gsnet,
           ri.telegrama_enviado_por, ri.telegrama_enviado_em
    FROM requisicao_itens ri JOIN requisicoes r ON r.id = ri.requisicao_id
    WHERE ${condI.join(' AND ')}
  `).all(...paramsI);

  // --- Requisições COLETIVAS: uma linha por requisição (coletiva = 1) ---
  const coletivas = db.prepare(`
    SELECT 'coletiva' AS tipo, NULL AS id, r.id AS requisicao_id, r.codigo_controle, r.autor, r.sei,
           r.total_pacientes, r.total_itens,
           r.status_atendimento, r.telegrama_enviado, r.data_envio, r.requisicao_gsnet,
           r.telegrama_enviado_por, r.telegrama_enviado_em,
           -- Estoque agregado: conta itens que ficariam "Aguardar" (autonomia < 2)
           -- e "Chamar" (autonomia >= 2), pela mesma regra da linha individual.
           (SELECT COUNT(*) FROM requisicao_itens ri2 WHERE ri2.requisicao_id = r.id
             AND (SELECT e.autonomia FROM estoque_itens e WHERE e.codigo_item = ri2.codigo_item AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1) < 2) AS n_aguardar,
           (SELECT COUNT(*) FROM requisicao_itens ri2 WHERE ri2.requisicao_id = r.id
             AND (SELECT e.autonomia FROM estoque_itens e WHERE e.codigo_item = ri2.codigo_item AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1) >= 2) AS n_chamar
    FROM requisicoes r WHERE ${condC.join(' AND ')}
  `).all(...paramsC);
  // Rótulo do Status Estoque da coletiva: algum item Aguardar => parcial;
  // senão, se houver item para chamar => Chamar; sem dados => null.
  for (const c of coletivas) {
    c.status_estoque_coletiva = (c.n_aguardar > 0)
      ? 'Aguardar / Atendimento Parcial'
      : (c.n_chamar > 0 ? 'Chamar' : null);
  }

  // Mescla, ordena (requisição mais nova primeiro) e pagina em memória.
  const todos = [...individuais, ...coletivas].sort((a, b) =>
    (b.requisicao_id - a.requisicao_id) || ((a.id || 0) - (b.id || 0)));
  const total = todos.length;
  const itens = todos.slice(offset, offset + limit);

  // Resumo p/ KPIs — item individual conta 1; coletiva conta 1 (status do grupo).
  const resumo = { total, solicitado: 0, finalizado: 0, cancelado: 0, enviados: 0 };
  for (const r of todos) {
    if (r.status_atendimento === 'Solicitado') resumo.solicitado++;
    else if (r.status_atendimento === 'Finalizado') resumo.finalizado++;
    else if (r.status_atendimento === 'Cancelado') resumo.cancelado++;
    if (r.telegrama_enviado === 'Sim') resumo.enviados++;
  }

  res.json({
    total, itens, page: Number(page), pageSize: limit, resumo,
    caixas: { ehAdmin, visiveis: caixasVisiveis, contagens, totalPermitido },
  });
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

  const { status_atendimento, telegrama_enviado, data_envio, requisicao_gsnet, quantidade } = req.body || {};
  let status = status_atendimento ?? item.status_atendimento;
  // Quantidade de Aquisição (editável na linha do relatório). Aceita número ou
  // vazio (= sem quantidade / "apenas registrar"). Guardada como texto.
  const novaQtde = quantidade === undefined
    ? item.quantidade
    : (quantidade === null || String(quantidade).trim() === '' ? null : String(quantidade).trim());
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

  db.prepare('UPDATE requisicao_itens SET status_atendimento = ?, telegrama_enviado = ?, data_envio = ?, requisicao_gsnet = ?, quantidade = ?, telegrama_enviado_por = ?, telegrama_enviado_em = ? WHERE id = ?')
    .run(status, telegrama, dataEnvio, gsnet, novaQtde, enviadoPor, enviadoEm, item.id);

  // Registra no log; se a quantidade mudou, guarda o antes/depois explicitamente.
  const mudouQtde = String(item.quantidade ?? '') !== String(novaQtde ?? '');
  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_antes, dados_depois) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.usuario.id, req.usuario.email, mudouQtde ? 'editar_qtde_aquisicao' : 'atualizar_atendimento_item', 'requisicao_itens', item.id,
      mudouQtde ? JSON.stringify({ quantidade: item.quantidade }) : null,
      JSON.stringify({ status_atendimento: status, telegrama_enviado: telegrama, data_envio: dataEnvio, requisicao_gsnet: gsnet, quantidade: novaQtde, telegrama_enviado_por: enviadoPor }));

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
                                  tipo_demanda, qtde_consumo, prazo, periodicidade, dispensacoes_autorizadas, autonomia_compra, catmat,
                                  situacao_ata, escolha_ata, valor_unitario)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const it of itens) {
    stmt.run(r.id, it.codigo_item || null, it.cod_siafisico || null, it.descricao_item || null, it.categoria || null, String(it.quantidade ?? ''),
      it.tipo_demanda || null, it.qtde_consumo != null ? String(it.qtde_consumo) : null, it.prazo || null, it.periodicidade || null, it.dispensacoes_autorizadas || null,
      it.autonomia_compra != null ? String(it.autonomia_compra) : null, it.catmat || null,
      it.situacao_ata || null, it.escolha_ata || null, it.valor_unitario != null ? String(it.valor_unitario) : null);
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
  // Enriquece cada item com estoque e autonomia da foto mais recente (escopo
  // Tenente Pena), para o modal aplicar a mesma regra de Status Estoque.
  const escTP = "(e.unidade IS NULL OR e.unidade LIKE '%Tenente Pena%')";
  const stEst = db.prepare(`SELECT e.estoque AS estoque_atual, e.autonomia AS autonomia_atual
     FROM estoque_itens e WHERE e.codigo_item = ? AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1`);
  itens.forEach((it) => {
    const x = stEst.get(it.codigo_item) || {};
    it.estoque_atual = x.estoque_atual != null ? x.estoque_atual : null;
    it.autonomia_atual = x.autonomia_atual != null ? x.autonomia_atual : null;
  });
  // Coletiva: devolve a lista de pacientes e o detalhe por item já parseados.
  let pacientes = null;
  if (r.coletiva) {
    try { pacientes = JSON.parse(r.pacientes_json || '[]'); } catch (_) { pacientes = []; }
    itens.forEach((it) => { try { it.detalhe = JSON.parse(it.detalhe_json || '[]'); } catch (_) { it.detalhe = []; } });
  }
  res.json({ requisicao: r, itens, pacientes });
});

// ---------- Coletiva: atualizar o status/telegrama do GRUPO ----------
router.put('/requisicoes/:id/status-coletiva', (req, res) => {
  const r = db.prepare('SELECT * FROM requisicoes WHERE id = ? AND coletiva = 1').get(req.params.id);
  if (!r) return res.status(404).json({ erro: 'Solicitação coletiva não encontrada.' });
  const eAdmin = req.usuario.perfil === 'admin';
  const jaEnviado = r.telegrama_enviado === 'Sim';
  if (jaEnviado && !eAdmin) return res.status(403).json({ erro: 'Telegrama já enviado. Apenas um administrador pode alterar.' });

  const { status_atendimento, telegrama_enviado, data_envio, requisicao_gsnet } = req.body || {};
  let status = status_atendimento ?? r.status_atendimento;
  const telegrama = telegrama_enviado ?? r.telegrama_enviado;
  let dataEnvio = data_envio !== undefined ? (data_envio || null) : r.data_envio;
  const gsnet = requisicao_gsnet !== undefined ? (requisicao_gsnet || null) : r.requisicao_gsnet;
  let enviadoPor = r.telegrama_enviado_por;
  let enviadoEm = r.telegrama_enviado_em;
  const agora = new Date();
  if (telegrama === 'Sim' && !jaEnviado) {
    status = 'Finalizado';
    if (!dataEnvio) dataEnvio = agora.toISOString().slice(0, 10);
    enviadoPor = req.usuario.nome || req.usuario.email;
    enviadoEm = agora.toISOString();
  } else if (telegrama !== 'Sim' && jaEnviado) {
    dataEnvio = data_envio !== undefined ? (data_envio || null) : null;
    enviadoPor = null; enviadoEm = null;
  }
  db.prepare('UPDATE requisicoes SET status_atendimento = ?, telegrama_enviado = ?, data_envio = ?, requisicao_gsnet = ?, telegrama_enviado_por = ?, telegrama_enviado_em = ? WHERE id = ?')
    .run(status, telegrama, dataEnvio, gsnet, enviadoPor, enviadoEm, r.id);
  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.usuario.id, req.usuario.email, 'atualizar_status_coletiva', 'requisicoes', r.id,
      JSON.stringify({ status_atendimento: status, telegrama_enviado: telegrama, data_envio: dataEnvio, requisicao_gsnet: gsnet }));
  res.json({ ok: true });
});

// ---------- Comparação entre a versão anterior e a atual ----------
// Extraída em função para poder ser reaproveitada pelo envio por e-mail.
function calcularComparacao() {
  const datas = db.prepare(
    'SELECT DISTINCT data_referencia FROM autores_itens WHERE data_referencia IS NOT NULL ORDER BY data_referencia DESC LIMIT 2'
  ).all().map((r) => r.data_referencia);

  if (datas.length < 2) {
    return { temAnterior: false, atual: datas[0] || null };
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

  // Subcategoria por item (item_classificacao), para o filtro de subcategoria.
  const subcatMap = new Map(
    db.prepare("SELECT codigo_item, subcategoria FROM item_classificacao WHERE subcategoria IS NOT NULL AND subcategoria <> ''")
      .all().map((r) => [r.codigo_item, r.subcategoria])
  );
  const subcat = (cod) => (cod ? (subcatMap.get(cod) || null) : null);

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
          subcategoria: subcat(l.codigo_item),
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
      encerrados.push({ autor, processo: g.processo, ultimo_item: ultimo.descricao_item || '—', codigo_item: ultimo.codigo_item || null, subcategoria: subcat(ultimo.codigo_item), tipo_demanda: ultimo.tipo_demanda || null });
    }
  }

  // Alterações (autores em ambos, com diferença de itens/status)
  const alteracoes = [];
  for (const [autor, gA] of mapAtual) {
    const gP = mapAnt.get(autor);
    if (!gP) continue;
    // itens novos
    for (const [cod, it] of gA.itens) {
      if (!gP.itens.has(cod)) alteracoes.push({ autor, protocolo: it.protocolo || '—', codigo_item: cod, categoria: it.categoria || '—', subcategoria: subcat(cod), tipo_demanda: it.tipo_demanda || null, qtde_consumo: it.qtde_consumo || '—', alteracao: 'Novo medicamento', detalhe: it.descricao_item || cod });
    }
    // itens removidos
    for (const [cod, it] of gP.itens) {
      if (!gA.itens.has(cod)) alteracoes.push({ autor, protocolo: it.protocolo || '—', codigo_item: cod, categoria: it.categoria || '—', subcategoria: subcat(cod), tipo_demanda: it.tipo_demanda || null, qtde_consumo: it.qtde_consumo || '—', alteracao: 'Item removido', detalhe: it.descricao_item || cod });
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
        alteracoes.push({ autor, protocolo: itA.protocolo || '—', codigo_item: cod, categoria: itA.categoria || '—', subcategoria: subcat(cod), tipo_demanda: itA.tipo_demanda || null, qtde_consumo: itA.qtde_consumo || '—', alteracao: 'Status alterado', detalhe: `${it_desc(itA)} — ${partes.join('; ')}` });
      }
    }
  }
  function it_desc(it) { return it.descricao_item || it.codigo_item || '—'; }

  novos.sort((a, b) => a.autor.localeCompare(b.autor));
  encerrados.sort((a, b) => a.autor.localeCompare(b.autor));
  alteracoes.sort((a, b) => a.autor.localeCompare(b.autor));

  // Subcategorias e tipos de demanda presentes nas 3 listas, para os filtros.
  const subSet = new Set();
  const tipoSet = new Set();
  for (const arr of [novos, encerrados, alteracoes]) {
    for (const e of arr) {
      if (e.subcategoria) subSet.add(e.subcategoria);
      if (e.tipo_demanda && e.tipo_demanda !== '—') tipoSet.add(e.tipo_demanda);
    }
  }
  const subcategorias = [...subSet].sort((a, b) => a.localeCompare(b));
  const tiposDemanda = [...tipoSet].sort((a, b) => a.localeCompare(b));

  return {
    temAnterior: true,
    anterior,
    atual,
    totalAnterior: mapAnt.size,
    totalAtual: mapAtual.size,
    totalNovosPacientes,
    novos,
    encerrados,
    alteracoes,
    subcategorias,
    tiposDemanda,
  };
}

router.get('/comparacao', (req, res) => {
  const dados = calcularComparacao();
  // O e-mail padrão (destinatário) ajuda a pré-preencher a caixa no front.
  dados.emailPadrao = process.env.ALERTA_EMAIL_PARA || '';
  res.json(dados);
});

// ---------- Detalhe de um item (modal do paciente novo) ----------
// Estoque, autonomia, consumo total, demanda e compras EM ABERTO do item.
router.get('/comparacao/item-detalhe', (req, res) => {
  const codigo = (req.query.codigo || '').trim();
  if (!codigo) return res.status(400).json({ erro: 'Informe o código do item.' });
  const protocolo = (req.query.protocolo || '').trim() || null;
  const { detalheItem } = require('./andamentoCompraItem');
  res.json(detalheItem(codigo, protocolo));
});

// ---------- Enviar o comparativo por e-mail ----------
// Corpo: { para: "a@x;b@y" }. Anexa as 3 listas (novos, inativos, alterações)
// como CSV e resume no corpo. Sending real de e-mail: por segurança, exige
// perfil admin (a trava de módulo já barra não-admins em POST; esta é explícita).
router.post('/comparacao/enviar-relatorio', exigirPerfil('admin'), async (req, res) => {
  const { enviarComparativoPorEmail } = require('./enviarComparativoEmail');
  const para = (req.body && req.body.para ? String(req.body.para) : '').trim();
  if (!para) return res.status(400).json({ erro: 'Informe ao menos um e-mail de destino.' });
  try {
    const r = await enviarComparativoPorEmail(para, req.usuario ? req.usuario.email : 'sistema');
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(e.status || 500).json({ erro: e.message, codigo: e.codigo || 'ERRO' });
  }
});

module.exports = router;
module.exports.importarAutoresDeBuffer = importarAutoresDeBuffer;
module.exports.importarAutoresDeLinhas = importarAutoresDeLinhas;
module.exports.CAMPOS = CAMPOS;
module.exports.iniciarAtualizacaoOracle = iniciarAtualizacaoOracle;
module.exports.calcularComparacao = calcularComparacao;
module.exports.executarAtualizacaoOracle = executarAtualizacaoOracle;
