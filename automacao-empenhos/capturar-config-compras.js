// capturar-config-compras.js — Abre o Relatorio Estrategico de Compras JA LOGADO
// e ESPERA o Rafael configurar os filtros na mao e clicar EXPORTAR. Captura:
//   - os parametros exatos que o site enviou (POST fnRelatorioEstrategico) ->
//     config-compras.json  (essa e a "verdade" do que o robo deve mandar)
//   - o estado do formulario no momento do clique -> config-compras.json
//   - o .xlsx, se o export der certo -> downloads-compras/
// Assim o robo definitivo replica exatamente a config que funciona pro Rafael.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const URL_INICIAL = 'https://compras.saude.sp.gov.br/GsnetCompras/Account/Index';
const URL_RELATORIO = 'https://compras.saude.sp.gov.br/GsnetCompras/Planejamento/RelatorioEstrategico/Index?cmode=false';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USUARIO = process.env.GSNET_USUARIO;
const SENHA = process.env.GSNET_SENHA;
const PASTA_DOWNLOAD = process.env.PASTA_DOWNLOAD_COMPRAS || path.join(__dirname, 'downloads-compras');

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function tentarPreencher(page, seletores, valor) {
  for (const s of seletores) {
    const el = await page.$(s);
    if (el) { await el.click({ clickCount: 3 }).catch(() => {}); await el.type(valor, { delay: 25 }); return s; }
  }
  return null;
}

async function esperarXlsxNovo(pasta, desdeMs, timeoutMs) {
  const ateh = Date.now() + timeoutMs;
  while (Date.now() < ateh) {
    if (fs.existsSync(pasta)) {
      const temParcial = fs.readdirSync(pasta).some((f) => /\.crdownload$/i.test(f));
      const cand = fs.readdirSync(pasta).filter((f) => /\.xlsx$/i.test(f)).map((f) => path.join(pasta, f))
        .filter((p) => fs.statSync(p).mtimeMs >= desdeMs).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (cand.length && !temParcial) {
        const p = cand[0]; const t1 = fs.statSync(p).size; await espera(1500);
        if (fs.existsSync(p) && fs.statSync(p).size === t1 && t1 > 1000) return p;
      }
    }
    await espera(1500);
  }
  return null;
}

const LOG = path.join(__dirname, 'log-compras.txt');
function log(m) { const s = new Date().toLocaleString('pt-BR') + '  ' + m; console.log(s); try { fs.appendFileSync(LOG, s + '\n'); } catch (_) {} }

