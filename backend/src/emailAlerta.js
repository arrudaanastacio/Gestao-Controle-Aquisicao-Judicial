// =====================================================================
// emailAlerta.js
// Envia um e-mail de aviso quando uma sincronização automática via
// Oracle (SCODES) falha. Configurado por variáveis de ambiente:
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, ALERTA_EMAIL_PARA
// Se qualquer uma faltar, o envio é pulado silenciosamente (só loga).
// =====================================================================
let transportador = null;

function obterTransportador() {
  if (transportador) return transportador;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) return null;
  const nodemailer = require('nodemailer');
  transportador = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT, 10) || 587,
    secure: (parseInt(SMTP_PORT, 10) || 587) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  });
  return transportador;
}

async function enviarAlertaFalhaSincronizacao(nomeTarefa, mensagemErro) {
  const destinatarios = process.env.ALERTA_EMAIL_PARA;
  if (!destinatarios) {
    console.log(`[ALERTA E-MAIL] Pulado (ALERTA_EMAIL_PARA não configurado). Falha em ${nomeTarefa}: ${mensagemErro}`);
    return;
  }
  const t = obterTransportador();
  if (!t) {
    console.log('[ALERTA E-MAIL] Pulado (SMTP não configurado no .env).');
    return;
  }
  try {
    await t.sendMail({
      from: process.env.SMTP_USER,
      to: destinatarios,
      subject: `⚠️ Falha na sincronização automática — ${nomeTarefa}`,
      text: `A sincronização automática via Oracle (${nomeTarefa}) falhou em ${new Date().toLocaleString('pt-BR')}.\n\nErro: ${mensagemErro}\n\nO sistema vai tentar novamente no próximo horário agendado. Se o erro persistir, verifique a conexão com o Oracle ou a senha em uso.`,
    });
    console.log(`[ALERTA E-MAIL] Enviado para ${destinatarios} (falha em ${nomeTarefa}).`);
  } catch (e) {
    console.error('[ALERTA E-MAIL] Falha ao enviar e-mail de alerta:', e.message);
  }
}

// Verdadeiro só quando há SMTP configurado (para o front esconder/avisar).
function emailConfigurado() {
  return !!obterTransportador();
}

// Envia o convite de acesso: link único para o colega criar a própria senha.
// Lança erro se o SMTP não estiver configurado (o cadastro precisa saber que
// o e-mail não saiu, para não deixar o usuário preso sem senha nem aviso).
async function enviarConviteAcesso({ nome, email, link, validadeHoras }) {
  const t = obterTransportador();
  if (!t) throw new Error('SMTP não configurado no .env — não é possível enviar o convite.');
  await t.sendMail({
    from: process.env.SMTP_USER,
    to: email,
    subject: 'Acesso ao sistema Compras Judiciais — crie sua senha',
    text:
      `Olá, ${nome}!\n\n` +
      `Foi criado um acesso para você no sistema Compras Judiciais (Tenente Pena).\n` +
      `Para criar sua senha e entrar, acesse o link abaixo:\n\n` +
      `${link}\n\n` +
      `Este link é pessoal e expira em ${validadeHoras} horas. Depois de criar a senha, ele deixa de funcionar.\n` +
      `Se você não esperava este e-mail, pode ignorá-lo.\n`,
  });
}

module.exports = { enviarAlertaFalhaSincronizacao, obterTransportador, emailConfigurado, enviarConviteAcesso };
