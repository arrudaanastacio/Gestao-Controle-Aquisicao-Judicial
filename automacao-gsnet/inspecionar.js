// inspecionar.js — Passo de DIAGNÓSTICO (não importa nada).
// Loga no GSNET usando o .env, abre a tela "Fatura em Lote" e salva uma "foto
// da tela por dentro" (dump-fatura.html + campos-fatura.json + fatura.png) para
// o Claude identificar os campos exatos dos menus, do Pesquisar e do Importar.
// Não digita nada além do login e NÃO clica em Importar.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const URL_LOGIN = 'https://suprimentosv3.saude.sp.gov.br/suprimentos-frontend-v3/#/login';
const URL_FATURA = 'https://suprimentosv3.saude.sp.gov.br/suprimentos-frontend-v3/#/faturaemlote';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USUARIO = process.env.GSNET_USUARIO;
const SENHA = process.env.GSNET_SENHA;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Extrai uma lista compacta dos elementos interativos da página (sem valores de
// senha) — mesma ideia do comando de Console, mas rodando dentro do robô.
async function mapearCampos(page) {
  return page.evaluate(() => {
    const sel = 'input,select,textarea,button,mat-select,[formcontrolname],[role=combobox],[role=button],[role=listbox],[role=option],label,a';
    return [...document.querySelectorAll(sel)].map((e) => {
      const isPwd = (e.getAttribute('type') || '').toLowerCase() === 'password';
      return {
        tag: e.tagName.toLowerCase(),
        type: e.getAttribute('type'),
        id: e.id || null,
        name: e.getAttribute('name'),
        fc: e.getAttribute('formcontrolname'),
        ph: e.getAttribute('placeholder'),
        aria: e.getAttribute('aria-label'),
        role: e.getAttribute('role'),
        cls: (e.getAttribute('class') || '').slice(0, 80) || null,
        txt: isPwd ? '(oculto)' : (e.innerText || e.value || '').trim().slice(0, 70) || null,
      };
    });
  });
}

async function preencher(page, seletores, valor) {
  for (const s of seletores) {
    const el = await page.$(s);
    if (el) {
      await el.click({ clickCount: 3 }).catch(() => {});
      await el.type(valor, { delay: 20 });
      return s;
    }
  }
  throw new Error('Não achei o campo para: ' + seletores.join(' | '));
}

(async () => {
  if (!USUARIO || !SENHA || SENHA.includes('coloque-sua-senha')) {
    console.error('\n>>> Preencha o arquivo .env (GSNET_USUARIO e GSNET_SENHA) antes de rodar.\n');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized'],
  });
  const page = (await browser.pages())[0] || (await browser.newPage());

  try {
    console.log('Abrindo a tela de login...');
    await page.goto(URL_LOGIN, { waitUntil: 'networkidle2', timeout: 60000 });
    await espera(1500);

    // Usuário: 1º campo de texto (não senha). Senha: #password.
    const usadoUser = await preencher(page, [
      '#username', 'input[formcontrolname="username"]', 'input[formcontrolname="login"]',
      'input[type="text"]', 'input[type="tel"]', 'input:not([type="password"]):not([type="hidden"])',
    ], USUARIO);
    const usadoPwd = await preencher(page, [
      '#password', 'input[formcontrolname="password"]', 'input[type="password"]',
    ], SENHA);
    console.log('Campos de login preenchidos (user via', usadoUser, '| senha via', usadoPwd, ').');

    // Botão "Conecte-se".
    const clicouLogin = await page.evaluate(() => {
      const alvos = [...document.querySelectorAll('button, input[type=submit], a')];
      const b = alvos.find((e) => /conecte-?se|entrar|login/i.test((e.innerText || e.value || '')));
      if (b) { b.click(); return (b.innerText || b.value || '').trim(); }
      return null;
    });
    console.log('Cliquei no botão de login:', clicouLogin);

    // Espera sair da tela de login.
    await page.waitForFunction(() => !location.hash.includes('/login'), { timeout: 30000 })
      .catch(() => console.log('(aviso) ainda parece na tela de login — verifique usuário/senha.'));
    await espera(2500);
    console.log('URL após login:', page.url());

    // Vai para Fatura em Lote.
    console.log('Abrindo Fatura em Lote...');
    await page.goto(URL_FATURA, { waitUntil: 'networkidle2', timeout: 60000 });
    await espera(3500); // dá tempo do Angular montar os menus

    // Salva os artefatos de diagnóstico.
    const dir = __dirname;
    const html = await page.content();
    fs.writeFileSync(path.join(dir, 'dump-fatura.html'), html, 'utf8');
    const campos = await mapearCampos(page);
    fs.writeFileSync(path.join(dir, 'campos-fatura.json'), JSON.stringify(campos, null, 1), 'utf8');
    await page.screenshot({ path: path.join(dir, 'fatura.png'), fullPage: true });

    console.log('\n===== PRONTO =====');
    console.log('Gerados: dump-fatura.html, campos-fatura.json, fatura.png');
    console.log('Pode fechar a janela do Chrome. (fecha sozinha em 20s)');
    await espera(20000);
  } catch (e) {
    console.error('\nERRO:', e.message);
    try { await page.screenshot({ path: path.join(__dirname, 'erro.png'), fullPage: true }); } catch (_) {}
  } finally {
    await browser.close();
  }
})();
