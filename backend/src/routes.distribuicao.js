// =====================================================================
// routes.distribuicao.js — Módulo Distribuição (GSNET/IBL x Outras Demandas)
//
// Cruza dados de duas planilhas extraídas manualmente do sistema "Simples"
// (PRODESP) e salvas numa pasta de rede (vigiada por vigiaDistribuicao.js):
//   1. "2.Status Fatura WMS_IBL.xlsx" — status de cada fatura/item (o que
//      ainda está pendente de entrega, por unidade de destino).
//   2. "1.Extrato Simples.xls" — histórico de movimentações de saída do
//      armazém GSNET/IBL (arquivo HTML disfarçado de .xls).
// Os códigos de item vêm no formato interno do GSNET (codigo_material /
// ID_ITEM) — são traduzidos para o codigo_item do SCODES reaproveitando o
// mesmo "Cadastro Itens GSNET - IBL.xlsx" já usado pelo Estoque OD.
//
// Por enquanto este módulo só importa e mostra os dados brutos. O cálculo
// de sugestão de reposição (cruzando com estoque, consumo e elegibilidade
// por unidade) vem numa etapa seguinte.
// =====================================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const db = require('./db');
const { autenticar } = require('./auth');

const router = express.Router();
router.use(autenticar);

// Algumas colunas de código (ex.: Código Programa, Código Destino) vêm
// formatadas como DATA no Excel de origem mesmo contendo só um número (ex.:
// "3004"). Com cellDates:true, o SheetJS converte essas células pra objeto
// Date — se isso acontecer aqui (numa coluna que não deveria ser data),
// reconstruímos o número original a partir da data em vez de devolver o
// texto malformado tipo "Sun Mar 22 1908...".
function texto(v) {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const serial = Math.round((v.getTime() - Date.UTC(1899, 11, 30)) / 86400000);
    return String(serial);
  }
  const t = String(v).trim();
  return t === '' ? null : t;
}

function numero(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return Math.round((v.getTime() - Date.UTC(1899, 11, 30)) / 86400000);
  }
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function normalizar(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[._]/g, ' ')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// ---------- Mapeamento de código (GSNET -> SCODES) ----------
// A partir de 2026 este cadastro passou a ficar na pasta "BANCO DE DADOS"
// (junto com o Modelo grade.xlsx), não mais em "OUTRAS DEMANDAS\Estoque
// Outras Demandas" — a pasta antiga não existe mais (virou pastas por mês).
// Colunas identificadas pelo NOME (não pela posição) porque a ordem já
// mudou uma vez (o código GSNET está hoje em "Novo Código GSNET", não na
// posição em que o Estoque OD original foi escrito).
const PASTA_BANCO_DADOS_PADRAO = 'G:\\CAF\\GAF\\GGAF\\PROGRAMAÇÃO\\CPDAE\\GRADES DISTRIBUIÇÕES\\2026\\BANCO DE DADOS';
const PASTA_BANCO_DADOS = process.env.CAMINHO_BANCO_DADOS_DISTRIBUICAO || PASTA_BANCO_DADOS_PADRAO;
const CAMINHO_MAPEAMENTO_GSNET = path.join(PASTA_BANCO_DADOS, 'Cadastro Itens GSNET - IBL.xlsx');

function carregarMapeamentoGsnet() {
  const mapa = new Map();
  try {
    const buffer = fs.readFileSync(CAMINHO_MAPEAMENTO_GSNET);
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    const cab = (rows[0] || []).map(normalizar);
    const colScodes = cab.findIndex((c) => c === 'codigo');
    const colSku = cab.findIndex((c) => c.includes('novo codigo') && c.includes('gsnet'));
    if (colScodes === -1 || colSku === -1) {
      console.warn('[DISTRIBUIÇÃO] Não reconheci as colunas do Cadastro Itens GSNET-IBL (esperava "Código" e "Novo Código GSNET").');
      return mapa;
    }
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const codigoScodes = texto(r[colScodes]);
      const codigoSku = texto(r[colSku]);
      if (codigoScodes && codigoSku) mapa.set(String(codigoSku).trim(), codigoScodes);
    }
  } catch (e) {
    console.warn('[DISTRIBUIÇÃO] Não consegui ler o mapeamento GSNET-IBL:', e.message);
  }
  return mapa;
}

// ---------- Planilha 1: Status de Faturas (xlsx genuíno) ----------
const MAPA_FATURAS = {
  codigo_programa: ['codigo programa'],
  programa: ['programa'],
  drs: ['drs'],
  codigo_material: ['codigo material'],
  nome_material: ['nome material'],
  unidade_medida: ['nome unidade medida'],
  numero_fatura: ['numero fatura'],
  emissao_fatura: ['emissao fatura'],
  dt_programacao_entrega: ['dt programacao entrega'],
  qtd_volumes_itens: ['qtd volumes itens'],
  origem: ['origem'],
  status: ['status'],
  codigo_destino: ['codigo destino'],
  local: ['local'],
  municipio: ['municipio'],
  categoria: ['categoria'],
  status_fatura: ['status fatura'],
  qtde_faturada: ['qtde faturada'],
  preco_total: ['preco total'],
};
const CAMPOS_FATURAS = Object.keys(MAPA_FATURAS);

