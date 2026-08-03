// emailCartaTroca.js — Notificações do fluxo de aprovação das Cartas de Troca.
//
//  - Ao registrar/reenviar: avisa os TÉCNICOS (usuários com permissão "editar"
//    no módulo cartasTroca) que há uma carta "Aguardando Avaliação".
//  - Ao o técnico responder: avisa o ADMINISTRATIVO que registrou (e-mail do
//    criador) com o resultado (Aprovada / Reprovada).
//
// Reaproveita o transporte SMTP de emailAlerta.js. Se o SMTP não estiver
// configurado no .env, o envio é pulado silenciosamente (só loga) — igual ao
// resto do sistema. Tudo é "fire-and-forget": nunca derruba a resposta HTTP.

const db = require('./db');
const { obterTransportador } = require('./emailAlerta');

// E-mails dos técnicos = usuários com permissão "editar" habilitada no módulo
// cartasTroca. (Admins editam por bypass e não têm linha em permissoes; se
// quiser incluí-los, marque a permissão para eles também.)
function emailsDosTecnicos() {
  try {
    return db.prepare(`
      SELECT DISTINCT u.email
      FROM permissoes p JOIN usuarios u ON u.id = p.usuario_id
      WHERE p.modulo = 'cartasTroca' AND p.habilitado = 1 AND p.editar = 1
        AND u.email IS NOT NULL AND u.email <> ''
    `).all().map((r) => r.email);
  } catch (e) {
    return [];
  }
}

async function enviar(para, assunto, texto) {
  const lista = (Array.isArray(para) ? para : [para]).filter(Boolean);
  if (!lista.length) {
    console.log(`[CARTA TROCA E-MAIL] Pulado (sem destinatário). Assunto: ${assunto}`);
    return;
  }
  const t = obterTransportador();
  if (!t) {
    console.log(`[CARTA TROCA E-MAIL] Pulado (SMTP não configurado). Assunto: ${assunto}`);
    return;
  }
  try {
    await t.sendMail({ from: process.env.SMTP_USER, to: lista.join(', '), subject: assunto, text: texto });
    console.log(`[CARTA TROCA E-MAIL] Enviado para ${lista.join(', ')} — ${assunto}`);
  } catch (e) {
    console.error('[CARTA TROCA E-MAIL] Falha ao enviar:', e.message);
  }
}

function resumoCarta(c) {
  return [
    `Controle: ${c.codigo_controle || '—'}`,
    `Fornecedor: ${c.empresa || '—'}`,
    `Nota de empenho: ${c.nota_empenho || '—'}`,
    `Medicamento: ${c.medicamento || '—'}`,
    `SCODES: ${c.codigo_item || '—'}`,
    `Quantidade: ${c.quantidade != null ? c.quantidade : '—'} (${c.tipo_quantidade || '—'})`,
  ].join('\n');
}

// Aviso aos técnicos: há carta aguardando avaliação.
function notificarAguardandoAvaliacao(carta) {
  const assunto = `[Carta de Troca] ${carta.codigo_controle} — Aguardando Avaliação`;
  const texto = `Uma carta de troca foi registrada e aguarda avaliação técnica.\n\n${resumoCarta(carta)}\n\nAcesse o sistema (módulo Cartas de Troca › aba "Aguardando avaliação") para avaliar.`;
  return enviar(emailsDosTecnicos(), assunto, texto);
}

// Aviso ao administrativo que registrou: resultado da avaliação.
function notificarResultado(carta) {
  const aprovada = carta.situacao_analise === 'Aprovada';
  const assunto = `[Carta de Troca] ${carta.codigo_controle} — Avaliação ${aprovada ? 'APROVADA' : 'REPROVADA'}`;
  let texto = `A avaliação técnica da carta de troca foi concluída.\n\nResultado: ${carta.situacao_analise}\n\n${resumoCarta(carta)}`;
  if (!aprovada && carta.motivo_reprovacao) texto += `\n\nMotivo da reprovação: ${carta.motivo_reprovacao}\n\nCorrija as informações e reenvie para nova avaliação.`;
  if (aprovada) texto += `\n\nA carta está registrada no sistema; siga com o trâmite.`;
  return enviar(carta.criado_por_email, assunto, texto);
}

module.exports = { notificarAguardandoAvaliacao, notificarResultado, emailsDosTecnicos };
