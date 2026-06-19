# Compras de Medicamentos Judiciais — Tenente Pena

Sistema web local para controle de **compras judiciais de medicamentos**, gestão de
**estoque** e **validades**, usado na unidade Tenente Pena (setor público de saúde).
Substitui uma planilha Excel/VBA de ~18 MB e 26 abas por um aplicativo simples,
rápido e auditável.

> Roda no computador da unidade e é acessado pelos colegas via navegador na rede
> local (`http://IP-DA-MAQUINA:3000`).

---

## ✨ Principais recursos

- **Login com perfis** (administrador e somente-consulta), senha criptografada.
- **Catálogo de medicamentos** (elenco) ligado às compras pelo código do item.
- **Solicitações de compra** mês a mês, com status, ofício, empenho e datas.
- **Relatórios** detalhados (Aquisição em Andamento e Geral) com exportação CSV.
- **Estoque diário** importado de planilha, com histórico (cada importação é uma foto datada).
- **Gestão de validades**: KPIs de lotes a vencer (30/60/90/+90 dias), valores e exportação.
- **Alertas automáticos** cruzando estoque × compras (ruptura, estoque baixo, etc.).
- **Auditoria** de todas as escritas relevantes.

---

## 🧱 Tecnologia

| Camada | Escolha |
|---|---|
| Backend | Node.js + Express 5 |
| Banco | SQLite via módulo nativo `node:sqlite` (Node 22+) — **sem dependências de compilação** |
| Autenticação | JWT em cookie httpOnly + bcrypt |
| Frontend | HTML + CSS + JavaScript puro (sem framework, sem build) |
| Planilhas | SheetJS (`xlsx`) + `multer` |

Tudo em **português** (código, rotas, interface).

---

## 🚀 Como rodar (Windows)

Pré-requisito: **Node.js 22 ou superior**.

```bash
cd backend
npm install                         # instala dependências (1ª vez)
copy .env.example .env              # cria a configuração local
npm run criar-admin "Seu Nome" seu@email.local SUA_SENHA
npm start                           # sobe em http://localhost:3000
```

No Windows há scripts `.bat` de duplo-clique na pasta `backend/` para quem
prefere não usar o terminal (instalar, criar usuário, iniciar, salvar versão,
exportar banco).

---

## 📁 Estrutura

```
backend/
  src/
    server.js        Express + monta as rotas + serve o frontend
    db.js            Abre o banco e cria/migra as tabelas
    auth.js          Token, autenticação, perfis
    routes.*.js      Rotas por domínio (auth, itens, solicitações, estoque, …)
  data/              Banco SQLite (não versionado)
frontend/
  index.html         App principal (todas as telas)
  login.html         Tela de login
  css/ js/           Estilo e lógica
```

---

## 🔒 Segurança e dados

- O arquivo `.env` (segredos) e o banco `*.db` (dados reais) **não vão para o
  repositório** — veja `.gitignore`.
- Antes de expor em rede de verdade, troque o `JWT_SECRET` no `.env`.

---

## 📄 Licença

Projeto de uso interno. Defina aqui a licença desejada (ex.: MIT) caso vá
torná-lo público para reutilização.
