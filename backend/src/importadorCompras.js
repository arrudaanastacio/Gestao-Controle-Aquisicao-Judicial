// =====================================================================
// importadorCompras.js
// Motor do IMPORTADOR ÚNICO de solicitações de compra (modelo 2027).
//
// Um só arquivo de aquisição (o mesmo enviado ao setor de Compras) alimenta
// qualquer DESTINO, escolhido na hora de subir:
//   - 'Medicamentos'    -> tabela `solicitacoes`      (TP, campo SEI = n_oficio)
//   - 'Outras Demandas' -> tabela `solicitacoes_od`   (OD, campo SEI = n_oficio)
//   - 'Nutrição'        -> tabela `solicitacoes_seg`  (segmento, campo `sei`)
//   - 'Materiais'       -> tabela `solicitacoes_seg`  (segmento, campo `sei`)
//
// O arquivo traz só o PEDIDO (código, siafísico, item, qtde, tipo, SEI,
// requisição, mês, ano, modalidade, data). Empenho/entrega/status NÃO vêm
// daqui — são preenchidos pelos robôs do GSNET.
//
// Colunas mapeadas por NOME de cabeçalho (tolera acento/maiúsc./quebra de
// linha/espaço), não por posição — layout que muda de ordem não quebra.
//
// Identidade/unicidade da solicitação: codigo_item + ano + mês + SEI +
// requisição GSNET. O mesmo item pode ter várias solicitações no mês, desde
// que SEI/requisição difiram. O importador NUNCA apaga: insere só o que ainda
// não existe por essa chave (seguro para rodar repetido).
// =====================================================================
const XLSX = require('xlsx');
const db = require('./db');

// ---------- Normalização de texto (cabeçalhos e chaves) ----------
function normalizar(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // tira acento
    .replace(/\s+/g, ' ')                              // quebra de linha/espaços -> 1 espaço
    .trim().toLowerCase()
    .replace(/\./g, '');                               // tira ponto de abreviação ("qtde." -> "qtde")
}

// Sinônimos aceitos por campo (já normalizados). O 1º que casar vence.
const CABECALHOS = {
  codigo_item:       ['codigo scodes', 'scodes', 'codigo do item', 'codigo item', 'codigo'],
  codigo_siafisico:  ['codigo siafisico', 'siafisico', 'cod siafisico'],
  descricao:         ['item', 'descricao', 'descricao do item', 'descritivo'],
  qtde_solicitada:   ['qtde solicitada', 'quantidade solicitada', 'qtd solicitada', 'qtde'],
  tipo:              ['tipo'],
  sei:               ['sei', 'n sei', 'numero sei', 'processo sei'],
  requisicao_gsnet:  ['requisicao gsnet', 'requisicao', 'gsnet', 'req gsnet'],
  mes:               ['mes'],
  ano:               ['ano'],
  modalidade_compra: ['modalidade de compra', 'modalidade', 'modalidade compra'],
  data_solicitacao:  ['data de solicitacao', 'data solicitacao', 'data da solicitacao'],
};

// Campos obrigatórios para a linha ser utilizável.
const OBRIGATORIOS = ['codigo_item', 'ano', 'mes'];

const MESES_VALIDOS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const MESES_NORM = new Map(MESES_VALIDOS.map((m) => [normalizar(m), m]));

// ---------- Destinos ----------
// colSei: onde o SEI é gravado em cada tabela; qtdeNumerica: REAL vs TEXT.
const DESTINOS = {
  'Medicamentos':    { tabela: 'solicitacoes',     colSei: 'n_oficio', qtdeNumerica: true,  segmento: null },
  'Outras Demandas': { tabela: 'solicitacoes_od',  colSei: 'n_oficio', qtdeNumerica: false, segmento: null },
  'Nutrição':        { tabela: 'solicitacoes_seg', colSei: 'sei',      qtdeNumerica: true,  segmento: 'Nutrição' },
  'Materiais':       { tabela: 'solicitacoes_seg', colSei: 'sei',      qtdeNumerica: true,  segmento: 'Materiais' },
};

function destinoValido(d) { return Object.prototype.hasOwnProperty.call(DESTINOS, d); }

// ---------- Limpeza de valores ----------
function limpar(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' || t === '-' ? null : t;
  }
  if (typeof v === 'number') return v;
  return v;
}

