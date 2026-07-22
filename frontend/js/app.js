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
  if (!resp.ok) throw new Error(dados.erro || 'Erro na requisição');
  return dados;
}

function formatarData(iso) {
  if (!iso) return '—';
  const [ano, mes, dia] = iso.split('-');
  if (!dia) return iso;
  return `${dia}/${mes}/${ano}`;
}

// Mostra um valor de célula ou "—" quando vazio/nulo (para tabelas largas).
function valorCelula(v) {
  if (v === null || v === undefined || v === '') return '—';
  return v;
}

// Interpreta o texto de lotes vindo do relatório de estoque.
// Cada lote vem separado por "\" no formato:
//   "Lote N°: XXX Validade: DD/MM/YYYY Fabricante: YYY Qtde: NNN"
// Retorna uma lista de objetos { lote, validade, fabricante, qtde }.
function parsearLotes(texto) {
  if (!texto) return [];
  const t = String(texto).trim();
  if (!t || /^sem lote$/i.test(t)) return [];

  return t.split('\\').map((parte) => parte.trim()).filter(Boolean).map((p) => {
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
    document.getElementById('botaoAtualizarRelatorioItens').hidden = false;
    verificarStatusOracleRelatorioItens();
    document.querySelectorAll('.botao-atualizar-agora').forEach((b) => { b.hidden = false; });
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
    estoque: 'estoqueTP', validades: 'validadesTP', historico: 'historicoEstoqueTP', evolucao: 'evolucaoEstoqueTP',
    estoqueGeral: 'estoqueGeral', estoqueOD: 'estoqueOD', distribuicao: 'distribuicao',
    relatorioItens: 'relatorioItens',
    autores: 'autoresTP', autoresGeral: 'autoresGeral',
    comparativoAutores: 'comparativoAutoresTP', relatorioReq: 'relatorioReqTP',
    atas: 'atas',
    entradaLotes: 'entradaLotes',
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
  estoqueGeral: '<path d="M3 21V8l9-5 9 5v13"/><path d="M9 21v-6h6v6"/><path d="M3 13h18"/>',
  estoqueOD: '<path d="M3 21V8l9-5 9 5v13"/><path d="M9 21v-6h6v6"/><path d="M3 13h18"/><path d="M16 3l4 2v4l-4-2z"/>',
  solicitacoesOD: '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/><path d="M16 3l4 2v4l-4-2z"/>',
  aquisicaoODAndamento: '<path d="M4 19h16"/><path d="M4 19V5"/><path d="M7 15l4-5 3 3 5-7"/><path d="M16 3l4 2v4l-4-2z"/>',
  validades: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 9h16M9 3v4M15 3v4M12 12v3l2 1"/>',
  busca: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-3.5-3.5"/>',
  historico: '<path d="M4 12a8 8 0 1 0 2-5.3"/><path d="M4 4v3h3"/><path d="M12 8v4l3 2"/>',
  evolucao: '<path d="M4 19h16"/><path d="M4 19V5"/><path d="M7 15l4-5 3 3 5-7"/>',
  autores: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  autoresGeral: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  comparativoAutores: '<path d="M16 3h5v5"/><path d="M21 3l-7 7"/><path d="M8 21H3v-5"/><path d="M3 21l7-7"/>',
  relatorioReq: '<path d="M9 2h6l1 3H8z"/><rect x="4" y="5" width="16" height="17" rx="2"/><path d="M8 11h8M8 15h8M8 19h5"/>',
  relatorioItens: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  elenco: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  atas: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/><path d="M15 19l2 2 3-3"/>',
  distribuicao: '<circle cx="12" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="M12 8v4M12 12l-5 4M12 12l5 4"/>',
  entradaLotes: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 19h16"/>',
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

// Busca "Ir para tela…" da topbar: filtra as telas pela trilha e navega.
// Só oferece telas que o usuário pode ver (respeita a permissão do menu).
(function buscaTelas() {
  const input = document.getElementById('buscaTelas');
  const cx = document.getElementById('buscaTelasResultados');
  if (!input || !cx) return;
  let itens = [], marcado = -1;

  function listar() {
    const q = input.value.trim().toLowerCase();
    const res = [];
    for (const [pag, partes] of Object.entries(TRILHAS)) {
      const link = document.querySelector(`.nav-lateral a[data-pagina="${pag}"]`);
      if (link && link.hidden) continue;
      const tela = partes[partes.length - 1];
      const via = partes.slice(0, -1).join(' › ');
      if (!q || `${tela} ${via}`.toLowerCase().includes(q)) res.push({ pag, tela, via });
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
  estoque: ['Tenente Pena', 'Estoque', 'Estoque Tenente Pena'],
  evolucao: ['Tenente Pena', 'Estoque', 'Evolução de Estoque'],
  historico: ['Tenente Pena', 'Estoque', 'Histórico de Estoque'],
  entradaLotes: ['Tenente Pena', 'Estoque', 'Movimentação de Entrada'],
  reservas: ['Tenente Pena', 'Estoque', 'Reservas de Estoque'],
  rupturas: ['Tenente Pena', 'Estoque', 'Rupturas'],
  alertas: ['Tenente Pena', 'Estoque', 'Alertas'],
  autores: ['Tenente Pena', 'Autores', 'Listagem de Autores'],
  validades: ['Tenente Pena', 'Autores', 'Consultar Validades TP'],
  estoqueGeral: ['Outras Demandas', 'Estoque', 'Itens em Estoque Geral'],
  estoqueOD: ['Outras Demandas', 'Estoque', 'Estoque GSNET/IBL'],
  distribuicao: ['Outras Demandas', 'Estoque', 'Distribuição'],
  aquisicaoODAndamento: ['Outras Demandas', 'Compras', 'Aquisição em Andamento'],
  solicitacoesOD: ['Outras Demandas', 'Compras', 'Relatório de Compras OD'],
  autoresGeral: ['Outras Demandas', 'Autores', 'Listagem de Autores Demais Unidades'],
  relatorioItens: ['Consultas', 'Relatório de Itens'],
  atas: ['Consultas', 'Atas de Registro de Preço'],
  usuarios: ['Administração', 'Usuários'],
  importadores: ['Administração', 'Importação'],
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
  document.getElementById('paginaEstoqueGeral').hidden = pagina !== 'estoqueGeral';
  document.getElementById('paginaEstoqueOD').hidden = pagina !== 'estoqueOD';
  document.getElementById('paginaDistribuicao').hidden = pagina !== 'distribuicao';
  document.getElementById('paginaSolicitacoesOD').hidden = pagina !== 'solicitacoesOD';
  document.getElementById('paginaAquisicaoODAndamento').hidden = pagina !== 'aquisicaoODAndamento';
  document.getElementById('paginaValidades').hidden = pagina !== 'validades';
  document.getElementById('paginaHistorico').hidden = pagina !== 'historico';
  document.getElementById('paginaEvolucao').hidden = pagina !== 'evolucao';
  document.getElementById('paginaAutores').hidden = pagina !== 'autores';
  document.getElementById('paginaAutoresGeral').hidden = pagina !== 'autoresGeral';
  document.getElementById('paginaComparativoAutores').hidden = pagina !== 'comparativoAutores';
  document.getElementById('paginaRelatorioReq').hidden = pagina !== 'relatorioReq';
  document.getElementById('paginaAtas').hidden = pagina !== 'atas';
  document.getElementById('paginaEntradaLotes').hidden = pagina !== 'entradaLotes';
  document.getElementById('paginaReservas').hidden = pagina !== 'reservas';
  document.getElementById('paginaRupturas').hidden = pagina !== 'rupturas';
  document.getElementById('paginaRelatorioItens').hidden = pagina !== 'relatorioItens';
  document.getElementById('paginaElenco').hidden = pagina !== 'elenco';
  document.getElementById('paginaImportadores').hidden = pagina !== 'importadores';
  document.getElementById('paginaAlertas').hidden = pagina !== 'alertas';
  document.getElementById('paginaUsuarios').hidden = pagina !== 'usuarios';

  try {
    if (pagina === 'painel') await carregarPainel();
    if (pagina === 'solicitacoes') await carregarSolicitacoes();
    if (pagina === 'relatorio') await carregarRelatorio();
    if (pagina === 'estoque') await carregarEstoque();
    if (pagina === 'estoqueGeral') await carregarEstoqueGeral();
    if (pagina === 'estoqueOD') await carregarEstoqueOD();
    if (pagina === 'distribuicao') await carregarDistribuicao();
    if (pagina === 'solicitacoesOD') await carregarSolicitacoesOD();
    if (pagina === 'aquisicaoODAndamento') await carregarAquisicaoODAndamento();
    if (pagina === 'validades') await carregarValidades();
    if (pagina === 'historico') await carregarHistorico();
    if (pagina === 'evolucao') iniciarEvolucao();
    if (pagina === 'autores') await carregarAutores();
    if (pagina === 'autoresGeral') await carregarAutoresGeral();
    if (pagina === 'comparativoAutores') await carregarComparativo();
    if (pagina === 'relatorioReq') await carregarRelatorioReq();
    if (pagina === 'atas') await carregarAtas();
    if (pagina === 'entradaLotes') await carregarEntradaLotes();
    if (pagina === 'reservas') await carregarReservas();
    if (pagina === 'rupturas') await carregarRupturas();
    if (pagina === 'relatorioItens') await carregarRelatorioItens();
    if (pagina === 'alertas') await carregarAlertas();
    if (pagina === 'usuarios') await carregarUsuarios();
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
  const STATUS_ABERTO = ['Planejamento', 'Adjucado', 'Empenhado', 'Entrega Parcial'];

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
  const ORDEM = ['Planejamento', 'Adjucado', 'Empenhado', 'Entrega Parcial', 'Finalizado', 'Cancelado', 'Deserto', 'Fracassado', 'Revogado'];
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

  // --- Compras em andamento (recentes) ---
  estadoPainel.status = null;
  renderPainelCompras(recentes.solicitacoes || [], null);
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
const filtroAtrasados = document.getElementById('filtroAtrasados');

let debounceBusca;
filtroBusca.addEventListener('input', () => {
  clearTimeout(debounceBusca);
  debounceBusca = setTimeout(() => { estado.solicitacoes.pagina = 1; carregarSolicitacoes(); }, 350);
});
filtroStatus.addEventListener('change', () => { estado.solicitacoes.pagina = 1; carregarSolicitacoes(); });
filtroAno.addEventListener('change', () => { estado.solicitacoes.pagina = 1; carregarSolicitacoes(); });
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
  const ABERTO = ['Planejamento', 'Adjucado', 'Empenhado', 'Entrega Parcial', 'Em andamento'];
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
    kpiCard('chart', n(andamento), 'Em andamento', 'Planejamento · Adjucado · Empenhado · Entrega Parcial', 'aviso') +
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
  if (filtroAtrasados.checked) params.set('atrasados', 'true');
  params.set('page', estado.solicitacoes.pagina);
  params.set('pageSize', estado.solicitacoes.pageSize);

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
          <td class="col-codigo">${s.requisicao_gsnet || '—'}</td>
          <td class="col-codigo">${s.n_empenho || '—'}</td>
          <td class="col-data">${formatarData(s.data_entrega)}</td>
          <td>${valorCelula(s.qtde_entregue)}</td>
          <td>${valorCelula(s.qtde_pendente)}</td>
          <td><span class="etiqueta-status ${classe}">${rotulo}</span></td>
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

  container.innerHTML = dados.resultados.map((r) => {
    const semHistorico = r.historico.length === 0;
    return `
    <div class="tabela-wrap" style="margin-bottom:18px;">
      <div style="padding:14px 16px; border-bottom:1px solid var(--linha); background:#fbfaf6;">
        <strong>${r.item.descricao}</strong>
        <div class="col-codigo" style="margin-top:2px;">${r.item.codigo_item}${r.item.codigo_siafisico ? ' · SIAFI ' + r.item.codigo_siafisico : ''}</div>
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

// Monta os parâmetros de filtro atuais do relatório
function paramsRelatorio() {
  const params = new URLSearchParams();
  if (filtroAnoRelatorio.value) params.set('ano', filtroAnoRelatorio.value);
  if (filtroBuscaRelatorio.value.trim()) params.set('q', filtroBuscaRelatorio.value.trim());
  if (filtroStatusRelatorio.value) params.set('status', filtroStatusRelatorio.value);
  return params;
}

document.getElementById('botaoExportarRelatorio').addEventListener('click', () => {
  const params = paramsRelatorio();
  params.set('formato', 'csv');
  window.open(`/api/relatorios/consolidado?${params.toString()}`, '_blank');
});

filtroAnoRelatorio.addEventListener('change', carregarRelatorio);
filtroStatusRelatorio.addEventListener('change', carregarRelatorio);
let debounceBuscaRelatorio;
filtroBuscaRelatorio.addEventListener('input', () => {
  clearTimeout(debounceBuscaRelatorio);
  debounceBuscaRelatorio = setTimeout(carregarRelatorio, 350);
});
document.getElementById('botaoLimparFiltrosRelatorio').addEventListener('click', () => {
  filtroBuscaRelatorio.value = '';
  filtroStatusRelatorio.value = '';
  filtroAnoRelatorio.value = '';
  carregarRelatorio();
});

// KPIs do Relatório de Compras TP, calculados no navegador a partir das linhas
// já carregadas — refletem o filtro atual (ano/status/busca) da tela.
function renderKpisRelatorio(solicitacoes) {
  const alvo = document.getElementById('kpisRelatorio');
  if (!alvo) return;
  const ABERTO = ['Planejamento', 'Adjucado', 'Empenhado', 'Entrega Parcial'];
  const total = solicitacoes.length;
  const emAndamento = solicitacoes.filter((s) => ABERTO.includes(s.status)).length;
  const finalizadas = solicitacoes.filter((s) => s.status === 'Finalizado').length;
  const itens = new Set(solicitacoes.map((s) => s.codigo_item).filter(Boolean)).size;
  const n = (v) => v.toLocaleString('pt-BR');
  const pct = total ? Math.round((finalizadas / total) * 100) : 0;
  alvo.innerHTML =
    kpiCard('doc', n(total), 'Solicitações (filtro atual)', 'no recorte selecionado') +
    kpiCard('chart', n(emAndamento), 'Em andamento', 'Planejamento · Adjucado · Empenhado · Entrega Parcial', 'aviso') +
    kpiCard('check', n(finalizadas), 'Finalizadas', `${pct}% do total`) +
    kpiCard('list', n(itens), 'Itens distintos', 'medicamentos diferentes');
}

async function carregarRelatorio() {
  carregarUltimaAtualizacao('atualizadoRelatorio', 'solicitacoes');
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
        <td class="col-codigo">${s.requisicao_gsnet || '—'}</td>
        <td class="col-codigo">${s.n_empenho || '—'}</td>
        <td class="col-data">${formatarData(s.data_entrega)}</td>
        <td>${valorCelula(s.qtde_entregue)}</td>
        <td>${valorCelula(s.qtde_pendente)}</td>
        <td><span class="etiqueta-status ${classe}">${rotulo}</span></td>
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
    `Situação do estoque em ${formatarData(resumo.dataReferencia)} · autonomia mínima: ${resumo.limiarAutonomia} mês(es)`;

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
          <td>${it.descricao || '—'}<br><span class="col-codigo">${it.codigo_item}</span></td>
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
    `Itens em estoque das demais unidades em ${formatarData(resumo.dataReferencia)} · autonomia mínima: ${resumo.limiarAutonomia} mês(es)`;

  const valorFmt = resumo.valorTotalEstoque ? 'R$ ' + Number(resumo.valorTotalEstoque).toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : '—';
  document.getElementById('grideResumoEstoqueGeral').innerHTML = `
    <div class="cartao-resumo"><div class="numero">${fmtNumero(resumo.totalItens)}</div><div class="rotulo">Itens no estoque</div></div>
    <div class="cartao-resumo alerta"><div class="numero">${fmtNumero(resumo.ruptura)}</div><div class="rotulo">Em ruptura (zero + demanda)</div></div>
    <div class="cartao-resumo"><div class="numero">${fmtNumero(resumo.baixo)}</div><div class="rotulo">Estoque baixo (autonomia)</div></div>
    <div class="cartao-resumo"><div class="numero">${fmtNumero(resumo.zerado)}</div><div class="rotulo">Estoque zerado</div></div>
    <div class="cartao-resumo"><div class="numero" style="font-size:20px;">${valorFmt}</div><div class="rotulo">Valor total em estoque</div></div>
  `;
  await carregarFiltrosEstoqueGeral();
  carregarTabelaEstoqueGeral();
}

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
          <td>${it.descricao || '—'}<br><span class="col-codigo">${it.codigo_item}</span></td>
          <td>${it.unidade || '—'}</td>
          <td>${fmtNumero(it.demandas)}</td>
          <td>${fmtNumero(it.consumo_mensal_total)}</td>
          <td>${fmtNumero(it.estoque)}</td>
          <td><span class="etiqueta-status ${classe}">${autonomiaTxt}</span></td>
          <td class="col-data">${validadeTd}</td>
          <td>${compraTag}</td>
          <td><button class="botao-editar" data-codigo="${encodeURIComponent(it.codigo_item)}">Ver</button></td>
        </tr>`;
    }).join('');
    corpo.querySelectorAll('button[data-codigo]').forEach((btn) => {
      btn.addEventListener('click', () => abrirDetalheEstoque(btn.dataset.codigo, 'geral'));
    });
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoEstoqueGeral').textContent = `Página ${dados.page} de ${totalPaginas} · ${dados.total} itens`;
  document.getElementById('botaoAnteriorEstoqueGeral').disabled = dados.page <= 1;
  document.getElementById('botaoProximoEstoqueGeral').disabled = dados.page >= totalPaginas;
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
    `Posição de estoque no operador logístico em ${formatarData(resumo.dataReferencia)}`;

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
    : `<button class="btn-grade btn-validar" ${attrs}>Validar</button>`;
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
    const alvo = autonomiaPorSku.has(sku) ? autonomiaPorSku.get(sku) : autonomiaAlvoPadrao;
    grupo.forEach((it) => {
      const sug = Math.max(0, Math.round(alvo * it.consumo_mensal - (it.estoque_convertido + it.fatura_transito)));
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
      const dados = await api(`${cfg.endpoint}?unidades=${paramUnidades}`);
      if (req !== reqId) return; // resposta antiga: descarta
      dadosBrutos = dados.itens;
      autonomiaAlvoPadrao = dados.autonomiaAlvoMeses || 3;
      autonomiaPorSku.clear();
      const nUnid = dados.unidades ? dados.unidades.length : sel.length;
      let txt = `Autonomia-alvo: ${dados.autonomiaAlvoMeses} meses · Mostrando só autonomia ≥ ${dados.autonomiaMinimaExibir} · `
        + `${nUnid} unidade(s) · Estoque: ${dados.dataReferenciaEstoque ? formatarData(dados.dataReferenciaEstoque) : '—'} · `
        + `Operador: ${dados.dataReferenciaOperador ? formatarData(dados.dataReferenciaOperador) : '—'}`;
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
    const q = $('filtroBusca').value.trim().toLowerCase();
    const soSugeridos = $('filtroSoSugeridos').checked;
    const etiquetasSel = [...$('filtroEtiqueta').querySelectorAll('.chk-etiqueta:checked')].map((c) => c.value);
    const corpo = $('corpoTabela');
    const vazio = $('estadoVazio');

    let itens = dadosBrutos.slice();
    if (q) itens = itens.filter((it) => (it.descricao_item || '').toLowerCase().includes(q) || (it.codigo_item || '').toLowerCase().includes(q) || (it.codigo_sku || '').toLowerCase().includes(q));
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
            <input type="number" min="0" step="0.5" value="${alvo}" class="input-autonomia-sku" data-sku="${String(g.sku).replace(/"/g, '&quot;')}" title="Meses de autonomia-alvo deste SKU">
          </td>
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

  // Validar / Negar por linha (grade compartilhada). Delegação no tbody.
  $('corpoTabela').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('.btn-grade');
    if (!btn) return;
    const d = btn.dataset;
    const validar = btn.classList.contains('btn-validar');
    btn.disabled = true;
    try {
      if (validar) {
        const r = await api('/distribuicao/grade/validar', {
          method: 'POST',
          body: JSON.stringify({
            local_entrega: d.local, codigo_scodes: d.scodes, cod_item: d.sku,
            medicamento: d.med, qtde: Number(d.qtde) || 0, validade: d.val,
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
    }));
  } catch (e) { gradeFinalItens = []; }
  renderizarGradeFinal();
}

function renderizarGradeFinal() {
  const q = (document.getElementById('filtroBuscaGradeFinal').value || '').trim().toLowerCase();
  const corpo = document.getElementById('corpoTabelaGradeFinal');
  const vazio = document.getElementById('estadoVazioGradeFinal');
  const info = document.getElementById('infoGradeFinal');

  let itens = gradeFinalItens;
  if (q) itens = itens.filter((it) => (it.medicamento || '').toLowerCase().includes(q)
    || (it.codigo_scodes || '').toLowerCase().includes(q)
    || (it.cod_item || '').toLowerCase().includes(q)
    || (it.local_entrega || '').toLowerCase().includes(q));

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
  const ABERTO_OD = ['Planejamento', 'Adjucado', 'Empenhado', 'Entrega Parcial', 'Em andamento'];
  const contOD = (nome) => (porStatus.find((l) => l.status === nome) || {}).qtde || 0;
  const totalOD = porStatus.reduce((s, l) => s + l.qtde, 0);
  const andamentoOD = porStatus.filter((l) => ABERTO_OD.includes(l.status)).reduce((s, l) => s + l.qtde, 0);
  const finalOD = contOD('Finalizado');
  const pctOD = totalOD ? Math.round((finalOD / totalOD) * 100) : 0;
  const nOD = (v) => v.toLocaleString('pt-BR');
  document.getElementById('grideResumoSolicitacoesOD').innerHTML =
    kpiCard('doc', nOD(totalOD), 'Total de solicitações', 'todos os meses') +
    kpiCard('chart', nOD(andamentoOD), 'Em andamento', 'Planejamento · Adjucado · Empenhado · Entrega Parcial', 'aviso') +
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
        <td class="col-codigo">${s.requisicao_gsnet || '—'}</td>
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
// (Planejamento, Adjucado, Empenhado, Entrega Parcial). Dados vêm do mesmo
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
        <td class="col-codigo">${s.requisicao_gsnet || '—'}</td>
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

async function abrirDetalheEstoque(codigoEncoded, escopo = 'udtp') {
  const modal = document.getElementById('modalEstoqueItem');
  const conteudo = document.getElementById('conteudoModalEstoque');
  conteudo.innerHTML = '<p class="texto-apoio">Carregando…</p>';
  modal.hidden = false;

  const dados = await api(`/estoque/item/${codigoEncoded}?escopoUnidade=${escopo}`);
  const e = dados.estoqueAtual;

  document.getElementById('tituloModalEstoque').textContent = e ? (e.descricao || dados.codigo) : dados.codigo;
  document.getElementById('codigoModalEstoque').textContent = dados.codigo;

  // Montagem no mesmo formato do modal de Reservas: KPIs no topo, depois as
  // duas tabelas ESTREITAS lado a lado (lotes | evolução) e, por fim, as
  // tabelas LARGAS em largura total. Evita a rolagem vertical enorme que a
  // versão empilhada gerava.
  let html = '';

  if (e) {
    html += `
      <div class="grade-resumo" style="grid-template-columns: repeat(4, 1fr); margin-bottom:18px;">
        ${kpiCard('chart', fmtNumero(e.estoque), 'Estoque', 'saldo atual')}
        ${kpiCard('relogio', fmtNumero(e.autonomia), 'Autonomia', 'meses de cobertura')}
        ${kpiCard('list', fmtNumero(e.demandas), 'Demandas', 'pacientes com demanda')}
        ${kpiCard('doc', fmtNumero(e.consumo_mensal_total), 'Consumo/mês', 'média mensal')}
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

  // ----- coluna 2: evolução do estoque -----
  let colEvolucao = '';
  if (dados.historicoEstoque.length > 1) {
    colEvolucao += `<h4>Evolução do estoque <span class="texto-apoio">(${dados.historicoEstoque.length} datas)</span></h4>`;
    colEvolucao += `<table><thead><tr><th>Data</th><th>Estoque</th><th>Autonomia</th><th>Demanda</th></tr></thead><tbody>`;
    colEvolucao += dados.historicoEstoque.map((h) => `
      <tr>
        <td class="col-data">${formatarData(h.data_referencia)}</td>
        <td>${fmtNumero(h.estoque)}</td>
        <td>${fmtNumero(h.autonomia)}</td>
        <td>${fmtNumero(h.demandas)}</td>
      </tr>
    `).join('');
    colEvolucao += '</tbody></table>';
  }

  // As duas estreitas lado a lado (viram uma embaixo da outra em tela pequena)
  if (colLotes || colEvolucao) {
    html += `<div class="detalhe-colunas"><div>${colLotes}</div><div>${colEvolucao}</div></div>`;
  }

  // ----- largura total: compras judiciais -----
  html += '<h4>Compras no controle judicial</h4>';
  if (dados.compras.length === 0) {
    html += '<p class="texto-apoio">Nenhuma compra registrada para este item no controle judicial.</p>';
  } else {
    if (dados.temCompraAberta) {
      html += '<p class="aviso-compra-aberta">✓ Este item tem compra em aberto (em andamento).</p>';
    }
    html += `<div class="rolagem-tabela"><table><thead><tr><th>Período</th><th>Modalidade</th><th>Qtd. solicitada</th><th>Empenho</th><th>Previsão</th><th>Status</th></tr></thead><tbody>`;
    html += dados.compras.map((c) => {
      const classe = classeStatus(c.status, c.data_previsao_entrega);
      const rotulo = rotuloStatus(c.status, c.data_previsao_entrega);
      return `<tr>
        <td>${c.mes}/${c.ano}</td>
        <td>${c.modalidade_compra || '—'}</td>
        <td>${valorCelula(c.qtde_solicitada)}</td>
        <td>${c.n_empenho || '—'}</td>
        <td class="col-data">${formatarData(c.data_previsao_entrega)}</td>
        <td><span class="etiqueta-status ${classe}">${rotulo}</span></td>
      </tr>`;
    }).join('');
    html += '</tbody></table></div>';
  }

  // ----- largura total: pacientes -----
  html += `<h4>Pacientes ${dados.pacientes && dados.pacientes.length ? `<span class="texto-apoio">(${dados.pacientes.length})</span>` : ''}</h4>`;
  if (!dados.pacientes || dados.pacientes.length === 0) {
    html += '<p class="texto-apoio">Nenhum paciente cadastrado com este item na Tenente Pena.</p>';
  } else {
    html += `<div class="rolagem-tabela"><table><thead><tr><th>Nome</th><th>Protocolo</th><th>Qtde. Consumo</th><th>Prazo</th><th>Periodicidade</th><th>Data de retirada</th><th>Próx. data de retorno</th></tr></thead><tbody>`;
    html += dados.pacientes.map((p) => `
      <tr>
        <td>${p.autor || '—'}</td>
        <td>${p.protocolo || '—'}</td>
        <td>${p.qtde_consumo || '—'}</td>
        <td>${p.prazo || '—'}</td>
        <td>${p.periodicidade || '—'}</td>
        <td class="col-data">${p.data_ultima_dispensacao || '—'}</td>
        <td class="col-data">${p.data_ultimo_retorno || '—'}</td>
      </tr>
    `).join('');
    html += '</tbody></table></div>';
  }

  conteudo.innerHTML = html;
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
    `Lotes e validades do estoque em ${formatarData(dados.dataReferencia)}`;

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
    <div class="cartao-resumo"><div class="numero" style="font-size:18px;">${dados.dataReferencia ? formatarData(dados.dataReferencia) : '—'}</div><div class="rotulo">Data do arquivo</div></div>
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
        <td>${a.prazo || celVazia()}</td>
        <td>${a.periodicidade || celVazia()}</td>
        <td>${tagCategoria(a.categoria)}</td>
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
    <div class="cartao-resumo"><div class="numero" style="font-size:18px;">${dados.dataReferencia ? formatarData(dados.dataReferencia) : '—'}</div><div class="rotulo">Data do arquivo</div></div>
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
        <td>${a.prazo || celVazia()}</td>
        <td>${a.periodicidade || celVazia()}</td>
        <td>${tagCategoria(a.categoria)}</td>
      </tr>
    `).join('');
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoAutoresGeral').textContent =
    `Página ${dados.page} de ${totalPaginas} · ${fmtNumero(dados.total)} linha(s)`;
  document.getElementById('botaoAnteriorAutoresGeral').disabled = dados.page <= 1;
  document.getElementById('botaoProximoAutoresGeral').disabled = dados.page >= totalPaginas;
}

// -------------------- Relatório de Itens (catálogo) --------------------
const estadoRelItens = { pagina: 1, pageSize: 50, filtrosCarregados: false };

let debounceRelItens;
document.getElementById('riFiltroBusca').addEventListener('input', () => {
  clearTimeout(debounceRelItens);
  debounceRelItens = setTimeout(() => { estadoRelItens.pagina = 1; carregarTabelaRelItens(); }, 350);
});
['riFiltroCategoria', 'riFiltroTipo', 'riFiltroImportado', 'riFiltroOutrasDemandas'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => { estadoRelItens.pagina = 1; carregarTabelaRelItens(); });
});
document.getElementById('riLimparFiltros').addEventListener('click', () => {
  document.getElementById('riFiltroBusca').value = '';
  ['riFiltroCategoria', 'riFiltroTipo', 'riFiltroImportado', 'riFiltroOutrasDemandas'].forEach((id) => { document.getElementById(id).value = ''; });
  estadoRelItens.pagina = 1; carregarTabelaRelItens();
});
document.getElementById('riAnterior').addEventListener('click', () => { if (estadoRelItens.pagina > 1) { estadoRelItens.pagina--; carregarTabelaRelItens(); } });
document.getElementById('riProximo').addEventListener('click', () => { estadoRelItens.pagina++; carregarTabelaRelItens(); });

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
  const mapa = { categoria: 'riFiltroCategoria', tipo_item: 'riFiltroTipo', importado: 'riFiltroImportado', outras_demandas: 'riFiltroOutrasDemandas' };
  for (const [param, id] of Object.entries(mapa)) { const v = document.getElementById(id).value; if (v) params.set(param, v); }

  const dados = await api(`/relatorio-itens?${params.toString()}`);

  document.getElementById('grideResumoRelItens').innerHTML = `
    <div class="cartao-resumo"><div class="numero">${fmtNumero(dados.total)}</div><div class="rotulo">Itens${q ? ' filtrados' : ' no catálogo'}</div></div>
    <div class="cartao-resumo"><div class="numero" style="font-size:18px;">${dados.dataReferencia ? formatarData(dados.dataReferencia) : '—'}</div><div class="rotulo">Data do arquivo</div></div>
  `;

  const corpo = document.getElementById('corpoTabelaRelItens');
  const vazio = document.getElementById('estadoVazioRelItens');
  if (dados.itens.length === 0) {
    corpo.innerHTML = ''; vazio.hidden = false;
  } else {
    vazio.hidden = true;
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
      </tr>
    `).join('');
  }

  const totalPaginas = Math.max(Math.ceil(dados.total / dados.pageSize), 1);
  document.getElementById('textoPaginacaoRelItens').textContent =
    `Página ${dados.page} de ${totalPaginas} · ${fmtNumero(dados.total)} item(ns)`;
  document.getElementById('riAnterior').disabled = dados.page <= 1;
  document.getElementById('riProximo').disabled = dados.page >= totalPaginas;
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

  let cols = [];
  let linhas = [];
  if (aba === 'novos') {
    cols = ['ID Demanda', 'Autor', 'Protocolo', 'Processo', 'Tipo da Demanda', 'Cód. Item', 'Descrição do Item', 'Qtde de Consumo'];
    linhas = dadosComparativo.novos.map((n) => [
      `<span class="col-codigo">${n.id_demanda}</span>`, n.autor,
      `<span class="col-codigo">${n.protocolo}</span>`, `<span class="col-codigo">${n.processo}</span>`,
      n.tipo_demanda, `<span class="col-codigo">${n.codigo_item}</span>`, n.descricao_item, n.qtde_consumo,
    ]);
  } else if (aba === 'encerrados') {
    cols = ['Autor', 'Processo', 'Último Item'];
    linhas = dadosComparativo.encerrados.map((e) => [e.autor, e.processo || '—', e.ultimo_item]);
  } else {
    // popula o filtro de categoria (1ª vez)
    const selCat = document.getElementById('filtroCategoriaAlteracao');
    if (selCat.options.length <= 1) {
      const cats = [...new Set(dadosComparativo.alteracoes.map((a) => a.categoria).filter((c) => c && c !== '—'))].sort();
      selCat.innerHTML = '<option value="">Categoria: todas</option>' + cats.map((c) => `<option value="${c.replace(/"/g, '&quot;')}">${c}</option>`).join('');
    }

    const fTipo = document.getElementById('filtroTipoAlteracao').value;
    const fCat = selCat.value;
    // base filtrada só por categoria (para os KPIs por tipo)
    const baseCat = dadosComparativo.alteracoes.filter((a) => !fCat || a.categoria === fCat);
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
    corpo.innerHTML = linhas.slice(0, 2000).map((l) =>
      '<tr>' + l.map((celula) => `<td>${celula}</td>`).join('') + '</tr>'
    ).join('');
  }
  document.getElementById('contagemComparativo').textContent = `${fmtNumero(linhas.length)} registro(s)`;
}

// Filtros da aba Alterações re-renderizam a aba
['filtroTipoAlteracao', 'filtroCategoriaAlteracao'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => renderAbaComparativo('alteracoes'));
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
document.getElementById('botaoFecharRequisicao').addEventListener('click', () => { modalRequisicao.hidden = true; });
document.getElementById('reqVoltar').addEventListener('click', voltarParaBuscaPaciente);
document.getElementById('botaoGerarRequisicao').addEventListener('click', gerarRequisicao);

function abrirRequisicao() {
  reqModo = 'novo';
  reqEditId = null;
  modalRequisicao.hidden = false;
  document.getElementById('botaoGerarRequisicao').textContent = 'Gerar requisição →';
  document.getElementById('reqApenasRegistro').checked = false;
  voltarParaBuscaPaciente();
}

// Abre o construtor já com a requisição salva carregada, para edição
async function editarRequisicao(id) {
  const dados = await api(`/autores/requisicoes/${id}`);
  const r = dados.requisicao;
  reqModo = 'editar';
  reqEditId = id;
  modalRequisicao.hidden = false;
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

async function selecionarPaciente(autor) {
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
      badge = `<span class="etiqueta-status ${cls}">estoque: ${fmtNumero(it.estoque_atual)} · autonomia ${fmtNumero(aut)} m</span>`;
    }
    const chip = (rotulo, valor) => (valor !== null && valor !== undefined && String(valor).trim() !== '')
      ? `<span style="display:inline-block; background:#f0ece0; border:1px solid #e2dcc9; border-radius:4px; padding:1px 7px; margin:2px 4px 0 0; font-size:11px;"><strong>${rotulo}:</strong> ${valor}</span>`
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
      <label class="req-item" style="display:grid; grid-template-columns:24px 1fr 95px 110px; gap:10px; align-items:center; padding:9px 6px; border-bottom:1px solid #ece8db; cursor:pointer;">
        <input type="checkbox" class="req-check" data-idx="${idx}" style="width:auto;">
        <div>
          <div style="font-size:13px;">${it.descricao_item || '—'}</div>
          <div class="col-codigo">${it.codigo_item || ''}${it.cod_siafisico ? ' · SIAF ' + it.cod_siafisico : ''}</div>
          ${detalhes ? `<div style="margin-top:3px;">${detalhes}</div>` : ''}
          <div style="margin-top:3px;">${badge}</div>
        </div>
        <div>
          <label style="font-size:10px; color:var(--cinza-texto); display:block;">Autonomia de compra</label>
          <input type="number" class="req-autonomia" data-idx="${idx}" data-consumo="${consumoNum}" value="1" min="0" step="1" style="width:100%; padding:6px 8px; border:1px solid var(--linha); border-radius:4px; font-size:13px;">
        </div>
        <div>
          <label style="font-size:10px; color:var(--cinza-texto); display:block;">Qtde de Aquisição</label>
          <input type="number" class="req-qtd" data-idx="${idx}" value="${consumoNum}" readonly title="Consumo × Autonomia de compra" style="width:100%; padding:6px 8px; border:1px solid var(--linha); border-radius:4px; font-size:13px; background:#f3f1e8; font-weight:600;">
        </div>
      </label>`;
  }).join('');

  document.getElementById('reqMarcarTodos').checked = false;
  document.querySelectorAll('#reqListaItens .req-check').forEach((c) => c.addEventListener('change', atualizarContadorReq));
  // Recalcular a quantidade de aquisição quando a autonomia de compra mudar
  document.querySelectorAll('#reqListaItens .req-autonomia').forEach((inp) => {
    inp.addEventListener('input', () => recalcularAquisicao(inp));
  });
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
    selecionados.push({ ...reqItensAtuais[idx], quantidade: qtd, autonomia_compra: autonomiaCompra });
  });
  return selecionados;
}

// Monta o HTML do documento da requisição (reutilizado ao gerar e ao reabrir)
function montarDocumentoRequisicao(d) {
  const linhas = d.itens.map((it, i) => `
    <tr>
      <td style="text-align:center;">${i + 1}</td>
      <td>${it.codigo_item || '—'}</td>
      <td>${it.cod_siafisico || '—'}</td>
      <td>${it.catmat || '—'}</td>
      <td>${it.descricao_item || '—'}</td>
      <td style="text-align:center;">${it.qtde_consumo || '—'}</td>
      <td style="text-align:center;"><strong>${it.quantidade || '—'}</strong></td>
    </tr>`).join('');

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
      <thead><tr><th style="width:28px;">#</th><th>Cód. Item</th><th>SIAFÍSICO</th><th>CATMAT</th><th>Descrição do Item</th><th>Qtde Consumo</th><th style="width:90px;">Quantidade de Aquisição</th></tr></thead>
      <tbody>${linhas}</tbody>
    </table>
    <div class="assin">
      <div>${d.operadorNome || ''}<br>Responsável pela requisição</div>
      <div>Autorização</div>
    </div>
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
  const operador = estado.usuario || {};
  const botao = document.getElementById('botaoGerarRequisicao');
  botao.disabled = true;

  const corpoItens = itens.map((it) => ({
    codigo_item: it.codigo_item, cod_siafisico: it.cod_siafisico,
    descricao_item: it.descricao_item, categoria: it.categoria, quantidade: it.quantidade,
    tipo_demanda: it.tipo_demanda, qtde_consumo: it.qtde_consumo, prazo: it.prazo,
    periodicidade: it.periodicidade, dispensacoes_autorizadas: it.dispensacoes_autorizadas,
    autonomia_compra: it.autonomia_compra, catmat: it.catmat,
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

// Reabre/imprime uma requisição salva (a partir do Relatório Primeiro Atendimento)
async function reabrirRequisicao(id) {
  const dados = await api(`/autores/requisicoes/${id}`);
  const r = dados.requisicao;
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

// -------------------- Relatório Primeiro Atendimento (requisições salvas) --------------------
const estadoRelReq = { pagina: 1, pageSize: 50, filtrosCarregados: false };

let debounceRelReq;
['reqFiltroPaciente', 'reqFiltroSEI', 'reqFiltroCodigo', 'reqFiltroDescricao'].forEach((id) => {
  document.getElementById(id).addEventListener('input', () => {
    clearTimeout(debounceRelReq);
    debounceRelReq = setTimeout(() => { estadoRelReq.pagina = 1; carregarTabelaRelReq(); }, 350);
  });
});
document.getElementById('reqFiltroCategoria').addEventListener('change', () => { estadoRelReq.pagina = 1; carregarTabelaRelReq(); });
document.getElementById('reqLimparFiltros').addEventListener('click', () => {
  ['reqFiltroPaciente', 'reqFiltroSEI', 'reqFiltroCodigo', 'reqFiltroDescricao'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('reqFiltroCategoria').value = '';
  estadoRelReq.pagina = 1; carregarTabelaRelReq();
});
document.getElementById('reqAnterior').addEventListener('click', () => {
  if (estadoRelReq.pagina > 1) { estadoRelReq.pagina--; carregarTabelaRelReq(); }
});
document.getElementById('reqProximo').addEventListener('click', () => { estadoRelReq.pagina++; carregarTabelaRelReq(); });

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

  const dados = await api(`/autores/requisicoes/itens?${params.toString()}`);
  const corpo = document.getElementById('corpoTabelaRelatorioReq');
  const vazio = document.getElementById('estadoVazioRelatorioReq');

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
    corpo.innerHTML = dados.itens.map((it) => {
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
        <tr data-id="${it.id}">
          <td class="col-codigo"><a href="#" class="req-abrir-doc" data-req="${it.requisicao_id}"><strong>${it.codigo_controle || ('#' + it.requisicao_id)}</strong></a></td>
          <td>${it.autor || '—'}</td>
          <td class="col-codigo">${it.sei || '—'}</td>
          <td class="col-codigo">${it.codigo_item || '—'}</td>
          <td>${it.descricao_item || '—'}</td>
          <td class="col-codigo">${it.siafisico || '—'}</td>
          <td>${fmtNumero(it.estoque_atual)}</td>
          <td>${aut === null || aut === undefined ? '—' : fmtNumero(aut) + ' m'}</td>
          <td>${stEstoque}</td>
          <td>
            <select class="req-at-status" ${dis}>${opc(['Solicitado', 'Finalizado', 'Cancelado'], it.status_atendimento)}</select>
          </td>
          <td>
            <input type="text" class="req-at-gsnet" value="${(it.requisicao_gsnet || '').replace(/"/g, '&quot;')}" placeholder="GSNET" style="width:120px;" ${dis}>
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
    // Salvar ao alterar qualquer controle da linha
    corpo.querySelectorAll('tr[data-id]').forEach((tr) => {
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
      tr.querySelectorAll('.req-at-status, .req-at-tel, .req-at-data, .req-at-gsnet').forEach((ctrl) => {
        ctrl.addEventListener('change', () => salvarAtendimentoItem(tr));
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
  const id = tr.dataset.id;
  const corpo = {
    status_atendimento: tr.querySelector('.req-at-status').value,
    telegrama_enviado: tr.querySelector('.req-at-tel').value,
    data_envio: tr.querySelector('.req-at-data').value || null,
    requisicao_gsnet: tr.querySelector('.req-at-gsnet').value.trim() || null,
  };
  const eraSim = tr.querySelector('.req-det') !== null; // já estava enviado
  try {
    await api(`/autores/requisicoes/item/${id}`, { method: 'PUT', body: JSON.stringify(corpo) });
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
    grade += `<line x1="${mEsq}" y1="${yy}" x2="${L - mDir}" y2="${yy}" stroke="#ece8db" stroke-width="1"/>`;
    grade += `<text x="${mEsq - 8}" y="${yy + 4}" text-anchor="end" font-size="10" fill="#8a8676">${fmt(v)}</text>`;
  }

  const linhaPontos = pontos.map((p, i) => `${x(i)},${y(p.valor)}`).join(' ');
  const bolinhas = pontos.map((p, i) => `
    <circle cx="${x(i)}" cy="${y(p.valor)}" r="4" fill="#2f6f57"/>
    <text x="${x(i)}" y="${y(p.valor) - 9}" text-anchor="middle" font-size="10" fill="#2f4f43">${fmt(p.valor)}</text>
    <text x="${x(i)}" y="${A - mBaixo + 18}" text-anchor="middle" font-size="10" fill="#8a8676">${p.label}</text>
  `).join('');

  cont.innerHTML = `
    <svg viewBox="0 0 ${L} ${A}" style="width:100%; min-width:${pontos.length > 6 ? L : 0}px; height:auto;">
      ${grade}
      <line x1="${mEsq}" y1="${mTopo}" x2="${mEsq}" y2="${A - mBaixo}" stroke="#cfc9b8" stroke-width="1"/>
      <line x1="${mEsq}" y1="${A - mBaixo}" x2="${L - mDir}" y2="${A - mBaixo}" stroke="#cfc9b8" stroke-width="1"/>
      ${pontos.length > 1 ? `<polyline points="${linhaPontos}" fill="none" stroke="#2f6f57" stroke-width="2"/>` : ''}
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
document.getElementById('filtroAlertasResolvidos').addEventListener('change', carregarAlertas);

const ROTULO_TIPO_ALERTA = {
  estoque_ruptura: 'Ruptura',
  estoque_baixo: 'Estoque baixo',
  compra_aberta_demanda_zero: 'Revisar compra',
  item_removido_com_historico: 'Item removido',
};

async function carregarAlertas() {
  const container = document.getElementById('listaAlertas');
  const tipoFiltro = document.getElementById('filtroTipoAlerta').value;
  const mostrarResolvidos = document.getElementById('filtroAlertasResolvidos').checked;

  const params = new URLSearchParams();
  if (!mostrarResolvidos) params.set('resolvido', 'false');

  const { alertas } = await api(`/alertas?${params.toString()}`);
  const filtrados = tipoFiltro ? alertas.filter((a) => a.tipo === tipoFiltro) : alertas;

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
      ${!a.resolvido ? `<button class="botao-secundario" data-id="${a.id}">Marcar como resolvido</button>` : ''}
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
      <td><span class="etiqueta-status ${u.ativo ? 'finalizado' : 'cancelado'}">${u.ativo ? 'Ativo' : 'Inativo'}</span></td>
      <td>${textoAtividade(u.ultimo_acesso)}</td>
      <td>
        <button class="botao-editar" data-id="${u.id}">Editar</button>
        ${u.perfil === 'admin'
          ? '<span class="texto-secundario" style="margin-left:6px;">(pode tudo)</span>'
          : `<button class="botao-secundario" data-perm="${u.id}" data-nome="${u.nome}" style="margin-left:6px;">Permissões</button>`}
      </td>
    </tr>
  `).join('');

  corpo.querySelectorAll('.botao-editar').forEach((btn) => {
    btn.addEventListener('click', () => abrirModalUsuario(usuarios.find((u) => u.id === Number(btn.dataset.id))));
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

  let modulos, acoes, acoesRotulo, permissoes, habilitado;
  try {
    const [reg, perm] = await Promise.all([
      api('/usuarios/modulos'),
      api(`/usuarios/${usuarioId}/permissoes`),
    ]);
    ({ modulos, acoes, acoesRotulo } = reg);
    ({ permissoes, habilitado } = perm);
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
  try {
    await api(`/usuarios/${idUsuarioPermissoes}/permissoes`, {
      method: 'PUT',
      body: JSON.stringify({ permissoes, habilitado }),
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
document.getElementById('botaoCancelarModalUsuario').addEventListener('click', () => { modalUsuario.hidden = true; });

function abrirModalUsuario(usuario) {
  idUsuarioEditando = usuario ? usuario.id : null;
  formUsuario.reset();
  document.getElementById('tituloModalUsuario').textContent = usuario ? 'Editar usuário' : 'Novo usuário';
  document.getElementById('rotuloSenhaOpcional').textContent = usuario ? '(deixe em branco para manter)' : '';

  if (usuario) {
    document.getElementById('campoNomeUsuario').value = usuario.nome;
    document.getElementById('campoEmailUsuario').value = usuario.email;
    document.getElementById('campoEmailUsuario').disabled = true;
    document.getElementById('campoPerfilUsuario').value = usuario.perfil;
    document.getElementById('campoAtivoUsuario').value = usuario.ativo ? '1' : '0';
  } else {
    document.getElementById('campoEmailUsuario').disabled = false;
  }

  modalUsuario.hidden = false;
}

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
    } else {
      if (!senha) { alert('Defina uma senha para o novo usuário.'); return; }
      await api('/usuarios', { method: 'POST', body: JSON.stringify({ nome, email, senha, perfil }) });
    }
    modalUsuario.hidden = true;
    carregarUsuarios();
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
    const [estoque, autores, entradaLotes, relatorioItens] = await Promise.all([
      api('/estoque/atualizar-oracle/status'),
      api('/autores/atualizar-oracle/status'),
      api('/entrada-lotes/atualizar-oracle/status'),
      api('/relatorio-itens/atualizar-oracle/status'),
    ]);
    const falhas = [];
    if (estoque && estoque.ultimoErro) falhas.push(`Estoque: ${estoque.ultimoErro}`);
    if (autores && autores.ultimoErro) falhas.push(`Listagem de Autores: ${autores.ultimoErro}`);
    if (entradaLotes && entradaLotes.ultimoErro) falhas.push(`Entrada (lotes): ${entradaLotes.ultimoErro}`);
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
  const ini = document.getElementById('filtroInicioRupturas').value;
  const fim = document.getElementById('filtroFimRupturas').value;
  if (ini) p.set('inicio', ini);
  if (fim) p.set('fim', fim);
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
}

// Monta um cartão de quebra (por categoria / por tipo de item).
// A coluna "%" é a participação daquela linha no TOTAL de rupturas do grupo —
// a barrinha usa a mesma proporção, para leitura imediata.
function quebraRupturas(titulo, dados, rotuloColuna, campo) {
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
  return '<div class="cartao-quebra"><h4>' + titulo + '</h4>'
    + '<table><thead><tr><th>' + rotuloColuna + '</th><th>Rupturas</th><th>%</th><th>Itens</th><th>Pacientes</th></tr></thead>'
    + '<tbody>' + linhas + '</tbody>'
    + '<tfoot><tr><td><strong>Total</strong></td><td><strong>' + nf(total) + '</strong></td>'
    + '<td class="col-pct">100%</td><td></td><td></td></tr></tfoot>'
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
  const media = porDia.reduce((s, d) => s + d.rupturas, 0) / porDia.length;
  legenda.textContent = `${porDia.length} dias · média ${media.toFixed(1)}/dia · pico ${pico.rupturas} em ${formatarData(pico.data)}`;

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
    kpiCard('list', nf(k.totalRupturas), 'Rupturas', 'ocorrências no período', k.totalRupturas > 0 ? 'critico' : ''),
    kpiCard('chart', nf(k.quantidadeTotal), 'Quantidade em falta', 'soma do que não foi entregue'),
    kpiCard('relogio', nf(k.pacientes), 'Pacientes impactados', 'pessoas que não levaram o item'),
    kpiCard('doc', nf(k.itens), 'Itens', 'medicamentos/materiais distintos'),
  ].join('');

  document.getElementById('quebrasRupturas').innerHTML =
    quebraRupturas('Por categoria', d.porCategoria, 'Categoria', 'categoria')
    + quebraRupturas('Por tipo de item', d.porTipo, 'Tipo', 'tipo');

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
['filtroInicioRupturas', 'filtroFimRupturas', 'filtroCategoriaRupturas',
  'filtroTipoRupturas', 'filtroImportadoRupturas', 'filtroOutrasRupturas'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => {
    buscarRupturas().catch((e) => alert('Erro: ' + e.message));
  });
});
document.getElementById('botaoLimparFiltrosRupturas').addEventListener('click', () => {
  document.getElementById('filtroBuscaRupturas').value = '';
  ['filtroCategoriaRupturas', 'filtroTipoRupturas', 'filtroImportadoRupturas', 'filtroOutrasRupturas']
    .forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('filtroInicioRupturas').value = '';
  document.getElementById('filtroFimRupturas').value = '';
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
    const r = await api('/rupturas/importar-agora', { method: 'POST', body: JSON.stringify({}) });
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
