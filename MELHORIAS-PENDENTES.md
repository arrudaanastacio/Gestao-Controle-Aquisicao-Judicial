# Melhorias pendentes de publicação

> Lista do que já está pronto e testado em **homologação** mas ainda não foi
> para **produção**. Atualizada a cada melhoria nova. Quando o Rafael disser
> "Publicar", decidimos juntos o que entra dessa lista.

| # | Melhoria | Commit (homologação) | Data | Status |
|---|----------|----------------------|------|--------|
| 1 | Estoque x Pacientes — modal de detalhe do item em Estoque Tenente Pena agora mostra os pacientes vinculados (nome, protocolo, qtde. consumo, prazo, periodicidade, data de retirada, próxima data de retorno) | `83edd72` | 08/07/2026 | Pendente |
| 3 | Estoque GSNET/IBL — nova tela cruzando GSNET + IBL (operador logístico) com o código SCODES, comparativo de saldo entre os dois sistemas, e aba "Consolidado por Item" | `6264bbd`, `2be920a`, `d4cdc4d`, `9e1d2e4` | 08/07/2026 | Pendente |
| 4 | Importação automática das Solicitações — vigia o arquivo "RELATÓRIO DE COMPRAS TENENTE PENA - Macro.xlsm" e importa sozinho 2x/dia (12h e 19h), atualizando status e inserindo novas solicitações sem upload manual | `b6b31a6` | 10/07/2026 | Pendente |
| 5 | Relatório de Compras OD — nova tela em Outras Demandas mostrando as solicitações de compra do arquivo "RELATÓRIO DE COMPRAS OUTRAS DEMANDAS - Macro.xlsm", com vigia automático (12h/19h) igual ao item 4 | `80c669c` | 10/07/2026 | Pendente |
| 6 | Aquisição em Andamento OD — tela filtrada com as solicitações de Outras Demandas ainda não finalizadas (Planejamento, Adjucado, Empenhado, Entrega Parcial), atualiza sozinha junto com o item 5 | `896867b` | 10/07/2026 | Pendente |

## Publicadas recentemente

| # | Melhoria | Commit (produção) | Publicado em |
|---|----------|--------------------|--------------|
| 2 | Filtro de Demanda (Com/Sem demanda) nas telas Estoque Tenente Pena e Itens em Estoque Geral | `83e3ce0` (v1.3.1) | 08/07/2026 |

---

## Como usar

- Toda vez que uma melhoria for concluída e commitada em homologação, uma
  linha é adicionada aqui.
- Quando o Rafael disser **"Publicar"**, decide-se: publicar tudo, ou publicar
  só parte da lista (nesse caso, o Claude usa `git cherry-pick` dos commits
  escolhidos em vez de mesclar a trilha inteira).
- Itens publicados saem da tabela (ou movem para um histórico, se quiser
  manter registro).
