// =====================================================================
// udtpApi.js
// Cliente da API de Reservas da UDTP (https://api.udtp.org.br).
//
// A API usa autenticação HTTP Basic (cabeçalho WWW-Authenticate: Basic).
// As credenciais NUNCA ficam no código: vêm do .env local, que não é
// versionado (o repositório no GitHub é público).
//
// .env esperado:
//   UDTP_API_URL=https://api.udtp.org.br
//   UDTP_API_USUARIO=...
//   UDTP_API_SENHA=...
//   UDTP_API_TIMEOUT_MS=30000        (opcional)
//
// Observação sobre certificado: no Windows, o `curl` falha nessa API com
// CRYPT_E_NO_REVOCATION_CHECK porque o schannel não consegue consultar a
// lista de revogação através da rede corporativa. O Node NÃO usa schannel
// (usa OpenSSL e não faz checagem de revogação por padrão), então aqui o
// problema não acontece — não é preciso desabilitar validação nenhuma.
// =====================================================================

const BASE_PADRAO = 'https://api.udtp.org.br';

function config() {
  const base = (process.env.UDTP_API_URL || BASE_PADRAO).replace(/\/+$/, '');
  const usuario = process.env.UDTP_API_USUARIO || '';
  const senha = process.env.UDTP_API_SENHA || '';
  const timeoutMs = parseInt(process.env.UDTP_API_TIMEOUT_MS, 10) || 30000;
  return { base, usuario, senha, timeoutMs };
}

// Informa se as credenciais estão configuradas (sem revelar os valores).
function credenciaisConfiguradas() {
  const { usuario, senha } = config();
  return Boolean(usuario && senha);
}

function cabecalhoBasic(usuario, senha) {
  return 'Basic ' + Buffer.from(`${usuario}:${senha}`, 'utf8').toString('base64');
}

// Valida o formato da data exigido pela API: AAAA-MM-DD.
function normalizarData(data) {
  if (data instanceof Date) {
    const y = data.getFullYear();
    const m = String(data.getMonth() + 1).padStart(2, '0');
    const d = String(data.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const txt = String(data || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txt)) {
    const err = new Error(`Data inválida "${txt}". Use o formato AAAA-MM-DD (ex.: 2020-12-14).`);
    err.codigo = 'DATA_INVALIDA';
    throw err;
  }
  return txt;
}

// GET autenticado, com timeout e mensagens de erro em português.
async function chamar(caminho) {
  const { base, usuario, senha, timeoutMs } = config();
  if (!usuario || !senha) {
    const err = new Error('Credenciais da API UDTP não configuradas. Defina UDTP_API_USUARIO e UDTP_API_SENHA no .env.');
    err.codigo = 'SEM_CREDENCIAL';
    throw err;
  }

  const url = `${base}${caminho}`;
  // Timeout com AbortController + clearTimeout no finally. Evita deixar um
  // timer pendente depois da resposta (AbortSignal.timeout deixava, e isso
  // derrubava o processo no Windows com "Assertion failed ... uv_handle_closing"
  // quando o script terminava logo em seguida).
  const controlador = new AbortController();
  let estourou = false;
  const timer = setTimeout(() => { estourou = true; controlador.abort(); }, timeoutMs);

  let resp;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: cabecalhoBasic(usuario, senha),
        Accept: 'application/json',
      },
      signal: controlador.signal,
    });
  } catch (e) {
    const err = new Error(
      estourou
        ? `A API UDTP não respondeu em ${timeoutMs / 1000}s.`
        : `Não consegui falar com a API UDTP: ${e.message}`
    );
    err.codigo = estourou ? 'TIMEOUT' : 'FALHA_CONEXAO';
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 401) {
    const err = new Error('A API UDTP recusou as credenciais (401). Confira UDTP_API_USUARIO e UDTP_API_SENHA no .env.');
    err.codigo = 'NAO_AUTORIZADO';
    throw err;
  }
  if (resp.status === 403) {
    const err = new Error('Credencial aceita, mas sem permissão para este recurso na API UDTP (403).');
    err.codigo = 'SEM_PERMISSAO';
    throw err;
  }
  if (resp.status === 404) {
    const err = new Error('Recurso não encontrado na API UDTP (404).');
    err.codigo = 'NAO_ENCONTRADO';
    throw err;
  }
  if (!resp.ok) {
    const corpo = await resp.text().catch(() => '');
    const err = new Error(`A API UDTP respondeu ${resp.status}. ${corpo.slice(0, 300)}`);
    err.codigo = 'ERRO_API';
    throw err;
  }

  const texto = await resp.text();
  try {
    return texto ? JSON.parse(texto) : null;
  } catch {
    const err = new Error('A API UDTP respondeu algo que não é JSON válido.');
    err.codigo = 'RESPOSTA_INVALIDA';
    throw err;
  }
}

// Busca as reservas de uma data (AAAA-MM-DD).
async function buscarReservas(data) {
  const dia = normalizarData(data);
  return chamar(`/api/reservas/${dia}`);
}

// Busca o estoque POR LOTE de uma data (AAAA-MM-DD). É a fonte de lote,
// validade e unidade de medida — campos que a API de reservas não traz.
// Observado em 22/07/2026: ~8.4k linhas/dia, uma por lote; itens sem saldo
// vêm numa única linha com lote/validade nulos.
async function buscarEstoque(data) {
  const dia = normalizarData(data);
  return chamar(`/api/estoque/${dia}`);
}

module.exports = { buscarReservas, buscarEstoque, credenciaisConfiguradas, normalizarData };
