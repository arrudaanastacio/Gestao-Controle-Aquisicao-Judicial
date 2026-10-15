// =====================================================================
// descompactarBackup.js
// Descompacta um backup .gz de volta para .db (para RESTAURAR o banco).
//
// Uso:
//   node src/descompactarBackup.js                 -> o diário MAIS RECENTE
//   node src/descompactarBackup.js "caminho/arquivo.db.gz"
//
// Gera o .db numa subpasta "restaurados/" (não sobrescreve nada). Depois é
// só copiar esse .db por cima de data/medicamentos_judicial.db com o sistema
// PARADO, para voltar o banco àquele ponto.
// =====================================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { chaveBackup, decifrarEDescomprimir, pareceCifrado } = require('./backupCripto');

const PASTA_BACKUPS = path.join(__dirname, '..', 'data', 'backups');
const PASTA_SAIDA = path.join(PASTA_BACKUPS, 'restaurados');

// Acha o backup diário mais recente (por nome AAAA-MM-DD), cifrado (.db.gz.enc)
// ou só compactado (.db.gz).
function maisRecente() {
  let arquivos = [];
  try {
    arquivos = fs.readdirSync(PASTA_BACKUPS)
      .filter((n) => /^medicamentos_judicial_\d{4}-\d{2}-\d{2}\.db\.gz(\.enc)?$/.test(n))
      .sort();
  } catch { /* ignora */ }
  return arquivos.length ? path.join(PASTA_BACKUPS, arquivos[arquivos.length - 1]) : null;
}

// Restaura um backup para .db. Se o arquivo for cifrado (.enc), descriptografa
// com BACKUP_CHAVE (.env) e descomprime; senão, só descomprime.
function descompactar(origem) {
  return new Promise((resolve, reject) => {
    if (!origem || !fs.existsSync(origem)) return reject(new Error('Backup não encontrado: ' + origem));
    fs.mkdirSync(PASTA_SAIDA, { recursive: true });

    if (pareceCifrado(origem)) {
      const senha = chaveBackup();
      if (!senha) return reject(new Error('Backup cifrado (.enc), mas BACKUP_CHAVE não está definida no backend/.env. Defina a mesma senha usada no backup.'));
      const nomeSaida = path.basename(origem).replace(/\.gz\.enc$/i, ''); // tira .gz.enc -> .db
      return decifrarEDescomprimir(origem, path.join(PASTA_SAIDA, nomeSaida), senha).then(resolve, reject);
    }

    const nomeSaida = path.basename(origem).replace(/\.gz$/i, ''); // tira só o .gz -> .db
    const destino = path.join(PASTA_SAIDA, nomeSaida);
    const inp = fs.createReadStream(origem);
    const out = fs.createWriteStream(destino);
    const gunzip = zlib.createGunzip();
    inp.on('error', reject); gunzip.on('error', reject); out.on('error', reject);
    out.on('finish', () => resolve(destino));
    inp.pipe(gunzip).pipe(out);
  });
}

if (require.main === module) {
  const arg = process.argv[2];
  const origem = arg ? path.resolve(arg) : maisRecente();
  if (!origem) {
    console.error('[RESTAURAR] Nenhum backup .gz encontrado em', PASTA_BACKUPS);
    process.exit(1);
  }
  console.log('[RESTAURAR] Descompactando:', origem);
  descompactar(origem)
    .then((destino) => {
      const mb = (fs.statSync(destino).size / (1024 * 1024)).toFixed(1);
      console.log(`[RESTAURAR] Pronto: ${destino} (${mb} MB).`);
      console.log('[RESTAURAR] Para restaurar: PARE o sistema e copie esse .db por cima de data/medicamentos_judicial.db.');
    })
    .catch((e) => { console.error('[RESTAURAR] Falha:', e.message); process.exit(1); });
}

module.exports = { descompactar, maisRecente };
