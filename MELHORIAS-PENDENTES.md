# Melhorias pendentes de publicação

> Lista do que já está pronto e testado em **homologação** mas ainda não foi
> para **produção**. Atualizada a cada melhoria nova. Quando o Rafael disser
> "Publicar", decidimos juntos o que entra dessa lista.

| # | Melhoria | Commit (homologação) | Data | Status |
|---|----------|----------------------|------|--------|
| 21 | **CORREÇÃO CRÍTICA — solicitações sumindo na importação.** O importador identificava a solicitação só por item+ano+mês, então duas linhas do mesmo item no mesmo mês (JS/AS/JM/ASM) eram tratadas como a mesma: no modo automático a segunda SOBRESCREVIA a primeira, apagando dados. Corrigido com **"refazer o mês"**: para cada mês da planilha, apaga e regrava tudo (planilha = fonte da verdade), em transação, com aviso se a planilha vier suspeita de incompleta. Teste com a planilha real: **+122 linhas recuperadas** e **470 grupos de duplicatas achatadas → 0**. | 5f851e8 | 20/07/2026 | ✅ Testado com planilha real |

## Publicadas recentemente

| # | Melhoria | Publicado em |
|---|----------|--------------|
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