function texto(v) {
  const t = limpar(v);
  return t === null ? null : String(t);
}

// Requisição GSNET: a planilha costuma trazer número ("4508" -> "4508.0").
function limparGsnet(v) {
  const t = limpar(v);
  if (t === null) return null;
  if (typeof t === 'number') return Number.isInteger(t) ? String(t) : String(t);
  return String(t).replace(/^(\d+)\.0+$/, '$1');
}

function paraDataIso(v) {
  const t = limpar(v);
  if (t === null) return null;
  if (t instanceof Date) return t.toISOString().slice(0, 10);
  if (typeof t === 'number') {
    const d = XLSX.SSF.parse_date_code(t);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  return String(t);
}

function paraMes(v) {
  const t = limpar(v);
  if (t === null) return null;
  // Aceita "Janeiro", "JANEIRO", "janeiro", ou número 1..12.
  if (typeof t === 'number' && t >= 1 && t <= 12) return MESES_VALIDOS[t - 1];
  const n = normalizar(t);
  if (MESES_NORM.has(n)) return MESES_NORM.get(n);
  const num = parseInt(n, 10);
  if (num >= 1 && num <= 12) return MESES_VALIDOS[num - 1];
  return String(t); // deixa passar como veio; validação de obrigatórios decide
}

function paraNumero(v) {
  const t = limpar(v);
  if (t === null) return null;
  if (typeof t === 'number') return t;
  // Texto numérico pt-BR: "1.234,56" -> 1234.56; "12,5" -> 12.5
  const s = String(t).replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ---------- Leitura da planilha ----------
// Lê a 1ª aba, acha a linha de cabeçalho (a que mapear mais campos), e
// devolve as linhas já traduzidas para os campos internos.
function processarPlanilha(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const nomeAba = wb.SheetNames[0];
  if (!nomeAba) throw new Error('A planilha não tem nenhuma aba.');
  const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, defval: null });
  if (linhas.length < 1) throw new Error('A planilha está vazia.');

  // Procura a linha de cabeçalho nas primeiras 10 linhas: a que casar mais campos.
  let melhorIdx = -1, melhorMapa = null, melhorQtd = -1;
  for (let i = 0; i < Math.min(10, linhas.length); i++) {
    const { mapa, qtd } = mapearCabecalho(linhas[i]);
    if (qtd > melhorQtd) { melhorQtd = qtd; melhorMapa = mapa; melhorIdx = i; }
  }
  if (melhorQtd < 3) {
    throw new Error('Não reconheci o cabeçalho. Confira se as colunas incluem pelo menos Código, Ano e Mês.');
  }

  // Campos obrigatórios têm que ter coluna.
  const faltando = OBRIGATORIOS.filter((c) => !(c in melhorMapa));
  if (faltando.length) {
    const nomes = { codigo_item: 'Código', ano: 'Ano', mes: 'Mês' };
    throw new Error(`Faltam colunas obrigatórias no cabeçalho: ${faltando.map((c) => nomes[c] || c).join(', ')}.`);
  }

  const registros = [];
  for (let i = melhorIdx + 1; i < linhas.length; i++) {
    const linha = linhas[i];
    if (!linha || linha.every((c) => c === null || String(c).trim() === '')) continue; // linha em branco
    const r = traduzirLinha(linha, melhorMapa);
    if (!r.codigo_item || !r.ano || !r.mes) continue; // sem identificação mínima
    registros.push(r);
  }

  return { registros, colunasReconhecidas: Object.keys(melhorMapa), aba: nomeAba };
}

// Dado o array de células do cabeçalho, devolve { mapa: {campo: indiceColuna}, qtd }.
function mapearCabecalho(celulas) {
  const mapa = {};
  if (!Array.isArray(celulas)) return { mapa, qtd: 0 };
  const norm = celulas.map((c) => normalizar(c));
  for (const [campo, nomes] of Object.entries(CABECALHOS)) {
    if (campo in mapa) continue;
    for (const nome of nomes) {
      const idx = norm.indexOf(nome);
      if (idx !== -1) { mapa[campo] = idx; break; }
    }
  }
  return { mapa, qtd: Object.keys(mapa).length };
}

