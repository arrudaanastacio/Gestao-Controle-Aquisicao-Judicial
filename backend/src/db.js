const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'medicamentos_judicial.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');
// Sem isso, duas escritas simultâneas (ex.: sync via Oracle + um vigia de
// arquivo) fazem o SQLite falhar na hora com "database is locked" em vez de
// esperar a outra terminar. 5s é suficiente para as escritas deste sistema.
db.exec('PRAGMA busy_timeout = 5000;');

// Tabela de usuários (criada se não existir)
db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK(perfil IN ('admin','consulta')),
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);

// Última atividade do usuário (para mostrar quem está "online" no painel).
// Atualizada a cada requisição autenticada (ver auth.js / autenticar).
const colunasUsuarios = db.prepare("PRAGMA table_info(usuarios)").all().map((c) => c.name);
if (!colunasUsuarios.includes('ultimo_acesso')) {
  db.exec('ALTER TABLE usuarios ADD COLUMN ultimo_acesso TEXT');
}
// Convite por e-mail: token de uso único para o colega criar a própria senha.
// Enquanto houver token válido e senha_hash vazio, o usuário ainda não definiu senha.
if (!colunasUsuarios.includes('token_convite')) {
  db.exec('ALTER TABLE usuarios ADD COLUMN token_convite TEXT');
}
if (!colunasUsuarios.includes('token_expira')) {
  db.exec('ALTER TABLE usuarios ADD COLUMN token_expira TEXT');
}
// Caixas do Relatório de Primeiro Atendimento que o usuário pode ver (JSON
// array, ex.: ["Materiais","Nutrição"]). NULL = todas (mantém quem já usa);
// admin sempre vê todas. Definido pelo admin no modal de Permissões.
if (!colunasUsuarios.includes('caixas_req')) {
  db.exec('ALTER TABLE usuarios ADD COLUMN caixas_req TEXT');
}

db.exec(`
CREATE TABLE IF NOT EXISTS itens (
  codigo_item TEXT PRIMARY KEY,
  codigo_siafisico TEXT,
  descricao TEXT NOT NULL,
  catmat TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  inativado_em TEXT,
  atualizado_em TEXT DEFAULT (datetime('now'))
);
`);

// Migração idempotente: adiciona colunas novas se o banco já existia antes desta versão
const colunasItens = db.prepare("PRAGMA table_info(itens)").all().map((c) => c.name);
if (!colunasItens.includes('catmat')) db.exec("ALTER TABLE itens ADD COLUMN catmat TEXT");
if (!colunasItens.includes('ativo')) db.exec("ALTER TABLE itens ADD COLUMN ativo INTEGER NOT NULL DEFAULT 1");
if (!colunasItens.includes('inativado_em')) db.exec("ALTER TABLE itens ADD COLUMN inativado_em TEXT");
if (!colunasItens.includes('atualizado_em')) db.exec("ALTER TABLE itens ADD COLUMN atualizado_em TEXT");

// Alertas operacionais (ex: item removido do elenco mas com histórico de compra)
db.exec(`
CREATE TABLE IF NOT EXISTS alertas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  codigo_item TEXT,
  mensagem TEXT NOT NULL,
  resolvido INTEGER NOT NULL DEFAULT 0,
  resolvido_por TEXT,
  resolvido_em TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);

// Histórico de importações realizadas (elenco e solicitações)
db.exec(`
CREATE TABLE IF NOT EXISTS importacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  nome_arquivo TEXT,
  usuario_email TEXT,
  resumo TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);

// Log de auditoria de alterações (quem mudou o quê)
db.exec(`
CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER,
  usuario_email TEXT,
  acao TEXT NOT NULL,
  tabela TEXT,
  registro_id INTEGER,
  dados_antes TEXT,
  dados_depois TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);

// Cada importação diária do relatório de estoque vira um "snapshot" datado.
// Mantemos o histórico para acompanhar a evolução do estoque ao longo do tempo.
db.exec(`
CREATE TABLE IF NOT EXISTS estoque_importacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_referencia TEXT NOT NULL,           -- dia do estoque (yyyy-mm-dd)
  nome_arquivo TEXT,
  usuario_email TEXT,
  total_itens INTEGER,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);

// Linhas de estoque de cada importação (uma foto do item naquele dia)
db.exec(`
CREATE TABLE IF NOT EXISTS estoque_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  importacao_id INTEGER NOT NULL,
  data_referencia TEXT NOT NULL,
  codigo_item TEXT,
  id_item_origem TEXT,
  descricao TEXT,
  siafisico TEXT,
  catmat TEXT,
  categoria TEXT,
  tipo_item TEXT,
  marca TEXT,
  outras_demandas TEXT,
  demandas REAL,
  demandas_aj REAL,
  consumo_mensal_total REAL,
  consumo_mensal_aj REAL,
  estoque REAL,
  autonomia REAL,
  custo_unitario REAL,
  valor_medio_unitario REAL,
  lotes TEXT,
  FOREIGN KEY (importacao_id) REFERENCES estoque_importacoes(id)
);
`);

// Colunas adicionais de estoque (controlado / importado) — presentes na planilha
// mas que não eram guardadas antes. Migração idempotente para bancos já em uso.
const colunasEstoque = db.prepare("PRAGMA table_info(estoque_itens)").all().map((c) => c.name);
if (!colunasEstoque.includes('controlado')) db.exec("ALTER TABLE estoque_itens ADD COLUMN controlado TEXT");
if (!colunasEstoque.includes('importado')) db.exec("ALTER TABLE estoque_itens ADD COLUMN importado TEXT");
if (!colunasEstoque.includes('unidade')) db.exec("ALTER TABLE estoque_itens ADD COLUMN unidade TEXT");
// Demanda/consumo por programa (Comissão de Farmacologia = "Adm", e JEFAZ),
// espelhando demandas_aj/consumo_mensal_aj (ação judicial). Vêm da query Oracle.
if (!colunasEstoque.includes('demandas_cf')) db.exec("ALTER TABLE estoque_itens ADD COLUMN demandas_cf REAL");
if (!colunasEstoque.includes('consumo_mensal_cf')) db.exec("ALTER TABLE estoque_itens ADD COLUMN consumo_mensal_cf REAL");
if (!colunasEstoque.includes('demandas_jefaz')) db.exec("ALTER TABLE estoque_itens ADD COLUMN demandas_jefaz REAL");
if (!colunasEstoque.includes('consumo_mensal_jefaz')) db.exec("ALTER TABLE estoque_itens ADD COLUMN consumo_mensal_jefaz REAL");

// Arquivamento histórico: marca quais importações sao snapshots permanentes
// (referencia dia 01 ou 15). data_referencia segue sendo a data de coleta.
const colunasImport = db.prepare("PRAGMA table_info(estoque_importacoes)").all().map((c) => c.name);
if (!colunasImport.includes('arquivado')) db.exec("ALTER TABLE estoque_importacoes ADD COLUMN arquivado INTEGER NOT NULL DEFAULT 0");
if (!colunasImport.includes('referencia_historica')) db.exec("ALTER TABLE estoque_importacoes ADD COLUMN referencia_historica TEXT");

db.exec(`CREATE INDEX IF NOT EXISTS idx_estoque_codigo ON estoque_itens(codigo_item);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_estoque_data ON estoque_itens(data_referencia);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_estoque_importacao ON estoque_itens(importacao_id);`);

