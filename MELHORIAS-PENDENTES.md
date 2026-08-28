# Melhorias pendentes de publicação

> Lista do que já está pronto e testado em **homologação** mas ainda não foi
> para **produção**. Atualizada a cada melhoria nova. Quando o Rafael disser
> "Publicar", decidimos juntos o que entra dessa lista.

| # | Melhoria | Commit (homologação) | Data | Status |
|---|----------|----------------------|------|--------|
| 1 | Etiqueta de subcategoria no modal da Requisição de Compra | eb392ff | 17/08/2026 | 🚀 PUBLICADO (prod 1d9c727) |
| 2 | Requisição — modo "Por Item" (ex-"Solicitação Coletiva"): consolidada + filtro de paciente | 699e0ab | 17/08/2026 | 🚀 PUBLICADO (prod 1d9c727) |
| 3 | Requisição — etiqueta de ATA por item (ATA / Avaliação técnica / Sem ATA) | 179eeaa | 18/08/2026 | 🚀 PUBLICADO (prod 1d9c727) |
| 4 | Atas — busca direta do SISCOA (login automático + download), sem depender do arquivo na rede: botão "Buscar do SISCOA agora" + rotina diária | f1de8e4 | 19/08/2026 | 🚀 PUBLICADO (prod d039aed) |
| 5 | Listagem de Autores (TP e Demais Unidades) — modal "Ver" passa a mostrar Demanda, Consumo, Estoque e Autonomia da respectiva unidade | b3b2a1b | 19/08/2026 | 🚀 PUBLICADO (prod 1d9c727) |
| 6 | Menu lateral — botão 📌 para fixar/desafixar (mantém o menu aberto e desloca o conteúdo); preferência lembrada no navegador | cb7eb5c | 19/08/2026 | 🚀 PUBLICADO (prod d039aed) |
| 7 | Modal "Ver" dos Autores (TP e Demais Unidades) — etiquetas de subcategoria e Dose Certa (e demais de programa) no topo | 6447da7 | 19/08/2026 | 🚀 PUBLICADO (prod 1d9c727) |
| 8 | Requisição GSNET — remover casa decimal (ex.: "6119.0" → "6119") na exibição e na importação (TP) | e95bddd | 19/08/2026 | 🚀 PUBLICADO (prod 0c24cf2) |
| 9 | Modal de Permissões — aproveita a largura da tela, tabela 100%, rolagem vertical com cabeçalho fixo | c444a68 | 20/08/2026 | 🚀 PUBLICADO (prod 39c2f76) |
| 10 | Comparativo de Autores — filtros de subcategoria e tipo de demanda (valem para as 3 abas: Novos, Inativos, Alterações) | 4866755 | 20/08/2026 | 🚀 PUBLICADO (prod 1d9c727) |
| 11 | Relatório de Primeiro Atendimento — caixas por categoria (Materiais/Medicamentos/Nutrição/Manipulado) com permissão por usuário | 455ddf5 | 20/08/2026 | 🚀 PUBLICADO (prod 1d9c727) |
| 12 | Nova tela "Listagem de Autores Importados" (grupo Importados): pacientes ativos, todas as unidades, itens importados | b6adc4e | 20/08/2026 | 🚀 PUBLICADO (prod 1d9c727) |
| 13 | Importados — Relatório de Compras (todas as solicitações, colunas completas, ciclos, status condicionais) + Tabela Análise (só Embarque/Instrução Processual/Solicitado) | (ver commits) | 20/08/2026 | 🚀 PUBLICADO (prod 1d9c727) |
| 14 | Estoque (TP e Demais Unidades) — botão Exportar Excel (CSV) com colunas SCODES/Siafísico/Medicamento/Categoria/Subcategoria/Demanda·Consumo (total, Judicial, Adm, Jefaz)/Estoque/Autonomia/CATMAT/Valor Médio | 74030f4 | 21/08/2026 | 🚀 PUBLICADO (prod 7e2cce1) |
| 15 | Regra geral: telas que dependem de importação mostram DATA e HORA (helper `horaImportacao`) | 3face2b | 25/08/2026 | 🚀 PUBLICADO (prod 3face2b) |
| 16 | Correção de permissão: detalhe do item no Relatório de Primeiro Atendimento acessível a quem tem o relatório (sem exigir Comparativo) | 894dcdf | 25/08/2026 | 🚀 PUBLICADO (prod 894dcdf) |
| 17 | Monitoramento de Estoque — Qtde. Aquisição consolidada (TP+OD, AS+JS), Compra em Andamento (selo + status), filtros (sub-categoria, status estoque, situação final, compra) e busca ampliada | (sync) | 25/08/2026 | 🚀 PUBLICADO (prod 1d9c727) |
| 18 | Monitoramento — análises de cobertura: Cobertura da Aquisição, Autonomia Total após Recebimento, Previsão de Falta Projetada, Situação da Aquisição, Saldo Necessário, Situação da Cobertura + Autonomia Alvo configurável (`autonomia_alvo_meses`) | (sync) | 25/08/2026 | 🚀 PUBLICADO (prod 1d9c727) |
| 19 | Nova tela **Estoque IBL (API)** — consulta ao vivo do WMS IBL (locais 2999/3004), abas Por Lote e Consolidado por SKU (botão Ver → lotes/validades), export CSV. Token só no `.env` | (sync) | 25/08/2026 | 🚀 PUBLICADO (prod 1d9c727) |
| 20 | Saldo IBL de Outras Demandas (consolidado + validade + lotes) no modal "Ver" de Estoque TP, Estoque Geral e Listagem de Autores (cache 5 min) | (sync) | 25/08/2026 | 🚀 PUBLICADO (prod 1d9c727) |
| 21 | Abas em formato de **pasta** (estilo relevo) em todas as abas de conteúdo do sistema | (sync) | 25/08/2026 | 🚀 PUBLICADO (prod 1d9c727) |
| 22b | Busca tolerante a acento e maiúsc./minúsc. em todo o sistema (LIKE do SQLite sobrescrito + helper `normalizarBusca`), sem alterar os dados | db02c7b | 25/08/2026 | 🚀 PUBLICADO (prod db02c7b) |
| 23b | Autores Importados — modo "Por Item": escolhe item → seleciona pacientes (desabilita quem já consta, com "Incluir mesmo assim") → etapa de valores (Qtde/Valor/Total/SEI/GSNET/datas/status) com "Repetir SEI·GSNET·Data Solic. nos demais"; grava via POST+PUT | c9583c2 | 25/08/2026 | 🚀 PUBLICADO (prod c9583c2) |
| 24b | Requisição Coletiva — corrige alinhamento das colunas (colspan) + botão "👁 Ver itens" listando itens e código SCODES | c9583c2 | 25/08/2026 | 🚀 PUBLICADO (prod c9583c2) |
| 25b | Requisição Coletiva — Status Estoque agregado na linha (Chamar se todos ≥2m; Aguardar/Atend. Parcial se algum <2m) + Estoque/Autonomia/Status Estoque por item no "Ver itens" | ffde2d0 | 25/08/2026 | 🚀 PUBLICADO (prod ffde2d0) |
| 26b | Requisição Coletiva — editar a Qtde solicitada direto no modal "Ver itens" (salva ao sair do campo) | 02f3869 | 25/08/2026 | 🚀 PUBLICADO (prod 02f3869) |
| 27b | Primeiro Atendimento — abas em ordem (Todas · alfabético) + abas Cancelado/Finalizado à direita (migram por status); Status Cancelado exige justificativa; abas em estilo pasta | 4fdf42c | 25/08/2026 | 🚀 PUBLICADO (prod 4fdf42c) |
| 28b | Filipeta da solicitação coletiva — seção de pacientes vira bloco por paciente com os itens que ele pediu (descrição + SCODES + SIAF) e a qtde individual (soma bate com o consolidado) | 62221b4 | 26/08/2026 | 🚀 PUBLICADO (prod 62221b4) |
| 29b | Relatório de Primeiro Atendimento — filtro de Status Estoque (Chamar / Aguardar / Sem dado); individual pela autonomia, coletiva pela regra agregada | e23751f | 26/08/2026 | 🚀 PUBLICADO (prod e23751f) |
| 30b | Modal "Ver" do estoque (TP e Geral) — coluna Qtd. pendente nas compras, destacando o que falta receber nos itens com status Entrega Parcial | cbd35dc | 26/08/2026 | 🚀 PUBLICADO (prod cbd35dc) |
| 31b | Requisição de Compra (Por paciente) — campo de busca para localizar o item do paciente (medicamento/SCODES/siafísico), acento-insensitive, preservando seleções | dafa36b | 26/08/2026 | 🚀 PUBLICADO (prod dafa36b) |
| 32b | Estoque IBL nos modais "Ver" (Estoque TP e Itens em Estoque Demais Unidades) — mostrar só lotes com validade vigente; vencidos saem da lista e dos saldos (v1.16.1) | f5b13b1 | 27/08/2026 | 🚀 PUBLICADO (prod f5b13b1) |
| 33b | Correção de grafia do status **Adjucado → Adjudicado** em todo o sistema (dropdowns, filtros "em aberto", doc) + normalização no importador + dados legados do banco atualizados (v1.16.2) | 80308b6 | 27/08/2026 | 🚀 PUBLICADO (prod 80308b6) |
| 34b | Alerta de **siafísico duplicado** — considerar apenas itens **Sem Marca** (coluna marca ou descritivo terminando em "sem marca"); recorte vale para definir a duplicidade e para a lista; itens de marca deixam de contar (v1.16.3) | b6d48fb | 27/08/2026 | 🚀 PUBLICADO (prod b6d48fb) |
| 35b | **Reabrir requisição** no Relatório de Primeiro Atendimento — botão "↺ Reabrir" (individual reabre em Por paciente p/ incluir itens; coletiva reabre em Por Item já com itens/pacientes marcados p/ incluir pacientes/medicamentos); mesmo nº de controle, status volta a Solicitado; ≥2 pac.=coletiva, 1=individual; colaborador só reabre se sem telegrama enviado (senão só admin) (v1.17.0) | 676d0a5 | 27/08/2026 | 🚀 PUBLICADO (prod 676d0a5) |
| 36b | Reabrir — popup **Individual/Coletiva** na linha individual (Individual = tela Por paciente; Coletiva = tela Por Item p/ incluir outros pacientes); individual pode **virar coletiva** no mesmo nº de controle (coletiva vai direto p/ Por Item) (v1.18.0) | 598405e | 27/08/2026 | 🚀 PUBLICADO (prod 598405e) |
| 37b | **Rupturas** — botão "Atualizar agora" passa a reimportar **o período selecionado** no filtro (não só os últimos 30 dias), corrigindo divergência com a API ao vivo quando o intervalo tem dias fora da janela móvel (v1.18.1) | 8c02c58 | 28/08/2026 | 🚀 PUBLICADO (prod 8c02c58) |
| 38b | **Rupturas** — botão **"Carregar"** para cravar o período (datas não recarregam mais no change; Enter também carrega) + indicador **"X linha(s) no período"** na aba Lista + card "Total de linhas"; Atualizar/Exportar/refino usam o período cravado (v1.19.0) | 8d917e5 | 28/08/2026 | 🚀 PUBLICADO (prod 8d917e5) |
| 39b | **Rupturas** — corrige **duplicidade de borda** (a API UDTP devolve `fim+1`; importador só gravava linhas dentro do período pedido) + **"Atualizar agora" só admin** (botão escondido + `exigirPerfil` na rota); dados de produção corrigidos (v1.19.1) | ad309ec | 28/08/2026 | 🚀 PUBLICADO (prod ad309ec) |
| 40b | **Rupturas** — linha **Total** das quebras (Por categoria / Por tipo) passa a somar **Itens** e **Pacientes** (pacientes com aviso de que a soma pode passar do total distinto) (v1.19.2) | e73ded7 | 28/08/2026 | 🚀 PUBLICADO (prod e73ded7) |
| 41b | **Rupturas** — Total de **Pacientes** nas quebras vira o nº **distinto** (igual ao card "Pacientes impactados" e igual nas duas tabelas); antes a soma por linha divergia (779 vs 759) por contar o mesmo paciente em vários grupos (v1.19.3) | 6581c89 | 28/08/2026 | 🚀 PUBLICADO (prod 6581c89) |
| 42b | **Rupturas (Andamento de compra)** — tooltips (ⓘ) nas colunas **Rupturas** e **Pacientes** explicando a composição (ocorrências × pessoas distintas; Rupturas − Pacientes = repetições) (v1.19.4) | bcbb12d | 28/08/2026 | 🚀 PUBLICADO (prod bcbb12d) |
| 43b | **Rupturas (Indicadores)** — mesmos tooltips (ⓘ) nas quebras Por categoria / Por tipo (Rupturas, Itens e Pacientes, com a nota do Total distinto) (v1.19.5) | d2ab3fa | 28/08/2026 | 🚀 PUBLICADO (prod d2ab3fa) |
| 44b | **Rupturas (Andamento de compra)** — filtro "Mostrar:" (Todos/Nunca comprado/Sem compra em aberto/Compra em andamento) no **formato de pasta** (CSS escopado ao id) (v1.19.6) | b533d0a | 28/08/2026 | 🚀 PUBLICADO (prod b533d0a) |

