// inspecionar.js — Passo de DIAGNOSTICO (nao exporta e nao importa nada).
//
// O GsnetCompras nao pede usuario/senha direto: a tela inicial tem o botao
// "Acesso GsNetCompras", que leva para a plataforma "Minha Area SP.GOV.BR"
// (login federado do Estado). So la vem usuario e senha.
//
// Este script:
//   1. Abre a tela inicial do GsnetCompras.
//   2. Clica sozinho em "Acesso GsNetCompras".
//   3. Salva a "foto por dentro" da tela de LOGIN do SP.GOV.BR
//      (dump-login.html + campos-login.json + login-spgov.png) — para o Claude
//      descobrir os campos de usuario/senha e o botao de entrar.
//   4. ESPERA VOCE: voce digita seu usuario e senha, entra, e navega pelo menu
//      ate a tela de FILTROS do "Relatorio Estrategico de Empenhos".
//   5. Quando a tela de filtros estiver aberta, volte na janela preta e tecle
//      ENTER: ele salva a foto dessa tela (links-menu.json, dump-relatorio.html,
//      campos-relatorio.json, relatorio.png) e fecha.
//
// O Claude NUNCA digita nem le sua senha — quem loga e voce.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const puppeteer = require('puppeteer-core');

const URL_INICIAL = 'https://compras.saude.sp.gov.br/GsnetCompras/Account/Index';
const URL_RELATORIO = 'https://compras.saude.sp.gov.br/GsnetCompras/Planejamento/RelatorioEstrategicoEmpenho/Index?cmode=false';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USUARIO = process.env.GSNET_USUARIO;
const SENHA = process.env.GSNET_SENHA;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Tenta preencher o 1o seletor que existir na pagina. Retorna o seletor usado
// ou null se nenhum campo foi encontrado (sem estourar erro).
async function tentarPreencher(page, seletores, valor) {
  for (const s of seletores) {
    const el = await page.$(s);
    if (el) {
      await el.click({ clickCount: 3 }).catch(() => {});
      await el.type(valor, { delay: 25 });
      return s;
    }
  }
  return null;
}

function esperarEnter(msg) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('\n>>> ' + msg + '\n', () => { rl.close(); resolve(); });
  });
}

async function mapearCampos(page) {
  return page.evaluate(() => {
    const sel = 'input,select,textarea,button,[role=combobox],[role=button],[role=listbox],[role=option],label,a';
    return [...document.querySelectorAll(sel)].map((e) => {
      const isPwd = (e.getAttribute('type') || '').toLowerCase() === 'password';
      return {
        tag: e.tagName.toLowerCase(),
        type: e.getAttribute('type'),
        id: e.id || null,
        name: e.getAttribute('name'),
        ph: e.getAttribute('placeholder'),
        aria: e.getAttribute('aria-label'),
        href: e.getAttribute('href'),
        cls: (e.getAttribute('class') || '').slice(0, 80) || null,
        txt: isPwd ? '(oculto)' : (e.innerText || e.value || '').trim().slice(0, 80) || null,
      };
    });
  });
}

