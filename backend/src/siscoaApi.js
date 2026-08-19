// =====================================================================
// siscoaApi.js
// Cliente HTTP do SISCOA (https://siscoa.saude.sp.gov.br).
//
// Baixa o relatório de Atas de Registro de Preço direto do site, sem
// depender do arquivo "Atas SISCOA.xls" copiado na pasta de rede.
//
// O SISCOA autentica por SESSÃO (cookie JSESSIONID), não por HTTP Basic:
//   1) GET  /login            -> recebe um JSESSIONID novo
//   2) POST /login/logar       -> envia loginEmail + loginSenha (form-urlencoded)
//                                 carregando o cookie; em caso de sucesso
//                                 redireciona (302) para dentro do sistema
//   3) GET  <export do relatório> com o mesmo cookie -> baixa o XLS
//
// O relatório é uma tabela DisplayTag: a URL de export tem o padrão
//   /relatorios/listaItensVigencia?d-<idTabela>-e=<formato>&export=1
// onde "d-...-e=2" pede o formato Excel. O "6578706f7274" que aparece na
// URL do navegador é só o hexadecimal de "export".
//
// Credenciais NUNCA no código (o repositório no GitHub é público). Vêm do
// .env local, reaproveitando as mesmas do robô de extração:
//   SISCOA_USUARIO=...
//   SISCOA_SENHA=...
//   SISCOA_URL=https://siscoa.saude.sp.gov.br        (opcional)
//   SISCOA_TIMEOUT_MS=60000                           (opcional)
// =====================================================================

const BASE_PADRAO = 'https://siscoa.saude.sp.gov.br';
// Caminho do export do relatório de Atas vigentes (formato Excel).
const CAMINHO_EXPORT_ATAS_PADRAO = '/relatorios/listaItensVigencia?d-3581610-e=2&export=1';

function config() {
  const base = (process.env.SISCOA_URL || BASE_PADRAO).replace(/\/+$/, '');
  const usuario = process.env.SISCOA_USUARIO || '';
  const senha = process.env.SISCOA_SENHA || '';
  const exportAtas = process.env.SISCOA_EXPORT_ATAS || CAMINHO_EXPORT_ATAS_PADRAO;
  const timeoutMs = parseInt(process.env.SISCOA_TIMEOUT_MS, 10) || 60000;
  return { base, usuario, senha, exportAtas, timeoutMs };
}

// Informa se as credenciais estão configuradas (sem revelar os valores).
function credenciaisConfiguradas() {
  const { usuario, senha } = config();
  return Boolean(usuario && senha);
}

// ---- Cofre de cookies mínimo (só o par nome=valor, sem atributos) ----
function novoCofreCookies() {
  const jar = new Map();
  return {
    guardar(setCookieHeader) {
      if (!setCookieHeader) return;
      // getSetCookie() devolve array; header simples devolve string.
      const linhas = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
      for (const linha of linhas) {
        const primeiro = String(linha).split(';')[0];
        const eq = primeiro.indexOf('=');
        if (eq > 0) jar.set(primeiro.slice(0, eq).trim(), primeiro.slice(eq + 1).trim());
      }
    },
    cabecalho() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    tem(nome) { return jar.has(nome); },
  };
}

function coletarSetCookie(resp, cofre) {
  // Node 20+ tem getSetCookie(); cai no header simples se não existir.
  if (typeof resp.headers.getSetCookie === 'function') cofre.guardar(resp.headers.getSetCookie());
  else cofre.guardar(resp.headers.get('set-cookie'));
}

