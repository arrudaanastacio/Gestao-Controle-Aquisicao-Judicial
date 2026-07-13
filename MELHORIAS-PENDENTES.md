# Melhorias pendentes de publicação

> Lista do que já está pronto e testado em **homologação** mas ainda não foi
> para **produção**. Atualizada a cada melhoria nova. Quando o Rafael disser
> "Publicar", decidimos juntos o que entra dessa lista.

| # | Melhoria | Commit (homologação) | Data | Status |
|---|----------|----------------------|------|--------|
| 1 | Estoque x Pacientes — modal de detalhe do item em Estoque Tenente Pena agora mostra os pacientes vinculados (nome, protocolo, qtde. consumo, prazo, periodicidade, data de retirada, próxima data de retorno) | `83edd72` | 08/07/2026 | Pendente |
| 3 | Estoque GSNET/IBL — nova tela cruzando GSNET + IBL (operador logístico) com o código SCODES, comparativo de saldo entre os dois sistemas, aba "Consolidado por Item" e aba "Controle de Validade" (lotes por faixa de vencimento) | `6264bbd`, `2be920a`, `d4cdc4d`, `9e1d2e4`, `503f13e` | 08/07/2026 | Pendente |
| 4 | Importação automática das Solicitações — vigia o arquivo "RELATÓRIO DE COMPRAS TENENTE PENA - Macro.xlsm" e importa sozinho 2x/dia (12h e 19h), atualizando status e inserindo novas solicitações sem upload manual | `b6b31a6` | 10/07/2026 | Pendente |
| 5 | Relatório de Compras OD — nova tela em Outras Demandas mostrando as solicitações de compra do arquivo "RELATÓRIO DE COMPRAS OUTRAS DEMANDAS - Macro.xlsm", com vigia automático (12h/19h) igual ao item 4 | `80c669c` | 10/07/2026 | Pendente |
| 6 | Aquisição em Andamento OD — tela filtrada com as solicitações de Outras Demandas ainda não finalizadas (Planejamento, Adjucado, Empenhado, Entrega Parcial), atualiza sozinha junto com o item 5 | `896867b` | 10/07/2026 | Pendente |
| 7 | Tabela Análise TP — passa a abrir por padrão filtrada em "Em andamento" (Planejamento, Adjucado, Empenhado, Entrega Parcial), refletindo sempre os dados mais recentes do item 4 | `cabce81` | 10/07/2026 | Pendente |
| 8 | Movimentações de Entrada (lotes/validade) — nova tela em Consultas puxando via Oracle a query enviada pelo Rafael (só o bloco Entrada), janela móvel de 12 meses calculada no próprio SQL, encadeada no agendador diário após Autores. **Ainda falta validar a query contra o Oracle real** (só testei com dados simulados neste ambiente) | `f2c1803` | 13/07/2026 | Pendente — precisa validar Oracle |

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