async function salvarFoto(page, prefixo) {
  const dir = __dirname;
  fs.writeFileSync(path.join(dir, `dump-${prefixo}.html`), await page.content(), 'utf8');
  fs.writeFileSync(path.join(dir, `campos-${prefixo}.json`), JSON.stringify(await mapearCampos(page), null, 1), 'utf8');
  await page.screenshot({ path: path.join(dir, `${prefixo}.png`), fullPage: true });
  console.log(`  -> salvei dump-${prefixo}.html, campos-${prefixo}.json, ${prefixo}.png  (URL: ${page.url()})`);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized'],
  });
  const page = (await browser.pages())[0] || (await browser.newPage());

  try {
    console.log('1) Abrindo a tela inicial do GsnetCompras...');
    await page.goto(URL_INICIAL, { waitUntil: 'networkidle2', timeout: 60000 });
    await espera(1500);

    console.log('2) Clicando em "Acesso GsNetCompras"...');
    const clicou = await page.evaluate(() => {
      const alvos = [...document.querySelectorAll('a, button')];
      const b = alvos.find((e) => /gsnet\s*compras|acesso\s*gsnet/i.test((e.innerText || e.textContent || '')));
      if (b) { b.click(); return (b.innerText || b.textContent || '').trim(); }
      return null;
    });
    console.log('   cliquei em:', clicou || '(nao achei o link automaticamente — clique voce mesmo)');

    // Espera a navegacao para a plataforma SP.GOV.BR.
    await espera(5000);
    console.log('   URL agora:', page.url());

    console.log('3) Salvando a foto da tela de LOGIN do SP.GOV.BR...');
    await salvarFoto(page, 'login');

    // Tenta logar sozinho com o usuario/senha do .env (nomes de campo mais
    // comuns do SP.GOV.BR / gov.br). Se nao achar os campos, voce loga na mao.
    let logouSozinho = false;
    if (USUARIO && SENHA && !/coloque-/.test(USUARIO) && !/coloque-/.test(SENHA)) {
      console.log('   Tentando logar sozinho com o usuario/senha do .env...');
      const u = await tentarPreencher(page, [
        '#username', '#user', '#login', '#Login', '#usuario', '#cpf', '#Cpf',
        'input[name="username"]', 'input[name="login"]', 'input[name="usuario"]', 'input[name="cpf"]',
        'input[type="text"]', 'input[type="email"]', 'input[type="tel"]',
      ], USUARIO);
      const s = await tentarPreencher(page, [
        '#password', '#senha', '#Senha', 'input[name="password"]', 'input[name="senha"]', 'input[type="password"]',
      ], SENHA);
      if (u && s) {
        await page.evaluate(() => {
          // Botao certo desta tela: #login (input type=button, "Login").
          // NUNCA clicar em "Acesso Minha Area" / "Acesso GsNetCompras".
          const direto = document.querySelector('#login');
          if (direto) { direto.click(); return; }
          const b = [...document.querySelectorAll('button, input[type=submit], input[type=button]')]
            .find((e) => {
              const t = (e.innerText || e.value || '').trim();
              return /^(login|entrar|acessar|conecte-?se)$/i.test(t);
            });
          if (b) b.click();
        });
        await espera(6000);
        logouSozinho = !/sp\.gov|login|acesso/i.test(page.url());
        console.log('   Apos tentar logar, URL:', page.url(), logouSozinho ? '(parece que entrou)' : '(ainda na tela de login — logue na mao)');
      } else {
        console.log('   Nao reconheci os campos de login automaticamente — logue na mao (normal na 1a vez).');
      }
    }

    if (!logouSozinho) {
      console.log('\n>>> O login automatico nao confirmou. Se precisar, entre na mao na janela do Chrome.');
      await esperarEnter('Quando estiver LOGADO (dentro do GsnetCompras), tecle ENTER para eu abrir o relatorio.');
    }

    console.log('4) Abrindo direto a tela do Relatorio Estrategico de Empenhos...');
    await page.goto(URL_RELATORIO, { waitUntil: 'networkidle2', timeout: 60000 });
    await espera(4000); // tempo do formulario de filtros montar

    // Se caiu na tela de login, deixa o Rafael logar e tenta de novo.
    if (/account\/index|login|sp\.gov/i.test(page.url())) {
      console.log('   (parece que a sessao nao estava ativa — logue na janela do Chrome)');
      await esperarEnter('Depois de logar, tecle ENTER para eu abrir o relatorio.');
      await page.goto(URL_RELATORIO, { waitUntil: 'networkidle2', timeout: 60000 });
      await espera(4000);
    }

    console.log('5) Salvando a foto da tela do RELATORIO...');
    const links = await page.evaluate(() =>
      [...document.querySelectorAll('a')]
        .map((a) => ({ txt: (a.innerText || '').trim().slice(0, 80), href: a.getAttribute('href') }))
        .filter((l) => l.txt || l.href)
    );
    fs.writeFileSync(path.join(__dirname, 'links-menu.json'), JSON.stringify(links, null, 1), 'utf8');
    await salvarFoto(page, 'relatorio');

    console.log('\n===== PRONTO =====');
    console.log('Gerados: dump-login.html, campos-login.json, login.png,');
    console.log('         links-menu.json, dump-relatorio.html, campos-relatorio.json, relatorio.png');
    console.log('Pode fechar a janela do Chrome. (fecha sozinha em 15s)');
    await espera(15000);
  } catch (e) {
    console.error('\nERRO:', e.message);
    try { await page.screenshot({ path: path.join(__dirname, 'erro.png'), fullPage: true }); } catch (_) {}
  } finally {
    await browser.close();
  }
})();
