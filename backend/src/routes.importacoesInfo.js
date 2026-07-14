// Consulta simples de "quando foi a última importação" por tipo. Usado pelas
// telas de relatório para mostrar "Atualizado em" no cabeçalho. Não expõe
// dado sensível (só data/hora), então basta estar autenticado — não trava
// por módulo, já que várias telas com módulos diferentes (ex.: Relatório de
// Compras TP e Tabela Análise TP) precisam do mesmo tipo de importação.
const express = require('express');
const router = express.Router();
const db = require('./db');

router.get('/ultima', (req, res) => {
  const tipo = req.query.tipo;
  if (!tipo) return res.status(400).json({ erro: 'Informe o tipo.' });
  const row = db.prepare(
    'SELECT criado_em FROM importacoes WHERE tipo = ? ORDER BY criado_em DESC LIMIT 1'
  ).get(tipo);
  res.json({ criado_em: row ? row.criado_em : null });
});

module.exports = router;
