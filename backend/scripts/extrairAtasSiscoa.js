// Extrai automaticamente o relatório de Atas de Registro de Preço do SISCOA
// (login + navegação até "Relatórios" + exportar Excel) e salva o arquivo
// exatamente no caminho que o vigia de Atas (vigiaAtas.js) já monitora — ele
// detecta a atualização e importa sozinho, sem precisar abrir o arquivo no
// Excel (evita o bug de datas trocadas que vimos com "Salvar Como .xlsx").
//
// Uso:  node scripts/extrairAtasSiscoa.js
// Credenciais lidas de backend/.env: SISCOA_USUARIO, SISCOA_SENHA

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const URL_LOGIN = 'https://siscoa.saude.sp.gov.br/login';
const USUARIO = process.env.SISCOA_USUARIO;
const SENHA = process.env.SISCOA_SENHA;
const CAMINHO_DESTINO = process.env.CAMINHO_ATAS_CSV ||
  'G:\\CAF\\GAF\\GGAF\\PROGRAMAÇÃO\\CPDAE\\RELATÓRIO DE COMPRAS\\2026\\MEDICAMENTO\\MACRO\\Atas SISCOA.xls';
const MODO_VISIVEL = process.env.SISCOA_HEADLESS === 'false'; // para depurar: SISCOA_HEADLESS=false node scripts/...

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function tentarClicar(page, opcoes) {
  for (const loc of opcoes) {
    try {
      const el = loc();
      if (await el.count() > 0) { await el.first().click({ timeout: 5000 }); return true; }
    } catch { /* tenta a próxima estratégia */ }
  }
  return false;
}

async function tentarPreencher(page, opcoes, valor) {
  for (const loc of opcoes) {
    try {
      const el = loc();
      if (await el.count() > 0) { await el.first().fill(valor, { timeout: 5000 }); return true; }
    } catch { /* tenta a próxima estratégia */ }
  }
  return false;
}

async function main() {
  if (!USUARIO || !SENHA) {
    throw new Error('Defina SISCOA_USUARIO e SISCOA_SENHA no arquivo backend/.env antes de rodar este script.');
  }

  const browser = await chromium.launch({ headless: !MODO_VISIVEL });
  const contexto = await browser.newContext({ acceptDownloads: true });
  const page = await contexto.newPage();

  try {
    log('Abrindo página de login do SISCOA…');
    await page.goto(URL_LOGIN, { waitUntil: 'networkidle' });

    const okUsuario = await tentarPreencher(page, [
      () => page.getByLabel(/usu[aá]rio/i),
      () => page.locator('input[name*="usuario" i]'),
      () => page.locator('input[type="text"]').first(),
      () => page.locator('input[type="email"]'),
    ], USUARIO);
    if (!okUsuario) throw new Error('Não encontrei o campo de usuário na tela de login.');

    const okSenha = await tentarPreencher(page, [
      () => page.getByLabel(/senha/i),
      () => page.locator('input[type="password"]'),
    ], SENHA);
    if (!okSenha) throw new Error('Não encontrei o campo de senha na tela de login.');

    log('Fazendo login…');
    const okEntrar = await tentarClicar(page, [
      () => page.getByRole('button', { name: /entrar/i }),
      () => page.getByText(/^entrar$/i),
      () => page.locator('button[type="submit"]'),
    ]);
    if (!okEntrar) throw new Error('Não encontrei o botão "Entrar" na tela de login.');

    await page.waitForLoadState('networkidle');
    if (page.url().includes('/login')) {
      throw new Error('Login não avançou (continua na página de login) — verifique usuário/senha em backend/.env.');
    }
    log('Login OK. Indo até Relatórios…');

    const okRelatorios = await tentarClicar(page, [
      () => page.getByRole('link', { name: /relat[oó]rios/i }),
      () => page.getByText(/relat[oó]rios/i),
    ]);
    if (!okRelatorios) throw new Error('Não encontrei o menu "Relatórios".');
    await page.waitForLoadState('networkidle');

    log('Clicando em Excel para exportar…');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      tentarClicar(page, [
        () => page.getByRole('link', { name: /^excel$/i }),
        () => page.getByRole('button', { name: /^excel$/i }),
        () => page.getByText(/^excel$/i),
      ]),
    ]);

    fs.mkdirSync(path.dirname(CAMINHO_DESTINO), { recursive: true });
    await download.saveAs(CAMINHO_DESTINO);
    const st = fs.statSync(CAMINHO_DESTINO);
    log(`Arquivo salvo em: ${CAMINHO_DESTINO} (${st.size} bytes)`);
    log('Concluído. O vigia de Atas do sistema vai detectar e importar automaticamente em instantes.');
  } catch (e) {
    log(`ERRO: ${e.message}`);
    try {
      const pastaErro = path.join(__dirname, '..', 'data', 'logs');
      fs.mkdirSync(pastaErro, { recursive: true });
      const arqPrint = path.join(pastaErro, `erro-siscoa-${Date.now()}.png`);
      await page.screenshot({ path: arqPrint, fullPage: true });
      log(`Print da tela no momento do erro salvo em: ${arqPrint}`);
    } catch { /* se nem o print der certo, segue só com a mensagem de erro */ }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
