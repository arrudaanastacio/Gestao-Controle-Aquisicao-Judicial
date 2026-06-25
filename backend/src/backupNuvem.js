// Backup do banco para a nuvem (pasta sincronizada do OneDrive).
// Usa "VACUUM INTO", que gera uma copia CONSISTENTE mesmo com o sistema
// rodando (nao corrompe). Mantem os ultimos N backups e apaga os antigos.
//
// Uso:  node src/backupNuvem.js
// Destino: <OneDrive>/Backup Compras Judiciais/medicamentos_judicial_AAAA-MM-DD.db

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const MANTER = 14; // quantos backups diarios guardar

// Descobre a pasta do OneDrive (corporativo de preferencia)
const oneDrive = process.env.OneDriveCommercial || process.env.OneDrive;
if (!oneDrive) {
  console.error('Nao encontrei o OneDrive (variavel OneDriveCommercial/OneDrive). Backup nao realizado.');
  process.exit(1);
}

const pastaBackup = path.join(oneDrive, 'Backup Compras Judiciais');
fs.mkdirSync(pastaBackup, { recursive: true });

const hoje = new Date().toISOString().slice(0, 10); // AAAA-MM-DD
const destino = path.join(pastaBackup, `medicamentos_judicial_${hoje}.db`);
const bancoOrigem = path.join(__dirname, '..', 'data', 'medicamentos_judicial.db');

// VACUUM INTO exige que o arquivo destino nao exista
if (fs.existsSync(destino)) fs.rmSync(destino);

const db = new DatabaseSync(bancoOrigem);
db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
db.close();

const tamMB = (fs.statSync(destino).size / (1024 * 1024)).toFixed(1);
console.log(`Backup criado: ${destino} (${tamMB} MB)`);

// Retencao: mantem so os MANTER mais recentes
const backups = fs.readdirSync(pastaBackup)
  .filter((n) => /^medicamentos_judicial_\d{4}-\d{2}-\d{2}\.db$/.test(n))
  .sort(); // ordem alfabetica = ordem cronologica (datas ISO)

const excedentes = backups.slice(0, Math.max(0, backups.length - MANTER));
for (const arq of excedentes) {
  fs.rmSync(path.join(pastaBackup, arq));
  console.log(`Removido backup antigo: ${arq}`);
}
console.log(`Backups guardados: ${Math.min(backups.length, MANTER)} (limite ${MANTER}).`);
