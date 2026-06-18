const campoEmail = document.getElementById('email');
const campoSenha = document.getElementById('senha');
const botao = document.getElementById('botaoEntrar');
const erro = document.getElementById('erroLogin');

// Mantém cópia da senha atualizada por qualquer meio (digitação, autofill, extensão)
let senhaCapturada = '';
['input', 'change', 'keyup', 'keydown'].forEach((ev) => {
  campoSenha.addEventListener(ev, () => {
    if (campoSenha.value) senhaCapturada = campoSenha.value;
  });
});
// Polling como fallback para autofill que não dispara eventos
setInterval(() => {
  if (campoSenha.value) senhaCapturada = campoSenha.value;
}, 200);

async function fazerLogin() {
  erro.hidden = true;

  const email = campoEmail.value.trim();
  const senha = campoSenha.value || senhaCapturada;

  console.log('[LOGIN] email:', JSON.stringify(email), '| senha preenchida?', !!senha);

  if (!email || !senha) {
    erro.textContent = 'Preencha o e-mail e a senha antes de continuar.';
    erro.hidden = false;
    return;
  }

  botao.disabled = true;
  botao.textContent = 'Entrando…';

  try {
    const resp = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, senha }),
    });
    console.log('[LOGIN] status:', resp.status);
    const dados = await resp.json();
    console.log('[LOGIN] resposta:', dados);

    if (!resp.ok) {
      erro.textContent = dados.erro || 'Não foi possível entrar.';
      erro.hidden = false;
      return;
    }

    window.location.href = '/index.html';
  } catch (e) {
    console.error('[LOGIN] erro de rede:', e);
    erro.textContent = 'Não foi possível conectar ao servidor.';
    erro.hidden = false;
  } finally {
    botao.disabled = false;
    botao.textContent = 'Entrar';
  }
}

botao.addEventListener('click', fazerLogin);
campoEmail.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') campoSenha.focus(); });
campoSenha.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') fazerLogin(); });