// ---------------------------------------------------------------------
// RESERVAS (API UDTP) — quantidade do estoque separada para um paciente.
// Mesmo padrão do estoque: cada consulta é uma FOTO DATADA. Serve para
// calcular o disponível real (estoque - reservado) por item/lote.
// A ligação com o resto do sistema é pelo CÓDIGO SCODES.
// A API não devolve identificação do paciente — por isso não há campo de
// paciente aqui (nada de dado pessoal é guardado).
// ---------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS reservas_importacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_referencia TEXT NOT NULL,           -- dia consultado na API (yyyy-mm-dd)
  origem TEXT,                             -- ex.: 'API UDTP'
  usuario_email TEXT,
  total_itens INTEGER,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);

// Ajuste de formato ANTES da 1ª publicação: o desenho inicial supunha
// lote/validade/unidade, mas a API devolve codigoItem/codigoProtocolo/
// descricao/recebedor/saldoReservado. Como a tela nunca foi publicada e o
// conteúdo é uma foto re-obtenível da API, a tabela antiga é descartada.
const colsReservasAntigas = db.prepare("PRAGMA table_info(reservas_itens)").all().map((c) => c.name);
if (colsReservasAntigas.includes('codigo_scodes')) {
  db.exec('DROP TABLE IF EXISTS reservas_itens');
  db.exec('DELETE FROM reservas_importacoes');
}

db.exec(`
CREATE TABLE IF NOT EXISTS reservas_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  importacao_id INTEGER NOT NULL,
  data_referencia TEXT NOT NULL,
  codigo_item TEXT,                        -- chave de ligação (casa com estoque_itens.codigo_item)
  codigo_protocolo TEXT,                   -- protocolo da ação/demanda do paciente
  descricao TEXT,                          -- nome do medicamento
  recebedor TEXT,                          -- para quem a quantidade foi separada
  saldo_reservado REAL,
  FOREIGN KEY (importacao_id) REFERENCES reservas_importacoes(id)
);
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_reservas_item ON reservas_itens(codigo_item);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_reservas_protocolo ON reservas_itens(codigo_protocolo);`);

// ---------------------------------------------------------------------
// ESTOQUE POR LOTE (API UDTP /api/estoque/{data}) — fonte de LOTE,
// VALIDADE e UNIDADE DE MEDIDA, que a API de reservas não traz.
// Granularidade: uma linha por lote. Itens sem saldo vêm numa linha única
// com lote/validade nulos. Liga-se às reservas por codigo_item.
// Guardado à parte do estoque do Oracle (estoque_itens), que tem outra
// origem, outra granularidade (por unidade) e outros campos.
// ---------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS estoque_udtp_importacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_referencia TEXT NOT NULL,
  origem TEXT,
  usuario_email TEXT,
  total_itens INTEGER,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS estoque_udtp_lotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  importacao_id INTEGER NOT NULL,
  data_referencia TEXT NOT NULL,
  codigo_item TEXT,
  descricao TEXT,
  lote TEXT,
  validade TEXT,                           -- yyyy-mm-dd
  saldo REAL,
  unidade_medida TEXT,
  com_marca INTEGER,                       -- 0/1
  FOREIGN KEY (importacao_id) REFERENCES estoque_udtp_importacoes(id)
);
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_estudtp_item ON estoque_udtp_lotes(codigo_item);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_estudtp_data ON estoque_udtp_lotes(data_referencia);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_estudtp_validade ON estoque_udtp_lotes(validade);`);

// ---------------------------------------------------------------------
// RUPTURAS (API UDTP /api/rupturas?periodoInicio=&periodoFim=)
// Dispensação que o paciente veio buscar e NÃO pôde ser atendida — é o
// fato consumado, diferente do alerta "estoque_ruptura", que é calculado.
//
// Ligações confirmadas com dado real (22/07/2026):
//   codigo_item          -> estoque / relatorio_itens.codigo   (100%)
//   protocolo_norm       -> autores_itens.protocolo sem "N: "  (100%)
// O campo demandaId da API NÃO é o id_demanda dos autores (só 6% coincidem),
// por isso é guardado apenas como referência, sem servir de chave.
//
// Categoria, tipo de item, importado e outras demandas NÃO são copiados para
// cá: vêm por junção com relatorio_itens na hora da consulta, assim
// acompanham automaticamente qualquer correção feita naquele cadastro.
// ---------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS rupturas_importacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  periodo_inicio TEXT NOT NULL,
  periodo_fim TEXT NOT NULL,
  origem TEXT,
  usuario_email TEXT,
  total_itens INTEGER,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS rupturas_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  importacao_id INTEGER NOT NULL,
  data TEXT NOT NULL,                      -- dia da ruptura (yyyy-mm-dd)
  codigo_item TEXT,
  descricao TEXT,
  unidade_medida TEXT,
  quantidade REAL,                         -- quanto faltou
  protocolo TEXT,                          -- numeroDocumentoSaida, como veio
  protocolo_norm TEXT,                     -- sem "N: " e sem espaços (chave)
  demanda_id TEXT,
  com_marca INTEGER,
  FOREIGN KEY (importacao_id) REFERENCES rupturas_importacoes(id)
);
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_rupt_data ON rupturas_itens(data);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_rupt_item ON rupturas_itens(codigo_item);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_rupt_prot ON rupturas_itens(protocolo_norm);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_reservas_data ON reservas_itens(data_referencia);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_reservas_importacao ON reservas_itens(importacao_id);`);

// Listagem de Autores (requerentes das ações judiciais) — cada linha é um
// autor x item da demanda. É substituída por completo a cada importação.
db.exec(`
CREATE TABLE IF NOT EXISTS autores_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_referencia TEXT,
  unidade_dispensadora TEXT,
  unidade_organizacional TEXT,
  id_demanda TEXT,
  autor TEXT,
  idade TEXT,
  dt_nascimento TEXT,
  data_cadastro TEXT,
  protocolo TEXT,
  processo TEXT,
  status_demanda TEXT,
  tipo_demanda TEXT,
  porta_entrada TEXT,
  codigo_item TEXT,
  id_item TEXT,
  data_inclusao_od TEXT,
  descricao_item TEXT,
  qtde_consumo TEXT,
  status_item TEXT,
  data_inativacao_item TEXT,
  cobranca_judicial TEXT,
  servicos_medicos TEXT,
  saude_mental TEXT,
  dispensacoes TEXT,
  periodicidade TEXT,
  prazo TEXT,
  dispensacoes_autorizadas TEXT,
  intercambiaveis TEXT,
  outras_demandas TEXT,
  importados TEXT,
  categoria TEXT,
  data_ultima_dispensacao TEXT,
  data_ultimo_retorno TEXT,
  procurador_estado TEXT,
  cod_siafisico TEXT
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_autores_autor ON autores_itens(autor);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_autores_codigo ON autores_itens(codigo_item);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_autores_unidade ON autores_itens(unidade_dispensadora);`);

