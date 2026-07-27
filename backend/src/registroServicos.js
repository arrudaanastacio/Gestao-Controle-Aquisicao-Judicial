// =====================================================================
// registroServicos.js
// Núcleo da tela "Status dos Serviços".
//
// Faz três coisas:
//   1. CATALOGO — descreve os serviços automáticos do sistema (nome,
//      descrição, categoria, agendamento e como ligá-los/desligá-los).
//   2. Registro — os vigias chamam registrarExecucao() quando de fato
//      importam algo (ou falham), e marcarVerificacao() a cada rodada de
//      checagem. Só o primeiro grava no banco; o segundo é um "sinal de
//      vida" em memória, para a tela mostrar que o vigia está acordado
//      sem inchar a tabela com 2.880 linhas por dia.
//   3. Leitura — situacao(), indicadores() e alertas() montam o que a
//      tela consome.
//
// Princípio: só mostramos número que existe de verdade. Nada de
// "disponibilidade 99,98%" inventada — ela é calculada do histórico real
// e, enquanto não houver histórico, a tela diz que ainda não há dados.
// =====================================================================

const db = require('./db');

// --- Catálogo ---------------------------------------------------------
// `envDesliga`: variável do .env que desativa o serviço (e o valor que desativa).
// `agendamento`: texto amigável do quando roda.
// `tipo`: 'vigia' (observa arquivo continuamente) | 'agendado' (hora marcada).
// `intervaloEsperadoH`: de quantas em quantas horas esperamos ver uma execução
//   bem-sucedida. Passou muito disso => a tela acende "Atenção". Para os vigias
//   de arquivo é null: eles só rodam quando o arquivo muda, então ficar dias
//   parado é normal e NÃO é defeito.
const CATALOGO = [
  {
    id: 'estoqueTP',
    nome: 'Importação de Estoque (Tenente Pena)',
    descricao: 'Importa o estoque da unidade sempre que o relatório do SCODES é atualizado na pasta de rede.',
    categoria: 'Importação',
    tipo: 'vigia',
    agendamento: 'Contínuo — verifica a cada 30 segundos',
    envDesliga: { chave: 'AUTO_IMPORTAR_ESTOQUE', valor: 'false' },
    intervaloEsperadoH: null,
  },
  {
    id: 'autores',
    nome: 'Listagem de Autores',
    descricao: 'Importa a listagem de pacientes/autores usada pelo Comparativo de Autores.',
    categoria: 'Importação',
    tipo: 'vigia',
    agendamento: 'Contínuo — verifica a cada 30 segundos',
    envDesliga: { chave: 'AUTO_IMPORTAR_AUTORES', valor: 'false' },
    intervaloEsperadoH: null,
  },
  {
    id: 'relatorioItens',
    nome: 'Relatório de Itens',
    descricao: 'Importa o cadastro de itens usado nas consultas de catálogo.',
    categoria: 'Importação',
    tipo: 'vigia',
    agendamento: 'Contínuo — verifica a cada 30 segundos',
    envDesliga: { chave: 'AUTO_IMPORTAR_RELATORIO_ITENS', valor: 'false' },
    intervaloEsperadoH: null,
  },
  {
    id: 'atas',
    nome: 'Atas de Registro de Preço (SISCOA)',
    descricao: 'Importa as atas vigentes do SISCOA para consulta de preços e fornecedores.',
    categoria: 'Importação',
    tipo: 'vigia',
    agendamento: 'Contínuo — verifica a cada 30 segundos',
    envDesliga: { chave: 'AUTO_IMPORTAR_ATAS', valor: 'false' },
    intervaloEsperadoH: null,
  },
  {
    id: 'estoqueOD',
    nome: 'Estoque GSNET / IBL',
    descricao: 'Importa e concilia o estoque dos sistemas GSNET e IBL das Outras Demandas.',
    categoria: 'Importação',
    tipo: 'vigia',
    agendamento: 'Contínuo — verifica a cada 30 segundos',
    envDesliga: { chave: 'AUTO_IMPORTAR_ESTOQUE_OD', valor: 'false' },
    intervaloEsperadoH: null,
  },
  {
    id: 'distribuicao',
    nome: 'Distribuição',
    descricao: 'Importa extrato, faturas, elenco CEDMAC e locais de entrega da distribuição.',
    categoria: 'Importação',
    tipo: 'vigia',
    agendamento: 'Contínuo — verifica a cada 30 segundos',
    envDesliga: { chave: 'AUTO_IMPORTAR_DISTRIBUICAO', valor: 'false' },
    intervaloEsperadoH: null,
  },
  {
    id: 'solicitacoesTP',
    nome: 'Solicitações de Compra (Tenente Pena)',
    descricao: 'Importa a planilha de solicitações de compra da unidade Tenente Pena.',
    categoria: 'Importação',
    tipo: 'agendado',
    agendamento: 'Diário às 12:00 e 19:00 (e quando a planilha muda)',
    envDesliga: { chave: 'AUTO_IMPORTAR_SOLICITACOES', valor: 'false' },
    intervaloEsperadoH: null,
  },
  {
    id: 'solicitacoesOD',
    nome: 'Solicitações de Compra (Outras Demandas)',
    descricao: 'Importa a planilha de solicitações de compra das Outras Demandas.',
    categoria: 'Importação',
    tipo: 'agendado',
    agendamento: 'Diário às 12:00 e 19:00 (e quando a planilha muda)',
    envDesliga: { chave: 'AUTO_IMPORTAR_SOLICITACOES_OD', valor: 'false' },
    intervaloEsperadoH: null,
  },
  {
    id: 'reservasUdtp',
    nome: 'Integração UDTP (Reservas, Estoque e Rupturas)',
    descricao: 'Consulta a API da UDTP e atualiza reservas por paciente, estoque por lote e rupturas dos últimos 30 dias.',
    categoria: 'Integração',
    tipo: 'agendado',
    agendamento: () => `Diário às ${horaEnv('HORA_SYNC_RESERVAS', 7, 'MINUTO_SYNC_RESERVAS', 0)}`,
    envDesliga: { chave: 'AUTO_IMPORTAR_RESERVAS', valor: 'false' },
    intervaloEsperadoH: 26,
  },
  {
    id: 'oracleDiario',
    nome: 'Sincronização Oracle (SCODES)',
    descricao: 'Cadeia diária de sincronização com o banco Oracle do SCODES.',
    categoria: 'Integração',
    tipo: 'agendado',
    agendamento: () => `Diário às ${horaEnv('HORA_SYNC_ESTOQUE', 6, 'MINUTO_SYNC_ESTOQUE', 0)}`,
    // Este é opt-in: só liga quando AGENDAR_ORACLE_DIARIO=true.
    envLiga: { chave: 'AGENDAR_ORACLE_DIARIO', valor: 'true' },
    intervaloEsperadoH: 26,
  },
  {
    id: 'backup',
    nome: 'Backup do Banco de Dados',
    descricao: 'Gera a cópia de segurança diária do banco, aplica a retenção e mantém o backup mensal de longo prazo.',
    categoria: 'Manutenção',
    tipo: 'agendado',
    agendamento: () => `Diário às ${horaEnv('BACKUP_HORA', 5, 'BACKUP_MINUTO', 0)}`,
    envDesliga: { chave: 'AUTO_BACKUP', valor: 'false' },
    intervaloEsperadoH: 26,
  },
];

