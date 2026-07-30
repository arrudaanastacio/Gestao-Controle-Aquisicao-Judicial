// =====================================================================
// routes.planejamento.js
// Rota do Planejamento de Compras (Tenente Pena).
//
// PARTE 1 (só leitura): expõe o motor de cálculo (planejamentoMotor.js) sem
// gravar nada. Serve para a tela "Planejamento" gerar e visualizar o cálculo.
// A persistência (salvar/versionar documentos) entra numa parte posterior.
//
// Endpoints:
//   GET  /api/planejamento/parametros-padrao  -> valores iniciais para a tela
//   POST /api/planejamento/simular            -> roda o motor e devolve linhas+resumo
// =====================================================================

const express = require('express');
const router = express.Router();
const db = require('./db');
const XLSX = require('xlsx');
const { calcularPlanejamento } = require('./planejamentoMotor');

// Lê o limiar de autonomia configurado (se existir) só como referência; os
// alvos do planejamento (ATA 6 / Pregão 9) são parâmetros próprios da tela.
function config(chave, padrao) {
  try {
    const row = db.prepare('SELECT valor FROM configuracoes WHERE chave = ?').get(chave);
    return row && row.valor !== null && row.valor !== '' ? row.valor : padrao;
  } catch { return padrao; }
}

// Datas das fotos disponíveis (para a tela mostrar "base de cálculo").
function maxData(tabela) {
  try { return db.prepare(`SELECT MAX(data_referencia) d FROM ${tabela}`).get().d; }
  catch { return null; }
}

// GET /parametros-padrao — valores iniciais sugeridos para os campos da tela.
router.get('/parametros-padrao', (req, res) => {
  res.json({
    unidade: 'TP',
    dataBase: maxData('estoque_itens'),
    autonomiaAlvoAta: 6,
    autonomiaAlvoPregao: 9,
    cortePoucaDemanda: 3,
    autonomiaPoucaDemanda: null,
    incluirZerados: false,
    fotos: {
      estoque: maxData('estoque_itens'),
      lois: maxData('plan_consumo_medio'),
      carta: maxData('plan_carta_troca'),
      irregular: maxData('plan_demanda_irregular'),
      atas: maxData('atas_itens'),
    },
  });
});

// POST /simular — roda o motor com os parâmetros do corpo e devolve o resultado.
// Não grava nada. Aceita o mesmo shape de opcoes de calcularPlanejamento().
router.post('/simular', (req, res) => {
  try {
    const b = req.body || {};
    const opcoes = {
      unidade: b.unidade || 'TP',
      dataBase: b.dataBase || undefined,
      autonomiaAlvoAta: b.autonomiaAlvoAta,
      autonomiaAlvoPregao: b.autonomiaAlvoPregao,
      cortePoucaDemanda: b.cortePoucaDemanda,
      autonomiaPoucaDemanda: b.autonomiaPoucaDemanda,
      incluirZerados: !!b.incluirZerados,
    };
    const resultado = calcularPlanejamento(opcoes);
    res.json(resultado);
  } catch (e) {
    console.error('Erro ao simular planejamento:', e);
    res.status(500).json({ erro: 'Falha ao calcular o planejamento: ' + e.message });
  }
});

// ---------------------------------------------------------------------
// PARTE 4 — Persistência: salvar / listar / reabrir / atualizar / duplicar.
// Um "planejamento" é um documento (cabeçalho em `planejamentos`) com suas
// linhas (`planejamento_itens`). Guardamos os insumos junto do resultado, para
// o documento ser auto-explicativo mesmo que os dados de origem mudem depois.
// ---------------------------------------------------------------------

// Colunas gravadas por item (na ordem do INSERT). Espelham o retorno do motor.
const COLS_ITEM = [
  'codigo_item', 'descricao', 'siafisico', 'catmat',
  'consumo_mensal', 'estoque', 'empenhado', 'solicitado', 'carta_troca', 'reservado',
  'embalagem_conversao', 'unidade_fornecimento', 'demanda_total', 'irregular',
  'ata_numero', 'ata_validade', 'preco_unitario',
  'autonomia_existente', 'autonomia_sugerida', 'autonomia_ajustada',
  'quantidade_calculada', 'custo_total', 'comprar', 'observacao',
];

function nn(v) { return v === undefined ? null : v; }

// Insere todas as linhas de um planejamento (dentro de uma transação já aberta).
function inserirItens(planId, linhas) {
  const stmt = db.prepare(
    `INSERT INTO planejamento_itens (planejamento_id, ${COLS_ITEM.join(', ')})
     VALUES (?, ${COLS_ITEM.map(() => '?').join(', ')})`
  );
  for (const l of linhas || []) {
    stmt.run(planId, ...COLS_ITEM.map((c) => {
      if (c === 'comprar') return l.comprar ? 1 : 0;
      if (c === 'irregular') return l.irregular ? 1 : 0;
      return nn(l[c]);
    }));
  }
}

