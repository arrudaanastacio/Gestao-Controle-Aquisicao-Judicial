# CLAUDE.md — Contexto do Projeto

> Este arquivo é lido automaticamente pelo Claude Code ao abrir o projeto.
> Ele resume o que é o sistema, as decisões de arquitetura já tomadas, e os
> pontos de atenção. Escrito em português porque o usuário (Rafael) e todo o
> domínio do sistema são em português do Brasil.

## Quem é o usuário

Rafael trabalha com compras e controle de estoque no setor público (área da
saúde), gerenciando a aquisição de medicamentos de **ação judicial** para a
unidade **Tenente Pena**. Não é desenvolvedor profissional — sabe Excel/VBA,
estudou Python e SQL em nível introdutório, mas depende de explicações claras
e em português. Ao ajudar, prefira:

- Explicar o "porquê" das mudanças, não só o "o quê".
- Comandos prontos para copiar e colar (ambiente Windows, Node v24).
- Evitar jargão sem explicação.
- Nunca assumir que ele vai editar código manualmente sem orientação.

## O que é o sistema

Aplicação web local que substitui uma planilha Excel/VBA frágil (~18 MB, 26
abas) de controle de compras judiciais de medicamentos. Roda no computador do
Rafael e é acessada pelos colegas via navegador na rede local
(`http://IP-DA-MAQUINA:3000`). Futuramente pode ser exposta para acesso
externo (planejado: Cloudflare Tunnel ou Tailscale, sem mudar o código).

Três grandes domínios, todos ligados pelo **código do item** (`codigo_item`,
formato ex.: `1L30552/28/67275/01/00`), que é a chave que une tudo:

1. **Compras judiciais** — catálogo de medicamentos (elenco) + solicitações
   mensais de compra (movimento), com status, ofício, empenho, datas.
2. **Estoque** — importação diária do relatório "Itens em Estoque UDTP",
   guardando histórico (cada importação é uma foto datada).
3. **Alertas** — avisos automáticos cruzando estoque × compras.

## Stack e decisões de arquitetura (IMPORTANTES — não reverter sem motivo)

- **Backend:** Node.js + Express 5. Porta 3000.
- **Banco:** SQLite via módulo **nativo `node:sqlite`** (built-in do Node 22+).
  - DECISÃO CRÍTICA: NÃO usar `better-sqlite3`. O ambiente de
    desenvolvimento tinha rede restrita e não compilava módulos nativos. O
    `node:sqlite` resolve isso e é portável (não precisa de toolchain de
    compilação na máquina do Rafael). Por isso o projeto exige **Node v22+**.
  - Acesso ao banco é **síncrono** (`db.prepare(...).get()/.all()/.run()`).
- **Autenticação:** JWT em cookie httpOnly (8h de validade), senha com bcryptjs.
- **Perfis (RBAC):** apenas dois — `admin` (faz tudo) e `consulta` (só leitura).
- **Frontend:** HTML + CSS + JS puro (sem framework, sem build step).
  Propositalmente simples para rodar sem ferramentas extras. SPA caseira:
  uma `index.html` com `<section>` por página, alternadas via
  `mudarPagina()` em `app.js`. Login em `login.html` separado.
- **Leitura de planilhas:** biblioteca `xlsx` (SheetJS) + `multer` para upload.
- **Idioma:** todo o código, nomes de variáveis, rotas e UI em português.

## Estrutura de arquivos