### Detalhe do item 12 — Listagem de Autores Importados

Nova tela **Listagem de Autores Importados**, em um novo grupo de menu
**🌐 Importados**. Mostra os **pacientes ativos** (status "Demanda Ativa"), de
**todas as unidades**, cujos itens são **importados** (flag do catálogo:
`relatorio_itens.importado = 'Sim'`). Mesmo layout, filtros e modal 👁 "Ver"
da "Listagem de Autores Demais Unidades".

- **Backend:** novo escopo `escopoUnidade=importados` em `montarFiltroAutores`
  e na rota `/autores/filtros` (todas as unidades + demanda ativa + item
  importado). Reaproveita `/autores`, `/autores/exportar` e `/autores/filtros`.
- **Permissão:** novo módulo `autoresImportados` (Visualizar/Exportar) — aparece
  no modal de Permissões automaticamente.
- **Frontend:** clone da tela Demais Unidades (`paginaAutoresImportados` +
  `carregarTabelaAutoresImportados`), link no menu, ícone e trilha.

**Observação:** como mexe em `routes.autores.js` (compartilhado), **anda junto
da Onda B** na publicação. **Pós-publicação:** reiniciar produção (backend) + Ctrl+F5.

### Detalhe do item 11 — Caixas do Relatório de Primeiro Atendimento

O Relatório de Primeiro Atendimento passa a ter **abas por caixa**: **Materiais,
Medicamentos, Nutrição** (+ **Todas**, e **Sem caixa** só para o admin). Cada
solicitação cai na sua caixa **na criação**; o admin vê tudo e cada colaborador
vê só a(s) caixa(s) que o admin liberou.

- **Regra da caixa (por item):** subcategoria **Manipulado** → Medicamentos;
  senão pela **categoria do Relatório de Itens** (Materiais/Medicamentos/Nutrição);
  o resto (Procedimentos/Outros Itens) fica **sem caixa** (só admin, aba "Todas").
  A solicitação inteira vai para a caixa **predominante** dos seus itens.
- **Backend:** `caixaAtendimento.js` (regra + cache); coluna `requisicoes.caixa`
  (gravada na criação + backfill único ao subir); coluna `usuarios.caixas_req`
  (JSON das caixas liberadas; null = todas). `/requisicoes/itens` filtra por
  permissão + aba e devolve as contagens por caixa.
- **Permissões:** no modal de Permissões, seção nova com as 3 caixas por usuário
  (admin sempre vê todas). `/usuarios/:id/permissoes` GET/PUT tratam `caixasReq`.
- **Frontend:** barra de abas no relatório (reaproveita `.chip-faixa`).

**Pós-publicação:** reiniciar produção (backend + migração + backfill) + Ctrl+F5.

### Detalhe do item 1

No modal 🛒 **Requisição de Compra** (lista de itens do paciente), cada item
ganha a **etiqueta de Sub-categoria** (mesmo estilo `tag-programa sub` do
Estoque). Backend: `/autores/paciente` passa a trazer `subcategoria` (subquery
em `item_classificacao`). **Pós-publicação:** reiniciar produção (backend) + Ctrl+F5.

