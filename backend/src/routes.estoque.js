const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('./db');
const { autenticar, exigirPerfil } = require('./auth');

const router = express.Router();
router.use(autenticar);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// Status de compra considerados "em aberto" (compra ainda não concluída)
const STATUS_EM_ABERTO = ['Planejamento', 'Adjucado', 'Empenhado', 'Entrega Parcial'];

// Posições das colunas no relatório "Itens em Estoque UDTP" (cabeçalho na linha 6, dados a partir da 7)
const COL = {
  unidade: 0, categoria: 1, controlado: 2, tipo_item: 3, marca: 4, importado: 5,
  outras_demandas: 6, intercambiaveis: 7, id_item: 8, codigo: 9, descricao: 10,
  siafisico: 11, descritivo_siafisico: 12, data_revisao_siafi: 13, demandas: 14,
  demandas_cf: 15, demandas_jefaz: 16, demandas_aj: 17, consumo_mensal_total: 18,
  consumo_mensal_cf: 19, consumo_mensal_jefaz: 20, consumo_mensal_aj: 21,
  estoque: 22, autonomia: 23, custo_unitario: 24, valor_medio_unitario: 25,
  catmat: 26, lotes: 27,
};

function limpar(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  if (typeof v === 'number') return v;
  return v;
}

function texto(v) {
  const l = limpar(v);
  return l === null ? null : String(l).trim();
}

function numero(v) {
  const l = limpar(v);
  if (l === null) return null;
  const n = typeof l === 'number' ? l : parseFloat(String(l).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Lê o relatório de estoque e retorna {linhas, dataReferencia, nomeAba}
function processarEstoque(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const nomeAba = wb.SheetNames[0];
  const sheet = wb.Sheets[nomeAba];
  const linhasBrutas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

  // Localiza a linha de cabeçalho (a que contém "Código" e "Descrição do Item")
  let linhaCabecalho = -1;
  for (let i = 0; i < Math.min(linhasBrutas.length, 15); i++) {
    const linha = (linhasBrutas[i] || []).map((c) => String(c ?? '').toLowerCase());
    if (linha.includes('código') && linha.some((c) => c.includes('descrição do item'))) {
      linhaCabecalho = i;
      break;
    }
  }
  if (linhaCabecalho === -1) {
    throw new Error('Não reconheci o layout do relatório de estoque (não encontrei a linha de cabeçalho com "Código" e "Descrição do Item").');
  }

  const linhas = [];
  for (let i = linhaCabecalho + 1; i < linhasBrutas.length; i++) {
    const r = linhasBrutas[i];
    if (!r) continue;
    const codigo = texto(r[COL.codigo]);
    if (!codigo) continue;

    linhas.push({
      codigo_item: codigo,
      id_item_origem: texto(r[COL.id_item]),
      descricao: texto(r[COL.descricao]),
      siafisico: texto(r[COL.siafisico]),
      catmat: texto(r[COL.catmat]),
      categoria: texto(r[COL.categoria]),
      controlado: texto(r[COL.controlado]),
      tipo_item: texto(r[COL.tipo_item]),
      marca: texto(r[COL.marca]),
      importado: texto(r[COL.importado]),
      outras_demandas: texto(r[COL.outras_demandas]),
      demandas: numero(r[COL.demandas]),
      demandas_aj: numero(r[COL.demandas_aj]),
      consumo_mensal_total: numero(r[COL.consumo_mensal_total]),
      consumo_mensal_aj: numero(r[COL.consumo_mensal_aj]),
      estoque: numero(r[COL.estoque]),
      autonomia: numero(r[COL.autonomia]),
      custo_unitario: numero(r[COL.custo_unitario]),
      valor_medio_unitario: numero(r[COL.valor_medio_unitario]),
      lotes: texto(r[COL.lotes]),
    });
  }

  // Tenta extrair a data do nome da aba (ex: Rel_ItensEmEstoque_16022024_104 -> 2024-02-16)
  let dataReferencia = null;
  const m = nomeAba.match(/(\d{2})(\d{2})(\d{4})/);
  if (m) dataReferencia = `${m[3]}-${m[2]}-${m[1]}`;

  return { linhas, dataReferencia, nomeAba };
}

// ---------- Prévia da importação (não grava) ----------
router.post('/importar/previa', exigirPerfil('admin'), upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie o arquivo .xlsx do relatório de estoque.' });

  let resultado;
  try {
    resultado = processarEstoque(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ erro: e.message });
  }

  const { linhas, dataReferencia, nomeAba } = resultado;
  const jaImportado = dataReferencia
    ? db.prepare('SELECT id FROM estoque_importacoes WHERE data_referencia = ?').get(dataReferencia)
    : null;

  res.json({
    nomeAba,
    dataReferenciaDetectada: dataReferencia,
    totalLinhas: linhas.length,
    jaExisteImportacaoNestaData: !!jaImportado,
    amostra: linhas.slice(0, 5),
  });
});

