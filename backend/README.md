# Controle de Compras Judiciais — Tenente Pena

Sistema web para acompanhar o andamento das compras de medicamentos de ação
judicial. Roda direto no seu computador e pode ser acessado por outros
colaboradores na mesma rede local, com login e dois perfis de acesso:

- **Admin** — consulta, cadastra, edita e exclui solicitações; gerencia usuários.
- **Consulta** — apenas visualiza o andamento das compras (não pode editar nada).

Todas as alterações feitas por usuários admin são registradas em um log de
auditoria interno (quem alterou, o quê, e quando).

## 1. Pré-requisitos

Instale o **Node.js versão 22 ou superior** no computador que vai servir o
sistema (o mesmo computador onde os outros colaboradores vão acessar pela
rede). Baixe em https://nodejs.org — escolha a versão "LTS".

Para confirmar que instalou corretamente, abra o terminal (cmd/PowerShell no
Windows, ou Terminal no Mac/Linux) e digite:

```
node --version
```

Deve aparecer algo como `v22.x.x` ou superior.

## 2. Instalação (primeira vez)

1. Copie a pasta `backend` (com tudo dentro, incluindo `data/medicamentos_judicial.db`)
   para o computador que vai servir o sistema.
2. Abra o terminal dentro dessa pasta `backend`.
3. Instale as dependências:

   ```
   npm install
   ```

4. Crie o primeiro usuário administrador (troque o nome, e-mail e senha pelos
   seus dados reais):

   ```
   npm run criar-admin -- "Seu Nome" seuemail@exemplo.com SuaSenhaForte123
   ```

5. (Recomendado) Abra o arquivo `.env` e troque o valor de `JWT_SECRET` por
   um texto aleatório qualquer — é o que garante a segurança das sessões de
   login. Qualquer frase longa e única serve.

## 3. Rodando o sistema

Dentro da pasta `backend`, rode:

```
npm start
```

Você verá uma mensagem como:

```
Servidor rodando em http://0.0.0.0:3000
Acesse pela rede local usando o IP deste computador, ex: http://192.168.x.x:3000
```

No seu próprio computador, acesse `http://localhost:3000` no navegador.

## 4. Acesso pelos outros colaboradores (rede local)

Para outras pessoas na mesma rede (Wi-Fi ou cabo) acessarem:

1. Descubra o IP do computador que está servindo o sistema:
   - **Windows**: abra o cmd e digite `ipconfig`, procure "Endereço IPv4" (ex: 192.168.1.45).
   - **Mac/Linux**: abra o terminal e digite `ifconfig` ou `ip a`, procure algo como `inet 192.168.1.45`.
2. Nos outros computadores, acesse no navegador: `http://SEU_IP:3000`
   (substituindo `SEU_IP` pelo IP encontrado, ex: `http://192.168.1.45:3000`).
3. Se não conseguir acessar, verifique se o **firewall do Windows/Mac** está
   bloqueando a porta 3000 — pode ser necessário liberar uma exceção para o Node.js
   ou para a porta 3000 nas configurações de firewall.

Importante: o computador que está rodando `npm start` precisa **ficar ligado
e com o terminal aberto** enquanto outras pessoas estiverem usando o sistema.
Se fechar o terminal ou o computador hibernar, o sistema fica indisponível.

### Deixando o servidor sempre ligado (opcional)

Para não depender do terminal aberto, você pode instalar o utilitário `pm2`,
que mantém o servidor rodando em segundo plano e o reinicia automaticamente
se cair:

```
npm install -g pm2
pm2 start src/server.js --name compras-judiciais
pm2 save
```

Depois disso, mesmo fechando o terminal, o servidor continua no ar. Para
ver o status: `pm2 status`. Para parar: `pm2 stop compras-judiciais`.

## 5. Acesso externo (fora da rede local) — próxima etapa

