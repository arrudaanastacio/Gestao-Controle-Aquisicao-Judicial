// baixar-empenhos.js — Robo que baixa o "Relatorio Estrategico de Empenhos" do
// GsnetCompras, sozinho:
//   1. Loga (usuario/senha do .env) na tela GCS Compras.
//   2. Abre direto a tela do Relatorio Estrategico de Empenhos.
//   3. Aplica os filtros: Un. Institucional = Gabinete do Coordenador - CAF,
//      Periodo Inicio = GSNET_PERIODO_INICIO (padrao 01/2023), Periodo Fim = mes
//      atual, Atraso = Todos, Tipo Planilha = Completo.
//   4. Clica Exportar e espera o .xlsx cair na PASTA_DOWNLOAD.
// Ao final imprime o caminho do arquivo. Quem grava no banco e o importar-planilha.js.

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

const URL_INICIAL = 'https://compras.saude.sp.gov.br/GsnetCompras/Account/Index';
const URL_RELATORIO = 'https://compras.saude.sp.gov.br/GsnetCompras/Planejamento/RelatorioEstrategicoEmpenho/Index?cmode=false';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USUARIO = process.env.GSNET_USUARIO;
const SENHA = process.env.GSNET_SENHA;
const UNIDADE = process.env.GSNET_UNIDADE || 'Gabinete do Coordenador - CAF';
const PERIODO_INICIO = process.env.GSNET_PERIODO_INICIO || '01/2023';
const PASTA_DOWNLOAD = process.env.PASTA_DOWNLOAD || path.join(__dirname, 'downloads');
const DOWNLOADS_WIN = process.env.DOWNLOADS_WIN || path.join(os.homedir(), 'Downloads');
const HEADLESS = /^(1|true|sim)$/i.test(process.env.HEADLESS || '');

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function mesAtualMMYYYY() {
  const d = new Date();
  return String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}

function normalizar(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Acha um elemento VISIVEL cujo texto casa com o regex e devolve o handle
// (para clique real). Se nao houver visivel, devolve o 1o que casar.
async function handleVisivelPorTexto(page, seletor, regex) {
  const handles = await page.$$(seletor);
  let primeiro = null;
  for (const h of handles) {
    const info = await page.evaluate((el) => ({
      t: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      vis: !!(el.offsetParent !== null || el.getClientRects().length),
    }), h).catch(() => ({ t: '', vis: false }));
    if (regex.test(info.t)) {
      if (info.vis) return h;
      if (!primeiro) primeiro = h;
    }
  }
  return primeiro;
}

// Preenche o 1o seletor que existir. Retorna o seletor ou null.
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

// Define o valor de um input via JS (sem abrir datepicker) e dispara os eventos.
async function definirValor(page, seletor, valor) {
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, seletor, valor);
}

// Seleciona numa <select> a opcao cujo texto contem o alvo (normalizado).
async function selecionarPorTexto(page, seletor, alvo) {
  const res = await page.evaluate((sel, alvoNorm) => {
    const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const s = document.querySelector(sel);
    if (!s) return { erro: 'select nao encontrado' };
    const opt = [...s.options].find((o) => norm(o.textContent).includes(alvoNorm));
    if (!opt) return { erro: 'opcao nao encontrada', opcoes: [...s.options].map((o) => o.textContent.trim()).slice(0, 30) };
    s.value = opt.value;
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, texto: opt.textContent.trim(), value: opt.value };
  }, seletor, normalizar(alvo));
  if (res.erro) throw new Error(`Un. Institucional: ${res.erro}${res.opcoes ? ' (opcoes: ' + res.opcoes.join(' / ') + ')' : ''}`);
  return res;
}