// Protocolo normalizado (sem o prefixo "N: " e sem espaços) guardado em coluna
// própria. É a chave que liga a RUPTURA ao paciente. Antes a normalização era
// feita na hora da consulta, com REPLACE sobre as ~217 mil linhas da data —
// varredura completa, repetida em cada uma das 8 consultas da tela (48s no
// total). Com a coluna gravada e indexada, vira busca por índice.
const colunasAutores = db.prepare("PRAGMA table_info(autores_itens)").all().map((c) => c.name);
if (!colunasAutores.includes('protocolo_norm')) {
  db.exec("ALTER TABLE autores_itens ADD COLUMN protocolo_norm TEXT");
}
// Preenche o que ainda estiver vazio (linhas importadas antes desta versão).
const faltando = db.prepare(
  'SELECT COUNT(*) AS c FROM autores_itens WHERE protocolo_norm IS NULL AND protocolo IS NOT NULL'
).get().c;
if (faltando > 0) {
  console.log(`[BANCO] Normalizando o protocolo de ${faltando} linha(s) de autores_itens...`);
  db.exec(`UPDATE autores_itens
              SET protocolo_norm = REPLACE(REPLACE(REPLACE(protocolo, 'N: ', ''), 'N:', ''), ' ', '')
            WHERE protocolo_norm IS NULL AND protocolo IS NOT NULL`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_autores_data_prot ON autores_itens(data_referencia, protocolo_norm);`);

// Atas de Registro de Preço (SISCOA) — cada linha é um item registrado numa
// Ata. Guarda só as 2 fotos mais recentes (mesmo padrão de autores_itens),
// já que o relatório sempre traz o que está vigente no momento da extração.
db.exec(`
CREATE TABLE IF NOT EXISTS atas_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_referencia TEXT,
  ata TEXT,
  oc TEXT,
  item TEXT,
  siafisico TEXT,
  descricao TEXT,
  unidade_fornecimento TEXT,
  nome_comercial TEXT,
  apresentacao TEXT,
  detentor_registro TEXT,
  ultimo_valor_publicado REAL,
  data_publicacao TEXT,
  vencimento TEXT,
  embalagem_primaria TEXT,
  embalagem_secundaria TEXT
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_atas_siafisico ON atas_itens(siafisico);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_atas_data ON atas_itens(data_referencia);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_atas_vencimento ON atas_itens(vencimento);`);

// Estoque Outras Demandas (operador logístico: GSNET + IBL) — cada linha é um
// lote do relatório IBL, enriquecido com o codigo_item SCODES (via planilha de
// "Cadastro Itens GSNET-IBL") e com o saldo do GSNET para conferência cruzada.
db.exec(`
CREATE TABLE IF NOT EXISTS estoque_od_importacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_referencia TEXT NOT NULL UNIQUE,
  total_itens INTEGER,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);
db.exec(`
CREATE TABLE IF NOT EXISTS estoque_od_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  importacao_id INTEGER NOT NULL,
  data_referencia TEXT NOT NULL,
  codigo_item TEXT,
  codigo_sku TEXT,
  descricao TEXT,
  lote TEXT,
  validade TEXT,
  embalagem2 TEXT,
  multiplo_distribuicao REAL,
  status_estoque TEXT,
  tipo_bloqueio TEXT,
  obs_bloqueio TEXT,
  qtde_disponivel REAL,
  qtde_bloqueado REAL,
  qtde_reservada REAL,
  qtde_total REAL,
  saldo_gsnet REAL,
  status_comparativo TEXT,
  diferenca REAL,
  FOREIGN KEY (importacao_id) REFERENCES estoque_od_importacoes(id)
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_estoqueod_codigo ON estoque_od_itens(codigo_item);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_estoqueod_sku ON estoque_od_itens(codigo_sku);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_estoqueod_data ON estoque_od_itens(data_referencia);`);

// Distribuição — Status de Faturas (WMS/IBL): planilha "2.Status Fatura WMS_IBL.xlsx".
// Snapshot único (substitui tudo a cada importação, sem histórico por data).
db.exec(`
CREATE TABLE IF NOT EXISTS distribuicao_faturas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_programa TEXT,
  programa TEXT,
  drs TEXT,
  codigo_material TEXT,
  nome_material TEXT,
  unidade_medida TEXT,
  numero_fatura TEXT,
  emissao_fatura TEXT,
  dt_programacao_entrega TEXT,
  qtd_volumes_itens REAL,
  origem TEXT,
  status TEXT,
  codigo_destino TEXT,
  local TEXT,
  municipio TEXT,
  categoria TEXT,
  status_fatura TEXT,
  qtde_faturada REAL,
  preco_total REAL,
  codigo_item TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_distfaturas_codigo ON distribuicao_faturas(codigo_item);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_distfaturas_status ON distribuicao_faturas(status);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_distfaturas_local ON distribuicao_faturas(local);`);

// Distribuição — Extrato de Movimentações (GSNET/Simples): arquivo "1.Extrato Simples.xls".
// Histórico de movimentações de saída do armazém GSNET/IBL. Snapshot único também.
db.exec(`
CREATE TABLE IF NOT EXISTS distribuicao_movimentacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nr_documento TEXT,
  sr_documento TEXT,
  dt_documento TEXT,
  tp_movimentacao TEXT,
  vl_total REAL,
  local_origem TEXT,
  local_destino TEXT,
  dt_inclusao TEXT,
  dt_alteracao TEXT,
  st_registro TEXT,
  nr_ordem TEXT,
  id_item TEXT,
  nm_item TEXT,
  qt_unit_atendida REAL,
  pmu REAL,
  cd_usuario TEXT,
  codigo_item TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_distmov_codigo ON distribuicao_movimentacoes(codigo_item);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_distmov_destino ON distribuicao_movimentacoes(local_destino);`);

// Distribuição — Itens Elegíveis por unidade (exceção, ex.: CEDMAC): planilha
// "6.Elenco CEDMAC.xlsx". Para a maioria das unidades de Outras Demandas a
// elegibilidade é só "outras_demandas = Sim" no catálogo; unidades com
// regra própria (Consumo Mensal Total fixo por acordo administrativo, e
// fator de Conversão porque o estoque vem numa unidade "base" diferente da
// unidade de dispensação) entram aqui. Substitui tudo a cada importação.
db.exec(`
CREATE TABLE IF NOT EXISTS distribuicao_itens_elegiveis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_item TEXT,
  siafisico TEXT,
  descricao_item TEXT,
  unidade_dispensadora TEXT,
  demandas REAL,
  consumo_mensal_fixo REAL,
  conversao REAL,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_distelegiveis_codigo ON distribuicao_itens_elegiveis(codigo_item);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_distelegiveis_unidade ON distribuicao_itens_elegiveis(unidade_dispensadora);`);

// Distribuição — Conversão geral de Outras Demandas: planilha "7.Conversão
// OD.xlsx". Diferente da exceção CEDMAC (que é por unidade, com consumo
// fixo), esta lista vale para QUALQUER unidade de Outras Demandas: só diz
// quais itens têm estoque/consumo reportados numa unidade "base" (grama,
// mililitro, dose) diferente da unidade de dispensação, e o fator pra
// converter. Nesses itens, tanto o Consumo quanto o Estoque são divididos
// pela conversão (diferente da CEDMAC, onde só o Estoque é dividido).
db.exec(`
CREATE TABLE IF NOT EXISTS distribuicao_conversao_od (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_item TEXT,
  siafisico TEXT,
  descricao_item TEXT,
  conversao REAL,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_distconversaood_codigo ON distribuicao_conversao_od(codigo_item);`);

// Distribuição — Locais de Entrega: planilha "8.Locais de Entrega.xlsx".
// "De-para" entre o nome da unidade no SCODES (usado em estoque_itens.
// unidade, ex.: "UD 27 - CEDMAC HCFMUSP") e o código numérico usado pelo
// GSNET (distribuicao_faturas.codigo_destino, ex.: 2865) — os dois
// sistemas usam nomes de unidade diferentes (às vezes com erro de
// digitação de um lado), então o vínculo confiável é por esse código.
db.exec(`
CREATE TABLE IF NOT EXISTS distribuicao_locais_entrega (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_entrega TEXT,
  cod_local TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_distlocais_local ON distribuicao_locais_entrega(local_entrega);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_distlocais_cod ON distribuicao_locais_entrega(cod_local);`);

// Coeficiente (autonomia-alvo em meses) da Sugestão de Reposição, ajustável por
// item — e, opcionalmente, por item + unidade. Substitui o antigo alvo fixo de
// 3 meses. Persistente (não some nas importações diárias). Regra em cascata:
//   1) coeficiente do item NAQUELA unidade  ->  2) padrão do item  ->  3) 3 (fixo)
// unidade = '' guarda o PADRÃO do item. coeficiente 0 = não distribuir.
db.exec(`
CREATE TABLE IF NOT EXISTS distribuicao_coeficiente (
  codigo_item TEXT NOT NULL,
  unidade TEXT NOT NULL DEFAULT '',
  coeficiente REAL NOT NULL,
  atualizado_em TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (codigo_item, unidade)
);
`);

// Grade validada da reposição: itens que o usuário aprovou ("Validar") para
// enviar ao operador logístico, no layout do arquivo "9.Modelo grade.xlsx".
// Uma linha por item (SCODES) por local de entrega — "Negar" apaga a linha.
db.exec(`
CREATE TABLE IF NOT EXISTS distribuicao_grade (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cod_local TEXT,
  local_entrega TEXT,
  cod_item TEXT,            -- código GSNET (SKU), COD_ITEM na grade
  medicamento TEXT,
  qtde REAL,
  validade TEXT,
  codigo_scodes TEXT,      -- nosso código (coluna "Código SCODES")
  criado_em TEXT DEFAULT (datetime('now')),
  atualizado_em TEXT DEFAULT (datetime('now')),
  UNIQUE(local_entrega, codigo_scodes)
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_distgrade_local ON distribuicao_grade(local_entrega);`);
// Origem da quantidade na grade: 'calculada' (fórmula) ou 'manual' (digitada).
{
  const colsGrade = db.prepare("PRAGMA table_info(distribuicao_grade)").all().map((c) => c.name);
  if (!colsGrade.includes('origem')) db.exec("ALTER TABLE distribuicao_grade ADD COLUMN origem TEXT NOT NULL DEFAULT 'calculada'");
}

// Distribuição Hospital Escola (H.E) — base fechada da planilha
// "10.Hospital Escola Base.xlsx": lista fixa de medicamentos (aba "Itens")
// e de unidades dispensadoras (aba "Unidades") que participam da grade dos
// Hospitais Escola. Diferente da reposição geral (que varre todas as
// unidades de Outras Demandas), aqui o universo é fechado: só estes itens,
// só estas unidades. O Consumo e o Estoque vêm da query de itens em estoque,
// divididos pela conversão de embalagem definida nesta própria planilha.
db.exec(`
CREATE TABLE IF NOT EXISTS distribuicao_he_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_item TEXT,        -- código SCODES
  codigo_gsnet TEXT,       -- código GSNET (SKU) informado na planilha
  siafisico TEXT,
  descricao_item TEXT,
  conversao REAL,          -- Embalagem Conversão (fator; 1 = sem conversão)
  criado_em TEXT DEFAULT (datetime('now'))
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_disthe_itens_codigo ON distribuicao_he_itens(codigo_item);`);

db.exec(`
CREATE TABLE IF NOT EXISTS distribuicao_he_unidades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unidade TEXT,            -- nome no SCODES (bate com estoque_itens.unidade)
  criado_em TEXT DEFAULT (datetime('now'))
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_disthe_unidades ON distribuicao_he_unidades(unidade);`);

// Solicitações de compra de Outras Demandas (relatório próprio, separado do
// Tenente Pena — layout de colunas diferente, mesmo conceito de mês a mês)
db.exec(`
CREATE TABLE IF NOT EXISTS solicitacoes_od (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_item TEXT NOT NULL,
  descricao TEXT,
  codigo_siafisico TEXT,
  codigo_gsnet TEXT,
  ano INTEGER NOT NULL,
  mes TEXT NOT NULL,
  tipo TEXT,
  modalidade_compra TEXT,
  n_oficio TEXT,
  qtde_solicitada TEXT,
  data_solicitacao TEXT,
  requisicao_gsnet TEXT,
  n_empenho TEXT,
  data_previsao_entrega TEXT,
  data_entrega TEXT,
  qtde_entregue TEXT,
  qtde_pendente TEXT,
  status TEXT,
  observacao TEXT
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_solod_codigo ON solicitacoes_od(codigo_item);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_solod_anomes ON solicitacoes_od(ano, mes);`);
// MIGRAÇÃO: remove o índice ÚNICO antigo em (codigo_item, ano, mes, tipo).
// Ele impedia guardar duas solicitações OD do mesmo item/mês/tipo com
// ofícios/quantidades diferentes — forçava o importador a sobrescrever uma
// pela outra, perdendo dados. O importador agora "refaz o mês" (apaga por
// ano+mes, coberto por idx_solod_anomes) e não depende mais desse índice.
db.exec(`DROP INDEX IF EXISTS idx_solod_unico;`);

// Movimentações de Entrada com Lotes/Validade (via Oracle/SCODES).
// Janela dos últimos 12 meses até hoje, recalculada na própria query SQL.
// A cada sincronização o conteúdo é substituído por completo (não é um
// histórico próprio — o histórico real é o do Oracle).
db.exec(`
CREATE TABLE IF NOT EXISTS entrada_lotes_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item TEXT,
  unidade TEXT,
  data_entrada TEXT,
  tipo_movimentacao TEXT,
  unidade_transferencia TEXT,
  modalidade_compra TEXT,
  nota_empenho TEXT,
  nota_fiscal TEXT,
  documento_transferencia TEXT,
  fabricante TEXT,
  codigo_item TEXT,
  qtde REAL,
  qtde_acerto REAL,
  valor_unitario REAL,
  valor_total REAL,
  usuario_login TEXT,
  observacao TEXT,
  termolabil TEXT,
  fornecedor TEXT,
  fornecedor_cnpj TEXT,
  tipo_transferencia TEXT,
  lote TEXT,
  validade TEXT,
  lote_foi_digitado TEXT,
  categoria TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_entlotes_codigo ON entrada_lotes_itens(codigo_item);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_entlotes_data ON entrada_lotes_itens(data_entrada);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_entlotes_unidade ON entrada_lotes_itens(unidade);`);
const colunasEntLotes = db.prepare("PRAGMA table_info(entrada_lotes_itens)").all().map((c) => c.name);
if (!colunasEntLotes.includes('categoria')) db.exec("ALTER TABLE entrada_lotes_itens ADD COLUMN categoria TEXT");

// Movimentações de SAÍDA com Lotes/Validade (via Oracle/SCODES). Mesma
// lógica da tabela de Entrada: janela dos últimos 12 meses recalculada na
// query SQL e conteúdo substituído por completo a cada sincronização.
// Reúne os dois blocos de Saída do SCODES (dispensações + demais saídas).
db.exec(`
CREATE TABLE IF NOT EXISTS saida_lotes_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item TEXT,
  unidade TEXT,
  data_saida TEXT,
  tipo_movimentacao TEXT,
  unidade_transferencia TEXT,
  fornecedor TEXT,
  fornecedor_cnpj TEXT,
  documento_transferencia TEXT,
  tipo_transferencia TEXT,
  fabricante TEXT,
  codigo_item TEXT,
  qtde REAL,
  usuario_login TEXT,
  observacao TEXT,
  lote TEXT,
  validade TEXT,
  lote_foi_digitado TEXT,
  categoria TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sailotes_codigo ON saida_lotes_itens(codigo_item);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sailotes_data ON saida_lotes_itens(data_saida);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sailotes_tipo ON saida_lotes_itens(tipo_movimentacao);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sailotes_categoria ON saida_lotes_itens(categoria);`);

// Requisições de compra geradas (Relatório Primeiro Atendimento)
db.exec(`
CREATE TABLE IF NOT EXISTS requisicoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_controle TEXT,
  autor TEXT,
  idade TEXT,
  unidade TEXT,
  procurador TEXT,
  sei TEXT,
  operador_nome TEXT,
  operador_email TEXT,
  total_itens INTEGER,
  criado_em TEXT DEFAULT (datetime('now'))
);
`);
db.exec(`
CREATE TABLE IF NOT EXISTS requisicao_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requisicao_id INTEGER NOT NULL,
  codigo_item TEXT,
  cod_siafisico TEXT,
  descricao_item TEXT,
  categoria TEXT,
  quantidade TEXT,
  FOREIGN KEY (requisicao_id) REFERENCES requisicoes(id)
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_reqitens_req ON requisicao_itens(requisicao_id);`);

// Relatório de Compras Importados: alimentado manualmente pelo botão "+" da
// Listagem de Autores Importados (captura a linha do autor + dados do modal).
// Controle por paciente/item; colunas editáveis (quantidade_solicitada, sei,
// status) vão sendo preenchidas na tela. Novas colunas entram por migração.
db.exec(`
CREATE TABLE IF NOT EXISTS compras_importados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_item TEXT,
  cod_siafisico TEXT,
  descricao_item TEXT,
  categoria TEXT,
  autor TEXT,
  unidade_dispensadora TEXT,
  id_demanda TEXT,
  protocolo TEXT,
  processo TEXT,
  status_demanda TEXT,
  tipo_demanda TEXT,
  qtde_consumo TEXT,
  prazo TEXT,
  periodicidade TEXT,
  data_ultima_dispensacao TEXT,
  data_ultimo_retorno TEXT,
  quantidade_solicitada TEXT,
  sei TEXT,
  status TEXT DEFAULT 'Solicitado',
  criado_em TEXT DEFAULT (datetime('now','localtime')),
  criado_por TEXT,
  atualizado_em TEXT
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_comp_imp_autor ON compras_importados(autor);`);

// Status/cancelamento da requisição (cancelar mantém o histórico)
const colunasReq = db.prepare("PRAGMA table_info(requisicoes)").all().map((c) => c.name);
if (!colunasReq.includes('status')) db.exec("ALTER TABLE requisicoes ADD COLUMN status TEXT NOT NULL DEFAULT 'Ativa'");
if (!colunasReq.includes('atualizado_em')) db.exec("ALTER TABLE requisicoes ADD COLUMN atualizado_em TEXT");
if (!colunasReq.includes('cancelado_em')) db.exec("ALTER TABLE requisicoes ADD COLUMN cancelado_em TEXT");
if (!colunasReq.includes('cancelado_por')) db.exec("ALTER TABLE requisicoes ADD COLUMN cancelado_por TEXT");
if (!colunasReq.includes('protocolo')) db.exec("ALTER TABLE requisicoes ADD COLUMN protocolo TEXT");
if (!colunasReq.includes('processo')) db.exec("ALTER TABLE requisicoes ADD COLUMN processo TEXT");
if (!colunasReq.includes('tipo_demanda')) db.exec("ALTER TABLE requisicoes ADD COLUMN tipo_demanda TEXT");
// Solicitação Coletiva: uma requisição consolida vários pacientes + itens somados.
if (!colunasReq.includes('coletiva')) db.exec("ALTER TABLE requisicoes ADD COLUMN coletiva INTEGER NOT NULL DEFAULT 0");
if (!colunasReq.includes('total_pacientes')) db.exec("ALTER TABLE requisicoes ADD COLUMN total_pacientes INTEGER");
if (!colunasReq.includes('pacientes_json')) db.exec("ALTER TABLE requisicoes ADD COLUMN pacientes_json TEXT");
// Status ÚNICO do grupo (só para coletiva; a individual usa o status por item).
if (!colunasReq.includes('status_atendimento')) db.exec("ALTER TABLE requisicoes ADD COLUMN status_atendimento TEXT DEFAULT 'Solicitado'");
if (!colunasReq.includes('telegrama_enviado')) db.exec("ALTER TABLE requisicoes ADD COLUMN telegrama_enviado TEXT DEFAULT 'Não'");
if (!colunasReq.includes('data_envio')) db.exec("ALTER TABLE requisicoes ADD COLUMN data_envio TEXT");
if (!colunasReq.includes('requisicao_gsnet')) db.exec("ALTER TABLE requisicoes ADD COLUMN requisicao_gsnet TEXT");
if (!colunasReq.includes('telegrama_enviado_por')) db.exec("ALTER TABLE requisicoes ADD COLUMN telegrama_enviado_por TEXT");
if (!colunasReq.includes('telegrama_enviado_em')) db.exec("ALTER TABLE requisicoes ADD COLUMN telegrama_enviado_em TEXT");
// Caixa do Relatório de Primeiro Atendimento (Materiais/Medicamentos/Nutrição;
// null = sem caixa, só admin/aba "Todas"). Preenchida na criação; backfill em
// routes.autores.js.
if (!colunasReq.includes('caixa')) db.exec("ALTER TABLE requisicoes ADD COLUMN caixa TEXT");

// Fluxo de atendimento por item da requisição (editável pelos usuários)
const colunasReqItens = db.prepare("PRAGMA table_info(requisicao_itens)").all().map((c) => c.name);
if (!colunasReqItens.includes('status_atendimento')) db.exec("ALTER TABLE requisicao_itens ADD COLUMN status_atendimento TEXT NOT NULL DEFAULT 'Solicitado'");
if (!colunasReqItens.includes('telegrama_enviado')) db.exec("ALTER TABLE requisicao_itens ADD COLUMN telegrama_enviado TEXT NOT NULL DEFAULT 'Não'");
if (!colunasReqItens.includes('data_envio')) db.exec("ALTER TABLE requisicao_itens ADD COLUMN data_envio TEXT");
if (!colunasReqItens.includes('requisicao_gsnet')) db.exec("ALTER TABLE requisicao_itens ADD COLUMN requisicao_gsnet TEXT");
if (!colunasReqItens.includes('telegrama_enviado_por')) db.exec("ALTER TABLE requisicao_itens ADD COLUMN telegrama_enviado_por TEXT");
if (!colunasReqItens.includes('telegrama_enviado_em')) db.exec("ALTER TABLE requisicao_itens ADD COLUMN telegrama_enviado_em TEXT");
if (!colunasReqItens.includes('tipo_demanda')) db.exec("ALTER TABLE requisicao_itens ADD COLUMN tipo_demanda TEXT");
if (!colunasReqItens.includes('qtde_consumo')) db.exec("ALTER TABLE requisicao_itens ADD COLUMN qtde_consumo TEXT");
if (!colunasReqItens.includes('prazo')) db.exec("ALTER TABLE requisicao_itens ADD COLUMN prazo TEXT");
if (!colunasReqItens.includes('periodicidade')) db.exec("ALTER TABLE requisicao_itens ADD COLUMN periodicidade TEXT");
if (!colunasReqItens.includes('dispensacoes_autorizadas')) db.exec("ALTER TABLE requisicao_itens ADD COLUMN dispensacoes_autorizadas TEXT");
if (!colunasReqItens.includes('autonomia_compra')) db.exec("ALTER TABLE requisicao_itens ADD COLUMN autonomia_compra TEXT");
if (!colunasReqItens.includes('catmat')) db.exec("ALTER TABLE requisicao_itens ADD COLUMN catmat TEXT");
// Coletiva: detalhe por paciente do item consolidado (JSON) + nº de pacientes.
if (!colunasReqItens.includes('detalhe_json')) db.exec("ALTER TABLE requisicao_itens ADD COLUMN detalhe_json TEXT");
if (!colunasReqItens.includes('n_pacientes')) db.exec("ALTER TABLE requisicao_itens ADD COLUMN n_pacientes INTEGER");
if (!colunasReqItens.includes('situacao_ata')) db.exec("ALTER TABLE requisicao_itens ADD COLUMN situacao_ata TEXT");
if (!colunasReqItens.includes('escolha_ata')) db.exec("ALTER TABLE requisicao_itens ADD COLUMN escolha_ata TEXT");
if (!colunasReqItens.includes('valor_unitario')) db.exec("ALTER TABLE requisicao_itens ADD COLUMN valor_unitario TEXT");

// Relatório de Itens (catálogo completo) — substitui Consulta/Catálogo.
// Substituído por completo a cada importação.
db.exec(`
CREATE TABLE IF NOT EXISTS relatorio_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_referencia TEXT,
  pro_id TEXT,
  situacao TEXT,
  usuario TEXT,
  categoria TEXT,
  codigo TEXT,
  siafisico TEXT,
  catmat TEXT,
  descricao_item TEXT,
  valor_medio_unitario TEXT,
  item TEXT,
  especificacao TEXT,
  apresentacao TEXT,
  marca TEXT,
  importado TEXT,
  tipo_item TEXT,
  grupo TEXT,
  programa TEXT,
  grupo_af TEXT,
  intercambiavel TEXT,
  observacoes TEXT,
  outras_demandas TEXT,
  oncologico TEXT,
  termolabil TEXT,
  antimicrobiano TEXT,
  portaria34498 TEXT,
  grande_volume TEXT,
  comissao_farmacologia TEXT,
  judicial TEXT,
  jefaz TEXT
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_relitens_codigo ON relatorio_itens(codigo);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_relitens_descricao ON relatorio_itens(descricao_item);`);

// Classificação PERMANENTE do item (não é apagada pela reimportação diária do
// relatório de itens). Dados manuais, mantidos pelo usuário, cruzados por
// codigo_item: Dose Certa (PDC), Doença Rara, Unidade de Fornecimento e
// Embalagem de Conversão (o múltiplo usado no arredondamento do Planejamento).
// Origem: aba "Status-Siafisico" (importação) ou edição manual pela tela.
db.exec(`
CREATE TABLE IF NOT EXISTS item_classificacao (
  codigo_item TEXT PRIMARY KEY,
  dose_certa TEXT,             -- 'Sim' / 'Não'
  doenca_rara TEXT,           -- 'Sim' / 'Não'
  unidade_fornecimento TEXT,
  embalagem_conversao REAL,
  outros_programas TEXT,       -- 'Sim' / 'Não'
  qual_programa TEXT,          -- descrição do programa quando outros_programas = 'Sim'
  subcategoria TEXT,           -- ex.: Medicamentos, Materiais, Manipulado, Importado... (planilha REL)
  responsavel_aquisicao TEXT,  -- ex.: CGA / CAF (planilha REL)
  atualizado_em TEXT DEFAULT (datetime('now','localtime')),
  usuario_email TEXT
);
`);
// Migração idempotente: bancos antigos ganham as colunas novas.
const colsClassificacao = db.prepare("PRAGMA table_info(item_classificacao)").all().map((c) => c.name);
if (!colsClassificacao.includes('outros_programas')) db.exec("ALTER TABLE item_classificacao ADD COLUMN outros_programas TEXT");
if (!colsClassificacao.includes('qual_programa')) db.exec("ALTER TABLE item_classificacao ADD COLUMN qual_programa TEXT");
if (!colsClassificacao.includes('subcategoria')) db.exec("ALTER TABLE item_classificacao ADD COLUMN subcategoria TEXT");
if (!colsClassificacao.includes('responsavel_aquisicao')) db.exec("ALTER TABLE item_classificacao ADD COLUMN responsavel_aquisicao TEXT");
// Override de modalidade do Planejamento decidido pelo técnico nos casos de
// marca divergente (REVISAR): 'ATA' | 'PREGAO' | NULL (usa a classificação automática).
if (!colsClassificacao.includes('modalidade_planejamento')) db.exec("ALTER TABLE item_classificacao ADD COLUMN modalidade_planejamento TEXT");
// Inex (Sim/Não): item adquirido por Inexigibilidade. No Planejamento vira Modalidade Inex.
if (!colsClassificacao.includes('inex')) db.exec("ALTER TABLE item_classificacao ADD COLUMN inex TEXT");

// Configurações gerais do sistema (ex: limiar de autonomia para alerta de estoque baixo)
db.exec(`
CREATE TABLE IF NOT EXISTS configuracoes (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
`);
// Valor padrão do limiar de autonomia (meses) — só insere se ainda não existir
const cfg = db.prepare("SELECT valor FROM configuracoes WHERE chave = 'autonomia_minima_meses'").get();
if (!cfg) {
  db.prepare("INSERT INTO configuracoes (chave, valor) VALUES ('autonomia_minima_meses', '2')").run();
}

// Permissões por usuário e por módulo (controle fino de acesso).
// Cada coluna é 1 (pode) ou 0 (não pode). O perfil 'admin' NÃO usa esta tabela:
// ele é super-usuário e sempre pode tudo (ver auth.js / exigirModulo).
db.exec(`
CREATE TABLE IF NOT EXISTS permissoes (
  usuario_id INTEGER NOT NULL,
  modulo TEXT NOT NULL,
  visualizar INTEGER NOT NULL DEFAULT 0,
  inserir INTEGER NOT NULL DEFAULT 0,
  editar INTEGER NOT NULL DEFAULT 0,
  excluir INTEGER NOT NULL DEFAULT 0,
  exportar INTEGER NOT NULL DEFAULT 0,
  importar INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (usuario_id, modulo),
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
);
`);

// Interruptor mestre do módulo: se habilitado=0, o usuário não enxerga nem usa
// o módulo (bloqueia tudo, independente das ações). Padrão 1 (habilitado).
const colunasPerm = db.prepare("PRAGMA table_info(permissoes)").all().map((c) => c.name);
if (!colunasPerm.includes('habilitado')) {
  db.exec('ALTER TABLE permissoes ADD COLUMN habilitado INTEGER NOT NULL DEFAULT 1');
}

// Garante que todo usuário NÃO-admin tenha uma linha por módulo. Por padrão só
// "visualizar" vem ligado (resto 0) — assim ninguém perde o acesso de leitura
// que já tinha, e o admin libera o resto na tela. INSERT OR IGNORE preserva o
// que o admin já configurou (não sobrescreve).
const { MODULO_CHAVES } = require('./permissoes');
function garantirPermissoesPadrao() {
  const usuarios = db.prepare("SELECT id, perfil FROM usuarios WHERE ativo = 1").all();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO permissoes (usuario_id, modulo, visualizar) VALUES (?, ?, 1)'
  );
  for (const u of usuarios) {
    if (u.perfil === 'admin') continue;
    for (const modulo of MODULO_CHAVES) insert.run(u.id, modulo);
  }
}
garantirPermissoesPadrao();