function traduzirLinha(linha, mapa) {
  const pega = (campo) => (campo in mapa ? linha[mapa[campo]] : null);
  return {
    codigo_item: texto(pega('codigo_item')),
    codigo_siafisico: texto(pega('codigo_siafisico')),
    descricao: texto(pega('descricao')),
    qtde_solicitada: pega('qtde_solicitada'), // convertido no destino (REAL/TEXT)
    tipo: texto(pega('tipo')),
    sei: texto(pega('sei')),
    requisicao_gsnet: limparGsnet(pega('requisicao_gsnet')),
    mes: paraMes(pega('mes')),
    ano: (() => { const n = parseInt(texto(pega('ano')), 10); return Number.isFinite(n) ? n : null; })(),
    modalidade_compra: texto(pega('modalidade_compra')),
    data_solicitacao: paraDataIso(pega('data_solicitacao')),
  };
}

// ---------- Auto-cadastro do item no elenco (`itens`) ----------
// `solicitacoes` tem FK para `itens`; e os relatórios cruzam por `itens` para
// pegar descrição/siafísico. Então todo item importado precisa existir lá.
const stmtItemElenco = db.prepare('SELECT codigo_item FROM itens WHERE codigo_item = ?');
const stmtItemSCODES = db.prepare(
  `SELECT siafisico, descricao_item, catmat FROM relatorio_itens
    WHERE codigo = ? ORDER BY data_referencia DESC, id DESC LIMIT 1`
);
const stmtInserirItem = db.prepare(
  `INSERT OR IGNORE INTO itens (codigo_item, codigo_siafisico, descricao, catmat, ativo, atualizado_em)
   VALUES (?, ?, ?, ?, 1, datetime('now','localtime'))`
);
function garantirItemNoElenco(r) {
  if (stmtItemElenco.get(r.codigo_item)) return 'existente';
  const sc = stmtItemSCODES.get(r.codigo_item);
  if (sc && sc.descricao_item) {
    stmtInserirItem.run(r.codigo_item, sc.siafisico || r.codigo_siafisico || null, sc.descricao_item, sc.catmat || null);
    return 'scodes';
  }
  if (r.descricao) {
    stmtInserirItem.run(r.codigo_item, r.codigo_siafisico || null, r.descricao, null);
    return 'planilha';
  }
  return null;
}

// ---------- Chave de identidade (unicidade) ----------
function chaveIdentidade(r) {
  return [r.codigo_item, r.ano, r.mes, r.sei, r.requisicao_gsnet]
    .map((v) => (v === null || v === undefined ? '' : String(v).trim()))
    .join('||');
}

// ---------- Montagem da linha para INSERT, por destino ----------
function montarInsert(destino, r) {
  const cfg = DESTINOS[destino];
  const qtde = cfg.qtdeNumerica ? paraNumero(r.qtde_solicitada) : texto(r.qtde_solicitada);

  if (cfg.tabela === 'solicitacoes') {
    return {
      cols: ['codigo_item','ano','mes','tipo','modalidade_compra','n_oficio','qtde_solicitada','data_solicitacao','requisicao_gsnet'],
      vals: [r.codigo_item, r.ano, r.mes, r.tipo, r.modalidade_compra, r.sei, qtde, r.data_solicitacao, r.requisicao_gsnet],
    };
  }
  if (cfg.tabela === 'solicitacoes_od') {
    return {
      cols: ['codigo_item','descricao','codigo_siafisico','ano','mes','tipo','modalidade_compra','n_oficio','qtde_solicitada','data_solicitacao','requisicao_gsnet'],
      vals: [r.codigo_item, r.descricao, r.codigo_siafisico, r.ano, r.mes, r.tipo, r.modalidade_compra, r.sei, qtde, r.data_solicitacao, r.requisicao_gsnet],
    };
  }
  // solicitacoes_seg
  return {
    cols: ['segmento','codigo_item','ano','mes','tipo','modalidade_compra','sei','qtde_solicitada','data_solicitacao','requisicao_gsnet'],
    vals: [cfg.segmento, r.codigo_item, r.ano, r.mes, r.tipo, r.modalidade_compra, r.sei, qtde, r.data_solicitacao, r.requisicao_gsnet],
  };
}

