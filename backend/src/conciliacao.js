// =====================================================================
// conciliacao.js — Motor compartilhado dos robôs "Associar"
// (baixa de ENTREGA e de EMPENHO nas solicitações de compra).
//
// Peças reutilizáveis:
//   normalizarEmpenho() — resolve os formatos diferentes de nº de empenho
//     (2025NE25 / 2025NE00025 / 2026NE01987) para comparar entre tabelas.
//   chaveEntrada() — chave natural estável de uma linha de Movimentação de
//     Entrada (a tabela é recarregada do Oracle todo dia, então NÃO se pode
//     usar o id; esta chave sobrevive à recarga e evita associar 2x.
//   gerarPropostasEntrada() — casa entradas x compras em aberto (SCODES +
//     Empenho + Quantidade) e devolve as propostas com nota de confiança.
// =====================================================================
const db = require('./db');

// Solicitações "em aberto" (pendentes de entrega) — decisão do Rafael.
const STATUS_ABERTO = ['Planejamento', 'Adjudicado', 'Empenhado', 'Entrega Parcial'];

// Normaliza "AAAANE<numero>" tirando zeros à esquerda do número.
// 2025NE00025 -> "2025NE25";  2026NE01987 -> "2026NE1987". Sem casar o
// padrão, devolve o texto limpo em maiúsculas (comparação ainda possível).
function normalizarEmpenho(v) {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase().replace(/\s+/g, '');
  if (!s || s === '—') return null;
  const m = s.match(/^(\d{4})NE0*(\d+)$/);
  if (m) return `${m[1]}NE${m[2]}`;
  return s;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Pendente da solicitação: usa qtde_pendente se houver; senão solicitada - entregue.
function pendenteSolicitacao(s) {
  const p = num(s.qtde_pendente);
  if (p != null) return p;
  const sol = num(s.qtde_solicitada) || 0;
  const ent = num(s.qtde_entregue) || 0;
  return Math.max(0, sol - ent);
}

// Chave natural de uma linha de entrada (estável entre recargas do Oracle).
function chaveEntrada(e) {
  return [
    e.codigo_item || '',
    (e.data_entrada || '').slice(0, 19),
    e.nota_fiscal || '',
    normalizarEmpenho(e.nota_empenho) || '',
    num(e.qtde) ?? '',
    e.lote || '',
  ].join('|');
}

// Índice das solicitações em aberto, agrupadas por codigo_item.
function solicitacoesAbertasPorItem() {
  const ph = STATUS_ABERTO.map(() => '?').join(',');
  const linhas = db.prepare(
    `SELECT id, codigo_item, ano, mes, tipo, status, n_empenho,
            qtde_solicitada, qtde_entregue, qtde_pendente
     FROM solicitacoes WHERE status IN (${ph})`
  ).all(...STATUS_ABERTO);
  const mapa = new Map();
  for (const s of linhas) {
    if (!mapa.has(s.codigo_item)) mapa.set(s.codigo_item, []);
    mapa.get(s.codigo_item).push(s);
  }
  return mapa;
}

// Conjunto de chaves de entrada JÁ associadas (não desfeitas) — para pular.
function chavesJaAssociadas() {
  const set = new Set();
  for (const r of db.prepare(
    "SELECT chave_origem FROM associacoes WHERE origem='entrega' AND desfeita=0"
  ).all()) set.add(r.chave_origem);
  return set;
}

// Conjunto de chaves de entrada marcadas como IGNORAR — para pular (some das
// abas Pendente e "A associar" e não gera proposta).
function chavesIgnoradas() {
  const set = new Set();
  try {
    for (const r of db.prepare('SELECT chave_origem FROM entradas_ignoradas').all()) set.add(r.chave_origem);
  } catch (_) { /* tabela pode nao existir em banco antigo */ }
  return set;
}

// Escolhe a melhor solicitação-candidata para uma entrada.
// Ordem de preferência: casa empenho > quantidade exata > menor pendente que caiba.
function melhorCandidata(entrada, candidatas) {
  const empE = normalizarEmpenho(entrada.nota_empenho);
  const q = num(entrada.qtde) || 0;
  let melhor = null, melhorScore = -1;
  for (const s of candidatas) {
    const pend = pendenteSolicitacao(s);
    if (pend <= 0) continue;
    const empS = normalizarEmpenho(s.n_empenho);
    const empMatch = !!(empE && empS && empE === empS);
    const qtdeExata = q === pend;
    // pontuação: empenho vale mais; quantidade exata desempata.
    let score = 0;
    if (empMatch) score += 100;
    if (qtdeExata) score += 10;
    score += Math.max(0, 5 - Math.abs(pend - q) / Math.max(1, pend)); // proximidade
    if (score > melhorScore) { melhorScore = score; melhor = { s, pend, empMatch, qtdeExata }; }
  }
  return melhor;
}

// Gera propostas de ENTREGA (não grava — só devolve a lista).
function gerarPropostasEntrada() {
  const abertas = solicitacoesAbertasPorItem();
  const jaAssoc = chavesJaAssociadas();
  const ignoradas = chavesIgnoradas();
  const entradas = db.prepare(
    "SELECT * FROM entrada_lotes_itens WHERE unidade LIKE '%Tenente Pena%'"
  ).all();

  const propostas = [];
  for (const e of entradas) {
    const q = num(e.qtde);
    if (!q || q <= 0) continue;
    const candidatas = abertas.get(e.codigo_item);
    if (!candidatas || !candidatas.length) continue;      // sem compra em aberto
    const chave = chaveEntrada(e);
    if (jaAssoc.has(chave)) continue;                     // já associada
    if (ignoradas.has(chave)) continue;                   // marcada como Ignorar

    const best = melhorCandidata(e, candidatas);
    if (!best) continue;

    const empMatch = best.empMatch, qtdeExata = best.qtdeExata, pend = best.pend;
    // Regras de confiança (SCODES sempre confere aqui):
    //   empenho confere            -> ALTA
    //   sem empenho mas qtde exata -> REVISAR
    //   caso contrário             -> não propõe (vai para "a associar")
    let confianca = null;
    if (empMatch) confianca = 'alta';
    else if (qtdeExata) confianca = 'revisar';
    if (!confianca) continue;

    const resultado = q >= pend ? 'Finalizado' : 'Entrega Parcial';
    propostas.push({
      origem: 'entrega',
      chave_origem: chave,
      codigo_item: e.codigo_item,
      solicitacao_id: best.s.id,
      quantidade: q,
      confianca,
      sinais: { SCODES: true, Empenho: empMatch, Quantidade: qtdeExata },
      resultado_previsto: resultado,
      detalhe: {
        item: e.item, data_entrada: e.data_entrada, nota_fiscal: e.nota_fiscal,
        nota_empenho: e.nota_empenho, lote: e.lote, qtde: q,
        sol_mes: best.s.mes, sol_ano: best.s.ano, sol_tipo: best.s.tipo,
        sol_status: best.s.status, sol_pendente: pend,
      },
    });
  }
  return propostas;
}

// ---------------------------------------------------------------------
// ROBÔ DE EMPENHOS: casa empenhos (Controle de Empenhos) x compras em aberto
// SEM Nº Empenho, para preencher n_empenho / quantidade_empenho / status.
// ---------------------------------------------------------------------

// Extrai o padrão de SEI (024.00000000/AAAA-DD) de um texto qualquer.
function extrairSEI(s) {
  if (!s) return null;
  const m = String(s).match(/\d{3}\.\d{6,}\/\d{4}-\d{2}/);
  return m ? m[0] : null;
}
// Chave natural de um empenho (estável entre reimportações do robô).
function chaveEmpenho(e) {
  return 'emp|' + [
    normalizarEmpenho(e.nota_empenho) || '',
    e.scodes || e.siafisico || '',
    num(e.quantidade) ?? '',
    e.numero_requisicao || '',
  ].join('|');
}

// Compras em aberto SEM empenho, agrupadas por codigo_item.
function comprasSemEmpenhoPorItem() {
  const ph = STATUS_ABERTO.map(() => '?').join(',');
  const linhas = db.prepare(
    `SELECT id, codigo_item, ano, mes, tipo, status, n_oficio, requisicao_gsnet, qtde_solicitada
     FROM solicitacoes WHERE status IN (${ph}) AND (n_empenho IS NULL OR n_empenho='')`
  ).all(...STATUS_ABERTO);
  const mapa = new Map();
  for (const s of linhas) {
    if (!mapa.has(s.codigo_item)) mapa.set(s.codigo_item, []);
    mapa.get(s.codigo_item).push(s);
  }
  return mapa;
}

function gerarPropostasEmpenho() {
  const alvo = comprasSemEmpenhoPorItem();
  if (!alvo.size) return [];
  // Ponte Siafísico -> codigo_item (empenhos às vezes só têm o siafísico).
  const siafParaItem = new Map();
  for (const r of db.prepare("SELECT codigo_item, codigo_siafisico FROM itens WHERE codigo_siafisico IS NOT NULL AND codigo_siafisico<>''").all()) {
    siafParaItem.set(String(r.codigo_siafisico).trim(), r.codigo_item);
  }
  // Empenhos já associados (não desfeitos) -> pular.
  const jaAssoc = new Set(db.prepare("SELECT chave_origem FROM associacoes WHERE origem='empenho' AND desfeita=0").all().map(r => r.chave_origem));

  // Indexa empenhos por codigo_item (direto por scodes ou via siafísico).
  const empPorItem = new Map();
  for (const e of db.prepare('SELECT * FROM empenhos').all()) {
    const cod = (e.scodes && String(e.scodes).trim()) || siafParaItem.get(String(e.siafisico || '').trim());
    if (!cod || !alvo.has(cod)) continue; // só interessa quem tem compra-alvo
    if (!empPorItem.has(cod)) empPorItem.set(cod, []);
    empPorItem.get(cod).push(e);
  }

  const propostas = [];
  const empUsados = new Set();
  for (const [cod, compras] of alvo) {
    const emps = empPorItem.get(cod);
    if (!emps) continue;
    for (const s of compras) {
      const seiSol = extrairSEI(s.n_oficio);
      const req = s.requisicao_gsnet ? String(s.requisicao_gsnet).trim() : null;
      const qSol = num(s.qtde_solicitada);
      let best = null, bestScore = -1;
      for (const e of emps) {
        const chave = chaveEmpenho(e);
        if (jaAssoc.has(chave) || empUsados.has(chave)) continue;
        const reqM = !!(req && e.numero_requisicao && req === String(e.numero_requisicao).trim());
        const seiM = !!(seiSol && extrairSEI(e.processo_sem_papel) === seiSol);
        const qtdM = !!(qSol != null && num(e.quantidade) === qSol);
        let score = (reqM ? 100 : 0) + (seiM ? 100 : 0) + (qtdM ? 10 : 0);
        if (score > bestScore) { bestScore = score; best = { e, chave, reqM, seiM, qtdM }; }
      }
      if (!best) continue;
      const forte = best.reqM || best.seiM;
      let confianca = null;
      if (forte) confianca = 'alta';
      else if (best.qtdM) confianca = 'revisar';
      if (!confianca) continue;
      empUsados.add(best.chave);
      propostas.push({
        origem: 'empenho', chave_origem: best.chave, codigo_item: cod, solicitacao_id: s.id,
        quantidade: num(best.e.quantidade),
        confianca, sinais: { SCODES: true, Requisicao: best.reqM, SEI: best.seiM, Quantidade: best.qtdM },
        resultado_previsto: 'Empenhado',
        detalhe: {
          nota_empenho: best.e.nota_empenho, quantidade: num(best.e.quantidade), empresa: best.e.empresa,
          numero_requisicao: best.e.numero_requisicao, processo: best.e.processo_sem_papel, medicamento: best.e.medicamento,
          sol_mes: s.mes, sol_ano: s.ano, sol_tipo: s.tipo, sol_status: s.status, sol_solicitada: qSol,
        },
      });
      break; // uma compra recebe um empenho por vez (o melhor)
    }
  }
  return propostas;
}

// Regenera a fila 'pendente' de um robô: preserva as REJEITADAS (não
// reaparecem) e as já aprovadas/associadas (o motor já ignora). Usado tanto
// pelas rotas "Rodar robô agora" quanto pelo agendador diário.
function salvarPropostasPendentes(origem, gerarFn) {
  const rejeitadas = new Set(db.prepare(
    "SELECT chave_origem FROM propostas_conciliacao WHERE origem=? AND situacao='rejeitada'"
  ).all(origem).map(r => r.chave_origem));
  const propostas = gerarFn().filter(p => !rejeitadas.has(p.chave_origem));
  const ins = db.prepare(`INSERT INTO propostas_conciliacao
    (origem, chave_origem, codigo_item, solicitacao_id, quantidade, confianca, sinais_json, resultado_previsto, detalhe_json, situacao)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente')`);
  db.exec('BEGIN');
  try {
    db.prepare("DELETE FROM propostas_conciliacao WHERE origem=? AND situacao='pendente'").run(origem);
    for (const p of propostas) {
      ins.run(origem, p.chave_origem, p.codigo_item, p.solicitacao_id, p.quantidade, p.confianca,
        JSON.stringify(p.sinais), p.resultado_previsto, JSON.stringify(p.detalhe));
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const alta = propostas.filter(p => p.confianca === 'alta').length;
  return { total: propostas.length, alta, revisar: propostas.length - alta };
}
function regenerarEntrada() { return salvarPropostasPendentes('entrega', gerarPropostasEntrada); }
function regenerarEmpenho() { return salvarPropostasPendentes('empenho', gerarPropostasEmpenho); }

module.exports = {
  STATUS_ABERTO, normalizarEmpenho, pendenteSolicitacao, chaveEntrada, chaveEmpenho, extrairSEI,
  solicitacoesAbertasPorItem, comprasSemEmpenhoPorItem, gerarPropostasEntrada, gerarPropostasEmpenho,
  salvarPropostasPendentes, regenerarEntrada, regenerarEmpenho, chavesIgnoradas,
};
