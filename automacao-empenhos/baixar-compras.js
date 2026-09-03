// baixar-compras.js — Robo que baixa o "Relatorio Estrategico de Compras" do
// GsnetCompras (irmao do baixar-empenhos.js, mesma mecanica de acesso):
//   1. Loga (usuario/senha do .env) na tela GCS Compras.
//   2. Abre a tela do Relatorio Estrategico de COMPRAS.
//      (Compras -> Relatorios -> Relatorio Estrategico de Compras)
//   3. Aplica os filtros: Un. Institucional = Gabinete do Coordenador - CAF,
//      Periodo Inicio = GSNET_PERIODO_INICIO (padrao 01/2023), Periodo Fim = mes
//      atual, Programa = GSNET_COMPRAS_PROGRAMA (padrao DEMANDAS EXTRAORDINARIAS),
//      e o restante dos Com/Sem/checkboxes como o site ja vem por padrao (print).
//   4. Clica Exportar e espera o .xlsx cair na PASTA_DOWNLOAD (downloads-compras/).
// Ao final imprime o caminho do arquivo. Quem grava no banco e o importar-compras.js.
//
// >>> ESTA VERSAO ainda TEM diagnostico (dump do formulario) enquanto validamos
//     os IDs reais dos campos desta pagina. Depois de confirmado, e enxugado.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const URL_INICIAL = 'https://compras.saude.sp.gov.br/GsnetCompras/Account/Index';
const URL_RELATORIO = 'https://compras.saude.sp.gov.br/GsnetCompras/Planejamento/RelatorioEstrategico/Index?cmode=false';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USUARIO = process.env.GSNET_USUARIO;
const SENHA = process.env.GSNET_SENHA;
const UNIDADE = process.env.GSNET_UNIDADE || 'Gabinete do Coordenador - CAF';
// Um ou mais programas (o dropdown e de selecao unica, entao exportamos 1 arquivo
// por programa e o importar-compras.js junta tudo). Nomes casam por "contem"
// normalizado, entao "Demandas Extraordinarias" acha "DEMANDAS EXTRAORDINÁRIAS".
const PROGRAMAS = (process.env.GSNET_COMPRAS_PROGRAMAS || 'Demandas Extraordinarias, Outras Demandas')
  .split(',').map((s) => s.trim()).filter(Boolean);
const PERIODO_INICIO = process.env.GSNET_COMPRAS_PERIODO_INICIO || '01/2025';
const PASTA_DOWNLOAD = process.env.PASTA_DOWNLOAD_COMPRAS || path.join(__dirname, 'downloads-compras');
const HEADLESS = /^(1|true|sim)$/i.test(process.env.HEADLESS || '');

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function mesAtualMMYYYY() {
  const d = new Date();
  return String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}

function normalizar(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
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

// Dispara focus (jQuery + nativo) num campo cujo dropdown carrega via AJAX no foco.
async function dispararFoco(page, seletor) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    if (window.jQuery) { try { window.jQuery(el).trigger('focus'); } catch (e) {} }
    try { el.focus(); } catch (e) {}
    el.dispatchEvent(new Event('focus', { bubbles: true }));
    el.dispatchEvent(new Event('focusin', { bubbles: true }));
  }, seletor);
  await page.focus(seletor).catch(() => {});
}

// Espera um <select> ter uma opcao cujo texto contenha `alvo` (normalizado).
async function esperarOpcao(page, seletor, alvo, timeoutMs) {
  return page.waitForFunction((sel, alvoNorm) => {
    const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const el = document.querySelector(sel);
    return el && [...el.options].some((o) => norm(o.textContent).includes(alvoNorm));
  }, { timeout: timeoutMs }, seletor, normalizar(alvo)).then(() => true).catch(() => false);
}

// Seleciona numa <select> a opcao cujo texto contem o alvo (normalizado).
async function selecionarPorTexto(page, seletor, alvo, rotulo) {
  const res = await page.evaluate((sel, alvoNorm) => {
    const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const s = document.querySelector(sel);
    if (!s) return { erro: 'select nao encontrado' };
    const opt = [...s.options].find((o) => norm(o.textContent).includes(alvoNorm));
    if (!opt) return { erro: 'opcao nao encontrada', opcoes: [...s.options].map((o) => o.textContent.trim()).slice(0, 40) };
    s.value = opt.value;
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, texto: opt.textContent.trim(), value: opt.value };
  }, seletor, normalizar(alvo));
  if (res.erro) throw new Error(`${rotulo || seletor}: ${res.erro}${res.opcoes ? ' (opcoes: ' + res.opcoes.join(' / ') + ')' : ''}`);
  return res;
}