// Carrega as chaves de identidade já existentes no destino para um (ano, mês),
// para não reinserir. Para solicitacoes_seg filtra também pelo segmento.
function chavesExistentes(destino, ano, mes) {
  const cfg = DESTINOS[destino];
  const colSei = cfg.colSei;
  let sql, params;
  if (cfg.segmento) {
    sql = `SELECT codigo_item, ano, mes, ${colSei} AS sei, requisicao_gsnet FROM ${cfg.tabela} WHERE segmento = ? AND ano = ? AND mes = ?`;
    params = [cfg.segmento, ano, mes];
  } else {
    sql = `SELECT codigo_item, ano, mes, ${colSei} AS sei, requisicao_gsnet FROM ${cfg.tabela} WHERE ano = ? AND mes = ?`;
    params = [ano, mes];
  }
  return new Set(db.prepare(sql).all(...params).map(chaveIdentidade));
}

// ---------- Gravação ----------
// Insere só o que ainda não existe (pela chave). Nunca apaga. Transação única.
function gravar(buffer, destino, nomeArquivo, usuarioEmail, usuarioId = null) {
  if (!destinoValido(destino)) throw new Error(`Destino inválido: "${destino}".`);
  const { registros, colunasReconhecidas, aba } = processarPlanilha(buffer);

  let inseridos = 0, ignorados = 0, itensInexistentes = 0;
  const codigosInexistentes = new Set();
  const codigosCadastrados = new Set();

  // Agrupa por (ano, mês) para carregar as chaves existentes uma vez por mês.
  const porMes = new Map();
  for (const r of registros) {
    const k = `${r.ano}||${r.mes}`;
    if (!porMes.has(k)) porMes.set(k, []);
    porMes.get(k).push(r);
  }

  db.exec('BEGIN');
  try {
    for (const [k, lista] of porMes) {
      const [anoTxt, mes] = k.split('||');
      const ano = Number(anoTxt);
      const jaExistem = chavesExistentes(destino, ano, mes);

      for (const r of lista) {
        const origem = garantirItemNoElenco(r);
        if (!origem) { itensInexistentes++; codigosInexistentes.add(r.codigo_item); continue; }
        if (origem !== 'existente') codigosCadastrados.add(r.codigo_item);

        const chave = chaveIdentidade(r);
        if (jaExistem.has(chave)) { ignorados++; continue; }

        const { cols, vals } = montarInsert(destino, r);
        db.prepare(`INSERT INTO ${DESTINOS[destino].tabela} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
        jaExistem.add(chave);
        inseridos++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const resumo = {
    destino, aba, colunasReconhecidas,
    totalLinhas: registros.length, inseridos, ignorados,
    itensInexistentes, itensCadastrados: codigosCadastrados.size,
    codigosCadastrados: Array.from(codigosCadastrados).slice(0, 50),
    codigosInexistentes: Array.from(codigosInexistentes).slice(0, 20),
  };

  db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
    .run('compras:' + destino, nomeArquivo, usuarioEmail, JSON.stringify(resumo));
  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
    .run(usuarioId, usuarioEmail, 'importar_compras', DESTINOS[destino].tabela, JSON.stringify(resumo));

  return resumo;
}

// ---------- Prévia (não grava nada) ----------
function previa(buffer, destino) {
  if (!destinoValido(destino)) throw new Error(`Destino inválido: "${destino}".`);
  const { registros, colunasReconhecidas, aba } = processarPlanilha(buffer);

  let novos = 0, jaExistentes = 0, itensACadastrar = 0;
  const cacheMes = new Map();
  const codigosACadastrar = new Set();

  for (const r of registros) {
    if (!stmtItemElenco.get(r.codigo_item)) {
      const sc = stmtItemSCODES.get(r.codigo_item);
      if ((sc && sc.descricao_item) || r.descricao) { itensACadastrar++; codigosACadastrar.add(r.codigo_item); }
    }
    const k = `${r.ano}||${r.mes}`;
    if (!cacheMes.has(k)) cacheMes.set(k, chavesExistentes(destino, r.ano, r.mes));
    const existentes = cacheMes.get(k);
    const chave = chaveIdentidade(r);
    if (existentes.has(chave)) { jaExistentes++; } else { existentes.add(chave); novos++; }
  }

  return {
    destino, aba, colunasReconhecidas,
    totalLinhas: registros.length, novos, jaExistentes,
    itensACadastrar, codigosACadastrar: Array.from(codigosACadastrar).slice(0, 20),
  };
}

module.exports = { gravar, previa, processarPlanilha, DESTINOS, destinoValido, normalizar };
