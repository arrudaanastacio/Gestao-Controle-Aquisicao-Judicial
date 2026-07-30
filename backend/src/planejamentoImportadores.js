// =====================================================================
// planejamentoImportadores.js
// Importadores dos três relatórios que alimentam o Planejamento de Compras
// e ainda não vinham para o banco:
//   - Consumo Médio (LOIS)   -> plan_consumo_medio
//   - Carta de Troca         -> plan_carta_troca
//   - Irregulares            -> plan_demanda_irregular
//
// Todos cruzam por codigo_item (SCODES/PRO_CODIGO). Cada importação é uma FOTO
// datada: preserva o histórico e só substitui se reimportar a MESMA data de
// referência (mesmo princípio do importador de estoque). Escrita em transação
// única para não prender o banco (node:sqlite é síncrono).
// =====================================================================

const XLSX = require('xlsx');
const db = require('./db');

// Normaliza cabeçalho: sem acento, minúsculo, espaço único.
function norm(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[._]/g, ' ')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// Converte texto BR/planilha em número (tolera "1.234,56", vazio, "-").
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let t = String(v).trim();
  if (t === '' || t === '-') return null;
  // Se tem vírgula E ponto, ponto é milhar; se só vírgula, vírgula é decimal.
  if (t.includes(',') && t.includes('.')) t = t.replace(/\./g, '').replace(',', '.');
  else if (t.includes(',')) t = t.replace(',', '.');
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