### Detalhe do item 7 — Etiquetas de programa no modal "Ver" dos Autores

No topo do modal 👁 **Ver** (abaixo do nome/descrição), nas duas listagens de
autores, aparecem as **etiquetas de programa** do item: **Subcategoria**,
**Dose Certa** (só quando "Sim"), e também **Outras Demandas** e **Inex** quando
o item pertencer — reaproveitando `etiquetasProgramaHTML()` e os estilos do
Estoque. Fonte: `item_classificacao` (dose_certa, inex, subcategoria) e
`relatorio_itens.outras_demandas`, por `codigo_item`. Vêm no mesmo endpoint
`/autores/estoque-unidade`. **Pós-publicação:** reiniciar produção (backend) + Ctrl+F5.

### Detalhe do item 5 — Estoque da unidade no modal "Ver" dos Autores

Na **Listagem de Autores** (Tenente Pena **e** Demais Unidades), o modal 👁 **Ver**
de cada linha passa a mostrar, além de Prazo/Periodicidade/datas, um bloco
**"Estoque — <unidade>"** com **Demanda, Consumo médio mensal, Estoque e
Autonomia** daquele item **na unidade dispensadora daquela linha** (não só a TP).

- Backend: novo endpoint `GET /autores/estoque-unidade?codigo_item=&unidade=`
  que cruza `estoque_itens.unidade` com `autores_itens.unidade_dispensadora`
  (mesmo texto, ex.: "UD 01 - Tenente Pena") e devolve a foto mais recente.
  Carrega **sob demanda** (1 linha por clique) para não pesar a listagem.
- Se a unidade não tiver estoque importado, mostra "Sem dados de estoque para
  esta unidade" (comum em unidades pequenas que não vêm no relatório).
- Frontend: `abrirDetalheDemanda` virou async e busca o bloco; `btDadosDemanda`
  passou a levar `codigo_item` e `unidade`.
**Pós-publicação:** reiniciar produção (backend) + Ctrl+F5.

### Detalhe do item 4 — Atas: busca direta do SISCOA

Agora o sistema busca o relatório de **Atas de Registro de Preço** direto do
site do **SISCOA** (`siscoa.saude.sp.gov.br`), por HTTP autenticado, sem
depender do arquivo `Atas SISCOA.xls` copiado na pasta de rede.

- **Como funciona:** login por sessão (`GET /login` → `POST /login/logar` com
  `loginEmail`/`loginSenha`) e download do export DisplayTag do relatório
  (formato Excel). O XLS baixado cai no **mesmo** `importarAtasDeBuffer` que já
  existia — tabela, regras de vigência e a tela de Atas ficam idênticas.
- **Botão "🔄 Buscar do SISCOA agora"** na tela de Atas (só admin) — baixa e
  importa na hora.
- **Rotina diária automática** às 06:00 (igual à UDTP), com recuperação se o
  PC subir depois do horário. Aparece na tela **Status dos Serviços** como
  "Atas do SISCOA (busca direta)".
- **Credenciais:** `SISCOA_USUARIO` / `SISCOA_SENHA` no `.env` local (o robô de
  extração já usava as mesmas). **Nunca vão pro GitHub** (repo público).
- Novos arquivos: `siscoaApi.js` (cliente), `vigiaAtasSiscoa.js` (agendador),
  `testarSiscoa.js` (diagnóstico). O vigia de arquivo antigo (`vigiaAtas.js`)
  **continua ativo** — dá pra desligar depois com `AUTO_IMPORTAR_ATAS=false`,
  já que agora a fonte direta cobre o mesmo.
- **.env novos:** `AUTO_IMPORTAR_ATAS_SISCOA` (padrão on), `HORA_SYNC_ATAS`
  (6), `MINUTO_SYNC_ATAS` (0).

**Pós-publicação:** preencher `SISCOA_USUARIO`/`SISCOA_SENHA` no `.env` de
produção, reiniciar produção (backend) + Ctrl+F5.

### Detalhe do item 3 — Etiqueta de ATA na Requisição de Compra

Nos dois fluxos da Requisição (**Por paciente** e **Por Item**), cada
medicamento ganha uma **etiqueta de ATA**, cruzando o **siafísico** com o
módulo de **Atas de Registro de Preço** (foto mais recente, só atas vigentes:
vencimento ≥ hoje) e com a **marca do estoque** (SCODES) — a **mesma regra do
Planejamento** (`planejamentoMotor.js`):

- **ATA** (verde, clicável) — siafísico tem ata vigente e a marca é "Sem Marca"
  (ou bate com a da ata). Ao clicar, abre **nome comercial, nº da ATA, detentor
  e vencimento**.
- **Avaliação técnica** (âmbar) — tem ata vigente mas a marca do estoque é
  **diferente** da ata. Aparecem os botões **ATA / SEM ATA** para o técnico
  decidir (a decisão fica **só nesta requisição**; qualquer um que abre a
  requisição pode escolher).
- **Sem ATA** (cinza) — o siafísico não retornou nenhuma ata vigente.

Backend: novo `ataSituacao.js` (com cache por item — 1 cálculo por medicamento,
essencial na coletiva de milhares de pacientes); `/autores/paciente` e
`/autores/itens-pacientes` passam a trazer `ata` por item. Persistência (só
grava, não aparece no documento impresso): colunas `situacao_ata` e
`escolha_ata` em `requisicao_itens` (migração idempotente). Frontend:
`htmlEtiquetaAta()` + estados no `estilo.css`.
**Pós-publicação:** reiniciar produção (backend + migração) + Ctrl+F5.

**Extras (mesmo commit):**
- **Quantidade de demanda antes do estoque** no cartão do item (nos dois
  fluxos): a etiqueta passa a mostrar `demanda X · estoque Y · autonomia Z m`
  (fonte: `estoque_itens.demandas` da foto TP mais recente).
- **Valor unitário e Valor total na filipeta impressa** (documento por paciente
  e documento consolidado da coletiva): duas colunas novas + linha **Total da
  aquisição**. Total = valor unitário × Qtde de Aquisição. Gravado na requisição
  (`requisicao_itens.valor_unitario`) para valer também ao reabrir.
- **Valor unitário conforme a etiqueta:** item **ATA** (ou Avaliação técnica com
  o técnico escolhendo **ATA**) usa o **último valor publicado da ATA**; as
  demais etiquetas usam o **valor médio** (`valor_medio_unitario`). Se o valor
  vier **vazio/zero**, o cartão libera um **campo para o técnico informar** o
  valor (repinta automaticamente quando a escolha ATA/SEM ATA muda). No Por Item
  o valor é único por medicamento (nível da aba). Backend: `ataSituacao.js`
  passa a devolver `valor` (da ata); `/paciente` e `/itens-pacientes` trazem
  `valor_medio`.
- **Aviso ao misturar ATA e SEM ATA:** antes de gerar (nos dois fluxos), se a
  requisição tiver itens **com ATA** e itens **SEM ATA** juntos, um pop-up mostra
  a contagem de cada modalidade, recomenda separar a aquisição e termina com
  **"Tem certeza disso?"** — só gera se confirmar. (Correção junto: no fluxo Por
  paciente o `corpoItens` agora envia `situacao_ata`/`escolha_ata`/`valor_unitario`
  ao backend — antes eram descartados na montagem do payload.) Etiqueta ajustada
  para **"SEM ATA"** (maiúsculas).

### Detalhe do item 2 — modo "Por Item" CONSOLIDADO (abas por medicamento)

**Refinamento de UX (nova etapa, só frontend):** o botão do modo foi renomeado
de "Solicitação coletiva" para **"Por Item"**. Dentro de cada aba de medicamento,
em vez de listar TODOS os pacientes de uma vez (inviável para itens com milhares,
ex. dieta enteral), agora há um **campo de filtro de paciente** (nome/processo/
protocolo, sem acento). Os resultados aparecem como linhas compactas; **ao clicar
em "+ selecionar"** o paciente vira um **cartão detalhado** (mesmos dados do fluxo
por paciente: tipo de demanda, consumo, prazo, periodicidade, dispensações,
estoque/autonomia + autonomia de compra individual e Qtde de Aquisição). Cartões
selecionados ficam numa seção "Pacientes selecionados" (com ✕ para remover).
Nenhum paciente vem marcado por padrão; **"Marcar todos os filtrados"** age só
sobre o subconjunto do filtro (confirma se > 200). Só `frontend/` (index.html +
app.js) — **Ctrl+F5**, sem reiniciar.