// Marca um radio por name+value (dispara os handlers do site).
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

// Deixa um checkbox no estado desejado (so clica se precisar; roda os handlers).
async function definirCheckbox(page, seletor, queroMarcado) {
  const r = await page.evaluate((sel, quero) => {
    const el = document.querySelector(sel);
    if (!el) return { erro: 'nao encontrado' };
    if (el.checked !== quero) { el.click(); el.dispatchEvent(new Event('change', { bubbles: true })); }
    return { ok: true, agora: el.checked };
  }, seletor, queroMarcado);
  if (r.erro) throw new Error(`checkbox ${seletor}: ${r.erro}`);
  return r;
}

// Espera um .xlsx MODIFICADO depois de `desdeMs`, download concluido e tamanho
// estavel. O site salva com nome fixo, entao detectamos pela data de modificacao.
async function esperarXlsxNovo(pasta, desdeMs, timeoutMs) {
  const ateh = Date.now() + timeoutMs;
  while (Date.now() < ateh) {
    if (fs.existsSync(pasta)) {
      const temParcial = fs.readdirSync(pasta).some((f) => /\.crdownload$/i.test(f));
      const candidatos = fs.readdirSync(pasta)
        .filter((f) => /\.xlsx$/i.test(f))
        .map((f) => path.join(pasta, f))
        .filter((p) => fs.statSync(p).mtimeMs >= desdeMs)
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (candidatos.length && !temParcial) {
        const p = candidatos[0];
        const t1 = fs.statSync(p).size;
        await espera(1500);
        if (fs.existsSync(p) && fs.statSync(p).size === t1 && t1 > 1000) return p;
      }
    }
    await espera(1500);
  }
  return null;
}

const LOG = path.join(__dirname, 'log-compras.txt');
function log(m) {
  const s = new Date().toLocaleString('pt-BR') + '  ' + m;
  console.log(s);
  try { fs.appendFileSync(LOG, s + '\n'); } catch (_) {}
}

