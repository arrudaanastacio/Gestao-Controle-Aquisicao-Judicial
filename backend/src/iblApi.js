// =====================================================================
// iblApi.js — Cliente da API de Estoque IBL (CEAF / SES-SP, SIAL WMS)
//
// API REST somente leitura. Buscamos o snapshot de estoque por projeto
// (local) — hoje só 2999 (IMPORTADOS) e 3004 (DEMANDA EXTRAORDINÁRIA).
//
// Segredos (NUNCA no código — repo é público): vêm do .env
//   IBL_API_KEY     token técnico (X-API-Key / Bearer)
//   IBL_COMPANY_ID  UUID da empresa no SIAL
//   IBL_BASE_URL    default https://sessp.sialwms.com.br
//   IBL_PROJETOS    default "2999,3004"
//
// Observação de granularidade: a API devolve UMA linha por
// (item × lote × situação). O Estoque OD trabalha com UMA linha por lote,
// com colunas separadas de Disponível/Bloqueado/Reservada. Por isso
// `iblLinhasNoFormatoOD()` PIVOTA as situações de volta para colunas,
// reproduzindo o mesmo shape do parser da planilha "5.Estoque IBL.xlsx".
// =====================================================================

const BASE_URL = process.env.IBL_BASE_URL || 'https://sessp.sialwms.com.br';
const PATH_SNAPSHOT = '/integrations/ceaf/stock-snapshot';
const PATH_PROGRAMS = '/integrations/ceaf/programs';

function projetosPadrao() {
  return String(process.env.IBL_PROJETOS || '2999,3004')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function exigirCredenciais() {
  const key = process.env.IBL_API_KEY;
  const company = process.env.IBL_COMPANY_ID;
  if (!key) throw new Error('IBL_API_KEY ausente no .env (token da API IBL).');
  if (!company) throw new Error('IBL_COMPANY_ID ausente no .env (UUID da empresa).');
  return { key, company };
}

// GET autenticado com timeout. Usa o fetch nativo do Node 22+.
async function getJson(url, key) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'X-API-Key': key, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const corpo = await resp.text().catch(() => '');
      throw new Error(`IBL HTTP ${resp.status} em ${url}${corpo ? ' — ' + corpo.slice(0, 200) : ''}`);
    }
    return resp.json();
  } finally {
    clearTimeout(t);
  }
}

// Lista os programas (locais) com saldo. Útil para conferência.
async function listarProgramas() {
  const { key, company } = exigirCredenciais();
  const url = `${BASE_URL}${PATH_PROGRAMS}?company_id=${encodeURIComponent(company)}`;
  const d = await getJson(url, key);
  return d.programs || [];
}

// Busca TODAS as páginas do snapshot de UM projeto (local).
async function buscarProjeto(projeto, { pageSize = 5000 } = {}) {
  const { key, company } = exigirCredenciais();
  const linhas = [];
  let pagina = 1, totalPaginas = 1, geradoEm = null;
  do {
    const url = `${BASE_URL}${PATH_SNAPSHOT}?company_id=${encodeURIComponent(company)}`
      + `&projeto_codigo=${encodeURIComponent(projeto)}&page=${pagina}&page_size=${pageSize}`;
    const d = await getJson(url, key);
    geradoEm = d.gerado_em || geradoEm;
    totalPaginas = d.total_paginas || 1;
    for (const l of (d.linhas || [])) linhas.push(l);
    pagina += 1;
  } while (pagina <= totalPaginas);
  return { projeto, geradoEm, linhas };
}

// Busca vários projetos (locais) e devolve as linhas cruas concatenadas.
async function buscarSnapshot(projetos = projetosPadrao(), opcoes = {}) {
  const porProjeto = [];
  let todas = [];
  let geradoEm = null;
  for (const p of projetos) {
    const r = await buscarProjeto(p, opcoes);
    geradoEm = r.geradoEm || geradoEm;
    porProjeto.push({ projeto: p, linhas: r.linhas.length });
    todas = todas.concat(r.linhas);
  }
  return { projetos, geradoEm, porProjeto, linhas: todas };
}

