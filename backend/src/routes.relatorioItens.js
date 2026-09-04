const express = require('express');
const XLSX = require('xlsx');
const multer = require('multer');
const db = require('./db');
const { autenticar, exigirPerfil } = require('./auth');

const router = express.Router();
router.use(autenticar);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

function normalizar(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[._]/g, ' ')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// campo do banco -> nome(s) de cabeçalho aceitos (normalizados)
const MAPA = {
  pro_id: ['pro id'],
  situacao: ['situacao'],
  usuario: ['usuario'],
  categoria: ['categoria'],
  codigo: ['codigo'],
  siafisico: ['siafisico'],
  catmat: ['catmat'],
  descricao_item: ['descricao do item'],
  valor_medio_unitario: ['valor medio unitario'],
  item: ['item'],
  especificacao: ['especificacao'],
  apresentacao: ['apresentacao'],
  marca: ['marca'],
  importado: ['importado'],
  tipo_item: ['tipo item'],
  grupo: ['grupo'],
  programa: ['programa'],
  grupo_af: ['grupo af'],
  intercambiavel: ['intercambiavel'],
  observacoes: ['observacoes'],
  outras_demandas: ['outras demandas'],
  oncologico: ['oncologico'],
  termolabil: ['termolabil'],
  antimicrobiano: ['antimicrobiano'],
  portaria34498: ['portaria34498'],
  grande_volume: ['grandevolume', 'grande volume'],
  comissao_farmacologia: ['comissao de farmacologia'],
  judicial: ['judicial'],
  jefaz: ['jefaz'],
};
const CAMPOS = Object.keys(MAPA);

function texto(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

function processarRelatorioItens(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const brutas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });

  let hc = -1;
  for (let i = 0; i < Math.min(brutas.length, 15); i++) {
    const ln = (brutas[i] || []).map(normalizar);
    if (ln.includes('codigo') && ln.includes('descricao do item')) { hc = i; break; }
  }
  if (hc === -1) throw new Error('Não reconheci o layout do Relatório de Itens (não achei "Código" e "Descrição do Item").');

  const cab = (brutas[hc] || []).map(normalizar);
  const COL = {};
  for (const [campo, nomes] of Object.entries(MAPA)) COL[campo] = cab.findIndex((c) => nomes.includes(c));
  if (COL.codigo === -1) throw new Error('Não encontrei a coluna "Código".');

  const linhas = [];
  for (let i = hc + 1; i < brutas.length; i++) {
    const r = brutas[i];
    if (!r) continue;
    const codigo = texto(r[COL.codigo]);
    if (!codigo) continue;
    const linha = {};
    for (const campo of CAMPOS) linha[campo] = COL[campo] >= 0 ? texto(r[COL[campo]]) : null;
    linhas.push(linha);
  }
  return linhas;
}

