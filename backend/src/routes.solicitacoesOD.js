const express = require('express');
const XLSX = require('xlsx');
const db = require('./db');
const { autenticar } = require('./auth');

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

// Grava no banco em modo "substituir": atualiza linhas existentes (mesmo
// item+ano+mês+tipo) e insere as novas. Usado pelo vigia automático.
function gravarImportacao(buffer, nomeArquivo, usuarioEmail) {
  const { linhasComMovimento, abas } = processarPlanilha(buffer);

  const stmtBuscaExistente = db.prepare('SELECT id FROM solicitacoes_od WHERE codigo_item = ? AND ano = ? AND mes = ? AND tipo IS ?');

  const campos = ['codigo_item','descricao','codigo_siafisico','codigo_gsnet','ano','mes','tipo',
    'modalidade_compra','n_oficio','qtde_solicitada','data_solicitacao','requisicao_gsnet','n_empenho',
    'data_previsao_entrega','data_entrega','qtde_entregue','qtde_pendente','status','observacao'];

  const stmtInsert = db.prepare(
    `INSERT INTO solicitacoes_od (${campos.join(',')}) VALUES (${campos.map(() => '?').join(',')})`
  );
  const camposSemChave = campos.filter((c) => !['codigo_item','ano','mes','tipo'].includes(c));
  const stmtUpdate = db.prepare(
    `UPDATE solicitacoes_od SET ${camposSemChave.map((c) => `${c} = ?`).join(', ')} WHERE codigo_item = ? AND ano = ? AND mes = ? AND tipo IS ?`
  );

  let inseridos = 0, atualizados = 0;

  for (const l of linhasComMovimento) {
    const existente = stmtBuscaExistente.get(l.codigo_item, l.ano, l.mes, l.tipo);
    if (!existente) {
      stmtInsert.run(...campos.map((c) => l[c]));
      inseridos++;
    } else {
      stmtUpdate.run(...camposSemChave.map((c) => l[c]), l.codigo_item, l.ano, l.mes, l.tipo);
      atualizados++;
    }
  }

  const resumo = { abasProcessadas: abas, inseridos, atualizados };

  db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
    .run('solicitacoes_od', nomeArquivo, usuarioEmail, JSON.stringify(resumo));

  return resumo;
}

// ---------- Consulta ----------
const ORDEM_MES = {
  Janeiro: 1, Fevereiro: 2, Março: 3, Abril: 4, Maio: 5, Junho: 6,
  Julho: 7, Agosto: 8, Setembro: 9, Outubro: 10, Novembro: 11, Dezembro: 12,
};

router.get('/resumo', (req, res) => {
  const porStatus = db.prepare(`
    SELECT COALESCE(status, 'Em andamento') as status, COUNT(*) as qtde
    FROM solicitacoes_od GROUP BY status
  `).all();
  res.json({ porStatus });
});

router.get('/', (req, res) => {
  const { q, status, ano, mes, page = 1, pageSize = 50 } = req.query;
  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const condicoes = [];
  const params = [];

  if (q) {
    condicoes.push(`(descricao LIKE ? OR codigo_item LIKE ? OR codigo_siafisico LIKE ? OR codigo_gsnet LIKE ? OR n_oficio LIKE ? OR n_empenho LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }
  if (status) { condicoes.push('status = ?'); params.push(status); }
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

module.exports = router;
module.exports.gravarImportacao = gravarImportacao;
