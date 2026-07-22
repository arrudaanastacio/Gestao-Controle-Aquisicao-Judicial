// Testa o mapeador de reservas SEM tocar no banco real: injeta um dublê de
// './db' no cache de módulos antes de carregar o reservasUdtp.
const path = require('path');
const SRC = __dirname;

const caminhoDb = require.resolve(path.join(SRC, 'db.js'));
require.cache[caminhoDb] = { id: caminhoDb, filename: caminhoDb, loaded: true, exports: {
  prepare: () => ({ run: () => ({}), get: () => null, all: () => [] }),
  transaction: (fn) => fn,
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
ok('texto BR milhar', 1234.56, paraNumero('1.234,56'));
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

console.log('\n--- mapearRegistro: nomes em portugues com acento ---');
const r1 = mapearRegistro({
  'Código Scodes': '123456',
  'Nome do Medicamento': 'DIPIRONA 500MG',
  'Lote': 'ABC123',
  'Validade': '31/05/2027',
  'Quantidade': '1.200',
  'Unidade': 'COMPRIMIDO',
});
ok('r1 linha', {
  codigo_scodes: '123456', descricao: 'DIPIRONA 500MG', lote: 'ABC123',
  validade: '2027-05-31', quantidade: 1200, unidade: 'COMPRIMIDO',
}, r1.linha);
ok('r1 nada sobrando', [], r1.naoUsados);

console.log('\n--- mapearRegistro: camelCase (estilo Spring/JSON) ---');
const r2 = mapearRegistro({
  codigoScodes: 654321,
  nomeMedicamento: 'OMEPRAZOL 20MG',
  lote: 'L99',
  dataValidade: '2026-12-01',
  quantidade: 50,
  unidadeMedida: 'CAPSULA',
});
ok('r2 linha', {
  codigo_scodes: '654321', descricao: 'OMEPRAZOL 20MG', lote: 'L99',
  validade: '2026-12-01', quantidade: 50, unidade: 'CAPSULA',
}, r2.linha);

console.log('\n--- mapearRegistro: objeto aninhado ---');
const r3 = mapearRegistro({
  medicamento: { scodes: '777', nome: 'INSULINA' },
  lote: 'X1', validade: '2028-01-15', qtde: 3, und: 'FRASCO',
});
ok('r3 linha', {
  codigo_scodes: '777', descricao: 'INSULINA', lote: 'X1',
  validade: '2028-01-15', quantidade: 3, unidade: 'FRASCO',
}, r3.linha);

console.log('\n--- mapearRegistro: campo desconhecido eh reportado ---');
const r4 = mapearRegistro({ codigoScodes: '1', campoEstranho: 'x', outro: 9 });
ok('r4 reporta nao mapeados', ['campoEstranho', 'outro'], r4.naoUsados.sort());
ok('r4 faltantes viram null', [null, null, null, null, null],
  [r4.linha.descricao, r4.linha.lote, r4.linha.validade, r4.linha.quantidade, r4.linha.unidade]);

console.log(`\n===== ${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : falhas + ' TESTE(S) FALHARAM'} =====\n`);
process.exitCode = falhas === 0 ? 0 : 1;