// Datas nesta planilha vêm como valor Excel genuíno (serial/Date) — sem a
// ambiguidade de texto DD/MM x MM/DD do outro arquivo.
function dataParaBR(v) {
  if (!(v instanceof Date) || Number.isNaN(v.getTime())) return texto(v);
  const d = String(v.getUTCDate()).padStart(2, '0');
  const m = String(v.getUTCMonth() + 1).padStart(2, '0');
  const a = v.getUTCFullYear();
  return `${d}/${m}/${a}`;
}

function parsearStatusFaturas(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const linhas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });

  const cab = (linhas[0] || []).map(normalizar);
  const COL = {};
  for (const [campo, nomes] of Object.entries(MAPA_FATURAS)) COL[campo] = cab.findIndex((c) => nomes.includes(c));
  if (COL.numero_fatura === -1) throw new Error('Não encontrei a coluna "Número fatura" na planilha de Status de Faturas.');

  const resultado = [];
  for (let i = 1; i < linhas.length; i++) {
    const r = linhas[i];
    if (!r) continue;
    const numeroFatura = texto(r[COL.numero_fatura]);
    if (!numeroFatura) continue;
    const linha = {};
    for (const campo of CAMPOS_FATURAS) {
      const v = COL[campo] >= 0 ? r[COL[campo]] : null;
      if (campo === 'emissao_fatura' || campo === 'dt_programacao_entrega') linha[campo] = dataParaBR(v);
      else if (campo === 'qtd_volumes_itens' || campo === 'qtde_faturada' || campo === 'preco_total') linha[campo] = numero(v);
      else linha[campo] = texto(v);
    }
    resultado.push(linha);
  }
  return resultado;
}