Quando quiser liberar acesso de fora (home office, outro local), será
necessário um destes caminhos — me avise quando chegar essa hora que eu
configuro:

- Um serviço de túnel seguro (ex: Cloudflare Tunnel, Tailscale) — mais simples
  e seguro, não exige abrir portas no roteador.
- Configuração de acesso remoto na rede (port forwarding + HTTPS) — exige
  mais cuidado de segurança.

A aplicação já está pronta para isso; não precisa mudar nada no código.

## 6. Gerenciando usuários

Logado como admin, acesse o menu **Usuários** para cadastrar os colaboradores
que vão usar o sistema, escolhendo o perfil de cada um (Admin ou Consulta).

## 7. Buscar o andamento de um medicamento específico

No menu **Buscar medicamento**, digite o código do item (ex: `1L00002/21/44391/01/00`)
ou parte do nome do medicamento (ex: `abatacepte`). O sistema mostra o item
encontrado e todo o histórico de solicitações dele, mês a mês, em ordem
cronológica — útil para responder rapidamente "em que pé está a compra deste
remédio" sem precisar abrir planilhas antigas.

## 8. Relatório consolidado de todos os meses

No menu **Relatório consolidado**, todos os meses e anos cadastrados são
reunidos em uma única lista, trazendo apenas os medicamentos que de fato
tiveram movimento de compra (ou seja, com modalidade de compra preenchida —
exclui automaticamente qualquer linha sem modalidade definida, equivalente
ao "-" da planilha original).

Use o filtro de ano para consolidar apenas um período específico, e o botão
**Exportar CSV** para baixar a planilha pronta para abrir no Excel.

## 9. Atualizando o elenco de medicamentos

O **elenco** é a lista oficial de medicamentos que podem ser solicitados — o
catálogo que antes ficava repetido em todas as abas da planilha. Em vez de
digitar item por item, você importa uma planilha nova com a lista atualizada.

No menu **Importar dados**, no card **Elenco de medicamentos**:

1. Selecione o arquivo (.xlsx ou .xlsm) com as colunas **Código do Item**,
   **Código Siafísico**, **Descrição do Item** (e opcionalmente **CATMAT**,
   se a planilha tiver essa coluna).
2. Clique em **Analisar planilha** — o sistema mostra, sem gravar nada ainda,
   quantos itens são novos, quantos tiveram algum dado alterado (siafísico,
   descrição ou CATMAT) e quantos itens vão deixar de constar no elenco.
3. Revise o resumo e clique em **Confirmar importação**.

Regras importantes:

- Itens novos são cadastrados automaticamente.
- Itens já existentes são atualizados (ex: correção do código siafísico, que
  passa a valer para todos os meses, passados e futuros, sem precisar editar
  mês a mês).
- Itens que não aparecerem mais na planilha **nunca são excluídos** — eles
  são marcados como inativos. Se esse item já tiver alguma solicitação de
  compra registrada, um alerta é criado automaticamente no menu **Alertas**,
  avisando que o item foi removido do elenco mas tem histórico de compra.
  O histórico permanece disponível para consulta normalmente.

### Corrigindo um item manualmente

Se precisar corrigir o siafísico, a descrição ou o CATMAT de um item
específico sem importar uma planilha inteira, use o menu **Elenco de
medicamentos**: digite o código do item, localize-o, e edite os campos
diretamente. A correção vale para todos os meses automaticamente.

## 10. Lançando novas aquisições de medicamentos

No mesmo menu **Importar dados**, no card **Novas aquisições (solicitações
mensais)**, você importa o controle mensal no mesmo layout do arquivo
original (uma aba por mês, ex: `AGOSTO-2026`, com as colunas de modalidade
de compra, ofício, datas, empenho, status etc.).

