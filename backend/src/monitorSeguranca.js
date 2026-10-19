// =====================================================================
// monitorSeguranca.js — Monitor de segurança (Onda E).
//
// Verifica PERIODICAMENTE sinais de segurança e registra o resultado na tela
// "Status dos Serviços" (via registroServicos). Nos casos CRÍTICOS, dispara um
// e-mail de alerta. É PROPORCIONAL e só OBSERVA: nunca bloqueia acesso nem
// derruba o sistema (evita negação de serviço por falso positivo).
//
// O que observa (tudo leitura):
//   • login_falho em volume anormal na última hora (sinal de força-bruta)
//   • acesso_negado (403) em excesso na última hora
//   • saúde do backup: existe e é recente; se há BACKUP_CHAVE, está cifrado
//
// Config (.env, com padrões sensatos — nada obrigatório):
//   MONITOR_SEGURANCA=false         -> desliga o monitor
//   SEG_MONITOR_INTERVALO_MIN=30    -> intervalo entre verificações (min)
//   SEG_LIMIAR_LOGIN_FALHO=10       -> logins falhos/hora que viram "atenção"
//                                      (3x o limiar vira "crítico" + e-mail)
//   SEG_LIMIAR_ACESSO_NEGADO=20     -> acessos negados/hora que viram "atenção"
// =====================================================================
const path = require('path');
const fs = require('fs');
const db = require('./db');
const reg = require('./registroServicos');
const { enviarAlertaSeguranca } = require('./emailAlerta');
const { chaveBackup } = require('./backupCripto');

const PASTA_BACKUPS = path.join(__dirname, '..', 'data', 'backups');

function intervaloMin() { return Math.max(5, parseInt(process.env.SEG_MONITOR_INTERVALO_MIN, 10) || 30); }
function limiar(chave, padrao) { const n = parseInt(process.env[chave], 10); return Number.isFinite(n) ? n : padrao; }

// Conta eventos de um tipo na auditoria nos últimos N minutos (criado_em é UTC,
// igual ao datetime('now')).
function contarEvento(acao, minutos) {
  try {
    return db.prepare("SELECT COUNT(*) c FROM auditoria WHERE acao = ? AND criado_em >= datetime('now', ?)")
      .get(acao, `-${minutos} minutes`).c;
  } catch (_) { return 0; }
}

// Checa a saúde do backup diário. Retorna {nivel, msg} se houver problema; null se OK.
function verificarBackup() {
  let arquivos = [];
  try {
    arquivos = fs.readdirSync(PASTA_BACKUPS)
      .filter((n) => /^medicamentos_judicial_\d{4}-\d{2}-\d{2}\.db\.gz(\.enc)?$/.test(n)).sort();
  } catch (_) { /* pasta pode não existir ainda */ }
  if (!arquivos.length) return { nivel: 'WARNING', msg: 'nenhum backup diário encontrado' };
  const ultimo = arquivos[arquivos.length - 1];
  let idadeH = Infinity;
  try { idadeH = (Date.now() - fs.statSync(path.join(PASTA_BACKUPS, ultimo)).mtimeMs) / 3600000; } catch (_) {}
  // Tolerância de ~3,5 dias (backup roda só em dias úteis; fim de semana não gera).
  if (idadeH > 84) return { nivel: 'WARNING', msg: `backup mais recente tem ${Math.round(idadeH)}h (${ultimo}) — pode não estar rodando` };
  if (chaveBackup() && !/\.enc$/.test(ultimo)) return { nivel: 'WARNING', msg: `BACKUP_CHAVE definida, mas o backup mais recente NÃO está cifrado (${ultimo})` };
  return null;
}

const ORDEM = { INFO: 0, WARNING: 1, ERROR: 2, CRITICAL: 3 };

async function rodarVerificacao() {
  const inicioMs = reg.marcarInicio('monitorSeguranca');
  try {
    const janela = 60; // minutos
    const limLogin = limiar('SEG_LIMIAR_LOGIN_FALHO', 10);
    const limNegado = limiar('SEG_LIMIAR_ACESSO_NEGADO', 20);
    const falhas = contarEvento('login_falho', janela);
    const negados = contarEvento('acesso_negado', janela);
    const bkp = verificarBackup();

    const achados = [];
    let nivel = 'INFO';
    const subir = (n) => { if (ORDEM[n] > ORDEM[nivel]) nivel = n; };

    if (falhas >= limLogin * 3) { achados.push(`${falhas} logins falhos na última hora (limiar ${limLogin})`); subir('CRITICAL'); }
    else if (falhas >= limLogin) { achados.push(`${falhas} logins falhos na última hora (limiar ${limLogin})`); subir('WARNING'); }

    if (negados >= limNegado) { achados.push(`${negados} acessos negados na última hora (limiar ${limNegado})`); subir('WARNING'); }

    if (bkp) { achados.push(`backup: ${bkp.msg}`); subir(bkp.nivel); }

    const mensagem = achados.length
      ? achados.join(' | ')
      : `OK — ${falhas} login(s) falho(s), ${negados} acesso(s) negado(s) na última hora; backup saudável.`;

    reg.registrarExecucao('monitorSeguranca', {
      resultado: ORDEM[nivel] >= ORDEM.ERROR ? 'erro' : 'sucesso',
      nivel, mensagem, arquivo: 'auditoria/backup', inicioMs,
    });

    if (nivel === 'CRITICAL') {
      enviarAlertaSeguranca('Atividade suspeita detectada', mensagem).catch(() => {});
    }
  } catch (e) {
    reg.registrarExecucao('monitorSeguranca', { resultado: 'erro', nivel: 'ERROR', mensagem: e.message, detalhe: e.stack, inicioMs });
  } finally {
    reg.marcarFim('monitorSeguranca');
  }
}

function iniciarMonitorSeguranca() {
  if (process.env.MONITOR_SEGURANCA === 'false') {
    console.log('[MONITOR SEGURANÇA] Desativado (MONITOR_SEGURANCA=false).');
    return;
  }
  console.log(`[MONITOR SEGURANÇA] Ativo — verifica a cada ${intervaloMin()} min.`);
  // Primeira verificação após 2 min (deixa o sistema terminar de subir).
  setTimeout(() => { rodarVerificacao().catch(() => {}); }, 2 * 60 * 1000);
  const timer = setInterval(() => { rodarVerificacao().catch(() => {}); }, intervaloMin() * 60 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = { iniciarMonitorSeguranca, rodarVerificacao };