// ---------- Planilha 2: Extrato Simples (HTML disfarçado de .xls) ----------
// Não usar o parser padrão de data do XLSX aqui: ele assume formato
// americano (MM/DD) e inverte dia/mês de datas brasileiras (DD/MM). Lemos
// tudo como texto puro e convertemos a data manualmente.
function decodificarEntidadesHtml(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    // Entidades numéricas (ex.: &#199; -> Ç, &#195; -> Ã) — comuns em
    // acentos exportados pelo sistema Simples (PRODESP).
    .replace(/&#(\d+);/g, (_, cod) => String.fromCharCode(parseInt(cod, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, cod) => String.fromCharCode(parseInt(cod, 16)))
    .replace(/&amp;/g, '&');
}

function textoCelula(html) {
  const semTags = html.replace(/<[^>]*>/g, '');
  return decodificarEntidadesHtml(semTags).replace(/\s+/g, ' ').trim();
}

// Converte "dd/mm/aaaa" (com ou sem hora) para "dd/mm/aaaa". Mantém o texto
// original se não bater com o formato esperado.
function normalizarDataBR(s) {
  const t = texto(s);
  if (!t) return null;
  const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : t;
}

function parsearExtratoSimples(buffer) {
  // O arquivo é HTML (tabela <table id="GridResultado">) salvo com extensão
  // .xls pelo sistema "Simples" (PRODESP). Detecta a codificação (utf-8 ou
  // latin1/windows-1252) olhando se aparecem caracteres de substituição.
  let html = buffer.toString('utf8');
  if (html.includes('�')) html = buffer.toString('latin1');

  const tabelaMatch = html.match(/<table[^>]*>[\s\S]*?<\/table>/i);
  if (!tabelaMatch) throw new Error('Não encontrei a tabela de dados no arquivo Extrato Simples.');

  const linhasHtml = tabelaMatch[0].match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  if (linhasHtml.length < 2) throw new Error('Extrato Simples sem linhas de dados.');

  const extrairCelulas = (linhaHtml) => (linhaHtml.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(textoCelula);

  const cabecalho = extrairCelulas(linhasHtml[0]).map((c) => c.toUpperCase());
  const idx = (nome) => cabecalho.indexOf(nome);
  const COL = {
    nr_documento: idx('NR_DOCUMENTO'),
    sr_documento: idx('SR_DOCUMENTO'),
    dt_documento: idx('DT_DOCUMENTO'),
    tp_movimentacao: idx('NM_TP_MOVIMENTACAO'),
    vl_total: idx('VL_TOTAL'),
    local_origem: idx('LOCAL_DESTINO'), // 1ª ocorrência da query = local de origem
    local_destino: idx('LOCAL_DESTINO1'),
    dt_inclusao: idx('DT_INCLUSAO'),
    dt_alteracao: idx('DT_ALTERACAO'),
    st_registro: idx('ST_REGISTRO'),
    nr_ordem: idx('NR_ORDEM'),
    id_item: idx('ID_ITEM'),
    nm_item: idx('NM_ITEM'),
    qt_unit_atendida: idx('QT_UNIT_ATENDIDA'),
    pmu: idx('PMU'),
    cd_usuario: idx('CD_USUARIO'),
  };
  if (COL.nr_documento === -1) throw new Error('Não reconheci o layout do Extrato Simples (coluna NR_DOCUMENTO não encontrada).');

  const resultado = [];
  for (let i = 1; i < linhasHtml.length; i++) {
    const cels = extrairCelulas(linhasHtml[i]);
    if (cels.length === 0) continue;
    const nrDocumento = texto(cels[COL.nr_documento]);
    if (!nrDocumento) continue;
    resultado.push({
      nr_documento: nrDocumento,
      sr_documento: texto(cels[COL.sr_documento]),
      dt_documento: normalizarDataBR(cels[COL.dt_documento]),
      tp_movimentacao: texto(cels[COL.tp_movimentacao]),
      vl_total: numero(cels[COL.vl_total]),
      local_origem: texto(cels[COL.local_origem]),
      local_destino: texto(cels[COL.local_destino]),
      dt_inclusao: normalizarDataBR(cels[COL.dt_inclusao]),
      dt_alteracao: normalizarDataBR(cels[COL.dt_alteracao]),
      st_registro: texto(cels[COL.st_registro]),
      nr_ordem: texto(cels[COL.nr_ordem]),
      id_item: texto(cels[COL.id_item]),
      nm_item: texto(cels[COL.nm_item]),
      qt_unit_atendida: numero(cels[COL.qt_unit_atendida]),
      pmu: numero(cels[COL.pmu]),
      cd_usuario: texto(cels[COL.cd_usuario]),
    });
  }
  return resultado;
}

// ---------- Importação (substitui tudo, numa única transação) ----------
function importarStatusFaturas(linhas, opcoes = {}) {
  const mapa = opcoes.mapaGsnet || carregarMapeamentoGsnet();
  let resumo;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM distribuicao_faturas');
    const cols = [...CAMPOS_FATURAS, 'codigo_item'];
    const stmt = db.prepare(`INSERT INTO distribuicao_faturas (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    for (const l of linhas) {
      const codigoItem = mapa.get(String(l.codigo_material || '').trim()) || null;
      stmt.run(...CAMPOS_FATURAS.map((c) => l[c]), codigoItem);
    }
    resumo = { totalLinhas: linhas.length };
    db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
      .run('distribuicao_faturas', opcoes.nomeArquivo || 'Status Fatura WMS_IBL', opcoes.usuarioEmail || 'sistema', JSON.stringify(resumo));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return resumo;
}

function importarExtratoSimples(linhas, opcoes = {}) {
  const mapa = opcoes.mapaGsnet || carregarMapeamentoGsnet();
  let resumo;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM distribuicao_movimentacoes');
    const campos = ['nr_documento', 'sr_documento', 'dt_documento', 'tp_movimentacao', 'vl_total',
      'local_origem', 'local_destino', 'dt_inclusao', 'dt_alteracao', 'st_registro', 'nr_ordem',
      'id_item', 'nm_item', 'qt_unit_atendida', 'pmu', 'cd_usuario'];
    const cols = [...campos, 'codigo_item'];
    const stmt = db.prepare(`INSERT INTO distribuicao_movimentacoes (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    for (const l of linhas) {
      const codigoItem = mapa.get(String(l.id_item || '').trim()) || null;
      stmt.run(...campos.map((c) => l[c]), codigoItem);
    }
    resumo = { totalLinhas: linhas.length };
    db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
      .run('distribuicao_movimentacoes', opcoes.nomeArquivo || 'Extrato Simples', opcoes.usuarioEmail || 'sistema', JSON.stringify(resumo));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return resumo;
}

// ---------- Planilha 3: Itens Elegíveis por unidade (exceção, ex.: CEDMAC) ----------
const MAPA_ELEGIVEIS = {
  codigo_item: ['codigo'],
  siafisico: ['siafisico'],
  descricao_item: ['descricao do item'],
  unidade_dispensadora: ['unidade dispensadora'],
  demandas: ['demandas'],
  consumo_mensal_fixo: ['consumo mensal total'],
  conversao: ['conversao'],
};
const CAMPOS_ELEGIVEIS = Object.keys(MAPA_ELEGIVEIS);

function parsearItensElegiveis(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const linhas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });

  const cab = (linhas[0] || []).map(normalizar);
  const COL = {};
  for (const [campo, nomes] of Object.entries(MAPA_ELEGIVEIS)) COL[campo] = cab.findIndex((c) => nomes.includes(c));
  if (COL.codigo_item === -1) throw new Error('Não encontrei a coluna "Código" na planilha de Itens Elegíveis.');

  const resultado = [];
  for (let i = 1; i < linhas.length; i++) {
    const r = linhas[i];
    if (!r) continue;
    const codigoItem = texto(r[COL.codigo_item]);
    if (!codigoItem) continue;
    const linha = {};
    for (const campo of CAMPOS_ELEGIVEIS) {
      const v = COL[campo] >= 0 ? r[COL[campo]] : null;
      linha[campo] = (campo === 'demandas' || campo === 'consumo_mensal_fixo' || campo === 'conversao') ? numero(v) : texto(v);
    }
    // Conversão em branco/0 equivale a "sem conversão" (fator 1).
    if (!linha.conversao) linha.conversao = 1;
    resultado.push(linha);
  }
  return resultado;
}

function importarItensElegiveis(linhas, opcoes = {}) {
  let resumo;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM distribuicao_itens_elegiveis');
    const stmt = db.prepare(
      `INSERT INTO distribuicao_itens_elegiveis (${CAMPOS_ELEGIVEIS.join(',')}) VALUES (${CAMPOS_ELEGIVEIS.map(() => '?').join(',')})`
    );
    for (const l of linhas) stmt.run(...CAMPOS_ELEGIVEIS.map((c) => l[c]));
    resumo = { totalLinhas: linhas.length };
    db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
      .run('distribuicao_itens_elegiveis', opcoes.nomeArquivo || 'Elenco CEDMAC', opcoes.usuarioEmail || 'sistema', JSON.stringify(resumo));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return resumo;
}

// ---------- Planilha 4: Conversão geral de Outras Demandas ----------
// "7.Conversão OD.xlsx" — Código, Siafisico, Descrição do Item, Conversão.
// Vale pra QUALQUER unidade de Outras Demandas (diferente da exceção
// CEDMAC): quando o código aparece aqui, tanto o Consumo quanto o Estoque
// (vindos do relatório diário de estoque) são divididos pela conversão.
const MAPA_CONVERSAO_OD = {
  codigo_item: ['codigo'],
  siafisico: ['siafisico'],
  descricao_item: ['descricao do item'],
  conversao: ['conversao'],
};
const CAMPOS_CONVERSAO_OD = Object.keys(MAPA_CONVERSAO_OD);

function parsearConversaoOD(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const linhas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });

  const cab = (linhas[0] || []).map(normalizar);
  const COL = {};
  for (const [campo, nomes] of Object.entries(MAPA_CONVERSAO_OD)) COL[campo] = cab.findIndex((c) => nomes.includes(c));
  if (COL.codigo_item === -1) throw new Error('Não encontrei a coluna "Código" na planilha de Conversão OD.');

  const resultado = [];
  for (let i = 1; i < linhas.length; i++) {
    const r = linhas[i];
    if (!r) continue;
    const codigoItem = texto(r[COL.codigo_item]);
    if (!codigoItem) continue;
    const linha = {};
    for (const campo of CAMPOS_CONVERSAO_OD) {
      const v = COL[campo] >= 0 ? r[COL[campo]] : null;
      linha[campo] = campo === 'conversao' ? numero(v) : texto(v);
    }
    if (!linha.conversao) linha.conversao = 1;
    resultado.push(linha);
  }
  return resultado;
}