// =====================================================================
// Execuções dos serviços automáticos (vigias, agendadores, backup).
// Alimenta a tela "Status dos Serviços". Uma linha por execução que de
// fato FEZ algo (importou/falhou) — as verificações de rotina que não
// encontram novidade NÃO são gravadas, senão a tabela cresceria ~2.880
// linhas por dia por vigia sem informação útil.
// =====================================================================
db.exec(`
CREATE TABLE IF NOT EXISTS servico_execucoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  servico TEXT NOT NULL,              -- id do serviço (ver registroServicos.js)
  iniciado_em TEXT NOT NULL,          -- ISO local
  finalizado_em TEXT,
  duracao_ms INTEGER,
  resultado TEXT NOT NULL,            -- 'sucesso' | 'erro'
  nivel TEXT NOT NULL DEFAULT 'INFO', -- INFO | WARNING | ERROR | CRITICAL
  mensagem TEXT,
  registros INTEGER,                  -- quantidade de linhas processadas
  arquivo TEXT,                       -- arquivo/origem processada
  origem TEXT NOT NULL DEFAULT 'automatico', -- 'automatico' | 'manual'
  usuario_email TEXT,
  detalhe TEXT                        -- stack trace, quando houver
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_servexec_servico ON servico_execucoes(servico, iniciado_em DESC);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_servexec_data ON servico_execucoes(iniciado_em DESC);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_servexec_nivel ON servico_execucoes(nivel, iniciado_em DESC);`);

