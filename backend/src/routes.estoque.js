const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('./db');
const { autenticar, exigirPerfil } = require('./auth');
const { referenciaParaColeta } = require('./diasUteis');

const router = express.Router();
router.use(autenticar);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// Status de compra considerados "em aberto" (compra ainda não concluída)
const STATUS_EM_ABERTO = ['Planejamento', 'Adjudicado', 'Empenhado', 'Entrega Parcial'];

// Divide o estoque por escopo de unidade dispensadora:
//   'udtp'  → UD 01 - Tenente Pena (inclui linhas antigas sem unidade preenchida)
//   'geral' → TODAS as unidades, incluindo a UD 01 - Tenente Pena (sem restrição)
// Retorna a condição SQL (com o prefixo de coluna informado, ex.: 'e.') ou null.
function condEscopoUnidade(escopo, pfx = '') {
  if (escopo === 'udtp') return `(${pfx}unidade IS NULL OR ${pfx}unidade LIKE '%Tenente Pena%')`;
  return null; // 'geral' (e demais): sem filtro de unidade → todas, incluindo a Tenente Pena
}

// Normaliza um texto de cabeçalho: minúsculas, sem acento, sem underscore,
// espaços colapsados. Usado para casar colunas pelo NOME (robusto a mudanças
// de posição/ordem das colunas no relatório).
function normalizarCabecalho(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
    .replace(/_/g, ' ')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// Para cada campo, o(s) nome(s) de cabeçalho aceitos (já normalizados).
// O casamento é por igualdade exata (evita confundir "estoque" com
// "estoque vencido", ou "demandas" com "demandas aj").
const MAPA_CABECALHOS = {
  unidade: ['unidade dispensadora'],
  categoria: ['categoria'],
  controlado: ['controlado'],
  tipo_item: ['tipo item'],
  marca: ['marca'],
  importado: ['importado'],
  outras_demandas: ['outras demandas'],
  id_item: ['id item'],
  codigo: ['codigo'],
  descricao: ['descricao do item'],
  siafisico: ['siafisico'],
  demandas: ['demandas'],
  demandas_aj: ['demandas aj'],
  consumo_mensal_total: ['consumo mensal total'],
  consumo_mensal_aj: ['consumo mensal aj'],
  demandas_cf: ['demandas cf'],
  consumo_mensal_cf: ['consumo mensal cf'],
  demandas_jefaz: ['demandas jefaz'],
  consumo_mensal_jefaz: ['consumo mensal jefaz'],
  estoque: ['estoque'],
  autonomia: ['autonomia'],
  custo_unitario: ['custo unitario'],
  valor_medio_unitario: ['valor medio unitario'],
  catmat: ['catmat'],
  lotes: ['lotes'],
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

// Converte número no formato brasileiro: ponto = separador de milhar,
// vírgula = decimal. Ex.: "5,48" -> 5.48 ; "3.092.580" -> 3092580 ; "7,1572" -> 7.1572
function numero(v) {
  const l = limpar(v);
  if (l === null) return null;
  if (typeof l === 'number') return l;
  let s = String(l).trim();
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.'); // remove milhares, vírgula vira ponto
  } else {
    s = s.replace(/\./g, ''); // sem vírgula: pontos são separador de milhar
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Lê o relatório de estoque e retorna {linhas, dataReferencia, nomeAba}
function processarEstoque(buffer) {
  // raw:true preserva os valores como texto (evita o SheetJS interpretar
  // "5,48" como 548 — vírgula como milhar no padrão americano)
  const wb = XLSX.read(buffer, { type: 'buffer', raw: true });
  const nomeAba = wb.SheetNames[0];
  const sheet = wb.Sheets[nomeAba];
  const linhasBrutas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });

  // Localiza a linha de cabeçalho (a que contém "Código" e "Descrição do Item")
  let linhaCabecalho = -1;
  for (let i = 0; i < Math.min(linhasBrutas.length, 15); i++) {
    const linha = (linhasBrutas[i] || []).map(normalizarCabecalho);
    if (linha.includes('codigo') && linha.includes('descricao do item')) {
      linhaCabecalho = i;
      break;
    }
  }
  if (linhaCabecalho === -1) {
    throw new Error('Não reconheci o layout do relatório de estoque (não encontrei a linha de cabeçalho com "Código" e "Descrição do Item").');
  }

  // Mapeia cada campo para o índice da coluna pelo NOME do cabeçalho
  const cabecalhoNorm = (linhasBrutas[linhaCabecalho] || []).map(normalizarCabecalho);
  const COL = {};
  for (const [campo, nomes] of Object.entries(MAPA_CABECALHOS)) {
    COL[campo] = cabecalhoNorm.findIndex((c) => nomes.includes(c));
  }
  if (COL.codigo === -1 || COL.descricao === -1) {
    throw new Error('Não encontrei as colunas obrigatórias "Código" e/ou "Descrição do Item" no relatório.');
  }
  // helper: lê a célula só se a coluna existe no arquivo
  const cel = (r, campo) => (COL[campo] >= 0 ? r[COL[campo]] : null);

  const linhas = [];
  for (let i = linhaCabecalho + 1; i < linhasBrutas.length; i++) {
    const r = linhasBrutas[i];
    if (!r) continue;
    const codigo = texto(cel(r, 'codigo'));
    if (!codigo) continue;

    linhas.push({
      codigo_item: codigo,
      id_item_origem: texto(cel(r, 'id_item')),
      descricao: texto(cel(r, 'descricao')),
      siafisico: texto(cel(r, 'siafisico')),
      catmat: texto(cel(r, 'catmat')),
      unidade: texto(cel(r, 'unidade')),
      categoria: texto(cel(r, 'categoria')),
      controlado: texto(cel(r, 'controlado')),
      tipo_item: texto(cel(r, 'tipo_item')),
      marca: texto(cel(r, 'marca')),
      importado: texto(cel(r, 'importado')),
      outras_demandas: texto(cel(r, 'outras_demandas')),
      demandas: numero(cel(r, 'demandas')),
      demandas_aj: numero(cel(r, 'demandas_aj')),
      consumo_mensal_total: numero(cel(r, 'consumo_mensal_total')),
      consumo_mensal_aj: numero(cel(r, 'consumo_mensal_aj')),
      demandas_cf: numero(cel(r, 'demandas_cf')),
      consumo_mensal_cf: numero(cel(r, 'consumo_mensal_cf')),
      demandas_jefaz: numero(cel(r, 'demandas_jefaz')),
      consumo_mensal_jefaz: numero(cel(r, 'consumo_mensal_jefaz')),
      estoque: numero(cel(r, 'estoque')),
      autonomia: numero(cel(r, 'autonomia')),
      custo_unitario: numero(cel(r, 'custo_unitario')),
      valor_medio_unitario: numero(cel(r, 'valor_medio_unitario')),
      lotes: texto(cel(r, 'lotes')),
    });
  }

  // Tenta extrair a data do nome da aba (ex: Rel_ItensEmEstoque_16022024_104 -> 2024-02-16)
  let dataReferencia = null;
  const m = nomeAba.match(/(\d{2})(\d{2})(\d{4})/);
  if (m) dataReferencia = `${m[3]}-${m[2]}-${m[1]}`;

  return { linhas, dataReferencia, nomeAba };
}

// ---------- Prévia da importação (não grava) ----------
router.post('/importar/previa', upload.single('arquivo'), (req, res) => {
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

// Importa o estoque a partir de um buffer de arquivo (xlsx/csv) e grava tudo.
// Usada tanto pela rota de importação quanto pelo vigia de arquivo automático.
function importarEstoqueDeBuffer(buffer, opcoes = {}) {
  const resultado = processarEstoque(buffer);
  return importarEstoqueDeLinhas(resultado.linhas, {
    dataReferencia: opcoes.dataReferencia || resultado.dataReferencia,
    ...opcoes,
  });
}

// Grava a foto do estoque a partir de linhas já mapeadas (objetos com as
// chaves de MAPA_CABECALHOS): substitui a foto do dia, gera alertas,
// arquiva histórico (01/15) e limpa. Usada tanto pelo CSV quanto pelo
// atualizador via Oracle.
function importarEstoqueDeLinhas(linhas, opcoes = {}) {
  const dataReferencia = (opcoes.dataReferencia || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const nomeArquivo = opcoes.nomeArquivo || 'estoque';
  const usuarioEmail = opcoes.usuarioEmail || 'sistema';
  const usuarioId = opcoes.usuarioId ?? null;

  // Tudo numa única transação: apagar/inserir/arquivar/limpar em passos
  // separados (sem transação) podia deixar o banco num estado parcial se
  // uma etapa falhasse ou o processo fosse interrompido no meio — aí a
  // linha "pai" (estoque_importacoes) e as linhas "filhas" (estoque_itens)
  // ficavam dessincronizadas, causando "FOREIGN KEY constraint failed" na
  // sincronização seguinte. Com BEGIN/COMMIT, se qualquer passo falhar,
  // tudo volta atrás e o banco nunca fica inconsistente.
  let resumo;
  db.exec('BEGIN');
  try {
    // Se já houver importação nesta data (e ainda não for um snapshot
    // histórico arquivado), substitui (refaz a foto do dia). Snapshots
    // arquivados (dias 01/15) nunca são apagados aqui.
    const existente = db.prepare('SELECT id FROM estoque_importacoes WHERE data_referencia = ? AND arquivado = 0').get(dataReferencia);
    if (existente) {
      db.prepare('DELETE FROM estoque_itens WHERE importacao_id = ?').run(existente.id);
      db.prepare('DELETE FROM estoque_importacoes WHERE id = ?').run(existente.id);
    }

    const infoImp = db.prepare(
      'INSERT INTO estoque_importacoes (data_referencia, nome_arquivo, usuario_email, total_itens) VALUES (?, ?, ?, ?)'
    ).run(dataReferencia, nomeArquivo, usuarioEmail, linhas.length);
    const importacaoId = infoImp.lastInsertRowid;

    const campos = ['importacao_id', 'data_referencia', 'codigo_item', 'id_item_origem', 'descricao',
      'siafisico', 'catmat', 'unidade', 'categoria', 'controlado', 'tipo_item', 'marca', 'importado',
      'outras_demandas', 'demandas',
      'demandas_aj', 'consumo_mensal_total', 'consumo_mensal_aj',
      'demandas_cf', 'consumo_mensal_cf', 'demandas_jefaz', 'consumo_mensal_jefaz',
      'estoque', 'autonomia',
      'custo_unitario', 'valor_medio_unitario', 'lotes'];
    const stmt = db.prepare(
      `INSERT INTO estoque_itens (${campos.join(',')}) VALUES (${campos.map(() => '?').join(',')})`
    );

    for (const l of linhas) {
      // undefined não pode ser vinculado no SQLite; normaliza para null.
      const v = (x) => (x === undefined ? null : x);
      stmt.run(importacaoId, dataReferencia, v(l.codigo_item), v(l.id_item_origem), v(l.descricao),
        v(l.siafisico), v(l.catmat), v(l.unidade), v(l.categoria), v(l.controlado), v(l.tipo_item), v(l.marca), v(l.importado),
        v(l.outras_demandas), v(l.demandas),
        v(l.demandas_aj), v(l.consumo_mensal_total), v(l.consumo_mensal_aj),
        v(l.demandas_cf), v(l.consumo_mensal_cf), v(l.demandas_jefaz), v(l.consumo_mensal_jefaz),
        v(l.estoque), v(l.autonomia),
        v(l.custo_unitario), v(l.valor_medio_unitario), v(l.lotes));
    }

    // Gera alertas a partir desta foto
    const alertasGerados = gerarAlertasEstoque(dataReferencia, importacaoId);

    // ----- Arquivamento histórico (regra do 1º dia útil para 01 e 15) -----
    const jaArquivadas = new Set(
      db.prepare("SELECT referencia_historica FROM estoque_importacoes WHERE arquivado = 1 AND referencia_historica IS NOT NULL")
        .all().map((r) => r.referencia_historica)
    );
    const referencia = referenciaParaColeta(dataReferencia, jaArquivadas);
    if (referencia) {
      db.prepare('UPDATE estoque_importacoes SET arquivado = 1, referencia_historica = ? WHERE id = ?')
        .run(referencia, importacaoId);
    }

    // ----- Limpeza: mantém só os snapshots históricos (01/15) + o estoque atual -----
    const atual = db.prepare('SELECT id FROM estoque_importacoes ORDER BY data_referencia DESC, id DESC LIMIT 1').get();
    const descartar = db.prepare('SELECT id FROM estoque_importacoes WHERE arquivado = 0 AND id != ?').all(atual.id);
    const delItens = db.prepare('DELETE FROM estoque_itens WHERE importacao_id = ?');
    const delImp = db.prepare('DELETE FROM estoque_importacoes WHERE id = ?');
    for (const r of descartar) { delItens.run(r.id); delImp.run(r.id); }

    resumo = {
      dataReferencia,
      totalItens: linhas.length,
      substituiu: !!existente,
      arquivadoComoHistorico: referencia || null,
      snapshotsDescartados: descartar.length,
      ...alertasGerados,
    };

    db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
      .run('estoque', nomeArquivo, usuarioEmail, JSON.stringify(resumo));
    db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
      .run(usuarioId, usuarioEmail, 'importar_estoque', 'estoque_itens', JSON.stringify(resumo));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return resumo;
}

// ---------- Confirma a importação diária ----------
router.post('/importar/confirmar', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie o arquivo .xlsx do relatório de estoque.' });
  try {
    const resumo = importarEstoqueDeBuffer(req.file.buffer, {
      dataReferencia: req.body.data_referencia,
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
const estadoOracleEstoque = { rodando: false, inicio: null, ultimoResumo: null, ultimoErro: null };

// Executa a atualização e ESPERA terminar (devolve a Promise). Usado pelo
// agendador diário, que precisa saber quando terminou para encadear a
// próxima atualização (Autores) em seguida.
function executarAtualizacaoEstoqueOracle(opcoes = {}) {
  if (estadoOracleEstoque.rodando) return Promise.resolve({ pulou: true, motivo: 'já em andamento' });
  const { atualizarEstoqueViaOracle } = require('../oracle/sync-estoque');
  estadoOracleEstoque.rodando = true;
  estadoOracleEstoque.inicio = new Date().toISOString();
  estadoOracleEstoque.ultimoErro = null;

  return atualizarEstoqueViaOracle(opcoes)
    .then((resumo) => {
      estadoOracleEstoque.ultimoResumo = { ...resumo, fim: new Date().toISOString() };
      console.log(`[SYNC ESTOQUE] Concluido via Oracle: ${resumo.totalItens} itens em ${Math.round((resumo.duracaoMs || 0) / 1000)}s.`);
      return resumo;
    })
    .catch((e) => {
      estadoOracleEstoque.ultimoErro = e.message;
      console.error('[SYNC ESTOQUE] Falha via Oracle:', e.message);
      require('./emailAlerta').enviarAlertaFalhaSincronizacao('Estoque', e.message);
      throw e;
    })
    .finally(() => { estadoOracleEstoque.rodando = false; });
}

// Dispara a atualização em segundo plano (não espera terminar). Usado pelo
// botão (rota abaixo) — não trava a resposta do navegador.
function iniciarAtualizacaoEstoqueOracle(opcoes = {}) {
  if (estadoOracleEstoque.rodando) return { iniciado: false, jaRodando: true };
  executarAtualizacaoEstoqueOracle(opcoes).catch(() => {}); // erro já registrado em estadoOracleEstoque
  return { iniciado: true, jaRodando: false };
}

// Botão "Atualizar via Oracle": dispara e responde na hora.
router.post('/atualizar-oracle', exigirPerfil('admin'), (req, res) => {
  const r = iniciarAtualizacaoEstoqueOracle({ usuarioEmail: req.usuario.email, usuarioId: req.usuario.id });
  if (!r.iniciado) {
    return res.status(409).json({ erro: 'Já existe uma atualização via Oracle em andamento.', ...estadoOracleEstoque });
  }
  res.json({ iniciado: true, inicio: estadoOracleEstoque.inicio });
});

// A tela consulta este status a cada poucos segundos para saber quando terminou.
router.get('/atualizar-oracle/status', (req, res) => {
  res.json(estadoOracleEstoque);
});

// Gera os alertas de estoque para uma data de referência.
// Limpa alertas automáticos de estoque anteriores não resolvidos (para não acumular duplicados a cada importação).
function gerarAlertasEstoque(dataReferencia, importacaoId) {
  const limiar = parseFloat(
    db.prepare("SELECT valor FROM configuracoes WHERE chave = 'autonomia_minima_meses'").get()?.valor || '2'
  );

  // Remove alertas automáticos de estoque ainda abertos (serão regerados a partir da foto mais recente)
  db.prepare("DELETE FROM alertas WHERE tipo IN ('estoque_baixo','estoque_ruptura','compra_aberta_demanda_zero','siafisico_duplicado') AND resolvido = 0").run();

  // Alertas cruzam estoque × compras judiciais (que são do Tenente Pena),
  // por isso só geramos alertas para os itens da UD 01 - Tenente Pena.
  const itens = db.prepare(
    `SELECT * FROM estoque_itens WHERE importacao_id = ? AND ${condEscopoUnidade('udtp')}`
  ).all(importacaoId);

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

  // Siafísico duplicado: o MESMO siafísico em mais de um código de item, entre
  // os itens com DEMANDA ATIVA (demandas > 0). Gera UM alerta-resumo; o
  // relatório detalhado sai por /alertas/siafisico-duplicado.
  const dupMap = new Map();
  for (const it of itens) {
    const dem = Number(it.demandas) || 0;
    const s = (it.siafisico || '').trim();
    if (dem > 0 && s) {
      if (!dupMap.has(s)) dupMap.set(s, new Set());
      dupMap.get(s).add(it.codigo_item);
    }
  }
  // UM alerta-resumo de siafísicos duplicados. O relatório completo (agrupado
  // por siafísico) sai no modal via /alertas/siafisico-duplicado.
  const dupEntries = [...dupMap.entries()].filter(([, set]) => set.size > 1);
  const siafisicoDuplicado = dupEntries.length;
  if (siafisicoDuplicado > 0) {
    const nItens = dupEntries.reduce((a, [, set]) => a + set.size, 0);
    stmtAlerta.run('siafisico_duplicado', null,
      `${siafisicoDuplicado} siafísico(s) com DEMANDA ATIVA aparecem em mais de um código de item no Estoque Tenente Pena (${nItens} itens envolvidos). Abra o relatório para revisar.`);
  }

  return { alertasEstoqueBaixo: estoqueBaixo, alertasRuptura: ruptura, alertasCompraDemandaZero: compraDemandaZero, siafisicoDuplicado, limiarUsado: limiar };
}

// ---------- Consulta do estoque do dia (mais recente ou data específica) ----------
// Valores distintos de cada coluna filtrável, para montar os menus suspensos.
// Considera a data informada (ou a mais recente).
router.get('/filtros', (req, res) => {
  let dataRef = req.query.data;
  if (!dataRef) {
    const ultima = db.prepare('SELECT data_referencia FROM estoque_importacoes ORDER BY data_referencia DESC LIMIT 1').get();
    if (!ultima) return res.json({ unidade: [], categoria: [], controlado: [], tipo_item: [], marca: [], importado: [], outras_demandas: [] });
    dataRef = ultima.data_referencia;
  }
  const escCond = condEscopoUnidade(req.query.escopoUnidade);
  const andEsc = escCond ? ' AND ' + escCond : '';
  const colunas = ['unidade', 'categoria', 'controlado', 'tipo_item', 'marca', 'importado', 'outras_demandas'];
  const resultado = {};
  for (const col of colunas) {
    resultado[col] = db.prepare(
      `SELECT DISTINCT ${col} v FROM estoque_itens WHERE data_referencia = ? AND ${col} IS NOT NULL AND ${col} <> ''${andEsc} ORDER BY v`
    ).all(dataRef).map((r) => r.v);
  }
  res.json(resultado);
});

router.get('/', (req, res) => {
  const { data, q, situacao, autonomia, demanda, escopoUnidade, page = 1, pageSize = 50,
    unidade, categoria, controlado, tipo_item, marca, importado, outras_demandas } = req.query;

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

  const escCond = condEscopoUnidade(escopoUnidade, 'e.');
  if (escCond) condicoes.push(escCond);

  if (q) {
    condicoes.push('(e.descricao LIKE ? OR e.codigo_item LIKE ? OR e.siafisico LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (situacao === 'ruptura') condicoes.push('(e.estoque <= 0 AND e.demandas > 0)');
  if (situacao === 'baixo') condicoes.push('(e.estoque > 0 AND e.autonomia > 0 AND e.autonomia <= ' + limiar + ')');
  if (situacao === 'zerado') condicoes.push('e.estoque <= 0');

  // Filtro por faixa de autonomia (meses de cobertura).
  // Considera apenas itens com autonomia preenchida (não nula).
  const FAIXAS_AUTONOMIA = {
    '0': 'e.autonomia = 0',
    '0-1': 'e.autonomia >= 0 AND e.autonomia <= 1',
    '1-2': 'e.autonomia > 1 AND e.autonomia <= 2',
    '2-6': 'e.autonomia > 2 AND e.autonomia <= 6',
    '6mais': 'e.autonomia > 6',
  };
  if (autonomia && FAIXAS_AUTONOMIA[autonomia]) {
    condicoes.push('e.autonomia IS NOT NULL AND (' + FAIXAS_AUTONOMIA[autonomia] + ')');
  }

  // Filtro por demanda: itens com ou sem demanda cadastrada no relatório.
  if (demanda === 'com') condicoes.push('e.demandas IS NOT NULL AND e.demandas > 0');
  if (demanda === 'sem') condicoes.push('(e.demandas IS NULL OR e.demandas = 0)');

  // Filtros por coluna (menus suspensos). Cada um casa pelo valor exato escolhido.
  const filtrosColuna = { categoria, controlado, tipo_item, marca, importado, outras_demandas };
  for (const [coluna, valor] of Object.entries(filtrosColuna)) {
    if (valor) {
      condicoes.push(`e.${coluna} = ?`);
      params.push(valor);
    }
  }

  // Unidade dispensadora aceita VÁRIAS unidades (separadas por vírgula) → IN (...)
  if (unidade) {
    const unidades = String(unidade).split(',').map((u) => u.trim()).filter(Boolean);
    if (unidades.length) {
      condicoes.push(`e.unidade IN (${unidades.map(() => '?').join(',')})`);
      params.push(...unidades);
    }
  }

  const where = `WHERE ${condicoes.join(' AND ')}`;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const total = db.prepare(`SELECT COUNT(*) c FROM estoque_itens e ${where}`).get(...params).c;

  // Marca quais itens têm compra em aberto (join leve por código). A fonte muda
  // conforme o escopo: no GERAL usamos a "Aquisição em Andamento OD"
  // (solicitacoes_od); no Tenente Pena, as compras judiciais (solicitacoes).
  const tabelaCompras = escopoUnidade === 'geral' ? 'solicitacoes_od' : 'solicitacoes';
  const placeholders = STATUS_EM_ABERTO.map(() => '?').join(',');
  // Programas a que o item pertence (para as etiquetas na lista):
  //  • Outras Demandas → relatorio_itens.outras_demandas (foto mais recente)
  //  • Dose Certa / Inex → item_classificacao (classificação permanente)
  const itens = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM ${tabelaCompras} s WHERE s.codigo_item = e.codigo_item AND s.status IN (${placeholders})) AS compras_abertas,
      (SELECT ri.outras_demandas FROM relatorio_itens ri WHERE ri.codigo = e.codigo_item ORDER BY ri.data_referencia DESC LIMIT 1) AS prog_outras_demandas,
      (SELECT ic.dose_certa FROM item_classificacao ic WHERE ic.codigo_item = e.codigo_item) AS prog_dose_certa,
      (SELECT ic.inex FROM item_classificacao ic WHERE ic.codigo_item = e.codigo_item) AS prog_inex,
      (SELECT ic.subcategoria FROM item_classificacao ic WHERE ic.codigo_item = e.codigo_item) AS subcategoria
    FROM estoque_itens e
    ${where}
    ORDER BY e.descricao COLLATE NOCASE ASC, e.unidade COLLATE NOCASE ASC
    LIMIT ? OFFSET ?
  `).all(...STATUS_EM_ABERTO, ...params, limit, offset);

  const datasDisponiveis = db.prepare('SELECT data_referencia, total_itens FROM estoque_importacoes ORDER BY data_referencia DESC').all();

  res.json({ dataReferencia: dataRef, limiarAutonomia: limiar, total, itens, page: Number(page), pageSize: limit, datasDisponiveis });
});

// ---------- Exportar (CSV) o Relatório de Itens em Estoque ----------
// Mesmos filtros da listagem (escopoUnidade TP/geral, busca, unidade, etc.).
// Colunas fixas pedidas: SCODES, Siafísico, Medicamento, Demanda/Consumo (total,
// Judicial=AJ, Adm=CF, Jefaz), Estoque, Autonomia, CATMAT, Valor Médio.
router.get('/exportar', (req, res) => {
  const { data, q, situacao, autonomia, demanda, escopoUnidade,
    unidade, categoria, controlado, tipo_item, marca, importado, outras_demandas } = req.query;

  let dataRef = data;
  if (!dataRef) {
    const ultima = db.prepare('SELECT data_referencia FROM estoque_importacoes ORDER BY data_referencia DESC LIMIT 1').get();
    dataRef = ultima ? ultima.data_referencia : null;
  }
  const limiar = parseFloat(db.prepare("SELECT valor FROM configuracoes WHERE chave = 'autonomia_minima_meses'").get()?.valor || '2');

  const condicoes = ['e.data_referencia = ?'];
  const params = [dataRef];
  const escCond = condEscopoUnidade(escopoUnidade, 'e.');
  if (escCond) condicoes.push(escCond);
  if (q) { condicoes.push('(e.descricao LIKE ? OR e.codigo_item LIKE ? OR e.siafisico LIKE ?)'); const like = `%${q}%`; params.push(like, like, like); }
  if (situacao === 'ruptura') condicoes.push('(e.estoque <= 0 AND e.demandas > 0)');
  if (situacao === 'baixo') condicoes.push('(e.estoque > 0 AND e.autonomia > 0 AND e.autonomia <= ' + limiar + ')');
  if (situacao === 'zerado') condicoes.push('e.estoque <= 0');
  const FX = { '0': 'e.autonomia = 0', '0-1': 'e.autonomia >= 0 AND e.autonomia <= 1', '1-2': 'e.autonomia > 1 AND e.autonomia <= 2', '2-6': 'e.autonomia > 2 AND e.autonomia <= 6', '6mais': 'e.autonomia > 6' };
  if (autonomia && FX[autonomia]) condicoes.push('e.autonomia IS NOT NULL AND (' + FX[autonomia] + ')');
  if (demanda === 'com') condicoes.push('e.demandas IS NOT NULL AND e.demandas > 0');
  if (demanda === 'sem') condicoes.push('(e.demandas IS NULL OR e.demandas = 0)');
  const filtrosColuna = { categoria, controlado, tipo_item, marca, importado, outras_demandas };
  for (const [coluna, valor] of Object.entries(filtrosColuna)) { if (valor) { condicoes.push(`e.${coluna} = ?`); params.push(valor); } }
  if (unidade) { const u = String(unidade).split(',').map((s) => s.trim()).filter(Boolean); if (u.length) { condicoes.push(`e.unidade IN (${u.map(() => '?').join(',')})`); params.push(...u); } }
  const where = dataRef ? `WHERE ${condicoes.join(' AND ')}` : 'WHERE 1 = 0';

  const linhas = db.prepare(`
    SELECT e.unidade, e.codigo_item, e.siafisico, e.descricao, e.categoria,
           (SELECT ic.subcategoria FROM item_classificacao ic WHERE ic.codigo_item = e.codigo_item) AS subcategoria,
           e.demandas, e.consumo_mensal_total, e.estoque, e.autonomia,
           e.demandas_aj, e.consumo_mensal_aj, e.demandas_cf, e.consumo_mensal_cf,
           e.demandas_jefaz, e.consumo_mensal_jefaz, e.catmat, e.valor_medio_unitario
      FROM estoque_itens e ${where}
     ORDER BY e.descricao COLLATE NOCASE ASC, e.unidade COLLATE NOCASE ASC
  `).all(...params);

  const cols = [
    ['unidade', 'Unidade'], ['codigo_item', 'Código SCODES'], ['siafisico', 'Siafísico'], ['descricao', 'Medicamento'],
    ['categoria', 'Categoria'], ['subcategoria', 'Subcategoria'],
    ['demandas', 'Demanda'], ['consumo_mensal_total', 'Consumo'], ['estoque', 'Estoque'], ['autonomia', 'Autonomia'],
    ['demandas_aj', 'Demanda Judicial'], ['consumo_mensal_aj', 'Consumo Judicial'],
    ['demandas_cf', 'Demanda Adm'], ['consumo_mensal_cf', 'Consumo Adm'],
    ['demandas_jefaz', 'Demanda Jefaz'], ['consumo_mensal_jefaz', 'Consumo Jefaz'],
    ['catmat', 'CATMAT'], ['valor_medio_unitario', 'Valor Médio Mensal'],
  ];
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const header = cols.map((c) => esc(c[1])).join(';');
  const corpo = linhas.map((l) => cols.map((c) => esc(l[c[0]])).join(';')).join('\r\n');
  const csv = '﻿' + header + '\r\n' + corpo;

  const sufixo = escopoUnidade === 'geral' ? 'demais_unidades' : 'tenente_pena';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="estoque_${sufixo}_${dataRef || 'sem_data'}.csv"`);
  res.send(csv);
});

// ---------- Resumo (cards) do estoque do dia ----------
router.get('/resumo', (req, res) => {
  const { data, q, situacao, autonomia, demanda, escopoUnidade,
    unidade, categoria, controlado, tipo_item, marca, importado, outras_demandas } = req.query;

  let dataRef = data;
  if (!dataRef) {
    const ultima = db.prepare('SELECT data_referencia FROM estoque_importacoes ORDER BY data_referencia DESC LIMIT 1').get();
    if (!ultima) return res.json({ dataReferencia: null });
    dataRef = ultima.data_referencia;
  }
  const limiar = parseFloat(
    db.prepare("SELECT valor FROM configuracoes WHERE chave = 'autonomia_minima_meses'").get()?.valor || '2'
  );

  // Horário da importação (criado_em é UTC; converte para hora local do servidor).
  const imp = db.prepare("SELECT datetime(criado_em, 'localtime') q FROM estoque_importacoes WHERE data_referencia = ? ORDER BY criado_em DESC LIMIT 1").get(dataRef);
  const dataImportacao = imp ? imp.q : null;

  // Mesmos filtros da listagem (/) — assim os cards batem exatamente com a
  // tabela filtrada (busca por medicamento/SCODES, unidade, categoria, etc.).
  const condicoes = ['e.data_referencia = ?'];
  const params = [dataRef];
  const escCond = condEscopoUnidade(escopoUnidade, 'e.');
  if (escCond) condicoes.push(escCond);
  if (q) {
    condicoes.push('(e.descricao LIKE ? OR e.codigo_item LIKE ? OR e.siafisico LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (situacao === 'ruptura') condicoes.push('(e.estoque <= 0 AND e.demandas > 0)');
  if (situacao === 'baixo') condicoes.push('(e.estoque > 0 AND e.autonomia > 0 AND e.autonomia <= ' + limiar + ')');
  if (situacao === 'zerado') condicoes.push('e.estoque <= 0');
  const FX = { '0': 'e.autonomia = 0', '0-1': 'e.autonomia >= 0 AND e.autonomia <= 1', '1-2': 'e.autonomia > 1 AND e.autonomia <= 2', '2-6': 'e.autonomia > 2 AND e.autonomia <= 6', '6mais': 'e.autonomia > 6' };
  if (autonomia && FX[autonomia]) condicoes.push('e.autonomia IS NOT NULL AND (' + FX[autonomia] + ')');
  if (demanda === 'com') condicoes.push('e.demandas IS NOT NULL AND e.demandas > 0');
  if (demanda === 'sem') condicoes.push('(e.demandas IS NULL OR e.demandas = 0)');
  const filtrosColuna = { categoria, controlado, tipo_item, marca, importado, outras_demandas };
  for (const [coluna, valor] of Object.entries(filtrosColuna)) {
    if (valor) { condicoes.push(`e.${coluna} = ?`); params.push(valor); }
  }
  if (unidade) {
    const u = String(unidade).split(',').map((s) => s.trim()).filter(Boolean);
    if (u.length) { condicoes.push(`e.unidade IN (${u.map(() => '?').join(',')})`); params.push(...u); }
  }
  const where = `WHERE ${condicoes.join(' AND ')}`;

  const totalItens = db.prepare(`SELECT COUNT(*) c FROM estoque_itens e ${where}`).get(...params).c;
  const ruptura = db.prepare(`SELECT COUNT(*) c FROM estoque_itens e ${where} AND e.estoque <= 0 AND e.demandas > 0`).get(...params).c;
  const baixo = db.prepare(`SELECT COUNT(*) c FROM estoque_itens e ${where} AND e.estoque > 0 AND e.autonomia > 0 AND e.autonomia <= ?`).get(...params, limiar).c;
  const zerado = db.prepare(`SELECT COUNT(*) c FROM estoque_itens e ${where} AND e.estoque <= 0`).get(...params).c;
  const valorTotal = db.prepare(`SELECT SUM(e.estoque * COALESCE(e.valor_medio_unitario, e.custo_unitario, 0)) v FROM estoque_itens e ${where}`).get(...params).v;

  // Somas de demanda/consumo por programa (Judicial=AJ, CF/Adm, JEFAZ) sobre o
  // conjunto filtrado — alimentam os cards dinâmicos do Estoque Geral.
  const s = db.prepare(`SELECT
      COALESCE(SUM(e.demandas_aj),0)          dJud, COALESCE(SUM(e.consumo_mensal_aj),0)    cJud,
      COALESCE(SUM(e.demandas_cf),0)          dCf,  COALESCE(SUM(e.consumo_mensal_cf),0)    cCf,
      COALESCE(SUM(e.demandas_jefaz),0)       dJef, COALESCE(SUM(e.consumo_mensal_jefaz),0) cJef
    FROM estoque_itens e ${where}`).get(...params);

  res.json({
    dataReferencia: dataRef, dataImportacao, limiarAutonomia: limiar, totalItens, ruptura, baixo, zerado, valorTotalEstoque: valorTotal,
    judicial: { demanda: s.dJud, consumo: s.cJud },
    cf: { demanda: s.dCf, consumo: s.cCf },
    jefaz: { demanda: s.dJef, consumo: s.cJef },
    total: { demanda: s.dJud + s.dCf + s.dJef, consumo: s.cJud + s.cCf + s.cJef },
  });
});

// ---------- Monitoramento de Estoque (reproduz a planilha "Monitoramento Estoque.xlsm") ----------
// Classifica cada item por autonomia (meses) em faixas fixas — as MESMAS da
// planilha gerencial da CPDAE — e devolve os dados prontos para os 4 painéis:
//   1) contagem de itens por Sub-categoria
//   2) contagem de itens por Status Estoque
//   3) itens por Categoria (rosca)  4) demandas por Categoria (rosca)
// Faixas (coluna "Status Estoque" da planilha), sobre a Autonomia em meses:
//   demanda 0 → Sem Demanda · autonomia 0 → Estoque Zero · <1 → Estoque Baixo ·
//   1–2 → Estoque Crítico · 2–5 → Regular · ≥5 → Abastecido.
function classificarStatusEstoque(demandas, autonomia) {
  const d = Number(demandas) || 0;
  const a = autonomia == null ? null : Number(autonomia);
  if (d === 0) return 'Sem Demanda';
  if (a === 0 || a == null) return 'Estoque Zero';
  if (a > 0 && a < 1) return 'Estoque Baixo';
  if (a >= 1 && a < 2) return 'Estoque Crítico';
  if (a >= 2 && a < 5) return 'Regular';
  return 'Abastecido';
}
function statusFinalDe(statusEstoque) {
  if (statusEstoque === 'Sem Demanda') return 'Sem Demanda';
  if (statusEstoque === 'Estoque Baixo' || statusEstoque === 'Estoque Crítico') return 'Crítico';
  if (statusEstoque === 'Estoque Zero') return 'Desabastecido';
  return 'Abastecido';
}

// Monta a lista de itens JÁ CLASSIFICADA para o monitoramento, aplicando os
// filtros do servidor (escopo, categoria, comDemanda) + os filtros do cliente
// que o export precisa reproduzir (busca q, status, situação final,
// subcategoria). Devolve { dataRef, itens }.
function construirItensMonitoramento(query) {
  const { data, escopoUnidade, categoria } = query;
  const soComDemanda = query.comDemanda !== '0';
  let dataRef = data;
  if (!dataRef) {
    const ultima = db.prepare('SELECT data_referencia FROM estoque_importacoes ORDER BY data_referencia DESC LIMIT 1').get();
    if (!ultima) return { dataRef: null, itens: [], autonomiaAlvo: null };
    dataRef = ultima.data_referencia;
  }

  // Autonomia Alvo (meses desejados como objetivo de abastecimento). Prioriza o
  // override enviado pela tela (?autonomiaAlvo=N); senão usa o valor persistido
  // em configuracoes (chave 'autonomia_alvo_meses'); default 6. Mesmo padrão do
  // 'autonomia_minima_meses'. NÃO fica fixo no código.
  const alvoOverride = Number(query.autonomiaAlvo);
  const autonomiaAlvo = Number.isFinite(alvoOverride) && alvoOverride > 0
    ? alvoOverride
    : parseFloat(db.prepare("SELECT valor FROM configuracoes WHERE chave = 'autonomia_alvo_meses'").get()?.valor || '6');

  const condicoes = ['e.data_referencia = ?'];
  const params = [dataRef];
  // Se o usuário escolheu unidades específicas, filtra por elas (IN) e ignora
  // o escopo udtp/geral. Senão, usa o escopo (Tenente Pena por padrão).
  const unidadesEscolhidas = String(query.unidade || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (unidadesEscolhidas.length) {
    condicoes.push(`e.unidade IN (${unidadesEscolhidas.map(() => '?').join(',')})`);
    params.push(...unidadesEscolhidas);
  } else {
    const escCond = condEscopoUnidade(escopoUnidade || 'udtp', 'e.');
    if (escCond) condicoes.push(escCond);
  }
  if (categoria) { condicoes.push('e.categoria = ?'); params.push(categoria); }
  if (soComDemanda) condicoes.push('e.demandas IS NOT NULL AND e.demandas > 0');
  const where = `WHERE ${condicoes.join(' AND ')}`;

  // Compras EM ANDAMENTO (em aberto) consolidadas por item: soma qtde_pendente
  // dos dois fluxos (TP = solicitacoes + OD = solicitacoes_od) e de todos os
  // tipos (JS + AS), e reúne os status ativos para o selo/lista do Monitoramento.
  const mapaAquisicao = new Map();
  const _ph = STATUS_EM_ABERTO.map(() => '?').join(',');
  const linhasAberto = db.prepare(`
    SELECT codigo_item, 'TP' AS fluxo, status, COALESCE(qtde_pendente, 0) AS q
      FROM solicitacoes WHERE status IN (${_ph})
    UNION ALL
    SELECT codigo_item, 'OD' AS fluxo, status, COALESCE(qtde_pendente, 0) AS q
      FROM solicitacoes_od WHERE status IN (${_ph})
  `).all(...STATUS_EM_ABERTO, ...STATUS_EM_ABERTO);
  const ORDEM_ABERTO = STATUS_EM_ABERTO; // Planejamento < Adjudicado < Empenhado < Entrega Parcial
  for (const r of linhasAberto) {
    let a = mapaAquisicao.get(r.codigo_item);
    if (!a) { a = { qtde: 0, chaves: new Set() }; mapaAquisicao.set(r.codigo_item, a); }
    a.qtde += Number(r.q) || 0;
    a.chaves.add(`${r.status} (${r.fluxo})`);
  }
  // Texto ordenado dos status ativos, ex.: "Empenhado (TP) · Planejamento (OD)".
  const textoStatus = (a) => [...a.chaves].sort((x, y) => {
    const sx = ORDEM_ABERTO.findIndex((s) => x.startsWith(s));
    const sy = ORDEM_ABERTO.findIndex((s) => y.startsWith(s));
    return sx !== sy ? sx - sy : x.localeCompare(y);
  }).join(' · ');

  const linhas = db.prepare(`
    SELECT e.codigo_item, e.siafisico, e.descricao, e.unidade,
           e.categoria, e.tipo_item, e.marca, e.importado, e.controlado, e.outras_demandas,
           e.demandas, e.demandas_aj, e.demandas_cf, e.demandas_jefaz,
           e.consumo_mensal_total, e.estoque, e.autonomia,
           (SELECT ic.subcategoria FROM item_classificacao ic WHERE ic.codigo_item = e.codigo_item) AS subcategoria
      FROM estoque_itens e ${where}
      ORDER BY e.descricao
  `).all(...params);

  const hoje = new Date();
  // Soma "meses" (fração) a uma data-base, sem arredondar antes: dias = meses*30.
  const dataMaisMeses = (base, meses) => {
    const d = new Date(base.getTime());
    d.setDate(d.getDate() + Math.round(Number(meses) * 30));
    return d.toISOString().slice(0, 10);
  };
  let itens = linhas.map((r) => {
    const aq = mapaAquisicao.get(r.codigo_item) || null;
    const statusEstoque = classificarStatusEstoque(r.demandas, r.autonomia);
    const statusFinal = statusFinalDe(statusEstoque);
    let previsaoFalta = null, coberturaMes = null;
    if (r.autonomia != null && (Number(r.consumo_mensal_total) || 0) > 0) {
      previsaoFalta = dataMaisMeses(hoje, r.autonomia);
      const m = new Date(hoje.getFullYear(), hoje.getMonth() + Math.round(Number(r.autonomia)), 1);
      coberturaMes = m.toISOString().slice(0, 7);
    }

    // ---- Novas análises de cobertura / aquisição (usam valores REAIS; a
    // apresentação com 2 casas é feita no frontend). ----
    const consumo = Number(r.consumo_mensal_total) || 0;   // 0 se vazio/nulo
    const estoque = Number(r.estoque) || 0;                // 0 se vazio/nulo
    const qtdeAquisicao = aq ? Number(aq.qtde) || 0 : 0;    // vazia = 0
    const autoAtual = r.autonomia;                          // importada (pode ser null)
    const temConsumo = consumo > 0;

    // Cobertura da Aquisição = Qtde. Aquisição / Consumo. Sem consumo → null ("-").
    const coberturaAquisicao = !temConsumo ? null : (qtdeAquisicao > 0 ? qtdeAquisicao / consumo : 0);

    // Autonomia Total após Recebimento: se não há aquisição, é a própria autonomia
    // atual (regra do enunciado). Com aquisição, soma a cobertura à autonomia atual
    // (base = autonomia importada; se ausente, cai para estoque/consumo).
    let autonomiaTotal;
    if (qtdeAquisicao <= 0) {
      autonomiaTotal = autoAtual;                 // pode ser null → "—"
    } else if (!temConsumo) {
      autonomiaTotal = null;                      // aquisição sem consumo → indefinido
    } else {
      const base = (autoAtual != null) ? Number(autoAtual) : (estoque / consumo);
      autonomiaTotal = base + coberturaAquisicao;
    }

    // Previsão de Falta Projetada = hoje + Autonomia Total (mesma referência/lógica
    // da Previsão de Falta atual). Sem aquisição, coincide com a Previsão de Falta.
    let previsaoFaltaProjetada = null;
    if (autonomiaTotal != null && temConsumo) previsaoFaltaProjetada = dataMaisMeses(hoje, autonomiaTotal);
    else if (qtdeAquisicao <= 0) previsaoFaltaProjetada = previsaoFalta;

    // Situação da Aquisição (fase 1: só reflete se há ou não aquisição).
    const situacaoAquisicao = qtdeAquisicao > 0 ? 'Aquisição em andamento' : 'Sem aquisição';

    // Saldo Necessário de Aquisição = MAX(0, Consumo*Alvo - (Estoque + Aquisição)).
    // Sem consumo não há meta de meses → null ("-").
    const saldoNecessario = !temConsumo
      ? null
      : Math.max(0, consumo * autonomiaAlvo - (estoque + qtdeAquisicao));

    // Situação da Cobertura frente à Autonomia Alvo.
    let situacaoCobertura;
    if (!temConsumo) situacaoCobertura = 'Sem consumo';
    else if (saldoNecessario > 0) situacaoCobertura = 'Necessita Aquisição';
    else situacaoCobertura = 'Autonomia Alvo Atendida';

    return {
      codigo_item: r.codigo_item, siafisico: r.siafisico, descricao: r.descricao, unidade: r.unidade,
      categoria: r.categoria || 'Sem categoria', subcategoria: r.subcategoria || (r.categoria || 'Sem categoria'),
      tipo_item: r.tipo_item, marca: r.marca, importado: r.importado, controlado: r.controlado,
      demandas: r.demandas || 0, demandas_aj: r.demandas_aj || 0, demandas_cf: r.demandas_cf || 0, demandas_jefaz: r.demandas_jefaz || 0,
      consumo_mensal_total: r.consumo_mensal_total || 0, estoque: r.estoque || 0, autonomia: r.autonomia,
      status_estoque: statusEstoque, status_final: statusFinal,
      previsao_falta: previsaoFalta, cobertura_mes: coberturaMes,
      faixa_demanda: (Number(r.demandas) || 0) > 30 ? 'Acima 30' : 'Baixo 30',
      qtde_aquisicao: qtdeAquisicao,
      em_compra: aq ? 'Em compra' : 'Sem compra',
      compra_status_txt: aq ? textoStatus(aq) : '',
      // Novas análises:
      cobertura_aquisicao: coberturaAquisicao,
      autonomia_total: autonomiaTotal,
      previsao_falta_projetada: previsaoFaltaProjetada,
      situacao_aquisicao: situacaoAquisicao,
      saldo_necessario: saldoNecessario,
      situacao_cobertura: situacaoCobertura,
    };
  });

  // Filtros do cliente (reproduzidos para o export dar o MESMO conjunto da tela).
  const q = db.normalizarBusca(query.q);
  if (q) itens = itens.filter((i) =>
    db.normalizarBusca(i.descricao).includes(q) ||
    db.normalizarBusca(i.codigo_item).includes(q) ||
    db.normalizarBusca(i.siafisico).includes(q));
  if (query.status) itens = itens.filter((i) => i.status_estoque === query.status);
  if (query.statusFinal) itens = itens.filter((i) => i.status_final === query.statusFinal);
  if (query.subcategoria) itens = itens.filter((i) => i.subcategoria === query.subcategoria);
  return { dataRef, itens, autonomiaAlvo };
}

router.get('/monitoramento', (req, res) => {
  // Reaproveita o mesmo construtor do export (escopo/unidade/categoria/comDemanda).
  // Aqui NÃO aplicamos q/status/etc — esses recortes são feitos no navegador.
  const { dataRef, itens, autonomiaAlvo } = construirItensMonitoramento({
    data: req.query.data, escopoUnidade: req.query.escopoUnidade,
    categoria: req.query.categoria, comDemanda: req.query.comDemanda, unidade: req.query.unidade,
    autonomiaAlvo: req.query.autonomiaAlvo,
  });
  if (!dataRef) return res.json({ dataReferencia: null, itens: [], autonomiaAlvo: null });

  // Agregações para os painéis.
  const contar = (chave) => {
    const m = new Map();
    for (const it of itens) { const k = it[chave] || '—'; m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].map(([nome, valor]) => ({ nome, valor })).sort((a, b) => b.valor - a.valor);
  };
  const somarPor = (chave, campo) => {
    const m = new Map();
    for (const it of itens) { const k = it[chave] || '—'; m.set(k, (m.get(k) || 0) + (Number(it[campo]) || 0)); }
    return [...m.entries()].map(([nome, valor]) => ({ nome, valor })).sort((a, b) => b.valor - a.valor);
  };

  // Ordem fixa e cores para o Status Estoque (do pior ao melhor).
  const ORDEM_STATUS = ['Estoque Zero', 'Estoque Baixo', 'Estoque Crítico', 'Regular', 'Abastecido', 'Sem Demanda'];
  const porStatus = ORDEM_STATUS
    .map((nome) => ({ nome, valor: itens.filter((i) => i.status_estoque === nome).length }))
    .filter((x) => x.valor > 0);
  const ORDEM_FINAL = ['Desabastecido', 'Crítico', 'Abastecido', 'Sem Demanda'];
  const porFinal = ORDEM_FINAL
    .map((nome) => ({ nome, valor: itens.filter((i) => i.status_final === nome).length }))
    .filter((x) => x.valor > 0);

  // No escopo geral (dezenas de milhares de itens) a tabela vai truncada para
  // não estourar o payload; os painéis continuam calculados sobre TUDO.
  const LIMITE_TABELA = 8000;
  const truncado = itens.length > LIMITE_TABELA;

  res.json({
    dataReferencia: dataRef,
    autonomiaAlvo,
    totalItens: itens.length,
    truncado,
    itens: truncado ? itens.slice(0, LIMITE_TABELA) : itens,
    paineis: {
      porSubcategoria: contar('subcategoria'),
      porStatusEstoque: porStatus,
      porStatusFinal: porFinal,
      itensPorCategoria: contar('categoria'),
      demandasPorCategoria: somarPor('categoria', 'demandas'),
    },
  });
});

// Exporta para Excel EXATAMENTE os itens filtrados na tela (mesmos filtros:
// escopo, categoria, comDemanda, busca q, status, situação final, subcategoria).
router.get('/monitoramento/exportar', (req, res) => {
  const { dataRef, itens, autonomiaAlvo } = construirItensMonitoramento(req.query);
  if (!dataRef) return res.status(404).json({ erro: 'Nenhum estoque importado.' });

  // Arredonda meses para 2 casas só na saída (cálculo usou valor real); '' se null.
  const meses2 = (v) => (v == null ? '' : Math.round(Number(v) * 100) / 100);
  const dataBR = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

  const cabecalho = [
    'Código SCODES', 'Siafísico', 'Descrição', 'Unidade', 'Categoria', 'Sub-categoria',
    'Marca', 'Demandas', 'Demanda AJ', 'Demanda CF', 'Demanda JEFAZ', 'Consumo Mensal',
    'Estoque', 'Autonomia (meses)', 'Qtde. Aquisição', 'Cobertura da Aquisição (meses)',
    'Autonomia Total após Recebimento (meses)', 'Compra em Andamento', 'Status da Compra',
    'Situação da Aquisição', `Saldo Necessário de Aquisição (alvo ${autonomiaAlvo}m)`,
    'Situação da Cobertura', 'Status Estoque', 'Situação Final',
    'Previsão de Falta', 'Previsão de Falta Projetada', 'Cobertura (mês)',
  ];
  const aoa = [cabecalho];
  for (const i of itens) {
    aoa.push([
      i.codigo_item || '', i.siafisico || '', i.descricao || '', i.unidade || '',
      i.categoria || '', i.subcategoria || '', i.marca || '',
      i.demandas, i.demandas_aj, i.demandas_cf, i.demandas_jefaz, i.consumo_mensal_total,
      i.estoque, i.autonomia == null ? '' : Number(i.autonomia),
      i.qtde_aquisicao || 0, meses2(i.cobertura_aquisicao), meses2(i.autonomia_total),
      i.em_compra, i.compra_status_txt || '',
      i.situacao_aquisicao, i.saldo_necessario == null ? '' : Math.round(i.saldo_necessario),
      i.situacao_cobertura,
      i.status_estoque, i.status_final,
      dataBR(i.previsao_falta), dataBR(i.previsao_falta_projetada), i.cobertura_mes || '',
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { wch: 24 }, { wch: 12 }, { wch: 45 }, { wch: 22 }, { wch: 14 }, { wch: 14 },
    { wch: 16 }, { wch: 10 }, { wch: 11 }, { wch: 11 }, { wch: 13 }, { wch: 13 },
    { wch: 10 }, { wch: 15 }, { wch: 15 }, { wch: 20 }, { wch: 22 },
    { wch: 18 }, { wch: 30 }, { wch: 20 }, { wch: 22 }, { wch: 20 },
    { wch: 15 }, { wch: 14 }, { wch: 15 }, { wch: 18 }, { wch: 13 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Monitoramento');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const nomeArq = `Monitoramento_Estoque_${dataRef}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArq}"`);
  res.send(buffer);
});

// ---------- Histórico de estoque: lista dos snapshots arquivados (01/15) ----------
router.get('/historico', (req, res) => {
  const snapshots = db.prepare(`
    SELECT ei.id, ei.referencia_historica, ei.data_referencia AS data_coleta, ei.total_itens,
      (SELECT ROUND(SUM(it.estoque * COALESCE(it.valor_medio_unitario, it.custo_unitario, 0)), 2)
       FROM estoque_itens it WHERE it.importacao_id = ei.id) AS valor_total
    FROM estoque_importacoes ei
    WHERE ei.arquivado = 1 AND ei.referencia_historica IS NOT NULL
    ORDER BY ei.referencia_historica DESC
  `).all();
  res.json({ snapshots });
});

// ---------- Comparação entre dois snapshots históricos ----------
router.get('/historico/comparar', (req, res) => {
  const { ref1, ref2, q } = req.query;
  if (!ref1 || !ref2) return res.status(400).json({ erro: 'Informe as duas referências (ref1 e ref2).' });

  const imp = (ref) => db.prepare('SELECT id, data_referencia FROM estoque_importacoes WHERE referencia_historica = ? AND arquivado = 1').get(ref);
  const i1 = imp(ref1);
  const i2 = imp(ref2);
  if (!i1 || !i2) return res.status(404).json({ erro: 'Snapshot histórico não encontrado para uma das referências.' });

  // Junta os itens das duas fotos por código. Usa a descrição mais recente disponível.
  const linhas = db.prepare(`
    SELECT
      COALESCE(a.codigo_item, b.codigo_item) AS codigo_item,
      COALESCE(a.descricao, b.descricao) AS descricao,
      COALESCE(a.categoria, b.categoria) AS categoria,
      a.estoque AS estoque1, b.estoque AS estoque2,
      a.autonomia AS autonomia1, b.autonomia AS autonomia2,
      ROUND(a.estoque * COALESCE(a.valor_medio_unitario, a.custo_unitario, 0), 2) AS valor1,
      ROUND(b.estoque * COALESCE(b.valor_medio_unitario, b.custo_unitario, 0), 2) AS valor2
    FROM (SELECT * FROM estoque_itens WHERE importacao_id = ?) a
    FULL OUTER JOIN (SELECT * FROM estoque_itens WHERE importacao_id = ?) b
      ON a.codigo_item = b.codigo_item
  `).all(i1.id, i2.id);

  let resultado = linhas.map((l) => ({
    ...l,
    estoque1: l.estoque1 ?? 0,
    estoque2: l.estoque2 ?? 0,
    variacao_estoque: (l.estoque2 ?? 0) - (l.estoque1 ?? 0),
    variacao_valor: (l.valor2 ?? 0) - (l.valor1 ?? 0),
  }));

  if (q) {
    const termo = db.normalizarBusca(q);
    resultado = resultado.filter((l) =>
      db.normalizarBusca(l.descricao).includes(termo) ||
      db.normalizarBusca(l.codigo_item).includes(termo));
  }

  resultado.sort((a, b) => Math.abs(b.variacao_estoque) - Math.abs(a.variacao_estoque));

  res.json({
    ref1, ref2,
    dataColeta1: i1.data_referencia, dataColeta2: i2.data_referencia,
    total: resultado.length,
    itens: resultado,
  });
});

// ---------- Evolução de estoque: busca de medicamentos (na foto mais recente) ----------
router.get('/evolucao/buscar', (req, res) => {
  const { q, escopoUnidade } = req.query;
  if (!q || q.trim().length < 2) return res.json({ itens: [] });

  const ultima = db.prepare('SELECT data_referencia FROM estoque_importacoes ORDER BY data_referencia DESC LIMIT 1').get();
  if (!ultima) return res.json({ itens: [] });

  const escCond = condEscopoUnidade(escopoUnidade || 'udtp', 'e.');
  const andEsc = escCond ? ' AND ' + escCond : '';
  const like = `%${q.trim()}%`;
  const itens = db.prepare(`
    SELECT DISTINCT e.codigo_item, e.descricao
    FROM estoque_itens e
    WHERE e.data_referencia = ? AND (e.descricao LIKE ? OR e.codigo_item LIKE ? OR e.siafisico LIKE ?)${andEsc}
    ORDER BY e.descricao
    LIMIT 30
  `).all(ultima.data_referencia, like, like, like);
  res.json({ itens });
});

// ---------- Evolução de estoque de um item ao longo da série histórica ----------
router.get('/evolucao', (req, res) => {
  const { codigo, escopoUnidade } = req.query;
  if (!codigo) return res.status(400).json({ erro: 'Informe o código do item.' });

  const escCond = condEscopoUnidade(escopoUnidade || 'udtp', 'it.');
  const andEsc = escCond ? ' AND ' + escCond : '';

  // Série por data (todos os snapshots guardados: histórico 01/15 + atual)
  const serie = db.prepare(`
    SELECT ei.data_referencia,
           ei.referencia_historica,
           ei.arquivado,
           SUM(it.estoque) AS estoque,
           AVG(it.autonomia) AS autonomia,
           SUM(it.demandas) AS demandas,
           SUM(it.consumo_mensal_total) AS consumo_mensal_total,
           ROUND(SUM(it.estoque * COALESCE(it.valor_medio_unitario, it.custo_unitario, 0)), 2) AS valor
    FROM estoque_importacoes ei
    JOIN estoque_itens it ON it.importacao_id = ei.id AND it.codigo_item = ?
    WHERE 1=1 ${andEsc}
    GROUP BY ei.id
    ORDER BY ei.data_referencia
  `).all(codigo);

  const descricao = db.prepare(
    'SELECT descricao FROM estoque_itens WHERE codigo_item = ? ORDER BY data_referencia DESC LIMIT 1'
  ).get(codigo)?.descricao || codigo;

  res.json({ codigo, descricao, serie });
});

// Interpreta o texto de lotes do relatório. Separador entre lotes: "\" (formato
// antigo do Excel) ou ", Lote N°:" (formato atual via Oracle). Não quebra em
// vírgulas dentro do nome do fabricante (só separa quando vem "Lote N°" adiante).
// Formato de cada lote: "Lote N°: XXX Validade: DD/MM/YYYY Fabricante: YYY Qtde: NNN"
function parsearLotesServidor(texto) {
  if (!texto) return [];
  const t = String(texto).trim();
  if (!t || /^sem lote$/i.test(t)) return [];
  return t.split(/\\|,\s*(?=Lote\s*N[°º:])/i).map((p) => p.trim()).filter(Boolean).map((p) => {
    const lote = (p.match(/Lote\s*N[°º:]*\s*([^\s]+(?:\s+[^\s]+)*?)(?=\s+Validade:|\s+Fabricante:|\s+Qtde:|$)/i) || [])[1];
    const validade = (p.match(/Validade:\s*(\d{2}\/\d{2}\/\d{4})/i) || [])[1];
    const fabricante = (p.match(/Fabricante:\s*(.+?)(?=\s+Qtde:|$)/i) || [])[1];
    const qtdeStr = (p.match(/Qtde:\s*([\d.,]+)/i) || [])[1];
    const qtde = qtdeStr ? Number(qtdeStr.replace(/\./g, '').replace(',', '.')) : null;
    return {
      lote: lote ? lote.trim() : null,
      validade: validade || null,
      fabricante: fabricante ? fabricante.trim() : null,
      qtde: Number.isFinite(qtde) ? qtde : null,
    };
  });
}

// Converte DD/MM/YYYY para Date (meia-noite local) ou null.
function dataDeBR(validadeBR) {
  if (!validadeBR) return null;
  const [d, m, a] = validadeBR.split('/').map(Number);
  if (!d || !m || !a) return null;
  return new Date(a, m - 1, d);
}

// Em qual faixa de vencimento cai um nº de dias restantes.
function faixaVencimento(dias) {
  if (dias < 0) return 'vencido';
  if (dias <= 30) return 'd30';
  if (dias <= 60) return 'd60';
  if (dias <= 90) return 'd90';
  return 'mais90';
}

// ---------- Gestão de validades: lotes a vencer, KPIs e filtro por faixa ----------
router.get('/validades', (req, res) => {
  const { data, q, janela } = req.query;

  let dataRef = data;
  if (!dataRef) {
    const ultima = db.prepare('SELECT data_referencia FROM estoque_importacoes ORDER BY data_referencia DESC LIMIT 1').get();
    if (!ultima) return res.json({ dataReferencia: null, lotes: [], resumo: null, datasDisponiveis: [] });
    dataRef = ultima.data_referencia;
  }

  // Validades é uma visão do Tenente Pena (UDTP) por padrão
  const escCond = condEscopoUnidade(req.query.escopoUnidade || 'udtp');
  const andEsc = escCond ? ' AND ' + escCond : '';
  const itens = db.prepare(
    `SELECT codigo_item, descricao, siafisico, categoria, marca, lotes,
            COALESCE(valor_medio_unitario, custo_unitario, 0) AS valor_unit
     FROM estoque_itens WHERE data_referencia = ? AND lotes IS NOT NULL AND lotes <> ''${andEsc}`
  ).all(dataRef);

  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const MS_DIA = 1000 * 60 * 60 * 24;

  let linhas = [];
  for (const it of itens) {
    for (const l of parsearLotesServidor(it.lotes)) {
      const dataVal = dataDeBR(l.validade);
      if (!dataVal) continue; // sem validade → fora da gestão de vencimento
      const dias = Math.floor((dataVal - hoje) / MS_DIA);
      const qtde = l.qtde || 0;
      const valorTotal = qtde * it.valor_unit;
      linhas.push({
        codigo_item: it.codigo_item,
        descricao: it.descricao,
        categoria: it.categoria,
        marca: it.marca,
        lote: l.lote,
        fabricante: l.fabricante,
        validade: l.validade,
        qtde,
        valor_unit: it.valor_unit,
        valor_total: valorTotal,
        dias_para_vencer: dias,
        faixa: faixaVencimento(dias),
      });
    }
  }

  const FAIXAS = ['vencido', 'd30', 'd60', 'd90', 'mais90'];

  // Filtro de texto/medicamento: afeta TANTO os KPIs quanto a tabela.
  // (assim, ao buscar/clicar num medicamento, os cards recalculam para ele)
  if (q) {
    const termo = db.normalizarBusca(q);
    linhas = linhas.filter((ln) =>
      db.normalizarBusca(ln.descricao).includes(termo) ||
      db.normalizarBusca(ln.codigo_item).includes(termo) ||
      db.normalizarBusca(ln.lote).includes(termo));
  }

  // KPIs por faixa, calculados sobre o conjunto já filtrado por texto,
  // mas ANTES do filtro de faixa (para os cards não se anularem entre si).
  const resumo = { totalLotes: linhas.length, valorTotal: 0 };
  for (const f of FAIXAS) resumo[f] = { qtdeLotes: 0, valor: 0 };
  for (const ln of linhas) {
    resumo.valorTotal += ln.valor_total;
    resumo[ln.faixa].qtdeLotes += 1;
    resumo[ln.faixa].valor += ln.valor_total;
  }

  // Filtro de faixa: afeta SÓ a tabela exibida.
  if (janela && FAIXAS.includes(janela)) {
    linhas = linhas.filter((ln) => ln.faixa === janela);
  }

  // Ordena por validade mais próxima primeiro
  linhas.sort((a, b) => a.dias_para_vencer - b.dias_para_vencer);

  const datasDisponiveis = db.prepare('SELECT data_referencia, total_itens FROM estoque_importacoes ORDER BY data_referencia DESC').all();

  res.json({ dataReferencia: dataRef, resumo, lotes: linhas, datasDisponiveis });
});

// ---------- Detalhe de um item: situação de estoque + compras ----------
// No escopo GERAL cada linha da listagem é de UMA unidade dispensadora, então o
// modal recebe a `unidade` clicada e mostra os dados DAQUELA unidade (estoque,
// lotes, pacientes) e as compras da "Aquisição em Andamento OD". No Tenente
// Pena (padrão) usa o escopo TP, as compras judiciais e os pacientes da TP.
router.get('/item/:codigo', (req, res) => {
  const codigo = req.params.codigo;
  const escopo = req.query.escopoUnidade;
  const unidade = (req.query.unidade || '').trim() || null;

  // Filtro de estoque/histórico: unidade específica (se veio) ou o escopo.
  let andEstoque = '';
  const pEstoque = [];
  if (unidade) {
    andEstoque = ' AND unidade = ?';
    pEstoque.push(unidade);
  } else {
    const escCond = condEscopoUnidade(escopo);
    if (escCond) andEstoque = ' AND ' + escCond;
  }

  const ultima = db.prepare('SELECT data_referencia FROM estoque_importacoes ORDER BY data_referencia DESC LIMIT 1').get();
  const estoqueAtual = ultima
    ? db.prepare(`SELECT * FROM estoque_itens WHERE codigo_item = ? AND data_referencia = ?${andEstoque}`).get(codigo, ultima.data_referencia, ...pEstoque)
    : null;

  // Evolução do estoque ao longo do tempo (histórico).
  // Duas correções em relação à versão anterior:
  //  1) respeita o MESMO filtro de unidade do estoque atual (antes não
  //     filtrava, então misturava unidades);
  //  2) agrupa por data — a tabela guarda uma linha por item POR UNIDADE,
  //     então sem o GROUP BY a mesma data aparecia repetida várias vezes.
  const historicoEstoque = db.prepare(`
    SELECT data_referencia,
           SUM(estoque) AS estoque,
           MAX(autonomia) AS autonomia,
           SUM(demandas) AS demandas,
           SUM(consumo_mensal_total) AS consumo_mensal_total
      FROM estoque_itens
     WHERE codigo_item = ?${andEstoque}
     GROUP BY data_referencia
     ORDER BY data_referencia
  `).all(codigo, ...pEstoque);

  // Ordem cronológica pelo mês por extenso (igual nas duas fontes de compra).
  const ordemMes = `CASE mes WHEN 'Janeiro' THEN 1 WHEN 'Fevereiro' THEN 2 WHEN 'Março' THEN 3 WHEN 'Abril' THEN 4
        WHEN 'Maio' THEN 5 WHEN 'Junho' THEN 6 WHEN 'Julho' THEN 7 WHEN 'Agosto' THEN 8
        WHEN 'Setembro' THEN 9 WHEN 'Outubro' THEN 10 WHEN 'Novembro' THEN 11 WHEN 'Dezembro' THEN 12 END`;

  // Fonte das compras: no GERAL, "Aquisição em Andamento OD" (solicitacoes_od);
  // no Tenente Pena, as compras judiciais (solicitacoes).
  const fonteCompras = escopo === 'geral' ? 'od' : 'judicial';
  const compras = fonteCompras === 'od'
    ? db.prepare(`
        SELECT ano, mes, modalidade_compra, n_oficio, n_empenho, qtde_solicitada,
               qtde_entregue, qtde_pendente, data_previsao_entrega, data_entrega, status
        FROM solicitacoes_od WHERE codigo_item = ?
        ORDER BY ano, ${ordemMes}
      `).all(codigo)
    : db.prepare(`
        SELECT ano, mes, modalidade_compra, n_oficio, n_empenho, qtde_solicitada,
               quantidade_empenho, qtde_entregue, qtde_pendente, data_previsao_entrega, data_entrega, status
        FROM solicitacoes WHERE codigo_item = ?
        ORDER BY ano, ${ordemMes}
      `).all(codigo);

  const temCompraAberta = compras.some((c) => STATUS_EM_ABERTO.includes(c.status));

  // Pacientes (Listagem de Autores): da unidade dispensadora clicada (no geral)
  // ou da Tenente Pena (padrão).
  const pacientes = db.prepare(`
    SELECT autor, protocolo, tipo_demanda, qtde_consumo, prazo, periodicidade,
           data_ultima_dispensacao, data_ultimo_retorno
    FROM autores_itens
    WHERE codigo_item = ?
      AND unidade_dispensadora ${unidade ? '= ?' : "LIKE '%Tenente Pena%'"}
      AND data_referencia = (SELECT MAX(data_referencia) FROM autores_itens)
    ORDER BY autor
  `).all(...(unidade ? [codigo, unidade] : [codigo]));

  res.json({ codigo, unidade, fonteCompras, estoqueAtual, historicoEstoque, compras, temCompraAberta, pacientes });
});

module.exports = router;
module.exports.importarEstoqueDeBuffer = importarEstoqueDeBuffer;
module.exports.importarEstoqueDeLinhas = importarEstoqueDeLinhas;
module.exports.iniciarAtualizacaoEstoqueOracle = iniciarAtualizacaoEstoqueOracle;
module.exports.executarAtualizacaoEstoqueOracle = executarAtualizacaoEstoqueOracle;
