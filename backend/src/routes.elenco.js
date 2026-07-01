const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('./db');
const { autenticar, exigirPerfil } = require('./auth');

const router = express.Router();
router.use(autenticar);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// Possíveis nomes de cabeçalho aceitos para cada campo, para tolerar pequenas
// variações entre planilhas (acentos, maiúsculas, quebras de linha do Excel)
const ALIASES = {
  codigo_item: ['código do item', 'codigo do item', 'código', 'codigo'],
  codigo_siafisico: ['código\nsiafísico', 'codigo siafisico', 'código siafísico', 'siafisico', 'cod siafisico', 'cód. siafísico'],
  descricao: ['descrição do item', 'descricao do item', 'descrição', 'descricao'],
  catmat: ['catmat', 'código catmat', 'codigo catmat'],
};

function normalizarTexto(v) {
  return String(v ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapearColunas(headerRow) {
  const mapa = {};
  headerRow.forEach((valorBruto, idx) => {
    const valor = normalizarTexto(valorBruto);
    for (const [campo, aliases] of Object.entries(ALIASES)) {
      if (mapa[campo] !== undefined) continue;
      if (aliases.some((a) => normalizarTexto(a) === valor)) {
        mapa[campo] = idx;
      }
    }
  });
  return mapa;
}

function limpar(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' || t === '-' ? null : t;
  }
  if (typeof v === 'number') return String(v);
  return v;
}

// ---------- Pré-visualização do elenco a importar (não grava nada ainda) ----------
router.post('/previa', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie um arquivo .xlsx ou .xlsm.' });

  let linhasPlanilha;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const primeiraAba = wb.SheetNames[0];
    linhasPlanilha = XLSX.utils.sheet_to_json(wb.Sheets[primeiraAba], { header: 1, defval: null });
  } catch (e) {
    return res.status(400).json({ erro: 'Não foi possível ler o arquivo. Verifique se é um .xlsx/.xlsm válido.' });
  }

  if (linhasPlanilha.length < 2) {
    return res.status(400).json({ erro: 'Planilha vazia ou sem linhas de dados.' });
  }

  const mapa = mapearColunas(linhasPlanilha[0]);
  if (mapa.codigo_item === undefined || mapa.descricao === undefined) {
    return res.status(400).json({
      erro: 'Não encontrei as colunas "Código do Item" e "Descrição do Item" no cabeçalho da planilha. Verifique se o layout é o mesmo do arquivo modelo.',
    });
  }

  const codigosNaPlanilha = new Set();
  const itensNovos = [];
  const itensAtualizados = [];

  const todosOsItensAtuais = db.prepare('SELECT codigo_item, codigo_siafisico, descricao, catmat, ativo FROM itens').all();
  const mapaAtual = new Map(todosOsItensAtuais.map((i) => [i.codigo_item, i]));

  for (let i = 1; i < linhasPlanilha.length; i++) {
    const linha = linhasPlanilha[i];
    const codigo = limpar(linha[mapa.codigo_item]);
    if (!codigo) continue;

    const siafisico = mapa.codigo_siafisico !== undefined ? limpar(linha[mapa.codigo_siafisico]) : null;
    const descricao = limpar(linha[mapa.descricao]);
    const catmat = mapa.catmat !== undefined ? limpar(linha[mapa.catmat]) : null;

    codigosNaPlanilha.add(codigo);
    const atual = mapaAtual.get(codigo);

    if (!atual) {
      itensNovos.push({ codigo_item: codigo, codigo_siafisico: siafisico, descricao, catmat });
    } else {
      const mudou =
        (descricao && descricao !== atual.descricao) ||
        (siafisico !== null && siafisico !== atual.codigo_siafisico) ||
        (catmat !== null && catmat !== atual.catmat) ||
        atual.ativo === 0; // reativa se reaparecer no elenco
      if (mudou) {
        itensAtualizados.push({
          codigo_item: codigo,
          de: { codigo_siafisico: atual.codigo_siafisico, descricao: atual.descricao, catmat: atual.catmat, ativo: atual.ativo },
          para: { codigo_siafisico: siafisico ?? atual.codigo_siafisico, descricao: descricao ?? atual.descricao, catmat: catmat ?? atual.catmat, ativo: 1 },
        });
      }
    }
  }

  // Itens que existiam no catálogo mas não vieram na planilha nova
  const itensParaInativar = todosOsItensAtuais
    .filter((i) => i.ativo === 1 && !codigosNaPlanilha.has(i.codigo_item))
    .map((i) => {
      const temHistorico = db.prepare('SELECT COUNT(*) c FROM solicitacoes WHERE codigo_item = ?').get(i.codigo_item).c;
      return { codigo_item: i.codigo_item, descricao: i.descricao, tem_historico: temHistorico > 0, qtde_solicitacoes: temHistorico };
    });

  res.json({
    totalLinhasPlanilha: linhasPlanilha.length - 1,
    itensNovos,
    itensAtualizados,
    itensParaInativar,
    colunasEncontradas: mapa,
  });
});

