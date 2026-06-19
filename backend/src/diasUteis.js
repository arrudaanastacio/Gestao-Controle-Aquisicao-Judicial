// Cálculo de dias úteis e feriados nacionais (Brasil), usado para a regra
// de "primeiro dia útil subsequente" no arquivamento histórico de estoque.

function iso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dia}`;
}

function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDias(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

// Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher)
function pascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(ano, mes - 1, dia);
}

// Conjunto de feriados nacionais (ISO yyyy-mm-dd) de um ano.
// Fixos + móveis (relativos à Páscoa): Carnaval (seg/ter), Sexta-feira Santa,
// Corpus Christi. Carnaval e Sexta-feira Santa entram porque não há expediente.
const _cacheFeriados = {};
function feriadosNacionais(ano) {
  if (_cacheFeriados[ano]) return _cacheFeriados[ano];
  const fixos = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '12-25'];
  const set = new Set(fixos.map((md) => `${ano}-${md}`));
  const p = pascoa(ano);
  [-48, -47, -2, 60].forEach((off) => set.add(iso(addDias(p, off))));
  _cacheFeriados[ano] = set;
  return set;
}

function ehDiaUtil(d) {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;             // domingo/sábado
  return !feriadosNacionais(d.getFullYear()).has(iso(d));
}

// Primeiro dia útil em D ou depois de D
function primeiroDiaUtilEmDiante(d) {
  let r = new Date(d);
  while (!ehDiaUtil(r)) r = addDias(r, 1);
  return r;
}

// Dada a data de coleta (ISO) e o conjunto de referências já arquivadas,
// retorna a referência (01 ou 15) que esta coleta cumpre, ou null.
// Regra: a coleta vale para a referência cuja data agendada (primeiro dia
// útil >= 01/15) seja <= coleta, dentro de uma janela de 6 dias (tolerância
// para importações atrasadas), e que ainda não tenha sido arquivada.
function referenciaParaColeta(dataColetaISO, jaArquivadas = new Set()) {
  const D = parseISO(dataColetaISO);
  const ano = D.getFullYear();
  const mes = String(D.getMonth() + 1).padStart(2, '0');
  const refs = [`${ano}-${mes}-15`, `${ano}-${mes}-01`]; // checa 15 antes de 01

  for (const R of refs) {
    if (jaArquivadas.has(R)) continue;
    const agendada = primeiroDiaUtilEmDiante(parseISO(R));
    const inicio = iso(agendada);
    const fim = iso(addDias(agendada, 6));
    if (dataColetaISO >= inicio && dataColetaISO <= fim) return R;
  }
  return null;
}

module.exports = {
  iso, parseISO, pascoa, feriadosNacionais, ehDiaUtil,
  primeiroDiaUtilEmDiante, referenciaParaColeta,
};