```
COMECE-AQUI.txt              Guia rápido para o Rafael (instalação via .bat)
backend/
  1 - instalar.bat           Scripts .bat de duplo-clique para Windows
  2 - criar-usuario-admin.bat
  3 - iniciar-sistema.bat
  README.md                  Manual completo de uso (em português)
  package.json               scripts: "start" e "criar-admin"
  .env.example               Modelo do .env (PORT, JWT_SECRET, NODE_ENV)
  data/
    medicamentos_judicial.db SQLite — TODOS OS DADOS vivem aqui
  src/
    server.js                Express, monta todas as rotas, serve o frontend
    db.js                    Abre o banco e cria/migra todas as tabelas
    auth.js                  gerarToken, autenticar, exigirPerfil
    seedAdmin.js             Cria/atualiza o usuário admin (via CLI)
    routes.auth.js           /api/auth        login, logout, me
    routes.usuarios.js       /api/usuarios    CRUD usuários (admin)
    routes.itens.js          /api/itens       consulta do catálogo
    routes.solicitacoes.js   /api/solicitacoes  CRUD + busca histórico + resumo
    routes.relatorios.js     /api/relatorios  consolidado (JSON e CSV)
    routes.elenco.js         /api/elenco      importador de catálogo + edição
    routes.importarSolicitacoes.js  /api/importar-solicitacoes
    routes.alertas.js        /api/alertas     listar e resolver
    routes.estoque.js        /api/estoque     importar, consultar, detalhe item
    routes.config.js         /api/config      limiar de autonomia
frontend/
  login.html                 Tela de login
  index.html                 App principal (todas as seções)
  css/estilo.css             Estilo único (paleta institucional sóbria)
  js/login.js                Lógica do login
  js/app.js                  Toda a lógica do app (navegação, telas, fetch)
```

## Esquema do banco (tabelas principais)

- **itens** (3.345 linhas) — catálogo/elenco. PK `codigo_item`. Campos:
  `codigo_siafisico`, `descricao`, `catmat`, `ativo` (1/0),
  `inativado_em`, `atualizado_em`. Itens que saem do elenco são
  **inativados (ativo=0), nunca excluídos**.
- **solicitacoes** (3.675 linhas) — movimento de compra. FK `codigo_item`.
  Cada linha tem `ano` + `mes` (controle mês a mês preservado), `tipo` (AS/JS),
  `modalidade_compra`, `n_oficio`, `n_empenho`, quantidades, datas e `status`.
  Status vistos: Planejamento, Adjucado, Empenhado, Entrega Parcial,
  Finalizado, Cancelado, Deserto, Fracassado, Revogado.
  Status "em aberto" (compra em andamento): Planejamento, Adjucado,
  Empenhado, Entrega Parcial.
- **estoque_importacoes** / **estoque_itens** — cada importação diária é um
  snapshot datado (`data_referencia`). `estoque_itens` guarda estoque,
  `autonomia` (meses de cobertura), `demandas`, consumo, custo, etc.
- **alertas** — `tipo`, `codigo_item`, `mensagem`, `resolvido`. Tipos:
  `estoque_ruptura`, `estoque_baixo`, `compra_aberta_demanda_zero`,
  `item_removido_com_historico`.
- **configuracoes** — chave/valor. Hoje só `autonomia_minima_meses` (padrão 2).
- **usuarios**, **auditoria**, **importacoes** (log).

## Regras de negócio que NÃO podem quebrar

1. **Item nunca é excluído do catálogo** se tiver histórico de compra. Ao sair
   do elenco numa importação, vira `ativo=0` e gera alerta
   `item_removido_com_historico`. (Caso real de referência:
   `1L30552/28/67275/01/00`.)
2. **Código siafísico é centralizado em `itens`**. Corrigir lá reflete em todos
   os meses automaticamente (solicitações referenciam por `codigo_item`, não
   duplicam o siafísico). Há tela de edição manual no menu Elenco.
3. **Controle mês a mês**: cada solicitação é uma linha com `ano`+`mes` própria.
   Importadores não devem fundir meses nem perder esse detalhe.
4. **Importação de estoque mantém histórico** (não sobrescreve datas anteriores;
   só substitui se reimportar a MESMA data).
