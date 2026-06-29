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

// Importa (substitui toda a listagem) a partir de um buffer
function importarAutoresDeBuffer(buffer, opcoes = {}) {
  const linhas = processarAutores(buffer);
  const dataReferencia = (opcoes.dataReferencia || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const usuarioEmail = opcoes.usuarioEmail || 'sistema';
  const usuarioId = opcoes.usuarioId ?? null;

  // Substitui a versão da mesma data (se reimportar no mesmo dia)
  db.prepare('DELETE FROM autores_itens WHERE data_referencia = ?').run(dataReferencia);

  const cols = ['data_referencia', ...CAMPOS];
  const stmt = db.prepare(
    `INSERT INTO autores_itens (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  );
  for (const l of linhas) {
    stmt.run(dataReferencia, ...CAMPOS.map((c) => l[c]));
  }

  // Mantém só as 2 versões mais recentes (atual + anterior, para o comparativo)
  const datas = db.prepare('SELECT DISTINCT data_referencia FROM autores_itens WHERE data_referencia IS NOT NULL ORDER BY data_referencia DESC').all().map((r) => r.data_referencia);
  if (datas.length > 2) {
    const manter = datas.slice(0, 2);
    db.prepare(`DELETE FROM autores_itens WHERE data_referencia NOT IN (${manter.map(() => '?').join(',')})`).run(...manter);
  }

  // contagens úteis (só da versão atual)
  const totalAutores = db.prepare('SELECT COUNT(DISTINCT autor) c FROM autores_itens WHERE data_referencia = ?').get(dataReferencia).c;
  const resumo = { dataReferencia, totalLinhas: linhas.length, totalAutores };

  db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
    .run('autores', opcoes.nomeArquivo || 'autores', usuarioEmail, JSON.stringify(resumo));
  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
    .run(usuarioId, usuarioEmail, 'importar_autores', 'autores_itens', JSON.stringify(resumo));

  return resumo;
}

// ---------- Listagem com filtros e paginação ----------
router.get('/', (req, res) => {
  const { q, unidade, status_demanda, status_item, categoria, page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  // Sempre a versão mais recente
  const cond = ['data_referencia = (SELECT MAX(data_referencia) FROM autores_itens)'];
  const params = [];
  if (q) {
    cond.push('(autor LIKE ? OR processo LIKE ? OR protocolo LIKE ? OR descricao_item LIKE ? OR codigo_item LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  if (unidade) { cond.push('unidade_dispensadora = ?'); params.push(unidade); }
  if (status_demanda) { cond.push('status_demanda = ?'); params.push(status_demanda); }
  if (status_item) { cond.push('status_item = ?'); params.push(status_item); }
  if (categoria) { cond.push('categoria = ?'); params.push(categoria); }
  const where = `WHERE ${cond.join(' AND ')}`;

  const total = db.prepare(`SELECT COUNT(*) c FROM autores_itens ${where}`).get(...params).c;
  const itens = db.prepare(
    `SELECT * FROM autores_itens ${where} ORDER BY autor COLLATE NOCASE, descricao_item LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  const dataRef = db.prepare('SELECT MAX(data_referencia) v FROM autores_itens').get()?.v || null;
  const totalAutores = db.prepare('SELECT COUNT(DISTINCT autor) c FROM autores_itens WHERE data_referencia = ?').get(dataRef).c;

  res.json({ total, totalAutores, dataReferencia: dataRef, itens, page: Number(page), pageSize: limit });
});

// ---------- Valores distintos para os filtros ----------
router.get('/filtros', (req, res) => {
  const distintos = (col) => db.prepare(
    `SELECT DISTINCT ${col} v FROM autores_itens WHERE data_referencia = (SELECT MAX(data_referencia) FROM autores_itens) AND ${col} IS NOT NULL AND ${col} <> '' ORDER BY v`
  ).all().map((r) => r.v);
  res.json({
    unidade: distintos('unidade_dispensadora'),
    status_demanda: distintos('status_demanda'),
    status_item: distintos('status_item'),
    categoria: distintos('categoria'),
  });
});

// ---------- Importação manual ----------
router.post('/importar/confirmar', exigirPerfil('admin'), upload.single('arquivo'), (req, res) => {
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
           (SELECT e.estoque   FROM estoque_itens e WHERE e.codigo_item = a.codigo_item AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1) AS estoque_atual,
           (SELECT e.autonomia FROM estoque_itens e WHERE e.codigo_item = a.codigo_item AND ${escTP} ORDER BY e.data_referencia DESC LIMIT 1) AS autonomia_atual
    FROM autores_itens a
    WHERE a.autor = ? AND a.data_referencia = (SELECT MAX(data_referencia) FROM autores_itens)
    ORDER BY a.descricao_item
  `).all(autor);

  const info = db.prepare(
    'SELECT autor, idade, dt_nascimento, unidade_dispensadora, procurador_estado FROM autores_itens WHERE autor = ? AND data_referencia = (SELECT MAX(data_referencia) FROM autores_itens) LIMIT 1'
  ).get(autor) || { autor };

  res.json({ info, itens });
});

// ---------- Requisições: salvar (gera ID de controle) ----------
router.post('/requisicoes', (req, res) => {
  const { autor, idade, unidade, procurador, sei, itens } = req.body || {};
  if (!autor || !Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ erro: 'Informe o paciente e ao menos um item.' });
  }

  const info = db.prepare(`
    INSERT INTO requisicoes (autor, idade, unidade, procurador, sei, operador_nome, operador_email, total_itens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(autor, idade || null, unidade || null, procurador || null, sei || null,
    req.usuario.nome, req.usuario.email, itens.length);

  const id = info.lastInsertRowid;
  const ano = new Date().getFullYear();
  const codigoControle = `REQ-${ano}-${String(id).padStart(5, '0')}`;
  db.prepare('UPDATE requisicoes SET codigo_controle = ? WHERE id = ?').run(codigoControle, id);

  const stmt = db.prepare(`
    INSERT INTO requisicao_itens (requisicao_id, codigo_item, cod_siafisico, descricao_item, categoria, quantidade)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const it of itens) {
    stmt.run(id, it.codigo_item || null, it.cod_siafisico || null, it.descricao_item || null, it.categoria || null, String(it.quantidade ?? ''));
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
           ri.quantidade, ri.status_atendimento, ri.telegrama_enviado, ri.data_envio, ri.requisicao_gsnet
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

  const { status_atendimento, telegrama_enviado, data_envio, requisicao_gsnet } = req.body || {};
  const status = status_atendimento ?? item.status_atendimento;
  const telegrama = telegrama_enviado ?? item.telegrama_enviado;
  const dataEnvio = data_envio !== undefined ? (data_envio || null) : item.data_envio;
  const gsnet = requisicao_gsnet !== undefined ? (requisicao_gsnet || null) : item.requisicao_gsnet;

  db.prepare('UPDATE requisicao_itens SET status_atendimento = ?, telegrama_enviado = ?, data_envio = ?, requisicao_gsnet = ? WHERE id = ?')
    .run(status, telegrama, dataEnvio, gsnet, item.id);

  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.usuario.id, req.usuario.email, 'atualizar_atendimento_item', 'requisicao_itens', item.id,
      JSON.stringify({ status_atendimento: status, telegrama_enviado: telegrama, data_envio: dataEnvio }));

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

  const { sei, itens } = req.body || {};
  if (!Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ erro: 'Informe ao menos um item.' });
  }

  db.prepare("UPDATE requisicoes SET sei = ?, total_itens = ?, atualizado_em = datetime('now') WHERE id = ?")
    .run(sei || null, itens.length, r.id);

  db.prepare('DELETE FROM requisicao_itens WHERE requisicao_id = ?').run(r.id);
  const stmt = db.prepare(`
    INSERT INTO requisicao_itens (requisicao_id, codigo_item, cod_siafisico, descricao_item, categoria, quantidade)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const it of itens) {
    stmt.run(r.id, it.codigo_item || null, it.cod_siafisico || null, it.descricao_item || null, it.categoria || null, String(it.quantidade ?? ''));
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
    'SELECT autor, processo, codigo_item, descricao_item, data_cadastro, status_demanda, status_item FROM autores_itens WHERE data_referencia = ?'
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

  // Novos pacientes (no atual, não no anterior)
  const novos = [];
  for (const [autor, g] of mapAtual) {
    if (!mapAnt.has(autor)) {
      const primeiro = g.linhas[0] || {};
      novos.push({ autor, processo: g.processo, item: primeiro.descricao_item || '—', cadastro: primeiro.data_cadastro || '—', qtde_itens: g.linhas.length });
    }
  }

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
      if (!gP.itens.has(cod)) alteracoes.push({ autor, alteracao: 'Novo medicamento', detalhe: it.descricao_item || cod });
    }
    // itens removidos
    for (const [cod, it] of gP.itens) {
      if (!gA.itens.has(cod)) alteracoes.push({ autor, alteracao: 'Item removido', detalhe: it.descricao_item || cod });
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
        alteracoes.push({ autor, alteracao: 'Status alterado', detalhe: `${it_desc(itA)} — ${partes.join('; ')}` });
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
    novos,
    encerrados,
    alteracoes,
  });
});

module.exports = router;
module.exports.importarAutoresDeBuffer = importarAutoresDeBuffer;