**Consolidação (etapa anterior, tem backend):** a coletiva agora gera **UM único número de
controle** (não mais N). No **Relatório de Primeiro Atendimento** vira **1 linha**
("Fulano e mais N pacientes", etiqueta **COLETIVA**, "X medicamento(s) · Y
paciente(s)"), com **status/telegrama ÚNICO do grupo**. Ao **clicar no controle**,
abre o **documento consolidado**: SEI, **total por medicamento** (qtde somada +
nº de pacientes) e a **lista de pacientes** (nome/protocolo/processo).
Banco (migração idempotente): `requisicoes` ganhou `coletiva`, `total_pacientes`,
`pacientes_json` e status do grupo; `requisicao_itens` ganhou `detalhe_json`,
`n_pacientes`. Backend: `/requisicoes/coletiva` consolida; `/requisicoes/itens`
mescla itens individuais + coletivas (1 linha); `/requisicoes/:id` devolve
pacientes+detalhe; novo `PUT /requisicoes/:id/status-coletiva`.
**Pós-publicação:** reiniciar produção (backend + migração) + Ctrl+F5.

---
_Histórico do item 2 (etapas anteriores):_

### Detalhe do item 2 — Solicitação Coletiva (abas por medicamento)

Novo **modo "Solicitação coletiva"** no modal de Requisição de Compra. Modelo
com **uma aba por medicamento**: busca um medicamento → vira **aba** com a lista
de pacientes que o têm, **cada paciente com os mesmos dados do fluxo por
paciente** (tipo de demanda, consumo, prazo, periodicidade, dispensações,
estoque/autonomia) + **autonomia de compra INDIVIDUAL** (e Qtde de Aquisição =
consumo × autonomia). Botão **+ Inserir medicamento** abre a busca e cria nova
aba; **navegar entre abas preserva** o que já foi selecionado (contagem por aba).
Cada aba tem ✕ para remover. **Um único SEI**. **Marcar todos** age na aba
atual. Contador geral = pacientes únicos · itens · aquisição total. **Gerar**
agrupa por paciente e cria **1 requisição por paciente** com os itens marcados
(de todas as abas). **Fechar** pede confirmação (perde a solicitação montada).
Backend (já pronto): `itens-busca`, `itens-pacientes`, `requisicoes/coletiva`.
Só frontend nesta etapa. **Pós-publicação:** reiniciar produção (backend das
etapas anteriores) + Ctrl+F5.

## Publicadas recentemente

### 17/08/2026 — Logos oficiais + textos da tela de login (publicado, commit cf9c268)

Substitui a marca provisória (SVG de 3 nós + wordmark) pelos **logos oficiais**
(arte da CAF), como PNG em `frontend/img/`:
- **Símbolo do infinito** (`ELO_simbolo_alta_resolucao.png`) no topo do menu
  lateral, num chip branco (o símbolo tem partes grafite que sumiriam na barra
  escura).
- **Logo completo** (`ELO_logo_completo_alta_resolucao.png`) na tela de login,
  no lugar do símbolo+nome; cartão de login alargado (360→440px).
- **Texto do login:** parágrafo com o significado do nome ELO (o elo entre
  demandas administrativas/judiciais, estoques e aquisição).
- Só frontend (imagens estáticas) → **Ctrl+F5**, sem reiniciar.

## Publicadas recentemente (histórico)

### 17/08/2026 — Modal de pacientes: coluna Tipo de Demanda (publicado, commit 2ef5676)

No modal de detalhe do item (tabela **Pacientes**), nova coluna **Tipo de
Demanda** logo após o Protocolo, com a etiqueta colorida já usada na Listagem
de Autores (Judicial / Comissão de Farmacologia / Jefaz). Backend:
`routes.estoque.js` passa a selecionar `tipo_demanda` nos pacientes.

### 14/08/2026 — Monitoramento de Estoque (publicado, commit fea4b16)

Detalhe do item — Monitoramento de Estoque

Reproduz a planilha gerencial **"Monitoramento Estoque.xlsm"** como uma **tela
viva** no Elo (menu Estoque → *Monitoramento de Estoque*), alimentada pelo
estoque já importado (nada de Excel manual).

- **Classificação por autonomia** (faixas **fixas da planilha**): demanda 0 →
  *Sem Demanda* · autonomia 0 → *Estoque Zero* · <1 → *Baixo* · 1–2 → *Crítico*
  · 2–5 → *Regular* · ≥5 → *Abastecido*. **Situação Final**: Baixo/Crítico →
  *Crítico*, Zero → *Desabastecido*, resto → *Abastecido*. Também calcula
  *Previsão de Falta* (hoje + autonomia×30) e *Cobertura* (mês em que zera).
- **5 painéis dinâmicos** em SVG puro (sem biblioteca): barras por Status de
  Estoque, barras por Situação Final, rosca de itens por Categoria, rosca de
  demandas por Categoria, barras por Sub-categoria. **Recalculam no navegador
  junto com a busca**.
- **Cross-filter por clique:** clicar em qualquer barra/fatia/legenda (ou nos
  cards de status) filtra **tudo junto** — tabela e os demais gráficos —
  destacando o selecionado (um gráfico não filtra a si mesmo, então continua
  mostrando todas as fatias). Um **chip** mostra o filtro ativo e o botão
  **✕ Limpar filtro** zera busca + recortes (e o seletor de categoria).
- **Exportar para Excel** (botão ⬇): baixa um `.xlsx` com **exatamente os itens
  filtrados na tela** (mesmos filtros: escopo, categoria, comDemanda, busca e
  recortes de clique). Colunas: SCODES, Siafísico, Descrição, Unidade,
  Categoria, Sub-categoria, Marca, Demandas (total/AJ/CF/JEFAZ), Consumo,
  Estoque, Autonomia, Status Estoque, Situação Final, Previsão de Falta,
  Cobertura. Endpoint `GET /api/estoque/monitoramento/exportar` (SheetJS).
- **Tabela classificada** com busca (medicamento/SCODES/siafísico).
- **Filtros:** escopo (Tenente Pena / todas as unidades), categoria e
  **"Somente com demanda"** (ligado por padrão — reproduz o recorte da planilha:
  validado em **1.994 itens** vs. ~1.998 do arquivo original; contagens de status
  batem quase 1:1).
- Backend: `GET /api/estoque/monitoramento` (novo). Frontend: seção
  `paginaMonitoramento` + `carregarMonitoramento()`.
  **Pós-publicação:** reiniciar produção (backend novo) + Ctrl+F5 (frontend).

### 14/08/2026 — E-mail bloqueado pela rede: gerar link de convite + tentativa Office365 (commits dcde94b, d235bfb, 09d3aa9)

- **SMTP forçado a IPv4** (`family:4`) — corrige `ENETUNREACH` (a máquina não tem
  rota IPv6). Depois descobrimos que a rede do governo **bloqueia toda saída SMTP**
  (Gmail 25/465/587 = timeout), mas **libera o Microsoft 365** (`smtp.office365.com:587`).
  O `.env` de produção foi apontado para `smtp.office365.com` + `rafael.arruda@apoioprodesp.sp.gov.br`;
  falta o **TI do Prodesp habilitar o SMTP AUTH** da caixa (erro `535 5.7.139`).
- **Gerar link de convite para copiar** — como o e-mail está bloqueado, o cadastro
  de usuário ganhou a opção (padrão) **"Gerar link para copiar"**: cria o usuário e
  abre um modal com o link de definir-senha + botão **Copiar** (funciona em http://IP:3000),
  para enviar por e-mail/Teams. Convites pendentes ganham **"Copiar link"**. Backend:
  modo `link` no POST e `apenasLink` no reenviar.
  **Pós-publicação:** reiniciar produção (backend); frontend por Ctrl+F5.
- **Mensagem de boas-vindas pronta** no modal do link (commit 09d3aa9, frontend):
  além de "só o link", um campo com o texto completo (saudação com o primeiro nome,
  boas-vindas ao sistema, o link de 48h e o passo a passo para criar a senha) + botão
  **Copiar mensagem** — para colar direto no e-mail/Teams. Só Ctrl+F5.

### 14/08/2026 — Estoque (cards/etiquetas) + Distribuição (coeficiente e Manual) — commits a231ba5, e7e5069, 23351cb, fd04d3d, 7dc2235, d02d024, 19237d1

Quatro melhorias publicadas juntas (empilhadas no histórico):

- **Estoque Geral — cards dinâmicos por programa:** trocados os 5 cards estáticos
  por 4 que reagem à busca/filtros (Judicial · CF/Adm · JEFAZ · Total), com demanda
  e consumo somados de todas as unidades do conjunto filtrado. `/resumo` passou a
  respeitar busca/filtros.
- **Distribuição — coeficiente (alvo em meses) ajustável** por item e por item ×
  unidade, no lugar do alvo fixo de 3. Coluna "Coef" editável + botão "todas".
  0 = não distribuir. Persistente (`distribuicao_coeficiente`). Reposição geral + HE.
- **Distribuição — botão "Manual"** ao lado de "Validar": pergunta a quantidade e
  grava na Grade Final como manual (D.E, rituximabe). Nova coluna `origem` +
  etiqueta Calculada/Manual na Grade Final.
- **Estoque TP e Geral — etiqueta de SubCategoria** (sem repetir a de programa),
  **marca em negrito** (quando ≠ SEM MARCA) e **siafísico ao lado do código SCODES**.

**Pós-publicação (produção):** **reiniciar a produção** (`REINICIAR-PRODUCAO
(porta 3000).bat`) — mudanças de backend (cards `/resumo`, tabelas
`distribuicao_coeficiente` e coluna `origem`, subquery de subcategoria). Frontend
por Ctrl+F5.

### 12/08/2026 — Listagem de Autores: só itens ATIVOS + Painel e botão "Ver" (commits 7d848b3, 0718318, 3265563, 85cdfb0)

Três melhorias publicadas juntas (estavam empilhadas na mesma linha do histórico):

- **Listagem de Autores só mostra "Item em Atendimento"** — a query enxuta só
  filtrava `orp_ativo_atual = 1`, que é flag de VERSÃO da linha, não de atividade.
  Por isso itens inativados/suspensos apareciam na demanda do paciente (ex.: Zelita
  e Sergio Viana Assis — teriparatida/ácido zoledrônico "Suspenso"). Portada a lógica
  oficial do SCODES: join `recusa_item`, coluna **Status Item** (`STA.classificacao_status=1
  AND ORP.orp_concluido=0 AND REI.rei_id IS NULL` → "Item em Atendimento", senão o motivo)
  e filtro `WHERE status_item = 'Item em Atendimento'`. Passa a preencher também os
  campos `status_item` e `data_inativacao_item` (antes vazios).
  **Pós-publicação (produção):** reiniciar + "Atualizar via Oracle" na Listagem de Autores.
- **Gráfico "Alertas por categoria" no Painel** (clicável → Alertas filtrado). Frontend → Ctrl+F5.
- **Botão "👁 Ver" nas Listagens de Autores** — modal com Prazo, Periodicidade, Data
  Última Dispensação e Data Último Retorno (tira Prazo/Periodicidade da tabela). Frontend → Ctrl+F5.

### 12/08/2026 — Estoque: etiquetas de programa, ordenação e cards CF/JEFAZ (commits 4325ad7, 550c316, 0f00190)

Três melhorias do estoque publicadas juntas (empilhadas nos mesmos arquivos):

- **Etiquetas de programa** (Outras Demandas / Dose Certa / Inex) abaixo do código,
  nas listas de Estoque Tenente Pena e Itens em Estoque Geral.
- **Estoque geral ordenado** por medicamento e depois por unidade dispensadora.
- **Modal do estoque com 3 cards de demanda/consumo por programa** — Judicial (AJ),
  **Adm** (Comissão de Farmacologia) e **JEFAZ** — alimentados pela query de estoque
  do Oracle (`query-estoque.sql`, separação por PED_TIPO). Novas colunas
  `demandas_cf/consumo_mensal_cf/demandas_jefaz/consumo_mensal_jefaz` em `estoque_itens`.

**Pós-publicação (produção):** 1) **reiniciar a produção** (`REINICIAR-PRODUCAO
(porta 3000).bat`) — cria as colunas novas e carrega a query nova; 2) na tela de
Estoque, clicar **"Atualizar via Oracle"** uma vez para preencher CF/JEFAZ com o
dado real. Só depois desses dois passos o CF/JEFAZ aparece (no modal e no relatório
Estoque × Compras).