// Marca um radio por name+value.
async function marcarRadio(page, name, value) {
  const ok = await page.evaluate((n, v) => {
    const el = document.querySelector(`input[name="${n}"][value="${v}"]`);
    if (!el) return false;
    el.checked = true;
    el.click();
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, name, value);
  if (!ok) throw new Error(`Nao achei o radio ${name}=${value}`);
}

function xlsxNaPasta(pasta) {
  if (!fs.existsSync(pasta)) return new Set();
  return new Set(fs.readdirSync(pasta).filter((f) => /\.xlsx$/i.test(f)));
}

// Espera aparecer um .xlsx NOVO em QUALQUER uma das pastas vigiadas.
// `antesPorPasta` é um Map pasta->Set(nomes que ja existiam).
async function esperarDownload(pastas, antesPorPasta, timeoutMs) {
  const ateh = Date.now() + timeoutMs;
  while (Date.now() < ateh) {
    for (const pasta of pastas) {
      if (!fs.existsSync(pasta)) continue;
      const temParcial = fs.readdirSync(pasta).some((f) => /\.crdownload$/i.test(f));
      const antes = antesPorPasta.get(pasta) || new Set();
      const novos = [...xlsxNaPasta(pasta)].filter((f) => !antes.has(f));
      if (novos.length && !temParcial) {
        const p = path.join(pasta, novos.sort((a, b) => fs.statSync(path.join(pasta, b)).mtimeMs - fs.statSync(path.join(pasta, a)).mtimeMs)[0]);
        const t1 = fs.statSync(p).size;
        await espera(1500);
        if (fs.existsSync(p) && fs.statSync(p).size === t1) return p;
      }
    }
    await espera(1500);
  }
  return null;
}

const LOG = path.join(__dirname, 'log.txt');
function log(m) {
  const s = new Date().toLocaleString('pt-BR') + '  ' + m;
  console.log(s);
  try { fs.appendFileSync(LOG, s + '\n'); } catch (_) {}
}

(async () => {
  try { fs.writeFileSync(LOG, ''); } catch (_) {}
  log('=== Inicio do robo de empenhos ===');
  if (!USUARIO || !SENHA || /coloque-/.test(USUARIO) || /coloque-/.test(SENHA)) {
    console.error('\n>>> Preencha o .env (GSNET_USUARIO e GSNET_SENHA). Use o "1 - colar login e senha.bat".\n');
    process.exit(1);
  }
  fs.mkdirSync(PASTA_DOWNLOAD, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADLESS ? 'new' : false,
    defaultViewport: null,
    args: ['--start-maximized'],
  });
  const page = (await browser.pages())[0] || (await browser.newPage());

  // Direciona os downloads para a nossa pasta.
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: PASTA_DOWNLOAD }).catch(() => {});

  page.on('framenavigated', (f) => { if (f === page.mainFrame()) log('  [nav] ' + f.url()); });

  try {
    log('1/5  Login...');
    await page.goto(URL_INICIAL, { waitUntil: 'networkidle2', timeout: 60000 });
    log('  abriu tela inicial: ' + page.url());
    await espera(1200);
    // A tela inicial pode ja ser o formulario de login (GCS Compras) ou ter o
    // botao "Acesso GsNetCompras". Se houver o botao, clica nele.
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('a, button')].find((e) => /gsnet\s*compras|acesso\s*gsnet/i.test(e.innerText || e.textContent || ''));
      if (b) b.click();
    });
    await espera(2500);

    const u = await tentarPreencher(page, ['#username', 'input[name="username"]'], USUARIO);
    const s = await tentarPreencher(page, ['#password', 'input[name="password"]'], SENHA);
    if (!u || !s) throw new Error('Nao achei os campos de login (usuario/senha).');
    await page.evaluate(() => {
      const direto = document.querySelector('#login');
      if (direto) { direto.click(); return; }
      const b = [...document.querySelectorAll('button, input[type=submit], input[type=button]')]
        .find((e) => /^(login|entrar|acessar)$/i.test((e.innerText || e.value || '').trim()));
      if (b) b.click();
    });
    await espera(6000);
    log('  apos login, URL: ' + page.url());
    // Login OK = saiu da pagina Account/Index (a home logada é .../GsnetCompras/).
    // NAO usar "sp.gov" aqui: o site inteiro é saude.SP.GOV.br!
    if (/account\/(index|login)/i.test(page.url())) {
      throw new Error('O login nao passou — confira usuario e senha no .env.');
    }

    // Captura a tela inicial logo apos o login (diagnostico do menu/link).
    await espera(2000);
    try {
      const html = await page.content();
      fs.writeFileSync(path.join(__dirname, 'dump-home.html'), html, 'utf8');
      await page.screenshot({ path: path.join(__dirname, 'home.png'), fullPage: true });
      log('  salvei dump-home.html (' + html.length + ' bytes) e home.png');
    } catch (e) { log('  FALHA ao salvar dump-home: ' + e.message); }

    // Lista os links que contem "RelatorioEstrategicoEmpenho" (para diagnostico).
    try {
      const achados = await page.evaluate(() =>
        [...document.querySelectorAll('a')]
          .filter((a) => /RelatorioEstrategicoEmpenho/i.test(a.getAttribute('href') || ''))
          .map((a) => ({ href: a.getAttribute('href'), vis: !!(a.offsetParent !== null || a.getClientRects().length), onclick: a.getAttribute('onclick') })));
      log('  links do relatorio no menu: ' + JSON.stringify(achados));
    } catch (e) { log('  FALHA ao listar links: ' + e.message); }

    log('2/5  Abrindo o relatorio e esperando as Unidades carregarem...');
    const homeUrl = page.url();
    await page.setExtraHTTPHeaders({ Referer: homeUrl }).catch(() => {});
    // O relatorio exige Referer (goto direto sem Referer cai na home). Alem disso,
    // o dropdown de Unidade carrega via AJAX depois e AS VEZES VEM VAZIO. Estrategia
    // robusta: abrir o relatorio e esperar a opcao CAF aparecer; se nao aparecer,
    // RECARREGAR a pagina (redispara o AJAX) e tentar de novo, ate 5 vezes.
    let unidadeOk = false;
    for (let tentativa = 1; tentativa <= 5 && !unidadeOk; tentativa++) {
      log('  tentativa ' + tentativa + ': abrindo relatorio...');
      await page.goto(URL_RELATORIO, { waitUntil: 'networkidle2', timeout: 60000, referer: homeUrl }).catch((e) => log('  goto erro: ' + e.message));
      const temForm = await page.waitForSelector('#P_ID_UNID_INSTIT', { timeout: 15000 }).then(() => true).catch(() => false);
      if (!temForm) {
        log('  formulario nao apareceu (caiu na home?) — voltando e tentando de novo');
        await page.goto(URL_INICIAL, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
        await espera(2500);
        continue;
      }
      // Espera a opcao desejada (CAF) aparecer no dropdown (ate 18s).
      unidadeOk = await page.waitForFunction((alvoNorm) => {
        const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
        const sel = document.querySelector('#P_ID_UNID_INSTIT');
        return sel && [...sel.options].some((o) => norm(o.textContent).includes(alvoNorm));
      }, { timeout: 18000 }, normalizar(UNIDADE)).then(() => true).catch(() => false);
      const info = await page.evaluate(() => {
        const s = document.querySelector('#P_ID_UNID_INSTIT');
        return s ? [...s.options].map((o) => (o.textContent || '').trim()) : null;
      });
      log('  Unidades: ' + JSON.stringify(info) + ' -> carregou CAF? ' + unidadeOk);
      if (!unidadeOk) { log('  vazio/incompleto — vou recarregar a pagina'); await espera(1500); }
    }
    await page.setExtraHTTPHeaders({}).catch(() => {});
    if (!unidadeOk) throw new Error('A lista de Unidades (Un. Institucional) nao carregou apos varias tentativas. Veja log.txt.');
    await espera(500);

    log('3/5  Aplicando filtros...');
    const un = await selecionarPorTexto(page, '#P_ID_UNID_INSTIT', UNIDADE);
    log('     Un. Institucional: ' + un.texto);
    await definirValor(page, '#P_DT_REF_INI', PERIODO_INICIO);
    await definirValor(page, '#P_DT_REF_FIM', mesAtualMMYYYY());
    console.log('     Periodo:', PERIODO_INICIO, 'ate', mesAtualMMYYYY());
    await marcarRadio(page, 'P_DIAS_ATRASO', 'T'); // Todos
    await marcarRadio(page, 'P_PLANILHA', 'B');    // Completo
    console.log('     Atraso: Todos | Tipo Planilha: Completo');
    await espera(800);

    console.log('4/5  Exportando (pode demorar enquanto o relatorio e gerado)...');
    // Vigia tanto a nossa pasta quanto a pasta Downloads do Windows (onde o
    // export manual costuma cair, caso o redirecionamento de download nao pegue).
    const pastas = [PASTA_DOWNLOAD, DOWNLOADS_WIN].filter((p, i, a) => p && a.indexOf(p) === i);
    const antesPorPasta = new Map(pastas.map((p) => [p, xlsxNaPasta(p)]));

    // Clique REAL (evento confiavel) no botao verde Exportar.
    await page.click('#btnExportar').catch(async () => {
      await page.evaluate(() => { const b = document.querySelector('#btnExportar'); if (b) b.click(); });
    });
    await espera(3000);
    try { await page.screenshot({ path: path.join(__dirname, 'apos-exportar.png'), fullPage: true }); } catch (_) {}

    // Se abriu uma janela pedindo o formato (ex.: Excel/PDF), escolhe Excel e
    // confirma no botao azul #btnExportar_v01.
    await page.evaluate(() => {
      const btn = document.querySelector('#btnExportar_v01');
      const visivel = btn && btn.offsetParent !== null;
      if (visivel) {
        const radios = [...document.querySelectorAll('input[type=radio]')];
        const xls = radios.find((r) => /xls|excel/i.test((r.id || '') + (r.value || '') + (r.nextElementSibling?.textContent || '')));
        if (xls) { xls.checked = true; xls.click(); }
        btn.click();
      }
    });

    let arquivo = await esperarDownload(pastas, antesPorPasta, 240000);
    if (!arquivo) throw new Error('O download do .xlsx nao apareceu em 4 minutos. Veja erro.png e apos-exportar.png.');

    // Garante que o arquivo esteja na PASTA_DOWNLOAD (o importador le de la).
    if (path.dirname(arquivo) !== path.resolve(PASTA_DOWNLOAD)) {
      const destino = path.join(PASTA_DOWNLOAD, path.basename(arquivo));
      fs.copyFileSync(arquivo, destino);
      console.log('     (copiei o arquivo da pasta Downloads para', PASTA_DOWNLOAD + ')');
      arquivo = destino;
    }

    log('5/5  PRONTO! Arquivo baixado: ' + arquivo);
    await espera(1500);
    await browser.close();
    process.exit(0);
  } catch (e) {
    log('ERRO: ' + e.message);
    try { await page.screenshot({ path: path.join(__dirname, 'erro.png'), fullPage: true }); } catch (_) {}
    log('(salvei erro.png e log.txt na pasta.)');
    await espera(4000);
    await browser.close();
    process.exit(1);
  }
})();
