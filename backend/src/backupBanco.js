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
// (AAAA-MM-DD.db.gz — COMPACTADO em gzip, reduz ~80%), gerados só em DIAS
// ÚTEIS (seg–sex). Janela ROLANTE: mantém só os últimos N backups diários
// por CONTAGEM (BACKUP_MANTER_DIARIOS, padrão 7) — ao gerar um novo, o mais
// antigo é apagado. Para restaurar, descompactar com src/descompactarBackup.js.
//
// Além da cópia local, se BACKUP_PASTA_DRIVE apontar para uma pasta do
// Google Drive para Desktop (ex.: "G:\Meu Drive\Backups Compras
// Judiciais"), o mesmo arquivo é copiado pra lá também — o app do Drive
// sincroniza sozinho em segundo plano. Se a pasta não existir (Drive
// fechado/deslogado), só avisa no log e segue — o backup local já
// aconteceu de qualquer forma.
//
// Além dos backups diários, guarda também um backup MENSAL de longo prazo
// em backend/data/backups/mensais/ (1 por mês), para recuperar o banco de
// meses atrás. Fica numa subpasta de propósito: a limpeza dos diários é por
// contagem/padrão de nome e não encosta nos mensais.
// Janela ROLANTE por contagem: mantém os últimos BACKUP_MENSAL_MANTER meses
// (padrão 3) — ao criar o mês novo, o mês mais antigo é apagado.
//
// Ligado por padrão. Desligar com AUTO_BACKUP=false no .env.
//   BACKUP_HORA=5              -> hora do backup (0-23), padrão 5
//   BACKUP_MINUTO=0            -> minuto do backup (0-59), padrão 0
//   BACKUP_MANTER_DIARIOS=7    -> quantos backups diários manter (janela rolante)
//   BACKUP_MENSAL_MANTER=3     -> quantos backups mensais manter (janela rolante)
//   BACKUP_PASTA_DRIVE=        -> pasta do Google Drive (opcional)
// =====================================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');
const db = require('./db');
const { agendarDiariamente } = require('./agendadorUtil');
const reg = require('./registroServicos');

// Compacta um arquivo para .gz por STREAMING (memória constante — importante
// porque o backup tem centenas de MB). Reduz ~80% o tamanho no Drive.
function comprimirGz(origem, destino) {
  return new Promise((resolve, reject) => {
    const inp = fs.createReadStream(origem);
    const out = fs.createWriteStream(destino);
    const gz = zlib.createGzip({ level: 6 });
    inp.on('error', reject); gz.on('error', reject); out.on('error', reject);
    out.on('finish', resolve);
    inp.pipe(gz).pipe(out);
  });
}

const PASTA_BACKUPS = path.join(__dirname, '..', 'data', 'backups');
const PASTA_MENSAIS = path.join(PASTA_BACKUPS, 'mensais');

// Tabelas grandes e 100% deriváveis do Oracle que NÃO precisam ir para o
// backup (recarregáveis via "Atualizar via Oracle"). São removidas apenas da
// CÓPIA de backup, nunca do banco vivo.
const TABELAS_FORA_DO_BACKUP = ['recibos_entregas'];

// Abre o arquivo de backup e remove as tabelas deriváveis, compactando em
// seguida. Falha silenciosa: se der errado, o backup continua válido (só
// maior). Nunca toca no banco vivo.
function podarTabelasDerivaveis(arquivoBackup) {
  let bak;
  try {
    bak = new DatabaseSync(arquivoBackup);
    for (const t of TABELAS_FORA_DO_BACKUP) bak.exec(`DROP TABLE IF EXISTS ${t}`);
    bak.exec('VACUUM');
  } catch (e) {
    console.warn(`[BACKUP BANCO] Não consegui podar tabelas deriváveis do backup: ${e.message}`);
  } finally {
    if (bak) { try { bak.close(); } catch (_) { /* ignora */ } }
  }
}

function nomeArquivoHoje() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `medicamentos_judicial_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.db`;
}

