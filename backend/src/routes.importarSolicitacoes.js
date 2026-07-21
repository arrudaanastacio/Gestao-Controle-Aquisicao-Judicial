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

// Identidade completa de uma linha de solicitação. Usada só no modo
// 'somente_novos' (para não reinserir o que já está lá). Inclui TIPO
// (JS/AS/JM/ASM), ofício, requisição GSNET e quantidade: o mesmo item pode
// ter várias solicitações no mesmo mês, e elas se distinguem por esses
// campos — considerar só item+ano+mês fundia solicitações diferentes.
function chaveIdentidade(l) {
  return [l.codigo_item, l.ano, l.mes, l.tipo, l.n_oficio, l.requisicao_gsnet, l.qtde_solicitada]
    .map((v) => (v === null || v === undefined ? '' : String(v).trim()))
    .join('||');
}

// Grava no banco as linhas extraídas de uma planilha, no modo indicado.
// Compartilhado pela rota manual (/confirmar) e pelo vigia automático.
//
// modo 'substituir' (usado pelo vigia): REFAZ O MÊS. Para cada (ano, mês)
// presente na planilha, apaga tudo daquele mês e regrava as linhas da
// planilha. A planilha é a fonte da verdade, então o banco vira um espelho
// exato dela. Isso resolve de uma vez:
//   - várias solicitações do mesmo item no mesmo mês (JS/AS/JM/ASM) que
//     antes eram fundidas numa linha só (uma sobrescrevia a outra);
//   - correções feitas na planilha (quantidade, ofício) que antes gerariam
//     duplicata em vez de corrigir;
//   - duplicatas históricas já achatadas, que somem ao refazer o mês.
// Meses que NÃO aparecem na planilha nunca são tocados.
//
// modo 'somente_novos': não apaga nada; insere só as linhas que ainda não
// existem, comparando pela identidade completa (ver chaveIdentidade).
function gravarImportacao(buffer, modo, nomeArquivo, usuarioEmail, usuarioId = null) {
  const { linhasComMovimento, abas } = processarPlanilha(buffer);

  const stmtBuscaItem = db.prepare('SELECT codigo_item FROM itens WHERE codigo_item = ?');

  const campos = ['codigo_item','ano','mes','tipo','modalidade_compra','n_oficio','qtde_solicitada',
    'data_solicitacao','requisicao_gsnet','n_empenho','quantidade_empenho','data_previsao_entrega',
    'data_entrega','qtde_entregue','qtde_pendente','status','observacao','justificativa'];

  const stmtInsert = db.prepare(
    `INSERT INTO solicitacoes (${campos.join(',')}) VALUES (${campos.map(() => '?').join(',')})`
  );

  let inseridos = 0, atualizados = 0, ignorados = 0, itensInexistentes = 0, apagados = 0;
  const codigosInexistentes = new Set();
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

      // Só as linhas cujo item existe no catálogo podem ser gravadas.
      const gravaveis = [];
      for (const l of linhas) {
        if (!stmtBuscaItem.get(l.codigo_item)) {
          itensInexistentes++;
          codigosInexistentes.add(l.codigo_item);
          continue;
        }
        gravaveis.push(l);
      }

      if (modo === 'substituir') {
        const existentes = db.prepare(
          'SELECT COUNT(*) c FROM solicitacoes WHERE ano = ? AND mes = ?'
        ).get(ano, mes).c;

        // Rede de segurança: se a planilha traz bem menos linhas do que o
        // banco já tem para o mês, pode ser arquivo truncado/corrompido.
        // Não bloqueia (a planilha manda), mas registra aviso bem visível.
        if (existentes > 0 && gravaveis.length < existentes * 0.5) {
          const aviso = `Mês ${mes}/${ano}: planilha trouxe ${gravaveis.length} linha(s) e o banco tinha ${existentes}. Verifique se a planilha está completa.`;
          avisos.push(aviso);
          console.warn(`[IMPORTAR SOLICITACOES] ATENCAO - ${aviso}`);
        }

        apagados += db.prepare('DELETE FROM solicitacoes WHERE ano = ? AND mes = ?').run(ano, mes).changes;
        for (const l of gravaveis) {
          stmtInsert.run(...campos.map((c) => l[c]));
          inseridos++;
        }
      } else {
        // somente_novos: insere o que ainda não existe, pela identidade completa.
        const jaExistem = new Set(
          db.prepare(`SELECT ${campos.join(',')} FROM solicitacoes WHERE ano = ? AND mes = ?`)
            .all(ano, mes).map(chaveIdentidade)
        );
        for (const l of gravaveis) {
          if (jaExistem.has(chaveIdentidade(l))) { ignorados++; continue; }
          stmtInsert.run(...campos.map((c) => l[c]));
          jaExistem.add(chaveIdentidade(l));
          inseridos++;
        }
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const resumo = {
    abasProcessadas: abas, inseridos, atualizados, ignorados, itensInexistentes,
    apagados, mesesRefeitos: modo === 'substituir' ? porMes.size : 0,
    avisos,
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

// Atualização manual "agora" (admin) — relê o arquivo da pasta de rede e
// reimporta, sem esperar o horário agendado (12h/19h). Usado pelos botões
// "Atualizar agora" das telas Relatório de Compras TP e Tabela Análise TP.
router.post('/atualizar-agora', exigirPerfil('admin'), (req, res) => {
  try {
    const { forcarImportacaoSolicitacoes } = require('./vigiaSolicitacoes');
    const resumo = forcarImportacaoSolicitacoes(req.usuario.email, req.usuario.id);
    res.json({ ok: true, ...resumo });
  } catch (e) {
    const status = e.codigo === 'ARQUIVO_NAO_ENCONTRADO' ? 404
      : e.codigo === 'ARQUIVO_EM_GRAVACAO' ? 409 : 400;
    res.status(status).json({ erro: e.message });
  }
});

module.exports = router;
module.exports.gravarImportacao = gravarImportacao;