// Retenção: mantém 180 dias de histórico de execuções. Roda uma vez na
// subida do sistema — barato e evita crescimento indefinido da tabela.
try {
  db.prepare(
    "DELETE FROM servico_execucoes WHERE iniciado_em < datetime('now', 'localtime', '-180 days')"
  ).run();
} catch { /* tabela recém-criada, nada a limpar */ }

// =====================================================================
// MÓDULO DE PLANEJAMENTO DE COMPRAS
// =====================================================================
// O planejamento é um DOCUMENTO próprio do sistema, com histórico e versão,
// que a reimportação das solicitações (12h/19h, que apaga e refaz o mês) NUNCA
// toca. Guarda o que o Rafael decidiu, não o espelho da planilha do G:.
//
// Fluxo: cada relatório abaixo alimenta o cálculo; o resultado vira um
// `planejamento` (cabeçalho) com N `planejamento_itens` (linhas), separado por
// unidade e modalidade de aquisição (ATA / PREGAO / INEX).

// --- Insumos importados (relatórios que o Rafael exporta e salva na rede) ----

// Consumo Médio (LOIS): (Σ consumo 6 meses + Σ ruptura 6 meses) / nº de meses.
// Guardamos o valor final já calculado pelo relatório + os componentes, para
// rastreabilidade. Uma foto por data de referência (histórico preservado).
db.exec(`
CREATE TABLE IF NOT EXISTS plan_consumo_medio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_referencia TEXT NOT NULL,        -- data de geração do relatório
  codigo_item TEXT NOT NULL,
  consumo_medio REAL,                   -- coluna "Consumo Médio" (LOIS)
  consumo_scodes REAL,                  -- coluna "Consumo SCODES"
  autonomia_scodes REAL,
  autonomia_lois REAL,
  saldo REAL,
  meses_consolidados INTEGER,           -- parâmetro do topo do relatório (ex.: 6)
  considera_rupturas INTEGER,           -- 1/0 (parâmetro do topo)
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_consumo_data_item ON plan_consumo_medio(data_referencia, codigo_item);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_consumo_item ON plan_consumo_medio(codigo_item);`);

