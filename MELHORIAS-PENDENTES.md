# Melhorias pendentes de publicação

> Lista do que já está pronto e testado em **homologação** mas ainda não foi
> para **produção**. Atualizada a cada melhoria nova. Quando o Rafael disser
> "Publicar", decidimos juntos o que entra dessa lista.

| # | Melhoria | Commit (homologação) | Data | Status |
|---|----------|----------------------|------|--------|
| 1 | Gráfico "Alertas por categoria" no Painel inicial (clicável → tela de Alertas filtrada) | 7d848b3 | 11/08/2026 | ✅ Pronto em homolog (frontend) |
| 2 | Listagens de Autores (TP + Demais Unidades): botão "👁 Ver" abre modal com Prazo, Periodicidade, Data Última Dispensação e Data Último Retorno (tira Prazo/Periodicidade da tabela) | 0718318 | 12/08/2026 | ✅ Pronto em homolog (frontend) |
| 3 | Listagem de Autores: trazer **Status Item** do SCODES e mostrar **só "Item em Atendimento"** (exclui Inativação/Suspensão/Descontinuado/Item Atendido/etc.). Corrige itens inativos/suspensos aparecendo na demanda do paciente (ex.: Zelita e Sergio Viana Assis — some teriparatida/zoledrônico suspensos, sobra só denosumabe). | (homolog) | 12/08/2026 | ⏳ Aguardando validar na homolog (reiniciar + Atualizar via Oracle) |

### Detalhe das pendências

**Etiquetas de programa no estoque (Estoque TP + Estoque Geral).**
Cada item do estoque mostra etiquetas coloridas abaixo do código indicando a que
programa pertence: **Outras Demandas** (azul — `relatorio_itens.outras_demandas`),
**Dose Certa** (verde — `item_classificacao.dose_certa`) e **Inex** (âmbar —
`item_classificacao.inex`). Só aparece a etiqueta do programa a que o item
pertence. Vale para as listas de Estoque Tenente Pena e Itens em Estoque Geral.
**Pós-publicação:** reiniciar produção (consulta nova no backend).

## Publicadas recentemente

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
