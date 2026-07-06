// =====================================================================
// sync-demandas.js
// Roda a query de demandas judiciais (todas as unidades) no Oracle do
// SCODES e grava o resultado como "Listagem de Autores.csv" no caminho
// que o vigiaAutores.js já monitora (src/vigiaAutores.js, polling a
// cada VIGIA_INTERVALO_MS). O vigia detecta o arquivo novo sozinho e
// chama importarAutoresDeBuffer() — mesmo pipeline usado hoje para a
// importação manual, com toda a lógica de comparação de versões já
// pronta em routes.autores.js. Este script não grava em nenhuma tabela
// diretamente e não precisa de nenhuma rota nova no server.js.
//
// Uso:      node sync-demandas.js
// Agendado: sync-demandas.bat, via Agendador de Tarefas do Windows, 6h.
//
// Escrita atômica: grava primeiro em um arquivo temporário na mesma
// pasta e só then renomeia para o nome final, para o vigia nunca pegar
// um arquivo pela metade.
// =====================================================================
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { buscarDemandas } = require('./oracle/demandas');
const { fecharPool } = require('./oracle/db-oracle');

// Mesmo caminho e mesma variável de ambiente que src/vigiaAutores.js usa,
// para que o arquivo gerado aqui seja o mesmo que ele já monitora.
const CAMINHO_PADRAO =
  'G:\\CAF\\GAF\\GGAF\\PROGRAMAÇÃO\\CPDAE\\RELATÓRIO DE COMPRAS\\2026\\MEDICAMENTO\\MACRO\\Listagem de Autores.csv';
const CAMINHO_CSV = process.env.CAMINHO_AUTORES_CSV || CAMINHO_PADRAO;

// Ordem e nomes de coluna do CSV. Os nomes batem com o MAPA de
// routes.autores.js depois de normalizar() (. e _ viram espaço, minúsculas).
// Colunas do MAPA que a query não traz (idade, dt_nascimento, status_item,
// etc.) simplesmente não aparecem — o parser aceita isso (fica null).
const CABECALHO = [
  'Unid.Dispensadora',
  'Unid. Organizacional',
  'ID Demanda',
  'Autor',
  'Protocolo',
  'Processo',
  'Status da Demanda',
  'Tipo da Demanda',
  'Data Inclusão na OD',
  'Cód Item',
  'Descrição do Item',
  'Qtdade de Consumo',
  'Dispensações',
  'Periodicidade',
  'Prazo',
  'Dispensações Autorizadas',
  'Categoria',
  'Data Última Dispensação',
  'Data Último Retorno',
  'Cod.SIAFISICO',
];

// Chaves correspondentes vindas do Oracle (aliases da query-demandas.sql)
const CHAVES_ORACLE = [
  'Unid_Dispensadora',
  'Unid_Organizacional',
  'ID_Demanda',
  'Autor',
  'Protocolo',
  'Processo',
  'Status_da_Demanda',
  'Tipo_da_Demanda',
  'Data_Inclusao_na_OD',
  'Cod_Item',
  'Descricao_do_Item',
  'Qtdade_de_Consumo',
  'Dispensacoes',
  'Periodicidade',
  'Prazo',
  'Dispensacoes_Autorizadas',
  'Categoria',
  'Data_Ultima_Dispensacao',
  'Data_Ultimo_Retorno',
  'Cod_SIAFISICO',
];

function gerarCsvBuffer(linhas) {
  const aoa = [CABECALHO];
  for (const linha of linhas) {
    aoa.push(CHAVES_ORACLE.map((chave) => linha[chave] ?? ''));
  }
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Autores');
  return XLSX.write(wb, { type: 'buffer', bookType: 'csv' });
}

async function main() {
  console.log(`[sync] início: ${new Date().toISOString()}`);
  console.time('[sync] tempo total');

  console.log('[sync] consultando Oracle (todas as unidades)... isso pode levar ~15 min');
  console.time('[sync] tempo Oracle');
  const linhas = await buscarDemandas({ undId: null });
  console.timeEnd('[sync] tempo Oracle');
  console.log(`[sync] ${linhas.length} linhas recebidas do Oracle`);

  if (linhas.length === 0) {
    console.warn('[sync] AVISO: a query retornou 0 linhas. Abortando para não sobrescrever o CSV existente com um arquivo vazio.');
    await fecharPool();
    process.exitCode = 1;
    return;
  }

  console.log('[sync] gerando CSV...');
  const buffer = gerarCsvBuffer(linhas);

  const pastaDestino = path.dirname(CAMINHO_CSV);
  if (!fs.existsSync(pastaDestino)) {
    throw new Error(`Pasta de destino não encontrada: ${pastaDestino}. Verifique se o drive de rede está montado.`);
  }

  // Escrita atômica: grava em arquivo temporário na MESMA pasta (garante
  // que o rename seja atômico, sem cruzar volumes) e só então renomeia.
  const caminhoTemp = path.join(pastaDestino, `.tmp-listagem-autores-${process.pid}.csv`);
  fs.writeFileSync(caminhoTemp, buffer);
  fs.renameSync(caminhoTemp, CAMINHO_CSV);

  console.log(`[sync] CSV gravado em: ${CAMINHO_CSV} (${buffer.length} bytes, ${linhas.length} linhas)`);
  console.log('[sync] o vigiaAutores.js do servidor deve detectar e importar em até ' +
    `${Math.round((parseInt(process.env.VIGIA_INTERVALO_MS, 10) || 30000) / 1000)}s, se o servidor estiver rodando.`);

  await fecharPool();
  console.timeEnd('[sync] tempo total');
  console.log(`[sync] fim: ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error('[sync] ERRO FATAL:', err.message);
  process.exit(1);
});