function horaEnv(chaveH, padraoH, chaveM, padraoM) {
  const h = Math.min(23, Math.max(0, parseInt(process.env[chaveH], 10) || padraoH));
  const m = Math.min(59, Math.max(0, parseInt(process.env[chaveM], 10) || padraoM));
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const PORID = new Map(CATALOGO.map((s) => [s.id, s]));

// --- Estado em memória (some ao reiniciar, e tudo bem) ----------------
// ultimaVerificacao: última vez que o vigia acordou e olhou a origem.
// emExecucao: está rodando agora (usado pelo badge "Executando" e pela
//   trava contra clique duplo no botão "Executar agora").
const estado = new Map();
function est(id) {
  if (!estado.has(id)) estado.set(id, { ultimaVerificacao: null, emExecucao: false, inicioExecucao: null });
  return estado.get(id);
}

function agoraISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// --- API para os vigias ----------------------------------------------

// Sinal de vida: "acordei e verifiquei a origem". Não grava no banco.
function marcarVerificacao(id) {
  est(id).ultimaVerificacao = agoraISO();
}

// Marca início/fim de execução, para o badge "Executando".
function marcarInicio(id) {
  const e = est(id);
  e.emExecucao = true;
  e.inicioExecucao = Date.now();
  return e.inicioExecucao;
}
function marcarFim(id) {
  const e = est(id);
  e.emExecucao = false;
  const ms = e.inicioExecucao ? Date.now() - e.inicioExecucao : null;
  e.inicioExecucao = null;
  return ms;
}
function estaExecutando(id) {
  return !!est(id).emExecucao;
}

const inserirExec = db.prepare(`
  INSERT INTO servico_execucoes
    (servico, iniciado_em, finalizado_em, duracao_ms, resultado, nivel,
     mensagem, registros, arquivo, origem, usuario_email, detalhe)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Grava uma execução que de fato aconteceu (importou algo ou falhou).
// Chamada pelos vigias. Nunca deixa uma falha de log derrubar a importação —
// por isso todo o corpo está protegido.
function registrarExecucao(id, dados = {}) {
  try {
    const inicioMs = dados.inicioMs || null;
    const fim = agoraISO();
    const duracao = dados.duracaoMs != null
      ? dados.duracaoMs
      : (inicioMs ? Date.now() - inicioMs : null);
    const inicio = inicioMs
      ? (() => {
          const d = new Date(inicioMs);
          const p = (n) => String(n).padStart(2, '0');
          return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
        })()
      : fim;
    const erro = dados.resultado === 'erro';
    inserirExec.run(
      id,
      inicio,
      fim,
      duracao,
      erro ? 'erro' : 'sucesso',
      dados.nivel || (erro ? 'ERROR' : 'INFO'),
      dados.mensagem || null,
      dados.registros != null ? dados.registros : null,
      dados.arquivo || null,
      dados.origem || 'automatico',
      dados.usuarioEmail || null,
      dados.detalhe || null
    );
  } catch (e) {
    console.error('[STATUS SERVIÇOS] Não consegui registrar execução de', id, '-', e.message);
  }
}

// Açúcar sintático: envolve uma função, cronometrando e registrando o erro
// automaticamente. Usado nas execuções manuais ("Executar agora").
async function executarRegistrando(id, fn, { origem = 'manual', usuarioEmail = null } = {}) {
  const inicioMs = marcarInicio(id);
  try {
    const r = await fn();
    marcarFim(id);
    return r;
  } catch (e) {
    marcarFim(id);
    registrarExecucao(id, {
      resultado: 'erro',
      nivel: 'ERROR',
      mensagem: e && e.message ? e.message : String(e),
      detalhe: e && e.stack ? e.stack : null,
      inicioMs,
      origem,
      usuarioEmail,
    });
    throw e;
  }
}

// --- Leitura para a tela ----------------------------------------------

function habilitado(s) {
  if (s.envLiga) return process.env[s.envLiga.chave] === s.envLiga.valor;
  if (s.envDesliga) return process.env[s.envDesliga.chave] !== s.envDesliga.valor;
  return true;
}

const ultimaExecStmt = db.prepare(`
  SELECT * FROM servico_execucoes WHERE servico = ? ORDER BY iniciado_em DESC, id DESC LIMIT 1
`);
const metricasStmt = db.prepare(`
  SELECT COUNT(*) AS total,
         SUM(CASE WHEN resultado = 'sucesso' THEN 1 ELSE 0 END) AS sucessos,
         AVG(duracao_ms) AS duracao_media
    FROM servico_execucoes
   WHERE servico = ? AND iniciado_em >= datetime('now', 'localtime', '-30 days')
`);

// Horas decorridas desde um timestamp local 'YYYY-MM-DD HH:MM:SS'.
function horasDesde(texto) {
  if (!texto) return null;
  const t = Date.parse(texto.replace(' ', 'T'));
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 3600000;
}

// Situação de um serviço. Estados possíveis:
//   desabilitado | executando | erro | atencao | aguardando | ativo
function situacao(s, ultima) {
  if (!habilitado(s)) return 'desabilitado';
  if (estaExecutando(s.id)) return 'executando';
  if (ultima && ultima.resultado === 'erro') return 'erro';
  // Só cobramos pontualidade de quem tem hora marcada. Vigia de arquivo
  // parado há dias é normal — o arquivo simplesmente não mudou.
  if (s.intervaloEsperadoH) {
    const h = horasDesde(ultima && ultima.iniciado_em);
    if (h === null) return 'aguardando';       // nunca rodou ainda
    if (h > s.intervaloEsperadoH) return 'atencao';
  }
  return 'ativo';
}

const ROTULO_SITUACAO = {
  ativo: 'Ativo',
  executando: 'Executando',
  aguardando: 'Aguardando',
  atencao: 'Atenção',
  erro: 'Erro',
  desabilitado: 'Desabilitado',
};

// Próxima execução prevista, para os serviços de hora marcada.
function proximaExecucao(s) {
  if (s.tipo !== 'agendado' || !habilitado(s)) return null;
  const texto = typeof s.agendamento === 'function' ? s.agendamento() : s.agendamento;
  const horas = String(texto).match(/\d{2}:\d{2}/g);
  if (!horas || !horas.length) return null;
  const agora = new Date();
  let melhor = null;
  for (const hhmm of horas) {
    const [h, m] = hhmm.split(':').map(Number);
    const alvo = new Date(agora);
    alvo.setHours(h, m, 0, 0);
    if (alvo <= agora) alvo.setDate(alvo.getDate() + 1);
    if (!melhor || alvo < melhor) melhor = alvo;
  }
  if (!melhor) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${melhor.getFullYear()}-${p(melhor.getMonth() + 1)}-${p(melhor.getDate())} ${p(melhor.getHours())}:${p(melhor.getMinutes())}:00`;
}

// Linha da tabela principal.
function linhaServico(s) {
  const ultima = ultimaExecStmt.get(s.id) || null;
  const m = metricasStmt.get(s.id) || {};
  const total = m.total || 0;
  const sit = situacao(s, ultima);
  return {
    id: s.id,
    nome: s.nome,
    descricao: s.descricao,
    categoria: s.categoria,
    tipo: s.tipo,
    agendamento: typeof s.agendamento === 'function' ? s.agendamento() : s.agendamento,
    habilitado: habilitado(s),
    situacao: sit,
    situacaoRotulo: ROTULO_SITUACAO[sit],
    ultimaExecucao: ultima ? ultima.iniciado_em : null,
    ultimaMensagem: ultima ? ultima.mensagem : null,
    ultimoResultado: ultima ? ultima.resultado : null,
    ultimaDuracaoMs: ultima ? ultima.duracao_ms : null,
    ultimosRegistros: ultima ? ultima.registros : null,
    ultimoArquivo: ultima ? ultima.arquivo : null,
    ultimaVerificacao: est(s.id).ultimaVerificacao,
    proximaExecucao: proximaExecucao(s),
    // Só devolvemos as métricas quando existe histórico. Sem dado, null —
    // a tela mostra "—" em vez de um número inventado.
    duracaoMediaMs: total > 0 && m.duracao_media != null ? Math.round(m.duracao_media) : null,
    disponibilidade: total > 0 ? (m.sucessos / total) * 100 : null,
    execucoes30d: total,
  };
}

function listar() {
  return CATALOGO.map(linhaServico);
}

// Cartões do topo. "Disponibilidade" e "tempo médio" são agregados reais
// dos últimos 30 dias; sem histórico, vêm null.
function indicadores(linhas) {
  const conta = (sit) => linhas.filter((l) => l.situacao === sit).length;
  const comHist = linhas.filter((l) => l.execucoes30d > 0);
  const totalExec = comHist.reduce((a, l) => a + l.execucoes30d, 0);
  const somaOk = comHist.reduce((a, l) => a + (l.disponibilidade / 100) * l.execucoes30d, 0);
  const comTempo = linhas.filter((l) => l.duracaoMediaMs != null);
  return {
    ativos: conta('ativo') + conta('aguardando'),
    executando: conta('executando'),
    atencao: conta('atencao'),
    erro: conta('erro'),
    desabilitados: conta('desabilitado'),
    disponibilidade: totalExec > 0 ? (somaOk / totalExec) * 100 : null,
    tempoMedioMs: comTempo.length
      ? Math.round(comTempo.reduce((a, l) => a + l.duracaoMediaMs, 0) / comTempo.length)
      : null,
  };
}

// Faixa de alertas do topo — só o que exige ação.
//
// Um serviço DESLIGADO no .env é uma escolha do administrador, não um defeito:
// se cada um virasse uma linha de alerta, em homologação (onde quase tudo fica
// desligado de propósito) a faixa teria 7 avisos e afogaria o único erro que
// importa. Por isso os desabilitados entram como UMA linha agregada, no fim.
function alertas(linhas) {
  const saida = [];
  for (const l of linhas) {
    if (l.situacao === 'erro') {
      saida.push({
        nivel: 'critico',
        servico: l.id,
        texto: `${l.nome}: última execução falhou${l.ultimaMensagem ? ' — ' + l.ultimaMensagem : ''}.`,
      });
    } else if (l.situacao === 'atencao') {
      const s = PORID.get(l.id);
      saida.push({
        nivel: 'atencao',
        servico: l.id,
        texto: l.ultimaExecucao
          ? `${l.nome}: sem execução bem-sucedida há mais de ${s.intervaloEsperadoH} horas.`
          : `${l.nome}: nunca executou desde que o monitoramento foi ativado.`,
      });
    }
  }

  const desligados = linhas.filter((l) => l.situacao === 'desabilitado');
  if (desligados.length) {
    saida.push({
      nivel: 'atencao',
      servico: desligados[0].id,
      texto: desligados.length === 1
        ? `${desligados[0].nome} está desativado na configuração (.env) e não vai rodar.`
        : `${desligados.length} serviços estão desativados na configuração (.env): ${desligados.map((d) => d.nome).join(', ')}.`,
    });
  }
  return saida;
}

// Uso de recursos do PROCESSO do sistema (não por serviço — é um processo
// Node só). Honesto sobre o que mede: memória residente e o percentual de
// CPU consumido desde a última chamada.
let ultimaCpu = process.cpuUsage();
let ultimoInstante = Date.now();
function recursos() {
  const mem = process.memoryUsage();
  const agora = Date.now();
  const uso = process.cpuUsage(ultimaCpu);
  const decorridoMs = Math.max(1, agora - ultimoInstante);
  ultimaCpu = process.cpuUsage();
  ultimoInstante = agora;
  const cpuPct = ((uso.user + uso.system) / 1000 / decorridoMs) * 100;
  return {
    memoriaMB: Math.round(mem.rss / 1048576),
    heapMB: Math.round(mem.heapUsed / 1048576),
    cpuPercent: Math.round(cpuPct * 10) / 10,
    uptimeSegundos: Math.round(process.uptime()),
  };
}

module.exports = {
  CATALOGO,
  PORID,
  ROTULO_SITUACAO,
  marcarVerificacao,
  marcarInicio,
  marcarFim,
  estaExecutando,
  registrarExecucao,
  executarRegistrando,
  listar,
  linhaServico,
  indicadores,
  alertas,
  recursos,
  habilitado,
};
