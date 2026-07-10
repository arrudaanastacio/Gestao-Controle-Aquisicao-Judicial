const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('./db');
const { autenticar, exigirPerfil } = require('./auth');

const router = express.Router();
router.use(autenticar);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// Mapeamento por posição, igual ao layout original do arquivo .xlsm
// (Código, Código Siafísico, Descrição, Ano, Mês, Tipo, Modalidade, Ofício,
//  Qtde Solicitada, Data Solicitação, Requisição GSNET, Nº Empenho, Quantidade,
//  Data Previsão, Data Entrega, Qtde Entregue, Qtde Pendente, Status, Observação, Justificativa)
const COL = {
  codigo_item: 0, codigo_siafisico: 1, descricao: 2, ano: 3, mes: 4, tipo: 5,
  modalidade_compra: 6, n_oficio: 7, qtde_solicitada: 8, data_solicitacao: 9,
  requisicao_gsnet: 10, n_empenho: 11, quantidade_empenho: 12, data_previsao_entrega: 13,
  data_entrega: 14, qtde_entregue: 15, qtde_pendente: 16, status: 17, observacao: 18, justificativa: 19,
};

const MESES_VALIDOS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

function limpar(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' || t === '-' ? null : t;
  }
  return v;
}

function paraDataIso(v) {
  v = limpar(v);
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    // Excel armazena datas como número serial (dias desde 1899-12-30)
    const data = XLSX.SSF.parse_date_code(v);
    if (!data) return null;
    return `${data.y}-${String(data.m).padStart(2, '0')}-${String(data.d).padStart(2, '0')}`;
  }
  return String(v);
}

// Lê todas as abas que parecem ser abas mensais (nome contendo um mês válido + ano)
function extrairAbasMensais(workbook) {
  return workbook.SheetNames.filter((nome) =>
    MESES_VALIDOS.some((m) => nome.toUpperCase().startsWith(m.toUpperCase())) && /\d{4}/.test(nome)
  );
}

function processarPlanilha(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const abas = extrairAbasMensais(wb);

  if (abas.length === 0) {
    throw new Error('Não encontrei abas no formato "MÊS-ANO" (ex: JANEIRO-2026) no arquivo enviado.');
  }

  const linhasComMovimento = [];
  const codigosNaoEncontrados = new Set();

  for (const nomeAba of abas) {
    const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, defval: null });
    if (linhas.length < 2) continue;

    for (let i = 1; i < linhas.length; i++) {
      const linha = linhas[i];
      const codigo = limpar(linha[COL.codigo_item]);
      if (!codigo) continue;

      const campos = {
        codigo_item: codigo,
        ano: Number(limpar(linha[COL.ano])) || null,
        mes: limpar(linha[COL.mes]),
        tipo: limpar(linha[COL.tipo]),
        modalidade_compra: limpar(linha[COL.modalidade_compra]),
        n_oficio: limpar(linha[COL.n_oficio]),
        qtde_solicitada: limpar(linha[COL.qtde_solicitada]),
        data_solicitacao: paraDataIso(linha[COL.data_solicitacao]),
        requisicao_gsnet: limpar(linha[COL.requisicao_gsnet]),
        n_empenho: limpar(linha[COL.n_empenho]),
        quantidade_empenho: limpar(linha[COL.quantidade_empenho]),
        data_previsao_entrega: paraDataIso(linha[COL.data_previsao_entrega]),
        data_entrega: paraDataIso(linha[COL.data_entrega]),
        qtde_entregue: limpar(linha[COL.qtde_entregue]),
        qtde_pendente: limpar(linha[COL.qtde_pendente]),
        status: limpar(linha[COL.status]),
        observacao: limpar(linha[COL.observacao]),
        justificativa: limpar(linha[COL.justificativa]),
      };

      // Só considera "com movimento" se algo alem dos campos de identificação foi preenchido
      const temMovimento = ['modalidade_compra','n_oficio','qtde_solicitada','data_solicitacao',
        'requisicao_gsnet','n_empenho','quantidade_empenho','data_previsao_entrega','data_entrega',
        'qtde_entregue','status','observacao','justificativa'].some((c) => campos[c] !== null);

      if (!temMovimento) continue;
      if (!campos.ano || !campos.mes) continue;

      linhasComMovimento.push(campos);
    }
  }

  return { linhasComMovimento, abas };
}

