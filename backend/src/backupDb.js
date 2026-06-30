// backupDb.js — Gera uma cópia de segurança (backup) consistente do banco.
//
// Por que existe: o banco roda em modo WAL (Write-Ahead Logging), então
// simplesmente copiar o arquivo .db com o sistema ligado pode pegar uma
// versao incompleta. O comando "VACUUM INTO" do SQLite cria um snapshot
// limpo e consistente num unico arquivo, mesmo com o sistema em uso.
//
// Tambem apaga backups antigos, mantendo apenas os mais recentes (padrao 30).

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const QUANTOS_MANTER = 30; // quantos backups guardar (apaga os mais antigos)

const BANCO = path.join(__dirname, '..', 'data', 'medicamentos_judicial.db');
const PASTA_BACKUP = path.join(__dirname, '..', 'data', 'backups');

function carimboData() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '_' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

function main() {
  if (!fs.existsSync(BANCO)) {
    console.error('ERRO: banco nao encontrado em: ' + BANCO);
    process.exit(1);
  }

  fs.mkdirSync(PASTA_BACKUP, { recursive: true });

  const destino = path.join(
    PASTA_BACKUP,
    'medicamentos_judicial_' + carimboData() + '.db'
  );

  const db = new DatabaseSync(BANCO);
  // VACUUM INTO gera um arquivo unico, consistente e ja compactado.
  db.exec(`VACUUM INTO '${destino.replace(/\\/g, '/')}'`);
  db.close();

  const tamMb = (fs.statSync(destino).size / (1024 * 1024)).toFixed(1);
  console.log('Backup criado: ' + path.basename(destino) + ' (' + tamMb + ' MB)');

  // Limpa backups antigos, mantendo apenas os QUANTOS_MANTER mais recentes.
  const arquivos = fs
    .readdirSync(PASTA_BACKUP)
    .filter((f) => f.startsWith('medicamentos_judicial_') && f.endsWith('.db'))
    .sort(); // nome tem data -> ordem alfabetica = ordem cronologica

  const sobrando = arquivos.length - QUANTOS_MANTER;
  if (sobrando > 0) {
    for (let i = 0; i < sobrando; i++) {
      fs.unlinkSync(path.join(PASTA_BACKUP, arquivos[i]));
      console.log('Backup antigo removido: ' + arquivos[i]);
    }
  }

  console.log('Pasta de backups: ' + PASTA_BACKUP);
}

main();
