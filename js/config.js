/* Configuração da implantação — edite este arquivo (não precisa recompilar nada). */
window.OPA_CONFIG = {
  titulo: "Dashboard de Atendimentos",
  subtitulo: "Central de atendimento · OPA Suite",

  // De onde o painel lê os dados quando ninguém enviou um arquivo no navegador.
  // Pode ser um caminho do próprio site ou uma URL completa (CSV ou XLSX),
  // por exemplo o link "Publicar na Web > CSV" de uma Google Planilha.
  dataUrl: "data/atendimentos.csv",
  deParaUrl: "data/depara_motivos.csv",

  // Recarrega o arquivo do servidor a cada N minutos (0 = desligado). Útil para TV/monitor de sala.
  autoRefreshMinutes: 0,

  // Mínimo de avaliações para um atendente entrar no ranking de nota (a planilha usava 10).
  minAvaliacoesRanking: 10,

  // Canais que sempre aparecem (na ordem). Canais novos encontrados nos dados são adicionados sozinhos.
  canais: ["WhatsApp", "Instagram", "Telefonia"],

  // Permite enviar/colar arquivos pelo navegador (ficam salvos só naquele navegador).
  permitirAtualizacaoPeloNavegador: true
};
