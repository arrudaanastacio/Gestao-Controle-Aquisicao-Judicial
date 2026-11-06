// baixar-consultar-empenhos.js — Robo que baixa a tela "Consultar Empenho e Item
// de Empenho" (Menu Empenhos > Empenhos) do GsnetCompras.
//   1. Loga (usuario/senha do .env).
//   2. Abre a tela ConsultarEmpenho. ATENCAO: no site ela roda em "modo
//      compatibilidade" (cmode=true), DENTRO de um iframe. O robo tenta primeiro
//      a pagina DIRETA (cmode=false); se nao der, opera dentro do iframe.
//   3. Filtros: Unidade Institucional = GABINETE DO COORDENADOR - CAF,
//      Data Emissao Empenho de GSNET_CE_DATA_INI (padrao 01/01/2026) ate hoje.
//   4. Clica Pesquisar, espera o grid, e clica o icone EXPORTAR (xlsx) do grid.
//   5. Espera o .xlsx cair em PASTA_DOWNLOAD (downloads-consultar-empenhos/).
//
// >>> 1a VERSAO: grava um dump do formulario (consultar-empenho-form.json) e
//     prints em cada etapa, para confirmar seletores reais. Depois e enxugado.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const URL_INICIAL = 'https://compras.saude.sp.gov.br/GsnetCompras/Account/Index';
const URL_DIRETA = 'https://compras.saude.sp.gov.br/GsnetCompras/Preparacao/ProcessoCompra/ConsultarEmpenho?cmode=false';
const URL_SPA = 'https://compras.saude.sp.gov.br/GsnetCompras/?cmode=true#/GsnetCompras/Preparacao/ProcessoCompra/ConsultarEmpenho';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USUARIO = process.env.GSNET_USUARIO;
const SENHA = process.env.GSNET_SENHA;
const UNIDADE = process.env.GSNET_UNIDADE || 'Gabinete do Coordenador - CAF';
const DATA_INI = process.env.GSNET_CE_DATA_INI || '01/01/2026';
const PASTA_DOWNLOAD = process.env.PASTA_DOWNLOAD_CE || path.join(__dirname, 'downloads-consultar-empenhos');
const HEADLESS = /^(1|true|sim)$/i.test(process.env.HEADLESS || '');

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
function hojeDDMMYYYY() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`; }
function normalizar(s) { return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }

const LOG = path.join(__dirname, 'log-consultar-empenhos.txt');
function log(m) { const s = new Date().toLocaleString('pt-BR') + '  ' + m; console.log(s); try { fs.appendFileSync(LOG, s + '\n'); } catch (_) {} }

// Dispara focus (jQuery + nativo) — dropdowns que carregam no foco.
async function dispararFoco(ctx, seletor) {
  await ctx.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    if (window.jQuery) { try { window.jQuery(el).trigger('focus'); } catch (e) {} }
    try { el.focus(); } catch (e) {}
    el.dispatchEvent(new Event('focus', { bubbles: true }));
    el.dispatchEvent(new Event('focusin', { bubbles: true }));
  }, seletor);
}
// Define valor de input (sem abrir datepicker) + eventos.
async function definirValor(ctx, seletor, valor) {
  return ctx.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }, seletor, valor);
}
// Espera um .xlsx modificado apos `desdeMs`, download concluido e tamanho estavel.
async function esperarXlsxNovo(pasta, desdeMs, timeoutMs) {
  const ateh = Date.now() + timeoutMs;
  while (Date.now() < ateh) {
    if (fs.existsSync(pasta)) {
      const temParcial = fs.readdirSync(pasta).some((f) => /\.crdownload$/i.test(f));
      const cand = fs.readdirSync(pasta).filter((f) => /\.xlsx$/i.test(f)).map((f) => path.join(pasta, f))
        .filter((p) => fs.statSync(p).mtimeMs >= desdeMs).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (cand.length && !temParcial) { const p = cand[0]; const t1 = fs.statSync(p).size; await espera(1500); if (fs.existsSync(p) && fs.statSync(p).size === t1 && t1 > 1000) return p; }
    }
    await espera(1500);
  }
  return null;
}

(async () => {
  try { fs.writeFileSync(LOG, ''); } catch (_) {}
  log('=== Inicio do robo CONSULTAR EMPENHOS ===');
  if (!USUARIO || !SENHA) { console.error('\n>>> Preencha o .env (GSNET_USUARIO e GSNET_SENHA).\n'); process.exit(1); }
  fs.mkdirSync(PASTA_DOWNLOAD, { recursive: true });
  for (const f of fs.readdirSync(PASTA_DOWNLOAD)) { if (/\.xlsx$/i.test(f)) { try { fs.unlinkSync(path.join(PASTA_DOWNLOAD, f)); } catch (_) {} } }

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: HEADLESS ? 'new' : false, defaultViewport: null, args: ['--start-maximized'] });
  const page = (await browser.pages())[0] || (await browser.newPage());
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: PASTA_DOWNLOAD }).catch(() => {});
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) log('  [nav] ' + f.url()); });

  try {
    log('1/5  Login...');
    await page.goto(URL_INICIAL, { waitUntil: 'networkidle2', timeout: 60000 });
    await espera(1200);
    await page.evaluate(() => { const b = [...document.querySelectorAll('a, button')].find((e) => /gsnet\s*compras|acesso\s*gsnet/i.test(e.innerText || e.textContent || '')); if (b) b.click(); });
    await espera(2500);
    await page.evaluate((u) => { const e = document.querySelector('#username') || document.querySelector('input[name="username"]'); if (e) e.value = u; }, USUARIO);
    await page.evaluate((s) => { const e = document.querySelector('#password') || document.querySelector('input[name="password"]'); if (e) e.value = s; }, SENHA);
    await page.evaluate(() => { const d = document.querySelector('#login'); if (d) { d.click(); return; } const b = [...document.querySelectorAll('button, input[type=submit], input[type=button]')].find((e) => /^(login|entrar|acessar)$/i.test((e.innerText || e.value || '').trim())); if (b) b.click(); });
    await espera(6000);
    log('  apos login, URL: ' + page.url());
    if (/account\/(index|login)/i.test(page.url())) throw new Error('O login nao passou — confira usuario e senha no .env.');
    const homeUrl = page.url();
    await espera(1500);

    // --- Resolve o CONTEXTO: pagina direta (cmode=false) ou iframe (cmode=true) ---
    log('2/5  Abrindo Consultar Empenho...');
    await page.setExtraHTTPHeaders({ Referer: homeUrl }).catch(() => {});
    let ctx = null;
    // tenta direto
    await page.goto(URL_DIRETA, { waitUntil: 'networkidle2', timeout: 60000, referer: homeUrl }).catch((e) => log('  goto direta: ' + e.message));
    await espera(2500);
    const temSelectDireto = await page.evaluate(() => !!document.querySelector('select')).catch(() => false);
    const pareceConsultaDireto = await page.evaluate(() => /consultar empenho/i.test(document.body.innerText || '')).catch(() => false);
    if (temSelectDireto && pareceConsultaDireto) {
      ctx = page; log('  -> abriu DIRETO (cmode=false). URL: ' + page.url());
    } else {
      log('  pagina direta nao serviu — indo pelo iframe (cmode=true)...');
      await page.goto(URL_SPA, { waitUntil: 'networkidle2', timeout: 60000, referer: homeUrl }).catch((e) => log('  goto spa: ' + e.message));
      await espera(4500);
      // espera o iframe de ConsultarEmpenho aparecer
      for (let i = 0; i < 20 && !ctx; i++) {
        const alvo = page.frames().find((f) => /ConsultarEmpenho/i.test(f.url()));
        if (alvo) { ctx = alvo; break; }
        await espera(1000);
      }
      log('  frames: ' + JSON.stringify(page.frames().map((f) => f.url()).filter((u) => u && u !== 'about:blank')));
      if (!ctx) throw new Error('Nao achei a tela ConsultarEmpenho (nem direto nem no iframe).');
      log('  -> operando no IFRAME: ' + ctx.url());
    }
    await page.setExtraHTTPHeaders({}).catch(() => {});

    // --- DIAGNOSTICO: dump do formulario (selects/inputs/botoes/export) ---
    const diag = await ctx.evaluate(() => {
      const arr = (sel) => [...document.querySelectorAll(sel)];
      const selects = arr('select').map((s, i) => ({ i, id: s.id, name: s.name, title: s.title, nOpc: s.options.length, temCAF: [...s.options].some((o) => /coordenador/i.test(o.textContent)) }));
      const inputs = arr('input').map((x, i) => ({ i, id: x.id, name: x.name, type: x.type, title: x.title, ph: x.placeholder }));
      const botoes = arr('button, input[type=button], input[type=submit], a.btn').map((x) => ({ id: x.id, cls: String(x.className || '').slice(0, 30), txt: (x.innerText || x.value || '').trim().slice(0, 30), title: x.title }));
      const exportaveis = arr('a,button,img,i,span,div').filter((x) => /xls|excel|export|planilha/i.test(String(x.className || '') + (x.title || '') + (x.getAttribute('onclick') || '') + (x.getAttribute('src') || '') + (x.id || ''))).map((x) => ({ tag: x.tagName, id: x.id, cls: String(x.className || '').slice(0, 40), title: x.title, onclick: String(x.getAttribute('onclick') || '').slice(0, 80) })).slice(0, 15);
      return { url: location.href, selects, inputs: inputs.slice(0, 40), botoes: botoes.slice(0, 25), exportaveis };
    }).catch((e) => ({ erro: e.message }));
    try { fs.writeFileSync(path.join(__dirname, 'consultar-empenho-form.json'), JSON.stringify(diag, null, 2), 'utf8'); } catch (_) {}
    log('  [dump] selects=' + (diag.selects || []).length + ' inputs=' + (diag.inputs || []).length + ' botoes=' + (diag.botoes || []).length + ' export?=' + JSON.stringify(diag.exportaveis || []));
    try { await page.screenshot({ path: path.join(__dirname, 'ce-1-form.png'), fullPage: true }); } catch (_) {}

    // --- Filtros ---
    log('3/5  Aplicando filtros...');
    // Unidade = o <select> cujas opcoes contem "Coordenador" (carrega no foco se vazio).
    let selUnidade = (diag.selects || []).find((s) => s.temCAF);
    if (!selUnidade) {
      // tenta focar todos os selects p/ carregar opcoes via AJAX, e reavalia
      for (const s of (diag.selects || [])) { if (s.id) await dispararFoco(ctx, '#' + s.id); }
      await espera(1500);
      selUnidade = await ctx.evaluate(() => {
        const s = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => /coordenador/i.test(o.textContent)));
        return s ? { id: s.id } : null;
      });
    }
    if (selUnidade && selUnidade.id) {
      const r = await ctx.evaluate((id, alvoNorm) => {
        const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
        const sel = document.getElementById(id);
        const opt = [...sel.options].find((o) => norm(o.textContent).includes(alvoNorm));
        if (!opt) return { erro: 'opcao nao achada', opcoes: [...sel.options].map((o) => o.textContent.trim()).slice(0, 20) };
        sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, texto: opt.textContent.trim() };
      }, selUnidade.id, normalizar(UNIDADE));
      log('  Unidade (#' + selUnidade.id + '): ' + JSON.stringify(r));
    } else {
      log('  [ATENCAO] nao localizei o select de Unidade — ver consultar-empenho-form.json');
    }

    // Data Emissao Empenho: de DATA_INI ate hoje. Acha os 2 campos de data da
    // linha cujo rotulo contem "Data Emissao Empenho".
    const okData = await ctx.evaluate((dataIni, dataFim) => {
      const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      // acha o no de texto/elemento com "data emissao empenho"
      const todos = [...document.querySelectorAll('td,th,label,span,div')];
      const rotulo = todos.find((e) => norm(e.textContent).includes('data emissao empenho') && e.querySelectorAll('*').length < 6);
      if (!rotulo) return { erro: 'rotulo Data Emissao nao achado' };
      // procura inputs de texto proximos (mesma linha/tabela ou irmaos seguintes)
      let escopo = rotulo.closest('tr') || rotulo.parentElement;
      let ins = escopo ? [...escopo.querySelectorAll('input[type=text], input:not([type])')] : [];
      // se nao achou 2, sobe um nivel
      if (ins.length < 2 && escopo && escopo.parentElement) ins = [...escopo.parentElement.querySelectorAll('input[type=text], input:not([type])')];
      const setar = (el, v) => { if (!el) return; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('blur', { bubbles: true })); };
      if (ins[0]) setar(ins[0], dataIni);
      if (ins[1]) setar(ins[1], dataFim);
      return { ok: true, nInputs: ins.length, ids: ins.slice(0, 2).map((x) => x.id || x.name || '(sem id)') };
    }, DATA_INI, hojeDDMMYYYY());
    log('  Data Emissao ' + DATA_INI + ' ate ' + hojeDDMMYYYY() + ' -> ' + JSON.stringify(okData));
    await espera(600);

    // --- Pesquisar ---
    log('4/5  Pesquisar...');
    const clicouPesq = await ctx.evaluate(() => {
      const b = [...document.querySelectorAll('button, input[type=button], input[type=submit], a')].find((x) => /^pesquisar$/i.test((x.innerText || x.value || '').trim()));
      if (b) { b.click(); return true; } return false;
    });
    log('  clicou Pesquisar? ' + clicouPesq);
    if (!clicouPesq) throw new Error('Nao achei o botao Pesquisar.');
    // espera o grid carregar (linhas na tabela ou "Qtde Itens")
    await ctx.waitForFunction(() => {
      const t = document.body.innerText || '';
      return /qtde\s*itens/i.test(t) || document.querySelectorAll('table tbody tr').length > 3;
    }, { timeout: 60000 }).catch(() => log('  (grid demorou — seguindo mesmo assim)'));
    await espera(2000);
    try { await page.screenshot({ path: path.join(__dirname, 'ce-2-resultado.png'), fullPage: true }); } catch (_) {}

    // --- Exportar (icone do grid abre um MENU; escolher "todas as paginas") ---
    log('5/5  Exportando (todas as paginas) para Excel...');
    const t0 = Date.now() - 2000;
    // 1) clica o icone "Exportar grid de dados" (abre o modal de opcoes)
    const abriu = await ctx.evaluate(() => {
      const chave = (x) => ((x.title || '') + ' ' + String(x.className || '') + ' ' + (x.id || '') + ' ' + (x.getAttribute('onclick') || '')).toLowerCase();
      const cands = [...document.querySelectorAll('a,button,img,i,span,div')].filter((x) => /exportar grid|xls|excel|export|planilha/.test(chave(x)));
      const alvo = cands.find((x) => x.offsetParent !== null) || cands[0];
      if (alvo) { alvo.click(); return alvo.title || alvo.id || String(alvo.className).slice(0, 40); }
      return null;
    });
    log('  abriu menu de exportar via: ' + JSON.stringify(abriu));
    if (!abriu) throw new Error('Nao achei o icone "Exportar grid de dados".');
    // 2) espera e clica "Exportar TODAS as paginas para Excel"
    const clicouTodas = await ctx.waitForFunction(() => {
      const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
      const b = [...document.querySelectorAll('button, input[type=button], input[type=submit], a, .btn')]
        .find((x) => x.offsetParent !== null && norm(x.innerText || x.value).includes('exportar todas as paginas para excel'));
      if (b) { b.click(); return true; }
      return false;
    }, { timeout: 25000 }).then(() => true).catch(() => false);
    log('  cliquei "Exportar todas as paginas para Excel"? ' + clicouTodas);
    if (!clicouTodas) throw new Error('Abriu o menu mas nao achei o botao "Exportar todas as paginas para Excel".');
    await espera(2500);
    try { await page.screenshot({ path: path.join(__dirname, 'ce-3-apos-export.png'), fullPage: true }); } catch (_) {}

    // Todas as paginas (1033+) pode demorar: ate 8 min.
    const arquivo = await esperarXlsxNovo(PASTA_DOWNLOAD, t0, 480000);
    if (!arquivo) throw new Error('O .xlsx nao apareceu em 8 min. Veja ce-3-apos-export.png.');
    log('PRONTO! Arquivo salvo (' + fs.statSync(arquivo).size + ' bytes): ' + arquivo);
    await espera(1500);
    await browser.close();
    process.exit(0);
  } catch (e) {
    log('ERRO: ' + e.message);
    try { await page.screenshot({ path: path.join(__dirname, 'ce-erro.png'), fullPage: true }); } catch (_) {}
    await espera(3000);
    await browser.close();
    process.exit(1);
  }
})();