(async () => {
  try { fs.writeFileSync(LOG, ''); } catch (_) {}
  log('=== CAPTURAR config do Relatorio de Compras (manual) ===');
  if (!USUARIO || !SENHA) { console.error('\n>>> Preencha o .env (GSNET_USUARIO e GSNET_SENHA).\n'); process.exit(1); }
  fs.mkdirSync(PASTA_DOWNLOAD, { recursive: true });

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: false, defaultViewport: null, args: ['--start-maximized'] });
  const page = (await browser.pages())[0] || (await browser.newPage());
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: PASTA_DOWNLOAD }).catch(() => {});

  // Captura o POST que o site faz ao clicar Exportar (os parametros de verdade).
  let capturado = null;
  page.on('request', (req) => {
    try {
      if (req.method() === 'POST' && /RelatorioEstrategico\/fn[A-Za-z]*Estrategico\b/i.test(req.url()) && !/GerarExcel/i.test(req.url())) {
        capturado = { url: req.url(), postData: req.postData() };
        log('  [capturei o POST do Exportar] ' + req.url());
      }
    } catch (_) {}
  });

  try {
    log('1/3  Login...');
    await page.goto(URL_INICIAL, { waitUntil: 'networkidle2', timeout: 60000 });
    await espera(1200);
    await page.evaluate(() => { const b = [...document.querySelectorAll('a, button')].find((e) => /gsnet\s*compras|acesso\s*gsnet/i.test(e.innerText || e.textContent || '')); if (b) b.click(); });
    await espera(2500);
    await tentarPreencher(page, ['#username', 'input[name="username"]'], USUARIO);
    await tentarPreencher(page, ['#password', 'input[name="password"]'], SENHA);
    await page.evaluate(() => { const d = document.querySelector('#login'); if (d) { d.click(); return; } const b = [...document.querySelectorAll('button, input[type=submit], input[type=button]')].find((e) => /^(login|entrar|acessar)$/i.test((e.innerText || e.value || '').trim())); if (b) b.click(); });
    await espera(6000);
    if (/account\/(index|login)/i.test(page.url())) throw new Error('O login nao passou — confira usuario e senha no .env.');

    log('2/3  Abrindo o Relatorio Estrategico de Compras...');
    const homeUrl = page.url();
    await page.setExtraHTTPHeaders({ Referer: homeUrl }).catch(() => {});
    await page.goto(URL_RELATORIO, { waitUntil: 'networkidle2', timeout: 60000, referer: homeUrl }).catch(() => {});
    await page.waitForSelector('#P_ID_UNID_INSTIT', { timeout: 20000 }).catch(() => {});
    await page.setExtraHTTPHeaders({}).catch(() => {});

    log('');
    log('  >>> AGORA E COM VOCE, RAFAEL <<<');
    log('  1) Configure os filtros na tela EXATAMENTE como voce quer.');
    log('  2) Clique em EXPORTAR (o botao verde), nessa mesma janela.');
    log('  3) NAO feche o navegador — eu capturo tudo sozinho.');
    log('  (Estou esperando ate 8 minutos...)');

    const t0 = Date.now() - 2000;
    // Espera o POST do Exportar (ate 8 min).
    const ate = Date.now() + 480000;
    while (!capturado && Date.now() < ate) await espera(1000);
    if (!capturado) throw new Error('Nao vi o clique em Exportar em 8 minutos. Rode de novo e clique em Exportar.');

    // Captura o estado do formulario no momento do clique.
    const estado = await page.evaluate(() => {
      const form = document.querySelector('#formulario') || document;
      const val = (id) => { const e = document.querySelector(id); return e ? e.value : null; };
      const selTxt = (id) => { const e = document.querySelector(id); return e ? (e.options[e.selectedIndex] || {}).textContent : null; };
      const radio = (name) => { const e = document.querySelector(`input[name="${name}"]:checked`); return e ? e.value : null; };
      const check = (id) => { const e = document.querySelector(id); return e ? e.checked : null; };
      return {
        unidade: selTxt('#P_ID_UNID_INSTIT'), programa: selTxt('#P_ID_PROGRAMA_SAUDE'),
        periodo_ini: val('#P_DT_REF_INI'), periodo_fim: val('#P_DT_REF_FIM'),
        ChkTudo: check('#ChkTudo'), OmitirNR: check('#P_NR_OMITIR'), OmitirSubItens: check('#P_SUBITEM_PROC_OMITIR'),
        radios: {
          ATA_P_TP_RELATORIO: radio('P_TP_RELATORIO'), Requisicao_P_REQ: radio('P_REQ'), Processo_P_PROC: radio('P_PROC'),
          PesqPreco_P_PPRECO: radio('P_PPRECO'), OC_P_OC: radio('P_OC'), NR_P_NR: radio('P_NR'),
          Contrato_P_CT: radio('P_CT'), Empenhos_P_NE: radio('P_NE'), NotasFiscais_P_NF: radio('P_NF'),
        },
      };
    });
    fs.writeFileSync(path.join(__dirname, 'config-compras.json'), JSON.stringify({ estado, postCapturado: capturado }, null, 2), 'utf8');
    log('3/3  Capturei a config! Salvei config-compras.json');
    log('  Estado: ' + JSON.stringify(estado));

    // Tenta pegar o arquivo, se o export der certo.
    log('  Esperando o .xlsx (ate 5 min)...');
    const arquivo = await esperarXlsxNovo(PASTA_DOWNLOAD, t0, 300000);
    if (arquivo) log('  PRONTO! Arquivo baixado: ' + arquivo + ' (' + fs.statSync(arquivo).size + ' bytes)');
    else log('  [aviso] nao caiu .xlsx (pode ter dado "sem dados" ou erro na tela). A config foi capturada mesmo assim.');

    try { await page.screenshot({ path: path.join(__dirname, 'compras-config-capturada.png'), fullPage: true }); } catch (_) {}
    await espera(1500);
    await browser.close();
    process.exit(0);
  } catch (e) {
    log('ERRO: ' + e.message);
    try { await page.screenshot({ path: path.join(__dirname, 'compras-erro.png'), fullPage: true }); } catch (_) {}
    await espera(3000);
    await browser.close();
    process.exit(1);
  }
})();
