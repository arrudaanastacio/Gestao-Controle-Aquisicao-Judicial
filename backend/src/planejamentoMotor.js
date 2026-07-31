// =====================================================================
// planejamentoMotor.js
// Motor de cálculo do Planejamento de Compras (Tenente Pena).
//
// É uma função PURA de cálculo: lê as fotos mais recentes dos insumos que já
// vivem no banco (estoque UDTP, solicitações em aberto, consumo LOIS, carta de
// troca, irregulares, atas SISCOA, classificação do item) e devolve, item a
// item, a linha calculada no formato da tabela `planejamento_itens`. NÃO grava
// nada — quem persiste é a rota, ao "salvar" um documento de planejamento.
//
// Fórmula (validada contra a planilha real do Rafael — venetoclax 100mg):
//   autonomia_existente = (estoque + empenhado + solicitado) / consumo_mensal
//   autonomia_sugerida  = clamp(alvo − autonomia_existente, 0, teto)
//        (teto = meses até a ata vencer; só para itens de ATA)
//   quantidade          = MROUND(autonomia_sugerida × consumo × conv, conv)
//        (conv = item_classificacao.embalagem_conversao, default 1)
//   custo_total         = quantidade × preço unitário da ata (só ATA)
//   analise_critica     = autonomia_existente + autonomia_sugerida  (cobertura final)
//
// Consumo usado na QUANTIDADE = SCODES (estoque_itens.consumo_mensal_total).
// LOIS (plan_consumo_medio.consumo_medio) vem ao lado como contexto (a coluna
// "%" = LOIS ÷ SCODES revela ruptura quando baixa). Ver memórias
// planejamento-regras-autonomia e planejamento-fontes-dados.
// =====================================================================

const db = require('./db');

