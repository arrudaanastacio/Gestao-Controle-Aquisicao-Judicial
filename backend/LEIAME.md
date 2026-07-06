# Módulo Oracle — Demandas Judiciais (SCODES) → Listagem de Autores

Substitui a etapa manual de baixar a "Listagem de Autores.csv" pela tela do
SCODES: este script consulta o Oracle diretamente e gera esse mesmo CSV,
no formato que o `vigiaAutores.js` já monitora. **Nenhuma rota, tabela ou
linha do `server.js` precisa mudar** — o pipeline de importação que já
existe (`routes.autores.js` / `importarAutoresDeBuffer`) cuida do resto,
exatamente como cuida hoje quando alguém baixa o CSV manualmente.

O filtro por unidade (Tenente Pena vs. demais) já existe na tela/endpoint
`GET /api/autores?unidade=...`, então o script sempre importa **todas as
unidades de uma vez** — não é preciso gerar dois arquivos.

## Conteúdo do zip

```
oracle/
  query-demandas.sql   -> a query (21 colunas), aliases batendo com o MAPA
                           de importarAutoresDeBuffer (routes.autores.js)
  db-oracle.js         -> pool de conexão Oracle
  demandas.js          -> buscarDemandas({ undId })
sync-demandas.js        -> consulta o Oracle e grava o CSV no caminho monitorado
sync-demandas.bat       -> dispara o sync, com log; para o Agendador de Tarefas
teste-demandas.js       -> teste avulso via Node (consulta só Tenente Pena, rápido)
.env.oracle.example     -> variáveis a adicionar no seu .env
```

## Instalação

1. Extraia o zip **dentro de** `C:\Compras Judiciais\backend\`.
   Cria/atualiza `backend\oracle\` e os arquivos `sync-demandas.js`,
   `sync-demandas.bat` na raiz do backend. Nada em `src\` é tocado.

2. Confirme as variáveis do Oracle no seu `.env` (veja `.env.oracle.example`):
   ```
   ORA_USER=usuario_de_consulta
   ORA_PASSWORD="senha_do_usuario"
   ORA_CONNECT_STRING="(DESCRIPTION=...(HOST=SEU_IP)(PORT=1521)...(SERVICE_NAME=SEU_SERVICO)...)"
   ```

3. O `xlsx` já é dependência do projeto (visto no seu `npm list`) — nada
   novo para instalar.

## Rodando o sync manualmente (primeiro teste)

```
cd C:\Compras Judiciais\backend
node sync-demandas.js
```

Isso vai:
- Consultar o Oracle, todas as unidades — **demora ~14 minutos**, é esperado
  (mesmo tempo que a query completa levou no DBeaver).
- Gerar o CSV em memória.
- Gravar primeiro num arquivo temporário na mesma pasta e só então renomear
  para `Listagem de Autores.csv` (escrita atômica — o vigia nunca pega o
  arquivo pela metade).

Se o servidor (`node server.js` / `3 - iniciar-sistema.bat`) já estiver
rodando, o `vigiaAutores.js` detecta o arquivo novo em até
`VIGIA_INTERVALO_MS` (padrão 30s) e importa sozinho — você verá no console
do servidor algo como:
```
[VIGIA AUTORES] Arquivo atualizado: 218702 linhas / NNNN autores (ref 2026-07-04).
```
Se o servidor não estiver rodando, o CSV fica pronto e é importado na
próxima vez que o servidor subir (o vigia também roda uma verificação ao
iniciar).

## Agendando para rodar sozinho às 6h

1. Abra o **Agendador de Tarefas** do Windows (`taskschd.msc`).
2. **Criar Tarefa Básica** → nome: "Sync Demandas Judiciais SCODES".
3. Disparador: **Diariamente**, às **06:00**.
4. Ação: **Iniciar um programa** → aponte para:
   `C:\Compras Judiciais\backend\sync-demandas.bat`
5. Em "Iniciar em (opcional)", coloque: `C:\Compras Judiciais\backend`
6. Marque "Executar mesmo se o usuário não estiver conectado" se a máquina
   ficar ligada sem sessão ativa de madrugada (pode pedir a senha do Windows).
7. Salve. Logs de cada execução ficam em `backend\logs\sync-demandas-AAAA-MM-DD.log`.

Como o servidor Node já roda continuamente (é como o app funciona hoje) e
o `vigiaAutores.js` já sobe junto com ele, a importação acontece sozinha
assim que o CSV é atualizado — sem precisar reiniciar nada.

## Observações

- A query filtra `STA.sta_descricao LIKE 'Demanda Ativa%'` — apenas demandas
  ativas. Remova essa condição em `query-demandas.sql` para incluir encerradas.
- Colunas do sistema existente que a query Oracle não traz (idade,
  dt_nascimento, status_item, cobrança judicial, etc.) ficam em branco no
  CSV — o parser aceita isso normalmente. Se quiser incluir alguma, veja a
  query original de 45 colunas (a que você já tinha) e me avise quais campos
  adicionar.
- Se o caminho `G:\CAF\...\MACRO\` não estiver acessível (drive de rede não
  montado), o script para com um erro claro em vez de gravar em outro lugar.
- O script sempre importa TODAS as unidades; o recorte "Tenente Pena" /
  "Demais Unidades" continua sendo feito pelo filtro `?unidade=` que a tela
  já usa — nenhuma mudança necessária aí.