// Abre o relatorio, aplica os filtros para UM programa, exporta e salva o .xlsx
// com nome proprio do programa (senao o proximo export sobrescreve o RelatorioEstrategico.xlsx).
async function exportarPrograma(page, programa, homeUrl) {
  log('=== Programa: ' + programa + ' ===');
  // Abre o relatorio e espera as Unidades (dropdown carrega no FOCO). Retenta.
  await page.setExtraHTTPHeaders({ Referer: homeUrl }).catch(() => {});
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
    await espera(1200);
    await dispararFoco(page, '#P_ID_UNID_INSTIT');
    unidadeOk = await esperarOpcao(page, '#P_ID_UNID_INSTIT', UNIDADE, 12000);
    if (!unidadeOk) { await dispararFoco(page, '#P_ID_UNID_INSTIT'); unidadeOk = await esperarOpcao(page, '#P_ID_UNID_INSTIT', UNIDADE, 15000); }
    if (!unidadeOk) { log('  Unidades vazias — recarregando'); await espera(1500); }
  }
  await page.setExtraHTTPHeaders({}).catch(() => {});
  if (!unidadeOk) throw new Error('A lista de Unidades nao carregou (programa "' + programa + '").');
  await espera(500);

  // Filtros
  const un = await selecionarPorTexto(page, '#P_ID_UNID_INSTIT', UNIDADE, 'Un. Institucional');
  log('  Un. Institucional: ' + un.texto);
  await definirValor(page, '#P_DT_REF_INI', PERIODO_INICIO);
  await definirValor(page, '#P_DT_REF_FIM', mesAtualMMYYYY());
  log('  Periodo: ' + PERIODO_INICIO + ' ate ' + mesAtualMMYYYY());

  // Programa (dropdown carrega no foco: CarregarDropDownListPS).
  await dispararFoco(page, '#P_ID_PROGRAMA_SAUDE');
  const achou = await esperarOpcao(page, '#P_ID_PROGRAMA_SAUDE', programa, 18000);
  if (!achou) {
    const opcoes = await page.evaluate(() => { const e = document.querySelector('#P_ID_PROGRAMA_SAUDE'); return e ? [...e.options].map((o) => o.textContent.trim()) : null; });
    throw new Error('Nao achei o Programa "' + programa + '". Opcoes: ' + JSON.stringify(opcoes));
  }
  const pr = await selecionarPorTexto(page, '#P_ID_PROGRAMA_SAUDE', programa, 'Programa');
  log('  Programa: ' + pr.texto);

  // Tudo OFF + Com Processo (resto = padrao do site/print).
  await definirCheckbox(page, '#ChkTudo', false);
  await marcarRadio(page, 'P_PROC', 'C');
  await espera(800);

  // Export (POST gera na sessao -> iframe GerarExcel -> Chrome salva RelatorioEstrategico.xlsx).
  const onResponse = async (resp) => {
    const u2 = resp.url();
    if (/GerarExcel/i.test(u2)) log('  [excel] ' + resp.status() + ' (' + (resp.headers()['content-type'] || '') + ', ' + (resp.headers()['content-length'] || '?') + ' bytes)');
    else if (/RelatorioEstrategico\/fn[A-Za-z]*Estrategico\b/i.test(u2)) { try { log('  [gerar] ' + resp.status() + ' -> ' + (await resp.text()).slice(0, 160).replace(/\s+/g, ' ')); } catch (_) {} }
  };
  page.on('response', onResponse);
  const t0 = Date.now() - 2000;
  await page.click('#btnExportar').catch(async () => { await page.evaluate(() => { const b = document.querySelector('#btnExportar'); if (b) b.click(); }); });
  const arquivo = await esperarXlsxNovo(PASTA_DOWNLOAD, t0, 300000);
  page.off('response', onResponse);
  if (!arquivo) throw new Error('O .xlsx nao apareceu em 5 min (programa "' + programa + '"). Veja o log.');

  // Renomeia para nome proprio do programa (o proximo export sobrescreve o fixo).
  const slug = normalizar(programa).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const destino = path.join(PASTA_DOWNLOAD, 'RelatorioEstrategico__' + slug + '.xlsx');
  try { if (fs.existsSync(destino)) fs.unlinkSync(destino); fs.renameSync(arquivo, destino); }
  catch (e) { log('  [aviso] nao consegui renomear (' + e.message + ') — mantendo ' + path.basename(arquivo)); return arquivo; }
  log('  salvo: ' + path.basename(destino) + ' (' + fs.statSync(destino).size + ' bytes)');
  return destino;
}

(async () => {
  try { fs.writeFileSync(LOG, ''); } catch (_) {}
  log('=== Inicio do robo de COMPRAS ===');
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

  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: PASTA_DOWNLOAD }).catch(() => {});

  page.on('framenavigated', (f) => { if (f === page.mainFrame()) log('  [nav] ' + f.url()); });

  try {
    log('1/5  Login...');
    await page.goto(URL_INICIAL, { waitUntil: 'networkidle2', timeout: 60000 });
    log('  abriu tela inicial: ' + page.url());
    await espera(1200);
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
    if (/account\/(index|login)/i.test(page.url())) {
      throw new Error('O login nao passou — confira usuario e senha no .env.');
    }
    await espera(2000);

    const homeUrl = page.url();
    // Limpa .xlsx antigos p/ o importador so pegar os desta rodada.
    for (const f of fs.readdirSync(PASTA_DOWNLOAD)) {
      if (/\.xlsx$/i.test(f)) { try { fs.unlinkSync(path.join(PASTA_DOWNLOAD, f)); } catch (_) {} }
    }

    log('2/3  Exportando ' + PROGRAMAS.length + ' programa(s): ' + PROGRAMAS.join(' | '));
    const arquivos = [];
    for (const programa of PROGRAMAS) {
      arquivos.push(await exportarPrograma(page, programa, homeUrl));
    }

    log('3/3  PRONTO! ' + arquivos.length + ' arquivo(s): ' + arquivos.map((a) => path.basename(a)).join(', '));
    await espera(1500);
    await browser.close();
    process.exit(0);
  } catch (e) {
    log('ERRO: ' + e.message);
    try { await page.screenshot({ path: path.join(__dirname, 'compras-erro.png'), fullPage: true }); } catch (_) {}
    log('(salvei compras-erro.png e log-compras.txt na pasta.)');
    await espera(4000);
    await browser.close();
    process.exit(1);
  }
})();