### v1.15.0 — 10/08/2026 (Estoque geral por unidade, lotes e Primeiro Atendimento)

- **Bug dos lotes corrigido:** o modal de estoque e a Gestão de Validades voltam
  a mostrar **todos os lotes/validades** (o separador mudou de "\" para vírgula
  quando a importação passou para o Oracle).
- **Estoque geral inclui a UD 01 - Tenente Pena** (antes o "geral" a excluía).
- **Estoque geral por unidade dispensadora:** a coluna "compra em aberto" e o
  modal passam a usar a **Aquisição em Andamento OD**; o modal abre os dados da
  unidade clicada (estoque, autonomia, demandas, consumo, lotes) e os
  **pacientes daquela unidade** (não mais fixo na Tenente Pena).
- **Relatório de Primeiro Atendimento:** nova coluna **Qtde Aquisição** editável
  na linha (com log de auditoria) e **modal** ao clicar no item (demanda,
  consumo mensal, estoque e autonomia).

### v1.14.0 — 10/08/2026 (Convite de acesso por e-mail)

**Convite de acesso por e-mail (o usuário cria a própria senha).**
Ao cadastrar um usuário, o admin escolhe **"Enviar convite por e-mail"** (padrão)
ou **"Definir a senha agora"** (comportamento antigo). No convite, o sistema cria o
usuário sem senha, gera um **link único com validade de 48h** e envia por e-mail
(Gmail SMTP). O colega abre `definir-senha.html?token=…`, cria a senha e o token é
queimado (uso único). Na lista de usuários aparece a etiqueta **"Convite pendente"**
com botão **"Reenviar convite"** (gera link novo). Se o e-mail falhar, o admin recebe
o link na tela para copiar manualmente. **Também conserta o envio de e-mail** (a senha
de app do Gmail no `.env` estava inválida e foi atualizada — alertas de sincronização
voltam a chegar). **Pós-publicação:** reiniciar produção (novas rotas + colunas no banco).

### v1.13.1 — 04/08/2026 (Exportar na Movimentação de Saída)

Botões **⬇ Exportar** (lista detalhada) e **⬇ Exportar consolidado** na tela de
Movimentação de Saída — geram Excel (.xlsx) respeitando os filtros ativos (busca,
tipo múltiplo, categoria múltipla, período). Endpoints `/api/saida-lotes/exportar`
e `/api/saida-lotes/consolidado/exportar`. **Pós-publicação:** reiniciar produção
para carregar os novos endpoints.

### v1.13.0 — 04/08/2026 (Movimentação de Saída + Menu no padrão ERP)

**Nova aba "Movimentação de Saída Estoque" (Tenente Pena › Estoque)** — espelha a de
Entrada, mas via Oracle/SCODES trazendo as SAÍDAS dos últimos 12 meses. Reúne os
**dois blocos de Saída** do SCODES (dispensações tipos 7/8/9 + demais saídas da
tabela SAIDA); quantidade sempre positiva (ABS) para o consolidado somar certo.
Filtros: busca, **Tipo de movimentação (múltiplo)**, **Categoria (múltiplo)**,
período, **Limpar filtros** e **Consolidar saídas** (soma por medicamento). Botão
"Atualizar via Oracle" (admin) e entrada na cadeia diária (Estoque→Autores→Entrada→
**Saída**→Rel. Itens). Tela em largura total.