1. Selecione o arquivo.
2. Escolha o modo de importação:
   - **Importar apenas o que ainda não existe** — não altera nada que já
     esteja cadastrado (mais seguro para reenvios acidentais do mesmo arquivo).
   - **Atualizar também os já existentes** — se o mesmo item/mês/ano já
     estiver no sistema, os dados da planilha substituem o que está
     cadastrado (use quando a planilha for a versão mais atualizada de um
     mês já lançado).
3. Clique em **Analisar planilha** para ver quantas linhas serão inseridas,
   quantas já existem e se algum item da planilha não está cadastrado no
   elenco (nesse caso, cadastre o item pelo importador de elenco antes de
   reenviar).
4. Confirme a importação.

Só linhas com algum campo de movimento preenchido (modalidade, ofício,
quantidade, status etc.) são importadas — linhas totalmente vazias ("-" em
tudo) são ignoradas automaticamente, exatamente como já acontece com o
restante do sistema.

Arquivos grandes (com todas as 26 abas, como o arquivo original) podem levar
de 20 a 30 segundos para processar — isso é normal.

## 11. Estoque

O menu **Estoque** mostra a situação atual dos itens em estoque na UD 01 -
Tenente Pena, a partir do relatório "Itens em Estoque UDTP".

### Importando o estoque do dia

No menu **Importar dados**, card **Estoque diário**:

1. Selecione o arquivo .xlsx do relatório de estoque.
2. O sistema detecta a data automaticamente pelo nome da aba (ex:
   `Rel_ItensEmEstoque_16022024_104` → 16/02/2024). Ajuste a data se quiser.
3. Clique em **Analisar planilha** e depois em **Confirmar importação**.

Cada importação é uma **foto do dia** — o histórico de todas as importações é
mantido, então você pode acompanhar a evolução do estoque de um item ao longo
do tempo (visível no detalhe de cada item). Se importar duas vezes para a
mesma data, a segunda substitui a primeira.

A cada importação, os alertas de estoque são recalculados automaticamente.

### Consultando o estoque

Na tela **Estoque** você vê cards com o total de itens, quantos estão em
ruptura, quantos com estoque baixo e o valor total em estoque. Pode filtrar
por situação (ruptura, estoque baixo, zerado) e buscar por medicamento,
código ou siafísico. O seletor no topo permite ver o estoque de qualquer data
já importada.

Clicando em **Ver** num item, abre o detalhe com a situação de estoque, a
evolução ao longo do tempo, e — importante — **todas as compras desse item no
controle judicial**, indicando se há compra em aberto. É aí que se cruza
"tenho estoque baixo" com "já tem compra a caminho?".

### Configurando o alerta de estoque baixo

No card **Configuração de alertas de estoque** (menu Importar dados), defina a
**autonomia mínima em meses**: itens cuja autonomia (meses de estoque
restante dado o consumo) for igual ou menor que esse número entram como
"estoque baixo". O padrão é 2 meses.

## 12. Alertas

O menu **Alertas** (visível só para admin, com um número vermelho indicando
quantos estão pendentes) reúne avisos gerados automaticamente pelo sistema.
Use o filtro por tipo para navegar entre as categorias:

- **Ruptura de estoque** — item com estoque zero e que tem demanda (consumo).
  Indica se há ou não compra em aberto no controle judicial.
- **Estoque baixo** — item com autonomia abaixo do limite configurado.
- **Revisar compra** — item que tem compra em aberto no controle judicial mas
  está com demanda ZERO no relatório de estoque (possível compra a reavaliar).
- **Item removido do elenco com histórico** — item que saiu do elenco mas já
  teve compras registradas (foi inativado, não excluído).

Revise o alerta e clique em **Marcar como resolvido** depois de tratá-lo. Os
alertas de estoque são regerados a cada nova importação de estoque, sempre
refletindo a foto mais recente.

## 13. Backup

O banco de dados é um único arquivo: `data/medicamentos_judicial.db`. Faça
cópias periódicas desse arquivo (ex: copiar para um pendrive ou nuvem uma vez
por semana) para não perder o histórico em caso de problema no computador.
