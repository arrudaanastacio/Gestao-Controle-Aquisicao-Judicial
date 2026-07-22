# Melhorias pendentes de publicação

> Lista do que já está pronto e testado em **homologação** mas ainda não foi
> para **produção**. Atualizada a cada melhoria nova. Quando o Rafael disser
> "Publicar", decidimos juntos o que entra dessa lista.

| # | Melhoria | Commit (homologação) | Data | Status |
|---|----------|----------------------|------|--------|
| 41 | **Reservas — botão "Ver" abre card com lotes e pacientes** (no lugar da tela separada e da linha expansível). Cada linha ganha um botão **Ver** que abre um **modal largo (1000px)** com os **lotes em ordem FEFO** (lote, validade, saldo) e os **pacientes com reserva** (recebedor, protocolo, quantidade e o lote que atende cada um). Mais espaço que a linha expandida — importante porque há item com **164 pacientes** — e muito mais óbvio que a setinha. Fecha pelo botão ou clicando no fundo (sem atalho Esc, de propósito: já existe um `Escape` na busca "Ir para tela"). Também: a tela passou a usar a **largura total** (faltava na lista de páginas sem o limite de 1280px, o que deixava espaço vazio à direita). | c015681 | 22/07/2026 | ⏳ Servido e verificado no HTML/JS — falta sua conferência visual |
| 40 | **Reservas — disponibilidade + detalhe por lote/paciente (pedidos A e B).** A tela passa a ser **por item**, com `Unidade`, `Estoque`, `Reservado`, **`Disponível`** (destacado em vermelho/âmbar quando ≤ 0) e `Validade mais próxima`. Cada linha **expande** mostrando, lado a lado, os **lotes em ordem FEFO** (lote, validade, saldo) e os **pacientes com reserva** (recebedor, protocolo, quantidade) — com o **lote que atende cada reserva calculado pela regra FEFO**, confirmada pela operação (a API não informa o lote da reserva; a tela deixa isso explícito). Novo filtro **"só comprometidos"** e KPI de itens com disponível ≤ 0. **Dado real: dos 182 itens reservados, 65 estão com o estoque todo comprometido.** Painel do detalhe com rolagem própria (há item com 164 reservas). | 32c3d13 | 22/07/2026 | ✅ SQL e regra FEFO validados com dado real — falta sua conferência visual |
| 39 | **Segunda API: estoque por lote** (`/api/estoque/{data}`) — é a fonte de **lote, validade e unidade de medida**, que a API de reservas não traz. Isso explica a lista original de 6 campos: eles vinham de **duas APIs**. Tabelas `estoque_udtp_importacoes`/`estoque_udtp_lotes` (uma linha por lote; itens zerados vêm com lote/validade nulos), importador tolerante, e entrada no mesmo ciclo diário e no botão "Atualizar agora". Corrigida uma falha de desenho: a trava de recuperação só olhava reservas e passaria por cima do estoque — agora exige **as duas** fontes. **Validado com dado real: 8.422 linhas (2.397 com lote) + 705 reservas; 182/182 (100%) dos itens reservados têm lote/validade, permitindo calcular `estoque − reservado = disponível`.** | 6058412 | 22/07/2026 | ✅ Importação real das 2 fontes OK — falta definir a exibição na tela |
| 38 | **Reservas — alinhamento com a API real + primeira importação.** Com a credencial, os campos reais se mostraram diferentes do previsto: `codigoItem`, `codigoProtocolo`, `descricao`, `recebedor`, `saldoReservado` (**não há** lote/validade/unidade). Modelo, tela, CSV e KPIs refeitos. O `codigoItem` casa **182/182 (100%)** com `estoque_itens.codigo_item` — chave de cruzamento confirmada. Como a API devolve **404 para o dia de hoje** (só publica o dia fechado), o agendador e o botão passam a importar **a data mais recente disponível** (olha até 7 dias atrás). Corrigidos 2 bugs reais: `db.transaction()` não existe no `node:sqlite` (trocado por BEGIN/COMMIT/ROLLBACK) e o `recebedor` agora é **escapado** no HTML. **Importação real validada: 705 reservas de 21/07, 0 sem código, 0 sem recebedor.** | 68fda50 | 22/07/2026 | ✅ Importação real OK; recuperação do item 35 confirmada ao vivo no log |
| 37 | **Tela "Reservas de Estoque"** (menu Tenente Pena › Estoque). Consulta por **dia** (seletor com as datas já importadas), 4 cartões de KPI (reservas, medicamentos distintos, quantidade reservada, lotes), filtros de **busca** (medicamento/SCODES/lote) e **unidade**, **exportar CSV** e selo "Atualizado em". Botão **"Atualizar agora"** consulta a API na hora — controlado pela ação **Importar** do módulo `reservas`, liberável **por usuário** na tela de Permissões (admin sempre pode). **Atualização diária automática às 7h** (`vigiaReservas.js`), já usando a recuperação na inicialização do item 35, e que se auto-desativa com aviso claro se não houver credencial. Ao publicar, usuários ativos passam a **ver** a tela automaticamente (`habilitado` e `visualizar` por padrão) e o **botão nasce oculto** até ser liberado. | c62271b | 22/07/2026 | ⚠️ Backend verificado (rotas, tabelas, boot limpo). **Visual não conferido logado** — falta credencial da API e uma olhada sua na tela |
| 36b | **Reservas UDTP — banco + importador.** Tabelas `reservas_importacoes` / `reservas_itens` no padrão de **foto datada** do estoque, com os 6 campos do relatório (Código SCODES, medicamento, lote, validade, quantidade, unidade) e ligação pelo **código SCODES**. Importador `reservasUdtp.js` refaz o dia (API = fonte da verdade) e usa **mapeamento tolerante** de nomes de campo (acento/maiúscula/camelCase/objeto aninhado), reportando `camposNaoMapeados` para ajuste rápido contra o dado real. Teste `testarMapeadorReservas.js` com **22 casos**, rodando sem rede e sem banco. Pegou e corrigiu um bug sério: quantidade `"1.200"` (milhar BR) virava **1,2**. **Sem tela ainda.** | fc5cd3e | 22/07/2026 | ✅ 22 testes passando — falta credencial para validar contra o retorno real |
| 36 | **Base da integração com a API de Reservas UDTP** (`https://api.udtp.org.br/api/reservas/{AAAA-MM-DD}`). A API foi testada e está saudável, exigindo **HTTP Basic** (Spring Boot atrás de Apache). Entregue: `udtpApi.js` (cliente autenticado, credenciais só do `.env`, timeout com limpeza correta, erros traduzidos: SEM_CREDENCIAL/NAO_AUTORIZADO/SEM_PERMISSAO/TIMEOUT) e `testarUdtpApi.js` (diagnóstico que revela a **estrutura** do retorno com **valores mascarados**, por ser provável dado de paciente). `.env.example` documentado. **Ainda NÃO grava nada no banco** — falta credencial e a definição de negócio (o que é a reserva e como se liga ao item/paciente). | c7d7257 | 22/07/2026 | ⏳ Base pronta e testada (401 tratado) — aguarda credencial + regra de negócio |
| 35 | **Recuperação na inicialização dos agendadores (fim do "não atualizou porque o PC estava desligado no horário").** Os agendadores só disparavam no horário exato **se o sistema estivesse rodando naquele momento** — sem recuperação, se o horário já tinha passado ao subir, pulava para o dia seguinte. Agora, ao iniciar, se o horário do dia já passou e ainda não sincronizou hoje, roda na hora: **Oracle diário (Estoque/Autores/Entrada/Rel. Itens, 6h)** com trava "já importou estoque hoje?" (não repuxa o Oracle a cada reinício) e **Solicitações TP e OD (12h)** relendo o arquivo (a assinatura evita reimportar se nada mudou). | 01e4f2b | 22/07/2026 | ✅ Lógica testada (4 cenários) — a conferir em homologação com o sistema no ar |

## Publicadas recentemente

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