**Menu no padrão ERP (Fase 4 do visual)** — busca de telas **dentro do menu**
(filtra na hora, ignora acento, abre grupos recolhidos, respeita permissões);
**ícones** nos itens que faltavam (Reservas, Rupturas, Cartas de Troca, Status);
**indicador ativo em pílula** (fundo menta + barra luminosa); **badges**
arredondados; menu expandido mais largo (256→288px). Mockup aprovado pelo Rafael.

**Pós-publicação (produção):** 1) reiniciar produção (`REINICIAR-PRODUCAO porta
3000`) p/ criar a tabela `saida_lotes_itens` e carregar a rota/menu; 2) liberar
permissões do módulo **saidaLotes** em Administração › Usuários; 3) na aba de Saída,
clicar **"Atualizar via Oracle"** e validar as quantidades contra o relatório real
do SCODES. Menu é frontend → Ctrl+F5.

### v1.12.0 — 03/08/2026 (Módulo Cartas de Troca + robô de automação dos Empenhos)

**Novo módulo "Cartas de Troca" (Tenente Pena) + robô que atualiza os Empenhos sozinho.**
- **Carta de troca** = fornecedor quer entregar item com validade menor que o edital;
  protocola informando validade, lote e compromisso de troca. Registro 1 empenho × N
  medicamentos; busca por empenho/requisição/SEI/siafísico/empresa/medicamento/scodes/
  processo/nome requisição. **Fluxo em 2 etapas:** administrativo (perm. inserir)
  registra → "Aguardando avaliação" + e-mail aos técnicos; técnico (perm. editar)
  **aprova/reprova com justificativa** → e-mail ao criador. Total/Parcial, N lotes
  (lote+validade+qtd, soma fecha), opção **"Empenho não localizado"** (tudo manual).
- Aba **"Controle de Empenhos"** = foto do Relatório Estratégico de Empenhos.
- **Robô `automacao-empenhos/`** (puppeteer): loga no GsnetCompras, abre o relatório
  (via Referer), aplica filtros (CAF, 01/2023→mês atual, Atraso Todos, Completo),
  exporta o .xlsx e importa na tabela `empenhos`. Roda sozinho **03:00 e 13:30**
  (Agendador do Windows via `4 - AGENDAR`). Credenciais só no `.env` local.
- **Pós-publicação:** liberar permissões (técnicos=editar, administrativos=inserir)
  em Administração › Usuários; agendar o robô na pasta de produção; configurar SMTP
  no `.env` para os e-mails saírem.

### v1.11.0 — 31/07/2026 (Planejamento: layout por aba no formato dos modelos)

**Tela do Planejamento com o layout dos modelos por modalidade.**
- Aba **ATA** = layout do `10.ATA.xlsx` (62 colunas); abas **Pregão** e **Inex** =
  layout do `11.PREGÃO.xlsx` (55 colunas); **Todos** e **Revisar** = visão compacta.
- Colunas editáveis na tela: Autonomia de Compra, Embalagem, Conversão, Comprar,
  **Modalidade** (Auto/ATA/Pregão/Inex) e Observações; o restante é calculado ao vivo
  com as **mesmas fórmulas** dos modelos (validado célula a célula).
- Trocar a modalidade **move o item** para a aba escolhida (ex.: sai de Revisar) e
  o preço acompanha (ATA = valor da ata; Pregão/Inex = valor médio). Decisão salva
  na classificação. O `/simular` passou a trazer % atendimento e periodicidade por item.
- **Scripts:** novos atalhos com caminho absoluto **`REINICIAR-PRODUCAO (porta 3000).bat`**
  e **`REINICIAR-HOMOLOG (porta 3001).bat`** (evitam confundir as pastas); o
  `3 - REINICIAR-sistema.bat` do homolog corrigido para mirar a 3001 (não derruba mais a produção).

### v1.10.0 — 29/07/2026 (Módulo Planejamento de Compras)

**Novo módulo "Planejamento de Compras" (Tenente Pena) + campo Inex no Relatório de Itens.**

- **Motor de cálculo** fiel aos modelos ATA/Pregão: quantidade =
  `MROUND(autonomia × consumo × conversão, passo)`, arredondando Judicial e ADM
  separadamente. Passo: ATA = embalagem primária SISCOA; Pregão/Inex = conversão.
- **Modalidade** por siafísico + validade da ata + **marca** (nome comercial):
  ATA / Pregão / **Inex** / **⚠ Revisar** (marca divergente → técnico decide,
  decisão lembrada em `item_classificacao.modalidade_planejamento`).
- **Preço:** ATA/Revisar = último valor publicado da ata; Pregão/Inex = valor
  médio do Relatório de Itens.
- **% Atendimento Único / Demandas por Dispensações** e **Periodicidade Média**
  calculadas ao vivo da Listagem de Autores (sem importar).
- **Tela:** gerar, editar item a item (autonomia, quantidade, conversão editável,
  comprar, obs, modalidade), filtros (modalidade, categoria, subcategoria múltipla,
  ml/g/dose, busca), salvar/reabrir/duplicar/excluir, e **export XLSX** nos layouts
  10.ATA / 11.PREGÃO (+ aba REVISAR).
- **Relatório de Itens:** nova coluna e campo no modal **Inex (Sim/Não)** — `Sim`
  entra no Planejamento como **Modalidade Inex**.
- **Estoque:** removida a "Evolução do estoque" do modal de detalhe do item.

**Na publicação (produção):** as colunas novas de `item_classificacao` (inex,
modalidade_planejamento) nascem via migração automática. Para o Planejamento
usar os insumos LOIS / Carta de Troca / Demanda Irregular, importar essas
planilhas; estoque, atas e autores já vêm das rotinas diárias. Preencher a
**conversão de embalagem** dos itens em ml/g/dose (destacados em âmbar).

### v1.9.0 — 28/07/2026 (itens 57–58)

**Relatório de Itens — classificação permanente do item + aba "Planejamento TP".**
Nova tabela `item_classificacao` (permanente, não apagada pela reimportação
diária do catálogo) e uma nova aba dentro do Relatório de Itens focada no
universo de planejamento da Tenente Pena. Na publicação: a `item_classificacao`
nasce vazia em produção — importar as planilhas **Status-Siafisico** e
**Relatório de Itens (REL)** pelo botão "Importar classificação" para preencher.

| # | Melhoria | Publicado |
|---|----------|-----------|
| 57 | Classificação permanente do item: Dose Certa/PDC, Doença Rara, Unidade de Fornecimento e Embalagem de Conversão em tabela própria (`item_classificacao`) que a reimportação diária não apaga. Importação em massa (aba "Status-Siafisico", só admin), edição item a item (modal), colunas e filtros na tela. Filtro "pendentes" cruza o código SCODES do Estoque TP. Alimenta o futuro módulo de Planejamento. | v1.9.0 — 28/07/2026 |
| 58 | Aba "Planejamento TP" (só itens da TP, uma linha por item do Estoque TP mais recente com demanda total ≠ 0). Colunas: SCODES, siafísico, descritivo, demanda total, Dose Certa, Doença Rara, Unid. Fornecimento, Emb. Conversão, **SubCategoria**, **Resp. Aquisição** (CGA/CAF) e **Outros Programas** (com "Qual programa?"). Filtros: busca, categoria, classificação, Responsável, **SubCategoria (seleção múltipla)** e **novos**. Etiqueta **"🆕 Novo"** (item novo no Estoque TP vs snapshot anterior) e botão **Exportar Excel**. O botão "Importar classificação" reconhece dois layouts (Status-Siafisico e REL), sem colidir na Dose Certa. | v1.9.0 — 28/07/2026 |

### v1.8.0 — 27/07/2026 (item 56)

Tela **Status dos Serviços** (Administração, só admin): monitoramento dos 11
serviços automáticos que rodam sozinhos — os vigias de arquivo (Estoque TP,
Autores, Relatório de Itens, Atas, Estoque GSNET/IBL, Distribuição,
Solicitações TP e OD), os agendadores (integração UDTP e Oracle/SCODES) e o
backup diário do banco.

