// Testa o mapeador de reservas SEM tocar no banco real nem na rede:
// injeta um dublê de './db' no cache de módulos antes de carregar o
// reservasUdtp. Rode com:  node src/testarMapeadorReservas.js
const path = require('path');
const SRC = __dirname;

const caminhoDb = require.resolve(path.join(SRC, 'db.js'));
// O dublê imita a superfície REAL do node:sqlite (prepare/exec). Note que
// NÃO existe db.transaction() — isso é do better-sqlite3. Manter o dublê fiel
// evita que o teste "passe" usando um método que não existe em produção.
require.cache[caminhoDb] = { id: caminhoDb, filename: caminhoDb, loaded: true, exports: {
  prepare: () => ({ run: () => ({}), get: () => null, all: () => [] }),
  exec: () => {},
} };

const { mapearRegistro, extrairLista, paraNumero, paraDataISO } = require(path.join(SRC, 'reservasUdtp.js'));

let falhas = 0;
function ok(nome, esperado, obtido) {
  const bateu = JSON.stringify(esperado) === JSON.stringify(obtido);
  if (!bateu) falhas++;
  console.log(`${bateu ? '  OK  ' : ' FALHA'} ${nome}${bateu ? '' : `\n        esperado: ${JSON.stringify(esperado)}\n        obtido:   ${JSON.stringify(obtido)}`}`);
}

console.log('\n--- paraNumero ---');
ok('inteiro', 12, paraNumero(12));
ok('texto BR milhar+decimal', 1234.56, paraNumero('1.234,56'));
ok('texto BR decimal', 1234.56, paraNumero('1234,56'));
ok('texto US', 1234.56, paraNumero('1234.56'));
ok('vazio', null, paraNumero(''));
ok('lixo', null, paraNumero('abc'));
ok('milhar BR sem decimal "1.200"', 1200, paraNumero('1.200'));
ok('milhar BR duplo "12.345.678"', 12345678, paraNumero('12.345.678'));
ok('decimal US curto "1.5" segue 1.5', 1.5, paraNumero('1.5'));
ok('decimal US "1.20" segue 1.2', 1.2, paraNumero('1.20'));
ok('zero', 0, paraNumero(0));

console.log('\n--- paraDataISO ---');
ok('ISO puro', '2027-05-31', paraDataISO('2027-05-31'));
ok('ISO com hora', '2027-05-31', paraDataISO('2027-05-31T00:00:00-03:00'));
ok('BR', '2027-05-31', paraDataISO('31/05/2027'));
ok('nulo', null, paraDataISO(null));

console.log('\n--- extrairLista ---');
ok('lista pura', 2, (extrairLista([{}, {}]) || []).length);
ok('paginado Spring', 1, (extrairLista({ content: [{}] }) || []).length);
ok('campo reservas', 1, (extrairLista({ reservas: [{}] }) || []).length);
ok('formato ruim', null, extrairLista({ algo: 1 }));

console.log('\n--- mapearRegistro: campos REAIS da API (confirmados 22/07/2026) ---');
const r1 = mapearRegistro({
  codigoItem: '1R33252/28/78620/04/30823',
  codigoProtocolo: '02123456789012345',
  descricao: 'DIPIRONA SODICA 500MG COMPRIMIDO',
  recebedor: 'Fulano de Tal da Silva',
  saldoReservado: 336,
});
ok('r1 linha', {
  codigo_item: '1R33252/28/78620/04/30823',
  codigo_protocolo: '02123456789012345',
  descricao: 'DIPIRONA SODICA 500MG COMPRIMIDO',
  recebedor: 'Fulano de Tal da Silva',
  saldo_reservado: 336,
}, r1.linha);
ok('r1 nada sobrando', [], r1.naoUsados);

console.log('\n--- mapearRegistro: nomes alternativos (tolerância) ---');
const r2 = mapearRegistro({
  'Código Item': 'X1',
  'Protocolo': 'P9',
  'Nome do Medicamento': 'OMEPRAZOL 20MG',
  'Paciente': 'Beltrano de Souza',
  'Quantidade': '1.200',
});
ok('r2 linha', {
  codigo_item: 'X1', codigo_protocolo: 'P9', descricao: 'OMEPRAZOL 20MG',
  recebedor: 'Beltrano de Souza', saldo_reservado: 1200,
}, r2.linha);

console.log('\n--- mapearRegistro: objeto aninhado ---');
const r3 = mapearRegistro({
  medicamento: { codigoItem: '777', descricao: 'INSULINA' },
  recebedor: 'Ciclano', saldoReservado: 3,
});
ok('r3 linha', {
  codigo_item: '777', codigo_protocolo: null, descricao: 'INSULINA',
  recebedor: 'Ciclano', saldo_reservado: 3,
}, r3.linha);

console.log('\n--- mapearRegistro: campo novo da API é reportado ---');
const r4 = mapearRegistro({ codigoItem: '1', campoNovoDaApi: 'x', outro: 9 });
ok('r4 reporta não mapeados', ['campoNovoDaApi', 'outro'], r4.naoUsados.sort());
ok('r4 faltantes viram null', [null, null, null, null],
  [r4.linha.codigo_protocolo, r4.linha.descricao, r4.linha.recebedor, r4.linha.saldo_reservado]);

console.log(`\n===== ${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : falhas + ' TESTE(S) FALHARAM'} =====\n`);
process.exitCode = falhas === 0 ? 0 : 1;
