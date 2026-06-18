// -------------------- Estado global --------------------
const estado = {
  usuario: null,
  paginaAtual: 'painel',
  solicitacoes: { pagina: 1, pageSize: 20, total: 0, filtros: {} },
  estoque: { pagina: 1, pageSize: 30, total: 0, data: null },
  validades: { data: null, janela: '' },
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

// -------------------- Autenticação / shell --------------------
async function carregarUsuario() {
  const { usuario } = await api('/auth/me');
  estado.usuario = usuario;
  document.getElementById('nomeUsuario').textContent = usuario.nome;
  document.getElementById('perfilUsuario').textContent = usuario.perfil === 'admin' ? 'Admin' : 'Consulta';

  if (usuario.perfil === 'admin') {
    document.getElementById('linkUsuarios').hidden = false;
    document.getElementById('linkElenco').hidden = false;
    document.getElementById('linkImportadores').hidden = false;
    document.getElementById('linkAlertas').hidden = false;
    document.getElementById('botaoNovaSolicitacao').hidden = false;
    atualizarBadgeAlertas();
    carregarConfigLimiar();
  } else {
    document.getElementById('avisoSomenteLeitura').hidden = false;
  }
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

function mostrarErroPagina(idSecao, mensagem) {
  const secao = document.getElementById(idSecao);
  if (!secao) return;
  const alvo = secao.querySelector('.grade-resumo, .corpo-tabela-wrapper, [id^="lista"], [id^="corpo"]') || secao;
  const div = document.createElement('div');
  div.style.cssText = 'padding:24px;color:#c0392b;';
  div.textContent = mensagem;
  alvo.prepend(div);
}

async function mudarPagina(pagina) {
  estado.paginaAtual = pagina;
  document.querySelectorAll('.nav-lateral a').forEach((a) => a.classList.toggle('ativo', a.dataset.pagina === pagina));
  document.getElementById('paginaPainel').hidden = pagina !== 'painel';
  document.getElementById('paginaSolicitacoes').hidden = pagina !== 'solicitacoes';
  document.getElementById('paginaBusca').hidden = pagina !== 'busca';
  document.getElementById('paginaRelatorio').hidden = pagina !== 'relatorio';
  document.getElementById('paginaEstoque').hidden = pagina !== 'estoque';
  document.getElementById('paginaValidades').hidden = pagina !== 'validades';
  document.getElementById('paginaElenco').hidden = pagina !== 'elenco';
  document.getElementById('paginaImportadores').hidden = pagina !== 'importadores';
  document.getElementById('paginaAlertas').hidden = pagina !== 'alertas';
  document.getElementById('paginaUsuarios').hidden = pagina !== 'usuarios';

  try {
    if (pagina === 'painel') await carregarPainel();
    if (pagina === 'solicitacoes') await carregarSolicitacoes();
    if (pagina === 'relatorio') await carregarRelatorio();
    if (pagina === 'estoque') await carregarEstoque();
    if (pagina === 'validades') await carregarValidades();
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
async function carregarPainel() {
  const grade = document.getElementById('grideResumo');
  grade.innerHTML = '<p style="color:var(--cinza-texto);">Carregando…</p>';

  const { porStatus, atrasados } = await api('/solicitacoes/resumo');

  const cartoes = [];
  cartoes.push(`
    <div class="cartao-resumo alerta">
      <div class="numero">${atrasados}</div>
      <div class="rotulo">Itens com prazo vencido</div>
    </div>
  `);
  porStatus
    .sort((a, b) => b.qtde - a.qtde)
    .forEach((linha) => {
      cartoes.push(`
        <div class="cartao-resumo">
          <div class="numero">${linha.qtde}</div>
          <div class="rotulo">${linha.status}</div>
        </div>
      `);
    });

  grade.innerHTML = cartoes.join('');
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

async function carregarSolicitacoes() {
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
          <td>
            <div>${s.descricao}</div>
            <div class="col-codigo">${s.codigo_item}</div>
          </td>
          <td class="col-data">${s.mes}/${s.ano} · ${s.tipo || '—'}</td>
          <td class="col-codigo">${s.n_oficio || '—'}</td>
          <td class="col-data">${formatarData(s.data_previsao_entrega)}</td>
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

document.getElementById('botaoExportarRelatorio').addEventListener('click', () => {
  const params = new URLSearchParams();
  if (filtroAnoRelatorio.value) params.set('ano', filtroAnoRelatorio.value);
  params.set('formato', 'csv');
  window.open(`/api/relatorios/consolidado?${params.toString()}`, '_blank');
});

filtroAnoRelatorio.addEventListener('change', carregarRelatorio);

async function carregarRelatorio() {
  if (filtroAnoRelatorio.options.length <= 1) {
    const anoAtual = new Date().getFullYear();
    for (let a = anoAtual + 1; a >= 2025; a--) {
      const opt = document.createElement('option');
      opt.value = a;
      opt.textContent = a;
      filtroAnoRelatorio.appendChild(opt);
    }
  }

  const params = new URLSearchParams();
  if (filtroAnoRelatorio.value) params.set('ano', filtroAnoRelatorio.value);

  const { solicitacoes } = await api(`/relatorios/consolidado?${params.toString()}`);

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
        <td>${s.descricao}<br><span class="col-codigo">${s.codigo_item}</span></td>
        <td>${s.mes}/${s.ano}</td>
        <td>${s.modalidade_compra || '—'}</td>
        <td>${s.n_oficio || '—'}</td>
        <td>${s.n_empenho || '—'}</td>
        <td class="col-data">${formatarData(s.data_previsao_entrega)}</td>
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
      <div class="linha"><span>Atualizados</span><strong>${resumo.atualizados}</strong></div>
      <div class="linha"><span>Ignorados (já existiam)</span><strong>${resumo.ignorados}</strong></div>
      <div class="linha"><span>Itens não cadastrados</span><strong>${resumo.itensInexistentes}</strong></div>
    `;
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
  ['filtroCategoria', 'filtroControlado', 'filtroTipoItem', 'filtroMarca', 'filtroImportado', 'filtroOutrasDemandas']
    .forEach((id) => { document.getElementById(id).value = ''; });
  estado.estoque.pagina = 1;
  carregarTabelaEstoque();
});

// Popula os menus suspensos com os valores distintos da data selecionada
async function carregarFiltrosEstoque() {
  const params = new URLSearchParams();
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
  const resumo = await api('/estoque/resumo');

  if (!resumo.dataReferencia) {
    document.getElementById('avisoSemEstoque').hidden = false;
    document.getElementById('conteudoEstoque').hidden = true;
    return;
  }

  document.getElementById('avisoSemEstoque').hidden = true;
  document.getElementById('conteudoEstoque').hidden = false;

  // Preenche seletor de datas (apenas na primeira vez ou se mudou)
  const seletor = document.getElementById('seletorDataEstoque');
  const lista = await api('/estoque?pageSize=1');
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

  const params = new URLSearchParams({ page: estado.estoque.pagina, pageSize: estado.estoque.pageSize });
  if (estado.estoque.data) params.set('data', estado.estoque.data);
  if (q) params.set('q', q);
  if (situacao) params.set('situacao', situacao);
  if (autonomia) params.set('autonomia', autonomia);

  // Filtros por coluna (menus suspensos)
  FILTROS_COLUNA_ESTOQUE.forEach(({ id, coluna }) => {
    const v = document.getElementById(id).value;
    if (v) params.set(coluna, v);
  });

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
      return `
        <tr>
          <td>${it.descricao || '—'}<br><span class="col-codigo">${it.codigo_item}</span></td>
          <td>${fmtNumero(it.demandas)}</td>
          <td>${fmtNumero(it.consumo_mensal_total)}</td>
          <td>${fmtNumero(it.estoque)}</td>
          <td><span class="etiqueta-status ${classe}">${autonomiaTxt}</span></td>
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

async function abrirDetalheEstoque(codigoEncoded) {
  const modal = document.getElementById('modalEstoqueItem');
  const conteudo = document.getElementById('conteudoModalEstoque');
  conteudo.innerHTML = '<p style="color:var(--cinza-texto);">Carregando…</p>';
  modal.hidden = false;

  const dados = await api(`/estoque/item/${codigoEncoded}`);
  const e = dados.estoqueAtual;

  document.getElementById('tituloModalEstoque').textContent = e ? (e.descricao || dados.codigo) : dados.codigo;
  document.getElementById('codigoModalEstoque').textContent = dados.codigo;

  let html = '';

  if (e) {
    html += `
      <div class="grade-resumo" style="grid-template-columns: repeat(4, 1fr); margin-bottom:18px;">
        <div class="cartao-resumo"><div class="numero" style="font-size:22px;">${fmtNumero(e.estoque)}</div><div class="rotulo">Estoque</div></div>
        <div class="cartao-resumo"><div class="numero" style="font-size:22px;">${fmtNumero(e.autonomia)}</div><div class="rotulo">Autonomia (meses)</div></div>
        <div class="cartao-resumo"><div class="numero" style="font-size:22px;">${fmtNumero(e.demandas)}</div><div class="rotulo">Demandas</div></div>
        <div class="cartao-resumo"><div class="numero" style="font-size:22px;">${fmtNumero(e.consumo_mensal_total)}</div><div class="rotulo">Consumo/mês</div></div>
      </div>
    `;
  } else {
    html += '<p style="color:var(--cinza-texto);">Este item não consta no relatório de estoque mais recente.</p>';
  }

  // Lotes e validades (vindos do relatório de estoque)
  if (e) {
    const lotes = parsearLotes(e.lotes);
    html += '<h4 style="margin:18px 0 8px; font-size:14px; font-family:var(--fonte-titulo);">Lotes e validades</h4>';
    if (lotes.length === 0) {
      html += '<p style="color:var(--cinza-texto); font-size:13px;">Sem informação de lote para este item no relatório.</p>';
    } else {
      html += `<table style="font-size:12.5px;"><thead><tr><th>Lote</th><th>Validade</th><th>Quantidade</th><th>Fabricante</th></tr></thead><tbody>`;
      html += lotes.map((l) => {
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
          <td style="font-size:11.5px; color:var(--cinza-texto);">${l.fabricante}</td>
        </tr>`;
      }).join('');
      html += '</tbody></table>';
    }
  }

  // Situação de compra judicial
  html += '<h4 style="margin:18px 0 8px; font-size:14px; font-family:var(--fonte-titulo);">Compras no controle judicial</h4>';
  if (dados.compras.length === 0) {
    html += '<p style="color:var(--cinza-texto); font-size:13px;">Nenhuma compra registrada para este item no controle judicial.</p>';
  } else {
    if (dados.temCompraAberta) {
      html += '<p style="font-size:12.5px; color:var(--selo); margin:0 0 8px;">✓ Este item tem compra em aberto (em andamento).</p>';
    }
    html += `<table style="font-size:12.5px;"><thead><tr><th>Período</th><th>Modalidade</th><th>Empenho</th><th>Previsão</th><th>Status</th></tr></thead><tbody>`;
    html += dados.compras.map((c) => {
      const classe = classeStatus(c.status, c.data_previsao_entrega);
      const rotulo = rotuloStatus(c.status, c.data_previsao_entrega);
      return `<tr>
        <td>${c.mes}/${c.ano}</td>
        <td>${c.modalidade_compra || '—'}</td>
        <td>${c.n_empenho || '—'}</td>
        <td class="col-data">${formatarData(c.data_previsao_entrega)}</td>
        <td><span class="etiqueta-status ${classe}">${rotulo}</span></td>
      </tr>`;
    }).join('');
    html += '</tbody></table>';
  }

  // Histórico de estoque (evolução)
  if (dados.historicoEstoque.length > 1) {
    html += '<h4 style="margin:18px 0 8px; font-size:14px; font-family:var(--fonte-titulo);">Evolução do estoque</h4>';
    html += `<table style="font-size:12.5px;"><thead><tr><th>Data</th><th>Estoque</th><th>Autonomia</th><th>Demanda</th></tr></thead><tbody>`;
    html += dados.historicoEstoque.map((h) => `
      <tr>
        <td class="col-data">${formatarData(h.data_referencia)}</td>
        <td>${fmtNumero(h.estoque)}</td>
        <td>${fmtNumero(h.autonomia)}</td>
        <td>${fmtNumero(h.demandas)}</td>
      </tr>
    `).join('');
    html += '</tbody></table>';
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

    // Clicar numa linha filtra pelo medicamento → cards recalculam para ele
    corpo.querySelectorAll('.linha-clicavel').forEach((tr) => {
      tr.addEventListener('click', () => {
        document.getElementById('filtroBuscaValidades').value = tr.dataset.codigo;
        carregarValidades();
      });
    });
  }

  document.getElementById('textoContagemValidades').textContent =
    `${dados.lotes.length} lote(s) exibido(s) · ${fmtNumero(r.totalLotes)} no total · valor total ${reais(r.valorTotal)}`;
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

    el.innerHTML = `<div class="bloco-resultado-importacao">
      <div class="linha"><span>Data de referência</span><strong>${formatarData(dados.dataReferencia)}</strong></div>
      <div class="linha"><span>Itens importados</span><strong>${dados.totalItens}</strong></div>
      <div class="linha"><span>Alertas de ruptura</span><strong>${dados.alertasRuptura}</strong></div>
      <div class="linha"><span>Alertas de estoque baixo</span><strong>${dados.alertasEstoqueBaixo}</strong></div>
      <div class="linha"><span>Compra em aberto + demanda zero</span><strong>${dados.alertasCompraDemandaZero}</strong></div>
    </div>`;
    document.getElementById('botaoConfirmarEstoque').disabled = true;
    estado.estoque.data = dados.dataReferencia;
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
async function carregarUsuarios() {
  const { usuarios } = await api('/usuarios');
  const corpo = document.getElementById('corpoTabelaUsuarios');
  corpo.innerHTML = usuarios.map((u) => `
    <tr>
      <td>${u.nome}</td>
      <td class="col-codigo">${u.email}</td>
      <td><span class="etiqueta-status ${u.perfil === 'admin' ? 'finalizado' : 'andamento'}">${u.perfil === 'admin' ? 'Admin' : 'Consulta'}</span></td>
      <td><span class="etiqueta-status ${u.ativo ? 'finalizado' : 'cancelado'}">${u.ativo ? 'Ativo' : 'Inativo'}</span></td>
      <td><button class="botao-editar" data-id="${u.id}">Editar</button></td>
    </tr>
  `).join('');

  corpo.querySelectorAll('.botao-editar').forEach((btn) => {
    btn.addEventListener('click', () => abrirModalUsuario(usuarios.find((u) => u.id === Number(btn.dataset.id))));
  });
}

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

// -------------------- Inicialização --------------------
(async function iniciar() {
  try {
    await carregarUsuario();
    preencherAnos();
    document.getElementById('telaCarregando').hidden = true;
    document.querySelector('.app-shell').hidden = false;
    await mudarPagina('painel');
  } catch (e) {
    // carregarUsuario já redireciona para login em caso de 401.
    // Para qualquer outro erro (ex: servidor indisponível), redireciona também.
    if (!window.location.href.includes('login.html')) {
      window.location.href = '/login.html';
    }
  }
})();