| # | Melhoria | Publicado |
|---|----------|-----------|
| 56 | Tela "Status dos Serviços": cartões de indicadores, tabela com busca/ordenação/filtros, painel lateral de detalhes, abas Histórico e Logs (com exportação CSV), faixa de alertas, botão "Executar agora" e atualização automática a cada 30 s (só a linha que mudou). | v1.8.0 — 27/07/2026 |

Decisões registradas:

- **Só número real.** Disponibilidade e tempo médio vêm do histórico de
  execuções; enquanto não houver histórico, a tela mostra "sem histórico" em
  vez de um valor inventado. Campos de datacenter que não se aplicam a um
  único PC (servidor, frota de máquinas) ficaram de fora.
- **Serviço desligado no `.env`** entra como UM alerta agregado, não um por
  serviço — senão a faixa de alertas afoga o erro que realmente importa.
- **Vigia de arquivo parado não é defeito** (só roda quando o arquivo muda),
  então a cobrança de pontualidade vale apenas para os serviços de hora
  marcada.
- O histórico de execuções tem **retenção de 180 dias**, limpa na subida do
  sistema, para a tabela não crescer sem limite.

### v1.7.0 — 24/07/2026 (itens 35–55)

Grande lote: recuperação dos agendadores na inicialização, integração com a
API UDTP (Reservas, Estoque por lote e Rupturas), módulo **Rupturas** completo
com aba de **Andamento de compra** e gráfico de autonomia clicável, ganho de
desempenho de **48 s → 0,02 s** na tela de Rupturas, coluna de **Consumo mensal
total** na Evolução de Estoque, correção das cores fixas dos gráficos no tema
escuro, e no **Comparativo de Autores** o detalhe do paciente novo em modal e o
botão **Enviar relatório por e-mail**. Na publicação: credenciais UDTP copiadas
para o `.env` de produção e migração automática do `protocolo_norm` (433 mil
linhas) no primeiro boot.

| # | Melhoria | Publicado em |
|---|----------|--------------|
| 55 | Comparativo de Autores: modal do paciente novo (estoque/autonomia/consumo/demanda/compras em aberto) + botão Enviar relatório por e-mail (3 CSVs anexos). | v1.7.0 — 24/07/2026 |
| 54 | Modal de Andamento: foco nas compras em aberto; encerradas viram histórico recolhível. | v1.7.0 — 24/07/2026 |
| 53 | Andamento de compra: gráfico de faixas de autonomia clicável (filtra a lista). | v1.7.0 — 24/07/2026 |
| 52 | Andamento de compra: esconde itens já normalizados (autonomia ≥ limiar configurável de 2 meses). | v1.7.0 — 24/07/2026 |
| 51 | Rupturas: aba "Andamento de compra" (situação de compra por item, dois fluxos TP+OD). | v1.7.0 — 24/07/2026 |
| 50 | Rupturas: desempenho 48 s → 0,02 s (protocolo_norm indexado + autores só quando necessário). | v1.7.0 — 24/07/2026 |
| 49 | Rupturas: total na legenda e faixa "Recorte" — deixa claro que os gráficos acompanham o filtro. | v1.7.0 — 24/07/2026 |
| 48 | Evolução de Estoque: coluna e indicador "Consumo mensal total". | v1.7.0 — 24/07/2026 |
| 47 | Gráfico da Evolução de Estoque no tema escuro (cores por token) + limpeza de 4 cores cravadas. | v1.7.0 — 24/07/2026 |
| 46 | Rupturas: coluna de % e tela em 2 abas com gráficos (por dia, top 10). | v1.7.0 — 24/07/2026 |
| 45 | Módulo RUPTURA (dispensações não atendidas, últimos 30 dias, KPIs e quebras). | v1.7.0 — 24/07/2026 |
| 44 | Painel: barras de status clicáveis + correção de data dos alertas e cor cravada no escuro. | v1.7.0 — 24/07/2026 |
| 43 | Modal de detalhe do item no formato de Reservas + correção da Evolução do estoque (16→2 linhas). | v1.7.0 — 24/07/2026 |
| 42 | Estilo de modal padronizado em todo o sistema (CSS único; 20 estilos inline removidos). | v1.7.0 — 24/07/2026 |
| 41 | Reservas: botão "Ver" abre modal com lotes (FEFO) e pacientes. | v1.7.0 — 24/07/2026 |
| 40 | Reservas: disponibilidade + detalhe por lote/paciente (estoque − reservado). | v1.7.0 — 24/07/2026 |
| 39 | Segunda API UDTP: estoque por lote (fonte de lote/validade/unidade). | v1.7.0 — 24/07/2026 |
| 38 | Reservas: alinhamento com a API real + primeira importação (705 reservas). | v1.7.0 — 24/07/2026 |
| 37 | Tela "Reservas de Estoque" (consulta por dia, KPIs, filtros, CSV, atualização diária 7h). | v1.7.0 — 24/07/2026 |
| 36b | Reservas UDTP: banco + importador tolerante (22 testes, bug do milhar BR corrigido). | v1.7.0 — 24/07/2026 |
| 36 | Base da integração com a API UDTP (cliente autenticado, erros traduzidos). | v1.7.0 — 24/07/2026 |
| 35 | Recuperação dos agendadores na inicialização (fim do "não atualizou porque estava desligado"). | v1.7.0 — 24/07/2026 |

