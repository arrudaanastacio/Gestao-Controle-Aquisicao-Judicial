// =====================================================================
// backupBanco.js — Backup diário automático do banco SQLite.
//
// Usa "VACUUM INTO" em vez de copiar o arquivo .db direto: isso garante
// uma cópia consistente mesmo com o banco em uso (modo WAL) e, de
// brinde, compacta o backup (remove espaço livre deixado por
// DELETE/reimportações, que o SQLite não libera sozinho do arquivo
// principal).
//
// Os backups ficam em backend/data/backups/, um arquivo por dia
// (AAAA-MM-DD). Mantém só os últimos N dias (BACKUP_RETENCAO_DIAS,
// padrão 14) — apaga os mais antigos automaticamente.
//
// Ligado por padrão. Desligar com AUTO_BACKUP=false no .env.
//   BACKUP_HORA=5            -> hora do backup (0-23), padrão 5
//   BACKUP_MINUTO=0          -> minuto do backup (0-59), padrão 0
//   BACKUP_RETENCAO_DIAS=14  -> quantos dias de backup manter
// =====================================================================
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { agendarDiariamente } = require('./agendadorUtil');

const PASTA_BACKUPS = path.join(__dirname, '..', 'data', 'backups');

function nomeArquivoHoje() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `medicamentos_judicial_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.db`;
}

// Apaga backups mais antigos que a retenção configurada.
function limparBackupsAntigos(dias) {
  const limiteMs = dias * 24 * 60 * 60 * 1000;
  const agora = Date.now();
  let arquivos;
  try {
    arquivos = fs.readdirSync(PASTA_BACKUPS);
  } catch {
    return;
  }
  for (const nome of arquivos) {
    if (!nome.endsWith('.db')) continue;
    const caminho = path.join(PASTA_BACKUPS, nome);
    const st = fs.statSync(caminho);
    if (agora - st.mtimeMs > limiteMs) {
      fs.unlinkSync(caminho);
      console.log(`[BACKUP BANCO] Removido backup antigo: ${nome}`);
    }
  }
}

// Roda o backup do dia. Se reimportar no mesmo dia, sobrescreve o arquivo
// de hoje (não acumula vários backups no mesmo dia).
function rodarBackup() {
  fs.mkdirSync(PASTA_BACKUPS, { recursive: true });
  const destino = path.join(PASTA_BACKUPS, nomeArquivoHoje());
  if (fs.existsSync(destino)) fs.unlinkSync(destino);

  const t0 = Date.now();
  // VACUUM INTO não aceita parâmetro (?) para o caminho — o valor é
  // controlado pelo próprio sistema (nunca vem de entrada do usuário),
  // então só escapamos aspas simples por segurança.
  db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  const segundos = Math.round((Date.now() - t0) / 1000);
  const tamanhoMB = (fs.statSync(destino).size / (1024 * 1024)).toFixed(1);
  console.log(`[BACKUP BANCO] Backup salvo: ${nomeArquivoHoje()} (${tamanhoMB} MB, ${segundos}s).`);

  const retencaoDias = Math.max(1, parseInt(process.env.BACKUP_RETENCAO_DIAS, 10) || 14);
  limparBackupsAntigos(retencaoDias);
}

function iniciarBackupDiario() {
  if (process.env.AUTO_BACKUP === 'false') {
    console.log('[BACKUP BANCO] Desativado (AUTO_BACKUP=false).');
    return;
  }
  const hora = Math.min(23, Math.max(0, parseInt(process.env.BACKUP_HORA, 10) || 5));
  const minuto = Math.min(59, Math.max(0, parseInt(process.env.BACKUP_MINUTO, 10) || 0));
  console.log(`[BACKUP BANCO] Agendado para ${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')} todo dia.`);
  agendarDiariamente('BACKUP BANCO', hora, minuto, rodarBackup);
}

module.exports = { iniciarBackupDiario, rodarBackup };

// Permite rodar direto pela linha de comando: node src/backupBanco.js
if (require.main === module) {
  require('dotenv').config();
  try {
    rodarBackup();
  } catch (e) {
    console.error('[BACKUP BANCO] Falha:', e.message);
    process.exitCode = 1;
  }
}