// Importa (substitui todo o catálogo) a partir de linhas já mapeadas
// (objetos com as chaves de CAMPOS). Usado tanto pelo CSV quanto pelo
// atualizador via Oracle. Tudo numa única transação: gravar milhares de
// linhas uma a uma sem transação prende o banco por muito tempo e colide
// com outras escritas ("database is locked" — mesma causa já corrigida
// na sincronização de Autores).
function importarRelatorioItensDeLinhas(linhas, opcoes = {}) {
  const dataReferencia = (opcoes.dataReferencia || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const usuarioEmail = opcoes.usuarioEmail || 'sistema';
  const usuarioId = opcoes.usuarioId ?? null;

  let resumo;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM relatorio_itens');
    const cols = ['data_referencia', ...CAMPOS];
    const stmt = db.prepare(`INSERT INTO relatorio_itens (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    for (const l of linhas) stmt.run(dataReferencia, ...CAMPOS.map((c) => (l[c] === undefined ? null : l[c])));

    resumo = { dataReferencia, totalItens: linhas.length };
    db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
      .run('relatorio_itens', opcoes.nomeArquivo || 'relatorio_itens', usuarioEmail, JSON.stringify(resumo));
    db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
      .run(usuarioId, usuarioEmail, 'importar_relatorio_itens', 'relatorio_itens', JSON.stringify(resumo));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return resumo;
}

function importarRelatorioItensDeBuffer(buffer, opcoes = {}) {
  const linhas = processarRelatorioItens(buffer);
  return importarRelatorioItensDeLinhas(linhas, opcoes);
}

// =====================================================================
// CLASSIFICAÇÃO PERMANENTE (Dose Certa / Doença Rara / Unidade de
// Fornecimento / Embalagem de Conversão) — tabela item_classificacao.
// NÃO é apagada pela reimportação diária do relatório. Origem: aba
// "Status-Siafisico" (importação) ou edição manual pela tela.
// =====================================================================

// Converte texto BR/planilha em número (tolera "1.234,56", "-", vazio).
function numero(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let t = String(v).trim();
  if (t === '' || t === '-') return null;
  if (t.includes(',') && t.includes('.')) t = t.replace(/\./g, '').replace(',', '.');
  else if (t.includes(',')) t = t.replace(',', '.');
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

// Texto, mas tratando "-" (traço) e vazio como nulo (usado em SubCategoria/Responsável).
function textoSemTraco(v) {
  const t = String(v ?? '').trim();
  return t === '' || t === '-' ? null : t;
}

// Normaliza "Sim"/"Não"/"-"/vazio -> 'Sim' | 'Não' | null.
function simNao(v) {
  const t = String(v ?? '').trim();
  if (t === '' || t === '-') return null;
  if (/^s/i.test(t)) return 'Sim';
  if (/^n/i.test(t)) return 'Não';
  return null;
}

// Faz o upsert de UM item na classificação. `direto=false` (importação)
// preserva o valor antigo quando o novo vem nulo (COALESCE); `direto=true`
// (edição manual) grava exatamente o que veio, permitindo limpar um campo.
function upsertClassificacao(reg, usuarioEmail, direto = false) {
  const set = direto
    ? `dose_certa = excluded.dose_certa,
       doenca_rara = excluded.doenca_rara,
       unidade_fornecimento = excluded.unidade_fornecimento,
       embalagem_conversao = excluded.embalagem_conversao,
       outros_programas = excluded.outros_programas,
       qual_programa = excluded.qual_programa,
       subcategoria = excluded.subcategoria,
       responsavel_aquisicao = excluded.responsavel_aquisicao,
       inex = excluded.inex`
    : `dose_certa = COALESCE(excluded.dose_certa, item_classificacao.dose_certa),
       doenca_rara = COALESCE(excluded.doenca_rara, item_classificacao.doenca_rara),
       unidade_fornecimento = COALESCE(excluded.unidade_fornecimento, item_classificacao.unidade_fornecimento),
       embalagem_conversao = COALESCE(excluded.embalagem_conversao, item_classificacao.embalagem_conversao),
       outros_programas = COALESCE(excluded.outros_programas, item_classificacao.outros_programas),
       qual_programa = COALESCE(excluded.qual_programa, item_classificacao.qual_programa),
       subcategoria = COALESCE(excluded.subcategoria, item_classificacao.subcategoria),
       responsavel_aquisicao = COALESCE(excluded.responsavel_aquisicao, item_classificacao.responsavel_aquisicao),
       inex = COALESCE(excluded.inex, item_classificacao.inex)`;
  db.prepare(`
    INSERT INTO item_classificacao
      (codigo_item, dose_certa, doenca_rara, unidade_fornecimento, embalagem_conversao, outros_programas, qual_programa, subcategoria, responsavel_aquisicao, inex, atualizado_em, usuario_email)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), ?)
    ON CONFLICT(codigo_item) DO UPDATE SET
      ${set},
      atualizado_em = datetime('now','localtime'),
      usuario_email = excluded.usuario_email
  `).run(reg.codigo_item, reg.dose_certa, reg.doenca_rara, reg.unidade_fornecimento, reg.embalagem_conversao,
         reg.outros_programas ?? null, reg.qual_programa ?? null, reg.subcategoria ?? null, reg.responsavel_aquisicao ?? null, reg.inex ?? null, usuarioEmail);
}

// Lê a planilha de classificação e devolve as linhas. Reconhece DOIS layouts,
// escritos em item_classificacao (upsert que preserva o que não vem):
//  • "Status-Siafisico": Programa=Dose Certa (Sim/Não), Doenças Raras,
//    Unidade de Fornecimento, Embalagem de Conversão.
//  • "Relatório de Itens (REL)": tem "SubCategoria" e "Responsável Aquisição".
//    Nesse layout NÃO mapeamos Dose Certa — ali "Programa" é o NOME do programa
//    (Especializado, Componente Básico...), não um Sim/Não; mapear corromperia.
function processarStatusSiafisico(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false });

  // Procura, em qualquer aba, uma linha de cabeçalho com "Código" + algum
  // cabeçalho conhecido de classificação.
  let escolhido = null;
  for (const nome of wb.SheetNames) {
    const brutas = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1, defval: null, raw: false });
    for (let i = 0; i < Math.min(brutas.length, 12); i++) {
      const ln = (brutas[i] || []).map(normalizar);
      const temCodigo = ln.includes('codigo');
      const temAlgo = ln.some((c) => c.includes('embalagem de conversao') || c.includes('subcategoria') || c.includes('responsavel'));
      if (temCodigo && temAlgo) { escolhido = { brutas, hc: i, cab: ln }; break; }
    }
    if (escolhido) break;
  }
  if (!escolhido) {
    throw new Error('Não reconheci o layout da planilha (esperado "Código" com "Embalagem de Conversão" ou com "SubCategoria/Responsável Aquisição").');
  }

  const { brutas, hc, cab } = escolhido;
  const acha = (nomes) => cab.findIndex((c) => nomes.some((n) => c === n || c.includes(n)));
  const ehREL = cab.some((c) => c.includes('subcategoria')) && cab.some((c) => c.includes('responsavel'));

  const COL = {
    codigo: acha(['codigo']),
    subcategoria: acha(['subcategoria']),
    responsavel_aquisicao: acha(['responsavel aquisicao', 'responsavel']),
    // Só no layout Status-Siafisico (senão "Programa" do REL vira lixo em Dose Certa).
    dose_certa: ehREL ? -1 : acha(['programa']),
    doenca_rara: ehREL ? -1 : acha(['doencas raras', 'doenca rara']),
    unidade_fornecimento: ehREL ? -1 : acha(['unidade de fornecimento']),
    embalagem_conversao: ehREL ? -1 : acha(['embalagem de conversao']),
  };
  if (COL.codigo === -1) throw new Error('Não encontrei a coluna "Código" na planilha.');

  const linhas = [];
  for (let i = hc + 1; i < brutas.length; i++) {
    const r = brutas[i]; if (!r) continue;
    const codigo = texto(r[COL.codigo]);
    if (!codigo) continue;
    linhas.push({
      codigo_item: codigo,
      dose_certa: COL.dose_certa >= 0 ? simNao(r[COL.dose_certa]) : null,
      doenca_rara: COL.doenca_rara >= 0 ? simNao(r[COL.doenca_rara]) : null,
      unidade_fornecimento: COL.unidade_fornecimento >= 0 ? texto(r[COL.unidade_fornecimento]) : null,
      embalagem_conversao: COL.embalagem_conversao >= 0 ? numero(r[COL.embalagem_conversao]) : null,
      subcategoria: COL.subcategoria >= 0 ? textoSemTraco(r[COL.subcategoria]) : null,
      responsavel_aquisicao: COL.responsavel_aquisicao >= 0 ? textoSemTraco(r[COL.responsavel_aquisicao]) : null,
    });
  }
  return linhas;
}

// Importa a classificação da aba Status-Siafisico (upsert, preserva o antigo
// quando o novo vem em branco). Transação única para não prender o banco.
function importarStatusSiafisicoDeBuffer(buffer, opcoes = {}) {
  const linhas = processarStatusSiafisico(buffer);
  const usuarioEmail = opcoes.usuarioEmail || 'sistema';
  let novos = 0;
  db.exec('BEGIN');
  try {
    const existe = db.prepare('SELECT 1 FROM item_classificacao WHERE codigo_item = ?');
    for (const l of linhas) {
      if (!existe.get(l.codigo_item)) novos++;
      upsertClassificacao(l, usuarioEmail, false);
    }
    const resumo = { total: linhas.length, novos, atualizados: linhas.length - novos };
    db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
      .run('item_classificacao', opcoes.nomeArquivo || 'status_siafisico', usuarioEmail, JSON.stringify(resumo));
    db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
      .run(opcoes.usuarioId ?? null, usuarioEmail, 'importar_classificacao', 'item_classificacao', JSON.stringify(resumo));
    db.exec('COMMIT');
    return resumo;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- Listagem com filtros e paginação ----------
router.get('/', (req, res) => {
  const { q, categoria, tipo_item, grupo, situacao, judicial, importado, outras_demandas,
    dose_certa, doenca_rara, classificacao, page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  // JOIN com a classificação permanente (item_classificacao) por código.
  const FROM = `FROM relatorio_itens ri
    LEFT JOIN item_classificacao c ON c.codigo_item = ri.codigo`;

  const cond = [];
  const params = [];
  if (q) {
    cond.push('(ri.descricao_item LIKE ? OR ri.codigo LIKE ? OR ri.siafisico LIKE ? OR ri.catmat LIKE ? OR ri.marca LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  if (categoria) { cond.push('ri.categoria = ?'); params.push(categoria); }
  if (tipo_item) { cond.push('ri.tipo_item = ?'); params.push(tipo_item); }
  if (grupo) { cond.push('ri.grupo = ?'); params.push(grupo); }
  if (situacao) { cond.push('ri.situacao = ?'); params.push(situacao); }
  if (judicial) { cond.push('ri.judicial = ?'); params.push(judicial); }
  if (importado) { cond.push('ri.importado = ?'); params.push(importado); }
  if (outras_demandas) { cond.push('ri.outras_demandas = ?'); params.push(outras_demandas); }
  if (dose_certa) { cond.push('c.dose_certa = ?'); params.push(dose_certa); }
  if (doenca_rara) { cond.push('c.doenca_rara = ?'); params.push(doenca_rara); }
  // Classificação: 'pendentes' = item que EXISTE no Estoque TP mais recente
  // (com demanda > 0 — o universo real de planejamento) e ainda não tem a
  // Embalagem de Conversão preenchida. Assim o filtro mostra só os itens de
  // TP que faltam classificar, não o catálogo inteiro. Cruzamento pelo código
  // SCODES (relatorio_itens.codigo = estoque_itens.codigo_item).
  // 'ok' = já classificado (embalagem preenchida).
  if (classificacao === 'pendentes') {
    cond.push(`(c.codigo_item IS NULL OR c.embalagem_conversao IS NULL)
      AND ri.codigo IN (
        SELECT e.codigo_item FROM estoque_itens e
        WHERE e.data_referencia = (SELECT MAX(data_referencia) FROM estoque_itens)
          AND e.demandas > 0)`);
  } else if (classificacao === 'ok') cond.push('c.embalagem_conversao IS NOT NULL');
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) cc ${FROM} ${where}`).get(...params).cc;
  const itens = db.prepare(
    `SELECT ri.*,
       c.dose_certa AS clas_dose_certa,
       c.doenca_rara AS clas_doenca_rara,
       c.unidade_fornecimento AS clas_unidade_fornecimento,
       c.embalagem_conversao AS clas_embalagem_conversao,
       c.inex AS clas_inex
     ${FROM} ${where}
     ORDER BY ri.descricao_item COLLATE NOCASE LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  const dataRef = db.prepare('SELECT data_referencia FROM relatorio_itens LIMIT 1').get()?.data_referencia || null;

  const _impRI = db.prepare("SELECT datetime(criado_em,'localtime') q FROM importacoes WHERE tipo='relatorio_itens' ORDER BY criado_em DESC LIMIT 1").get();
  res.json({ total, dataReferencia: dataRef, dataImportacao: _impRI ? _impRI.q : null, itens, page: Number(page), pageSize: limit });
});

// ---------- Valores distintos para os filtros ----------
router.get('/filtros', (req, res) => {
  const distintos = (col) => db.prepare(
    `SELECT DISTINCT ${col} v FROM relatorio_itens WHERE ${col} IS NOT NULL AND ${col} <> '' ORDER BY v`
  ).all().map((r) => r.v);
  res.json({
    categoria: distintos('categoria'),
    tipo_item: distintos('tipo_item'),
    importado: distintos('importado'),
    outras_demandas: distintos('outras_demandas'),
  });
});

// ---------- Importação manual ----------
router.post('/importar/confirmar', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie o arquivo .csv do Relatório de Itens.' });
  try {
    const resumo = importarRelatorioItensDeBuffer(req.file.buffer, {
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
const estadoOracle = { rodando: false, inicio: null, ultimoResumo: null, ultimoErro: null };

function executarAtualizacaoRelatorioItensOracle(opcoes = {}) {
  if (estadoOracle.rodando) return Promise.resolve({ pulou: true, motivo: 'já em andamento' });
  const { atualizarRelatorioItensViaOracle } = require('../oracle/sync-relatorio-itens');
  estadoOracle.rodando = true;
  estadoOracle.inicio = new Date().toISOString();
  estadoOracle.ultimoErro = null;

  return atualizarRelatorioItensViaOracle(opcoes)
    .then((resumo) => {
      estadoOracle.ultimoResumo = { ...resumo, fim: new Date().toISOString() };
      console.log(`[SYNC RELATÓRIO ITENS] Concluido via Oracle: ${resumo.totalItens} itens em ${Math.round((resumo.duracaoMs || 0) / 1000)}s.`);
      return resumo;
    })
    .catch((e) => {
      estadoOracle.ultimoErro = e.message;
      console.error('[SYNC RELATÓRIO ITENS] Falha via Oracle:', e.message);
      require('./emailAlerta').enviarAlertaFalhaSincronizacao('Relatório de Itens', e.message);
      throw e;
    })
    .finally(() => { estadoOracle.rodando = false; });
}

function iniciarAtualizacaoOracle(opcoes = {}) {
  if (estadoOracle.rodando) return { iniciado: false, jaRodando: true };
  executarAtualizacaoRelatorioItensOracle(opcoes).catch(() => {});
  return { iniciado: true, jaRodando: false };
}

router.post('/atualizar-oracle', exigirPerfil('admin'), (req, res) => {
  const r = iniciarAtualizacaoOracle({ usuarioEmail: req.usuario.email });
  if (!r.iniciado) {
    return res.status(409).json({ erro: 'Já existe uma atualização via Oracle em andamento.', ...estadoOracle });
  }
  res.json({ iniciado: true, inicio: estadoOracle.inicio });
});

router.get('/atualizar-oracle/status', (req, res) => {
  res.json(estadoOracle);
});

// ---------- Classificação: importar aba Status-Siafisico ----------
router.post('/classificacao/importar', exigirPerfil('admin'), upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie a planilha com a aba "Status-Siafisico".' });
  try {
    const resumo = importarStatusSiafisicoDeBuffer(req.file.buffer, {
      nomeArquivo: req.file.originalname,
      usuarioEmail: req.usuario.email,
      usuarioId: req.usuario.id,
    });
    res.json(resumo);
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

// ---------- Classificação: consultar um item ----------
router.get('/classificacao/:codigo', (req, res) => {
  const c = db.prepare('SELECT * FROM item_classificacao WHERE codigo_item = ?').get(req.params.codigo);
  res.json(c || { codigo_item: req.params.codigo, dose_certa: null, doenca_rara: null, unidade_fornecimento: null, embalagem_conversao: null });
});

// ---------- Classificação: editar/gravar um item manualmente ----------
// Permissão: quem tiver a ação "editar" no módulo relatorioItens (admin sempre).
// A trava é feita pelo exigirModulo('relatorioItens') no server.js — por isso
// NÃO exigimos mais o perfil admin aqui (antes era só admin).
router.put('/classificacao/:codigo', (req, res) => {
  const codigo = String(req.params.codigo || '').trim();
  if (!codigo) return res.status(400).json({ erro: 'Código do item ausente.' });
  const b = req.body || {};
  const outrosProgramas = simNao(b.outros_programas);
  const reg = {
    codigo_item: codigo,
    dose_certa: simNao(b.dose_certa),
    doenca_rara: simNao(b.doenca_rara),
    unidade_fornecimento: texto(b.unidade_fornecimento),
    embalagem_conversao: numero(b.embalagem_conversao),
    outros_programas: outrosProgramas,
    // Só guarda o nome do programa quando "Outros Programas" = Sim; caso
    // contrário limpa (não faz sentido manter texto de programa com resposta Não).
    qual_programa: outrosProgramas === 'Sim' ? texto(b.qual_programa) : null,
    subcategoria: texto(b.subcategoria),
    responsavel_aquisicao: texto(b.responsavel_aquisicao),
    inex: simNao(b.inex),
  };
  try {
    upsertClassificacao(reg, req.usuario.email, true);
    db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
      .run(req.usuario.id ?? null, req.usuario.email, 'editar_classificacao', 'item_classificacao', JSON.stringify(reg));
    res.json({ ok: true, classificacao: db.prepare('SELECT * FROM item_classificacao WHERE codigo_item = ?').get(codigo) });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

// ---------- Aba "Planejamento TP": só itens da Tenente Pena ----------
// Universo = itens presentes no Estoque TP mais recente com demanda ≠ 0
// (o universo real de planejamento). Cruzamento pelo código SCODES
// (estoque_itens.codigo_item = relatorio_itens.codigo = item_classificacao.codigo_item).
// Traz o descritivo/siafísico do relatório e a classificação permanente.
// Monta o FROM/WHERE/SELECT compartilhado entre a listagem e a exportação.
// `is_novo` = item que está no Estoque TP mais recente mas NÃO estava no
// snapshot imediatamente anterior (item novo na unidade). Se não houver
// snapshot anterior, ninguém é marcado como novo.
function montarConsultaPlanTP(query) {
  const { q, classificacao, categoria, novos, responsavel } = query;

  // Duas datas de referência mais recentes do estoque.
  const refs = db.prepare('SELECT DISTINCT data_referencia FROM estoque_itens ORDER BY data_referencia DESC LIMIT 2').all();
  const dataRef = refs[0]?.data_referencia || null;
  const prevRef = refs[1]?.data_referencia || null;
  // prevRef vem do próprio banco (formato YYYY-MM-DD controlado) — inlining seguro.
  // Só a Tenente Pena (o Planejamento TP é da unidade). Sem esse filtro, o
  // universo somava a demanda de TODAS as unidades e entravam itens sem
  // demanda na TP (bug corrigido em 24/08/2026).
  const TP = "(unidade IS NULL OR unidade LIKE '%Tenente Pena%')";
  const novoExpr = prevRef
    ? `CASE WHEN e.codigo_item NOT IN (SELECT codigo_item FROM estoque_itens WHERE data_referencia = '${prevRef}' AND ${TP}) THEN 1 ELSE 0 END`
    : '0';

  // O estoque tem VÁRIAS linhas por item (uma por demanda). Agrego primeiro
  // por código (soma da demanda = demanda total do item) para ter UMA linha
  // por item; só então junto o catálogo (siafísico/descrição) e a classificação.
  const FROM = `FROM (
      SELECT codigo_item,
             SUM(demandas) AS demanda_total,
             MAX(siafisico) AS siafisico,
             MAX(descricao) AS descricao,
             MAX(categoria) AS categoria
      FROM estoque_itens
      WHERE data_referencia = (SELECT MAX(data_referencia) FROM estoque_itens)
        AND ${TP}
      GROUP BY codigo_item
      HAVING SUM(demandas) IS NOT NULL AND SUM(demandas) <> 0
    ) e
    LEFT JOIN relatorio_itens ri ON ri.codigo = e.codigo_item
    LEFT JOIN item_classificacao c ON c.codigo_item = e.codigo_item`;

  const cond = [];
  const params = [];
  if (q) {
    cond.push('(ri.descricao_item LIKE ? OR e.descricao LIKE ? OR e.codigo_item LIKE ? OR ri.siafisico LIKE ? OR e.siafisico LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  if (categoria) { cond.push('e.categoria = ?'); params.push(categoria); }
  if (responsavel) { cond.push('c.responsavel_aquisicao = ?'); params.push(responsavel); }
  // SubCategoria aceita múltiplos valores (?subcategoria=A&subcategoria=B).
  let subs = query.subcategoria;
  if (subs) {
    if (!Array.isArray(subs)) subs = [subs];
    subs = subs.filter((s) => s != null && String(s).trim() !== '');
    if (subs.length) {
      cond.push(`c.subcategoria IN (${subs.map(() => '?').join(',')})`);
      params.push(...subs);
    }
  }
  if (classificacao === 'pendentes') cond.push('(c.codigo_item IS NULL OR c.embalagem_conversao IS NULL)');
  else if (classificacao === 'ok') cond.push('c.embalagem_conversao IS NOT NULL');
  if (novos === '1' || novos === 'true') cond.push(`${novoExpr} = 1`);
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const SELECT = `SELECT e.codigo_item AS codigo,
       COALESCE(ri.siafisico, e.siafisico) AS siafisico,
       COALESCE(ri.descricao_item, e.descricao) AS descricao_item,
       e.demanda_total AS demanda_total,
       ${novoExpr} AS is_novo,
       c.dose_certa AS clas_dose_certa,
       c.doenca_rara AS clas_doenca_rara,
       c.unidade_fornecimento AS clas_unidade_fornecimento,
       c.embalagem_conversao AS clas_embalagem_conversao,
       c.outros_programas AS clas_outros_programas,
       c.qual_programa AS clas_qual_programa,
       c.subcategoria AS clas_subcategoria,
       c.responsavel_aquisicao AS clas_responsavel_aquisicao,
       c.inex AS clas_inex`;

  return { FROM, where, params, SELECT, dataRef, prevRef };
}

router.get('/planejamento-tp', (req, res) => {
  const limit = Math.min(parseInt(req.query.pageSize, 10) || 50, 200);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const offset = (page - 1) * limit;

  const { FROM, where, params, SELECT, dataRef, prevRef } = montarConsultaPlanTP(req.query);
  const total = db.prepare(`SELECT COUNT(*) cc ${FROM} ${where}`).get(...params).cc;
  const itens = db.prepare(
    `${SELECT} ${FROM} ${where} ORDER BY descricao_item COLLATE NOCASE LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  res.json({ total, dataReferencia: dataRef, dataAnterior: prevRef, itens, page, pageSize: limit });
});