| # | Melhoria | Publicado em |
|---|----------|--------------|
| 34 | **Cache-buster automático do frontend (fim do Ctrl+F5).** O servidor passa a servir o `index.html` (rotas `/` e `/index.html`, com `Cache-Control: no-cache`) trocando a versão de `app.js`/`estilo.css` pela data de modificação do arquivo — toda mudança no frontend é rebuscada com um F5 normal. **Requer reiniciar o servidor.** | v1.6.0 — 22/07/2026 |
| 33 | **Visual ERP — cartões de KPI ricos também nas telas OD** (Relatório de Compras OD e Aquisição em Andamento OD), no mesmo padrão das telas TP. As 4 telas de relatório usam o mesmo estilo. | v1.6.0 — 22/07/2026 |
| 32 | **Visual ERP — alinhamento com o mockup:** cartões KPI com ícone+número+descrição, botão "Atualizar agora" verde, TIPO em etiqueta nas 4 tabelas, cores de status legíveis no tema escuro. | v1.6.0 — 22/07/2026 |
| 31 | **Visual ERP — tema claro/escuro** (botão ☀️/🌙 na topbar, escolha guardada no navegador) reproduzindo a identidade do mockup; pílulas de status neutras com fundo visível no escuro. | v1.6.0 — 22/07/2026 |
| 30 | **Visual ERP — Fase 4 (KPIs), cobertura das telas:** cartões de indicadores na Tabela Análise TP (Total, Em andamento, Finalizadas, Atrasadas) via `/solicitacoes/resumo`. As 4 telas de relatório mostram KPIs. | v1.6.0 — 22/07/2026 |
| 29 | **Visual ERP — Fase 4 (KPIs reais nos relatórios):** cartões no topo do Relatório de Compras TP, calculados no navegador e refletindo o filtro da tela. | v1.6.0 — 22/07/2026 |
| 28 | **Visual ERP — Fase 3 (menu escalável):** grupos de unidade recolhíveis + seção ⭐ Favoritos por pessoa (guardado no navegador, respeitando permissões). | v1.6.0 — 22/07/2026 |
| 27 | **Visual ERP — Fase 2 (topbar):** barra fixa no topo com caminho de navegação (Unidade › Tipo › Tela) e busca "Ir para tela…". | v1.6.0 — 22/07/2026 |
| 26 | **Visual ERP — Fase 1 (design system):** escala de tokens (raio/sombra/espaçamento) e refino de botões, campos, cartões e tabela (zebra + hover, foco visível). | v1.6.0 — 22/07/2026 |
| 25 | **Menu lateral reorganizado em 2 níveis** — por Unidade (Tenente Pena / Outras Demandas / Consultas / Administração) e, dentro de cada uma, subgrupos por tipo (Estoque / Compras / Autores). Nenhuma tela removida. | v1.6.0 — 22/07/2026 |
| 24 | **Botão "Atualizar agora" (só admin)** nos Relatórios de Compras TP e OD: relê o arquivo da pasta de rede e reimporta na hora, sem esperar 12h/19h. Inclui correção do fuso do carimbo "Atualizado em" e ocultação do "Nova solicitação" nas telas espelho. | v1.6.0 — 22/07/2026 |
| 23 | **Painel geral redesenhado** (dashboard): banner de alertas, 4 cards de KPI, barras "Compras por status", "Alertas recentes" e tabela "Compras em andamento". | v1.6.0 — 22/07/2026 |
| 22 | **CORREÇÃO — mesmo bug do item 21, no OD (Outras Demandas).** Remove índice ÚNICO em `solicitacoes_od(item,ano,mês,tipo)` que bloqueava solicitações OD distintas do mesmo item/mês/tipo (migração idempotente) + importador OD "refaz o mês". Teste real: **+12 linhas recuperadas**. | v1.5.4 — 20/07/2026 |
| 21 | **CORREÇÃO CRÍTICA — solicitações sumindo na importação.** O importador identificava a solicitação só por item+ano+mês, então duas linhas do mesmo item no mesmo mês (JS/AS/JM/ASM) eram fundidas (uma sobrescrevia a outra). Corrigido com **"refazer o mês"** (planilha = fonte da verdade), em transação. **Recupera dados perdidos ao reimportar.** | v1.5.3 — 20/07/2026 |
| 20 | Limpeza de código morto — remove `backupNuvem.js`, `backupGoogleDrive.js`, `exportarBanco.js` e os `.bat` 5/6/7 (backup antigo). Limpa scripts npm órfãos. Atualiza `COMO-FAZER-BACKUP.txt` e `COMECE-AQUI.txt` para o backup novo. | v1.5.2 — 20/07/2026 |
| 19 | Backup consolidado — aposenta o backup duplicado das 18h (`backupDb.js` removido), fica só o backup embutido das 5h. Adiciona **backup mensal de longo prazo** (1 por mês em `backups/mensais/`, mantém 12 meses, `BACKUP_MENSAL_MANTER`). **Falta na produção: remover a tarefa agendada das 18h no Windows.** | v1.5.1 — 20/07/2026 |
| 18 | Serviço do Windows — sistema sobe sozinho ao ligar o PC, reinicia sozinho se travar, roda sem janela aberta. Instalação por duplo-clique (`9 - instalar/desinstalar-servico-windows.bat`). Serviços separados: produção `ComprasJudiciais` (3000) e homologação `ComprasJudiciasHomolog` (3001). **Falta a virada operacional na produção: fechar a janela .bat e rodar `9 - instalar-servico-windows.bat` como Administrador.** | v1.5.0 — 20/07/2026 |
| 1 | Estoque × Pacientes — modal de detalhe do item em Estoque Tenente Pena mostra os pacientes vinculados (nome, protocolo, qtde. consumo, prazo, periodicidade, data de retirada, próxima data de retorno) | v1.4.0 — 17/07/2026 |
| 3 | Estoque GSNET/IBL — tela cruzando GSNET + IBL pelo código SCODES, comparativo de saldo, aba "Consolidado por Item" e aba "Controle de Validade" (lotes por faixa de vencimento), motivo do bloqueio nos lotes | v1.4.0 — 17/07/2026 |
| 4 | Importação automática das Solicitações — vigia o arquivo "RELATÓRIO DE COMPRAS TENENTE PENA - Macro.xlsm" e importa sozinho 2x/dia (12h e 19h) | v1.4.0 — 17/07/2026 |
| 5 | Relatório de Compras OD — tela em Outras Demandas com vigia automático (12h/19h) | v1.4.0 — 17/07/2026 |
| 6 | Aquisição em Andamento OD — solicitações de Outras Demandas ainda não finalizadas | v1.4.0 — 17/07/2026 |
| 7 | Tabela Análise TP — abre por padrão filtrada em "Em andamento" | v1.4.0 — 17/07/2026 |
| 8 | Movimentação de Entrada Estoque (via Oracle) — só bloco Entrada, só Tenente Pena, janela móvel de 12 meses, filtros por tipo e categoria. **ATENÇÃO: a query Oracle (join com CATEGORIA) só foi testada com dados simulados — validar contra o Oracle real em produção** | v1.4.0 — 17/07/2026 |
| 9 | Permissão por tela — cada relatório do menu vira módulo independente (19 módulos) | v1.4.0 — 17/07/2026 |
| 10 | Botão "Apenas registrar" na Requisição de Compra | v1.4.0 — 17/07/2026 |
| 11 | Destaque visual dos itens marcados no modal de Requisição de Compra | v1.4.0 — 17/07/2026 |
| 12 | "Atualizado em" no cabeçalho de 4 relatórios (Compras TP, Análise TP, Compras OD, Aquisição em Andamento OD) | v1.4.0 — 17/07/2026 |
| 13 | Relatório de Itens — atualização automática via Oracle (SCODES) + botão manual para admin | v1.4.0 — 17/07/2026 |
| 14 | Backup automático diário do banco (5h) em `backend/data/backups/` via VACUUM INTO, retenção de 14 dias, cópia opcional para Google Drive. **ATENÇÃO: configurar `BACKUP_PASTA_DRIVE` no .env de produção para a cópia no Drive (sem isso, faz só o backup local)** | v1.4.0 — 17/07/2026 |
| 15 | Folha impressa da Requisição de Compra sem Prazo, Periodicidade, Disp. Autorizadas e Tipo de Demanda | v1.4.0 — 17/07/2026 |
| 16 | Crédito "Desenvolvido por Rafael Arruda Anastácio" no rodapé do menu lateral | v1.4.0 — 17/07/2026 |
| 17 | Módulo Distribuição — importa 5 planilhas GSNET/IBL via vigia de pasta e calcula Sugestão de Reposição por unidade (SKU, estoque do operador, múltiplo de embalagem, validade FEFO, etiquetas, autonomia-alvo por SKU, rateio). Abas Reposição, **Grade Final** (validar/negar/editar/salvar/limpar/exportar no layout do 9.Modelo grade) e **Distribuição H.E** (Hospital Escola: universo fechado da planilha 10.Hospital Escola Base, 8 unidades / 11 itens com conversão própria) | v1.4.0 — 17/07/2026 |
| 2 | Filtro de Demanda (Com/Sem demanda) nas telas Estoque Tenente Pena e Itens em Estoque Geral | v1.3.1 — 08/07/2026 |

---

## Pós-publicação da v1.6.0 — pendências operacionais

Depois de reiniciar a produção com a v1.6.0:

1. **Reiniciar a produção** para carregar o novo código (fechar a janela .bat
   antiga e abrir a `3 - iniciar-sistema.bat` de novo). Só após reiniciar as
   melhorias aparecem — e o cache-buster (item 34) só passa a valer aí.
2. **Ctrl+Shift+R uma última vez** no navegador de cada colega, para limpar o
   `app.js` antigo que ficou preso pelo cache travado anterior. Depois disso,
   F5 normal basta para sempre.

---

## Pós-publicação da v1.4.0 — pendências operacionais

Estas NÃO são código pendente, e sim ações de configuração/validação em
produção depois de reiniciar o sistema:

1. **Reiniciar a produção** para carregar o novo código (o servidor só passa a
   usar as melhorias após reiniciar).
2. **Validar a query Oracle da Movimentação de Entrada (item 8)** com dados
   reais — em especial o join com a tabela CATEGORIA.
3. **Configurar `BACKUP_PASTA_DRIVE`** no `.env` de produção (item 14) se
   quiser a cópia do backup no Google Drive.
4. **Conferir as flags de vigia de CSV** no `.env` de produção: com o Oracle
   ativo, os vigias de CSV de Estoque/Autores devem permanecer desligados
   (`AUTO_IMPORTAR_ESTOQUE=false`, `AUTO_IMPORTAR_AUTORES=false`).

---

## Como usar

- Toda vez que uma melhoria for concluída e commitada em homologação, uma
  linha é adicionada na tabela de pendentes.
- Quando o Rafael disser **"Publicar"**, decide-se: publicar tudo, ou publicar
  só parte da lista (nesse caso, `git cherry-pick` dos commits escolhidos).
- Itens publicados movem para a tabela "Publicadas recentemente".