// ---------- Pré-visualização (não grava nada) ----------
router.post('/previa', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie um arquivo .xlsx ou .xlsm.' });

  let resultado;
  try {
    resultado = processarPlanilha(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ erro: e.message });
  }

  const { linhasComMovimento, abas } = resultado;

  const stmtBuscaItem = db.prepare('SELECT codigo_item FROM itens WHERE codigo_item = ?');
  const stmtBuscaExistente = db.prepare('SELECT id FROM solicitacoes WHERE codigo_item = ? AND ano = ? AND mes = ?');

  let novos = 0, possiveisDuplicados = 0, itensInexistentes = 0;
  const codigosInexistentes = new Set();

  for (const l of linhasComMovimento) {
    if (!stmtBuscaItem.get(l.codigo_item)) {
      itensInexistentes++;
      codigosInexistentes.add(l.codigo_item);
      continue;
    }
    if (stmtBuscaExistente.get(l.codigo_item, l.ano, l.mes)) {
      possiveisDuplicados++;
    } else {
      novos++;
    }
  }

  res.json({
    abasEncontradas: abas,
    totalLinhasComMovimento: linhasComMovimento.length,
    novos,
    possiveisDuplicados,
    itensInexistentes,
    codigosInexistentes: Array.from(codigosInexistentes).slice(0, 20),
  });
});

// Grava no banco as linhas extraídas de uma planilha, no modo indicado.
// Compartilhado pela rota manual (/confirmar) e pelo vigia automático.
function gravarImportacao(buffer, modo, nomeArquivo, usuarioEmail, usuarioId = null) {
  const { linhasComMovimento, abas } = processarPlanilha(buffer);

  const stmtBuscaItem = db.prepare('SELECT codigo_item FROM itens WHERE codigo_item = ?');
  const stmtBuscaExistente = db.prepare('SELECT id FROM solicitacoes WHERE codigo_item = ? AND ano = ? AND mes = ?');

  const campos = ['codigo_item','ano','mes','tipo','modalidade_compra','n_oficio','qtde_solicitada',
    'data_solicitacao','requisicao_gsnet','n_empenho','quantidade_empenho','data_previsao_entrega',
    'data_entrega','qtde_entregue','qtde_pendente','status','observacao','justificativa'];

  const stmtInsert = db.prepare(
    `INSERT INTO solicitacoes (${campos.join(',')}) VALUES (${campos.map(() => '?').join(',')})`
  );
  const camposSemChave = campos.filter((c) => !['codigo_item','ano','mes'].includes(c));
  const stmtUpdate = db.prepare(
    `UPDATE solicitacoes SET ${camposSemChave.map((c) => `${c} = ?`).join(', ')} WHERE codigo_item = ? AND ano = ? AND mes = ?`
  );

  let inseridos = 0, atualizados = 0, ignorados = 0, itensInexistentes = 0;
  const codigosInexistentes = new Set();

  for (const l of linhasComMovimento) {
    if (!stmtBuscaItem.get(l.codigo_item)) {
      itensInexistentes++;
      codigosInexistentes.add(l.codigo_item);
      continue;
    }

    const existente = stmtBuscaExistente.get(l.codigo_item, l.ano, l.mes);

    if (!existente) {
      stmtInsert.run(...campos.map((c) => l[c]));
      inseridos++;
    } else if (modo === 'substituir') {
      stmtUpdate.run(...camposSemChave.map((c) => l[c]), l.codigo_item, l.ano, l.mes);
      atualizados++;
    } else {
      ignorados++;
    }
  }

  const resumo = {
    abasProcessadas: abas, inseridos, atualizados, ignorados, itensInexistentes,
    codigosInexistentes: Array.from(codigosInexistentes).slice(0, 20),
  };

  db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
    .run('solicitacoes', nomeArquivo, usuarioEmail, JSON.stringify(resumo));

  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
    .run(usuarioId, usuarioEmail, 'importar_solicitacoes', 'solicitacoes', JSON.stringify(resumo));

  return resumo;
}

// ---------- Confirma e grava a importação ----------
router.post('/confirmar', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie um arquivo .xlsx ou .xlsm.' });

  const modo = req.body.modo === 'substituir' ? 'substituir' : 'somente_novos';
  // 'somente_novos': ignora linhas que já existem (mesmo item+ano+mês)
  // 'substituir': atualiza a linha existente com os dados da planilha

  let resumo;
  try {
    resumo = gravarImportacao(req.file.buffer, modo, req.file.originalname, req.usuario.email, req.usuario.id);
  } catch (e) {
    return res.status(400).json({ erro: e.message });
  }

  res.json(resumo);
});

module.exports = router;
module.exports.gravarImportacao = gravarImportacao;
