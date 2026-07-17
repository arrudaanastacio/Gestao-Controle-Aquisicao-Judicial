// importar.js — Robô do GSNET / Suplementos 3.0 (Fatura em Lote).
// Faz a parte repetitiva e ENTREGA a tela pronta para você:
//   1. Loga (usuário/senha do .env)
//   2. Abre "Fatura em Lote"
//   3. Seleciona ID Gestor (11) e ID Local (3004)
//   4. Clica "Pesquisar"
//   5. Para aqui: VOCÊ escolhe o arquivo e clica "Importar".
// Ao terminar, feche a janela do Chrome — o robô encerra sozinho.

require('dotenv').config();
const puppeteer = require('puppeteer-core');

const URL_LOGIN = 'https://suprimentosv3.saude.sp.gov.br/suprimentos-frontend-v3/#/login';
const URL_FATURA = 'https://suprimentosv3.saude.sp.gov.br/suprimentos-frontend-v3/#/faturaemlote';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USUARIO = process.env.GSNET_USUARIO;
const SENHA = process.env.GSNET_SENHA;
const ID_GESTOR = process.env.GSNET_ID_GESTOR || '11';
const ID_LOCAL = process.env.GSNET_ID_LOCAL || '3004';

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Seleciona numa <select> a opção cujo value bate com o código, ou cujo texto
// contém "(codigo)". Dispara o evento que o Angular precisa para reagir.
async function selecionarOpcao(page, seletor, codigo) {
  const val = await page.evaluate((sel, code) => {
    const s = document.querySelector(sel);
    if (!s) return { erro: 'select não encontrado' };
    const opt = [...s.options].find(
      (o) => o.value === code || o.value.endsWith(':' + code) || o.textContent.includes('(' + code + ')') || o.textContent.trim().includes(code)
    );
    if (!opt) return { erro: 'opção não encontrada', opcoes: [...s.options].map((o) => o.textContent.trim()) };
    return { value: opt.value };
  }, seletor, codigo);
  if (val.erro) throw new Error(`Menu ${seletor}: ${val.erro}${val.opcoes ? ' (opções: ' + val.opcoes.join(' / ') + ')' : ''}`);
  await page.select(seletor, val.value);
  await page.evaluate((sel) => {
    const s = document.querySelector(sel);
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }, seletor);
}

(async () => {
  if (!USUARIO || !SENHA || SENHA.includes('coloque-sua-senha')) {
    console.error('\n>>> Preencha o arquivo .env (GSNET_USUARIO e GSNET_SENHA). Use o "1 - colar senha.bat".\n');
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
    console.log('1/4  Fazendo login...');
    await page.goto(URL_LOGIN, { waitUntil: 'networkidle2', timeout: 60000 });
    await espera(1500);
    await preencher(page, [
      '#username', 'input[formcontrolname="login"]', 'input[formcontrolname="username"]',
      'input[type="text"]', 'input[type="tel"]', 'input:not([type="password"]):not([type="hidden"])',
    ], USUARIO);
    await preencher(page, ['#password', 'input[formcontrolname="password"]', 'input[type="password"]'], SENHA);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button, input[type=submit], a')]
        .find((e) => /conecte-?se|entrar|login/i.test(e.innerText || e.value || ''));
      if (b) b.click();
    });
    await page.waitForFunction(() => !location.hash.includes('/login'), { timeout: 30000 })
      .catch(() => { throw new Error('O login não passou — confira usuário e senha no .env.'); });
    await espera(2000);

    console.log('2/4  Abrindo Fatura em Lote...');
    await page.goto(URL_FATURA, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('#idGestor', { timeout: 30000 });
    await espera(1200);

    console.log(`3/4  Selecionando ID Gestor (${ID_GESTOR}) e ID Local (${ID_LOCAL})...`);
    await selecionarOpcao(page, '#idGestor', ID_GESTOR);
    // ID Local carrega (async) e sai do estado "disabled" depois do gestor.
    await page.waitForFunction((code) => {
      const s = document.querySelector('#idLocal');
      if (!s || s.disabled) return false;
      return [...s.options].some((o) => o.value === code || o.textContent.includes('(' + code + ')') || o.textContent.includes(code));
    }, { timeout: 20000 }, ID_LOCAL).catch(() => {
      throw new Error('O menu "ID Local" não carregou a opção ' + ID_LOCAL + ' a tempo.');
    });
    await selecionarOpcao(page, '#idLocal', ID_LOCAL);
    await espera(500);

    console.log('4/4  Clicando em Pesquisar...');
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((e) => /pesquisar/i.test(e.innerText || ''));
      if (b) b.click();
    });
    await espera(1500);

    console.log('\n====================================================');
    console.log('  PRONTO! A tela está preparada.');
    console.log('  Agora, NA JANELA DO CHROME:');
    console.log('   1) Clique em "Escolher arquivo" e selecione a grade;');
    console.log('   2) Clique em "Importar".');
    console.log('');
    console.log('  Quando terminar, FECHE a janela do Chrome que o robô');
    console.log('  encerra sozinho.');
    console.log('====================================================\n');

    // Mantém aberto até você fechar a janela do Chrome.
    await new Promise((resolve) => browser.on('disconnected', resolve));
  } catch (e) {
    console.error('\nERRO:', e.message);
    try { await page.screenshot({ path: require('path').join(__dirname, 'erro.png'), fullPage: true }); } catch (_) {}
    console.error('(salvei um "erro.png" na pasta, se ajudar.)');
    await espera(8000);
    await browser.close();
  }
})();
