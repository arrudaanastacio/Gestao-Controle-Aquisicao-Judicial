// ---------------------------------------------------------------------------
// servico-windows.js — instala/remove o sistema como SERVIÇO do Windows.
//
// Por quê: hoje o sistema depende de uma janela .bat aberta. Se fechar ou o PC
// reiniciar, cai até alguém reabrir. Como serviço, o Windows sobe o sistema
// sozinho ao ligar a máquina, reinicia sozinho se travar, e roda invisível em
// segundo plano (sem janela preta).
//
// O MESMO arquivo serve para produção e homologação: ele lê o .env da pasta e
// nomeia o serviço conforme o ambiente, criando DOIS serviços distintos que
// nunca se atropelam:
//   - produção  (NODE_ENV=production) -> "ComprasJudiciais"
//   - homologação (qualquer outro)    -> "ComprasJudiciaisHomolog"
//
// Uso (sempre como Administrador — os .bat fazem a elevação sozinhos):
//   node src/servico-windows.js instalar     (cria e liga o serviço)
//   node src/servico-windows.js desinstalar   (remove o serviço)
//   node src/servico-windows.js iniciar        (liga um serviço já instalado)
//   node src/servico-windows.js parar          (desliga sem remover)
// ---------------------------------------------------------------------------

const path = require('path');

// Carrega o .env da RAIZ do backend (uma pasta acima de /src), para conhecer
// NODE_ENV e PORT independentemente de onde o serviço for iniciado pelo Windows.
const raizBackend = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(raizBackend, '.env') });

const ehProducao = (process.env.NODE_ENV || '').toLowerCase() === 'production';
const porta = process.env.PORT || (ehProducao ? '3000' : '3001');

// Nome interno do serviço (sem espaços/acentos — é o "id" no Windows) e o
// rótulo amigável que aparece no painel de Serviços (services.msc).
const nomeServico = ehProducao ? 'ComprasJudiciais' : 'ComprasJudiciaisHomolog';
const rotulo = ehProducao
  ? 'Controle de Compras Judiciais'
  : 'Compras Judiciais (HOMOLOGACAO)';
const descricao = ehProducao
  ? `Sistema de Controle de Compras Judiciais - Tenente Pena (producao, porta ${porta}). Sobe sozinho ao ligar o computador.`
  : `Sistema de Controle de Compras Judiciais - AMBIENTE DE TESTE (homologacao, porta ${porta}).`;

const { Service } = require('node-windows');

const svc = new Service({
  name: nomeServico,
  description: descricao,
  script: path.join(__dirname, 'server.js'),
  // Garante que o server.js e o dotenv rodem a partir da raiz do backend,
  // encontrando o .env e o caminho do banco de dados corretamente.
  workingDirectory: raizBackend,
  // Se o processo cair, o Windows aguarda 2s e reinicia (até estabilizar).
  wait: 2,
  grow: 0.5,
  maxRestarts: 40,
  // Repassa o ambiente para o processo do serviço (o dotenv por caminho já
  // cobre o resto, mas deixamos explícito para o painel de Serviços).
  env: [
    { name: 'NODE_ENV', value: process.env.NODE_ENV || 'producao' },
    { name: 'PORT', value: String(porta) },
  ],
});

// O node-windows fala com o Windows por eventos. Amarramos mensagens claras.
svc.on('install', () => {
  console.log(`\n[OK] Servico "${rotulo}" instalado.`);
  console.log('     Iniciando o servico agora...');
  svc.start();
});
svc.on('alreadyinstalled', () => {
  console.log(`\n[i] O servico "${rotulo}" ja estava instalado. Nada a fazer.`);
});
svc.on('start', () => {
  console.log(`\n[OK] Servico "${rotulo}" iniciado e no ar em http://localhost:${porta}`);
  console.log('     A partir de agora ele sobe sozinho quando o computador liga.');
  process.exit(0);
});
svc.on('stop', () => {
  console.log(`\n[OK] Servico "${rotulo}" parado.`);
});
svc.on('uninstall', () => {
  console.log(`\n[OK] Servico "${rotulo}" removido do Windows.`);
  console.log('     (O sistema volta a ser iniciado pelo .bat, se voce quiser.)');
  process.exit(0);
});
svc.on('error', (e) => {
  console.error('\n[ERRO] Falha no gerenciamento do servico:', e && e.message ? e.message : e);
  process.exit(1);
});

const comando = (process.argv[2] || '').toLowerCase();

switch (comando) {
  case 'instalar':
  case 'install':
    console.log(`Instalando o servico "${rotulo}" (porta ${porta})...`);
    svc.install();
    break;
  case 'desinstalar':
  case 'uninstall':
  case 'remover':
    console.log(`Removendo o servico "${rotulo}"...`);
    svc.uninstall();
    break;
  case 'iniciar':
  case 'start':
    console.log(`Iniciando o servico "${rotulo}"...`);
    svc.start();
    break;
  case 'parar':
  case 'stop':
    console.log(`Parando o servico "${rotulo}"...`);
    svc.stop();
    break;
  default:
    console.log('Comando nao reconhecido. Use um destes:');
    console.log('  node src/servico-windows.js instalar');
    console.log('  node src/servico-windows.js desinstalar');
    console.log('  node src/servico-windows.js iniciar');
    console.log('  node src/servico-windows.js parar');
    process.exit(1);
}