// Mantém só os últimos N backups DIÁRIOS (por CONTAGEM), apagando os mais
// antigos — janela ROLANTE: ao gerar um novo, o mais antigo sai. Economiza
// espaço de forma previsível (fica sempre com ~N arquivos). O nome
// AAAA-MM-DD ordena cronologicamente. Não toca nos mensais (padrão diferente).
function limparDiariosAntigos(pasta, manter, rotulo) {
  let arquivos;
  try {
    // Aceita .db (backups antigos) e .db.gz (novos, compactados) — a janela
    // rolante vai podando os antigos .db durante a transição.
    arquivos = fs.readdirSync(pasta)
      .filter((n) => /^medicamentos_judicial_\d{4}-\d{2}-\d{2}\.db(\.gz)?$/.test(n));
  } catch {
    return;
  }
  arquivos.sort(); // AAAA-MM-DD em ordem crescente (mais antigo primeiro)
  const excedente = arquivos.slice(0, Math.max(0, arquivos.length - manter));
  for (const nome of excedente) {
    try {
      fs.unlinkSync(path.join(pasta, nome));
      console.log(`[BACKUP BANCO] Removido backup diário antigo${rotulo ? ' (' + rotulo + ')' : ''}: ${nome}`);
    } catch (_) { /* ignora */ }
  }
}

// Dias úteis = segunda(1) a sexta(5). getDay(): 0=domingo, 6=sábado.
function ehDiaUtil(d = new Date()) { const g = d.getDay(); return g >= 1 && g <= 5; }

// Copia o backup do dia também para a pasta do Google Drive (se configurada).
// Falha silenciosa (só loga aviso): o backup local já é o que garante os
// dados, o Drive é uma segunda cópia de conveniência.
function copiarParaDrive(origem, nomeArquivo, manterDiarios) {
  const pastaDrive = process.env.BACKUP_PASTA_DRIVE;
  if (!pastaDrive) return;
  try {
    fs.mkdirSync(pastaDrive, { recursive: true });
    const destino = path.join(pastaDrive, nomeArquivo);
    fs.copyFileSync(origem, destino);
    console.log(`[BACKUP BANCO] Copiado também para o Google Drive: ${destino}`);
    limparDiariosAntigos(pastaDrive, manterDiarios, 'Google Drive');
  } catch (e) {
    console.warn(`[BACKUP BANCO] Não consegui copiar para o Google Drive (${pastaDrive}): ${e.message}`);
  }
}

// Nome do backup mensal do mês corrente (ex.: ..._mensal_2026-07.db.gz).
function nomeMensalAtual() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `medicamentos_judicial_mensal_${d.getFullYear()}-${p(d.getMonth() + 1)}.db.gz`;
}