5. **Alertas de estoque** são recalculados a cada importação de estoque:
   - `estoque_ruptura`: estoque ≤ 0 E demanda > 0 (crítico).
   - `estoque_baixo`: estoque > 0 E autonomia entre 0 e o limiar configurável.
   - `compra_aberta_demanda_zero`: tem compra em aberto mas demanda 0 no estoque.

## Layouts de planilha esperados pelos importadores

- **Elenco** (`routes.elenco.js`): 1ª aba, colunas reconhecidas por nome
  (tolera acento/maiúsc.): Código do Item, Código Siafísico, Descrição do
  Item, e opcional CATMAT.
- **Solicitações** (`routes.importarSolicitacoes.js`): layout original, uma
  aba por mês nomeada tipo `AGOSTO-2026`. Mapeamento por POSIÇÃO de coluna
  (constante `COL`). Só importa linhas com algum campo de movimento; ignora "-".
- **Estoque** (`routes.estoque.js`): arquivo "Itens em Estoque UDTP".
  Cabeçalho na ~linha 6, dados a partir da 7. Mapeamento por posição
  (constante `COL`). Data de referência extraída do nome da aba
  (ex.: `Rel_ItensEmEstoque_16022024_104` → 2024-02-16).

## Como rodar (Windows, Node v24 já instalado)

```
cd backend
npm install                          # primeira vez (ou usar "1 - instalar.bat")
copy .env.example .env               # criar config local
npm run criar-admin "Rafael" rafael@tenentepena.local SENHA
npm start                            # sobe em http://localhost:3000
```

O `.env` real NÃO vai no controle de versão (só o `.env.example`).
Trocar o `JWT_SECRET` antes de usar em rede de verdade.

## Convenções ao editar este projeto

- Mantenha tudo em **português** (nomes, mensagens, comentários, UI).
- Ao adicionar rota: criar `routes.X.js`, montar em `server.js`, e a tela
  correspondente em `index.html` + funções em `app.js` + link na navegação.
- Rotas nomeadas (ex.: `/relatorio`, `/historico-medicamento`) devem vir
  ANTES de rotas com parâmetro (`/:id`) no mesmo arquivo, senão o Express
  casa o nome como se fosse um id.
- O `db.js` cria as tabelas e faz migração idempotente com `ALTER TABLE`
  protegido por checagem de coluna — siga esse padrão ao mudar o schema,
  para não quebrar bancos já em uso.
- Toda escrita relevante registra em `auditoria`.
- Após mexer no frontend, lembrar o Rafael de dar **Ctrl+F5** (cache).

## Histórico resumido do que já foi construído

1. Extração da planilha original → banco SQLite relacional (itens +
   solicitações), reduzindo de 18 MB para ~1,4 MB.
2. App web com login, RBAC, painel, busca de medicamento, relatório
   consolidado (com export CSV).
3. Importador de elenco (catálogo) + edição manual + inativação com alerta.
4. Importador de solicitações mensais (layout original).
5. Módulo de estoque: importação diária com histórico, consulta com filtros,
   detalhe do item cruzando estoque × compras judiciais, e três tipos de
   alerta. Limiar de autonomia configurável.
6. Scripts .bat para o Rafael rodar no Windows sem usar terminal.

## Bug já corrigido (referência)

Modais (`.fundo-modal`) abriam todos juntos ao carregar a página porque o
CSS `display:flex` vencia o atributo `hidden` do HTML, travando a tela de
login. Corrigido com regra global `[hidden] { display: none !important; }`
no topo de `estilo.css`. Se algo parecido reaparecer, é conflito de
especificidade CSS vs atributo `hidden`.

## Estado atual / próximos passos possíveis

- Banco entregue limpo (catálogo + solicitações reais; sem usuários, estoque
  ou alertas — Rafael cria o admin e importa o estoque do dia).
- Fase atual: testes locais.
- Ideias futuras: acesso externo (túnel), dashboard de evolução de estoque,
  e-mail/alerta proativo de prazos vencendo.