// Carta de Troca: quantidade que entra por carta de troca (reduz a compra).
db.exec(`
CREATE TABLE IF NOT EXISTS plan_carta_troca (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_referencia TEXT NOT NULL,
  codigo_item TEXT NOT NULL,
  quantidade_carta REAL,                -- "Quantidade Carta de Troca"
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_carta_data_item ON plan_carta_troca(data_referencia, codigo_item);`);

// Demanda Irregular: itens marcados como irregulares (S/N) e a quantidade.
db.exec(`
CREATE TABLE IF NOT EXISTS plan_demanda_irregular (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_referencia TEXT NOT NULL,
  codigo_item TEXT NOT NULL,
  irregular INTEGER NOT NULL DEFAULT 0, -- 1 quando ORP_IRREGULAR = 'S'
  quantidade REAL,                      -- coluna "Total"
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_irregular_data_item ON plan_demanda_irregular(data_referencia, codigo_item);`);

// --- Documento do planejamento ------------------------------------------------

// Cabeçalho: uma linha por planejamento gerado. `unidade` = TP | OD | HE.
// `modalidade` = ATA | PREGAO | INEX. `autonomia_alvo` é o padrão daquele
// documento (6 para ATA, 9 para Pregão/Inex) — mas cada item pode divergir.
db.exec(`
CREATE TABLE IF NOT EXISTS planejamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unidade TEXT NOT NULL DEFAULT 'TP',
  modalidade TEXT NOT NULL,             -- ATA | PREGAO | INEX
  titulo TEXT,                          -- ex.: "Planejamento Julho/2026 - Pregão"
  data_base TEXT NOT NULL,              -- data de referência dos dados usados
  autonomia_alvo REAL NOT NULL,         -- meses-alvo padrão do documento
  corte_pouca_demanda INTEGER NOT NULL DEFAULT 3, -- até N demandas = pouca
  status TEXT NOT NULL DEFAULT 'rascunho', -- rascunho | finalizado | exportado
  versao INTEGER NOT NULL DEFAULT 1,
  usuario_id INTEGER,
  usuario_email TEXT,
  observacao TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  atualizado_em TEXT
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_planejamentos_unid_mod ON planejamentos(unidade, modalidade, criado_em DESC);`);

