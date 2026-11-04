// Situação de ATA de um item, para a tela de Requisição de Compra.
//
// Cruza o SIAFÍSICO do item com o módulo de Atas de Registro de Preço (a foto
// mais recente, considerando só atas vigentes = sem vencimento OU vencimento
// ainda não passou) e com a MARCA do item no Estoque (SCODES), reproduzindo a
// mesma regra do Planejamento (planejamentoMotor.js):
//
//   sem ata vigente para o siafísico ............... SEM_ATA
//   ata vigente + marca "Sem Marca" (ou marca bate) .. ATA
//   ata vigente + marca divergente ................. AVALIACAO (técnico decide)
//
// Devolve, além da situação, os dados da ata para o card clicável (nome
// comercial, número da ata, detentor e vencimento).
const db = require('./db');

// Normaliza marca/nome-comercial para comparar: maiúsculas, sem acento, sem
// dosagem e sem pontuação. (Cópia da lógica do planejamentoMotor, de propósito,
// para os dois módulos poderem evoluir sem se acoplarem.)
function normMarca(s) {
  if (s === null || s === undefined) return '';
  let t = String(s).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  t = t.replace(/\b\d+([.,]\d+)?\s*(MG\/ML|MG\/G|MCG|MG|ML|G|UI|KG|L|%)\b/g, ' ');
  return t.replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Unidades de PESO/VOLUME. Nelas o número da apresentação é o conteúdo de UMA
// unidade (ex.: "LATA COM 400G" = uma lata de 400 g), NÃO um pacote de 400 itens.
// Por isso não viram múltiplo de arredondamento — comprar-se-ia de 400 em 400.
const UNID_CONTEUDO = new Set([
  'G', 'GR', 'GRAMA', 'GRAMAS', 'KG', 'MG', 'MCG', 'UI',
  'ML', 'L', 'LT', 'LITRO', 'LITROS', 'GAL', 'GALAO',
]);

// Deriva o tamanho da embalagem de compra a partir do texto da apresentação da
// ata (ex.: "APRESENTAÇÃO: CAIXA COM 10 UNIDADES" → 10). É mais confiável que o
// campo embalagem_secundaria, que às vezes é importado como 1 mesmo quando a
// caixa tem N unidades (caso real: toalha umedecida). Só conta quando a unidade
// é CONTÁVEL (UNIDADES, ROLOS, FRASCOS, BOLSAS, TIRAS…); para peso/volume devolve
// null. Também devolve null para N ausente ou ≤ 1 (sem agrupamento).
//
// Segurança: itens "duas peças" (bolsa + placa) trazem DUAS embalagens no mesmo
// texto (ex.: "CAIXA COM 30 UNIDADES (BOLSA) / CAIXA COM 05 UNIDADES (PLACA)").
// Nesse caso o texto é ambíguo e não dá para saber qual vale para a compra, então
// devolvemos null e deixamos o comportamento antigo (embalagem_secundaria) decidir.
function embalagemDaApresentacao(apresentacao) {
  if (!apresentacao) return null;
  const txt = String(apresentacao).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Kit "duas peças" (bolsa + placa): tem embalagens distintas e o texto às vezes
  // vem com um dos números faltando, furando a contagem de grupos — trata como
  // ambíguo direto pelos marcadores.
  if (txt.includes('BOLSA') && txt.includes('PLACA')) return null;
  const grupos = txt.match(/COM\s+0*\d+\s*[A-Z]+/g) || [];
  if (grupos.length !== 1) return null; // nenhuma ou ambígua (2+)
  const m = /COM\s+0*(\d+)\s*([A-Z]+)/.exec(grupos[0]);
  const n = parseInt(m[1], 10);
  if (!n || n <= 1) return null;
  if (UNID_CONTEUDO.has(m[2])) return null;
  return n;
}

// Marca do estoque atende à ata? "SEM MARCA"/sem marca => qualquer marca atende.
function marcasBatem(marcaEstoque, nomeAta) {
  const a = normMarca(marcaEstoque);
  if (!a || a === 'SEM MARCA') return true;
  const b = normMarca(nomeAta);
  if (!b) return false;
  if (a === b) return true;
  if (b.startsWith(a) || a.startsWith(b)) return true;
  return (' ' + b + ' ').includes(' ' + a + ' ') || (' ' + a + ' ').includes(' ' + b + ' ');
}

// Cria um calculador com cache por código de item (a mesma situação vale para
// todos os pacientes de um mesmo medicamento — essencial quando um item tem
// milhares de pacientes na coletiva). Reaproveita os prepared statements.
function criarCalculadoraAta() {
  const hoje = new Date().toISOString().slice(0, 10);
  const dataRefAtas = db.prepare('SELECT MAX(data_referencia) v FROM atas_itens').get()?.v || null;

  const qMarca = db.prepare(
    "SELECT marca FROM estoque_itens WHERE codigo_item = ? AND (unidade IS NULL OR unidade LIKE '%Tenente Pena%') ORDER BY data_referencia DESC LIMIT 1"
  );
  const qAta = dataRefAtas ? db.prepare(`
    SELECT ata, vencimento, nome_comercial, detentor_registro, ultimo_valor_publicado,
           embalagem_secundaria, apresentacao
      FROM atas_itens
     WHERE data_referencia = ? AND siafisico = ?
       AND (vencimento IS NULL OR vencimento >= ?)
     ORDER BY (vencimento IS NULL), vencimento DESC
     LIMIT 1
  `) : null;

  const cache = new Map();

  return function situacaoAta(codigoItem, codSiafisico) {
    const chave = String(codigoItem ?? '') + '|' + String(codSiafisico ?? '');
    if (cache.has(chave)) return cache.get(chave);

    const siaf = codSiafisico != null ? String(codSiafisico).trim() : '';
    let resultado;
    const ata = (qAta && siaf) ? qAta.get(dataRefAtas, siaf, hoje) : null;
    if (!ata) {
      resultado = { situacao: 'SEM_ATA', ata_numero: null, vencimento: null, nome_comercial: null, detentor: null };
    } else {
      const marca = qMarca.get(codigoItem)?.marca || null;
      const situacao = marcasBatem(marca, ata.nome_comercial) ? 'ATA' : 'AVALIACAO';
      resultado = {
        situacao,
        ata_numero: ata.ata || null,
        vencimento: ata.vencimento || null,
        nome_comercial: ata.nome_comercial || null,
        detentor: ata.detentor_registro || null,
        valor: (ata.ultimo_valor_publicado != null && Number(ata.ultimo_valor_publicado) > 0)
          ? Number(ata.ultimo_valor_publicado) : null,
        // Qtd por embalagem de compra = múltiplo de arredondamento da aquisição
        // para itens em ATA. Fonte preferida: o texto da apresentação ("CAIXA
        // COM N UNIDADES"), que é mais confiável que embalagem_secundaria (ver
        // embalagemDaApresentacao). Cai para a secundária só quando a apresentação
        // não informa. Null → sem agrupamento (arredonda ao inteiro no front).
        embalagem: embalagemDaApresentacao(ata.apresentacao)
          || (Number(ata.embalagem_secundaria) > 1 ? Number(ata.embalagem_secundaria) : null),
        marca_estoque: marca,
      };
    }
    cache.set(chave, resultado);
    return resultado;
  };
}

module.exports = { criarCalculadoraAta, marcasBatem };
