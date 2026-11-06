// =====================================================================
// termoLGPD.js
// Texto do "Termo de Ciência e Responsabilidade – Tratamento de Dados
// (LGPD)" exibido no primeiro acesso de cada usuário ao Elo.
//
// ┌───────────────────────────────────────────────────────────────────┐
// │ ATENÇÃO (MINUTA): este texto é um RASCUNHO para revisão do setor    │
// │ jurídico / encarregado de dados (DPO) antes de valer oficialmente.  │
// │ NÃO constitui parecer jurídico. Ajuste livremente o conteúdo.       │
// └───────────────────────────────────────────────────────────────────┘
//
// COMO FUNCIONA O VERSIONAMENTO:
//   - `VERSAO` identifica a versão vigente do termo.
//   - Cada usuário tem o aceite gravado COM a versão que aceitou.
//   - Se você MUDAR o texto de forma relevante, INCREMENTE a `VERSAO`
//     (ex.: '1' -> '2'). Todos voltarão a ver o termo e a aceitar a nova
//     versão no próximo acesso. Aceites antigos ficam guardados (histórico).
//   - Mudança só de pontuação/digitação NÃO precisa trocar a versão.
// =====================================================================

const VERSAO = '1';

const TITULO = 'Termo de Ciência e Responsabilidade – Tratamento de Dados (LGPD)';

// O texto é dividido em parágrafos (cada item do array vira um <p>).
// Mantido como array para facilitar a edição e evitar HTML solto.
const PARAGRAFOS = [
  'O Elo – Gestão e Controle de Aquisição Judicial é um sistema interno de uso restrito. Ele reúne e exibe dados pessoais e dados pessoais sensíveis (inclusive dados de saúde de pacientes de ações judiciais), além de informações de aquisição, estoque e empenho.',
  'O tratamento desses dados pelo sistema tem como finalidade o cumprimento de obrigação legal e a execução de políticas públicas de assistência farmacêutica, nos termos da Lei nº 13.709/2018 (LGPD), em especial dos artigos 7º, II e III, e 11, II. O acesso a este sistema não cria, para o usuário, uma relação de consentimento, mas sim um dever funcional de sigilo e de uso adequado.',
  'Ao acessar o Elo, declaro estar ciente de que: (i) só devo utilizar os dados para o desempenho das minhas atribuições funcionais; (ii) é vedado copiar, imprimir, encaminhar, divulgar ou dar aos dados qualquer uso estranho à finalidade do sistema; (iii) não devo compartilhar minhas credenciais de acesso nem permitir que terceiros usem a minha sessão; (iv) todas as minhas ações ficam registradas em trilha de auditoria.',
  'Comprometo-me a manter sigilo sobre as informações a que tiver acesso, inclusive após o término da minha atuação, e a comunicar ao responsável qualquer incidente, suspeita de acesso indevido ou vazamento de dados de que venha a tomar conhecimento.',
  'Declaro ter lido e compreendido este termo e assumo a responsabilidade pelo uso que fizer do sistema e dos dados nele disponibilizados.',
];

module.exports = { VERSAO, TITULO, PARAGRAFOS };
