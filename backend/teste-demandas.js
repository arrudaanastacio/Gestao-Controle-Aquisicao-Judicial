// =====================================================================
// teste-demandas.js
// Roda a query de demandas via Node pela primeira vez, no modo Tenente Pena.
// Objetivo: confirmar que a query completa executa (funções Fcn_*, joins,
// subconsulta de dispensações) e ver uma amostra dos dados.
//
// Uso:  node teste-demandas.js
// =====================================================================
const { buscarDemandasTenentePena } = require('./oracle/demandas');
const { fecharPool } = require('./oracle/db-oracle');

async function main() {
  console.time('consulta');
  try {
    const dados = await buscarDemandasTenentePena();
    console.timeEnd('consulta');

    console.log(`\nTotal de linhas (Tenente Pena): ${dados.length}\n`);

    if (dados.length > 0) {
      console.log('Colunas retornadas:');
      console.log(Object.keys(dados[0]).join(', '));

      console.log('\nPrimeiras 3 linhas:');
      console.table(dados.slice(0, 3));

      // Conferência de duplicidade de demanda (mesmo ID_Demanda em várias linhas
      // é esperado no nível-item, pois uma demanda pode ter vários itens)
      const ids = new Set(dados.map((d) => d.ID_Demanda));
      console.log(`\nDemandas distintas: ${ids.size}  |  Linhas (itens): ${dados.length}`);
    } else {
      console.log('A query rodou mas não retornou linhas. Verificar filtros/período.');
    }
  } catch (err) {
    console.timeEnd('consulta');
    console.error('\nERRO ao executar a query:');
    console.error(err.message);
    console.error('\nSe for erro de coluna/função (ORA-00904, PLS-00201), me avise o texto exato.');
  } finally {
    await fecharPool();
  }
}

main();
