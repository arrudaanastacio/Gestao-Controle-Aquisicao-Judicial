# Política de Retenção e Descarte de Informações — Sistema Elo

> Documento da **Onda E** da auditoria de segurança. Descreve o ciclo de vida
> dos dados do sistema de Compras Judiciais (Tenente Pena). Os campos marcados
> **[A DEFINIR]** dependem de decisão institucional/jurídica — **não foram
> inventados prazos legais**. Base aplicável a considerar: **LGPD** (há dado
> pessoal e de saúde dos autores), normas de **arquivo/conservação documental**
> e de **transparência** do órgão.

Última atualização: 2026-10-15 · Responsável pelo sistema: Rafael Arruda Anastácio

---

## Princípios
1. **Não excluir** o que for necessário à prestação de contas, auditoria ou
   preservação documental.
2. Descarte **seguro** (sobrescrever/criptografar), não só apagar o índice.
3. Toda rotina automática de expurgo deve ter **modo simulação**, **relatório
   prévio** e **registro** da execução.
4. Dado pessoal: guardar o **mínimo necessário** e pelo tempo da finalidade.

---

## Categorias

### 1. Dados operacionais (catálogo, solicitações, atas, empenhos)
- **Finalidade:** operação e histórico das compras judiciais.
- **Hoje:** mantidos indefinidamente; itens que saem do elenco são **inativados
  (ativo=0), nunca excluídos** (regra de negócio).
- **Prazo de retenção:** **[A DEFINIR]** (tende a ser longo — prestação de contas).
- **Descarte:** não se aplica enquanto houver obrigação de guarda.

### 2. Dados pessoais / de saúde (autores das ações)
- **Finalidade:** vincular demanda judicial ao requerente.
- **Hoje:** recarregados do SCODES; mantidos enquanto a demanda estiver ativa.
- **Prazo:** **[A DEFINIR — LGPD]** — definir por quanto tempo após o fim da
  demanda os dados pessoais permanecem, e se são **anonimizados** depois.
- **Descarte:** anonimização ou remoção segura ao fim do prazo.

### 3. Registros de auditoria (`auditoria`)
- **Finalidade:** rastreabilidade (quem fez o quê, inclusive eventos de
  segurança: login_ok/login_falho/logout/acesso_negado — Onda B).
- **Hoje:** **crescem sem expurgo** (não há limpeza automática).
- **Prazo:** **[A DEFINIR]** — sugestão técnica de partida: **manter 2 anos**
  ativos + arquivar o excedente; confirmar com exigências de auditoria do órgão.
- **Descarte:** só após o prazo e **nunca** sobre eventos sob investigação.
- **Proteção:** hoje a trilha fica no mesmo banco (admin pode alterar). Melhoria
  prevista: integridade por **hash chain** / cópia externa protegida.

### 4. Backups
- **Finalidade:** recuperação do banco.
- **Hoje:** diários (janela rolante **7**, dias úteis) + mensais (**12** meses);
  **cifrados em AES-256-GCM** quando há `BACKUP_CHAVE` (Onda C1). Cópia ao
  Google Drive **só quando cifrada**.
- **Prazo:** 7 diários / 12 mensais (ajustável por `BACKUP_MANTER_DIARIOS` /
  `BACKUP_MENSAL_MANTER`). **[A DEFINIR]** se o órgão exige retenção maior.
- **Descarte:** janela rolante apaga os excedentes automaticamente.

### 5. Arquivos temporários / auxiliares
- **`data/*.db-wal`, `*.db-shm`:** gerenciados pelo SQLite (efêmeros). Protegidos
  pelo **BitLocker** (Onda C2) em repouso.
- **`.db` intermediário do backup:** criado e **apagado** ao fim de cada backup.
- **Descarte:** automático; nenhum dado em texto puro deve sobrar fora de pasta
  protegida por disco cifrado.

### 6. Exportações (CSV/relatórios baixados pelos usuários)
- **Finalidade:** uso pontual fora do sistema.
- **Hoje:** geradas sob demanda; **ficam na máquina de quem baixou** (fora do
  controle do sistema).
- **Prazo/descarte:** **[A DEFINIR]** — orientar os usuários a não reter
  exportações com dado pessoal além do necessário.

### 7. Arquivos de sincronização (planilhas dos vigias, relatórios Oracle/GSNET)
- **Finalidade:** importação automática.
- **Hoje:** lidos da rede (drive Z:) e das pastas dos robôs; o sistema guarda o
  **resultado** no banco, não os arquivos.
- **Prazo/descarte:** dos arquivos de origem — **[A DEFINIR]** com quem mantém a
  pasta de rede.

### 8. Dados de teste (homologação)
- **Finalidade:** validar mudanças antes de produção.
- **Hoje:** cópia do banco real na pasta de TESTE (porta 3001).
- **Prazo/descarte:** **[A DEFINIR]** — por ser cópia de dado real, aplicar o
  mesmo rigor de proteção (BitLocker) e descartar cópias antigas.

### 9. Cópias antigas / versões anteriores do banco (`.bak`)
- **Hoje:** `*.bak` **nunca** vão para o git (repo público); ficam em pasta local.
- **Prazo/descarte:** **[A DEFINIR]** — manter alinhado com a retenção de backups.

---

## Pendências para fechar a política
1. Definir **prazos** dos campos **[A DEFINIR]** com a instituição/jurídico (LGPD
   + normas de arquivo).
2. Decidir **expurgo automático da auditoria** após o prazo (posso implementar
   com modo simulação + relatório + registro).
3. Definir **anonimização** de dados pessoais ao fim da demanda, se aplicável.

> Enquanto os prazos não forem definidos, **nada é apagado** além do que já é hoje
> (janela rolante de backups). O descarte automático só entra depois da decisão.