// Itens do planejamento: a linha calculada e o que o Rafael ajustou.
// Guardamos os INSUMOS usados (estoque, consumo, compras em aberto, embalagem,
// ata) junto com o RESULTADO, para o documento ser auto-explicativo mesmo que
// os dados de origem mudem depois. `autonomia_sugerida` vem do motor;
// `autonomia_ajustada` é o que o Rafael digitou (NULL = usa a sugerida).
db.exec(`
CREATE TABLE IF NOT EXISTS planejamento_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  planejamento_id INTEGER NOT NULL,
  codigo_item TEXT NOT NULL,
  descricao TEXT,
  siafisico TEXT,
  catmat TEXT,
  -- insumos (foto no momento do cálculo)
  consumo_mensal REAL,
  estoque REAL,
  empenhado REAL,
  solicitado REAL,
  carta_troca REAL,
  reservado REAL,
  embalagem_conversao REAL DEFAULT 1,
  unidade_fornecimento TEXT,
  demanda_total REAL,
  irregular INTEGER DEFAULT 0,
  ata_numero TEXT,
  ata_validade TEXT,
  preco_unitario REAL,
  -- cobertura já existente (meses) = (estoque+empenhado+solicitado)/consumo
  autonomia_existente REAL,
  -- decisão
  autonomia_sugerida REAL,
  autonomia_ajustada REAL,              -- NULL = usa a sugerida
  quantidade_calculada REAL,            -- MROUND(autonomia*consumo*conv, emb)
  custo_total REAL,
  comprar INTEGER NOT NULL DEFAULT 1,   -- 1 entra na compra, 0 excluído pelo Rafael
  observacao TEXT,
  FOREIGN KEY (planejamento_id) REFERENCES planejamentos(id)
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_itens_plano ON planejamento_itens(planejamento_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_itens_item ON planejamento_itens(codigo_item);`);