// Arredonda x para o múltiplo mais próximo de m (igual ao MROUND do Excel).
function mround(x, m) {
  if (!Number.isFinite(x)) return null;
  const passo = Number.isFinite(m) && m > 0 ? m : 1;
  return Math.round(x / passo) * passo;
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

// Diferença em meses (aprox.) entre duas datas ISO YYYY-MM-DD. Pode ser negativa.
function mesesEntre(deISO, ateISO) {
  const de = new Date(`${deISO}T00:00:00`);
  const ate = new Date(`${ateISO}T00:00:00`);
  if (isNaN(de) || isNaN(ate)) return null;
  return (ate - de) / (1000 * 60 * 60 * 24 * 30.4375);
}

// Normaliza "S"/"Sim"/1 -> true (usado para importado / irregular).
function ehSim(v) {
  return /^s/i.test(String(v ?? '').trim());
}

// ---------------------------------------------------------------------
// Calcula o planejamento e devolve { dataBase, parametros, linhas, resumo }.
//
// opcoes:
//   unidade            'TP' (padrão) — reservado para futuras unidades
//   dataBase           YYYY-MM-DD (padrão = foto de estoque mais recente)
//   autonomiaAlvoAta   meses-alvo para itens com ata vigente (padrão 6)
//   autonomiaAlvoPregao meses-alvo para itens sem ata (padrão 9)
//   cortePoucaDemanda  demanda_total <= corte => "pouca demanda" (padrão 3)
//   autonomiaPoucaDemanda  se informado, vira o alvo dos itens de pouca demanda
//                          (Pregão/Inex). Se null, não reduz — só sinaliza.
//   incluirZerados     inclui itens com consumo 0 (padrão false — funil remove)
// ---------------------------------------------------------------------
function calcularPlanejamento(opcoes = {}) {
  const unidade = opcoes.unidade || 'TP';
  const alvoAta = num(opcoes.autonomiaAlvoAta, 6);
  const alvoPregao = num(opcoes.autonomiaAlvoPregao, 9);
  const corte = num(opcoes.cortePoucaDemanda, 3);
  const alvoPouca = opcoes.autonomiaPoucaDemanda === undefined || opcoes.autonomiaPoucaDemanda === null
    ? null : num(opcoes.autonomiaPoucaDemanda, null);
  const incluirZerados = !!opcoes.incluirZerados;

  const dataBase = (opcoes.dataBase
    || db.prepare('SELECT MAX(data_referencia) d FROM estoque_itens').get().d);
  if (!dataBase) return { dataBase: null, parametros: parametros(), linhas: [], resumo: resumoVazio() };

  // Fotos mais recentes dos insumos de planejamento (podem ter data ≠ do estoque).
  const dtCarta = maxData('plan_carta_troca');
  const dtIrreg = maxData('plan_demanda_irregular');
  const dtLois = maxData('plan_consumo_medio');

  // --- Funil de filtragem (arquivo "1.Itens em Estoque" do processo manual): --
  //   base UDTP (TP) -> remove Demandas=0 -> remove Tipo=MANIPULADO
  //   -> remove Importado=Sim. Aqui agregamos 1 linha por item (o relatório traz
  //   uma linha por demanda). Consumo/estoque/etc. são iguais nas linhas do
  //   mesmo item, por isso MAX; demanda é a SOMA.
  const base = db.prepare(`
    SELECT codigo_item,
           MAX(descricao)              AS descricao,
           MAX(siafisico)              AS siafisico,
           MAX(catmat)                 AS catmat,
           MAX(marca)                  AS marca,
           MAX(categoria)              AS categoria,
           MAX(unidade)                AS unidade_estoque,
           MAX(tipo_item)              AS tipo_item,
           MAX(importado)              AS importado,
           MAX(consumo_mensal_total)   AS consumo,
           MAX(consumo_mensal_aj)      AS consumo_aj,
           MAX(estoque)                AS estoque,
           SUM(demandas)               AS demanda_total,
           SUM(demandas_aj)            AS demanda_aj
      FROM estoque_itens
     WHERE data_referencia = ?
     GROUP BY codigo_item
  `).all(dataBase);

  // Consultas pontuais reaproveitadas por item.
  const qEmp = db.prepare(
    "SELECT COALESCE(SUM(qtde_pendente),0) s FROM solicitacoes WHERE codigo_item = ? AND status = 'Empenhado'");
  const qSol = db.prepare(
    "SELECT COALESCE(SUM(qtde_pendente),0) s FROM solicitacoes WHERE codigo_item = ? AND status IN ('Planejamento','Adjucado','Entrega Parcial')");
  const qCarta = dtCarta ? db.prepare('SELECT quantidade_carta q FROM plan_carta_troca WHERE codigo_item = ? AND data_referencia = ?') : null;
  const qIrreg = dtIrreg ? db.prepare('SELECT irregular i FROM plan_demanda_irregular WHERE codigo_item = ? AND data_referencia = ?') : null;
  const qLois = dtLois ? db.prepare('SELECT consumo_medio c FROM plan_consumo_medio WHERE codigo_item = ? AND data_referencia = ?') : null;
  const qClas = db.prepare('SELECT embalagem_conversao, unidade_fornecimento, modalidade_planejamento, subcategoria, inex FROM item_classificacao WHERE codigo_item = ?');
  // Preço dos itens de Pregão (sem ata): valor médio da planilha de Itens (Relatório de Itens).
  const dtItens = maxData('relatorio_itens');
  const qValorItem = dtItens
    ? db.prepare('SELECT valor_medio_unitario v FROM relatorio_itens WHERE codigo = ? AND data_referencia = ? ORDER BY id DESC LIMIT 1')
    : null;
  // Ata "vigente": a de maior vencimento cujo vencimento não passou da data-base.
  const qAta = db.prepare(`
    SELECT ata, vencimento, ultimo_valor_publicado, unidade_fornecimento,
           embalagem_primaria, embalagem_secundaria, detentor_registro, nome_comercial
      FROM atas_itens
     WHERE siafisico = ?
     ORDER BY (vencimento IS NULL), vencimento DESC
     LIMIT 1`);

  const linhas = [];
  for (const b of base) {
    // Funil: remove manipulado e importado.
    if (/manipulad/i.test(String(b.tipo_item || ''))) continue;
    if (ehSim(b.importado)) continue;

    const consumo = numOuNull(b.consumo);
    const demanda = numOuNull(b.demanda_total) || 0;
    // Funil: remove demanda 0 (a menos que peçam para incluir zerados).
    if (!incluirZerados && (!consumo || consumo <= 0) && demanda === 0) continue;

    const empenhado = qEmp.get(b.codigo_item).s || 0;
    const solicitado = qSol.get(b.codigo_item).s || 0;
    const estoque = numOuNull(b.estoque) || 0;
    const carta = qCarta ? (qCarta.get(b.codigo_item, dtCarta)?.q ?? null) : null;
    const irregular = qIrreg ? (qIrreg.get(b.codigo_item, dtIrreg)?.i ?? 0) : 0;
    const loisRow = qLois ? qLois.get(b.codigo_item, dtLois) : null;
    const consumoLois = loisRow ? numOuNull(loisRow.c) : null;
    const clas = qClas.get(b.codigo_item) || {};
    const conv = numOuNull(clas.embalagem_conversao) || 1;

    const ata = qAta.get(String(b.siafisico ?? ''));
    // Ata vigente = existe e não venceu antes da data-base.
    const ataVigente = ata && ata.vencimento && ata.vencimento >= dataBase ? ata : null;

    // Classificação da MODALIDADE (ATA / PREGAO / REVISAR):
    //   sem ata vigente                         -> PREGAO
    //   ata vigente + marca bate (ou sem marca) -> ATA
    //   ata vigente + marca NÃO bate            -> REVISAR (técnico decide)
    // O técnico pode forçar via item_classificacao.modalidade_planejamento.
    const marcaEstoque = b.marca || null;
    const nomeAta = ataVigente ? (ataVigente.nome_comercial || null) : null;
    const marcaOk = ataVigente ? marcasBatem(marcaEstoque, nomeAta) : false;
    // Inex marcado na classificação (Sim) tem precedência: item vai por Inexigibilidade.
    const ehInex = /^s/i.test(String(clas.inex ?? '').trim());
    let modalidadeCalc;
    if (ehInex) modalidadeCalc = 'INEX';
    else if (!ataVigente) modalidadeCalc = 'PREGAO';
    else if (marcaOk) modalidadeCalc = 'ATA';
    else modalidadeCalc = 'REVISAR';
    const forcada = normModalidade(clas.modalidade_planejamento);
    const modalidade = forcada || modalidadeCalc;
    // Para o cálculo (embalagem/preço), REVISAR e ATA usam a ata; PREGAO/INEX não.
    const usaAta = modalidade === 'ATA' || modalidade === 'REVISAR';

    // Autonomia que o item já tem (em meses), somando compras em aberto.
    const autonomiaExistente = consumo && consumo > 0
      ? (estoque + empenhado + solicitado) / consumo : null;

    // Alvo por modalidade, com desconto opcional para pouca demanda (Pregão/Inex).
    const poucaDemanda = demanda > 0 && demanda <= corte;
    let alvo = usaAta ? alvoAta : alvoPregao;
    if (!usaAta && poucaDemanda && alvoPouca !== null) alvo = alvoPouca;

    // Teto: só quando usa ata — não adianta pedir além da vigência da ata.
    let teto = Infinity;
    if (usaAta && ataVigente && ataVigente.vencimento) {
      const m = mesesEntre(dataBase, ataVigente.vencimento);
      teto = m === null ? Infinity : Math.max(0, m);
    }

    // Autonomia sugerida (o "Autonomia de Compra"): o que falta para o alvo.
    let autonomiaSugerida = null;
    if (autonomiaExistente !== null) {
      autonomiaSugerida = clamp(alvo - autonomiaExistente, 0, teto);
    } else if (consumo === null || consumo === 0) {
      autonomiaSugerida = 0; // sem consumo não há como projetar quantidade
    }

    // Embalagem do cálculo (conforme os modelos ATA/Pregão do Rafael):
    //   MULTIPLICADOR ("Conversão") = item_classificacao.embalagem_conversao — o fator
    //     que o Rafael pesquisa (frasco→ml/g/dose). 1 para itens sem fracionamento.
    //   PASSO do MROUND ("Embalagem"):
    //     ATA    -> embalagem_primária da ata (SISCOA)
    //     Pregão -> a própria conversão (modelo: MROUND(Z×consumo×G, G))
    // Quantidade = MROUND(autonomia × consumo × multiplicador, passo), arredondando
    // Judicial e ADM SEPARADAMENTE e somando (AF = AD + AE nos modelos).
    let embMult = conv, embPasso;
    if (usaAta && ataVigente) {
      const p = numOuNull(ataVigente.embalagem_primaria);
      embPasso = p && p > 0 ? p : 1;
    } else {
      embPasso = conv;
    }
    const consumoJud = numOuNull(b.consumo_aj) || 0;
    const consumoAdm = Math.max(0, (consumo || 0) - consumoJud);

    let qtdJud = null, qtdAdm = null, quantidade = null;
    if (autonomiaSugerida !== null && consumo && consumo > 0) {
      qtdJud = mround(autonomiaSugerida * consumoJud * embMult, embPasso);
      qtdAdm = mround(autonomiaSugerida * consumoAdm * embMult, embPasso);
      quantidade = (qtdJud || 0) + (qtdAdm || 0);
    }

    // Preço: ATA/REVISAR usam o último valor publicado da ata; Pregão usa o
    // valor médio da planilha de Itens (Relatório de Itens).
    const valorMedioItem = qValorItem ? numOuNull(qValorItem.get(b.codigo_item, dtItens)?.v) : null;
    const preco = (usaAta && ataVigente)
      ? numOuNull(ataVigente.ultimo_valor_publicado)
      : valorMedioItem;
    const custo = quantidade !== null && preco !== null ? quantidade * preco : null;
    const analiseCritica = autonomiaExistente !== null && autonomiaSugerida !== null
      ? autonomiaExistente + autonomiaSugerida : null;
    const percentLois = consumoLois !== null && consumo && consumo > 0
      ? consumoLois / consumo : null;

    linhas.push({
      codigo_item: b.codigo_item,
      descricao: b.descricao,
      siafisico: b.siafisico,
      catmat: b.catmat,
      // insumos (foto)
      consumo_mensal: consumo,
      estoque,
      empenhado,
      solicitado,
      carta_troca: carta,
      reservado: null,
      // "Conversão" (multiplicador do MROUND): ATA = emb. secundária; Pregão = conv.
      embalagem_conversao: embMult,
      // Item de ATA: unidade de fornecimento (e embalagens/detentor) vêm do
      // módulo Atas de Registro de Preço. Pregão/Inex: da classificação do item.
      unidade_fornecimento: (usaAta && ataVigente)
        ? (ataVigente.unidade_fornecimento || clas.unidade_fornecimento || null)
        : (clas.unidade_fornecimento || null),
      demanda_total: demanda,
      irregular: irregular ? 1 : 0,
      ata_numero: (usaAta && ataVigente) ? ataVigente.ata : null,
      ata_validade: (usaAta && ataVigente) ? ataVigente.vencimento : null,
      preco_unitario: preco,
      // resultado
      autonomia_existente: arred(autonomiaExistente, 2),
      autonomia_sugerida: arred(autonomiaSugerida, 2),
      autonomia_ajustada: null,
      quantidade_calculada: quantidade,
      custo_total: custo === null ? null : arred(custo, 2),
      comprar: 1,
      observacao: null,
      // extras (não persistidos; contexto de tela e export nos modelos)
      _modalidade: modalidade,
      _modalidade_calc: modalidadeCalc,     // classificação automática (antes do override)
      _modalidade_forcada: forcada || null, // override do técnico (se houver)
      _marca_estoque: marcaEstoque,
      _categoria: b.categoria || null,
      _subcategoria: clas.subcategoria || null,
      // Os dois preços (para a tela alternar quando o técnico muda a modalidade):
      _preco_ata: ataVigente ? numOuNull(ataVigente.ultimo_valor_publicado) : null,
      _preco_medio: valorMedioItem,
      _ata_nome_comercial: ataVigente ? (ataVigente.nome_comercial || null) : null,
      _ata_emb_primaria: ataVigente ? (ataVigente.embalagem_primaria || null) : null,
      _ata_emb_secundaria: ataVigente ? (ataVigente.embalagem_secundaria || null) : null,
      _detentor: ataVigente ? (ataVigente.detentor_registro || null) : null,
      _emb_passo: embPasso,        // passo do MROUND (ATA = emb. primária; Pregão = conv)
      _qtd_jud: qtdJud,
      _qtd_adm: qtdAdm,
      _consumo_aj: numOuNull(b.consumo_aj),
      _demanda_aj: numOuNull(b.demanda_aj) || 0,
      _consumo_lois: consumoLois,
      _percent_lois: percentLois === null ? null : arred(percentLois, 4),
      _pouca_demanda: poucaDemanda ? 1 : 0,
      _teto_meses: Number.isFinite(teto) ? arred(teto, 2) : null,
      _analise_critica: arred(analiseCritica, 2),
    });
  }

  // Resumo por modalidade.
  const resumo = {
    total_itens: linhas.length,
    ata: linhas.filter((l) => l._modalidade === 'ATA').length,
    pregao: linhas.filter((l) => l._modalidade === 'PREGAO').length,
    inex: linhas.filter((l) => l._modalidade === 'INEX').length,
    revisar: linhas.filter((l) => l._modalidade === 'REVISAR').length,
    com_quantidade: linhas.filter((l) => l.quantidade_calculada > 0).length,
    custo_total_ata: arred(linhas.reduce((s, l) => s + (l.custo_total || 0), 0), 2),
  };

  function parametros() {
    return {
      unidade, dataBase,
      autonomiaAlvoAta: alvoAta, autonomiaAlvoPregao: alvoPregao,
      cortePoucaDemanda: corte, autonomiaPoucaDemanda: alvoPouca,
      fotos: { carta: dtCarta, irregular: dtIrreg, lois: dtLois },
    };
  }

  return { dataBase, parametros: parametros(), linhas, resumo };

  function resumoVazio() { return { total_itens: 0, ata: 0, pregao: 0, inex: 0, revisar: 0, com_quantidade: 0, custo_total_ata: 0 }; }
}

// Normaliza marca/nome-comercial para comparar: maiúsculas, sem acento, sem
// dosagem (ex.: "2 MG/G", "100 MG", "5 ML") e sem pontuação.
function normMarca(s) {
  if (s === null || s === undefined) return '';
  let t = String(s).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  t = t.replace(/\b\d+([.,]\d+)?\s*(MG\/ML|MG\/G|MCG|MG|ML|G|UI|KG|L|%)\b/g, ' ');
  return t.replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
// Marca do estoque atende à ata? Igual, contida, ou item "SEM MARCA"/sem marca
// (sem exigência de marca) => atende. Divergente => REVISAR (decide o técnico).
function marcasBatem(marcaEstoque, nomeAta) {
  const a = normMarca(marcaEstoque);
  // Sem marca exigida no item judicial: qualquer marca da ata atende.
  if (!a || a === 'SEM MARCA') return true;
  const b = normMarca(nomeAta);
  if (!b) return false;
  if (a === b) return true;
  if (b.startsWith(a) || a.startsWith(b)) return true;
  return (' ' + b + ' ').includes(' ' + a + ' ') || (' ' + a + ' ').includes(' ' + b + ' ');
}
// Normaliza o override de modalidade gravado pelo técnico.
function normModalidade(v) {
  const t = String(v ?? '').trim().toUpperCase();
  if (t === 'ATA') return 'ATA';
  if (t === 'PREGAO' || t === 'PREGÃO') return 'PREGAO';
  if (t === 'INEX') return 'INEX';
  return null;
}

function maxData(tabela) {
  try { return db.prepare(`SELECT MAX(data_referencia) d FROM ${tabela}`).get().d; }
  catch { return null; }
}
function num(v, def) { const n = Number(v); return Number.isFinite(n) ? n : def; }
function numOuNull(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function arred(v, casas) { if (v === null || v === undefined || !Number.isFinite(v)) return null; const f = 10 ** casas; return Math.round(v * f) / f; }

module.exports = { calcularPlanejamento, mround };
