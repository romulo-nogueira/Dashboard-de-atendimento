/* Configuração da implantação — edite este arquivo (não precisa recompilar nada). */
window.OPA_CONFIG = {
  titulo: "Dashboard de Atendimentos",
  subtitulo: "Central de atendimento · OPA Suite",

  // Modo com banco de dados: endereço da API do servidor (server/server.js). Deixe "" para usar só arquivos.
  // Se a API não responder, o painel cai para o arquivo estático abaixo.
  apiUrl: "/api",

  // (Modo sem banco) De onde o painel lê os dados quando ninguém enviou um arquivo no navegador.
  // Pode ser um caminho do próprio site ou uma URL completa (CSV ou XLSX),
  // por exemplo o link "Publicar na Web > CSV" de uma Google Planilha.
  dataUrl: "data/atendimentos.csv",
  deParaUrl: "data/depara_motivos.csv",

  // Verifica a cada N minutos se há dados novos no banco e recarrega sozinho (0 = desligado). Bom para TV/monitor.
  autoRefreshMinutes: 5,

  // Mínimo de avaliações para um atendente entrar no ranking de nota (a planilha usava 10).
  minAvaliacoesRanking: 10,

  // TMA: atendimentos com duração acima deste teto (em horas) ficam fora da média, pois costumam ser
  // tickets esquecidos abertos e distorcem o indicador. 0 = sem teto (soma tudo).
  tmaMaxHoras: 24,

  // Colunas com estes termos no cabeçalho são tratadas como dado do cliente e NUNCA são gravadas
  // (já incluídos: contato, cliente, telefone, celular, cpf, cnpj, email, endereço, documento, nome, cep...).
  // Acrescente aqui termos próprios da sua operação. No servidor use a variável COLUNAS_SENSIVEIS.
  colunasSensiveis: [],

  // Canais que sempre aparecem (na ordem). Canais novos encontrados nos dados são adicionados sozinhos.
  canais: ["WhatsApp", "Instagram", "Telefonia"],

  // Permite enviar/colar arquivos pelo navegador (ficam salvos só naquele navegador).
  permitirAtualizacaoPeloNavegador: true
};