// ---------- Confirma e grava a importação do elenco ----------
router.post('/confirmar', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie um arquivo .xlsx ou .xlsm.' });

  let linhasPlanilha;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const primeiraAba = wb.SheetNames[0];
    linhasPlanilha = XLSX.utils.sheet_to_json(wb.Sheets[primeiraAba], { header: 1, defval: null });
  } catch (e) {
    return res.status(400).json({ erro: 'Não foi possível ler o arquivo.' });
  }

  const mapa = mapearColunas(linhasPlanilha[0]);
  if (mapa.codigo_item === undefined || mapa.descricao === undefined) {
    return res.status(400).json({ erro: 'Cabeçalho da planilha não reconhecido.' });
  }

  const codigosNaPlanilha = new Set();
  let inseridos = 0, atualizados = 0, inativados = 0, alertasGerados = 0;

  const todosOsItensAtuais = db.prepare('SELECT codigo_item, codigo_siafisico, descricao, catmat, ativo FROM itens').all();
  const mapaAtual = new Map(todosOsItensAtuais.map((i) => [i.codigo_item, i]));

  const stmtInsert = db.prepare(
    'INSERT INTO itens (codigo_item, codigo_siafisico, descricao, catmat, ativo, atualizado_em) VALUES (?, ?, ?, ?, 1, datetime(\'now\'))'
  );
  const stmtUpdate = db.prepare(
    'UPDATE itens SET codigo_siafisico = ?, descricao = ?, catmat = ?, ativo = 1, inativado_em = NULL, atualizado_em = datetime(\'now\') WHERE codigo_item = ?'
  );
  const stmtInativar = db.prepare(
    'UPDATE itens SET ativo = 0, inativado_em = datetime(\'now\'), atualizado_em = datetime(\'now\') WHERE codigo_item = ?'
  );
  const stmtAlerta = db.prepare(
    'INSERT INTO alertas (tipo, codigo_item, mensagem) VALUES (?, ?, ?)'
  );

  for (let i = 1; i < linhasPlanilha.length; i++) {
    const linha = linhasPlanilha[i];
    const codigo = limpar(linha[mapa.codigo_item]);
    if (!codigo) continue;

    const siafisico = mapa.codigo_siafisico !== undefined ? limpar(linha[mapa.codigo_siafisico]) : null;
    const descricao = limpar(linha[mapa.descricao]);
    const catmat = mapa.catmat !== undefined ? limpar(linha[mapa.catmat]) : null;

    codigosNaPlanilha.add(codigo);
    const atual = mapaAtual.get(codigo);

    if (!atual) {
      stmtInsert.run(codigo, siafisico, descricao || codigo, catmat);
      inseridos++;
    } else {
      const novaDescricao = descricao || atual.descricao;
      const novoSiafisico = siafisico !== null ? siafisico : atual.codigo_siafisico;
      const novoCatmat = catmat !== null ? catmat : atual.catmat;
      const mudou = novaDescricao !== atual.descricao || novoSiafisico !== atual.codigo_siafisico || novoCatmat !== atual.catmat || atual.ativo === 0;
      if (mudou) {
        stmtUpdate.run(novoSiafisico, novaDescricao, novoCatmat, codigo);
        atualizados++;
      }
    }
  }

  // Itens que saíram do elenco
  for (const item of todosOsItensAtuais) {
    if (item.ativo === 1 && !codigosNaPlanilha.has(item.codigo_item)) {
      stmtInativar.run(item.codigo_item);
      inativados++;

      const temHistorico = db.prepare('SELECT COUNT(*) c FROM solicitacoes WHERE codigo_item = ?').get(item.codigo_item).c;
      if (temHistorico > 0) {
        stmtAlerta.run(
          'item_removido_com_historico',
          item.codigo_item,
          `O item "${item.descricao}" (${item.codigo_item}) foi removido do elenco de medicamentos, mas possui ${temHistorico} solicitação(ões) de compra registrada(s). O item foi inativado, não excluído, e seu histórico continua disponível para consulta.`
        );
        alertasGerados++;
      }
    }
  }

  const resumo = { inseridos, atualizados, inativados, alertasGerados, totalLinhasPlanilha: linhasPlanilha.length - 1 };

  db.prepare('INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)')
    .run('elenco', req.file.originalname, req.usuario.email, JSON.stringify(resumo));

  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, dados_depois) VALUES (?, ?, ?, ?, ?)')
    .run(req.usuario.id, req.usuario.email, 'importar_elenco', 'itens', JSON.stringify(resumo));

  res.json(resumo);
});

// ---------- Busca de item do elenco por código (para tela de edição) ----------
router.get('/buscar', (req, res) => {
  const { codigo } = req.query;
  if (!codigo) return res.status(400).json({ erro: 'Informe o código do item.' });

  const item = db.prepare('SELECT * FROM itens WHERE codigo_item = ?').get(codigo.trim());
  if (!item) return res.status(404).json({ erro: 'Item não encontrado no elenco.' });

  const qtdeSolicitacoes = db.prepare('SELECT COUNT(*) c FROM solicitacoes WHERE codigo_item = ?').get(item.codigo_item).c;

  res.json({ item, qtdeSolicitacoes });
});

// ---------- Edição manual de um item do elenco (siafísico, descrição, CATMAT) ----------
router.put('/:codigo', (req, res) => {
  const { codigo } = req.params;
  const atual = db.prepare('SELECT * FROM itens WHERE codigo_item = ?').get(codigo);
  if (!atual) return res.status(404).json({ erro: 'Item não encontrado.' });

  const { codigo_siafisico, descricao, catmat } = req.body || {};

  db.prepare(
    'UPDATE itens SET codigo_siafisico = ?, descricao = ?, catmat = ?, atualizado_em = datetime(\'now\') WHERE codigo_item = ?'
  ).run(
    codigo_siafisico !== undefined ? codigo_siafisico : atual.codigo_siafisico,
    descricao !== undefined ? descricao : atual.descricao,
    catmat !== undefined ? catmat : atual.catmat,
    codigo
  );

  db.prepare('INSERT INTO auditoria (usuario_id, usuario_email, acao, tabela, registro_id, dados_antes, dados_depois) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.usuario.id, req.usuario.email, 'editar_item_elenco', 'itens', codigo, JSON.stringify(atual), JSON.stringify(req.body));

  res.json({ ok: true });
});

module.exports = router;
