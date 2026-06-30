// backupGoogleDrive.js — Backup do banco para a pasta do Google Drive.
//
// Como funciona: o "Google Drive para Desktop" cria uma pasta no PC (ex.:
// G:\Meu Drive ou H:\Meu Drive) que sincroniza sozinha com a nuvem. Este
// script gera uma copia consistente do banco (VACUUM INTO, seguro mesmo com
// o sistema ligado) dentro dessa pasta. O Google sobe o arquivo sozinho.
//
// Detecta a pasta do Drive automaticamente. Se nao achar, voce pode forcar
// criando a variavel de ambiente GOOGLE_DRIVE_DIR apontando para a pasta.
//
// Uso:  node src/backupGoogleDrive.js

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const MANTER = 30;            // quantos backups guardar
const SUBPASTA = 'Backup Compras Judiciais'; // pasta criada dentro do Drive

// Procura a pasta raiz do Google Drive (Meu Drive / My Drive) em varios lugares.
function acharGoogleDrive() {
  // 1) Forcado por variavel de ambiente
  if (process.env.GOOGLE_DRIVE_DIR && fs.existsSync(process.env.GOOGLE_DRIVE_DIR)) {
    return process.env.GOOGLE_DRIVE_DIR;
  }
  const nomes = ['Meu Drive', 'My Drive'];
  const candidatos = [];
  // 2) Dentro do perfil do usuario
  for (const n of nomes) {
    candidatos.push(path.join(process.env.USERPROFILE || '', n));
    candidatos.push(path.join(process.env.USERPROFILE || '', 'Google Drive', n));
  }
  // 3) Em qualquer letra de unidade (D: ate Z:)
  for (let c = 68; c <= 90; c++) {
    const letra = String.fromCharCode(c) + ':\\';
    for (const n of nomes) candidatos.push(path.join(letra, n));
  }
  for (const c of candidatos) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

function carimboData() {
  return new Date().toISOString().slice(0, 10); // AAAA-MM-DD
}

function main() {
  const raizDrive = acharGoogleDrive();
  if (!raizDrive) {
    console.error(
      'Nao encontrei a pasta do Google Drive.\n' +
      'Verifique se o "Google Drive para Desktop" esta instalado e logado,\n' +
      'ou defina a variavel GOOGLE_DRIVE_DIR com o caminho da pasta.'
    );
    process.exit(1);
  }

  const pastaBackup = path.join(raizDrive, SUBPASTA);
  fs.mkdirSync(pastaBackup, { recursive: true });

  const destino = path.join(pastaBackup, `medicamentos_judicial_${carimboData()}.db`);
  const bancoOrigem = path.join(__dirname, '..', 'data', 'medicamentos_judicial.db');

  // VACUUM INTO exige que o destino nao exista (sobrescreve o do mesmo dia).
  if (fs.existsSync(destino)) fs.rmSync(destino);

  const db = new DatabaseSync(bancoOrigem);
  db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  db.close();

  const tamMB = (fs.statSync(destino).size / (1024 * 1024)).toFixed(1);
  console.log(`Backup criado: ${destino} (${tamMB} MB)`);
  console.log('O Google Drive vai sincronizar este arquivo automaticamente.');

  // Retencao: mantem so os MANTER mais recentes.
  const backups = fs.readdirSync(pastaBackup)
    .filter((n) => /^medicamentos_judicial_\d{4}-\d{2}-\d{2}\.db$/.test(n))
    .sort();
  const excedentes = backups.slice(0, Math.max(0, backups.length - MANTER));
  for (const arq of excedentes) {
    fs.rmSync(path.join(pastaBackup, arq));
    console.log(`Removido backup antigo: ${arq}`);
  }
}

main();