// POST / — salva um novo documento de planejamento com suas linhas.
router.post('/', (req, res) => {
  const b = req.body || {};
  const p = b.parametros || {};
  const linhas = Array.isArray(b.linhas) ? b.linhas : [];
  if (!linhas.length) return res.status(400).json({ erro: 'Nada a salvar: gere o planejamento antes.' });

  const dataBase = p.dataBase || b.dataBase
    || (db.prepare('SELECT MAX(data_referencia) d FROM estoque_itens').get().d) || '';
  const alvo = Number(p.autonomiaAlvoAta ?? b.autonomiaAlvo ?? 6);
  const corte = Number(p.cortePoucaDemanda ?? 3);
  const titulo = (b.titulo || '').trim() || `Planejamento ${dataBase}`;

  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO planejamentos
        (unidade, modalidade, titulo, data_base, autonomia_alvo, corte_pouca_demanda,
         status, versao, usuario_id, usuario_email, observacao, atualizado_em)
       VALUES (?, 'MISTA', ?, ?, ?, ?, 'rascunho', 1, ?, ?, ?, datetime('now','localtime'))`
    ).run(p.unidade || 'TP', titulo, dataBase, alvo, corte,
      req.usuario.id, req.usuario.email, b.observacao || null);
    const planId = info.lastInsertRowid;
    inserirItens(planId, linhas);
    db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.usuario.id, req.usuario.email, 'salvar_planejamento', 'planejamentos', planId,
        JSON.stringify({ titulo, dataBase, itens: linhas.length }));
    db.exec('COMMIT');
    res.status(201).json({ id: Number(planId), titulo });
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('Erro ao salvar planejamento:', e);
    res.status(500).json({ erro: 'Falha ao salvar: ' + e.message });
  }
});

// GET / — lista os documentos salvos (com contagem de itens e custo estimado).
router.get('/', (req, res) => {
  const linhas = db.prepare(`
    SELECT p.id, p.titulo, p.unidade, p.modalidade, p.data_base, p.autonomia_alvo,
           p.status, p.versao, p.usuario_email, p.criado_em, p.atualizado_em, p.observacao,
           (SELECT COUNT(*) FROM planejamento_itens i WHERE i.planejamento_id = p.id) AS total_itens,
           (SELECT COUNT(*) FROM planejamento_itens i WHERE i.planejamento_id = p.id AND i.comprar = 1 AND i.quantidade_calculada > 0) AS itens_comprar,
           (SELECT COALESCE(SUM(i.custo_total),0) FROM planejamento_itens i WHERE i.planejamento_id = p.id AND i.comprar = 1) AS custo_total
      FROM planejamentos p
     ORDER BY p.criado_em DESC
  `).all();
  res.json({ planejamentos: linhas });
});

// PUT /conversao — o técnico ajusta a conversão de embalagem de um item direto
// na tela do planejamento (itens em ml/g/dose destacados). Atualiza SOMENTE
// item_classificacao.embalagem_conversao, preservando os demais campos, para
// o valor ser lembrado nos próximos planejamentos. Código no corpo (tem barras).
// IMPORTANTE: precisa vir ANTES de PUT '/:id' (senão o Express casa "conversao"
// como um id) — ver convenção no CLAUDE.md.
router.put('/conversao', (req, res) => {
  const codigo = String(req.body?.codigo_item || '').trim();
  const valor = Number(req.body?.embalagem_conversao);
  if (!codigo) return res.status(400).json({ erro: 'Código do item ausente.' });
  if (!Number.isFinite(valor) || valor <= 0) return res.status(400).json({ erro: 'Conversão inválida.' });
  try {
    db.prepare(`
      INSERT INTO item_classificacao (codigo_item, embalagem_conversao, atualizado_em, usuario_email)
      VALUES (?, ?, datetime('now','localtime'), ?)
      ON CONFLICT(codigo_item) DO UPDATE SET
        embalagem_conversao = excluded.embalagem_conversao,
        atualizado_em = excluded.atualizado_em,
        usuario_email = excluded.usuario_email
    `).run(codigo, valor, req.usuario.email);
    db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
      .run(req.usuario.id ?? null, req.usuario.email, 'editar_conversao_planejamento', 'item_classificacao',
        JSON.stringify({ codigo_item: codigo, embalagem_conversao: valor }));
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro ao salvar conversão:', e);
    res.status(500).json({ erro: 'Falha ao salvar conversão: ' + e.message });
  }
});

// PUT /modalidade — o técnico decide a modalidade de um item REVISAR (marca
// divergente): 'ATA' | 'PREGAO' | null (volta ao automático). Persistido em
// item_classificacao.modalidade_planejamento. Antes de PUT '/:id' (ver CLAUDE.md).
router.put('/modalidade', (req, res) => {
  const codigo = String(req.body?.codigo_item || '').trim();
  if (!codigo) return res.status(400).json({ erro: 'Código do item ausente.' });
  const t = String(req.body?.modalidade ?? '').trim().toUpperCase();
  let mod;
  if (t === 'ATA') mod = 'ATA';
  else if (t === 'PREGAO' || t === 'PREGÃO') mod = 'PREGAO';
  else if (t === '' || t === 'AUTO') mod = null; // volta à classificação automática
  else return res.status(400).json({ erro: 'Modalidade inválida.' });
  try {
    db.prepare(`
      INSERT INTO item_classificacao (codigo_item, modalidade_planejamento, atualizado_em, usuario_email)
      VALUES (?, ?, datetime('now','localtime'), ?)
      ON CONFLICT(codigo_item) DO UPDATE SET
        modalidade_planejamento = excluded.modalidade_planejamento,
        atualizado_em = excluded.atualizado_em,
        usuario_email = excluded.usuario_email
    `).run(codigo, mod, req.usuario.email);
    db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
      .run(req.usuario.id ?? null, req.usuario.email, 'definir_modalidade_planejamento', 'item_classificacao',
        JSON.stringify({ codigo_item: codigo, modalidade: mod }));
    res.json({ ok: true, modalidade: mod });
  } catch (e) {
    console.error('Erro ao definir modalidade:', e);
    res.status(500).json({ erro: 'Falha ao salvar modalidade: ' + e.message });
  }
});

// GET /:id — devolve o cabeçalho + as linhas de um documento (para reabrir).
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const cab = db.prepare('SELECT * FROM planejamentos WHERE id = ?').get(id);
  if (!cab) return res.status(404).json({ erro: 'Planejamento não encontrado.' });
  const itens = db.prepare('SELECT * FROM planejamento_itens WHERE planejamento_id = ? ORDER BY descricao').all(id);
  res.json({ cabecalho: cab, itens });
});

// PUT /:id — regrava as linhas (salvar edições) e atualiza o cabeçalho.
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const cab = db.prepare('SELECT * FROM planejamentos WHERE id = ?').get(id);
  if (!cab) return res.status(404).json({ erro: 'Planejamento não encontrado.' });
  const linhas = Array.isArray(b.linhas) ? b.linhas : [];

  db.exec('BEGIN');
  try {
    if (b.titulo || b.observacao !== undefined || b.status) {
      db.prepare(`UPDATE planejamentos SET
          titulo = COALESCE(?, titulo),
          observacao = COALESCE(?, observacao),
          status = COALESCE(?, status),
          atualizado_em = datetime('now','localtime')
        WHERE id = ?`).run(b.titulo || null, b.observacao ?? null, b.status || null, id);
    } else {
      db.prepare("UPDATE planejamentos SET atualizado_em = datetime('now','localtime') WHERE id = ?").run(id);
    }
    if (linhas.length) {
      db.prepare('DELETE FROM planejamento_itens WHERE planejamento_id = ?').run(id);
      inserirItens(id, linhas);
    }
    db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_depois) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.usuario.id, req.usuario.email, 'editar_planejamento', 'planejamentos', id,
        JSON.stringify({ itens: linhas.length, status: b.status || cab.status }));
    db.exec('COMMIT');
    res.json({ id, ok: true });
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('Erro ao atualizar planejamento:', e);
    res.status(500).json({ erro: 'Falha ao atualizar: ' + e.message });
  }
});

// POST /:id/duplicar — cria um novo documento (versão +1) copiando as linhas.
router.post('/:id/duplicar', (req, res) => {
  const id = Number(req.params.id);
  const cab = db.prepare('SELECT * FROM planejamentos WHERE id = ?').get(id);
  if (!cab) return res.status(404).json({ erro: 'Planejamento não encontrado.' });

  db.exec('BEGIN');
  try {
    const info = db.prepare(
      `INSERT INTO planejamentos
        (unidade, modalidade, titulo, data_base, autonomia_alvo, corte_pouca_demanda,
         status, versao, usuario_id, usuario_email, observacao, atualizado_em)
       VALUES (?, ?, ?, ?, ?, ?, 'rascunho', ?, ?, ?, ?, datetime('now','localtime'))`
    ).run(cab.unidade, cab.modalidade, `${cab.titulo} (cópia)`, cab.data_base,
      cab.autonomia_alvo, cab.corte_pouca_demanda, (cab.versao || 1) + 1,
      req.usuario.id, req.usuario.email, cab.observacao);
    const novoId = info.lastInsertRowid;
    // Copia as linhas via INSERT ... SELECT (mesmas colunas, novo planejamento_id).
    db.prepare(
      `INSERT INTO planejamento_itens (planejamento_id, ${COLS_ITEM.join(', ')})
       SELECT ?, ${COLS_ITEM.join(', ')} FROM planejamento_itens WHERE planejamento_id = ?`
    ).run(novoId, id);
    db.exec('COMMIT');
    res.status(201).json({ id: Number(novoId) });
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('Erro ao duplicar planejamento:', e);
    res.status(500).json({ erro: 'Falha ao duplicar: ' + e.message });
  }
});

// DELETE /:id — remove um documento e suas linhas.
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const cab = db.prepare('SELECT * FROM planejamentos WHERE id = ?').get(id);
  if (!cab) return res.status(404).json({ erro: 'Planejamento não encontrado.' });
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM planejamento_itens WHERE planejamento_id = ?').run(id);
    db.prepare('DELETE FROM planejamentos WHERE id = ?').run(id);
    db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_antes) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.usuario.id, req.usuario.email, 'excluir_planejamento', 'planejamentos', id,
        JSON.stringify({ titulo: cab.titulo }));
    db.exec('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    db.exec('ROLLBACK');
    res.status(500).json({ erro: 'Falha ao excluir: ' + e.message });
  }
});

// ---------------------------------------------------------------------
// PARTE 5 — Exportar no LAYOUT DOS MODELOS do Rafael (2 abas .xlsx):
//   aba "ATA FINAL"     = itens de ATA    (62 colunas do modelo 10.ATA.xlsx)
//   aba "SEM ATA FINAL" = itens de Pregão (55 colunas do modelo 11.PREGÃO.xlsx)
// Preenche o que o sistema tem; colunas sem fonte de dados ficam em branco.
// Split Judicial/ADM/Total: usa consumo/demanda judiciais; ADM = Total − Jud.
// ---------------------------------------------------------------------

// Cabeçalhos EXATOS das abas (ordem preservada; '' = coluna em branco no modelo).
const CAB_ATA = [
  'Nº Cont.', 'Nº', 'Código Scodes', 'Código Siafisico', 'Item', 'Unidade de Medida',
  'Real Necessidade (Judicial)', 'Real Necessidade (ADM)', 'Real Necessidade (Total)',
  'Autonomia de Compra', 'Consumo Mensal Total Ata Comprar',
  '(%) JUD Atendimento Único', '(%) JUD Demandas por Dispensações',
  '(%) ADM Atendimento Único', '(%) ADM Demandas por Dispensações',
  'Demanda Irregular SIM', 'Quantidade Demanda Irregular', 'Periodicidade Média',
  'Reservados Nominal', 'Carta de Troca', 'Compras Anteriores Empenhado',
  'Compras Anteriores Solicitado', 'Análise Crítica',
  'Autonomia de Aquisição (k) + Análise Crítica (V)',
  'Qtde. a comprar conforme adequação Financeira (Judicial)',
  'Qtde. a comprar conforme adequação Financeira (ADM)',
  'Qtde. a comprar conforme adequação Financeira (Total)',
  'Embalagem', 'Conversão',
  'Qtde. a comprar conforme adequação de Embalagem (Judicial)',
  'Qtde. a comprar conforme adequação de Embalagem (ADM)',
  'Qtde. a comprar conforme adequação de Embalagem (Total)',
  'Preço Unitario', 'Custo Total da Aquisição (Judicial)',
  'Custo Total da Aquisição (ADM)', 'Custo Total da Aquisição (Total)',
  'Ata', 'Validade', 'Demandas U.D.T.P. (Judicial)', 'Demandas U.D.T.P. (ADM)',
  'Demandas Total U.D.T.P.', 'Consumo Mensal U.D.T.P. (Judicial)',
  'Consumo Mensal U.D.T.P. (ADM)', 'Consumo Total -U.D.T.P.',
  'Consumo Total -U.D.T.P. LOIS', 'Consumo Total -U.D.T.P. LOIS - %',
  'Estoque U.D.T.P.', 'Autonomia de Estoque U.D.T.P.', 'Entrega', 'Recurso', 'CATMAT',
  'Status Comprar ou Não comprar (Técnico)', 'OBSERVAÇÃO DEMANDA', 'OBSERVAÇÕES GERAIS',
  'MODALIDADE', 'EMBALAGEM PRIMARIA', 'EMBALAGEM SECUNDARIA', 'Detentor',
  'Tramitado Processo', 'Data', 'EGRP', '',
];

const CAB_PREGAO = [
  'Calc Seq.', 'N° Itens', 'Código', 'Siafísico', 'CATMAT', 'Status',
  'Embalagem Conversão', 'Item', 'Demandas U.D.T.P. Judicial Total',
  'Demandas U.D.T.P. ADM Total', 'Demandas U.D.T.P. (Total)',
  'Consumo Mensal U.D.T.P. Judicial Total', 'Consumo Mensal U.D.T.P. ADM Total',
  'Consumo Mensal U.D.T.P. (Total)', 'Consumo Mensal U.D.T.P. (LOIS)',
  'Consumo Mensal U.D.T.P. (LOIS) %', 'Estoque', 'Autonomia Estoque U.D.T.P.',
  'Reserva Nominal', 'Solicitação Anterior Solicitado', 'Solicitação Anterior Empenhado',
  'Autonomia Solicitaçao Anterior', 'Análise Crítica Compras Anteriores + Estoque / Consumo',
  'Carta de Troca', 'Autonomia Carta de Troca', 'AUTONOMIA DE COMPRA',
  'Consumo Mensal Total Comprar', '(%) Atendimento Único JUD',
  '(%) Demandas por Dispensações JUD', '(%) Atendimento Único ADM',
  '(%) Demandas por Dispensações ADM', 'PERIODICIDADE', 'Demanda Irregular SIM',
  'Quantidade Demanda Irregular', 'Unidade de Fornecimento SCODES',
  'Aquisição Conforme Necessidade SCODES (Judicial)',
  'Aquisição Conforme Necessidade SCODES (ADM)',
  'Aquisição Conforme Necessidade SCODES (Total)', 'Unidade de Fornecimento Siafísico',
  'Quantidade Comprar Conforme Unidade de Fornecimento Siafísico (Judicial)',
  'Quantidade Comprar Conforme Unidade de Fornecimento Siafísico (ADM)',
  'Quantidade Comprar Conforme Unidade de Fornecimento Siafísico (Total)',
  'Custo Unitário (R$) (*)', 'Custo Total da Aquisição (Judicial)',
  'Custo Total da Aquisição (ADM)', 'Custo Total da Aquisição (Total)',
  'Entrega', 'Recurso', 'MARCA / SEM MARCA', 'Doenças Raras',
  'Status Comprar ou Não comprar', 'Status Comprar ou Não comprar (Avaliaçao Comitê)',
  'Observação Demanda', 'MODALIDADE', '',
];

const r2 = (v) => (v == null || !Number.isFinite(Number(v))) ? '' : Math.round(Number(v) * 100) / 100;
const rInt = (v) => (v == null || !Number.isFinite(Number(v))) ? '' : Math.round(Number(v));

// Fração judicial do item (consumo judicial ÷ total; cai para demanda se preciso).
function fracaoJud(l) {
  const ct = Number(l.consumo_mensal) || 0, cj = Number(l._consumo_aj) || 0;
  if (ct > 0 && cj > 0) return Math.min(cj / ct, 1);
  const dt = Number(l.demanda_total) || 0, dj = Number(l._demanda_aj) || 0;
  if (dt > 0 && dj > 0) return Math.min(dj / dt, 1);
  return null; // sem como ratear
}
// Divide um total em [Judicial, ADM, Total]. Sem fração conhecida: só Total.
function tripla(total, sh, arred) {
  if (total == null || !Number.isFinite(Number(total))) return ['', '', ''];
  const t = Number(total);
  if (sh == null) return ['', '', arred(t)];
  const jud = t * sh;
  return [arred(jud), arred(t - jud), arred(t)];
}
// MROUND igual ao Excel/motor (arredonda ao múltiplo de m). '' se x inválido.
function mroundE(x, m) {
  if (x == null || !Number.isFinite(Number(x))) return '';
  const p = Number(m) > 0 ? Number(m) : 1;
  return Math.round(Number(x) / p) * p;
}
// Split EXATO [Jud, ADM, Total] a partir do valor judicial conhecido.
function splitExato(total, jud, arred) {
  if (total == null || !Number.isFinite(Number(total))) return ['', '', ''];
  const t = Number(total);
  if (!Number.isFinite(Number(jud))) return ['', '', arred(t)];
  const j = Number(jud);
  return [arred(j), arred(Math.max(0, t - j)), arred(t)];
}
// Quantidade [Jud, ADM, Total]: usa o split do motor (arredondado separadamente);
// se o total foi editado à mão e não bate com Jud+ADM, rateia pela fração judicial.
function splitQtd(l) {
  const j = Number(l._qtd_jud), a = Number(l._qtd_adm), tot = Number(l.quantidade_calculada);
  if (Number.isFinite(j) && Number.isFinite(a) && Number.isFinite(tot) && Math.abs((j + a) - tot) < 0.5) {
    return [rInt(j), rInt(a), rInt(tot)];
  }
  return tripla(l.quantidade_calculada, fracaoJud(l), rInt);
}

// Reproduz a tabela dinâmica do Rafael para a % de atendimento:
//   linhas = código do item · filtro = tipo de demanda (Judicial × ADM)
//   colunas = prazo (Único / Dispensações / Indeterminado)
//   valores = contagem de id_demanda, exibida como % do total da linha.
// Judicial = tipo_demanda 'Judicial'; ADM = 'Comissão de Farmacologia' + 'Jefaz'.
// Devolve Map(codigo_item -> { J:{t,u,d}, A:{t,u,d} }) da foto mais recente.
function mapaAtendimento() {
  const dt = db.prepare('SELECT MAX(data_referencia) d FROM autores_itens').get().d;
  const mapa = new Map();
  if (!dt) return mapa;
  const rows = db.prepare(`
    SELECT codigo_item AS cod,
           CASE WHEN tipo_demanda = 'Judicial' THEN 'J' ELSE 'A' END AS cls,
           prazo, COUNT(*) AS c
      FROM autores_itens
     WHERE data_referencia = ?
     GROUP BY codigo_item, cls, prazo`).all(dt);
  for (const r of rows) {
    if (!r.cod) continue;
    if (!mapa.has(r.cod)) mapa.set(r.cod, { J: { t: 0, u: 0, d: 0 }, A: { t: 0, u: 0, d: 0 } });
    const o = mapa.get(r.cod)[r.cls];
    o.t += r.c;
    if (r.prazo === 'Único') o.u += r.c;
    else if (r.prazo === 'Dispensações') o.d += r.c;
  }
  return mapa;
}
// [%Único, %Dispensações] como fração (0–1); '' quando não há demandas.
function pctAtend(o) {
  if (!o || o.t === 0) return ['', ''];
  return [Math.round(o.u / o.t * 10000) / 10000, Math.round(o.d / o.t * 10000) / 10000];
}

// Periodicidade Média: tabela dinâmica (item na linha, média de `periodicidade`).
// Ignora valores não numéricos (ex.: "N/I"), como o Excel faz na média.
// Devolve Map(codigo_item -> média).
function mapaPeriodicidade() {
  const dt = db.prepare('SELECT MAX(data_referencia) d FROM autores_itens').get().d;
  const mapa = new Map();
  if (!dt) return mapa;
  const rows = db.prepare(`
    SELECT codigo_item AS cod, AVG(CAST(periodicidade AS REAL)) AS m
      FROM autores_itens
     WHERE data_referencia = ? AND periodicidade GLOB '[0-9]*'
     GROUP BY codigo_item`).all(dt);
  for (const r of rows) if (r.cod) mapa.set(r.cod, r.m);
  return mapa;
}

// Aba ATA FINAL — fórmulas do modelo 10.ATA.xlsx:
//   Real Necessidade = MROUND(J×consumo, Embalagem)   [sem conversão]
//   Qtde Embalagem   = MROUND(J×consumo×Conversão, Embalagem)  (Jud/ADM separados)
//   Análise Crítica (W) = existente ; Aut.Aquis+AC (X) = J + existente
//   K = Qtde total ÷ Consumo total ; Custo = preço × Qtde
function linhaAta(l, seq, mapa, perMap) {
  const at = mapa && mapa.get(l.codigo_item);
  const [ju, jd] = pctAtend(at && at.J);
  const [au, ad] = pctAtend(at && at.A);
  const autC = l.autonomia_ajustada ?? l.autonomia_sugerida;
  const consumo = Number(l.consumo_mensal) || 0;
  const cJ = Number(l._consumo_aj);
  const temJ = Number.isFinite(cJ);
  const cA = temJ ? Math.max(0, consumo - cJ) : null;
  const passo = Number(l._emb_passo) > 0 ? Number(l._emb_passo) : 1;
  const mult = Number(l.embalagem_conversao) > 0 ? Number(l.embalagem_conversao) : 1;
  const [conJ, conA] = splitExato(consumo, cJ, r2);
  const [dJ, dA, dT] = splitExato(l.demanda_total, l._demanda_aj, r2);
  const [qJ, qA, qT] = splitQtd(l);
  const preco = l.preco_unitario;
  const custo = (q) => (preco != null && q !== '') ? r2(preco * Number(q)) : '';
  // Real Necessidade (sem conversão) e Financeira (bruta, sem embalagem)
  const realJ = (autC != null && temJ) ? mroundE(autC * cJ, passo) : '';
  const realA = (autC != null && temJ) ? mroundE(autC * cA, passo) : '';
  const finJ = (autC != null && temJ) ? r2(autC * cJ) : '';
  const finA = (autC != null && temJ) ? r2(autC * cA) : '';
  const finT = (autC != null) ? r2(autC * consumo) : '';
  const autTotal = (l.autonomia_existente != null && autC != null) ? r2(l.autonomia_existente + autC) : '';
  const kCol = (consumo > 0 && qT !== '') ? r2(Number(qT) / consumo) : '';
  const row = new Array(CAB_ATA.length).fill('');
  row[1] = seq; row[2] = l.codigo_item ?? ''; row[3] = l.siafisico ?? ''; row[4] = l.descricao ?? '';
  row[5] = l.unidade_fornecimento ?? '';
  row[6] = realJ; row[7] = realA; row[8] = (realJ !== '' && realA !== '') ? realJ + realA : '';
  row[9] = r2(autC); row[10] = kCol;
  row[11] = ju; row[12] = jd; row[13] = au; row[14] = ad;
  row[15] = l.irregular ? 'SIM' : ''; row[17] = r2(perMap && perMap.get(l.codigo_item));
  row[19] = r2(l.carta_troca);
  row[20] = r2(l.empenhado); row[21] = r2(l.solicitado); row[22] = r2(l.autonomia_existente); row[23] = autTotal;
  row[24] = finJ; row[25] = finA; row[26] = finT;
  row[27] = r2(passo); row[28] = r2(mult);
  row[29] = qJ; row[30] = qA; row[31] = qT;
  row[32] = r2(preco); row[33] = custo(qJ); row[34] = custo(qA); row[35] = custo(qT);
  row[36] = l.ata_numero ?? ''; row[37] = l.ata_validade ?? '';
  row[38] = dJ; row[39] = dA; row[40] = dT;
  row[41] = conJ; row[42] = conA; row[43] = r2(consumo);
  row[44] = r2(l._consumo_lois); row[45] = l._percent_lois == null ? '' : r2(l._percent_lois);
  row[46] = r2(l.estoque); row[47] = consumo > 0 ? r2(l.estoque / consumo) : '';
  row[48] = 'Única'; row[49] = 'Tesouro'; row[50] = l.catmat ?? '';
  row[51] = l.comprar ? 'Comprar' : 'Não comprar'; row[53] = l.observacao ?? ''; row[54] = 'ATA';
  row[55] = l._ata_emb_primaria ?? ''; row[56] = l._ata_emb_secundaria ?? ''; row[57] = l._detentor ?? '';
  return row;
}

// Aba SEM ATA FINAL — fórmulas do modelo 11.PREGÃO.xlsx:
//   Qtde (AN/AO/AP) = MROUND(Z×consumo×G, G)  (G = embalagem conversão)
//   Aquisição SCODES = MROUND(Z×consumo, 1)
//   Análise Crítica (W) = (estoque+solic+emp)/consumo + Z  (já inclui a compra)
//   Consumo Mensal Total Comprar (AA) = Qtde total ÷ consumo ÷ G
function linhaPregao(l, seq, mapa, perMap) {
  const at = mapa && mapa.get(l.codigo_item);
  const [ju, jd] = pctAtend(at && at.J);
  const [au, ad] = pctAtend(at && at.A);
  const autC = l.autonomia_ajustada ?? l.autonomia_sugerida;
  const consumo = Number(l.consumo_mensal) || 0;
  const cJ = Number(l._consumo_aj);
  const temJ = Number.isFinite(cJ);
  const cA = temJ ? Math.max(0, consumo - cJ) : null;
  const conv = Number(l.embalagem_conversao) > 0 ? Number(l.embalagem_conversao) : 1;
  const [conJ, conA] = splitExato(consumo, cJ, r2);
  const [dJ, dA, dT] = splitExato(l.demanda_total, l._demanda_aj, r2);
  const [qJ, qA, qT] = splitQtd(l);
  const preco = l.preco_unitario;
  const custo = (q) => (preco != null && q !== '') ? r2(Math.max(0, preco * Number(q))) : '';
  const aqJ = (autC != null && temJ) ? mroundE(autC * cJ, 1) : '';
  const aqA = (autC != null && temJ) ? mroundE(autC * cA, 1) : '';
  const autSolic = consumo > 0 ? r2(((Number(l.empenhado) || 0) + (Number(l.solicitado) || 0)) / consumo) : '';
  const autCarta = (consumo > 0 && l.carta_troca) ? r2(Number(l.carta_troca) / consumo) : '';
  const analiseCrit = consumo > 0
    ? r2(((Number(l.estoque) || 0) + (Number(l.solicitado) || 0) + (Number(l.empenhado) || 0)) / consumo + (autC || 0)) : '';
  const aaCol = (consumo > 0 && qT !== '') ? r2(Number(qT) / consumo / conv) : '';
  const row = new Array(CAB_PREGAO.length).fill('');
  row[1] = seq; row[2] = l.codigo_item ?? ''; row[3] = l.siafisico ?? ''; row[4] = l.catmat ?? '';
  row[5] = l.comprar ? 'Comprar' : 'Não comprar'; row[6] = r2(conv); row[7] = l.descricao ?? '';
  row[8] = dJ; row[9] = dA; row[10] = dT; row[11] = conJ; row[12] = conA; row[13] = r2(consumo);
  row[14] = r2(l._consumo_lois); row[15] = l._percent_lois == null ? '' : r2(l._percent_lois);
  row[16] = r2(l.estoque); row[17] = consumo > 0 ? r2(l.estoque / consumo) : ''; row[19] = r2(l.solicitado); row[20] = r2(l.empenhado);
  row[21] = autSolic; row[22] = analiseCrit; row[23] = r2(l.carta_troca); row[24] = autCarta;
  row[25] = r2(autC); row[26] = aaCol;
  row[27] = ju; row[28] = jd; row[29] = au; row[30] = ad;
  row[31] = r2(perMap && perMap.get(l.codigo_item));
  row[32] = l.irregular ? 'SIM' : '';
  row[34] = l.unidade_fornecimento ?? ''; row[35] = aqJ; row[36] = aqA; row[37] = (aqJ !== '' && aqA !== '') ? aqJ + aqA : '';
  row[39] = qJ; row[40] = qA; row[41] = qT; row[42] = r2(preco);
  row[43] = custo(qJ); row[44] = custo(qA); row[45] = custo(qT);
  row[46] = 'ÚNICA'; row[47] = 'TESOURO';
  row[50] = l.comprar ? 'Comprar' : 'Não comprar';
  row[52] = l.observacao ?? ''; row[53] = l._modalidade === 'INEX' ? 'INEX' : 'PREGÃO';
  return row;
}

// POST /exportar-xlsx — recebe { linhas, titulo } e devolve o .xlsx (2 abas).
router.post('/exportar-xlsx', (req, res) => {
  try {
    const linhas = Array.isArray(req.body?.linhas) ? req.body.linhas : [];
    if (!linhas.length) return res.status(400).json({ erro: 'Nada a exportar.' });

    const mapa = mapaAtendimento();
    const perMap = mapaPeriodicidade();
    const ata = linhas.filter((l) => l._modalidade === 'ATA');
    const pregao = linhas.filter((l) => l._modalidade === 'PREGAO' || l._modalidade === 'INEX');
    const revisar = linhas.filter((l) => l._modalidade === 'REVISAR');
    const aoaAta = [CAB_ATA, ...ata.map((l, i) => linhaAta(l, i + 1, mapa, perMap))];
    const aoaPreg = [CAB_PREGAO, ...pregao.map((l, i) => linhaPregao(l, i + 1, mapa, perMap))];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaAta), 'ATA FINAL');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaPreg), 'SEM ATA FINAL');
    // Aba REVISAR: itens com ata vigente mas MARCA divergente — o técnico decide
    // a modalidade (marca do estoque × nome comercial da ata lado a lado).
    if (revisar.length) {
      const cabR = ['Código', 'Siafísico', 'Item', 'Marca (estoque TP)', 'Nome comercial (SISCOA)',
        'Ata', 'Validade', 'Consumo', 'Estoque', 'Demanda Total', 'Preço Ata'];
      const aoaRev = [cabR, ...revisar.map((l) => [
        l.codigo_item ?? '', l.siafisico ?? '', l.descricao ?? '',
        l._marca_estoque ?? '', l._ata_nome_comercial ?? '',
        l.ata_numero ?? '', l.ata_validade ?? '',
        r2(l.consumo_mensal), r2(l.estoque), r2(l.demanda_total), r2(l.preco_unitario),
      ])];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaRev), 'REVISAR');
    }
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const nome = String(req.body?.titulo || 'planejamento').replace(/[^\w\-]+/g, '_') || 'planejamento';
    res.setHeader('Content-Disposition', `attachment; filename="${nome}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    console.error('Erro ao exportar xlsx:', e);
    res.status(500).json({ erro: 'Falha ao exportar: ' + e.message });
  }
});

module.exports = router;