function importarConversaoOD(linhas, opcoes = {}) {
  let resumo;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM distribuicao_conversao_od');
    const stmt = db.prepare(
      `INSERT INTO distribuicao_conversao_od (${CAMPOS_CONVERSAO_OD.join(',')}) VALUES (${CAMPOS_CONVERSAO_OD.map(() => '?').join(',')})`
    );
    for (const l of linhas) stmt.run(...CAMPOS_CONVERSAO_OD.map((c) => l[c]));
    resumo = { totalLinhas: linhas.length };
    db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
      .run('distribuicao_conversao_od', opcoes.nomeArquivo || 'Conversão OD', opcoes.usuarioEmail || 'sistema', JSON.stringify(resumo));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return resumo;
}

// Status considerados "pendente de entrega" (definidos pelo Rafael)
const STATUS_PENDENTES = [
  '5. Onda Gerada', '6. Separação', '8. Etiquetagem de volumes', '9. Aguardando Expedição',
  '10. Cte emitido', '11. Aguardando Agendamento', '12. Em processo de carregamento',
  '14. Em rota de entrega', '15. Em Tratativa de SAC',
];

// ---------- Consulta: Status de Faturas ----------
router.get('/faturas/resumo', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) c FROM distribuicao_faturas').get().c;
  const placeholders = STATUS_PENDENTES.map(() => '?').join(',');
  const pendentes = db.prepare(`SELECT COUNT(*) c FROM distribuicao_faturas WHERE status IN (${placeholders})`).get(...STATUS_PENDENTES).c;
  res.json({ total, pendentes });
});

