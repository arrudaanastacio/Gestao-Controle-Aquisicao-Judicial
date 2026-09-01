// =====================================================================
// routes.integracaoSigem.js
// API de integração (somente leitura) que alimenta o sistema SIGEM com as
// Movimentações de ENTRADA da unidade Tenente Pena.
//
// - Consumo: o SIGEM faz GET e recebe JSON.
// - Autenticação: CHAVE DE API secreta (SIGEM_API_KEY), enviada em cada
//   requisição. O repositório é público, então a chave fica SÓ no .env.
//     Cabeçalho:  Authorization: Bearer <chave>
//        ou:      X-API-Key: <chave>
// - Recorte: INCREMENTAL por data — o SIGEM informa ?desde=AAAA-MM-DD para
//   puxar só as entradas a partir daquela data (opcional ?ate=AAAA-MM-DD).
//
// Esta rota NÃO usa o login por cookie (JWT) do sistema — é máquina-a-máquina.
// =====================================================================
const express = require('express');
const crypto = require('crypto');
const db = require('./db');

const router = express.Router();

const FILTRO_TP = "unidade LIKE '%Tenente Pena%'";

// Middleware: exige a chave de API do SIGEM (comparação em tempo constante).
function exigirChaveSigem(req, res, next) {
  const chave = process.env.SIGEM_API_KEY;
  if (!chave) {
    return res.status(503).json({ erro: 'Integração SIGEM não configurada. Defina SIGEM_API_KEY no .env do servidor.' });
  }
  const auth = req.get('authorization') || '';
  const enviado = auth.startsWith('Bearer ')
    ? auth.slice(7).trim()
    : (req.get('x-api-key') || req.query.api_key || '').trim();
  const a = Buffer.from(enviado);
  const b = Buffer.from(chave);
  if (!enviado || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ erro: 'Não autorizado: chave de API ausente ou inválida.' });
  }
  next();
}
router.use(exigirChaveSigem);

// Teste rápido de conectividade/credencial para o SIGEM.
// GET /api/sigem/ping  ->  { ok: true, sistema, hora }
router.get('/ping', (req, res) => {
  res.json({ ok: true, sistema: 'Compras Judiciais — Tenente Pena', hora: new Date().toISOString() });
});

// Colunas da tabela -> nomes expostos na API (estáveis para o SIGEM).
// Se o SIGEM precisar de mais/menos campos, é só ajustar aqui.
function mapear(r) {
  return {
    id: r.id,
    data_entrada: r.data_entrada,
    tipo_movimentacao: r.tipo_movimentacao,
    codigo_item: r.codigo_item,      // SCODES
    item: r.item,                    // descrição do item
    categoria: r.categoria,
    lote: r.lote,
    validade: r.validade,
    quantidade: r.qtde,
    quantidade_acerto: r.qtde_acerto,
    valor_unitario: r.valor_unitario,
    valor_total: r.valor_total,
    nota_empenho: r.nota_empenho,
    nota_fiscal: r.nota_fiscal,
    documento_transferencia: r.documento_transferencia,
    modalidade_compra: r.modalidade_compra,
    fornecedor: r.fornecedor,
    fornecedor_cnpj: r.fornecedor_cnpj,
    fabricante: r.fabricante,
    termolabil: r.termolabil,
    unidade_transferencia: r.unidade_transferencia,
    tipo_transferencia: r.tipo_transferencia,
    observacao: r.observacao,
    usuario_login: r.usuario_login,
  };
}

// Movimentações de ENTRADA da Tenente Pena (incremental por data).
// GET /api/sigem/movimentacao-entrada?desde=AAAA-MM-DD[&ate=AAAA-MM-DD][&pagina=1][&tamanho=500]
router.get('/movimentacao-entrada', (req, res) => {
  const { desde, ate } = req.query;
  const tamanho = Math.min(Math.max(parseInt(req.query.tamanho, 10) || 500, 1), 2000);
  const pagina = Math.max(parseInt(req.query.pagina, 10) || 1, 1);
  const offset = (pagina - 1) * tamanho;

  const cond = [FILTRO_TP];
  const params = [];
  if (desde) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(desde))) {
      return res.status(400).json({ erro: 'Parâmetro "desde" deve estar no formato AAAA-MM-DD.' });
    }
    cond.push('date(data_entrada) >= date(?)'); params.push(desde);
  }
  if (ate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ate))) {
      return res.status(400).json({ erro: 'Parâmetro "ate" deve estar no formato AAAA-MM-DD.' });
    }
    cond.push('date(data_entrada) <= date(?)'); params.push(ate);
  }
  const where = 'WHERE ' + cond.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) c FROM entrada_lotes_itens ${where}`).get(...params).c;
  const linhas = db.prepare(`
    SELECT * FROM entrada_lotes_itens ${where}
    ORDER BY date(data_entrada) ASC, id ASC
    LIMIT ? OFFSET ?
  `).all(...params, tamanho, offset);

  res.json({
    unidade: 'Tenente Pena',
    gerado_em: new Date().toISOString(),
    filtro: { desde: desde || null, ate: ate || null },
    paginacao: { pagina, tamanho, total, paginas: Math.ceil(total / tamanho) || 1 },
    quantidade: linhas.length,
    movimentacoes: linhas.map(mapear),
  });
});

module.exports = router;
