// Teste manual do cliente SISCOA: faz login, baixa o relatório de Atas e
// mostra um resumo do que veio (sem gravar nada no banco).
//
// Rode a partir da pasta backend, com o .env preenchido:
//   node src/testarSiscoa.js
//   node src/testarSiscoa.js --salvar   (grava o XLS baixado em data/ para conferir)
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { baixarRelatorioAtas, credenciaisConfiguradas } = require('./siscoaApi');

(async () => {
  if (!credenciaisConfiguradas()) {
    console.log('❌ Credenciais não configuradas. Preencha SISCOA_USUARIO e SISCOA_SENHA no .env.');
    process.exit(1);
  }
  console.log('→ Autenticando e baixando o relatório de Atas do SISCOA...');
  try {
    const { buffer, contentType, tamanho } = await baixarRelatorioAtas();
    console.log(`✔ Download OK: ${tamanho} bytes (content-type: ${contentType || 'n/d'}).`);

    // Tenta abrir como planilha e contar linhas/abas, só para conferência.
    const wb = XLSX.read(buffer, { type: 'buffer' });
    console.log('  Abas:', wb.SheetNames.join(', '));
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const linhas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });
    console.log(`  Linhas na 1ª aba: ${linhas.length}`);
    if (linhas[0]) console.log('  1ª linha (cabeçalho?):', linhas[0].slice(0, 12));
    if (linhas[1]) console.log('  2ª linha (dados?):    ', linhas[1].slice(0, 12));

    if (process.argv.includes('--salvar')) {
      const destino = path.join(__dirname, '..', 'data', `atas-siscoa-teste-${Date.now()}.xls`);
      fs.writeFileSync(destino, buffer);
      console.log('  Arquivo salvo em:', destino);
    }
    console.log('\n✅ Funcionou. O próximo passo é ligar isso no importador de Atas.');
  } catch (e) {
    console.log(`❌ Falhou (${e.codigo || 'ERRO'}): ${e.message}`);
    process.exit(1);
  }
})();