router.get('/faturas', (req, res) => {
  const { q, status, local, page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const cond = [];
  const params = [];
  if (q) {
    cond.push('(nome_material LIKE ? OR codigo_material LIKE ? OR codigo_item LIKE ? OR numero_fatura LIKE ? OR local LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  if (status) { cond.push('status = ?'); params.push(status); }
  if (local) { cond.push('local = ?'); params.push(local); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) c FROM distribuicao_faturas ${where}`).get(...params).c;
  const itens = db.prepare(
    `SELECT * FROM distribuicao_faturas ${where} ORDER BY numero_fatura DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  res.json({ total, itens, page: Number(page), pageSize: limit });
});

router.get('/faturas/filtros', (req, res) => {
  const distintos = (col) => db.prepare(
    `SELECT DISTINCT ${col} v FROM distribuicao_faturas WHERE ${col} IS NOT NULL AND ${col} <> '' ORDER BY v`
  ).all().map((r) => r.v);
  res.json({ status: distintos('status'), local: distintos('local') });
});

// ---------- Consulta: Movimentações (Extrato Simples) ----------
router.get('/movimentacoes', (req, res) => {
  const { q, local_destino, page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const cond = [];
  const params = [];
  if (q) {
    cond.push('(nm_item LIKE ? OR id_item LIKE ? OR codigo_item LIKE ? OR nr_documento LIKE ? OR local_destino LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  if (local_destino) { cond.push('local_destino = ?'); params.push(local_destino); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) c FROM distribuicao_movimentacoes ${where}`).get(...params).c;
  const itens = db.prepare(
    `SELECT * FROM distribuicao_movimentacoes ${where} ORDER BY nr_documento DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  res.json({ total, itens, page: Number(page), pageSize: limit });
});

router.get('/movimentacoes/filtros', (req, res) => {
  const local_destino = db.prepare(
    "SELECT DISTINCT local_destino v FROM distribuicao_movimentacoes WHERE local_destino IS NOT NULL AND local_destino <> '' ORDER BY v"
  ).all().map((r) => r.v);
  res.json({ local_destino });
});

// ---------- Planilha 5: Locais de Entrega (de-para SCODES x GSNET) ----------
const MAPA_LOCAIS = {
  local_entrega: ['local de entrega'],
  cod_local: ['cod local'],
};
const CAMPOS_LOCAIS = Object.keys(MAPA_LOCAIS);

function parsearLocaisEntrega(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const linhas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });

  const cab = (linhas[0] || []).map(normalizar);
  const COL = {};
  for (const [campo, nomes] of Object.entries(MAPA_LOCAIS)) COL[campo] = cab.findIndex((c) => nomes.includes(c));
  if (COL.local_entrega === -1 || COL.cod_local === -1) {
    throw new Error('Não reconheci as colunas da planilha de Locais de Entrega (esperava "Local de Entrega" e "Cod_Local").');
  }

  const resultado = [];
  for (let i = 1; i < linhas.length; i++) {
    const r = linhas[i];
    if (!r) continue;
    const local = texto(r[COL.local_entrega]);
    const cod = texto(r[COL.cod_local]);
    if (!local || !cod) continue;
    resultado.push({ local_entrega: local, cod_local: cod });
  }
  return resultado;
}

function importarLocaisEntrega(linhas, opcoes = {}) {
  let resumo;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM distribuicao_locais_entrega');
    const stmt = db.prepare(
      `INSERT INTO distribuicao_locais_entrega (${CAMPOS_LOCAIS.join(',')}) VALUES (${CAMPOS_LOCAIS.map(() => '?').join(',')})`
    );
    for (const l of linhas) stmt.run(...CAMPOS_LOCAIS.map((c) => l[c]));
    resumo = { totalLinhas: linhas.length };
    db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
      .run('distribuicao_locais_entrega', opcoes.nomeArquivo || 'Locais de Entrega', opcoes.usuarioEmail || 'sistema', JSON.stringify(resumo));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return resumo;
}

// ---------- Cálculo de sugestão de reposição ----------
// Fórmula combinada com o Rafael:
//   Sugestão = (autonomia-alvo × Consumo Mensal) − (Estoque convertido + Fatura em Trânsito), mínimo 0
// Autonomia-alvo = 3 meses (confirmado com dados reais da CEDMAC).
//
// Duas fontes de elegibilidade/consumo, dependendo da unidade:
//   - Unidades com elenco próprio (ex.: CEDMAC, planilha "6.Elenco
//     CEDMAC.xlsx"): lista fechada de itens, Consumo Mensal FIXO (acordo
//     administrativo — não vem do relatório diário), só o Estoque é
//     dividido pela conversão do próprio elenco.
//   - Demais unidades de Outras Demandas (regra geral): elegibilidade =
//     "outras_demandas = Sim" no relatório diário de estoque; Consumo e
//     Estoque vêm do mesmo relatório (por isso os dois são divididos pela
//     conversão, quando o item está na planilha "7.Conversão OD.xlsx").
//
// O vínculo entre a unidade no SCODES (estoque) e no GSNET (fatura em
// trânsito) é feito pelo código numérico da planilha "8.Locais de
// Entrega.xlsx" — não dá pra cruzar por nome porque os dois sistemas
// grafam a unidade de forma diferente (ex.: SCODES "UD 27 - CEDMAC
// HCFMUSP" x GSNET "(2865) - HC - CDEMAC", com erro de digitação no GSNET).
const AUTONOMIA_ALVO_MESES = 3;
// Só entram na sugestão de reposição itens com autonomia atual >= este valor
// (definido com o Rafael). Itens com autonomia menor são ruptura/crítico e
// tratados em outro fluxo, fora desta tela.
const AUTONOMIA_MINIMA_EXIBIR = 2;

// Arredonda para cima até o próximo múltiplo de embalagem (o que se pede ao
// operador). Múltiplo ausente/<=0 equivale a "sem embalagem" (fator 1).
function arredondarParaCima(qtd, multiplo) {
  const m = multiplo && multiplo > 0 ? multiplo : 1;
  return Math.ceil(qtd / m) * m;
}
// Arredonda para baixo até o múltiplo (usado quando o operador não tem
// estoque para o pedido inteiro — só dá pra enviar embalagens fechadas).
function arredondarParaBaixo(qtd, multiplo) {
  const m = multiplo && multiplo > 0 ? multiplo : 1;
  return Math.floor(qtd / m) * m;
}

// Converte "DD/MM/AAAA" -> número comparável (AAAAMMDD) ou null.
function chaveDataBR(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? Number(`${m[3]}${m[2]}${m[1]}`) : null;
}

// Monta, para a última importação do Estoque OD (operador logístico), um mapa
// codigo_item -> { sku, multiplo, estoqueOperador, validade }.
//   - estoqueOperador = MENOR entre o disponível do IBL (soma dos lotes) e o
//     Saldo Disp. do GSNET — é o que de fato pode ser separado/enviado.
//   - validade = a MAIS PRÓXIMA entre os lotes com saldo disponível (FEFO).
function carregarEstoqueOperadorPorItem() {
  const mapa = new Map();
  const ultima = db.prepare('SELECT data_referencia FROM estoque_od_importacoes ORDER BY data_referencia DESC LIMIT 1').get();
  if (!ultima) return { mapa, dataReferencia: null };
  const linhas = db.prepare(`
    SELECT codigo_item, codigo_sku, multiplo_distribuicao, saldo_gsnet, qtde_disponivel, validade
    FROM estoque_od_itens WHERE data_referencia = ? AND codigo_item IS NOT NULL
  `).all(ultima.data_referencia);

  const acc = new Map();
  for (const l of linhas) {
    let a = acc.get(l.codigo_item);
    if (!a) { a = { sku: l.codigo_sku, multiplo: 0, ibl: 0, gsnet: null, validadeChave: null, validade: null }; acc.set(l.codigo_item, a); }
    a.multiplo = Math.max(a.multiplo, l.multiplo_distribuicao || 0);
    a.ibl += l.qtde_disponivel || 0;
    if (l.saldo_gsnet != null) a.gsnet = Math.max(a.gsnet || 0, l.saldo_gsnet);
    if ((l.qtde_disponivel || 0) > 0) {
      const ch = chaveDataBR(l.validade);
      if (ch != null && (a.validadeChave === null || ch < a.validadeChave)) { a.validadeChave = ch; a.validade = l.validade; }
    }
  }
  for (const [codigo, a] of acc) {
    const estoqueOperador = a.gsnet != null ? Math.min(a.gsnet, a.ibl) : a.ibl;
    mapa.set(codigo, { sku: a.sku, multiplo: a.multiplo, estoqueOperador, validade: a.validade });
  }
  return { mapa, dataReferencia: ultima.data_referencia };
}

router.get('/reposicao', (req, res) => {
  const unidade = req.query.unidade;
  if (!unidade) return res.status(400).json({ erro: 'Informe a unidade.' });

  const local = db.prepare('SELECT cod_local FROM distribuicao_locais_entrega WHERE local_entrega = ?').get(unidade);
  if (!local) {
    return res.status(400).json({ erro: `Não encontrei "${unidade}" na planilha de Locais de Entrega — confira se o nome bate exatamente.` });
  }
  const codigoDestino = local.cod_local;

  const ultimaData = db.prepare('SELECT data_referencia FROM estoque_importacoes ORDER BY data_referencia DESC LIMIT 1').get();
  const { mapa: mapaOperador, dataReferencia: dataOperador } = carregarEstoqueOperadorPorItem();

  const placeholders = STATUS_PENDENTES.map(() => '?').join(',');
  const stmtTransito = db.prepare(
    `SELECT COALESCE(SUM(qtde_faturada), 0) v FROM distribuicao_faturas WHERE codigo_destino = ? AND codigo_item = ? AND status IN (${placeholders})`
  );
  const stmtEstoque = ultimaData
    ? db.prepare('SELECT estoque FROM estoque_itens WHERE unidade = ? AND codigo_item = ? AND data_referencia = ? LIMIT 1')
    : null;
  const mapaConversaoOD = new Map(
    db.prepare('SELECT codigo_item, conversao FROM distribuicao_conversao_od').all().map((r) => [r.codigo_item, r.conversao])
  );

  // Duas origens MUTUAMENTE EXCLUSIVAS de itens, conforme a unidade:
  //   - Unidades com elenco fechado próprio (ex.: UD 27 - CEDMAC HCFMUSP,
  //     planilha "6.Elenco CEDMAC.xlsx"): mostra SÓ os itens do elenco, com
  //     consumo FIXO (acordo administrativo).
  //   - Demais unidades de Outras Demandas: mostra os itens marcados como
  //     "Outras Demandas = Sim" na query de itens em estoque, com consumo e
  //     estoque vindos do relatório diário (÷ Conversão OD quando houver).
  const elenco = db.prepare(
    'SELECT * FROM distribuicao_itens_elegiveis WHERE unidade_dispensadora = ? ORDER BY descricao_item'
  ).all(unidade);

  let base;
  if (elenco.length > 0) {
    base = elenco.map((el) => ({
      codigo_item: el.codigo_item,
      siafisico: el.siafisico,
      descricao_item: el.descricao_item,
      consumoMensal: el.consumo_mensal_fixo || 0,
      conversaoEstoque: el.conversao || 1,
    }));
  } else if (ultimaData) {
    const linhasEstoque = db.prepare(
      "SELECT codigo_item, descricao, siafisico, consumo_mensal_total FROM estoque_itens WHERE unidade = ? AND data_referencia = ? AND outras_demandas = 'Sim' ORDER BY descricao"
    ).all(unidade, ultimaData.data_referencia);
    base = linhasEstoque.map((l) => {
      const conv = mapaConversaoOD.get(l.codigo_item) || 1;
      return {
        codigo_item: l.codigo_item,
        siafisico: l.siafisico,
        descricao_item: l.descricao,
        consumoMensal: conv !== 1 ? (l.consumo_mensal_total || 0) / conv : (l.consumo_mensal_total || 0),
        conversaoEstoque: conv,
      };
    });
  } else {
    base = [];
  }

  // 1ª passada: calcula, por item, o consumo/estoque/autonomia, a sugestão
  // bruta (para 3 meses) e a reposição arredondada ao múltiplo de embalagem.
  let itens = base.map((it) => {
    const estoqueRow = stmtEstoque && ultimaData ? stmtEstoque.get(unidade, it.codigo_item, ultimaData.data_referencia) : null;
    const estoqueBruto = estoqueRow ? (estoqueRow.estoque || 0) : 0;
    const estoqueConvertido = it.conversaoEstoque !== 1 ? estoqueBruto / it.conversaoEstoque : estoqueBruto;

    const faturaTransito = stmtTransito.get(codigoDestino, it.codigo_item, ...STATUS_PENDENTES).v || 0;

    const sugestao = Math.max(0, Math.round((AUTONOMIA_ALVO_MESES * it.consumoMensal) - (estoqueConvertido + faturaTransito)));
    const autonomia = it.consumoMensal > 0 ? (estoqueConvertido + faturaTransito) / it.consumoMensal : null;

    const op = mapaOperador.get(it.codigo_item) || null;
    const multiplo = op ? op.multiplo : null;
    const reposicaoArredondada = sugestao > 0 ? arredondarParaCima(sugestao, multiplo) : 0;

    return {
      codigo_item: it.codigo_item,
      codigo_sku: op ? op.sku : null,
      siafisico: it.siafisico,
      descricao_item: it.descricao_item,
      conversao: it.conversaoEstoque,
      convertido: it.conversaoEstoque !== 1,
      consumo_mensal: Math.round(it.consumoMensal * 100) / 100,
      estoque_bruto: estoqueBruto,
      estoque_convertido: Math.round(estoqueConvertido * 100) / 100,
      fatura_transito: faturaTransito,
      autonomia: autonomia === null ? null : Math.round(autonomia * 10) / 10,
      multiplo_embalagem: multiplo,
      estoque_operador: op ? op.estoqueOperador : null,
      validade: op ? op.validade : null,
      sugestao,
      reposicao: reposicaoArredondada, // pode ser ajustado na 2ª passada (parcial)
    };
  });

  // Filtro: só itens com autonomia >= 2 (esconde os críticos < 2). Itens sem
  // consumo (autonomia indefinida) permanecem — a sugestão deles é 0 mesmo.
  itens = itens.filter((it) => it.autonomia === null || it.autonomia >= AUTONOMIA_MINIMA_EXIBIR);

  // 2ª passada: agrupa por Código GSNET (SKU) e resolve o atendimento contra o
  // estoque do operador logístico. Etiquetas:
  //   - total   : operador cobre todo o subtotal do SKU.
  //   - parcial : operador tem estoque, mas menos que o subtotal -> distribui
  //               igualitariamente entre os itens do grupo (embalagens fechadas).
  //   - sem_reposicao : nada a repor, ou operador sem estoque.
  const grupos = new Map();
  for (const it of itens) {
    const chave = it.codigo_sku || `__sem_sku__${it.codigo_item}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(it);
  }

  for (const [, grupo] of grupos) {
    const subtotal = grupo.reduce((s, it) => s + (it.reposicao || 0), 0);
    const operador = grupo[0].estoque_operador; // mesmo SKU -> mesmo estoque operador
    const multiplo = grupo[0].multiplo_embalagem;
    let etiqueta;

    if (subtotal <= 0) {
      etiqueta = 'sem_reposicao';
      grupo.forEach((it) => { it.reposicao = 0; it.destaque = false; });
    } else if (operador == null) {
      // Sem vínculo no operador (SKU desconhecido): mantém a sugestão, sem cap.
      etiqueta = 'total';
      grupo.forEach((it) => { it.destaque = false; });
    } else if (operador >= subtotal) {
      etiqueta = 'total';
      grupo.forEach((it) => { it.destaque = false; });
    } else if (operador > 0) {
      etiqueta = 'parcial';
      // Distribuição igualitária: cada item recebe uma fatia igual do estoque
      // do operador, arredondada para baixo ao múltiplo e limitada ao que
      // pediria. Sobra por arredondamento fica sem enviar (embalagem fechada).
      const fatia = operador / grupo.length;
      grupo.forEach((it) => {
        it.reposicao = Math.min(it.reposicao, arredondarParaBaixo(fatia, multiplo));
        it.destaque = true;
      });
    } else {
      etiqueta = 'sem_reposicao'; // operador zerado
      grupo.forEach((it) => { it.reposicao = 0; it.destaque = true; });
    }
    grupo.forEach((it) => { it.etiqueta = etiqueta; it.subtotal_sku = grupo.reduce((s, x) => s + (x.reposicao || 0), 0); });
  }

  res.json({
    unidade,
    modo: elenco.length > 0 ? 'elenco_fechado' : 'geral',
    dataReferenciaEstoque: ultimaData ? ultimaData.data_referencia : null,
    dataReferenciaOperador: dataOperador,
    autonomiaAlvoMeses: AUTONOMIA_ALVO_MESES,
    autonomiaMinimaExibir: AUTONOMIA_MINIMA_EXIBIR,
    total: itens.length,
    itens,
  });
});

// ---------- Consulta: unidades disponíveis pra reposição ----------
router.get('/reposicao/unidades', (req, res) => {
  const unidades = db.prepare(`
    SELECT DISTINCT unidade v FROM estoque_itens
    WHERE unidade IS NOT NULL AND unidade <> ''
    ORDER BY v
  `).all().map((r) => r.v);
  res.json({ unidades });
});

// ---------- Consulta: Itens Elegíveis ----------
router.get('/elegiveis', (req, res) => {
  const itens = db.prepare('SELECT * FROM distribuicao_itens_elegiveis ORDER BY unidade_dispensadora, descricao_item').all();
  res.json({ total: itens.length, itens });
});

// ---------- Consulta: Conversão OD ----------
router.get('/conversao-od', (req, res) => {
  const itens = db.prepare('SELECT * FROM distribuicao_conversao_od ORDER BY descricao_item').all();
  res.json({ total: itens.length, itens });
});

module.exports = router;
module.exports.parsearStatusFaturas = parsearStatusFaturas;
module.exports.parsearExtratoSimples = parsearExtratoSimples;
module.exports.parsearItensElegiveis = parsearItensElegiveis;
module.exports.parsearConversaoOD = parsearConversaoOD;
module.exports.parsearLocaisEntrega = parsearLocaisEntrega;
module.exports.importarStatusFaturas = importarStatusFaturas;
module.exports.importarExtratoSimples = importarExtratoSimples;
module.exports.importarItensElegiveis = importarItensElegiveis;
module.exports.importarConversaoOD = importarConversaoOD;
module.exports.importarLocaisEntrega = importarLocaisEntrega;
module.exports.carregarMapeamentoGsnet = carregarMapeamentoGsnet;
module.exports.STATUS_PENDENTES = STATUS_PENDENTES;