// Mantém só os últimos N backups mensais numa pasta, apagando os mais
// antigos. Aqui a poda é por CONTAGEM (não por data de modificação): os
// mensais são antigos de propósito. O nome AAAA-MM ordena cronologicamente.
function limparMensaisAntigos(pasta, manter, rotulo) {
  let arquivos;
  try {
    arquivos = fs.readdirSync(pasta)
      .filter((n) => /^medicamentos_judicial_mensal_\d{4}-\d{2}\.db(\.gz)?$/.test(n));
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
async function rodarBackup(opcoesRegistro = {}) {
  const inicioMs = reg.marcarInicio('backup');
  try {
    fs.mkdirSync(PASTA_BACKUPS, { recursive: true });
    const nomeDb = nomeArquivoHoje();          // ...AAAA-MM-DD.db (temporário)
    const nomeGz = nomeDb + '.gz';             // ...AAAA-MM-DD.db.gz (final)
    const destinoDb = path.join(PASTA_BACKUPS, nomeDb);
    const destinoGz = path.join(PASTA_BACKUPS, nomeGz);
    // Reexecução no mesmo dia sobrescreve (remove .db e .gz anteriores de hoje).
    for (const f of [destinoDb, destinoGz]) if (fs.existsSync(f)) fs.unlinkSync(f);

    const t0 = Date.now();
    // VACUUM INTO não aceita parâmetro (?) para o caminho — o valor é
    // controlado pelo próprio sistema (nunca vem de entrada do usuário),
    // então só escapamos aspas simples por segurança.
    db.exec(`VACUUM INTO '${destinoDb.replace(/'/g, "''")}'`);
    // Remove do ARQUIVO DE BACKUP (não do banco vivo) tabelas grandes e 100%
    // deriváveis do Oracle — não precisam ir para o backup. Ex.: recibos do
    // Extrato (relatório Consumo x Entrega), recarregáveis via "Atualizar via
    // Oracle". Enxuga o .bak sem perda: é só rodar a carga de novo se preciso.
    podarTabelasDerivaveis(destinoDb);
    // Compacta em .gz (reduz ~80%) e apaga o .db — no Drive fica só o .gz.
    await comprimirGz(destinoDb, destinoGz);
    fs.unlinkSync(destinoDb);
    const segundos = Math.round((Date.now() - t0) / 1000);
    const tamanhoMB = (fs.statSync(destinoGz).size / (1024 * 1024)).toFixed(1);
    console.log(`[BACKUP BANCO] Backup salvo (compactado): ${nomeGz} (${tamanhoMB} MB, ${segundos}s).`);

    // Janela rolante: mantém só os últimos N backups diários (padrão 7).
    const manterDiarios = Math.max(1, parseInt(process.env.BACKUP_MANTER_DIARIOS, 10) || 7);
    limparDiariosAntigos(PASTA_BACKUPS, manterDiarios);
    copiarParaDrive(destinoGz, nomeGz, manterDiarios);

    // Backup mensal de longo prazo (1 por mês, mantém os últimos N meses).
    const mensalManter = Math.max(1, parseInt(process.env.BACKUP_MENSAL_MANTER, 10) || 3);
    garantirBackupMensal(destinoGz, mensalManter);

    reg.registrarExecucao('backup', {
      resultado: 'sucesso',
      mensagem: `Backup salvo compactado: ${nomeGz} (${tamanhoMB} MB, ${segundos}s). Mantendo os últimos ${manterDiarios} backups diários.`,
      arquivo: nomeGz,
      inicioMs,
      ...opcoesRegistro,
    });
  } catch (e) {
    console.error('[BACKUP BANCO] Falha ao gerar backup:', e.message);
    reg.registrarExecucao('backup', {
      resultado: 'erro',
      // Backup é a última linha de defesa dos dados: falha aqui é crítica.
      nivel: 'CRITICAL',
      mensagem: e.message,
      detalhe: e.stack,
      inicioMs,
      ...opcoesRegistro,
    });
    throw e;
  } finally {
    reg.marcarFim('backup');
  }
}

function iniciarBackupDiario() {
  if (process.env.AUTO_BACKUP === 'false') {
    console.log('[BACKUP BANCO] Desativado (AUTO_BACKUP=false).');
    return;
  }
  const hora = Math.min(23, Math.max(0, parseInt(process.env.BACKUP_HORA, 10) || 5));
  const minuto = Math.min(59, Math.max(0, parseInt(process.env.BACKUP_MINUTO, 10) || 0));
  console.log(`[BACKUP BANCO] Agendado para ${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')} em dias úteis (seg–sex).`);
  // O agendador dispara todo dia; aqui pulamos sábado/domingo (só dias úteis).
  agendarDiariamente('BACKUP BANCO', hora, minuto, () => {
    if (!ehDiaUtil()) {
      console.log('[BACKUP BANCO] Fim de semana — backup pulado (roda só em dias úteis).');
      return;
    }
    rodarBackup().catch((e) => console.error('[BACKUP BANCO] Falha no backup agendado:', e.message));
  });
}

module.exports = { iniciarBackupDiario, rodarBackup };

// Permite rodar direto pela linha de comando: node src/backupBanco.js
if (require.main === module) {
  require('dotenv').config();
  rodarBackup().catch((e) => {
    console.error('[BACKUP BANCO] Falha:', e.message);
    process.exitCode = 1;
  });
}
