const express = require('express');
const XLSX = require('xlsx');
const db = require('./db');
const { autenticar, exigirPerfil } = require('./auth');

const router = express.Router();
router.use(autenticar);

// Mapeamento por posição, layout do arquivo
// "RELATÓRIO DE COMPRAS OUTRAS DEMANDAS - Macro.xlsm" (diferente do Tenente Pena)
const COL = {
  codigo_item: 0, descricao: 1, codigo_siafisico: 2, codigo_gsnet: 3, ano: 4, mes: 5, tipo: 6,
  modalidade_compra: 7, n_oficio: 8, qtde_solicitada: 9, data_solicitacao: 10,
  requisicao_gsnet: 11, n_empenho: 12, data_previsao_entrega: 13, data_entrega: 14,
  qtde_entregue: 15, qtde_pendente: 16, status: 17, observacao: 18,
};

const MESES_VALIDOS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const ABAS_IGNORADAS = ['FRONT PAGE', 'TABELA'];

function limpar(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' || t === '-' ? null : t;
  }
  if (typeof v === 'number') {
    // Converte para string aqui (e não deixa o SQLite converter), pois
    // coluna TEXT + parâmetro REAL faz "651257" virar "651257.0" no banco.
    return String(v);
  }
  return v;
}

function paraDataIso(v) {
  v = limpar(v);
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    const data = XLSX.SSF.parse_date_code(v);
    if (!data) return null;
    return `${data.y}-${String(data.m).padStart(2, '0')}-${String(data.d).padStart(2, '0')}`;
  }
  return String(v);
}

function extrairAbasMensais(workbook) {
  return workbook.SheetNames.filter((nome) =>
    !ABAS_IGNORADAS.includes(nome.toUpperCase()) &&
    MESES_VALIDOS.some((m) => nome.toUpperCase().startsWith(m.toUpperCase())) && /\d{4}/.test(nome)
  );
}

function processarPlanilha(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const abas = extrairAbasMensais(wb);

  if (abas.length === 0) {
    throw new Error('Não encontrei abas no formato "MÊS-ANO" (ex: JULHO-2026) no arquivo enviado.');
  }

  const linhasComMovimento = [];

  for (const nomeAba of abas) {
    const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, defval: null });
    if (linhas.length < 2) continue;

    for (let i = 1; i < linhas.length; i++) {
      const linha = linhas[i];
      const codigo = limpar(linha[COL.codigo_item]);
      if (!codigo) continue;

      const campos = {
        codigo_item: codigo,
        descricao: limpar(linha[COL.descricao]),
        codigo_siafisico: limpar(linha[COL.codigo_siafisico]),
        codigo_gsnet: limpar(linha[COL.codigo_gsnet]),
        ano: Number(limpar(linha[COL.ano])) || null,
        mes: limpar(linha[COL.mes]),
        tipo: limpar(linha[COL.tipo]),
        modalidade_compra: limpar(linha[COL.modalidade_compra]),
        n_oficio: limpar(linha[COL.n_oficio]),
        qtde_solicitada: limpar(linha[COL.qtde_solicitada]),
        data_solicitacao: paraDataIso(linha[COL.data_solicitacao]),
        requisicao_gsnet: limpar(linha[COL.requisicao_gsnet]),
        n_empenho: limpar(linha[COL.n_empenho]),
        data_previsao_entrega: paraDataIso(linha[COL.data_previsao_entrega]),
        data_entrega: paraDataIso(linha[COL.data_entrega]),
        qtde_entregue: limpar(linha[COL.qtde_entregue]),
        qtde_pendente: limpar(linha[COL.qtde_pendente]),
        status: limpar(linha[COL.status]),
        observacao: limpar(linha[COL.observacao]),
      };

      const temMovimento = ['modalidade_compra','n_oficio','qtde_solicitada','data_solicitacao',
        'requisicao_gsnet','n_empenho','data_previsao_entrega','data_entrega',
        'qtde_entregue','status','observacao'].some((c) => campos[c] !== null);

      if (!temMovimento) continue;
      if (!campos.ano || !campos.mes) continue;

      linhasComMovimento.push(campos);
    }
  }

  return { linhasComMovimento, abas };
}