function texto(v) {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

// Acha a linha de cabeçalho procurando por um conjunto de rótulos esperados.
function acharCabecalho(linhas, obrigatorias, limite = 12) {
  for (let i = 0; i < Math.min(linhas.length, limite); i++) {
    const cab = (linhas[i] || []).map(norm);
    if (obrigatorias.every((o) => cab.some((c) => c.includes(o)))) return i;
  }
  return -1;
}

// Índice da coluna cujo cabeçalho casa (contém) algum dos nomes.
function idxCol(cab, nomes) {
  return cab.findIndex((c) => nomes.some((n) => c === n || c.includes(n)));
}

// Grava linhas numa tabela de insumo, substituindo a MESMA data de referência.
function gravarFoto(tabela, colunas, linhas, dataReferencia, extra = {}) {
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM ${tabela} WHERE data_referencia = ?`).run(dataReferencia);
    const todas = ['data_referencia', ...colunas];
    const stmt = db.prepare(
      `INSERT INTO ${tabela} (${todas.join(',')}) VALUES (${todas.map(() => '?').join(',')})`
    );
    for (const l of linhas) stmt.run(dataReferencia, ...colunas.map((c) => (l[c] === undefined ? null : l[c])));
    // Log de importação (mesma tabela usada pelos outros importadores).
    try {
      db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
        .run(tabela, extra.nomeArquivo || tabela, extra.usuarioEmail || 'sistema',
          JSON.stringify({ dataReferencia, total: linhas.length }));
    } catch { /* tabela importacoes pode não ter a mesma forma; não é crítico */ }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { dataReferencia, total: linhas.length };
}

// Data de referência a partir de "Data de Geração: 02/07/2026 14:54" -> ISO.
function dataDeGeracao(brutas, padrao) {
  for (let i = 0; i < Math.min(brutas.length, 8); i++) {
    for (const cel of brutas[i] || []) {
      const m = String(cel).match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (m && /gera|data/i.test(String(cel))) return `${m[3]}-${m[2]}-${m[1]}`;
    }
  }
  return padrao || new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// 1) CONSUMO MÉDIO (LOIS)
// Cabeçalho na ~linha 6. Colunas: Código UDTP | SCODES | Consumo x6 | Ruptura
// x6 | Dias Zerados x6 | Saldo | Consumo SCODES | Consumo Médio | Autonomia
// SCODES | Autonomia LOIS. Parâmetros ("Meses para consolidar", "Considera
// rupturas") ficam no topo do arquivo.
// ---------------------------------------------------------------------
function importarConsumoMedio(buffer, opcoes = {}) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false });
  const sheet = wb.Sheets[wb.SheetNames.find((n) => /consumo/i.test(n)) || wb.SheetNames[0]];
  const brutas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });

  const hc = acharCabecalho(brutas, ['scodes', 'consumo medio']);
  if (hc === -1) throw new Error('Não reconheci o layout do Consumo Médio (não achei "SCODES" e "Consumo Médio").');
  const cab = (brutas[hc] || []).map(norm);

  const COL = {
    codigo: idxCol(cab, ['scodes']),
    consumo_medio: idxCol(cab, ['consumo medio']),
    consumo_scodes: idxCol(cab, ['consumo scodes']),
    autonomia_scodes: idxCol(cab, ['autonomia scodes']),
    autonomia_lois: idxCol(cab, ['autonomia lois']),
    saldo: idxCol(cab, ['saldo']),
  };
  if (COL.codigo === -1 || COL.consumo_medio === -1) {
    throw new Error('Colunas essenciais do Consumo Médio não encontradas (SCODES / Consumo Médio).');
  }

  // Parâmetros do topo
  let meses = null, considera = null;
  for (let i = 0; i < hc; i++) {
    const txt = (brutas[i] || []).map((c) => String(c)).join(' ');
    const mm = txt.match(/consolidar[:\s]+(\d+)/i);
    if (mm) meses = parseInt(mm[1], 10);
    if (/considera rupturas/i.test(txt)) considera = /sim/i.test(txt) ? 1 : 0;
  }

  const linhas = [];
  for (let i = hc + 1; i < brutas.length; i++) {
    const r = brutas[i]; if (!r) continue;
    const codigo = texto(r[COL.codigo]);
    if (!codigo) continue;
    linhas.push({
      codigo_item: codigo,
      consumo_medio: num(r[COL.consumo_medio]),
      consumo_scodes: COL.consumo_scodes >= 0 ? num(r[COL.consumo_scodes]) : null,
      autonomia_scodes: COL.autonomia_scodes >= 0 ? num(r[COL.autonomia_scodes]) : null,
      autonomia_lois: COL.autonomia_lois >= 0 ? num(r[COL.autonomia_lois]) : null,
      saldo: COL.saldo >= 0 ? num(r[COL.saldo]) : null,
      meses_consolidados: meses,
      considera_rupturas: considera,
    });
  }

  const dataRef = (opcoes.dataReferencia || dataDeGeracao(brutas)).slice(0, 10);
  const cols = ['codigo_item', 'consumo_medio', 'consumo_scodes', 'autonomia_scodes',
    'autonomia_lois', 'saldo', 'meses_consolidados', 'considera_rupturas'];
  const resumo = gravarFoto('plan_consumo_medio', cols, linhas, dataRef, opcoes);
  resumo.mesesConsolidados = meses;
  resumo.consideraRupturas = considera;
  return resumo;
}

// ---------------------------------------------------------------------
// 2) CARTA DE TROCA
// Cabeçalho ~linha 5. Interessa: SCODES + "Quantidade Carta de Troca".
// ---------------------------------------------------------------------
function importarCartaTroca(buffer, opcoes = {}) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const brutas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });

  const hc = acharCabecalho(brutas, ['scodes', 'carta de troca']);
  if (hc === -1) throw new Error('Não reconheci o layout da Carta de Troca (não achei "SCODES" e "Carta de Troca").');
  const cab = (brutas[hc] || []).map(norm);
  const iCod = idxCol(cab, ['scodes']);
  const iQtd = idxCol(cab, ['quantidade carta de troca']);
  if (iCod === -1 || iQtd === -1) throw new Error('Colunas essenciais da Carta de Troca não encontradas.');

  const linhas = [];
  for (let i = hc + 1; i < brutas.length; i++) {
    const r = brutas[i]; if (!r) continue;
    const codigo = texto(r[iCod]);
    if (!codigo) continue;
    const q = num(r[iQtd]);
    // Só guarda quem tem carta de troca > 0 (o resto é ruído: 7.436 linhas).
    if (!q) continue;
    linhas.push({ codigo_item: codigo, quantidade_carta: q });
  }

  const dataRef = (opcoes.dataReferencia || new Date().toISOString().slice(0, 10)).slice(0, 10);
  return gravarFoto('plan_carta_troca', ['codigo_item', 'quantidade_carta'], linhas, dataRef, opcoes);
}

// ---------------------------------------------------------------------
// 3) IRREGULARES
// Cabeçalho ~linha 3. PRO_CODIGO | ORP_IRREGULAR (S/N) | Total.
// ---------------------------------------------------------------------
function importarIrregulares(buffer, opcoes = {}) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false });
  // A aba de dados é a "Planilha1" (as outras são bases auxiliares).
  const sheet = wb.Sheets[wb.SheetNames.find((n) => /planilha1/i.test(n)) || wb.SheetNames[0]];
  const brutas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });

  const hc = acharCabecalho(brutas, ['pro codigo', 'irregular'], 8);
  if (hc === -1) throw new Error('Não reconheci o layout de Irregulares (não achei "PRO_CODIGO" e "IRREGULAR").');
  const cab = (brutas[hc] || []).map(norm);
  const iCod = idxCol(cab, ['pro codigo']);
  const iIrr = idxCol(cab, ['irregular', 'orp irregular']);
  const iTot = idxCol(cab, ['total']);

  const linhas = [];
  for (let i = hc + 1; i < brutas.length; i++) {
    const r = brutas[i]; if (!r) continue;
    const codigo = texto(r[iCod]);
    if (!codigo) continue;
    const irr = /^s/i.test(String(r[iIrr] ?? '')) ? 1 : 0;
    linhas.push({ codigo_item: codigo, irregular: irr, quantidade: iTot >= 0 ? num(r[iTot]) : null });
  }

  const dataRef = (opcoes.dataReferencia || new Date().toISOString().slice(0, 10)).slice(0, 10);
  return gravarFoto('plan_demanda_irregular', ['codigo_item', 'irregular', 'quantidade'], linhas, dataRef, opcoes);
}

module.exports = { importarConsumoMedio, importarCartaTroca, importarIrregulares };