// ---------- Confirma a importação diária ----------
router.post('/importar/confirmar', exigirPerfil('admin'), upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie o arquivo .xlsx do relatório de estoque.' });

  let resultado;
  try {
    resultado = processarEstoque(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ erro: e.message });
  }

  const { linhas } = resultado;
  // Data de referência: usa a informada pelo usuário, ou a detectada, ou hoje
  const dataReferencia = (req.body.data_referencia || resultado.dataReferencia || new Date().toISOString().slice(0, 10)).slice(0, 10);

  // Se já houver importação nesta data, substitui (refaz a foto do dia)
  const existente = db.prepare('SELECT id FROM estoque_importacoes WHERE data_referencia = ?').get(dataReferencia);
  if (existente) {
    db.prepare('DELETE FROM estoque_itens WHERE importacao_id = ?').run(existente.id);
    db.prepare('DELETE FROM estoque_importacoes WHERE id = ?').run(existente.id);
  }

  const infoImp = db.prepare(
    'INSERT INTO estoque_importacoes (data_referencia, nome_arquivo, usuario_email, total_itens) VALUES (?, ?, ?, ?)'
  ).run(dataReferencia, req.file.originalname, req.usuario.email, linhas.length);
  const importacaoId = infoImp.lastInsertRowid;

  const campos = ['importacao_id', 'data_referencia', 'codigo_item', 'id_item_origem', 'descricao',
    'siafisico', 'catmat', 'categoria', 'controlado', 'tipo_item', 'marca', 'importado',
    'outras_demandas', 'demandas',
    'demandas_aj', 'consumo_mensal_total', 'consumo_mensal_aj', 'estoque', 'autonomia',
    'custo_unitario', 'valor_medio_unitario', 'lotes'];
  const stmt = db.prepare(
    `INSERT INTO estoque_itens (${campos.join(',')}) VALUES (${campos.map(() => '?').join(',')})`
  );

  for (const l of linhas) {
    stmt.run(importacaoId, dataReferencia, l.codigo_item, l.id_item_origem, l.descricao,
      l.siafisico, l.catmat, l.categoria, l.controlado, l.tipo_item, l.marca, l.importado,
      l.outras_demandas, l.demandas,
      l.demandas_aj, l.consumo_mensal_total, l.consumo_mensal_aj, l.estoque, l.autonomia,
      l.custo_unitario, l.valor_medio_unitario, l.lotes);
  }

  // Gera alertas a partir desta foto
  const alertasGerados = gerarAlertasEstoque(dataReferencia, importacaoId);

  const resumo = { dataReferencia, totalItens: linhas.length, substituiu: !!existente, ...alertasGerados };

  db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
    .run('estoque', req.file.originalname, req.usuario.email, JSON.stringify(resumo));
  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
    .run(req.usuario.id, req.usuario.email, 'importar_estoque', 'estoque_itens', JSON.stringify(resumo));

  res.json(resumo);
});

