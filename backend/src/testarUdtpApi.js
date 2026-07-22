// =====================================================================
// testarUdtpApi.js — diagnóstico da integração com a API de Reservas UDTP.
//
// Uso:
//   node src/testarUdtpApi.js                 (usa a data de hoje)
//   node src/testarUdtpApi.js 2020-12-14      (data específica)
//   node src/testarUdtpApi.js 2020-12-14 --completo
//
// Por padrão os VALORES são MASCARADOS: o objetivo é descobrir a ESTRUTURA
// (quais campos existem e de que tipo), sem despejar dado pessoal de paciente
// na tela ou em log. Use --completo só se precisar ver o conteúdo real, e
// evite colar o resultado completo em lugares públicos.
// =====================================================================
require('dotenv').config();
const { buscarReservas, credenciaisConfiguradas } = require('./udtpApi');

const MOSTRAR_TUDO = process.argv.includes('--completo');

function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function tipoDe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `lista[${v.length}]`;
  return typeof v;
}

// Mostra o valor de forma segura: números/booleanos inteiros, textos mascarados.
function amostra(v) {
  if (MOSTRAR_TUDO) return JSON.stringify(v);
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') {
    // Datas ISO não são dado pessoal — mostra inteiras, ajudam a entender o formato.
    if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(v)) return v;
    if (v.length <= 2) return '"' + '*'.repeat(v.length) + '"';
    return `"${v.slice(0, 2)}${'*'.repeat(Math.min(v.length - 2, 8))}" (${v.length} chars)`;
  }
  if (Array.isArray(v)) return `lista com ${v.length} item(ns)`;
  if (typeof v === 'object') return `objeto com campos: ${Object.keys(v).join(', ')}`;
  return '?';
}

function descreverRegistro(reg, indent = '  ') {
  for (const [k, v] of Object.entries(reg)) {
    console.log(`${indent}${k.padEnd(28)} ${tipoDe(v).padEnd(12)} ${amostra(v)}`);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      descreverRegistro(v, indent + '    ');
    } else if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null) {
      console.log(`${indent}    -- estrutura do 1o item da lista --`);
      descreverRegistro(v[0], indent + '    ');
    }
  }
}

(async () => {
  const data = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || hojeISO();

  console.log('==========================================================');
  console.log('  Diagnóstico da API de Reservas UDTP');
  console.log('==========================================================');
  console.log('Data consultada:', data);
  console.log('Credenciais no .env:', credenciaisConfiguradas() ? 'configuradas ✔' : 'NÃO configuradas ✘');
  console.log('Modo:', MOSTRAR_TUDO ? 'COMPLETO (valores reais)' : 'MASCARADO (só estrutura)');
  console.log('');

  if (!credenciaisConfiguradas()) {
    console.log('Para configurar, adicione ao backend/.env (NÃO comitar):');
    console.log('  UDTP_API_URL=https://api.udtp.org.br');
    console.log('  UDTP_API_USUARIO=seu_usuario');
    console.log('  UDTP_API_SENHA=sua_senha');
    process.exitCode = 1; // sem process.exit(): deixa o Node encerrar limpo
    return;
  }

  try {
    const inicio = Date.now();
    const dados = await buscarReservas(data);
    const ms = Date.now() - inicio;
    console.log(`✔ Conexão OK — resposta em ${ms} ms.`);
    console.log('');

    const lista = Array.isArray(dados) ? dados : (dados && Array.isArray(dados.content) ? dados.content : null);

    if (lista) {
      console.log(`Formato: LISTA com ${lista.length} registro(s).`);
      if (!Array.isArray(dados)) console.log('(a lista veio dentro do campo "content" — paginação estilo Spring)');
      if (lista.length === 0) {
        console.log('Nenhuma reserva nesta data. Tente outra data para ver a estrutura.');
      } else {
        console.log('');
        console.log('--- Estrutura do 1o registro (campo | tipo | amostra) ---');
        descreverRegistro(lista[0]);
      }
    } else if (dados && typeof dados === 'object') {
      console.log('Formato: OBJETO. Campos do topo:');
      console.log('');
      descreverRegistro(dados);
    } else {
      console.log('Resposta inesperada:', tipoDe(dados));
    }
    console.log('');
    console.log('==========================================================');
  } catch (e) {
    console.error(`✘ Falhou [${e.codigo || 'ERRO'}]: ${e.message}`);
    process.exitCode = 1; // sem process.exit(): deixa o Node encerrar limpo
  }
})();