// Exporta a aba Planejamento TP em Excel (.xlsx), respeitando os filtros ativos.
router.get('/planejamento-tp/exportar', (req, res) => {
  const { FROM, where, params, SELECT, dataRef } = montarConsultaPlanTP(req.query);
  const itens = db.prepare(`${SELECT} ${FROM} ${where} ORDER BY descricao_item COLLATE NOCASE`).all(...params);

  const linhas = itens.map((i) => ({
    'Novo': i.is_novo ? 'Sim' : '',
    'Código SCODES': i.codigo || '',
    'SIAFÍSICO': i.siafisico || '',
    'Descrição do Item': i.descricao_item || '',
    'Demanda Total': i.demanda_total != null ? i.demanda_total : '',
    'Dose Certa': i.clas_dose_certa || '',
    'Doença Rara': i.clas_doenca_rara || '',
    'Unid. Fornecimento': i.clas_unidade_fornecimento || '',
    'Emb. Conversão': i.clas_embalagem_conversao != null ? i.clas_embalagem_conversao : '',
    'SubCategoria': i.clas_subcategoria || '',
    'Responsável Aquisição': i.clas_responsavel_aquisicao || '',
    'Inex': i.clas_inex || '',
    'Outros Programas': i.clas_outros_programas || '',
    'Qual Programa': i.clas_qual_programa || '',
  }));

  const ws = XLSX.utils.json_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Planejamento TP');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const nome = `Planejamento_TP_${(dataRef || 'sem-data').replace(/-/g, '')}.xlsx`;
  res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Categorias presentes no universo TP (para o filtro da aba Planejamento TP).
router.get('/planejamento-tp/categorias', (req, res) => {
  const cats = db.prepare(
    `SELECT DISTINCT categoria v FROM estoque_itens
     WHERE data_referencia = (SELECT MAX(data_referencia) FROM estoque_itens)
       AND (unidade IS NULL OR unidade LIKE '%Tenente Pena%')
       AND categoria IS NOT NULL AND categoria <> ''
     ORDER BY v`
  ).all().map((r) => r.v);
  const responsaveis = db.prepare(
    `SELECT DISTINCT responsavel_aquisicao v FROM item_classificacao
     WHERE responsavel_aquisicao IS NOT NULL AND responsavel_aquisicao <> '' ORDER BY v`
  ).all().map((r) => r.v);
  const subcategorias = db.prepare(
    `SELECT DISTINCT subcategoria v FROM item_classificacao
     WHERE subcategoria IS NOT NULL AND subcategoria <> '' ORDER BY v`
  ).all().map((r) => r.v);
  res.json({ categorias: cats, responsaveis, subcategorias });
});

module.exports = router;
module.exports.importarRelatorioItensDeBuffer = importarRelatorioItensDeBuffer;
module.exports.importarStatusSiafisicoDeBuffer = importarStatusSiafisicoDeBuffer;
module.exports.importarRelatorioItensDeLinhas = importarRelatorioItensDeLinhas;
module.exports.executarAtualizacaoRelatorioItensOracle = executarAtualizacaoRelatorioItensOracle;