// fetch com timeout (AbortController + clearTimeout no finally, para não
// deixar timer pendente — mesmo cuidado do udtpApi.js).
async function fetchComTimeout(url, opcoes, timeoutMs) {
  const controlador = new AbortController();
  let estourou = false;
  const timer = setTimeout(() => { estourou = true; controlador.abort(); }, timeoutMs);
  try {
    return await fetch(url, { ...opcoes, signal: controlador.signal });
  } catch (e) {
    const err = new Error(estourou
      ? `O SISCOA não respondeu em ${Math.round(timeoutMs / 1000)}s.`
      : `Não consegui falar com o SISCOA: ${e.message}`);
    err.codigo = estourou ? 'TIMEOUT' : 'FALHA_CONEXAO';
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Faz login e devolve o cofre de cookies com a sessão autenticada.
async function autenticar() {
  const { base, usuario, senha, timeoutMs } = config();
  if (!usuario || !senha) {
    const err = new Error('Credenciais do SISCOA não configuradas. Defina SISCOA_USUARIO e SISCOA_SENHA no .env.');
    err.codigo = 'SEM_CREDENCIAL';
    throw err;
  }

  const cofre = novoCofreCookies();

  // 1) GET /login -> cookie de sessão inicial
  const respLogin = await fetchComTimeout(`${base}/login`, {
    method: 'GET', redirect: 'manual',
    headers: { 'User-Agent': 'Elo-ComprasJudiciais', Accept: 'text/html' },
  }, timeoutMs);
  coletarSetCookie(respLogin, cofre);

  // 2) POST /login/logar com as credenciais
  const corpo = new URLSearchParams({ loginEmail: usuario, loginSenha: senha }).toString();
  const respLogar = await fetchComTimeout(`${base}/login/logar`, {
    method: 'POST', redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cofre.cabecalho(),
      'User-Agent': 'Elo-ComprasJudiciais',
      Accept: 'text/html',
    },
    body: corpo,
  }, timeoutMs);
  coletarSetCookie(respLogar, cofre);

  // Sucesso típico: 302 para dentro do sistema. Falha típica: 200 devolvendo
  // a própria tela de login (ou 302 de volta para /login).
  const destino = respLogar.headers.get('location') || '';
  const status = respLogar.status;
  const voltouProLogin = /\/login(\b|\/|$|\?)/i.test(destino) && !/logar/i.test(destino);
  if (status === 200 || voltouProLogin) {
    const err = new Error('O SISCOA recusou o login. Confira SISCOA_USUARIO e SISCOA_SENHA no .env.');
    err.codigo = 'NAO_AUTORIZADO';
    throw err;
  }
  if (status !== 302 && !(status >= 200 && status < 400)) {
    const err = new Error(`Resposta inesperada do login do SISCOA (HTTP ${status}).`);
    err.codigo = 'ERRO_LOGIN';
    throw err;
  }

  return cofre;
}

// Baixa o relatório de Atas (XLS) já autenticado e devolve um Buffer.
async function baixarRelatorioAtas() {
  const { base, exportAtas, timeoutMs } = config();
  const cofre = await autenticar();

  const url = exportAtas.startsWith('http') ? exportAtas : `${base}${exportAtas}`;
  const resp = await fetchComTimeout(url, {
    method: 'GET', redirect: 'manual',
    headers: {
      Cookie: cofre.cabecalho(),
      'User-Agent': 'Elo-ComprasJudiciais',
      Accept: 'application/vnd.ms-excel, application/octet-stream, */*',
    },
  }, timeoutMs);

  // Se a sessão não valeu para o export, ele redireciona de volta ao /login.
  if (resp.status === 302) {
    const destino = resp.headers.get('location') || '';
    if (/\/login/i.test(destino)) {
      const err = new Error('A sessão do SISCOA não foi aceita no download do relatório (redirecionou para o login).');
      err.codigo = 'SESSAO_INVALIDA';
      throw err;
    }
    const err = new Error(`O download do relatório redirecionou para ${destino}`);
    err.codigo = 'REDIRECIONOU';
    throw err;
  }
  if (!resp.ok) {
    const err = new Error(`O SISCOA respondeu ${resp.status} ao baixar o relatório de Atas.`);
    err.codigo = 'ERRO_DOWNLOAD';
    throw err;
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  const tipo = resp.headers.get('content-type') || '';
  // Se veio HTML (tela de login/erro) em vez do binário, avisa em vez de
  // gravar lixo no banco.
  if (/text\/html/i.test(tipo) || buffer.length < 1000) {
    const err = new Error(`O SISCOA não devolveu o arquivo esperado (content-type "${tipo}", ${buffer.length} bytes). A sessão pode ter expirado ou o relatório mudou de endereço.`);
    err.codigo = 'RESPOSTA_INVALIDA';
    throw err;
  }
  return { buffer, contentType: tipo, tamanho: buffer.length };
}

module.exports = { baixarRelatorioAtas, autenticar, credenciaisConfiguradas };
