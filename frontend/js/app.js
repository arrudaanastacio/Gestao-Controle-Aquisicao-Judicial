// -------------------- Estado global --------------------
const estado = {
  usuario: null,
  paginaAtual: 'painel',
  solicitacoes: { pagina: 1, pageSize: 20, total: 0, filtros: {} },
  estoque: { pagina: 1, pageSize: 30, total: 0, data: null },
  validades: { data: null, janela: '' },
  atas: { pagina: 1, pageSize: 50, total: 0, janela: '' },
  itensCache: [],
};

// -------------------- Utilitários --------------------
async function api(caminho, opcoes = {}) {
  const resp = await fetch(`/api${caminho}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opcoes,
  });
  if (resp.status === 401) {
    window.location.href = '/login.html';
    throw new Error('Não autenticado');
  }
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(dados.erro || 'Erro na requisição');
    err.status = resp.status;
    err.dados = dados;
    throw err;
  }
  return dados;
}

function formatarData(iso) {
  if (!iso) return '—';
  const [ano, mes, dia] = iso.split('-');
  if (!dia) return iso;
  return `${dia}/${mes}/${ano}`;
}

// Sufixo " · importado às HH:MM" para telas que dependem de importação/atualização.
// Recebe um datetime "YYYY-MM-DD HH:MM:SS" (já em hora local, vindo do backend).
// Retorna string vazia quando não há hora, para não poluir o subtítulo.
function horaImportacao(dh) {
  return dh ? ` · importado às ${String(dh).slice(11, 16)}` : '';
}

// Normaliza texto para BUSCA (não muda o que é exibido/gravado): tira espaços
// das pontas, passa para minúsculas e remove acentos. Assim "Lítio" acha
// "litio" e vice-versa. Usada nos filtros de tela (lado do cliente).
function normalizarBusca(s) {
  return s == null ? '' : String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Meses com 2 casas e vírgula (ex.: 3 → "3,00 meses"). null/undefined → "—".
// vazioTraco='-' permite o padrão do enunciado ("-" quando não há consumo).
function fmtMeses(v, traco = '—') {
  if (v == null || Number.isNaN(Number(v))) return traco;
  return `${Number(v).toFixed(2).replace('.', ',')}`;
}

// Mostra um valor de célula ou "—" quando vazio/nulo (para tabelas largas).
function valorCelula(v) {
  if (v === null || v === undefined || v === '') return '—';
  return v;
}

// Interpreta o texto de lotes vindo do relatório de estoque.
// Vários lotes vêm concatenados; o separador entre lotes já foi "\" (formato
// antigo do Excel) e hoje, via Oracle, é ", Lote N°:" (vírgula antes de um novo
// "Lote N°:"). Aceitamos os dois — e NÃO quebramos em vírgulas que aparecem
// dentro do nome do fabricante, pois só separamos quando vem "Lote N°" adiante.
//   "Lote N°: XXX Validade: DD/MM/YYYY Fabricante: YYY Qtde: NNN"
// Retorna uma lista de objetos { lote, validade, fabricante, qtde }.
function parsearLotes(texto) {
  if (!texto) return [];
  const t = String(texto).trim();
  if (!t || /^sem lote$/i.test(t)) return [];

  return t.split(/\\|,\s*(?=Lote\s*N[°º:])/i).map((parte) => parte.trim()).filter(Boolean).map((p) => {
    const lote = (p.match(/Lote\s*N[°º:]*\s*([^\s]+(?:\s+[^\s]+)*?)(?=\s+Validade:|\s+Fabricante:|\s+Qtde:|$)/i) || [])[1];
    const validade = (p.match(/Validade:\s*(\d{2}\/\d{2}\/\d{4})/i) || [])[1];
    const fabricante = (p.match(/Fabricante:\s*(.+?)(?=\s+Qtde:|$)/i) || [])[1];
    const qtde = (p.match(/Qtde:\s*([\d.,]+)/i) || [])[1];
    return {
      lote: lote ? lote.trim() : '—',
      validade: validade || null,
      fabricante: fabricante ? fabricante.trim() : '—',
      qtde: qtde || null,
    };
  });
}

// A partir do texto de lotes, retorna a validade mais próxima de vencer
// (a menor data), com os dias restantes. Retorna null se não houver validade.
function proximaValidade(lotesTexto) {
  const lotes = parsearLotes(lotesTexto).filter((l) => l.validade);
  if (lotes.length === 0) return null;
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  let melhor = null;
  for (const l of lotes) {
    const [d, m, a] = l.validade.split('/').map(Number);
    if (!d || !m || !a) continue;
    const data = new Date(a, m - 1, d);
    const dias = Math.floor((data - hoje) / (1000 * 60 * 60 * 24));
    if (melhor === null || dias < melhor.dias) melhor = { validade: l.validade, dias };
  }
  return melhor;
}

// Monta as etiquetas de programa (Outras Demandas / Dose Certa / Inex) de um
// item do estoque. Só mostra a etiqueta do programa a que o item pertence.
function etiquetasProgramaHTML(it) {
  const tags = [];
  const rotulos = new Set(); // evita etiquetas repetidas (ex.: subcategoria = "Outras Demandas")
  const add = (rotulo, classe) => {
    const chave = rotulo.toLowerCase();
    if (rotulos.has(chave)) return;
    rotulos.add(chave);
    tags.push(`<span class="tag-programa ${classe}">${escHtml(rotulo)}</span>`);
  };
  if (it.prog_outras_demandas === 'Sim') add('Outras Demandas', 'od');
  if (it.prog_dose_certa === 'Sim') add('Dose Certa', 'dc');
  if (it.prog_inex === 'Sim') add('Inex', 'ix');
  if (it.subcategoria && String(it.subcategoria).trim()) add(String(it.subcategoria).trim(), 'sub');
  return tags.length ? `<div class="tags-programa">${tags.join('')}</div>` : '';
}

// Descrição do item com a MARCA em negrito — só quando a marca é diferente de
// "SEM MARCA". A descrição termina com a marca (ex.: "… / UNIDADE / TRIKAFTA").
function descricaoComMarcaHTML(it) {
  const desc = it.descricao || '—';
  const marca = (it.marca || '').trim();
  if (!marca || /sem\s*marca/i.test(marca) || !desc.endsWith(marca)) return escHtml(desc);
  const prefixo = desc.slice(0, desc.length - marca.length);
  return escHtml(prefixo) + '<strong>' + escHtml(marca) + '</strong>';
}

// Classifica uma validade DD/MM/YYYY: 'vencido', 'proximo' (<=90 dias) ou ''.
function classeValidade(validadeBR) {
  if (!validadeBR) return '';
  const [d, m, a] = validadeBR.split('/').map(Number);
  if (!d || !m || !a) return '';
  const data = new Date(a, m - 1, d);
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const diasRestantes = Math.floor((data - hoje) / (1000 * 60 * 60 * 24));
  if (diasRestantes < 0) return 'vencido';
  if (diasRestantes <= 90) return 'proximo';
  return '';
}

function classeStatus(status, dataPrevisao) {
  const finalizados = ['Finalizado'];
  const negativos = ['Cancelado', 'Fracassado', 'Deserto', 'Revogado'];

  if (dataPrevisao && !finalizados.includes(status) && !negativos.includes(status)) {
    const hoje = new Date();
    const previsao = new Date(dataPrevisao);
    if (previsao < hoje) return 'atrasado';
  }
  if (finalizados.includes(status)) return 'finalizado';
  if (negativos.includes(status)) return (status || '').toLowerCase();
  if (status === 'Planejamento') return 'planejamento';
  return 'andamento';
}

function rotuloStatus(status, dataPrevisao) {
  const classe = classeStatus(status, dataPrevisao);
  if (classe === 'atrasado') return 'Atrasado';
  return status || 'Em andamento';
}

// -------- Etiquetas de apresentação da Listagem de Autores --------
function celVazia() { return '<span class="cel-vazia">—</span>'; }

// Status da demanda: quase sempre "Demanda Ativa - <sub>". Mostra o sub-status
// (o texto completo fica no title/tooltip) com um ponto verde quando ativa.
function etStatusDemanda(v) {
  if (!v) return celVazia();
  const sub = v.includes(' - ') ? v.split(' - ').slice(1).join(' - ') : v;
  const ok = /ativ|atendimento/i.test(v);
  return `<span class="et-status ${ok ? 'ok' : 'neutra'}" title="${v.replace(/"/g, '')}">${sub}</span>`;
}

// Tipo da demanda e Categoria: etiquetas neutras diferenciadas por um ponto de cor.
function tagClassif(v, mapa) {
  if (!v) return celVazia();
  const cls = mapa[v] || 'out';
  return `<span class="tag-clsf ${cls}">${v}</span>`;
}
function tagTipoDemanda(v) {
  return tagClassif(v, { 'Judicial': 'jud', 'Comissão de Farmacologia': 'com', 'Jefaz': 'jef' });
}
function tagCategoria(v) {
  return tagClassif(v, { 'Medicamentos': 'med', 'Materiais': 'mat', 'Nutrição': 'nut', 'Procedimentos': 'proc', 'Outros Itens': 'out' });
}

// -------------------- Autenticação / shell --------------------
async function carregarUsuario() {
  const { usuario } = await api('/auth/me');
  estado.usuario = usuario;
  document.getElementById('nomeUsuario').textContent = usuario.nome;
  document.getElementById('perfilUsuario').textContent = usuario.perfil === 'admin' ? 'Admin' : 'Consulta';

  // Iniciais no avatar (primeira letra dos dois primeiros nomes)
  const partes = (usuario.nome || '?').trim().split(/\s+/);
  const iniciais = (partes[0]?.[0] || '') + (partes.length > 1 ? partes[partes.length - 1][0] : '');
  document.getElementById('avatarUsuario').textContent = iniciais.toUpperCase() || '?';

  if (usuario.perfil === 'admin') {
    document.getElementById('linkUsuarios').hidden = false;
    document.getElementById('linkImportadores').hidden = false;
    document.getElementById('linkAlertas').hidden = false;
    // Status dos Serviços é exclusiva de admin (a API também exige o perfil).
    document.getElementById('linkStatusServicos').hidden = false;
    configurarStatusServicos();
    // "Nova solicitação" fica ESCONDIDO de propósito: as telas de compras
    // TP/OD são espelho da planilha do G: (fonte da verdade). Um cadastro
    // manual aqui seria apagado na próxima importação "refaz o mês" (12h/19h
    // ou "Atualizar agora"). O cadastro correto é feito na planilha.
    // document.getElementById('botaoNovaSolicitacao').hidden = false;
    document.getElementById('botaoAtualizarOracle').hidden = false;
    verificarStatusOracle(); // retoma acompanhamento se já houver atualização em curso
    document.getElementById('botaoAtualizarOracleEstoque').hidden = false;
    verificarStatusOracleEstoque();
    document.getElementById('botaoImportarEstoqueOD').hidden = false;
    document.getElementById('botaoAtualizarEntradaLotes').hidden = false;
    verificarStatusOracleEntradaLotes();
    document.getElementById('botaoAtualizarSaidaLotes').hidden = false;
    verificarStatusOracleSaidaLotes();
    document.getElementById('botaoAtualizarRelatorioItens').hidden = false;
    document.getElementById('botaoImportarClassificacao').hidden = false;
    verificarStatusOracleRelatorioItens();
    document.getElementById('botaoAtualizarConsumoEntrega').hidden = false;
    verificarStatusOracleConsumoEntrega();
    document.getElementById('botaoGerarConciliacao').hidden = false;
    document.getElementById('botaoGerarEmpenhos').hidden = false;
    document.querySelectorAll('.botao-atualizar-agora').forEach((b) => { b.hidden = false; });
    document.getElementById('acoesAtasAdmin').hidden = false;
    atualizarBadgeAlertas();
    carregarConfigLimiar();
  } else {
    // Administração (usuários/importação) continua só para admin
    document.getElementById('grupoAdministracao').hidden = true;
    // Mostra o aviso de leitura só se o usuário não tiver NENHuma permissão de escrita
    document.getElementById('avisoSomenteLeitura').hidden = temAlgumaEscrita();
    aplicarPermissoesNav();
  }
}

// Verdadeiro se o usuário pode fazer a ação no módulo. Admin pode tudo.
function temPermissao(modulo, acao) {
  const u = estado.usuario;
  if (!u) return false;
  if (u.perfil === 'admin') return true;
  // Módulo desabilitado bloqueia tudo, independente das ações.
  if (u.habilitado && u.habilitado[modulo] === false) return false;
  return !!(u.permissoes && u.permissoes[modulo] && u.permissoes[modulo][acao]);
}

// Algum poder de escrita em qualquer módulo? (para decidir o aviso de leitura)
function temAlgumaEscrita() {
  const p = estado.usuario && estado.usuario.permissoes;
  if (!p) return false;
  return Object.values(p).some((m) =>
    ['inserir', 'editar', 'excluir', 'importar'].some((a) => m[a]));
}

// Esconde da navegação os módulos que o usuário não pode nem visualizar.
function aplicarPermissoesNav() {
  // Cada link de página é mapeado para o módulo que o controla — um módulo
  // por tela (13/07/2026), sem mais telas agrupadas sob o mesmo módulo.
  const mapa = {
    relatorio: 'relatorioComprasTP', solicitacoes: 'tabelaAnaliseTP',
    solicitacoesOD: 'relatorioComprasOD', aquisicaoODAndamento: 'aquisicaoODAndamento',
    estoque: 'estoqueTP', monitoramento: 'monitoramentoEstoque', validades: 'validadesTP', historico: 'historicoEstoqueTP', evolucao: 'evolucaoEstoqueTP',
    estoqueGeral: 'estoqueGeral', estoqueOD: 'estoqueOD', estoqueIblApi: 'estoqueIblApi', distribuicao: 'distribuicao',
    relatorioItens: 'relatorioItens',
    planejamento: 'planejamento',
    autores: 'autoresTP', autoresGeral: 'autoresGeral', autoresImportados: 'autoresImportados',
    relatorioImportados: 'relatorioComprasImportados', analiseImportados: 'analiseImportados',
    relatorioItensImportados: 'relatorioItensImportados',
    consumoEntrega: 'consumoEntrega',
    associarEntrada: 'associarEntrada',
    roboEmpenhos: 'roboEmpenhos',
    comparativoAutores: 'comparativoAutoresTP', relatorioReq: 'relatorioReqTP',
    cartasTroca: 'cartasTroca',
    atas: 'atas',
    entradaLotes: 'entradaLotes',
    saidaLotes: 'saidaLotes',
    reservas: 'reservas',
    rupturas: 'rupturas',
    alertas: 'alertas',
  };
  for (const [pagina, modulo] of Object.entries(mapa)) {
    const link = document.querySelector(`[data-pagina="${pagina}"]`);
    if (link) link.hidden = !temPermissao(modulo, 'visualizar');
  }
  if (temPermissao('alertas', 'visualizar')) {
    document.getElementById('linkAlertas').hidden = false;
    atualizarBadgeAlertas();
  }
  if (window.__favoritosRender) window.__favoritosRender();
}

async function atualizarBadgeAlertas() {
  try {
    const { totalAbertos } = await api('/alertas?resolvido=false');
    const badge = document.getElementById('badgeAlertas');
    if (totalAbertos > 0) {
      badge.textContent = totalAbertos;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  } catch (e) { /* silencioso */ }
}

document.getElementById('botaoSair').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

// Planejamento de Compras: botão "Gerar planejamento" (Parte 2) e edição
// item a item na tabela (Parte 3), via listener delegado no corpo da tabela.
{
  const bGerar = document.getElementById('botaoGerarPlan');
  if (bGerar) bGerar.addEventListener('click', gerarPlanejamento);
  const corpoPlan = document.getElementById('corpoPlanejamento');
  if (corpoPlan) {
    corpoPlan.addEventListener('input', onEdicaoPlanejamento);
    corpoPlan.addEventListener('change', onEdicaoPlanejamento);
  }
  const bSalvar = document.getElementById('botaoSalvarPlan');
  if (bSalvar) bSalvar.addEventListener('click', salvarPlanejamento);
  const bExportar = document.getElementById('botaoExportarPlan');
  if (bExportar) bExportar.addEventListener('click', exportarPlanejamentoCSV);
  const bListar = document.getElementById('botaoListarPlan');
  if (bListar) bListar.addEventListener('click', listarPlanejamentosSalvos);
  const bFechar = document.getElementById('botaoFecharListaPlan');
  if (bFechar) bFechar.addEventListener('click', () => { document.getElementById('planListaSalvos').style.display = 'none'; });

  // Filtros da lista: chips de modalidade, "só âmbar", "só a comprar" e busca.
  const chips = document.getElementById('planChipsModalidade');
  if (chips) chips.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-mod]');
    if (!b) return;
    chips.querySelectorAll('button').forEach((x) => x.classList.toggle('ativo', x === b));
    estadoPlanejamento.filtros.modalidade = b.dataset.mod;
    aplicarFiltrosPlanejamento();
  });
  const fFrac = document.getElementById('planFiltroFrac');
  if (fFrac) fFrac.addEventListener('change', () => { estadoPlanejamento.filtros.soFrac = fFrac.checked; aplicarFiltrosPlanejamento(); });
  const fComprar = document.getElementById('planFiltroComprar');
  if (fComprar) fComprar.addEventListener('change', () => { estadoPlanejamento.filtros.soComprar = fComprar.checked; aplicarFiltrosPlanejamento(); });
  const fCat = document.getElementById('planFiltroCategoria');
  if (fCat) fCat.addEventListener('change', () => { estadoPlanejamento.filtros.categoria = fCat.value; aplicarFiltrosPlanejamento(); });
  const subBtn = document.getElementById('planFiltroSubBotao');
  if (subBtn) subBtn.addEventListener('click', (ev) => { ev.stopPropagation(); const p = document.getElementById('planFiltroSubPainel'); p.hidden = !p.hidden; });
  document.addEventListener('click', (ev) => {
    const wrap = document.getElementById('planFiltroSubWrap');
    const p = document.getElementById('planFiltroSubPainel');
    if (wrap && p && !wrap.contains(ev.target)) p.hidden = true;
  });
  const fBusca = document.getElementById('planBusca');
  if (fBusca) {
    let t;
    fBusca.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { estadoPlanejamento.filtros.busca = fBusca.value.trim().toLowerCase(); aplicarFiltrosPlanejamento(); }, 200);
    });
  }
}

document.querySelectorAll('.nav-lateral a').forEach((link) => {
  link.addEventListener('click', (ev) => {
    ev.preventDefault();
    mudarPagina(link.dataset.pagina);
  });
});

// Ícones (linha simples) para cada item do menu — visual mais moderno
const ICONES_NAV = {
  painel: '<rect x="4" y="4" width="6" height="7" rx="1"/><rect x="14" y="4" width="6" height="4" rx="1"/><rect x="14" y="12" width="6" height="8" rx="1"/><rect x="4" y="15" width="6" height="5" rx="1"/>',
  solicitacoes: '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/>',
  relatorio: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
  estoque: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  monitoramento: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M7 11l2-2 2 3 3-5 3 4"/><path d="M8 20h8M12 16v4"/>',
  estoqueGeral: '<path d="M3 21V8l9-5 9 5v13"/><path d="M9 21v-6h6v6"/><path d="M3 13h18"/>',
  estoqueOD: '<path d="M3 21V8l9-5 9 5v13"/><path d="M9 21v-6h6v6"/><path d="M3 13h18"/><path d="M16 3l4 2v4l-4-2z"/>',
  estoqueIblApi: '<path d="M3 21V8l9-5 9 5v13"/><path d="M9 21v-6h6v6"/><path d="M3 13h18"/><circle cx="18" cy="6" r="2.5"/>',
  solicitacoesOD: '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/><path d="M16 3l4 2v4l-4-2z"/>',
  aquisicaoODAndamento: '<path d="M4 19h16"/><path d="M4 19V5"/><path d="M7 15l4-5 3 3 5-7"/><path d="M16 3l4 2v4l-4-2z"/>',
  validades: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 9h16M9 3v4M15 3v4M12 12v3l2 1"/>',
  busca: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-3.5-3.5"/>',
  historico: '<path d="M4 12a8 8 0 1 0 2-5.3"/><path d="M4 4v3h3"/><path d="M12 8v4l3 2"/>',
  evolucao: '<path d="M4 19h16"/><path d="M4 19V5"/><path d="M7 15l4-5 3 3 5-7"/>',
  autores: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  autoresGeral: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  autoresImportados: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
  relatorioImportados: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  analiseImportados: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11M15 9v11"/>',
  relatorioItensImportados: '<path d="M4 4h16v16H4z"/><path d="M4 9h16M9 9v11"/><path d="M13 13h4M13 16h4"/>',
  consumoEntrega: '<path d="M3 3v18h18"/><path d="M7 14l3-4 3 3 4-6"/>',
  associarEntrada: '<path d="M4 7h16"/><path d="M4 12h10"/><path d="M4 17h7"/><path d="M15 16l2 2 4-4"/>',
  roboEmpenhos: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M9 8V5a3 3 0 0 1 6 0v3"/><path d="M9 14h.01M15 14h.01"/>',
  comparativoAutores: '<path d="M16 3h5v5"/><path d="M21 3l-7 7"/><path d="M8 21H3v-5"/><path d="M3 21l7-7"/>',
  relatorioReq: '<path d="M9 2h6l1 3H8z"/><rect x="4" y="5" width="16" height="17" rx="2"/><path d="M8 11h8M8 15h8M8 19h5"/>',
  relatorioItens: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  elenco: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  atas: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/><path d="M15 19l2 2 3-3"/>',
  planejamento: '<path d="M9 2h6l1 3H8z"/><rect x="4" y="5" width="16" height="17" rx="2"/><path d="M8 11l2 2 4-4"/><path d="M8 17h8"/>',
  distribuicao: '<circle cx="12" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="M12 8v4M12 12l-5 4M12 12l5 4"/>',
  entradaLotes: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 19h16"/>',
  saidaLotes: '<path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M4 19h16"/>',
  reservas: '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/>',
  rupturas: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  cartasTroca: '<path d="M3 8h13M13 5l3 3-3 3"/><path d="M21 16H8m3-3l-3 3 3 3"/>',
  statusServicos: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  alertas: '<path d="M6 9a6 6 0 1 1 12 0c0 4 2 5 2 5H4s2-1 2-5"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  importadores: '<path d="M12 15V4M8 8l4-4 4 4"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  usuarios: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 6a3 3 0 0 1 0 6M21 20a6 6 0 0 0-5-5.9"/>',
};

(function injetarIconesNav() {
  document.querySelectorAll('.nav-lateral a[data-pagina]').forEach((a) => {
    if (a.querySelector('svg')) return;
    const path = ICONES_NAV[a.dataset.pagina];
    if (!path) return;
    const span = document.createElement('span');
    span.className = 'nav-rotulo';
    while (a.firstChild) span.appendChild(a.firstChild); // preserva texto e badge
    a.insertAdjacentHTML('afterbegin',
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`);
    a.appendChild(span);
  });
})();

// Tema claro/escuro (botão na topbar). Guardado por pessoa no navegador.
(function tema() {
  const raiz = document.documentElement;
  function aplicar(t) {
    raiz.setAttribute('data-tema', t);
    const btn = document.getElementById('botaoTema');
    if (btn) btn.textContent = t === 'escuro' ? '🌙' : '☀️';
  }
  aplicar(localStorage.getItem('tema') === 'escuro' ? 'escuro' : 'claro');
  const btn = document.getElementById('botaoTema');
  if (btn) btn.addEventListener('click', () => {
    const novo = raiz.getAttribute('data-tema') === 'escuro' ? 'claro' : 'escuro';
    localStorage.setItem('tema', novo);
    aplicar(novo);
  });
})();

// Fixar/desafixar o menu lateral: quando fixo, o menu fica sempre aberto (e o
// conteúdo desloca). Preferência guardada no navegador (localStorage).
(function fixarMenu() {
  const barra = document.querySelector('.barra-lateral');
  const botao = document.getElementById('botaoFixarMenu');
  if (!barra || !botao) return;
  function aplicar(fixo) {
    barra.classList.toggle('fixo', fixo);
    botao.classList.toggle('ativo', fixo);
    botao.setAttribute('aria-pressed', fixo ? 'true' : 'false');
    botao.title = fixo ? 'Desafixar menu' : 'Fixar menu aberto';
    botao.setAttribute('aria-label', botao.title);
  }
  aplicar(localStorage.getItem('menuFixo') === '1');
  botao.addEventListener('click', () => {
    const fixo = !barra.classList.contains('fixo');
    localStorage.setItem('menuFixo', fixo ? '1' : '0');
    aplicar(fixo);
  });
})();

// Busca "Ir para tela…" da topbar: filtra as telas pela trilha e navega.
// Só oferece telas que o usuário pode ver (respeita a permissão do menu).
(function buscaTelas() {
  const input = document.getElementById('buscaTelas');
  const cx = document.getElementById('buscaTelasResultados');
  if (!input || !cx) return;
  let itens = [], marcado = -1;

  function listar() {
    const q = normalizarBusca(input.value);
    const res = [];
    for (const [pag, partes] of Object.entries(TRILHAS)) {
      const link = document.querySelector(`.nav-lateral a[data-pagina="${pag}"]`);
      if (link && link.hidden) continue;
      const tela = partes[partes.length - 1];
      const via = partes.slice(0, -1).join(' › ');
      if (!q || normalizarBusca(`${tela} ${via}`).includes(q)) res.push({ pag, tela, via });
    }
    return res.slice(0, 12);
  }
  function abrir() {
    itens = listar(); marcado = -1;
    cx.innerHTML = itens.length
      ? itens.map((r) => `<button type="button" class="item" data-pag="${r.pag}">${r.tela}${r.via ? `<span class="via">${r.via}</span>` : ''}</button>`).join('')
      : '<div class="vazio">Nenhuma tela encontrada.</div>';
    cx.hidden = false;
    cx.querySelectorAll('.item').forEach((b) => b.addEventListener('mousedown', (ev) => { ev.preventDefault(); ir(b.dataset.pag); }));
  }
  function ir(pag) { input.value = ''; cx.hidden = true; mudarPagina(pag); }
  input.addEventListener('focus', abrir);
  input.addEventListener('input', abrir);
  input.addEventListener('blur', () => setTimeout(() => { cx.hidden = true; }, 120));
  input.addEventListener('keydown', (ev) => {
    const bs = cx.querySelectorAll('.item');
    if (ev.key === 'ArrowDown') { ev.preventDefault(); marcado = Math.min(marcado + 1, bs.length - 1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); marcado = Math.max(marcado - 1, 0); }
    else if (ev.key === 'Enter') { if (itens[marcado]) { ev.preventDefault(); ir(itens[marcado].pag); } return; }
    else if (ev.key === 'Escape') { cx.hidden = true; input.blur(); return; }
    else return;
    bs.forEach((b, i) => b.classList.toggle('marcado', i === marcado));
  });
})();

// Fase 3: menu escalável — grupos recolhíveis + favoritos (guardados no
// navegador, por isso cada pessoa tem os seus). Mantém o menu limpo à medida
// que novas telas entram.
(function menuEscalavel() {
  const CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>';
  const ESTRELA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 21l1.1-6.5L2.6 9.8l6.5-.9z"/></svg>';

  // Grupos recolhíveis: clicar no cabeçalho da unidade abre/fecha.
  document.querySelectorAll('.nav-unidade-titulo').forEach((t) => {
    const grupo = t.closest('.nav-grupo');
    if (!grupo) return;
    const chev = document.createElement('span');
    chev.className = 'nav-cev';
    chev.innerHTML = CHEV;
    t.appendChild(chev);
    t.setAttribute('role', 'button');
    t.setAttribute('tabindex', '0');
    const chave = 'menuRecolhido.' + (t.textContent || '').trim();
    if (localStorage.getItem(chave) === '1') grupo.classList.add('recolhido');
    const alternar = () => {
      grupo.classList.toggle('recolhido');
      localStorage.setItem(chave, grupo.classList.contains('recolhido') ? '1' : '0');
    };
    t.addEventListener('click', alternar);
    t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); alternar(); } });
  });

  // Favoritos: estrela em cada item fixa/desafixa a tela no topo do menu.
  let FAV = [];
  try { FAV = JSON.parse(localStorage.getItem('menuFavoritos') || '[]'); } catch (_) { FAV = []; }
  const box = document.getElementById('navFavoritos');

  function estrelasAtualizar() {
    document.querySelectorAll('.fav-estrela').forEach((b) => b.classList.toggle('ativo', FAV.includes(b.dataset.pag)));
  }
  function favoritosRender() {
    if (!box) return;
    box.innerHTML = '';
    const validos = FAV.filter((p) => {
      const l = document.querySelector(`.nav-grupo a[data-pagina="${p}"]`);
      return l && !l.hidden;
    });
    if (!validos.length) { box.hidden = true; return; }
    box.hidden = false;
    const tit = document.createElement('p');
    tit.className = 'subtitulo';
    tit.textContent = '⭐ Favoritos';
    box.appendChild(tit);
    validos.forEach((p) => {
      const orig = document.querySelector(`.nav-grupo a[data-pagina="${p}"]`);
      const a = document.createElement('a');
      a.className = 'link';
      a.href = '#';
      a.dataset.pagina = p;
      a.innerHTML = orig.innerHTML;
      a.querySelectorAll('.fav-estrela').forEach((s) => s.remove());
      a.addEventListener('click', (ev) => { ev.preventDefault(); mudarPagina(p); });
      box.appendChild(a);
    });
  }
  function alternarFav(p) {
    const i = FAV.indexOf(p);
    if (i >= 0) FAV.splice(i, 1); else FAV.push(p);
    localStorage.setItem('menuFavoritos', JSON.stringify(FAV));
    estrelasAtualizar();
    favoritosRender();
  }

  document.querySelectorAll('.nav-grupo a[data-pagina]').forEach((a) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fav-estrela';
    b.dataset.pag = a.dataset.pagina;
    b.setAttribute('aria-label', 'Fixar nos favoritos');
    b.title = 'Fixar nos favoritos';
    b.innerHTML = ESTRELA;
    b.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); alternarFav(a.dataset.pagina); });
    a.appendChild(b);
  });
  estrelasAtualizar();
  favoritosRender();

  // Reexpõe para reagir quando as permissões escondem telas (perfil consulta).
  window.__favoritosRender = favoritosRender;
})();

// Fase 4: busca de telas DENTRO do menu. Filtra os itens na hora conforme
// digita (ignora acento/maiúscula), abre grupos recolhidos para revelar o que
// casou e respeita as telas escondidas por permissão. Campo vazio = tudo volta.
(function filtroMenu() {
  const input = document.getElementById('filtroMenu');
  const nav = document.querySelector('.nav-lateral');
  if (!input || !nav) return;
  const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  function aplicar() {
    const q = norm(input.value.trim());
    nav.classList.toggle('filtrando', !!q);

    const links = nav.querySelectorAll('.nav-grupo a[data-pagina]');
    links.forEach((a) => {
      const casou = !q || norm(a.textContent).includes(q);
      a.classList.toggle('nao-encontrado', !casou);
    });
    // Subgrupos e grupos sem nenhum item visível somem enquanto filtra.
    const temVisivel = (escopo) => [...escopo.querySelectorAll('a[data-pagina]')]
      .some((a) => !a.hidden && !a.classList.contains('nao-encontrado'));
    nav.querySelectorAll('.nav-subgrupo').forEach((sg) => {
      sg.classList.toggle('nao-encontrado', !!q && !temVisivel(sg));
    });
    nav.querySelectorAll('.nav-grupo').forEach((g) => {
      g.classList.toggle('nao-encontrado', !!q && !temVisivel(g));
    });

    // Mensagem de "nada encontrado".
    let vazio = document.getElementById('navBuscaVazio');
    const nada = !!q && ![...links].some((a) => !a.hidden && !a.classList.contains('nao-encontrado'));
    if (nada && !vazio) {
      vazio = document.createElement('p');
      vazio.id = 'navBuscaVazio';
      vazio.className = 'nav-busca-vazio';
      vazio.textContent = 'Nenhuma tela encontrada.';
      nav.appendChild(vazio);
    } else if (!nada && vazio) {
      vazio.remove();
    }
  }

  input.addEventListener('input', aplicar);
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { input.value = ''; aplicar(); input.blur(); } });
})();

function mostrarErroPagina(idSecao, mensagem) {
  const secao = document.getElementById(idSecao);
  if (!secao) return;
  const alvo = secao.querySelector('.grade-resumo, .corpo-tabela-wrapper, [id^="lista"], [id^="corpo"]') || secao;
  const div = document.createElement('div');
  div.style.cssText = 'padding:24px;color:#c0392b;';
  div.textContent = mensagem;
  alvo.prepend(div);
}

// Caminho de navegação (breadcrumb) de cada tela: Unidade › Tipo › Tela.
// Usado pela topbar e pela busca "Ir para tela…".
const TRILHAS = {
  painel: ['Painel'],
  relatorio: ['Tenente Pena', 'Compras', 'Relatório de Compras TP'],
  solicitacoes: ['Tenente Pena', 'Compras', 'Tabela Análise TP'],
  comparativoAutores: ['Tenente Pena', 'Compras', 'Comparativo de Autores'],
  relatorioReq: ['Tenente Pena', 'Compras', 'Relatório de Primeiro Atendimento'],
  cartasTroca: ['Tenente Pena', 'Compras', 'Cartas de Troca'],
  estoque: ['Tenente Pena', 'Estoque', 'Estoque Tenente Pena'],
  monitoramento: ['Tenente Pena', 'Estoque', 'Monitoramento de Estoque'],
  evolucao: ['Tenente Pena', 'Estoque', 'Evolução de Estoque'],
  historico: ['Tenente Pena', 'Estoque', 'Histórico de Estoque'],
  entradaLotes: ['Tenente Pena', 'Estoque', 'Movimentação de Entrada'],
  saidaLotes: ['Tenente Pena', 'Estoque', 'Movimentação de Saída'],
  reservas: ['Tenente Pena', 'Estoque', 'Reservas de Estoque'],
  rupturas: ['Tenente Pena', 'Estoque', 'Rupturas'],
  alertas: ['Tenente Pena', 'Estoque', 'Alertas'],
  autores: ['Tenente Pena', 'Autores', 'Listagem de Autores'],
  validades: ['Tenente Pena', 'Autores', 'Consultar Validades TP'],
  estoqueGeral: ['Outras Demandas', 'Estoque', 'Itens em Estoque Geral'],
  estoqueOD: ['Outras Demandas', 'Estoque', 'Estoque GSNET/IBL'],
  estoqueIblApi: ['Outras Demandas', 'Estoque', 'Estoque IBL (API)'],
  distribuicao: ['Outras Demandas', 'Estoque', 'Distribuição'],
  aquisicaoODAndamento: ['Outras Demandas', 'Compras', 'Aquisição em Andamento'],
  solicitacoesOD: ['Outras Demandas', 'Compras', 'Relatório de Compras OD'],
  autoresGeral: ['Outras Demandas', 'Autores', 'Listagem de Autores Demais Unidades'],
  autoresImportados: ['Importados', 'Listagem de Autores Importados'],
  relatorioImportados: ['Importados', 'Relatório de Compras Importados'],
  analiseImportados: ['Importados', 'Tabela Análise Importados'],
  relatorioItensImportados: ['Importados', 'Relatório de Itens Importados'],
  relatorioItens: ['Consultas', 'Relatório de Itens'],
  atas: ['Consultas', 'Atas de Registro de Preço'],
  consumoEntrega: ['Consultas', 'Consumo x Entrega'],
  associarEntrada: ['Estoque', 'Associar Entrada à Compra'],
  roboEmpenhos: ['Estoque', 'Robô de Empenhos'],
  usuarios: ['Administração', 'Usuários'],
  importadores: ['Administração', 'Importação'],
  statusServicos: ['Administração', 'Status dos Serviços'],
  elenco: ['Administração', 'Elenco'],
  busca: ['Busca de medicamento'],
};

function atualizarTrilha(pagina) {
  const trilha = document.getElementById('trilha');
  if (!trilha) return;
  const partes = TRILHAS[pagina] || ['—'];
  const sep = '<svg class="sep" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>';
  trilha.innerHTML = partes
    .map((p, i) => (i === partes.length - 1 ? `<span class="atual">${p}</span>` : `<span>${p}</span>`))
    .join(sep);
}

async function mudarPagina(pagina) {
  estado.paginaAtual = pagina;
  atualizarTrilha(pagina);
  document.querySelectorAll('.nav-lateral a').forEach((a) => a.classList.toggle('ativo', a.dataset.pagina === pagina));
  document.getElementById('paginaPainel').hidden = pagina !== 'painel';
  document.getElementById('paginaSolicitacoes').hidden = pagina !== 'solicitacoes';
  document.getElementById('paginaBusca').hidden = pagina !== 'busca';
  document.getElementById('paginaRelatorio').hidden = pagina !== 'relatorio';
  document.getElementById('paginaEstoque').hidden = pagina !== 'estoque';
  document.getElementById('paginaMonitoramento').hidden = pagina !== 'monitoramento';
  document.getElementById('paginaEstoqueGeral').hidden = pagina !== 'estoqueGeral';
  document.getElementById('paginaEstoqueOD').hidden = pagina !== 'estoqueOD';
  document.getElementById('paginaEstoqueIblApi').hidden = pagina !== 'estoqueIblApi';
  document.getElementById('paginaDistribuicao').hidden = pagina !== 'distribuicao';
  document.getElementById('paginaSolicitacoesOD').hidden = pagina !== 'solicitacoesOD';
  document.getElementById('paginaAquisicaoODAndamento').hidden = pagina !== 'aquisicaoODAndamento';
  document.getElementById('paginaValidades').hidden = pagina !== 'validades';
  document.getElementById('paginaHistorico').hidden = pagina !== 'historico';
  document.getElementById('paginaEvolucao').hidden = pagina !== 'evolucao';
  document.getElementById('paginaAutores').hidden = pagina !== 'autores';
  document.getElementById('paginaAutoresGeral').hidden = pagina !== 'autoresGeral';
  document.getElementById('paginaAutoresImportados').hidden = pagina !== 'autoresImportados';
  document.getElementById('paginaRelatorioImportados').hidden = pagina !== 'relatorioImportados';
  document.getElementById('paginaAnaliseImportados').hidden = pagina !== 'analiseImportados';
  document.getElementById('paginaRelatorioItensImportados').hidden = pagina !== 'relatorioItensImportados';
  document.getElementById('paginaConsumoEntrega').hidden = pagina !== 'consumoEntrega';
  document.getElementById('paginaAssociarEntrada').hidden = pagina !== 'associarEntrada';
  document.getElementById('paginaRoboEmpenhos').hidden = pagina !== 'roboEmpenhos';
  document.getElementById('paginaComparativoAutores').hidden = pagina !== 'comparativoAutores';
  document.getElementById('paginaRelatorioReq').hidden = pagina !== 'relatorioReq';
  document.getElementById('paginaCartasTroca').hidden = pagina !== 'cartasTroca';
  document.getElementById('paginaAtas').hidden = pagina !== 'atas';
  document.getElementById('paginaEntradaLotes').hidden = pagina !== 'entradaLotes';
  document.getElementById('paginaSaidaLotes').hidden = pagina !== 'saidaLotes';
  document.getElementById('paginaReservas').hidden = pagina !== 'reservas';
  document.getElementById('paginaRupturas').hidden = pagina !== 'rupturas';
  document.getElementById('paginaRelatorioItens').hidden = pagina !== 'relatorioItens';
  document.getElementById('paginaPlanejamento').hidden = pagina !== 'planejamento';
  document.getElementById('paginaElenco').hidden = pagina !== 'elenco';
  document.getElementById('paginaImportadores').hidden = pagina !== 'importadores';
  document.getElementById('paginaAlertas').hidden = pagina !== 'alertas';
  document.getElementById('paginaUsuarios').hidden = pagina !== 'usuarios';
  document.getElementById('paginaStatusServicos').hidden = pagina !== 'statusServicos';

  // O monitoramento só consulta o servidor enquanto a tela está aberta.
  if (pagina !== 'statusServicos') pararPollingServicos();

  try {
    if (pagina === 'painel') await carregarPainel();
    if (pagina === 'solicitacoes') await carregarSolicitacoes();
    if (pagina === 'relatorio') await carregarRelatorio();
    if (pagina === 'estoque') await carregarEstoque();
    if (pagina === 'monitoramento') await carregarMonitoramento();
    if (pagina === 'estoqueGeral') await carregarEstoqueGeral();
    if (pagina === 'estoqueOD') await carregarEstoqueOD();
    if (pagina === 'estoqueIblApi') await carregarEstoqueIblApi();
    if (pagina === 'distribuicao') await carregarDistribuicao();
    if (pagina === 'solicitacoesOD') await carregarSolicitacoesOD();
    if (pagina === 'aquisicaoODAndamento') await carregarAquisicaoODAndamento();
    if (pagina === 'validades') await carregarValidades();
    if (pagina === 'historico') await carregarHistorico();
    if (pagina === 'evolucao') iniciarEvolucao();
    if (pagina === 'autores') await carregarAutores();
    if (pagina === 'autoresGeral') await carregarAutoresGeral();
    if (pagina === 'autoresImportados') await carregarAutoresImportados();
    if (pagina === 'relatorioImportados') await carregarRelatorioImportados();
    if (pagina === 'analiseImportados') await carregarAnaliseImportados();
    if (pagina === 'relatorioItensImportados') await carregarRelatorioItensImportados();
    if (pagina === 'consumoEntrega') await carregarConsumoEntrega();
    if (pagina === 'associarEntrada') await carregarAssociarEntrada();
    if (pagina === 'roboEmpenhos') await carregarRoboEmpenhos();
    if (pagina === 'comparativoAutores') await carregarComparativo();
    if (pagina === 'relatorioReq') await carregarRelatorioReq();
    if (pagina === 'cartasTroca') await carregarCartasTroca();
    if (pagina === 'atas') await carregarAtas();
    if (pagina === 'entradaLotes') await carregarEntradaLotes();
    if (pagina === 'saidaLotes') await carregarSaidaLotes();
    if (pagina === 'reservas') await carregarReservas();
    if (pagina === 'rupturas') await carregarRupturas();
    if (pagina === 'relatorioItens') await carregarRelatorioItens();
    if (pagina === 'planejamento') await carregarPlanejamento();
    if (pagina === 'alertas') await carregarAlertas();
    if (pagina === 'usuarios') await carregarUsuarios();
    if (pagina === 'statusServicos') { await carregarStatusServicos(); iniciarPollingServicos(); }
  } catch (e) {
    if (!window.location.href.includes('login.html')) {
      mostrarErroPagina('pagina' + pagina.charAt(0).toUpperCase() + pagina.slice(1),
        'Erro ao carregar dados: ' + e.message);
    }
  }
}

// -------------------- Painel --------------------
// Estado do filtro por status do painel (qual barra está selecionada).
const estadoPainel = { status: null };

async function carregarPainel() {
  const STATUS_ABERTO = ['Planejamento', 'Adjudicado', 'Empenhado', 'Entrega Parcial'];

  // Busca tudo em paralelo; cada chamada é tolerante a falha (ex.: estoque
  // ainda sem importação) para o painel nunca ficar em branco por completo.
  const [resumo, alertasResp, validades, recentes] = await Promise.all([
    api('/solicitacoes/resumo').catch(() => ({ porStatus: [], atrasados: 0 })),
    api('/alertas?resolvido=false').catch(() => ({ alertas: [], totalAbertos: 0 })),
    api('/estoque/validades').catch(() => ({ lotes: [] })),
    api('/solicitacoes?status=__em_aberto__&page=1&pageSize=6').catch(() => ({ solicitacoes: [] })),
  ]);

  const porStatus = resumo.porStatus || [];
  const alertas = alertasResp.alertas || [];
  const totalAlertas = alertasResp.totalAbertos || 0;
  const comprasAndamento = porStatus
    .filter((s) => STATUS_ABERTO.includes(s.status))
    .reduce((soma, s) => soma + s.qtde, 0);
  const itensCriticos = alertas.filter((a) => a.tipo === 'estoque_ruptura').length;
  const vencendo30 = (validades.lotes || [])
    .filter((l) => l.dias_para_vencer >= 0 && l.dias_para_vencer <= 30).length;

  // --- Banner de alertas ---
  const banner = document.getElementById('painelBanner');
  if (totalAlertas > 0) {
    const p = totalAlertas > 1;
    banner.innerHTML = `
      <div class="texto"><strong>${totalAlertas} alerta${p ? 's' : ''} ativo${p ? 's' : ''}</strong> precisa${p ? 'm' : ''} de atenção — estoque em ruptura ou compras sem demanda registrada.</div>
      <button type="button" onclick="mudarPagina('alertas')">Ver alertas →</button>`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }

  // --- Cards de números (KPIs) ---
  document.getElementById('painelTiles').innerHTML = `
    <div class="painel-tile"><div class="numero">${comprasAndamento}</div><div class="rotulo">Compras em andamento</div></div>
    <div class="painel-tile critico"><div class="numero">${itensCriticos}</div><div class="rotulo">Itens com estoque crítico</div></div>
    <div class="painel-tile aviso"><div class="numero">${totalAlertas}</div><div class="rotulo">Alertas ativos</div></div>
    <div class="painel-tile"><div class="numero">${vencendo30}</div><div class="rotulo">Lotes vencendo em 30 dias</div></div>`;

  // --- Barras "Compras por status" ---
  const ORDEM = ['Planejamento', 'Adjudicado', 'Empenhado', 'Entrega Parcial', 'Finalizado', 'Cancelado', 'Deserto', 'Fracassado', 'Revogado'];
  const ordenado = porStatus.slice().sort((a, b) => ORDEM.indexOf(a.status) - ORDEM.indexOf(b.status));
  const maxQ = Math.max(1, ...ordenado.map((s) => s.qtde));
  const corBarra = (st) => (st === 'Entrega Parcial' ? 'andamento' : (st === 'Finalizado' ? 'final' : ''));
  // Cada barra é clicável: filtra a tabela "Compras" logo abaixo por aquele
  // status. Clicar de novo na mesma barra limpa o filtro.
  const barras = ordenado.map((s) => `
    <button type="button" class="barra-status clicavel" data-status="${escAttr(s.status)}"
            title="Ver as compras com status ${escAttr(s.status)}">
      <div class="linha-topo"><span>${s.status}</span><span class="valor">${s.qtde}</span></div>
      <div class="trilho"><div class="preenchido ${corBarra(s.status)}" style="width:${Math.round((s.qtde / maxQ) * 100)}%"></div></div>
    </button>`).join('') || '<p class="painel-vazio">Sem dados de status.</p>';
  document.getElementById('painelStatus').innerHTML =
    `<div class="cartao-cabecalho"><h3>Compras por status</h3>
       <span class="texto-apoio">clique para filtrar</span></div>${barras}`;

  document.querySelectorAll('#painelStatus .barra-status.clicavel').forEach((b) => {
    b.addEventListener('click', () => selecionarStatusPainel(b.dataset.status));
  });

  // --- Alertas recentes ---
  const listaAlertas = alertas.slice(0, 3).map((a) => `
    <div class="item-alerta">
      <span class="ponto ${a.tipo === 'estoque_ruptura' ? 'critico' : ''}"></span>
      <div><div class="alerta-txt">${a.mensagem || ''}</div><div class="data">${formatarDataHora(a.criado_em)}</div></div>
    </div>`).join('') || '<p class="painel-vazio">Nenhum alerta ativo. 🎉</p>';
  document.getElementById('painelAlertas').innerHTML = `
    <div class="cartao-cabecalho"><h3>Alertas recentes</h3><button class="painel-link" onclick="mudarPagina('alertas')">Ver todos →</button></div>
    <div class="lista-alertas">${listaAlertas}</div>`;

  // --- Alertas por categoria (gráfico, reaproveita os alertas já buscados) ---
  renderPainelCategoriaAlertas(alertas);

  // --- Compras em andamento (recentes) ---
  estadoPainel.status = null;
  renderPainelCompras(recentes.solicitacoes || [], null);
}

// Categoria de alerta escolhida no Painel, para pré-filtrar a tela de Alertas.
let categoriaAlertaInicial = '';

// Gráfico "Alertas por categoria" no Painel (mesmo visual da tela de Alertas).
// Reaproveita os alertas já buscados; clicar leva à tela de Alertas já filtrada.
function renderPainelCategoriaAlertas(alertas) {
  const box = document.getElementById('painelCategoriaAlertas');
  if (!box) return;
  const cont = {};
  for (const a of alertas) { const c = a.categoria || 'Sem categoria'; cont[c] = (cont[c] || 0) + 1; }
  const linhas = Object.entries(cont).sort((x, y) => y[1] - x[1]);
  if (linhas.length === 0) { box.hidden = true; return; }
  box.hidden = false;
  const total = alertas.length;
  const maxV = Math.max(...linhas.map(([, v]) => v));
  let extra = 0;
  const cor = (cat) => CORES_CATEGORIA_ALERTA[cat] || PALETA_CATEGORIA_EXTRA[extra++ % PALETA_CATEGORIA_EXTRA.length];
  box.innerHTML = `<div class="cartao-cabecalho"><h3>Alertas por categoria</h3><span class="texto-apoio">clique para ver</span></div>` +
    `<div class="grafico-categoria">` + linhas.map(([cat, v]) => {
      const larg = Math.round((v / maxV) * 100), pct = Math.round((v / total) * 100);
      return `<div class="linha-cat" data-cat="${escAttr(cat)}" role="button" tabindex="0">
        <span class="rot-cat" title="${escAttr(cat)}">${cat}</span>
        <span class="trilho-cat"><span class="barra-cat" style="width:${larg}%; background:${cor(cat)};"></span></span>
        <span class="val-cat">${fmtNumero(v)} · ${pct}%</span></div>`;
    }).join('') + `</div>`;
  box.querySelectorAll('.linha-cat').forEach((el) => {
    const ir = () => { categoriaAlertaInicial = el.dataset.cat; mudarPagina('alertas'); };
    el.addEventListener('click', ir);
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ir(); } });
  });
}

// Monta a tabela de compras do painel. `status` nulo = "em andamento"
// (comportamento padrão); com status, mostra as compras daquele status.
function renderPainelCompras(lista, status) {
  const linhas = (lista || []).map((s) => {
    const classe = classeStatus(s.status, s.data_previsao_entrega);
    const rotulo = rotuloStatus(s.status, s.data_previsao_entrega);
    return `<tr>
      <td class="medicamento">${s.descricao || '—'}</td>
      <td class="cod-item">${s.codigo_item || '—'}</td>
      <td>${s.n_oficio || '—'}</td>
      <td>${valorCelula(s.qtde_solicitada)}</td>
      <td><span class="etiqueta-status ${classe}">${rotulo}</span></td>
    </tr>`;
  }).join('');

  const titulo = status
    ? `Compras — ${status}`
    : 'Compras em andamento — recentes';
  const limpar = status
    ? `<button class="painel-link" type="button" id="limparStatusPainel">✕ Limpar filtro</button>`
    : '';
  const vazio = status
    ? `Nenhuma compra com status "${status}".`
    : 'Nenhuma compra em andamento.';

  document.getElementById('painelComprasRecentes').innerHTML = `
    <div class="cartao-cabecalho"><h3>${titulo}</h3>
      ${limpar}
      <button class="painel-link" onclick="mudarPagina('solicitacoes')">Ver relatório completo →</button></div>
    <table class="painel-tabela">
      <thead><tr><th>Medicamento</th><th>Código do item</th><th>Ofício</th><th>Qtde.</th><th>Status</th></tr></thead>
      <tbody>${linhas || `<tr><td colspan="5" class="painel-vazio">${vazio}</td></tr>`}</tbody>
    </table>`;

  const btnLimpar = document.getElementById('limparStatusPainel');
  if (btnLimpar) btnLimpar.addEventListener('click', () => selecionarStatusPainel(null));
}

// Clique numa barra de "Compras por status": busca as compras daquele status
// e atualiza a tabela. Clicar de novo na mesma barra (ou em "Limpar") volta
// ao padrão "em andamento".
async function selecionarStatusPainel(status) {
  const alvo = (status && status === estadoPainel.status) ? null : status;
  estadoPainel.status = alvo;

  // Realce da barra selecionada
  document.querySelectorAll('#painelStatus .barra-status').forEach((b) => {
    b.classList.toggle('ativa', !!alvo && b.dataset.status === alvo);
  });

  try {
    const filtro = alvo ? encodeURIComponent(alvo) : '__em_aberto__';
    const r = await api(`/solicitacoes?status=${filtro}&page=1&pageSize=6`);
    renderPainelCompras(r.solicitacoes || [], alvo);
  } catch (e) {
    document.getElementById('painelComprasRecentes').innerHTML =
      `<p class="painel-vazio">Não consegui carregar: ${escHtml(e.message)}</p>`;
  }
}

// -------------------- Solicitações --------------------
const filtroBusca = document.getElementById('filtroBusca');
const filtroStatus = document.getElementById('filtroStatus');
const filtroAno = document.getElementById('filtroAno');
const filtroStatusProcesso = document.getElementById('filtroStatusProcesso');
const filtroAtrasados = document.getElementById('filtroAtrasados');

let debounceBusca;
filtroBusca.addEventListener('input', () => {
  clearTimeout(debounceBusca);
  debounceBusca = setTimeout(() => { estado.solicitacoes.pagina = 1; carregarSolicitacoes(); }, 350);
});
filtroStatus.addEventListener('change', () => { estado.solicitacoes.pagina = 1; carregarSolicitacoes(); });
filtroAno.addEventListener('change', () => { estado.solicitacoes.pagina = 1; carregarSolicitacoes(); });
filtroStatusProcesso.addEventListener('change', () => { estado.solicitacoes.pagina = 1; carregarSolicitacoes(); });
filtroAtrasados.addEventListener('change', () => { estado.solicitacoes.pagina = 1; carregarSolicitacoes(); });

function preencherAnos() {
  const anoAtual = new Date().getFullYear();
  for (let a = anoAtual + 1; a >= 2025; a--) {
    const opt = document.createElement('option');
    opt.value = a;
    opt.textContent = a;
    filtroAno.appendChild(opt);
  }
}

// Ícones (traço simples) e montagem do cartão de KPI no estilo do mockup:
// ícone + rótulo em cima, número grande, linha descritiva embaixo.
const KPI_ICONES = {
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  chart: '<path d="M4 19h16M4 19V5M7 15l4-5 3 3 5-7"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  relogio: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
function kpiCard(icone, num, rotulo, sub, classe = '') {
  const svg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${KPI_ICONES[icone] || ''}</svg>`;
  return `<div class="cartao-kpi">
      <div class="rot">${svg}${rotulo}</div>
      <div class="num${classe ? ' ' + classe : ''}">${num}</div>
      <div class="sub">${sub || ''}</div>
    </div>`;
}

// KPIs da Tabela Análise TP, a partir do resumo (totais exatos, não paginados).
async function renderKpisSolicitacoes() {
  const alvo = document.getElementById('kpisSolicitacoes');
  if (!alvo) return;
  let r;
  try { r = await api('/solicitacoes/resumo'); } catch (_) { return; }
  const ABERTO = ['Planejamento', 'Adjudicado', 'Empenhado', 'Entrega Parcial', 'Em andamento'];
  const porStatus = r.porStatus || [];
  const soma = (fil) => porStatus.filter(fil).reduce((s, l) => s + l.qtde, 0);
  const total = soma(() => true);
  const andamento = soma((l) => ABERTO.includes(l.status));
  const finalizadas = soma((l) => l.status === 'Finalizado');
  const atrasadas = r.atrasados || 0;
  const n = (v) => v.toLocaleString('pt-BR');
  const pct = total ? Math.round((finalizadas / total) * 100) : 0;
  alvo.innerHTML =
    kpiCard('doc', n(total), 'Total de solicitações', 'todos os meses') +
    kpiCard('chart', n(andamento), 'Em andamento', 'Planejamento · Adjudicado · Empenhado · Entrega Parcial', 'aviso') +
    kpiCard('check', n(finalizadas), 'Finalizadas', `${pct}% do total`) +
    kpiCard('relogio', n(atrasadas), 'Atrasadas', 'previsão de entrega vencida', atrasadas > 0 ? 'critico' : '');
}

async function carregarSolicitacoes() {
  carregarUltimaAtualizacao('atualizadoSolicitacoes', 'solicitacoes');
  renderKpisSolicitacoes();
  const params = new URLSearchParams();
  if (filtroBusca.value) params.set('q', filtroBusca.value);
  if (filtroStatus.value) params.set('status', filtroStatus.value);
  if (filtroAno.value) params.set('ano', filtroAno.value);
  if (filtroStatusProcesso.value) params.set('statusProcesso', filtroStatusProcesso.value);
  if (filtroAtrasados.checked) params.set('atrasados', 'true');
  params.set('page', estado.solicitacoes.pagina);
  params.set('pageSize', estado.solicitacoes.pageSize);
  popularFiltroStatusProcesso();

  const { solicitacoes, total } = await api(`/solicitacoes?${params.toString()}`);
  estado.solicitacoes.total = total;

  const corpo = document.getElementById('corpoTabelaSolicitacoes');
  const vazio = document.getElementById('estadoVazio');

  if (solicitacoes.length === 0) {
    corpo.innerHTML = '';
    vazio.hidden = false;
  } else {
    vazio.hidden = true;
    corpo.innerHTML = solicitacoes.map((s) => {
      const classe = classeStatus(s.status, s.data_previsao_entrega);
      const rotulo = rotuloStatus(s.status, s.data_previsao_entrega);
      return `
        <tr>
          <td class="col-codigo">${s.codigo_item || '—'}</td>
          <td class="col-codigo">${s.codigo_siafisico || '—'}</td>
          <td>${s.descricao || '—'}</td>
          <td>${s.ano || '—'}</td>
          <td>${s.mes || '—'}</td>
          <td>${s.tipo ? `<span class="tag-tipo">${s.tipo}</span>` : '—'}</td>
          <td>${s.modalidade_compra || '—'}</td>
          <td class="col-codigo">${s.n_oficio || '—'}</td>
          <td>${valorCelula(s.qtde_solicitada)}</td>
          <td class="col-data">${formatarData(s.data_solicitacao)}</td>
          <td class="col-codigo">${fmtGsnet(s.requisicao_gsnet) || '—'}</td>
          <td class="col-codigo">${s.n_empenho || '—'}</td>
          <td class="col-data">${formatarData(s.data_entrega)}</td>
          <td>${valorCelula(s.qtde_entregue)}</td>
          <td>${valorCelula(s.qtde_pendente)}</td>
          <td><span class="etiqueta-status ${classe}">${rotulo}</span></td>
          <td>${escHtml(s.status_item_processo || '—')}</td>
          <td>${estado.usuario.perfil === 'admin' ? `<button class="botao-editar" data-id="${s.id}">Editar</button>` : ''}</td>
        </tr>
      `;
    }).join('');

    corpo.querySelectorAll('.botao-editar').forEach((btn) => {
      btn.addEventListener('click', () => abrirModalSolicitacao(btn.dataset.id));
    });
  }

  const totalPaginas = Math.max(Math.ceil(total / estado.solicitacoes.pageSize), 1);
  document.getElementById('textoPaginacao').textContent =
    `${total} resultado${total === 1 ? '' : 's'} · página ${estado.solicitacoes.pagina} de ${totalPaginas}`;
  document.getElementById('botaoAnterior').disabled = estado.solicitacoes.pagina <= 1;
  document.getElementById('botaoProximo').disabled = estado.solicitacoes.pagina >= totalPaginas;
}

document.getElementById('botaoAnterior').addEventListener('click', () => {
  if (estado.solicitacoes.pagina > 1) { estado.solicitacoes.pagina--; carregarSolicitacoes(); }
});
document.getElementById('botaoProximo').addEventListener('click', () => {
  estado.solicitacoes.pagina++; carregarSolicitacoes();
});

// -------------------- Modal de solicitação --------------------
const modalSolicitacao = document.getElementById('modalSolicitacao');
const formSolicitacao = document.getElementById('formSolicitacao');
let idSolicitacaoEditando = null;

document.getElementById('botaoNovaSolicitacao').addEventListener('click', () => abrirModalSolicitacao(null));
document.getElementById('botaoCancelarModal').addEventListener('click', () => { modalSolicitacao.hidden = true; });

// Botão "Atualizar agora" (só admin) — relê o arquivo da pasta de rede e
// reimporta na hora, sem esperar os horários agendados (12h/19h). Como TP e OD
// vêm cada um de UM arquivo e cada par de telas lê da MESMA tabela, o botão
// fica só na tela "Relatório de Compras" de cada fonte; a tela irmã (Tabela
// Análise TP / Aquisição em Andamento OD) já pega os dados novos ao abrir.
const RECARGA_ATUALIZAR_AGORA = {
  btnAtualizarAgoraRelatorio: carregarRelatorio,
  btnAtualizarAgoraSolicitacoesOD: carregarSolicitacoesOD,
};
// Mostra um recado curto ao lado do botão (cria o span se ainda não existir).
function statusAtualizarAgora(botao, texto, cor) {
  let el = botao.nextElementSibling;
  if (!el || !el.classList.contains('status-atualizar-agora')) {
    el = document.createElement('span');
    el.className = 'status-atualizar-agora atualizado-em';
    botao.after(el);
  }
  el.textContent = texto || '';
  el.style.color = cor || '';
  el.hidden = !texto;
}
document.querySelectorAll('.botao-atualizar-agora').forEach((botao) => {
  botao.addEventListener('click', async () => {
    const fonte = botao.dataset.fonte; // 'tp' ou 'od'
    const rota = fonte === 'od' ? '/solicitacoes-od/atualizar-agora' : '/importar-solicitacoes/atualizar-agora';
    const rotulo = botao.textContent;
    botao.disabled = true;
    botao.textContent = '↻ Atualizando…';
    statusAtualizarAgora(botao, '');
    try {
      const r = await api(rota, { method: 'POST' });
      const recarregar = RECARGA_ATUALIZAR_AGORA[botao.id];
      if (recarregar) await recarregar();
      const ins = r.inseridos ?? 0;
      const atu = r.atualizados ?? 0;
      statusAtualizarAgora(botao, `✔ Atualizado: ${ins} inseridos, ${atu} atualizados.`, '#2c7a4b');
    } catch (e) {
      statusAtualizarAgora(botao, e.message || 'Não foi possível atualizar agora.', '#a3372b');
    } finally {
      botao.disabled = false;
      botao.textContent = rotulo;
    }
  });
});

async function carregarItensCache(filtro = '') {
  const { itens } = await api(`/itens?q=${encodeURIComponent(filtro)}&pageSize=50`);
  const lista = document.getElementById('listaItens');
  lista.innerHTML = itens.map((i) => `<option value="${i.codigo_item} — ${i.descricao}">`).join('');
  estado.itensCache = itens;
}

async function abrirModalSolicitacao(id) {
  idSolicitacaoEditando = id;
  formSolicitacao.reset();
  document.getElementById('botaoExcluirSolicitacao').hidden = !id;
  document.getElementById('campoItemNovo').hidden = !!id;

  if (id) {
    document.getElementById('tituloModalSolicitacao').textContent = 'Editar solicitação';
    const { solicitacao } = await api(`/solicitacoes/${id}`);
    document.getElementById('descricaoModalSolicitacao').textContent =
      `${solicitacao.descricao} (${solicitacao.codigo_item})`;

    document.getElementById('campoAno').value = solicitacao.ano || '';
    document.getElementById('campoMes').value = solicitacao.mes || '';
    document.getElementById('campoTipo').value = solicitacao.tipo || 'AS';
    document.getElementById('campoModalidade').value = solicitacao.modalidade_compra || '';
    document.getElementById('campoOficio').value = solicitacao.n_oficio || '';
    document.getElementById('campoQtdeSolicitada').value = solicitacao.qtde_solicitada ?? '';
    document.getElementById('campoDataSolicitacao').value = solicitacao.data_solicitacao || '';
    document.getElementById('campoRequisicaoGsnet').value = solicitacao.requisicao_gsnet || '';
    document.getElementById('campoNEmpenho').value = solicitacao.n_empenho || '';
    document.getElementById('campoQuantidadeEmpenho').value = solicitacao.quantidade_empenho ?? '';
    document.getElementById('campoDataPrevisao').value = solicitacao.data_previsao_entrega || '';
    document.getElementById('campoDataEntrega').value = solicitacao.data_entrega || '';
    document.getElementById('campoQtdeEntregue').value = solicitacao.qtde_entregue ?? '';
    document.getElementById('campoQtdePendente').value = solicitacao.qtde_pendente ?? '';
    document.getElementById('campoStatus').value = solicitacao.status || '';
    document.getElementById('campoObservacao').value = solicitacao.observacao || '';
    document.getElementById('campoJustificativa').value = solicitacao.justificativa || '';
  } else {
    document.getElementById('tituloModalSolicitacao').textContent = 'Nova solicitação';
    document.getElementById('descricaoModalSolicitacao').textContent = 'Selecione o item do catálogo e preencha os dados da solicitação.';
    document.getElementById('campoAno').value = new Date().getFullYear();
    await carregarItensCache();
  }

  modalSolicitacao.hidden = false;
}

document.getElementById('campoCodigoItem').addEventListener('input', (ev) => {
  carregarItensCache(ev.target.value);
});

document.getElementById('botaoExcluirSolicitacao').addEventListener('click', async () => {
  if (!idSolicitacaoEditando) return;
  if (!confirm('Excluir esta solicitação? Esta ação não pode ser desfeita.')) return;
  await api(`/solicitacoes/${idSolicitacaoEditando}`, { method: 'DELETE' });
  modalSolicitacao.hidden = true;
  carregarSolicitacoes();
});

formSolicitacao.addEventListener('submit', async (ev) => {
  ev.preventDefault();

  const corpo = {
    ano: Number(document.getElementById('campoAno').value) || null,
    mes: document.getElementById('campoMes').value,
    tipo: document.getElementById('campoTipo').value,
    modalidade_compra: document.getElementById('campoModalidade').value || null,
    n_oficio: document.getElementById('campoOficio').value || null,
    qtde_solicitada: Number(document.getElementById('campoQtdeSolicitada').value) || null,
    data_solicitacao: document.getElementById('campoDataSolicitacao').value || null,
    requisicao_gsnet: document.getElementById('campoRequisicaoGsnet').value || null,
    n_empenho: document.getElementById('campoNEmpenho').value || null,
    quantidade_empenho: Number(document.getElementById('campoQuantidadeEmpenho').value) || null,
    data_previsao_entrega: document.getElementById('campoDataPrevisao').value || null,
    data_entrega: document.getElementById('campoDataEntrega').value || null,
    qtde_entregue: Number(document.getElementById('campoQtdeEntregue').value) || null,
    qtde_pendente: Number(document.getElementById('campoQtdePendente').value) || null,
    status: document.getElementById('campoStatus').value || null,
    observacao: document.getElementById('campoObservacao').value || null,
    justificativa: document.getElementById('campoJustificativa').value || null,
  };

  try {
    if (idSolicitacaoEditando) {
      await api(`/solicitacoes/${idSolicitacaoEditando}`, { method: 'PUT', body: JSON.stringify(corpo) });
    } else {
      const valorItem = document.getElementById('campoCodigoItem').value;
      const codigo = valorItem.split(' — ')[0].trim();
      if (!codigo) { alert('Selecione um item válido do catálogo.'); return; }
      corpo.codigo_item = codigo;
      await api('/solicitacoes', { method: 'POST', body: JSON.stringify(corpo) });
    }
    modalSolicitacao.hidden = true;
    carregarSolicitacoes();
    carregarPainel();
  } catch (e) {
    alert(e.message);
  }
});

// -------------------- Buscar andamento de medicamento --------------------
const campoBuscaMedicamento = document.getElementById('campoBuscaMedicamento');
const botaoBuscarMedicamento = document.getElementById('botaoBuscarMedicamento');

botaoBuscarMedicamento.addEventListener('click', buscarMedicamento);

// Exemplos clicáveis abaixo do campo de busca (preenchem e já buscam).
(function montarExemplosBusca() {
  const wrap = document.getElementById('buscaExemplos');
  if (!wrap) return;
  ['abatacepte', 'rituximabe', 'lanadelumabe', 'trikafta'].forEach((ex) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip-exemplo';
    b.textContent = ex;
    b.addEventListener('click', () => { campoBuscaMedicamento.value = ex; buscarMedicamento(); });
    wrap.appendChild(b);
  });
})();
campoBuscaMedicamento.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') buscarMedicamento();
});

async function buscarMedicamento() {
  const q = campoBuscaMedicamento.value.trim();
  const container = document.getElementById('resultadosBuscaMedicamento');

  if (q.length < 2) {
    container.innerHTML = '<div class="estado-vazio">Digite ao menos 2 caracteres.</div>';
    return;
  }

  let dados;
  try {
    dados = await api(`/solicitacoes/historico-medicamento?q=${encodeURIComponent(q)}`);
  } catch (e) {
    container.innerHTML = `<div class="estado-vazio">${e.message}</div>`;
    return;
  }

  if (dados.resultados.length === 0) {
    container.innerHTML = '<div class="estado-vazio">Nenhum medicamento encontrado com este termo.</div>';
    return;
  }

  const ABERTO_BUSCA = ['Planejamento', 'Adjudicado', 'Empenhado', 'Entrega Parcial'];
  container.innerHTML = dados.resultados.map((r) => {
    const semHistorico = r.historico.length === 0;
    // Mini-KPIs do medicamento, calculados do próprio histórico.
    const total = r.historico.length;
    const emAndamento = r.historico.filter((h) => ABERTO_BUSCA.includes(h.status)).length;
    const finalizadas = r.historico.filter((h) => h.status === 'Finalizado').length;
    const ultima = r.historico.reduce((best, h) => {
      const v = (Number(h.ano) || 0) * 12 + (Number(h.mes) || 0);
      return v > best.v ? { v, txt: `${h.mes}/${h.ano}` } : best;
    }, { v: -1, txt: '—' }).txt;
    const chip = (rot, val, cor) => `<span class="busca-kpi"><span class="busca-kpi-num" style="color:${cor}">${val}</span> ${rot}</span>`;
    const faixaKpi = semHistorico ? '' : `<div class="busca-kpi-faixa">
      ${chip('solicitações', total, 'var(--selo-escuro)')}
      ${chip('em andamento', emAndamento, '#2a78d6')}
      ${chip('finalizadas', finalizadas, '#1baf7a')}
      <span class="busca-kpi"><span class="busca-kpi-num" style="color:var(--selo-escuro)">${ultima}</span> última compra</span>
    </div>`;
    return `
    <div class="tabela-wrap" style="margin-bottom:18px;">
      <div style="padding:14px 16px; border-bottom:1px solid var(--linha); background:var(--zebra);">
        <strong>${r.item.descricao}</strong>
        <div class="col-codigo" style="margin-top:2px;">${r.item.codigo_item}${r.item.codigo_siafisico ? ' · SIAFI ' + r.item.codigo_siafisico : ''}</div>
        ${faixaKpi}
      </div>
      ${semHistorico
        ? '<div class="estado-vazio">Nenhuma solicitação registrada para este item ainda.</div>'
        : `<table>
            <thead><tr><th>Período</th><th>Modalidade</th><th>Ofício</th><th>Empenho</th><th>Previsão</th><th>Entrega</th><th>Status</th></tr></thead>
            <tbody>
              ${r.historico.map((h) => {
                const classe = classeStatus(h.status, h.data_previsao_entrega);
                const rotulo = rotuloStatus(h.status, h.data_previsao_entrega);
                return `
                <tr>
                  <td>${h.mes}/${h.ano}</td>
                  <td>${h.modalidade_compra || '—'}</td>
                  <td>${h.n_oficio || '—'}</td>
                  <td>${h.n_empenho || '—'}</td>
                  <td class="col-data">${formatarData(h.data_previsao_entrega)}</td>
                  <td class="col-data">${formatarData(h.data_entrega)}</td>
                  <td><span class="etiqueta-status ${classe}">${rotulo}</span></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>`
      }
    </div>`;
  }).join('');
}

// -------------------- Relatório consolidado (todos os meses) --------------------
const filtroAnoRelatorio = document.getElementById('filtroAnoRelatorio');
const filtroBuscaRelatorio = document.getElementById('filtroBuscaRelatorio');
const filtroStatusRelatorio = document.getElementById('filtroStatusRelatorio');
const filtroStatusProcessoRelatorio = document.getElementById('filtroStatusProcessoRelatorio');

// Monta os parâmetros de filtro atuais do relatório
function paramsRelatorio() {
  const params = new URLSearchParams();
  if (filtroAnoRelatorio.value) params.set('ano', filtroAnoRelatorio.value);
  if (filtroBuscaRelatorio.value.trim()) params.set('q', filtroBuscaRelatorio.value.trim());
  if (filtroStatusRelatorio.value) params.set('status', filtroStatusRelatorio.value);
  if (filtroStatusProcessoRelatorio.value) params.set('statusProcesso', filtroStatusProcessoRelatorio.value);
  return params;
}

document.getElementById('botaoExportarRelatorio').addEventListener('click', () => {
  const params = paramsRelatorio();
  params.set('formato', 'csv');
  window.open(`/api/relatorios/consolidado?${params.toString()}`, '_blank');
});

filtroAnoRelatorio.addEventListener('change', carregarRelatorio);
filtroStatusRelatorio.addEventListener('change', carregarRelatorio);
filtroStatusProcessoRelatorio.addEventListener('change', carregarRelatorio);
let debounceBuscaRelatorio;
filtroBuscaRelatorio.addEventListener('input', () => {
  clearTimeout(debounceBuscaRelatorio);
  debounceBuscaRelatorio = setTimeout(carregarRelatorio, 350);
});
document.getElementById('botaoLimparFiltrosRelatorio').addEventListener('click', () => {
  filtroBuscaRelatorio.value = '';
  filtroStatusRelatorio.value = '';
  filtroAnoRelatorio.value = '';
  filtroStatusProcessoRelatorio.value = '';
  carregarRelatorio();
});

// Popula (uma vez) os dois filtros "Status Item Processo" com os valores reais
// vindos do robô de Compras (compras_estrategico). Preserva a seleção atual.
let statusProcessoCarregado = false;
async function popularFiltroStatusProcesso() {
  if (statusProcessoCarregado) return;
  statusProcessoCarregado = true;
  let valores = [];
  try { valores = (await api('/solicitacoes/status-processo')).valores || []; }
  catch (e) { statusProcessoCarregado = false; return; }
  const opcoes = valores.map((v) => `<option value="${escAttr(v)}">${escHtml(v)}</option>`).join('');
  for (const sel of [filtroStatusProcesso, filtroStatusProcessoRelatorio]) {
    if (!sel) continue;
    const atual = sel.value;
    sel.innerHTML = '<option value="">Status Item Processo: todos</option>' + opcoes;
    sel.value = atual;
  }
}

// KPIs do Relatório de Compras TP, calculados no navegador a partir das linhas
// já carregadas — refletem o filtro atual (ano/status/busca) da tela.
function renderKpisRelatorio(solicitacoes) {
  const alvo = document.getElementById('kpisRelatorio');
  if (!alvo) return;
  const ABERTO = ['Planejamento', 'Adjudicado', 'Empenhado', 'Entrega Parcial'];
  const total = solicitacoes.length;
  const emAndamento = solicitacoes.filter((s) => ABERTO.includes(s.status)).length;
  const finalizadas = solicitacoes.filter((s) => s.status === 'Finalizado').length;
  const itens = new Set(solicitacoes.map((s) => s.codigo_item).filter(Boolean)).size;
  const n = (v) => v.toLocaleString('pt-BR');
  const pct = total ? Math.round((finalizadas / total) * 100) : 0;
  alvo.innerHTML =
    kpiCard('doc', n(total), 'Solicitações (filtro atual)', 'no recorte selecionado') +
    kpiCard('chart', n(emAndamento), 'Em andamento', 'Planejamento · Adjudicado · Empenhado · Entrega Parcial', 'aviso') +
    kpiCard('check', n(finalizadas), 'Finalizadas', `${pct}% do total`) +
    kpiCard('list', n(itens), 'Itens distintos', 'medicamentos diferentes');
}

async function carregarRelatorio() {
  carregarUltimaAtualizacao('atualizadoRelatorio', 'solicitacoes');
  popularFiltroStatusProcesso();
  if (filtroAnoRelatorio.options.length <= 1) {
    const anoAtual = new Date().getFullYear();
    for (let a = anoAtual + 1; a >= 2025; a--) {
      const opt = document.createElement('option');
      opt.value = a;
      opt.textContent = a;
      filtroAnoRelatorio.appendChild(opt);
    }
  }

  const params = paramsRelatorio();

  const { solicitacoes } = await api(`/relatorios/consolidado?${params.toString()}`);

  renderKpisRelatorio(solicitacoes);

  const corpo = document.getElementById('corpoTabelaRelatorio');
  const vazio = document.getElementById('estadoVazioRelatorio');

  if (solicitacoes.length === 0) {
    corpo.innerHTML = '';
    vazio.hidden = false;
    return;
  }
  vazio.hidden = true;

  corpo.innerHTML = solicitacoes.map((s) => {
    const classe = classeStatus(s.status, s.data_previsao_entrega);
    const rotulo = rotuloStatus(s.status, s.data_previsao_entrega);
    return `
      <tr>
        <td class="col-codigo">${s.codigo_item || '—'}</td>
        <td class="col-codigo">${s.codigo_siafisico || '—'}</td>
        <td>${s.descricao || '—'}</td>
        <td>${s.ano || '—'}</td>
        <td>${s.mes || '—'}</td>
        <td>${s.tipo ? `<span class="tag-tipo">${s.tipo}</span>` : '—'}</td>
        <td>${s.modalidade_compra || '—'}</td>
        <td class="col-codigo">${s.n_oficio || '—'}</td>
        <td>${valorCelula(s.qtde_solicitada)}</td>
        <td class="col-data">${formatarData(s.data_solicitacao)}</td>
        <td class="col-codigo">${fmtGsnet(s.requisicao_gsnet) || '—'}</td>
        <td class="col-codigo">${s.n_empenho || '—'}</td>
        <td class="col-data">${formatarData(s.data_entrega)}</td>
        <td>${valorCelula(s.qtde_entregue)}</td>
        <td>${valorCelula(s.qtde_pendente)}</td>
        <td><span class="etiqueta-status ${classe}">${rotulo}</span></td>
        <td>${escHtml(s.status_item_processo || '—')}</td>
      </tr>
    `;
  }).join('');
}

// -------------------- Elenco de medicamentos (busca e edição) --------------------
const campoBuscaElenco = document.getElementById('campoBuscaElenco');
document.getElementById('botaoBuscarElenco').addEventListener('click', buscarItemElenco);
campoBuscaElenco.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') buscarItemElenco(); });

async function buscarItemElenco() {
  const codigo = campoBuscaElenco.value.trim();
  const container = document.getElementById('resultadoBuscaElenco');
  if (!codigo) {
    container.innerHTML = '<div class="estado-vazio">Informe o código do item.</div>';
    return;
  }

  let dados;
  try {
    dados = await api(`/elenco/buscar?codigo=${encodeURIComponent(codigo)}`);
  } catch (e) {
    container.innerHTML = `<div class="estado-vazio">${e.message}</div>`;
    return;
  }

  const { item, qtdeSolicitacoes } = dados;
  container.innerHTML = `
    <div class="ficha-elenco">
      <div class="codigo-grande">${item.codigo_item}</div>
      <h3>${item.descricao}</h3>
      ${item.ativo === 0 ? `<p style="color:var(--vermelho); font-size:13px; margin-bottom:14px;">Este item está inativo no elenco (saiu da última importação)${item.inativado_em ? ' em ' + formatarData(item.inativado_em.slice(0,10)) : ''}. O histórico de ${qtdeSolicitacoes} solicitação(ões) continua disponível.</p>` : ''}
      <form id="formEditarElenco">
        <div class="grade-form">
          <div>
            <label for="campoSiafisicoElenco">Código Siafísico</label>
            <input type="text" id="campoSiafisicoElenco" value="${item.codigo_siafisico || ''}">
          </div>
          <div>
            <label for="campoCatmatElenco">CATMAT</label>
            <input type="text" id="campoCatmatElenco" value="${item.catmat || ''}">
          </div>
          <div class="campo-largo">
            <label for="campoDescricaoElenco">Descrição</label>
            <textarea id="campoDescricaoElenco">${item.descricao}</textarea>
          </div>
        </div>
        <div class="acoes-modal" style="justify-content:flex-start;">
          <button type="submit" class="botao-primario">Salvar alterações</button>
        </div>
      </form>
    </div>
  `;

  document.getElementById('formEditarElenco').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api(`/elenco/${encodeURIComponent(item.codigo_item)}`, {
        method: 'PUT',
        body: JSON.stringify({
          codigo_siafisico: document.getElementById('campoSiafisicoElenco').value.trim() || null,
          catmat: document.getElementById('campoCatmatElenco').value.trim() || null,
          descricao: document.getElementById('campoDescricaoElenco').value.trim(),
        }),
      });
      buscarItemElenco();
    } catch (e) {
      alert(e.message);
    }
  });
}

// -------------------- Importadores --------------------
function renderResultadoImportacao(elementId, resumo, tipo) {
  const el = document.getElementById(elementId);
  let linhas = '';

  if (tipo === 'previa-elenco') {
    linhas = `
      <div class="linha"><span>Linhas na planilha</span><strong>${resumo.totalLinhasPlanilha}</strong></div>
      <div class="linha"><span>Itens novos</span><strong>${resumo.itensNovos.length}</strong></div>
      <div class="linha"><span>Itens com dados alterados</span><strong>${resumo.itensAtualizados.length}</strong></div>
      <div class="linha"><span>Itens que vão ser inativados</span><strong>${resumo.itensParaInativar.length}</strong></div>
    `;
    const comHistorico = resumo.itensParaInativar.filter((i) => i.tem_historico);
    if (comHistorico.length > 0) {
      linhas += `<div class="lista-codigos">⚠ ${comHistorico.length} item(ns) a inativar já têm histórico de compra — um alerta será criado automaticamente para cada um.</div>`;
    }
  } else if (tipo === 'previa-solicitacoes') {
    linhas = `
      <div class="linha"><span>Abas encontradas</span><strong>${resumo.abasEncontradas.join(', ')}</strong></div>
      <div class="linha"><span>Linhas com movimento</span><strong>${resumo.totalLinhasComMovimento}</strong></div>
      <div class="linha"><span>Novas (serão inseridas)</span><strong>${resumo.novos}</strong></div>
      <div class="linha"><span>Já existentes</span><strong>${resumo.possiveisDuplicados}</strong></div>
      <div class="linha"><span>Itens não cadastrados no elenco</span><strong>${resumo.itensInexistentes}</strong></div>
    `;
    if (resumo.codigosInexistentes.length > 0) {
      linhas += `<div class="lista-codigos">Códigos não encontrados no elenco: ${resumo.codigosInexistentes.join(', ')}. Cadastre-os primeiro pelo importador de elenco.</div>`;
    }
  } else if (tipo === 'confirmar-elenco') {
    linhas = `
      <div class="linha"><span>Itens inseridos</span><strong>${resumo.inseridos}</strong></div>
      <div class="linha"><span>Itens atualizados</span><strong>${resumo.atualizados}</strong></div>
      <div class="linha"><span>Itens inativados</span><strong>${resumo.inativados}</strong></div>
      <div class="linha"><span>Alertas gerados</span><strong>${resumo.alertasGerados}</strong></div>
    `;
  } else if (tipo === 'confirmar-solicitacoes') {
    linhas = `
      <div class="linha"><span>Inseridos</span><strong>${resumo.inseridos}</strong></div>
      <div class="linha"><span>Ignorados (já existiam)</span><strong>${resumo.ignorados}</strong></div>
      <div class="linha"><span>Itens não cadastrados</span><strong>${resumo.itensInexistentes}</strong></div>
    `;
    // No modo "substituir" o importador REFAZ cada mês da planilha (apaga e
    // regrava), então mostramos quantos meses foram refeitos em vez de
    // "atualizados", que nesse modo é sempre zero.
    if (resumo.mesesRefeitos > 0) {
      linhas += `<div class="linha"><span>Meses refeitos pela planilha</span><strong>${resumo.mesesRefeitos}</strong></div>`;
      linhas += `<div class="linha"><span>Linhas antigas substituídas</span><strong>${resumo.apagados}</strong></div>`;
    }
    if (resumo.avisos && resumo.avisos.length > 0) {
      linhas += `<div class="lista-codigos"><strong>Atenção:</strong> ${resumo.avisos.join(' ')}</div>`;
    }
    if (resumo.codigosInexistentes.length > 0) {
      linhas += `<div class="lista-codigos">Não importados (item não está no elenco): ${resumo.codigosInexistentes.join(', ')}</div>`;
    }
  }

  el.innerHTML = `<div class="bloco-resultado-importacao">${linhas}</div>`;
}

// --- Elenco ---
let arquivoElencoSelecionado = null;
document.getElementById('botaoPreviaElenco').addEventListener('click', async () => {
  const input = document.getElementById('arquivoElenco');
  if (!input.files[0]) { alert('Selecione um arquivo .xlsx/.xlsm primeiro.'); return; }
  arquivoElencoSelecionado = input.files[0];

  const el = document.getElementById('resultadoImportacaoElenco');
  el.innerHTML = '<div class="estado-vazio">Analisando planilha…</div>';

  const formData = new FormData();
  formData.append('arquivo', arquivoElencoSelecionado);

  try {
    const resp = await fetch('/api/elenco/previa', { method: 'POST', body: formData });
    const dados = await resp.json();
    if (!resp.ok) throw new Error(dados.erro);
    renderResultadoImportacao('resultadoImportacaoElenco', dados, 'previa-elenco');
    document.getElementById('botaoConfirmarElenco').disabled = false;
  } catch (e) {
    el.innerHTML = `<div class="estado-vazio">${e.message}</div>`;
    document.getElementById('botaoConfirmarElenco').disabled = true;
  }
});

document.getElementById('botaoConfirmarElenco').addEventListener('click', async () => {
  if (!arquivoElencoSelecionado) return;
  if (!confirm('Confirmar a importação do elenco? Itens novos serão cadastrados, existentes atualizados, e os que saírem da lista serão inativados.')) return;

  const el = document.getElementById('resultadoImportacaoElenco');
  el.innerHTML = '<div class="estado-vazio">Importando…</div>';

  const formData = new FormData();
  formData.append('arquivo', arquivoElencoSelecionado);

  try {
    const resp = await fetch('/api/elenco/confirmar', { method: 'POST', body: formData });
    const dados = await resp.json();
    if (!resp.ok) throw new Error(dados.erro);
    renderResultadoImportacao('resultadoImportacaoElenco', dados, 'confirmar-elenco');
    document.getElementById('botaoConfirmarElenco').disabled = true;
    atualizarBadgeAlertas();
  } catch (e) {
    el.innerHTML = `<div class="estado-vazio">${e.message}</div>`;
  }
});

// --- Solicitações (novas aquisições) ---
let arquivoSolicitacoesSelecionado = null;
document.getElementById('botaoPreviaSolicitacoes').addEventListener('click', async () => {
  const input = document.getElementById('arquivoSolicitacoes');
  if (!input.files[0]) { alert('Selecione um arquivo .xlsx/.xlsm primeiro.'); return; }
  arquivoSolicitacoesSelecionado = input.files[0];

  const el = document.getElementById('resultadoImportacaoSolicitacoes');
  el.innerHTML = '<div class="estado-vazio">Analisando planilha (pode levar até 1 minuto em arquivos grandes)…</div>';

  const formData = new FormData();
  formData.append('arquivo', arquivoSolicitacoesSelecionado);

  try {
    const resp = await fetch('/api/importar-solicitacoes/previa', { method: 'POST', body: formData });
    const dados = await resp.json();
    if (!resp.ok) throw new Error(dados.erro);
    renderResultadoImportacao('resultadoImportacaoSolicitacoes', dados, 'previa-solicitacoes');
    document.getElementById('botaoConfirmarSolicitacoes').disabled = false;
  } catch (e) {
    el.innerHTML = `<div class="estado-vazio">${e.message}</div>`;
    document.getElementById('botaoConfirmarSolicitacoes').disabled = true;
  }
});

document.getElementById('botaoConfirmarSolicitacoes').addEventListener('click', async () => {
  if (!arquivoSolicitacoesSelecionado) return;
  const modo = document.querySelector('input[name="modoImportacao"]:checked').value;
  if (!confirm('Confirmar a importação das solicitações?')) return;

  const el = document.getElementById('resultadoImportacaoSolicitacoes');
  el.innerHTML = '<div class="estado-vazio">Importando…</div>';

  const formData = new FormData();
  formData.append('arquivo', arquivoSolicitacoesSelecionado);
  formData.append('modo', modo);

  try {
    const resp = await fetch('/api/importar-solicitacoes/confirmar', { method: 'POST', body: formData });
    const dados = await resp.json();
    if (!resp.ok) throw new Error(dados.erro);
    renderResultadoImportacao('resultadoImportacaoSolicitacoes', dados, 'confirmar-solicitacoes');
    document.getElementById('botaoConfirmarSolicitacoes').disabled = true;
  } catch (e) {
    el.innerHTML = `<div class="estado-vazio">${e.message}</div>`;
  }
});

// -------------------- Estoque --------------------
function fmtNumero(v) {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

// Número da Requisição GSNET sem casa decimal: a importação às vezes traz o
// valor como "4508.0" (célula numérica do Excel). Remove só o ".0"/".00" de
// finais inteiros; não mexe em GSNET alfanumérico nem em decimais reais.
function fmtGsnet(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/^(\d+)\.0+$/, '$1');
}

function classeAutonomia(item, limiar) {
  const estoque = item.estoque ?? 0;
  const demanda = item.demandas ?? 0;
  const autonomia = item.autonomia ?? 0;
  if (estoque <= 0 && demanda > 0) return 'cancelado';      // vermelho (ruptura)
  if (estoque > 0 && autonomia > 0 && autonomia <= limiar) return 'atrasado'; // âmbar (baixo)
  if (estoque <= 0) return 'andamento';                     // cinza (zerado sem demanda)
  return 'finalizado';                                       // verde (saudável)
}

let debounceBuscaEstoque;
document.getElementById('filtroBuscaEstoque').addEventListener('input', () => {
  clearTimeout(debounceBuscaEstoque);
  debounceBuscaEstoque = setTimeout(() => { estado.estoque.pagina = 1; carregarTabelaEstoque(); }, 350);
});
document.getElementById('filtroSituacaoEstoque').addEventListener('change', () => {
  estado.estoque.pagina = 1; carregarTabelaEstoque();
});
document.getElementById('filtroAutonomiaEstoque').addEventListener('change', () => {
  estado.estoque.pagina = 1; carregarTabelaEstoque();
});
document.getElementById('filtroDemandaEstoque').addEventListener('change', () => {
  estado.estoque.pagina = 1; carregarTabelaEstoque();
});
document.getElementById('seletorDataEstoque').addEventListener('change', async (ev) => {
  estado.estoque.data = ev.target.value;
  estado.estoque.pagina = 1;
  await carregarFiltrosEstoque();
  carregarTabelaEstoque();
});

// Filtros da tela de Monitoramento de Estoque.
document.getElementById('monCategoria').addEventListener('change', () => {
  Object.keys(DIMENSOES_MON).forEach((d) => { estadoMonFiltro[d] = null; });
  carregarMonitoramento();
});
// Sub-categoria filtra do lado do cliente (é a mesma dimensão dos cliques nos
// gráficos), sem ir ao servidor — recorta o conjunto já carregado.
document.getElementById('monSubcategoria').addEventListener('change', (ev) => {
  estadoMonFiltro.subcategoria = ev.target.value || null;
  renderMonDinamico();
});
// Status de Estoque e Situação Final — mesmas dimensões dos gráficos.
document.getElementById('monStatusEstoque').addEventListener('change', (ev) => {
  estadoMonFiltro.status_estoque = ev.target.value || null;
  renderMonDinamico();
});
document.getElementById('monStatusFinal').addEventListener('change', (ev) => {
  estadoMonFiltro.status_final = ev.target.value || null;
  renderMonDinamico();
});
// Compra em andamento (Em compra / Sem compra) — recorte do lado do cliente.
document.getElementById('monCompra').addEventListener('change', (ev) => {
  monFiltroCompra = ev.target.value || null;
  renderMonDinamico();
});
// Autonomia Alvo: muda o saldo necessário e a situação da cobertura — recalcula
// no servidor (recarrega mantendo os demais filtros de topo).
document.getElementById('monAlvo').addEventListener('change', () => {
  carregarMonitoramento();
});
document.getElementById('monComDemanda').addEventListener('change', () => {
  Object.keys(DIMENSOES_MON).forEach((d) => { estadoMonFiltro[d] = null; });
  carregarMonitoramento();
});
document.getElementById('monBusca').addEventListener('input', () => {
  // Ao buscar, os gráficos e cards recalculam junto com a tabela (dinâmicos).
  renderMonDinamico();
});
document.getElementById('monLimparFiltro').addEventListener('click', limparFiltroMon);
document.getElementById('monExportar').addEventListener('click', exportarMonitoramento);
// Seletor de unidades específicas: abre/fecha o painel e fecha ao clicar fora.
document.getElementById('monUnidadeBotao').addEventListener('click', (ev) => {
  ev.stopPropagation();
  const p = document.getElementById('monUnidadePainel');
  p.hidden = !p.hidden;
});
document.addEventListener('click', (ev) => {
  const wrap = document.getElementById('monUnidadeWrap');
  if (wrap && !wrap.contains(ev.target)) document.getElementById('monUnidadePainel').hidden = true;
});
// Clique em qualquer barra/fatia/legenda dos gráficos aplica o recorte.
document.getElementById('monConteudo').addEventListener('click', (ev) => {
  const alvo = ev.target.closest('.mon-clic');
  if (!alvo || !alvo.dataset.dim) return;
  alternarRecorteMon(alvo.dataset.dim, alvo.dataset.nome);
});

// Liga cada menu suspenso de coluna para refazer a busca ao mudar
['filtroCategoria', 'filtroControlado', 'filtroTipoItem', 'filtroMarca', 'filtroImportado', 'filtroOutrasDemandas'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => {
    estado.estoque.pagina = 1;
    carregarTabelaEstoque();
  });
});

document.getElementById('botaoLimparFiltrosEstoque').addEventListener('click', () => {
  document.getElementById('filtroBuscaEstoque').value = '';
  document.getElementById('filtroSituacaoEstoque').value = '';
  document.getElementById('filtroAutonomiaEstoque').value = '';
  document.getElementById('filtroDemandaEstoque').value = '';
  ['filtroCategoria', 'filtroControlado', 'filtroTipoItem', 'filtroMarca', 'filtroImportado', 'filtroOutrasDemandas']
    .forEach((id) => { document.getElementById(id).value = ''; });
  unidadesSelecionadas = [];
  document.querySelectorAll('#filtroUnidadePainel input[type="checkbox"]').forEach((c) => { c.checked = false; });
  atualizarRotuloUnidade();
  estado.estoque.pagina = 1;
  carregarTabelaEstoque();
});

// ----- Filtro de Unidade dispensadora com seleção múltipla -----
let unidadesSelecionadas = [];

const filtroUnidadeBotao = document.getElementById('filtroUnidadeBotao');
const filtroUnidadePainel = document.getElementById('filtroUnidadePainel');

filtroUnidadeBotao.addEventListener('click', (ev) => {
  ev.stopPropagation();
  filtroUnidadePainel.hidden = !filtroUnidadePainel.hidden;
});
// Fecha o painel ao clicar fora
document.addEventListener('click', (ev) => {
  if (!document.getElementById('filtroUnidadeWrap').contains(ev.target)) {
    filtroUnidadePainel.hidden = true;
  }
});

function atualizarRotuloUnidade() {
  const n = unidadesSelecionadas.length;
  filtroUnidadeBotao.innerHTML = (n === 0
    ? 'Unidade dispensadora: todas'
    : `Unidade dispensadora: ${n} selecionada${n > 1 ? 's' : ''}`) + ' <span aria-hidden="true">▾</span>';
}

// Monta as caixas de seleção de unidade a partir dos valores disponíveis
function montarFiltroUnidade(valores) {
  if (!valores || valores.length === 0) {
    filtroUnidadePainel.innerHTML = '<div style="padding:6px 4px; color:var(--cinza-texto); font-size:12px;">Sem unidades nesta data. Reimporte o estoque para preencher.</div>';
    unidadesSelecionadas = [];
    atualizarRotuloUnidade();
    return;
  }
  filtroUnidadePainel.innerHTML = valores.map((v) => {
    const escapado = v.replace(/"/g, '&quot;');
    const marcado = unidadesSelecionadas.includes(v) ? 'checked' : '';
    return `<label class="multi-filtro-item"><input type="checkbox" value="${escapado}" ${marcado}> ${v}</label>`;
  }).join('');

  filtroUnidadePainel.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      unidadesSelecionadas = Array.from(filtroUnidadePainel.querySelectorAll('input:checked')).map((c) => c.value);
      atualizarRotuloUnidade();
      estado.estoque.pagina = 1;
      carregarTabelaEstoque();
    });
  });
  // remove seleções que não existem mais nesta data
  unidadesSelecionadas = unidadesSelecionadas.filter((u) => valores.includes(u));
  atualizarRotuloUnidade();
}

// Popula os menus suspensos com os valores distintos da data selecionada
async function carregarFiltrosEstoque() {
  const params = new URLSearchParams();
  params.set('escopoUnidade', 'udtp');
  if (estado.estoque.data) params.set('data', estado.estoque.data);
  let dados;
  try {
    dados = await api(`/estoque/filtros?${params.toString()}`);
  } catch (e) {
    return; // se falhar, mantém os menus só com "todos"
  }
  FILTROS_COLUNA_ESTOQUE.forEach(({ id, coluna }) => {
    const sel = document.getElementById(id);
    const valorAtual = sel.value;
    const rotuloPadrao = sel.options[0].textContent; // ex: "Categoria: todas"
    const opcoes = (dados[coluna] || []).map((v) =>
      `<option value="${v.replace(/"/g, '&quot;')}">${v}</option>`
    ).join('');
    sel.innerHTML = `<option value="">${rotuloPadrao}</option>` + opcoes;
    sel.value = valorAtual; // preserva seleção se ainda existir
  });

  // Unidade dispensadora (seleção múltipla)
  montarFiltroUnidade(dados.unidade || []);
}
document.getElementById('botaoAnteriorEstoque').addEventListener('click', () => {
  if (estado.estoque.pagina > 1) { estado.estoque.pagina--; carregarTabelaEstoque(); }
});
document.getElementById('botaoProximoEstoque').addEventListener('click', () => {
  estado.estoque.pagina++; carregarTabelaEstoque();
});
document.getElementById('botaoFecharModalEstoque').addEventListener('click', () => {
  document.getElementById('modalEstoqueItem').hidden = true;
});

// -------------------- Monitoramento de Estoque --------------------
// Reproduz a planilha gerencial "Monitoramento Estoque.xlsm": classifica cada
// item por faixa de autonomia (fixas: <1 Baixo, 1–2 Crítico, 2–5 Regular,
// ≥5 Abastecido) e monta os painéis + a tabela classificada.
const estadoMon = { dados: null };

// Cores por status/situação (alinhadas ao semáforo já usado no sistema).
const CORES_STATUS = {
  'Estoque Zero': '#b3261e', 'Estoque Baixo': '#eb6834', 'Estoque Crítico': '#e0a100',
  'Regular': '#2a78d6', 'Abastecido': '#1baf7a', 'Sem Demanda': '#8a94a6',
  'Desabastecido': '#b3261e', 'Crítico': '#eb6834',
};
const PALETA_CAT = ['#2a78d6', '#1baf7a', '#6c4bd1', '#eb6834', '#e0a100', '#0f9d9d', '#b3261e', '#8a94a6'];

// Seletor ÚNICO de unidades do Monitoramento.
//   monUnidadeTodas = true  → todas as unidades (escopo geral)
//   monUnidadesSelecionadas = [...] → unidades específicas (padrão: Tenente Pena)
const UNIDADE_TP = 'UD 01 - Tenente Pena';
let monUnidadesSelecionadas = [UNIDADE_TP];
let monUnidadeTodas = false;
let monUnidadesCarregadas = false;

// Busca a lista de unidades (uma vez) e monta as caixas de seleção, com a opção
// "Todas as unidades" no topo e a Tenente Pena marcada por padrão.
async function garantirUnidadesMon() {
  if (monUnidadesCarregadas) return;
  const painel = document.getElementById('monUnidadePainel');
  try {
    const dados = await api('/estoque/filtros?escopoUnidade=geral');
    let unidades = (dados.unidade || []).filter(Boolean);
    // Garante a Tenente Pena na lista e no topo.
    if (!unidades.includes(UNIDADE_TP)) unidades.unshift(UNIDADE_TP);
    else unidades = [UNIDADE_TP, ...unidades.filter((u) => u !== UNIDADE_TP)];

    const itemTodas = `<label class="multi-filtro-item" style="font-weight:600; border-bottom:1px solid var(--linha);"><input type="checkbox" id="monUnidadeTodasCb"> Todas as unidades</label>`;
    const itensUnid = unidades.map((v) => {
      const esc = v.replace(/"/g, '&quot;');
      const marcado = monUnidadesSelecionadas.includes(v) ? 'checked' : '';
      return `<label class="multi-filtro-item"><input type="checkbox" class="mon-uni-cb" value="${esc}" ${marcado}> ${escHtml(v)}</label>`;
    }).join('');
    painel.innerHTML = itemTodas + itensUnid;

    const cbTodas = painel.querySelector('#monUnidadeTodasCb');
    const cbsUnid = Array.from(painel.querySelectorAll('.mon-uni-cb'));
    // "Todas" desmarca as individuais; marcar uma individual desliga "Todas".
    cbTodas.addEventListener('change', () => {
      monUnidadeTodas = cbTodas.checked;
      if (monUnidadeTodas) { cbsUnid.forEach((c) => { c.checked = false; c.disabled = true; }); monUnidadesSelecionadas = []; }
      else { cbsUnid.forEach((c) => { c.disabled = false; }); monUnidadesSelecionadas = [UNIDADE_TP]; cbsUnid.forEach((c) => { c.checked = c.value === UNIDADE_TP; }); }
      Object.keys(DIMENSOES_MON).forEach((d) => { estadoMonFiltro[d] = null; });
      atualizarRotuloUnidadeMon();
      carregarMonitoramento();
    });
    cbsUnid.forEach((cb) => cb.addEventListener('change', () => {
      monUnidadeTodas = false; cbTodas.checked = false; cbsUnid.forEach((c) => { c.disabled = false; });
      monUnidadesSelecionadas = cbsUnid.filter((c) => c.checked).map((c) => c.value);
      // Nunca deixa vazio: se desmarcou tudo, volta para Tenente Pena.
      if (!monUnidadesSelecionadas.length) { monUnidadesSelecionadas = [UNIDADE_TP]; cbsUnid.forEach((c) => { c.checked = c.value === UNIDADE_TP; }); }
      Object.keys(DIMENSOES_MON).forEach((d) => { estadoMonFiltro[d] = null; });
      atualizarRotuloUnidadeMon();
      carregarMonitoramento();
    }));
    monUnidadesCarregadas = true;
    atualizarRotuloUnidadeMon();
  } catch (e) { /* silencioso: mantém o padrão Tenente Pena */ }
}

function atualizarRotuloUnidadeMon() {
  let txt;
  if (monUnidadeTodas) txt = 'Todas as unidades';
  else if (monUnidadesSelecionadas.length === 1) txt = monUnidadesSelecionadas[0] === UNIDADE_TP ? 'Tenente Pena' : monUnidadesSelecionadas[0].replace(/^UD \d+ - /, '');
  else txt = `${monUnidadesSelecionadas.length} unidades`;
  document.getElementById('monUnidadeBotao').innerHTML = `Unidades: ${escHtml(txt)} <span aria-hidden="true">▾</span>`;
}

async function carregarMonitoramento() {
  await garantirUnidadesMon();
  const categoria = document.getElementById('monCategoria').value || '';
  const comDemanda = document.getElementById('monComDemanda').checked;
  const qs = new URLSearchParams();
  // "Todas" → escopo geral; senão, a lista de unidades escolhidas.
  if (monUnidadeTodas) qs.set('escopoUnidade', 'geral');
  else qs.set('unidade', monUnidadesSelecionadas.join(','));
  if (categoria) qs.set('categoria', categoria);
  if (!comDemanda) qs.set('comDemanda', '0');
  // Autonomia Alvo escolhida na tela (override do valor padrão de configuracoes).
  const alvoSel = document.getElementById('monAlvo').value;
  if (alvoSel) qs.set('autonomiaAlvo', alvoSel);
  const dados = await api('/estoque/monitoramento?' + qs.toString());
  estadoMon.dados = dados;

  const vazio = document.getElementById('monAvisoVazio');
  const conteudo = document.getElementById('monConteudo');
  if (!dados.dataReferencia) {
    vazio.hidden = false; conteudo.hidden = true; return;
  }
  vazio.hidden = true; conteudo.hidden = false;

  // Reflete no seletor o alvo efetivamente usado (padrão de configuracoes na 1ª carga).
  if (dados.autonomiaAlvo != null) document.getElementById('monAlvo').value = String(dados.autonomiaAlvo);

  document.getElementById('subtituloMonitoramento').textContent =
    `Situação em ${formatarData(dados.dataReferencia)}${horaImportacao(dados.dataImportacao)} — ${fmtNumero(dados.totalItens)} itens · autonomia alvo: ${dados.autonomiaAlvo} mês(es) · faixas fixas da planilha CPDAE.`;

  // Preenche o filtro de categoria (uma vez, a partir dos painéis).
  const selCat = document.getElementById('monCategoria');
  if (selCat.options.length <= 1) {
    dados.paineis.itensPorCategoria.forEach((c) => {
      const o = document.createElement('option'); o.value = c.nome; o.textContent = c.nome; selCat.appendChild(o);
    });
  }

  // Filtro de sub-categoria: repovoa a cada carga (depende da categoria/escopo).
  const selSub = document.getElementById('monSubcategoria');
  const subAtual = selSub.value;
  selSub.innerHTML = '<option value="">Todas as sub-categorias</option>';
  (dados.paineis.porSubcategoria || []).forEach((s) => {
    const o = document.createElement('option'); o.value = s.nome; o.textContent = `${s.nome} (${fmtNumero(s.valor)})`; selSub.appendChild(o);
  });
  // Mantém a seleção se a sub-categoria ainda existe no novo conjunto.
  if (subAtual && [...selSub.options].some((o) => o.value === subAtual)) selSub.value = subAtual;
  else selSub.value = '';

  const aviso = document.getElementById('monTruncadoAviso');
  if (dados.truncado) { aviso.hidden = false; aviso.textContent = `Base grande: painéis e tabela consideram os primeiros ${fmtNumero(dados.itens.length)} de ${fmtNumero(dados.totalItens)} itens. Use o filtro de categoria para refinar.`; }
  else aviso.hidden = true;

  // Ao recarregar do servidor, zera o recorte por status.
  Object.keys(DIMENSOES_MON).forEach((d) => { estadoMonFiltro[d] = null; });
  renderMonDinamico();
}

// Ordem fixa dos status (do pior ao melhor) para os painéis/cards.
const ORDEM_STATUS_MON = ['Estoque Zero', 'Estoque Baixo', 'Estoque Crítico', 'Regular', 'Abastecido', 'Sem Demanda'];
const ORDEM_FINAL_MON = ['Desabastecido', 'Crítico', 'Abastecido', 'Sem Demanda'];

// Recalcula os painéis (contagens/somas) a partir de uma lista de itens —
// é isso que deixa os gráficos DINÂMICOS: mudam junto com a busca.
function calcularPaineisMon(itens) {
  const contar = (campo) => {
    const m = new Map();
    for (const it of itens) { const k = it[campo] || '—'; m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].map(([nome, valor]) => ({ nome, valor })).sort((a, b) => b.valor - a.valor);
  };
  const somar = (campoChave, campoValor) => {
    const m = new Map();
    for (const it of itens) { const k = it[campoChave] || '—'; m.set(k, (m.get(k) || 0) + (Number(it[campoValor]) || 0)); }
    return [...m.entries()].map(([nome, valor]) => ({ nome, valor })).sort((a, b) => b.valor - a.valor);
  };
  const porStatus = ORDEM_STATUS_MON.map((nome) => ({ nome, valor: itens.filter((i) => i.status_estoque === nome).length })).filter((x) => x.valor > 0);
  const porFinal = ORDEM_FINAL_MON.map((nome) => ({ nome, valor: itens.filter((i) => i.status_final === nome).length })).filter((x) => x.valor > 0);
  return {
    porStatusEstoque: porStatus, porStatusFinal: porFinal,
    itensPorCategoria: contar('categoria'), demandasPorCategoria: somar('categoria', 'demandas'),
    porSubcategoria: contar('subcategoria'),
  };
}

// Recortes ativos por clique (cross-filter): busca + dimensões dos gráficos.
// Cada dimensão aponta para o campo do item que ela filtra.
const DIMENSOES_MON = {
  status_estoque: 'Status de Estoque', status_final: 'Situação Final',
  categoria: 'Categoria', subcategoria: 'Sub-categoria',
};

// Recorte "Compra em andamento" (Em compra / Sem compra) — filtro simples do
// dropdown, aplicado junto com a busca em baseFiltradaMon.
let monFiltroCompra = null;

// Aplica a busca + os recortes de clique (opcionalmente ignorando UMA dimensão,
// para que um gráfico não filtre a si mesmo). É o que faz tudo filtrar junto.
function baseFiltradaMon(exceto) {
  const dados = estadoMon.dados;
  if (!dados) return [];
  const busca = normalizarBusca(document.getElementById('monBusca').value);
  let itens = dados.itens;
  if (busca) itens = itens.filter((i) =>
    normalizarBusca(i.descricao).includes(busca) ||
    normalizarBusca(i.codigo_item).includes(busca) ||
    normalizarBusca(i.siafisico).includes(busca));
  if (monFiltroCompra) itens = itens.filter((i) => i.em_compra === monFiltroCompra);
  for (const dim of Object.keys(DIMENSOES_MON)) {
    if (dim === exceto) continue;
    if (estadoMonFiltro[dim]) itens = itens.filter((i) => (i[dim] || '—') === estadoMonFiltro[dim]);
  }
  return itens;
}

// Liga/desliga um recorte de dimensão (clique em barra/fatia/card) e redesenha.
function alternarRecorteMon(dim, nome) {
  estadoMonFiltro[dim] = estadoMonFiltro[dim] === nome ? null : nome;
  renderMonDinamico();
}

// Exporta para Excel os itens exatamente como estão filtrados na tela.
async function exportarMonitoramento() {
  const qs = new URLSearchParams();
  if (monUnidadeTodas) qs.set('escopoUnidade', 'geral');
  else qs.set('unidade', monUnidadesSelecionadas.join(','));
  if (!document.getElementById('monComDemanda').checked) qs.set('comDemanda', '0');
  // Categoria: recorte do gráfico tem prioridade sobre o seletor.
  const cat = estadoMonFiltro.categoria || document.getElementById('monCategoria').value;
  if (cat) qs.set('categoria', cat);
  const busca = (document.getElementById('monBusca').value || '').trim();
  if (busca) qs.set('q', busca);
  if (estadoMonFiltro.status_estoque) qs.set('status', estadoMonFiltro.status_estoque);
  if (estadoMonFiltro.status_final) qs.set('statusFinal', estadoMonFiltro.status_final);
  if (estadoMonFiltro.subcategoria) qs.set('subcategoria', estadoMonFiltro.subcategoria);
  const alvoSel = document.getElementById('monAlvo').value;
  if (alvoSel) qs.set('autonomiaAlvo', alvoSel);

  const btn = document.getElementById('monExportar');
  const textoOrig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Gerando…';
  try {
    const resp = await fetch('/api/estoque/monitoramento/exportar?' + qs.toString());
    if (!resp.ok) throw new Error('Falha ao gerar o Excel.');
    const blob = await resp.blob();
    const nome = (resp.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'Monitoramento_Estoque.xlsx';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nome; document.body.appendChild(a); a.click();
    a.remove(); URL.revokeObjectURL(url);
  } catch (e) {
    alert('Não foi possível exportar: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = textoOrig;
  }
}

// Zera busca + todos os recortes (e o seletor de categoria, se estiver ativo).
function limparFiltroMon() {
  document.getElementById('monBusca').value = '';
  for (const dim of Object.keys(DIMENSOES_MON)) estadoMonFiltro[dim] = null;
  monFiltroCompra = null; document.getElementById('monCompra').value = '';
  const selCat = document.getElementById('monCategoria');
  if (selCat.value) { selCat.value = ''; carregarMonitoramento(); return; } // recarrega do servidor
  renderMonDinamico();
}

// Mostra/oculta o botão "Limpar filtro" e o chip com o filtro ativo.
function atualizarIndicadorFiltroMon() {
  const ativos = [];
  const busca = (document.getElementById('monBusca').value || '').trim();
  if (busca) ativos.push(`busca "${busca}"`);
  for (const [dim, rot] of Object.entries(DIMENSOES_MON)) {
    if (estadoMonFiltro[dim]) ativos.push(`${rot}: ${estadoMonFiltro[dim]}`);
  }
  if (monFiltroCompra) ativos.push(`Compra: ${monFiltroCompra}`);
  const btn = document.getElementById('monLimparFiltro');
  const chip = document.getElementById('monFiltroAtivo');
  btn.hidden = ativos.length === 0;
  if (ativos.length) { chip.hidden = false; chip.textContent = 'filtrando por ' + ativos.join(' · '); }
  else chip.hidden = true;
}

// Recortes ativos por dimensão. Cada gráfico usa a base "exceto ele mesmo",
// então clicar num status mantém todos os status visíveis (só destaca o
// escolhido) e filtra o resto (tabela + demais gráficos).
const estadoMonFiltro = { status_estoque: null, status_final: null, categoria: null, subcategoria: null };

// Redesenha cards + os 5 gráficos + a tabela a partir do estado atual dos filtros.
function renderMonDinamico() {
  const pStatus = calcularPaineisMon(baseFiltradaMon('status_estoque'));
  const pFinal = calcularPaineisMon(baseFiltradaMon('status_final'));
  const pCat = calcularPaineisMon(baseFiltradaMon('categoria'));
  const pSub = calcularPaineisMon(baseFiltradaMon('subcategoria'));

  renderCardsMon(pStatus.porStatusEstoque);
  document.getElementById('monChartStatus').innerHTML = barrasHorizontais(pStatus.porStatusEstoque, (n) => CORES_STATUS[n] || '#8a94a6', 'status_estoque');
  document.getElementById('monChartFinal').innerHTML = barrasHorizontais(pFinal.porStatusFinal, (n) => CORES_STATUS[n] || '#8a94a6', 'status_final');
  document.getElementById('monChartCategoria').innerHTML = roscaSVG(pCat.itensPorCategoria, 'categoria');
  document.getElementById('monChartDemandas').innerHTML = roscaSVG(pCat.demandasPorCategoria, 'categoria');
  document.getElementById('monChartSubcategoria').innerHTML = barrasHorizontais(pSub.porSubcategoria, (_, i) => PALETA_CAT[i % PALETA_CAT.length], 'subcategoria');

  renderTabelaMon(baseFiltradaMon());
  atualizarIndicadorFiltroMon();

  // Mantém o dropdown de sub-categoria refletindo a dimensão (cliques nos gráficos
  // e "Limpar filtro" também mexem nela).
  const selSub = document.getElementById('monSubcategoria');
  if (selSub) {
    const alvo = estadoMonFiltro.subcategoria || '';
    if (selSub.value !== alvo && [...selSub.options].some((o) => o.value === alvo)) selSub.value = alvo;
    else if (!alvo) selSub.value = '';
  }
  // Status de Estoque e Situação Final acompanham a dimensão (opções fixas).
  const selSE = document.getElementById('monStatusEstoque');
  if (selSE) selSE.value = estadoMonFiltro.status_estoque || '';
  const selSF = document.getElementById('monStatusFinal');
  if (selSF) selSF.value = estadoMonFiltro.status_final || '';
}

// Cards de resumo por status (clicáveis — mesmo recorte da barra de status).
function renderCardsMon(porStatus) {
  const total = porStatus.reduce((s, x) => s + x.valor, 0) || 1;
  const alvo = document.getElementById('monCards');
  alvo.innerHTML = porStatus.map((s) => {
    const pct = Math.round((s.valor / total) * 100);
    const cor = CORES_STATUS[s.nome] || '#8a94a6';
    const ativo = estadoMonFiltro.status_estoque === s.nome ? ' mon-card-ativo' : '';
    return `<button type="button" class="cartao card-prog mon-card${ativo}" data-nome="${escHtml(s.nome)}" style="border-top-color:${cor}; text-align:left; cursor:pointer;">
      <div class="prog-rotulo">${escHtml(s.nome)}</div>
      <div class="prog-metrica">${fmtNumero(s.valor)}</div>
      <div class="prog-sub">${pct}% do filtro</div>
    </button>`;
  }).join('');
  alvo.querySelectorAll('.mon-card').forEach((b) =>
    b.addEventListener('click', () => alternarRecorteMon('status_estoque', b.dataset.nome)));
}

// Gráfico de barras horizontais em SVG puro (rótulo + barra + valor).
// dim = dimensão do cross-filter; cada barra vira clicável.
function barrasHorizontais(dados, corFn, dim) {
  if (!dados || !dados.length) return '<p class="dica">Sem dados.</p>';
  const max = Math.max(...dados.map((d) => d.valor), 1);
  const linha = 30, margemTopo = 6, largRotulo = 118, largBarra = 240, largValor = 60;
  const largura = largRotulo + largBarra + largValor;
  const altura = margemTopo * 2 + dados.length * linha;
  const sel = dim ? estadoMonFiltro[dim] : null;
  const linhas = dados.map((d, i) => {
    const y = margemTopo + i * linha;
    const w = Math.max(2, (d.valor / max) * largBarra);
    const cor = corFn(d.nome, i);
    const rot = String(d.nome).length > 16 ? String(d.nome).slice(0, 15) + '…' : d.nome;
    const opac = sel && sel !== d.nome ? ' opacity="0.35"' : '';
    return `<g class="mon-clic" data-dim="${dim || ''}" data-nome="${escHtml(d.nome)}" style="cursor:pointer"${opac}>
      <rect x="0" y="${y}" width="${largura}" height="${linha}" fill="transparent"></rect>
      <text x="${largRotulo - 8}" y="${y + 18}" text-anchor="end" class="mon-bar-rot">${escHtml(rot)}</text>
      <rect x="${largRotulo}" y="${y + 5}" width="${w}" height="18" rx="4" fill="${cor}"></rect>
      <text x="${largRotulo + w + 6}" y="${y + 18}" class="mon-bar-val">${fmtNumero(d.valor)}</text>
    </g>`;
  }).join('');
  return `<svg viewBox="0 0 ${largura} ${altura}" width="100%" style="max-width:${largura}px" role="img">${linhas}</svg>`;
}

// Gráfico de rosca (doughnut) em SVG puro + legenda com valor e %. Fatias e
// itens da legenda são clicáveis (cross-filter pela dimensão dim).
function roscaSVG(dados, dim) {
  if (!dados || !dados.length) return '<p class="dica">Sem dados.</p>';
  const total = dados.reduce((s, d) => s + d.valor, 0) || 1;
  const R = 60, r = 36, cx = 70, cy = 70;
  const sel = dim ? estadoMonFiltro[dim] : null;
  let ang = -Math.PI / 2;
  const setores = dados.map((d, i) => {
    const frac = d.valor / total;
    const a2 = ang + frac * 2 * Math.PI;
    const grande = frac > 0.5 ? 1 : 0;
    const x1 = cx + R * Math.cos(ang), y1 = cy + R * Math.sin(ang);
    const x2 = cx + R * Math.cos(a2), y2 = cy + R * Math.sin(a2);
    const xi2 = cx + r * Math.cos(a2), yi2 = cy + r * Math.sin(a2);
    const xi1 = cx + r * Math.cos(ang), yi1 = cy + r * Math.sin(ang);
    ang = a2;
    const cor = PALETA_CAT[i % PALETA_CAT.length];
    const opac = sel && sel !== d.nome ? ' opacity="0.35"' : '';
    const attrs = `class="mon-clic" data-dim="${dim || ''}" data-nome="${escHtml(d.nome)}" style="cursor:pointer"${opac}`;
    if (frac >= 0.999) return `<circle ${attrs} cx="${cx}" cy="${cy}" r="${(R + r) / 2}" fill="none" stroke="${cor}" stroke-width="${R - r}"></circle>`;
    return `<path ${attrs} d="M ${x1} ${y1} A ${R} ${R} 0 ${grande} 1 ${x2} ${y2} L ${xi2} ${yi2} A ${r} ${r} 0 ${grande} 0 ${xi1} ${yi1} Z" fill="${cor}"></path>`;
  }).join('');
  const legenda = dados.map((d, i) => {
    const pct = Math.round((d.valor / total) * 100);
    const opac = sel && sel !== d.nome ? 'opacity:0.45;' : '';
    return `<div class="mon-leg-item mon-clic" data-dim="${dim || ''}" data-nome="${escHtml(d.nome)}" style="cursor:pointer;${opac}"><span class="mon-leg-cor" style="background:${PALETA_CAT[i % PALETA_CAT.length]}"></span>${escHtml(d.nome)} — <strong>${fmtNumero(d.valor)}</strong> (${pct}%)</div>`;
  }).join('');
  return `<div class="mon-rosca"><svg viewBox="0 0 140 140" width="140" height="140" role="img">${setores}</svg><div class="mon-legenda">${legenda}</div></div>`;
}

function renderTabelaMon(base) {
  if (!estadoMon.dados) return;
  const itens = base || baseFiltradaMon();

  const corpo = document.getElementById('monTabelaCorpo');
  const LIM = 500;
  const mostra = itens.slice(0, LIM);
  corpo.innerHTML = mostra.map((i) => {
    const corE = CORES_STATUS[i.status_estoque] || '#8a94a6';
    const corF = CORES_STATUS[i.status_final] || '#8a94a6';
    // Cores dos selos das novas situações.
    const corCob = i.situacao_cobertura === 'Autonomia Alvo Atendida' ? '#1f7a3a'
      : i.situacao_cobertura === 'Necessita Aquisição' ? '#b45309' : '#8a94a6';
    const corAq = i.situacao_aquisicao === 'Aquisição em andamento' ? '#1c6cad' : '#8a94a6';
    const selo = (txt, cor) => `<span class="tag-status" style="background:${cor}22; color:${cor}; border:1px solid ${cor}55;">${escHtml(txt)}</span>`;
    return `<tr>
      <td>${escHtml(i.codigo_item || '—')}${i.siafisico ? '<br><span class="col-codigo">Siafísico: ' + escHtml(i.siafisico) + '</span>' : ''}</td>
      <td>${escHtml(i.descricao || '—')}</td>
      <td>${escHtml(i.categoria || '—')}</td>
      <td class="num">${fmtNumero(i.demandas)}</td>
      <td class="num">${fmtNumero(i.consumo_mensal_total)}</td>
      <td class="num">${fmtNumero(i.estoque)}</td>
      <td class="num">${i.autonomia == null ? '—' : Number(i.autonomia).toFixed(1)}</td>
      <td class="num">${(Number(i.qtde_aquisicao) || 0) > 0 ? fmtNumero(i.qtde_aquisicao) : '—'}</td>
      <td class="num">${fmtMeses(i.cobertura_aquisicao, '-')}</td>
      <td class="num">${fmtMeses(i.autonomia_total, '—')}</td>
      <td>${i.em_compra === 'Em compra'
        ? '<span class="tag-status" style="background:#1f7a3a22; color:#1f7a3a; border:1px solid #1f7a3a55;">Em compra</span>'
          + (i.compra_status_txt ? '<br><span class="col-codigo">' + escHtml(i.compra_status_txt) + '</span>' : '')
        : '<span class="tag-status" style="background:#8a94a622; color:#8a94a6; border:1px solid #8a94a655;">Sem compra</span>'}</td>
      <td>${selo(i.situacao_aquisicao, corAq)}</td>
      <td class="num">${i.saldo_necessario == null ? '-' : fmtNumero(Math.round(i.saldo_necessario))}</td>
      <td>${selo(i.situacao_cobertura, corCob)}</td>
      <td><span class="tag-status" style="background:${corE}22; color:${corE}; border:1px solid ${corE}55;">${escHtml(i.status_estoque)}</span></td>
      <td><span class="tag-status" style="background:${corF}22; color:${corF}; border:1px solid ${corF}55;">${escHtml(i.status_final)}</span></td>
      <td>${i.previsao_falta ? formatarData(i.previsao_falta) : '—'}</td>
      <td>${i.previsao_falta_projetada ? formatarData(i.previsao_falta_projetada) : '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="18" class="dica" style="text-align:center;">Nenhum item para o filtro atual.</td></tr>';

  const h3 = document.querySelector('#monConteudo .cartao h3');
  if (h3) h3.textContent = `Itens classificados (${fmtNumero(itens.length)}${itens.length > LIM ? ', mostrando ' + LIM : ''})`;
}

async function carregarEstoque() {
  const resumo = await api('/estoque/resumo?escopoUnidade=udtp');

  if (!resumo.dataReferencia) {
    document.getElementById('avisoSemEstoque').hidden = false;
    document.getElementById('conteudoEstoque').hidden = true;
    return;
  }

  document.getElementById('avisoSemEstoque').hidden = true;
  document.getElementById('conteudoEstoque').hidden = false;

  // Preenche seletor de datas (apenas na primeira vez ou se mudou)
  const seletor = document.getElementById('seletorDataEstoque');
  const lista = await api('/estoque?pageSize=1&escopoUnidade=udtp');
  seletor.innerHTML = lista.datasDisponiveis.map((d) =>
    `<option value="${d.data_referencia}">${formatarData(d.data_referencia)} (${d.total_itens} itens)</option>`
  ).join('');
  if (!estado.estoque.data) estado.estoque.data = resumo.dataReferencia;
  seletor.value = estado.estoque.data;

  document.getElementById('subtituloEstoque').textContent =
    `Situação do estoque em ${formatarData(resumo.dataReferencia)}${resumo.dataImportacao ? ' · importado às ' + resumo.dataImportacao.slice(11, 16) : ''} · autonomia mínima: ${resumo.limiarAutonomia} mês(es)`;

  const grade = document.getElementById('grideResumoEstoque');
  const valorFmt = resumo.valorTotalEstoque
    ? 'R$ ' + Number(resumo.valorTotalEstoque).toLocaleString('pt-BR', { maximumFractionDigits: 0 })
    : '—';
  grade.innerHTML = `
    <div class="cartao-resumo"><div class="numero">${fmtNumero(resumo.totalItens)}</div><div class="rotulo">Itens no estoque</div></div>
    <div class="cartao-resumo alerta"><div class="numero">${fmtNumero(resumo.ruptura)}</div><div class="rotulo">Em ruptura (zero + demanda)</div></div>
    <div class="cartao-resumo"><div class="numero">${fmtNumero(resumo.baixo)}</div><div class="rotulo">Estoque baixo (autonomia)</div></div>
    <div class="cartao-resumo"><div class="numero">${fmtNumero(resumo.zerado)}</div><div class="rotulo">Estoque zerado</div></div>
    <div class="cartao-resumo"><div class="numero" style="font-size:20px;">${valorFmt}</div><div class="rotulo">Valor total em estoque</div></div>
  `;

  await carregarFiltrosEstoque();
  carregarTabelaEstoque();
}

const FILTROS_COLUNA_ESTOQUE = [
  { id: 'filtroCategoria', coluna: 'categoria' },
  { id: 'filtroControlado', coluna: 'controlado' },
  { id: 'filtroTipoItem', coluna: 'tipo_item' },
  { id: 'filtroMarca', coluna: 'marca' },
  { id: 'filtroImportado', coluna: 'importado' },
  { id: 'filtroOutrasDemandas', coluna: 'outras_demandas' },
];

// Exporta o Relatório de Itens em Estoque (CSV), respeitando os filtros atuais.
function exportarEstoqueTP() {
  const params = new URLSearchParams();
  params.set('escopoUnidade', 'udtp');
  if (estado.estoque.data) params.set('data', estado.estoque.data);
  const q = document.getElementById('filtroBuscaEstoque').value.trim(); if (q) params.set('q', q);
  const situacao = document.getElementById('filtroSituacaoEstoque').value; if (situacao) params.set('situacao', situacao);
  const autonomia = document.getElementById('filtroAutonomiaEstoque').value; if (autonomia) params.set('autonomia', autonomia);
  const demanda = document.getElementById('filtroDemandaEstoque').value; if (demanda) params.set('demanda', demanda);
  FILTROS_COLUNA_ESTOQUE.forEach(({ id, coluna }) => { const v = document.getElementById(id).value; if (v) params.set(coluna, v); });
  if (unidadesSelecionadas.length) params.set('unidade', unidadesSelecionadas.join(','));
  window.location.href = '/api/estoque/exportar?' + params.toString();
}
document.getElementById('botaoExportarEstoque').addEventListener('click', exportarEstoqueTP);

async function carregarTabelaEstoque() {
  const q = document.getElementById('filtroBuscaEstoque').value.trim();
  const situacao = document.getElementById('filtroSituacaoEstoque').value;
  const autonomia = document.getElementById('filtroAutonomiaEstoque').value;
  const demanda = document.getElementById('filtroDemandaEstoque').value;

  const params = new URLSearchParams({ page: estado.estoque.pagina, pageSize: estado.estoque.pageSize });
  params.set('escopoUnidade', 'udtp');
  if (estado.estoque.data) params.set('data', estado.estoque.data);
  if (q) params.set('q', q);
  if (situacao) params.set('situacao', situacao);
  if (autonomia) params.set('autonomia', autonomia);
  if (demanda) params.set('demanda', demanda);

  // Filtros por coluna (menus suspensos)
  FILTROS_COLUNA_ESTOQUE.forEach(({ id, coluna }) => {
    const v = document.getElementById(id).value;
    if (v) params.set(coluna, v);
  });

  // Unidade dispensadora (seleção múltipla) → uma ou mais unidades
  if (unidadesSelecionadas.length) params.set('unidade', unidadesSelecionadas.join(','));

  const dados = await api(`/estoque?${params.toString()}`);
  const limiar = dados.limiarAutonomia;
  const corpo = document.getElementById('corpoTabelaEstoque');
  const vazio = document.getElementById('estadoVazioEstoque');

  if (dados.itens.length === 0) {
    corpo.innerHTML = '';
    vazio.hidden = false;
  } else {
    vazio.hidden = true;
    corpo.innerHTML = dados.itens.map((it) => {
      const classe = classeAutonomia(it, limiar);
      const autonomiaTxt = it.autonomia === null ? '—' : `${fmtNumero(it.autonomia)} mês(es)`;
      const compraTag = it.compras_abertas > 0
        ? '<span class="etiqueta-status planejamento">Compra em aberto</span>'
        : '<span style="color:var(--cinza-texto); font-size:12px;">—</span>';
      const prox = proximaValidade(it.lotes);
      let validadeTd = '<span style="color:var(--cinza-texto); font-size:12px;">—</span>';
      if (prox) {
        const clsV = classeValidade(prox.validade);
        const tagV = clsV === 'vencido' ? 'cancelado' : clsV === 'proximo' ? 'atrasado' : 'finalizado';
        validadeTd = `<span class="etiqueta-status ${tagV}">${prox.validade}</span>`;
      }
      return `
        <tr>
          <td>${descricaoComMarcaHTML(it)}<br><span class="col-codigo">${it.codigo_item}</span>${it.siafisico ? ` · <span class="col-codigo">Siafísico: ${escHtml(String(it.siafisico))}</span>` : ''}${etiquetasProgramaHTML(it)}</td>
          <td>${fmtNumero(it.demandas)}</td>
          <td>${fmtNumero(it.consumo_mensal_total)}</td>
          <td>${fmtNumero(it.estoque)}</td>
          <td><span class="etiqueta-status ${classe}">${autonomiaTxt}</span></td>
          <td class="col-data">${validadeTd}</td>
          <td>${compraTag}</td>
          <td><button class="botao-editar" data-codigo="${encodeURIComponent(it.codigo_item)}">Ver</button></td>
        </tr>
      `;
    }).join('');

    corpo.querySelectorAll('button[data-codigo]').forEach((btn) => {
      btn.addEventListener('click', () => abrirDetalheEstoque(btn.dataset.codigo));
    });
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoEstoque').textContent =
    `Página ${dados.page} de ${totalPaginas} · ${dados.total} itens`;
  document.getElementById('botaoAnteriorEstoque').disabled = dados.page <= 1;
  document.getElementById('botaoProximoEstoque').disabled = dados.page >= totalPaginas;
}

// ==================== Itens em Estoque Geral (Demais Unidades) ====================
const estadoEstoqueGeral = { pagina: 1, pageSize: 30, data: null };
let unidadesSelecionadasGeral = [];
const COLS_FILTRO_GERAL = [
  { id: 'filtroCategoriaGeral', coluna: 'categoria' },
  { id: 'filtroControladoGeral', coluna: 'controlado' },
  { id: 'filtroTipoItemGeral', coluna: 'tipo_item' },
  { id: 'filtroMarcaGeral', coluna: 'marca' },
  { id: 'filtroImportadoGeral', coluna: 'importado' },
  { id: 'filtroOutrasDemandasGeral', coluna: 'outras_demandas' },
];

let debounceBuscaGeral;
document.getElementById('filtroBuscaEstoqueGeral').addEventListener('input', () => {
  clearTimeout(debounceBuscaGeral);
  debounceBuscaGeral = setTimeout(() => { estadoEstoqueGeral.pagina = 1; carregarTabelaEstoqueGeral(); }, 350);
});
document.getElementById('filtroSituacaoEstoqueGeral').addEventListener('change', () => { estadoEstoqueGeral.pagina = 1; carregarTabelaEstoqueGeral(); });
document.getElementById('filtroAutonomiaEstoqueGeral').addEventListener('change', () => { estadoEstoqueGeral.pagina = 1; carregarTabelaEstoqueGeral(); });
document.getElementById('filtroDemandaEstoqueGeral').addEventListener('change', () => { estadoEstoqueGeral.pagina = 1; carregarTabelaEstoqueGeral(); });
document.getElementById('seletorDataEstoqueGeral').addEventListener('change', async (ev) => {
  estadoEstoqueGeral.data = ev.target.value; estadoEstoqueGeral.pagina = 1;
  await carregarFiltrosEstoqueGeral(); carregarTabelaEstoqueGeral();
});
COLS_FILTRO_GERAL.forEach(({ id }) => {
  document.getElementById(id).addEventListener('change', () => { estadoEstoqueGeral.pagina = 1; carregarTabelaEstoqueGeral(); });
});
document.getElementById('botaoLimparFiltrosEstoqueGeral').addEventListener('click', () => {
  document.getElementById('filtroBuscaEstoqueGeral').value = '';
  document.getElementById('filtroSituacaoEstoqueGeral').value = '';
  document.getElementById('filtroAutonomiaEstoqueGeral').value = '';
  document.getElementById('filtroDemandaEstoqueGeral').value = '';
  COLS_FILTRO_GERAL.forEach(({ id }) => { document.getElementById(id).value = ''; });
  unidadesSelecionadasGeral = [];
  document.querySelectorAll('#filtroUnidadePainelGeral input[type="checkbox"]').forEach((c) => { c.checked = false; });
  atualizarRotuloUnidadeGeral();
  estadoEstoqueGeral.pagina = 1; carregarTabelaEstoqueGeral();
});
document.getElementById('botaoAnteriorEstoqueGeral').addEventListener('click', () => {
  if (estadoEstoqueGeral.pagina > 1) { estadoEstoqueGeral.pagina--; carregarTabelaEstoqueGeral(); }
});
document.getElementById('botaoProximoEstoqueGeral').addEventListener('click', () => {
  estadoEstoqueGeral.pagina++; carregarTabelaEstoqueGeral();
});

const filtroUnidadeBotaoGeral = document.getElementById('filtroUnidadeBotaoGeral');
const filtroUnidadePainelGeral = document.getElementById('filtroUnidadePainelGeral');
filtroUnidadeBotaoGeral.addEventListener('click', (ev) => { ev.stopPropagation(); filtroUnidadePainelGeral.hidden = !filtroUnidadePainelGeral.hidden; });
document.addEventListener('click', (ev) => {
  if (!document.getElementById('filtroUnidadeWrapGeral').contains(ev.target)) filtroUnidadePainelGeral.hidden = true;
});
function atualizarRotuloUnidadeGeral() {
  const n = unidadesSelecionadasGeral.length;
  filtroUnidadeBotaoGeral.innerHTML = (n === 0 ? 'Unidade dispensadora: todas' : `Unidade dispensadora: ${n} selecionada${n > 1 ? 's' : ''}`) + ' <span aria-hidden="true">▾</span>';
}
function montarFiltroUnidadeGeral(valores) {
  if (!valores || valores.length === 0) {
    filtroUnidadePainelGeral.innerHTML = '<div style="padding:6px 4px; color:var(--cinza-texto); font-size:12px;">Sem unidades nesta data. Reimporte o estoque para preencher.</div>';
    unidadesSelecionadasGeral = []; atualizarRotuloUnidadeGeral(); return;
  }
  filtroUnidadePainelGeral.innerHTML = valores.map((v) => {
    const e = v.replace(/"/g, '&quot;'); const m = unidadesSelecionadasGeral.includes(v) ? 'checked' : '';
    return `<label class="multi-filtro-item"><input type="checkbox" value="${e}" ${m}> ${v}</label>`;
  }).join('');
  filtroUnidadePainelGeral.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      unidadesSelecionadasGeral = Array.from(filtroUnidadePainelGeral.querySelectorAll('input:checked')).map((c) => c.value);
      atualizarRotuloUnidadeGeral(); estadoEstoqueGeral.pagina = 1; carregarTabelaEstoqueGeral();
    });
  });
  unidadesSelecionadasGeral = unidadesSelecionadasGeral.filter((u) => valores.includes(u));
  atualizarRotuloUnidadeGeral();
}

async function carregarFiltrosEstoqueGeral() {
  const params = new URLSearchParams();
  params.set('escopoUnidade', 'geral');
  if (estadoEstoqueGeral.data) params.set('data', estadoEstoqueGeral.data);
  let dados;
  try { dados = await api(`/estoque/filtros?${params.toString()}`); } catch (e) { return; }
  COLS_FILTRO_GERAL.forEach(({ id, coluna }) => {
    const sel = document.getElementById(id);
    const valorAtual = sel.value;
    const rotuloPadrao = sel.options[0].textContent;
    const opcoes = (dados[coluna] || []).map((v) => `<option value="${v.replace(/"/g, '&quot;')}">${v}</option>`).join('');
    sel.innerHTML = `<option value="">${rotuloPadrao}</option>` + opcoes;
    sel.value = valorAtual;
  });
  montarFiltroUnidadeGeral(dados.unidade || []);
}

async function carregarEstoqueGeral() {
  const resumo = await api('/estoque/resumo?escopoUnidade=geral');
  if (!resumo.dataReferencia) {
    document.getElementById('avisoSemEstoqueGeral').hidden = false;
    document.getElementById('conteudoEstoqueGeral').hidden = true;
    return;
  }
  document.getElementById('avisoSemEstoqueGeral').hidden = true;
  document.getElementById('conteudoEstoqueGeral').hidden = false;

  const seletor = document.getElementById('seletorDataEstoqueGeral');
  const lista = await api('/estoque?pageSize=1&escopoUnidade=geral');
  seletor.innerHTML = lista.datasDisponiveis.map((d) => `<option value="${d.data_referencia}">${formatarData(d.data_referencia)} (${d.total_itens} itens)</option>`).join('');
  if (!estadoEstoqueGeral.data) estadoEstoqueGeral.data = resumo.dataReferencia;
  seletor.value = estadoEstoqueGeral.data;

  document.getElementById('subtituloEstoqueGeral').textContent =
    `Itens em estoque das demais unidades em ${formatarData(resumo.dataReferencia)}${resumo.dataImportacao ? ' · importado às ' + resumo.dataImportacao.slice(11, 16) : ''} · autonomia mínima: ${resumo.limiarAutonomia} mês(es)`;

  // Os cards agora são dinâmicos (Judicial / CF-Adm / JEFAZ / Total) e batem
  // com a busca/filtros — preenchidos por atualizarCardsEstoqueGeral(), que é
  // chamado ao final de carregarTabelaEstoqueGeral().
  await carregarFiltrosEstoqueGeral();
  carregarTabelaEstoqueGeral();
}

// Monta os parâmetros de filtro (sem paginação) da tela Estoque Geral.
function paramsFiltroEstoqueGeral() {
  const params = new URLSearchParams({ escopoUnidade: 'geral' });
  if (estadoEstoqueGeral.data) params.set('data', estadoEstoqueGeral.data);
  const q = document.getElementById('filtroBuscaEstoqueGeral').value.trim();
  const situacao = document.getElementById('filtroSituacaoEstoqueGeral').value;
  const autonomia = document.getElementById('filtroAutonomiaEstoqueGeral').value;
  const demanda = document.getElementById('filtroDemandaEstoqueGeral').value;
  if (q) params.set('q', q);
  if (situacao) params.set('situacao', situacao);
  if (autonomia) params.set('autonomia', autonomia);
  if (demanda) params.set('demanda', demanda);
  COLS_FILTRO_GERAL.forEach(({ id, coluna }) => { const v = document.getElementById(id).value; if (v) params.set(coluna, v); });
  if (unidadesSelecionadasGeral.length) params.set('unidade', unidadesSelecionadasGeral.join(','));
  return params;
}

// Cards dinâmicos do Estoque Geral: demanda/consumo por programa (Judicial,
// CF/Adm, JEFAZ) e o total, somando todas as unidades do conjunto filtrado.
async function atualizarCardsEstoqueGeral() {
  const grade = document.getElementById('grideResumoEstoqueGeral');
  let r;
  try { r = await api(`/estoque/resumo?${paramsFiltroEstoqueGeral().toString()}`); }
  catch (_) { return; }
  const fmtDem = (v) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  const fmtCons = (v) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
  const card = (titulo, cls, o) => `
    <div class="cartao-resumo card-prog ${cls}">
      <div class="rotulo">${titulo}</div>
      <div class="prog-metrica"><span>Demanda</span><strong>${fmtDem(o.demanda)}</strong></div>
      <div class="prog-metrica"><span>Consumo</span><strong>${fmtCons(o.consumo)}</strong></div>
    </div>`;
  grade.innerHTML =
    card('Judicial', 'jud', r.judicial || {}) +
    card('CF (Adm)', 'adm', r.cf || {}) +
    card('JEFAZ', 'jef', r.jefaz || {}) +
    card('Total (Jud + Adm + JEFAZ)', 'tot', r.total || {});
}

function exportarEstoqueGeral() {
  const params = new URLSearchParams();
  params.set('escopoUnidade', 'geral');
  if (estadoEstoqueGeral.data) params.set('data', estadoEstoqueGeral.data);
  const q = document.getElementById('filtroBuscaEstoqueGeral').value.trim(); if (q) params.set('q', q);
  const situacao = document.getElementById('filtroSituacaoEstoqueGeral').value; if (situacao) params.set('situacao', situacao);
  const autonomia = document.getElementById('filtroAutonomiaEstoqueGeral').value; if (autonomia) params.set('autonomia', autonomia);
  const demanda = document.getElementById('filtroDemandaEstoqueGeral').value; if (demanda) params.set('demanda', demanda);
  COLS_FILTRO_GERAL.forEach(({ id, coluna }) => { const v = document.getElementById(id).value; if (v) params.set(coluna, v); });
  if (unidadesSelecionadasGeral.length) params.set('unidade', unidadesSelecionadasGeral.join(','));
  window.location.href = '/api/estoque/exportar?' + params.toString();
}
document.getElementById('botaoExportarEstoqueGeral').addEventListener('click', exportarEstoqueGeral);

async function carregarTabelaEstoqueGeral() {
  const q = document.getElementById('filtroBuscaEstoqueGeral').value.trim();
  const situacao = document.getElementById('filtroSituacaoEstoqueGeral').value;
  const autonomia = document.getElementById('filtroAutonomiaEstoqueGeral').value;
  const demanda = document.getElementById('filtroDemandaEstoqueGeral').value;

  const params = new URLSearchParams({ page: estadoEstoqueGeral.pagina, pageSize: estadoEstoqueGeral.pageSize });
  params.set('escopoUnidade', 'geral');
  if (estadoEstoqueGeral.data) params.set('data', estadoEstoqueGeral.data);
  if (q) params.set('q', q);
  if (situacao) params.set('situacao', situacao);
  if (autonomia) params.set('autonomia', autonomia);
  if (demanda) params.set('demanda', demanda);
  COLS_FILTRO_GERAL.forEach(({ id, coluna }) => { const v = document.getElementById(id).value; if (v) params.set(coluna, v); });
  if (unidadesSelecionadasGeral.length) params.set('unidade', unidadesSelecionadasGeral.join(','));

  const dados = await api(`/estoque?${params.toString()}`);
  const limiar = dados.limiarAutonomia;
  const corpo = document.getElementById('corpoTabelaEstoqueGeral');
  const vazio = document.getElementById('estadoVazioEstoqueGeral');

  if (dados.itens.length === 0) {
    corpo.innerHTML = ''; vazio.hidden = false;
  } else {
    vazio.hidden = true;
    corpo.innerHTML = dados.itens.map((it) => {
      const classe = classeAutonomia(it, limiar);
      const autonomiaTxt = it.autonomia === null ? '—' : `${fmtNumero(it.autonomia)} mês(es)`;
      const compraTag = it.compras_abertas > 0
        ? '<span class="etiqueta-status planejamento">Compra em aberto</span>'
        : '<span style="color:var(--cinza-texto); font-size:12px;">—</span>';
      const prox = proximaValidade(it.lotes);
      let validadeTd = '<span style="color:var(--cinza-texto); font-size:12px;">—</span>';
      if (prox) {
        const clsV = classeValidade(prox.validade);
        const tagV = clsV === 'vencido' ? 'cancelado' : clsV === 'proximo' ? 'atrasado' : 'finalizado';
        validadeTd = `<span class="etiqueta-status ${tagV}">${prox.validade}</span>`;
      }
      return `
        <tr>
          <td>${descricaoComMarcaHTML(it)}<br><span class="col-codigo">${it.codigo_item}</span>${it.siafisico ? ` · <span class="col-codigo">Siafísico: ${escHtml(String(it.siafisico))}</span>` : ''}${etiquetasProgramaHTML(it)}</td>
          <td>${it.unidade || '—'}</td>
          <td>${fmtNumero(it.demandas)}</td>
          <td>${fmtNumero(it.consumo_mensal_total)}</td>
          <td>${fmtNumero(it.estoque)}</td>
          <td><span class="etiqueta-status ${classe}">${autonomiaTxt}</span></td>
          <td class="col-data">${validadeTd}</td>
          <td>${compraTag}</td>
          <td><button class="botao-editar" data-codigo="${encodeURIComponent(it.codigo_item)}" data-unidade="${escAttr(it.unidade || '')}">Ver</button></td>
        </tr>`;
    }).join('');
    corpo.querySelectorAll('button[data-codigo]').forEach((btn) => {
      btn.addEventListener('click', () => abrirDetalheEstoque(btn.dataset.codigo, 'geral', btn.dataset.unidade));
    });
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoEstoqueGeral').textContent = `Página ${dados.page} de ${totalPaginas} · ${dados.total} itens`;
  document.getElementById('botaoAnteriorEstoqueGeral').disabled = dados.page <= 1;
  document.getElementById('botaoProximoEstoqueGeral').disabled = dados.page >= totalPaginas;

  // Atualiza os cards dinâmicos (demanda/consumo por programa) conforme os filtros.
  atualizarCardsEstoqueGeral();
}

// ==================== Estoque Outras Demandas (GSNET + IBL) ====================
const estadoEstoqueOD = { pagina: 1, pageSize: 30, data: null };

document.getElementById('filtroBuscaEstoqueOD').addEventListener('input', () => {
  clearTimeout(window.__debounceBuscaEstoqueOD);
  window.__debounceBuscaEstoqueOD = setTimeout(() => { estadoEstoqueOD.pagina = 1; carregarTabelaEstoqueOD(); }, 350);
});
document.getElementById('filtroComparativoEstoqueOD').addEventListener('change', () => { estadoEstoqueOD.pagina = 1; carregarTabelaEstoqueOD(); });
document.getElementById('filtroStatusEstoqueOD').addEventListener('change', () => { estadoEstoqueOD.pagina = 1; carregarTabelaEstoqueOD(); });
document.getElementById('seletorDataEstoqueOD').addEventListener('change', async (ev) => {
  estadoEstoqueOD.data = ev.target.value; estadoEstoqueOD.pagina = 1;
  await carregarFiltrosEstoqueOD(); carregarTabelaEstoqueOD();
});
document.getElementById('botaoLimparFiltrosEstoqueOD').addEventListener('click', () => {
  document.getElementById('filtroBuscaEstoqueOD').value = '';
  document.getElementById('filtroComparativoEstoqueOD').value = '';
  document.getElementById('filtroStatusEstoqueOD').value = '';
  estadoEstoqueOD.pagina = 1;
  carregarTabelaEstoqueOD();
});
document.getElementById('botaoAnteriorEstoqueOD').addEventListener('click', () => {
  if (estadoEstoqueOD.pagina > 1) { estadoEstoqueOD.pagina--; carregarTabelaEstoqueOD(); }
});
document.getElementById('botaoProximoEstoqueOD').addEventListener('click', () => {
  estadoEstoqueOD.pagina++; carregarTabelaEstoqueOD();
});
document.getElementById('botaoImportarEstoqueOD').addEventListener('click', async () => {
  const botao = document.getElementById('botaoImportarEstoqueOD');
  const status = document.getElementById('statusImportarEstoqueOD');
  botao.disabled = true;
  status.hidden = false;
  status.textContent = 'Importando…';
  try {
    const resumo = await api('/estoque-od/importar-manual', { method: 'POST' });
    status.textContent = `✓ ${resumo.totalItens} itens (${resumo.totalDivergente} divergentes)`;
    estadoEstoqueOD.data = null;
    await carregarEstoqueOD();
  } catch (e) {
    status.textContent = '✗ Falha ao importar. Veja se os 3 arquivos estão na pasta de rede.';
  } finally {
    botao.disabled = false;
    setTimeout(() => { status.hidden = true; }, 8000);
  }
});

async function carregarFiltrosEstoqueOD() {
  const params = new URLSearchParams();
  if (estadoEstoqueOD.data) params.set('data', estadoEstoqueOD.data);
  let dados;
  try { dados = await api(`/estoque-od/filtros?${params.toString()}`); } catch (e) { return; }
  const sel = document.getElementById('filtroStatusEstoqueOD');
  const valorAtual = sel.value;
  sel.innerHTML = '<option value="">Status estoque: todos</option>' +
    (dados.status_estoque || []).map((v) => `<option value="${v.replace(/"/g, '&quot;')}">${v}</option>`).join('');
  sel.value = valorAtual;
}

// -------------------- Estoque IBL (API ao vivo) --------------------
// Consulta a API somente-leitura do WMS IBL e mostra o estoque por lote dos
// locais configurados (2999 e 3004). Não grava no banco — cada "Atualizar"
// reflete o saldo do momento.
const estadoIbl = { dados: null };

// "(2999) IBL IMPORTADOS" -> "IBL IMPORTADOS" (tira o código repetido do início).
function nomeLocalIbl(nome) {
  return String(nome || '').replace(/^\(\d+\)\s*/, '').trim();
}
// Mapa código -> nome curto do local, a partir dos itens carregados.
function mapaNomesLocaisIbl() {
  const m = new Map();
  for (const i of (estadoIbl.dados?.itens || [])) {
    if (i.projeto_codigo && !m.has(i.projeto_codigo)) m.set(i.projeto_codigo, nomeLocalIbl(i.projeto_nome));
  }
  return m;
}

async function carregarEstoqueIblApi(forcar) {
  const aviso = document.getElementById('iblAviso');
  const conteudo = document.getElementById('iblConteudo');
  // Só busca da API quando ainda não tem dados nesta sessão ou ao clicar Atualizar.
  if (!estadoIbl.dados || forcar) {
    aviso.hidden = false; aviso.textContent = 'Consultando a API do IBL…'; conteudo.hidden = true;
    try {
      estadoIbl.dados = await api('/ibl/estoque');
    } catch (e) {
      aviso.hidden = false; conteudo.hidden = true;
      aviso.textContent = 'Não foi possível consultar a API do IBL: ' + e.message;
      return;
    }
  }
  const d = estadoIbl.dados;
  aviso.hidden = true; conteudo.hidden = false;

  document.getElementById('subtituloEstoqueIblApi').textContent =
    `Consulta ao vivo do WMS IBL (CEAF/SES-SP)${d.geradoEm ? ' · gerado em ' + formatarData(d.geradoEm.slice(0, 10)) + ' às ' + d.geradoEm.slice(11, 16) : ''} · ${fmtNumero(d.total)} linhas (por lote)${d.semScodes ? ' · ' + fmtNumero(d.semScodes) + ' sem SCODES' : ''}.`;

  // Preenche o filtro de local (uma vez).
  const selLocal = document.getElementById('iblFiltroLocal');
  if (selLocal.options.length <= 1) {
    const nomes = mapaNomesLocaisIbl();
    (d.porProjeto || []).forEach((p) => {
      const o = document.createElement('option'); o.value = p.projeto;
      const nm = nomes.get(p.projeto);
      o.textContent = nm ? `${p.projeto} — ${nm}` : 'Local ' + p.projeto;
      selLocal.appendChild(o);
    });
  }

  // Cards de resumo por local: itens (SKUs distintos), lotes e total disponível.
  const cards = document.getElementById('iblCards');
  const porLocal = new Map();
  for (const i of d.itens) {
    const k = i.projeto_codigo || '—';
    let a = porLocal.get(k);
    if (!a) { a = { skus: new Set(), lotes: 0, disp: 0 }; porLocal.set(k, a); }
    a.skus.add(i.codigo_sku); a.lotes += 1; a.disp += Number(i.qtde_disponivel) || 0;
  }
  const nomesLoc = mapaNomesLocaisIbl();
  cards.innerHTML = [...porLocal.entries()].map(([loc, a]) => {
    const nm = nomesLoc.get(loc);
    return `<div class="cartao-resumo"><div class="numero">${fmtNumero(a.skus.size)}</div><div class="rotulo">Local ${escHtml(loc)}${nm ? ' — ' + escHtml(nm) : ''} · itens (${fmtNumero(a.lotes)} lotes · ${fmtNumero(a.disp)} disp.)</div></div>`;
  }).join('');

  renderIblAtual();
}

function renderIblTabela() {
  const d = estadoIbl.dados;
  if (!d) return;
  const itens = iblItensFiltrados();

  const LIM = 1000;
  const corpo = document.getElementById('iblTabelaCorpo');
  corpo.innerHTML = itens.slice(0, LIM).map((i) => `<tr>
    <td>${escHtml(i.projeto_codigo || '—')}${i.projeto_nome ? '<br><span class="col-codigo">' + escHtml(nomeLocalIbl(i.projeto_nome)) + '</span>' : ''}</td>
    <td>${i.codigo_item ? escHtml(i.codigo_item) : '<span class="col-codigo">— sem SCODES</span>'}</td>
    <td>${escHtml(i.codigo_sku || '—')}</td>
    <td>${escHtml(i.siafisico || '—')}</td>
    <td>${escHtml(i.descricao || '—')}</td>
    <td>${escHtml(i.lote || '—')}</td>
    <td>${escHtml(i.validade || '—')}</td>
    <td class="num">${fmtNumero(i.qtde_disponivel)}</td>
    <td class="num">${(Number(i.qtde_bloqueado) || 0) > 0 ? fmtNumero(i.qtde_bloqueado) : '—'}</td>
    <td class="num">${(Number(i.qtde_reservada) || 0) > 0 ? fmtNumero(i.qtde_reservada) : '—'}</td>
    <td class="num">${fmtNumero(i.qtde_total)}</td>
    <td class="num">${i.multiplo_distribuicao == null ? '—' : fmtNumero(i.multiplo_distribuicao)}</td>
    <td class="num">${i.valor_unitario == null ? '—' : Number(i.valor_unitario).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
  </tr>`).join('') || '<tr><td colspan="13" class="dica" style="text-align:center;">Nenhuma linha para o filtro atual.</td></tr>';

  document.getElementById('iblTituloTabela').textContent =
    `Estoque por lote (${fmtNumero(itens.length)}${itens.length > LIM ? ', mostrando ' + LIM : ''})`;
}

// Aplica os filtros de topo (local/situação/busca) à lista por lote. Fonte única
// usada pela aba Por Lote, pela aba Consolidado e pelo export.
function iblItensFiltrados() {
  const d = estadoIbl.dados;
  if (!d) return [];
  const local = document.getElementById('iblFiltroLocal').value;
  const situacao = document.getElementById('iblFiltroSituacao').value;
  const busca = normalizarBusca(document.getElementById('iblBusca').value);
  let itens = d.itens;
  if (local) itens = itens.filter((i) => String(i.projeto_codigo) === local);
  if (situacao === 'disp') itens = itens.filter((i) => (Number(i.qtde_disponivel) || 0) > 0);
  else if (situacao === 'bloq') itens = itens.filter((i) => (Number(i.qtde_bloqueado) || 0) > 0);
  else if (situacao === 'reserv') itens = itens.filter((i) => (Number(i.qtde_reservada) || 0) > 0);
  if (busca) itens = itens.filter((i) =>
    normalizarBusca(i.descricao).includes(busca) ||
    normalizarBusca(i.codigo_item).includes(busca) ||
    normalizarBusca(i.codigo_sku).includes(busca) ||
    normalizarBusca(i.siafisico).includes(busca) ||
    normalizarBusca(i.lote).includes(busca));
  return itens;
}

// "dd/mm/aaaa" -> "aaaa-mm-dd" (para comparar validades).
function iblValidadeIso(br) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(br || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Consolida os itens filtrados por SKU (soma lotes, menor validade, conta lotes).
function iblConsolidarPorSku(itens) {
  const m = new Map();
  for (const l of itens) {
    let a = m.get(l.codigo_sku);
    if (!a) {
      a = {
        codigo_sku: l.codigo_sku, codigo_item: l.codigo_item, siafisico: l.siafisico,
        descricao: l.descricao, locais: new Set(), lotes: 0,
        disp: 0, bloq: 0, reserv: 0, total: 0, validadeMinIso: null, validadeMinBr: null,
      };
      m.set(l.codigo_sku, a);
    }
    if (l.projeto_codigo) a.locais.add(l.projeto_codigo);
    a.lotes += 1;
    a.disp += Number(l.qtde_disponivel) || 0;
    a.bloq += Number(l.qtde_bloqueado) || 0;
    a.reserv += Number(l.qtde_reservada) || 0;
    a.total += Number(l.qtde_total) || 0;
    const iso = iblValidadeIso(l.validade);
    if (iso && (!a.validadeMinIso || iso < a.validadeMinIso)) { a.validadeMinIso = iso; a.validadeMinBr = l.validade; }
  }
  return [...m.values()].sort((x, y) => y.disp - x.disp);
}

// Selo de validade: vermelho se vencida, âmbar se < 6 meses, senão neutro.
function iblSeloValidade(iso, br) {
  if (!iso) return '—';
  const hoje = new Date();
  const dv = new Date(iso + 'T00:00:00');
  const meses = (dv - hoje) / (1000 * 60 * 60 * 24 * 30);
  let cor = '#5f6b7a';
  if (meses < 0) cor = '#b3261e';
  else if (meses < 6) cor = '#b45309';
  return `<span class="tag-status" style="background:${cor}22; color:${cor}; border:1px solid ${cor}55;">${escHtml(br || '—')}</span>`;
}

function renderIblConsolidado() {
  const d = estadoIbl.dados;
  if (!d) return;
  const linhas = iblConsolidarPorSku(iblItensFiltrados());
  const corpo = document.getElementById('iblConsolidadoCorpo');
  corpo.innerHTML = linhas.map((a) => `<tr>
    <td>${[...a.locais].map(escHtml).join('+') || '—'}</td>
    <td>${escHtml(a.codigo_sku || '—')}</td>
    <td>${a.codigo_item ? escHtml(a.codigo_item) : '<span class="col-codigo">— sem SCODES</span>'}</td>
    <td>${escHtml(a.siafisico || '—')}</td>
    <td>${escHtml(a.descricao || '—')}</td>
    <td class="num">${fmtNumero(a.lotes)}</td>
    <td class="num">${fmtNumero(a.disp)}</td>
    <td class="num">${a.bloq > 0 ? fmtNumero(a.bloq) : '—'}</td>
    <td class="num">${a.reserv > 0 ? fmtNumero(a.reserv) : '—'}</td>
    <td class="num">${fmtNumero(a.total)}</td>
    <td>${iblSeloValidade(a.validadeMinIso, a.validadeMinBr)}</td>
    <td><button type="button" class="botao-secundario ibl-ver-lotes" data-sku="${escAttr(a.codigo_sku)}" style="padding:4px 10px;">Ver</button></td>
  </tr>`).join('') || '<tr><td colspan="12" class="dica" style="text-align:center;">Nenhum item para o filtro atual.</td></tr>';

  document.getElementById('iblTituloConsolidado').textContent = `Consolidado por SKU (${fmtNumero(linhas.length)})`;
}

// Desenha a aba ativa (Por Lote ou Consolidado).
function renderIblAtual() {
  const aba = document.querySelector('.aba-pasta.ativo')?.dataset.abaIbl || 'lotes';
  if (aba === 'consolidado') renderIblConsolidado(); else renderIblTabela();
}

// Troca de abas em pasta.
document.querySelectorAll('.aba-pasta[data-aba-ibl]').forEach((tab) => {
  const ativar = () => {
    document.querySelectorAll('.aba-pasta[data-aba-ibl]').forEach((t) => t.classList.toggle('ativo', t === tab));
    const aba = tab.dataset.abaIbl;
    document.getElementById('iblAbaLotes').hidden = aba !== 'lotes';
    document.getElementById('iblAbaConsolidado').hidden = aba !== 'consolidado';
    renderIblAtual();
  };
  tab.addEventListener('click', ativar);
  tab.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ativar(); } });
});

// Modal "Ver" — lotes/validades e quantidades de um SKU.
const modalLotesIbl = document.getElementById('modalLotesIbl');
document.getElementById('botaoFecharLotesIbl').addEventListener('click', () => { modalLotesIbl.hidden = true; });
modalLotesIbl.addEventListener('click', (ev) => { if (ev.target === modalLotesIbl) modalLotesIbl.hidden = true; });
document.getElementById('iblConsolidadoCorpo').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.ibl-ver-lotes');
  if (btn) abrirLotesIbl(btn.dataset.sku);
});

function abrirLotesIbl(sku) {
  const d = estadoIbl.dados;
  if (!d) return;
  const lotes = d.itens.filter((i) => String(i.codigo_sku) === String(sku))
    .sort((a, b) => (iblValidadeIso(a.validade) || '9').localeCompare(iblValidadeIso(b.validade) || '9'));
  const ref = lotes[0] || {};
  document.getElementById('tituloLotesIbl').textContent = ref.descricao || ('SKU ' + sku);
  document.getElementById('subLotesIbl').textContent =
    `SKU ${sku}${ref.codigo_item ? ' · SCODES ' + ref.codigo_item : ''} · ${fmtNumero(lotes.length)} lote(s)`;
  document.getElementById('corpoLotesIbl').innerHTML = `
    <table class="tabela">
      <thead><tr><th>Local</th><th>Lote</th><th>Validade</th>
        <th class="num">Disponível</th><th class="num">Bloqueado</th>
        <th class="num">Reservada</th><th class="num">Total</th></tr></thead>
      <tbody>${lotes.map((l) => `<tr>
        <td>${escHtml(l.projeto_codigo || '—')}</td>
        <td>${escHtml(l.lote || '—')}</td>
        <td>${iblSeloValidade(iblValidadeIso(l.validade), l.validade)}</td>
        <td class="num">${fmtNumero(l.qtde_disponivel)}</td>
        <td class="num">${(Number(l.qtde_bloqueado) || 0) > 0 ? fmtNumero(l.qtde_bloqueado) : '—'}</td>
        <td class="num">${(Number(l.qtde_reservada) || 0) > 0 ? fmtNumero(l.qtde_reservada) : '—'}</td>
        <td class="num">${fmtNumero(l.qtde_total)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  modalLotesIbl.hidden = false;
}

// Injeta no modal (Estoque TP/Geral e Listagem de Autores) o saldo IBL de
// Outras Demandas (2999/3004), consolidado por SCODES + validade + lotes.
// Só aparece quando o item existe no IBL. `codigo` é o SCODES (codigo_item).
async function injetarSaldoIblOD(codigo, alvoId) {
  const alvo = document.getElementById(alvoId);
  if (!alvo || !codigo) { if (alvo) alvo.innerHTML = ''; return; }
  alvo.innerHTML = '<div class="texto-apoio" style="padding:6px 0;">Consultando estoque IBL (Outras Demandas)…</div>';
  try {
    const s = await api('/ibl-item/saldo?codigo=' + encodeURIComponent(codigo));
    if (s.disponivel == null) { alvo.innerHTML = ''; return; } // item não está no IBL
    const lotesHtml = (s.lotes || []).map((l) => `<tr>
      <td>${escHtml(l.local || '—')}</td>
      <td class="col-codigo">${escHtml(l.lote || '—')}</td>
      <td class="col-data">${l.validade ? iblSeloValidade(iblValidadeIso(l.validade), l.validade) : '—'}</td>
      <td>${fmtNumero(l.disponivel)}</td>
    </tr>`).join('');
    alvo.innerHTML = `
      <h4>Estoque IBL — Outras Demandas <span class="texto-apoio">(locais ${escHtml((s.locais || []).join(' + ') || '—')} · disponível e dentro da validade)</span></h4>
      <div class="grade-resumo" style="grid-template-columns:repeat(2,1fr); margin-bottom:8px;">
        ${kpiCard('chart', fmtNumero(s.disponivel), 'Disponível IBL', 'situação disponível · dentro da validade')}
        ${kpiCard('relogio', s.validadeProxima || '—', 'Validade + próxima', 'menor validade')}
      </div>
      ${lotesHtml ? `<div class="rolagem-tabela"><table><thead><tr><th>Local</th><th>Lote</th><th>Validade</th><th>Disponível</th></tr></thead><tbody>${lotesHtml}</tbody></table></div>` : ''}
      ${s.geradoEm ? `<div class="texto-apoio" style="font-size:12px; margin-top:4px;">IBL ao vivo · gerado em ${formatarData(s.geradoEm.slice(0, 10))} às ${s.geradoEm.slice(11, 16)}</div>` : ''}`;
  } catch (e) {
    alvo.innerHTML = '<div class="texto-apoio" style="color:var(--vermelho);">Não consegui carregar o estoque IBL (Outras Demandas).</div>';
  }
}

// Injeta no modal o saldo IBL dos IMPORTADOS (local 2999). Casa por Código
// GSNET -> SCODES (itens_gsnet). Só aparece quando o item importado existe no
// IBL. `codigo` é o SCODES (codigo_item).
async function injetarSaldoIblImportado(codigo, alvoId) {
  const alvo = document.getElementById(alvoId);
  if (!alvo || !codigo) { if (alvo) alvo.innerHTML = ''; return; }
  alvo.innerHTML = '<div class="texto-apoio" style="padding:6px 0;">Consultando estoque IBL (Importados)…</div>';
  try {
    const s = await api('/ibl-item/saldo-importado?codigo=' + encodeURIComponent(codigo));
    if (s.disponivel == null) { alvo.innerHTML = ''; return; } // sem estoque disponível/vigente no IBL Importados
    const lotesHtml = (s.lotes || []).map((l) => `<tr>
      <td class="col-codigo">${escHtml(l.lote || '—')}</td>
      <td class="col-data">${l.validade ? iblSeloValidade(iblValidadeIso(l.validade), l.validade) : '—'}</td>
      <td>${fmtNumero(l.quantidade)}</td>
    </tr>`).join('');
    alvo.innerHTML = `
      <h4>Estoque IBL — Importados <span class="texto-apoio">(local 2999 · disponível e dentro da validade)</span></h4>
      <div class="grade-resumo" style="grid-template-columns:repeat(2,1fr); margin-bottom:8px;">
        ${kpiCard('chart', fmtNumero(s.disponivel), 'Disponível IBL', 'situação DISPONÍVEL · dentro da validade')}
        ${kpiCard('relogio', s.validadeProxima || '—', 'Validade + próxima', 'menor validade')}
      </div>
      ${lotesHtml ? `<div class="rolagem-tabela"><table><thead><tr><th>Lote</th><th>Validade</th><th>Quantidade</th></tr></thead><tbody>${lotesHtml}</tbody></table></div>` : ''}
      ${s.geradoEm ? `<div class="texto-apoio" style="font-size:12px; margin-top:4px;">IBL ao vivo · gerado em ${formatarData(s.geradoEm.slice(0, 10))} às ${s.geradoEm.slice(11, 16)}</div>` : ''}`;
  } catch (e) {
    alvo.innerHTML = '<div class="texto-apoio" style="color:var(--vermelho);">Não consegui carregar o estoque IBL (Importados).</div>';
  }
}

document.getElementById('iblAtualizar').addEventListener('click', () => carregarEstoqueIblApi(true));
document.getElementById('iblFiltroLocal').addEventListener('change', renderIblAtual);
document.getElementById('iblFiltroSituacao').addEventListener('change', renderIblAtual);
document.getElementById('iblBusca').addEventListener('input', renderIblAtual);
document.getElementById('iblExportar').addEventListener('click', exportarIblCsv);

// Export simples em CSV do que está filtrado na tela (sem ida ao servidor).
function exportarIblCsv() {
  const d = estadoIbl.dados;
  if (!d) return;
  const itens = iblItensFiltrados();
  const cab = ['Local', 'Cod SCODES', 'Cod SKU', 'Siafisico', 'Descricao', 'Lote', 'Validade', 'Disponivel', 'Bloqueado', 'Reservada', 'Total', 'Multiplo', 'Valor unit.'];
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const linhas = itens.map((i) => [i.projeto_codigo, i.codigo_item, i.codigo_sku, i.siafisico, i.descricao, i.lote, i.validade,
    i.qtde_disponivel, i.qtde_bloqueado, i.qtde_reservada, i.qtde_total, i.multiplo_distribuicao, i.valor_unitario].map(esc).join(';'));
  const csv = '﻿' + [cab.map(esc).join(';'), ...linhas].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url; a.download = `Estoque_IBL_API_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

async function carregarEstoqueOD() {
  const resumo = await api('/estoque-od/resumo');
  if (!resumo.dataReferencia) {
    document.getElementById('avisoSemEstoqueOD').hidden = false;
    document.getElementById('conteudoEstoqueOD').hidden = true;
    return;
  }
  document.getElementById('avisoSemEstoqueOD').hidden = true;
  document.getElementById('conteudoEstoqueOD').hidden = false;

  const seletor = document.getElementById('seletorDataEstoqueOD');
  const lista = await api('/estoque-od?pageSize=1');
  seletor.innerHTML = lista.datasDisponiveis.map((d) => `<option value="${d.data_referencia}">${formatarData(d.data_referencia)} (${d.total_itens} itens)</option>`).join('');
  if (!estadoEstoqueOD.data) estadoEstoqueOD.data = resumo.dataReferencia;
  seletor.value = estadoEstoqueOD.data;

  document.getElementById('subtituloEstoqueOD').textContent =
    `Posição de estoque no operador logístico em ${formatarData(resumo.dataReferencia)}${horaImportacao(resumo.dataImportacao)}`;

  document.getElementById('grideResumoEstoqueOD').innerHTML = `
    <div class="cartao-resumo"><div class="numero">${fmtNumero(resumo.totalItens)}</div><div class="rotulo">Linhas (lotes)</div></div>
    <div class="cartao-resumo alerta"><div class="numero">${fmtNumero(resumo.divergente)}</div><div class="rotulo">Saldo divergente (GSNET x IBL)</div></div>
    <div class="cartao-resumo"><div class="numero">${fmtNumero(resumo.semCorrespondencia)}</div><div class="rotulo">Sem código SCODES correspondente</div></div>
  `;
  await carregarFiltrosEstoqueOD();
  carregarTabelaEstoqueOD();
}

async function carregarTabelaEstoqueOD() {
  const q = document.getElementById('filtroBuscaEstoqueOD').value.trim();
  const statusComparativo = document.getElementById('filtroComparativoEstoqueOD').value;
  const statusEstoque = document.getElementById('filtroStatusEstoqueOD').value;

  const params = new URLSearchParams({ page: estadoEstoqueOD.pagina, pageSize: estadoEstoqueOD.pageSize });
  if (estadoEstoqueOD.data) params.set('data', estadoEstoqueOD.data);
  if (q) params.set('q', q);
  if (statusComparativo) params.set('status_comparativo', statusComparativo);
  if (statusEstoque) params.set('status_estoque', statusEstoque);

  const dados = await api(`/estoque-od?${params.toString()}`);
  const corpo = document.getElementById('corpoTabelaEstoqueOD');
  const vazio = document.getElementById('estadoVazioEstoqueOD');

  if (dados.itens.length === 0) {
    corpo.innerHTML = ''; vazio.hidden = false;
  } else {
    vazio.hidden = true;
    corpo.innerHTML = dados.itens.map((it) => {
      const tagComparativo = it.status_comparativo === 'Bate'
        ? `<span class="etiqueta-status finalizado">Bate</span>`
        : it.status_comparativo === 'Diverge'
          ? `<span class="etiqueta-status cancelado">Diverge</span>`
          : `<span class="etiqueta-status atrasado">Sem correspondência</span>`;
      return `
        <tr>
          <td class="col-codigo">${it.codigo_item || '—'}</td>
          <td>${it.descricao || '—'}</td>
          <td class="col-codigo">${it.codigo_sku || '—'}</td>
          <td>${it.lote || '—'}</td>
          <td class="col-data">${it.validade || '—'}</td>
          <td>${it.embalagem2 || '—'}</td>
          <td>${fmtNumero(it.multiplo_distribuicao)}</td>
          <td>${it.status_estoque || '—'}</td>
          <td>${it.tipo_bloqueio || '—'}</td>
          <td>${it.obs_bloqueio || '—'}</td>
          <td>${fmtNumero(it.qtde_disponivel)}</td>
          <td>${fmtNumero(it.qtde_bloqueado)}</td>
          <td>${fmtNumero(it.qtde_reservada)}</td>
          <td>${fmtNumero(it.qtde_total)}</td>
          <td>${it.saldo_gsnet === null ? '—' : fmtNumero(it.saldo_gsnet)}</td>
          <td>${tagComparativo}</td>
          <td>${it.diferenca === null ? '—' : fmtNumero(it.diferenca)}</td>
        </tr>`;
    }).join('');
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoEstoqueOD').textContent = `Página ${dados.page} de ${totalPaginas} · ${dados.total} linhas`;
  document.getElementById('botaoAnteriorEstoqueOD').disabled = dados.page <= 1;
  document.getElementById('botaoProximoEstoqueOD').disabled = dados.page >= totalPaginas;
}

// ---- Abas: Por Lote / Consolidado por Item ----
document.querySelectorAll('#abasEstoqueOD .chip-faixa').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#abasEstoqueOD .chip-faixa').forEach((b) => b.classList.remove('ativo'));
    btn.classList.add('ativo');
    const aba = btn.dataset.aba;
    document.getElementById('abaLotesEstoqueOD').hidden = aba !== 'lotes';
    document.getElementById('abaConsolidadoEstoqueOD').hidden = aba !== 'consolidado';
    document.getElementById('abaValidadesEstoqueOD').hidden = aba !== 'validades';
    if (aba === 'consolidado') carregarTabelaEstoqueODConsolidado();
    if (aba === 'validades') carregarValidadesEstoqueOD();
  });
});

const estadoEstoqueODConsolidado = { pagina: 1, pageSize: 30 };

document.getElementById('filtroBuscaEstoqueODConsolidado').addEventListener('input', () => {
  clearTimeout(window.__debounceBuscaEstoqueODConsolidado);
  window.__debounceBuscaEstoqueODConsolidado = setTimeout(() => { estadoEstoqueODConsolidado.pagina = 1; carregarTabelaEstoqueODConsolidado(); }, 350);
});
document.getElementById('filtroComparativoEstoqueODConsolidado').addEventListener('change', () => { estadoEstoqueODConsolidado.pagina = 1; carregarTabelaEstoqueODConsolidado(); });
document.getElementById('botaoAnteriorEstoqueODConsolidado').addEventListener('click', () => {
  if (estadoEstoqueODConsolidado.pagina > 1) { estadoEstoqueODConsolidado.pagina--; carregarTabelaEstoqueODConsolidado(); }
});
document.getElementById('botaoProximoEstoqueODConsolidado').addEventListener('click', () => {
  estadoEstoqueODConsolidado.pagina++; carregarTabelaEstoqueODConsolidado();
});
document.getElementById('botaoFecharModalEstoqueOD').addEventListener('click', () => {
  document.getElementById('modalEstoqueODItem').hidden = true;
});

async function carregarTabelaEstoqueODConsolidado() {
  const q = document.getElementById('filtroBuscaEstoqueODConsolidado').value.trim();
  const statusComparativo = document.getElementById('filtroComparativoEstoqueODConsolidado').value;

  const params = new URLSearchParams({ page: estadoEstoqueODConsolidado.pagina, pageSize: estadoEstoqueODConsolidado.pageSize });
  if (estadoEstoqueOD.data) params.set('data', estadoEstoqueOD.data);
  if (q) params.set('q', q);
  if (statusComparativo) params.set('status_comparativo', statusComparativo);

  const dados = await api(`/estoque-od/consolidado?${params.toString()}`);
  const corpo = document.getElementById('corpoTabelaEstoqueODConsolidado');
  const vazio = document.getElementById('estadoVazioEstoqueODConsolidado');

  if (dados.itens.length === 0) {
    corpo.innerHTML = ''; vazio.hidden = false;
  } else {
    vazio.hidden = true;
    corpo.innerHTML = dados.itens.map((it) => {
      const tagComparativo = it.status_comparativo === 'Bate'
        ? `<span class="etiqueta-status finalizado">Bate</span>`
        : it.status_comparativo === 'Diverge'
          ? `<span class="etiqueta-status cancelado">Diverge</span>`
          : `<span class="etiqueta-status atrasado">Sem correspondência</span>`;
      return `
        <tr>
          <td class="col-codigo">${it.codigo_item || '—'}</td>
          <td>${it.descricao || '—'}</td>
          <td class="col-codigo">${it.codigo_sku || '—'}</td>
          <td>${fmtNumero(it.qtde_disponivel)}</td>
          <td>${fmtNumero(it.qtde_bloqueado)}</td>
          <td>${it.saldo_gsnet === null ? '—' : fmtNumero(it.saldo_gsnet)}</td>
          <td>${tagComparativo}</td>
          <td>${it.diferenca === null ? '—' : fmtNumero(it.diferenca)}</td>
          <td><button class="botao-editar" data-sku="${encodeURIComponent(it.codigo_sku)}">Ver</button></td>
        </tr>`;
    }).join('');
    corpo.querySelectorAll('button[data-sku]').forEach((btn) => {
      btn.addEventListener('click', () => abrirDetalheEstoqueODItem(btn.dataset.sku));
    });
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoEstoqueODConsolidado').textContent = `Página ${dados.page} de ${totalPaginas} · ${dados.total} itens`;
  document.getElementById('botaoAnteriorEstoqueODConsolidado').disabled = dados.page <= 1;
  document.getElementById('botaoProximoEstoqueODConsolidado').disabled = dados.page >= totalPaginas;
}

// ---- Aba: Controle de Validade ----
const estadoValidadesEstoqueOD = { janela: '' };

document.getElementById('filtroBuscaValidadesEstoqueOD').addEventListener('input', () => {
  clearTimeout(window.__debounceBuscaValidadesEstoqueOD);
  window.__debounceBuscaValidadesEstoqueOD = setTimeout(() => carregarValidadesEstoqueOD(), 350);
});
document.querySelectorAll('#filtrosFaixaValidadesEstoqueOD .chip-faixa').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#filtrosFaixaValidadesEstoqueOD .chip-faixa').forEach((b) => b.classList.remove('ativo'));
    btn.classList.add('ativo');
    estadoValidadesEstoqueOD.janela = btn.dataset.janela;
    carregarValidadesEstoqueOD();
  });
});

async function carregarValidadesEstoqueOD() {
  const q = document.getElementById('filtroBuscaValidadesEstoqueOD').value.trim();
  const params = new URLSearchParams();
  if (estadoEstoqueOD.data) params.set('data', estadoEstoqueOD.data);
  if (q) params.set('q', q);
  if (estadoValidadesEstoqueOD.janela) params.set('janela', estadoValidadesEstoqueOD.janela);

  const dados = await api(`/estoque-od/validades?${params.toString()}`);
  const r = dados.resumo || { totalLotes: 0, vencido: 0, d30: 0, d60: 0, d90: 0, mais90: 0 };

  document.getElementById('grideKpiValidadesEstoqueOD').innerHTML = `
    <div class="cartao-resumo alerta"><div class="numero">${fmtNumero(r.vencido)}</div><div class="rotulo">Lotes vencidos</div></div>
    <div class="cartao-resumo"><div class="numero">${fmtNumero(r.d30)}</div><div class="rotulo">Vencem em até 30 dias</div></div>
    <div class="cartao-resumo"><div class="numero">${fmtNumero(r.d60)}</div><div class="rotulo">31 a 60 dias</div></div>
    <div class="cartao-resumo"><div class="numero">${fmtNumero(r.d90)}</div><div class="rotulo">61 a 90 dias</div></div>
    <div class="cartao-resumo"><div class="numero">${fmtNumero(r.mais90)}</div><div class="rotulo">Mais de 90 dias</div></div>
  `;

  const corpo = document.getElementById('corpoTabelaValidadesEstoqueOD');
  const vazio = document.getElementById('estadoVazioValidadesEstoqueOD');
  if (!dados.lotes || dados.lotes.length === 0) {
    corpo.innerHTML = ''; vazio.hidden = false;
  } else {
    vazio.hidden = true;
    corpo.innerHTML = dados.lotes.map((l) => {
      const cls = corFaixaValidade(l.faixa);
      const diasTxt = l.dias_para_vencer < 0
        ? `vencido há ${Math.abs(l.dias_para_vencer)} dia(s)`
        : `${l.dias_para_vencer} dia(s)`;
      return `
        <tr>
          <td class="col-codigo">${l.codigo_item || '—'}</td>
          <td>${l.descricao || '—'}</td>
          <td class="col-codigo">${l.codigo_sku || '—'}</td>
          <td>${l.lote || '—'}</td>
          <td class="col-data"><span class="etiqueta-status ${cls}">${l.validade}</span></td>
          <td>${diasTxt}</td>
          <td>${fmtNumero(l.qtde_disponivel)}</td>
          <td>${fmtNumero(l.qtde_bloqueado)}</td>
          <td>${fmtNumero(l.qtde_total)}</td>
        </tr>
      `;
    }).join('');
  }

  document.getElementById('textoContagemValidadesEstoqueOD').textContent =
    `${dados.lotes ? dados.lotes.length : 0} lote(s) exibido(s) · ${fmtNumero(r.totalLotes)} no total`;
}

async function abrirDetalheEstoqueODItem(skuEncoded) {
  const modal = document.getElementById('modalEstoqueODItem');
  const conteudo = document.getElementById('conteudoModalEstoqueOD');
  conteudo.innerHTML = '<p class="texto-apoio">Carregando…</p>';
  modal.hidden = false;

  const params = new URLSearchParams();
  if (estadoEstoqueOD.data) params.set('data', estadoEstoqueOD.data);
  const dados = await api(`/estoque-od/item/${skuEncoded}?${params.toString()}`);

  document.getElementById('tituloModalEstoqueOD').textContent = dados.descricao || dados.codigoSku;
  document.getElementById('codigoModalEstoqueOD').textContent =
    `SCODES: ${dados.codigo_item || '—'} · SKU: ${dados.codigoSku}`;

  let html = '';
  if (dados.saldo_gsnet !== null && dados.saldo_gsnet !== undefined) {
    const tagComparativo = dados.status_comparativo === 'Bate'
      ? `<span class="etiqueta-status finalizado">Bate</span>`
      : dados.status_comparativo === 'Diverge'
        ? `<span class="etiqueta-status cancelado">Diverge</span>`
        : `<span class="etiqueta-status atrasado">Sem correspondência</span>`;
    html += `
      <div class="grade-resumo" style="grid-template-columns: repeat(3, 1fr); margin-bottom:18px;">
        <div class="cartao-resumo"><div class="numero" style="font-size:22px;">${fmtNumero(dados.saldo_gsnet)}</div><div class="rotulo">Saldo Disp. GSNET</div></div>
        <div class="cartao-resumo"><div class="numero" style="font-size:22px;">${dados.diferenca === null ? '—' : fmtNumero(dados.diferenca)}</div><div class="rotulo">Diferença</div></div>
        <div class="cartao-resumo"><div style="margin-top:4px;">${tagComparativo}</div><div class="rotulo">Comparativo</div></div>
      </div>
    `;
  }

  html += '<h4>Lotes</h4>';
  if (dados.lotes.length === 0) {
    html += '<p class="texto-apoio">Sem lotes para este item na data selecionada.</p>';
  } else {
    html += `<table><thead><tr><th>Lote</th><th>Validade</th><th>Múltiplo Distribuição</th><th>Disponível</th><th>Bloqueado</th><th>Motivo do Bloqueio</th></tr></thead><tbody>`;
    html += dados.lotes.map((l) => {
      const naoInformado = (v) => !v || String(v).trim().toLowerCase() === 'não informado';
      const partes = [naoInformado(l.tipo_bloqueio) ? null : l.tipo_bloqueio, naoInformado(l.obs_bloqueio) ? null : l.obs_bloqueio].filter(Boolean);
      const bloqueado = (l.qtde_bloqueado || 0) > 0;
      const motivo = bloqueado ? (partes.join(' — ') || '—') : '—';
      return `
      <tr>
        <td class="col-codigo">${l.lote || '—'}</td>
        <td class="col-data">${l.validade || '—'}</td>
        <td>${fmtNumero(l.multiplo_distribuicao)}</td>
        <td>${fmtNumero(l.qtde_disponivel)}</td>
        <td>${fmtNumero(l.qtde_bloqueado)}</td>
        <td>${bloqueado ? `<span class="etiqueta-status cancelado">${motivo}</span>` : '—'}</td>
      </tr>
    `;
    }).join('');
    html += '</tbody></table>';
  }

  conteudo.innerHTML = html;
}

// ==================== Relatório de Compras OD (Outras Demandas) ====================
const estadoSolicitacoesOD = { pagina: 1, pageSize: 50, filtrosCarregados: false };

document.getElementById('filtroBuscaSolicitacoesOD').addEventListener('input', () => {
  clearTimeout(window.__debounceBuscaSolicitacoesOD);
  window.__debounceBuscaSolicitacoesOD = setTimeout(() => { estadoSolicitacoesOD.pagina = 1; carregarTabelaSolicitacoesOD(); }, 350);
});
document.getElementById('filtroStatusSolicitacoesOD').addEventListener('change', () => { estadoSolicitacoesOD.pagina = 1; carregarTabelaSolicitacoesOD(); });
document.getElementById('filtroAnoSolicitacoesOD').addEventListener('change', () => { estadoSolicitacoesOD.pagina = 1; carregarTabelaSolicitacoesOD(); });
document.getElementById('filtroMesSolicitacoesOD').addEventListener('change', () => { estadoSolicitacoesOD.pagina = 1; carregarTabelaSolicitacoesOD(); });
document.getElementById('botaoLimparFiltrosSolicitacoesOD').addEventListener('click', () => {
  document.getElementById('filtroBuscaSolicitacoesOD').value = '';
  document.getElementById('filtroStatusSolicitacoesOD').value = '';
  document.getElementById('filtroAnoSolicitacoesOD').value = '';
  document.getElementById('filtroMesSolicitacoesOD').value = '';
  estadoSolicitacoesOD.pagina = 1;
  carregarTabelaSolicitacoesOD();
});
document.getElementById('botaoAnteriorSolicitacoesOD').addEventListener('click', () => {
  if (estadoSolicitacoesOD.pagina > 1) { estadoSolicitacoesOD.pagina--; carregarTabelaSolicitacoesOD(); }
});
document.getElementById('botaoProximoSolicitacoesOD').addEventListener('click', () => {
  estadoSolicitacoesOD.pagina++; carregarTabelaSolicitacoesOD();
});

// -------------------- Distribuição --------------------
const estadoDistFaturas = { pagina: 1, pageSize: 50, filtrosCarregados: false };
const estadoDistMov = { pagina: 1, pageSize: 50, filtrosCarregados: false };
let abaDistribuicaoAtiva = 'faturas';

document.querySelectorAll('#abasDistribuicao .chip-faixa').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#abasDistribuicao .chip-faixa').forEach((b) => b.classList.toggle('ativo', b === btn));
    abaDistribuicaoAtiva = btn.dataset.aba;
    document.getElementById('abaFaturasDistribuicao').hidden = abaDistribuicaoAtiva !== 'faturas';
    document.getElementById('abaMovimentacoesDistribuicao').hidden = abaDistribuicaoAtiva !== 'movimentacoes';
    document.getElementById('abaReposicaoDistribuicao').hidden = abaDistribuicaoAtiva !== 'reposicao';
    document.getElementById('abaHospitalEscolaDistribuicao').hidden = abaDistribuicaoAtiva !== 'hospitalescola';
    document.getElementById('abaGradeFinalDistribuicao').hidden = abaDistribuicaoAtiva !== 'gradefinal';
    if (abaDistribuicaoAtiva === 'faturas') carregarTabelaDistFaturas();
    else if (abaDistribuicaoAtiva === 'movimentacoes') carregarTabelaDistMov();
    else if (abaDistribuicaoAtiva === 'gradefinal') carregarGradeFinal();
    else if (abaDistribuicaoAtiva === 'hospitalescola') carregarTabelaReposicaoHE();
    else carregarTabelaReposicao();
  });
});

async function carregarDistribuicao() {
  const resumo = await api('/distribuicao/faturas/resumo');
  document.getElementById('grideResumoDistribuicao').innerHTML = `
    <div class="cartao-resumo"><div class="numero">${fmtNumero(resumo.total)}</div><div class="rotulo">Linhas de fatura importadas</div></div>
    <div class="cartao-resumo alerta"><div class="numero">${fmtNumero(resumo.pendentes)}</div><div class="rotulo">Pendentes de entrega</div></div>
  `;
  if (abaDistribuicaoAtiva === 'faturas') {
    await carregarFiltrosDistFaturas();
    carregarTabelaDistFaturas();
  } else if (abaDistribuicaoAtiva === 'movimentacoes') {
    await carregarFiltrosDistMov();
    carregarTabelaDistMov();
  } else {
    carregarTabelaReposicao();
  }
}

async function carregarFiltrosDistFaturas() {
  if (estadoDistFaturas.filtrosCarregados) return;
  try {
    const f = await api('/distribuicao/faturas/filtros');
    const preencher = (id, valores, rotulo) => {
      document.getElementById(id).innerHTML = `<option value="">${rotulo}</option>` +
        valores.map((v) => `<option value="${v.replace(/"/g, '&quot;')}">${v}</option>`).join('');
    };
    preencher('filtroStatusDistFaturas', f.status, 'Status: todos');
    preencher('filtroLocalDistFaturas', f.local, 'Unidade: todas');
    estadoDistFaturas.filtrosCarregados = true;
  } catch (e) { /* segue */ }
}

async function carregarTabelaDistFaturas() {
  const params = new URLSearchParams({ page: estadoDistFaturas.pagina, pageSize: estadoDistFaturas.pageSize });
  const q = document.getElementById('filtroBuscaDistFaturas').value.trim();
  if (q) params.set('q', q);
  const status = document.getElementById('filtroStatusDistFaturas').value;
  if (status) params.set('status', status);
  const local = document.getElementById('filtroLocalDistFaturas').value;
  if (local) params.set('local', local);

  const dados = await api(`/distribuicao/faturas?${params.toString()}`);
  const corpo = document.getElementById('corpoTabelaDistFaturas');
  const vazio = document.getElementById('estadoVazioDistFaturas');

  if (dados.itens.length === 0) {
    corpo.innerHTML = ''; vazio.hidden = false;
  } else {
    vazio.hidden = true;
    corpo.innerHTML = dados.itens.map((it) => `
      <tr>
        <td class="col-codigo">${it.numero_fatura || '—'}</td>
        <td class="col-codigo">${it.codigo_item || '—'}</td>
        <td class="col-codigo">${it.codigo_material || '—'}</td>
        <td>${it.nome_material || '—'}</td>
        <td>${it.local || '—'}</td>
        <td>${it.status || '—'}</td>
        <td>${it.emissao_fatura || '—'}</td>
        <td>${it.dt_programacao_entrega || '—'}</td>
        <td>${fmtNumero(it.qtde_faturada)}</td>
      </tr>
    `).join('');
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoDistFaturas').textContent = `Página ${dados.page} de ${totalPaginas} · ${fmtNumero(dados.total)} fatura(s)`;
  document.getElementById('botaoAnteriorDistFaturas').disabled = dados.page <= 1;
  document.getElementById('botaoProximoDistFaturas').disabled = dados.page >= totalPaginas;
}

document.getElementById('filtroBuscaDistFaturas').addEventListener('input', () => {
  clearTimeout(window.__debounceBuscaDistFaturas);
  window.__debounceBuscaDistFaturas = setTimeout(() => { estadoDistFaturas.pagina = 1; carregarTabelaDistFaturas(); }, 350);
});
document.getElementById('filtroStatusDistFaturas').addEventListener('change', () => { estadoDistFaturas.pagina = 1; carregarTabelaDistFaturas(); });
document.getElementById('filtroLocalDistFaturas').addEventListener('change', () => { estadoDistFaturas.pagina = 1; carregarTabelaDistFaturas(); });
document.getElementById('botaoLimparFiltrosDistFaturas').addEventListener('click', () => {
  document.getElementById('filtroBuscaDistFaturas').value = '';
  document.getElementById('filtroStatusDistFaturas').value = '';
  document.getElementById('filtroLocalDistFaturas').value = '';
  estadoDistFaturas.pagina = 1;
  carregarTabelaDistFaturas();
});
document.getElementById('botaoAnteriorDistFaturas').addEventListener('click', () => {
  if (estadoDistFaturas.pagina > 1) { estadoDistFaturas.pagina--; carregarTabelaDistFaturas(); }
});
document.getElementById('botaoProximoDistFaturas').addEventListener('click', () => {
  estadoDistFaturas.pagina++; carregarTabelaDistFaturas();
});

async function carregarFiltrosDistMov() {
  if (estadoDistMov.filtrosCarregados) return;
  try {
    const f = await api('/distribuicao/movimentacoes/filtros');
    document.getElementById('filtroDestinoDistMov').innerHTML = '<option value="">Unidade de destino: todas</option>' +
      f.local_destino.map((v) => `<option value="${v.replace(/"/g, '&quot;')}">${v}</option>`).join('');
    estadoDistMov.filtrosCarregados = true;
  } catch (e) { /* segue */ }
}

async function carregarTabelaDistMov() {
  const params = new URLSearchParams({ page: estadoDistMov.pagina, pageSize: estadoDistMov.pageSize });
  const q = document.getElementById('filtroBuscaDistMov').value.trim();
  if (q) params.set('q', q);
  const destino = document.getElementById('filtroDestinoDistMov').value;
  if (destino) params.set('local_destino', destino);

  const dados = await api(`/distribuicao/movimentacoes?${params.toString()}`);
  const corpo = document.getElementById('corpoTabelaDistMov');
  const vazio = document.getElementById('estadoVazioDistMov');

  if (dados.itens.length === 0) {
    corpo.innerHTML = ''; vazio.hidden = false;
  } else {
    vazio.hidden = true;
    corpo.innerHTML = dados.itens.map((it) => `
      <tr>
        <td class="col-codigo">${it.nr_documento || '—'}</td>
        <td>${it.dt_documento || '—'}</td>
        <td class="col-codigo">${it.codigo_item || '—'}</td>
        <td>${it.nm_item || '—'}</td>
        <td>${it.local_destino || '—'}</td>
        <td>${fmtNumero(it.qt_unit_atendida)}</td>
        <td>${it.pmu != null ? fmtNumero(it.pmu) : '—'}</td>
      </tr>
    `).join('');
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoDistMov').textContent = `Página ${dados.page} de ${totalPaginas} · ${fmtNumero(dados.total)} movimentação(ões)`;
  document.getElementById('botaoAnteriorDistMov').disabled = dados.page <= 1;
  document.getElementById('botaoProximoDistMov').disabled = dados.page >= totalPaginas;
}

document.getElementById('filtroBuscaDistMov').addEventListener('input', () => {
  clearTimeout(window.__debounceBuscaDistMov);
  window.__debounceBuscaDistMov = setTimeout(() => { estadoDistMov.pagina = 1; carregarTabelaDistMov(); }, 350);
});
document.getElementById('filtroDestinoDistMov').addEventListener('change', () => { estadoDistMov.pagina = 1; carregarTabelaDistMov(); });
document.getElementById('botaoLimparFiltrosDistMov').addEventListener('click', () => {
  document.getElementById('filtroBuscaDistMov').value = '';
  document.getElementById('filtroDestinoDistMov').value = '';
  estadoDistMov.pagina = 1;
  carregarTabelaDistMov();
});
document.getElementById('botaoAnteriorDistMov').addEventListener('click', () => {
  if (estadoDistMov.pagina > 1) { estadoDistMov.pagina--; carregarTabelaDistMov(); }
});
document.getElementById('botaoProximoDistMov').addEventListener('click', () => {
  estadoDistMov.pagina++; carregarTabelaDistMov();
});

// ==================== Reposição (fábrica de painéis) ====================
// Dois painéis usam exatamente a mesma lógica de sugestão de reposição:
//   - "Sugestão de Reposição" — geral, todas as unidades de Outras Demandas.
//   - "Distribuição H.E" — universo fechado do Hospital Escola (planilha 10).
// A fábrica criarPainelReposicao(cfg) evita duplicar ~250 linhas: cada painel
// tem seus próprios elementos (IDs com sufixo) e seu endpoint, mas compartilham
// a MESMA grade validada (tabela distribuicao_grade / aba Grade Final).

let gradeValidadas = new Set();          // chaves (local||scodes) já validadas na grade
function chaveGrade(local, scodes) { return `${local}||${scodes}`; }
function escAttr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }

// Arredondamentos de embalagem (espelham o backend) para o recálculo local.
function ceilMultiplo(q, m) { const k = m && m > 0 ? m : 1; return Math.ceil(q / k) * k; }
function floorMultiplo(q, m) { const k = m && m > 0 ? m : 1; return Math.floor(q / k) * k; }

const ROTULO_ETIQUETA = {
  total: '<span class="etiqueta-rep etiqueta-total">Reposição total</span>',
  parcial: '<span class="etiqueta-rep etiqueta-parcial">Reposição parcial</span>',
  sem_reposicao: '<span class="etiqueta-rep etiqueta-sem">Sem reposição</span>',
};

// Atualiza os contadores da grade nas duas abas (ambas mostram o mesmo total).
function atualizarContadorGrade(total) {
  if (total == null) return;
  ['contadorGrade', 'contadorGradeHE'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = total;
  });
}

// Carrega do banco quais itens já estão na grade validada e atualiza os contadores.
async function carregarGradeValidadas() {
  try {
    const { itens, total } = await api('/distribuicao/grade');
    gradeValidadas = new Set(itens.map((g) => chaveGrade(g.local_entrega, g.codigo_scodes)));
    atualizarContadorGrade(total != null ? total : gradeValidadas.size);
  } catch (e) { /* segue */ }
}

// Exportar a grade validada no layout do 9.Modelo grade (download .xlsx).
function baixarGradeXlsx() {
  const a = document.createElement('a');
  a.href = '/api/distribuicao/grade/exportar';
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Botão Validar/Negar por linha. Guarda no próprio botão os dados que vão para
// a grade (layout do 9.Modelo grade): SKU=COD_ITEM, nosso código=Código SCODES.
function botaoAcaoGrade(it) {
  const validado = gradeValidadas.has(chaveGrade(it.local_entrega, it.codigo_item));
  const attrs = `data-local="${escAttr(it.local_entrega)}" data-scodes="${escAttr(it.codigo_item)}"`
    + ` data-sku="${escAttr(it.codigo_sku)}" data-med="${escAttr(it.descricao_item)}"`
    + ` data-qtde="${escAttr(it.reposicao)}" data-val="${escAttr(it.validade)}"`;
  return validado
    ? `<button class="btn-grade btn-negar" ${attrs}>Negar</button>`
    : `<button class="btn-grade btn-validar" ${attrs}>Validar</button> <button class="btn-grade btn-manual" ${attrs}>Manual</button>`;
}

// cfg = { prefixo, endpoint, endpointUnidades, classeChk, escolherPadrao(unidades)->[valores] }
function criarPainelReposicao(cfg) {
  const $ = (base) => document.getElementById(base + cfg.prefixo);
  let dadosBrutos = [];
  let unidadesLista = [];
  let carregadas = false;
  let reqId = 0;
  let autonomiaAlvoPadrao = 3;
  const autonomiaPorSku = new Map();

  // Recalcula a reposição de UM SKU quando o usuário muda a autonomia-alvo dele.
  function recalcularSku(sku) {
    const grupo = dadosBrutos.filter((it) => it.codigo_sku === sku);
    if (!grupo.length) return;
    // Ajuste rápido por SKU (não salvo) sobrepõe; senão usa o coeficiente
    // persistente de cada item (item×unidade -> padrão do item -> 3).
    const alvoSku = autonomiaPorSku.has(sku) ? autonomiaPorSku.get(sku) : null;
    grupo.forEach((it) => {
      const alvo = alvoSku != null ? alvoSku : (it.coeficiente != null ? it.coeficiente : autonomiaAlvoPadrao);
      const sug = alvo <= 0 ? 0 : Math.max(0, Math.round(alvo * it.consumo_mensal - (it.estoque_convertido + it.fatura_transito)));
      it.sugestao = sug;
      it.reposicao = sug > 0 ? ceilMultiplo(sug, it.multiplo_embalagem) : 0;
    });
    const subtotal = grupo.reduce((s, it) => s + it.reposicao, 0);
    const op = grupo[0].estoque_operador;
    const mult = grupo[0].multiplo_embalagem;
    let et;
    if (subtotal <= 0) { et = 'sem_reposicao'; grupo.forEach((it) => { it.reposicao = 0; it.destaque = false; }); }
    else if (op == null) { et = 'total'; grupo.forEach((it) => { it.destaque = false; }); }
    else if (op >= subtotal) { et = 'total'; grupo.forEach((it) => { it.destaque = false; }); }
    else if (op > 0) {
      et = 'parcial';
      const fatia = op / grupo.length;
      grupo.forEach((it) => { it.reposicao = Math.min(it.reposicao, floorMultiplo(fatia, mult)); it.destaque = true; });
    } else { et = 'sem_reposicao'; grupo.forEach((it) => { it.reposicao = 0; it.destaque = true; }); }
    const sub2 = grupo.reduce((s, it) => s + it.reposicao, 0);
    grupo.forEach((it) => { it.etiqueta = et; it.subtotal_sku = sub2; });
  }

  async function carregarUnidades() {
    if (carregadas) return;
    const lista = $('listaUnidades');
    try {
      const { unidades } = await api(cfg.endpointUnidades);
      unidadesLista = unidades;
      lista.innerHTML = unidades.map((u) => `
        <label class="opcao-unidade"><input type="checkbox" class="${cfg.classeChk}" value="${escAttr(u)}"> ${u}</label>
      `).join('');
      const marcados = cfg.escolherPadrao ? cfg.escolherPadrao(unidades) : [];
      lista.querySelectorAll('.' + cfg.classeChk).forEach((c) => {
        if (marcados.includes(c.value)) c.checked = true;
        c.addEventListener('change', aoMudarUnidades);
      });
      carregadas = true;
      atualizarRotulo();
    } catch (e) { /* segue */ }
  }

  function selecionadas() {
    return [...$('listaUnidades').querySelectorAll('.' + cfg.classeChk + ':checked')].map((c) => c.value);
  }

  function atualizarRotulo() {
    const sel = selecionadas();
    const btn = $('botaoUnidades');
    const total = unidadesLista.length;
    if (sel.length === 0) btn.textContent = 'Selecione a(s) unidade(s) ▾';
    else if (sel.length === 1) btn.textContent = `${sel[0]} ▾`;
    else if (sel.length === total) btn.textContent = `Todas as unidades (${total}) ▾`;
    else btn.textContent = `${sel.length} unidades selecionadas ▾`;
    $('chkTodasUnidades').checked = sel.length === total && total > 0;
  }

  function aoMudarUnidades() {
    atualizarRotulo();
    carregar();
  }

  async function carregar() {
    await carregarUnidades();
    await carregarGradeValidadas();
    const sel = selecionadas();
    const corpo = $('corpoTabela');
    const vazio = $('estadoVazio');
    const info = $('info');

    if (sel.length === 0) {
      dadosBrutos = [];
      corpo.innerHTML = '';
      vazio.hidden = false;
      vazio.textContent = 'Selecione ao menos uma unidade.';
      info.textContent = '';
      return;
    }

    const todas = sel.length === unidadesLista.length;
    const paramUnidades = todas ? '__todas__' : sel.map(encodeURIComponent).join(',');

    const req = ++reqId;
    vazio.hidden = true;
    corpo.innerHTML = '';
    info.textContent = 'Calculando…';
    try {
      const dados = await api(`${cfg.endpoint}?unidades=${paramUnidades}&considerarFatura=${considerarFaturaDist ? '1' : '0'}&alvo=${encodeURIComponent(alvoDist || '')}&faixaAutonomia=${encodeURIComponent(faixaAutonomiaDist)}`);
      if (req !== reqId) return; // resposta antiga: descarta
      dadosBrutos = dados.itens;
      autonomiaAlvoPadrao = dados.autonomiaAlvoMeses || 3;
      autonomiaPorSku.clear();
      const nUnid = dados.unidades ? dados.unidades.length : sel.length;
      const rotFaixa = { min2: 'autonomia ≥ 2', ate2: 'autonomia ≤ 2', ate1: 'autonomia ≤ 1', min3: 'autonomia ≥ 3', todos: 'todas as autonomias' }[dados.faixaAutonomia || 'min2'];
      let txt = `Autonomia-alvo: ${dados.autonomiaAlvoMeses} meses · Mostrando ${rotFaixa} · `
        + `${nUnid} unidade(s) · Estoque: ${dados.dataReferenciaEstoque ? formatarData(dados.dataReferenciaEstoque) + horaImportacao(dados.dataImportacaoEstoque) : '—'} · `
        + `Operador: ${dados.dataReferenciaOperador ? formatarData(dados.dataReferenciaOperador) + horaImportacao(dados.dataImportacaoOperador) : '—'}`;
      if (dados.ignoradas && dados.ignoradas.length) txt += ` · Ignoradas (sem Local de Entrega): ${dados.ignoradas.length}`;
      info.textContent = txt;
      renderizar();
    } catch (e) {
      if (req !== reqId) return;
      corpo.innerHTML = '';
      vazio.hidden = false;
      vazio.textContent = 'Erro ao calcular: ' + e.message;
    }
  }

  function renderizar() {
    const q = normalizarBusca($('filtroBusca').value);
    const soSugeridos = $('filtroSoSugeridos').checked;
    const etiquetasSel = [...$('filtroEtiqueta').querySelectorAll('.chk-etiqueta:checked')].map((c) => c.value);
    const corpo = $('corpoTabela');
    const vazio = $('estadoVazio');

    let itens = dadosBrutos.slice();
    if (q) itens = itens.filter((it) => normalizarBusca(it.descricao_item).includes(q) || normalizarBusca(it.codigo_item).includes(q) || normalizarBusca(it.codigo_sku).includes(q));
    if (etiquetasSel.length) itens = itens.filter((it) => etiquetasSel.includes(it.etiqueta));
    if (soSugeridos) itens = itens.filter((it) => it.reposicao > 0);

    if (itens.length === 0) {
      corpo.innerHTML = '';
      vazio.hidden = false;
      vazio.textContent = 'Nenhum item elegível encontrado com estes filtros.';
      return;
    }
    vazio.hidden = true;

    const colador = (a, b) => (a || '').localeCompare(b || '', 'pt-BR', { sensitivity: 'base' });
    itens.sort((a, b) => colador(a.descricao_item, b.descricao_item) || colador(a.local_entrega, b.local_entrega));

    const grupos = [];
    const indice = new Map();
    for (const it of itens) {
      const chave = it.codigo_sku || `__sem_sku__${it.codigo_item}__${it.local_entrega}`;
      if (!indice.has(chave)) { indice.set(chave, grupos.length); grupos.push({ chave, sku: it.codigo_sku, itens: [] }); }
      grupos[indice.get(chave)].itens.push(it);
    }

    let html = '';
    for (const g of grupos) {
      const et = g.itens[0].etiqueta;
      for (const it of g.itens) {
        const classes = [];
        if (it.convertido) classes.push('linha-convertida');
        if (it.destaque) classes.push('linha-parcial');
        html += `
        <tr class="${classes.join(' ')}">
          <td>${it.local_entrega || '—'}</td>
          <td class="col-codigo">${it.codigo_item || '—'}</td>
          <td class="col-codigo">${it.codigo_sku || '—'}</td>
          <td>${it.descricao_item || '—'}</td>
          <td>${fmtNumero(it.demanda_total)}</td>
          <td>${fmtNumero(it.consumo_mensal)}</td>
          <td>${fmtNumero(it.estoque_convertido)}${it.convertido ? ` <span class="descricao-item">(÷${fmtNumero(it.conversao)})</span>` : ''}</td>
          <td>${fmtNumero(it.fatura_transito)}</td>
          <td>${it.autonomia == null ? '—' : fmtNumero(it.autonomia)}</td>
          <td class="col-coef">
            <input type="number" min="0" step="0.5" value="${it.coeficiente}" class="input-coef-item"
              data-cod="${escAttr(it.codigo_item)}" data-un="${escAttr(it.local_entrega)}"
              title="${it.coeficiente_origem === 'padrao' ? 'Herdado do padrão (3)' : it.coeficiente_origem === 'item' ? 'Padrão do item' : 'Ajuste desta unidade'} — 0 = não distribuir">
            <button type="button" class="btn-coef-todas" data-cod="${escAttr(it.codigo_item)}" title="Aplicar este coeficiente a TODAS as unidades deste item">todas</button>
          </td>
          <td>${it.estoque_operador == null ? '—' : fmtNumero(it.estoque_operador)}</td>
          <td>${it.validade || '—'}</td>
          <td>${it.multiplo_embalagem == null ? '—' : fmtNumero(it.multiplo_embalagem)}</td>
          <td>${fmtNumero(it.sugestao)}</td>
          <td><strong>${fmtNumero(it.reposicao)}</strong></td>
          <td>${ROTULO_ETIQUETA[it.etiqueta] || '—'}</td>
          <td>${botaoAcaoGrade(it)}</td>
        </tr>`;
      }
      if (g.sku) {
        const subtotal = g.itens[0].subtotal_sku;
        const op = g.itens[0].estoque_operador;
        const saldo = op == null ? null : op - subtotal;
        const celSaldo = op == null
          ? '—'
          : `${fmtNumero(op)} − ${fmtNumero(subtotal)} = <strong>${fmtNumero(saldo)}</strong>`;
        const alvo = autonomiaPorSku.has(g.sku) ? autonomiaPorSku.get(g.sku) : autonomiaAlvoPadrao;
        html += `
        <tr class="linha-subtotal-sku">
          <td colspan="9" style="text-align:right;">
            <strong>Subtotal do SKU ${g.sku} · ${g.itens.length} local(is)</strong>
            &nbsp;·&nbsp;<span class="rotulo-autonomia">Autonomia-alvo:</span>
            <input type="number" min="0" step="0.5" value="${alvo}" class="input-autonomia-sku" data-sku="${String(g.sku).replace(/"/g, '&quot;')}" title="Meses de autonomia-alvo deste SKU (ajuste rápido, não salvo)">
          </td>
          <td></td>
          <td title="Saldo do operador após a reposição">${celSaldo}</td>
          <td colspan="3"></td>
          <td><strong>${fmtNumero(subtotal)}</strong></td>
          <td>${ROTULO_ETIQUETA[et] || '—'}</td>
          <td></td>
        </tr>`;
      }
    }
    corpo.innerHTML = html;
  }

  // ---- Listeners deste painel ----
  $('botaoUnidades').addEventListener('click', (ev) => {
    ev.stopPropagation();
    const painel = $('painelUnidades');
    painel.hidden = !painel.hidden;
  });
  document.addEventListener('click', (ev) => {
    const seletor = $('seletorUnidades');
    if (seletor && !seletor.contains(ev.target)) $('painelUnidades').hidden = true;
  });
  $('chkTodasUnidades').addEventListener('change', (ev) => {
    $('listaUnidades').querySelectorAll('.' + cfg.classeChk).forEach((c) => { c.checked = ev.target.checked; });
    aoMudarUnidades();
  });
  $('filtroBusca').addEventListener('input', renderizar);
  $('filtroSoSugeridos').addEventListener('change', renderizar);
  $('filtroEtiqueta').querySelectorAll('.chk-etiqueta').forEach((c) => c.addEventListener('change', renderizar));

  // Autonomia-alvo por SKU (input na linha de subtotal). Delegação no tbody.
  $('corpoTabela').addEventListener('change', (ev) => {
    const inp = ev.target;
    if (!inp.classList || !inp.classList.contains('input-autonomia-sku')) return;
    const sku = inp.dataset.sku;
    let v = parseFloat(String(inp.value).replace(',', '.'));
    if (!Number.isFinite(v) || v < 0) v = autonomiaAlvoPadrao;
    autonomiaPorSku.set(sku, v);
    recalcularSku(sku);
    renderizar();
  });

  // Coeficiente (alvo em meses) PERSISTENTE por item × unidade. Ao alterar,
  // salva no banco e recarrega — o servidor recalcula a sugestão com o rateio.
  async function salvarCoeficiente(codigoItem, unidade, valor, aplicarTodas) {
    const bruto = String(valor).trim();
    const coeficiente = bruto === '' ? '' : Number(bruto.replace(',', '.'));
    if (coeficiente !== '' && (!Number.isFinite(coeficiente) || coeficiente < 0)) {
      alert('Coeficiente inválido: use um número ≥ 0 (0 = não distribuir).');
      return;
    }
    try {
      await api('/distribuicao/coeficiente', {
        method: 'PUT',
        body: JSON.stringify({ codigo_item: codigoItem, unidade, coeficiente, aplicarTodas }),
      });
      await carregar();
    } catch (e) { alert('Não foi possível salvar o coeficiente: ' + e.message); }
  }
  $('corpoTabela').addEventListener('change', (ev) => {
    const inp = ev.target.closest && ev.target.closest('.input-coef-item');
    if (!inp) return;
    salvarCoeficiente(inp.dataset.cod, inp.dataset.un, inp.value, false);
  });
  $('corpoTabela').addEventListener('click', (ev) => {
    const btn = ev.target.closest && ev.target.closest('.btn-coef-todas');
    if (!btn) return;
    const inp = btn.parentElement.querySelector('.input-coef-item');
    salvarCoeficiente(btn.dataset.cod, '', inp ? inp.value : '', true);
  });

  // Validar / Negar por linha (grade compartilhada). Delegação no tbody.
  $('corpoTabela').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('.btn-grade');
    if (!btn) return;
    const d = btn.dataset;
    const manual = btn.classList.contains('btn-manual');
    const validar = btn.classList.contains('btn-validar');

    // "Manual": pergunta a quantidade e grava na grade marcada como manual.
    if (manual) {
      const resp = prompt(`Quantidade manual para "${d.med}"\n${d.local}:`, d.qtde || '');
      if (resp === null) return; // cancelou
      const q = Number(String(resp).replace(',', '.'));
      if (!Number.isFinite(q) || q < 0) { alert('Quantidade inválida — use um número ≥ 0.'); return; }
      btn.disabled = true;
      try {
        const r = await api('/distribuicao/grade/validar', {
          method: 'POST',
          body: JSON.stringify({
            local_entrega: d.local, codigo_scodes: d.scodes, cod_item: d.sku,
            medicamento: d.med, qtde: q, validade: d.val, origem: 'manual',
          }),
        });
        gradeValidadas.add(chaveGrade(d.local, d.scodes));
        atualizarContadorGrade(r.total);
        renderizar();
      } catch (e) { alert('Erro: ' + e.message); btn.disabled = false; }
      return;
    }

    btn.disabled = true;
    try {
      if (validar) {
        const r = await api('/distribuicao/grade/validar', {
          method: 'POST',
          body: JSON.stringify({
            local_entrega: d.local, codigo_scodes: d.scodes, cod_item: d.sku,
            medicamento: d.med, qtde: Number(d.qtde) || 0, validade: d.val, origem: 'calculada',
          }),
        });
        gradeValidadas.add(chaveGrade(d.local, d.scodes));
        atualizarContadorGrade(r.total);
      } else {
        const r = await api('/distribuicao/grade/negar', {
          method: 'POST',
          body: JSON.stringify({ local_entrega: d.local, codigo_scodes: d.scodes }),
        });
        gradeValidadas.delete(chaveGrade(d.local, d.scodes));
        atualizarContadorGrade(r.total);
      }
      renderizar();
    } catch (e) {
      alert('Erro: ' + e.message);
      btn.disabled = false;
    }
  });

  return { carregar };
}

// Painel geral (Sugestão de Reposição) — padrão: CEDMAC marcada.
const painelReposicao = criarPainelReposicao({
  prefixo: 'Reposicao',
  endpoint: '/distribuicao/reposicao',
  endpointUnidades: '/distribuicao/reposicao/unidades',
  classeChk: 'chk-unidade-rep',
  escolherPadrao: (unidades) => [unidades.includes('UD 27 - CEDMAC HCFMUSP') ? 'UD 27 - CEDMAC HCFMUSP' : unidades[0]].filter(Boolean),
});
function carregarTabelaReposicao() { return painelReposicao.carregar(); }

// "Considerar fatura": quando ligado, a sugestão desconta a quantidade a chegar
// das faturas; desligado, ignora (ex.: sem fatura emitida). Vale para os dois
// painéis (Reposição e Distribuição H.E).
let considerarFaturaDist = true;
// Alvo (meses) global forçado pela tela ('' = usar o cadastro/coeficiente).
let alvoDist = '';
// Faixa de autonomia exibida (min2 = padrão: só >= 2).
let faixaAutonomiaDist = 'min2';

function recarregarPaineisDist() {
  painelReposicao.carregar();
  if (typeof painelReposicaoHE !== 'undefined') painelReposicaoHE.carregar();
}
function aplicarConsiderarFatura(valor) {
  considerarFaturaDist = valor;
  ['toggleConsiderarFatura', 'toggleConsiderarFaturaHE'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.checked = valor;
  });
  recarregarPaineisDist();
}
['toggleConsiderarFatura', 'toggleConsiderarFaturaHE'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => aplicarConsiderarFatura(el.checked));
});
// Alvo (meses) — sincronizado entre as duas abas.
['alvoDistReposicao', 'alvoDistReposicaoHE'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => {
    alvoDist = el.value.trim();
    ['alvoDistReposicao', 'alvoDistReposicaoHE'].forEach((x) => { const e = document.getElementById(x); if (e) e.value = alvoDist; });
    recarregarPaineisDist();
  });
});
// Faixa de autonomia — sincronizada entre as duas abas.
['faixaDistReposicao', 'faixaDistReposicaoHE'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => {
    faixaAutonomiaDist = el.value;
    ['faixaDistReposicao', 'faixaDistReposicaoHE'].forEach((x) => { const e = document.getElementById(x); if (e) e.value = faixaAutonomiaDist; });
    recarregarPaineisDist();
  });
});

// Painel Hospital Escola (Distribuição H.E) — padrão: todas as unidades marcadas.
const painelReposicaoHE = criarPainelReposicao({
  prefixo: 'ReposicaoHE',
  endpoint: '/distribuicao/reposicao-he',
  endpointUnidades: '/distribuicao/reposicao-he/unidades',
  classeChk: 'chk-unidade-rep-he',
  escolherPadrao: (unidades) => unidades.slice(),
});
function carregarTabelaReposicaoHE() { return painelReposicaoHE.carregar(); }

document.getElementById('botaoExportarGrade').addEventListener('click', baixarGradeXlsx);
document.getElementById('botaoExportarGradeFinal').addEventListener('click', baixarGradeXlsx);
const btnExpHE = document.getElementById('botaoExportarGradeHE');
if (btnExpHE) btnExpHE.addEventListener('click', baixarGradeXlsx);

// -------------------- Grade Final --------------------
// Cópia editável da grade validada (o Rafael ajusta qtde/remove e depois Salva).
let gradeFinalItens = [];

async function carregarGradeFinal() {
  try {
    const { itens } = await api('/distribuicao/grade');
    gradeFinalItens = (itens || []).map((g) => ({
      cod_local: g.cod_local, local_entrega: g.local_entrega, cod_item: g.cod_item,
      medicamento: g.medicamento, qtde: g.qtde, validade: g.validade, codigo_scodes: g.codigo_scodes,
      origem: g.origem || 'calculada',
    }));
  } catch (e) { gradeFinalItens = []; }
  renderizarGradeFinal();
}

function renderizarGradeFinal() {
  const q = normalizarBusca(document.getElementById('filtroBuscaGradeFinal').value);
  const corpo = document.getElementById('corpoTabelaGradeFinal');
  const vazio = document.getElementById('estadoVazioGradeFinal');
  const info = document.getElementById('infoGradeFinal');

  let itens = gradeFinalItens;
  if (q) itens = itens.filter((it) => normalizarBusca(it.medicamento).includes(q)
    || normalizarBusca(it.codigo_scodes).includes(q)
    || normalizarBusca(it.cod_item).includes(q)
    || normalizarBusca(it.local_entrega).includes(q));

  const totalQtde = gradeFinalItens.reduce((s, it) => s + (Number(it.qtde) || 0), 0);
  info.textContent = `${gradeFinalItens.length} item(ns) na grade · ${fmtNumero(totalQtde)} unidade(s)`;

  if (itens.length === 0) {
    corpo.innerHTML = '';
    vazio.hidden = false;
    vazio.textContent = gradeFinalItens.length === 0
      ? 'Nenhum item na grade. Valide itens na aba Sugestão de Reposição.'
      : 'Nenhum item encontrado com esta busca.';
    return;
  }
  vazio.hidden = true;

  corpo.innerHTML = itens.map((it) => {
    const chave = chaveGrade(it.local_entrega, it.codigo_scodes);
    return `
      <tr data-chave="${escAttr(chave)}">
        <td>${it.cod_local || '—'}</td>
        <td>${it.local_entrega || '—'}</td>
        <td class="col-codigo">${it.cod_item || '—'}</td>
        <td>${it.medicamento || '—'}</td>
        <td><input type="number" min="0" step="1" value="${escAttr(it.qtde)}" class="input-qtde-grade" data-chave="${escAttr(chave)}" style="width:90px;"></td>
        <td>${it.validade || '—'}</td>
        <td class="col-codigo">${it.codigo_scodes || '—'}</td>
        <td><span class="tag-origem ${it.origem === 'manual' ? 'manual' : 'calculada'}">${it.origem === 'manual' ? 'Manual' : 'Calculada'}</span></td>
        <td><button class="btn-grade btn-negar btn-remover-grade" data-chave="${escAttr(chave)}">Remover</button></td>
      </tr>`;
  }).join('');
}

// Editar quantidade de uma linha (guarda no array local; só grava ao Salvar).
document.getElementById('corpoTabelaGradeFinal').addEventListener('change', (ev) => {
  const inp = ev.target;
  if (!inp.classList || !inp.classList.contains('input-qtde-grade')) return;
  const item = gradeFinalItens.find((it) => chaveGrade(it.local_entrega, it.codigo_scodes) === inp.dataset.chave);
  if (item) {
    let v = parseInt(String(inp.value).replace(/[^\d]/g, ''), 10);
    item.qtde = Number.isFinite(v) && v >= 0 ? v : 0;
  }
  renderizarGradeFinal();
});

// Remover uma linha da grade (só do array local; grava ao Salvar).
document.getElementById('corpoTabelaGradeFinal').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.btn-remover-grade');
  if (!btn) return;
  gradeFinalItens = gradeFinalItens.filter((it) => chaveGrade(it.local_entrega, it.codigo_scodes) !== btn.dataset.chave);
  renderizarGradeFinal();
});

document.getElementById('filtroBuscaGradeFinal').addEventListener('input', renderizarGradeFinal);

// Salvar grade: substitui tudo no banco pelo conjunto atual da tela.
document.getElementById('botaoSalvarGrade').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    const r = await api('/distribuicao/grade/salvar', {
      method: 'POST', body: JSON.stringify({ itens: gradeFinalItens }),
    });
    // Reflete o novo estado na aba Reposição (botões e contador).
    gradeValidadas = new Set(gradeFinalItens.map((it) => chaveGrade(it.local_entrega, it.codigo_scodes)));
    const cont = document.getElementById('contadorGrade');
    if (cont) cont.textContent = r.total;
    alert('Grade salva com sucesso (' + r.total + ' item(ns) no banco).');
  } catch (e) {
    alert('Erro ao salvar a grade: ' + e.message);
  } finally {
    btn.disabled = false;
  }
});

// Limpar grade: zera tudo no banco (com confirmação).
document.getElementById('botaoLimparGrade').addEventListener('click', async (ev) => {
  if (!confirm('Isso apaga TODOS os itens da grade validada, no banco. Deseja continuar?')) return;
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    const r = await api('/distribuicao/grade/limpar', { method: 'POST', body: JSON.stringify({}) });
    gradeFinalItens = [];
    gradeValidadas = new Set();
    const cont = document.getElementById('contadorGrade');
    if (cont) cont.textContent = r.total;
    renderizarGradeFinal();
  } catch (e) {
    alert('Erro ao limpar a grade: ' + e.message);
  } finally {
    btn.disabled = false;
  }
});

async function carregarSolicitacoesOD() {
  carregarUltimaAtualizacao('atualizadoSolicitacoesOD', 'solicitacoes_od');
  const { porStatus } = await api('/solicitacoes-od/resumo');
  const ABERTO_OD = ['Planejamento', 'Adjudicado', 'Empenhado', 'Entrega Parcial', 'Em andamento'];
  const contOD = (nome) => (porStatus.find((l) => l.status === nome) || {}).qtde || 0;
  const totalOD = porStatus.reduce((s, l) => s + l.qtde, 0);
  const andamentoOD = porStatus.filter((l) => ABERTO_OD.includes(l.status)).reduce((s, l) => s + l.qtde, 0);
  const finalOD = contOD('Finalizado');
  const pctOD = totalOD ? Math.round((finalOD / totalOD) * 100) : 0;
  const nOD = (v) => v.toLocaleString('pt-BR');
  document.getElementById('grideResumoSolicitacoesOD').innerHTML =
    kpiCard('doc', nOD(totalOD), 'Total de solicitações', 'todos os meses') +
    kpiCard('chart', nOD(andamentoOD), 'Em andamento', 'Planejamento · Adjudicado · Empenhado · Entrega Parcial', 'aviso') +
    kpiCard('check', nOD(finalOD), 'Finalizadas', `${pctOD}% do total`) +
    kpiCard('relogio', nOD(contOD('Entrega Parcial')), 'Entrega parcial', 'aguardando saldo');

  if (!estadoSolicitacoesOD.filtrosCarregados) {
    const selStatus = document.getElementById('filtroStatusSolicitacoesOD');
    selStatus.innerHTML = '<option value="">Status: todos</option>' +
      porStatus.filter((l) => l.status && l.status !== 'Em andamento')
        .map((l) => `<option value="${l.status}">${l.status}</option>`).join('');

    const selAno = document.getElementById('filtroAnoSolicitacoesOD');
    const anoAtual = new Date().getFullYear();
    for (let a = anoAtual + 1; a >= 2025; a--) {
      const opt = document.createElement('option');
      opt.value = a; opt.textContent = a;
      selAno.appendChild(opt);
    }

    const selMes = document.getElementById('filtroMesSolicitacoesOD');
    ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro']
      .forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m; opt.textContent = m;
        selMes.appendChild(opt);
      });

    estadoSolicitacoesOD.filtrosCarregados = true;
  }

  await carregarTabelaSolicitacoesOD();
}

async function carregarTabelaSolicitacoesOD() {
  const q = document.getElementById('filtroBuscaSolicitacoesOD').value.trim();
  const status = document.getElementById('filtroStatusSolicitacoesOD').value;
  const ano = document.getElementById('filtroAnoSolicitacoesOD').value;
  const mes = document.getElementById('filtroMesSolicitacoesOD').value;

  const params = new URLSearchParams({ page: estadoSolicitacoesOD.pagina, pageSize: estadoSolicitacoesOD.pageSize });
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  if (ano) params.set('ano', ano);
  if (mes) params.set('mes', mes);

  const dados = await api(`/solicitacoes-od?${params.toString()}`);
  const corpo = document.getElementById('corpoTabelaSolicitacoesOD');
  const vazio = document.getElementById('estadoVazioSolicitacoesOD');

  if (dados.solicitacoes.length === 0) {
    corpo.innerHTML = ''; vazio.hidden = false;
  } else {
    vazio.hidden = true;
    corpo.innerHTML = dados.solicitacoes.map((s) => `
      <tr>
        <td class="col-codigo">${s.codigo_item || '—'}</td>
        <td>${s.descricao || '—'}</td>
        <td class="col-codigo">${s.codigo_siafisico || '—'}</td>
        <td class="col-codigo">${s.codigo_gsnet || '—'}</td>
        <td>${s.ano || '—'}</td>
        <td>${s.mes || '—'}</td>
        <td>${s.tipo ? `<span class="tag-tipo">${s.tipo}</span>` : '—'}</td>
        <td>${s.modalidade_compra || '—'}</td>
        <td class="col-codigo">${s.n_oficio || '—'}</td>
        <td>${valorCelula(s.qtde_solicitada)}</td>
        <td class="col-codigo">${fmtGsnet(s.requisicao_gsnet) || '—'}</td>
        <td class="col-codigo">${s.n_empenho || '—'}</td>
        <td class="col-data">${formatarData(s.data_previsao_entrega)}</td>
        <td class="col-data">${formatarData(s.data_entrega)}</td>
        <td>${valorCelula(s.qtde_entregue)}</td>
        <td>${valorCelula(s.qtde_pendente)}</td>
        <td>${s.status || '—'}</td>
        <td>${s.observacao || '—'}</td>
      </tr>
    `).join('');
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoSolicitacoesOD').textContent = `Página ${dados.page} de ${totalPaginas} · ${dados.total} resultados`;
  document.getElementById('botaoAnteriorSolicitacoesOD').disabled = dados.page <= 1;
  document.getElementById('botaoProximoSolicitacoesOD').disabled = dados.page >= totalPaginas;
}

// ==================== Aquisição em Andamento OD ====================
// Visão filtrada do Relatório de Compras OD: só status em aberto
// (Planejamento, Adjudicado, Empenhado, Entrega Parcial). Dados vêm do mesmo
// vigia automático de solicitacoes_od — não tem importação própria.
const estadoAquisicaoODAndamento = { pagina: 1, pageSize: 50, filtrosCarregados: false };

document.getElementById('filtroBuscaAquisicaoODAndamento').addEventListener('input', () => {
  clearTimeout(window.__debounceBuscaAquisicaoODAndamento);
  window.__debounceBuscaAquisicaoODAndamento = setTimeout(() => { estadoAquisicaoODAndamento.pagina = 1; carregarTabelaAquisicaoODAndamento(); }, 350);
});
document.getElementById('filtroAnoAquisicaoODAndamento').addEventListener('change', () => { estadoAquisicaoODAndamento.pagina = 1; carregarTabelaAquisicaoODAndamento(); });
document.getElementById('filtroMesAquisicaoODAndamento').addEventListener('change', () => { estadoAquisicaoODAndamento.pagina = 1; carregarTabelaAquisicaoODAndamento(); });
document.getElementById('botaoLimparFiltrosAquisicaoODAndamento').addEventListener('click', () => {
  document.getElementById('filtroBuscaAquisicaoODAndamento').value = '';
  document.getElementById('filtroAnoAquisicaoODAndamento').value = '';
  document.getElementById('filtroMesAquisicaoODAndamento').value = '';
  estadoAquisicaoODAndamento.pagina = 1;
  carregarTabelaAquisicaoODAndamento();
});
document.getElementById('botaoAnteriorAquisicaoODAndamento').addEventListener('click', () => {
  if (estadoAquisicaoODAndamento.pagina > 1) { estadoAquisicaoODAndamento.pagina--; carregarTabelaAquisicaoODAndamento(); }
});
document.getElementById('botaoProximoAquisicaoODAndamento').addEventListener('click', () => {
  estadoAquisicaoODAndamento.pagina++; carregarTabelaAquisicaoODAndamento();
});

async function carregarAquisicaoODAndamento() {
  carregarUltimaAtualizacao('atualizadoAquisicaoODAndamento', 'solicitacoes_od');
  const { porStatus } = await api('/solicitacoes-od/resumo?emAberto=true');
  const contAnd = (nome) => (porStatus.find((l) => l.status === nome) || {}).qtde || 0;
  const totalAnd = porStatus.reduce((s, l) => s + l.qtde, 0);
  const nAnd = (v) => v.toLocaleString('pt-BR');
  document.getElementById('grideResumoAquisicaoODAndamento').innerHTML =
    kpiCard('chart', nAnd(totalAnd), 'Total em andamento', 'compras não finalizadas', 'aviso') +
    kpiCard('doc', nAnd(contAnd('Empenhado')), 'Empenhadas', 'com empenho emitido') +
    kpiCard('relogio', nAnd(contAnd('Entrega Parcial')), 'Entrega parcial', 'aguardando saldo') +
    kpiCard('list', nAnd(contAnd('Planejamento')), 'Planejamento', 'ainda sem empenho');

  if (!estadoAquisicaoODAndamento.filtrosCarregados) {
    const selAno = document.getElementById('filtroAnoAquisicaoODAndamento');
    const anoAtual = new Date().getFullYear();
    for (let a = anoAtual + 1; a >= 2025; a--) {
      const opt = document.createElement('option');
      opt.value = a; opt.textContent = a;
      selAno.appendChild(opt);
    }
    const selMes = document.getElementById('filtroMesAquisicaoODAndamento');
    ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro']
      .forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m; opt.textContent = m;
        selMes.appendChild(opt);
      });
    estadoAquisicaoODAndamento.filtrosCarregados = true;
  }

  await carregarTabelaAquisicaoODAndamento();
}

async function carregarTabelaAquisicaoODAndamento() {
  const q = document.getElementById('filtroBuscaAquisicaoODAndamento').value.trim();
  const ano = document.getElementById('filtroAnoAquisicaoODAndamento').value;
  const mes = document.getElementById('filtroMesAquisicaoODAndamento').value;

  const params = new URLSearchParams({ emAberto: 'true', page: estadoAquisicaoODAndamento.pagina, pageSize: estadoAquisicaoODAndamento.pageSize });
  if (q) params.set('q', q);
  if (ano) params.set('ano', ano);
  if (mes) params.set('mes', mes);

  const dados = await api(`/solicitacoes-od?${params.toString()}`);
  const corpo = document.getElementById('corpoTabelaAquisicaoODAndamento');
  const vazio = document.getElementById('estadoVazioAquisicaoODAndamento');

  if (dados.solicitacoes.length === 0) {
    corpo.innerHTML = ''; vazio.hidden = false;
  } else {
    vazio.hidden = true;
    corpo.innerHTML = dados.solicitacoes.map((s) => `
      <tr>
        <td class="col-codigo">${s.codigo_item || '—'}</td>
        <td>${s.descricao || '—'}</td>
        <td class="col-codigo">${s.codigo_siafisico || '—'}</td>
        <td class="col-codigo">${s.codigo_gsnet || '—'}</td>
        <td>${s.ano || '—'}</td>
        <td>${s.mes || '—'}</td>
        <td>${s.tipo ? `<span class="tag-tipo">${s.tipo}</span>` : '—'}</td>
        <td>${s.modalidade_compra || '—'}</td>
        <td class="col-codigo">${s.n_oficio || '—'}</td>
        <td>${valorCelula(s.qtde_solicitada)}</td>
        <td class="col-codigo">${fmtGsnet(s.requisicao_gsnet) || '—'}</td>
        <td class="col-codigo">${s.n_empenho || '—'}</td>
        <td class="col-data">${formatarData(s.data_previsao_entrega)}</td>
        <td>${valorCelula(s.qtde_pendente)}</td>
        <td>${s.status || '—'}</td>
        <td>${s.observacao || '—'}</td>
      </tr>
    `).join('');
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoAquisicaoODAndamento').textContent = `Página ${dados.page} de ${totalPaginas} · ${dados.total} resultados`;
  document.getElementById('botaoAnteriorAquisicaoODAndamento').disabled = dados.page <= 1;
  document.getElementById('botaoProximoAquisicaoODAndamento').disabled = dados.page >= totalPaginas;
}

// Card de demanda/consumo por programa (Judicial / Adm / JEFAZ) no modal.
function cardPrograma(titulo, cls, demanda, consumo, tooltip) {
  return `<div class="card-programa ${cls}">
    <span class="titp-programa"${tooltip ? ` title="${escAttr(tooltip)}"` : ''}>${titulo}</span>
    <div class="duo-programa">
      <div><div class="rot2p">Demanda</div><div class="n2p">${fmtNumero(demanda)}</div></div>
      <div><div class="rot2p">Consumo/mês</div><div class="n2p">${fmtNumero(consumo)}</div></div>
    </div>
  </div>`;
}

async function abrirDetalheEstoque(codigoEncoded, escopo = 'udtp', unidade = '') {
  const modal = document.getElementById('modalEstoqueItem');
  const conteudo = document.getElementById('conteudoModalEstoque');
  conteudo.innerHTML = '<p class="texto-apoio">Carregando…</p>';
  modal.hidden = false;

  let url = `/estoque/item/${codigoEncoded}?escopoUnidade=${escopo}`;
  if (unidade) url += `&unidade=${encodeURIComponent(unidade)}`;
  const dados = await api(url);
  const e = dados.estoqueAtual;

  document.getElementById('tituloModalEstoque').textContent = e ? (e.descricao || dados.codigo) : dados.codigo;
  document.getElementById('codigoModalEstoque').textContent = dados.codigo + (unidade ? ' · ' + unidade : '');

  // Montagem no mesmo formato do modal de Reservas: KPIs no topo, depois as
  // duas tabelas ESTREITAS lado a lado (lotes | evolução) e, por fim, as
  // tabelas LARGAS em largura total. Evita a rolagem vertical enorme que a
  // versão empilhada gerava.
  let html = '';

  if (e) {
    html += `
      <div class="grade-resumo" style="grid-template-columns: repeat(4, 1fr); margin-bottom:12px;">
        ${kpiCard('chart', fmtNumero(e.estoque), 'Estoque', 'saldo atual')}
        ${kpiCard('relogio', fmtNumero(e.autonomia), 'Autonomia', 'meses de cobertura')}
        ${kpiCard('list', fmtNumero(e.demandas), 'Demandas', 'pacientes com demanda')}
        ${kpiCard('doc', fmtNumero(e.consumo_mensal_total), 'Consumo/mês', 'média mensal')}
      </div>
      <div class="grade-programas">
        ${cardPrograma('Judicial', 'jud', e.demandas_aj, e.consumo_mensal_aj)}
        ${cardPrograma('Adm', 'adm', e.demandas_cf, e.consumo_mensal_cf, 'Comissão de Farmacologia')}
        ${cardPrograma('JEFAZ', 'jef', e.demandas_jefaz, e.consumo_mensal_jefaz)}
      </div>
    `;
  } else {
    html += '<p class="texto-apoio">Este item não consta no relatório de estoque mais recente.</p>';
  }

  // ----- coluna 1: lotes e validades -----
  let colLotes = '';
  if (e) {
    const lotes = parsearLotes(e.lotes);
    colLotes += `<h4>Lotes e validades ${lotes.length ? `<span class="texto-apoio">(${lotes.length})</span>` : ''}</h4>`;
    if (lotes.length === 0) {
      colLotes += '<p class="texto-apoio">Sem informação de lote para este item no relatório.</p>';
    } else {
      colLotes += `<table><thead><tr><th>Lote</th><th>Validade</th><th>Quantidade</th><th>Fabricante</th></tr></thead><tbody>`;
      colLotes += lotes.map((l) => {
        const cls = classeValidade(l.validade);
        const tag = cls === 'vencido'
          ? `<span class="etiqueta-status cancelado">${l.validade} · vencido</span>`
          : cls === 'proximo'
            ? `<span class="etiqueta-status atrasado">${l.validade} · vence em breve</span>`
            : (l.validade || '—');
        return `<tr>
          <td class="col-codigo">${l.lote}</td>
          <td class="col-data">${tag}</td>
          <td>${l.qtde ? fmtNumero(Number(String(l.qtde).replace(/\./g, '').replace(',', '.'))) : '—'}</td>
          <td class="texto-apoio">${l.fabricante}</td>
        </tr>`;
      }).join('');
      colLotes += '</tbody></table>';
    }
  }

  // Lotes e validades em largura total (a "Evolução do estoque" foi retirada
  // deste modal por não ser necessária aqui).
  if (colLotes) {
    html += colLotes;
  }

  // ----- largura total: compras (OD no geral, judicial no TP) -----
  const ehOD = dados.fonteCompras === 'od';
  html += `<h4>${ehOD ? 'Aquisição em Andamento OD' : 'Compras no controle judicial'}</h4>`;
  if (dados.compras.length === 0) {
    html += `<p class="texto-apoio">Nenhuma compra registrada para este item ${ehOD ? 'na Aquisição em Andamento OD' : 'no controle judicial'}.</p>`;
  } else {
    if (dados.temCompraAberta) {
      html += '<p class="aviso-compra-aberta">✓ Este item tem compra em aberto (em andamento).</p>';
    }
    html += `<div class="rolagem-tabela"><table><thead><tr><th>Período</th><th>Modalidade</th><th>Qtd. solicitada</th><th>Qtd. pendente</th><th>Empenho</th><th>Previsão</th><th>Status</th></tr></thead><tbody>`;
    html += dados.compras.map((c) => {
      const classe = classeStatus(c.status, c.data_previsao_entrega);
      const rotulo = rotuloStatus(c.status, c.data_previsao_entrega);
      // Qtd. pendente: destaca quando é Entrega Parcial (o que falta receber).
      const pend = c.qtde_pendente;
      const celPend = (c.status === 'Entrega Parcial' && pend != null && String(pend).trim() !== '')
        ? `<strong class="etiqueta-status atrasado" style="padding:1px 7px;">${valorCelula(pend)}</strong>`
        : (pend != null && Number(pend) > 0 ? valorCelula(pend) : '—');
      return `<tr>
        <td>${c.mes}/${c.ano}</td>
        <td>${c.modalidade_compra || '—'}</td>
        <td>${valorCelula(c.qtde_solicitada)}</td>
        <td>${celPend}</td>
        <td>${c.n_empenho || '—'}</td>
        <td class="col-data">${formatarData(c.data_previsao_entrega)}</td>
        <td><span class="etiqueta-status ${classe}">${rotulo}</span></td>
      </tr>`;
    }).join('');
    html += '</tbody></table></div>';
  }

  // ----- largura total: pacientes -----
  const nomeUnidadePac = dados.unidade || 'Tenente Pena';
  html += `<h4>Pacientes <span class="texto-apoio">— ${nomeUnidadePac}</span> ${dados.pacientes && dados.pacientes.length ? `<span class="texto-apoio">(${dados.pacientes.length})</span>` : ''}</h4>`;
  if (!dados.pacientes || dados.pacientes.length === 0) {
    html += `<p class="texto-apoio">Nenhum paciente cadastrado com este item ${dados.unidade ? 'na ' + nomeUnidadePac : 'na Tenente Pena'}.</p>`;
  } else {
    html += `<div class="rolagem-tabela"><table><thead><tr><th>Nome</th><th>Protocolo</th><th>Tipo de Demanda</th><th>Qtde. Consumo</th><th>Prazo</th><th>Periodicidade</th><th>Data de retirada</th><th>Próx. data de retorno</th></tr></thead><tbody>`;
    html += dados.pacientes.map((p) => `
      <tr>
        <td>${p.autor || '—'}</td>
        <td>${p.protocolo || '—'}</td>
        <td>${tagTipoDemanda(p.tipo_demanda)}</td>
        <td>${p.qtde_consumo || '—'}</td>
        <td>${p.prazo || '—'}</td>
        <td>${p.periodicidade || '—'}</td>
        <td class="col-data">${p.data_ultima_dispensacao || '—'}</td>
        <td class="col-data">${p.data_ultimo_retorno || '—'}</td>
      </tr>
    `).join('');
    html += '</tbody></table></div>';
  }

  // Placeholders dos blocos de estoque IBL (Outras Demandas e Importados) —
  // carregados após render. Cada um só aparece se o item existir no respectivo
  // local do IBL.
  html += '<div id="blocoIblOD" style="margin-top:6px;"></div>';
  html += '<div id="blocoIblImportado" style="margin-top:6px;"></div>';

  conteudo.innerHTML = html;
  injetarSaldoIblOD(dados.codigo, 'blocoIblOD');
  injetarSaldoIblImportado(dados.codigo, 'blocoIblImportado');
}

// -------------------- Gestão de validades --------------------
let debounceBuscaValidades;
document.getElementById('filtroBuscaValidades').addEventListener('input', () => {
  clearTimeout(debounceBuscaValidades);
  debounceBuscaValidades = setTimeout(carregarValidades, 350);
});
document.getElementById('seletorDataValidades').addEventListener('change', (ev) => {
  estado.validades.data = ev.target.value;
  carregarValidades();
});
document.querySelectorAll('#filtrosFaixaValidades .chip-faixa').forEach((btn) => {
  btn.addEventListener('click', () => {
    estado.validades.janela = btn.dataset.janela;
    sincronizarChipsFaixa();
    carregarValidades();
  });
});

// Mantém os chips de faixa coerentes com o estado atual (mudado por chip ou card)
function sincronizarChipsFaixa() {
  document.querySelectorAll('#filtrosFaixaValidades .chip-faixa')
    .forEach((b) => b.classList.toggle('ativo', (b.dataset.janela || '') === estado.validades.janela));
}

document.getElementById('botaoLimparFiltrosValidades').addEventListener('click', () => {
  document.getElementById('filtroBuscaValidades').value = '';
  estado.validades.janela = '';
  sincronizarChipsFaixa();
  carregarValidades();
});

document.getElementById('botaoExportarValidades').addEventListener('click', exportarValidadesCSV);

// Exporta os lotes da gestão de validades (respeitando os filtros atuais) para CSV.
// Usa ponto-e-vírgula e BOM UTF-8 para abrir certinho no Excel em português.
async function exportarValidadesCSV() {
  const params = new URLSearchParams();
  if (estado.validades.data) params.set('data', estado.validades.data);
  const q = document.getElementById('filtroBuscaValidades').value.trim();
  if (q) params.set('q', q);
  if (estado.validades.janela) params.set('janela', estado.validades.janela);

  const dados = await api(`/estoque/validades?${params.toString()}`);
  if (!dados.lotes || dados.lotes.length === 0) {
    alert('Não há lotes para exportar com os filtros atuais.');
    return;
  }

  const csvCampo = (v) => {
    const t = (v === null || v === undefined) ? '' : String(v);
    return `"${t.replace(/"/g, '""')}"`; // protege aspas, ponto-e-vírgula e quebras
  };

  const cabecalho = ['Medicamento', 'Código do item', 'Lote', 'Validade', 'Dias para vencer',
    'Quantidade', 'Valor unitário', 'Valor total', 'Fornecedor', 'Categoria', 'Marca'];

  const linhas = dados.lotes.map((l) => [
    l.descricao, l.codigo_item, l.lote, l.validade, l.dias_para_vencer,
    l.qtde, l.valor_unit, l.valor_total, l.fabricante, l.categoria, l.marca,
  ].map(csvCampo).join(';'));

  const csv = '﻿' + [cabecalho.map(csvCampo).join(';'), ...linhas].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `validades_${dados.dataReferencia || 'estoque'}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function corFaixaValidade(faixa) {
  if (faixa === 'vencido') return 'cancelado';   // vermelho
  if (faixa === 'd30') return 'atrasado';         // âmbar (urgente)
  if (faixa === 'd60') return 'planejamento';     // azul
  if (faixa === 'd90') return 'andamento';        // cinza
  return 'finalizado';                            // verde (folgado)
}

async function carregarValidades() {
  const params = new URLSearchParams();
  if (estado.validades.data) params.set('data', estado.validades.data);
  const q = document.getElementById('filtroBuscaValidades').value.trim();
  if (q) params.set('q', q);
  if (estado.validades.janela) params.set('janela', estado.validades.janela);

  const dados = await api(`/estoque/validades?${params.toString()}`);

  if (!dados.dataReferencia) {
    document.getElementById('avisoSemValidades').hidden = false;
    document.getElementById('conteudoValidades').hidden = true;
    return;
  }
  document.getElementById('avisoSemValidades').hidden = true;
  document.getElementById('conteudoValidades').hidden = false;

  // Seletor de datas
  const seletor = document.getElementById('seletorDataValidades');
  seletor.innerHTML = dados.datasDisponiveis.map((d) =>
    `<option value="${d.data_referencia}">${formatarData(d.data_referencia)} (${d.total_itens} itens)</option>`
  ).join('');
  if (!estado.validades.data) estado.validades.data = dados.dataReferencia;
  seletor.value = estado.validades.data;

  document.getElementById('subtituloValidades').textContent =
    `Lotes e validades do estoque em ${formatarData(dados.dataReferencia)}${horaImportacao(dados.dataImportacao)}`;

  // KPIs (cards clicáveis: clicar filtra a tabela pela faixa)
  const r = dados.resumo;
  const reais = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  const kpi = document.getElementById('grideKpiValidades');
  const jat = estado.validades.janela;
  const cartao = (faixa, rotulo, classeExtra = '') => `
    <div class="cartao-resumo cartao-clicavel ${classeExtra} ${jat === faixa ? 'selecionado' : ''}" data-janela="${faixa}">
      <div class="numero">${fmtNumero(r[faixa].qtdeLotes)}</div>
      <div class="rotulo">${rotulo}<br><span style="font-size:11px;">${reais(r[faixa].valor)}</span></div>
    </div>`;
  kpi.innerHTML =
    cartao('vencido', 'Lotes vencidos', 'alerta') +
    cartao('d30', 'Vencem em até 30 dias') +
    cartao('d60', '31 a 60 dias') +
    cartao('d90', '61 a 90 dias') +
    cartao('mais90', 'Mais de 90 dias');

  kpi.querySelectorAll('.cartao-clicavel').forEach((c) => {
    c.addEventListener('click', () => {
      // clicar de novo no card já ativo remove o filtro
      estado.validades.janela = (estado.validades.janela === c.dataset.janela) ? '' : c.dataset.janela;
      sincronizarChipsFaixa();
      carregarValidades();
    });
  });

  // Tabela
  const corpo = document.getElementById('corpoTabelaValidades');
  const vazio = document.getElementById('estadoVazioValidades');
  if (dados.lotes.length === 0) {
    corpo.innerHTML = '';
    vazio.hidden = false;
  } else {
    vazio.hidden = true;
    corpo.innerHTML = dados.lotes.map((l) => {
      const cls = corFaixaValidade(l.faixa);
      const diasTxt = l.dias_para_vencer < 0
        ? `vencido há ${Math.abs(l.dias_para_vencer)} dia(s)`
        : `${l.dias_para_vencer} dia(s)`;
      return `
        <tr class="linha-clicavel" data-codigo="${(l.codigo_item || '').replace(/"/g, '&quot;')}" title="Clique para ver só este medicamento">
          <td>${l.descricao || '—'}<br><span class="col-codigo">${l.codigo_item}</span></td>
          <td class="col-codigo">${l.lote || '—'}</td>
          <td class="col-data"><span class="etiqueta-status ${cls}">${l.validade}</span></td>
          <td>${diasTxt}</td>
          <td>${fmtNumero(l.qtde)}</td>
          <td>${reais(l.valor_total)}</td>
          <td style="font-size:12px; color:var(--cinza-texto);">${l.categoria || '—'}</td>
        </tr>
      `;
    }).join('');

    // Clicar numa linha abre o detalhe do medicamento (lotes e validades)
    corpo.querySelectorAll('.linha-clicavel').forEach((tr) => {
      tr.addEventListener('click', () => abrirDetalheValidade(tr.dataset.codigo));
    });
  }

  document.getElementById('textoContagemValidades').textContent =
    `${dados.lotes.length} lote(s) exibido(s) · ${fmtNumero(r.totalLotes)} no total · valor total ${reais(r.valorTotal)}`;
}

document.getElementById('botaoFecharModalValidade').addEventListener('click', () => {
  document.getElementById('modalValidadeItem').hidden = true;
});

// Abre o modal com os lotes e validades de um medicamento específico
async function abrirDetalheValidade(codigo) {
  const modal = document.getElementById('modalValidadeItem');
  const conteudo = document.getElementById('conteudoModalValidade');
  conteudo.innerHTML = '<p class="texto-apoio">Carregando…</p>';
  document.getElementById('tituloModalValidade').textContent = 'Detalhe do item';
  document.getElementById('codigoModalValidade').textContent = codigo;
  modal.hidden = false;

  const params = new URLSearchParams();
  if (estado.validades.data) params.set('data', estado.validades.data);
  params.set('q', codigo); // traz todos os lotes deste item (sem filtro de faixa)
  const dados = await api(`/estoque/validades?${params.toString()}`);

  // Pega só os lotes exatamente deste código
  const lotes = dados.lotes.filter((l) => l.codigo_item === codigo);
  const reais = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 });

  if (lotes.length === 0) {
    conteudo.innerHTML = '<p class="texto-apoio">Sem lotes com validade para este item.</p>';
    return;
  }

  const it = lotes[0];
  document.getElementById('tituloModalValidade').textContent = it.descricao || codigo;

  // Resumo do item
  const totalQtde = lotes.reduce((s, l) => s + (l.qtde || 0), 0);
  const totalValor = lotes.reduce((s, l) => s + (l.valor_total || 0), 0);
  let html = `
    <div class="grade-resumo" style="grid-template-columns: repeat(3, 1fr); margin-bottom:18px;">
      <div class="cartao-resumo"><div class="numero" style="font-size:20px;">${fmtNumero(lotes.length)}</div><div class="rotulo">Lotes</div></div>
      <div class="cartao-resumo"><div class="numero" style="font-size:20px;">${fmtNumero(totalQtde)}</div><div class="rotulo">Quantidade total</div></div>
      <div class="cartao-resumo"><div class="numero" style="font-size:18px;">${reais(totalValor)}</div><div class="rotulo">Valor total</div></div>
    </div>
    <p style="font-size:12.5px; color:var(--cinza-texto); margin:0 0 12px;">Categoria: <strong>${it.categoria || '—'}</strong>${it.marca ? ' · Marca: <strong>' + it.marca + '</strong>' : ''}</p>
  `;

  html += `<table><thead><tr>
    <th>Lote</th><th>Validade</th><th>Dias p/ vencer</th><th>Quantidade</th><th>Valor</th><th>Fornecedor</th>
  </tr></thead><tbody>`;
  html += lotes.map((l) => {
    const cls = corFaixaValidade(l.faixa);
    const diasTxt = l.dias_para_vencer < 0
      ? `vencido há ${Math.abs(l.dias_para_vencer)} dia(s)`
      : `${l.dias_para_vencer} dia(s)`;
    return `<tr>
      <td class="col-codigo">${l.lote || '—'}</td>
      <td class="col-data"><span class="etiqueta-status ${cls}">${l.validade}</span></td>
      <td>${diasTxt}</td>
      <td>${fmtNumero(l.qtde)}</td>
      <td>${reais(l.valor_total)}</td>
      <td style="font-size:11.5px; color:var(--cinza-texto);">${l.fabricante || '—'}</td>
    </tr>`;
  }).join('');
  html += '</tbody></table>';

  conteudo.innerHTML = html;
}

// -------------------- Histórico Estoque (snapshots 01/15 + comparação) --------------------
function formatarRef(iso) {
  // referência sempre vem como yyyy-mm-dd
  return formatarData(iso);
}

// Mini-gráfico de linha (sparkline) do valor total por snapshot, em SVG puro.
function sparklineValorHist(serie, reais) {
  if (!serie || serie.length === 0) return '<p class="texto-apoio">Sem dados.</p>';
  if (serie.length === 1) {
    return `<p class="texto-apoio">Só há 1 snapshot (${formatarRef(serie[0].referencia_historica)} — ${reais(serie[0].valor_total)}). O gráfico ganha forma conforme novos snapshots forem guardados.</p>`;
  }
  const W = 720, H = 130, mL = 8, mR = 8, mT = 12, mB = 24;
  const vals = serie.map((s) => Number(s.valor_total) || 0);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i) => mL + (i * (W - mL - mR)) / (serie.length - 1);
  const y = (v) => mT + (1 - (v - min) / span) * (H - mT - mB);
  const pts = serie.map((s, i) => `${x(i).toFixed(1)},${y(vals[i]).toFixed(1)}`).join(' ');
  const area = `${mL},${(H - mB).toFixed(1)} ${pts} ${(W - mR)},${(H - mB).toFixed(1)}`;
  const pontos = serie.map((s, i) => {
    const rot = formatarRef(s.referencia_historica);
    return `<circle cx="${x(i).toFixed(1)}" cy="${y(vals[i]).toFixed(1)}" r="3.5" fill="#1f5c52"><title>${rot}: ${reais(s.valor_total)}</title></circle>`;
  }).join('');
  // rótulos: primeiro, último e o de maior valor
  const idxMax = vals.indexOf(max);
  const rotulos = [0, serie.length - 1, idxMax].filter((v, i, a) => a.indexOf(v) === i).map((i) => {
    const anchor = i === 0 ? 'start' : i === serie.length - 1 ? 'end' : 'middle';
    return `<text x="${x(i).toFixed(1)}" y="${(H - 8).toFixed(1)}" text-anchor="${anchor}" font-size="10" fill="var(--cinza-texto)">${formatarRef(serie[i].referencia_historica)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:100%" role="img" aria-label="Evolução do valor em estoque">
    <polygon points="${area}" fill="#1f5c52" opacity="0.08"></polygon>
    <polyline points="${pts}" fill="none" stroke="#1f5c52" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></polyline>
    ${pontos}${rotulos}
  </svg>`;
}

async function carregarHistorico() {
  const { snapshots } = await api('/estoque/historico');

  const aviso = document.getElementById('avisoSemHistorico');
  const conteudo = document.getElementById('conteudoHistorico');
  if (!snapshots || snapshots.length === 0) {
    aviso.hidden = false;
    conteudo.hidden = true;
    return;
  }
  aviso.hidden = true;
  conteudo.hidden = false;

  // Tabela de snapshots
  const reais = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });

  // ----- KPIs + sparkline (padrão ERP) -----
  // snapshots vem em ordem DECRESCENTE (mais recente primeiro).
  const ultimo = snapshots[0];
  const anterior = snapshots[1];
  const nInt = (v) => Number(v || 0).toLocaleString('pt-BR');
  const deltaValor = anterior ? (ultimo.valor_total || 0) - (anterior.valor_total || 0) : 0;
  const pctValor = anterior && anterior.valor_total ? Math.round((deltaValor / anterior.valor_total) * 100) : 0;
  const deltaItens = anterior ? (ultimo.total_itens || 0) - (anterior.total_itens || 0) : 0;
  const sinal = (v) => (v > 0 ? '▲ ' : v < 0 ? '▼ ' : '') ;
  const subVar = anterior
    ? `${sinal(deltaValor)}${reais(Math.abs(deltaValor))} (${pctValor >= 0 ? '+' : ''}${pctValor}%) vs. ${formatarRef(anterior.referencia_historica)}`
    : 'sem período anterior';
  document.getElementById('kpisHistorico').innerHTML =
    kpiCard('relogio', nInt(snapshots.length), 'Snapshots guardados', 'fotos de estoque arquivadas') +
    kpiCard('chart', reais(ultimo.valor_total), 'Valor no último snapshot', formatarRef(ultimo.referencia_historica)) +
    kpiCard('chart', (deltaValor >= 0 ? '+' : '−') + reais(Math.abs(deltaValor)), 'Variação de valor', subVar, deltaValor < 0 ? 'aviso' : '') +
    kpiCard('list', nInt(ultimo.total_itens) + (anterior ? ` (${deltaItens >= 0 ? '+' : ''}${nInt(deltaItens)})` : ''), 'Itens no último snapshot', anterior ? `vs. ${formatarRef(anterior.referencia_historica)}` : '');

  // Sparkline do valor total (mais antigo → mais recente).
  const serie = snapshots.slice().reverse();
  document.getElementById('histSparkline').innerHTML = sparklineValorHist(serie, reais);
  document.getElementById('corpoTabelaHistorico').innerHTML = snapshots.map((s) => {
    const coletaDiferente = s.data_coleta !== s.referencia_historica;
    return `<tr>
      <td class="col-data">${formatarRef(s.referencia_historica)}</td>
      <td class="col-data">${formatarData(s.data_coleta)}${coletaDiferente ? ' <span style="color:var(--cinza-texto); font-size:11px;">(1º dia útil)</span>' : ''}</td>
      <td>${fmtNumero(s.total_itens)}</td>
      <td>${reais(s.valor_total)}</td>
    </tr>`;
  }).join('');

  // Popula os dois seletores de comparação
  const opcoes = snapshots.map((s) =>
    `<option value="${s.referencia_historica}">${formatarRef(s.referencia_historica)}</option>`
  ).join('');
  const r1 = document.getElementById('histRef1');
  const r2 = document.getElementById('histRef2');
  r1.innerHTML = opcoes;
  r2.innerHTML = opcoes;
  // por padrão compara os dois mais recentes
  if (snapshots.length >= 2) { r1.selectedIndex = 1; r2.selectedIndex = 0; }
}

document.getElementById('botaoCompararHist').addEventListener('click', compararHistorico);

async function compararHistorico() {
  const ref1 = document.getElementById('histRef1').value;
  const ref2 = document.getElementById('histRef2').value;
  const q = document.getElementById('histBusca').value.trim();
  if (!ref1 || !ref2) return;
  if (ref1 === ref2) { alert('Escolha duas referências diferentes para comparar.'); return; }

  const params = new URLSearchParams({ ref1, ref2 });
  if (q) params.set('q', q);
  const dados = await api(`/estoque/historico/comparar?${params.toString()}`);

  // Atualiza os títulos das colunas com as referências escolhidas
  document.getElementById('thEstoque1').textContent = `Estoque (${formatarRef(ref1)})`;
  document.getElementById('thEstoque2').textContent = `Estoque (${formatarRef(ref2)})`;
  document.getElementById('thValor1').textContent = `Valor (${formatarRef(ref1)})`;
  document.getElementById('thValor2').textContent = `Valor (${formatarRef(ref2)})`;

  const corpo = document.getElementById('corpoTabelaComparar');
  const vazio = document.getElementById('estadoVazioComparar');
  const reais = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  const sinal = (v) => (v > 0 ? '+' : '') + fmtNumero(v);
  const corVar = (v) => v > 0 ? 'var(--selo)' : (v < 0 ? 'var(--vermelho)' : 'var(--cinza-texto)');

  if (!dados.itens.length) {
    corpo.innerHTML = '';
    vazio.hidden = false;
  } else {
    vazio.hidden = true;
    corpo.innerHTML = dados.itens.slice(0, 1000).map((it) => `
      <tr>
        <td>${it.descricao || '—'}<br><span class="col-codigo">${it.codigo_item}</span></td>
        <td style="font-size:12px; color:var(--cinza-texto);">${it.categoria || '—'}</td>
        <td>${fmtNumero(it.estoque1)}</td>
        <td>${fmtNumero(it.estoque2)}</td>
        <td style="color:${corVar(it.variacao_estoque)};">${sinal(it.variacao_estoque)}</td>
        <td>${reais(it.valor1)}</td>
        <td>${reais(it.valor2)}</td>
        <td style="color:${corVar(it.variacao_valor)};">${(it.variacao_valor > 0 ? '+' : '') + reais(it.variacao_valor)}</td>
      </tr>
    `).join('');
  }

  document.getElementById('textoContagemComparar').textContent =
    `${dados.total} item(ns) comparados entre ${formatarRef(ref1)} (coleta ${formatarData(dados.dataColeta1)}) e ${formatarRef(ref2)} (coleta ${formatarData(dados.dataColeta2)})`;
}

// -------------------- Listagem de Autores --------------------
const estadoAutores = { pagina: 1, pageSize: 150, total: 0, filtrosCarregados: false };

let debounceBuscaAutores;
document.getElementById('filtroBuscaAutores').addEventListener('input', () => {
  clearTimeout(debounceBuscaAutores);
  debounceBuscaAutores = setTimeout(() => { estadoAutores.pagina = 1; carregarTabelaAutores(); }, 350);
});
['filtroUnidadeAutores', 'filtroStatusDemandaAutores', 'filtroStatusItemAutores', 'filtroCategoriaAutores'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => { estadoAutores.pagina = 1; carregarTabelaAutores(); });
});
document.getElementById('botaoLimparFiltrosAutores').addEventListener('click', () => {
  document.getElementById('filtroBuscaAutores').value = '';
  ['filtroUnidadeAutores', 'filtroStatusDemandaAutores', 'filtroStatusItemAutores', 'filtroCategoriaAutores']
    .forEach((id) => { document.getElementById(id).value = ''; });
  estadoAutores.pagina = 1; carregarTabelaAutores();
});
document.getElementById('botaoAnteriorAutores').addEventListener('click', () => {
  if (estadoAutores.pagina > 1) { estadoAutores.pagina--; carregarTabelaAutores(); }
});
document.getElementById('botaoProximoAutores').addEventListener('click', () => {
  estadoAutores.pagina++; carregarTabelaAutores();
});

async function carregarAutores() {
  if (!estadoAutores.filtrosCarregados) {
    try {
      const f = await api('/autores/filtros?escopoUnidade=udtp');
      const preencher = (id, valores, rotulo) => {
        const sel = document.getElementById(id);
        sel.innerHTML = `<option value="">${rotulo}</option>` +
          valores.map((v) => `<option value="${v.replace(/"/g, '&quot;')}">${v}</option>`).join('');
      };
      preencher('filtroUnidadeAutores', f.unidade, 'Unidade: todas');
      preencher('filtroStatusDemandaAutores', f.status_demanda, 'Status da demanda: todos');
      preencher('filtroStatusItemAutores', f.status_item, 'Status do item: todos');
      preencher('filtroCategoriaAutores', f.categoria, 'Categoria: todas');
      estadoAutores.filtrosCarregados = true;
    } catch (e) { /* segue sem filtros */ }
  }
  carregarTabelaAutores();
}

async function carregarTabelaAutores() {
  const params = new URLSearchParams({ page: estadoAutores.pagina, pageSize: estadoAutores.pageSize });
  params.set('escopoUnidade', 'udtp'); // principal: só a Tenente Pena
  const q = document.getElementById('filtroBuscaAutores').value.trim();
  if (q) params.set('q', q);
  const mapa = {
    unidade: 'filtroUnidadeAutores', status_demanda: 'filtroStatusDemandaAutores',
    status_item: 'filtroStatusItemAutores', categoria: 'filtroCategoriaAutores',
  };
  for (const [param, id] of Object.entries(mapa)) {
    const v = document.getElementById(id).value;
    if (v) params.set(param, v);
  }

  const dados = await api(`/autores?${params.toString()}`);
  estadoAutores.total = dados.total;

  // Cards de resumo
  document.getElementById('grideResumoAutores').innerHTML = `
    <div class="cartao-resumo"><div class="numero">${fmtNumero(dados.totalAutores)}</div><div class="rotulo">Autores (distintos)</div></div>
    <div class="cartao-resumo"><div class="numero">${fmtNumero(dados.total)}</div><div class="rotulo">Linhas (autor × item)${q || params.has('unidade') ? ' filtradas' : ''}</div></div>
    <div class="cartao-resumo"><div class="numero" style="font-size:18px;">${dados.dataReferencia ? formatarData(dados.dataReferencia) : '—'}</div><div class="rotulo">Data do arquivo${horaImportacao(dados.dataImportacao)}</div></div>
  `;

  const corpo = document.getElementById('corpoTabelaAutores');
  const vazio = document.getElementById('estadoVazioAutores');
  if (dados.itens.length === 0) {
    corpo.innerHTML = ''; vazio.hidden = false;
  } else {
    vazio.hidden = true;
    corpo.innerHTML = dados.itens.map((a) => `
      <tr>
        <td class="col-autor">${a.autor || '—'}</td>
        <td class="col-codigo">${a.id_demanda || '—'}</td>
        <td class="col-codigo">${a.protocolo || '—'}</td>
        <td class="col-codigo">${a.processo || '—'}</td>
        <td>${etStatusDemanda(a.status_demanda)}</td>
        <td>${tagTipoDemanda(a.tipo_demanda)}</td>
        <td class="col-codigo">${a.codigo_item || '—'}</td>
        <td class="col-codigo">${a.cod_siafisico || '—'}</td>
        <td class="col-desc" title="${(a.descricao_item || '').replace(/"/g, '')}">${a.descricao_item || celVazia()}</td>
        <td class="col-num">${a.qtde_consumo || '—'}</td>
        <td>${tagCategoria(a.categoria)}</td>
        <td><button type="button" class="botao-secundario btn-ver-demanda" data-demanda='${btDadosDemanda(a)}' style="padding:4px 10px; font-size:12px;">👁 Ver</button></td>
      </tr>
    `).join('');
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoAutores').textContent =
    `Página ${dados.page} de ${totalPaginas} · ${fmtNumero(dados.total)} linha(s)`;
  document.getElementById('botaoAnteriorAutores').disabled = dados.page <= 1;
  document.getElementById('botaoProximoAutores').disabled = dados.page >= totalPaginas;
}

// -------------------- Listagem de Autores — Demais Unidades --------------------
const estadoAutoresGeral = { pagina: 1, pageSize: 150, total: 0, filtrosCarregados: false };

let debounceBuscaAutoresGeral;
document.getElementById('filtroBuscaAutoresGeral').addEventListener('input', () => {
  clearTimeout(debounceBuscaAutoresGeral);
  debounceBuscaAutoresGeral = setTimeout(() => { estadoAutoresGeral.pagina = 1; carregarTabelaAutoresGeral(); }, 350);
});
['filtroUnidadeAutoresGeral', 'filtroStatusDemandaAutoresGeral', 'filtroStatusItemAutoresGeral', 'filtroCategoriaAutoresGeral'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => { estadoAutoresGeral.pagina = 1; carregarTabelaAutoresGeral(); });
});
document.getElementById('botaoLimparFiltrosAutoresGeral').addEventListener('click', () => {
  document.getElementById('filtroBuscaAutoresGeral').value = '';
  ['filtroUnidadeAutoresGeral', 'filtroStatusDemandaAutoresGeral', 'filtroStatusItemAutoresGeral', 'filtroCategoriaAutoresGeral']
    .forEach((id) => { document.getElementById(id).value = ''; });
  estadoAutoresGeral.pagina = 1; carregarTabelaAutoresGeral();
});
document.getElementById('botaoAnteriorAutoresGeral').addEventListener('click', () => {
  if (estadoAutoresGeral.pagina > 1) { estadoAutoresGeral.pagina--; carregarTabelaAutoresGeral(); }
});
document.getElementById('botaoProximoAutoresGeral').addEventListener('click', () => {
  estadoAutoresGeral.pagina++; carregarTabelaAutoresGeral();
});

// Exportação Excel (CSV) das listagens de Autores, respeitando os filtros atuais.
function exportarAutores(escopoGeral) {
  const suf = escopoGeral ? 'AutoresGeral' : 'Autores';
  const params = new URLSearchParams();
  params.set('escopoUnidade', escopoGeral ? 'geral' : 'udtp');
  const q = document.getElementById('filtroBusca' + suf).value.trim();
  if (q) params.set('q', q);
  const mapa = {
    unidade: 'filtroUnidade' + suf, status_demanda: 'filtroStatusDemanda' + suf,
    status_item: 'filtroStatusItem' + suf, categoria: 'filtroCategoria' + suf,
  };
  for (const [param, id] of Object.entries(mapa)) {
    const el = document.getElementById(id);
    if (el && el.value) params.set(param, el.value);
  }
  window.location.href = '/api/autores/exportar?' + params.toString();
}
document.getElementById('botaoExportarAutores').addEventListener('click', () => exportarAutores(false));
document.getElementById('botaoExportarAutoresGeral').addEventListener('click', () => exportarAutores(true));

// ---------- Atualizar Listagem de Autores direto do Oracle (SCODES) ----------
let timerStatusOracle = null;
function mostrarStatusOracle(texto, cor) {
  const el = document.getElementById('statusOracleAutores');
  el.textContent = texto;
  el.style.color = cor || '';
  el.hidden = !texto;
}
async function verificarStatusOracle() {
  try {
    const r = await fetch('/api/autores/atualizar-oracle/status');
    const s = await r.json();
    const botao = document.getElementById('botaoAtualizarOracle');
    if (s.rodando) {
      botao.disabled = true;
      // Se a página foi recarregada no meio da atualização, religa o timer.
      if (!timerStatusOracle) timerStatusOracle = setInterval(verificarStatusOracle, 5000);
      const min = s.inicio ? Math.floor((Date.now() - new Date(s.inicio)) / 60000) : 0;
      mostrarStatusOracle(`⏳ Atualizando via Oracle… (${min} min) — pode continuar usando o sistema.`, '#8a6d00');
    } else {
      botao.disabled = false;
      if (timerStatusOracle) { clearInterval(timerStatusOracle); timerStatusOracle = null; }
      if (s.ultimoErro) {
        mostrarStatusOracle('❌ Falha na última atualização: ' + s.ultimoErro, '#b00020');
      } else if (s.ultimoResumo) {
        const seg = Math.round((s.ultimoResumo.duracaoMs || 0) / 1000);
        mostrarStatusOracle(`✅ Atualizado: ${s.ultimoResumo.totalLinhas} linhas / ${s.ultimoResumo.totalAutores} autores (${seg}s). Recarregue a tabela.`, '#1f5c52');
        // Recarrega as listagens com os dados novos
        estadoAutores.pagina = 1;
        carregarTabelaAutores();
      } else {
        mostrarStatusOracle('', '');
      }
    }
  } catch (_) { /* silencioso */ }
}
document.getElementById('botaoAtualizarOracle').addEventListener('click', async () => {
  if (!confirm('Atualizar a Listagem de Autores puxando TODAS as unidades direto do Oracle (SCODES)?\n\nIsso leva alguns minutos e roda em segundo plano — você pode continuar usando o sistema normalmente.')) return;
  const botao = document.getElementById('botaoAtualizarOracle');
  botao.disabled = true;
  mostrarStatusOracle('⏳ Iniciando…', '#8a6d00');
  try {
    const r = await fetch('/api/autores/atualizar-oracle', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) {
      mostrarStatusOracle('❌ ' + (d.erro || 'Não foi possível iniciar.'), '#b00020');
      botao.disabled = false;
      return;
    }
    // Passa a acompanhar o status a cada 5s
    if (timerStatusOracle) clearInterval(timerStatusOracle);
    timerStatusOracle = setInterval(verificarStatusOracle, 5000);
    verificarStatusOracle();
  } catch (e) {
    mostrarStatusOracle('❌ Erro de rede ao iniciar.', '#b00020');
    botao.disabled = false;
  }
});

// ---------- Atualizar Estoque direto do Oracle (SCODES) ----------
let timerStatusOracleEstoque = null;
function mostrarStatusOracleEstoque(texto, cor) {
  const el = document.getElementById('statusOracleEstoque');
  el.textContent = texto;
  el.style.color = cor || '';
  el.hidden = !texto;
}
async function verificarStatusOracleEstoque() {
  try {
    const r = await fetch('/api/estoque/atualizar-oracle/status');
    const s = await r.json();
    const botao = document.getElementById('botaoAtualizarOracleEstoque');
    if (s.rodando) {
      botao.disabled = true;
      if (!timerStatusOracleEstoque) timerStatusOracleEstoque = setInterval(verificarStatusOracleEstoque, 5000);
      const min = s.inicio ? Math.floor((Date.now() - new Date(s.inicio)) / 60000) : 0;
      mostrarStatusOracleEstoque(`⏳ Atualizando via Oracle… (${min} min) — pode continuar usando o sistema.`, '#8a6d00');
    } else {
      botao.disabled = false;
      if (timerStatusOracleEstoque) { clearInterval(timerStatusOracleEstoque); timerStatusOracleEstoque = null; }
      if (s.ultimoErro) {
        mostrarStatusOracleEstoque('❌ Falha na última atualização: ' + s.ultimoErro, '#b00020');
      } else if (s.ultimoResumo) {
        const seg = Math.round((s.ultimoResumo.duracaoMs || 0) / 1000);
        mostrarStatusOracleEstoque(`✅ Atualizado: ${s.ultimoResumo.totalItens} itens (${seg}s). Recarregue a tela.`, '#1f5c52');
        estado.estoque.data = null; // força usar a data mais recente
        carregarEstoque();
      } else {
        mostrarStatusOracleEstoque('', '');
      }
    }
  } catch (_) { /* silencioso */ }
}
document.getElementById('botaoAtualizarOracleEstoque').addEventListener('click', async () => {
  if (!confirm('Atualizar o Estoque puxando TODAS as unidades direto do Oracle (SCODES)?\n\nLeva alguns minutos e roda em segundo plano — você pode continuar usando o sistema normalmente.')) return;
  const botao = document.getElementById('botaoAtualizarOracleEstoque');
  botao.disabled = true;
  mostrarStatusOracleEstoque('⏳ Iniciando…', '#8a6d00');
  try {
    const r = await fetch('/api/estoque/atualizar-oracle', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) {
      mostrarStatusOracleEstoque('❌ ' + (d.erro || 'Não foi possível iniciar.'), '#b00020');
      botao.disabled = false;
      return;
    }
    if (timerStatusOracleEstoque) clearInterval(timerStatusOracleEstoque);
    timerStatusOracleEstoque = setInterval(verificarStatusOracleEstoque, 5000);
    verificarStatusOracleEstoque();
  } catch (e) {
    mostrarStatusOracleEstoque('❌ Erro de rede ao iniciar.', '#b00020');
    botao.disabled = false;
  }
});

async function carregarAutoresGeral() {
  if (!estadoAutoresGeral.filtrosCarregados) {
    try {
      const f = await api('/autores/filtros?escopoUnidade=geral');
      const preencher = (id, valores, rotulo) => {
        const sel = document.getElementById(id);
        sel.innerHTML = `<option value="">${rotulo}</option>` +
          valores.map((v) => `<option value="${v.replace(/"/g, '&quot;')}">${v}</option>`).join('');
      };
      preencher('filtroUnidadeAutoresGeral', f.unidade, 'Unidade: todas');
      preencher('filtroStatusDemandaAutoresGeral', f.status_demanda, 'Status da demanda: todos');
      preencher('filtroStatusItemAutoresGeral', f.status_item, 'Status do item: todos');
      preencher('filtroCategoriaAutoresGeral', f.categoria, 'Categoria: todas');
      estadoAutoresGeral.filtrosCarregados = true;
    } catch (e) { /* segue sem filtros */ }
  }
  carregarTabelaAutoresGeral();
}

async function carregarTabelaAutoresGeral() {
  const params = new URLSearchParams({ page: estadoAutoresGeral.pagina, pageSize: estadoAutoresGeral.pageSize });
  params.set('escopoUnidade', 'geral');
  const q = document.getElementById('filtroBuscaAutoresGeral').value.trim();
  if (q) params.set('q', q);
  const mapa = {
    unidade: 'filtroUnidadeAutoresGeral', status_demanda: 'filtroStatusDemandaAutoresGeral',
    status_item: 'filtroStatusItemAutoresGeral', categoria: 'filtroCategoriaAutoresGeral',
  };
  for (const [param, id] of Object.entries(mapa)) {
    const v = document.getElementById(id).value;
    if (v) params.set(param, v);
  }

  const dados = await api(`/autores?${params.toString()}`);
  estadoAutoresGeral.total = dados.total;

  document.getElementById('grideResumoAutoresGeral').innerHTML = `
    <div class="cartao-resumo"><div class="numero">${fmtNumero(dados.totalAutores)}</div><div class="rotulo">Autores (distintos)</div></div>
    <div class="cartao-resumo"><div class="numero">${fmtNumero(dados.total)}</div><div class="rotulo">Linhas (autor × item)${q || params.has('unidade') ? ' filtradas' : ''}</div></div>
    <div class="cartao-resumo"><div class="numero" style="font-size:18px;">${dados.dataReferencia ? formatarData(dados.dataReferencia) : '—'}</div><div class="rotulo">Data do arquivo${horaImportacao(dados.dataImportacao)}</div></div>
  `;

  const corpo = document.getElementById('corpoTabelaAutoresGeral');
  const vazio = document.getElementById('estadoVazioAutoresGeral');
  if (dados.itens.length === 0) {
    corpo.innerHTML = ''; vazio.hidden = false;
  } else {
    vazio.hidden = true;
    corpo.innerHTML = dados.itens.map((a) => `
      <tr>
        <td class="col-autor">${a.autor || '—'}</td>
        <td class="col-unidade">${a.unidade_dispensadora || celVazia()}</td>
        <td class="col-codigo">${a.id_demanda || '—'}</td>
        <td class="col-codigo">${a.protocolo || '—'}</td>
        <td class="col-codigo">${a.processo || '—'}</td>
        <td>${etStatusDemanda(a.status_demanda)}</td>
        <td>${tagTipoDemanda(a.tipo_demanda)}</td>
        <td class="col-codigo">${a.codigo_item || '—'}</td>
        <td class="col-codigo">${a.cod_siafisico || '—'}</td>
        <td class="col-desc" title="${(a.descricao_item || '').replace(/"/g, '')}">${a.descricao_item || celVazia()}</td>
        <td class="col-num">${a.qtde_consumo || '—'}</td>
        <td>${tagCategoria(a.categoria)}</td>
        <td><button type="button" class="botao-secundario btn-ver-demanda" data-demanda='${btDadosDemanda(a)}' style="padding:4px 10px; font-size:12px;">👁 Ver</button></td>
      </tr>
    `).join('');
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoAutoresGeral').textContent =
    `Página ${dados.page} de ${totalPaginas} · ${fmtNumero(dados.total)} linha(s)`;
  document.getElementById('botaoAnteriorAutoresGeral').disabled = dados.page <= 1;
  document.getElementById('botaoProximoAutoresGeral').disabled = dados.page >= totalPaginas;
}

// ==================== Listagem de Autores Importados ====================
// Pacientes ATIVOS, de TODAS as unidades, com itens IMPORTADOS. Mesmo layout e
// modal ("Ver") das outras listagens de autores (escopoUnidade='importados').
const estadoAutoresImportados = { pagina: 1, pageSize: 150, total: 0, filtrosCarregados: false };

let debounceBuscaAutoresImportados;
document.getElementById('filtroBuscaAutoresImportados').addEventListener('input', () => {
  clearTimeout(debounceBuscaAutoresImportados);
  debounceBuscaAutoresImportados = setTimeout(() => { estadoAutoresImportados.pagina = 1; carregarTabelaAutoresImportados(); }, 350);
});
['filtroUnidadeAutoresImportados', 'filtroStatusDemandaAutoresImportados', 'filtroStatusItemAutoresImportados', 'filtroCategoriaAutoresImportados'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => { estadoAutoresImportados.pagina = 1; carregarTabelaAutoresImportados(); });
});
document.getElementById('botaoLimparFiltrosAutoresImportados').addEventListener('click', () => {
  document.getElementById('filtroBuscaAutoresImportados').value = '';
  ['filtroUnidadeAutoresImportados', 'filtroStatusDemandaAutoresImportados', 'filtroStatusItemAutoresImportados', 'filtroCategoriaAutoresImportados']
    .forEach((id) => { document.getElementById(id).value = ''; });
  estadoAutoresImportados.pagina = 1; carregarTabelaAutoresImportados();
});
document.getElementById('botaoAnteriorAutoresImportados').addEventListener('click', () => {
  if (estadoAutoresImportados.pagina > 1) { estadoAutoresImportados.pagina--; carregarTabelaAutoresImportados(); }
});
document.getElementById('botaoProximoAutoresImportados').addEventListener('click', () => {
  estadoAutoresImportados.pagina++; carregarTabelaAutoresImportados();
});
document.getElementById('botaoExportarAutoresImportados').addEventListener('click', () => {
  const params = new URLSearchParams();
  params.set('escopoUnidade', 'importados');
  const q = document.getElementById('filtroBuscaAutoresImportados').value.trim();
  if (q) params.set('q', q);
  const mapa = { unidade: 'filtroUnidadeAutoresImportados', status_demanda: 'filtroStatusDemandaAutoresImportados', status_item: 'filtroStatusItemAutoresImportados', categoria: 'filtroCategoriaAutoresImportados' };
  for (const [param, id] of Object.entries(mapa)) { const el = document.getElementById(id); if (el && el.value) params.set(param, el.value); }
  window.location.href = '/api/autores/exportar?' + params.toString();
});

async function carregarAutoresImportados() {
  if (!estadoAutoresImportados.filtrosCarregados) {
    try {
      const f = await api('/autores/filtros?escopoUnidade=importados');
      const preencher = (id, valores, rotulo) => {
        const sel = document.getElementById(id);
        sel.innerHTML = `<option value="">${rotulo}</option>` +
          valores.map((v) => `<option value="${v.replace(/"/g, '&quot;')}">${v}</option>`).join('');
      };
      preencher('filtroUnidadeAutoresImportados', f.unidade, 'Unidade: todas');
      preencher('filtroStatusDemandaAutoresImportados', f.status_demanda, 'Status da demanda: todos');
      preencher('filtroStatusItemAutoresImportados', f.status_item, 'Status do item: todos');
      preencher('filtroCategoriaAutoresImportados', f.categoria, 'Categoria: todas');
      estadoAutoresImportados.filtrosCarregados = true;
    } catch (e) { /* segue sem filtros */ }
  }
  carregarTabelaAutoresImportados();
}

async function carregarTabelaAutoresImportados() {
  const params = new URLSearchParams({ page: estadoAutoresImportados.pagina, pageSize: estadoAutoresImportados.pageSize });
  params.set('escopoUnidade', 'importados');
  const q = document.getElementById('filtroBuscaAutoresImportados').value.trim();
  if (q) params.set('q', q);
  const mapa = {
    unidade: 'filtroUnidadeAutoresImportados', status_demanda: 'filtroStatusDemandaAutoresImportados',
    status_item: 'filtroStatusItemAutoresImportados', categoria: 'filtroCategoriaAutoresImportados',
  };
  for (const [param, id] of Object.entries(mapa)) { const v = document.getElementById(id).value; if (v) params.set(param, v); }

  const dados = await api(`/autores?${params.toString()}`);
  estadoAutoresImportados.total = dados.total;

  document.getElementById('grideResumoAutoresImportados').innerHTML = `
    <div class="cartao-resumo"><div class="numero">${fmtNumero(dados.totalAutores)}</div><div class="rotulo">Autores (distintos)</div></div>
    <div class="cartao-resumo"><div class="numero">${fmtNumero(dados.total)}</div><div class="rotulo">Linhas (autor × item)${q || params.has('unidade') ? ' filtradas' : ''}</div></div>
    <div class="cartao-resumo"><div class="numero" style="font-size:18px;">${dados.dataReferencia ? formatarData(dados.dataReferencia) : '—'}</div><div class="rotulo">Data do arquivo${horaImportacao(dados.dataImportacao)}</div></div>
  `;

  const corpo = document.getElementById('corpoTabelaAutoresImportados');
  const vazio = document.getElementById('estadoVazioAutoresImportados');
  if (dados.itens.length === 0) {
    corpo.innerHTML = ''; vazio.hidden = false;
  } else {
    vazio.hidden = true;
    corpo.innerHTML = dados.itens.map((a) => `
      <tr>
        <td class="col-autor">${a.autor || '—'}</td>
        <td class="col-unidade">${a.unidade_dispensadora || celVazia()}</td>
        <td class="col-codigo">${a.id_demanda || '—'}</td>
        <td class="col-codigo">${a.protocolo || '—'}</td>
        <td class="col-codigo">${a.processo || '—'}</td>
        <td>${etStatusDemanda(a.status_demanda)}</td>
        <td>${tagTipoDemanda(a.tipo_demanda)}</td>
        <td class="col-codigo">${a.codigo_item || '—'}</td>
        <td class="col-codigo">${a.cod_siafisico || '—'}</td>
        <td class="col-desc" title="${(a.descricao_item || '').replace(/"/g, '')}">${a.descricao_item || celVazia()}</td>
        <td class="col-num">${a.qtde_consumo || '—'}</td>
        <td>${tagCategoria(a.categoria)}</td>
        <td style="white-space:nowrap;">
          <button type="button" class="botao-secundario btn-ver-demanda" data-demanda='${btDadosDemanda(a)}' style="padding:4px 10px; font-size:12px;">👁 Ver</button>
          <button type="button" class="botao-primario btn-add-compra-imp" data-imp='${btDadosCompraImp(a)}' title="Adicionar ao Relatório de Compras Importados" style="padding:4px 10px; font-size:12px;">➕</button>
        </td>
      </tr>
    `).join('');
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoAutoresImportados').textContent =
    `Página ${dados.page} de ${totalPaginas} · ${fmtNumero(dados.total)} linha(s)`;
  document.getElementById('botaoAnteriorAutoresImportados').disabled = dados.page <= 1;
  document.getElementById('botaoProximoAutoresImportados').disabled = dados.page >= totalPaginas;
}

// ==================== Relatório de Compras Importados ====================
let relImpCache = [];
document.getElementById('filtroBuscaRelImp').addEventListener('input', () => renderRelImp());
document.getElementById('botaoLimparFiltrosRelImp').addEventListener('click', () => {
  document.getElementById('filtroBuscaRelImp').value = '';
  document.getElementById('filtroStatusRelImp').value = '';
  document.getElementById('filtroUnidadeRelImp').value = '';
  renderRelImp();
});

// Número no padrão pt-BR ou com ponto decimal.
function parseValorImp(v) {
  if (v == null || v === '') return null;
  let s = String(v).trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
function valorTotalImp(r) {
  const q = parseValorImp(r.quantidade_solicitada);
  const v = parseValorImp(r.valor_medio_unitario);
  return (q != null && v != null) ? q * v : null;
}
function badgeStatusImp(s) {
  const st = s || 'Solicitado';
  const cls = st === 'Finalizado' ? 'finalizado'
    : (st === 'Cancelado' || st === 'Devolvido' || st === 'Deserto' || st === 'Fracassado' || st === 'Demanda Inativa') ? 'cancelado'
      : 'planejamento';
  return `<span class="etiqueta-status ${cls}">${escHtml(st)}</span>`;
}

async function carregarRelatorioImportados() {
  const dados = await api('/autores/compras-importados');
  relImpCache = dados.itens || [];
  renderRelImp();
}

// Data de referência do status atual (para os alertas): status_desde, ou o
// último update/criação como aproximação para linhas antigas.
function refStatusDesde(r) { return r.status_desde || r.atualizado_em || r.criado_em || null; }
function diasDecorridos(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).replace(' ', 'T'));
  if (isNaN(d)) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}
function textoTempoImp(dias) {
  if (dias == null) return '';
  if (dias <= 0) return 'hoje';
  if (dias < 60) return `há ${dias} dia${dias > 1 ? 's' : ''}`;
  const meses = Math.floor(dias / 30);
  return `há ${meses} ${meses > 1 ? 'meses' : 'mês'}`;
}
function corAlertaImp(dias) {
  if (dias == null) return 'var(--cinza-texto)';
  if (dias > 30) return '#b00020';
  if (dias >= 15) return '#8a6d00';
  return '#5a7d2a';
}

// Preenche os selects de Status e Unidade (preservando a seleção atual).
function preencherFiltrosRelImp() {
  const selS = document.getElementById('filtroStatusRelImp');
  const selU = document.getElementById('filtroUnidadeRelImp');
  const statuses = [...new Set(relImpCache.map((r) => r.status || 'Solicitado'))].sort((a, b) => a.localeCompare(b));
  const unidades = [...new Set(relImpCache.map((r) => r.unidade_dispensadora).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const manter = (sel, valores, rot) => {
    const atual = sel.value;
    sel.innerHTML = `<option value="">${rot}</option>` + valores.map((v) => `<option value="${escAttr(v)}">${escHtml(v)}</option>`).join('');
    if (valores.includes(atual)) sel.value = atual;
  };
  manter(selS, statuses, 'Status: todos');
  manter(selU, unidades, 'Unidade: todas');
}

// Painel de alertas: Pendência e Devolvido, com há quanto tempo.
function renderAlertasRelImp() {
  const box = document.getElementById('alertasRelImp');
  const alvos = relImpCache
    .filter((r) => ['Pendência', 'Devolvido'].includes(r.status))
    .map((r) => ({ r, dias: diasDecorridos(refStatusDesde(r)) }))
    .sort((a, b) => (b.dias || 0) - (a.dias || 0));
  if (!alvos.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const itens = alvos.map(({ r, dias }) => {
    const cor = corAlertaImp(dias);
    return `<button type="button" class="alerta-imp-item" data-imp="${r.id}" style="border-left:4px solid ${cor};">
      <span><strong>${escHtml(r.autor || '—')}</strong> está com status <strong>${escHtml(r.status)}</strong> <span style="color:${cor}; font-weight:600;">${textoTempoImp(dias)}</span></span>
      <span class="texto-secundario" style="font-size:12px;">${escHtml(r.descricao_item || '')}${r.unidade_dispensadora ? ' · ' + escHtml(r.unidade_dispensadora) : ''}</span>
    </button>`;
  }).join('');
  box.innerHTML = `<div class="painel-alertas-imp">
      <div class="painel-alertas-imp-titulo">⚠️ Alertas — Pendência e Devolvido (${alvos.length})</div>
      <div class="painel-alertas-imp-lista">${itens}</div>
    </div>`;
}

function renderRelImp() {
  preencherFiltrosRelImp();
  const q = normalizarBusca(document.getElementById('filtroBuscaRelImp').value);
  const fStatus = document.getElementById('filtroStatusRelImp').value;
  const fUnidade = document.getElementById('filtroUnidadeRelImp').value;
  const lista = relImpCache.filter((r) =>
    (!fStatus || (r.status || 'Solicitado') === fStatus)
    && (!fUnidade || r.unidade_dispensadora === fUnidade)
    && (!q || [r.autor, r.processo, r.protocolo, r.sei, r.req_gsnet, r.descricao_item, r.codigo_item, r.catmat]
      .some((v) => normalizarBusca(v).includes(q))));

  document.getElementById('grideResumoRelImp').innerHTML = `
    <div class="cartao-resumo"><div class="numero">${fmtNumero(new Set(relImpCache.map((r) => r.autor)).size)}</div><div class="rotulo">Pacientes</div></div>
    <div class="cartao-resumo"><div class="numero">${fmtNumero(relImpCache.length)}</div><div class="rotulo">Linhas (paciente × item)</div></div>
  `;

  renderAlertasRelImp();

  const corpo = document.getElementById('corpoTabelaRelImp');
  const vazio = document.getElementById('estadoVazioRelImp');
  if (!lista.length) { corpo.innerHTML = ''; vazio.hidden = false; return; }
  vazio.hidden = true;
  corpo.innerHTML = lista.map(linhaCompImpHTML).join('');
}
document.getElementById('filtroStatusRelImp').addEventListener('change', renderRelImp);
document.getElementById('filtroUnidadeRelImp').addEventListener('change', renderRelImp);
// Clique num alerta abre a edição da linha correspondente.
document.getElementById('alertasRelImp').addEventListener('click', (ev) => {
  const b = ev.target.closest('.alerta-imp-item');
  if (b) abrirModalCompraImp(b.dataset.imp);
});

// Linha (<tr>) de uma compra de importado — usada no Relatório e na Tabela Análise.
// Status "negativos" (licitação deserta/fracassada): liberam nova aquisição.
const STATUS_NEGATIVOS_IMP = ['Deserto', 'Fracassado'];
function linhaCompImpHTML(r) {
  const cel = (v) => escHtml(v == null || v === '' ? '—' : v);
  const vt = valorTotalImp(r);
  const podeNova = STATUS_NEGATIVOS_IMP.includes(r.status || '');
  return `
    <tr data-imp="${r.id}">
      <td class="col-autor">${cel(r.autor)}</td>
      <td class="col-num">${(r.ciclo || 1)}ª</td>
      <td class="col-unidade">${cel(r.unidade_dispensadora)}</td>
      <td class="col-codigo">${cel(r.protocolo)}</td>
      <td class="col-codigo">${cel(r.processo)}</td>
      <td class="col-codigo">${cel(r.codigo_item)}</td>
      <td class="col-codigo">${cel(r.cod_siafisico)}</td>
      <td class="col-desc" title="${escAttr(r.descricao_item || '')}">${cel(r.descricao_item)}</td>
      <td class="col-num">${cel(r.qtde_consumo)}</td>
      <td class="col-codigo">${cel(r.catmat)}</td>
      <td class="col-num">${cel(r.quantidade_solicitada)}</td>
      <td class="col-codigo">${cel(r.sei)}</td>
      <td class="col-codigo">${cel(r.req_gsnet)}</td>
      <td class="col-codigo">${cel(r.codigo_gsnet_item)}</td>
      <td class="col-num">${r.valor_medio_unitario ? brlPlan(parseValorImp(r.valor_medio_unitario)) : '—'}</td>
      <td class="col-num">${vt != null ? brlPlan(vt) : '—'}</td>
      <td class="col-codigo">${cel(r.solicitacao_drs_sei)}</td>
      <td class="col-data">${r.data_solicitacao ? formatarData(r.data_solicitacao) : '—'}</td>
      <td class="col-codigo">${cel(r.numero_empenho)}</td>
      <td class="col-codigo">${cel(r.numero_recibo)}</td>
      <td class="col-data">${r.data_entrega ? formatarData(r.data_entrega) : '—'}</td>
      <td>${badgeStatusImp(r.status)}</td>
      <td style="white-space:nowrap;">
        <button type="button" class="botao-secundario relimp-editar" style="padding:4px 8px; font-size:12px;">✏️ Editar</button>
        <button type="button" class="botao-secundario relimp-nova" ${podeNova ? '' : 'disabled'} title="${podeNova ? 'Refazer aquisição (processo Deserto/Fracassado)' : 'Nova aquisição disponível só quando o status for Deserto ou Fracassado'}" style="padding:4px 8px; font-size:12px;${podeNova ? '' : ' opacity:.4; cursor:not-allowed;'}">➕ Nova</button>
        <button type="button" class="botao-secundario relimp-remover" title="Remover" style="padding:4px 8px; font-size:12px; color:#c0392b;">✕</button>
      </td>
    </tr>`;
}

// Status que aparecem na Tabela Análise dos Importados.
const STATUS_ANALISE_IMP = ['Embarque', 'Instrução Processual', 'Solicitado'];

async function carregarAnaliseImportados() {
  const dados = await api('/autores/compras-importados');
  relImpCache = dados.itens || [];
  renderAnaliseImp();
}

// ==================== Relatório de Itens Importados ====================
// Itens importado='Sim' com demanda ativa, uma linha por SCODES. A coluna
// Código GSNET é editável (salva por item) para quem tem a ação "editar".
// Carrega TODOS de uma vez (poucas centenas) e filtra no navegador.
let itensImportadosCache = [];

async function carregarRelatorioItensImportados() {
  const dados = await api('/itens-importados');
  itensImportadosCache = dados.itens || [];
  const selCat = document.getElementById('filtroCategoriaItensImportados');
  const atual = selCat.value;
  selCat.innerHTML = '<option value="">Categoria: todas</option>' +
    (dados.categorias || []).map((c) => `<option value="${escAttr(c)}">${escHtml(c)}</option>`).join('');
  selCat.value = atual;
  const sub = document.getElementById('subtituloItensImportados');
  if (sub) {
    sub.textContent = dados.dataReferencia
      ? `Itens importados com demanda ativa — atualizado em ${formatarData(dados.dataReferencia)}${horaImportacao(dados.dataImportacao)}. Digite o Código GSNET conforme os códigos forem criados.`
      : 'Itens importados com demanda ativa. Digite o Código GSNET conforme os códigos forem criados.';
  }
  renderItensImportados();
}

function renderItensImportados() {
  const q = normalizarBusca(document.getElementById('filtroBuscaItensImportados').value);
  const cat = document.getElementById('filtroCategoriaItensImportados').value;
  let lista = itensImportadosCache;
  if (cat) lista = lista.filter((i) => (i.categoria || '') === cat);
  if (q) lista = lista.filter((i) =>
    normalizarBusca(`${i.codigo} ${i.catmat || ''} ${i.siafisico || ''} ${i.descricao || ''} ${i.categoria || ''} ${i.codigoGsnet || ''}`).includes(q));

  const podeEditar = temPermissao('relatorioItensImportados', 'editar');
  const corpo = document.getElementById('corpoTabelaItensImportados');
  corpo.innerHTML = lista.map((i) => `<tr>
    <td class="col-codigo">${escHtml(i.codigo)}</td>
    <td class="col-codigo">${escHtml(i.catmat || '—')}</td>
    <td class="col-codigo">${escHtml(i.siafisico || '—')}</td>
    <td>${escHtml(i.descricao || '—')}</td>
    <td>${escHtml(i.categoria || '—')}</td>
    <td><input type="text" class="ii-gsnet" data-codigo="${escAttr(i.codigo)}" value="${escAttr(i.codigoGsnet || '')}" placeholder="—" style="width:150px;" ${podeEditar ? '' : 'readonly'}></td>
  </tr>`).join('');
  document.getElementById('estadoVazioItensImportados').hidden = lista.length > 0;
  document.getElementById('totalItensImportados').textContent = `${fmtNumero(lista.length)} item(ns)`;

  if (podeEditar) {
    corpo.querySelectorAll('.ii-gsnet').forEach((inp) =>
      inp.addEventListener('change', () => salvarGsnetItem(inp)));
  }
}

async function salvarGsnetItem(inp) {
  const codigo = inp.dataset.codigo;
  const valor = inp.value.trim();
  inp.disabled = true;
  try {
    await api('/itens-importados/gsnet', { method: 'PUT', body: JSON.stringify({ codigo_item: codigo, codigo_gsnet: valor }) });
    inp.style.borderColor = 'var(--selo)';
    setTimeout(() => { inp.style.borderColor = ''; }, 1200);
    const it = itensImportadosCache.find((x) => x.codigo === codigo);
    if (it) it.codigoGsnet = valor;
  } catch (e) {
    alert('Não foi possível salvar o Código GSNET: ' + e.message);
  } finally {
    inp.disabled = false;
  }
}

document.getElementById('filtroBuscaItensImportados').addEventListener('input', renderItensImportados);
document.getElementById('filtroCategoriaItensImportados').addEventListener('change', renderItensImportados);
document.getElementById('botaoLimparFiltrosItensImportados').addEventListener('click', () => {
  document.getElementById('filtroBuscaItensImportados').value = '';
  document.getElementById('filtroCategoriaItensImportados').value = '';
  renderItensImportados();
});
document.getElementById('botaoExportarItensImportados').addEventListener('click', () => {
  const p = new URLSearchParams();
  const b = document.getElementById('filtroBuscaItensImportados').value.trim();
  const c = document.getElementById('filtroCategoriaItensImportados').value;
  if (b) p.set('busca', b);
  if (c) p.set('categoria', c);
  window.location.href = '/api/itens-importados/csv?' + p.toString();
});

function renderAnaliseImp() {
  const q = normalizarBusca(document.getElementById('filtroBuscaAnaliseImp').value);
  const base = relImpCache.filter((r) => STATUS_ANALISE_IMP.includes(r.status || 'Solicitado'));
  const lista = !q ? base : base.filter((r) =>
    [r.autor, r.processo, r.protocolo, r.sei, r.req_gsnet, r.descricao_item, r.codigo_item, r.catmat]
      .some((v) => normalizarBusca(v).includes(q)));

  document.getElementById('grideResumoAnaliseImp').innerHTML = `
    <div class="cartao-resumo"><div class="numero">${fmtNumero(new Set(base.map((r) => r.autor)).size)}</div><div class="rotulo">Pacientes (em análise)</div></div>
    <div class="cartao-resumo"><div class="numero">${fmtNumero(base.length)}</div><div class="rotulo">Solicitações (Embarque · Instrução Processual · Solicitado)</div></div>
  `;

  const corpo = document.getElementById('corpoTabelaAnaliseImp');
  const vazio = document.getElementById('estadoVazioAnaliseImp');
  if (!lista.length) { corpo.innerHTML = ''; vazio.hidden = false; return; }
  vazio.hidden = true;
  corpo.innerHTML = lista.map(linhaCompImpHTML).join('');
}

// Recarrega os dados e re-renderiza a tela de importados ativa (Relatório ou Análise).
async function recarregarCompImpAtual() {
  const dados = await api('/autores/compras-importados');
  relImpCache = dados.itens || [];
  if (estado.paginaAtual === 'analiseImportados') renderAnaliseImp(); else renderRelImp();
}

async function manipularCliqueCompImp(ev) {
  const tr = ev.target.closest('tr[data-imp]');
  if (!tr) return;
  const id = tr.dataset.imp;
  if (ev.target.closest('.relimp-editar')) {
    abrirModalCompraImp(id);
  } else if (ev.target.closest('.relimp-nova')) {
    const r = relImpCache.find((x) => String(x.id) === String(id));
    if (!r) return;
    if (!confirm(`Criar uma NOVA aquisição de ${r.autor} para este item? (os campos de compra vêm em branco)`)) return;
    // Só os campos capturados (a nova aquisição começa sem empenho/datas/valores).
    const base = {
      codigo_item: r.codigo_item, cod_siafisico: r.cod_siafisico, descricao_item: r.descricao_item,
      categoria: r.categoria, autor: r.autor, unidade_dispensadora: r.unidade_dispensadora,
      id_demanda: r.id_demanda, protocolo: r.protocolo, processo: r.processo,
      status_demanda: r.status_demanda, tipo_demanda: r.tipo_demanda, qtde_consumo: r.qtde_consumo,
      prazo: r.prazo, periodicidade: r.periodicidade, data_ultima_dispensacao: r.data_ultima_dispensacao,
      data_ultimo_retorno: r.data_ultimo_retorno, forcar: true,
    };
    try { await api('/autores/compras-importados', { method: 'POST', body: JSON.stringify(base) }); await recarregarCompImpAtual(); }
    catch (e) { alert(e.message); }
  } else if (ev.target.closest('.relimp-remover')) {
    if (!confirm('Remover este paciente do Relatório de Compras Importados?')) return;
    try { await api(`/autores/compras-importados/${id}`, { method: 'DELETE' }); await recarregarCompImpAtual(); }
    catch (e) { alert(e.message); }
  }
}
document.getElementById('corpoTabelaRelImp').addEventListener('click', manipularCliqueCompImp);
document.getElementById('corpoTabelaAnaliseImp').addEventListener('click', manipularCliqueCompImp);
document.getElementById('filtroBuscaAnaliseImp').addEventListener('input', () => renderAnaliseImp());
document.getElementById('botaoLimparFiltrosAnaliseImp').addEventListener('click', () => {
  document.getElementById('filtroBuscaAnaliseImp').value = ''; renderAnaliseImp();
});

// -------- Modal de edição da Compra do Importado --------
let ciEditId = null;
const modalCompraImp = document.getElementById('modalCompraImp');
// Quais campos condicionais cada status revela.
const CI_COND = {
  Cancelado: ['ciWrapJustificativa'],
  Devolvido: ['ciWrapJustificativa'],
  Fracassado: ['ciWrapJustificativa'],
  'Demanda Inativa': ['ciWrapDataInativacao'],
  Embarque: ['ciWrapDataEmbarque', 'ciWrapLote', 'ciWrapValidade'],
  Finalizado: ['ciWrapNumFatura', 'ciWrapDataFatura', 'ciWrapNumDocEntrada', 'ciWrapDataEntrada'],
  'Pendência': ['ciWrapMotivo', 'ciWrapJustificativa'],
  'Sem cotação': ['ciWrapTentativas', 'ciWrapTentativasDatas', 'ciWrapJustificativa'],
};
const CI_TODOS_WRAPS = ['ciWrapMotivo', 'ciWrapDataInativacao', 'ciWrapDataEmbarque', 'ciWrapLote',
  'ciWrapValidade', 'ciWrapNumFatura', 'ciWrapDataFatura', 'ciWrapNumDocEntrada', 'ciWrapDataEntrada',
  'ciWrapTelegrama', 'ciWrapDataTelegrama', 'ciWrapTentativas', 'ciWrapTentativasDatas', 'ciWrapJustificativa'];
let ciEhTP = false; // a linha em edição é da Tenente Pena?
function ciAtualizarCondicionais() {
  const st = document.getElementById('ciStatus').value;
  const mostrar = new Set(CI_COND[st] || []);
  // Telegrama: só no status Finalizado E para a unidade Tenente Pena.
  if (st === 'Finalizado' && ciEhTP) { mostrar.add('ciWrapTelegrama'); mostrar.add('ciWrapDataTelegrama'); }
  CI_TODOS_WRAPS.forEach((wid) => { document.getElementById(wid).hidden = !mostrar.has(wid); });
}
// Sem cotação: renderiza um campo de data por tentativa (1, 2, 3...).
function ciRenderTentativasDatas(n, valores) {
  const cont = document.getElementById('ciTentativasDatas');
  const qtd = Math.max(0, Math.min(20, parseInt(n, 10) || 0));
  const vals = Array.isArray(valores) ? valores : [];
  let html = '';
  for (let i = 0; i < qtd; i++) {
    html += `<label class="campo-modal">Tentativa ${i + 1}<input type="date" class="ci-tentativa-data" data-idx="${i}" value="${escAttr(vals[i] || '')}"></label>`;
  }
  cont.innerHTML = html || '<span class="texto-secundario" style="font-size:12px;">Informe o nº de tentativas acima.</span>';
}
function ciAtualizarValorTotal() {
  const q = parseValorImp(document.getElementById('ciQtdeSolic').value);
  const v = parseValorImp(document.getElementById('ciValorMedio').value);
  document.getElementById('ciValorTotal').value = (q != null && v != null) ? brlPlan(q * v) : '';
}
function abrirModalCompraImp(id) {
  const r = relImpCache.find((x) => String(x.id) === String(id));
  if (!r) return;
  ciEditId = id;
  document.getElementById('subCompraImp').textContent = `${r.autor || '—'} — ${r.descricao_item || '—'}`;
  const set = (elId, val) => { document.getElementById(elId).value = val == null ? '' : val; };
  set('ciQtdeSolic', r.quantidade_solicitada);
  set('ciValorMedio', r.valor_medio_unitario);
  set('ciSei', r.sei);
  set('ciReqGsnet', r.req_gsnet);
  set('ciSolicDrsSei', r.solicitacao_drs_sei);
  set('ciDataSolic', r.data_solicitacao);
  set('ciNumEmpenho', r.numero_empenho);
  set('ciNumRecibo', r.numero_recibo);
  set('ciDataEntrega', r.data_entrega);
  document.getElementById('ciStatus').value = r.status || 'Solicitado';
  set('ciJustificativa', r.justificativa);
  set('ciDataInativacao', r.data_inativacao);
  set('ciDataEmbarque', r.data_embarque);
  set('ciNumFaturaGsnet', r.numero_fatura_gsnet);
  set('ciDataFatura', r.data_fatura);
  set('ciNumDocEntradaGsnet', r.num_doc_entrada_gsnet);
  set('ciDataEntrada', r.data_entrada);
  document.getElementById('ciMotivoPendencia').value = r.motivo_pendencia || '';
  set('ciLote', r.lote);
  set('ciValidade', r.validade);
  set('ciNumTentativas', r.num_tentativas);
  ciEhTP = /tenente pena/i.test(r.unidade_dispensadora || '');
  document.getElementById('ciTelegramaEnviado').value = r.telegrama_enviado || 'Não';
  set('ciDataEnvioTelegrama', r.data_envio_telegrama);
  let datasTent = [];
  try { datasTent = r.tentativas_datas ? JSON.parse(r.tentativas_datas) : []; } catch (e) { datasTent = []; }
  ciRenderTentativasDatas(r.num_tentativas, datasTent);
  ciAtualizarCondicionais();
  ciAtualizarValorTotal();
  modalCompraImp.hidden = false;
}
document.getElementById('ciStatus').addEventListener('change', ciAtualizarCondicionais);
document.getElementById('ciNumTentativas').addEventListener('input', () => {
  // Preserva as datas já digitadas ao mudar a quantidade.
  const atuais = [...document.querySelectorAll('#ciTentativasDatas .ci-tentativa-data')].map((i) => i.value);
  ciRenderTentativasDatas(document.getElementById('ciNumTentativas').value, atuais);
});
document.getElementById('ciQtdeSolic').addEventListener('input', ciAtualizarValorTotal);
document.getElementById('ciValorMedio').addEventListener('input', ciAtualizarValorTotal);
document.getElementById('botaoCancelarCompraImp').addEventListener('click', () => { modalCompraImp.hidden = true; });
document.getElementById('botaoSalvarCompraImp').addEventListener('click', async () => {
  if (!ciEditId) return;
  const val = (elId) => document.getElementById(elId).value.trim();
  const body = {
    quantidade_solicitada: val('ciQtdeSolic'), valor_medio_unitario: val('ciValorMedio'),
    sei: val('ciSei'), req_gsnet: val('ciReqGsnet'), solicitacao_drs_sei: val('ciSolicDrsSei'),
    data_solicitacao: val('ciDataSolic'), numero_empenho: val('ciNumEmpenho'),
    numero_recibo: val('ciNumRecibo'), data_entrega: val('ciDataEntrega'),
    status: document.getElementById('ciStatus').value,
    justificativa: val('ciJustificativa'), data_inativacao: val('ciDataInativacao'),
    data_embarque: val('ciDataEmbarque'), numero_fatura_gsnet: val('ciNumFaturaGsnet'),
    data_fatura: val('ciDataFatura'),
    num_doc_entrada_gsnet: val('ciNumDocEntradaGsnet'), data_entrada: val('ciDataEntrada'),
    motivo_pendencia: document.getElementById('ciMotivoPendencia').value,
    lote: val('ciLote'), validade: val('ciValidade'),
    num_tentativas: val('ciNumTentativas'),
    tentativas_datas: JSON.stringify([...document.querySelectorAll('#ciTentativasDatas .ci-tentativa-data')].map((i) => i.value)),
    telegrama_enviado: (ciEhTP && document.getElementById('ciStatus').value === 'Finalizado') ? document.getElementById('ciTelegramaEnviado').value : '',
    data_envio_telegrama: (ciEhTP && document.getElementById('ciStatus').value === 'Finalizado') ? val('ciDataEnvioTelegrama') : '',
  };
  try {
    await api(`/autores/compras-importados/${ciEditId}`, { method: 'PUT', body: JSON.stringify(body) });
    const item = relImpCache.find((r) => String(r.id) === String(ciEditId));
    if (item) Object.assign(item, body);
    modalCompraImp.hidden = true;
    if (estado.paginaAtual === 'analiseImportados') renderAnaliseImp(); else renderRelImp();
  } catch (e) { alert(e.message); }
});

// Dados capturados pelo botão "+" (Adicionar ao Relatório de Compras Importados):
// a linha do autor + os campos do modal.
function btDadosCompraImp(a) {
  const d = {
    codigo_item: a.codigo_item || '', cod_siafisico: a.cod_siafisico || '',
    descricao_item: a.descricao_item || '', categoria: a.categoria || '',
    autor: a.autor || '', unidade_dispensadora: a.unidade_dispensadora || '',
    id_demanda: a.id_demanda || '', protocolo: a.protocolo || '', processo: a.processo || '',
    status_demanda: a.status_demanda || '', tipo_demanda: a.tipo_demanda || '',
    qtde_consumo: a.qtde_consumo || '', prazo: a.prazo || '', periodicidade: a.periodicidade || '',
    data_ultima_dispensacao: a.data_ultima_dispensacao || '', data_ultimo_retorno: a.data_ultimo_retorno || '',
  };
  return JSON.stringify(d).replace(/&/g, '&amp;').replace(/'/g, '&#39;');
}
// Clique no "+" → adiciona ao Relatório de Compras Importados.
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('.btn-add-compra-imp');
  if (!b) return;
  let dados;
  try { dados = JSON.parse(b.dataset.imp); } catch (e) { return; }
  b.disabled = true;
  try {
    await api('/autores/compras-importados', { method: 'POST', body: JSON.stringify(dados) });
    b.textContent = '✓';
    alert(`${dados.autor} adicionado ao Relatório de Compras Importados.`);
  } catch (e) {
    // Já existe: só libera nova aquisição quando a última foi FINALIZADA
    // (recorrência). Deserto/Fracassado -> refazer pelo Relatório; em andamento -> bloqueia.
    if (e.dados && e.dados.jaExiste && e.dados.podeNova) {
      const nova = (e.dados.ciclos || 1) + 1;
      const stAnt = e.dados.statusAnterior || 'encerrada';
      if (confirm(`${dados.autor} já tem uma aquisição encerrada (${stAnt}) deste item.\n\nCriar uma NOVA aquisição (${nova}ª)?`)) {
        try {
          await api('/autores/compras-importados', { method: 'POST', body: JSON.stringify({ ...dados, forcar: true }) });
          b.textContent = '✓';
          alert(`Nova aquisição (${nova}ª) de ${dados.autor} adicionada.`);
          return;
        } catch (e2) { alert(e2.message); }
      }
    } else {
      alert(e.message);
    }
    b.disabled = false;
  }
});

// ================== Modo "Por Item" (Autores Importados) ==================
// Escolhe um item, lista os pacientes ativos dele e adiciona vários ao
// Relatório de Compras Importados de uma vez. Reaproveita POST
// /autores/compras-importados (com a mesma regra de recorrência).
const modalPorItemImp = document.getElementById('modalPorItemImp');
let piItemAtual = null;      // { codigo_item, descricao_item, ... }
let piPacientes = [];        // pacientes carregados do item
let piValorMedio = null;     // valor médio unitário do item (Relatório de Itens)
let piSelecionados = [];     // pacientes escolhidos na etapa de valores
let piDebounce;

function piMostrarEtapa(etapa) { // 'item' | 'pacientes' | 'valores'
  document.getElementById('piEtapaItem').hidden = etapa !== 'item';
  document.getElementById('piEtapaPacientes').hidden = etapa !== 'pacientes';
  document.getElementById('piEtapaValores').hidden = etapa !== 'valores';
  document.getElementById('piVoltar').hidden = etapa !== 'pacientes';
  document.getElementById('piVoltarPac').hidden = etapa !== 'valores';
  document.getElementById('piAdicionar').hidden = etapa !== 'pacientes';
  document.getElementById('piConfirmar').hidden = etapa !== 'valores';
}

function abrirPorItemImp() {
  piItemAtual = null; piPacientes = []; piValorMedio = null; piSelecionados = [];
  piMostrarEtapa('item');
  document.getElementById('piBuscaItem').value = '';
  document.getElementById('piResultadosItem').innerHTML = '<p class="texto-apoio" style="padding:8px 0;">Digite para buscar um item.</p>';
  modalPorItemImp.hidden = false;
  setTimeout(() => document.getElementById('piBuscaItem').focus(), 50);
}
document.getElementById('botaoPorItemImp').addEventListener('click', abrirPorItemImp);
document.getElementById('piCancelar').addEventListener('click', () => { modalPorItemImp.hidden = true; });
modalPorItemImp.addEventListener('click', (ev) => { if (ev.target === modalPorItemImp) modalPorItemImp.hidden = true; });
document.getElementById('piVoltar').addEventListener('click', () => piMostrarEtapa('item'));
document.getElementById('piVoltarPac').addEventListener('click', () => piMostrarEtapa('pacientes'));

document.getElementById('piBuscaItem').addEventListener('input', (ev) => {
  clearTimeout(piDebounce);
  const termo = ev.target.value.trim();
  const alvo = document.getElementById('piResultadosItem');
  if (!termo) { alvo.innerHTML = '<p class="texto-apoio" style="padding:8px 0;">Digite para buscar um item.</p>'; return; }
  piDebounce = setTimeout(async () => {
    alvo.innerHTML = '<p class="texto-apoio" style="padding:8px 0;">Buscando…</p>';
    try {
      const d = await api('/autores/importados/itens?q=' + encodeURIComponent(termo));
      if (!d.itens.length) { alvo.innerHTML = '<p class="texto-apoio" style="padding:8px 0;">Nenhum item encontrado.</p>'; return; }
      alvo.innerHTML = d.itens.map((it, i) => `
        <div class="pi-item-op" data-idx="${i}" role="button" tabindex="0" style="display:flex; align-items:center; gap:10px; padding:9px 10px; border:1px solid var(--linha); border-radius:var(--raio); margin-bottom:6px; cursor:pointer;">
          <div style="flex:1;">
            <div style="font-weight:500; font-size:13px;">${escHtml(it.descricao_item || it.codigo_item)}</div>
            <div class="col-codigo" style="font-size:11px;">${escHtml(it.codigo_item)}${it.cod_siafisico ? ' · Siafísico ' + escHtml(it.cod_siafisico) : ''}</div>
          </div>
          <span class="tag-status" style="background:#1c6cad22; color:#1c6cad; border:1px solid #1c6cad55; white-space:nowrap;">${fmtNumero(it.n_pacientes)} paciente(s)</span>
        </div>`).join('');
      alvo.querySelectorAll('.pi-item-op').forEach((el) => {
        const it = d.itens[Number(el.dataset.idx)];
        el.addEventListener('click', () => escolherItemImp(it));
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); escolherItemImp(it); } });
      });
    } catch (e) { alvo.innerHTML = `<p class="texto-apoio" style="color:var(--vermelho); padding:8px 0;">Erro: ${e.message}</p>`; }
  }, 300);
});

async function escolherItemImp(it) {
  piItemAtual = it;
  const corpo = document.getElementById('piCorpoPacientes');
  piMostrarEtapa('pacientes');
  document.getElementById('piItemEscolhido').innerHTML =
    `<div style="flex:1;"><div style="font-weight:500;">${escHtml(it.descricao_item || it.codigo_item)}</div>
     <div class="col-codigo" style="font-size:11px;">${escHtml(it.codigo_item)}</div></div>`;
  corpo.innerHTML = '<p class="texto-apoio" style="padding:8px 0;">Carregando pacientes…</p>';
  try {
    const d = await api('/autores/importados/por-item?codigo=' + encodeURIComponent(it.codigo_item));
    piPacientes = d.itens;
    piValorMedio = d.valor_medio_unitario || null;
    renderPacientesImp();
  } catch (e) { corpo.innerHTML = `<p class="texto-apoio" style="color:var(--vermelho);">Erro: ${e.message}</p>`; }
}

// Qtde a Comprar do paciente = Qtde de Consumo × Autonomia de compra (meses).
function piQtdComprar(p) {
  const consumo = parseNumeroReq(p.qtde_consumo);
  const aut = p._autonomia == null ? 1 : parseNumeroReq(p._autonomia);
  return Math.ceil(consumo * aut); // sempre inteiro (arredonda p/ cima: não comprar menos que o necessário)
}

function renderPacientesImp() {
  const corpo = document.getElementById('piCorpoPacientes');
  // Autonomia de compra padrão = 1 mês (igual à tela coletiva "Por item").
  piPacientes.forEach((p) => { if (p._autonomia == null) p._autonomia = 1; });
  corpo.innerHTML = `<table class="tabela" style="min-width:1080px;"><thead><tr>
      <th style="width:34px;"></th><th>Paciente</th><th>Unidade</th><th>Protocolo</th><th>Status da demanda</th>
      <th style="text-align:right;">Periodicidade</th><th style="text-align:right;">Prazo</th>
      <th style="text-align:right;">Qtde de Consumo</th><th style="width:96px; text-align:right;">Autonomia (m)</th>
      <th style="text-align:right;">Qtde a Comprar</th><th></th>
    </tr></thead><tbody>${piPacientes.map((p, i) => {
      const tip = p.ja_existe ? `já consta aquisição do item para o paciente${p.status_anterior ? ' (última: ' + escHtml(p.status_anterior) + ')' : ''}` : '';
      const chk = `<input type="checkbox" class="pi-chk" data-idx="${i}" ${p.ja_existe ? 'disabled' : ''}>`;
      const incluir = p.ja_existe
        ? `<button type="button" class="botao-secundario pi-incluir" data-idx="${i}" title="${tip}" style="padding:3px 9px; font-size:11px;">Incluir mesmo assim</button>`
        : '';
      return `<tr${p.ja_existe ? ' style="opacity:.6;" title="' + tip + '"' : ''}>
        <td>${chk}</td>
        <td style="font-weight:500;">${escHtml(p.autor || '—')}${p.ja_existe ? ' <span class="tag-status" style="background:#b4530922; color:#b45309; border:1px solid #b4530955; font-size:10px;">já no relatório</span>' : ''}</td>
        <td>${escHtml(p.unidade_dispensadora || '—')}</td>
        <td class="col-codigo">${escHtml(p.protocolo || '—')}</td>
        <td style="font-size:12px;">${escHtml(p.status_demanda || '—')}</td>
        <td class="num">${escHtml(p.periodicidade || '—')}</td>
        <td class="num">${escHtml(p.prazo || '—')}</td>
        <td class="num">${escHtml(p.qtde_consumo || '—')}</td>
        <td><input type="number" class="pi-aut" data-idx="${i}" value="${escAttr(String(p._autonomia))}" min="0" step="1" ${p.ja_existe ? 'disabled' : ''} style="width:78px; text-align:right; padding:4px 6px;"></td>
        <td class="num pi-comprar" data-idx="${i}" style="font-weight:600;">${fmtNumero(piQtdComprar(p))}</td>
        <td>${incluir}</td>
      </tr>`;
    }).join('')}</tbody></table>`;
  corpo.querySelectorAll('.pi-chk').forEach((c) => c.addEventListener('change', atualizarContadorPiSel));
  corpo.querySelectorAll('.pi-incluir').forEach((b) => b.addEventListener('click', () => incluirMesmoAssimImp(Number(b.dataset.idx), b)));
  corpo.querySelectorAll('.pi-aut').forEach((inp) => inp.addEventListener('input', () => {
    const idx = Number(inp.dataset.idx);
    piPacientes[idx]._autonomia = parseNumeroReq(inp.value);
    const cel = corpo.querySelector(`.pi-comprar[data-idx="${idx}"]`);
    if (cel) cel.textContent = fmtNumero(piQtdComprar(piPacientes[idx]));
    atualizarContadorPiSel();
  }));
  document.getElementById('piSelTodos').checked = false;
  atualizarContadorPiSel();
}

function atualizarContadorPiSel() {
  const marcados = [...document.querySelectorAll('#piCorpoPacientes .pi-chk:checked')];
  const n = marcados.length;
  const subtotal = marcados.reduce((s, c) => s + piQtdComprar(piPacientes[Number(c.dataset.idx)]), 0);
  document.getElementById('piContadorSel').textContent =
    n > 0 ? `${n} selecionado(s) · Qtde a Comprar (subtotal): ${fmtNumero(+subtotal.toFixed(2))}` : '0 selecionado(s)';
  document.getElementById('piAdicionar').textContent = n > 0 ? `Adicionar ${n} selecionado(s)` : 'Adicionar selecionados';
}

document.getElementById('piSelTodos').addEventListener('change', (ev) => {
  document.querySelectorAll('#piCorpoPacientes .pi-chk:not(:disabled)').forEach((c) => { c.checked = ev.target.checked; });
  atualizarContadorPiSel();
});

async function incluirMesmoAssimImp(idx, btn) {
  const p = piPacientes[idx];
  if (!p) return;
  if (!confirm(`Incluir "${p.autor}" mesmo já constando aquisição deste item?`)) return;
  btn.disabled = true; btn.textContent = 'Incluindo…';
  try {
    await api('/autores/compras-importados', { method: 'POST', body: JSON.stringify({ ...p, forcar: true }) });
    btn.textContent = '✓ incluído';
  } catch (e) { btn.disabled = false; btn.textContent = 'Incluir mesmo assim'; alert(e.message); }
}

// "Adicionar selecionados" → vai para a etapa de VALORES (não grava ainda).
document.getElementById('piAdicionar').addEventListener('click', () => {
  piSelecionados = [...document.querySelectorAll('#piCorpoPacientes .pi-chk:checked')].map((c) => piPacientes[Number(c.dataset.idx)]);
  if (!piSelecionados.length) { alert('Selecione ao menos um paciente.'); return; }
  piMostrarEtapa('valores');
  document.getElementById('piValoresItem').innerHTML =
    `<div style="flex:1;"><div style="font-weight:500;">${escHtml(piItemAtual.descricao_item || piItemAtual.codigo_item)}</div>
       <div class="col-codigo" style="font-size:11px;">${escHtml(piItemAtual.codigo_item)} · ${fmtNumero(piSelecionados.length)} paciente(s)${piValorMedio ? ' · Valor médio ' + escHtml(piValorMedio) : ''}</div></div>`;
  renderValoresImp();
});

// Converte "1.234,56" / "1234.56" → número; vazio → null.
function piNum(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = parseFloat(String(v).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
const PI_STATUS = ['Solicitado', 'Embarque', 'Instrução Processual', 'Pendência', 'Sem cotação', 'Deserto', 'Fracassado', 'Devolvido', 'Finalizado', 'Cancelado', 'Demanda Inativa'];

function renderValoresImp() {
  const corpo = document.getElementById('piCorpoValores');
  const opt = (sel) => PI_STATUS.map((s) => `<option${s === sel ? ' selected' : ''}>${s}</option>`).join('');
  corpo.innerHTML = `<table class="tabela" style="min-width:1180px;"><thead><tr>
      <th>Paciente</th><th>Qtde Solicitada</th><th>Valor Médio Unit.</th><th>Valor Total</th>
      <th>SEI</th><th>Req. GSNET</th><th>Data Solic.</th><th>Nº Empenho</th><th>Nº Recibo</th><th>Data Entrega</th><th>Status</th>
    </tr></thead><tbody>${piSelecionados.map((p, i) => `<tr data-idx="${i}">
      <td style="font-weight:500; min-width:160px;">${escHtml(p.autor || '—')}<br><span class="col-codigo" style="font-size:10px;">${escHtml(p.unidade_dispensadora || '')}</span></td>
      <td><input type="text" class="piv-qtde" data-idx="${i}" value="${p._autonomia != null ? escAttr(String(piQtdComprar(p))) : ''}" style="width:90px;"></td>
      <td><input type="text" class="piv-valor" data-idx="${i}" value="${piValorMedio ? escAttr(piValorMedio) : ''}" style="width:100px;"></td>
      <td><input type="text" class="piv-total" data-idx="${i}" readonly style="width:110px; background:var(--realce-tabela);"></td>
      <td><input type="text" class="piv-sei" data-idx="${i}" style="width:120px;"></td>
      <td><input type="text" class="piv-req" data-idx="${i}" style="width:110px;"></td>
      <td><input type="date" class="piv-dsolic" data-idx="${i}"></td>
      <td><input type="text" class="piv-emp" data-idx="${i}" style="width:110px;"></td>
      <td><input type="text" class="piv-rec" data-idx="${i}" style="width:110px;"></td>
      <td><input type="date" class="piv-dentr" data-idx="${i}"></td>
      <td><select class="piv-status" data-idx="${i}">${opt('Solicitado')}</select></td>
    </tr>`).join('')}</tbody></table>`;
  // Recalcula o Valor Total quando muda Qtde ou Valor Médio.
  const recalc = (i) => {
    const q = piNum(corpo.querySelector(`.piv-qtde[data-idx="${i}"]`).value);
    const v = piNum(corpo.querySelector(`.piv-valor[data-idx="${i}"]`).value);
    const tot = (q != null && v != null) ? (q * v) : null;
    corpo.querySelector(`.piv-total[data-idx="${i}"]`).value = tot == null ? '' : tot.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  corpo.querySelectorAll('.piv-qtde, .piv-valor').forEach((el) => el.addEventListener('input', () => recalc(Number(el.dataset.idx))));
  piSelecionados.forEach((_, i) => recalc(i)); // calcula o Valor Total inicial (Qtde vem pré-preenchida)
}

// Repete os valores da 1ª linha nas demais.
document.getElementById('piRepetir').addEventListener('click', () => {
  const corpo = document.getElementById('piCorpoValores');
  if (piSelecionados.length < 2) return;
  // Replica APENAS SEI, Req. GSNET e Data de Solicitação da 1ª linha nas demais.
  const campos = ['piv-sei', 'piv-req', 'piv-dsolic'];
  const origem = {}; campos.forEach((c) => origem[c] = corpo.querySelector(`.${c}[data-idx="0"]`).value);
  for (let i = 1; i < piSelecionados.length; i++) {
    campos.forEach((c) => { const el = corpo.querySelector(`.${c}[data-idx="${i}"]`); if (el) el.value = origem[c]; });
  }
});

// Confirmar: cria cada paciente (POST) e grava os valores (PUT).
document.getElementById('piConfirmar').addEventListener('click', async () => {
  const corpo = document.getElementById('piCorpoValores');
  const btn = document.getElementById('piConfirmar');
  btn.disabled = true;
  const g = (cls, i) => { const el = corpo.querySelector(`.${cls}[data-idx="${i}"]`); return el ? el.value : ''; };
  let ok = 0; const erros = [];
  for (let i = 0; i < piSelecionados.length; i++) {
    const p = piSelecionados[i];
    btn.textContent = `Salvando ${i + 1}/${piSelecionados.length}…`;
    try {
      const criado = await api('/autores/compras-importados', { method: 'POST', body: JSON.stringify(p) });
      const body = {
        quantidade_solicitada: g('piv-qtde', i), valor_medio_unitario: g('piv-valor', i),
        sei: g('piv-sei', i), req_gsnet: g('piv-req', i), data_solicitacao: g('piv-dsolic', i),
        numero_empenho: g('piv-emp', i), numero_recibo: g('piv-rec', i), data_entrega: g('piv-dentr', i),
        status: g('piv-status', i) || 'Solicitado',
      };
      await api(`/autores/compras-importados/${criado.id}`, { method: 'PUT', body: JSON.stringify(body) });
      ok++;
    } catch (e) { erros.push(`${p.autor}: ${e.message}`); }
  }
  btn.disabled = false; btn.textContent = 'Confirmar e salvar';
  alert(`${ok} paciente(s) salvos no Relatório de Compras Importados.` + (erros.length ? `\n\nNão salvos (${erros.length}):\n- ` + erros.slice(0, 8).join('\n- ') : ''));
  modalPorItemImp.hidden = true;
  if (typeof carregarTabelaAutoresImportados === 'function') carregarTabelaAutoresImportados();
});

// Modal "Ver" das listagens de autores: guarda os campos na própria célula.
function btDadosDemanda(a) {
  const d = {
    autor: a.autor || '',
    descricao_item: a.descricao_item || '',
    codigo_item: a.codigo_item || '',
    id_demanda: a.id_demanda || '',
    unidade: a.unidade_dispensadora || '',
    prazo: a.prazo || '',
    periodicidade: a.periodicidade || '',
    data_ultima_dispensacao: a.data_ultima_dispensacao || '',
    data_ultimo_retorno: a.data_ultimo_retorno || '',
  };
  // atributo entre aspas simples -> escapa aspas simples; o navegador decodifica as entidades
  return JSON.stringify(d).replace(/&/g, '&amp;').replace(/'/g, '&#39;');
}

async function abrirDetalheDemanda(d) {
  document.getElementById('subDetalheDemanda').textContent =
    `${d.autor || '—'} — ${d.descricao_item || '—'}`;
  const linha = (rot, val) =>
    `<div style="display:flex; justify-content:space-between; gap:16px; padding:9px 0; border-bottom:1px solid var(--borda);">
       <span class="texto-secundario">${rot}</span><strong>${escHtml(val || '—')}</strong></div>`;
  const corpo = document.getElementById('corpoDetalheDemanda');
  const base =
    '<div id="etiquetasDetalheDemanda" style="margin:0 0 10px;"></div>' +
    linha('ID Demanda', d.id_demanda) +
    linha('Prazo', d.prazo) +
    linha('Periodicidade', d.periodicidade) +
    linha('Data Última Dispensação', d.data_ultima_dispensacao) +
    linha('Data Último Retorno', d.data_ultimo_retorno);
  // Bloco de estoque da unidade (carrega enquanto o modal já aparece).
  const rotuloUnidade = d.unidade ? escHtml(d.unidade) : 'unidade';
  corpo.innerHTML = base +
    `<div id="blocoEstoqueUnidade" style="margin-top:12px;">
       <div class="texto-secundario" style="font-weight:600; margin-bottom:2px;">Estoque — ${rotuloUnidade}</div>
       <div id="corpoEstoqueUnidade"><div style="padding:9px 0;" class="texto-secundario">Carregando…</div></div>
     </div>
     <div id="blocoIblODDemanda" style="margin-top:12px;"></div>`;
  document.getElementById('modalDetalheDemanda').hidden = false;
  injetarSaldoIblOD(d.codigo_item, 'blocoIblODDemanda');

  try {
    const params = new URLSearchParams({ codigo_item: d.codigo_item || '' });
    if (d.unidade) params.set('unidade', d.unidade);
    const e = await api(`/autores/estoque-unidade?${params.toString()}`);
    const num = (v) => (v === null || v === undefined || v === '' ? '—' : fmtNumero(v));
    const meses = (v) => (v === null || v === undefined || v === '' ? '—' : `${fmtNumero(v)} m`);
    let html =
      linha('Demanda', num(e.demanda)) +
      linha('Consumo médio mensal', num(e.consumo)) +
      linha('Estoque', num(e.estoque)) +
      linha('Autonomia', meses(e.autonomia));
    if (e.semDados) {
      html = `<div style="padding:9px 0;" class="texto-secundario">Sem dados de estoque para esta unidade.</div>` + html;
    } else if (e.data_referencia) {
      html += `<div class="texto-secundario" style="font-size:12px; margin-top:6px;">Foto de ${formatarData(e.data_referencia)}</div>`;
    }
    // O modal pode ter sido fechado/reaberto enquanto carregava — só escreve se ainda existe.
    const alvo = document.getElementById('corpoEstoqueUnidade');
    if (alvo) alvo.innerHTML = html;
    // Etiquetas de programa/subcategoria (mesmo helper e estilo do Estoque).
    const et = document.getElementById('etiquetasDetalheDemanda');
    if (et) et.innerHTML = etiquetasProgramaHTML(e);
  } catch (err) {
    const alvo = document.getElementById('corpoEstoqueUnidade');
    if (alvo) alvo.innerHTML = `<div style="padding:9px 0; color:var(--vermelho);">Não consegui carregar o estoque da unidade.</div>`;
  }
}

document.addEventListener('click', (ev) => {
  const b = ev.target.closest('.btn-ver-demanda');
  if (!b) return;
  try { abrirDetalheDemanda(JSON.parse(b.dataset.demanda)); } catch (e) { /* ignora */ }
});
document.getElementById('botaoFecharDetalheDemanda').addEventListener('click', () => {
  document.getElementById('modalDetalheDemanda').hidden = true;
});

// -------------------- Relatório de Itens (catálogo) --------------------
const estadoRelItens = { pagina: 1, pageSize: 50, filtrosCarregados: false };

let debounceRelItens;
document.getElementById('riFiltroBusca').addEventListener('input', () => {
  clearTimeout(debounceRelItens);
  debounceRelItens = setTimeout(() => { estadoRelItens.pagina = 1; carregarTabelaRelItens(); }, 350);
});
['riFiltroCategoria', 'riFiltroTipo', 'riFiltroImportado', 'riFiltroOutrasDemandas', 'riFiltroDoseCerta', 'riFiltroDoencaRara', 'riFiltroClassificacao'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => { estadoRelItens.pagina = 1; carregarTabelaRelItens(); });
});
document.getElementById('riLimparFiltros').addEventListener('click', () => {
  document.getElementById('riFiltroBusca').value = '';
  ['riFiltroCategoria', 'riFiltroTipo', 'riFiltroImportado', 'riFiltroOutrasDemandas', 'riFiltroDoseCerta', 'riFiltroDoencaRara', 'riFiltroClassificacao'].forEach((id) => { document.getElementById(id).value = ''; });
  estadoRelItens.pagina = 1; carregarTabelaRelItens();
});
document.getElementById('riAnterior').addEventListener('click', () => { if (estadoRelItens.pagina > 1) { estadoRelItens.pagina--; carregarTabelaRelItens(); } });
document.getElementById('riProximo').addEventListener('click', () => { estadoRelItens.pagina++; carregarTabelaRelItens(); });

// ---------- Importar classificação (aba Status-Siafisico) ----------
document.getElementById('botaoImportarClassificacao').addEventListener('click', () => {
  document.getElementById('arquivoClassificacao').click();
});
document.getElementById('arquivoClassificacao').addEventListener('change', async (ev) => {
  const arq = ev.target.files[0];
  if (!arq) return;
  const botao = document.getElementById('botaoImportarClassificacao');
  const rotuloOriginal = botao.textContent;
  botao.disabled = true; botao.textContent = '⏳ Importando…';
  try {
    const fd = new FormData();
    fd.append('arquivo', arq);
    const resp = await fetch('/api/relatorio-itens/classificacao/importar', { method: 'POST', body: fd });
    const dados = await resp.json();
    if (!resp.ok) throw new Error(dados.erro || 'Falha na importação.');
    alert(`Classificação importada: ${dados.total} itens (${dados.novos} novos, ${dados.atualizados} atualizados).`);
    carregarTabelaRelItens();
  } catch (e) {
    alert('Erro ao importar classificação: ' + e.message);
  } finally {
    botao.disabled = false; botao.textContent = rotuloOriginal;
    ev.target.value = '';
  }
});

// ---------- Editar classificação de um item ----------
let codigoClassificacaoAtual = null;
async function abrirModalClassificacao(codigo, descricao) {
  codigoClassificacaoAtual = codigo;
  document.getElementById('descClassificacao').textContent = descricao || '';
  document.getElementById('codigoClassificacao').textContent = codigo;
  // valores em branco enquanto carrega
  document.getElementById('clasDoseCerta').value = '';
  document.getElementById('clasDoencaRara').value = '';
  document.getElementById('clasUnidadeForn').value = '';
  document.getElementById('clasEmbConversao').value = '';
  document.getElementById('clasOutrosProgramas').value = '';
  document.getElementById('clasQualPrograma').value = '';
  document.getElementById('clasSubcategoria').value = '';
  document.getElementById('clasResponsavel').value = '';
  document.getElementById('clasInex').value = '';
  atualizarVisibilidadeQualPrograma();
  document.getElementById('modalClassificacao').hidden = false;
  try {
    const c = await api(`/relatorio-itens/classificacao/${encodeURIComponent(codigo)}`);
    document.getElementById('clasDoseCerta').value = c.dose_certa || '';
    document.getElementById('clasDoencaRara').value = c.doenca_rara || '';
    document.getElementById('clasUnidadeForn').value = c.unidade_fornecimento || '';
    document.getElementById('clasEmbConversao').value = c.embalagem_conversao != null ? c.embalagem_conversao : '';
    document.getElementById('clasOutrosProgramas').value = c.outros_programas || '';
    document.getElementById('clasQualPrograma').value = c.qual_programa || '';
    document.getElementById('clasSubcategoria').value = c.subcategoria || '';
    document.getElementById('clasResponsavel').value = c.responsavel_aquisicao || '';
    document.getElementById('clasInex').value = c.inex || '';
    atualizarVisibilidadeQualPrograma();
  } catch (e) { /* mantém em branco */ }
}
// Mostra o campo "Qual programa?" só quando Outros Programas = Sim.
function atualizarVisibilidadeQualPrograma() {
  const sim = document.getElementById('clasOutrosProgramas').value === 'Sim';
  document.getElementById('rotuloQualPrograma').hidden = !sim;
  if (!sim) document.getElementById('clasQualPrograma').value = '';
}
document.getElementById('clasOutrosProgramas').addEventListener('change', atualizarVisibilidadeQualPrograma);
function fecharModalClassificacao() {
  document.getElementById('modalClassificacao').hidden = true;
  codigoClassificacaoAtual = null;
}
document.getElementById('botaoFecharClassificacao').addEventListener('click', fecharModalClassificacao);
document.getElementById('botaoSalvarClassificacao').addEventListener('click', async () => {
  if (!codigoClassificacaoAtual) return;
  const botao = document.getElementById('botaoSalvarClassificacao');
  botao.disabled = true;
  try {
    await api(`/relatorio-itens/classificacao/${encodeURIComponent(codigoClassificacaoAtual)}`, {
      method: 'PUT',
      body: JSON.stringify({
        dose_certa: document.getElementById('clasDoseCerta').value || null,
        doenca_rara: document.getElementById('clasDoencaRara').value || null,
        unidade_fornecimento: document.getElementById('clasUnidadeForn').value.trim() || null,
        embalagem_conversao: document.getElementById('clasEmbConversao').value || null,
        outros_programas: document.getElementById('clasOutrosProgramas').value || null,
        qual_programa: document.getElementById('clasQualPrograma').value.trim() || null,
        subcategoria: document.getElementById('clasSubcategoria').value.trim() || null,
        responsavel_aquisicao: document.getElementById('clasResponsavel').value.trim() || null,
        inex: document.getElementById('clasInex').value || null,
      }),
    });
    fecharModalClassificacao();
    carregarTabelaRelItens();
    if (!document.getElementById('abaRelItensPlanTP').hidden) carregarTabelaPlanTP();
  } catch (e) {
    alert('Erro ao salvar: ' + e.message);
  } finally {
    botao.disabled = false;
  }
});

async function carregarRelatorioItens() {
  if (!estadoRelItens.filtrosCarregados) {
    try {
      const f = await api('/relatorio-itens/filtros');
      const preencher = (id, valores, rotulo) => {
        document.getElementById(id).innerHTML = `<option value="">${rotulo}</option>` +
          valores.map((v) => `<option value="${v.replace(/"/g, '&quot;')}">${v}</option>`).join('');
      };
      preencher('riFiltroCategoria', f.categoria, 'Categoria: todas');
      preencher('riFiltroTipo', f.tipo_item, 'Tipo item: todos');
      preencher('riFiltroImportado', f.importado, 'Importado: todos');
      preencher('riFiltroOutrasDemandas', f.outras_demandas, 'Outras demandas: todas');
      estadoRelItens.filtrosCarregados = true;
    } catch (e) { /* segue */ }
  }
  carregarTabelaRelItens();
}

async function carregarTabelaRelItens() {
  const params = new URLSearchParams({ page: estadoRelItens.pagina, pageSize: estadoRelItens.pageSize });
  const q = document.getElementById('riFiltroBusca').value.trim();
  if (q) params.set('q', q);
  const mapa = { categoria: 'riFiltroCategoria', tipo_item: 'riFiltroTipo', importado: 'riFiltroImportado', outras_demandas: 'riFiltroOutrasDemandas',
    dose_certa: 'riFiltroDoseCerta', doenca_rara: 'riFiltroDoencaRara', classificacao: 'riFiltroClassificacao' };
  for (const [param, id] of Object.entries(mapa)) { const v = document.getElementById(id).value; if (v) params.set(param, v); }

  const dados = await api(`/relatorio-itens?${params.toString()}`);

  document.getElementById('grideResumoRelItens').innerHTML = `
    <div class="cartao-resumo"><div class="numero">${fmtNumero(dados.total)}</div><div class="rotulo">Itens${q ? ' filtrados' : ' no catálogo'}</div></div>
    <div class="cartao-resumo"><div class="numero" style="font-size:18px;">${dados.dataReferencia ? formatarData(dados.dataReferencia) : '—'}</div><div class="rotulo">Data do arquivo${horaImportacao(dados.dataImportacao)}</div></div>
  `;

  const corpo = document.getElementById('corpoTabelaRelItens');
  const vazio = document.getElementById('estadoVazioRelItens');
  if (dados.itens.length === 0) {
    corpo.innerHTML = ''; vazio.hidden = false;
  } else {
    vazio.hidden = true;
    const ehAdmin = estado.usuario && estado.usuario.perfil === 'admin';
    const marca = (v) => {
      if (v === 'Sim') return '<span class="etiqueta-status finalizado">Sim</span>';
      if (v === 'Não') return '<span class="etiqueta-status">Não</span>';
      return '—';
    };
    corpo.innerHTML = dados.itens.map((i) => `
      <tr>
        <td class="col-codigo">${i.codigo || '—'}</td>
        <td class="col-codigo">${i.catmat || '—'}</td>
        <td class="col-codigo">${i.siafisico || '—'}</td>
        <td>${i.descricao_item || '—'}</td>
        <td>${i.categoria || '—'}</td>
        <td>${i.apresentacao || '—'}</td>
        <td>${i.importado || '—'}</td>
        <td>${i.tipo_item || '—'}</td>
        <td>${i.outras_demandas || '—'}</td>
        <td>${marca(i.clas_dose_certa)}</td>
        <td>${marca(i.clas_doenca_rara)}</td>
        <td>${i.clas_unidade_fornecimento || '—'}</td>
        <td style="text-align:right;">${i.clas_embalagem_conversao != null ? fmtNumero(i.clas_embalagem_conversao) : '<span style="color:var(--aviso,#b8860b);">pendente</span>'}</td>
        <td>${marca(i.clas_inex)}</td>
        <td>${ehAdmin
          ? `<button class="botao-editar" data-codigo="${encodeURIComponent(i.codigo || '')}" data-desc="${(i.descricao_item || '').replace(/"/g, '&quot;')}">Editar</button>`
          : '—'}</td>
      </tr>
    `).join('');
    corpo.querySelectorAll('.botao-editar').forEach((btn) => {
      btn.addEventListener('click', () => abrirModalClassificacao(decodeURIComponent(btn.dataset.codigo), btn.dataset.desc));
    });
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoRelItens').textContent =
    `Página ${dados.page} de ${totalPaginas} · ${fmtNumero(dados.total)} item(ns)`;
  document.getElementById('riAnterior').disabled = dados.page <= 1;
  document.getElementById('riProximo').disabled = dados.page >= totalPaginas;
}

// -------------------- Aba "Planejamento TP" --------------------
// Só itens da Tenente Pena (Estoque TP mais recente, demanda ≠ 0), com a
// mesma classificação permanente editável pelo modal.
const estadoPlanTP = { pagina: 1, pageSize: 50, carregouUmaVez: false, categoriasCarregadas: false };

async function carregarCategoriasPlanTP() {
  if (estadoPlanTP.categoriasCarregadas) return;
  try {
    const r = await api('/relatorio-itens/planejamento-tp/categorias');
    document.getElementById('ptpFiltroCategoria').innerHTML = '<option value="">Categoria: todas</option>' +
      (r.categorias || []).map((v) => `<option value="${v.replace(/"/g, '&quot;')}">${v}</option>`).join('');
    document.getElementById('ptpFiltroResponsavel').innerHTML = '<option value="">Responsável: todos</option>' +
      (r.responsaveis || []).map((v) => `<option value="${v.replace(/"/g, '&quot;')}">${v}</option>`).join('');
    // SubCategoria = seleção múltipla por checkboxes.
    document.getElementById('ptpFiltroSubPainel').innerHTML = (r.subcategorias || []).map((v) => {
      const esc = v.replace(/"/g, '&quot;');
      return `<label style="display:flex; align-items:center; gap:6px; padding:3px 0; cursor:pointer; white-space:nowrap;">
        <input type="checkbox" class="ptp-sub-check" value="${esc}"> ${v}</label>`;
    }).join('') || '<span style="color:var(--texto-suave);">Sem subcategorias (importe a planilha REL).</span>';
    document.querySelectorAll('.ptp-sub-check').forEach((cb) => cb.addEventListener('change', () => {
      atualizarRotuloSubPlanTP(); estadoPlanTP.pagina = 1; carregarTabelaPlanTP();
    }));
    estadoPlanTP.categoriasCarregadas = true;
  } catch (e) { /* segue sem o filtro */ }
}

// Troca entre as abas Catálogo / Planejamento TP
document.querySelectorAll('#abasRelItens .chip-faixa').forEach((btn) => {
  btn.addEventListener('click', () => {
    const aba = btn.dataset.aba;
    document.querySelectorAll('#abasRelItens .chip-faixa').forEach((b) => b.classList.toggle('ativo', b === btn));
    document.getElementById('abaRelItensCatalogo').hidden = aba !== 'catalogo';
    document.getElementById('abaRelItensPlanTP').hidden = aba !== 'plantp';
    if (aba === 'plantp' && !estadoPlanTP.carregouUmaVez) {
      estadoPlanTP.carregouUmaVez = true;
      carregarCategoriasPlanTP();
      carregarTabelaPlanTP();
    }
  });
});

let debouncePlanTP;
document.getElementById('ptpFiltroBusca').addEventListener('input', () => {
  clearTimeout(debouncePlanTP);
  debouncePlanTP = setTimeout(() => { estadoPlanTP.pagina = 1; carregarTabelaPlanTP(); }, 350);
});
['ptpFiltroClassificacao', 'ptpFiltroCategoria', 'ptpFiltroResponsavel', 'ptpFiltroNovos'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => { estadoPlanTP.pagina = 1; carregarTabelaPlanTP(); });
});
document.getElementById('ptpLimparFiltros').addEventListener('click', () => {
  document.getElementById('ptpFiltroBusca').value = '';
  document.getElementById('ptpFiltroClassificacao').value = '';
  document.getElementById('ptpFiltroCategoria').value = '';
  document.getElementById('ptpFiltroResponsavel').value = '';
  document.getElementById('ptpFiltroNovos').value = '';
  document.querySelectorAll('.ptp-sub-check').forEach((cb) => { cb.checked = false; });
  atualizarRotuloSubPlanTP();
  estadoPlanTP.pagina = 1; carregarTabelaPlanTP();
});
// Dropdown de SubCategoria (seleção múltipla)
function subcategoriasSelecionadasPlanTP() {
  return [...document.querySelectorAll('.ptp-sub-check:checked')].map((cb) => cb.value);
}
function atualizarRotuloSubPlanTP() {
  const n = subcategoriasSelecionadasPlanTP().length;
  document.getElementById('ptpFiltroSubBotao').textContent = n === 0 ? 'SubCategoria: todas ▾' : `SubCategoria: ${n} selecionada(s) ▾`;
}
document.getElementById('ptpFiltroSubBotao').addEventListener('click', (ev) => {
  ev.stopPropagation();
  const p = document.getElementById('ptpFiltroSubPainel');
  p.hidden = !p.hidden;
});
document.addEventListener('click', (ev) => {
  const wrap = document.getElementById('ptpFiltroSubWrap');
  if (wrap && !wrap.contains(ev.target)) document.getElementById('ptpFiltroSubPainel').hidden = true;
});
// Monta os parâmetros de filtro atuais da aba TP (compartilhado por tabela e exportação).
function paramsFiltroPlanTP() {
  const p = new URLSearchParams();
  const q = document.getElementById('ptpFiltroBusca').value.trim();
  if (q) p.set('q', q);
  const cls = document.getElementById('ptpFiltroClassificacao').value;
  if (cls) p.set('classificacao', cls);
  const cat = document.getElementById('ptpFiltroCategoria').value;
  if (cat) p.set('categoria', cat);
  const resp = document.getElementById('ptpFiltroResponsavel').value;
  if (resp) p.set('responsavel', resp);
  subcategoriasSelecionadasPlanTP().forEach((s) => p.append('subcategoria', s));
  const nov = document.getElementById('ptpFiltroNovos').value;
  if (nov) p.set('novos', nov);
  return p;
}
document.getElementById('ptpExportar').addEventListener('click', () => {
  // Navegação direta dispara o download; o cookie de sessão vai junto (mesma origem).
  window.location.href = `/api/relatorio-itens/planejamento-tp/exportar?${paramsFiltroPlanTP().toString()}`;
});
document.getElementById('ptpAnterior').addEventListener('click', () => { if (estadoPlanTP.pagina > 1) { estadoPlanTP.pagina--; carregarTabelaPlanTP(); } });
document.getElementById('ptpProximo').addEventListener('click', () => { estadoPlanTP.pagina++; carregarTabelaPlanTP(); });

// Aquisição por unidade fracionada (Dose, Mililitro, Grama) — exige conversão de
// embalagem, então a linha é destacada na tela para conferência do Rafael.
// Casa tanto os puros ("MILILITRO", "GRAMA", "DOSE") quanto os compostos
// ("FRASCO 30 MILILITRO", "AMPOLA 10 ML", "BISNAGA 30 GR", "Frasco 200 Doses").
function unidadeAquisicaoFracionada(u) {
  if (!u) return false;
  const t = String(u).toLowerCase();
  return /(^|[^a-zà-ú])(dose|doses|mililitro|mililitros|mlilitro|ml|grama|gramas|gr)([^a-zà-ú]|$)/.test(t);
}

// ==================== Planejamento de Compras ====================
// Estado da última simulação (para as próximas partes: ajuste/salvar/exportar).
const estadoPlanejamento = { parametros: null, linhas: [], resumo: null, filtros: { modalidade: '', categoria: '', subcategorias: [], soFrac: false, soComprar: false, busca: '' } };

// Popula as opções de Categoria e SubCategoria a partir dos itens gerados.
function popularFiltrosCategoriaPlan() {
  const L = estadoPlanejamento.linhas;
  const cats = [...new Set(L.map((l) => l._categoria).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const subs = [...new Set(L.map((l) => l._subcategoria).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const selCat = document.getElementById('planFiltroCategoria');
  if (selCat) selCat.innerHTML = '<option value="">Categoria: todas</option>' +
    cats.map((v) => `<option value="${escaparAttr(v)}">${v}</option>`).join('');
  const painel = document.getElementById('planFiltroSubPainel');
  if (painel) painel.innerHTML = subs.length
    ? subs.map((v) => `<label style="display:flex; align-items:center; gap:6px; padding:3px 0; cursor:pointer; white-space:nowrap;"><input type="checkbox" class="plan-sub-check" value="${escaparAttr(v)}"> ${v}</label>`).join('')
    : '<span style="color:var(--texto-suave);">Sem subcategorias (preencha na classificação).</span>';
  document.querySelectorAll('.plan-sub-check').forEach((cb) => cb.addEventListener('change', () => {
    estadoPlanejamento.filtros.subcategorias = [...document.querySelectorAll('.plan-sub-check:checked')].map((x) => x.value);
    const n = estadoPlanejamento.filtros.subcategorias.length;
    document.getElementById('planFiltroSubBotao').textContent = n === 0 ? 'SubCategoria: todas ▾' : `SubCategoria: ${n} selecionada(s) ▾`;
    aplicarFiltrosPlanejamento();
  }));
}

// Re-renderiza a tabela aplicando os filtros atuais (modalidade/busca/marcados).
function aplicarFiltrosPlanejamento() {
  if (estadoPlanejamento.linhas.length) desenharTabelaPlanejamento(estadoPlanejamento.linhas);
}

// Ao abrir a tela: busca os parâmetros-padrão (datas das fotos) e preenche.
async function carregarPlanejamento() {
  try {
    const p = await api('/planejamento/parametros-padrao');
    document.getElementById('planAlvoAta').value = p.autonomiaAlvoAta ?? 6;
    document.getElementById('planAlvoPregao').value = p.autonomiaAlvoPregao ?? 9;
    document.getElementById('planCorte').value = p.cortePoucaDemanda ?? 3;
    const f = p.fotos || {};
    document.getElementById('planBaseInfo').innerHTML =
      `Base de cálculo — Estoque: <strong>${formatarData(f.estoque)}</strong> · ` +
      `Consumo LOIS: <strong>${formatarData(f.lois)}</strong> · ` +
      `Carta de Troca: <strong>${formatarData(f.carta)}</strong> · ` +
      `Irregulares: <strong>${formatarData(f.irregular)}</strong> · ` +
      `Atas: <strong>${formatarData(f.atas)}</strong>`;
  } catch (e) {
    document.getElementById('planBaseInfo').textContent = 'Não foi possível ler as datas-base: ' + e.message;
  }
  aplicarPermissoesPlanejamento();
}

// Roda o motor no servidor (/simular) com os parâmetros da tela e desenha.
async function gerarPlanejamento() {
  const botao = document.getElementById('botaoGerarPlan');
  const corpo = document.getElementById('corpoPlanejamento');
  const opcoes = {
    unidade: 'TP',
    autonomiaAlvoAta: Number(document.getElementById('planAlvoAta').value) || 0,
    autonomiaAlvoPregao: Number(document.getElementById('planAlvoPregao').value) || 0,
    cortePoucaDemanda: Number(document.getElementById('planCorte').value) || 0,
    incluirZerados: document.getElementById('planIncluirZerados').checked,
  };
  botao.disabled = true;
  const rotulo = botao.textContent;
  botao.textContent = '⏳ Calculando…';
  corpo.innerHTML = '<tr><td colspan="15" style="text-align:center; padding:24px; color:#888;">Calculando…</td></tr>';
  try {
    const r = await api('/planejamento/simular', { method: 'POST', body: JSON.stringify(opcoes) });
    estadoPlanejamento.parametros = r.parametros;
    estadoPlanejamento.linhas = r.linhas || [];
    // A autonomia ajustada começa igual à sugerida (o usuário pode alterar).
    estadoPlanejamento.linhas.forEach((l) => {
      if (l.autonomia_ajustada === null || l.autonomia_ajustada === undefined) {
        l.autonomia_ajustada = l.autonomia_sugerida;
      }
    });
    estadoPlanejamento.resumo = r.resumo;
    marcarEditando(null); // planejamento recém-gerado ainda não foi salvo
    // reinicia os filtros de categoria/subcategoria com o novo conjunto de itens
    estadoPlanejamento.filtros.categoria = '';
    estadoPlanejamento.filtros.subcategorias = [];
    const subBtn = document.getElementById('planFiltroSubBotao');
    if (subBtn) subBtn.textContent = 'SubCategoria: todas ▾';
    popularFiltrosCategoriaPlan();
    desenharResumoPlanejamento(r.resumo);
    desenharTabelaPlanejamento(estadoPlanejamento.linhas);
  } catch (e) {
    corpo.innerHTML = `<tr><td colspan="15" style="text-align:center; padding:24px; color:#c0392b;">Erro: ${e.message}</td></tr>`;
  } finally {
    botao.disabled = false;
    botao.textContent = rotulo;
  }
}

function desenharResumoPlanejamento(resumo) {
  const alvo = document.getElementById('planResumo');
  if (!resumo) { alvo.innerHTML = ''; return; }
  const custo = (resumo.custo_total_ata || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  alvo.innerHTML = `
    <div class="painel-tile"><div class="numero">${fmtNumero(resumo.total_itens)}</div><div class="rotulo">Itens no planejamento</div></div>
    <div class="painel-tile"><div class="numero">${fmtNumero(resumo.ata)}</div><div class="rotulo">Por ATA</div></div>
    <div class="painel-tile"><div class="numero">${fmtNumero(resumo.pregao)}</div><div class="rotulo">Por Pregão</div></div>
    <div class="painel-tile"><div class="numero">${fmtNumero(resumo.inex || 0)}</div><div class="rotulo">Por Inex</div></div>
    <div class="painel-tile${resumo.revisar ? ' critico' : ''}"><div class="numero">${fmtNumero(resumo.revisar || 0)}</div><div class="rotulo">⚠ Revisar (marca)</div></div>
    <div class="painel-tile"><div class="numero">${fmtNumero(resumo.com_quantidade)}</div><div class="rotulo">Com quantidade a comprar</div></div>
    <div class="painel-tile"><div class="numero" style="font-size:20px;">${custo}</div><div class="rotulo">Custo estimado (total)</div></div>`;
}

// MROUND igual ao do backend (planejamentoMotor.js): arredonda ao múltiplo de m.
function mroundFront(x, m) {
  if (!Number.isFinite(x)) return null;
  const passo = Number.isFinite(m) && m > 0 ? m : 1;
  return Math.round(x / passo) * passo;
}

const brlPlan = (v) => v === null || v === undefined ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function escaparAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Cabeçalhos dos modelos (mesma ordem/nomes do export 10.ATA / 11.PREGÃO).
const CAB_ATA_MODELO = [
  'Nº Cont.', 'Nº', 'Código Scodes', 'Código Siafisico', 'Item', 'Unidade de Medida',
  'Real Necessidade (Judicial)', 'Real Necessidade (ADM)', 'Real Necessidade (Total)',
  'Autonomia de Compra', 'Consumo Mensal Total Ata Comprar',
  '(%) JUD Atend. Único', '(%) JUD Demandas/Dispens.', '(%) ADM Atend. Único', '(%) ADM Demandas/Dispens.',
  'Demanda Irregular SIM', 'Qtd. Demanda Irregular', 'Periodicidade Média', 'Reservados Nominal',
  'Carta de Troca', 'Compras Ant. Empenhado', 'Compras Ant. Solicitado', 'Análise Crítica',
  'Aut. Aquis. (k) + Análise Crítica', 'Qtde Financeira (Jud)', 'Qtde Financeira (ADM)', 'Qtde Financeira (Total)',
  'Embalagem', 'Conversão', 'Qtde Embalagem (Jud)', 'Qtde Embalagem (ADM)', 'Qtde Embalagem (Total)',
  'Preço Unitário', 'Custo (Jud)', 'Custo (ADM)', 'Custo (Total)', 'Ata', 'Validade',
  'Demandas UDTP (Jud)', 'Demandas UDTP (ADM)', 'Demandas Total UDTP',
  'Consumo UDTP (Jud)', 'Consumo UDTP (ADM)', 'Consumo Total UDTP', 'Consumo LOIS', 'Consumo LOIS %',
  'Estoque UDTP', 'Aut. Estoque UDTP', 'Entrega', 'Recurso', 'CATMAT',
  'Status (Técnico)', 'Observação Demanda', 'Observações Gerais', 'MODALIDADE',
  'Emb. Primária', 'Emb. Secundária', 'Detentor', 'Tramitado Processo', 'Data', 'EGRP', '',
];
const CAB_PREGAO_MODELO = [
  'Calc Seq.', 'N° Itens', 'Código', 'Siafísico', 'CATMAT', 'Status', 'Embalagem Conversão', 'Item',
  'Demandas UDTP Jud', 'Demandas UDTP ADM', 'Demandas UDTP (Total)',
  'Consumo UDTP Jud', 'Consumo UDTP ADM', 'Consumo UDTP (Total)', 'Consumo UDTP (LOIS)', 'Consumo UDTP (LOIS) %',
  'Estoque', 'Aut. Estoque UDTP', 'Reserva Nominal', 'Solic. Ant. Solicitado', 'Solic. Ant. Empenhado',
  'Aut. Solic. Anterior', 'Análise Crítica', 'Carta de Troca', 'Aut. Carta de Troca',
  'AUTONOMIA DE COMPRA', 'Consumo Mensal Total Comprar',
  '(%) Atend. Único JUD', '(%) Demandas/Dispens. JUD', '(%) Atend. Único ADM', '(%) Demandas/Dispens. ADM',
  'PERIODICIDADE', 'Demanda Irregular SIM', 'Qtd. Demanda Irregular', 'Unid. Forn. SCODES',
  'Aquis. Necess. SCODES (Jud)', 'Aquis. Necess. SCODES (ADM)', 'Aquis. Necess. SCODES (Total)',
  'Unid. Forn. Siafísico', 'Qtd Comprar Unid Forn (Jud)', 'Qtd Comprar Unid Forn (ADM)', 'Qtd Comprar Unid Forn (Total)',
  'Custo Unitário (R$)', 'Custo (Jud)', 'Custo (ADM)', 'Custo (Total)', 'Entrega', 'Recurso',
  'MARCA / SEM MARCA', 'Doenças Raras', 'Status Comprar', 'Status (Comitê)', 'Observação Demanda', 'MODALIDADE', '',
];

// Um item passa pelos filtros atuais? (mantém data-idx = índice no array completo)
function linhaVisivelPlan(l) {
  const f = estadoPlanejamento.filtros || {};
  if (f.modalidade && l._modalidade !== f.modalidade) return false;
  if (f.categoria && (l._categoria || '') !== f.categoria) return false;
  if (f.subcategorias && f.subcategorias.length && !f.subcategorias.includes(l._subcategoria || '')) return false;
  if (f.soFrac && !unidadeAquisicaoFracionada(l.unidade_fornecimento)) return false;
  if (f.soComprar && !l.comprar) return false;
  if (f.busca) {
    const alvo = `${l.descricao || ''} ${l.siafisico || ''} ${l._marca_estoque || ''} ${l.codigo_item || ''}`.toLowerCase();
    if (!alvo.includes(f.busca)) return false;
  }
  return true;
}

// Formatação p/ os layouts de modelo.
const _n = (v) => (v == null || v === '' || !isFinite(Number(v))) ? '' : fmtNumero(v);
const _pf = (v) => (v == null || v === '') ? '' : (Number(v) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
const _mo = (v) => (v == null || v === '' || !isFinite(Number(v))) ? '' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const _td = (v, cls) => `<td${cls ? ' class="' + cls + '"' : ''} style="text-align:right;">${v}</td>`;
const _tdE = (v) => `<td>${v ?? ''}</td>`; // texto à esquerda

// Inputs editáveis (as classes são capturadas por onEdicaoPlanejamento).
const _inAut = (l) => `<td style="text-align:right;"><input type="number" class="plan-aut" value="${l.autonomia_ajustada ?? ''}" step="0.5" min="0" style="width:56px;text-align:right;"></td>`;
const _inEmb = (l) => `<td style="text-align:right;"><input type="number" class="plan-emb" value="${l._emb_passo ?? ''}" step="1" min="0" style="width:54px;text-align:right;" title="Embalagem (passo do arredondamento)"></td>`;
const _inConv = (l) => `<td style="text-align:right;"><input type="number" class="plan-conv" value="${l.embalagem_conversao ?? ''}" step="1" min="0" style="width:54px;text-align:right;" title="Conversão (frasco→ml/g/dose)"></td>`;
const _selComprar = (l) => `<td><select class="plan-comprar-sel" style="width:118px;"><option value="Comprar"${l.comprar ? ' selected' : ''}>Comprar</option><option value="Não comprar"${!l.comprar ? ' selected' : ''}>Não comprar</option></select></td>`;
const _inObs = (l) => `<td><input type="text" class="plan-obs" value="${escaparAttr(l.observacao)}" placeholder="—" style="width:130px;"></td>`;
function _selMod(l) {
  const fz = l._modalidade_forcada;
  return `<td><select class="plan-modalidade" style="width:92px;">
    <option value=""${!fz ? ' selected' : ''}>Auto</option>
    <option value="ATA"${fz === 'ATA' ? ' selected' : ''}>ATA</option>
    <option value="PREGAO"${fz === 'PREGAO' ? ' selected' : ''}>Pregão</option>
    <option value="INEX"${fz === 'INEX' ? ' selected' : ''}>Inex</option>
  </select></td>`;
}

// Valores derivados (split Jud/ADM/Total etc.), iguais aos do export.
function _ctxLinha(l) {
  const autC = Number(l.autonomia_ajustada ?? l.autonomia_sugerida) || 0;
  const consumo = Number(l.consumo_mensal) || 0;
  const cJ = Number(l._consumo_aj); const temJ = Number.isFinite(cJ);
  const cA = temJ ? Math.max(0, consumo - cJ) : consumo;
  const dJ = Number(l._demanda_aj); const dTot = Number(l.demanda_total) || 0;
  const dA = Number.isFinite(dJ) ? Math.max(0, dTot - dJ) : '';
  const passo = Number(l._emb_passo) > 0 ? Number(l._emb_passo) : (Number(l.embalagem_conversao) > 0 ? Number(l.embalagem_conversao) : 1);
  const qJ = Number(l._qtd_jud), qA = Number(l._qtd_adm), qT = Number(l.quantidade_calculada) || 0;
  const preco = l.preco_unitario;
  const custo = (q) => (preco != null && Number.isFinite(q)) ? q * preco : '';
  const mr = (x) => mroundFront(x, passo);
  const existente = Number(l.autonomia_existente);
  return {
    autC, consumo, cJ, cA, temJ, dJ, dA, dTot, passo,
    qJ: temJ ? qJ : '', qA: temJ ? qA : '', qT, preco,
    finJ: temJ ? autC * cJ : '', finA: temJ ? autC * cA : '', finT: autC * consumo,
    realJ: temJ ? mr(autC * cJ) : '', realA: temJ ? mr(autC * cA) : '',
    custoJ: temJ ? custo(qJ) : '', custoA: temJ ? custo(qA) : '', custoT: custo(qT),
    autTotal: Number.isFinite(existente) ? existente + autC : '',
    autEstoque: consumo > 0 ? l.estoque / consumo : '',
    autSolic: consumo > 0 ? ((Number(l.empenhado) || 0) + (Number(l.solicitado) || 0)) / consumo : '',
    autCarta: (consumo > 0 && l.carta_troca) ? Number(l.carta_troca) / consumo : '',
    kCol: consumo > 0 ? qT / consumo : '',
  };
}

function celulasAta(l, seq) {
  const c = _ctxLinha(l);
  const realT = (c.realJ !== '' && c.realA !== '') ? c.realJ + c.realA : '';
  return [
    _tdE(''), _td(seq), _tdE(l.codigo_item), _tdE(l.siafisico), _tdE(l.descricao), _tdE(l.unidade_fornecimento),
    _td(_n(c.realJ)), _td(_n(c.realA)), _td(_n(realT)),
    _inAut(l), _td(_n(c.kCol)),
    _td(_pf(l._pct_unico_jud)), _td(_pf(l._pct_disp_jud)), _td(_pf(l._pct_unico_adm)), _td(_pf(l._pct_disp_adm)),
    _td(l.irregular ? 'SIM' : ''), _td(''), _td(_n(l._periodicidade)), _td(''), _td(_n(l.carta_troca)),
    _td(_n(l.empenhado)), _td(_n(l.solicitado)), _td(_n(l.autonomia_existente)), _td(_n(c.autTotal)),
    _td(_n(c.finJ)), _td(_n(c.finA)), _td(_n(c.finT)),
    _inEmb(l), _inConv(l),
    _td(_n(c.qJ), 'cel-qj'), _td(_n(c.qA), 'cel-qa'), _td(_n(c.qT), 'cel-qt'),
    _td(_mo(c.preco)), _td(_mo(c.custoJ), 'cel-cj'), _td(_mo(c.custoA), 'cel-ca'), _td(_mo(c.custoT), 'cel-custo'),
    _tdE(l.ata_numero), _tdE(formatarData(l.ata_validade)),
    _td(_n(c.temJ ? c.dJ : '')), _td(_n(c.dA)), _td(_n(c.dTot)),
    _td(_n(c.temJ ? c.cJ : '')), _td(_n(c.cA)), _td(_n(c.consumo)),
    _td(_n(l._consumo_lois)), _td(_pf(l._percent_lois)), _td(_n(l.estoque)), _td(_n(c.autEstoque)),
    _tdE('Única'), _tdE('Tesouro'), _tdE(l.catmat),
    _selComprar(l), _tdE(''), _inObs(l), _selMod(l),
    _tdE(l._ata_emb_primaria), _tdE(l._ata_emb_secundaria), _tdE(l._detentor),
    _tdE(''), _tdE(''), _tdE(''), _tdE(''),
  ].join('');
}

function celulasPregao(l, seq) {
  const c = _ctxLinha(l);
  const aqJ = c.temJ ? mroundFront(c.autC * c.cJ, 1) : '';
  const aqA = c.temJ ? mroundFront(c.autC * c.cA, 1) : '';
  const aqT = (aqJ !== '' && aqA !== '') ? aqJ + aqA : '';
  const conv = Number(l.embalagem_conversao) > 0 ? Number(l.embalagem_conversao) : 1;
  const aaCol = c.consumo > 0 ? c.qT / c.consumo / conv : '';
  const analiseCrit = c.consumo > 0
    ? ((Number(l.estoque) || 0) + (Number(l.solicitado) || 0) + (Number(l.empenhado) || 0)) / c.consumo + c.autC : '';
  return [
    _tdE(''), _td(seq), _tdE(l.codigo_item), _tdE(l.siafisico), _tdE(l.catmat), _tdE(''),
    _inConv(l), _tdE(l.descricao),
    _td(_n(c.temJ ? c.dJ : '')), _td(_n(c.dA)), _td(_n(c.dTot)),
    _td(_n(c.temJ ? c.cJ : '')), _td(_n(c.cA)), _td(_n(c.consumo)),
    _td(_n(l._consumo_lois)), _td(_pf(l._percent_lois)), _td(_n(l.estoque)), _td(_n(c.autEstoque)),
    _td(''), _td(_n(l.solicitado)), _td(_n(l.empenhado)), _td(_n(c.autSolic)), _td(_n(analiseCrit)),
    _td(_n(l.carta_troca)), _td(_n(c.autCarta)),
    _inAut(l), _td(_n(aaCol)),
    _td(_pf(l._pct_unico_jud)), _td(_pf(l._pct_disp_jud)), _td(_pf(l._pct_unico_adm)), _td(_pf(l._pct_disp_adm)),
    _td(_n(l._periodicidade)), _td(l.irregular ? 'SIM' : ''), _td(''),
    _tdE(l.unidade_fornecimento), _td(_n(aqJ)), _td(_n(aqA)), _td(_n(aqT)),
    _tdE(''), _td(_n(c.qJ), 'cel-qj'), _td(_n(c.qA), 'cel-qa'), _td(_n(c.qT), 'cel-qt'),
    _td(_mo(c.preco)), _td(_mo(c.custoJ), 'cel-cj'), _td(_mo(c.custoA), 'cel-ca'), _td(_mo(c.custoT), 'cel-custo'),
    _tdE('ÚNICA'), _tdE('TESOURO'), _tdE(l._marca_estoque), _tdE(''),
    _selComprar(l), _tdE(''), _inObs(l), _selMod(l), _tdE(''),
  ].join('');
}

function celulasCompacto(l) {
  const revisar = l._modalidade === 'REVISAR';
  const modLabel = l._modalidade === 'ATA' ? 'ATA' : (revisar ? '⚠ Revisar' : (l._modalidade === 'INEX' ? 'Inex' : 'Pregão'));
  const modClasse = (l._modalidade || '').toLowerCase();
  const marcaTitle = escaparAttr(`Marca (estoque): ${l._marca_estoque || '—'}  |  Nome comercial (ata): ${l._ata_nome_comercial || '—'}`);
  const passo = Number(l._emb_passo) > 0 ? Number(l._emb_passo) : (Number(l.embalagem_conversao) > 0 ? Number(l.embalagem_conversao) : 1);
  return `<td style="text-align:center;"><input type="checkbox" class="plan-comprar" ${l.comprar ? 'checked' : ''}></td>
    <td>${valorCelula(l.descricao)}</td>
    <td>${valorCelula(l.siafisico)}</td>
    <td class="cel-mod" title="${marcaTitle}"><span class="badge-mod badge-${modClasse}">${modLabel}</span>${_selMod(l).replace('<td>', '').replace('</td>', '')}</td>
    <td>${valorCelula(l.unidade_fornecimento)}</td>
    <td style="text-align:right;">${fmtNumero(l.consumo_mensal)}</td>
    <td style="text-align:right;">${_pf(l._percent_lois) || '—'}</td>
    <td style="text-align:right;">${fmtNumero(l.estoque)}</td>
    <td style="text-align:right;">${fmtNumero(l.empenhado)}</td>
    <td style="text-align:right;">${fmtNumero(l.solicitado)}</td>
    <td style="text-align:right;">${fmtNumero(l.autonomia_existente)}</td>
    <td style="text-align:right;"><input type="number" class="plan-aut" value="${l.autonomia_ajustada ?? ''}" step="0.5" min="0" style="width:64px; text-align:right;"></td>
    <td style="text-align:right;"><input type="number" class="plan-conv" value="${l.embalagem_conversao ?? ''}" step="1" min="0" style="width:60px; text-align:right;"></td>
    <td style="text-align:right;"><input type="number" class="plan-qtd" value="${l.quantidade_calculada ?? ''}" step="${passo}" min="0" style="width:84px; text-align:right;"></td>
    <td style="text-align:right;">${brlPlan(l.preco_unitario)}</td>
    <td style="text-align:right;" class="cel-custo">${brlPlan(l.custo_total)}</td>
    <td><input type="text" class="plan-obs" value="${escaparAttr(l.observacao)}" placeholder="—" style="width:120px;"></td>`;
}

const CAB_COMPACTO_F = ['Comprar', 'Descrição', 'SIAFÍSICO', 'Modalidade', 'Un. Forn.', 'Consumo', '% LOIS', 'Estoque', 'Empenhado', 'Solicitado', 'Aut. existente', 'Aut. ajustada', 'Conv.', 'Quantidade', 'Preço', 'Custo', 'Obs.'];

function layoutAtualPlan() {
  const m = (estadoPlanejamento.filtros || {}).modalidade;
  return m === 'ATA' ? 'ata' : (m === 'PREGAO' || m === 'INEX') ? 'pregao' : 'compacto';
}

function renderCabecalhoPlan(layout) {
  const cab = layout === 'ata' ? CAB_ATA_MODELO : layout === 'pregao' ? CAB_PREGAO_MODELO : CAB_COMPACTO_F;
  const thead = document.getElementById('cabecalhoPlanejamento');
  if (thead) thead.innerHTML = '<tr>' + cab.map((h) => `<th>${h || ''}</th>`).join('') + '</tr>';
}

function desenharTabelaPlanejamento(linhas) {
  const corpo = document.getElementById('corpoPlanejamento');
  const layout = layoutAtualPlan();
  const nCols = layout === 'ata' ? CAB_ATA_MODELO.length : layout === 'pregao' ? CAB_PREGAO_MODELO.length : CAB_COMPACTO_F.length;
  renderCabecalhoPlan(layout);
  if (!linhas.length) {
    corpo.innerHTML = `<tr><td colspan="${nCols}" style="text-align:center; padding:24px; color:#888;">Nenhum item no planejamento com esses parâmetros.</td></tr>`;
    return;
  }
  let vis = 0;
  const html = linhas.map((l, idx) => {
    if (!linhaVisivelPlan(l)) return '';
    vis += 1;
    const frac = unidadeAquisicaoFracionada(l.unidade_fornecimento);
    const classes = [frac ? 'linha-unidade-fracionada' : '', l._modalidade === 'REVISAR' ? 'linha-revisar' : '', l.comprar ? '' : 'linha-nao-comprar'].filter(Boolean).join(' ');
    const cells = layout === 'ata' ? celulasAta(l, vis) : layout === 'pregao' ? celulasPregao(l, vis) : celulasCompacto(l);
    return `<tr data-idx="${idx}" class="${classes}">${cells}</tr>`;
  }).join('');
  corpo.innerHTML = vis ? html : `<tr><td colspan="${nCols}" style="text-align:center; padding:24px; color:#888;">Nenhum item com esses filtros.</td></tr>`;
  const cont = document.getElementById('planContagemFiltro');
  if (cont) cont.textContent = vis === linhas.length ? `${fmtNumero(vis)} itens` : `${fmtNumero(vis)} de ${fmtNumero(linhas.length)}`;
}

// Recalcula os cards de resumo a partir do estado atual (respeita "Comprar").
function recalcularResumoPlan() {
  const L = estadoPlanejamento.linhas;
  const resumo = {
    total_itens: L.length,
    ata: L.filter((l) => l._modalidade === 'ATA').length,
    pregao: L.filter((l) => l._modalidade === 'PREGAO').length,
    inex: L.filter((l) => l._modalidade === 'INEX').length,
    revisar: L.filter((l) => l._modalidade === 'REVISAR').length,
    com_quantidade: L.filter((l) => l.comprar && Number(l.quantidade_calculada) > 0).length,
    custo_total_ata: L.reduce((s, l) => s + (l.comprar && l.custo_total ? l.custo_total : 0), 0),
  };
  estadoPlanejamento.resumo = resumo;
  desenharResumoPlanejamento(resumo);
}

// Recalcula quantidade da linha: MROUND(aut × consumo × conversão, passo),
// arredondando Judicial e ADM à parte (igual ao motor/modelos).
function recomputarQuantidadeLinhaPlan(l) {
  const consumo = Number(l.consumo_mensal) || 0;
  const aut = l.autonomia_ajustada;
  if (aut == null || consumo <= 0) { l.quantidade_calculada = 0; l._qtd_jud = null; l._qtd_adm = 0; return; }
  const mult = Number(l.embalagem_conversao) > 0 ? Number(l.embalagem_conversao) : 1;
  const passo = Number(l._emb_passo) > 0 ? Number(l._emb_passo) : mult;
  const cj = Number(l._consumo_aj); const temJ = Number.isFinite(cj);
  const ca = temJ ? Math.max(0, consumo - cj) : consumo;
  const qj = temJ ? mroundFront(aut * cj * mult, passo) : 0;
  const qa = mroundFront(aut * ca * mult, passo);
  l._qtd_jud = temJ ? qj : null;
  l._qtd_adm = qa;
  l.quantidade_calculada = (qj || 0) + (qa || 0);
}

// Salva a conversão ajustada na classificação permanente do item.
async function persistirConversaoPlan(codigo, valor) {
  try {
    await api('/planejamento/conversao', {
      method: 'PUT',
      body: JSON.stringify({ codigo_item: codigo, embalagem_conversao: valor }),
    });
  } catch (e) { /* silencioso: a edição continua valendo em memória */ }
}

function atualizarCustoLinhaPlan(tr, l) {
  const preco = l.preco_unitario;
  l.custo_total = (l.quantidade_calculada != null && preco != null) ? l.quantidade_calculada * preco : null;
  const c = tr.querySelector('.cel-custo');
  if (c) c.textContent = brlPlan(l.custo_total);
}

// Handler delegado de edição na tabela do planejamento (Parte 3).
function onEdicaoPlanejamento(e) {
  const tr = e.target.closest('tr[data-idx]');
  if (!tr) return;
  const l = estadoPlanejamento.linhas[+tr.dataset.idx];
  if (!l) return;
  const consumo = Number(l.consumo_mensal) || 0;
  const conv = Number(l.embalagem_conversao) > 0 ? Number(l.embalagem_conversao) : 1;

  if (e.target.classList.contains('plan-comprar')) {
    l.comprar = e.target.checked ? 1 : 0;
    tr.classList.toggle('linha-nao-comprar', !e.target.checked);
    recalcularResumoPlan();
  } else if (e.target.classList.contains('plan-aut')) {
    const v = e.target.value === '' ? null : Number(e.target.value);
    l.autonomia_ajustada = v;
    recomputarQuantidadeLinhaPlan(l);
    const q = tr.querySelector('.plan-qtd');
    if (q) q.value = l.quantidade_calculada ?? '';
    atualizarCustoLinhaPlan(tr, l);
    recalcularResumoPlan();
  } else if (e.target.classList.contains('plan-conv')) {
    // Técnico ajusta a conversão de embalagem (itens ml/g/dose destacados).
    const v = e.target.value === '' ? null : Number(e.target.value);
    l.embalagem_conversao = v;
    // No Pregão o passo do MROUND é a própria conversão; na ATA o passo é fixo
    // (embalagem primária da ata) e a conversão é só o multiplicador.
    if (l._modalidade !== 'ATA') l._emb_passo = v;
    recomputarQuantidadeLinhaPlan(l);
    const q = tr.querySelector('.plan-qtd');
    if (q) q.value = l.quantidade_calculada ?? '';
    atualizarCustoLinhaPlan(tr, l);
    recalcularResumoPlan();
    // Persiste na classificação (lembrado nos próximos planejamentos) ao sair do campo.
    if (e.type === 'change' && v != null && v > 0) persistirConversaoPlan(l.codigo_item, v);
  } else if (e.target.classList.contains('plan-qtd')) {
    l.quantidade_calculada = e.target.value === '' ? null : Number(e.target.value);
    atualizarCustoLinhaPlan(tr, l);
    recalcularResumoPlan();
  } else if (e.target.classList.contains('plan-emb')) {
    // Passo do MROUND (coluna "Embalagem" do modelo ATA). Editável na tela.
    l._emb_passo = e.target.value === '' ? null : Number(e.target.value);
    recomputarQuantidadeLinhaPlan(l);
    atualizarCustoLinhaPlan(tr, l);
    recalcularResumoPlan();
  } else if (e.target.classList.contains('plan-comprar-sel')) {
    l.comprar = e.target.value === 'Comprar' ? 1 : 0;
    tr.classList.toggle('linha-nao-comprar', !l.comprar);
    recalcularResumoPlan();
  } else if (e.target.classList.contains('plan-obs')) {
    l.observacao = e.target.value;
  } else if (e.target.classList.contains('plan-modalidade')) {
    // Técnico decide a modalidade (move o item para a aba escolhida).
    const v = e.target.value; // '', 'ATA', 'PREGAO', 'INEX'
    l._modalidade_forcada = v || null;
    l._modalidade = v || l._modalidade_calc;
    const usaAta = l._modalidade === 'ATA' || l._modalidade === 'REVISAR';
    const cv = Number(l.embalagem_conversao) > 0 ? Number(l.embalagem_conversao) : 1;
    l._emb_passo = usaAta ? (Number(l._ata_emb_primaria) > 0 ? Number(l._ata_emb_primaria) : 1) : cv;
    // Preço acompanha a modalidade: ATA/Revisar = preço da ata; Pregão/Inex = valor médio.
    l.preco_unitario = usaAta ? (l._preco_ata ?? null) : (l._preco_medio ?? null);
    recomputarQuantidadeLinhaPlan(l);
    desenharTabelaPlanejamento(estadoPlanejamento.linhas); // re-render (item muda de aba)
    recalcularResumoPlan();
    if (e.type === 'change') persistirModalidadePlan(l.codigo_item, v);
    return;
  }
  // Nos layouts de modelo, ao sair do campo re-renderiza para atualizar as
  // colunas divididas (Jud/ADM/Total, custos) que dependem do valor editado.
  if (e.type === 'change' && layoutAtualPlan() !== 'compacto') {
    desenharTabelaPlanejamento(estadoPlanejamento.linhas);
  }
}

// Salva a decisão de modalidade (override) do técnico na classificação.
async function persistirModalidadePlan(codigo, modalidade) {
  try {
    await api('/planejamento/modalidade', {
      method: 'PUT',
      body: JSON.stringify({ codigo_item: codigo, modalidade: modalidade || '' }),
    });
  } catch (e) { /* silencioso: decisão continua valendo em memória */ }
}

// -------- Parte 4/5/6: salvar, exportar, listar, reabrir, duplicar --------

// Aplica a visibilidade dos botões conforme a permissão do usuário.
function aplicarPermissoesPlanejamento() {
  const podeSalvar = temPermissao('planejamento', 'inserir') || temPermissao('planejamento', 'editar');
  const bs = document.getElementById('botaoSalvarPlan');
  const be = document.getElementById('botaoExportarPlan');
  if (bs) bs.hidden = !podeSalvar;
  if (be) be.hidden = !temPermissao('planejamento', 'exportar');
}

// Salva o planejamento atual: cria novo (POST) ou atualiza o aberto (PUT).
async function salvarPlanejamento() {
  if (!estadoPlanejamento.linhas.length) { alert('Gere o planejamento antes de salvar.'); return; }
  const titulo = document.getElementById('planTitulo').value.trim();
  const payload = {
    titulo,
    parametros: estadoPlanejamento.parametros,
    linhas: estadoPlanejamento.linhas,
  };
  const botao = document.getElementById('botaoSalvarPlan');
  botao.disabled = true;
  try {
    let resp;
    if (estadoPlanejamento.idEditando) {
      resp = await api(`/planejamento/${estadoPlanejamento.idEditando}`, { method: 'PUT', body: JSON.stringify(payload) });
      alert('Planejamento atualizado.');
    } else {
      resp = await api('/planejamento', { method: 'POST', body: JSON.stringify(payload) });
      estadoPlanejamento.idEditando = resp.id;
      marcarEditando(resp.id, resp.titulo || titulo);
      alert('Planejamento salvo.');
    }
  } catch (e) {
    alert('Erro ao salvar: ' + e.message);
  } finally {
    botao.disabled = false;
  }
}

function marcarEditando(id, titulo) {
  const info = document.getElementById('planEditandoInfo');
  if (id) {
    estadoPlanejamento.idEditando = id;
    info.textContent = `✔ Editando #${id}${titulo ? ' — ' + titulo : ''}`;
    info.hidden = false;
  } else {
    estadoPlanejamento.idEditando = null;
    info.hidden = true;
  }
}

// Exporta o planejamento atual como .xlsx com 2 abas (ATA FINAL / SEM ATA
// FINAL) no layout dos modelos do Rafael. O arquivo é montado no servidor.
async function exportarPlanejamentoCSV() {
  const L = estadoPlanejamento.linhas;
  if (!L.length) { alert('Gere o planejamento antes de exportar.'); return; }
  const botao = document.getElementById('botaoExportarPlan');
  botao.disabled = true;
  const rotulo = botao.textContent;
  botao.textContent = '⏳ Gerando…';
  try {
    const titulo = (document.getElementById('planTitulo').value.trim() || 'planejamento');
    const resp = await fetch('/api/planejamento/exportar-xlsx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linhas: L, titulo }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.erro || 'Falha ao exportar');
    }
    const blob = await resp.blob();
    const nome = titulo.replace(/[^\w\-]+/g, '_') || 'planejamento';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${nome}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    alert('Erro ao exportar: ' + e.message);
  } finally {
    botao.disabled = false;
    botao.textContent = rotulo;
  }
}

// Abre/atualiza o painel com a lista de planejamentos salvos.
async function listarPlanejamentosSalvos() {
  const painel = document.getElementById('planListaSalvos');
  const corpo = document.getElementById('planListaSalvosCorpo');
  painel.style.display = 'block';
  corpo.innerHTML = 'Carregando…';
  try {
    const { planejamentos } = await api('/planejamento');
    if (!planejamentos.length) { corpo.innerHTML = '<em>Nenhum planejamento salvo ainda.</em>'; return; }
    const podeExcluir = temPermissao('planejamento', 'excluir');
    const podeDuplicar = temPermissao('planejamento', 'inserir');
    const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    corpo.innerHTML = `<table class="tabela"><thead><tr>
        <th>#</th><th>Título</th><th>Base</th><th>Itens</th><th>A comprar</th><th>Custo</th>
        <th>Status</th><th>Criado</th><th>Por</th><th></th></tr></thead><tbody>${
      planejamentos.map((p) => `<tr>
        <td>${p.id}</td><td>${valorCelula(p.titulo)}</td><td>${formatarData(p.data_base)}</td>
        <td style="text-align:right;">${fmtNumero(p.total_itens)}</td>
        <td style="text-align:right;">${fmtNumero(p.itens_comprar)}</td>
        <td style="text-align:right;">${brl(p.custo_total)}</td>
        <td>${valorCelula(p.status)}</td><td>${valorCelula(p.criado_em)}</td>
        <td>${valorCelula(p.usuario_email)}</td>
        <td style="white-space:nowrap;">
          <button class="botao-texto" type="button" onclick="abrirPlanejamentoSalvo(${p.id})">Abrir</button>
          ${podeDuplicar ? `<button class="botao-texto" type="button" onclick="duplicarPlanejamento(${p.id})">Duplicar</button>` : ''}
          ${podeExcluir ? `<button class="botao-texto" type="button" style="color:#c0392b;" onclick="excluirPlanejamento(${p.id})">Excluir</button>` : ''}
        </td></tr>`).join('')
    }</tbody></table>`;
  } catch (e) {
    corpo.innerHTML = 'Erro ao listar: ' + e.message;
  }
}

// Reabre um planejamento salvo, recompondo o estado a partir das linhas gravadas.
async function abrirPlanejamentoSalvo(id) {
  try {
    const { cabecalho, itens } = await api(`/planejamento/${id}`);
    estadoPlanejamento.parametros = {
      unidade: cabecalho.unidade, dataBase: cabecalho.data_base,
      autonomiaAlvoAta: cabecalho.autonomia_alvo, cortePoucaDemanda: cabecalho.corte_pouca_demanda,
    };
    estadoPlanejamento.linhas = itens.map((l) => ({
      ...l,
      _modalidade: l.ata_numero ? 'ATA' : 'PREGAO',
      _percent_lois: null,
    }));
    document.getElementById('planTitulo').value = cabecalho.titulo || '';
    marcarEditando(id, cabecalho.titulo);
    recalcularResumoPlan();
    desenharTabelaPlanejamento(estadoPlanejamento.linhas);
    document.getElementById('planListaSalvos').style.display = 'none';
  } catch (e) {
    alert('Erro ao abrir: ' + e.message);
  }
}

async function duplicarPlanejamento(id) {
  try {
    const r = await api(`/planejamento/${id}/duplicar`, { method: 'POST' });
    await listarPlanejamentosSalvos();
    if (r.id) abrirPlanejamentoSalvo(r.id);
  } catch (e) { alert('Erro ao duplicar: ' + e.message); }
}

async function excluirPlanejamento(id) {
  if (!confirm('Excluir este planejamento? Esta ação não pode ser desfeita.')) return;
  try {
    await api(`/planejamento/${id}`, { method: 'DELETE' });
    if (estadoPlanejamento.idEditando === id) marcarEditando(null);
    await listarPlanejamentosSalvos();
  } catch (e) { alert('Erro ao excluir: ' + e.message); }
}

async function carregarTabelaPlanTP() {
  const params = paramsFiltroPlanTP();
  params.set('page', estadoPlanTP.pagina);
  params.set('pageSize', estadoPlanTP.pageSize);

  const dados = await api(`/relatorio-itens/planejamento-tp?${params.toString()}`);

  document.getElementById('subtituloPlanTP').textContent =
    `Itens da Tenente Pena com demanda diferente de zero (Estoque TP de ${dados.dataReferencia ? formatarData(dados.dataReferencia) : '—'}).`;

  const corpo = document.getElementById('corpoTabelaPlanTP');
  const vazio = document.getElementById('estadoVazioPlanTP');
  if (dados.itens.length === 0) {
    corpo.innerHTML = ''; vazio.hidden = false;
  } else {
    vazio.hidden = true;
    const ehAdmin = estado.usuario && estado.usuario.perfil === 'admin';
    const marca = (v) => {
      if (v === 'Sim') return '<span class="etiqueta-status finalizado">Sim</span>';
      if (v === 'Não') return '<span class="etiqueta-status">Não</span>';
      return '—';
    };
    const outros = (i) => {
      if (i.clas_outros_programas === 'Sim') {
        const nome = i.clas_qual_programa ? ` <small style="color:var(--texto-suave);">(${i.clas_qual_programa})</small>` : '';
        return `<span class="etiqueta-status finalizado">Sim</span>${nome}`;
      }
      if (i.clas_outros_programas === 'Não') return '<span class="etiqueta-status">Não</span>';
      return '—';
    };
    const etiquetaNovo = (i) => i.is_novo
      ? '<span class="etiqueta-status" style="background:var(--sucesso-fundo,#e6f4ea); color:var(--sucesso,#1f7a4d); border:1px solid var(--sucesso,#1f7a4d); margin-left:6px;">🆕 Novo</span>'
      : '';
    corpo.innerHTML = dados.itens.map((i) => `
      <tr class="${unidadeAquisicaoFracionada(i.clas_unidade_fornecimento) ? 'linha-unidade-fracionada' : ''}">
        <td class="col-codigo">${i.codigo || '—'}</td>
        <td class="col-codigo">${i.siafisico || '—'}</td>
        <td>${i.descricao_item || '—'}${etiquetaNovo(i)}</td>
        <td style="text-align:right;">${i.demanda_total != null ? fmtNumero(i.demanda_total) : '—'}</td>
        <td>${marca(i.clas_dose_certa)}</td>
        <td>${marca(i.clas_doenca_rara)}</td>
        <td>${i.clas_unidade_fornecimento || '—'}</td>
        <td style="text-align:right;">${i.clas_embalagem_conversao != null ? fmtNumero(i.clas_embalagem_conversao) : '<span style="color:var(--aviso,#b8860b);">pendente</span>'}</td>
        <td>${i.clas_subcategoria || '—'}</td>
        <td>${i.clas_responsavel_aquisicao || '—'}</td>
        <td>${marca(i.clas_inex)}</td>
        <td>${outros(i)}</td>
        <td>${ehAdmin
          ? `<button class="botao-editar" data-codigo="${encodeURIComponent(i.codigo || '')}" data-desc="${(i.descricao_item || '').replace(/"/g, '&quot;')}">Editar</button>`
          : '—'}</td>
      </tr>
    `).join('');
    corpo.querySelectorAll('.botao-editar').forEach((btn) => {
      btn.addEventListener('click', () => abrirModalClassificacao(decodeURIComponent(btn.dataset.codigo), btn.dataset.desc));
    });
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoPlanTP').textContent =
    `Página ${dados.page} de ${totalPaginas} · ${fmtNumero(dados.total)} item(ns) da TP`;
  document.getElementById('ptpAnterior').disabled = dados.page <= 1;
  document.getElementById('ptpProximo').disabled = dados.page >= totalPaginas;
}

// ---------- Atualizar via Oracle (SCODES) ----------
let timerStatusOracleRelatorioItens = null;
function mostrarStatusOracleRelatorioItens(texto, cor) {
  const el = document.getElementById('statusOracleRelatorioItens');
  el.textContent = texto;
  el.style.color = cor || '';
  el.hidden = !texto;
}
async function verificarStatusOracleRelatorioItens() {
  try {
    const r = await fetch('/api/relatorio-itens/atualizar-oracle/status');
    const s = await r.json();
    const botao = document.getElementById('botaoAtualizarRelatorioItens');
    if (s.rodando) {
      botao.disabled = true;
      if (!timerStatusOracleRelatorioItens) timerStatusOracleRelatorioItens = setInterval(verificarStatusOracleRelatorioItens, 5000);
      const min = s.inicio ? Math.floor((Date.now() - new Date(s.inicio)) / 60000) : 0;
      mostrarStatusOracleRelatorioItens(`⏳ Atualizando via Oracle… (${min} min) — pode continuar usando o sistema.`, '#8a6d00');
    } else {
      botao.disabled = false;
      if (timerStatusOracleRelatorioItens) { clearInterval(timerStatusOracleRelatorioItens); timerStatusOracleRelatorioItens = null; }
      if (s.ultimoErro) {
        mostrarStatusOracleRelatorioItens('❌ Falha na última atualização: ' + s.ultimoErro, '#b00020');
      } else if (s.ultimoResumo) {
        const seg = Math.round((s.ultimoResumo.duracaoMs || 0) / 1000);
        mostrarStatusOracleRelatorioItens(`✅ Atualizado: ${s.ultimoResumo.totalItens} itens (${seg}s). Recarregue a tabela.`, '#1f5c52');
        if (estado.paginaAtual === 'relatorioItens') carregarTabelaRelItens();
      } else {
        mostrarStatusOracleRelatorioItens('', '');
      }
    }
  } catch (_) { /* silencioso */ }
}
document.getElementById('botaoAtualizarRelatorioItens').addEventListener('click', async () => {
  if (!confirm('Atualizar o catálogo completo (Relatório de Itens) direto do Oracle (SCODES)?\n\nIsso substitui os dados atuais e roda em segundo plano — você pode continuar usando o sistema normalmente.\n\nObs.: "Intercambiável" e "Comissão de Farmacologia" não vêm do Oracle e ficam em branco (só a importação manual por CSV preenche esses dois campos).')) return;
  const botao = document.getElementById('botaoAtualizarRelatorioItens');
  botao.disabled = true;
  mostrarStatusOracleRelatorioItens('⏳ Iniciando…', '#8a6d00');
  try {
    const r = await fetch('/api/relatorio-itens/atualizar-oracle', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) {
      mostrarStatusOracleRelatorioItens('❌ ' + (d.erro || 'Não foi possível iniciar.'), '#b00020');
      botao.disabled = false;
      return;
    }
    if (timerStatusOracleRelatorioItens) clearInterval(timerStatusOracleRelatorioItens);
    timerStatusOracleRelatorioItens = setInterval(verificarStatusOracleRelatorioItens, 5000);
    verificarStatusOracleRelatorioItens();
  } catch (e) {
    mostrarStatusOracleRelatorioItens('❌ Erro de rede ao iniciar.', '#b00020');
    botao.disabled = false;
  }
});

// ==================== Consumo x Entrega ====================
// Cruza consumo estimado (consumo mensal × período) com a entrega real
// (recibos do SCODES). Abas TP/OD; período 30–365 dias a partir de hoje.
const estadoConsumoEntrega = { aba: 'tp', dados: null };
let debounceConsumoEntrega = null;

function periodoConsumoEntrega() {
  return parseInt(document.getElementById('filtroPeriodoConsumoEntrega').value, 10) || 30;
}

async function carregarConsumoEntrega() {
  const corpo = document.getElementById('corpoTabelaConsumoEntrega');
  const dias = periodoConsumoEntrega();
  const busca = document.getElementById('filtroBuscaConsumoEntrega').value.trim();
  corpo.innerHTML = '<tr><td colspan="10" style="padding:14px; color:var(--cinza-texto);">Carregando…</td></tr>';
  try {
    const qs = new URLSearchParams({ escopo: estadoConsumoEntrega.aba, dias: String(dias) });
    if (busca) qs.set('scodes', busca);
    const d = await api('/consumo-entrega?' + qs.toString());
    estadoConsumoEntrega.dados = d;
    renderConsumoEntrega(d);
  } catch (e) {
    corpo.innerHTML = `<tr><td colspan="10" style="padding:14px; color:var(--vermelho);">Erro: ${escHtml(e.message)}</td></tr>`;
  }
}

function renderConsumoEntrega(d) {
  const corpo = document.getElementById('corpoTabelaConsumoEntrega');
  const vazio = document.getElementById('estadoVazioConsumoEntrega');
  const dias = d.dias;
  // Rótulos dinâmicos das colunas com o período.
  document.getElementById('thConsumoEstimadoCE').textContent = `Consumo estim. (${dias}d)`;
  document.getElementById('thRealEntregueCE').textContent = 'Real entregue';

  document.getElementById('totalConsumoEntrega').textContent =
    `${fmtNumero(d.total)} item(ns) de demanda ativa`;
  const carimbo = document.getElementById('carimboConsumoEntrega');
  carimbo.textContent = d.dataCarga
    ? `· recibos atualizados até ${formatarDataHora(d.dataCarga)}`
    : '· sem carga de recibos ainda — use “Atualizar via Oracle”';

  if (!d.itens.length) { corpo.innerHTML = ''; vazio.hidden = false; return; }
  vazio.hidden = true;
  corpo.innerHTML = d.itens.map((it) => {
    const pct = it.percentual;
    const corPct = pct == null ? '' : (pct < 70 ? 'color:#b45309;' : (pct > 130 ? 'color:#1c6cad;' : 'color:#1f5c52;'));
    return `<tr>
      <td class="col-codigo" style="white-space:nowrap;">${escHtml(it.codigo_item)}</td>
      <td>${escHtml(it.descricao || '—')}</td>
      <td class="num">${fmtNumero(it.demanda)}</td>
      <td class="num">${fmtNumero(it.consumo_mensal)}</td>
      <td class="num">${fmtNumero(it.consumo_estimado_periodo)}</td>
      <td class="num">${fmtNumero(it.demandas_atendidas)}</td>
      <td class="num">${fmtNumero(it.soma_real_entregue)}</td>
      <td class="num">${it.periodicidade_media == null ? '—' : it.periodicidade_media.toFixed(1)}</td>
      <td class="num" style="font-weight:600; ${corPct}">${pct == null ? '—' : fmtNumero(pct) + '%'}</td>
      <td><button type="button" class="botao-secundario ce-ver" data-cod="${escAttr(it.codigo_item)}" style="padding:3px 10px; font-size:12px;">Ver</button></td>
    </tr>`;
  }).join('');
  corpo.querySelectorAll('.ce-ver').forEach((b) => b.addEventListener('click', () => abrirDetalheConsumoEntrega(b.dataset.cod)));
}

async function abrirDetalheConsumoEntrega(codigo) {
  const dias = periodoConsumoEntrega();
  const modal = document.getElementById('modalDetalheConsumoEntrega');
  const corpo = document.getElementById('corpoDetalheConsumoEntrega');
  document.getElementById('subDetalheConsumoEntrega').textContent = 'Carregando…';
  corpo.innerHTML = '';
  modal.hidden = false;
  try {
    const qs = new URLSearchParams({ escopo: estadoConsumoEntrega.aba, dias: String(dias), codigo });
    const d = await api('/consumo-entrega/detalhe?' + qs.toString());
    document.getElementById('tituloDetalheConsumoEntrega').textContent = `${d.codigo_item} — consolidado por mês`;
    document.getElementById('subDetalheConsumoEntrega').textContent =
      `${d.descricao || ''} · ${estadoConsumoEntrega.aba === 'od' ? 'Outras Demandas' : 'Tenente Pena'} · últimos ${dias} dias`;
    const nMeses = d.meses.length || 1;
    const totalReal = d.meses.reduce((s, m) => s + (m.soma_real || 0), 0);
    const consumoEstMes = d.consumo_mensal || 0;
    // A partir de 60 dias, faz mais sentido a MÉDIA/mês (decidido com o Rafael).
    const mostrarMedia = dias >= 60;
    const linhas = d.meses.map((m) => `
      <tr>
        <td>${escHtml(m.mes)}</td>
        <td class="num">${fmtNumero(consumoEstMes)}</td>
        <td class="num">${fmtNumero(m.demandas_atendidas)}</td>
        <td class="num">${fmtNumero(m.soma_real)}</td>
        <td class="num">${m.periodicidade_media == null ? '—' : m.periodicidade_media.toFixed(1)}</td>
      </tr>`).join('');
    const rodape = mostrarMedia
      ? `<tr style="font-weight:600; border-top:2px solid var(--linha);">
           <td>Média/mês</td>
           <td class="num">${fmtNumero(consumoEstMes)}</td>
           <td class="num">${fmtNumero(+(d.meses.reduce((s, m) => s + m.demandas_atendidas, 0) / nMeses).toFixed(1))}</td>
           <td class="num">${fmtNumero(+(totalReal / nMeses).toFixed(2))}</td>
           <td class="num">—</td>
         </tr>`
      : '';
    const tabelaMeses = d.meses.length
      ? `<table class="tabela" style="width:100%;"><thead><tr>
           <th>Mês</th><th class="num">Consumo estim./mês</th><th class="num">Demandas atendidas</th><th class="num">Real entregue</th><th class="num">Periodic. média</th>
         </tr></thead><tbody>${linhas}${rodape}</tbody></table>`
      : '<p class="texto-apoio" style="padding:10px 0;">Sem recibos neste período para este item.</p>';

    // Consolidado por UNIDADE — só na aba Outras Demandas (itens em várias unidades).
    let blocoUnidades = '';
    if (estadoConsumoEntrega.aba === 'od' && (d.unidades || []).length) {
      const unidadesOrdenadas = d.unidades
        .filter((u) => (u.demanda || 0) > 0) // não mostra unidade sem demanda
        .sort((a, b) => String(a.unidade).localeCompare(String(b.unidade), 'pt-BR', { numeric: true }));
      const linhasUnid = unidadesOrdenadas.map((u) => {
        const est = (u.consumo_mensal || 0) * (dias / 30);
        const pct = est > 0 ? (u.soma_real / est) * 100 : null;
        const corPct = pct == null ? '' : (pct < 70 ? 'color:#b45309;' : (pct > 130 ? 'color:#1c6cad;' : 'color:#1f5c52;'));
        return `
        <tr>
          <td>${escHtml(u.unidade)}</td>
          <td class="num">${fmtNumero(u.demanda)}</td>
          <td class="num">${fmtNumero(u.consumo_mensal)}</td>
          <td class="num">${fmtNumero(u.demandas_atendidas)}</td>
          <td class="num">${fmtNumero(u.soma_real)}</td>
          <td class="num">${u.periodicidade_media == null ? '—' : u.periodicidade_media.toFixed(1)}</td>
          <td class="num" style="font-weight:600; ${corPct}">${pct == null ? '—' : fmtNumero(+pct.toFixed(1)) + '%'}</td>
        </tr>`;
      }).join('');
      if (unidadesOrdenadas.length) blocoUnidades = `
        <div style="margin-top:18px; font-weight:600; color:var(--cinza-texto); font-size:13px;">Consolidado por unidade</div>
        <div style="overflow-x:auto;">
          <table class="tabela" style="width:100%; min-width:720px; margin-top:6px;"><thead><tr>
            <th>Unidade</th><th class="num">Demanda</th><th class="num">Consumo /mês</th><th class="num">Demandas atendidas</th><th class="num">Real entregue</th><th class="num">Periodic. média</th><th class="num">% Cons. × Entr.</th>
          </tr></thead><tbody>${linhasUnid}</tbody></table>
        </div>`;
    }
    corpo.innerHTML = tabelaMeses + blocoUnidades;
  } catch (e) {
    corpo.innerHTML = `<p class="texto-apoio" style="color:var(--vermelho);">Erro: ${escHtml(e.message)}</p>`;
  }
}

function exportarConsumoEntregaCSV() {
  const d = estadoConsumoEntrega.dados;
  if (!d || !d.itens.length) { alert('Nada para exportar.'); return; }
  const cab = ['SCODES', 'Descrição', 'Demanda', 'Consumo/mês', `Consumo estim (${d.dias}d)`, 'Demandas atendidas', 'Real entregue', 'Periodicidade média', '% Consumo x Entrega'];
  const linhas = d.itens.map((it) => [
    it.codigo_item, it.descricao || '', it.demanda, it.consumo_mensal, it.consumo_estimado_periodo,
    it.demandas_atendidas, it.soma_real_entregue, it.periodicidade_media == null ? '' : it.periodicidade_media,
    it.percentual == null ? '' : it.percentual,
  ]);
  const csv = [cab, ...linhas].map((l) => l.map((c) => {
    const s = String(c ?? '');
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `consumo-x-entrega_${estadoConsumoEntrega.aba}_${d.dias}d.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Listeners da tela Consumo x Entrega.
document.querySelectorAll('#abasConsumoEntrega .chip-faixa').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#abasConsumoEntrega .chip-faixa').forEach((b) => b.classList.toggle('ativo', b === btn));
    estadoConsumoEntrega.aba = btn.dataset.aba;
    carregarConsumoEntrega();
  });
});
document.getElementById('filtroPeriodoConsumoEntrega').addEventListener('change', carregarConsumoEntrega);
document.getElementById('filtroBuscaConsumoEntrega').addEventListener('input', () => {
  clearTimeout(debounceConsumoEntrega);
  debounceConsumoEntrega = setTimeout(carregarConsumoEntrega, 350);
});
document.getElementById('botaoLimparConsumoEntrega').addEventListener('click', () => {
  document.getElementById('filtroBuscaConsumoEntrega').value = '';
  carregarConsumoEntrega();
});
document.getElementById('botaoExportarConsumoEntrega').addEventListener('click', exportarConsumoEntregaCSV);
document.getElementById('fecharDetalheConsumoEntrega').addEventListener('click', () => { document.getElementById('modalDetalheConsumoEntrega').hidden = true; });
document.getElementById('modalDetalheConsumoEntrega').addEventListener('click', (ev) => { if (ev.target.id === 'modalDetalheConsumoEntrega') ev.currentTarget.hidden = true; });

// ---------- Atualizar via Oracle (recibos) ----------
let timerStatusOracleCE = null;
function mostrarStatusOracleCE(texto, cor) {
  const el = document.getElementById('statusOracleConsumoEntrega');
  el.textContent = texto; el.style.color = cor || ''; el.hidden = !texto;
}
async function verificarStatusOracleConsumoEntrega() {
  try {
    const r = await fetch('/api/consumo-entrega/atualizar-oracle/status');
    const s = await r.json();
    const botao = document.getElementById('botaoAtualizarConsumoEntrega');
    if (s.rodando) {
      botao.disabled = true;
      if (!timerStatusOracleCE) timerStatusOracleCE = setInterval(verificarStatusOracleConsumoEntrega, 5000);
      const min = s.inicio ? Math.floor((Date.now() - new Date(s.inicio)) / 60000) : 0;
      mostrarStatusOracleCE(`⏳ Atualizando recibos via Oracle… (${min} min) — pode continuar usando o sistema.`, '#8a6d00');
    } else {
      botao.disabled = false;
      if (timerStatusOracleCE) { clearInterval(timerStatusOracleCE); timerStatusOracleCE = null; }
      if (s.ultimoErro) {
        mostrarStatusOracleCE('❌ Falha na última atualização: ' + s.ultimoErro, '#b00020');
      } else if (s.ultimoResumo) {
        const seg = Math.round((s.ultimoResumo.duracaoMs || 0) / 1000);
        mostrarStatusOracleCE(`✅ Recibos atualizados: ${fmtNumero(s.ultimoResumo.gravadas || 0)} linhas (${seg}s). Recarregue a tabela.`, '#1f5c52');
        if (estado.paginaAtual === 'consumoEntrega') carregarConsumoEntrega();
      } else {
        mostrarStatusOracleCE('', '');
      }
    }
  } catch (_) { /* silencioso */ }
}
document.getElementById('botaoAtualizarConsumoEntrega').addEventListener('click', async () => {
  if (!confirm('Atualizar os recibos (entrega real) direto do Oracle (SCODES)?\n\nPuxa ~13 meses de recibos e roda em segundo plano — você pode continuar usando o sistema.')) return;
  const botao = document.getElementById('botaoAtualizarConsumoEntrega');
  botao.disabled = true;
  mostrarStatusOracleCE('⏳ Iniciando…', '#8a6d00');
  try {
    const r = await fetch('/api/consumo-entrega/atualizar-oracle', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) { mostrarStatusOracleCE('❌ ' + (d.erro || 'Não foi possível iniciar.'), '#b00020'); botao.disabled = false; return; }
    if (timerStatusOracleCE) clearInterval(timerStatusOracleCE);
    timerStatusOracleCE = setInterval(verificarStatusOracleConsumoEntrega, 5000);
    verificarStatusOracleConsumoEntrega();
  } catch (e) { mostrarStatusOracleCE('❌ Erro de rede ao iniciar.', '#b00020'); botao.disabled = false; }
});

// ==================== Associar Entrada à Compra (conciliação) ====================
// Notificação efêmera simples (não havia toast no app).
function mostrarToast(msg) {
  let t = document.getElementById('__toastGlobal');
  if (!t) {
    t = document.createElement('div');
    t.id = '__toastGlobal';
    t.style.cssText = 'position:fixed; left:50%; bottom:26px; transform:translateX(-50%) translateY(20px); background:var(--selo, #1f5c52); color:#fff; padding:11px 18px; border-radius:10px; font-size:13.5px; font-weight:500; box-shadow:0 8px 24px rgba(0,0,0,.2); opacity:0; transition:.28s; z-index:9999; pointer-events:none; max-width:90vw;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'translateX(-50%) translateY(0)'; });
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(-50%) translateY(20px)'; }, 2800);
}

const estadoConc = { aba: 'pend', propostas: [], aAssociar: [], auditoria: [], modalEntrada: null, escolha: null };

async function carregarAssociarEntrada() {
  await Promise.all([carregarConcPropostas(), carregarConcAssociar(), carregarConcAuditoria()]);
  mostrarAbaConc(estadoConc.aba);
}
async function carregarConcPropostas() {
  try { estadoConc.propostas = (await api('/conciliacao/entrada/propostas')).propostas || []; }
  catch (e) { estadoConc.propostas = []; }
  renderConcPend();
}
async function carregarConcAssociar() {
  try { estadoConc.aAssociar = (await api('/conciliacao/entrada/a-associar')).fila || []; }
  catch (e) { estadoConc.aAssociar = []; }
  renderConcAssoc();
}
async function carregarConcAuditoria() {
  try { estadoConc.auditoria = (await api('/conciliacao/auditoria')).auditoria || []; }
  catch (e) { estadoConc.auditoria = []; }
  renderConcAud();
}

function mostrarAbaConc(aba) {
  estadoConc.aba = aba;
  document.querySelectorAll('#abasConciliacao .chip-faixa').forEach((b) => b.classList.toggle('ativo', b.dataset.aba === aba));
  document.getElementById('concViewPend').hidden = aba !== 'pend';
  document.getElementById('concViewAssoc').hidden = aba !== 'assoc';
  document.getElementById('concViewAud').hidden = aba !== 'aud';
}

function chipConfConc(c) {
  return c === 'alta'
    ? '<span class="tag-status" style="background:#1f7a5c22; color:#1f7a5c; border:1px solid #1f7a5c55;">Alta confiança</span>'
    : '<span class="tag-status" style="background:#1c6cad22; color:#1c6cad; border:1px solid #1c6cad55;">Revisar</span>';
}
function sinaisConc(s) {
  const rot = { SCODES: 'SCODES', Empenho: 'Empenho', Quantidade: 'Quantidade' };
  return '<div style="display:flex; gap:4px; flex-wrap:wrap; margin-top:5px;">' + Object.keys(rot).map((k) => {
    const ok = s[k];
    const cor = ok ? 'background:#1f7a5c18; color:#1f7a5c; border-color:#1f7a5c40;' : 'background:var(--realce-tabela); color:var(--cinza-texto); border-color:var(--linha);';
    return `<span style="font-size:10.5px; padding:1px 6px; border-radius:5px; border:1px solid; ${cor}${ok ? '' : ' text-decoration:line-through;'}">${ok ? '✓' : '✕'} ${rot[k]}</span>`;
  }).join('') + '</div>';
}

function renderConcPend() {
  const corpo = document.getElementById('concPendBody');
  const vazio = document.getElementById('concPendVazio');
  document.getElementById('contPend').textContent = estadoConc.propostas.length ? `(${estadoConc.propostas.length})` : '';
  if (!estadoConc.propostas.length) { corpo.innerHTML = ''; vazio.hidden = false; return; }
  vazio.hidden = true;
  corpo.innerHTML = estadoConc.propostas.map((p) => {
    const d = p.detalhe || {};
    const badge = p.resultado_previsto === 'Finalizado'
      ? '<span class="tag-status" style="background:#1f7a5c22; color:#1f7a5c; border:1px solid #1f7a5c55;">Finalizado</span>'
      : '<span class="tag-status" style="background:#b4530922; color:#b45309; border:1px solid #b4530955;">Entrega Parcial</span>';
    return `<tr>
      <td><div style="font-weight:500;">${escHtml(d.item || p.codigo_item)}</div>
        <div class="col-codigo">${escHtml(p.codigo_item)}</div>
        <div class="texto-apoio" style="font-size:11.5px; margin-top:3px;">${escHtml((d.data_entrada || '').slice(0, 16))} · <b>${fmtNumero(p.quantidade)} un</b> · empenho ${escHtml(d.nota_empenho || '—')}</div></td>
      <td><b>${escHtml(d.sol_mes || '')}/${escHtml(String(d.sol_ano || ''))} · ${escHtml(d.sol_tipo || '')}</b>
        <div class="texto-apoio" style="font-size:12px;">${escHtml(d.sol_status || '')} · pendente ${fmtNumero(d.sol_pendente || 0)}</div></td>
      <td>${chipConfConc(p.confianca)}${sinaisConc(p.sinais || {})}</td>
      <td>${badge}</td>
      <td style="text-align:right; white-space:nowrap;">
        <button class="botao-secundario conc-rej" data-id="${p.id}" style="padding:4px 10px; font-size:12px;">Rejeitar</button>
        <button class="botao-primario conc-apr" data-id="${p.id}" style="padding:4px 10px; font-size:12px;">Aprovar</button></td>
    </tr>`;
  }).join('');
  corpo.querySelectorAll('.conc-apr').forEach((b) => b.addEventListener('click', () => aprovarConc(b.dataset.id)));
  corpo.querySelectorAll('.conc-rej').forEach((b) => b.addEventListener('click', () => rejeitarConc(b.dataset.id)));
}

async function aprovarConc(id) {
  try {
    const r = await api('/conciliacao/entrada/aprovar/' + id, { method: 'POST' });
    mostrarToast(`Aprovado — compra ficou ${r.status}.`);
    await Promise.all([carregarConcPropostas(), carregarConcAuditoria()]);
  } catch (e) { alert(e.message); }
}
async function rejeitarConc(id) {
  try {
    await api('/conciliacao/entrada/rejeitar/' + id, { method: 'POST' });
    await Promise.all([carregarConcPropostas(), carregarConcAssociar()]);
  } catch (e) { alert(e.message); }
}

function renderConcAssoc() {
  const corpo = document.getElementById('concAssocBody');
  const vazio = document.getElementById('concAssocVazio');
  document.getElementById('contAssoc').textContent = estadoConc.aAssociar.length ? `(${estadoConc.aAssociar.length})` : '';
  const termo = normalizarBusca(document.getElementById('concBuscaAssoc').value || '');
  const soEmp = document.getElementById('concSoComEmpenho').checked;
  let lista = estadoConc.aAssociar.filter((e) => !soEmp || (e.nota_empenho && e.nota_empenho !== '—' && e.nota_empenho !== ''));
  if (termo) lista = lista.filter((e) => normalizarBusca(`${e.codigo_item} ${e.item} ${e.nota_empenho || ''}`).includes(termo));
  document.getElementById('concAssocTotal').textContent = `${fmtNumero(lista.length)} de ${fmtNumero(estadoConc.aAssociar.length)}`;
  const mostra = lista.slice(0, 200);
  if (!mostra.length) { corpo.innerHTML = ''; vazio.hidden = false; return; }
  vazio.hidden = true;
  corpo.innerHTML = mostra.map((e, i) => `<tr>
      <td class="col-codigo">${escHtml((e.data_entrada || '').slice(0, 16))}</td>
      <td><div style="font-weight:500;">${escHtml(e.item || '—')}</div><div class="col-codigo">${escHtml(e.codigo_item)}</div></td>
      <td class="num" style="font-weight:600;">${fmtNumero(e.qtde)}</td>
      <td class="col-codigo">${escHtml(e.nota_empenho || '—')}</td>
      <td style="text-align:right;"><button class="botao-primario conc-assoc" data-idx="${i}" style="padding:4px 10px; font-size:12px;">Associar</button></td>
    </tr>`).join('') + (lista.length > 200 ? `<tr><td colspan="5" class="texto-apoio" style="text-align:center;">Mostrando 200 de ${fmtNumero(lista.length)}. Refine a busca.</td></tr>` : '');
  corpo.querySelectorAll('.conc-assoc').forEach((b) => b.addEventListener('click', () => abrirModalAssoc(mostra[Number(b.dataset.idx)])));
}

async function abrirModalAssoc(entrada) {
  estadoConc.modalEntrada = entrada; estadoConc.escolha = null;
  document.getElementById('concEntradaBox').innerHTML = [
    ['Item', escHtml(entrada.item || entrada.codigo_item)],
    ['SCODES', `<span class="col-codigo">${escHtml(entrada.codigo_item)}</span>`],
    ['Entrada', `<span class="col-codigo">${escHtml((entrada.data_entrada || '').slice(0, 16))}</span>`],
    ['Qtde a baixar', `<b>${fmtNumero(entrada.qtde)}</b>`],
    ['Empenho', `<span class="col-codigo">${escHtml(entrada.nota_empenho || '—')}</span>`],
  ].map(([k, v]) => `<div><div class="texto-apoio" style="font-size:10.5px; text-transform:uppercase;">${k}</div><div style="font-weight:600; font-size:13px;">${v}</div></div>`).join('');
  const corpo = document.getElementById('concCorpoCompras');
  corpo.innerHTML = '<p class="texto-apoio" style="padding:8px 0;">Carregando compras em aberto…</p>';
  document.getElementById('concResultado').hidden = true;
  document.getElementById('concConfirmar').disabled = true;
  document.getElementById('modalAssociarEntrada').hidden = false;
  try {
    const d = await api('/conciliacao/entrada/compras-abertas?codigo=' + encodeURIComponent(entrada.codigo_item));
    if (!d.compras.length) { corpo.innerHTML = '<p class="texto-apoio" style="padding:8px 0;">Nenhuma compra em aberto para este SCODES.</p>'; return; }
    corpo.innerHTML = `<table class="tabela"><tbody>${d.compras.map((c, i) => `
      <tr class="conc-opt" data-idx="${i}" style="cursor:pointer;">
        <td style="width:26px;"><input type="radio" name="concCompra" value="${i}"></td>
        <td><b>${escHtml(c.mes)}/${escHtml(String(c.ano))} · ${escHtml(c.tipo)}</b>
          <div class="texto-apoio" style="font-size:12px;">${escHtml(c.status)} · pendente ${fmtNumero(c.pendente)} · ${c.n_empenho ? 'empenho ' + escHtml(c.n_empenho) : 'sem empenho'}</div></td>
      </tr>`).join('')}</tbody></table>`;
    corpo._compras = d.compras;
    corpo.querySelectorAll('.conc-opt').forEach((o) => o.addEventListener('click', () => selecionarCompraConc(Number(o.dataset.idx))));
  } catch (e) { corpo.innerHTML = `<p class="texto-apoio" style="color:var(--vermelho);">Erro: ${escHtml(e.message)}</p>`; }
}

function selecionarCompraConc(idx) {
  const corpo = document.getElementById('concCorpoCompras');
  const c = corpo._compras[idx]; estadoConc.escolha = c;
  corpo.querySelectorAll('.conc-opt').forEach((o, i) => { o.style.background = i === idx ? 'var(--realce-tabela)' : ''; const r = o.querySelector('input'); if (r) r.checked = i === idx; });
  const q = estadoConc.modalEntrada.qtde;
  const res = document.getElementById('concResultado');
  let html;
  if (q >= c.pendente) {
    const sobra = q - c.pendente;
    html = `<b>Finalizado</b> — baixa ${fmtNumero(c.pendente)} de ${fmtNumero(c.pendente)}; a compra de ${escHtml(c.mes)} é finalizada.` + (sobra > 0 ? ` <span style="color:#b45309;">Sobra ${fmtNumero(sobra)} un.</span>` : '');
  } else {
    html = `<b>Entrega Parcial</b> — baixa ${fmtNumero(q)} de ${fmtNumero(c.pendente)}; pendente cai para ${fmtNumero(c.pendente - q)}.`;
  }
  const emp = estadoConc.modalEntrada.nota_empenho;
  if (emp && emp !== '—' && c.n_empenho && normalizarBusca(emp).replace(/ne0*/g, 'ne') !== normalizarBusca(c.n_empenho).replace(/ne0*/g, 'ne')) {
    html += `<br><span style="color:#b45309;">⚠ Empenho divergente: entrada ${escHtml(emp)} ≠ compra ${escHtml(c.n_empenho)} — confirme.</span>`;
  }
  res.innerHTML = html; res.hidden = false;
  document.getElementById('concConfirmar').disabled = false;
}

async function confirmarAssocConc() {
  const e = estadoConc.modalEntrada, c = estadoConc.escolha;
  if (!c) return;
  const btn = document.getElementById('concConfirmar'); btn.disabled = true;
  try {
    const r = await api('/conciliacao/entrada/associar-manual', { method: 'POST', body: JSON.stringify({
      solicitacao_id: c.id, quantidade: e.qtde, chave_origem: e.chave_origem,
      detalhe: { item: e.item, data_entrada: e.data_entrada, nota_fiscal: e.nota_fiscal, nota_empenho: e.nota_empenho, lote: e.lote, qtde: e.qtde },
    }) });
    document.getElementById('modalAssociarEntrada').hidden = true;
    mostrarToast(`Associado a ${c.mes} — ${r.status}.`);
    await Promise.all([carregarConcAssociar(), carregarConcAuditoria()]);
  } catch (err) { alert(err.message); btn.disabled = false; }
}

function renderConcAud() {
  const corpo = document.getElementById('concAudBody');
  const vazio = document.getElementById('concAudVazio');
  document.getElementById('contAud').textContent = estadoConc.auditoria.length ? `(${estadoConc.auditoria.length})` : '';
  if (!estadoConc.auditoria.length) { corpo.innerHTML = ''; vazio.hidden = false; return; }
  vazio.hidden = true;
  corpo.innerHTML = estadoConc.auditoria.map((a) => {
    const d = a.detalhe || {};
    const badge = a.status === 'Finalizado'
      ? '<span class="tag-status" style="background:#1f7a5c22; color:#1f7a5c; border:1px solid #1f7a5c55;">Finalizado</span>'
      : '<span class="tag-status" style="background:#b4530922; color:#b45309; border:1px solid #b4530955;">Entrega Parcial</span>';
    return `<tr${a.desfeita ? ' style="opacity:.5;"' : ''}>
      <td class="col-codigo">${escHtml((a.criado_em || '').slice(0, 16))}</td>
      <td><div style="font-weight:500;">${escHtml(d.item || a.codigo_item)}</div><div class="col-codigo">${escHtml(a.codigo_item)}</div></td>
      <td class="col-codigo">${escHtml((d.data_entrada || '').slice(0, 10))}</td>
      <td>${escHtml(a.mes || '')}/${escHtml(String(a.ano || ''))} · ${escHtml(a.tipo || '')}</td>
      <td class="num" style="font-weight:600;">${fmtNumero(a.quantidade)}</td>
      <td>${a.desfeita ? '<span class="texto-apoio">desfeita</span>' : badge}</td>
      <td class="texto-apoio">${a.como === 'manual' ? 'Manual' : 'Robô'}</td>
      <td style="text-align:right;">${a.desfeita ? '' : `<button class="botao-secundario conc-undo" data-id="${a.id}" style="padding:4px 10px; font-size:12px;">Desfazer</button>`}</td>
    </tr>`;
  }).join('');
  corpo.querySelectorAll('.conc-undo').forEach((b) => b.addEventListener('click', () => desfazerConc(b.dataset.id)));
}
async function desfazerConc(id) {
  if (!confirm('Desfazer esta baixa? A compra volta ao status anterior.')) return;
  try {
    await api('/conciliacao/desfazer/' + id, { method: 'POST' });
    mostrarToast('Baixa desfeita.');
    await Promise.all([carregarConcAuditoria(), carregarConcAssociar(), carregarConcPropostas()]);
  } catch (e) { alert(e.message); }
}

// Listeners da tela Associar Entrada
document.querySelectorAll('#abasConciliacao .chip-faixa').forEach((b) => b.addEventListener('click', () => mostrarAbaConc(b.dataset.aba)));
document.getElementById('concBuscaAssoc').addEventListener('input', renderConcAssoc);
document.getElementById('concSoComEmpenho').addEventListener('change', renderConcAssoc);
document.getElementById('concCancelar').addEventListener('click', () => { document.getElementById('modalAssociarEntrada').hidden = true; });
document.getElementById('modalAssociarEntrada').addEventListener('click', (ev) => { if (ev.target.id === 'modalAssociarEntrada') ev.currentTarget.hidden = true; });
document.getElementById('concConfirmar').addEventListener('click', confirmarAssocConc);
document.getElementById('botaoGerarConciliacao').addEventListener('click', async () => {
  const btn = document.getElementById('botaoGerarConciliacao'); btn.disabled = true; btn.textContent = '🤖 Rodando…';
  try {
    const r = await api('/conciliacao/entrada/gerar', { method: 'POST' });
    mostrarToast(`Robô rodou: ${r.total} proposta(s) — ${r.alta} alta, ${r.revisar} revisar.`);
    await carregarAssociarEntrada();
  } catch (e) { alert(e.message); }
  btn.disabled = false; btn.textContent = '🤖 Rodar robô agora';
});

// ==================== Robô de Empenhos ====================
const estadoEmp = { aba: 'pend', propostas: [], aAssociar: [], auditoria: [], modalCompra: null, escolha: null };

async function carregarRoboEmpenhos() {
  await Promise.all([carregarEmpPropostas(), carregarEmpAssociar(), carregarEmpAuditoria()]);
  mostrarAbaEmp(estadoEmp.aba);
}
async function carregarEmpPropostas() {
  try { estadoEmp.propostas = (await api('/conciliacao/empenho/propostas')).propostas || []; } catch (e) { estadoEmp.propostas = []; }
  renderEmpPend();
}
async function carregarEmpAssociar() {
  try { estadoEmp.aAssociar = (await api('/conciliacao/empenho/a-associar')).fila || []; } catch (e) { estadoEmp.aAssociar = []; }
  renderEmpAssoc();
}
async function carregarEmpAuditoria() {
  try { estadoEmp.auditoria = (await api('/conciliacao/auditoria?origem=empenho')).auditoria || []; } catch (e) { estadoEmp.auditoria = []; }
  renderEmpAud();
}
function mostrarAbaEmp(aba) {
  estadoEmp.aba = aba;
  document.querySelectorAll('#abasEmpenhos .chip-faixa').forEach((b) => b.classList.toggle('ativo', b.dataset.aba === aba));
  document.getElementById('empViewPend').hidden = aba !== 'pend';
  document.getElementById('empViewAssoc').hidden = aba !== 'assoc';
  document.getElementById('empViewAud').hidden = aba !== 'aud';
}
function sinaisEmp(s) {
  const rot = { SCODES: 'SCODES', Requisicao: 'Requisição', SEI: 'SEI', Quantidade: 'Quantidade' };
  return '<div style="display:flex; gap:4px; flex-wrap:wrap; margin-top:5px;">' + Object.keys(rot).map((k) => {
    const ok = s[k];
    const cor = ok ? 'background:#1f7a5c18; color:#1f7a5c; border-color:#1f7a5c40;' : 'background:var(--realce-tabela); color:var(--cinza-texto); border-color:var(--linha);';
    return `<span style="font-size:10.5px; padding:1px 6px; border-radius:5px; border:1px solid; ${cor}${ok ? '' : ' text-decoration:line-through;'}">${ok ? '✓' : '✕'} ${rot[k]}</span>`;
  }).join('') + '</div>';
}
function renderEmpPend() {
  const corpo = document.getElementById('empPendBody'), vazio = document.getElementById('empPendVazio');
  document.getElementById('empContPend').textContent = estadoEmp.propostas.length ? `(${estadoEmp.propostas.length})` : '';
  if (!estadoEmp.propostas.length) { corpo.innerHTML = ''; vazio.hidden = false; return; }
  vazio.hidden = true;
  corpo.innerHTML = estadoEmp.propostas.map((p) => {
    const d = p.detalhe || {};
    return `<tr>
      <td><b>${escHtml(d.sol_mes || '')}/${escHtml(String(d.sol_ano || ''))} · ${escHtml(d.sol_tipo || '')}</b>
        <div class="col-codigo">${escHtml(p.codigo_item)}</div>
        <div class="texto-apoio" style="font-size:11.5px;">${escHtml(d.sol_status || '')} · solicitada ${fmtNumero(d.sol_solicitada || 0)}</div></td>
      <td><b class="col-codigo" style="font-size:13px;">${escHtml(d.nota_empenho || '—')}</b>
        <div class="texto-apoio" style="font-size:11.5px;">qtde ${fmtNumero(d.quantidade || 0)}${d.numero_requisicao ? ' · req ' + escHtml(d.numero_requisicao) : ''}</div>
        <div class="texto-apoio" style="font-size:11px;">${escHtml((d.empresa || '').slice(0, 34))}</div></td>
      <td>${chipConfConc(p.confianca)}${sinaisEmp(p.sinais || {})}</td>
      <td><span class="tag-status" style="background:#1c6cad22; color:#1c6cad; border:1px solid #1c6cad55;">→ Empenhado</span></td>
      <td style="text-align:right; white-space:nowrap;">
        <button class="botao-secundario emp-rej" data-id="${p.id}" style="padding:4px 10px; font-size:12px;">Rejeitar</button>
        <button class="botao-primario emp-apr" data-id="${p.id}" style="padding:4px 10px; font-size:12px;">Aprovar</button></td>
    </tr>`;
  }).join('');
  corpo.querySelectorAll('.emp-apr').forEach((b) => b.addEventListener('click', () => aprovarEmp(b.dataset.id)));
  corpo.querySelectorAll('.emp-rej').forEach((b) => b.addEventListener('click', () => rejeitarEmp(b.dataset.id)));
}
async function aprovarEmp(id) {
  try {
    const r = await api('/conciliacao/empenho/aprovar/' + id, { method: 'POST' });
    mostrarToast(`Empenho ${r.n_empenho} preenchido — status ${r.status}.`);
    await Promise.all([carregarEmpPropostas(), carregarEmpAssociar(), carregarEmpAuditoria()]);
  } catch (e) { alert(e.message); }
}
async function rejeitarEmp(id) {
  try { await api('/conciliacao/empenho/rejeitar/' + id, { method: 'POST' }); await carregarEmpPropostas(); }
  catch (e) { alert(e.message); }
}
function renderEmpAssoc() {
  const corpo = document.getElementById('empAssocBody'), vazio = document.getElementById('empAssocVazio');
  document.getElementById('empContAssoc').textContent = estadoEmp.aAssociar.length ? `(${estadoEmp.aAssociar.length})` : '';
  const termo = normalizarBusca(document.getElementById('empBuscaAssoc').value || '');
  let lista = estadoEmp.aAssociar;
  if (termo) lista = lista.filter((s) => normalizarBusca(`${s.codigo_item} ${s.mes} ${s.ano}`).includes(termo));
  document.getElementById('empAssocTotal').textContent = `${fmtNumero(lista.length)} de ${fmtNumero(estadoEmp.aAssociar.length)}`;
  const mostra = lista.slice(0, 200);
  if (!mostra.length) { corpo.innerHTML = ''; vazio.hidden = false; return; }
  vazio.hidden = true;
  corpo.innerHTML = mostra.map((s, i) => `<tr>
      <td><b>${escHtml(s.mes)}/${escHtml(String(s.ano))} · ${escHtml(s.tipo)}</b><div class="texto-apoio" style="font-size:11.5px;">${escHtml(s.status)}</div></td>
      <td class="col-codigo">${escHtml(s.codigo_item)}</td>
      <td class="num" style="font-weight:600;">${fmtNumero(s.solicitada || 0)}</td>
      <td class="col-codigo">${escHtml(s.requisicao_gsnet || '—')}</td>
      <td style="text-align:right;"><button class="botao-primario emp-assoc" data-idx="${i}" style="padding:4px 10px; font-size:12px;">Escolher empenho</button></td>
    </tr>`).join('') + (lista.length > 200 ? `<tr><td colspan="5" class="texto-apoio" style="text-align:center;">Mostrando 200 de ${fmtNumero(lista.length)}. Refine a busca.</td></tr>` : '');
  corpo.querySelectorAll('.emp-assoc').forEach((b) => b.addEventListener('click', () => abrirModalEmp(mostra[Number(b.dataset.idx)])));
}
async function abrirModalEmp(compra) {
  estadoEmp.modalCompra = compra; estadoEmp.escolha = null;
  document.getElementById('empCompraBox').innerHTML = [
    ['Compra', `<b>${escHtml(compra.mes)}/${escHtml(String(compra.ano))} · ${escHtml(compra.tipo)}</b>`],
    ['SCODES', `<span class="col-codigo">${escHtml(compra.codigo_item)}</span>`],
    ['Solicitada', `<b>${fmtNumero(compra.solicitada || 0)}</b>`],
    ['Requisição GSNET', `<span class="col-codigo">${escHtml(compra.requisicao_gsnet || '—')}</span>`],
    ['Status', escHtml(compra.status)],
  ].map(([k, v]) => `<div><div class="texto-apoio" style="font-size:10.5px; text-transform:uppercase;">${k}</div><div style="font-weight:600; font-size:13px;">${v}</div></div>`).join('');
  const corpo = document.getElementById('empCorpoCandidatos');
  corpo.innerHTML = '<p class="texto-apoio" style="padding:8px 0;">Buscando empenhos candidatos…</p>';
  document.getElementById('empResultado').hidden = true;
  document.getElementById('empConfirmar').disabled = true;
  document.getElementById('modalAssociarEmpenho').hidden = false;
  try {
    const d = await api('/conciliacao/empenho/candidatos?codigo=' + encodeURIComponent(compra.codigo_item));
    if (!d.empenhos.length) { corpo.innerHTML = '<p class="texto-apoio" style="padding:8px 0;">Nenhum empenho encontrado para este SCODES/Siafísico no Controle de Empenhos.</p>'; return; }
    corpo.innerHTML = `<table class="tabela"><tbody>${d.empenhos.map((e, i) => `
      <tr class="emp-opt" data-idx="${i}" style="cursor:${e.ja_associado ? 'not-allowed' : 'pointer'}; ${e.ja_associado ? 'opacity:.45;' : ''}">
        <td style="width:26px;"><input type="radio" name="empCand" value="${i}" ${e.ja_associado ? 'disabled' : ''}></td>
        <td><b class="col-codigo" style="font-size:13px;">${escHtml(e.nota_empenho || '—')}</b>${e.ja_associado ? ' <span class="texto-apoio">(já usado)</span>' : ''}
          <div class="texto-apoio" style="font-size:12px;">qtde ${fmtNumero(e.quantidade || 0)}${e.numero_requisicao ? ' · req ' + escHtml(e.numero_requisicao) : ''} · ${escHtml((e.empresa || '').slice(0, 30))}</div></td>
      </tr>`).join('')}</tbody></table>`;
    corpo._emps = d.empenhos;
    corpo.querySelectorAll('.emp-opt').forEach((o) => o.addEventListener('click', () => {
      const e = corpo._emps[Number(o.dataset.idx)];
      if (e.ja_associado) return;
      selecionarEmpCand(Number(o.dataset.idx));
    }));
  } catch (e) { corpo.innerHTML = `<p class="texto-apoio" style="color:var(--vermelho);">Erro: ${escHtml(e.message)}</p>`; }
}
function selecionarEmpCand(idx) {
  const corpo = document.getElementById('empCorpoCandidatos');
  const e = corpo._emps[idx]; estadoEmp.escolha = e;
  corpo.querySelectorAll('.emp-opt').forEach((o, i) => { o.style.background = i === idx ? 'var(--realce-tabela)' : ''; const r = o.querySelector('input'); if (r && !r.disabled) r.checked = i === idx; });
  const c = estadoEmp.modalCompra;
  const novoStatus = (c.status === 'Planejamento' || c.status === 'Adjudicado') ? 'Empenhado' : c.status;
  const res = document.getElementById('empResultado');
  res.innerHTML = `Preenche <b>Nº Empenho ${escHtml(e.nota_empenho)}</b> e <b>Qtde Empenhada ${fmtNumero(e.quantidade || 0)}</b>` + (novoStatus !== c.status ? ` · status <b>${escHtml(c.status)} → ${escHtml(novoStatus)}</b>.` : ` · status mantém <b>${escHtml(c.status)}</b>.`);
  res.hidden = false;
  document.getElementById('empConfirmar').disabled = false;
}
async function confirmarAssocEmp() {
  const c = estadoEmp.modalCompra, e = estadoEmp.escolha; if (!e) return;
  const btn = document.getElementById('empConfirmar'); btn.disabled = true;
  try {
    const r = await api('/conciliacao/empenho/associar-manual', { method: 'POST', body: JSON.stringify({
      solicitacao_id: c.solicitacao_id, chave_origem: e.chave_origem,
      detalhe: { nota_empenho: e.nota_empenho, quantidade: e.quantidade, empresa: e.empresa, numero_requisicao: e.numero_requisicao, processo: e.processo, sol_mes: c.mes, sol_ano: c.ano, sol_tipo: c.tipo },
    }) });
    document.getElementById('modalAssociarEmpenho').hidden = true;
    mostrarToast(`Empenho ${r.n_empenho} preenchido — status ${r.status}.`);
    await Promise.all([carregarEmpAssociar(), carregarEmpAuditoria()]);
  } catch (err) { alert(err.message); btn.disabled = false; }
}
function renderEmpAud() {
  const corpo = document.getElementById('empAudBody'), vazio = document.getElementById('empAudVazio');
  document.getElementById('empContAud').textContent = estadoEmp.auditoria.length ? `(${estadoEmp.auditoria.length})` : '';
  if (!estadoEmp.auditoria.length) { corpo.innerHTML = ''; vazio.hidden = false; return; }
  vazio.hidden = true;
  corpo.innerHTML = estadoEmp.auditoria.map((a) => {
    const d = a.detalhe || {};
    return `<tr${a.desfeita ? ' style="opacity:.5;"' : ''}>
      <td class="col-codigo">${escHtml((a.criado_em || '').slice(0, 16))}</td>
      <td><div style="font-weight:500;">${escHtml(d.medicamento || d.item || a.codigo_item)}</div><div class="col-codigo">${escHtml(a.codigo_item)}</div></td>
      <td>${escHtml(a.mes || '')}/${escHtml(String(a.ano || ''))} · ${escHtml(a.tipo || '')}</td>
      <td class="col-codigo">${escHtml(d.nota_empenho || '—')}</td>
      <td class="num" style="font-weight:600;">${fmtNumero(a.quantidade || 0)}</td>
      <td>${a.desfeita ? '<span class="texto-apoio">desfeita</span>' : '<span class="tag-status" style="background:#1c6cad22; color:#1c6cad; border:1px solid #1c6cad55;">' + escHtml(a.status || 'Empenhado') + '</span>'}</td>
      <td class="texto-apoio">${a.como === 'manual' ? 'Manual' : 'Robô'}</td>
      <td style="text-align:right;">${a.desfeita ? '' : `<button class="botao-secundario emp-undo" data-id="${a.id}" style="padding:4px 10px; font-size:12px;">Desfazer</button>`}</td>
    </tr>`;
  }).join('');
  corpo.querySelectorAll('.emp-undo').forEach((b) => b.addEventListener('click', () => desfazerEmp(b.dataset.id)));
}
async function desfazerEmp(id) {
  if (!confirm('Desfazer este empenho? A compra volta ao status e empenho anteriores.')) return;
  try {
    await api('/conciliacao/desfazer/' + id, { method: 'POST' });
    mostrarToast('Empenho desfeito.');
    await Promise.all([carregarEmpAuditoria(), carregarEmpAssociar(), carregarEmpPropostas()]);
  } catch (e) { alert(e.message); }
}
document.querySelectorAll('#abasEmpenhos .chip-faixa').forEach((b) => b.addEventListener('click', () => mostrarAbaEmp(b.dataset.aba)));
document.getElementById('empBuscaAssoc').addEventListener('input', renderEmpAssoc);
document.getElementById('empCancelar').addEventListener('click', () => { document.getElementById('modalAssociarEmpenho').hidden = true; });
document.getElementById('modalAssociarEmpenho').addEventListener('click', (ev) => { if (ev.target.id === 'modalAssociarEmpenho') ev.currentTarget.hidden = true; });
document.getElementById('empConfirmar').addEventListener('click', confirmarAssocEmp);
document.getElementById('botaoGerarEmpenhos').addEventListener('click', async () => {
  const btn = document.getElementById('botaoGerarEmpenhos'); btn.disabled = true; btn.textContent = '🤖 Rodando…';
  try {
    const r = await api('/conciliacao/empenho/gerar', { method: 'POST' });
    mostrarToast(`Robô rodou: ${r.total} proposta(s) — ${r.alta} alta, ${r.revisar} revisar.`);
    await carregarRoboEmpenhos();
  } catch (e) { alert(e.message); }
  btn.disabled = false; btn.textContent = '🤖 Rodar robô agora';
});

// -------------------- Comparativo de Autores (anterior × atual) --------------------
let dadosComparativo = null;
let abaComparativoAtiva = 'novos';

document.querySelectorAll('#abasComparativo .chip-faixa').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#abasComparativo .chip-faixa').forEach((b) => b.classList.toggle('ativo', b === btn));
    renderAbaComparativo(btn.dataset.aba);
  });
});

async function carregarComparativo() {
  const dados = await api('/autores/comparacao');
  dadosComparativo = dados;

  if (!dados.temAnterior) {
    document.getElementById('avisoSemComparativo').hidden = false;
    document.getElementById('conteudoComparativo').hidden = true;
    return;
  }
  document.getElementById('avisoSemComparativo').hidden = true;
  document.getElementById('conteudoComparativo').hidden = false;

  const diffTotal = dados.totalAtual - dados.totalAnterior;
  const sinalTotal = (diffTotal > 0 ? '+' : '') + fmtNumero(diffTotal);
  document.getElementById('grideKpiComparativo').innerHTML = `
    <div class="cartao-resumo"><div class="numero" style="font-size:18px;">${formatarData(dados.anterior)}</div><div class="rotulo">Arquivo anterior</div></div>
    <div class="cartao-resumo"><div class="numero" style="font-size:18px;">${formatarData(dados.atual)}</div><div class="rotulo">Arquivo atual</div></div>
    <div class="cartao-resumo"><div class="numero">${fmtNumero(dados.totalAnterior)}</div><div class="rotulo">Total anterior</div></div>
    <div class="cartao-resumo"><div class="numero">${fmtNumero(dados.totalAtual)}</div><div class="rotulo">Total atual (${sinalTotal})</div></div>
    <div class="cartao-resumo"><div class="numero" style="color:var(--selo);">${fmtNumero(dados.totalNovosPacientes ?? dados.novos.length)}</div><div class="rotulo">Novos pacientes</div></div>
    <div class="cartao-resumo alerta"><div class="numero">${fmtNumero(dados.encerrados.length)}</div><div class="rotulo">Pacientes encerrados</div></div>
    <div class="cartao-resumo"><div class="numero">${fmtNumero(dados.alteracoes.length)}</div><div class="rotulo">Alterações</div></div>
  `;

  // atualiza rótulos das abas com contagens
  const ab = document.querySelectorAll('#abasComparativo .chip-faixa');
  ab[0].textContent = `Pacientes Novos (${dados.totalNovosPacientes ?? dados.novos.length})`;
  ab[1].textContent = `Pacientes Inativos (${dados.encerrados.length})`;
  ab[2].textContent = `Alterações (${dados.alteracoes.length})`;
  ab.forEach((b, i) => b.classList.toggle('ativo', i === 0));

  // Popula o filtro de subcategoria (preserva a seleção atual se ainda existir).
  const selSub = document.getElementById('filtroSubcategoriaComparativo');
  const subAtual = selSub.value;
  selSub.innerHTML = '<option value="">Subcategoria: todas</option>' +
    (dados.subcategorias || []).map((s) => `<option value="${s.replace(/"/g, '&quot;')}">${s}</option>`).join('');
  selSub.value = [...selSub.options].some((o) => o.value === subAtual) ? subAtual : '';

  const selTipo = document.getElementById('filtroTipoDemandaComparativo');
  const tipoAtual = selTipo.value;
  selTipo.innerHTML = '<option value="">Tipo de demanda: todos</option>' +
    (dados.tiposDemanda || []).map((t) => `<option value="${t.replace(/"/g, '&quot;')}">${t}</option>`).join('');
  selTipo.value = [...selTipo.options].some((o) => o.value === tipoAtual) ? tipoAtual : '';

  renderAbaComparativo('novos');
}

function renderAbaComparativo(aba) {
  if (!dadosComparativo) return;
  const cabecalho = document.getElementById('cabecalhoComparativo');
  const corpo = document.getElementById('corpoComparativo');
  const vazio = document.getElementById('vazioComparativo');

  abaComparativoAtiva = aba;
  // Filtros e KPIs dinâmicos só aparecem na aba Alterações
  const ehAlteracoes = aba === 'alteracoes';
  document.getElementById('filtrosAlteracoes').hidden = !ehAlteracoes;
  document.getElementById('kpiAlteracoes').hidden = !ehAlteracoes;

  // Filtros de subcategoria e tipo de demanda (valem para as 3 abas).
  const fSub = document.getElementById('filtroSubcategoriaComparativo').value;
  const fTipoDem = document.getElementById('filtroTipoDemandaComparativo').value;
  const passaSub = (e) => (!fSub || e.subcategoria === fSub) && (!fTipoDem || e.tipo_demanda === fTipoDem);

  let cols = [];
  let linhas = [];
  if (aba === 'novos') {
    cols = ['ID Demanda', 'Autor', 'Protocolo', 'Processo', 'Tipo da Demanda', 'Cód. Item', 'Descrição do Item', 'Qtde de Consumo'];
    linhas = dadosComparativo.novos.filter(passaSub).map((n) => [
      `<span class="col-codigo">${n.id_demanda}</span>`, n.autor,
      `<span class="col-codigo">${n.protocolo}</span>`, `<span class="col-codigo">${n.processo}</span>`,
      n.tipo_demanda, `<span class="col-codigo">${n.codigo_item}</span>`, n.descricao_item, n.qtde_consumo,
    ]);
  } else if (aba === 'encerrados') {
    cols = ['Autor', 'Processo', 'Último Item'];
    linhas = dadosComparativo.encerrados.filter(passaSub).map((e) => [e.autor, e.processo || '—', e.ultimo_item]);
  } else {
    // popula o filtro de categoria (1ª vez)
    const selCat = document.getElementById('filtroCategoriaAlteracao');
    if (selCat.options.length <= 1) {
      const cats = [...new Set(dadosComparativo.alteracoes.map((a) => a.categoria).filter((c) => c && c !== '—'))].sort();
      selCat.innerHTML = '<option value="">Categoria: todas</option>' + cats.map((c) => `<option value="${c.replace(/"/g, '&quot;')}">${c}</option>`).join('');
    }

    const fTipo = document.getElementById('filtroTipoAlteracao').value;
    const fCat = selCat.value;
    // base filtrada por categoria E subcategoria (para os KPIs por tipo)
    const baseCat = dadosComparativo.alteracoes.filter((a) => (!fCat || a.categoria === fCat) && passaSub(a));
    const conta = (t) => baseCat.filter((a) => a.alteracao === t).length;
    document.getElementById('kpiAlteracoes').innerHTML = `
      <div class="cartao-resumo"><div class="numero">${fmtNumero(baseCat.length)}</div><div class="rotulo">Total de alterações</div></div>
      <div class="cartao-resumo"><div class="numero" style="color:var(--selo);">${fmtNumero(conta('Novo medicamento'))}</div><div class="rotulo">Novo medicamento</div></div>
      <div class="cartao-resumo alerta"><div class="numero">${fmtNumero(conta('Item removido'))}</div><div class="rotulo">Item removido</div></div>
      <div class="cartao-resumo"><div class="numero">${fmtNumero(conta('Status alterado'))}</div><div class="rotulo">Status alterado</div></div>
    `;

    const filtradas = baseCat.filter((a) => !fTipo || a.alteracao === fTipo);
    cols = ['Autor', 'Protocolo', 'Cód. Item', 'Categoria', 'Qtde Consumo', 'Alteração', 'Detalhe'];
    linhas = filtradas.map((a) => {
      const cls = a.alteracao === 'Novo medicamento' ? 'finalizado' : (a.alteracao === 'Item removido' ? 'cancelado' : 'planejamento');
      return [a.autor, `<span class="col-codigo">${a.protocolo || '—'}</span>`, `<span class="col-codigo">${a.codigo_item || '—'}</span>`,
        a.categoria || '—', a.qtde_consumo || '—', `<span class="etiqueta-status ${cls}">${a.alteracao}</span>`, a.detalhe];
    });
  }

  cabecalho.innerHTML = '<tr>' + cols.map((c) => `<th>${c}</th>`).join('') + '</tr>';
  if (linhas.length === 0) {
    corpo.innerHTML = ''; vazio.hidden = false;
  } else {
    vazio.hidden = true;
    // Na aba "novos", cada linha é clicável e abre o detalhe do item (o
    // código e o protocolo vão em data-* para o modal saber o que buscar).
    const meta = aba === 'novos' ? dadosComparativo.novos : null;
    corpo.innerHTML = linhas.slice(0, 2000).map((l, idx) => {
      const attrs = meta
        ? ` class="linha-clicavel" data-codigo="${escAttr(meta[idx].codigo_item)}"`
          + ` data-protocolo="${escAttr(meta[idx].protocolo || '')}"`
          + ` data-descricao="${escAttr(meta[idx].descricao_item || '')}" title="Ver estoque, autonomia e compras deste item"`
        : '';
      return `<tr${attrs}>` + l.map((celula) => `<td>${celula}</td>`).join('') + '</tr>';
    }).join('');
    if (meta) {
      corpo.querySelectorAll('.linha-clicavel').forEach((tr) => {
        tr.addEventListener('click', () => abrirPacienteNovo(tr.dataset.codigo, tr.dataset.protocolo, tr.dataset.descricao));
      });
    }
  }
  document.getElementById('contagemComparativo').textContent = `${fmtNumero(linhas.length)} registro(s)`;
}

// Filtros da aba Alterações re-renderizam a aba
['filtroTipoAlteracao', 'filtroCategoriaAlteracao'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => renderAbaComparativo('alteracoes'));
});
// Filtros de subcategoria e tipo de demanda valem para as 3 abas: re-renderizam a aba ativa.
['filtroSubcategoriaComparativo', 'filtroTipoDemandaComparativo'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => {
    renderAbaComparativo(abaComparativoAtiva || 'novos');
  });
});

// Monta {cols, linhas} em TEXTO PURO da aba (para exportar)
function dadosTextoComparativo(aba) {
  if (!dadosComparativo) return { cols: [], linhas: [] };
  if (aba === 'novos') {
    return {
      cols: ['ID Demanda', 'Autor', 'Protocolo', 'Processo', 'Tipo da Demanda', 'Cód. Item', 'Descrição do Item', 'Qtde de Consumo'],
      linhas: dadosComparativo.novos.map((n) => [n.id_demanda, n.autor, n.protocolo, n.processo, n.tipo_demanda, n.codigo_item, n.descricao_item, n.qtde_consumo]),
    };
  }
  if (aba === 'encerrados') {
    return {
      cols: ['Autor', 'Processo', 'Último Item'],
      linhas: dadosComparativo.encerrados.map((e) => [e.autor, e.processo || '—', e.ultimo_item]),
    };
  }
  // alterações (respeita os filtros atuais)
  const fTipo = document.getElementById('filtroTipoAlteracao').value;
  const fCat = document.getElementById('filtroCategoriaAlteracao').value;
  const filtradas = dadosComparativo.alteracoes
    .filter((a) => !fCat || a.categoria === fCat)
    .filter((a) => !fTipo || a.alteracao === fTipo);
  return {
    cols: ['Autor', 'Protocolo', 'Cód. Item', 'Categoria', 'Qtde Consumo', 'Alteração', 'Detalhe'],
    linhas: filtradas.map((a) => [a.autor, a.protocolo, a.codigo_item, a.categoria, a.qtde_consumo, a.alteracao, a.detalhe]),
  };
}

document.getElementById('botaoExportarComparativo').addEventListener('click', () => {
  const aba = abaComparativoAtiva;
  const { cols, linhas } = dadosTextoComparativo(aba);
  if (linhas.length === 0) { alert('Não há registros para exportar nesta aba.'); return; }

  const campo = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = '﻿' + [cols.map(campo).join(';'), ...linhas.map((l) => l.map(campo).join(';'))].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const nomeAba = { novos: 'pacientes-novos', encerrados: 'pacientes-inativos', alteracoes: 'alteracoes' }[aba] || aba;
  a.href = url;
  a.download = `comparativo_${nomeAba}_${dadosComparativo.atual || ''}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// -------------------- Requisição de Compra (construtor) --------------------
let reqPacienteAtual = null;
let reqItensAtuais = [];
let reqModo = 'novo';      // 'novo' ou 'editar'
let reqEditId = null;      // id da requisição em edição

const modalRequisicao = document.getElementById('modalRequisicao');
document.getElementById('botaoAbrirRequisicao').addEventListener('click', abrirRequisicao);
document.getElementById('botaoFecharRequisicao').addEventListener('click', () => fecharRequisicaoComConfirmacao());
document.getElementById('reqVoltar').addEventListener('click', voltarParaBuscaPaciente);
document.getElementById('botaoGerarRequisicao').addEventListener('click', gerarRequisicao);

function abrirRequisicao() {
  reqModo = 'novo';
  reqEditId = null;
  modalRequisicao.hidden = false;
  document.getElementById('botaoGerarRequisicao').textContent = 'Gerar requisição →';
  document.getElementById('reqApenasRegistro').checked = false;
  // Abas de modo visíveis; começa em "Por paciente".
  document.getElementById('reqModoAbas').hidden = false;
  reqModoAtual = 'paciente';
  document.querySelectorAll('#reqModoAbas .req-modo-aba').forEach((b) => b.classList.toggle('ativo', b.dataset.modo === 'paciente'));
  document.getElementById('reqModoColetiva').hidden = true;
  document.getElementById('botaoGerarColetiva').hidden = true;
  colTabs = []; // zera a solicitação coletiva anterior
  voltarParaBuscaPaciente();
}

// Abre o construtor já com a requisição salva carregada, para edição
async function editarRequisicao(id) {
  const dados = await api(`/autores/requisicoes/${id}`);
  const r = dados.requisicao;
  reqModo = 'editar';
  reqEditId = id;
  modalRequisicao.hidden = false;
  // Edição é sempre por paciente: esconde as abas e o modo coletiva.
  document.getElementById('reqModoAbas').hidden = true;
  document.getElementById('reqModoColetiva').hidden = true;
  document.getElementById('botaoGerarColetiva').hidden = true;
  document.getElementById('reqEtapaPaciente').hidden = true;

  await selecionarPaciente(r.autor);

  // Pré-preenche SEI e marca os itens que estavam na requisição
  document.getElementById('reqSEI').value = r.sei || '';
  const salvos = {};
  dados.itens.forEach((it) => { salvos[it.codigo_item] = it.quantidade; });
  document.querySelectorAll('#reqListaItens .req-check').forEach((c) => {
    const idx = Number(c.dataset.idx);
    const it = reqItensAtuais[idx];
    if (it && Object.prototype.hasOwnProperty.call(salvos, it.codigo_item)) {
      c.checked = true;
      const campoQtd = document.querySelector(`.req-qtd[data-idx="${idx}"]`);
      if (campoQtd) campoQtd.value = salvos[it.codigo_item];
    }
  });
  atualizarContadorReq();

  document.getElementById('reqVoltar').hidden = true; // paciente fixo na edição
  document.getElementById('botaoGerarRequisicao').textContent = `Salvar alterações (${r.codigo_controle})`;
}

async function cancelarRequisicao(id) {
  if (!confirm('Cancelar esta requisição? Ela continua no histórico, marcada como Cancelada.')) return;
  try {
    await api(`/autores/requisicoes/${id}/cancelar`, { method: 'PUT' });
    carregarTabelaRelReq();
  } catch (e) {
    alert('Erro ao cancelar: ' + e.message);
  }
}

function voltarParaBuscaPaciente() {
  reqPacienteAtual = null;
  reqItensAtuais = [];
  document.getElementById('reqEtapaPaciente').hidden = false;
  document.getElementById('reqEtapaItens').hidden = true;
  document.getElementById('reqVoltar').hidden = true;
  document.getElementById('botaoGerarRequisicao').hidden = true;
  document.getElementById('reqInputPaciente').value = '';
  document.getElementById('reqResultadosPaciente').innerHTML = '';
  const campoSei = document.getElementById('reqSEI');
  if (campoSei) campoSei.value = '';
  document.getElementById('reqInputPaciente').focus();
}

let debounceReqPaciente;
document.getElementById('reqInputPaciente').addEventListener('input', () => {
  clearTimeout(debounceReqPaciente);
  debounceReqPaciente = setTimeout(buscarPacienteRequisicao, 350);
});

async function buscarPacienteRequisicao() {
  const q = document.getElementById('reqInputPaciente').value.trim();
  const cont = document.getElementById('reqResultadosPaciente');
  if (q.length < 2) { cont.innerHTML = ''; return; }
  const { pacientes } = await api(`/autores/pacientes?q=${encodeURIComponent(q)}`);
  if (!pacientes.length) { cont.innerHTML = '<div class="estado-vazio">Nenhum paciente encontrado.</div>'; return; }
  cont.innerHTML = pacientes.map((p) => `
    <div class="req-paciente-card" data-autor="${(p.autor || '').replace(/"/g, '&quot;')}">
      <div><strong>${p.autor}</strong></div>
      <div class="col-codigo">${p.qtde_itens} item(ns) · processo ${p.processo || '—'}</div>
    </div>
  `).join('');
  cont.querySelectorAll('.req-paciente-card').forEach((c) => {
    c.addEventListener('click', () => selecionarPaciente(c.dataset.autor));
  });
}

// ===== Etiqueta de ATA na Requisição (visual; escolha vale só nesta requisição) =====
// Guarda a escolha do técnico (ATA/SEM_ATA) para itens de "Avaliação técnica",
// por id único. Zerado ao trocar de paciente / iniciar nova coletiva.
const escolhasAta = new Map();
// Valor unitário informado manualmente pelo técnico (quando não há valor), por id.
const valoresManual = new Map();

// Valor unitário efetivo do item: ATA usa o valor da ata; demais usam o valor
// médio; se ambos vazios, usa o que o técnico digitou (valoresManual).
function valorUnitFinal(item, id) {
  const ata = item.ata || {};
  const usaAta = ata.situacao === 'ATA' || (ata.situacao === 'AVALIACAO' && escolhasAta.get(id) === 'ATA');
  let base = usaAta ? ata.valor : item.valor_medio;
  base = (base != null && Number(base) > 0) ? Number(base) : null;
  if (base != null) return base;
  const man = valoresManual.get(id);
  return (man != null && man !== '' && isFinite(Number(man))) ? Number(man) : null;
}

// Container (vazio) do valor unitário do item; preenchido por preencherValorUnit.
function htmlValorUnit(item, id) {
  const ata = item.ata || {};
  return `<div class="ata-valor" data-vid="${id}" data-sit="${ata.situacao || ''}" data-vata="${ata.valor != null ? ata.valor : ''}" data-vmedio="${item.valor_medio != null ? item.valor_medio : ''}"></div>`;
}

// Preenche o container do valor: mostra o valor (ATA / valor médio) ou, se
// vazio, um campo para o técnico informar.
function preencherValorUnit(el) {
  const id = el.dataset.vid;
  const sit = el.dataset.sit;
  const vata = el.dataset.vata !== '' ? Number(el.dataset.vata) : null;
  const vmedio = el.dataset.vmedio !== '' ? Number(el.dataset.vmedio) : null;
  const usaAta = sit === 'ATA' || (sit === 'AVALIACAO' && escolhasAta.get(id) === 'ATA');
  let base = usaAta ? vata : vmedio;
  base = (base != null && base > 0) ? base : null;
  if (base != null) {
    el.innerHTML = `<span class="ata-valor-rot">Valor unitário:</span> <strong>${brlPlan(base)}</strong> <span class="ata-valor-fonte">(${usaAta ? 'ATA' : 'valor médio'})</span>`;
  } else {
    const man = valoresManual.get(id);
    el.innerHTML = `<span class="ata-valor-rot">Valor unitário (informar):</span> <input type="number" class="ata-valor-inp" data-vid="${id}" value="${man != null ? man : ''}" min="0" step="0.01" placeholder="R$" style="width:120px; padding:5px 8px; border:1px solid var(--linha); border-radius:4px; font-size:13px;">`;
  }
}

// Modalidade efetiva do item para o aviso de mistura: ATA (etiqueta ATA ou
// Avaliação técnica decidida como ATA), SEM_ATA, ou null (avaliação sem decisão).
function modalidadeEfetiva(situacao, escolha) {
  if (situacao === 'ATA') return 'ATA';
  if (situacao === 'SEM_ATA') return 'SEM_ATA';
  if (situacao === 'AVALIACAO') return escolha === 'ATA' ? 'ATA' : (escolha === 'SEM_ATA' ? 'SEM_ATA' : null);
  return null;
}

// Se a requisição mistura itens COM ATA e SEM ATA, pede confirmação.
// Recebe uma lista de modalidades efetivas ('ATA' | 'SEM_ATA' | null).
// Devolve true para prosseguir, false para cancelar.
function confirmarMisturaAta(modalidades) {
  const nAta = modalidades.filter((m) => m === 'ATA').length;
  const nSem = modalidades.filter((m) => m === 'SEM_ATA').length;
  if (nAta > 0 && nSem > 0) {
    return confirm(
      '⚠️ Esta requisição mistura itens COM ATA e itens SEM ATA.\n\n' +
      `• ${nAta} item(ns) com ATA\n` +
      `• ${nSem} item(ns) SEM ATA\n\n` +
      'O recomendado é separar a aquisição por modalidade — uma requisição para os itens de ATA e outra para os itens sem ATA.\n\n' +
      'Tem certeza disso?'
    );
  }
  return true;
}

function fmtDataAta(iso) {
  if (!iso) return '—';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso);
}

// Monta o HTML da etiqueta de ATA. `id` deve ser único e seguro (a-z0-9_).
function htmlEtiquetaAta(ata, id) {
  if (!ata || !ata.situacao) return '';
  if (ata.situacao === 'SEM_ATA') {
    return '<div class="ata-box"><span class="ata-pill sem">SEM ATA</span></div>';
  }
  const detalhe = `
    <div class="ata-detalhe" id="atadet-${id}"${ata.situacao === 'ATA' ? ' hidden' : ''}>
      <div><span class="rot">Nome comercial:</span> ${escHtml(ata.nome_comercial || '—')}</div>
      <div><span class="rot">Nº da ATA:</span> ${escHtml(ata.ata_numero || '—')} · <span class="rot">Detentor:</span> ${escHtml(ata.detentor || '—')}</div>
      <div><span class="rot">Vencimento:</span> ${fmtDataAta(ata.vencimento)}</div>
    </div>`;
  if (ata.situacao === 'ATA') {
    return `<div class="ata-box">
      <span class="ata-pill ata ata-toggle" data-id="${id}" role="button" tabindex="0">ATA ▾</span>
      ${detalhe}
    </div>`;
  }
  // AVALIACAO — o técnico decide ATA / SEM ATA
  const esc = escolhasAta.get(id) || '';
  return `<div class="ata-box">
    <span class="ata-pill av">⚠ Avaliação técnica</span>
    ${detalhe}
    <div>
      <span class="ata-esc ata-escolha ${esc === 'ATA' ? 'on' : ''}" data-id="${id}" data-esc="ATA">ATA</span>
      <span class="ata-esc ata-escolha ${esc === 'SEM_ATA' ? 'on' : ''}" data-id="${id}" data-esc="SEM_ATA">SEM ATA</span>
    </div>
  </div>`;
}

// Delegação global: abrir/fechar o detalhe da ATA e registrar a escolha.
document.addEventListener('click', (ev) => {
  const tog = ev.target.closest('.ata-toggle');
  if (tog) {
    const d = document.getElementById('atadet-' + tog.dataset.id);
    if (d) d.hidden = !d.hidden;
    return;
  }
  const esc = ev.target.closest('.ata-escolha');
  if (esc) {
    const id = esc.dataset.id;
    const novo = esc.dataset.esc;
    if (escolhasAta.get(id) === novo) escolhasAta.delete(id); else escolhasAta.set(id, novo);
    esc.parentElement.querySelectorAll('.ata-escolha').forEach((b) =>
      b.classList.toggle('on', escolhasAta.get(id) === b.dataset.esc));
    // A escolha ATA/SEM ATA muda a fonte do valor unitário — repinta o campo.
    document.querySelectorAll(`.ata-valor[data-vid="${cssEsc(id)}"]`).forEach(preencherValorUnit);
  }
});

// Valor unitário informado manualmente pelo técnico.
document.addEventListener('input', (ev) => {
  const inp = ev.target.closest('.ata-valor-inp');
  if (inp) valoresManual.set(inp.dataset.vid, inp.value);
});

async function selecionarPaciente(autor) {
  escolhasAta.clear();
  valoresManual.clear();
  const dados = await api(`/autores/paciente?autor=${encodeURIComponent(autor)}`);
  reqPacienteAtual = dados.info;
  reqItensAtuais = dados.itens;

  document.getElementById('reqEtapaPaciente').hidden = true;
  document.getElementById('reqEtapaItens').hidden = false;
  document.getElementById('reqVoltar').hidden = false;
  document.getElementById('botaoGerarRequisicao').hidden = false;

  const info = dados.info;
  document.getElementById('reqPacienteCabecalho').innerHTML = `
    <div style="background:var(--papel); border:1px solid var(--linha); border-radius:8px; padding:12px 14px;">
      <div style="font-size:15px; font-weight:600;">${info.autor}</div>
      <div class="col-codigo">${info.idade ? info.idade + ' anos · ' : ''}${info.unidade_dispensadora || ''}</div>
    </div>`;

  document.getElementById('reqListaItens').innerHTML = dados.itens.map((it, idx) => {
    const aut = it.autonomia_atual;
    let badge = '<span style="color:var(--cinza-texto); font-size:12px;">sem dado de estoque</span>';
    if (aut !== null && aut !== undefined) {
      const cls = aut <= 0 ? 'cancelado' : (aut <= 2 ? 'atrasado' : 'finalizado');
      const dem = (it.demanda_atual !== null && it.demanda_atual !== undefined) ? `demanda: ${fmtNumero(it.demanda_atual)} · ` : '';
      badge = `<span class="etiqueta-status ${cls}">${dem}estoque: ${fmtNumero(it.estoque_atual)} · autonomia ${fmtNumero(aut)} m</span>`;
    }
    const chip = (rotulo, valor) => (valor !== null && valor !== undefined && String(valor).trim() !== '')
      ? `<span style="display:inline-block; background:var(--realce-tabela); border:1px solid var(--linha); border-radius:4px; padding:1px 7px; margin:2px 4px 0 0; font-size:11px;"><strong>${rotulo}:</strong> ${valor}</span>`
      : '';
    const detalhes = [
      chip('Tipo de demanda', it.tipo_demanda),
      chip('Qtde de consumo', it.qtde_consumo),
      chip('Prazo', it.prazo),
      chip('Periodicidade', it.periodicidade),
      chip('Dispensações autorizadas', it.dispensacoes_autorizadas),
    ].join('');
    const consumoNum = parseNumeroReq(it.qtde_consumo);
    return `
      <label class="req-item" data-busca="${escAttr(normalizarBusca((it.descricao_item || '') + ' ' + (it.codigo_item || '') + ' ' + (it.cod_siafisico || '')))}" style="display:grid; grid-template-columns:24px 1fr 95px 110px; gap:10px; align-items:center; padding:9px 6px; border-bottom:1px solid var(--linha-tabela); cursor:pointer;">
        <input type="checkbox" class="req-check" data-idx="${idx}" style="width:auto;">
        <div>
          <div style="font-size:13px;">${it.descricao_item || '—'}</div>
          <div class="col-codigo">${it.codigo_item || ''}${it.cod_siafisico ? ' · SIAF ' + it.cod_siafisico : ''}</div>
          ${it.subcategoria && String(it.subcategoria).trim() ? `<div class="tags-programa"><span class="tag-programa sub">${escHtml(String(it.subcategoria).trim())}</span></div>` : ''}
          ${detalhes ? `<div style="margin-top:3px;">${detalhes}</div>` : ''}
          <div style="margin-top:3px;">${badge}</div>
          ${htmlEtiquetaAta(it.ata, 'pac_' + idx)}
          ${htmlValorUnit(it, 'pac_' + idx)}
        </div>
        <div>
          <label style="font-size:10px; color:var(--cinza-texto); display:block;">Autonomia de compra</label>
          <input type="number" class="req-autonomia" data-idx="${idx}" data-consumo="${consumoNum}" value="1" min="0" step="1" style="width:100%; padding:6px 8px; border:1px solid var(--linha); border-radius:4px; font-size:13px;">
        </div>
        <div>
          <label style="font-size:10px; color:var(--cinza-texto); display:block;">Qtde de Aquisição</label>
          <input type="number" class="req-qtd" data-idx="${idx}" value="${consumoNum}" readonly title="Consumo × Autonomia de compra" style="width:100%; padding:6px 8px; border:1px solid var(--linha); border-radius:4px; font-size:13px; background:var(--realce-tabela); font-weight:600;">
        </div>
      </label>`;
  }).join('');

  document.getElementById('reqMarcarTodos').checked = false;
  { const bp = document.getElementById('reqBuscaItemPaciente'); if (bp) bp.value = ''; }
  document.querySelectorAll('#reqListaItens .req-check').forEach((c) => c.addEventListener('change', atualizarContadorReq));
  // Recalcular a quantidade de aquisição quando a autonomia de compra mudar
  document.querySelectorAll('#reqListaItens .req-autonomia').forEach((inp) => {
    inp.addEventListener('input', () => recalcularAquisicao(inp));
  });
  document.querySelectorAll('#reqListaItens .ata-valor').forEach(preencherValorUnit);
  aplicarModoApenasRegistro();
  atualizarContadorReq();
}

// Modo "Apenas registrar": desliga os campos de Autonomia/Qtde de Aquisição
// (o item entra no Relatório de Primeiro Atendimento sem quantidade definida;
// a regra de disponibilidade de estoque continua sendo aplicada normalmente).
document.getElementById('reqApenasRegistro').addEventListener('change', aplicarModoApenasRegistro);

function aplicarModoApenasRegistro() {
  const ativo = document.getElementById('reqApenasRegistro').checked;
  document.querySelectorAll('#reqListaItens .req-autonomia, #reqListaItens .req-qtd').forEach((inp) => {
    inp.disabled = ativo;
    inp.style.opacity = ativo ? '0.45' : '1';
  });
}

// Converte texto numérico em PT-BR (ex.: "5", "5,00", "1.234,5") para número
function parseNumeroReq(v) {
  if (v === null || v === undefined || v === '') return 0;
  let s = String(v).trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// Qtde de Aquisição = Qtde de Consumo × Autonomia de compra
function recalcularAquisicao(inpAutonomia) {
  const idx = inpAutonomia.dataset.idx;
  const consumo = parseNumeroReq(inpAutonomia.dataset.consumo);
  const autonomia = parseNumeroReq(inpAutonomia.value);
  const campoQtd = document.querySelector(`.req-qtd[data-idx="${idx}"]`);
  if (campoQtd) campoQtd.value = +(consumo * autonomia).toFixed(2);
}

document.getElementById('reqMarcarTodos').addEventListener('change', (ev) => {
  document.querySelectorAll('#reqListaItens .req-check').forEach((c) => { c.checked = ev.target.checked; });
  atualizarContadorReq();
});
// Filtro de busca dos itens DO PACIENTE (esconde as linhas que não casam;
// preserva as seleções). Acento/caixa-insensitive.
document.getElementById('reqBuscaItemPaciente').addEventListener('input', (ev) => {
  const termo = normalizarBusca(ev.target.value);
  document.querySelectorAll('#reqListaItens .req-item').forEach((el) => {
    el.style.display = (!termo || (el.dataset.busca || '').includes(termo)) ? '' : 'none';
  });
});

function atualizarContadorReq() {
  const n = document.querySelectorAll('#reqListaItens .req-check:checked').length;
  document.getElementById('reqContador').textContent = `${n} item(ns) selecionado(s)`;
  document.querySelectorAll('#reqListaItens .req-check').forEach((c) => {
    c.closest('.req-item').classList.toggle('req-item-selecionado', c.checked);
  });
}

function coletarItensSelecionados() {
  const apenasRegistro = document.getElementById('reqApenasRegistro').checked;
  const selecionados = [];
  document.querySelectorAll('#reqListaItens .req-check:checked').forEach((c) => {
    const idx = Number(c.dataset.idx);
    const qtd = apenasRegistro ? 'Apenas registro' : document.querySelector(`.req-qtd[data-idx="${idx}"]`).value;
    const autonomiaCompra = apenasRegistro ? '' : document.querySelector(`.req-autonomia[data-idx="${idx}"]`).value;
    const item = reqItensAtuais[idx];
    const situacaoAta = item.ata ? item.ata.situacao : null;
    const escolhaAta = situacaoAta === 'AVALIACAO' ? (escolhasAta.get('pac_' + idx) || null) : null;
    const valorUnit = valorUnitFinal(item, 'pac_' + idx);
    selecionados.push({ ...item, quantidade: qtd, autonomia_compra: autonomiaCompra, situacao_ata: situacaoAta, escolha_ata: escolhaAta, valor_unitario: valorUnit });
  });
  return selecionados;
}

// Monta o HTML do documento da requisição (reutilizado ao gerar e ao reabrir)
function montarDocumentoRequisicao(d) {
  const preco = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(',', '.')); return isFinite(n) ? n : null; };
  const brl = (v) => v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  let totalGeral = 0, temValor = false;
  const linhas = d.itens.map((it, i) => {
    const uni = preco(it.valor_unitario);
    const qtd = parseNumeroReq(it.quantidade);
    const tot = (uni != null && qtd) ? uni * qtd : null;
    if (tot != null) { totalGeral += tot; temValor = true; }
    return `
    <tr>
      <td style="text-align:center;">${i + 1}</td>
      <td>${it.codigo_item || '—'}</td>
      <td>${it.cod_siafisico || '—'}</td>
      <td>${it.catmat || '—'}</td>
      <td>${it.descricao_item || '—'}</td>
      <td style="text-align:center;">${it.qtde_consumo || '—'}</td>
      <td style="text-align:center;"><strong>${it.quantidade || '—'}</strong></td>
      <td style="text-align:right;">${brl(uni)}</td>
      <td style="text-align:right;">${brl(tot)}</td>
    </tr>`;
  }).join('');
  const totalRow = temValor
    ? `<tr><td colspan="8" style="text-align:right;"><strong>Total da aquisição</strong></td><td style="text-align:right;"><strong>${brl(totalGeral)}</strong></td></tr>`
    : '';

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>${d.codigoControle || 'Requisição'} - ${d.autor}</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;margin:32px;}
      h1{font-size:18px;margin:0 0 2px;}
      .id{display:inline-block;background:#1f4c3c;color:#fff;font-size:13px;font-weight:bold;padding:3px 10px;border-radius:5px;margin-bottom:8px;}
      .sub{color:#666;font-size:12px;margin:0 0 18px;}
      .box{border:1px solid #ccc;border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:13px;}
      table{width:100%;border-collapse:collapse;font-size:12.5px;}
      th,td{border:1px solid #bbb;padding:6px 8px;text-align:left;vertical-align:top;}
      th{background:#eee;}
      .assin{margin-top:48px;display:flex;justify-content:space-around;}
      .assin div{border-top:1px solid #000;width:240px;text-align:center;padding-top:6px;font-size:12px;}
      .barra{margin-bottom:18px;}
      @media print{.no-print{display:none;}}
      button{padding:8px 16px;font-size:14px;cursor:pointer;}
    </style></head><body>
    <div class="barra no-print"><button onclick="window.print()">🖨 Imprimir / Salvar PDF</button></div>
    ${d.codigoControle ? `<div class="id">Nº de controle: ${d.codigoControle}</div><br>` : ''}
    <h1>REQUISIÇÃO DE COMPRA</h1>
    <p class="sub">Unidade Tenente Pena (UDTP) · Emitida em ${d.dataHora}${d.sei ? ' · SEI Nº ' + d.sei : ''}</p>
    <div class="box">
      ${d.sei ? '<strong>Nº SEI:</strong> ' + d.sei + '<br>' : ''}
      <strong>Paciente:</strong> ${d.autor}<br>
      <strong>Protocolo:</strong> ${d.protocolo || '—'} &nbsp;|&nbsp; <strong>Processo:</strong> ${d.processo || '—'} &nbsp;|&nbsp; <strong>Tipo de demanda:</strong> ${d.tipo_demanda || '—'}<br>
      <strong>Unidade:</strong> ${d.unidade || '—'}${d.procurador ? ' &nbsp;|&nbsp; <strong>Procurador:</strong> ' + d.procurador : ''}<br>
      <strong>Operador:</strong> ${d.operadorNome || '—'} &nbsp;|&nbsp; <strong>Login:</strong> ${d.operadorEmail || '—'}
    </div>
    <table>
      <thead><tr><th style="width:28px;">#</th><th>Cód. Item</th><th>SIAFÍSICO</th><th>CATMAT</th><th>Descrição do Item</th><th>Qtde Consumo</th><th style="width:90px;">Quantidade de Aquisição</th><th style="width:90px;">Valor Unitário</th><th style="width:100px;">Valor Total</th></tr></thead>
      <tbody>${linhas}${totalRow}</tbody>
    </table>
    </body></html>`;
}

// Documento consolidado de uma Solicitação Coletiva (pacientes + total por item).
function montarDocumentoColetiva(r, itens, pacientes) {
  const op = estado.usuario || {};
  const preco = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(',', '.')); return isFinite(n) ? n : null; };
  const brl = (v) => v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  let totalGeral = 0, temValor = false;
  const linhasItens = itens.map((it, i) => {
    const uni = preco(it.valor_unitario);
    const qtd = parseNumeroReq(it.quantidade);
    const tot = (uni != null && qtd) ? uni * qtd : null;
    if (tot != null) { totalGeral += tot; temValor = true; }
    return `
    <tr>
      <td style="text-align:center;">${i + 1}</td>
      <td>${it.codigo_item || '—'}</td>
      <td>${it.cod_siafisico || '—'}</td>
      <td>${it.catmat || '—'}</td>
      <td>${it.descricao_item || '—'}</td>
      <td style="text-align:center;">${it.n_pacientes != null ? it.n_pacientes : (it.detalhe ? it.detalhe.length : '—')}</td>
      <td style="text-align:center;"><strong>${it.quantidade || '—'}</strong></td>
      <td style="text-align:right;">${brl(uni)}</td>
      <td style="text-align:right;">${brl(tot)}</td>
    </tr>`;
  }).join('');
  const totalRowItens = temValor
    ? `<tr><td colspan="8" style="text-align:right;"><strong>Total da aquisição</strong></td><td style="text-align:right;"><strong>${brl(totalGeral)}</strong></td></tr>`
    : '';
  // Itens solicitados POR PACIENTE, com a quantidade INDIVIDUAL (do detalhe de
  // cada item). A soma das quantidades por paciente = o total do item na tabela
  // consolidada acima.
  const itensPorPaciente = new Map();
  for (const it of itens) {
    for (const d of (it.detalhe || [])) {
      if (!itensPorPaciente.has(d.autor)) itensPorPaciente.set(d.autor, []);
      itensPorPaciente.get(d.autor).push({ descricao: it.descricao_item, codigo: it.codigo_item, siafisico: it.cod_siafisico, quantidade: d.quantidade });
    }
  }
  const blocosPac = (pacientes || []).map((p, i) => {
    const lst = itensPorPaciente.get(p.autor) || [];
    const linhasI = lst.length
      ? lst.map((x) => {
        const meta = [x.codigo ? 'SCODES ' + escHtml(x.codigo) : '', x.siafisico ? 'SIAF ' + escHtml(x.siafisico) : ''].filter(Boolean).join(' · ');
        return `<tr><td style="padding:4px 8px 4px 16px;">${escHtml(x.descricao || x.codigo || '—')}${meta ? '<br><span style="color:#777;font-size:11px;">' + meta + '</span>' : ''}</td><td style="width:70px;text-align:center;"><strong>${x.quantidade != null && x.quantidade !== '' ? x.quantidade : '—'}</strong></td></tr>`;
      }).join('')
      : '<tr><td colspan="2" style="padding:4px 8px 4px 16px;color:#777;">Sem itens.</td></tr>';
    return `<div style="border:1px solid #bbb;border-radius:6px;overflow:hidden;margin-bottom:10px;break-inside:avoid;">
      <div style="background:#eee;padding:6px 10px;font-size:12.5px;">
        <strong>${i + 1}. ${escHtml(p.autor || '—')}</strong>${p.protocolo ? ' &nbsp;·&nbsp; Protocolo ' + escHtml(p.protocolo) : ''}${p.processo ? ' &nbsp;·&nbsp; Processo ' + escHtml(p.processo) : ''}
      </div>
      <table style="width:100%;border-collapse:collapse;"><thead><tr><th style="text-align:left;">Descrição do Item</th><th style="width:70px;">Qtde</th></tr></thead><tbody>${linhasI}</tbody></table>
    </div>`;
  }).join('');
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>${r.codigo_controle || 'Solicitação Coletiva'}</title>
    <style>
      body{font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;margin:32px;}
      h1{font-size:18px;margin:0 0 2px;} h2{font-size:14px;margin:18px 0 6px;}
      .id{display:inline-block;background:#1f4c3c;color:#fff;font-size:13px;font-weight:bold;padding:3px 10px;border-radius:5px;margin-bottom:8px;}
      .sub{color:#666;font-size:12px;margin:0 0 16px;}
      .box{border:1px solid #ccc;border-radius:6px;padding:10px 14px;margin-bottom:8px;font-size:13px;}
      table{width:100%;border-collapse:collapse;font-size:12.5px;} th,td{border:1px solid #bbb;padding:6px 8px;text-align:left;vertical-align:top;} th{background:#eee;}
      @media print{.no-print{display:none;}} button{padding:8px 16px;font-size:14px;cursor:pointer;}
    </style></head><body>
    <div class="no-print" style="margin-bottom:18px;"><button onclick="window.print()">🖨 Imprimir / Salvar PDF</button></div>
    <div class="id">Nº de controle: ${r.codigo_controle || '—'}</div><br>
    <h1>SOLICITAÇÃO COLETIVA DE COMPRA</h1>
    <p class="sub">Unidade Tenente Pena (UDTP) · Emitida em ${formatarDataHora(r.criado_em)}${r.sei ? ' · SEI Nº ' + r.sei : ''}</p>
    <div class="box">
      ${r.sei ? '<strong>Nº SEI:</strong> ' + r.sei + '<br>' : ''}
      <strong>Pacientes:</strong> ${r.total_pacientes || (pacientes ? pacientes.length : 0)} &nbsp;|&nbsp; <strong>Medicamentos:</strong> ${itens.length}<br>
      <strong>Operador:</strong> ${r.operador_nome || '—'} &nbsp;|&nbsp; <strong>Login:</strong> ${r.operador_email || '—'}
    </div>
    <h2>Total consolidado por medicamento</h2>
    <table>
      <thead><tr><th style="width:28px;">#</th><th>Cód. Item</th><th>SIAFÍSICO</th><th>CATMAT</th><th>Descrição do Item</th><th style="width:70px;">Pacientes</th><th style="width:90px;">Qtde total</th><th style="width:90px;">Valor Unitário</th><th style="width:100px;">Valor Total</th></tr></thead>
      <tbody>${linhasItens}${totalRowItens}</tbody>
    </table>
    <h2>Pacientes da solicitação (${pacientes ? pacientes.length : 0})</h2>
    ${blocosPac}
    </body></html>`;
}

function abrirDocumento(html) {
  const win = window.open('', '_blank');
  if (!win) { alert('Permita pop-ups para abrir a requisição.'); return; }
  win.document.write(html);
  win.document.close();
}

async function gerarRequisicao() {
  const itens = coletarItensSelecionados();
  if (itens.length === 0) { alert('Selecione ao menos um medicamento.'); return; }

  const info = reqPacienteAtual;
  const campoSei = document.getElementById('reqSEI');
  const sei = campoSei.value.trim();
  if (!sei) {
    alert('Informe o Nº do SEI para gerar a requisição.');
    campoSei.focus();
    return;
  }
  // Aviso quando a requisição mistura ATA e SEM ATA.
  if (!confirmarMisturaAta(itens.map((it) => modalidadeEfetiva(it.situacao_ata, it.escolha_ata)))) return;

  const operador = estado.usuario || {};
  const botao = document.getElementById('botaoGerarRequisicao');
  botao.disabled = true;

  const corpoItens = itens.map((it) => ({
    codigo_item: it.codigo_item, cod_siafisico: it.cod_siafisico,
    descricao_item: it.descricao_item, categoria: it.categoria, quantidade: it.quantidade,
    tipo_demanda: it.tipo_demanda, qtde_consumo: it.qtde_consumo, prazo: it.prazo,
    periodicidade: it.periodicidade, dispensacoes_autorizadas: it.dispensacoes_autorizadas,
    autonomia_compra: it.autonomia_compra, catmat: it.catmat,
    situacao_ata: it.situacao_ata, escolha_ata: it.escolha_ata, valor_unitario: it.valor_unitario,
  }));

  try {
    let salvo;
    if (reqModo === 'editar') {
      salvo = await api(`/autores/requisicoes/${reqEditId}`, {
        method: 'PUT',
        body: JSON.stringify({
          sei, itens: corpoItens,
          protocolo: info.protocolo, processo: info.processo, tipo_demanda: info.tipo_demanda,
        }),
      });
    } else {
      salvo = await api('/autores/requisicoes', {
        method: 'POST',
        body: JSON.stringify({
          autor: info.autor, idade: info.idade, unidade: info.unidade_dispensadora,
          procurador: info.procurador_estado, sei, itens: corpoItens,
          protocolo: info.protocolo, processo: info.processo, tipo_demanda: info.tipo_demanda,
        }),
      });
    }

    const html = montarDocumentoRequisicao({
      codigoControle: salvo.codigo_controle,
      autor: info.autor, unidade: info.unidade_dispensadora,
      procurador: info.procurador_estado, sei,
      protocolo: info.protocolo, processo: info.processo, tipo_demanda: info.tipo_demanda,
      operadorNome: operador.nome, operadorEmail: operador.email,
      dataHora: new Date().toLocaleString('pt-BR'),
      itens,
    });
    abrirDocumento(html);
    modalRequisicao.hidden = true;
    // Se o relatório estiver aberto, atualiza a lista
    if (estado.paginaAtual === 'relatorioReq') carregarTabelaRelReq();
  } catch (e) {
    alert('Erro ao gerar a requisição: ' + e.message);
  } finally {
    botao.disabled = false;
  }
}

// ==================== Requisição — modo SOLICITAÇÃO COLETIVA (abas por medicamento) ====================
// Cada medicamento vira uma ABA. Dentro da aba: os pacientes que têm aquele
// item, cada um com autonomia de compra INDIVIDUAL. As seleções ficam guardadas
// por aba (não se perdem ao navegar). Ao gerar, agrupa por paciente → uma
// requisição por paciente com os itens marcados (de todas as abas).
let reqModoAtual = 'paciente';
let colTabs = [];        // [{ item, pacientes:[...], sel: { [autor]: {checked, autonomia} } }]
let colTabAtivo = 0;
let colInserindo = false; // true quando o painel de busca é para INSERIR mais um item

// Alterna entre "Por paciente" e "Solicitação coletiva".
function setModoRequisicao(modo) {
  reqModoAtual = modo;
  document.querySelectorAll('#reqModoAbas .req-modo-aba').forEach((b) =>
    b.classList.toggle('ativo', b.dataset.modo === modo));
  const ehColetiva = modo === 'coletiva';
  document.getElementById('reqModoColetiva').hidden = !ehColetiva;
  document.getElementById('reqEtapaPaciente').hidden = ehColetiva;
  document.getElementById('reqEtapaItens').hidden = true;
  document.getElementById('reqDescricaoModo').textContent = ehColetiva
    ? 'Monte a solicitação por medicamento (uma aba para cada) e marque os pacientes.'
    : 'Selecione o paciente e marque os medicamentos para aquisição.';
  document.getElementById('reqVoltar').hidden = true;
  document.getElementById('botaoGerarRequisicao').hidden = true;
  document.getElementById('botaoGerarColetiva').hidden = true;
  if (ehColetiva) resetColetiva();
}

function resetColetiva() {
  colTabs = [];
  colTabAtivo = 0;
  colInserindo = false;
  escolhasAta.clear();
  valoresManual.clear();
  mostrarBuscaColetiva(false);
}

// Mostra o painel de busca (inicial ou "inserir") ou a área de trabalho.
function mostrarBuscaColetiva(inserindo) {
  colInserindo = inserindo;
  document.getElementById('colBuscaPanel').hidden = false;
  document.getElementById('colTrabalho').hidden = true; // esconde a área de trabalho enquanto pesquisa
  document.getElementById('colBuscaLabel').textContent = inserindo
    ? 'Buscar medicamento para inserir na solicitação' : 'Buscar o primeiro medicamento da solicitação';
  document.getElementById('colCancelarBusca').hidden = !inserindo;
  document.getElementById('botaoGerarColetiva').hidden = colTabs.length === 0;
  document.getElementById('colBuscaItem').value = '';
  document.getElementById('colResultadosItem').innerHTML = '';
  document.getElementById('colBuscaItem').focus();
}

function mostrarTrabalhoColetiva() {
  document.getElementById('colBuscaPanel').hidden = true;
  document.getElementById('colTrabalho').hidden = false;
  document.getElementById('botaoGerarColetiva').hidden = false;
  renderTabsColetiva();
  renderPacientesTab();
}

let colBuscaTimer = null;
async function buscarItensColetiva() {
  const q = document.getElementById('colBuscaItem').value.trim();
  const alvo = document.getElementById('colResultadosItem');
  if (q.length < 2) { alvo.innerHTML = ''; return; }
  let dados;
  try { dados = await api(`/autores/itens-busca?q=${encodeURIComponent(q)}`); }
  catch (e) { alvo.innerHTML = `<p class="texto-apoio">${e.message}</p>`; return; }
  if (!dados.itens.length) { alvo.innerHTML = '<p class="texto-apoio" style="font-size:12px;">Nenhum medicamento encontrado na demanda da Tenente Pena.</p>'; return; }
  alvo.innerHTML = dados.itens.map((it, i) => {
    const jaTem = colTabs.some((t) => t.item.codigo_item === it.codigo_item);
    return `
    <button type="button" class="col-item-op" data-idx="${i}" ${jaTem ? 'disabled' : ''} style="display:block; width:100%; text-align:left; background:var(--papel); border:1px solid var(--linha); border-radius:8px; padding:9px 12px; margin-bottom:6px; cursor:${jaTem ? 'default' : 'pointer'}; opacity:${jaTem ? '0.5' : '1'};">
      <div style="font-size:13px; font-weight:500;">${escHtml(it.descricao_item || '—')} ${jaTem ? '<span style="color:var(--selo-escuro); font-size:11px;">✓ já na solicitação</span>' : ''}</div>
      <div class="col-codigo">${escHtml(it.codigo_item || '')}${it.cod_siafisico ? ' · SIAF ' + escHtml(String(it.cod_siafisico)) : ''}</div>
      <div style="font-size:11px; color:var(--selo-escuro); margin-top:2px;">${it.n_pacientes} paciente${it.n_pacientes > 1 ? 's' : ''} com este item</div>
    </button>`;
  }).join('');
  alvo.querySelectorAll('.col-item-op:not([disabled])').forEach((b) =>
    b.addEventListener('click', () => adicionarMedicamentoColetiva(dados.itens[Number(b.dataset.idx)])));
}

async function adicionarMedicamentoColetiva(item) {
  if (colTabs.some((t) => t.item.codigo_item === item.codigo_item)) return;
  let dados;
  try { dados = await api(`/autores/itens-pacientes?codigos=${encodeURIComponent(item.codigo_item)}`); }
  catch (e) { alert('Erro ao carregar pacientes: ' + e.message); return; }
  // Cada paciente tem exatamente 1 item (esta busca é de um só código).
  const pacientes = (dados.pacientes || []).map((p) => ({ ...p, item: p.itens[0] }));
  const sel = {};
  pacientes.forEach((p) => { sel[p.autor] = { checked: false, autonomia: 1 }; });
  const ataItem = pacientes.length ? (pacientes[0].item || {}).ata : null;
  colTabs.push({ item, pacientes, sel, filtro: '', ata: ataItem || null });
  colTabAtivo = colTabs.length - 1;
  mostrarTrabalhoColetiva();
}

function renderTabsColetiva() {
  const bar = document.getElementById('colTabsBar');
  bar.innerHTML = colTabs.map((t, i) => {
    const nome = (t.item.descricao_item || '').split(' / ')[0];
    const marc = Object.values(t.sel).filter((s) => s.checked).length;
    return `<button type="button" class="col-aba ${i === colTabAtivo ? 'ativo' : ''}" data-i="${i}">
      ${escHtml(nome)} <span class="col-aba-cont">${marc}</span>
      <span class="col-aba-x" data-rem="${i}" title="Remover medicamento">✕</span>
    </button>`;
  }).join('') + `<button type="button" class="col-aba col-aba-add" id="colInserirMed">+ Inserir medicamento</button>`;

  bar.querySelectorAll('.col-aba[data-i]').forEach((b) => b.addEventListener('click', (ev) => {
    if (ev.target.classList.contains('col-aba-x')) return;
    colTabAtivo = Number(b.dataset.i); renderTabsColetiva(); renderPacientesTab();
  }));
  bar.querySelectorAll('.col-aba-x').forEach((x) => x.addEventListener('click', (ev) => {
    ev.stopPropagation(); removerTabColetiva(Number(x.dataset.rem));
  }));
  document.getElementById('colInserirMed').addEventListener('click', () => mostrarBuscaColetiva(true));
}

function removerTabColetiva(i) {
  const nome = (colTabs[i].item.descricao_item || '').split(' / ')[0];
  if (!confirm(`Remover "${nome}" da solicitação? As seleções deste medicamento serão perdidas.`)) return;
  colTabs.splice(i, 1);
  if (!colTabs.length) { resetColetiva(); return; }
  colTabAtivo = Math.max(0, Math.min(colTabAtivo, colTabs.length - 1));
  renderTabsColetiva(); renderPacientesTab();
}

// Normaliza texto para busca (sem acento, minúsculo).
function normPac(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Pacientes da aba que casam com o filtro digitado.
function pacientesFiltrados(tab) {
  const q = normPac(tab.filtro).trim();
  if (!q) return tab.pacientes;
  const termos = q.split(/\s+/);
  return tab.pacientes.filter((p) => {
    const alvo = normPac(`${p.autor} ${p.processo || ''} ${p.protocolo || ''}`);
    return termos.every((t) => alvo.includes(t));
  });
}

// Orquestra a aba ativa: campo de busca + resultados + cartões selecionados.
function renderPacientesTab() {
  const tab = colTabs[colTabAtivo];
  const busca = document.getElementById('colPacBusca');
  const res = document.getElementById('colPacResultados');
  const alvo = document.getElementById('colListaPacientes');
  const titulo = document.getElementById('colPacSelTitulo');
  const tagAta = document.getElementById('colAtaTag');
  if (!tab) { res.innerHTML = ''; alvo.innerHTML = ''; titulo.hidden = true; busca.value = ''; if (tagAta) tagAta.innerHTML = ''; return; }
  if (tagAta) {
    const itemTab = tab.pacientes.length ? (tab.pacientes[0].item || {}) : null;
    const idTab = 'coltab_' + colTabAtivo;
    tagAta.innerHTML = htmlEtiquetaAta(tab.ata, idTab) + (itemTab ? htmlValorUnit(itemTab, idTab) : '');
    tagAta.querySelectorAll('.ata-valor').forEach(preencherValorUnit);
  }
  busca.value = tab.filtro || '';
  if (!tab.pacientes.length) {
    res.innerHTML = '<p class="texto-apoio">Nenhum paciente com este medicamento na demanda da Tenente Pena.</p>';
    alvo.innerHTML = ''; titulo.hidden = true;
    document.getElementById('colMarcarTodos').checked = false;
    atualizarContadorColetiva();
    return;
  }
  renderResultadosPac();
  renderSelecionadosPac();
  atualizarContadorColetiva();
}

// Lista compacta de resultados do filtro; clicar seleciona (mostra o cartão).
function renderResultadosPac() {
  const tab = colTabs[colTabAtivo];
  const res = document.getElementById('colPacResultados');
  const LIMITE = 60;
  const filtrados = pacientesFiltrados(tab);
  const naoSel = filtrados.filter((p) => !tab.sel[p.autor].checked);
  const total = tab.pacientes.length;
  const selCount = tab.pacientes.filter((p) => tab.sel[p.autor].checked).length;

  const cabecalho = `<div style="font-size:11.5px; color:var(--cinza-texto); margin-bottom:6px;">
    ${filtrados.length} de ${total} paciente(s)${tab.filtro ? ' no filtro' : ''} · ${selCount} selecionado(s)</div>`;

  if (!naoSel.length) {
    res.innerHTML = cabecalho + (filtrados.length
      ? '<p class="texto-apoio" style="font-size:12px; margin:4px 0;">Todos os pacientes deste filtro já foram selecionados.</p>'
      : '<p class="texto-apoio" style="font-size:12px; margin:4px 0;">Nenhum paciente encontrado com esse filtro.</p>');
  } else {
    const mostra = naoSel.slice(0, LIMITE);
    res.innerHTML = cabecalho + mostra.map((p) => {
      const it = p.item || {};
      const aut = it.autonomia_atual;
      let badge = '';
      if (aut !== null && aut !== undefined) {
        const cls = aut <= 0 ? 'cancelado' : (aut <= 2 ? 'atrasado' : 'finalizado');
        badge = `<span class="etiqueta-status ${cls}" style="font-size:10px;">aut. ${fmtNumero(aut)} m</span>`;
      }
      return `<button type="button" class="col-pac-op" data-autor="${escHtml(p.autor)}" style="display:flex; justify-content:space-between; align-items:center; gap:8px; width:100%; text-align:left; background:var(--papel); border:1px solid var(--linha); border-radius:7px; padding:7px 11px; margin-bottom:5px; cursor:pointer;">
        <span>
          <span style="font-size:12.5px; font-weight:500;">${escHtml(p.autor || '—')}</span>
          <span class="col-codigo" style="display:block;">${[p.processo ? 'Proc. ' + p.processo : '', p.protocolo ? 'Prot. ' + p.protocolo : ''].filter(Boolean).join(' · ')}</span>
        </span>
        <span style="display:flex; align-items:center; gap:8px; flex-shrink:0;">${badge}<span style="color:var(--selo-escuro); font-size:12px; font-weight:600;">+ selecionar</span></span>
      </button>`;
    }).join('') + (naoSel.length > LIMITE
      ? `<p class="texto-apoio" style="font-size:11px; margin:2px 0;">Mostrando ${LIMITE} de ${naoSel.length}. Refine o filtro para ver os demais.</p>` : '');
    res.querySelectorAll('.col-pac-op').forEach((b) => b.addEventListener('click', () => {
      tab.sel[b.dataset.autor].checked = true;
      renderResultadosPac(); renderSelecionadosPac(); renderTabsColetiva(); atualizarContadorColetiva();
      sincronizarMarcarTodos();
    }));
  }
  sincronizarMarcarTodos();
}

// Marca/atualiza o checkbox "Marcar todos os filtrados".
function sincronizarMarcarTodos() {
  const tab = colTabs[colTabAtivo];
  const cb = document.getElementById('colMarcarTodos');
  if (!tab) { cb.checked = false; return; }
  const filtrados = pacientesFiltrados(tab);
  cb.checked = filtrados.length > 0 && filtrados.every((p) => tab.sel[p.autor].checked);
}

// Cartões detalhados dos pacientes já selecionados (com autonomia individual).
function renderSelecionadosPac() {
  const tab = colTabs[colTabAtivo];
  const alvo = document.getElementById('colListaPacientes');
  const titulo = document.getElementById('colPacSelTitulo');
  const selecionados = tab.pacientes.filter((p) => tab.sel[p.autor].checked);
  titulo.hidden = selecionados.length === 0;
  if (titulo && !titulo.hidden) titulo.textContent = `Pacientes selecionados (${selecionados.length})`;
  if (!selecionados.length) { alvo.innerHTML = ''; return; }

  const chip = (rot, val) => (val !== null && val !== undefined && String(val).trim() !== '')
    ? `<span style="display:inline-block; background:var(--realce-tabela); border:1px solid var(--linha); border-radius:4px; padding:1px 7px; margin:2px 4px 0 0; font-size:11px;"><strong>${rot}:</strong> ${escHtml(String(val))}</span>` : '';

  alvo.innerHTML = selecionados.map((p) => {
    const it = p.item || {};
    const s = tab.sel[p.autor];
    const consumo = parseNumeroReq(it.qtde_consumo);
    const qtd = +(consumo * (s.autonomia || 0)).toFixed(2);
    const aut = it.autonomia_atual;
    let badge = '<span style="color:var(--cinza-texto); font-size:11px;">sem dado de estoque</span>';
    if (aut !== null && aut !== undefined) {
      const cls = aut <= 0 ? 'cancelado' : (aut <= 2 ? 'atrasado' : 'finalizado');
      const dem = (it.demanda_atual !== null && it.demanda_atual !== undefined) ? `demanda ${fmtNumero(it.demanda_atual)} · ` : '';
      badge = `<span class="etiqueta-status ${cls}">${dem}estoque ${fmtNumero(it.estoque_atual)} · autonomia ${fmtNumero(aut)} m</span>`;
    }
    const detalhes = [
      chip('Tipo de demanda', p.tipo_demanda), chip('Qtde de consumo', it.qtde_consumo),
      chip('Prazo', it.prazo), chip('Periodicidade', it.periodicidade),
      chip('Dispensações autorizadas', it.dispensacoes_autorizadas),
    ].join('');
    return `
      <div class="req-item" style="display:grid; grid-template-columns:28px 1fr 95px 110px; gap:10px; align-items:center; padding:9px 6px; border-bottom:1px solid var(--linha-tabela);">
        <button type="button" class="col-pac-rem" data-autor="${escHtml(p.autor)}" title="Remover paciente" style="background:none; border:none; color:#c0392b; font-size:16px; cursor:pointer; padding:0;">✕</button>
        <div>
          <div style="font-size:13px; font-weight:500;">${escHtml(p.autor || '—')}</div>
          <div class="col-codigo">${[p.processo ? 'Proc. ' + p.processo : '', p.protocolo ? 'Prot. ' + p.protocolo : ''].filter(Boolean).join(' · ')}</div>
          ${detalhes ? `<div style="margin-top:3px;">${detalhes}</div>` : ''}
          <div style="margin-top:3px;">${badge}</div>
        </div>
        <div>
          <label style="font-size:10px; color:var(--cinza-texto); display:block;">Autonomia de compra</label>
          <input type="number" class="col-pac-aut" data-autor="${escHtml(p.autor)}" data-consumo="${consumo}" value="${s.autonomia}" min="0" step="1" style="width:100%; padding:6px 8px; border:1px solid var(--linha); border-radius:4px; font-size:13px;">
        </div>
        <div>
          <label style="font-size:10px; color:var(--cinza-texto); display:block;">Qtde de Aquisição</label>
          <input type="number" class="col-pac-qtd" data-autor="${escHtml(p.autor)}" value="${qtd}" readonly style="width:100%; padding:6px 8px; border:1px solid var(--linha); border-radius:4px; font-size:13px; background:var(--realce-tabela); font-weight:600;">
        </div>
      </div>`;
  }).join('');

  alvo.querySelectorAll('.col-pac-rem').forEach((b) => b.addEventListener('click', () => {
    tab.sel[b.dataset.autor].checked = false;
    renderResultadosPac(); renderSelecionadosPac(); renderTabsColetiva(); atualizarContadorColetiva();
  }));
  alvo.querySelectorAll('.col-pac-aut').forEach((inp) => inp.addEventListener('input', () => {
    const a = parseNumeroReq(inp.value);
    tab.sel[inp.dataset.autor].autonomia = a;
    const q = +(parseNumeroReq(inp.dataset.consumo) * a).toFixed(2);
    const campo = alvo.querySelector(`.col-pac-qtd[data-autor="${cssEsc(inp.dataset.autor)}"]`);
    if (campo) campo.value = q;
    atualizarContadorColetiva();
  }));
}

// Escapa um valor para uso seguro em seletor de atributo.
function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

// Total geral, considerando TODAS as abas e as seleções guardadas.
function atualizarContadorColetiva() {
  const pacientesUnicos = new Set();
  let totalItens = 0, aquisicaoTotal = 0;
  colTabs.forEach((t) => t.pacientes.forEach((p) => {
    const s = t.sel[p.autor];
    if (!s || !s.checked) return;
    pacientesUnicos.add(p.autor);
    totalItens++;
    aquisicaoTotal += parseNumeroReq(p.item.qtde_consumo) * (s.autonomia || 0);
  }));
  document.getElementById('colContador').textContent =
    `${pacientesUnicos.size} paciente(s) · ${totalItens} item(ns) · aquisição total ${fmtNumero(+aquisicaoTotal.toFixed(2))}`;
}

// Diálogo do "↺ Reabrir" da linha INDIVIDUAL: pergunta se a reabertura é
// Individual (tela Por paciente) ou Coletiva (tela Por Item, para incluir
// outros pacientes/medicamentos).
function escolherReabertura(id) {
  const fundo = document.createElement('div');
  fundo.style.cssText = 'position:fixed; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.35); z-index:9999;';
  fundo.innerHTML = `
    <div class="modal" style="max-width:460px; width:92%; padding:22px;">
      <h3 style="margin:0 0 6px;">Reabrir requisição</h3>
      <p class="texto-apoio" style="margin:0 0 16px;">Como você quer reabrir? Em ambos os casos o status volta para “Solicitado” (telegrama/data de envio são zerados).</p>
      <div style="display:flex; flex-direction:column; gap:10px;">
        <button type="button" id="reabInd" class="botao-secundario" style="text-align:left; padding:11px 13px; line-height:1.35;">
          <strong>Individual</strong><br><span class="texto-apoio">Corrigir ou incluir itens do <em>mesmo</em> paciente (tela Por paciente).</span>
        </button>
        <button type="button" id="reabCol" class="botao-primario" style="text-align:left; padding:11px 13px; line-height:1.35;">
          <strong>Coletiva</strong><br><span style="opacity:.85;">Incluir <em>outros</em> pacientes e/ou medicamentos (tela Por Item).</span>
        </button>
        <button type="button" id="reabCancel" class="botao-secundario" style="align-self:flex-end; padding:6px 16px; margin-top:4px;">Cancelar</button>
      </div>
    </div>`;
  document.body.appendChild(fundo);
  const fechar = () => fundo.remove();
  fundo.addEventListener('click', (ev) => { if (ev.target === fundo) fechar(); });
  fundo.querySelector('#reabInd').addEventListener('click', () => { fechar(); editarRequisicao(id); });
  fundo.querySelector('#reabCol').addEventListener('click', () => { fechar(); reabrirColetiva(id); });
  fundo.querySelector('#reabCancel').addEventListener('click', fechar);
}

// Reabre uma requisição existente NA TELA "Por Item" (coletiva), já com os
// itens como abas e os pacientes atuais marcados. Permite incluir mais
// pacientes (+ selecionar) e medicamentos (+ Inserir). Ao gerar, salva no
// mesmo nº de controle via PUT (reabrir-coletiva) e reabre o status.
async function reabrirColetiva(id) {
  let dados;
  try { dados = await api(`/autores/requisicoes/${id}`); }
  catch (e) { alert('Erro ao carregar a requisição: ' + e.message); return; }
  const r = dados.requisicao;

  reqModo = 'editar';
  reqEditId = id;
  modalRequisicao.hidden = false;
  document.getElementById('reqModoAbas').hidden = true; // não troca de modo durante a reabertura
  reqModoAtual = 'coletiva';
  document.getElementById('reqModoColetiva').hidden = false;
  document.getElementById('reqEtapaPaciente').hidden = true;
  document.getElementById('reqEtapaItens').hidden = true;
  document.getElementById('reqDescricaoModo').textContent =
    'Reabertura — inclua pacientes (+ selecionar) ou medicamentos (+ Inserir medicamento) e gere novamente.';
  resetColetiva();
  document.getElementById('colSEI').value = r.sei || '';

  // Dados de cada paciente (protocolo/processo) para injetar quem já constava
  // mas não aparecer mais na busca de candidatos. Numa requisição individual,
  // o paciente é o próprio autor do cabeçalho.
  const pacInfo = new Map((dados.pacientes || []).map((p) => [p.autor, p]));
  if (!r.coletiva && r.autor && !pacInfo.has(r.autor)) {
    pacInfo.set(r.autor, { autor: r.autor, protocolo: r.protocolo, processo: r.processo, tipo_demanda: r.tipo_demanda });
  }

  for (const it of dados.itens) {
    let d;
    try { d = await api(`/autores/itens-pacientes?codigos=${encodeURIComponent(it.codigo_item)}`); }
    catch (_) { d = { pacientes: [] }; }
    const pacientes = (d.pacientes || []).map((p) => ({ ...p, item: p.itens[0] }));
    const sel = {};
    pacientes.forEach((p) => { sel[p.autor] = { checked: false, autonomia: 1 }; });
    // Detalhe por paciente: coletiva já tem it.detalhe; individual = só o autor,
    // usando a autonomia_compra gravada na própria linha do item.
    const detalhes = r.coletiva
      ? (it.detalhe || [])
      : [{ autor: r.autor, autonomia_compra: it.autonomia_compra, qtde_consumo: it.qtde_consumo, quantidade: it.quantidade }];
    // Marca (e injeta, se preciso) os pacientes que já estavam na requisição.
    detalhes.forEach((det) => {
      const aut = Number(det.autonomia_compra) || 1;
      if (!sel[det.autor]) {
        const info = pacInfo.get(det.autor) || {};
        pacientes.push({
          autor: det.autor, protocolo: info.protocolo, processo: info.processo, tipo_demanda: info.tipo_demanda,
          item: {
            codigo_item: it.codigo_item, cod_siafisico: it.cod_siafisico, descricao_item: it.descricao_item,
            categoria: it.categoria, catmat: it.catmat, qtde_consumo: det.qtde_consumo,
          },
        });
      }
      sel[det.autor] = { checked: true, autonomia: aut };
    });
    const ataItem = pacientes.length ? (pacientes[0].item || {}).ata : null;
    colTabs.push({
      item: {
        codigo_item: it.codigo_item, cod_siafisico: it.cod_siafisico, descricao_item: it.descricao_item,
        categoria: it.categoria, catmat: it.catmat,
      },
      pacientes, sel, filtro: '', ata: ataItem || null,
    });
  }
  colTabAtivo = 0;
  mostrarTrabalhoColetiva();
}

async function gerarColetiva() {
  const sei = document.getElementById('colSEI').value.trim();
  if (!sei) { alert('Informe o Nº do SEI da solicitação coletiva.'); document.getElementById('colSEI').focus(); return; }

  // Agrupa por paciente os itens marcados em todas as abas.
  const mapa = new Map();
  colTabs.forEach((t, ti) => {
    const situacaoAta = t.ata ? t.ata.situacao : null;
    const escolhaAta = situacaoAta === 'AVALIACAO' ? (escolhasAta.get('coltab_' + ti) || null) : null;
    const itemTab = t.pacientes.length ? t.pacientes[0].item : {};
    const valorUnit = valorUnitFinal(itemTab, 'coltab_' + ti);
    t.pacientes.forEach((p) => {
      const s = t.sel[p.autor];
      if (!s || !s.checked) return;
      const it = p.item;
      if (!mapa.has(p.autor)) {
        mapa.set(p.autor, {
          autor: p.autor, idade: p.idade, unidade_dispensadora: p.unidade_dispensadora,
          procurador_estado: p.procurador_estado, protocolo: p.protocolo, processo: p.processo,
          tipo_demanda: p.tipo_demanda, itens: [],
        });
      }
      mapa.get(p.autor).itens.push({
        codigo_item: it.codigo_item, cod_siafisico: it.cod_siafisico, descricao_item: it.descricao_item,
        categoria: it.categoria, catmat: it.catmat, qtde_consumo: it.qtde_consumo, prazo: it.prazo,
        periodicidade: it.periodicidade, dispensacoes_autorizadas: it.dispensacoes_autorizadas,
        autonomia_compra: String(s.autonomia || 0),
        quantidade: +(parseNumeroReq(it.qtde_consumo) * (s.autonomia || 0)).toFixed(2),
        situacao_ata: situacaoAta, escolha_ata: escolhaAta,
        valor_unitario: valorUnit,
      });
    });
  });
  const pacientes = [...mapa.values()];
  if (!pacientes.length) { alert('Marque ao menos um paciente.'); return; }

  // Aviso quando a solicitação mistura ATA e SEM ATA (por medicamento distinto).
  const modMap = new Map();
  pacientes.forEach((p) => p.itens.forEach((it) => {
    if (!modMap.has(it.codigo_item)) modMap.set(it.codigo_item, modalidadeEfetiva(it.situacao_ata, it.escolha_ata));
  }));
  if (!confirmarMisturaAta([...modMap.values()])) return;

  const editar = reqModo === 'editar' && reqEditId;
  const botao = document.getElementById('botaoGerarColetiva');
  botao.disabled = true;
  try {
    const r = editar
      ? await api(`/autores/requisicoes/${reqEditId}/reabrir-coletiva`, {
          method: 'PUT', body: JSON.stringify({ sei, pacientes }),
        })
      : await api('/autores/requisicoes/coletiva', {
          method: 'POST', body: JSON.stringify({ sei, pacientes }),
        });
    alert(editar
      ? `✓ Requisição ${r.codigo_controle} reaberta e atualizada — ${r.totalPacientes} paciente(s) · ${r.totalItens} medicamento(s)${r.coletiva ? '' : ' (individual)'}.`
      : `✓ Solicitação coletiva ${r.codigo_controle} gerada — ${r.totalPacientes} paciente(s) · ${r.totalItens} medicamento(s) · SEI ${sei}.`);
    colTabs = [];
    reqModo = 'novo'; reqEditId = null;
    modalRequisicao.hidden = true;
    if (r.id) reabrirRequisicao(r.id); // abre o documento consolidado
    if (estado.paginaAtual === 'relatorioReq') carregarTabelaRelReq();
  } catch (e) {
    alert('Erro ao gerar as requisições: ' + e.message);
  } finally {
    botao.disabled = false;
  }
}

// Fecha o modal; na solicitação coletiva com itens, confirma antes de perder.
function fecharRequisicaoComConfirmacao() {
  if (reqModoAtual === 'coletiva' && colTabs.length &&
      !confirm('Tem certeza? Você irá perder toda a solicitação coletiva montada.')) return;
  colTabs = [];
  modalRequisicao.hidden = true;
}

// Listeners do modo coletiva.
document.querySelectorAll('#reqModoAbas .req-modo-aba').forEach((b) =>
  b.addEventListener('click', () => setModoRequisicao(b.dataset.modo)));
document.getElementById('colBuscaItem').addEventListener('input', () => {
  clearTimeout(colBuscaTimer); colBuscaTimer = setTimeout(buscarItensColetiva, 300);
});
document.getElementById('colCancelarBusca').addEventListener('click', () => { if (colTabs.length) mostrarTrabalhoColetiva(); });
document.getElementById('botaoGerarColetiva').addEventListener('click', gerarColetiva);
document.getElementById('colPacBusca').addEventListener('input', (ev) => {
  const tab = colTabs[colTabAtivo];
  if (!tab) return;
  tab.filtro = ev.target.value;
  renderResultadosPac();
});
document.getElementById('colMarcarTodos').addEventListener('change', (ev) => {
  const tab = colTabs[colTabAtivo];
  if (!tab) return;
  const filtrados = pacientesFiltrados(tab);
  if (ev.target.checked && filtrados.length > 200 &&
      !confirm(`Selecionar ${filtrados.length} pacientes de uma vez?`)) {
    ev.target.checked = false; return;
  }
  filtrados.forEach((p) => { tab.sel[p.autor].checked = ev.target.checked; });
  renderResultadosPac(); renderSelecionadosPac(); renderTabsColetiva(); atualizarContadorColetiva();
});

// Reabre/imprime uma requisição salva (a partir do Relatório Primeiro Atendimento)
// Modal "Ver itens" de uma solicitação coletiva: itens + código SCODES.
const modalItensColetiva = document.getElementById('modalItensColetiva');
document.getElementById('botaoFecharItensColetiva').addEventListener('click', () => { modalItensColetiva.hidden = true; });
modalItensColetiva.addEventListener('click', (ev) => { if (ev.target === modalItensColetiva) modalItensColetiva.hidden = true; });

async function abrirItensColetiva(id) {
  document.getElementById('tituloItensColetiva').textContent = 'Itens da solicitação coletiva';
  document.getElementById('subItensColetiva').textContent = 'Carregando…';
  document.getElementById('corpoItensColetiva').innerHTML = '';
  modalItensColetiva.hidden = false;
  try {
    const dados = await api(`/autores/requisicoes/${id}`);
    const r = dados.requisicao || {};
    const itens = dados.itens || [];
    document.getElementById('subItensColetiva').textContent =
      `${r.codigo_controle || '#' + id} · ${fmtNumero(itens.length)} medicamento(s)${r.sei ? ' · SEI ' + r.sei : ''}`;
    const badgeEst = (aut) => (aut === null || aut === undefined)
      ? '<span style="color:var(--cinza-texto); font-size:12px;">—</span>'
      : (Number(aut) < 2 ? '<span class="etiqueta-status cancelado">Aguardar</span>' : '<span class="etiqueta-status finalizado">Chamar</span>');
    document.getElementById('corpoItensColetiva').innerHTML = `
      <table class="tabela">
        <thead><tr><th>Código SCODES</th><th>Siafísico</th><th style="min-width:340px;">Descrição do item</th><th class="col-num">Qtde</th><th class="col-num">Pacientes</th><th class="col-num">Estoque</th><th class="col-num">Autonomia</th><th>Status Estoque</th></tr></thead>
        <tbody>${itens.map((it) => `<tr>
          <td class="col-codigo" style="white-space:nowrap;">${escHtml(it.codigo_item || '—')}</td>
          <td class="col-codigo" style="white-space:nowrap;">${escHtml(it.cod_siafisico || it.siafisico || '—')}</td>
          <td style="min-width:340px;">${escHtml(it.descricao_item || '—')}</td>
          <td class="col-num"><input type="number" min="0" step="1" class="ic-qtde" data-id="${it.id}" value="${it.quantidade != null ? String(it.quantidade).replace(/"/g, '&quot;') : ''}" placeholder="—" title="Corrigir a quantidade solicitada" style="width:84px;"></td>
          <td class="col-num">${it.n_pacientes != null ? fmtNumero(it.n_pacientes) : '—'}</td>
          <td class="col-num">${it.estoque_atual != null ? fmtNumero(it.estoque_atual) : '—'}</td>
          <td class="col-num">${it.autonomia_atual === null || it.autonomia_atual === undefined ? '—' : fmtNumero(it.autonomia_atual) + ' m'}</td>
          <td>${badgeEst(it.autonomia_atual)}</td>
        </tr>`).join('') || '<tr><td colspan="8" class="dica" style="text-align:center;">Sem itens.</td></tr>'}</tbody>
      </table>
      <p class="texto-apoio" style="font-size:12px; margin-top:6px;">Dica: você pode corrigir a Qtde direto nesta lista — salva ao sair do campo.</p>`;
    // Salva a correção da quantidade solicitada ao sair do campo (mesmo endpoint da linha).
    document.querySelectorAll('#corpoItensColetiva .ic-qtde').forEach((inp) => {
      const original = inp.value;
      inp.addEventListener('change', async () => {
        if (inp.value === inp.dataset.salvo) return;
        inp.disabled = true;
        try {
          await api(`/autores/requisicoes/item/${inp.dataset.id}`, { method: 'PUT', body: JSON.stringify({ quantidade: inp.value }) });
          inp.dataset.salvo = inp.value;
          inp.style.outline = '2px solid var(--verde-ok)';
          setTimeout(() => { inp.style.outline = ''; }, 900);
        } catch (e) {
          alert('Não foi possível salvar a quantidade: ' + e.message);
          inp.value = original;
        } finally { inp.disabled = false; }
      });
    });
  } catch (e) {
    document.getElementById('subItensColetiva').textContent = '';
    document.getElementById('corpoItensColetiva').innerHTML = `<p class="texto-apoio" style="color:var(--vermelho);">Erro: ${e.message}</p>`;
  }
}

async function reabrirRequisicao(id) {
  const dados = await api(`/autores/requisicoes/${id}`);
  const r = dados.requisicao;
  if (r.coletiva) { abrirDocumento(montarDocumentoColetiva(r, dados.itens, dados.pacientes || [])); return; }
  const html = montarDocumentoRequisicao({
    codigoControle: r.codigo_controle,
    autor: r.autor, unidade: r.unidade, procurador: r.procurador, sei: r.sei,
    protocolo: r.protocolo, processo: r.processo, tipo_demanda: r.tipo_demanda,
    operadorNome: r.operador_nome, operadorEmail: r.operador_email,
    dataHora: formatarDataHora(r.criado_em),
    itens: dados.itens,
  });
  abrirDocumento(html);
}

// Preenche o "Atualizado em" do cabeçalho de uma tela com a data/hora da
// última importação (manual ou automática, ambas gravam na tabela
// importacoes) daquele tipo. Falha silenciosa: não deve travar a tela.
async function carregarUltimaAtualizacao(spanId, tipo) {
  const span = document.getElementById(spanId);
  if (!span) return;
  try {
    const { criado_em } = await api(`/importacoes/ultima?tipo=${encodeURIComponent(tipo)}`);
    span.textContent = criado_em ? `Atualizado em ${formatarDataHora(criado_em)}` : '';
  } catch (_) {
    span.textContent = '';
  }
}

function formatarDataHora(iso) {
  if (!iso) return '—';
  // iso vem como "AAAA-MM-DD HH:MM:SS" (datetime do SQLite, gravado em UTC).
  // Convertemos para o horário LOCAL da máquina (Brasília, UTC−3) antes de
  // exibir — senão o carimbo "Atualizado em" mostra 3h a mais.
  const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return iso;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// -------------------- Cartas de Troca --------------------
// Controle das cartas em que o fornecedor pede para entregar item com validade
// menor que a exigida no edital. Fluxo de aprovação em duas etapas:
//   administrativo (perm. inserir) registra -> Aguardando avaliação (e-mail técnicos)
//   técnico (perm. editar) avalia -> Aprovada | Reprovada (e-mail ao criador)
//   se Reprovada, administrativo corrige e reenvia.
const estadoCartas = { pagina: 1, pageSize: 50, filtrosCarregados: false, aba: 'todas', situacao: '', modo: 'nova', editandoId: null, empenhoSel: null, empenhoQtd: null, manual: false };
const estadoEmpenhos = { pagina: 1, pageSize: 50 };

function ctPreencherSelect(id, rotulo, valores) {
  const el = document.getElementById(id);
  const atual = el.value;
  el.innerHTML = `<option value="">${rotulo}</option>` +
    (valores || []).map((v) => `<option value="${escAttr(v)}">${escHtml(v)}</option>`).join('');
  el.value = atual;
}

async function carregarCartasTroca() {
  document.getElementById('ctBotaoNova').hidden = !temPermissao('cartasTroca', 'inserir');
  document.getElementById('ctBotaoImportarEmpenhos').hidden = !temPermissao('cartasTroca', 'importar');

  try {
    const info = await api('/cartas-troca/empenhos/info');
    const el = document.getElementById('ctInfoEmpenhos');
    el.hidden = false;
    el.textContent = info && info.total
      ? `Empenhos: ${fmtNumero(info.total)} linhas (importado em ${formatarData(info.dataReferencia)}${info.dataImportacao ? ' às ' + String(info.dataImportacao).slice(11, 16) : ''})`
      : 'Nenhum empenho importado ainda';
  } catch (e) { /* segue */ }

  if (!estadoCartas.filtrosCarregados) {
    try {
      const f = await api('/cartas-troca/filtros');
      ctPreencherSelect('ctFiltroEmpresa', 'Fornecedor: todos', f.empresa);
      ctPreencherSelect('ctFiltroStatus', 'Status da troca: todos', f.status_troca);
      estadoCartas.filtrosCarregados = true;
    } catch (e) { /* segue */ }
  }
  if (estadoCartas.aba === 'empenhos') await carregarTabelaEmpenhos();
  else await carregarTabelaCartas();
}

// ---------- Abas ----------
function ctTrocarAba(aba, situacao) {
  estadoCartas.aba = aba;
  estadoCartas.situacao = situacao || '';
  estadoCartas.pagina = 1;
  document.querySelectorAll('#ctAbas .chip-faixa').forEach((b) => b.classList.toggle('ativo', b.dataset.aba === aba));
  const ehEmpenhos = aba === 'empenhos';
  document.getElementById('ctAreaCartas').hidden = ehEmpenhos;
  document.getElementById('ctAreaEmpenhos').hidden = !ehEmpenhos;
  if (ehEmpenhos) carregarTabelaEmpenhos();
  else carregarTabelaCartas();
}

function ctParamsFiltro() {
  const params = new URLSearchParams({ page: estadoCartas.pagina, pageSize: estadoCartas.pageSize });
  const q = document.getElementById('ctFiltroBusca').value.trim();
  if (q) params.set('q', q);
  const emp = document.getElementById('ctFiltroEmpresa').value;
  if (emp) params.set('empresa', emp);
  const st = document.getElementById('ctFiltroStatus').value;
  if (st) params.set('status_troca', st);
  if (estadoCartas.situacao) params.set('situacao', estadoCartas.situacao);
  return params;
}

function ctClasseSituacao(s) {
  if (s === 'Aprovada') return 'finalizado';
  if (s === 'Reprovada') return 'cancelado';
  return 'planejamento'; // Aguardando avaliação
}
function ctClasseStatus(s) {
  if (s === 'Trocado' || s === 'Consumido') return 'finalizado';
  if (s === 'Vencido no estoque' || s === 'Cancelado') return 'cancelado';
  return 'planejamento';
}

// Validade mais próxima (com alerta de cor) a partir da lista de lotes da carta.
function ctCelulaValidade(carta) {
  const val = carta.data_validade;
  if (!val) return '—';
  const txt = formatarData(val);
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const d = new Date(val + 'T00:00:00');
  if (isNaN(d)) return txt;
  const dias = Math.round((d - hoje) / 86400000);
  const vigente = carta.status_troca === 'Vigente' && carta.situacao_analise === 'Aprovada';
  if (dias < 0 && carta.status_troca === 'Vigente') return `<span style="color:#c0392b; font-weight:600;" title="Vencida há ${-dias} dia(s)">${txt} ⚠</span>`;
  if (dias <= 90 && vigente) return `<span style="color:#b9770e; font-weight:600;" title="Vence em ${dias} dia(s)">${txt}</span>`;
  return txt;
}

function ctResumoLotes(carta) {
  const lotes = carta.lotes || [];
  if (!lotes.length) return '—';
  const detalhe = lotes.map((l) => `${l.lote || '-'} · ${l.data_validade ? formatarData(l.data_validade) : '-'} · ${l.quantidade != null ? fmtNumero(l.quantidade) : '-'}`).join('\n');
  return `<span title="${escAttr(detalhe)}">${lotes.length} lote(s)</span>`;
}

async function carregarTabelaCartas() {
  const dados = await api(`/cartas-troca?${ctParamsFiltro().toString()}`);
  const corpo = document.getElementById('corpoTabelaCartas');
  const vazio = document.getElementById('estadoVazioCartas');

  // Badges das abas (contadores globais, independentes do filtro).
  const sit = dados.porSituacao || {};
  const badge = (id, n) => { const e = document.getElementById(id); if (!e) return; e.textContent = n || 0; e.hidden = !n; };
  badge('ctBadgeAguardando', sit['Aguardando avaliação']);
  badge('ctBadgePendencia', sit['Reprovada']);

  // KPIs
  const kpi = (rot, val, cls) => `<div class="cartao-resumo"><span class="valor ${cls || ''}">${fmtNumero(val || 0)}</span><span class="rotulo">${rot}</span></div>`;
  document.getElementById('ctGradeResumo').innerHTML =
    kpi('Total', dados.totalGeral) +
    kpi('Aguardando avaliação', sit['Aguardando avaliação']) +
    kpi('Aprovadas', sit['Aprovada']) +
    kpi('Reprovadas', sit['Reprovada']);

  const podeEditar = temPermissao('cartasTroca', 'editar');   // técnico (avaliar)
  const podeInserir = temPermissao('cartasTroca', 'inserir'); // administrativo (registrar/reenviar/status)
  const podeExcluir = temPermissao('cartasTroca', 'excluir');

  if (!dados.cartas.length) {
    corpo.innerHTML = ''; vazio.hidden = false;
  } else {
    vazio.hidden = true;
    corpo.innerHTML = dados.cartas.map((c) => {
      // Coluna Status da troca: editável (select) quando Aprovada e tem permissão.
      let statusCel;
      if (c.situacao_analise === 'Aprovada' && podeInserir) {
        const opc = ['Vigente', 'Vencido no estoque', 'Trocado', 'Consumido', 'Cancelado']
          .map((o) => `<option value="${o}" ${o === c.status_troca ? 'selected' : ''}>${o}</option>`).join('');
        statusCel = `<select class="ct-status-sel" data-id="${c.id}">${opc}</select>`;
      } else {
        statusCel = `<span class="etiqueta-status ${ctClasseStatus(c.status_troca)}">${escHtml(c.status_troca)}</span>`;
      }
      // Ações por situação + permissão
      let acoes = '';
      if (c.situacao_analise === 'Aguardando avaliação' && podeEditar) acoes += `<button type="button" class="botao-icone ct-avaliar" data-id="${c.id}" title="Avaliar (técnico)">🔎 Avaliar</button>`;
      if (c.situacao_analise === 'Reprovada' && podeInserir) acoes += `<button type="button" class="botao-icone ct-reenviar" data-id="${c.id}" title="Corrigir e reenviar">✏️ Corrigir</button>`;
      if (podeExcluir) acoes += ` <button type="button" class="botao-icone ct-excluir" data-id="${c.id}" title="Excluir">🗑️</button>`;
      if (!acoes) acoes = '<span class="texto-apoio">—</span>';

      return `
      <tr data-id="${c.id}">
        <td class="col-codigo"><strong>${escHtml(c.codigo_controle)}</strong></td>
        <td><span class="etiqueta-status ${ctClasseSituacao(c.situacao_analise)}">${escHtml(c.situacao_analise)}</span>${c.situacao_analise === 'Reprovada' && c.motivo_reprovacao ? ` <span title="${escAttr(c.motivo_reprovacao)}" style="cursor:help;">💬</span>` : ''}</td>
        <td>${escHtml(c.empresa)}</td>
        <td class="col-codigo">${escHtml(c.nota_empenho)}</td>
        <td class="col-codigo">${escHtml(c.numero_requisicao)}</td>
        <td class="col-codigo">${escHtml(c.codigo_item)}</td>
        <td>${escHtml(c.medicamento)}</td>
        <td>${escHtml(c.local_entrega)}</td>
        <td>${c.quantidade != null ? fmtNumero(c.quantidade) : '—'} <span class="texto-apoio">(${escHtml(c.tipo_quantidade || 'Total')})</span></td>
        <td>${ctResumoLotes(c)}</td>
        <td>${ctCelulaValidade(c)}</td>
        <td class="col-codigo">${escHtml(c.numero_protocolo)}</td>
        <td>${statusCel}</td>
        <td class="col-acoes" style="white-space:nowrap;">${acoes}</td>
      </tr>`;
    }).join('');

    corpo.querySelectorAll('.ct-avaliar').forEach((b) => b.addEventListener('click', () => abrirModalAvaliar(b.dataset.id)));
    corpo.querySelectorAll('.ct-reenviar').forEach((b) => b.addEventListener('click', () => abrirModalReenviar(b.dataset.id)));
    corpo.querySelectorAll('.ct-excluir').forEach((b) => b.addEventListener('click', () => excluirCarta(b.dataset.id)));
    corpo.querySelectorAll('.ct-status-sel').forEach((s) => s.addEventListener('change', () => ctAtualizarStatus(s.dataset.id, s.value)));
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoCartas').textContent =
    `Página ${dados.page} de ${totalPaginas} · ${fmtNumero(dados.total)} carta(s)`;
  document.getElementById('ctAnterior').disabled = dados.page <= 1;
  document.getElementById('ctProximo').disabled = dados.page >= totalPaginas;
}

async function ctAtualizarStatus(id, status) {
  try {
    await api(`/cartas-troca/${id}/status`, { method: 'POST', body: JSON.stringify({ status_troca: status }) });
    await carregarTabelaCartas();
  } catch (e) { alert('Erro ao atualizar status: ' + e.message); }
}

// ---------- Aba: empenhos importados ----------
let ctDebounceEmp;
async function carregarTabelaEmpenhos() {
  const params = new URLSearchParams({ page: estadoEmpenhos.pagina, pageSize: estadoEmpenhos.pageSize });
  const q = document.getElementById('ctEmpBusca').value.trim();
  if (q) params.set('q', q);
  const dados = await api(`/cartas-troca/empenhos?${params.toString()}`);
  const corpo = document.getElementById('corpoTabelaEmpenhos');
  const vazio = document.getElementById('estadoVazioEmpenhos');
  document.getElementById('ctEmpInfo').textContent = dados.dataReferencia
    ? `${fmtNumero(dados.total)} linha(s) · importado em ${formatarData(dados.dataReferencia)}${dados.dataImportacao ? ' às ' + String(dados.dataImportacao).slice(11, 16) : ''}` : '';

  if (!dados.itens.length) { corpo.innerHTML = ''; vazio.hidden = false; }
  else {
    vazio.hidden = true;
    corpo.innerHTML = dados.itens.map((e) => `
      <tr>
        <td class="col-codigo">${escHtml(e.nota_empenho)}</td>
        <td>${escHtml(e.empresa)}</td>
        <td class="col-codigo">${escHtml(e.scodes)}</td>
        <td class="col-codigo">${escHtml(e.siafisico)}</td>
        <td>${escHtml(e.medicamento)}</td>
        <td>${escHtml(e.apresentacao)}</td>
        <td>${e.quantidade != null ? fmtNumero(e.quantidade) : '—'}</td>
        <td>${e.valor_unitario != null ? fmtNumero(e.valor_unitario) : '—'}</td>
        <td>${e.valor_total != null ? fmtNumero(e.valor_total) : '—'}</td>
        <td>${escHtml(e.status_entrega)}</td>
        <td>${escHtml(e.local_entrega)}</td>
        <td class="col-codigo">${escHtml(e.numero_requisicao)}</td>
        <td>${temPermissao('cartasTroca', 'inserir') ? `<button type="button" class="botao-icone ct-emp-usar" title="Registrar carta deste empenho">➕ Carta</button>` : '<span class="texto-apoio">—</span>'}</td>
      </tr>`).join('');
    // Botão "Carta" abre o modal já com este empenho selecionado.
    corpo.querySelectorAll('.ct-emp-usar').forEach((b, i) => b.addEventListener('click', () => {
      const e = dados.itens[i];
      abrirModalNovaCarta();
      ctSelecionarEmpenho({ id: null, nota_empenho: e.nota_empenho, numero_requisicao: e.numero_requisicao,
        nome_requisicao: null, processo_sem_papel: e.processo_sem_papel, empresa: e.empresa, scodes: e.scodes,
        siafisico: e.siafisico, medicamento: e.medicamento, apresentacao: e.apresentacao, quantidade: e.quantidade,
        local_entrega: e.local_entrega });
    }));
  }
  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoEmpenhos').textContent = `Página ${dados.page} de ${totalPaginas} · ${fmtNumero(dados.total)} linha(s)`;
  document.getElementById('ctEmpAnterior').disabled = dados.page <= 1;
  document.getElementById('ctEmpProximo').disabled = dados.page >= totalPaginas;
}

// ==================== Modal (registrar / reenviar / avaliar) ====================
const CT_IDENT = ['ctEmpresa', 'ctNota', 'ctRequisicao', 'ctSei', 'ctScodes', 'ctSiafisico', 'ctMedicamento', 'ctApresentacao', 'ctNomeReq'];

function ctSetIdentEditavel(editavel) {
  CT_IDENT.forEach((id) => { document.getElementById(id).disabled = !editavel; });
}

function ctLimparForm() {
  ['ctEmpresa', 'ctNota', 'ctRequisicao', 'ctSei', 'ctScodes', 'ctSiafisico', 'ctMedicamento', 'ctApresentacao', 'ctNomeReq',
    'ctLocalEntrega', 'ctProtocolo', 'ctDataProtocolo', 'ctQuantidade', 'ctObservacao', 'ctMotivoReprovacao'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('ctTipoQtd').value = 'Total';
  document.getElementById('ctStatus').value = 'Vigente';
  document.getElementById('ctNumLotes').value = 1;
  document.getElementById('ctLotesContainer').innerHTML = '';
  document.getElementById('ctLotesResumo').textContent = '';
  document.getElementById('ctQtdDica').textContent = '';
}

function ctBotoesRodape(modo) {
  document.getElementById('ctModalSalvar').hidden = modo !== 'nova';
  document.getElementById('ctModalReenviar').hidden = modo !== 'reenviar';
  document.getElementById('ctModalReprovar').hidden = modo !== 'avaliar';
  document.getElementById('ctModalAprovar').hidden = modo !== 'avaliar';
  document.getElementById('ctBlocoAvaliacao').hidden = modo !== 'avaliar';
}

function abrirModalNovaCarta() {
  estadoCartas.modo = 'nova';
  estadoCartas.editandoId = null;
  estadoCartas.empenhoSel = null;
  estadoCartas.empenhoQtd = null;
  estadoCartas.manual = false;
  document.getElementById('ctModalTitulo').textContent = 'Registro de Carta de Troca';
  document.getElementById('ctBannerReprovacao').hidden = true;
  document.getElementById('ctBuscaEmpenhoBloco').hidden = false;
  document.getElementById('ctBuscaEmpenho').value = '';
  document.getElementById('ctResultadosEmpenho').innerHTML = '';
  document.getElementById('ctFormCarta').hidden = true;
  ctLimparForm();
  ctSetIdentEditavel(false);
  ctBotoesRodape('nova');
  document.getElementById('ctRotuloMotivo').hidden = true;
  document.getElementById('modalCartaTroca').hidden = false;
  setTimeout(() => document.getElementById('ctBuscaEmpenho').focus(), 50);
}

// "Empenho não localizado": processo de aquisição feito fora do sistema
// convencional. Abre TODOS os campos em branco e editáveis; ao salvar, todos
// passam a ser obrigatórios (ver ctCamposFaltando).
function ctEmpenhoNaoLocalizado() {
  estadoCartas.manual = true;
  estadoCartas.empenhoSel = null;
  estadoCartas.empenhoQtd = null;
  document.getElementById('ctModalTitulo').textContent = 'Registro de Carta de Troca — empenho não localizado';
  ctLimparForm();
  document.getElementById('ctBuscaEmpenhoBloco').hidden = true;
  document.getElementById('ctFormCarta').hidden = false;
  document.getElementById('ctTrocarEmpenho').hidden = false; // volta à busca
  ctSetIdentEditavel(true); // todos os campos de identidade abertos
  ctAplicarTipoQtd();
  ctRenderLotes();
  setTimeout(() => document.getElementById('ctEmpresa').focus(), 50);
}

let ctDebounceBusca;
function ctBuscarEmpenhos() {
  clearTimeout(ctDebounceBusca);
  ctDebounceBusca = setTimeout(async () => {
    const q = document.getElementById('ctBuscaEmpenho').value.trim();
    const cont = document.getElementById('ctResultadosEmpenho');
    if (q.length < 2) { cont.innerHTML = ''; return; }
    try {
      const { empenhos } = await api(`/cartas-troca/empenhos/buscar?q=${encodeURIComponent(q)}`);
      if (!empenhos.length) { cont.innerHTML = '<div class="texto-apoio" style="padding:8px;">Nenhum empenho encontrado. Importe o Relatório de Empenhos, se necessário.</div>'; return; }
      cont.innerHTML = empenhos.map((e, i) => `
        <div class="item-resultado" data-i="${i}" style="padding:8px 10px; border-bottom:1px solid var(--borda, #e5e8ee); cursor:pointer;">
          <div style="font-size:13px;"><strong>${escHtml(e.medicamento)}</strong> ${e.apresentacao ? '<span class="texto-apoio">· ' + escHtml(e.apresentacao) + '</span>' : ''}</div>
          <div style="font-size:12px; color:var(--cinza-texto);">
            ${escHtml(e.empresa)} · Empenho <strong>${escHtml(e.nota_empenho)}</strong> · SCODES ${escHtml(e.scodes)} · Req. ${escHtml(e.numero_requisicao)}
            ${e.quantidade != null ? '· Qtd ' + fmtNumero(e.quantidade) : ''} ${e.status_entrega ? '· ' + escHtml(e.status_entrega) : ''}
          </div>
        </div>`).join('');
      cont.querySelectorAll('.item-resultado').forEach((div) => div.addEventListener('click', () => ctSelecionarEmpenho(empenhos[Number(div.dataset.i)])));
    } catch (e) {
      cont.innerHTML = `<div class="texto-apoio" style="padding:8px; color:#c0392b;">Erro na busca: ${escHtml(e.message)}</div>`;
    }
  }, 300);
}

function ctSelecionarEmpenho(emp) {
  estadoCartas.manual = false;
  estadoCartas.empenhoSel = emp;
  estadoCartas.empenhoQtd = emp.quantidade != null ? emp.quantidade : null;
  document.getElementById('ctEmpresa').value = emp.empresa || '';
  document.getElementById('ctNota').value = emp.nota_empenho || '';
  document.getElementById('ctRequisicao').value = emp.numero_requisicao || '';
  document.getElementById('ctSei').value = emp.processo_sem_papel || '';
  document.getElementById('ctScodes').value = emp.scodes || '';
  document.getElementById('ctSiafisico').value = emp.siafisico || '';
  document.getElementById('ctMedicamento').value = emp.medicamento || '';
  document.getElementById('ctApresentacao').value = emp.apresentacao || '';
  document.getElementById('ctNomeReq').value = emp.nome_requisicao || '';
  document.getElementById('ctLocalEntrega').value = emp.local_entrega || '';
  document.getElementById('ctBuscaEmpenhoBloco').hidden = true;
  document.getElementById('ctFormCarta').hidden = false;
  document.getElementById('ctTrocarEmpenho').hidden = false;
  ctSetIdentEditavel(false);
  ctAplicarTipoQtd();
  ctRenderLotes();
  setTimeout(() => document.getElementById('ctProtocolo').focus(), 50);
}

function ctTrocarEmpenho() {
  estadoCartas.manual = false;
  estadoCartas.empenhoSel = null;
  estadoCartas.empenhoQtd = null;
  document.getElementById('ctModalTitulo').textContent = 'Registro de Carta de Troca';
  document.getElementById('ctBuscaEmpenhoBloco').hidden = false;
  document.getElementById('ctFormCarta').hidden = true;
  document.getElementById('ctResultadosEmpenho').innerHTML = '';
  document.getElementById('ctBuscaEmpenho').value = '';
  setTimeout(() => document.getElementById('ctBuscaEmpenho').focus(), 50);
}

// Total: quantidade = qtd do empenho (bloqueada). Parcial: digitável.
function ctAplicarTipoQtd() {
  const tipo = document.getElementById('ctTipoQtd').value;
  const inp = document.getElementById('ctQuantidade');
  const dica = document.getElementById('ctQtdDica');
  if (tipo === 'Total' && !estadoCartas.manual && estadoCartas.empenhoQtd != null) {
    inp.value = estadoCartas.empenhoQtd;
    inp.readOnly = true;
    dica.textContent = '= quantidade do empenho';
  } else {
    inp.readOnly = false;
    dica.textContent = estadoCartas.manual ? 'informe a quantidade total da carta' : (tipo === 'Total' ? 'informe a quantidade' : 'informe a quantidade parcial');
  }
  ctAtualizarResumoLotes();
}

// Renderiza N linhas de lote preservando o que já foi digitado.
function ctRenderLotes(lotesExistentes) {
  const n = Math.max(1, Math.min(30, parseInt(document.getElementById('ctNumLotes').value, 10) || 1));
  const cont = document.getElementById('ctLotesContainer');
  const atuais = ctColetarLotes();
  const base = lotesExistentes || atuais;
  let html = '';
  for (let i = 0; i < n; i++) {
    const l = base[i] || {};
    html += `
      <div class="ct-lote-row" style="display:grid; grid-template-columns:1fr 160px 140px; gap:8px; align-items:end;">
        <label style="margin:0;">Lote ${i + 1}<input type="text" class="ct-lote" value="${escAttr(l.lote || '')}" placeholder="ex.: ABC123"></label>
        <label style="margin:0;">Validade *<input type="date" class="ct-lote-val" value="${escAttr(l.data_validade || '')}"></label>
        <label style="margin:0;">Quantidade<input type="number" class="ct-lote-qtd" step="any" min="0" value="${l.quantidade != null ? l.quantidade : ''}"></label>
      </div>`;
  }
  cont.innerHTML = html;
  cont.querySelectorAll('.ct-lote-qtd').forEach((i) => i.addEventListener('input', ctAtualizarResumoLotes));
  ctAtualizarResumoLotes();
}

function ctColetarLotes() {
  return [...document.querySelectorAll('#ctLotesContainer .ct-lote-row')].map((row) => ({
    lote: row.querySelector('.ct-lote').value.trim() || null,
    data_validade: row.querySelector('.ct-lote-val').value || null,
    quantidade: row.querySelector('.ct-lote-qtd').value !== '' ? Number(row.querySelector('.ct-lote-qtd').value) : null,
  }));
}

function ctAtualizarResumoLotes() {
  const lotes = ctColetarLotes();
  const soma = lotes.reduce((s, l) => s + (l.quantidade || 0), 0);
  const qtd = Number(document.getElementById('ctQuantidade').value) || 0;
  const el = document.getElementById('ctLotesResumo');
  const bate = Math.abs(soma - qtd) < 0.001;
  el.innerHTML = `Soma dos lotes: <strong>${fmtNumero(soma)}</strong> / Quantidade da carta: <strong>${fmtNumero(qtd)}</strong> ` +
    (qtd > 0 ? (bate ? '<span style="color:#2e7d5b;">✓ fecha</span>' : '<span style="color:#c0392b;">✗ não fecha</span>') : '');
}

// Preenche o modal a partir de uma carta existente (reenviar/avaliar).
function ctPreencherDeCartas(carta) {
  document.getElementById('ctEmpresa').value = carta.empresa || '';
  document.getElementById('ctNota').value = carta.nota_empenho || '';
  document.getElementById('ctRequisicao').value = carta.numero_requisicao || '';
  document.getElementById('ctSei').value = carta.processo_sem_papel || '';
  document.getElementById('ctScodes').value = carta.codigo_item || '';
  document.getElementById('ctSiafisico').value = carta.siafisico || '';
  document.getElementById('ctMedicamento').value = carta.medicamento || '';
  document.getElementById('ctApresentacao').value = carta.apresentacao || '';
  document.getElementById('ctNomeReq').value = carta.nome_requisicao || '';
  document.getElementById('ctLocalEntrega').value = carta.local_entrega || '';
  document.getElementById('ctProtocolo').value = carta.numero_protocolo || '';
  document.getElementById('ctDataProtocolo').value = carta.data_protocolo || '';
  document.getElementById('ctTipoQtd').value = carta.tipo_quantidade || 'Total';
  document.getElementById('ctQuantidade').value = carta.quantidade != null ? carta.quantidade : '';
  document.getElementById('ctStatus').value = carta.status_troca || 'Vigente';
  document.getElementById('ctObservacao').value = carta.observacao || '';
  estadoCartas.empenhoQtd = carta.tipo_quantidade === 'Total' ? carta.quantidade : null;
  const nl = (carta.lotes && carta.lotes.length) ? carta.lotes.length : 1;
  document.getElementById('ctNumLotes').value = nl;
  ctRenderLotes(carta.lotes || []);
  document.getElementById('ctQuantidade').readOnly = (carta.tipo_quantidade || 'Total') === 'Total';
}

async function abrirModalReenviar(id) {
  try {
    const { carta } = await api(`/cartas-troca/${id}`);
    estadoCartas.modo = 'reenviar';
    estadoCartas.editandoId = carta.id;
    document.getElementById('ctModalTitulo').textContent = `Corrigir e reenviar — ${carta.codigo_controle || ''}`.trim();
    document.getElementById('ctBuscaEmpenhoBloco').hidden = true;
    document.getElementById('ctFormCarta').hidden = false;
    document.getElementById('ctTrocarEmpenho').hidden = true;
    document.getElementById('ctBannerReprovacao').hidden = !carta.motivo_reprovacao;
    document.getElementById('ctBannerMotivo').textContent = carta.motivo_reprovacao || '';
    ctPreencherDeCartas(carta);
    ctSetIdentEditavel(false); // administrativo corrige os dados da carta, não a identidade do empenho
    document.getElementById('ctRotuloMotivo').hidden = true;
    ctBotoesRodape('reenviar');
    document.getElementById('modalCartaTroca').hidden = false;
  } catch (e) { alert('Não consegui abrir a carta: ' + e.message); }
}

async function abrirModalAvaliar(id) {
  try {
    const { carta } = await api(`/cartas-troca/${id}`);
    estadoCartas.modo = 'avaliar';
    estadoCartas.editandoId = carta.id;
    document.getElementById('ctModalTitulo').textContent = `Avaliação técnica — ${carta.codigo_controle || ''}`.trim();
    document.getElementById('ctBuscaEmpenhoBloco').hidden = true;
    document.getElementById('ctFormCarta').hidden = false;
    document.getElementById('ctTrocarEmpenho').hidden = true;
    document.getElementById('ctBannerReprovacao').hidden = true;
    ctPreencherDeCartas(carta);
    ctSetIdentEditavel(true); // técnico pode editar todos os campos, inclusive os do empenho
    document.getElementById('ctRotuloMotivo').hidden = true;
    document.getElementById('ctMotivoReprovacao').value = '';
    ctBotoesRodape('avaliar');
    document.getElementById('modalCartaTroca').hidden = false;
  } catch (e) { alert('Não consegui abrir a carta: ' + e.message); }
}

function fecharModalCarta() { document.getElementById('modalCartaTroca').hidden = true; }

// Monta o corpo comum (campos + lotes) a partir do formulário.
function ctColetarCorpo() {
  return {
    empresa: document.getElementById('ctEmpresa').value.trim() || null,
    nota_empenho: document.getElementById('ctNota').value.trim() || null,
    numero_requisicao: document.getElementById('ctRequisicao').value.trim() || null,
    processo_sem_papel: document.getElementById('ctSei').value.trim() || null,
    codigo_item: document.getElementById('ctScodes').value.trim() || null,
    siafisico: document.getElementById('ctSiafisico').value.trim() || null,
    medicamento: document.getElementById('ctMedicamento').value.trim() || null,
    apresentacao: document.getElementById('ctApresentacao').value.trim() || null,
    nome_requisicao: document.getElementById('ctNomeReq').value.trim() || null,
    local_entrega: document.getElementById('ctLocalEntrega').value.trim() || null,
    numero_protocolo: document.getElementById('ctProtocolo').value.trim() || null,
    data_protocolo: document.getElementById('ctDataProtocolo').value || null,
    tipo_quantidade: document.getElementById('ctTipoQtd').value,
    quantidade: document.getElementById('ctQuantidade').value || null,
    status_troca: document.getElementById('ctStatus').value,
    observacao: document.getElementById('ctObservacao').value.trim() || null,
    lotes: ctColetarLotes(),
  };
}

function ctValidarBasico(corpo) {
  if (!corpo.numero_protocolo) { alert('Informe o Nº do protocolo.'); return false; }
  const lotes = corpo.lotes.filter((l) => l.lote || l.data_validade || l.quantidade != null);
  if (!lotes.length || lotes.some((l) => !l.data_validade)) { alert('Informe ao menos um lote com data de validade.'); return false; }
  return true;
}

// No modo "empenho não localizado" TUDO é obrigatório (não há empenho de onde
// puxar os dados). Devolve a lista de campos em falta.
function ctCamposFaltandoManual(corpo) {
  const obrig = [
    ['empresa', 'Fornecedor'], ['nota_empenho', 'Nota de empenho'], ['numero_requisicao', 'Requisição'],
    ['processo_sem_papel', 'Processo Sem Papel / SEI'], ['codigo_item', 'SCODES'], ['siafisico', 'SIAFÍSICO'],
    ['medicamento', 'Medicamento'], ['apresentacao', 'Apresentação'], ['nome_requisicao', 'Nome da requisição'],
    ['local_entrega', 'Local de entrega'], ['numero_protocolo', 'Nº do protocolo'], ['data_protocolo', 'Data do protocolo'],
  ];
  const faltando = obrig.filter(([k]) => !corpo[k]).map(([, r]) => r);
  const qtd = Number(corpo.quantidade);
  if (!qtd || qtd <= 0) faltando.push('Quantidade da carta');
  const lotes = corpo.lotes.filter((l) => l.lote || l.data_validade || l.quantidade != null);
  if (!lotes.length || lotes.some((l) => !l.lote || !l.data_validade || l.quantidade == null)) {
    faltando.push('Lotes completos (lote, validade e quantidade em cada linha)');
  }
  return faltando;
}

async function salvarCarta() {
  const corpo = ctColetarCorpo();
  if (!estadoCartas.manual && !estadoCartas.empenhoSel && !corpo.empresa) { alert('Selecione um empenho antes de salvar.'); return; }
  if (estadoCartas.manual) {
    const faltando = ctCamposFaltandoManual(corpo);
    if (faltando.length) { alert('Empenho não localizado: preencha todos os campos.\n\nFaltando:\n• ' + faltando.join('\n• ')); return; }
  }
  if (!ctValidarBasico(corpo)) return;
  const btn = document.getElementById('ctModalSalvar');
  btn.disabled = true;
  try {
    await api('/cartas-troca', { method: 'POST', body: JSON.stringify({ ...corpo, empenho_id: estadoCartas.empenhoSel ? estadoCartas.empenhoSel.id : null, empenho_quantidade: estadoCartas.empenhoQtd }) });
    fecharModalCarta();
    estadoCartas.filtrosCarregados = false;
    await carregarCartasTroca();
  } catch (e) { alert('Erro ao salvar: ' + e.message); }
  finally { btn.disabled = false; }
}

async function reenviarCarta() {
  const corpo = ctColetarCorpo();
  if (!ctValidarBasico(corpo)) return;
  const btn = document.getElementById('ctModalReenviar');
  btn.disabled = true;
  try {
    await api(`/cartas-troca/${estadoCartas.editandoId}/reenviar`, { method: 'POST', body: JSON.stringify({ ...corpo, empenho_quantidade: estadoCartas.empenhoQtd }) });
    fecharModalCarta();
    await carregarCartasTroca();
  } catch (e) { alert('Erro ao reenviar: ' + e.message); }
  finally { btn.disabled = false; }
}

async function avaliarCarta(resultado) {
  const corpo = ctColetarCorpo();
  if (!ctValidarBasico(corpo)) return;
  if (resultado === 'Reprovada') {
    const rot = document.getElementById('ctRotuloMotivo');
    const mot = document.getElementById('ctMotivoReprovacao');
    if (rot.hidden) { rot.hidden = false; mot.focus(); return; } // primeiro clique revela o campo
    if (!mot.value.trim()) { alert('Informe o motivo da reprovação.'); mot.focus(); return; }
  }
  const btn = resultado === 'Aprovada' ? document.getElementById('ctModalAprovar') : document.getElementById('ctModalReprovar');
  btn.disabled = true;
  try {
    await api(`/cartas-troca/${estadoCartas.editandoId}/avaliar`, {
      method: 'PUT',
      body: JSON.stringify({ ...corpo, resultado, motivo_reprovacao: document.getElementById('ctMotivoReprovacao').value.trim() || null, empenho_quantidade: estadoCartas.empenhoQtd }),
    });
    fecharModalCarta();
    await carregarCartasTroca();
  } catch (e) { alert('Erro ao registrar avaliação: ' + e.message); }
  finally { btn.disabled = false; }
}

async function excluirCarta(id) {
  if (!confirm('Excluir esta carta de troca? Esta ação não pode ser desfeita.')) return;
  try {
    await api(`/cartas-troca/${id}`, { method: 'DELETE' });
    await carregarTabelaCartas();
  } catch (e) { alert('Erro ao excluir: ' + e.message); }
}

async function ctImportarEmpenhos(input) {
  if (!input.files[0]) return;
  const fd = new FormData();
  fd.append('arquivo', input.files[0]);
  const btn = document.getElementById('ctBotaoImportarEmpenhos');
  const txt = btn.textContent;
  btn.disabled = true; btn.textContent = 'Importando…';
  try {
    const resp = await fetch('/api/cartas-troca/importar-empenhos/confirmar', { method: 'POST', body: fd });
    const dados = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(dados.erro || 'Falha na importação');
    alert(`Relatório importado: ${fmtNumero(dados.totalLinhas)} linhas de empenho (${fmtNumero(dados.totalEmpenhos)} empenhos distintos).`);
    await carregarCartasTroca();
  } catch (e) {
    alert('Erro ao importar empenhos: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = txt; input.value = '';
  }
}

// ---------- Listeners da tela ----------
document.querySelectorAll('#ctAbas .chip-faixa').forEach((b) => {
  b.addEventListener('click', () => ctTrocarAba(b.dataset.aba, b.dataset.sit));
});
let ctDebounceFiltro;
document.getElementById('ctFiltroBusca').addEventListener('input', () => {
  clearTimeout(ctDebounceFiltro);
  ctDebounceFiltro = setTimeout(() => { estadoCartas.pagina = 1; carregarTabelaCartas(); }, 350);
});
document.getElementById('ctFiltroEmpresa').addEventListener('change', () => { estadoCartas.pagina = 1; carregarTabelaCartas(); });
document.getElementById('ctFiltroStatus').addEventListener('change', () => { estadoCartas.pagina = 1; carregarTabelaCartas(); });
document.getElementById('ctLimparFiltros').addEventListener('click', () => {
  document.getElementById('ctFiltroBusca').value = '';
  document.getElementById('ctFiltroEmpresa').value = '';
  document.getElementById('ctFiltroStatus').value = '';
  estadoCartas.pagina = 1; carregarTabelaCartas();
});
document.getElementById('ctAnterior').addEventListener('click', () => { if (estadoCartas.pagina > 1) { estadoCartas.pagina--; carregarTabelaCartas(); } });
document.getElementById('ctProximo').addEventListener('click', () => { estadoCartas.pagina++; carregarTabelaCartas(); });
document.getElementById('ctEmpBusca').addEventListener('input', () => {
  clearTimeout(ctDebounceEmp);
  ctDebounceEmp = setTimeout(() => { estadoEmpenhos.pagina = 1; carregarTabelaEmpenhos(); }, 350);
});
document.getElementById('ctEmpAnterior').addEventListener('click', () => { if (estadoEmpenhos.pagina > 1) { estadoEmpenhos.pagina--; carregarTabelaEmpenhos(); } });
document.getElementById('ctEmpProximo').addEventListener('click', () => { estadoEmpenhos.pagina++; carregarTabelaEmpenhos(); });
document.getElementById('ctBotaoNova').addEventListener('click', abrirModalNovaCarta);
document.getElementById('ctBotaoExportar').addEventListener('click', () => { window.location.href = `/api/cartas-troca/exportar?${ctParamsFiltro().toString()}`; });
document.getElementById('ctBotaoImportarEmpenhos').addEventListener('click', () => document.getElementById('ctArquivoEmpenhos').click());
document.getElementById('ctArquivoEmpenhos').addEventListener('change', (ev) => ctImportarEmpenhos(ev.target));
document.getElementById('ctBuscaEmpenho').addEventListener('input', ctBuscarEmpenhos);
document.getElementById('ctBtnNaoLocalizado').addEventListener('click', ctEmpenhoNaoLocalizado);
document.getElementById('ctTrocarEmpenho').addEventListener('click', ctTrocarEmpenho);
document.getElementById('ctNumLotes').addEventListener('change', () => ctRenderLotes());
document.getElementById('ctTipoQtd').addEventListener('change', ctAplicarTipoQtd);
document.getElementById('ctQuantidade').addEventListener('input', ctAtualizarResumoLotes);
document.getElementById('ctModalCancelar').addEventListener('click', fecharModalCarta);
document.getElementById('ctModalSalvar').addEventListener('click', salvarCarta);
document.getElementById('ctModalReenviar').addEventListener('click', reenviarCarta);
document.getElementById('ctModalAprovar').addEventListener('click', () => avaliarCarta('Aprovada'));
document.getElementById('ctModalReprovar').addEventListener('click', () => avaliarCarta('Reprovada'));

// -------------------- Relatório Primeiro Atendimento (requisições salvas) --------------------
const estadoRelReq = { pagina: 1, pageSize: 50, filtrosCarregados: false, caixa: 'todas' };

let debounceRelReq;
['reqFiltroPaciente', 'reqFiltroSEI', 'reqFiltroCodigo', 'reqFiltroDescricao'].forEach((id) => {
  document.getElementById(id).addEventListener('input', () => {
    clearTimeout(debounceRelReq);
    debounceRelReq = setTimeout(() => { estadoRelReq.pagina = 1; carregarTabelaRelReq(); }, 350);
  });
});
document.getElementById('reqFiltroCategoria').addEventListener('change', () => { estadoRelReq.pagina = 1; carregarTabelaRelReq(); });
document.getElementById('reqFiltroStatusEstoque').addEventListener('change', () => { estadoRelReq.pagina = 1; carregarTabelaRelReq(); });
document.getElementById('reqLimparFiltros').addEventListener('click', () => {
  ['reqFiltroPaciente', 'reqFiltroSEI', 'reqFiltroCodigo', 'reqFiltroDescricao'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('reqFiltroCategoria').value = '';
  document.getElementById('reqFiltroStatusEstoque').value = '';
  estadoRelReq.pagina = 1; carregarTabelaRelReq();
});
document.getElementById('reqAnterior').addEventListener('click', () => {
  if (estadoRelReq.pagina > 1) { estadoRelReq.pagina--; carregarTabelaRelReq(); }
});
document.getElementById('reqProximo').addEventListener('click', () => { estadoRelReq.pagina++; carregarTabelaRelReq(); });

// Abas por CAIXA (Materiais/Medicamentos/Nutrição). Admin vê "Todas" + as 3
// (+ "Sem caixa" quando houver); colaborador vê "Todas" (= suas caixas) + as
// caixas que tem direito.
function renderAbasCaixaReq(caixas) {
  const barra = document.getElementById('abasCaixaReq');
  if (!barra) return;
  if (!caixas) { barra.hidden = true; barra.innerHTML = ''; return; }
  const { ehAdmin, veTodas = false, visiveis = [], contagens = {}, totalPermitido = 0 } = caixas;
  // "Todas" primeiro; depois as caixas em ordem ALFABÉTICA (Manipulado,
  // Materiais, Medicamentos, Nutrição); "Sem caixa" (admin) por último.
  // A aba "Todas" só aparece para quem tem a permissão (admin sempre).
  const abas = [];
  if (veTodas) abas.push({ chave: 'todas', rot: 'Todas', n: totalPermitido });
  [...visiveis].sort((a, b) => a.localeCompare(b, 'pt')).forEach((c) => abas.push({ chave: c, rot: c, n: contagens[c] || 0 }));
  if (ehAdmin && (contagens.sem || 0) > 0) abas.push({ chave: 'sem', rot: 'Sem caixa', n: contagens.sem });
  // Abas de STATUS, à direita (Cancelado e Finalizado).
  const abasStatus = [
    { chave: 'cancelado', rot: 'Cancelado', n: contagens.cancelado || 0 },
    { chave: 'finalizado', rot: 'Finalizado', n: contagens.finalizado || 0 },
  ];

  // Se a aba ativa não existe mais (ex.: sem permissão de "Todas"), cai para a
  // primeira aba disponível (Todas, se tiver; senão a primeira caixa) e
  // recarrega a lista nessa aba, para o conteúdo bater com a aba destacada.
  const todasChaves = [...abas, ...abasStatus].map((a) => a.chave);
  if (!todasChaves.includes(estadoRelReq.caixa)) {
    const alvo = todasChaves[0]; // sempre existe (Cancelado/Finalizado no mínimo)
    if (alvo && alvo !== estadoRelReq.caixa) {
      estadoRelReq.caixa = alvo;
      carregarTabelaRelReq(); // recarrega na aba certa (conteúdo bate com a aba)
      return;
    }
  }

  const btn = (a) => `<button type="button" class="chip-faixa ${estadoRelReq.caixa === a.chave ? 'ativo' : ''}" data-caixa="${a.chave}">${escHtml(a.rot)} (${fmtNumero(a.n)})</button>`;
  barra.hidden = false;
  barra.innerHTML = abas.map(btn).join('')
    + '<div style="flex:1 1 20px; align-self:stretch;"></div>'
    + abasStatus.map(btn).join('');
}
document.getElementById('abasCaixaReq').addEventListener('click', (ev) => {
  const b = ev.target.closest('.chip-faixa');
  if (!b) return;
  estadoRelReq.caixa = b.dataset.caixa;
  estadoRelReq.pagina = 1;
  carregarTabelaRelReq();
});

async function carregarRelatorioReq() {
  if (!estadoRelReq.filtrosCarregados) {
    try {
      const { categorias } = await api('/autores/requisicoes/categorias');
      document.getElementById('reqFiltroCategoria').innerHTML =
        '<option value="">Categoria: todas</option>' +
        categorias.map((c) => `<option value="${c.replace(/"/g, '&quot;')}">${c}</option>`).join('');
      estadoRelReq.filtrosCarregados = true;
    } catch (e) { /* segue */ }
  }
  carregarTabelaRelReq();
}

async function carregarTabelaRelReq() {
  const params = new URLSearchParams({ page: estadoRelReq.pagina, pageSize: estadoRelReq.pageSize });
  const set = (param, id) => { const v = document.getElementById(id).value.trim(); if (v) params.set(param, v); };
  set('paciente', 'reqFiltroPaciente');
  set('sei', 'reqFiltroSEI');
  set('codigo_item', 'reqFiltroCodigo');
  set('descricao', 'reqFiltroDescricao');
  const cat = document.getElementById('reqFiltroCategoria').value;
  if (cat) params.set('categoria', cat);
  const se = document.getElementById('reqFiltroStatusEstoque').value;
  if (se) params.set('statusEstoque', se);
  if (estadoRelReq.caixa && estadoRelReq.caixa !== 'todas') params.set('caixa', estadoRelReq.caixa);

  const dados = await api(`/autores/requisicoes/itens?${params.toString()}`);
  renderAbasCaixaReq(dados.caixas);
  const corpo = document.getElementById('corpoTabelaRelatorioReq');
  const vazio = document.getElementById('estadoVazioRelatorioReq');

  // KPIs (sobre todo o conjunto filtrado) — padrão ERP.
  const alvoKpi = document.getElementById('kpisRelatorioReq');
  if (alvoKpi && dados.resumo) {
    const r = dados.resumo;
    const nK = (v) => Number(v || 0).toLocaleString('pt-BR');
    const totalK = Number(r.total || 0);
    const pctFin = totalK ? Math.round((Number(r.finalizado || 0) / totalK) * 100) : 0;
    alvoKpi.innerHTML =
      kpiCard('doc', nK(r.total), 'Requisições (filtro atual)', 'itens no recorte') +
      kpiCard('relogio', nK(r.solicitado), 'Aguardando', 'status "Solicitado"', 'aviso') +
      kpiCard('check', nK(r.finalizado), 'Finalizadas', `${pctFin}% do total`) +
      kpiCard('chart', nK(r.enviados), 'Telegramas enviados', 'primeiro atendimento comunicado');
  }

  const opc = (lista, atual) => lista.map((o) =>
    `<option value="${o}" ${o === atual ? 'selected' : ''}>${o}</option>`).join('');

  const ehAdmin = estado.usuario && estado.usuario.perfil === 'admin';
  const fmtDataHora = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  if (dados.itens.length === 0) {
    corpo.innerHTML = ''; vazio.hidden = false;
  } else {
    vazio.hidden = true;
    // Requisições (individuais) que já tiveram algum telegrama enviado: nelas o
    // "↺ Reabrir" fica restrito ao admin (colaborador não desfaz envio).
    const reqComTelegrama = new Set(
      dados.itens.filter((x) => x.tipo !== 'coletiva' && x.telegrama_enviado === 'Sim').map((x) => x.requisicao_id)
    );
    corpo.innerHTML = dados.itens.map((it) => {
      // ----- Linha CONSOLIDADA de uma Solicitação Coletiva -----
      if (it.tipo === 'coletiva') {
        const enviadoC = it.telegrama_enviado === 'Sim';
        const disC = enviadoC && !ehAdmin ? 'disabled' : '';
        const maisN = (it.total_pacientes || 1) - 1;
        const nomePac = `${it.autor || '—'}${maisN > 0 ? ` <span style="color:var(--cinza-texto);">e mais ${maisN} paciente${maisN > 1 ? 's' : ''}</span>` : ''}`;
        return `
        <tr data-req="${it.requisicao_id}" data-coletiva="1" data-justificativa="${(it.justificativa || '').replace(/"/g, '&quot;')}">
          <td class="col-codigo"><a href="#" class="req-abrir-doc" data-req="${it.requisicao_id}"><strong>${it.codigo_controle || ('#' + it.requisicao_id)}</strong></a> <span class="tag-programa sub" style="font-size:9px;">COLETIVA</span>
            ${(ehAdmin || !enviadoC) ? `<br><button type="button" class="req-reabrir-col" data-req="${it.requisicao_id}" title="Reabrir para incluir pacientes ou medicamentos (status volta para Solicitado)" style="margin-top:4px; padding:2px 8px; font-size:11px;">↺ Reabrir</button>` : ''}</td>
          <td>${nomePac}</td>
          <td class="col-codigo">${it.sei || '—'}</td>
          <td colspan="4" style="color:var(--cinza-texto);">${fmtNumero(it.total_itens)} medicamento(s) · ${fmtNumero(it.total_pacientes)} paciente(s)
            <button type="button" class="botao-secundario req-ver-itens" data-req="${it.requisicao_id}" style="padding:2px 9px; font-size:11px; margin-left:8px;">👁 Ver itens</button></td>
          <td>—</td>
          <td>—</td>
          <td>${it.status_estoque_coletiva === 'Chamar'
            ? '<span class="etiqueta-status finalizado">Chamar</span>'
            : it.status_estoque_coletiva
              ? '<span class="etiqueta-status cancelado" title="Ao menos um item com autonomia baixa">Aguardar / Atend. Parcial</span>'
              : '<span style="color:var(--cinza-texto); font-size:12px;">—</span>'}</td>
          <td><select class="req-at-status" ${disC}>${opc(['Solicitado', 'Finalizado', 'Cancelado'], it.status_atendimento)}</select></td>
          <td><input type="text" class="req-at-gsnet" value="${fmtGsnet(it.requisicao_gsnet).replace(/"/g, '&quot;')}" placeholder="GSNET" style="width:120px;" ${disC}></td>
          <td><select class="req-at-tel" ${disC}>${opc(['Não', 'Sim'], it.telegrama_enviado)}</select></td>
          <td><input type="date" class="req-at-data" value="${it.data_envio || ''}" ${disC}></td>
        </tr>`;
      }
      const aut = it.autonomia_atual;
      let stEstoque = '<span style="color:var(--cinza-texto); font-size:12px;">—</span>';
      if (aut !== null && aut !== undefined) {
        stEstoque = Number(aut) < 2
          ? '<span class="etiqueta-status cancelado">Aguardar</span>'
          : '<span class="etiqueta-status finalizado">Chamar</span>';
      }
      const enviado = it.telegrama_enviado === 'Sim';
      const bloqueado = enviado && !ehAdmin;
      const dis = bloqueado ? 'disabled' : '';
      let detalhes = '';
      if (enviado && it.telegrama_enviado_por) {
        detalhes = `
            <div style="margin-top:4px;">
              <a href="#" class="req-det" style="font-size:11px;">Exibir detalhes</a>
              <div class="req-det-info" hidden style="font-size:11px; color:var(--cinza-texto); margin-top:2px;">
                Enviado por <strong>${it.telegrama_enviado_por}</strong>${it.telegrama_enviado_em ? ' em ' + fmtDataHora(it.telegrama_enviado_em) : ''}
              </div>
            </div>`;
      }
      return `
        <tr data-id="${it.id}" data-justificativa="${(it.justificativa || '').replace(/"/g, '&quot;')}">
          <td class="col-codigo">
            <a href="#" class="req-abrir-doc" data-req="${it.requisicao_id}"><strong>${it.codigo_controle || ('#' + it.requisicao_id)}</strong></a>
            ${(ehAdmin || !reqComTelegrama.has(it.requisicao_id)) ? `<br><button type="button" class="req-reabrir" data-req="${it.requisicao_id}" title="Reabrir a requisição para incluir itens (status volta para Solicitado)" style="margin-top:4px; padding:2px 8px; font-size:11px;">↺ Reabrir</button>` : ''}
          </td>
          <td>${it.autor || '—'}</td>
          <td class="col-codigo">${it.sei || '—'}</td>
          <td class="col-codigo"><a href="#" class="req-item-detalhe" data-codigo="${(it.codigo_item || '').replace(/"/g, '&quot;')}" data-protocolo="${(it.protocolo || '').replace(/"/g, '&quot;')}" data-desc="${(it.descricao_item || '').replace(/"/g, '&quot;')}">${it.codigo_item || '—'}</a></td>
          <td><a href="#" class="req-item-detalhe" data-codigo="${(it.codigo_item || '').replace(/"/g, '&quot;')}" data-protocolo="${(it.protocolo || '').replace(/"/g, '&quot;')}" data-desc="${(it.descricao_item || '').replace(/"/g, '&quot;')}">${it.descricao_item || '—'}</a></td>
          <td class="col-codigo">${it.siafisico || '—'}</td>
          <td><input type="number" min="0" step="1" class="req-at-qtde" value="${it.quantidade != null ? String(it.quantidade).replace(/"/g, '&quot;') : ''}" placeholder="—" style="width:90px;" ${dis}></td>
          <td>${fmtNumero(it.estoque_atual)}</td>
          <td>${aut === null || aut === undefined ? '—' : fmtNumero(aut) + ' m'}</td>
          <td>${stEstoque}</td>
          <td>
            <select class="req-at-status" ${dis}>${opc(['Solicitado', 'Finalizado', 'Cancelado'], it.status_atendimento)}</select>
          </td>
          <td>
            <input type="text" class="req-at-gsnet" value="${fmtGsnet(it.requisicao_gsnet).replace(/"/g, '&quot;')}" placeholder="GSNET" style="width:120px;" ${dis}>
          </td>
          <td>
            <select class="req-at-tel" ${dis}>${opc(['Não', 'Sim'], it.telegrama_enviado)}</select>
            ${detalhes}
          </td>
          <td>
            <input type="date" class="req-at-data" value="${it.data_envio || ''}" ${dis}>
          </td>
        </tr>`;
    }).join('');

    // Abrir documento ao clicar no nº de controle
    corpo.querySelectorAll('.req-abrir-doc').forEach((a) => {
      a.addEventListener('click', (ev) => { ev.preventDefault(); reabrirRequisicao(a.dataset.req); });
    });
    // "Ver itens" das linhas coletivas: lista itens + código SCODES solicitados.
    corpo.querySelectorAll('.req-ver-itens').forEach((b) => {
      b.addEventListener('click', () => abrirItensColetiva(b.dataset.req));
    });
    // "↺ Reabrir" (individual): pergunta se a reabertura é Individual (tela Por
    // paciente, só os itens do mesmo paciente) ou Coletiva (tela Por Item, para
    // incluir outros pacientes/medicamentos). Ao salvar, status volta a
    // "Solicitado".
    corpo.querySelectorAll('.req-reabrir').forEach((b) => {
      b.addEventListener('click', () => escolherReabertura(b.dataset.req));
    });
    // "↺ Reabrir" (coletiva): reabre na tela "Por Item", já com itens e
    // pacientes atuais marcados — para incluir mais pacientes/medicamentos.
    corpo.querySelectorAll('.req-reabrir-col').forEach((b) => {
      b.addEventListener('click', () => {
        if (!confirm('Reabrir esta solicitação coletiva para inclusão? O status voltará para "Solicitado" (o telegrama/data de envio serão zerados).')) return;
        reabrirColetiva(b.dataset.req);
      });
    });
    // Exibir/ocultar detalhes de quem enviou o telegrama
    corpo.querySelectorAll('.req-det').forEach((a) => {
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        const info = a.parentElement.querySelector('.req-det-info');
        const mostrar = info.hidden;
        info.hidden = !mostrar;
        a.textContent = mostrar ? 'Ocultar detalhes' : 'Exibir detalhes';
      });
    });
    // Salvar ao alterar qualquer controle da linha (individual ou coletiva)
    corpo.querySelectorAll('tr[data-id], tr[data-coletiva]').forEach((tr) => {
      const selTel = tr.querySelector('.req-at-tel');
      const selStatus = tr.querySelector('.req-at-status');
      const inpData = tr.querySelector('.req-at-data');
      // Ao marcar "Sim": finaliza e preenche a data de hoje automaticamente
      selTel.addEventListener('change', () => {
        if (selTel.value === 'Sim') {
          selStatus.value = 'Finalizado';
          if (!inpData.value) inpData.value = new Date().toISOString().slice(0, 10);
        }
      });
      tr.querySelectorAll('.req-at-status, .req-at-tel, .req-at-data, .req-at-gsnet, .req-at-qtde').forEach((ctrl) => {
        ctrl.addEventListener('change', () => salvarAtendimentoItem(tr));
      });
    });
    // Abrir modal de detalhes (estoque/demanda) ao clicar no código/descrição
    corpo.querySelectorAll('.req-item-detalhe').forEach((a) => {
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        abrirDetalheItemReq(a.dataset.codigo, a.dataset.protocolo, a.dataset.desc);
      });
    });
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoRelatorioReq').textContent =
    `Página ${dados.page} de ${totalPaginas} · ${fmtNumero(dados.total)} item(ns)`;
  document.getElementById('reqAnterior').disabled = dados.page <= 1;
  document.getElementById('reqProximo').disabled = dados.page >= totalPaginas;
}

async function salvarAtendimentoItem(tr) {
  const qtdeEl = tr.querySelector('.req-at-qtde');
  const status = tr.querySelector('.req-at-status').value;
  const corpo = {
    status_atendimento: status,
    telegrama_enviado: tr.querySelector('.req-at-tel').value,
    data_envio: tr.querySelector('.req-at-data').value || null,
    requisicao_gsnet: tr.querySelector('.req-at-gsnet').value.trim() || null,
    quantidade: qtdeEl ? (qtdeEl.value.trim() || null) : undefined,
  };
  // Status "Cancelado" exige justificativa. Pede só quando ainda não há uma
  // (evita reperguntar ao editar outros campos de uma linha já cancelada).
  if (status === 'Cancelado') {
    let just = tr.dataset.justificativa || '';
    if (!just.trim()) {
      const nova = prompt('Justificativa do cancelamento:', '');
      if (nova === null || !nova.trim()) { alert('Cancelamento requer justificativa.'); carregarTabelaRelReq(); return; }
      just = nova.trim();
    }
    tr.dataset.justificativa = just;
    corpo.justificativa = just;
  } else {
    tr.dataset.justificativa = '';
    corpo.justificativa = null;
  }
  const eraSim = tr.querySelector('.req-det') !== null; // já estava enviado
  // Coletiva: status é do GRUPO (endpoint próprio); individual: por item.
  const url = tr.dataset.coletiva === '1'
    ? `/autores/requisicoes/${tr.dataset.req}/status-coletiva`
    : `/autores/requisicoes/item/${tr.dataset.id}`;
  try {
    await api(url, { method: 'PUT', body: JSON.stringify(corpo) });
    tr.style.background = '#eaf5ee';
    // Se virou "Sim" (ou um admin desfez), recarrega para aplicar trava e detalhes
    if (corpo.telegrama_enviado === 'Sim' || eraSim) {
      setTimeout(() => carregarTabelaRelReq(), 400);
    } else {
      setTimeout(() => { tr.style.background = ''; }, 600);
    }
  } catch (e) {
    alert('Erro ao salvar: ' + e.message);
    carregarTabelaRelReq(); // desfaz a alteração visual recarregando do servidor
  }
}

// Modal de detalhes do item no Relatório de Primeiro Atendimento:
// demanda, consumo, estoque e autonomia (foto mais recente, escopo Tenente Pena).
const modalDetalheItemReq = document.getElementById('modalDetalheItemReq');
document.getElementById('botaoFecharDetalheItemReq').addEventListener('click', () => { modalDetalheItemReq.hidden = true; });
modalDetalheItemReq.addEventListener('click', (ev) => { if (ev.target === modalDetalheItemReq) modalDetalheItemReq.hidden = true; });

async function abrirDetalheItemReq(codigo, protocolo, desc) {
  const corpo = document.getElementById('corpoDetalheItemReq');
  document.getElementById('tituloDetalheItemReq').textContent = desc || 'Detalhes do item';
  document.getElementById('subDetalheItemReq').textContent = 'Código: ' + (codigo || '—');
  corpo.innerHTML = '<p class="texto-secundario">Carregando…</p>';
  modalDetalheItemReq.hidden = false;

  try {
    const params = new URLSearchParams({ codigo: codigo || '' });
    if (protocolo) params.set('protocolo', protocolo);
    const d = await api(`/autores/comparacao/item-detalhe?${params.toString()}`);
    const e = d.estoque || {};
    const dem = d.demanda || {};
    const dataEstoque = d.dataEstoque ? formatarData(d.dataEstoque) : null;

    const linha = (rotulo, valor) =>
      `<div style="display:flex; justify-content:space-between; gap:12px; padding:7px 0; border-bottom:1px solid var(--borda-suave, #eee);">
         <span class="texto-secundario">${rotulo}</span><strong>${valor}</strong></div>`;

    corpo.innerHTML =
      linha('Demanda', fmtNumero(e.demandas)) +
      linha('Consumo mensal', fmtNumero(e.consumoMensalTotal)) +
      linha('Estoque atual', fmtNumero(e.estoque)) +
      linha('Autonomia', (e.autonomia === null || e.autonomia === undefined) ? '—' : fmtNumero(e.autonomia) + ' meses') +
      (dem.tipo_demanda ? linha('Tipo de demanda', dem.tipo_demanda) : '') +
      (dataEstoque ? `<p class="texto-secundario" style="margin-top:10px; font-size:12px;">Estoque referente a ${dataEstoque}.</p>`
                   : '<p class="texto-secundario" style="margin-top:10px; font-size:12px;">Sem foto de estoque para este item.</p>');
  } catch (err) {
    corpo.innerHTML = `<p style="color:var(--vermelho, #b3261e);">Não foi possível carregar: ${err.message}</p>`;
  }
}

// -------------------- Evolução de Estoque (série histórica) --------------------
let serieEvolucaoAtual = null;
let debounceEvolucao;

function iniciarEvolucao() {
  // mostra o estado inicial quando entra na aba
  if (!serieEvolucaoAtual) {
    document.getElementById('conteudoEvolucao').hidden = true;
    document.getElementById('vazioEvolucao').hidden = false;
  }
}

document.getElementById('buscaEvolucao').addEventListener('input', () => {
  clearTimeout(debounceEvolucao);
  debounceEvolucao = setTimeout(buscarEvolucao, 350);
});

async function buscarEvolucao() {
  const q = document.getElementById('buscaEvolucao').value.trim();
  const cont = document.getElementById('resultadosEvolucao');
  if (q.length < 2) { cont.innerHTML = ''; return; }

  const { itens } = await api(`/estoque/evolucao/buscar?q=${encodeURIComponent(q)}&escopoUnidade=udtp`);
  if (!itens.length) {
    cont.innerHTML = '<div class="estado-vazio">Nenhum medicamento encontrado.</div>';
    return;
  }
  cont.innerHTML = itens.map((i) => `
    <div class="cartao-busca-evolucao" data-codigo="${encodeURIComponent(i.codigo_item)}" style="cursor:pointer; padding:9px 12px; border:1px solid var(--linha); border-radius:6px; margin-bottom:6px; background:var(--papel-elevado);">
      <div>${i.descricao || '—'}</div>
      <div class="col-codigo">${i.codigo_item}</div>
    </div>
  `).join('');
  cont.querySelectorAll('.cartao-busca-evolucao').forEach((c) => {
    c.addEventListener('click', () => carregarEvolucao(c.dataset.codigo));
  });
}

async function carregarEvolucao(codigoEncoded) {
  const dados = await api(`/estoque/evolucao?codigo=${codigoEncoded}&escopoUnidade=udtp`);
  serieEvolucaoAtual = dados;

  document.getElementById('vazioEvolucao').hidden = true;
  document.getElementById('conteudoEvolucao').hidden = false;
  document.getElementById('resultadosEvolucao').innerHTML = '';
  document.getElementById('buscaEvolucao').value = '';

  document.getElementById('tituloEvolucao').textContent = dados.descricao;
  document.getElementById('codigoEvolucao').textContent = dados.codigo;

  // Tabela
  const reais = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  document.getElementById('corpoTabelaEvolucao').innerHTML = dados.serie.map((s) => `
    <tr>
      <td class="col-data">${formatarData(s.data_referencia)}</td>
      <td class="col-data">${s.referencia_historica ? formatarData(s.referencia_historica) : '<span style="color:var(--cinza-texto);">atual</span>'}</td>
      <td>${fmtNumero(s.estoque)}</td>
      <td>${fmtNumero(s.autonomia)}</td>
      <td>${fmtNumero(s.demandas)}</td>
      <td>${fmtNumero(Math.round(Number(s.consumo_mensal_total) || 0))}</td>
      <td>${reais(s.valor)}</td>
    </tr>
  `).join('');

  desenharGraficoEvolucao();
}

document.getElementById('metricaEvolucao').addEventListener('change', desenharGraficoEvolucao);

function desenharGraficoEvolucao() {
  if (!serieEvolucaoAtual) return;
  const metrica = document.getElementById('metricaEvolucao').value;
  const serie = serieEvolucaoAtual.serie;
  const cont = document.getElementById('graficoEvolucao');

  const pontos = serie.map((s) => ({
    label: formatarData(s.data_referencia),
    valor: Number(s[metrica] || 0),
  }));

  if (pontos.length === 0) {
    cont.innerHTML = '<div class="estado-vazio">Sem dados na série histórica ainda.</div>';
    return;
  }

  const ehReais = metrica === 'valor';
  const fmt = (v) => ehReais
    ? 'R$ ' + Math.round(v).toLocaleString('pt-BR')
    : v.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

  // dimensões
  const L = 760, A = 260, mEsq = 64, mDir = 20, mTopo = 20, mBaixo = 46;
  const larguraUtil = L - mEsq - mDir;
  const alturaUtil = A - mTopo - mBaixo;
  const maxV = Math.max(...pontos.map((p) => p.valor), 1);
  const minV = Math.min(...pontos.map((p) => p.valor), 0);
  const faixa = (maxV - minV) || 1;

  const x = (i) => mEsq + (pontos.length === 1 ? larguraUtil / 2 : (i / (pontos.length - 1)) * larguraUtil);
  const y = (v) => mTopo + alturaUtil - ((v - minV) / faixa) * alturaUtil;

  // linhas de grade horizontais (4 níveis) + rótulos do eixo Y
  let grade = '';
  for (let g = 0; g <= 4; g++) {
    const v = minV + (faixa * g) / 4;
    const yy = y(v);
    grade += `<line class="g-grade" x1="${mEsq}" y1="${yy}" x2="${L - mDir}" y2="${yy}"/>`;
    grade += `<text class="g-eixo" x="${mEsq - 8}" y="${yy + 4}" text-anchor="end">${fmt(v)}</text>`;
  }

  const linhaPontos = pontos.map((p, i) => `${x(i)},${y(p.valor)}`).join(' ');
  const bolinhas = pontos.map((p, i) => `
    <circle class="g-ponto" cx="${x(i)}" cy="${y(p.valor)}" r="4"><title>${p.label}: ${fmt(p.valor)}</title></circle>
    <text class="g-valor" x="${x(i)}" y="${y(p.valor) - 9}" text-anchor="middle">${fmt(p.valor)}</text>
    <text class="g-eixo" x="${x(i)}" y="${A - mBaixo + 18}" text-anchor="middle">${p.label}</text>
  `).join('');

  cont.innerHTML = `
    <svg class="grafico-svg" viewBox="0 0 ${L} ${A}" style="min-width:${pontos.length > 6 ? L : 0}px;">
      ${grade}
      <line class="g-eixo-linha" x1="${mEsq}" y1="${mTopo}" x2="${mEsq}" y2="${A - mBaixo}"/>
      <line class="g-eixo-linha" x1="${mEsq}" y1="${A - mBaixo}" x2="${L - mDir}" y2="${A - mBaixo}"/>
      ${pontos.length > 1 ? `<polyline class="g-linha" points="${linhaPontos}"/>` : ''}
      ${bolinhas}
    </svg>
    ${pontos.length === 1 ? '<div style="text-align:center; color:var(--cinza-texto); font-size:12px; margin-top:6px;">Só há 1 ponto na série por enquanto. O gráfico ganha forma conforme os snapshots de dia 01 e 15 forem sendo guardados.</div>' : ''}
  `;
}

// -------------------- Importador de estoque --------------------
let arquivoEstoqueSelecionado = null;
document.getElementById('botaoPreviaEstoque').addEventListener('click', async () => {
  const input = document.getElementById('arquivoEstoque');
  if (!input.files[0]) { alert('Selecione o arquivo de estoque primeiro.'); return; }
  arquivoEstoqueSelecionado = input.files[0];

  const el = document.getElementById('resultadoImportacaoEstoque');
  el.innerHTML = '<div class="estado-vazio">Analisando planilha…</div>';

  const fd = new FormData();
  fd.append('arquivo', arquivoEstoqueSelecionado);

  try {
    const resp = await fetch('/api/estoque/importar/previa', { method: 'POST', body: fd });
    const dados = await resp.json();
    if (!resp.ok) throw new Error(dados.erro);

    if (dados.dataReferenciaDetectada) {
      document.getElementById('dataReferenciaEstoque').value = dados.dataReferenciaDetectada;
    }

    let aviso = '';
    if (dados.jaExisteImportacaoNestaData) {
      aviso = '<div class="lista-codigos">Já existe uma importação para esta data — confirmar irá substituí-la.</div>';
    }
    el.innerHTML = `<div class="bloco-resultado-importacao">
      <div class="linha"><span>Aba</span><strong>${dados.nomeAba}</strong></div>
      <div class="linha"><span>Data detectada</span><strong>${dados.dataReferenciaDetectada ? formatarData(dados.dataReferenciaDetectada) : 'não detectada'}</strong></div>
      <div class="linha"><span>Linhas a importar</span><strong>${dados.totalLinhas}</strong></div>
      ${aviso}
    </div>`;
    document.getElementById('botaoConfirmarEstoque').disabled = false;
  } catch (e) {
    el.innerHTML = `<div class="estado-vazio">${e.message}</div>`;
    document.getElementById('botaoConfirmarEstoque').disabled = true;
  }
});

document.getElementById('botaoConfirmarEstoque').addEventListener('click', async () => {
  if (!arquivoEstoqueSelecionado) return;
  const dataRef = document.getElementById('dataReferenciaEstoque').value;
  if (!confirm('Confirmar a importação do estoque? Os alertas de estoque serão recalculados.')) return;

  const el = document.getElementById('resultadoImportacaoEstoque');
  el.innerHTML = '<div class="estado-vazio">Importando…</div>';

  const fd = new FormData();
  fd.append('arquivo', arquivoEstoqueSelecionado);
  if (dataRef) fd.append('data_referencia', dataRef);

  try {
    const resp = await fetch('/api/estoque/importar/confirmar', { method: 'POST', body: fd });
    const dados = await resp.json();
    if (!resp.ok) throw new Error(dados.erro);

    const linhaHistorico = dados.arquivadoComoHistorico
      ? `<div class="linha"><span>📌 Arquivado como histórico</span><strong>Referência ${formatarData(dados.arquivadoComoHistorico)}</strong></div>`
      : `<div class="linha"><span>Arquivamento histórico</span><strong style="color:var(--cinza-texto);">não é dia 01/15 — só atualiza o atual</strong></div>`;
    el.innerHTML = `<div class="bloco-resultado-importacao">
      <div class="linha"><span>Data de referência (coleta)</span><strong>${formatarData(dados.dataReferencia)}</strong></div>
      <div class="linha"><span>Itens importados</span><strong>${dados.totalItens}</strong></div>
      ${linhaHistorico}
      <div class="linha"><span>Alertas de ruptura</span><strong>${dados.alertasRuptura}</strong></div>
      <div class="linha"><span>Alertas de estoque baixo</span><strong>${dados.alertasEstoqueBaixo}</strong></div>
      <div class="linha"><span>Compra em aberto + demanda zero</span><strong>${dados.alertasCompraDemandaZero}</strong></div>
    </div>`;
    document.getElementById('botaoConfirmarEstoque').disabled = true;
    estado.estoque.data = dados.dataReferencia;
    estadoEstoqueGeral.data = dados.dataReferencia;
    atualizarBadgeAlertas();
  } catch (e) {
    el.innerHTML = `<div class="estado-vazio">${e.message}</div>`;
  }
});

// -------------------- Configuração do limiar de autonomia --------------------
async function carregarConfigLimiar() {
  try {
    const { config } = await api('/config');
    document.getElementById('campoLimiarAutonomia').value = config.autonomia_minima_meses || '2';
  } catch (e) { /* silencioso */ }
}

document.getElementById('botaoSalvarLimiar').addEventListener('click', async () => {
  const valor = document.getElementById('campoLimiarAutonomia').value;
  const res = document.getElementById('resultadoLimiar');
  try {
    await api('/config/autonomia_minima_meses', { method: 'PUT', body: JSON.stringify({ valor }) });
    res.textContent = 'Configuração salva. O novo limite vale a partir da próxima importação de estoque.';
  } catch (e) {
    res.style.color = 'var(--vermelho)';
    res.textContent = e.message;
  }
});

// -------------------- Alertas --------------------
document.getElementById('filtroTipoAlerta').addEventListener('change', carregarAlertas);
document.getElementById('filtroCategoriaAlerta').addEventListener('change', carregarAlertas);
document.getElementById('filtroAlertasResolvidos').addEventListener('change', carregarAlertas);

const ROTULO_TIPO_ALERTA = {
  estoque_ruptura: 'Ruptura',
  estoque_baixo: 'Estoque baixo',
  compra_aberta_demanda_zero: 'Revisar compra',
  item_removido_com_historico: 'Item removido',
  siafisico_duplicado: 'Siafísico duplicado',
};

async function carregarAlertas() {
  const container = document.getElementById('listaAlertas');
  const tipoFiltro = document.getElementById('filtroTipoAlerta').value;
  const selCategoria = document.getElementById('filtroCategoriaAlerta');
  // Se veio do gráfico do Painel, usa a categoria escolhida lá (e limpa a marca).
  const categoriaFiltro = categoriaAlertaInicial || selCategoria.value;
  categoriaAlertaInicial = '';
  const mostrarResolvidos = document.getElementById('filtroAlertasResolvidos').checked;

  const params = new URLSearchParams();
  if (!mostrarResolvidos) params.set('resolvido', 'false');

  const { alertas } = await api(`/alertas?${params.toString()}`);

  // Popula o filtro de categoria com as categorias presentes nos alertas,
  // preservando a seleção atual.
  const categorias = [...new Set(alertas.map((a) => a.categoria).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'pt'));
  selCategoria.innerHTML = '<option value="">Todas as categorias</option>' +
    categorias.map((c) => `<option value="${escAttr(c)}" ${c === categoriaFiltro ? 'selected' : ''}>${c}</option>`).join('');
  selCategoria.value = categorias.includes(categoriaFiltro) ? categoriaFiltro : '';

  // Gráfico por categoria (visão geral, respeita só o filtro de tipo).
  const baseGrafico = tipoFiltro ? alertas.filter((a) => a.tipo === tipoFiltro) : alertas;
  renderGraficoAlertasCategoria(baseGrafico, categoriaFiltro);

  let filtrados = tipoFiltro ? alertas.filter((a) => a.tipo === tipoFiltro) : alertas;
  // O resumo de siafísico duplicado não tem categoria própria (agrega vários);
  // continua aparecendo mesmo com filtro de categoria — o relatório é que filtra.
  if (categoriaFiltro) filtrados = filtrados.filter((a) => a.categoria === categoriaFiltro || a.tipo === 'siafisico_duplicado');

  if (filtrados.length === 0) {
    container.innerHTML = '<div class="estado-vazio">Nenhum alerta com estes filtros.</div>';
    return;
  }

  // Resumo por tipo no topo
  const contagem = {};
  for (const a of alertas) contagem[a.tipo] = (contagem[a.tipo] || 0) + 1;
  const resumoHtml = Object.entries(contagem).map(([tipo, qtd]) =>
    `<span class="etiqueta-status andamento" style="cursor:default;">${ROTULO_TIPO_ALERTA[tipo] || tipo}: ${qtd}</span>`
  ).join(' ');

  container.innerHTML = `<div style="margin-bottom:14px; display:flex; gap:6px; flex-wrap:wrap;">${resumoHtml}</div>` +
    filtrados.slice(0, 300).map((a) => `
    <div class="cartao-alerta ${a.resolvido ? 'resolvido' : ''}">
      <div>
        <p>${a.mensagem}</p>
        <div class="data-alerta">${formatarData(a.criado_em.slice(0,10))} às ${a.criado_em.slice(11,16)}${a.resolvido ? ` · resolvido por ${a.resolvido_por}` : ''}</div>
      </div>
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
      ${a.tipo === 'siafisico_duplicado' ? `<button class="botao-secundario" data-siaf="${escAttr(a.codigo_item || '')}">📋 Ver relatório</button>` : ''}
      ${!a.resolvido ? `<button class="botao-secundario" data-id="${a.id}">Marcar como resolvido</button>` : ''}
      </div>
    </div>
  `).join('') +
  (filtrados.length > 300 ? `<div class="estado-vazio">Mostrando os primeiros 300 de ${filtrados.length} alertas. Use os filtros para refinar.</div>` : '');

  container.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/alertas/${btn.dataset.id}/resolver`, { method: 'PUT' });
        carregarAlertas();
        atualizarBadgeAlertas();
      } catch (e) {
        alert(e.message);
      }
    });
  });
  container.querySelectorAll('button[data-siaf]').forEach((btn) => {
    btn.addEventListener('click', () => abrirRelatorioSiafisico(btn.dataset.siaf, document.getElementById('filtroCategoriaAlerta').value));
  });
}

// Modal do alerta "Siafísico duplicado": itens do Estoque TP (demanda ativa)
// que compartilham o mesmo siafísico — modelo do print.
async function abrirRelatorioSiafisico(siaf, categoria) {
  const modal = document.getElementById('modalSiafDup');
  const corpo = document.getElementById('corpoTabelaSiafDup');
  corpo.innerHTML = '<tr><td colspan="8">Carregando…</td></tr>';
  modal.hidden = false;
  try {
    const params = new URLSearchParams();
    if (siaf) params.set('siafisico', siaf);
    if (categoria) params.set('categoria', categoria);
    const d = await api(`/alertas/siafisico-duplicado?${params.toString()}`);
    const sufCat = categoria ? ` · categoria: ${categoria}` : '';
    document.getElementById('subSiafDup').textContent = siaf
      ? `Siafísico ${siaf} — itens com demanda ativa no Estoque Tenente Pena${sufCat}`
      : `${d.siafisicos} siafísico(s) duplicado(s) · ${d.total} itens (demanda ativa) — Estoque Tenente Pena${sufCat}`;
    const cel = (v) => escHtml(v == null || v === '' ? '—' : v);
    let siafAnterior = null;
    corpo.innerHTML = (d.itens || []).map((r) => {
      // Linha divisória quando começa um novo siafísico (só no relatório completo).
      const novoGrupo = !siaf && r.siafisico !== siafAnterior;
      siafAnterior = r.siafisico;
      return `
      <tr${novoGrupo ? ' style="border-top:2px solid var(--linha-forte);"' : ''}>
        <td class="col-codigo">${cel(r.codigo_item)}</td>
        <td class="col-codigo">${cel(r.siafisico)}</td>
        <td class="col-desc" title="${escAttr(r.descricao || '')}">${cel(r.descricao)}</td>
        <td class="col-unidade">${cel(r.unidade)}</td>
        <td class="col-num">${cel(r.demandas)}</td>
        <td class="col-num">${cel(r.consumo_mensal_total)}</td>
        <td class="col-num">${cel(r.estoque)}</td>
        <td class="col-num">${cel(r.autonomia)}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="8" class="texto-secundario">Nenhum item (o alerta pode estar desatualizado — reimporte o estoque).</td></tr>';
  } catch (e) {
    corpo.innerHTML = `<tr><td colspan="8" style="color:var(--vermelho);">${escHtml(e.message)}</td></tr>`;
  }
}
document.getElementById('botaoFecharSiafDup').addEventListener('click', () => {
  document.getElementById('modalSiafDup').hidden = true;
});

// Gráfico de barras por categoria (HTML/CSS, sem biblioteca externa). Cada barra
// é clicável: aplica/limpa o filtro de categoria. Cores fixas por categoria.
const CORES_CATEGORIA_ALERTA = {
  'Medicamentos': '#2a78d6',
  'Materiais': '#eb6834',
  'Nutrição': '#1baf7a',
  'Outros Itens': '#eda100',
};
const PALETA_CATEGORIA_EXTRA = ['#e87ba4', '#4a3aa7', '#639922', '#888780'];

function renderGraficoAlertasCategoria(alertas, categoriaSelecionada) {
  const box = document.getElementById('graficoAlertasCategoria');
  if (!box) return;

  const contagem = {};
  for (const a of alertas) {
    const c = a.categoria || 'Sem categoria';
    contagem[c] = (contagem[c] || 0) + 1;
  }
  const linhas = Object.entries(contagem).sort((x, y) => y[1] - x[1]);
  if (linhas.length === 0) { box.innerHTML = ''; return; }

  const total = alertas.length;
  const maxV = Math.max(...linhas.map(([, v]) => v));
  let extra = 0;
  const cor = (cat) => CORES_CATEGORIA_ALERTA[cat] || PALETA_CATEGORIA_EXTRA[extra++ % PALETA_CATEGORIA_EXTRA.length];

  box.innerHTML = `<p class="titulo-graf">Alertas por categoria — total ${fmtNumero(total)} (clique para filtrar)</p>` +
    linhas.map(([cat, v]) => {
      const larg = Math.round((v / maxV) * 100);
      const pct = Math.round((v / total) * 100);
      const ativa = cat === categoriaSelecionada ? ' ativa' : '';
      return `<div class="linha-cat${ativa}" data-cat="${escAttr(cat)}" role="button" tabindex="0">
        <span class="rot-cat" title="${escAttr(cat)}">${cat}</span>
        <span class="trilho-cat"><span class="barra-cat" style="width:${larg}%; background:${cor(cat)};"></span></span>
        <span class="val-cat">${fmtNumero(v)} · ${pct}%</span>
      </div>`;
    }).join('');

  box.querySelectorAll('.linha-cat').forEach((el) => {
    const aplicar = () => {
      const cat = el.dataset.cat;
      const sel = document.getElementById('filtroCategoriaAlerta');
      // Clicar na categoria já ativa limpa o filtro (alterna).
      sel.value = (sel.value === cat) ? '' : cat;
      carregarAlertas();
    };
    el.addEventListener('click', aplicar);
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); aplicar(); } });
  });
}

// -------------------- Usuários --------------------
// Mostra "Online" se o usuário teve atividade nos últimos 5 minutos;
// caso contrário, "visto há X" (min/horas/dias) ou "nunca acessou".
function textoAtividade(ultimoAcesso) {
  if (!ultimoAcesso) return '<span style="color:#999;">nunca acessou</span>';
  const t = new Date(ultimoAcesso).getTime();
  if (isNaN(t)) return '<span style="color:#999;">—</span>';
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 5) return '<span style="color:#1a7f37;font-weight:600;">🟢 Online</span>';
  let quando;
  if (min < 60) quando = `há ${min} min`;
  else if (min < 1440) quando = `há ${Math.floor(min / 60)} h`;
  else quando = `há ${Math.floor(min / 1440)} d`;
  return `<span style="color:#777;">🔘 visto ${quando}</span>`;
}

async function carregarUsuarios() {
  const { usuarios } = await api('/usuarios');
  const corpo = document.getElementById('corpoTabelaUsuarios');
  corpo.innerHTML = usuarios.map((u) => `
    <tr>
      <td>${u.nome}</td>
      <td class="col-codigo">${u.email}</td>
      <td><span class="etiqueta-status ${u.perfil === 'admin' ? 'finalizado' : 'andamento'}">${u.perfil === 'admin' ? 'Admin' : 'Consulta'}</span></td>
      <td><span class="etiqueta-status ${u.ativo ? 'finalizado' : 'cancelado'}">${u.ativo ? 'Ativo' : 'Inativo'}</span>${u.pendente ? ' <span class="etiqueta-status andamento" title="Convite enviado; ainda não criou a senha">Convite pendente</span>' : ''}</td>
      <td>${textoAtividade(u.ultimo_acesso)}</td>
      <td>
        <button class="botao-editar" data-id="${u.id}">Editar</button>
        ${u.pendente ? `<button class="botao-secundario" data-copialink="${u.id}" style="margin-left:6px;">Copiar link</button>` : ''}
        ${u.pendente ? `<button class="botao-secundario" data-reenviar="${u.id}" style="margin-left:6px;">Reenviar e-mail</button>` : ''}
        ${u.perfil === 'admin'
          ? '<span class="texto-secundario" style="margin-left:6px;">(pode tudo)</span>'
          : `<button class="botao-secundario" data-perm="${u.id}" data-nome="${u.nome}" style="margin-left:6px;">Permissões</button>`}
      </td>
    </tr>
  `).join('');

  corpo.querySelectorAll('.botao-editar').forEach((btn) => {
    btn.addEventListener('click', () => abrirModalUsuario(usuarios.find((u) => u.id === Number(btn.dataset.id))));
  });
  corpo.querySelectorAll('[data-copialink]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const u = usuarios.find((x) => x.id === Number(btn.dataset.copialink));
      if (!confirm('Gerar um link novo de acesso para ' + u.email + '? O link anterior deixa de valer.')) return;
      btn.disabled = true; btn.textContent = 'Gerando…';
      try {
        const r = await api(`/usuarios/${u.id}/reenviar-convite`, { method: 'POST', body: JSON.stringify({ apenasLink: true }) });
        mostrarLinkConvite(r && r.link ? r.link : '', u.email, u.nome);
        carregarUsuarios();
      } catch (e) { alert(e.message); btn.disabled = false; btn.textContent = 'Copiar link'; }
    });
  });
  corpo.querySelectorAll('[data-reenviar]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const u = usuarios.find((x) => x.id === Number(btn.dataset.reenviar));
      if (!confirm('Reenviar o convite por e-mail para ' + u.email + '? Isso gera um link novo (o anterior deixa de valer).')) return;
      btn.disabled = true; btn.textContent = 'Enviando…';
      try {
        const r = await api(`/usuarios/${u.id}/reenviar-convite`, { method: 'POST' });
        if (r && r.emailEnviado) alert('Convite reenviado para ' + u.email + '. O link expira em 48 horas.');
        else mostrarLinkConvite(r && r.link ? r.link : '', u.email, u.nome);
        carregarUsuarios();
      } catch (e) { alert(e.message); btn.disabled = false; btn.textContent = 'Reenviar convite'; }
    });
  });
  corpo.querySelectorAll('[data-perm]').forEach((btn) => {
    btn.addEventListener('click', () => abrirModalPermissoes(Number(btn.dataset.perm), btn.dataset.nome));
  });
}

// -------------------- Permissões por módulo --------------------
const modalPermissoes = document.getElementById('modalPermissoes');
let idUsuarioPermissoes = null;

async function abrirModalPermissoes(usuarioId, nome) {
  idUsuarioPermissoes = usuarioId;
  document.getElementById('tituloModalPermissoes').textContent = 'Permissões de ' + nome;
  const corpo = document.getElementById('corpoPermissoes');
  corpo.innerHTML = '<tr><td colspan="7">Carregando…</td></tr>';
  modalPermissoes.hidden = false;

  let modulos, acoes, acoesRotulo, permissoes, habilitado, caixasReq, todasCaixas, perfilUsuario;
  try {
    const [reg, perm] = await Promise.all([
      api('/usuarios/modulos'),
      api(`/usuarios/${usuarioId}/permissoes`),
    ]);
    ({ modulos, acoes, acoesRotulo } = reg);
    ({ permissoes, habilitado, caixasReq, todasCaixas } = perm);
    perfilUsuario = perm.usuario && perm.usuario.perfil;
  } catch (e) {
    corpo.innerHTML = `<tr><td colspan="8" style="color:#c0392b;">Não consegui carregar a grade.<br>${e.message}<br><br>Provável causa: o servidor precisa ser <b>reiniciado</b> (feche e abra o "3 - iniciar-sistema.bat").</td></tr>`;
    return;
  }

  // Cabeçalho: Módulo | Habilitado | (ações)
  document.getElementById('cabecalhoPermissoes').innerHTML =
    '<th style="text-align:left;">Módulo</th>' +
    '<th>Habilitado</th>' +
    acoes.map((a) => `<th>${acoesRotulo[a]}</th>`).join('');

  corpo.innerHTML = modulos.map((m) => {
    const ligado = habilitado && habilitado[m.chave];
    const celulas = acoes.map((a) => {
      if (!m.acoes.includes(a)) return '<td style="color:#bbb;">—</td>';
      const marcado = permissoes[m.chave] && permissoes[m.chave][a] ? 'checked' : '';
      const desab = ligado ? '' : 'disabled';
      return `<td><input type="checkbox" data-modulo="${m.chave}" data-acao="${a}" ${marcado} ${desab}></td>`;
    }).join('');
    return `<tr data-linha="${m.chave}">
      <td style="text-align:left;">${m.rotulo}</td>
      <td><input type="checkbox" class="chk-habilitado" data-hab="${m.chave}" ${ligado ? 'checked' : ''}></td>
      ${celulas}
    </tr>`;
  }).join('');

  // Caixas do Relatório de Primeiro Atendimento (só para não-admin; admin vê tudo).
  const caixaBox = document.getElementById('caixasReqPermissoes');
  const caixaLista = document.getElementById('caixasReqLista');
  if (perfilUsuario === 'admin') {
    caixaBox.hidden = true;
    caixaLista.innerHTML = '';
  } else {
    caixaBox.hidden = false;
    const marcadas = new Set(caixasReq || []);
    caixaLista.innerHTML = (todasCaixas || []).map((c) => {
      const rot = c === 'Todas' ? 'Todas (mostra a aba "Todas" no relatório)' : c;
      return `<label style="display:flex; align-items:center; gap:6px; cursor:pointer;"><input type="checkbox" class="chk-caixa-req" value="${escAttr(c)}" ${marcadas.has(c) ? 'checked' : ''}> ${escHtml(rot)}</label>`;
    }).join('');
  }

  // Barra "Clonar acessos": some para admin (super-usuário) e é preenchida com
  // os demais usuários. Ao clonar, copia módulos/ações/caixas para os checkboxes.
  const clonarBox = document.getElementById('clonarAcessosBox');
  const clonarSel = document.getElementById('clonarDeSelect');
  if (perfilUsuario === 'admin') {
    clonarBox.hidden = true;
  } else {
    clonarBox.hidden = false;
    clonarSel.innerHTML = '<option value="">— escolha um usuário —</option>';
    try {
      const { usuarios } = await api('/usuarios');
      clonarSel.innerHTML += (usuarios || [])
        .filter((u) => u.id !== usuarioId)
        .map((u) => `<option value="${u.id}">${escHtml(u.nome)} — ${escHtml(u.email)}</option>`).join('');
    } catch (_) { /* silencioso: sem clonagem se a lista falhar */ }
  }

  // Quando o interruptor mestre muda, liga/desliga as caixinhas de ação da linha.
  corpo.querySelectorAll('.chk-habilitado').forEach((chk) => {
    chk.addEventListener('change', () => {
      const linha = corpo.querySelector(`tr[data-linha="${chk.dataset.hab}"]`);
      linha.querySelectorAll('input[data-acao]').forEach((c) => {
        c.disabled = !chk.checked;
        if (!chk.checked) c.checked = false;
      });
      linha.style.opacity = chk.checked ? '1' : '0.5';
    });
    // aplica o estado visual inicial
    if (!chk.checked) {
      corpo.querySelector(`tr[data-linha="${chk.dataset.hab}"]`).style.opacity = '0.5';
    }
  });
}

document.getElementById('botaoCancelarPermissoes').addEventListener('click', () => { modalPermissoes.hidden = true; });

// Aplica um conjunto de permissões (módulos/ações + caixas) aos checkboxes do
// modal aberto — usado pela clonagem. Não salva; o admin revisa e clica Salvar.
function aplicarPermissoesNaGrade(permissoes, habilitado, caixasReq) {
  const corpo = document.getElementById('corpoPermissoes');
  corpo.querySelectorAll('.chk-habilitado').forEach((chk) => {
    const mod = chk.dataset.hab;
    const on = !!(habilitado && habilitado[mod]);
    chk.checked = on;
    const linha = corpo.querySelector(`tr[data-linha="${mod}"]`);
    linha.querySelectorAll('input[data-acao]').forEach((c) => {
      const ac = c.dataset.acao;
      c.disabled = !on;
      c.checked = on && !!(permissoes[mod] && permissoes[mod][ac]);
    });
    linha.style.opacity = on ? '1' : '0.5';
  });
  const marcadas = new Set(caixasReq || []);
  modalPermissoes.querySelectorAll('.chk-caixa-req').forEach((c) => { c.checked = marcadas.has(c.value); });
}

document.getElementById('botaoClonarAcessos').addEventListener('click', async () => {
  const sel = document.getElementById('clonarDeSelect');
  const srcId = sel.value;
  if (!srcId) { alert('Escolha o usuário de quem copiar os acessos.'); return; }
  const nomeSrc = sel.options[sel.selectedIndex].text;
  if (!confirm(`Copiar TODOS os acessos de:\n${nomeSrc}\npara este usuário?\n\nAs marcações atuais serão substituídas. Você ainda precisa clicar em "Salvar permissões".`)) return;
  const b = document.getElementById('botaoClonarAcessos');
  b.disabled = true;
  try {
    const perm = await api(`/usuarios/${srcId}/permissoes`);
    aplicarPermissoesNaGrade(perm.permissoes || {}, perm.habilitado || {}, perm.caixasReq || []);
    alert('✓ Acessos copiados. Revise a grade e clique em "Salvar permissões".');
  } catch (e) {
    alert('Não consegui copiar os acessos: ' + e.message);
  } finally {
    b.disabled = false;
  }
});

document.getElementById('botaoSalvarPermissoes').addEventListener('click', async () => {
  const permissoes = {};
  const habilitado = {};
  modalPermissoes.querySelectorAll('input[data-acao]').forEach((c) => {
    const mod = c.dataset.modulo;
    permissoes[mod] = permissoes[mod] || {};
    permissoes[mod][c.dataset.acao] = c.checked;
  });
  modalPermissoes.querySelectorAll('input[data-hab]').forEach((c) => {
    habilitado[c.dataset.hab] = c.checked;
  });
  const caixasReq = [...modalPermissoes.querySelectorAll('.chk-caixa-req:checked')].map((c) => c.value);
  try {
    await api(`/usuarios/${idUsuarioPermissoes}/permissoes`, {
      method: 'PUT',
      body: JSON.stringify({ permissoes, habilitado, caixasReq }),
    });
    modalPermissoes.hidden = true;
    alert('Permissões salvas! O usuário verá a mudança no próximo login (ou ao recarregar a página dele).');
  } catch (e) {
    alert(e.message);
  }
});

const modalUsuario = document.getElementById('modalUsuario');
const formUsuario = document.getElementById('formUsuario');
let idUsuarioEditando = null;

document.getElementById('botaoNovoUsuario').addEventListener('click', () => abrirModalUsuario(null));
document.getElementById('botaoDerrubarSessoes')?.addEventListener('click', async () => {
  if (!confirm('Derrubar TODAS as sessões ativas, exceto a sua?\n\nTodos os outros usuários (colaboradores e admins) serão desconectados e precisarão fazer login novamente. Use ao subir uma atualização.')) return;
  const b = document.getElementById('botaoDerrubarSessoes');
  b.disabled = true;
  try {
    await api('/usuarios/derrubar-sessoes', { method: 'POST' });
    alert('✓ Sessões derrubadas. Os demais usuários serão levados ao login no próximo clique/ação.');
  } catch (e) {
    alert('Não foi possível derrubar as sessões: ' + e.message);
  } finally {
    b.disabled = false;
  }
});
document.getElementById('botaoCancelarModalUsuario').addEventListener('click', () => { modalUsuario.hidden = true; });

// Mostra/esconde o campo de senha conforme o modo escolhido (novo usuário).
// Na edição, o seletor de modo some e o campo senha reaparece ("deixe em branco").
function atualizarVisibilidadeSenhaModo() {
  const editando = !!idUsuarioEditando;
  const modoWrap = document.getElementById('campoModoAcessoWrap');
  const senhaWrap = document.getElementById('campoSenhaWrap');
  const modo = document.getElementById('campoModoUsuario').value;
  modoWrap.hidden = editando; // seletor de modo só no cadastro novo
  // No cadastro novo: senha aparece só quando modo = "senha". Na edição: sempre aparece.
  senhaWrap.hidden = !editando && modo !== 'senha';
}

function abrirModalUsuario(usuario) {
  idUsuarioEditando = usuario ? usuario.id : null;
  formUsuario.reset();
  document.getElementById('tituloModalUsuario').textContent = usuario ? 'Editar usuário' : 'Novo usuário';
  document.getElementById('rotuloSenhaOpcional').textContent = usuario ? '(deixe em branco para manter)' : '';
  document.getElementById('campoModoUsuario').value = 'link'; // padrão: gerar link para enviar manualmente

  if (usuario) {
    document.getElementById('campoNomeUsuario').value = usuario.nome;
    document.getElementById('campoEmailUsuario').value = usuario.email;
    document.getElementById('campoEmailUsuario').disabled = true;
    document.getElementById('campoPerfilUsuario').value = usuario.perfil;
    document.getElementById('campoAtivoUsuario').value = usuario.ativo ? '1' : '0';
  } else {
    document.getElementById('campoEmailUsuario').disabled = false;
  }

  atualizarVisibilidadeSenhaModo();
  modalUsuario.hidden = false;
}

document.getElementById('campoModoUsuario').addEventListener('change', atualizarVisibilidadeSenhaModo);

const NOME_SISTEMA = 'Elo — Entre Compras, Estoque e Demanda';

// Monta a mensagem de boas-vindas pronta para o admin enviar por e-mail/Teams.
function textoBoasVindasConvite(nome, link) {
  const primeiroNome = (nome || '').trim().split(/\s+/)[0] || '';
  const saudacao = primeiroNome ? `Olá, ${primeiroNome}!` : 'Olá!';
  return `${saudacao}

Seja bem-vindo(a) ao ${NOME_SISTEMA}.

Para acessar o sistema, primeiro você precisa criar a sua senha. É rápido:

1) Abra o link abaixo (válido por 48 horas):
${link}

2) Crie uma senha de sua preferência (mínimo de 6 caracteres) e confirme.

3) Pronto! Depois é só entrar com o seu e-mail e a senha que você criou.

Qualquer dúvida, estou à disposição.`;
}

// Abre o modal com o link + mensagem pronta, para o admin copiar e enviar.
function mostrarLinkConvite(link, email, nome) {
  document.getElementById('avisoCopiadoLink').hidden = true;
  document.getElementById('campoLinkConvite').value = link || '';
  document.getElementById('campoMensagemConvite').value = textoBoasVindasConvite(nome, link || '');
  document.getElementById('subLinkConvite').textContent = email
    ? `Envie o link (ou a mensagem pronta) para ${email} criar a senha. Validade: 48 horas.`
    : 'Copie o link ou a mensagem pronta e envie por e-mail ou Teams. Validade: 48 horas.';
  document.getElementById('modalLinkConvite').hidden = false;
}

// Copia o conteúdo de um campo (funciona em http://IP:3000 via execCommand).
function copiarCampo(id) {
  const campo = document.getElementById(id);
  campo.focus(); campo.select();
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(campo.value);
    else document.execCommand('copy');
  } catch (_) { try { document.execCommand('copy'); } catch (__) { /* nada */ } }
  document.getElementById('avisoCopiadoLink').hidden = false;
}
document.getElementById('botaoCopiarLinkConvite').addEventListener('click', () => copiarCampo('campoLinkConvite'));
document.getElementById('botaoCopiarMensagemConvite').addEventListener('click', () => copiarCampo('campoMensagemConvite'));
document.getElementById('botaoFecharLinkConvite').addEventListener('click', () => {
  document.getElementById('modalLinkConvite').hidden = true;
});

formUsuario.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const nome = document.getElementById('campoNomeUsuario').value.trim();
  const email = document.getElementById('campoEmailUsuario').value.trim();
  const senha = document.getElementById('campoSenhaUsuario').value;
  const perfil = document.getElementById('campoPerfilUsuario').value;
  const ativo = document.getElementById('campoAtivoUsuario').value === '1';

  try {
    if (idUsuarioEditando) {
      const corpo = { nome, perfil, ativo };
      if (senha) corpo.senha = senha;
      await api(`/usuarios/${idUsuarioEditando}`, { method: 'PUT', body: JSON.stringify(corpo) });
      modalUsuario.hidden = true;
      carregarUsuarios();
    } else {
      const modo = document.getElementById('campoModoUsuario').value;
      if (modo === 'senha' && !senha) { alert('Defina uma senha para o novo usuário.'); return; }
      const corpo = modo === 'senha' ? { nome, email, senha, perfil, modo } : { nome, email, perfil, modo };
      const r = await api('/usuarios', { method: 'POST', body: JSON.stringify(corpo) });
      modalUsuario.hidden = true;
      carregarUsuarios();
      if (modo === 'link') {
        // Gera o link e abre o modal para copiar e enviar por e-mail/Teams.
        mostrarLinkConvite(r && r.link ? r.link : '', email, nome);
      } else if (modo === 'convite') {
        if (r && r.emailEnviado) {
          alert('Usuário criado! Um convite foi enviado para ' + email + '. O link para criar a senha expira em 48 horas.');
        } else {
          // E-mail não saiu: mostra o link para o admin copiar manualmente.
          mostrarLinkConvite(r && r.link ? r.link : '', email, nome);
        }
      }
    }
  } catch (e) {
    alert(e.message);
  }
});

// -------------------- Atas de Registro de Preço (SISCOA) --------------------
// Classifica o vencimento (data ISO "AAAA-MM-DD"): 'vencido', 'proximo' (<=90 dias) ou ''.
function classeVencimentoAta(iso) {
  if (!iso) return '';
  const data = new Date(iso);
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const dias = Math.floor((data - hoje) / (1000 * 60 * 60 * 24));
  if (dias < 0) return 'vencido';
  if (dias <= 90) return 'proximo';
  return '';
}

let itensAtasCarregados = new Map(); // cache local dos itens da página atual, para abrir o modal sem nova chamada

let debounceBuscaAtas;
document.getElementById('filtroBuscaAtas').addEventListener('input', () => {
  clearTimeout(debounceBuscaAtas);
  debounceBuscaAtas = setTimeout(() => { estado.atas.pagina = 1; carregarAtas(); }, 350);
});
document.getElementById('filtroJanelaAtas').addEventListener('change', () => {
  estado.atas.pagina = 1; carregarAtas();
});
document.getElementById('botaoLimparFiltrosAtas').addEventListener('click', () => {
  document.getElementById('filtroBuscaAtas').value = '';
  document.getElementById('filtroJanelaAtas').value = '';
  estado.atas.pagina = 1; carregarAtas();
});
document.getElementById('botaoAnteriorAtas').addEventListener('click', () => {
  if (estado.atas.pagina > 1) { estado.atas.pagina--; carregarAtas(); }
});
document.getElementById('botaoProximoAtas').addEventListener('click', () => {
  estado.atas.pagina++; carregarAtas();
});
document.getElementById('botaoBuscarAtasSiscoa').addEventListener('click', async () => {
  const botao = document.getElementById('botaoBuscarAtasSiscoa');
  const textoOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = '⏳ Buscando no SISCOA…';
  try {
    const r = await api('/servicos/atasSiscoa/executar', { method: 'POST' });
    const resumo = r && r.resultado;
    alert(resumo
      ? `Atas atualizadas do SISCOA:\n${fmtNumero(resumo.totalLinhas)} linhas / ${fmtNumero(resumo.totalAtas)} atas (referência ${formatarData(resumo.dataReferencia)}).`
      : (r.mensagem || 'Busca do SISCOA concluída.'));
    estado.atas.pagina = 1;
    await carregarAtas();
  } catch (e) {
    alert('Não consegui buscar do SISCOA: ' + e.message);
  } finally {
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
});

async function carregarAtas() {
  const params = new URLSearchParams({ page: estado.atas.pagina, pageSize: estado.atas.pageSize });
  const q = document.getElementById('filtroBuscaAtas').value.trim();
  if (q) params.set('q', q);
  const janela = document.getElementById('filtroJanelaAtas').value;
  if (janela) params.set('janela', janela);

  const dados = await api(`/atas?${params.toString()}`);
  estado.atas.total = dados.total;

  const subtitulo = document.getElementById('subtituloAtas');
  subtitulo.textContent = dados.dataReferencia
    ? `Extraído automaticamente do SISCOA — dados de ${formatarData(dados.dataReferencia)}`
    : 'Ainda não há Atas importadas.';

  const grade = document.getElementById('grideResumoAtas');
  if (dados.resumo) {
    const r = dados.resumo;
    grade.innerHTML = `
      <div class="cartao-resumo"><div class="numero">${fmtNumero(r.d30)}</div><div class="rotulo">Até 30 dias</div></div>
      <div class="cartao-resumo"><div class="numero">${fmtNumero(r.d60)}</div><div class="rotulo">31 a 60 dias</div></div>
      <div class="cartao-resumo"><div class="numero">${fmtNumero(r.d90)}</div><div class="rotulo">61 a 90 dias</div></div>
      <div class="cartao-resumo"><div class="numero">${fmtNumero(r.mais90)}</div><div class="rotulo">Mais de 90 dias</div></div>
    `;
  } else {
    grade.innerHTML = '';
  }

  const corpo = document.getElementById('corpoTabelaAtas');
  const vazio = document.getElementById('estadoVazioAtas');
  itensAtasCarregados = new Map(dados.itens.map((a) => [String(a.id), a]));
  if (dados.itens.length === 0) {
    corpo.innerHTML = '';
    vazio.hidden = false;
  } else {
    vazio.hidden = true;
    const escapar = (s) => String(s ?? '').replace(/"/g, '&quot;');
    corpo.innerHTML = dados.itens.map((a) => {
      const clsV = classeVencimentoAta(a.vencimento);
      const tagV = clsV === 'vencido' ? 'cancelado' : clsV === 'proximo' ? 'atrasado' : 'finalizado';
      const valorFmt = a.ultimo_valor_publicado != null
        ? 'R$ ' + Number(a.ultimo_valor_publicado).toLocaleString('pt-BR', { minimumFractionDigits: 2 })
        : '—';
      return `
        <tr>
          <td>
            <span class="celula-truncada" style="display:block; max-width:340px;" title="${escapar(a.descricao)}">${a.descricao || '—'}</span>
            <span class="col-codigo">${a.ata || '—'} · item ${a.item || '—'}</span>
          </td>
          <td class="celula-truncada" title="${escapar(a.nome_comercial)}">${a.nome_comercial || '—'}</td>
          <td class="col-codigo">${a.siafisico || '—'}</td>
          <td>${valorFmt}</td>
          <td class="col-data"><span class="etiqueta-status ${tagV}">${formatarData(a.vencimento)}</span></td>
          <td><button class="botao-editar" data-id="${a.id}">Ver</button></td>
        </tr>
      `;
    }).join('');

    corpo.querySelectorAll('button[data-id]').forEach((btn) => {
      btn.addEventListener('click', () => abrirDetalheAta(btn.dataset.id));
    });
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / estado.atas.pageSize), 1);
  document.getElementById('textoPaginacaoAtas').textContent =
    `${dados.total} resultado${dados.total === 1 ? '' : 's'} · página ${dados.page} de ${totalPaginas}`;
  document.getElementById('botaoAnteriorAtas').disabled = dados.page <= 1;
  document.getElementById('botaoProximoAtas').disabled = dados.page >= totalPaginas;
}

document.getElementById('botaoFecharModalAta').addEventListener('click', () => {
  document.getElementById('modalAtaItem').hidden = true;
});

function abrirDetalheAta(id) {
  const a = itensAtasCarregados.get(String(id));
  if (!a) return;

  document.getElementById('tituloModalAta').textContent = a.descricao || a.nome_comercial || '—';
  document.getElementById('codigoModalAta').textContent = `Ata ${a.ata || '—'} · Item ${a.item || '—'} · Siafísico ${a.siafisico || '—'}`;

  const valorFmt = a.ultimo_valor_publicado != null
    ? 'R$ ' + Number(a.ultimo_valor_publicado).toLocaleString('pt-BR', { minimumFractionDigits: 2 })
    : '—';
  const clsV = classeVencimentoAta(a.vencimento);
  const tagV = clsV === 'vencido' ? 'cancelado' : clsV === 'proximo' ? 'atrasado' : 'finalizado';

  const linha = (rotulo, valor) => `
    <div style="display:flex; justify-content:space-between; gap:14px; padding:7px 0; border-bottom:1px solid var(--linha); font-size:13px;">
      <span style="color:var(--cinza-texto);">${rotulo}</span>
      <span style="text-align:right;">${valor ?? '—'}</span>
    </div>`;

  document.getElementById('conteudoModalAta').innerHTML = `
    <div class="grade-resumo" style="grid-template-columns: repeat(3, 1fr); margin-bottom:18px;">
      <div class="cartao-resumo"><div class="numero" style="font-size:20px;">${valorFmt}</div><div class="rotulo">Valor publicado</div></div>
      <div class="cartao-resumo"><div class="numero" style="font-size:20px;">${formatarData(a.data_publicacao)}</div><div class="rotulo">Data de publicação</div></div>
      <div class="cartao-resumo"><div class="numero"><span class="etiqueta-status ${tagV}" style="font-size:14px;">${formatarData(a.vencimento)}</span></div><div class="rotulo">Vencimento</div></div>
    </div>
    ${linha('Nome Comercial', a.nome_comercial)}
    ${linha('Unidade de Fornecimento', a.unidade_fornecimento)}
    ${linha('Embalagem Primária', a.embalagem_primaria)}
    ${linha('Embalagem Secundária', a.embalagem_secundaria)}
    ${linha('Detentor do Registro', a.detentor_registro)}
    ${linha('OC', a.oc)}
  `;

  document.getElementById('modalAtaItem').hidden = false;
}

// -------------------- Inicialização --------------------
// Verifica se a última sincronização automática via Oracle (Estoque ou
// Autores) falhou e, se sim, mostra um aviso no topo para o admin.
async function verificarFalhasOracle() {
  if (estado.usuario.perfil !== 'admin') return;
  const banner = document.getElementById('bannerAlertaOracle');
  try {
    const [estoque, autores, entradaLotes, saidaLotes, relatorioItens] = await Promise.all([
      api('/estoque/atualizar-oracle/status'),
      api('/autores/atualizar-oracle/status'),
      api('/entrada-lotes/atualizar-oracle/status'),
      api('/saida-lotes/atualizar-oracle/status'),
      api('/relatorio-itens/atualizar-oracle/status'),
    ]);
    const falhas = [];
    if (estoque && estoque.ultimoErro) falhas.push(`Estoque: ${estoque.ultimoErro}`);
    if (autores && autores.ultimoErro) falhas.push(`Listagem de Autores: ${autores.ultimoErro}`);
    if (entradaLotes && entradaLotes.ultimoErro) falhas.push(`Entrada (lotes): ${entradaLotes.ultimoErro}`);
    if (saidaLotes && saidaLotes.ultimoErro) falhas.push(`Saída (lotes): ${saidaLotes.ultimoErro}`);
    if (relatorioItens && relatorioItens.ultimoErro) falhas.push(`Relatório de Itens: ${relatorioItens.ultimoErro}`);
    if (falhas.length) {
      banner.textContent = `⚠️ A última sincronização automática via Oracle falhou. ${falhas.join(' | ')}`;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  } catch (_) {
    // Silencioso: não travar o carregamento do app por causa do banner.
  }
}

// ==================== Movimentação de Entrada Estoque (Tenente Pena) ====================
const estadoEntradaLotes = { pagina: 1, pageSize: 50, filtrosCarregados: false };

document.getElementById('filtroBuscaEntradaLotes').addEventListener('input', () => {
  clearTimeout(window.__debounceBuscaEntradaLotes);
  window.__debounceBuscaEntradaLotes = setTimeout(() => { estadoEntradaLotes.pagina = 1; carregarTabelaEntradaLotes(); }, 350);
});
document.getElementById('filtroTipoEntradaLotes').addEventListener('change', () => { estadoEntradaLotes.pagina = 1; carregarTabelaEntradaLotes(); });
document.getElementById('filtroCategoriaEntradaLotes').addEventListener('change', () => { estadoEntradaLotes.pagina = 1; carregarTabelaEntradaLotes(); });
document.getElementById('filtroDataInicioEntradaLotes').addEventListener('change', () => { estadoEntradaLotes.pagina = 1; carregarTabelaEntradaLotes(); });
document.getElementById('filtroDataFimEntradaLotes').addEventListener('change', () => { estadoEntradaLotes.pagina = 1; carregarTabelaEntradaLotes(); });
document.getElementById('botaoLimparFiltrosEntradaLotes').addEventListener('click', () => {
  document.getElementById('filtroBuscaEntradaLotes').value = '';
  document.getElementById('filtroTipoEntradaLotes').value = '';
  document.getElementById('filtroCategoriaEntradaLotes').value = '';
  document.getElementById('filtroDataInicioEntradaLotes').value = '';
  document.getElementById('filtroDataFimEntradaLotes').value = '';
  estadoEntradaLotes.pagina = 1;
  carregarTabelaEntradaLotes();
});
document.getElementById('botaoAnteriorEntradaLotes').addEventListener('click', () => {
  if (estadoEntradaLotes.pagina > 1) { estadoEntradaLotes.pagina--; carregarTabelaEntradaLotes(); }
});
document.getElementById('botaoProximoEntradaLotes').addEventListener('click', () => {
  estadoEntradaLotes.pagina++; carregarTabelaEntradaLotes();
});

async function carregarEntradaLotes() {
  const resumo = await api('/entrada-lotes/resumo');
  if (!resumo.total) {
    document.getElementById('avisoSemEntradaLotes').hidden = false;
    document.getElementById('conteudoEntradaLotes').hidden = true;
    return;
  }
  document.getElementById('avisoSemEntradaLotes').hidden = true;
  document.getElementById('conteudoEntradaLotes').hidden = false;

  document.getElementById('subtituloEntradaLotes').textContent =
    `${fmtNumero(resumo.total)} movimentações · período ${formatarDataHora(resumo.dataMaisAntiga)} a ${formatarDataHora(resumo.dataMaisRecente)} (últimos 12 meses, via Oracle/SCODES)`;

  document.getElementById('grideResumoEntradaLotes').innerHTML = `
    <div class="cartao-resumo"><div class="numero">${fmtNumero(resumo.total)}</div><div class="rotulo">Movimentações de Entrada</div></div>
  `;

  if (!estadoEntradaLotes.filtrosCarregados) {
    const { tipos, categorias } = await api('/entrada-lotes/filtros');
    const selTipo = document.getElementById('filtroTipoEntradaLotes');
    selTipo.innerHTML = '<option value="">Tipo de movimentação: todos</option>' +
      tipos.map((t) => `<option value="${t.replace(/"/g, '&quot;')}">${t}</option>`).join('');
    const selCat = document.getElementById('filtroCategoriaEntradaLotes');
    selCat.innerHTML = '<option value="">Categoria: todas</option>' +
      categorias.map((c) => `<option value="${c.replace(/"/g, '&quot;')}">${c}</option>`).join('');
    estadoEntradaLotes.filtrosCarregados = true;
  }

  await carregarTabelaEntradaLotes();
}

async function carregarTabelaEntradaLotes() {
  const q = document.getElementById('filtroBuscaEntradaLotes').value.trim();
  const tipoMovimentacao = document.getElementById('filtroTipoEntradaLotes').value;
  const categoria = document.getElementById('filtroCategoriaEntradaLotes').value;
  const dataInicio = document.getElementById('filtroDataInicioEntradaLotes').value;
  const dataFim = document.getElementById('filtroDataFimEntradaLotes').value;

  const params = new URLSearchParams({ page: estadoEntradaLotes.pagina, pageSize: estadoEntradaLotes.pageSize });
  if (q) params.set('q', q);
  if (tipoMovimentacao) params.set('tipoMovimentacao', tipoMovimentacao);
  if (categoria) params.set('categoria', categoria);
  if (dataInicio) params.set('dataInicio', dataInicio);
  if (dataFim) params.set('dataFim', dataFim);

  const dados = await api(`/entrada-lotes?${params.toString()}`);
  const corpo = document.getElementById('corpoTabelaEntradaLotes');
  const vazio = document.getElementById('estadoVazioEntradaLotes');

  if (dados.entradas.length === 0) {
    corpo.innerHTML = ''; vazio.hidden = false;
  } else {
    vazio.hidden = true;
    corpo.innerHTML = dados.entradas.map((e) => `
      <tr>
        <td class="col-data">${formatarDataHora(e.data_entrada)}</td>
        <td>${e.item || '—'}</td>
        <td class="col-codigo">${e.codigo_item || '—'}</td>
        <td class="col-codigo">${e.lote || '—'}</td>
        <td class="col-data">${e.validade || '—'}</td>
        <td>${fmtNumero(e.qtde)}</td>
        <td>${e.fabricante || '—'}</td>
        <td>${e.fornecedor || '—'}</td>
        <td>${e.modalidade_compra || '—'}</td>
        <td class="col-codigo">${e.nota_empenho || '—'}</td>
        <td class="col-codigo">${e.nota_fiscal || '—'}</td>
        <td>${e.valor_unitario == null ? '—' : fmtNumero(e.valor_unitario)}</td>
        <td>${e.valor_total == null ? '—' : fmtNumero(e.valor_total)}</td>
        <td>${e.tipo_movimentacao || '—'}</td>
      </tr>
    `).join('');
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoEntradaLotes').textContent = `Página ${dados.page} de ${totalPaginas} · ${dados.total} resultados`;
  document.getElementById('botaoAnteriorEntradaLotes').disabled = dados.page <= 1;
  document.getElementById('botaoProximoEntradaLotes').disabled = dados.page >= totalPaginas;
}

// ---------- Atualizar via Oracle (SCODES) ----------
let timerStatusOracleEntradaLotes = null;
function mostrarStatusOracleEntradaLotes(texto, cor) {
  const el = document.getElementById('statusOracleEntradaLotes');
  el.textContent = texto;
  el.style.color = cor || '';
  el.hidden = !texto;
}
async function verificarStatusOracleEntradaLotes() {
  try {
    const r = await fetch('/api/entrada-lotes/atualizar-oracle/status');
    const s = await r.json();
    const botao = document.getElementById('botaoAtualizarEntradaLotes');
    if (s.rodando) {
      botao.disabled = true;
      if (!timerStatusOracleEntradaLotes) timerStatusOracleEntradaLotes = setInterval(verificarStatusOracleEntradaLotes, 5000);
      const min = s.inicio ? Math.floor((Date.now() - new Date(s.inicio)) / 60000) : 0;
      mostrarStatusOracleEntradaLotes(`⏳ Atualizando via Oracle… (${min} min) — pode continuar usando o sistema.`, '#8a6d00');
    } else {
      botao.disabled = false;
      if (timerStatusOracleEntradaLotes) { clearInterval(timerStatusOracleEntradaLotes); timerStatusOracleEntradaLotes = null; }
      if (s.ultimoErro) {
        mostrarStatusOracleEntradaLotes('❌ Falha na última atualização: ' + s.ultimoErro, '#b00020');
      } else if (s.ultimoResumo) {
        const seg = Math.round((s.ultimoResumo.duracaoMs || 0) / 1000);
        mostrarStatusOracleEntradaLotes(`✅ Atualizado: ${s.ultimoResumo.totalLinhas} linhas (${seg}s). Recarregue a tabela.`, '#1f5c52');
        if (estado.paginaAtual === 'entradaLotes') carregarEntradaLotes();
      } else {
        mostrarStatusOracleEntradaLotes('', '');
      }
    }
  } catch (_) { /* silencioso */ }
}
document.getElementById('botaoAtualizarEntradaLotes').addEventListener('click', async () => {
  if (!confirm('Atualizar as Movimentações de Entrada (últimos 12 meses) direto do Oracle (SCODES)?\n\nIsso substitui os dados atuais e roda em segundo plano — você pode continuar usando o sistema normalmente.')) return;
  const botao = document.getElementById('botaoAtualizarEntradaLotes');
  botao.disabled = true;
  mostrarStatusOracleEntradaLotes('⏳ Iniciando…', '#8a6d00');
  try {
    const r = await fetch('/api/entrada-lotes/atualizar-oracle', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) {
      mostrarStatusOracleEntradaLotes('❌ ' + (d.erro || 'Não foi possível iniciar.'), '#b00020');
      botao.disabled = false;
      return;
    }
    if (timerStatusOracleEntradaLotes) clearInterval(timerStatusOracleEntradaLotes);
    timerStatusOracleEntradaLotes = setInterval(verificarStatusOracleEntradaLotes, 5000);
    verificarStatusOracleEntradaLotes();
  } catch (e) {
    mostrarStatusOracleEntradaLotes('❌ Erro de rede ao iniciar.', '#b00020');
    botao.disabled = false;
  }
});

// ==================== Movimentação de Saída Estoque (Tenente Pena) ====================
const estadoSaidaLotes = { pagina: 1, pageSize: 50, filtrosCarregados: false, consolidado: false };

// --- Dropdowns de seleção múltipla (Tipo de movimentação e Categoria) ---
function tiposSaidaSelecionados() {
  return [...document.querySelectorAll('.saida-tipo-check:checked')].map((cb) => cb.value);
}
function categoriasSaidaSelecionadas() {
  return [...document.querySelectorAll('.saida-cat-check:checked')].map((cb) => cb.value);
}
function atualizarRotuloTipoSaida() {
  const n = tiposSaidaSelecionados().length;
  document.getElementById('filtroTipoSaidaBotao').textContent =
    n === 0 ? 'Tipo de movimentação: todos ▾' : `Tipo: ${n} selecionado(s) ▾`;
}
function atualizarRotuloCategoriaSaida() {
  const n = categoriasSaidaSelecionadas().length;
  document.getElementById('filtroCategoriaSaidaBotao').textContent =
    n === 0 ? 'Categoria: todas ▾' : `Categoria: ${n} selecionada(s) ▾`;
}
document.getElementById('filtroTipoSaidaBotao').addEventListener('click', (ev) => {
  ev.stopPropagation();
  const p = document.getElementById('filtroTipoSaidaPainel');
  p.hidden = !p.hidden;
});
document.getElementById('filtroCategoriaSaidaBotao').addEventListener('click', (ev) => {
  ev.stopPropagation();
  const p = document.getElementById('filtroCategoriaSaidaPainel');
  p.hidden = !p.hidden;
});
document.addEventListener('click', (ev) => {
  const wt = document.getElementById('filtroTipoSaidaWrap');
  if (wt && !wt.contains(ev.target)) document.getElementById('filtroTipoSaidaPainel').hidden = true;
  const wc = document.getElementById('filtroCategoriaSaidaWrap');
  if (wc && !wc.contains(ev.target)) document.getElementById('filtroCategoriaSaidaPainel').hidden = true;
});

document.getElementById('filtroBuscaSaidaLotes').addEventListener('input', () => {
  clearTimeout(window.__debounceBuscaSaidaLotes);
  window.__debounceBuscaSaidaLotes = setTimeout(() => { estadoSaidaLotes.pagina = 1; recarregarVisaoSaidaLotes(); }, 350);
});
document.getElementById('filtroDataInicioSaidaLotes').addEventListener('change', () => { estadoSaidaLotes.pagina = 1; recarregarVisaoSaidaLotes(); });
document.getElementById('filtroDataFimSaidaLotes').addEventListener('change', () => { estadoSaidaLotes.pagina = 1; recarregarVisaoSaidaLotes(); });
document.getElementById('botaoLimparFiltrosSaidaLotes').addEventListener('click', () => {
  document.getElementById('filtroBuscaSaidaLotes').value = '';
  document.getElementById('filtroDataInicioSaidaLotes').value = '';
  document.getElementById('filtroDataFimSaidaLotes').value = '';
  document.querySelectorAll('.saida-tipo-check:checked, .saida-cat-check:checked').forEach((cb) => { cb.checked = false; });
  atualizarRotuloTipoSaida();
  atualizarRotuloCategoriaSaida();
  estadoSaidaLotes.pagina = 1;
  recarregarVisaoSaidaLotes();
});
document.getElementById('botaoAnteriorSaidaLotes').addEventListener('click', () => {
  if (estadoSaidaLotes.pagina > 1) { estadoSaidaLotes.pagina--; carregarTabelaSaidaLotes(); }
});
document.getElementById('botaoProximoSaidaLotes').addEventListener('click', () => {
  estadoSaidaLotes.pagina++; carregarTabelaSaidaLotes();
});
document.getElementById('botaoConsolidarSaidaLotes').addEventListener('click', () => {
  estadoSaidaLotes.consolidado = true;
  document.getElementById('listaSaidaLotes').hidden = true;
  document.getElementById('consolidadoSaidaLotes').hidden = false;
  carregarConsolidadoSaidaLotes();
});
document.getElementById('botaoVoltarListaSaidaLotes').addEventListener('click', () => {
  estadoSaidaLotes.consolidado = false;
  document.getElementById('consolidadoSaidaLotes').hidden = true;
  document.getElementById('listaSaidaLotes').hidden = false;
});
// Exportações (o cookie de sessão vai junto por ser mesma origem).
document.getElementById('botaoExportarSaidaLotes').addEventListener('click', () => {
  window.location.href = `/api/saida-lotes/exportar?${paramsFiltroSaidaLotes().toString()}`;
});
document.getElementById('botaoExportarConsolidadoSaidaLotes').addEventListener('click', () => {
  window.location.href = `/api/saida-lotes/consolidado/exportar?${paramsFiltroSaidaLotes().toString()}`;
});

// Recarrega a visão que estiver ativa (lista ou consolidado) ao mudar filtro.
function recarregarVisaoSaidaLotes() {
  if (estadoSaidaLotes.consolidado) carregarConsolidadoSaidaLotes();
  else carregarTabelaSaidaLotes();
}

// Monta os parâmetros de filtro atuais (compartilhado por lista e consolidado).
function paramsFiltroSaidaLotes() {
  const params = new URLSearchParams();
  const q = document.getElementById('filtroBuscaSaidaLotes').value.trim();
  if (q) params.set('q', q);
  tiposSaidaSelecionados().forEach((t) => params.append('tipoMovimentacao', t));
  categoriasSaidaSelecionadas().forEach((c) => params.append('categoria', c));
  const dataInicio = document.getElementById('filtroDataInicioSaidaLotes').value;
  const dataFim = document.getElementById('filtroDataFimSaidaLotes').value;
  if (dataInicio) params.set('dataInicio', dataInicio);
  if (dataFim) params.set('dataFim', dataFim);
  return params;
}

async function carregarSaidaLotes() {
  const resumo = await api('/saida-lotes/resumo');
  if (!resumo.total) {
    document.getElementById('avisoSemSaidaLotes').hidden = false;
    document.getElementById('conteudoSaidaLotes').hidden = true;
    return;
  }
  document.getElementById('avisoSemSaidaLotes').hidden = true;
  document.getElementById('conteudoSaidaLotes').hidden = false;

  document.getElementById('subtituloSaidaLotes').textContent =
    `${fmtNumero(resumo.total)} movimentações · período ${formatarDataHora(resumo.dataMaisAntiga)} a ${formatarDataHora(resumo.dataMaisRecente)} (últimos 12 meses, via Oracle/SCODES)`;

  document.getElementById('grideResumoSaidaLotes').innerHTML = `
    <div class="cartao-resumo"><div class="numero">${fmtNumero(resumo.total)}</div><div class="rotulo">Movimentações de Saída</div></div>
  `;

  if (!estadoSaidaLotes.filtrosCarregados) {
    const { tipos, categorias } = await api('/saida-lotes/filtros');
    const esc = (s) => String(s).replace(/"/g, '&quot;');
    document.getElementById('filtroTipoSaidaPainel').innerHTML = tipos.length
      ? tipos.map((t) => `<label class="multi-filtro-item"><input type="checkbox" class="saida-tipo-check" value="${esc(t)}"> ${t}</label>`).join('')
      : '<span style="color:var(--texto-suave); padding:6px 8px; display:block;">Sem tipos.</span>';
    document.getElementById('filtroCategoriaSaidaPainel').innerHTML = categorias.length
      ? categorias.map((c) => `<label class="multi-filtro-item"><input type="checkbox" class="saida-cat-check" value="${esc(c)}"> ${c}</label>`).join('')
      : '<span style="color:var(--texto-suave); padding:6px 8px; display:block;">Sem categorias.</span>';
    // Ao marcar/desmarcar qualquer checkbox, volta à 1ª página e recarrega.
    document.querySelectorAll('.saida-tipo-check').forEach((cb) => cb.addEventListener('change', () => {
      atualizarRotuloTipoSaida(); estadoSaidaLotes.pagina = 1; recarregarVisaoSaidaLotes();
    }));
    document.querySelectorAll('.saida-cat-check').forEach((cb) => cb.addEventListener('change', () => {
      atualizarRotuloCategoriaSaida(); estadoSaidaLotes.pagina = 1; recarregarVisaoSaidaLotes();
    }));
    estadoSaidaLotes.filtrosCarregados = true;
  }

  // Sempre reabre na lista detalhada ao entrar na tela.
  estadoSaidaLotes.consolidado = false;
  document.getElementById('consolidadoSaidaLotes').hidden = true;
  document.getElementById('listaSaidaLotes').hidden = false;
  await carregarTabelaSaidaLotes();
}

async function carregarTabelaSaidaLotes() {
  const params = paramsFiltroSaidaLotes();
  params.set('page', estadoSaidaLotes.pagina);
  params.set('pageSize', estadoSaidaLotes.pageSize);

  const dados = await api(`/saida-lotes?${params.toString()}`);
  const corpo = document.getElementById('corpoTabelaSaidaLotes');
  const vazio = document.getElementById('estadoVazioSaidaLotes');

  if (dados.saidas.length === 0) {
    corpo.innerHTML = ''; vazio.hidden = false;
  } else {
    vazio.hidden = true;
    corpo.innerHTML = dados.saidas.map((s) => `
      <tr>
        <td class="col-data">${formatarDataHora(s.data_saida)}</td>
        <td>${s.item || '—'}</td>
        <td class="col-codigo">${s.codigo_item || '—'}</td>
        <td class="col-codigo">${s.lote || '—'}</td>
        <td class="col-data">${s.validade || '—'}</td>
        <td>${fmtNumero(s.qtde)}</td>
        <td>${s.tipo_movimentacao || '—'}</td>
        <td>${s.categoria || '—'}</td>
        <td>${s.fabricante || '—'}</td>
        <td>${s.unidade_transferencia || '—'}</td>
        <td>${s.fornecedor || '—'}</td>
        <td class="col-codigo">${s.documento_transferencia || '—'}</td>
        <td>${s.usuario_login || '—'}</td>
        <td>${s.observacao || '—'}</td>
      </tr>
    `).join('');
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoSaidaLotes').textContent = `Página ${dados.page} de ${totalPaginas} · ${dados.total} resultados`;
  document.getElementById('botaoAnteriorSaidaLotes').disabled = dados.page <= 1;
  document.getElementById('botaoProximoSaidaLotes').disabled = dados.page >= totalPaginas;
}

async function carregarConsolidadoSaidaLotes() {
  const dados = await api(`/saida-lotes/consolidado?${paramsFiltroSaidaLotes().toString()}`);
  const corpo = document.getElementById('corpoTabelaConsolidadoSaidaLotes');
  const vazio = document.getElementById('estadoVazioConsolidadoSaidaLotes');

  document.getElementById('grideResumoConsolidadoSaidaLotes').innerHTML = `
    <div class="cartao-resumo"><div class="numero">${fmtNumero(dados.totalItens)}</div><div class="rotulo">Medicamentos distintos</div></div>
    <div class="cartao-resumo"><div class="numero">${fmtNumero(dados.totalQtde)}</div><div class="rotulo">Quantidade total saída</div></div>
    <div class="cartao-resumo"><div class="numero">${fmtNumero(dados.totalMovimentacoes)}</div><div class="rotulo">Movimentações somadas</div></div>
  `;

  if (dados.linhas.length === 0) {
    corpo.innerHTML = ''; vazio.hidden = false;
  } else {
    vazio.hidden = true;
    corpo.innerHTML = dados.linhas.map((l) => `
      <tr>
        <td class="col-codigo">${l.codigo_item || '—'}</td>
        <td>${l.item || '—'}</td>
        <td>${l.categoria || '—'}</td>
        <td><strong>${fmtNumero(l.qtde_total)}</strong></td>
        <td>${fmtNumero(l.movimentacoes)}</td>
      </tr>
    `).join('');
  }
}

// ---------- Atualizar via Oracle (SCODES) ----------
let timerStatusOracleSaidaLotes = null;
function mostrarStatusOracleSaidaLotes(texto, cor) {
  const el = document.getElementById('statusOracleSaidaLotes');
  el.textContent = texto;
  el.style.color = cor || '';
  el.hidden = !texto;
}
async function verificarStatusOracleSaidaLotes() {
  try {
    const r = await fetch('/api/saida-lotes/atualizar-oracle/status');
    const s = await r.json();
    const botao = document.getElementById('botaoAtualizarSaidaLotes');
    if (s.rodando) {
      botao.disabled = true;
      if (!timerStatusOracleSaidaLotes) timerStatusOracleSaidaLotes = setInterval(verificarStatusOracleSaidaLotes, 5000);
      const min = s.inicio ? Math.floor((Date.now() - new Date(s.inicio)) / 60000) : 0;
      mostrarStatusOracleSaidaLotes(`⏳ Atualizando via Oracle… (${min} min) — pode continuar usando o sistema.`, '#8a6d00');
    } else {
      botao.disabled = false;
      if (timerStatusOracleSaidaLotes) { clearInterval(timerStatusOracleSaidaLotes); timerStatusOracleSaidaLotes = null; }
      if (s.ultimoErro) {
        mostrarStatusOracleSaidaLotes('❌ Falha na última atualização: ' + s.ultimoErro, '#b00020');
      } else if (s.ultimoResumo) {
        const seg = Math.round((s.ultimoResumo.duracaoMs || 0) / 1000);
        mostrarStatusOracleSaidaLotes(`✅ Atualizado: ${s.ultimoResumo.totalLinhas} linhas (${seg}s). Recarregue a tabela.`, '#1f5c52');
        if (estado.paginaAtual === 'saidaLotes') carregarSaidaLotes();
      } else {
        mostrarStatusOracleSaidaLotes('', '');
      }
    }
  } catch (_) { /* silencioso */ }
}
document.getElementById('botaoAtualizarSaidaLotes').addEventListener('click', async () => {
  if (!confirm('Atualizar as Movimentações de Saída (últimos 12 meses) direto do Oracle (SCODES)?\n\nIsso substitui os dados atuais e roda em segundo plano — você pode continuar usando o sistema normalmente.')) return;
  const botao = document.getElementById('botaoAtualizarSaidaLotes');
  botao.disabled = true;
  mostrarStatusOracleSaidaLotes('⏳ Iniciando…', '#8a6d00');
  try {
    const r = await fetch('/api/saida-lotes/atualizar-oracle', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) {
      mostrarStatusOracleSaidaLotes('❌ ' + (d.erro || 'Não foi possível iniciar.'), '#b00020');
      botao.disabled = false;
      return;
    }
    if (timerStatusOracleSaidaLotes) clearInterval(timerStatusOracleSaidaLotes);
    timerStatusOracleSaidaLotes = setInterval(verificarStatusOracleSaidaLotes, 5000);
    verificarStatusOracleSaidaLotes();
  } catch (e) {
    mostrarStatusOracleSaidaLotes('❌ Erro de rede ao iniciar.', '#b00020');
    botao.disabled = false;
  }
});

(async function iniciar() {
  try {
    await carregarUsuario();
    preencherAnos();
    document.getElementById('telaCarregando').hidden = true;
    document.querySelector('.app-shell').hidden = false;
    await mudarPagina('painel');
    verificarFalhasOracle();
  } catch (e) {
    // carregarUsuario já redireciona para login em caso de 401.
    // Para qualquer outro erro (ex: servidor indisponível), redireciona também.
    if (!window.location.href.includes('login.html')) {
      window.location.href = '/login.html';
    }
  }
})();

// ==================== Reservas de Estoque (API UDTP) ====================
// Reserva = quantidade que está no estoque mas já foi separada para um
// paciente. A tela mostra a foto de um dia; o botão "Atualizar agora"
// consulta a API na hora (requer a ação "importar" no módulo "reservas").
const estadoReservas = { data: null };

// Escapa texto vindo da API antes de jogar no HTML. Importante aqui porque
// "recebedor" é nome de pessoa vindo de fora: sem isso, um caractere como
// "<" quebraria a tabela (ou pior).
function escHtml(v) {
  if (v === null || v === undefined || v === '') return '—';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function carregarReservas() {
  try {
    await carregarReservasInterno();
  } catch (e) {
    // Mesmo motivo da tela de Rupturas: sem isso, um erro deixaria a tela
    // em branco sem explicação (a mensagem cairia no bloco escondido).
    document.getElementById('conteudoReservas').hidden = true;
    const aviso = document.getElementById('avisoSemReservas');
    aviso.hidden = false;
    aviso.textContent = 'Não consegui carregar as reservas: ' + e.message;
    throw e;
  }
}

async function carregarReservasInterno() {
  const btn = document.getElementById('botaoAtualizarReservas');
  if (btn) btn.hidden = !temPermissao('reservas', 'importar');

  // Datas já importadas (para o seletor)
  const { datas } = await api('/reservas/datas');
  const seletor = document.getElementById('filtroDataReservas');
  if (datas.length) {
    const atual = estadoReservas.data && datas.some((d) => d.data === estadoReservas.data)
      ? estadoReservas.data : datas[0].data;
    estadoReservas.data = atual;
    seletor.innerHTML = datas
      .map((d) => `<option value="${d.data}"${d.data === atual ? ' selected' : ''}>${formatarData(d.data)}</option>`)
      .join('');
  } else {
    seletor.innerHTML = '';
    estadoReservas.data = null;
  }

  await buscarReservas();
}

async function buscarReservas() {
  const busca = document.getElementById('filtroBuscaReservas').value.trim();
  const soComp = document.getElementById('filtroComprometidosReservas').checked;
  const p = new URLSearchParams();
  if (estadoReservas.data) p.set('data', estadoReservas.data);
  if (busca) p.set('busca', busca);
  if (soComp) p.set('comprometidos', 'true');

  const dados = await api('/reservas?' + p.toString());
  renderReservas(dados);
}

function renderReservas(d) {
  const temDados = !!d.dataReferencia;
  document.getElementById('conteudoReservas').hidden = !temDados;
  const aviso = document.getElementById('avisoSemReservas');
  aviso.hidden = temDados;
  if (!temDados) {
    aviso.textContent = d.credenciaisConfiguradas
      ? 'Nenhuma reserva importada ainda. Use o botão "Atualizar agora" para consultar a API.'
      : 'A integração com a API UDTP ainda não está configurada (falta usuário/senha no .env do servidor). Fale com o administrador.';
    document.getElementById('atualizadoEmReservas').textContent = '';
    return;
  }

  document.getElementById('atualizadoEmReservas').textContent =
    'Atualizado em ' + formatarDataHora(d.atualizadoEm);

  const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
  document.getElementById('kpisReservas').innerHTML = [
    kpiCard('doc', nf(d.itensDistintos), 'Medicamentos', 'itens com reserva no dia'),
    kpiCard('chart', nf(d.quantidadeTotal), 'Saldo reservado', 'soma das quantidades separadas'),
    kpiCard('relogio', nf(d.protocolosDistintos), 'Reservas', 'protocolos/pacientes atendidos'),
    kpiCard('check', nf(d.comprometidos), 'Comprometidos', 'itens com disponível ≤ 0',
      d.comprometidos > 0 ? 'critico' : ''),
  ].join('');

  const corpo = document.getElementById('corpoTabelaReservas');
  corpo.innerHTML = d.linhas.map((l) => {
    // Disponível negativo/zero = estoque já todo comprometido: destaca.
    const classeDisp = l.disponivel < 0 ? 'texto-vermelho' : (l.disponivel === 0 ? 'texto-ambar' : '');
    return `
    <tr class="linha-reserva">
      <td><button class="botao-secundario botao-ver-reserva" type="button"
                  data-item="${escAttr(l.codigoItem)}"
                  data-desc="${escAttr(l.descricao)}"
                  title="Ver lotes, validades e pacientes deste medicamento">Ver</button></td>
      <td>${escHtml(l.codigoItem)}</td>
      <td>${escHtml(l.descricao)}</td>
      <td>${escHtml(l.unidade)}</td>
      <td>${nf(l.estoque)}</td>
      <td>${nf(l.reservado)}</td>
      <td class="${classeDisp}"><strong>${nf(l.disponivel)}</strong></td>
      <td>${l.validadeMaisProxima ? formatarData(l.validadeMaisProxima) : '—'}</td>
      <td>${nf(l.protocolos)}</td>
    </tr>`;
  }).join('');
  document.getElementById('estadoVazioReservas').hidden = d.linhas.length > 0;

  // "Ver": abre o card com os lotes e os pacientes, buscando sob demanda.
  corpo.querySelectorAll('.botao-ver-reserva').forEach((b) => {
    b.addEventListener('click', () => abrirModalReserva(b.dataset.item, b.dataset.desc));
  });
}

async function abrirModalReserva(codigoItem, descricao) {
  const modal = document.getElementById('modalReservaItem');
  const corpo = document.getElementById('conteudoModalReserva');
  document.getElementById('tituloModalReserva').textContent = descricao || 'Lotes e pacientes';
  document.getElementById('codigoModalReserva').textContent = codigoItem;
  corpo.innerHTML = '<p class="texto-apoio">Carregando…</p>';
  modal.hidden = false;

  try {
    const p = new URLSearchParams({ codigoItem });
    if (estadoReservas.data) p.set('data', estadoReservas.data);
    const d = await api('/reservas/detalhe?' + p.toString());
    corpo.innerHTML = montarDetalheReserva(d);
  } catch (e) {
    corpo.innerHTML = `<p class="texto-vermelho">Não consegui carregar o detalhe: ${escHtml(e.message)}</p>`;
  }
}

function fecharModalReserva() {
  document.getElementById('modalReservaItem').hidden = true;
}

function montarDetalheReserva(d) {
  const nf = (n) => Number(n || 0).toLocaleString('pt-BR');

  const lotes = d.lotes.length ? `
    <table>
      <thead><tr><th>Lote</th><th>Validade</th><th>Saldo</th></tr></thead>
      <tbody>${d.lotes.map((l) => `
        <tr><td>${escHtml(l.lote)}</td><td>${l.validade ? formatarData(l.validade) : '—'}</td><td>${nf(l.saldo)}</td></tr>`).join('')}
      </tbody>
    </table>` : '<p class="texto-apoio">Sem lotes com saldo nesta data.</p>';

  const reservas = d.reservas.length ? `
    <table>
      <thead><tr><th>Recebedor</th><th>Protocolo</th><th>Qtde</th><th>Lote(s) — FEFO</th></tr></thead>
      <tbody>${d.reservas.map((r) => `
        <tr>
          <td>${escHtml(r.recebedor)}</td>
          <td>${escHtml(r.codigoProtocolo)}</td>
          <td>${nf(r.saldoReservado)}</td>
          <td>${r.lotesFefo && r.lotesFefo.length
            ? r.lotesFefo.map((x) => `${escHtml(x.lote)} <span class="texto-apoio">(${formatarData(x.validade)}) ${nf(x.quantidade)}</span>`).join('<br>')
            : '<span class="texto-apoio">—</span>'}
            ${r.naoCoberto ? `<br><span class="texto-vermelho">sem lote para ${nf(r.naoCoberto)}</span>` : ''}</td>
        </tr>`).join('')}
      </tbody>
    </table>` : '<p class="texto-apoio">Sem reservas.</p>';

  return `
    <div class="detalhe-colunas">
      <div>
        <h4>Lotes em estoque <span class="texto-apoio">(ordem de validade — FEFO)</span></h4>
        ${lotes}
      </div>
      <div>
        <h4>Pacientes com reserva <span class="texto-apoio">(${d.reservas.length})</span></h4>
        ${reservas}
      </div>
    </div>
    <p class="texto-apoio" style="margin-top:8px;">
      A API não informa o lote de cada reserva; a coluna "Lote(s)" é uma indicação calculada pela regra FEFO
      (consome primeiro o que vence antes). Estoque da foto de ${formatarData(d.dataEstoque)}.
    </p>`;
}

// --- eventos da tela de Reservas ---
document.getElementById('filtroDataReservas').addEventListener('change', (e) => {
  estadoReservas.data = e.target.value;
  buscarReservas().catch((err) => alert('Erro: ' + err.message));
});
let tempoBuscaReservas = null;
document.getElementById('filtroBuscaReservas').addEventListener('input', () => {
  clearTimeout(tempoBuscaReservas);
  tempoBuscaReservas = setTimeout(() => {
    buscarReservas().catch((err) => alert('Erro: ' + err.message));
  }, 300);
});
document.getElementById('botaoFecharModalReserva').addEventListener('click', fecharModalReserva);

// Clicar no fundo escurecido fecha o card — mas SÓ nos modais de leitura.
// Nos de formulário (solicitação, usuário, permissões, requisição) isso fica
// de fora de propósito: um clique fora acidental jogaria fora o que a pessoa
// digitou. Fecha apenas quando o clique é no próprio fundo, não dentro do card.
['modalReservaItem', 'modalEstoqueItem', 'modalEstoqueODItem', 'modalAtaItem', 'modalValidadeItem']
  .forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', (ev) => { if (ev.target === el) el.hidden = true; });
  });
document.getElementById('filtroComprometidosReservas').addEventListener('change', () => {
  buscarReservas().catch((err) => alert('Erro: ' + err.message));
});
document.getElementById('botaoLimparFiltrosReservas').addEventListener('click', () => {
  document.getElementById('filtroBuscaReservas').value = '';
  document.getElementById('filtroComprometidosReservas').checked = false;
  buscarReservas().catch((err) => alert('Erro: ' + err.message));
});
document.getElementById('botaoExportarReservas').addEventListener('click', () => {
  if (!estadoReservas.data) return;
  window.location.href = '/api/reservas/csv?data=' + encodeURIComponent(estadoReservas.data);
});
document.getElementById('botaoAtualizarReservas').addEventListener('click', async () => {
  const botao = document.getElementById('botaoAtualizarReservas');
  const textoOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = '⏳ Consultando a API…';
  try {
    const r = await api('/reservas/importar-agora', { method: 'POST', body: JSON.stringify({}) });
    let msg = `Reservas atualizadas: ${r.totalRegistros} registro(s) em ${formatarData(r.dataReferencia)}.`;
    if (r.semCodigoScodes > 0) msg += `\n\nAtenção: ${r.semCodigoScodes} registro(s) vieram sem código SCODES.`;
    if (r.camposNaoMapeados && r.camposNaoMapeados.length) {
      msg += `\n\nCampos novos na API (ainda não usados): ${r.camposNaoMapeados.join(', ')}.`;
    }
    alert(msg);
    estadoReservas.data = r.dataReferencia;
    await carregarReservas();
  } catch (e) {
    alert('Não foi possível atualizar as reservas.\n\n' + e.message);
  } finally {
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
});

// ==================== Rupturas (API UDTP) ====================
// Ruptura = o paciente veio buscar e o item faltou. É o fato consumado,
// diferente do alerta "estoque_ruptura", que o sistema calcula.
// A tela abre nos últimos 30 dias e cruza com o Relatório de Itens
// (categoria, tipo, importado, outras demandas) e com a Listagem de Autores
// (nome do paciente, pelo protocolo).
const estadoRupturas = { inicio: null, fim: null };

function paramsRupturas() {
  const p = new URLSearchParams();
  // Usa o período JÁ APLICADO (cravado no botão Carregar), não o que está sendo
  // digitado — assim mudar a data só recarrega quando o usuário clica Carregar.
  if (estadoRupturas.inicio) p.set('inicio', estadoRupturas.inicio);
  if (estadoRupturas.fim) p.set('fim', estadoRupturas.fim);
  const busca = document.getElementById('filtroBuscaRupturas').value.trim();
  if (busca) p.set('busca', busca);
  const cat = document.getElementById('filtroCategoriaRupturas').value;
  if (cat) p.set('categoria', cat);
  const tipo = document.getElementById('filtroTipoRupturas').value;
  if (tipo) p.set('tipoItem', tipo);
  const imp = document.getElementById('filtroImportadoRupturas').value;
  if (imp) p.set('importado', imp);
  const outras = document.getElementById('filtroOutrasRupturas').value;
  if (outras) p.set('outrasDemandas', outras);
  return p;
}

async function carregarRupturas() {
  const btn = document.getElementById('botaoAtualizarRupturas');
  if (btn) btn.hidden = !temPermissao('rupturas', 'importar');
  try {
    await buscarRupturas();
  } catch (e) {
    // O tratador genérico de erro escreve dentro de .grade-resumo, que aqui
    // fica DENTRO do bloco escondido — a falha viraria uma página em branco
    // muda. Mostramos a mensagem no aviso, que fica sempre visível.
    document.getElementById('conteudoRupturas').hidden = true;
    const aviso = document.getElementById('avisoSemRupturas');
    aviso.hidden = false;
    aviso.textContent = 'Não consegui carregar as rupturas: ' + e.message;
    throw e;   // segue para o log do navegador, para diagnóstico
  }
}

async function buscarRupturas() {
  const d = await api('/rupturas?' + paramsRupturas().toString());
  renderRupturas(d);
  // Se a aba de compras estiver aberta, ela também precisa acompanhar o filtro.
  const abaCompras = document.getElementById('abaRupturasCompras');
  if (abaCompras && !abaCompras.hidden) await carregarComprasRupturas();
}

// Monta um cartão de quebra (por categoria / por tipo de item).
// A coluna "%" é a participação daquela linha no TOTAL de rupturas do grupo —
// a barrinha usa a mesma proporção, para leitura imediata.
function quebraRupturas(titulo, dados, rotuloColuna, campo, pacientesDistintos) {
  if (!dados || !dados.length) return '';
  const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
  const total = dados.reduce((s, x) => s + (x.rupturas || 0), 0) || 1;
  const linhas = dados.map((x) => {
    const pct = (x.rupturas / total) * 100;
    // 1 casa decimal só quando ajuda (evita "56,0%")
    const pctTxt = pct.toLocaleString('pt-BR', { minimumFractionDigits: pct < 10 ? 1 : 0, maximumFractionDigits: 1 }) + '%';
    return '<tr>'
      + '<td><div class="rotulo-quebra">' + escHtml(x[campo]) + '</div>'
      + '<div class="trilho-quebra"><span style="width:' + pct.toFixed(1) + '%"></span></div></td>'
      + '<td><strong>' + nf(x.rupturas) + '</strong></td>'
      + '<td class="col-pct">' + pctTxt + '</td>'
      + '<td>' + nf(x.itens) + '</td>'
      + '<td>' + nf(x.pacientes) + '</td>'
      + '</tr>';
  }).join('');
  // Total de Itens = soma por linha (cada item tem uma só categoria/tipo, então
  // a soma já é o total distinto). Total de Pacientes = nº de pacientes
  // DISTINTOS do período (não a soma das linhas): um mesmo paciente pode ter
  // ruptura em vários grupos, então somar contaria em duplicidade e daria
  // valores diferentes entre as tabelas. O distinto é igual ao card "Pacientes
  // impactados" e igual nas duas quebras.
  const totalItens = dados.reduce((s, x) => s + (x.itens || 0), 0);
  const totalPac = pacientesDistintos != null
    ? pacientesDistintos
    : dados.reduce((s, x) => s + (x.pacientes || 0), 0);
  return '<div class="cartao-quebra"><h4>' + titulo + '</h4>'
    + '<table><thead><tr><th>' + rotuloColuna + '</th>'
    + '<th title="Total de ocorrências de ruptura no período (cada falta conta 1; o mesmo paciente pode contar mais de uma vez).">Rupturas <span style="cursor:help; color:var(--cinza-texto); font-size:11px;">ⓘ</span></th>'
    + '<th>%</th>'
    + '<th title="Itens (medicamentos/materiais) distintos com ruptura no período.">Itens <span style="cursor:help; color:var(--cinza-texto); font-size:11px;">ⓘ</span></th>'
    + '<th title="Pacientes distintos com ruptura. Na linha Total é o total de pacientes distintos do período (não a soma das linhas: um paciente pode aparecer em mais de uma categoria/tipo).">Pacientes <span style="cursor:help; color:var(--cinza-texto); font-size:11px;">ⓘ</span></th></tr></thead>'
    + '<tbody>' + linhas + '</tbody>'
    + '<tfoot><tr><td><strong>Total</strong></td><td><strong>' + nf(total) + '</strong></td>'
    + '<td class="col-pct">100%</td>'
    + '<td><strong>' + nf(totalItens) + '</strong></td>'
    + '<td><strong title="Pacientes distintos no período (não é a soma das linhas: um paciente pode aparecer em mais de uma categoria/tipo)">' + nf(totalPac) + '</strong></td>'
    + '</tr></tfoot>'
    + '</table></div>';
}

// ---- Gráfico 1: rupturas por dia (barras verticais em SVG) ----
// Cores por classe CSS (não cravadas), para funcionar nos dois temas.
function graficoDiaRupturas(porDia) {
  const alvo = document.getElementById('graficoDiaRupturas');
  const legenda = document.getElementById('legendaDiaRupturas');
  if (!porDia || !porDia.length) {
    alvo.innerHTML = '<p class="texto-apoio">Sem dados no período.</p>';
    legenda.textContent = '';
    return;
  }
  const max = Math.max(...porDia.map((d) => d.rupturas), 1);
  const pico = porDia.reduce((a, b) => (b.rupturas > a.rupturas ? b : a));
  const soma = porDia.reduce((s, d) => s + d.rupturas, 0);
  const media = soma / porDia.length;
  // O total entra na legenda de propósito: como cada gráfico é redimensionado
  // pelo próprio máximo, ao filtrar o DESENHO muda pouco (mesmos dias, forma
  // parecida) mesmo com muito menos rupturas. Sem o total, dá a impressão de
  // que o gráfico "não atualizou".
  legenda.textContent = `${soma.toLocaleString('pt-BR')} rupturas · ${porDia.length} dias · média ${media.toFixed(1)}/dia · pico ${pico.rupturas} em ${formatarData(pico.data)}`;

  const L = 900, A = 240, mEsq = 40, mDir = 10, mTopo = 16, mBaixo = 54;
  const util = L - mEsq - mDir;
  const alt = A - mTopo - mBaixo;
  const passo = util / porDia.length;
  const larguraBarra = Math.max(4, Math.min(28, passo * 0.62));

  let grade = '';
  for (let g = 0; g <= 4; g++) {
    const v = (max * g) / 4;
    const yy = mTopo + alt - (v / max) * alt;
    grade += `<line class="g-grade" x1="${mEsq}" y1="${yy}" x2="${L - mDir}" y2="${yy}"/>`;
    grade += `<text class="g-eixo" x="${mEsq - 6}" y="${yy + 4}" text-anchor="end">${Math.round(v)}</text>`;
  }

  // Com muitos dias, mostra o rótulo de data alternado para não embolar.
  const passoRotulo = porDia.length > 16 ? 3 : (porDia.length > 10 ? 2 : 1);
  const barras = porDia.map((d, i) => {
    const h = (d.rupturas / max) * alt;
    const x = mEsq + i * passo + (passo - larguraBarra) / 2;
    const y = mTopo + alt - h;
    const rot = i % passoRotulo === 0
      ? `<text class="g-eixo" x="${x + larguraBarra / 2}" y="${A - mBaixo + 16}" text-anchor="end" transform="rotate(-45 ${x + larguraBarra / 2} ${A - mBaixo + 16})">${formatarData(d.data).slice(0, 5)}</text>`
      : '';
    return `<rect class="g-barra" x="${x}" y="${y}" width="${larguraBarra}" height="${Math.max(1, h)}" rx="2">
        <title>${formatarData(d.data)}: ${d.rupturas} ruptura(s), ${d.pacientes} paciente(s)</title>
      </rect>${rot}`;
  }).join('');

  alvo.innerHTML = `<svg class="grafico-svg" viewBox="0 0 ${L} ${A}" preserveAspectRatio="xMidYMid meet">${grade}${barras}</svg>`;
}

// ---- Gráfico 2: itens que mais romperam (barras horizontais em HTML) ----
function graficoTopRupturas(topItens) {
  const alvo = document.getElementById('graficoTopRupturas');
  if (!topItens || !topItens.length) {
    alvo.innerHTML = '<p class="texto-apoio">Sem dados no período.</p>';
    return;
  }
  const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
  const max = Math.max(...topItens.map((t) => t.rupturas), 1);
  alvo.innerHTML = topItens.map((t) => {
    const pct = (t.rupturas / max) * 100;
    return `<div class="barra-top">
        <div class="barra-top-rotulo" title="${escAttr(t.descricao)}">${escHtml(t.descricao)}</div>
        <div class="barra-top-trilho"><span style="width:${pct.toFixed(1)}%"></span></div>
        <div class="barra-top-valor">${nf(t.rupturas)} <span class="texto-apoio">(${nf(t.pacientes)} pac.)</span></div>
      </div>`;
  }).join('');
}

function renderRupturas(d) {
  // Na primeira carga o servidor devolve o período padrão (30 dias) — só
  // então preenchemos os campos de data, para não sobrescrever depois o que
  // o usuário tiver escolhido.
  const campoIni = document.getElementById('filtroInicioRupturas');
  const campoFim = document.getElementById('filtroFimRupturas');
  if (!campoIni.value) campoIni.value = d.periodo.inicio;
  if (!campoFim.value) campoFim.value = d.periodo.fim;
  estadoRupturas.inicio = d.periodo.inicio;
  estadoRupturas.fim = d.periodo.fim;

  // "Atualizar agora" consulta a API ao vivo e regrava o período — ação de
  // admin. Colaboradores só consultam o que está guardado (botão Carregar).
  const btnAtualizar = document.getElementById('botaoAtualizarRupturas');
  if (btnAtualizar) btnAtualizar.hidden = !(estado.usuario && estado.usuario.perfil === 'admin');

  const nunca = !d.atualizadoEm;
  document.getElementById('conteudoRupturas').hidden = nunca;
  const aviso = document.getElementById('avisoSemRupturas');
  aviso.hidden = !nunca;
  if (nunca) {
    aviso.textContent = d.credenciaisConfiguradas
      ? 'Nenhuma ruptura importada ainda. Use o botão "Atualizar agora" para consultar a API.'
      : 'A integração com a API UDTP ainda não está configurada (falta usuário/senha no .env do servidor). Fale com o administrador.';
    document.getElementById('atualizadoEmRupturas').textContent = '';
    return;
  }

  document.getElementById('atualizadoEmRupturas').textContent =
    'Atualizado em ' + formatarDataHora(d.atualizadoEm);

  const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
  const k = d.kpis || {};
  document.getElementById('kpisRupturas').innerHTML = [
    kpiCard('list', nf(k.totalRupturas), 'Total de linhas', 'ocorrências no período (bate com a API)', k.totalRupturas > 0 ? 'critico' : ''),
    kpiCard('chart', nf(k.quantidadeTotal), 'Quantidade em falta', 'soma do que não foi entregue'),
    kpiCard('relogio', nf(k.pacientes), 'Pacientes impactados', 'pessoas que não levaram o item'),
    kpiCard('doc', nf(k.itens), 'Itens', 'medicamentos/materiais distintos'),
  ].join('');

  // Indicador de linhas na própria aba Lista (o mesmo total dos KPIs), para
  // quem for consultar o relatório saber quantas linhas o período traz.
  const elTotal = document.getElementById('totalLinhasRupturas');
  if (elTotal) {
    elTotal.innerHTML = '<strong>' + nf(k.totalRupturas) + '</strong> linha(s) no período '
      + '<span class="texto-apoio">(' + formatarData(d.periodo.inicio) + ' a ' + formatarData(d.periodo.fim) + ')</span>';
  }

  document.getElementById('quebrasRupturas').innerHTML =
    quebraRupturas('Por categoria', d.porCategoria, 'Categoria', 'categoria', k.pacientes)
    + quebraRupturas('Por tipo de item', d.porTipo, 'Tipo', 'tipo', k.pacientes);

  // Deixa explícito, na aba de indicadores, QUAL recorte está desenhado —
  // os filtros ficam na outra aba, então sem isso o usuário olha o gráfico
  // sem lembrar que há um filtro ativo.
  const rotuloFiltro = (id) => {
    const sel = document.getElementById(id);
    return sel && sel.value ? sel.options[sel.selectedIndex].text : '';
  };
  const recortes = [
    rotuloFiltro('filtroCategoriaRupturas'),
    rotuloFiltro('filtroTipoRupturas'),
    rotuloFiltro('filtroImportadoRupturas'),
    rotuloFiltro('filtroOutrasRupturas'),
  ].filter(Boolean);
  const buscaAtual = document.getElementById('filtroBuscaRupturas').value.trim();
  if (buscaAtual) recortes.push('Busca: "' + buscaAtual + '"');
  const elRecorte = document.getElementById('recorteRupturas');
  elRecorte.innerHTML = '<strong>Recorte:</strong> '
    + formatarData(d.periodo.inicio) + ' a ' + formatarData(d.periodo.fim)
    + (recortes.length
      ? ' · ' + recortes.map((r) => '<span class="tag-recorte">' + escHtml(r) + '</span>').join(' ')
      : ' · <span class="texto-apoio">sem filtros (todos os dados)</span>');

  graficoDiaRupturas(d.porDia);
  graficoTopRupturas(d.topItens);

  // Preenche as opções dos filtros, mantendo a seleção atual.
  const encher = (id, valores, rotulo) => {
    const sel = document.getElementById(id);
    const atual = sel.value;
    sel.innerHTML = '<option value="">' + rotulo + '</option>'
      + valores.map((v) => '<option value="' + escAttr(v) + '">' + escHtml(v) + '</option>').join('');
    if (valores.includes(atual)) sel.value = atual;
  };
  encher('filtroCategoriaRupturas', d.opcoes.categorias || [], 'Categoria: todas');
  encher('filtroTipoRupturas', d.opcoes.tiposItem || [], 'Tipo de item: todos');

  const corpo = document.getElementById('corpoTabelaRupturas');
  corpo.innerHTML = d.linhas.map((l) => '<tr>'
    + '<td class="col-data">' + formatarData(l.data) + '</td>'
    + '<td>' + escHtml(l.descricao) + '</td>'
    + '<td class="col-codigo">' + escHtml(l.codigoItem) + '</td>'
    + '<td><strong>' + nf(l.quantidade) + '</strong></td>'
    + '<td>' + escHtml(l.unidade) + '</td>'
    + '<td>' + escHtml(l.paciente) + '</td>'
    + '<td>' + escHtml(l.protocolo) + '</td>'
    + '<td>' + escHtml(l.categoria) + '</td>'
    + '<td>' + (l.tipoItem ? '<span class="tag-tipo">' + escHtml(l.tipoItem) + '</span>' : '—') + '</td>'
    + '<td>' + escHtml(l.importado) + '</td>'
    + '<td>' + escHtml(l.outrasDemandas) + '</td>'
    + '</tr>').join('');
  document.getElementById('estadoVazioRupturas').hidden = d.linhas.length > 0;
}

// --- abas da tela de Rupturas ---
// Os filtros ficam ACIMA das abas de propósito: valem para as duas, então os
// KPIs e gráficos acompanham o mesmo recorte da lista.
document.querySelectorAll('#abasRupturas .chip-faixa').forEach((btn) => {
  btn.addEventListener('click', () => {
    const aba = btn.dataset.aba;
    document.querySelectorAll('#abasRupturas .chip-faixa')
      .forEach((b) => b.classList.toggle('ativo', b === btn));
    document.getElementById('abaRupturasLista').hidden = aba !== 'lista';
    document.getElementById('abaRupturasIndicadores').hidden = aba !== 'indicadores';
    document.getElementById('abaRupturasCompras').hidden = aba !== 'compras';
    // A aba de compras usa outra consulta (mais pesada, por cruzar os dois
    // fluxos de compra); só busca quando é realmente aberta.
    if (aba === 'compras') {
      carregarComprasRupturas().catch((e) => {
        document.getElementById('corpoComprasRupturas').innerHTML = '';
        const vazio = document.getElementById('estadoVazioComprasRupturas');
        vazio.hidden = false;
        vazio.textContent = 'Não consegui carregar o andamento de compra: ' + e.message;
      });
    }
  });
});

// --- eventos da tela de Rupturas ---
let tempoBuscaRupturas = null;
document.getElementById('filtroBuscaRupturas').addEventListener('input', () => {
  clearTimeout(tempoBuscaRupturas);
  tempoBuscaRupturas = setTimeout(() => {
    buscarRupturas().catch((e) => alert('Erro: ' + e.message));
  }, 300);
});
// Os filtros de refino (categoria/tipo/importado/outras) recarregam na hora.
// As DATAS não: elas só valem quando o usuário clica "Carregar" (cravar período).
['filtroCategoriaRupturas', 'filtroTipoRupturas', 'filtroImportadoRupturas', 'filtroOutrasRupturas'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => {
    buscarRupturas().catch((e) => alert('Erro: ' + e.message));
  });
});
// Botão "Carregar": crava o período informado e busca as rupturas dele.
function carregarPeriodoRupturas() {
  const ini = document.getElementById('filtroInicioRupturas').value;
  const fim = document.getElementById('filtroFimRupturas').value;
  if (ini && fim && ini > fim) { alert('A data inicial não pode ser maior que a data final.'); return; }
  estadoRupturas.inicio = ini || null;
  estadoRupturas.fim = fim || null;
  buscarRupturas().catch((e) => alert('Erro: ' + e.message));
}
document.getElementById('botaoCarregarRupturas').addEventListener('click', carregarPeriodoRupturas);
// Enter dentro dos campos de data também carrega.
['filtroInicioRupturas', 'filtroFimRupturas'].forEach((id) => {
  document.getElementById(id).addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); carregarPeriodoRupturas(); }
  });
});
document.getElementById('botaoLimparFiltrosRupturas').addEventListener('click', () => {
  document.getElementById('filtroBuscaRupturas').value = '';
  ['filtroCategoriaRupturas', 'filtroTipoRupturas', 'filtroImportadoRupturas', 'filtroOutrasRupturas']
    .forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('filtroInicioRupturas').value = '';
  document.getElementById('filtroFimRupturas').value = '';
  // Volta ao período padrão (últimos 30 dias) na próxima busca.
  estadoRupturas.inicio = null;
  estadoRupturas.fim = null;
  buscarRupturas().catch((e) => alert('Erro: ' + e.message));
});
document.getElementById('botaoExportarRupturas').addEventListener('click', () => {
  window.location.href = '/api/rupturas/csv?' + paramsRupturas().toString();
});
document.getElementById('botaoAtualizarRupturas').addEventListener('click', async () => {
  const botao = document.getElementById('botaoAtualizarRupturas');
  const txt = botao.textContent;
  botao.disabled = true;
  botao.textContent = '⏳ Consultando a API…';
  try {
    // Reimporta EXATAMENTE o período CRAVADO no relatório (o que foi carregado).
    // Assim as pontas antigas — fora da janela móvel dos últimos 30 dias —
    // também se atualizam e o total armazenado passa a bater com a API ao vivo.
    const corpo = (estadoRupturas.inicio && estadoRupturas.fim)
      ? { inicio: estadoRupturas.inicio, fim: estadoRupturas.fim } : {};
    const r = await api('/rupturas/importar-agora', { method: 'POST', body: JSON.stringify(corpo) });
    alert('Rupturas atualizadas: ' + r.totalRegistros + ' ocorrência(s) de '
      + formatarData(r.periodoInicio) + ' a ' + formatarData(r.periodoFim)
      + '.\n\n' + r.pacientes + ' paciente(s) e ' + r.itens + ' item(ns) impactados.');
    await buscarRupturas();
  } catch (e) {
    alert('Não foi possível atualizar as rupturas.\n\n' + e.message);
  } finally {
    botao.disabled = false;
    botao.textContent = txt;
  }
});

// ---- Aba "Andamento de compra" dos itens que romperam ----
// Responde à pergunta que a lista de rupturas não responde: o item que faltou
// para o paciente está sendo comprado? Olha os DOIS fluxos (Tenente Pena e
// Outras Demandas), porque o mesmo item pode ser comprado por qualquer um.
let comprasRupturasCache = [];      // lista COMPLETA vinda do servidor
let situacaoComprasRupturas = '';
let faixaComprasRupturas = '';      // faixa de autonomia clicada no gráfico
let limiarAutonomiaRupturas = 2;
let dataEstoqueRupturas = null;
let faixasAutonomiaRupturas = [];

// Realce da autonomia na tabela, coerente com a regra que esconde itens:
//   0            -> crítico (segue em falta total)
//   abaixo do limiar -> alerta (tem estoque, mas rompe de novo em breve)
//   >= limiar    -> ok (só aparece se "incluir normalizados" estiver marcado)
function seloAutonomiaRuptura(valor) {
  const a = Number(valor) || 0;
  const txt = a.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' m';
  if (a <= 0) return '<span class="selo-situacao critico">0</span>';
  if (a < limiarAutonomiaRupturas) return '<span class="selo-situacao alerta">' + txt + '</span>';
  return '<span class="selo-situacao ok">' + txt + '</span>';
}

const ROTULO_SITUACAO = {
  aberta: { texto: 'Compra em andamento', classe: 'ok' },
  semAberta: { texto: 'Sem compra em aberto', classe: 'alerta' },
  nunca: { texto: 'Nunca comprado', classe: 'critico' },
};

async function carregarComprasRupturas() {
  const d = await api('/rupturas/compras?' + paramsRupturas().toString());
  comprasRupturasCache = d.itens || [];       // lista completa
  limiarAutonomiaRupturas = Number(d.limiarAutonomia) || 2;
  dataEstoqueRupturas = d.dataEstoque || null;
  faixasAutonomiaRupturas = d.faixas || [];
  desenharGraficoAutonomiaRupturas();
  desenharComprasRupturas();
}

// Lista efetivamente mostrada, aplicando (nesta ordem):
//   1. faixa clicada no gráfico — se houver, MANDA e ignora a regra de esconder
//      (o usuário pediu explicitamente aquela faixa, mesmo a 2+);
//   2. senão, a regra de negócio: esconde os já normalizados (autonomia ≥
//      limiar), a menos que "Incluir itens já normalizados" esteja marcado;
//   3. o filtro de situação de compra (Nunca / Sem aberto / Em andamento).
function listaComprasFiltrada() {
  let lista = comprasRupturasCache;
  if (faixaComprasRupturas) {
    lista = lista.filter((i) => i.faixaAutonomia === faixaComprasRupturas);
  } else if (!document.getElementById('incluirNormalizadosRupturas').checked) {
    lista = lista.filter((i) => Number(i.autonomiaHoje) < limiarAutonomiaRupturas);
  }
  if (situacaoComprasRupturas) lista = lista.filter((i) => i.situacao === situacaoComprasRupturas);
  return lista;
}

// Gráfico de barras horizontais das faixas de autonomia. Cada barra é um botão.
function desenharGraficoAutonomiaRupturas() {
  const alvo = document.getElementById('graficoAutonomiaRupturas');
  if (!faixasAutonomiaRupturas.length) { alvo.innerHTML = '<p class="texto-apoio">Sem dados no período.</p>'; return; }
  const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
  const max = Math.max(...faixasAutonomiaRupturas.map((f) => f.itens), 1);
  alvo.innerHTML = faixasAutonomiaRupturas.map((f) => {
    const pct = (f.itens / max) * 100;
    const ativa = f.chave === faixaComprasRupturas;
    return '<button type="button" class="barra-faixa-aut' + (ativa ? ' ativa' : '')
      + '" data-faixa="' + escAttr(f.chave) + '"'
      + ' title="' + escAttr(f.rotulo + ' — ' + f.itens + ' itens, ' + f.pacientes + ' pacientes') + '">'
      + '<span class="barra-faixa-rotulo">' + escHtml(f.rotulo)
        + (f.normalizada ? ' <span class="texto-apoio">(reposto)</span>' : '') + '</span>'
      + '<span class="barra-faixa-trilho"><span style="width:' + pct.toFixed(1) + '%"></span></span>'
      + '<span class="barra-faixa-valor">' + nf(f.itens) + ' <span class="texto-apoio">itens · '
        + nf(f.pacientes) + ' pac.</span></span>'
      + '</button>';
  }).join('');
  alvo.querySelectorAll('.barra-faixa-aut').forEach((b) => {
    b.addEventListener('click', () => {
      // clicar de novo na mesma faixa desliga o filtro
      faixaComprasRupturas = (faixaComprasRupturas === b.dataset.faixa) ? '' : b.dataset.faixa;
      desenharGraficoAutonomiaRupturas();
      desenharComprasRupturas();
    });
  });
}

function desenharComprasRupturas() {
  const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
  const lista = listaComprasFiltrada();

  // KPIs de situação — refletem a lista atual SEM o filtro de situação (senão
  // clicar "Nunca comprado" zeraria os outros dois cartões).
  const baseKpi = faixaComprasRupturas
    ? comprasRupturasCache.filter((i) => i.faixaAutonomia === faixaComprasRupturas)
    : (document.getElementById('incluirNormalizadosRupturas').checked
        ? comprasRupturasCache
        : comprasRupturasCache.filter((i) => Number(i.autonomiaHoje) < limiarAutonomiaRupturas));
  const soma = (sit) => baseKpi.filter((i) => i.situacao === sit)
    .reduce((a, i) => ({ itens: a.itens + 1, pac: a.pac + i.pacientes }), { itens: 0, pac: 0 });
  const kn = soma('nunca'); const ks = soma('semAberta'); const ka = soma('aberta');
  document.getElementById('resumoComprasRupturas').innerHTML = [
    kpiCard('doc', nf(kn.itens), 'Nunca comprado', nf(kn.pac) + ' pacientes · sem registro de compra', 'critico'),
    kpiCard('list', nf(ks.itens), 'Sem compra em aberto', nf(ks.pac) + ' pacientes · já comprado antes', 'alerta'),
    kpiCard('chart', nf(ka.itens), 'Compra em andamento', nf(ka.pac) + ' pacientes · processo em curso'),
  ].join('');

  // Aviso sobre os itens normalizados / faixa selecionada.
  const aviso = document.getElementById('avisoNormalizadosRupturas');
  const norm = faixasAutonomiaRupturas.filter((f) => f.normalizada).reduce((s, f) => s + f.itens, 0);
  const lim = limiarAutonomiaRupturas.toLocaleString('pt-BR');
  const dataTxt = dataEstoqueRupturas ? formatarData(dataEstoqueRupturas) : '—';
  if (faixaComprasRupturas) {
    const f = faixasAutonomiaRupturas.find((x) => x.chave === faixaComprasRupturas);
    aviso.hidden = false;
    aviso.innerHTML = '<strong>Filtrando pela faixa:</strong> ' + escHtml(f ? f.rotulo : faixaComprasRupturas)
      + ' — ' + lista.length + ' item(ns). Clique na faixa de novo (ou aqui) para limpar. '
      + '<a href="#" id="limparFaixaAut">Limpar filtro</a>';
    document.getElementById('limparFaixaAut').addEventListener('click', (e) => {
      e.preventDefault(); faixaComprasRupturas = '';
      desenharGraficoAutonomiaRupturas(); desenharComprasRupturas();
    });
  } else if (norm && !document.getElementById('incluirNormalizadosRupturas').checked) {
    aviso.hidden = false;
    aviso.innerHTML = '<strong>' + norm + ' item(ns) fora da lista</strong> — romperam no período, '
      + 'mas já têm autonomia de ' + lim + ' meses ou mais na foto de ' + dataTxt + ' (estoque reposto). '
      + 'Marque "Incluir itens já normalizados" ou clique na faixa "2 meses ou mais" para vê-los.';
  } else {
    aviso.hidden = true;
  }

  document.getElementById('corpoComprasRupturas').innerHTML = lista.map((i) => {
    const s = ROTULO_SITUACAO[i.situacao] || ROTULO_SITUACAO.nunca;
    const detalhe = i.statusAtual
      ? ' <span class="texto-apoio">' + escHtml(i.fluxoAtual) + ' · ' + escHtml(i.statusAtual) + '</span>'
      : '';
    return '<tr>'
      + '<td>' + escHtml(i.descricao) + '</td>'
      + '<td class="col-codigo">' + escHtml(i.codigoItem) + '</td>'
      + '<td>' + escHtml(i.categoria || '—') + '</td>'
      + '<td>' + nf(i.rupturas) + '</td>'
      + '<td><strong>' + nf(i.pacientes) + '</strong></td>'
      + '<td>' + seloAutonomiaRuptura(i.autonomiaHoje) + '</td>'
      + '<td><span class="selo-situacao ' + s.classe + '">' + s.texto + '</span>' + detalhe + '</td>'
      + '<td>' + escHtml(i.ultimaCompra || '—') + '</td>'
      + '<td><button type="button" class="botao-secundario botao-ver-compra" data-codigo="'
        + escAttr(i.codigoItem) + '">Ver</button></td>'
      + '</tr>';
  }).join('');
  document.getElementById('estadoVazioComprasRupturas').hidden = lista.length > 0;

  document.querySelectorAll('.botao-ver-compra').forEach((b) => {
    b.addEventListener('click', () => abrirCompraRuptura(b.dataset.codigo));
  });
}

async function abrirCompraRuptura(codigo) {
  const corpo = document.getElementById('conteudoCompraRuptura');
  document.getElementById('tituloCompraRuptura').textContent = 'Andamento de compra';
  document.getElementById('codigoCompraRuptura').textContent = codigo;
  corpo.innerHTML = '<p class="texto-apoio">Carregando…</p>';
  document.getElementById('modalCompraRuptura').hidden = false;

  try {
    const p = paramsRupturas();
    p.set('codigo', codigo);
    const d = await api('/rupturas/compras/detalhe?' + p.toString());
    const it = d.item || {};
    document.getElementById('tituloCompraRuptura').textContent = it.descricao || codigo;
    document.getElementById('codigoCompraRuptura').textContent = codigo
      + (it.categoria ? ' · ' + it.categoria : '') + (it.tipoItem ? ' · ' + it.tipoItem : '');
    corpo.innerHTML = montarDetalheCompraRuptura(d);
  } catch (e) {
    corpo.innerHTML = '<p class="texto-vermelho">Não consegui carregar o andamento: ' + escHtml(e.message) + '</p>';
  }
}

function montarDetalheCompraRuptura(d) {
  const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
  const it = d.item || {};
  const est = d.estoque || {};

  let html = '<div class="grade-resumo">'
    + kpiCard('list', nf(it.rupturas), 'Rupturas', 'no período filtrado', 'critico')
    + kpiCard('relogio', nf(it.pacientes), 'Pacientes', 'não levaram o item')
    + kpiCard('chart', nf(est.estoque), 'Estoque', d.dataEstoque ? 'foto de ' + formatarData(d.dataEstoque) : 'sem foto')
    + kpiCard('doc', est.autonomia == null ? '—' : nf(est.autonomia), 'Autonomia', 'meses de cobertura')
    + '</div>';

  // Andamento de compra. O FOCO é a compra em aberto (Planejamento, Adjudicado,
  // Empenhado, Entrega Parcial) — é o que responde "está sendo comprado?". O
  // restante (Finalizado, Cancelado, etc.) vira histórico recolhível, para não
  // roubar a atenção mas continuar acessível.
  const STATUS_ABERTO = ['Planejamento', 'Adjudicado', 'Empenhado', 'Entrega Parcial'];
  const abertas = d.compras.filter((c) => STATUS_ABERTO.includes(c.status));
  const encerradas = d.compras.filter((c) => !STATUS_ABERTO.includes(c.status));

  const tabelaCompras = (linhas) => '<div class="lista-rolavel"><table><thead><tr>'
    + '<th>Fluxo</th><th>Competência</th><th>Status</th><th>Ofício</th><th>Empenho</th>'
    + '<th>Solicitado</th><th>Entregue</th><th>Pendente</th><th>Previsão</th></tr></thead><tbody>'
    + linhas.map((c) => {
      const classe = classeStatus(c.status, c.data_previsao_entrega);
      const rotulo = rotuloStatus(c.status, c.data_previsao_entrega);
      return '<tr>'
        + '<td><span class="tag-tipo">' + escHtml(c.fluxo) + '</span></td>'
        + '<td>' + escHtml(c.mes || '') + '/' + escHtml(c.ano || '') + '</td>'
        + '<td><span class="etiqueta-status ' + classe + '">' + escHtml(rotulo) + '</span></td>'
        + '<td>' + escHtml(c.n_oficio || '—') + '</td>'
        + '<td>' + escHtml(c.n_empenho || '—') + '</td>'
        + '<td>' + nf(c.qtde_solicitada) + '</td>'
        + '<td>' + nf(c.qtde_entregue) + '</td>'
        + '<td>' + nf(c.qtde_pendente) + '</td>'
        + '<td class="col-data">' + (c.data_previsao_entrega ? formatarData(c.data_previsao_entrega) : '—') + '</td>'
        + '</tr>';
    }).join('')
    + '</tbody></table></div>';

  html += '<h4>Compra em andamento <span class="texto-apoio">(' + abertas.length + ' em aberto)</span></h4>';
  if (!d.compras.length) {
    html += '<p class="texto-apoio">Nenhuma compra registrada para este item, em nenhum dos dois fluxos '
      + '(Tenente Pena e Outras Demandas). Vale conferir se ele é adquirido por outra via '
      + 'ou se está faltando cadastro.</p>';
  } else if (!abertas.length) {
    html += '<p class="texto-apoio">Nenhuma compra em aberto agora — todas as ' + encerradas.length
      + ' registrada(s) já estão encerradas (Finalizado, Cancelado, etc.). Veja o histórico abaixo.</p>';
  } else {
    html += tabelaCompras(abertas);
  }

  // Histórico completo (encerradas), recolhido por padrão.
  if (encerradas.length) {
    html += '<details class="detalhe-historico"><summary>Ver histórico completo ('
      + encerradas.length + ' compra(s) encerrada(s))</summary>'
      + tabelaCompras(encerradas) + '</details>';
  }

  // Quem ficou sem o item.
  html += '<h4>Pacientes que ficaram sem <span class="texto-apoio">(' + d.rupturas.length + ' ocorrência(s))</span></h4>'
    + '<div class="lista-rolavel"><table><thead><tr><th>Data</th><th>Paciente</th><th>Protocolo</th><th>Qtde em falta</th></tr></thead><tbody>'
    + d.rupturas.map((r) => '<tr>'
      + '<td class="col-data">' + formatarData(r.data) + '</td>'
      + '<td>' + escHtml(r.paciente || '—') + '</td>'
      + '<td>' + escHtml(r.protocolo || '—') + '</td>'
      + '<td>' + nf(r.quantidade) + '</td>'
      + '</tr>').join('')
    + '</tbody></table></div>';

  return html;
}

function fecharCompraRuptura() {
  document.getElementById('modalCompraRuptura').hidden = true;
}
document.getElementById('botaoFecharCompraRuptura').addEventListener('click', fecharCompraRuptura);
document.getElementById('modalCompraRuptura').addEventListener('click', (e) => {
  if (e.target.id === 'modalCompraRuptura') fecharCompraRuptura();
});

document.getElementById('incluirNormalizadosRupturas').addEventListener('change', () => {
  // A lista completa já está em memória; é só redesenhar (sem nova ida ao servidor).
  desenharComprasRupturas();
});

document.querySelectorAll('#situacaoComprasRupturas .chip-faixa').forEach((btn) => {
  btn.addEventListener('click', () => {
    situacaoComprasRupturas = btn.dataset.situacao || '';
    document.querySelectorAll('#situacaoComprasRupturas .chip-faixa')
      .forEach((b) => b.classList.toggle('ativo', b === btn));
    desenharComprasRupturas();
  });
});

// ==================== Comparativo: modal do paciente novo + envio ====================
// Ao clicar numa linha de "Pacientes Novos", mostra o andamento de compra
// daquele item: demanda, consumo total, estoque, autonomia e as compras em
// aberto (Tenente Pena + Outras Demandas).
async function abrirPacienteNovo(codigo, protocolo, descricao) {
  const corpo = document.getElementById('conteudoPacienteNovo');
  document.getElementById('tituloPacienteNovo').textContent = descricao || 'Detalhe do item';
  document.getElementById('codigoPacienteNovo').textContent = codigo || '';
  corpo.innerHTML = '<p class="texto-apoio">Carregando…</p>';
  document.getElementById('modalPacienteNovo').hidden = false;

  try {
    const p = new URLSearchParams({ codigo });
    if (protocolo) p.set('protocolo', protocolo);
    const d = await api('/autores/comparacao/item-detalhe?' + p.toString());
    corpo.innerHTML = montarDetalhePacienteNovo(d);
  } catch (e) {
    corpo.innerHTML = '<p class="texto-vermelho">Não consegui carregar o detalhe: ' + escHtml(e.message) + '</p>';
  }
}

function montarDetalhePacienteNovo(d) {
  const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
  const est = d.estoque || {};
  const dem = d.demanda || {};

  let html = '<div class="grade-resumo">'
    + kpiCard('chart', est.estoque == null ? '—' : nf(est.estoque), 'Estoque',
        d.dataEstoque ? 'foto de ' + formatarData(d.dataEstoque) : 'sem foto',
        Number(est.estoque) <= 0 ? 'critico' : '')
    + kpiCard('doc', est.autonomia == null ? '—' : nf(est.autonomia), 'Autonomia', 'meses de cobertura',
        (est.autonomia != null && Number(est.autonomia) < limiarAutonomiaRupturas) ? 'alerta' : '')
    + kpiCard('list', est.consumoMensalTotal == null ? '—' : nf(Math.round(Number(est.consumoMensalTotal))), 'Consumo mensal total', 'do relatório de estoque')
    + kpiCard('relogio', est.demandas == null ? '—' : nf(est.demandas), 'Demanda', 'no estoque')
    + '</div>';

  // Informação de demanda do paciente/item.
  if (dem && (dem.tipo_demanda || dem.status_demanda || dem.qtde_consumo)) {
    html += '<h4>Demanda</h4><div class="lista-rolavel"><table><tbody>'
      + '<tr><th>Tipo da demanda</th><td>' + escHtml(dem.tipo_demanda || '—') + '</td></tr>'
      + '<tr><th>Status da demanda</th><td>' + escHtml(dem.status_demanda || '—') + '</td></tr>'
      + '<tr><th>Status do item</th><td>' + escHtml(dem.status_item || '—') + '</td></tr>'
      + '<tr><th>Consumo (autor)</th><td>' + escHtml(dem.qtde_consumo || '—') + '</td></tr>'
      + '<tr><th>Dispensações</th><td>' + escHtml(dem.dispensacoes || '—') + '</td></tr>'
      + '<tr><th>Periodicidade</th><td>' + escHtml(dem.periodicidade || '—') + '</td></tr>'
      + '</tbody></table></div>';
  }

  // Compras em aberto (foco), nos dois fluxos.
  html += '<h4>Compra em andamento <span class="texto-apoio">(' + d.compras.length + ' em aberto)</span></h4>';
  if (!d.compras.length) {
    html += '<p class="texto-apoio">Nenhuma compra em aberto para este item nos dois fluxos '
      + '(Tenente Pena e Outras Demandas).</p>';
  } else {
    html += '<div class="lista-rolavel"><table><thead><tr>'
      + '<th>Fluxo</th><th>Competência</th><th>Status</th><th>Ofício</th><th>Empenho</th>'
      + '<th>Solicitado</th><th>Entregue</th><th>Pendente</th><th>Previsão</th></tr></thead><tbody>'
      + d.compras.map((c) => {
        const classe = classeStatus(c.status, c.data_previsao_entrega);
        const rotulo = rotuloStatus(c.status, c.data_previsao_entrega);
        return '<tr>'
          + '<td><span class="tag-tipo">' + escHtml(c.fluxo) + '</span></td>'
          + '<td>' + escHtml(c.mes || '') + '/' + escHtml(c.ano || '') + '</td>'
          + '<td><span class="etiqueta-status ' + classe + '">' + escHtml(rotulo) + '</span></td>'
          + '<td>' + escHtml(c.n_oficio || '—') + '</td>'
          + '<td>' + escHtml(c.n_empenho || '—') + '</td>'
          + '<td>' + nf(c.qtde_solicitada) + '</td>'
          + '<td>' + nf(c.qtde_entregue) + '</td>'
          + '<td>' + nf(c.qtde_pendente) + '</td>'
          + '<td class="col-data">' + (c.data_previsao_entrega ? formatarData(c.data_previsao_entrega) : '—') + '</td>'
          + '</tr>';
      }).join('')
      + '</tbody></table></div>';
  }
  return html;
}

function fecharPacienteNovo() { document.getElementById('modalPacienteNovo').hidden = true; }
document.getElementById('botaoFecharPacienteNovo').addEventListener('click', fecharPacienteNovo);
document.getElementById('modalPacienteNovo').addEventListener('click', (e) => {
  if (e.target.id === 'modalPacienteNovo') fecharPacienteNovo();
});

// ---- Enviar relatório por e-mail ----
document.getElementById('botaoEnviarRelatorioComparativo').addEventListener('click', () => {
  if (!dadosComparativo || !dadosComparativo.temAnterior) {
    alert('Ainda não há comparativo para enviar.');
    return;
  }
  const campo = document.getElementById('emailDestinoRelatorio');
  if (!campo.value) campo.value = dadosComparativo.emailPadrao || '';
  document.getElementById('avisoEnviarRelatorio').hidden = true;
  document.getElementById('modalEnviarRelatorio').hidden = false;
  campo.focus();
});
function fecharEnviarRelatorio() { document.getElementById('modalEnviarRelatorio').hidden = true; }
document.getElementById('botaoCancelarEnviarRelatorio').addEventListener('click', fecharEnviarRelatorio);
document.getElementById('modalEnviarRelatorio').addEventListener('click', (e) => {
  if (e.target.id === 'modalEnviarRelatorio') fecharEnviarRelatorio();
});

document.getElementById('botaoConfirmarEnviarRelatorio').addEventListener('click', async () => {
  const botao = document.getElementById('botaoConfirmarEnviarRelatorio');
  const aviso = document.getElementById('avisoEnviarRelatorio');
  const para = document.getElementById('emailDestinoRelatorio').value.trim();
  if (!para) {
    aviso.hidden = false;
    aviso.innerHTML = '<strong>Informe ao menos um e-mail de destino.</strong>';
    return;
  }
  botao.disabled = true;
  const txt = botao.textContent;
  botao.textContent = 'Enviando…';
  aviso.hidden = true;
  try {
    const r = await api('/autores/comparacao/enviar-relatorio', {
      method: 'POST', body: JSON.stringify({ para }),
    });
    fecharEnviarRelatorio();
    alert('Relatório enviado para ' + r.destinatarios.join(', ') + '.\n\n'
      + r.novos + ' pacientes novos, ' + r.inativos + ' inativos e ' + r.alteracoes + ' alterações.');
  } catch (e) {
    aviso.hidden = false;
    aviso.innerHTML = '<strong>Não foi possível enviar:</strong> ' + escHtml(e.message);
  } finally {
    botao.disabled = false;
    botao.textContent = txt;
  }
});


// ==================== Status dos Serviços (admin) ====================
// Tela de operação: mostra a saúde dos vigias, agendadores e backup.
// Atualiza sozinha a cada 30s por polling, trocando SÓ as linhas que
// mudaram (a página inteira não recarrega).

const estadoServicos = {
  linhas: [],
  aba: 'servicos',
  ordem: { campo: 'nome', desc: false },
  timer: null,
  executando: new Set(),   // ids com "Executar agora" em curso
  gavetaId: null,          // serviço aberto no painel lateral
  assinaturas: new Map(),  // id -> retrato do estado, para detectar mudança
};

// As datas dos serviços são gravadas em horário LOCAL (ver registroServicos.js),
// diferente das tabelas antigas que gravam em UTC. Por isso este formatador
// próprio: usar formatarDataHora() aqui mostraria 3 horas a mais.
function dataHoraServico(texto) {
  if (!texto) return '—';
  const m = String(texto).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return texto;
  return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
}

function duracaoServico(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const min = Math.floor(s / 60);
  return `${min} min ${Math.round(s % 60)} s`;
}

function numeroServico(n) {
  return (n === null || n === undefined) ? '—' : n.toLocaleString('pt-BR');
}

function seloSituacao(l) {
  return `<span class="selo-servico ${l.situacao}">${escaparHtml(l.situacaoRotulo)}</span>`;
}

function escaparHtml(t) {
  return String(t === null || t === undefined ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function carregarStatusServicos({ silencioso = false } = {}) {
  try {
    const d = await api('/servicos');
    estadoServicos.linhas = d.servicos || [];
    document.getElementById('atualizadoEmServicos').textContent =
      'Atualizado em: ' + dataHoraServico(d.atualizadoEm);
    montarCartoesServicos(d.indicadores, d.recursos);
    montarAlertasServicos(d.alertas || []);
    montarFiltrosServicos();
    renderizarTabelaServicos({ animarMudancas: silencioso });
    atualizarBadgeServicos(d.alertas || []);
    if (estadoServicos.gavetaId && !silencioso) abrirGavetaServico(estadoServicos.gavetaId);
  } catch (e) {
    if (!silencioso) mostrarErroPagina('paginaStatusServicos', 'Erro ao carregar o status: ' + e.message);
  }
}

// Marcador no menu lateral: quantos problemas existem agora.
function atualizarBadgeServicos(alertas) {
  const badge = document.getElementById('badgeServicos');
  if (!badge) return;
  const criticos = alertas.filter((a) => a.nivel === 'critico').length;
  badge.textContent = criticos;
  badge.hidden = criticos === 0;
}

function montarCartoesServicos(ind, rec) {
  // Disponibilidade e tempo médio só aparecem com histórico real. Sem dado,
  // mostramos "sem histórico" em vez de inventar um número.
  const disp = ind.disponibilidade === null
    ? '<span class="sem-dado">sem histórico</span>'
    : `<span class="valor">${ind.disponibilidade.toFixed(2).replace('.', ',')}%</span>`;
  const tempo = ind.tempoMedioMs === null
    ? '<span class="sem-dado">sem histórico</span>'
    : `<span class="valor">${duracaoServico(ind.tempoMedioMs)}</span>`;

  const cartoes = [
    { cls: 'ok', icone: '✅', valor: ind.ativos, rotulo: 'Serviços ativos' },
    { cls: 'info', icone: '⏳', valor: ind.executando, rotulo: 'Em execução' },
    { cls: 'aviso', icone: '⚠️', valor: ind.atencao, rotulo: 'Com alerta' },
    { cls: 'erro', icone: '⛔', valor: ind.erro, rotulo: 'Com erro' },
    { cls: 'neutro', icone: '⏸️', valor: ind.desabilitados, rotulo: 'Desabilitados' },
    { cls: 'ok', icone: '📈', html: disp, rotulo: 'Disponibilidade (30 dias)' },
    { cls: 'info', icone: '⏱️', html: tempo, rotulo: 'Tempo médio de execução' },
    { cls: 'neutro', icone: '💾', html: `<span class="valor">${rec.memoriaMB} MB</span>`, rotulo: 'Memória do sistema' },
  ];

  document.getElementById('cartoesServicos').innerHTML = cartoes.map((c) => `
    <div class="cartao-servico ${c.cls}">
      <span class="icone">${c.icone}</span>
      ${c.html || `<span class="valor">${c.valor}</span>`}
      <span class="rotulo">${c.rotulo}</span>
    </div>`).join('');
}

function montarAlertasServicos(alertas) {
  const caixa = document.getElementById('alertasServicos');
  if (!alertas.length) { caixa.hidden = true; caixa.innerHTML = ''; return; }
  caixa.hidden = false;
  caixa.innerHTML = alertas.map((a) => `
    <div class="alerta-servico ${a.nivel}">
      <span class="marca">${a.nivel === 'critico' ? '🔴' : '🟠'}</span>
      <span>${escaparHtml(a.texto)}</span>
      <button type="button" data-ver-servico="${a.servico}">Ver detalhes</button>
    </div>`).join('');
}

function montarFiltrosServicos() {
  const selSit = document.getElementById('filtroSituacaoServicos');
  const selCat = document.getElementById('filtroCategoriaServicos');
  const selHist = document.getElementById('filtroServicoHistorico');
  if (selSit.options.length <= 1) {
    const situacoes = [...new Set(estadoServicos.linhas.map((l) => l.situacaoRotulo))].sort();
    situacoes.forEach((s) => selSit.add(new Option('Status: ' + s, s)));
    const cats = [...new Set(estadoServicos.linhas.map((l) => l.categoria))].sort();
    cats.forEach((c) => selCat.add(new Option('Categoria: ' + c, c)));
    estadoServicos.linhas.forEach((l) => selHist.add(new Option(l.nome, l.id)));
  }
}

function servicosFiltrados() {
  const busca = normalizarBusca(document.getElementById('filtroBuscaServicos').value);
  const sit = document.getElementById('filtroSituacaoServicos').value;
  const cat = document.getElementById('filtroCategoriaServicos').value;
  let lista = estadoServicos.linhas.filter((l) => {
    if (sit && l.situacaoRotulo !== sit) return false;
    if (cat && l.categoria !== cat) return false;
    if (busca && !normalizarBusca(l.nome + ' ' + l.descricao).includes(busca)) return false;
    return true;
  });
  const { campo, desc } = estadoServicos.ordem;
  lista = lista.slice().sort((a, b) => {
    const va = a[campo], vb = b[campo];
    if (va === null || va === undefined) return 1;   // vazios sempre no fim
    if (vb === null || vb === undefined) return -1;
    const r = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb), 'pt-BR');
    return desc ? -r : r;
  });
  return lista;
}

// Retrato do que é visível na linha. Se mudar entre dois polls, a linha pisca.
function assinaturaLinha(l) {
  return [l.situacao, l.ultimaExecucao, l.ultimaMensagem, l.ultimosRegistros, l.ultimaDuracaoMs].join('|');
}

function renderizarTabelaServicos({ animarMudancas = false } = {}) {
  const lista = servicosFiltrados();
  const corpo = document.getElementById('corpoTabelaServicos');
  document.getElementById('estadoVazioServicos').hidden = lista.length > 0;

  corpo.innerHTML = lista.map((l) => {
    const rodando = estadoServicos.executando.has(l.id);
    const mudou = animarMudancas && estadoServicos.assinaturas.has(l.id)
      && estadoServicos.assinaturas.get(l.id) !== assinaturaLinha(l);
    return `
      <tr data-servico="${l.id}" class="${mudou ? 'linha-atualizada' : ''}">
        <td>
          <div class="nome-servico">${escaparHtml(l.nome)}</div>
          <div class="desc-servico">${escaparHtml(l.descricao)}</div>
        </td>
        <td>${escaparHtml(l.categoria)}</td>
        <td>${rodando ? '<span class="selo-servico executando">Executando</span>' : seloSituacao(l)}</td>
        <td>${dataHoraServico(l.ultimaExecucao)}</td>
        <td>${dataHoraServico(l.proximaExecucao)}</td>
        <td class="numero">${duracaoServico(l.ultimaDuracaoMs)}</td>
        <td class="numero">${numeroServico(l.ultimosRegistros)}</td>
        <td><div class="msg-servico">${escaparHtml(l.ultimaMensagem || '—')}</div></td>
        <td>
          <div class="botoes-acao-servico">
            <button type="button" class="botao-acao-mini" data-executar="${l.id}"
              ${rodando || !l.habilitado ? 'disabled' : ''}
              title="${l.habilitado ? 'Dispara o serviço agora' : 'Serviço desativado no .env'}">
              ${rodando ? '⏳' : '▶'} Executar
            </button>
            <button type="button" class="botao-acao-mini" data-detalhe="${l.id}">📄 Detalhes</button>
          </div>
        </td>
      </tr>`;
  }).join('');

  estadoServicos.assinaturas = new Map(estadoServicos.linhas.map((l) => [l.id, assinaturaLinha(l)]));
  atualizarSetasOrdem();
}

function atualizarSetasOrdem() {
  document.querySelectorAll('#paginaStatusServicos th.ordenavel').forEach((th) => {
    const ativa = th.dataset.ordem === estadoServicos.ordem.campo;
    th.querySelector('.seta')?.remove();
    if (ativa) {
      const s = document.createElement('span');
      s.className = 'seta';
      s.textContent = estadoServicos.ordem.desc ? '▼' : '▲';
      th.appendChild(s);
    }
  });
}

// --- Executar agora ---
async function executarServico(id) {
  const l = estadoServicos.linhas.find((x) => x.id === id);
  if (!l) return;
  if (!confirm(`Executar agora "${l.nome}"?\n\nO serviço vai rodar imediatamente, fora do horário programado.`)) return;

  estadoServicos.executando.add(id);
  renderizarTabelaServicos();
  try {
    const r = await api(`/servicos/${encodeURIComponent(id)}/executar`, { method: 'POST' });
    alert(r.mensagem || 'Execução concluída.');
  } catch (e) {
    alert('Falha ao executar: ' + e.message);
  } finally {
    estadoServicos.executando.delete(id);
    await carregarStatusServicos();
  }
}

// --- Painel lateral de detalhes ---
async function abrirGavetaServico(id) {
  estadoServicos.gavetaId = id;
  const fundo = document.getElementById('gavetaServico');
  fundo.hidden = false;
  const corpo = document.getElementById('gavetaServicoCorpo');
  corpo.innerHTML = '<p class="gaveta-sub">Carregando…</p>';

  try {
    const d = await api(`/servicos/${encodeURIComponent(id)}/detalhe`);
    document.getElementById('gavetaServicoTitulo').textContent = d.nome;
    document.getElementById('gavetaServicoDescricao').textContent = d.descricao;

    const btnExec = document.getElementById('botaoExecutarDaGaveta');
    btnExec.hidden = !d.podeExecutar;
    btnExec.disabled = !d.habilitado || estadoServicos.executando.has(id);
    btnExec.title = d.habilitado ? '' : 'Serviço desativado no .env';

    const campo = (rot, val, largo) =>
      `<div class="gaveta-campo ${largo ? 'largo' : ''}"><span class="rotulo">${rot}</span><span class="valor">${val}</span></div>`;

    const disp = d.disponibilidade === null
      ? '<span style="color:var(--cinza-texto)">sem histórico ainda</span>'
      : d.disponibilidade.toFixed(2).replace('.', ',') + '%';

    corpo.innerHTML = `
      <div class="gaveta-secao">
        <h4>Situação</h4>
        <div class="gaveta-campos">
          ${campo('Status atual', seloSituacao(d))}
          ${campo('Categoria', escaparHtml(d.categoria))}
          ${campo('Agendamento', escaparHtml(d.agendamento), true)}
          ${campo('Versão do sistema', escaparHtml(d.versao || '—'))}
          ${campo('Ativo na configuração', d.habilitado ? 'Sim' : 'Não (desligado no .env)')}
        </div>
      </div>

      <div class="gaveta-secao">
        <h4>Última execução</h4>
        <div class="gaveta-campos">
          ${campo('Quando', dataHoraServico(d.ultimaExecucao))}
          ${campo('Resultado', d.ultimoResultado === 'erro' ? '<span style="color:var(--vermelho)">Erro</span>'
            : d.ultimoResultado ? '<span style="color:var(--verde-ok)">Sucesso</span>' : '—')}
          ${campo('Duração', duracaoServico(d.ultimaDuracaoMs))}
          ${campo('Registros processados', numeroServico(d.ultimosRegistros))}
          ${campo('Origem processada', escaparHtml(d.ultimoArquivo || '—'), true)}
          ${campo('Disparado por', escaparHtml((d.ultimaExecucaoCompleta && d.ultimaExecucaoCompleta.usuario_email) || 'automático'))}
          ${campo('Próxima execução', dataHoraServico(d.proximaExecucao))}
        </div>
      </div>

      ${d.ultimaMensagem ? `<div class="gaveta-secao">
        <h4>Mensagem</h4>
        <div class="bloco-mensagem">${escaparHtml(d.ultimaMensagem)}</div>
      </div>` : ''}

      ${d.detalheErro ? `<div class="gaveta-secao">
        <h4>Detalhe técnico do erro</h4>
        <div class="bloco-stack">${escaparHtml(d.detalheErro)}</div>
      </div>` : ''}

      <div class="gaveta-secao">
        <h4>Desempenho (últimos 30 dias)</h4>
        <div class="gaveta-campos">
          ${campo('Execuções registradas', numeroServico(d.execucoes30d))}
          ${campo('Tempo médio', duracaoServico(d.duracaoMediaMs))}
          ${campo('Disponibilidade', disp)}
          ${campo('Última verificação', dataHoraServico(d.ultimaVerificacao))}
        </div>
      </div>

      <div class="gaveta-secao">
        <h4>Recursos do sistema</h4>
        <div class="gaveta-campos">
          ${campo('Memória em uso', d.recursos.memoriaMB + ' MB')}
          ${campo('CPU (desde a última leitura)', d.recursos.cpuPercent + '%')}
          ${campo('Sistema no ar há', duracaoServico(d.recursos.uptimeSegundos * 1000))}
        </div>
        <p class="gaveta-sub" style="margin-top:8px">
          Estes números são do sistema inteiro (um único processo), não de cada serviço isoladamente.
        </p>
      </div>`;
  } catch (e) {
    corpo.innerHTML = `<p style="color:var(--vermelho)">Erro ao carregar: ${escaparHtml(e.message)}</p>`;
  }
}

function fecharGavetaServico() {
  document.getElementById('gavetaServico').hidden = true;
  estadoServicos.gavetaId = null;
}

// --- Aba Histórico ---
async function carregarHistoricoServicos() {
  const servico = document.getElementById('filtroServicoHistorico').value;
  const de = document.getElementById('filtroInicioHistorico').value;
  const ate = document.getElementById('filtroFimHistorico').value;
  const p = new URLSearchParams();
  if (de) p.set('de', de);
  if (ate) p.set('ate', ate);
  const caminho = servico
    ? `/servicos/${encodeURIComponent(servico)}/historico?${p}`
    : `/servicos/logs?${p}`;
  try {
    const d = await api(caminho);
    const linhas = d.linhas || [];
    const nomes = Object.fromEntries(estadoServicos.linhas.map((l) => [l.id, l.nome]));
    document.getElementById('estadoVazioHistoricoServicos').hidden = linhas.length > 0;
    document.getElementById('corpoTabelaHistoricoServicos').innerHTML = linhas.map((l) => `
      <tr>
        <td>${dataHoraServico(l.iniciado_em)}</td>
        <td>${escaparHtml(l.servicoNome || nomes[l.servico] || l.servico)}</td>
        <td>${l.resultado === 'erro'
          ? '<span class="selo-servico erro">Erro</span>'
          : '<span class="selo-servico ativo">Sucesso</span>'}</td>
        <td class="numero">${duracaoServico(l.duracao_ms)}</td>
        <td class="numero">${numeroServico(l.registros)}</td>
        <td>${l.origem === 'manual' ? 'Manual' : 'Automático'}</td>
        <td>${escaparHtml(l.usuario_email || '—')}</td>
        <td><div class="msg-servico">${escaparHtml(l.mensagem || '—')}</div></td>
      </tr>`).join('');
  } catch (e) {
    alert('Erro ao carregar o histórico: ' + e.message);
  }
}

// --- Aba Logs ---
function parametrosLogs() {
  const p = new URLSearchParams();
  const busca = document.getElementById('filtroBuscaLogs').value.trim();
  const nivel = document.getElementById('filtroNivelLogs').value;
  const de = document.getElementById('filtroInicioLogs').value;
  const ate = document.getElementById('filtroFimLogs').value;
  if (busca) p.set('busca', busca);
  if (nivel) p.set('nivel', nivel);
  if (de) p.set('de', de);
  if (ate) p.set('ate', ate);
  return p;
}

async function carregarLogsServicos() {
  try {
    const d = await api('/servicos/logs?' + parametrosLogs());
    const linhas = d.linhas || [];
    document.getElementById('estadoVazioLogsServicos').hidden = linhas.length > 0;
    document.getElementById('corpoTabelaLogsServicos').innerHTML = linhas.map((l) => `
      <tr>
        <td style="white-space:nowrap">${dataHoraServico(l.iniciado_em)}</td>
        <td><span class="nivel-log ${escaparHtml(l.nivel)}">${escaparHtml(l.nivel)}</span></td>
        <td>${escaparHtml(l.servicoNome || l.servico)}</td>
        <td>${escaparHtml(l.mensagem || '—')}</td>
      </tr>`).join('');
  } catch (e) {
    alert('Erro ao carregar os logs: ' + e.message);
  }
}

// --- Abas ---
function trocarAbaServicos(aba) {
  estadoServicos.aba = aba;
  document.querySelectorAll('#abasServicos .chip-faixa')
    .forEach((b) => b.classList.toggle('ativo', b.dataset.aba === aba));
  document.getElementById('abaServicosLista').hidden = aba !== 'servicos';
  document.getElementById('abaServicosHistorico').hidden = aba !== 'historico';
  document.getElementById('abaServicosLogs').hidden = aba !== 'logs';
  if (aba === 'historico') carregarHistoricoServicos();
  if (aba === 'logs') carregarLogsServicos();
}

// --- Polling de 30s: só roda enquanto a tela está aberta e visível ---
function iniciarPollingServicos() {
  pararPollingServicos();
  estadoServicos.timer = setInterval(() => {
    // Aba do navegador em segundo plano não precisa consultar o servidor.
    if (document.hidden) return;
    if (estadoServicos.aba === 'servicos') carregarStatusServicos({ silencioso: true });
  }, 30000);
}
function pararPollingServicos() {
  if (estadoServicos.timer) { clearInterval(estadoServicos.timer); estadoServicos.timer = null; }
}

function configurarStatusServicos() {
  const secao = document.getElementById('paginaStatusServicos');
  if (!secao) return;

  document.getElementById('botaoAtualizarServicos')
    .addEventListener('click', () => carregarStatusServicos());

  document.getElementById('abasServicos').addEventListener('click', (ev) => {
    const b = ev.target.closest('.chip-faixa');
    if (b) trocarAbaServicos(b.dataset.aba);
  });

  // Filtros da lista: refazem só a tabela, sem ir ao servidor.
  ['filtroBuscaServicos', 'filtroSituacaoServicos', 'filtroCategoriaServicos'].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => renderizarTabelaServicos());
  });
  document.getElementById('botaoLimparFiltrosServicos').addEventListener('click', () => {
    document.getElementById('filtroBuscaServicos').value = '';
    document.getElementById('filtroSituacaoServicos').value = '';
    document.getElementById('filtroCategoriaServicos').value = '';
    renderizarTabelaServicos();
  });

  secao.querySelectorAll('th.ordenavel').forEach((th) => {
    th.addEventListener('click', () => {
      const campo = th.dataset.ordem;
      const o = estadoServicos.ordem;
      o.desc = o.campo === campo ? !o.desc : false;
      o.campo = campo;
      renderizarTabelaServicos();
    });
  });

  document.getElementById('corpoTabelaServicos').addEventListener('click', (ev) => {
    const exec = ev.target.closest('[data-executar]');
    if (exec) { executarServico(exec.dataset.executar); return; }
    const det = ev.target.closest('[data-detalhe]');
    if (det) abrirGavetaServico(det.dataset.detalhe);
  });

  document.getElementById('alertasServicos').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-ver-servico]');
    if (b) abrirGavetaServico(b.dataset.verServico);
  });

  // Gaveta
  document.getElementById('botaoFecharGaveta').addEventListener('click', fecharGavetaServico);
  document.getElementById('gavetaServico').addEventListener('click', (ev) => {
    if (ev.target.id === 'gavetaServico') fecharGavetaServico(); // clique fora fecha
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !document.getElementById('gavetaServico').hidden) fecharGavetaServico();
  });
  document.getElementById('botaoExecutarDaGaveta').addEventListener('click', () => {
    if (estadoServicos.gavetaId) executarServico(estadoServicos.gavetaId);
  });
  document.getElementById('botaoHistoricoDoServico').addEventListener('click', () => {
    const id = estadoServicos.gavetaId;
    fecharGavetaServico();
    document.getElementById('filtroServicoHistorico').value = id;
    trocarAbaServicos('historico');
  });

  // Histórico e Logs
  document.getElementById('botaoAplicarHistorico').addEventListener('click', carregarHistoricoServicos);
  document.getElementById('filtroServicoHistorico').addEventListener('change', carregarHistoricoServicos);
  document.getElementById('botaoAplicarLogs').addEventListener('click', carregarLogsServicos);
  document.getElementById('filtroNivelLogs').addEventListener('change', carregarLogsServicos);
  document.getElementById('filtroBuscaLogs').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') carregarLogsServicos();
  });
  document.getElementById('botaoExportarLogs').addEventListener('click', () => {
    window.location.href = '/api/servicos/logs/csv?' + parametrosLogs();
  });
}
