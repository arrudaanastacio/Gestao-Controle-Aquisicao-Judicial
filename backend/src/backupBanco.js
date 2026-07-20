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
// Além da cópia local, se BACKUP_PASTA_DRIVE apontar para uma pasta do
// Google Drive para Desktop (ex.: "G:\Meu Drive\Backups Compras
// Judiciais"), o mesmo arquivo é copiado pra lá também — o app do Drive
// sincroniza sozinho em segundo plano. Se a pasta não existir (Drive
// fechado/deslogado), só avisa no log e segue — o backup local já
// aconteceu de qualquer forma.
//
// Além dos backups diários (14 dias), guarda também um backup MENSAL de
// longo prazo em backend/data/backups/mensais/ (1 por mês), para recuperar
// o banco de meses atrás. Fica numa subpasta de propósito: a limpeza dos
// diários apaga por data de modificação e não deve encostar nos mensais.
// Mantém os últimos BACKUP_MENSAL_MANTER meses (padrão 12).
//
// Ligado por padrão. Desligar com AUTO_BACKUP=false no .env.
//   BACKUP_HORA=5              -> hora do backup (0-23), padrão 5
//   BACKUP_MINUTO=0            -> minuto do backup (0-59), padrão 0
//   BACKUP_RETENCAO_DIAS=14    -> quantos dias de backup diário manter
//   BACKUP_MENSAL_MANTER=12    -> quantos backups mensais manter
//   BACKUP_PASTA_DRIVE=        -> pasta do Google Drive (opcional)
// =====================================================================
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { agendarDiariamente } = require('./agendadorUtil');

const PASTA_BACKUPS = path.join(__dirname, '..', 'data', 'backups');
const PASTA_MENSAIS = path.join(PASTA_BACKUPS, 'mensais');

function nomeArquivoHoje() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `medicamentos_judicial_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.db`;
}

// Apaga backups mais antigos que a retenção configurada, numa pasta dada.
function limparBackupsAntigos(pasta, dias, rotulo) {
  const limiteMs = dias * 24 * 60 * 60 * 1000;
  const agora = Date.now();
  let arquivos;
  try {
    arquivos = fs.readdirSync(pasta);
  } catch {
    return;
  }
  for (const nome of arquivos) {
    if (!nome.endsWith('.db')) continue;
    const caminho = path.join(pasta, nome);
    const st = fs.statSync(caminho);
    if (agora - st.mtimeMs > limiteMs) {
      fs.unlinkSync(caminho);
      console.log(`[BACKUP BANCO] Removido backup antigo${rotulo ? ' (' + rotulo + ')' : ''}: ${nome}`);
    }
  }
}

// Copia o backup do dia também para a pasta do Google Drive (se configurada).
// Falha silenciosa (só loga aviso): o backup local já é o que garante os
// dados, o Drive é uma segunda cópia de conveniência.
function copiarParaDrive(origem, nomeArquivo, retencaoDias) {
  const pastaDrive = process.env.BACKUP_PASTA_DRIVE;
  if (!pastaDrive) return;
  try {
    fs.mkdirSync(pastaDrive, { recursive: true });
    const destino = path.join(pastaDrive, nomeArquivo);
    fs.copyFileSync(origem, destino);
    console.log(`[BACKUP BANCO] Copiado também para o Google Drive: ${destino}`);
    limparBackupsAntigos(pastaDrive, retencaoDias, 'Google Drive');
  } catch (e) {
    console.warn(`[BACKUP BANCO] Não consegui copiar para o Google Drive (${pastaDrive}): ${e.message}`);
  }
}

// Nome do backup mensal do mês corrente (ex.: ..._mensal_2026-07.db).
function nomeMensalAtual() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `medicamentos_judicial_mensal_${d.getFullYear()}-${p(d.getMonth() + 1)}.db`;
}

// Mantém só os últimos N backups mensais numa pasta, apagando os mais
// antigos. Aqui a poda é por CONTAGEM (não por data de modificação): os
// mensais são antigos de propósito. O nome AAAA-MM ordena cronologicamente.
function limparMensaisAntigos(pasta, manter, rotulo) {
  let arquivos;
  try {
    arquivos = fs.readdirSync(pasta)
      .filter((n) => /^medicamentos_judicial_mensal_\d{4}-\d{2}\.db$/.test(n));
  } catch {
    return;
  }
  arquivos.sort(); // AAAA-MM em ordem crescente
  const excedente = arquivos.slice(0, Math.max(0, arquivos.length - manter));
  for (const nome of excedente) {
    try {
      fs.unlinkSync(path.join(pasta, nome));
      console.log(`[BACKUP BANCO] Removido backup mensal antigo${rotulo ? ' (' + rotulo + ')' : ''}: ${nome}`);
    } catch (_) { /* ignora */ }
  }
}

// Garante 1 backup mensal do mês corrente (o primeiro backup do mês vira o
// mensal daquele mês). Aproveita o backup diário já gerado (só copia, sem
// rodar VACUUM de novo). Depois poda os mensais além do limite.
function garantirBackupMensal(origem, manter) {
  fs.mkdirSync(PASTA_MENSAIS, { recursive: true });
  const destino = path.join(PASTA_MENSAIS, nomeMensalAtual());
  if (!fs.existsSync(destino)) {
    fs.copyFileSync(origem, destino);
    console.log(`[BACKUP BANCO] Backup mensal criado: ${nomeMensalAtual()}`);
  }
  limparMensaisAntigos(PASTA_MENSAIS, manter);

  // Também no Google Drive (subpasta mensais/), se configurado.
  const pastaDrive = process.env.BACKUP_PASTA_DRIVE;
  if (pastaDrive) {
    try {
      const dm = path.join(pastaDrive, 'mensais');
      fs.mkdirSync(dm, { recursive: true });
      const dd = path.join(dm, nomeMensalAtual());
      if (!fs.existsSync(dd)) fs.copyFileSync(origem, dd);
      limparMensaisAntigos(dm, manter, 'Google Drive');
    } catch (e) {
      console.warn(`[BACKUP BANCO] Backup mensal no Drive falhou: ${e.message}`);
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
  limparBackupsAntigos(PASTA_BACKUPS, retencaoDias);
  copiarParaDrive(destino, nomeArquivoHoje(), retencaoDias);

  // Backup mensal de longo prazo (1 por mês, mantém os últimos N meses).
  const mensalManter = Math.max(1, parseInt(process.env.BACKUP_MENSAL_MANTER, 10) || 12);
  garantirBackupMensal(destino, mensalManter);
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
