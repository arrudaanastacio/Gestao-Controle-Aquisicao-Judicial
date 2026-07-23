// =====================================================================
// enviarComparativoEmail.js
// Envia o Comparativo de Autores por e-mail: resumo no corpo + 3 planilhas
// CSV anexas (pacientes novos, pacientes inativos, alterações).
// Reaproveita o transportador SMTP do emailAlerta.js.
// =====================================================================
const { obterTransportador } = require('./emailAlerta');

function erro(msg, status, codigo) {
  const e = new Error(msg);
  e.status = status; e.codigo = codigo;
  return e;
}

// Escapa um campo para CSV com separador ";" (padrão que o Excel-BR entende).
function campoCsv(v) {
  const t = v === null || v === undefined ? '' : String(v);
  return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}
function montarCsv(cols, linhas) {
  const corpo = [cols, ...linhas].map((l) => l.map(campoCsv).join(';')).join('\r\n');
  return '﻿' + corpo;   // BOM para acento sair certo no Excel
}

// As três listas na mesma estrutura de colunas usada na tela.
function csvNovos(d) {
  return montarCsv(
    ['ID Demanda', 'Autor', 'Protocolo', 'Processo', 'Tipo da Demanda', 'Cód. Item', 'Descrição do Item', 'Qtde de Consumo'],
    d.novos.map((n) => [n.id_demanda, n.autor, n.protocolo, n.processo, n.tipo_demanda, n.codigo_item, n.descricao_item, n.qtde_consumo]),
  );
}
function csvInativos(d) {
  return montarCsv(
    ['Autor', 'Processo', 'Último Item'],
    d.encerrados.map((e) => [e.autor, e.processo || '—', e.ultimo_item]),
  );
}
function csvAlteracoes(d) {
  return montarCsv(
    ['Autor', 'Protocolo', 'Cód. Item', 'Categoria', 'Qtde Consumo', 'Alteração', 'Detalhe'],
    d.alteracoes.map((a) => [a.autor, a.protocolo, a.codigo_item, a.categoria, a.qtde_consumo, a.alteracao, a.detalhe]),
  );
}

function fmtData(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || '—';
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

async function enviarComparativoPorEmail(para, usuarioEmail) {
  const t = obterTransportador();
  if (!t) throw erro('E-mail não está configurado no servidor (SMTP ausente no .env).', 400, 'SEM_SMTP');

  const { calcularComparacao } = require('./routes.autores');
  const d = calcularComparacao();
  if (!d.temAnterior) {
    throw erro('Ainda não há duas versões da Listagem de Autores para comparar.', 400, 'SEM_COMPARATIVO');
  }

  // Valida os destinatários (separados por ; ou ,).
  const lista = para.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
  const invalido = lista.find((x) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
  if (invalido) throw erro(`E-mail inválido: "${invalido}".`, 400, 'EMAIL_INVALIDO');
  if (!lista.length) throw erro('Informe ao menos um e-mail de destino.', 400, 'SEM_DESTINO');

  const nNovos = d.totalNovosPacientes ?? d.novos.length;
  const nInativos = d.encerrados.length;
  const nAlt = d.alteracoes.length;

  // Resumo em HTML — primeiras linhas de cada lista, o resto vai nos anexos.
  const previa = (titulo, cabec, linhas, total) => {
    if (!total) return `<h3>${titulo} (0)</h3><p>Sem registros.</p>`;
    const cab = cabec.map((c) => `<th align="left">${c}</th>`).join('');
    const corpo = linhas.map((l) => '<tr>' + l.map((c) => `<td>${(c ?? '—')}</td>`).join('') + '</tr>').join('');
    const nota = total > linhas.length ? `<p><em>… e mais ${total - linhas.length}. Lista completa no anexo.</em></p>` : '';
    return `<h3>${titulo} (${total})</h3>`
      + `<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;font-size:13px;">`
      + `<tr>${cab}</tr>${corpo}</table>${nota}`;
  };

  const html = `
    <div style="font-family:Arial,sans-serif;color:#20302b;">
      <h2>Comparativo de Autores — Tenente Pena</h2>
      <p>Comparação entre a versão de <strong>${fmtData(d.anterior)}</strong> e a de <strong>${fmtData(d.atual)}</strong>.</p>
      <ul>
        <li><strong>Total anterior:</strong> ${d.totalAnterior} pacientes</li>
        <li><strong>Total atual:</strong> ${d.totalAtual} pacientes</li>
        <li><strong>Pacientes novos:</strong> ${nNovos}</li>
        <li><strong>Pacientes inativos:</strong> ${nInativos}</li>
        <li><strong>Alterações:</strong> ${nAlt}</li>
      </ul>
      ${previa('Pacientes novos', ['Autor', 'Protocolo', 'Item', 'Consumo'],
        d.novos.slice(0, 15).map((n) => [n.autor, n.protocolo, n.descricao_item, n.qtde_consumo]), nNovos)}
      ${previa('Pacientes inativos', ['Autor', 'Processo', 'Último item'],
        d.encerrados.slice(0, 15).map((e) => [e.autor, e.processo, e.ultimo_item]), nInativos)}
      ${previa('Alterações', ['Autor', 'Item', 'Alteração'],
        d.alteracoes.slice(0, 15).map((a) => [a.autor, a.codigo_item, a.alteracao]), nAlt)}
      <p style="color:#7a8;font-size:12px;margin-top:18px;">
        As listas completas estão nas 3 planilhas CSV anexas.<br>
        Enviado por ${usuarioEmail} pelo sistema de Compras Judiciais.
      </p>
    </div>`;

  const stamp = (d.atual || '').replace(/-/g, '');
  await t.sendMail({
    from: process.env.SMTP_USER,
    to: lista.join(', '),
    subject: `Comparativo de Autores — ${fmtData(d.atual)} (${nNovos} novos, ${nInativos} inativos, ${nAlt} alterações)`,
    html,
    attachments: [
      { filename: `pacientes-novos_${stamp}.csv`, content: csvNovos(d) },
      { filename: `pacientes-inativos_${stamp}.csv`, content: csvInativos(d) },
      { filename: `alteracoes_${stamp}.csv`, content: csvAlteracoes(d) },
    ],
  });

  return { destinatarios: lista, novos: nNovos, inativos: nInativos, alteracoes: nAlt };
}

module.exports = { enviarComparativoPorEmail };
