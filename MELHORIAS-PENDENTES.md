# Melhorias pendentes de publicação

> Lista do que já está pronto e testado em **homologação** mas ainda não foi
> para **produção**. Atualizada a cada melhoria nova. Quando o Rafael disser
> "Publicar", decidimos juntos o que entra dessa lista.

| # | Melhoria | Commit (homologação) | Data | Status |
|---|----------|----------------------|------|--------|
| 28 | **Visual ERP — Fase 3 (menu escalável).** Grupos de unidade **recolhíveis** (clicar em 📦 Tenente Pena etc. abre/fecha, com setinha; estado guardado no navegador) + seção **⭐ Favoritos** no topo: uma estrela em cada item fixa/desafixa a tela mais usada (por pessoa, guardado no navegador; respeita permissões). Mantém o menu limpo conforme novas telas entram. Terceira etapa da direção [[direcao-visual-erp]]. | ab918fc | 21/07/2026 | ✅ Conferido no DOM da prévia |
| 27 | **Visual ERP — Fase 2 (barra superior / topbar).** Faixa fixa no topo de TODAS as telas com **caminho de navegação** (Unidade › Tipo › Tela) e busca **"Ir para tela…"** (filtra e pula para qualquer tela, com teclado, respeitando as permissões do usuário). É o elemento que dá "cara de ERP" na hora. Segunda etapa da direção [[direcao-visual-erp]]. | d3012b0 | 21/07/2026 | ✅ Topbar conferida na prévia |
| 26 | **Visual ERP — Fase 1 (design system).** Escala única de tokens no CSS (raio 8/12px, sombra sutil, espaçamento, altura de controle) e refino das peças compartilhadas para acabamento corporativo: botões mais firmes (peso 600, cantos 8px), campos com foco visível (anel verde), cartões e tabelas com cantos 12px + sombra leve, e **zebra + hover** na tabela. Compatível com as classes que já existem — melhora todas as telas de uma vez. Primeira etapa da direção [[direcao-visual-erp]]. | c268d89 | 21/07/2026 | ⏳ A conferir em homologação |
| 25 | **Menu lateral reorganizado em 2 níveis** — por Unidade (📦 Tenente Pena / 🏢 Outras Demandas / 📑 Consultas / ⚙️ Administração) e, dentro de cada uma, subgrupos por tipo (📊 Estoque / 🛒 Compras / 👥 Autores). Mais funcional e fácil de localizar. Nenhuma tela removida (só reorganizada); adiciona ícone à "Distribuição" e reticências em rótulos longos. | 5a74f2c | 21/07/2026 | ✅ Visual conferido na prévia |
| 24 | **Botão "Atualizar agora" (só admin)** nas telas **Relatório de Compras TP** e **Relatório de Compras OD** (1 por fonte). Relê o arquivo da pasta de rede e reimporta na hora, sem esperar os horários agendados (12h/19h) — importante para ação judicial, onde os dados precisam ir o mais atualizados possível. Como cada par de telas lê da MESMA tabela, as telas irmãs (Tabela Análise TP / Aquisição em Andamento OD) já pegam os dados novos ao abrir, sem botão próprio. Endpoints admin-only (`/importar-solicitacoes/atualizar-agora` e `/solicitacoes-od/atualizar-agora`) que reaproveitam o "refazer o mês" dos vigias. Inclui: correção do fuso do carimbo "Atualizado em" (mostrava 3h a mais) e ocultação do botão "Nova solicitação" nas telas espelho. | b7da9a3 | 21/07/2026 | ⏳ A conferir em homologação |
| 23 | **Painel geral redesenhado** (visual de dashboard, mesma paleta): banner de alertas, 4 cards de KPI (compras em andamento, itens em ruptura, alertas ativos, lotes vencendo em 30 dias), barras "Compras por status", lista "Alertas recentes" e tabela "Compras em andamento". Dados reais (endpoints já existentes). | 6d8dc7c | 21/07/2026 | ✅ Visual conferido na prévia |

## Publicadas recentemente

| # | Melhoria | Publicado em |
|---|----------|--------------|
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