// Gera os alertas de estoque para uma data de referência.
// Limpa alertas automáticos de estoque anteriores não resolvidos (para não acumular duplicados a cada importação).
function gerarAlertasEstoque(dataReferencia, importacaoId) {
  const limiar = parseFloat(
    db.prepare("SELECT valor FROM configuracoes WHERE chave = 'autonomia_minima_meses'").get()?.valor || '2'
  );

  // Remove alertas automáticos de estoque ainda abertos (serão regerados a partir da foto mais recente)
  db.prepare("DELETE FROM alertas WHERE tipo IN ('estoque_baixo','estoque_ruptura','compra_aberta_demanda_zero') AND resolvido = 0").run();

  const itens = db.prepare('SELECT * FROM estoque_itens WHERE importacao_id = ?').all(importacaoId);

  // Conjunto de itens com compra em aberto (no controle de compras judiciais)
  const placeholders = STATUS_EM_ABERTO.map(() => '?').join(',');
  const comprasAbertas = new Set(
    db.prepare(`SELECT DISTINCT codigo_item FROM solicitacoes WHERE status IN (${placeholders})`)
      .all(...STATUS_EM_ABERTO).map((r) => r.codigo_item)
  );

  const stmtAlerta = db.prepare(
    'INSERT INTO alertas (tipo, codigo_item, mensagem) VALUES (?, ?, ?)'
  );

  let estoqueBaixo = 0, ruptura = 0, compraDemandaZero = 0;

  for (const it of itens) {
    const estoque = it.estoque ?? 0;
    const autonomia = it.autonomia ?? 0;
    const demanda = it.demandas ?? 0;
    const temCompraAberta = comprasAbertas.has(it.codigo_item);

    // Ruptura: estoque zerado mas com demanda (consumo) — crítico
    if (estoque <= 0 && demanda > 0) {
      const sufixo = temCompraAberta ? ' Há compra em aberto no controle judicial.' : ' NÃO há compra em aberto registrada.';
      stmtAlerta.run('estoque_ruptura', it.codigo_item,
        `RUPTURA: "${it.descricao}" (${it.codigo_item}) está com estoque ZERO e demanda de ${demanda}.${sufixo}`);
      ruptura++;
    }
    // Estoque baixo por autonomia: ainda tem estoque, mas abaixo do limiar de meses
    else if (estoque > 0 && autonomia > 0 && autonomia <= limiar) {
      const sufixo = temCompraAberta ? ' Já existe compra em aberto.' : ' Não há compra em aberto — avaliar nova aquisição.';
      stmtAlerta.run('estoque_baixo', it.codigo_item,
        `ESTOQUE BAIXO: "${it.descricao}" (${it.codigo_item}) tem autonomia de ${autonomia} mês(es), abaixo do limite de ${limiar}.${sufixo}`);
      estoqueBaixo++;
    }

    // Compra em aberto, mas demanda zero no estoque — possível compra a revisar
    if (temCompraAberta && demanda === 0) {
      stmtAlerta.run('compra_aberta_demanda_zero', it.codigo_item,
        `REVISAR COMPRA: "${it.descricao}" (${it.codigo_item}) tem compra em aberto no controle judicial, mas está com demanda ZERO no relatório de estoque.`);
      compraDemandaZero++;
    }
  }

  return { alertasEstoqueBaixo: estoqueBaixo, alertasRuptura: ruptura, alertasCompraDemandaZero: compraDemandaZero, limiarUsado: limiar };
}

// ---------- Consulta do estoque do dia (mais recente ou data específica) ----------
// Valores distintos de cada coluna filtrável, para montar os menus suspensos.
// Considera a data informada (ou a mais recente).
router.get('/filtros', (req, res) => {
  let dataRef = req.query.data;
  if (!dataRef) {
    const ultima = db.prepare('SELECT data_referencia FROM estoque_importacoes ORDER BY data_referencia DESC LIMIT 1').get();
    if (!ultima) return res.json({ categoria: [], controlado: [], tipo_item: [], marca: [], importado: [], outras_demandas: [] });
    dataRef = ultima.data_referencia;
  }
  const colunas = ['categoria', 'controlado', 'tipo_item', 'marca', 'importado', 'outras_demandas'];
  const resultado = {};
  for (const col of colunas) {
    resultado[col] = db.prepare(
      `SELECT DISTINCT ${col} v FROM estoque_itens WHERE data_referencia = ? AND ${col} IS NOT NULL AND ${col} <> '' ORDER BY v`
    ).all(dataRef).map((r) => r.v);
  }
  res.json(resultado);
});

