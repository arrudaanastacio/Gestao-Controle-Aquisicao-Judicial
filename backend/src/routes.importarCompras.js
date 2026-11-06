// Rota do IMPORTADOR ÚNICO de solicitações de compra (ver importadorCompras.js).
// Só admin importa. Dois passos: /previa (não grava) e /confirmar (grava).
const express = require('express');
const multer = require('multer');
const { autenticar, exigirPerfil } = require('./auth');
const imp = require('./importadorCompras');

const router = express.Router();
router.use(autenticar, exigirPerfil('admin'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// Lista de destinos aceitos (para o frontend montar o seletor).
router.get('/destinos', (req, res) => {
  res.json({ destinos: Object.keys(imp.DESTINOS) });
});

// Prévia: conta novos/duplicados/itens a cadastrar, sem gravar nada.
router.post('/previa', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie um arquivo .xlsx ou .xlsm.' });
  const destino = req.body.destino;
  if (!imp.destinoValido(destino)) return res.status(400).json({ erro: 'Selecione um destino válido (Medicamentos, Nutrição, Materiais ou Outras Demandas).' });
  try {
    res.json(imp.previa(req.file.buffer, destino));
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

// Confirma: grava as solicitações novas no destino escolhido.
router.post('/confirmar', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie um arquivo .xlsx ou .xlsm.' });
  const destino = req.body.destino;
  if (!imp.destinoValido(destino)) return res.status(400).json({ erro: 'Selecione um destino válido (Medicamentos, Nutrição, Materiais ou Outras Demandas).' });
  try {
    res.json(imp.gravar(req.file.buffer, destino, req.file.originalname, req.usuario.email, req.usuario.id));
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

module.exports = router;