// --- Cartas de Troca ----------------------------------------------------------

// empenhos: foto do "Relatório Estratégico de Empenhos" (GsnetCompras). Cada
// linha é um item de um empenho (um empenho pode ter vários medicamentos).
// A importação SUBSTITUI toda a tabela (é um retrato re-obtenível do site),
// servindo de fonte de busca para o cadastro das cartas de troca. `scodes` é o
// codigo_item que casa com o catálogo. Ver memória relatorio-empenhos-gsnet.
db.exec(`
CREATE TABLE IF NOT EXISTS empenhos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_referencia TEXT NOT NULL,
  numero_requisicao TEXT,
  nome_requisicao TEXT,
  codigo_unico TEXT,
  processo_sem_papel TEXT,
  nota_empenho TEXT,
  empresa TEXT,
  scodes TEXT,                          -- = codigo_item (ex.: 1R01144/17/1751/01/00)
  siafisico TEXT,
  medicamento TEXT,
  apresentacao TEXT,
  quantidade REAL,
  valor_unitario REAL,
  valor_total REAL,
  data_limite_entrega TEXT,
  data_entrega_ne TEXT,
  quantidade_entrega REAL,
  quantidade_total REAL,
  data_entrega_item TEXT,
  status_entrega TEXT,                  -- Empenhado | Entregue Parcialmente | Entregue Totalmente
  local_entrega TEXT,
  atraso TEXT,                          -- SIM | NAO
  dias_atraso REAL,
  data_publicacao TEXT,
  data_retorno TEXT,
  data_envio TEXT,
  data_retirada TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_empenhos_nota ON empenhos(nota_empenho);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_empenhos_scodes ON empenhos(scodes);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_empenhos_empresa ON empenhos(empresa);`);

// cartas_troca: o CONTROLE em si. Cada registro é 1 carta para 1 item de 1
// empenho (relação 1-para-1 por linha empenho+medicamento). A empresa protocola
// a carta quando quer entregar um item com validade menor que a exigida no
// edital, informando validade, lote e o compromisso de trocar se vencer no
// estoque. Ver memória carta-de-troca-definicao.
db.exec(`
CREATE TABLE IF NOT EXISTS cartas_troca (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_controle TEXT,                 -- CT-2026-00001 (gerado no insert)
  empenho_id INTEGER,                   -- linha do empenho que originou (pode ficar nulo se o empenho sair da foto)
  -- dados copiados do empenho (foto, para o registro ser auto-explicativo)
  nota_empenho TEXT,
  numero_requisicao TEXT,
  nome_requisicao TEXT,
  processo_sem_papel TEXT,
  empresa TEXT,
  codigo_item TEXT,                     -- = scodes
  siafisico TEXT,
  medicamento TEXT,
  apresentacao TEXT,
  -- dados da carta (o técnico preenche)
  local_entrega TEXT,                  -- do empenho (CAF / UNIDADE TENENTE PENA), editável
  numero_protocolo TEXT,
  data_protocolo TEXT,
  lote TEXT,                           -- legado (1 lote); hoje os lotes vivem em cartas_troca_lotes
  data_validade TEXT,                  -- validade mais próxima entre os lotes (derivada, p/ alerta)
  quantidade REAL,                     -- quantidade da carta (Total = qtd do empenho; Parcial = informada)
  tipo_quantidade TEXT DEFAULT 'Total',-- Total | Parcial
  status_troca TEXT NOT NULL DEFAULT 'Vigente', -- Vigente | Vencido no estoque | Trocado | Consumido | Cancelado
  situacao_analise TEXT NOT NULL DEFAULT 'Aguardando avaliação', -- Aguardando avaliação | Aprovada | Reprovada
  motivo_reprovacao TEXT,
  avaliado_por TEXT,
  avaliado_em TEXT,
  observacao TEXT,
  criado_por TEXT,
  criado_por_email TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  atualizado_em TEXT,
  enviado_em TEXT,                     -- quando (re)enviada para avaliação
  FOREIGN KEY (empenho_id) REFERENCES empenhos(id)
);
`);
// Migração idempotente (bancos de homolog já tinham a tabela sem estes campos).
const colsCartas = db.prepare('PRAGMA table_info(cartas_troca)').all().map((c) => c.name);
const addCarta = (nome, ddl) => { if (!colsCartas.includes(nome)) db.exec(`ALTER TABLE cartas_troca ADD COLUMN ${ddl}`); };
addCarta('local_entrega', 'local_entrega TEXT');
addCarta('tipo_quantidade', "tipo_quantidade TEXT DEFAULT 'Total'");
addCarta('situacao_analise', "situacao_analise TEXT NOT NULL DEFAULT 'Aguardando avaliação'");
addCarta('motivo_reprovacao', 'motivo_reprovacao TEXT');
addCarta('avaliado_por', 'avaliado_por TEXT');
addCarta('avaliado_em', 'avaliado_em TEXT');
addCarta('criado_por_email', 'criado_por_email TEXT');
addCarta('enviado_em', 'enviado_em TEXT');
db.exec(`CREATE INDEX IF NOT EXISTS idx_cartas_item ON cartas_troca(codigo_item);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_cartas_empresa ON cartas_troca(empresa);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_cartas_status ON cartas_troca(status_troca);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_cartas_situacao ON cartas_troca(situacao_analise);`);

// Lotes de uma carta de troca (1 carta → N lotes). Cada lote: nº, validade e
// quantidade. A soma das quantidades dos lotes deve fechar com a quantidade da
// carta. A validade mais próxima é copiada para cartas_troca.data_validade
// (derivada) para o alerta de vencimento na listagem.
db.exec(`
CREATE TABLE IF NOT EXISTS cartas_troca_lotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  carta_id INTEGER NOT NULL,
  lote TEXT,
  data_validade TEXT,
  quantidade REAL,
  FOREIGN KEY (carta_id) REFERENCES cartas_troca(id)
);
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_cartas_lotes_carta ON cartas_troca_lotes(carta_id);`);

module.exports = db;
module.exports.garantirPermissoesPadrao = garantirPermissoesPadrao;