// Grava no banco REFAZENDO O MÊS: para cada (ano, mês) presente na planilha,
// apaga tudo daquele mês e regrava as linhas da planilha. A planilha é a
// fonte da verdade, então o banco vira um espelho exato dela. Usado pelo
// vigia automático.
//
// Antes isto identificava a solicitação por item+ano+mês+tipo e dava UPDATE:
// duas linhas do mesmo item/mês/tipo com ofícios ou quantidades diferentes
// eram fundidas (uma sobrescrevia a outra), perdendo dados — mesmo problema
// já corrigido nas solicitações de Tenente Pena. Ver routes.importarSolicitacoes.js.
// Meses que NÃO aparecem na planilha nunca são tocados.
function gravarImportacao(buffer, nomeArquivo, usuarioEmail) {
  const { linhasComMovimento, abas } = processarPlanilha(buffer);

  const campos = ['codigo_item','descricao','codigo_siafisico','codigo_gsnet','ano','mes','tipo',
    'modalidade_compra','n_oficio','qtde_solicitada','data_solicitacao','requisicao_gsnet','n_empenho',
    'data_previsao_entrega','data_entrega','qtde_entregue','qtde_pendente','status','observacao'];

  const stmtInsert = db.prepare(
    `INSERT INTO solicitacoes_od (${campos.join(',')}) VALUES (${campos.map(() => '?').join(',')})`
  );

  let inseridos = 0, apagados = 0;
  const avisos = [];

  // Separa as linhas por mês, preservando a ordem da planilha.
  const porMes = new Map();
  for (const l of linhasComMovimento) {
    const chave = `${l.ano}||${l.mes}`;
    if (!porMes.has(chave)) porMes.set(chave, []);
    porMes.get(chave).push(l);
  }

  // Tudo numa transação: se qualquer passo falhar, nada é apagado nem
  // gravado pela metade (um mês nunca fica vazio por erro no meio).
  db.exec('BEGIN');
  try {
    for (const [chave, linhas] of porMes) {
      const [anoTxt, mes] = chave.split('||');
      const ano = Number(anoTxt);

      const existentes = db.prepare(
        'SELECT COUNT(*) c FROM solicitacoes_od WHERE ano = ? AND mes = ?'
      ).get(ano, mes).c;

      // Rede de segurança: se a planilha traz bem menos linhas do que o
      // banco já tem para o mês, pode ser arquivo truncado/corrompido.
      if (existentes > 0 && linhas.length < existentes * 0.5) {
        const aviso = `Mês ${mes}/${ano}: planilha trouxe ${linhas.length} linha(s) e o banco tinha ${existentes}. Verifique se a planilha está completa.`;
        avisos.push(aviso);
        console.warn(`[IMPORTAR SOLICITACOES OD] ATENCAO - ${aviso}`);
      }

      apagados += db.prepare('DELETE FROM solicitacoes_od WHERE ano = ? AND mes = ?').run(ano, mes).changes;
      for (const l of linhas) {
        stmtInsert.run(...campos.map((c) => l[c]));
        inseridos++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const resumo = { abasProcessadas: abas, inseridos, apagados, mesesRefeitos: porMes.size, avisos };

  db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
    .run('solicitacoes_od', nomeArquivo, usuarioEmail, JSON.stringify(resumo));

  return resumo;
}

// ---------- Consulta ----------
const ORDEM_MES = {
  Janeiro: 1, Fevereiro: 2, Março: 3, Abril: 4, Maio: 5, Junho: 6,
  Julho: 7, Agosto: 8, Setembro: 9, Outubro: 10, Novembro: 11, Dezembro: 12,
};

// Status considerados "compra em andamento" (ainda não finalizada)
const STATUS_EM_ABERTO = ['Planejamento', 'Adjucado', 'Empenhado', 'Entrega Parcial'];

router.get('/resumo', (req, res) => {
  const { emAberto } = req.query;
  const where = emAberto === 'true'
    ? `WHERE status IN (${STATUS_EM_ABERTO.map(() => '?').join(',')})`
    : '';
  const porStatus = db.prepare(`
    SELECT COALESCE(status, 'Em andamento') as status, COUNT(*) as qtde
    FROM solicitacoes_od ${where} GROUP BY status
  `).all(...(emAberto === 'true' ? STATUS_EM_ABERTO : []));
  res.json({ porStatus });
});

router.get('/', (req, res) => {
  const { q, status, ano, mes, emAberto, page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const condicoes = [];
  const params = [];

  if (q) {
    condicoes.push(`(descricao LIKE ? OR codigo_item LIKE ? OR codigo_siafisico LIKE ? OR codigo_gsnet LIKE ? OR n_oficio LIKE ? OR n_empenho LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }
  if (emAberto === 'true') {
    condicoes.push(`status IN (${STATUS_EM_ABERTO.map(() => '?').join(',')})`);
    params.push(...STATUS_EM_ABERTO);
  } else if (status) {
    condicoes.push('status = ?'); params.push(status);
  }
  if (ano) { condicoes.push('ano = ?'); params.push(ano); }
  if (mes) { condicoes.push('mes = ?'); params.push(mes); }

  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) as c FROM solicitacoes_od ${where}`).get(...params).c;

  const linhas = db.prepare(`
    SELECT * FROM solicitacoes_od ${where}
    ORDER BY ano DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ solicitacoes: linhas, total, page: Number(page), pageSize: limit });
});

// Atualização manual "agora" (admin) — relê o arquivo OD da pasta de rede e
// reimporta, sem esperar o horário agendado. Usado pelos botões "Atualizar
// agora" das telas Relatório de Compras OD e Aquisição em Andamento OD.
router.post('/atualizar-agora', exigirPerfil('admin'), (req, res) => {
  try {
    const { forcarImportacaoSolicitacoesOD } = require('./vigiaSolicitacoesOD');
    const resumo = forcarImportacaoSolicitacoesOD(req.usuario.email);
    res.json({ ok: true, ...resumo });
  } catch (e) {
    const status = e.codigo === 'ARQUIVO_NAO_ENCONTRADO' ? 404
      : e.codigo === 'ARQUIVO_EM_GRAVACAO' ? 409 : 400;
    res.status(status).json({ erro: e.message });
  }
});

module.exports = router;
module.exports.gravarImportacao = gravarImportacao;
