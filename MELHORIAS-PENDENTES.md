# Melhorias pendentes de publicação

> Lista do que já está pronto e testado em **homologação** mas ainda não foi
> para **produção**. Atualizada a cada melhoria nova. Quando o Rafael disser
> "Publicar", decidimos juntos o que entra dessa lista.

| # | Melhoria | Commit (homologação) | Data | Status |
|---|----------|----------------------|------|--------|
| 1 | Estoque x Pacientes — modal de detalhe do item em Estoque Tenente Pena agora mostra os pacientes vinculados (nome, protocolo, qtde. consumo, prazo, periodicidade, data de retirada, próxima data de retorno) | `83edd72` | 08/07/2026 | Pendente |

---

## Como usar

- Toda vez que uma melhoria for concluída e commitada em homologação, uma
  linha é adicionada aqui.
- Quando o Rafael disser **"Publicar"**, decide-se: publicar tudo, ou publicar
  só parte da lista (nesse caso, o Claude usa `git cherry-pick` dos commits
  escolhidos em vez de mesclar a trilha inteira).
- Itens publicados saem da tabela (ou movem para um histórico, se quiser
  manter registro).
