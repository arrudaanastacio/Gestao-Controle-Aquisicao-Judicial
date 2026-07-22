// =====================================================================
// reservasUdtp.js
// Importa as RESERVAS da API UDTP para o banco, como foto datada.
//
// Reserva = quantidade que está no estoque mas já foi separada para um
// paciente. Serve para calcular o DISPONÍVEL REAL (estoque - reservado).
// A ligação com o resto do sistema é pelo CÓDIGO SCODES.
//
// Os nomes dos campos vindos da API ainda não foram confirmados (a API exige
// credencial). Por isso o mapeamento é TOLERANTE: normaliza a chave (sem
// acento, sem maiúscula, sem pontuação) e aceita variações comuns. O resumo
// devolve `camposNaoMapeados`, para ajustar rapidamente quando virmos o dado
// real — mesma filosofia dos importadores de planilha do projeto.
// =====================================================================
const db = require('./db');
const { buscarReservas, normalizarData } = require('./udtpApi');

// "Código SCODES" -> "codigoscodes"
function normalizarChave(k) {
  return String(k)
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // tira acento
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Para cada campo do nosso banco, os nomes que aceitamos vindos da API.
const SINONIMOS = {
  codigo_scodes: ['codigoscodes', 'scodes', 'codscodes', 'codigoscode', 'codigo', 'codigoproduto', 'codigoitem', 'codigomedicamento'],
  descricao: ['nomemedicamento', 'nomedomedicamento', 'medicamento', 'descricao', 'descricaoitem', 'nome', 'produto'],
  lote: ['lote', 'numerolote', 'nrolote', 'numlote'],
  validade: ['validade', 'datavalidade', 'dtvalidade', 'vencimento', 'datavencimento', 'dtvencimento'],
  quantidade: ['quantidade', 'qtd', 'qtde', 'qt', 'quantidadereservada', 'qtdreservada', 'quantidadeseparada'],
  unidade: ['unidade', 'unidademedida', 'und', 'unid', 'um', 'embalagem'],
};

// Converte número em formato brasileiro ou americano para Number.
function paraNumero(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let t = String(v).trim().replace(/\s/g, '');
  if (t.includes(',')) {
    // Formato brasileiro com decimal: "1.234,56" -> "1234.56" | "1234,56" -> "1234.56"
    t = t.replace(/\./g, '').replace(',', '.');
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) {
    // Só pontos, sempre com 3 dígitos depois: é separador de MILHAR, não decimal.
    // "1.200" -> 1200 (e não 1.2), "12.345.678" -> 12345678.
    // Cuidado: "1.5" ou "1.20" não casam aqui e seguem como decimal.
    t = t.replace(/\./g, '');
  }
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

// Aceita "2027-05-31", "31/05/2027" e ISO com hora. Devolve yyyy-mm-dd.
function paraDataISO(v) {
  if (!v) return null;
  const t = String(v).trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(t);
  if (!isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return null;
}

// Achata um registro que possa vir com um nível de objeto aninhado, para que
// { medicamento: { nome, scodes } } também seja reconhecido.
function achatar(reg) {
  const plano = {};
  for (const [k, v] of Object.entries(reg || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) {
        if (v2 === null || typeof v2 !== 'object') plano[`${k}.${k2}`] = v2;
      }
    } else {
      plano[k] = v;
    }
  }
  return plano;
}

// Mapeia um registro da API para as colunas do banco.
// Devolve { linha, usados } — `usados` são as chaves originais aproveitadas.
function mapearRegistro(regBruto) {
  const reg = achatar(regBruto);
  const porChaveNormalizada = new Map();
  for (const k of Object.keys(reg)) {
    // Para "medicamento.nome", tenta tanto o caminho todo quanto a última parte.
    const ultima = k.includes('.') ? k.split('.').pop() : k;
    porChaveNormalizada.set(normalizarChave(k), k);
    if (!porChaveNormalizada.has(normalizarChave(ultima))) {
      porChaveNormalizada.set(normalizarChave(ultima), k);
    }
  }

  const linha = {};
  const usados = new Set();
  for (const [campo, nomes] of Object.entries(SINONIMOS)) {
    for (const nome of nomes) {
      if (porChaveNormalizada.has(nome)) {
        const chaveOriginal = porChaveNormalizada.get(nome);
        linha[campo] = reg[chaveOriginal];
        usados.add(chaveOriginal);
        break;
      }
    }
    if (!(campo in linha)) linha[campo] = null;
  }

  linha.quantidade = paraNumero(linha.quantidade);
  linha.validade = paraDataISO(linha.validade);
  for (const c of ['codigo_scodes', 'descricao', 'lote', 'unidade']) {
    linha[c] = linha[c] === null || linha[c] === undefined ? null : String(linha[c]).trim();
  }

  const naoUsados = Object.keys(reg).filter((k) => !usados.has(k));
  return { linha, naoUsados };
}

// Extrai a lista de registros, tolerando resposta paginada do Spring
// ({ content: [...] }) ou lista pura.
function extrairLista(dados) {
  if (Array.isArray(dados)) return dados;
  if (dados && Array.isArray(dados.content)) return dados.content;
  if (dados && Array.isArray(dados.reservas)) return dados.reservas;
  return null;
}

// Grava a foto do dia. Refaz a data (apaga e reinsere) — a API é a fonte da
// verdade para aquele dia, mesmo padrão do "refazer o mês" das solicitações.
function gravarSnapshot(dataISO, registros, usuarioEmail) {
  const camposNaoMapeados = new Set();
  const linhas = [];
  for (const r of registros) {
    const { linha, naoUsados } = mapearRegistro(r);
    naoUsados.forEach((c) => camposNaoMapeados.add(c));
    linhas.push(linha);
  }

  const gravar = db.transaction(() => {
    const antigas = db.prepare('SELECT id FROM reservas_importacoes WHERE data_referencia = ?').all(dataISO);
    for (const a of antigas) {
      db.prepare('DELETE FROM reservas_itens WHERE importacao_id = ?').run(a.id);
      db.prepare('DELETE FROM reservas_importacoes WHERE id = ?').run(a.id);
    }

    const info = db.prepare(
      'INSERT INTO reservas_importacoes (data_referencia, origem, usuario_email, total_itens) VALUES (?, ?, ?, ?)'
    ).run(dataISO, 'API UDTP', usuarioEmail || 'sistema', linhas.length);
    const importacaoId = info.lastInsertRowid;

    const ins = db.prepare(`
      INSERT INTO reservas_itens
        (importacao_id, data_referencia, codigo_scodes, descricao, lote, validade, quantidade, unidade)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const l of linhas) {
      ins.run(importacaoId, dataISO, l.codigo_scodes, l.descricao, l.lote, l.validade, l.quantidade, l.unidade);
    }
    return importacaoId;
  });

  const importacaoId = gravar();

  // Quantos registros ficaram sem a chave de ligação — sinal de mapeamento errado.
  const semCodigo = linhas.filter((l) => !l.codigo_scodes).length;
  return {
    dataReferencia: dataISO,
    importacaoId,
    totalRegistros: linhas.length,
    semCodigoScodes: semCodigo,
    camposNaoMapeados: [...camposNaoMapeados],
  };
}

// Busca na API e grava. Retorna o resumo da importação.
async function importarReservasDoDia(data, usuarioEmail) {
  const dataISO = normalizarData(data);
  const dados = await buscarReservas(dataISO);
  const lista = extrairLista(dados);
  if (!lista) {
    const err = new Error('A API de Reservas devolveu um formato inesperado (não é lista nem {content:[...]}).');
    err.codigo = 'FORMATO_INESPERADO';
    throw err;
  }
  const resumo = gravarSnapshot(dataISO, lista, usuarioEmail);
  db.prepare(
    'INSERT INTO importacoes (tipo, nome_arquivo, usuario_email, resumo) VALUES (?, ?, ?, ?)'
  ).run('reservas', 'API UDTP', usuarioEmail || 'sistema', JSON.stringify(resumo));
  return resumo;
}

module.exports = {
  importarReservasDoDia,
  gravarSnapshot,   // exportado para teste sem rede
  mapearRegistro,
  extrairLista,
  paraNumero,
  paraDataISO,
};