// ---- Conversões para o formato do Estoque OD (parser da planilha IBL) ----

function texto(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}
function numero(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
// "2028-09-30" -> "30/09/2028" (mesmo formato BR que o parser da planilha grava).
function isoParaBR(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

// Em qual "balde" de quantidade a situação cai (Disponível/Bloqueado/Reservada).
function baldeDaSituacao(situacao) {
  const s = String(situacao || '').toUpperCase();
  if (s === 'DISPONIVEL') return 'disp';
  if (s === 'RESERVADO') return 'reserv';
  // VENCIDO, QUARENTENA, AVARIADO e BLOQUEADO entram como bloqueado/indisponível.
  return 'bloq';
}

// Pivota as linhas cruas (item × lote × situação) para UMA linha por lote,
// no mesmo shape que parsearIbl() da planilha produz.
function pivotarParaOD(linhasCruas) {
  const mapa = new Map(); // chave: sku|lote|validade
  for (const l of linhasCruas) {
    const sku = texto(l.cod_item);
    if (!sku) continue;
    const lote = texto(l.lote) || '';
    const validade = isoParaBR(l.data_validade);
    const projeto = texto(l.projeto_codigo) || '';
    const chave = `${projeto}|${sku}|${lote}|${validade || ''}`;
    let row = mapa.get(chave);
    if (!row) {
      row = {
        projeto_codigo: projeto || null,
        projeto_nome: texto(l.projeto_nome),
        codigo_sku: sku,
        siafisico: texto(l.siafisico),
        descricao: texto(l.descricao_item),
        lote: texto(l.lote),
        validade,
        embalagem2: null,
        valor_unitario: numero(l.valor_unitario),
        multiplo_distribuicao: numero(l.multiplo_distribuicao),
        status_estoque: null, // preenchido abaixo pela situação predominante
        tipo_bloqueio: null,
        obs_bloqueio: texto(l.motivo_bloqueio),
        qtde_disponivel: 0,
        qtde_bloqueado: 0,
        qtde_reservada: 0,
        qtde_total: 0,
        _situacoes: new Set(),
      };
      mapa.set(chave, row);
    }
    const q = numero(l.quantidade) || 0;
    const balde = baldeDaSituacao(l.situacao_qualidade);
    if (balde === 'disp') row.qtde_disponivel += q;
    else if (balde === 'reserv') row.qtde_reservada += q;
    else row.qtde_bloqueado += q;
    row.qtde_total += q;
    row._situacoes.add(String(l.situacao_qualidade || '').toUpperCase());
    if (l.motivo_bloqueio && !row.obs_bloqueio) row.obs_bloqueio = texto(l.motivo_bloqueio);
  }
  // status_estoque textual: "Disponível" se houver saldo disponível, senão a situação encontrada.
  const linhas = [];
  for (const row of mapa.values()) {
    const sit = row._situacoes;
    row.status_estoque = row.qtde_disponivel > 0
      ? 'Disponível'
      : (sit.has('BLOQUEADO') ? 'Bloqueado'
        : sit.has('RESERVADO') ? 'Reservado'
          : sit.has('VENCIDO') ? 'Vencido'
            : [...sit][0] || null);
    delete row._situacoes;
    linhas.push(row);
  }
  return linhas;
}

// Busca a API e já devolve as linhas no formato do Estoque OD (pivotadas).
async function iblLinhasNoFormatoOD(projetos = projetosPadrao(), opcoes = {}) {
  const snap = await buscarSnapshot(projetos, opcoes);
  return { ...snap, linhasOD: pivotarParaOD(snap.linhas) };
}

module.exports = {
  BASE_URL, projetosPadrao, listarProgramas, buscarSnapshot,
  pivotarParaOD, iblLinhasNoFormatoOD, isoParaBR,
};