router.get('/', (req, res) => {
  const { data, q, situacao, page = 1, pageSize = 50,
    categoria, controlado, tipo_item, marca, importado, outras_demandas } = req.query;

  // Determina a data de referência: a informada, ou a mais recente importada
  let dataRef = data;
  if (!dataRef) {
    const ultima = db.prepare('SELECT data_referencia FROM estoque_importacoes ORDER BY data_referencia DESC LIMIT 1').get();
    if (!ultima) return res.json({ dataReferencia: null, itens: [], total: 0, datasDisponiveis: [] });
    dataRef = ultima.data_referencia;
  }

  const limiar = parseFloat(
    db.prepare("SELECT valor FROM configuracoes WHERE chave = 'autonomia_minima_meses'").get()?.valor || '2'
  );

  const condicoes = ['e.data_referencia = ?'];
  const params = [dataRef];

  if (q) {
    condicoes.push('(e.descricao LIKE ? OR e.codigo_item LIKE ? OR e.siafisico LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (situacao === 'ruptura') condicoes.push('(e.estoque <= 0 AND e.demandas > 0)');
  if (situacao === 'baixo') condicoes.push('(e.estoque > 0 AND e.autonomia > 0 AND e.autonomia <= ' + limiar + ')');
  if (situacao === 'zerado') condicoes.push('e.estoque <= 0');

  // Filtros por coluna (menus suspensos). Cada um casa pelo valor exato escolhido.
  const filtrosColuna = { categoria, controlado, tipo_item, marca, importado, outras_demandas };
  for (const [coluna, valor] of Object.entries(filtrosColuna)) {
    if (valor) {
      condicoes.push(`e.${coluna} = ?`);
      params.push(valor);
    }
  }

  const where = `WHERE ${condicoes.join(' AND ')}`;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const total = db.prepare(`SELECT COUNT(*) c FROM estoque_itens e ${where}`).get(...params).c;

  // Marca quais itens têm compra em aberto (join leve por código)
  const placeholders = STATUS_EM_ABERTO.map(() => '?').join(',');
  const itens = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM solicitacoes s WHERE s.codigo_item = e.codigo_item AND s.status IN (${placeholders})) AS compras_abertas
    FROM estoque_itens e
    ${where}
    ORDER BY (e.estoque <= 0 AND e.demandas > 0) DESC, e.autonomia ASC, e.descricao
    LIMIT ? OFFSET ?
  `).all(...STATUS_EM_ABERTO, ...params, limit, offset);

  const datasDisponiveis = db.prepare('SELECT data_referencia, total_itens FROM estoque_importacoes ORDER BY data_referencia DESC').all();

  res.json({ dataReferencia: dataRef, limiarAutonomia: limiar, total, itens, page: Number(page), pageSize: limit, datasDisponiveis });
});

// ---------- Resumo (cards) do estoque do dia ----------
router.get('/resumo', (req, res) => {
  const ultima = db.prepare('SELECT data_referencia FROM estoque_importacoes ORDER BY data_referencia DESC LIMIT 1').get();
  if (!ultima) return res.json({ dataReferencia: null });

  const dataRef = ultima.data_referencia;
  const limiar = parseFloat(
    db.prepare("SELECT valor FROM configuracoes WHERE chave = 'autonomia_minima_meses'").get()?.valor || '2'
  );

  const totalItens = db.prepare('SELECT COUNT(*) c FROM estoque_itens WHERE data_referencia = ?').get(dataRef).c;
  const ruptura = db.prepare('SELECT COUNT(*) c FROM estoque_itens WHERE data_referencia = ? AND estoque <= 0 AND demandas > 0').get(dataRef).c;
  const baixo = db.prepare('SELECT COUNT(*) c FROM estoque_itens WHERE data_referencia = ? AND estoque > 0 AND autonomia > 0 AND autonomia <= ?').get(dataRef, limiar).c;
  const zerado = db.prepare('SELECT COUNT(*) c FROM estoque_itens WHERE data_referencia = ? AND estoque <= 0').get(dataRef).c;
  const valorTotal = db.prepare('SELECT SUM(estoque * COALESCE(valor_medio_unitario, custo_unitario, 0)) v FROM estoque_itens WHERE data_referencia = ?').get(dataRef).v;

  res.json({ dataReferencia: dataRef, limiarAutonomia: limiar, totalItens, ruptura, baixo, zerado, valorTotalEstoque: valorTotal });
});

// ---------- Detalhe de um item: situação de estoque + compras judiciais ----------
router.get('/item/:codigo', (req, res) => {
  const codigo = req.params.codigo;

  const ultima = db.prepare('SELECT data_referencia FROM estoque_importacoes ORDER BY data_referencia DESC LIMIT 1').get();
  const estoqueAtual = ultima
    ? db.prepare('SELECT * FROM estoque_itens WHERE codigo_item = ? AND data_referencia = ?').get(codigo, ultima.data_referencia)
    : null;

  // Evolução do estoque ao longo do tempo (histórico)
  const historicoEstoque = db.prepare(
    'SELECT data_referencia, estoque, autonomia, demandas, consumo_mensal_total FROM estoque_itens WHERE codigo_item = ? ORDER BY data_referencia'
  ).all(codigo);

  // Compras judiciais do item
  const compras = db.prepare(`
    SELECT ano, mes, modalidade_compra, n_oficio, n_empenho, qtde_solicitada,
           quantidade_empenho, data_previsao_entrega, data_entrega, status
    FROM solicitacoes WHERE codigo_item = ?
    ORDER BY ano,
      CASE mes WHEN 'Janeiro' THEN 1 WHEN 'Fevereiro' THEN 2 WHEN 'Março' THEN 3 WHEN 'Abril' THEN 4
        WHEN 'Maio' THEN 5 WHEN 'Junho' THEN 6 WHEN 'Julho' THEN 7 WHEN 'Agosto' THEN 8
        WHEN 'Setembro' THEN 9 WHEN 'Outubro' THEN 10 WHEN 'Novembro' THEN 11 WHEN 'Dezembro' THEN 12 END
  `).all(codigo);

  const temCompraAberta = compras.some((c) => STATUS_EM_ABERTO.includes(c.status));

  res.json({ codigo, estoqueAtual, historicoEstoque, compras, temCompraAberta });
});

module.exports = router;
