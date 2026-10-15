# Dashboard de Atendimentos (versão web)

Versão web da planilha `Dashboard_Atendimentos_OPA_V3.xlsx`. É um site estático (HTML + CSS + JavaScript puro): **sem servidor de aplicação, sem banco de dados, sem build e sem dependências externas**. Funciona em qualquer hospedagem que sirva arquivos.

## Testar no seu computador

```bash
cd opa-dashboard
python3 -m http.server 8080      # ou: npx serve .
# abra http://localhost:8080
```

> Abrir o `index.html` com duplo clique não carrega o arquivo de dados do servidor (limitação dos navegadores). Nesse caso use a aba **Atualizar dados** para enviar o relatório, ou rode o comando acima.

## O que tem

| Aba | Conteúdo |
|---|---|
| **Painel** | Total, TMA, nota média, satisfação, canal líder; dia mais/menos movimentado; volume e TMA por dia, turno e hora; canais; canal por semana; top 15 motivos; atendimentos e desempenho por atendente |
| **Avaliações** | Nota média, taxa de resposta, satisfeitos/neutros/insatisfeitos, distribuição, nota por dia, ranking de atendentes, notas por turno/semana/canal |
| **Motivos** | Ranking completo por canal, com recorte por mês, quinzena ou semana, busca e exportação em CSV |
| **Atualizar dados** | Envio de arquivo, colar do Excel, buscar de um link, baixar CSV tratado |
| **Configurações** | Mínimo de avaliações do ranking e editor do De-Para de motivos |

O seletor de **Período** (no topo) replica a aba *Período* da planilha: automático (último mês da base), um mês específico ou intervalo personalizado. Há também botão de imprimir/salvar em PDF e tema escuro automático.

## Como atualizar os dados

**1. Para todos (recomendado): trocar o arquivo no servidor.**
O painel lê `data/atendimentos.csv` a cada abertura. Para atualizar:

```bash
python3 tools/preparar_dados.py relatorio_exportado.xlsx            # substitui
python3 tools/preparar_dados.py relatorio_novo.csv --acrescentar    # junta sem duplicar (chave: Protocolo)
```

O script mantém só as colunas usadas pelo painel (**remove nome, telefone e demais dados do cliente**) e normaliza as datas. Depois é só subir o `data/atendimentos.csv` novo (FTP, Git, painel da hospedagem). CSV não exige nada além do Python 3; XLSX exige `pip install openpyxl`.
Você também pode fazer isso sem Python: envie o arquivo na aba **Atualizar dados** e clique em **Baixar CSV tratado**.

**2. Pelo navegador (só para quem enviou).** Na aba **Atualizar dados**, arraste o CSV/XLSX exportado do OPA ou cole as linhas copiadas do Excel. Aparece uma prévia (linhas, datas, canais, avisos) e você escolhe **Substituir tudo** ou **Acrescentar à base atual**. Os dados ficam salvos no navegador (IndexedDB) e o selo no topo mostra "Dados deste navegador". Útil para conferir um relatório antes de publicar.

**3. Por link.** Em `js/config.js`, `dataUrl` aceita uma URL completa de CSV/XLSX (por exemplo, uma Google Planilha publicada como CSV). A aba **Atualizar dados** também tem o campo "Buscar de um link". O site de origem precisa liberar acesso externo (CORS).

**4. Atualização automática de tela.** Para TV ou monitor de sala, defina `autoRefreshMinutes` em `js/config.js`; o painel recarrega o arquivo do servidor sozinho.

### De-Para de motivos
A aba **Configurações** mostra os motivos que ainda não têm nome padrão, com o nome sugerido e um botão para adicionar. Edições valem no navegador de quem editou; para valer para todos, use **Exportar CSV** e substitua `data/depara_motivos.csv`.

### Colunas esperadas no relatório
`Canal`, `Último atendente`, `Motivos do atendimento`, `Assumido em` (ou `Aberto em`), `Avaliação`, `Tempo em atendimento` (ex.: `1d 2h 3m 4s`) e, opcionalmente, `id`/`Protocolo`, `Status`, `Último departamento`, `Aberto em`, `Encerrado em`, `Tempo em espera`. A ordem das colunas não importa; acentos e maiúsculas também não.

## Hospedagem

Publique o conteúdo da pasta (tudo, exceto `test/` se preferir). Já estão prontos:

| Onde | O que fazer |
|---|---|
| **Qualquer hospedagem / cPanel / Apache** | Envie os arquivos por FTP. O `.htaccess` já configura cache e senha opcional |
| **Nginx / VPS** | Aponte `root` para a pasta e use `nginx.conf` como base |
| **Docker** | `docker compose up -d` (porta 8080). O CSV é montado como volume: trocou o arquivo, atualizou o painel |
| **Netlify** | Arraste a pasta em app.netlify.com/drop (usa `netlify.toml`) |
| **Vercel / Cloudflare Pages** | Importe o repositório, sem comando de build, diretório de saída `.` (Vercel usa `vercel.json`) |
| **GitHub Pages** | Suba para um repositório e ative Pages com *GitHub Actions* (`.github/workflows/pages.yml`) |

### Segurança e LGPD — leia antes de publicar
- O site é público para quem tiver o endereço. Ele traz **nomes dos atendentes e desempenho individual**. Se não deve ser aberto, proteja com senha (há exemplos comentados em `nginx.conf` e `.htaccess`) ou use Cloudflare Access, Netlify/Vercel com proteção por senha, VPN etc.
- O CSV publicado **não deve conter dados pessoais de clientes**. O script e o botão "Baixar CSV tratado" já removem essas colunas.
- Os arquivos têm `noindex`/`robots.txt` para não aparecer em buscadores, o que **não** substitui autenticação.

## Como os cálculos foram conferidos

`node test/validate.js` roda o motor de cálculo (`js/engine.js`) sobre os dados e compara com os valores que a planilha tinha calculados: total, TMA geral e por dia/turno/hora, volumes por canal e atendente, top 15 motivos, distribuição e média das notas, nota por dia e ranking. **Os 280 pontos conferem.**

## Diferenças em relação à planilha (propositais)

1. **Neutros (2,5 a 3,5)**: a planilha mostrava **0** por um erro de critério decimal (`">=2.5"`) quando o Excel está em português. Aqui são contados corretamente (**227 avaliações, 11,0%** no período de outubro); satisfeitos e insatisfeitos já batiam.
2. **% dos motivos**: a planilha dividia pelo total dos 73 motivos cadastrados no De-Para e ignorava os demais. Aqui o total inclui todos os motivos (os 16 sem De-Para aparecem com o texto original). Ex.: "Instabilidade" 42,5% aqui contra 42,7% lá; as quantidades são idênticas.
3. **Atendentes**: a planilha tinha uma lista fixa e juntava o resto em "Outros / Novos". Aqui todo atendente que aparece nos dados entra sozinho, e quem não tem nome fica em "Sem atendente". Por isso, por exemplo, Rony Cruz (que estava em "Outros") agora entra no ranking.
4. **Mínimo de avaliações do ranking**: o valor usado na planilha era 10 (o Leia-me citava 20). Está configurável, padrão 10.
5. **Extras**: período por mês ou intervalo, recorte por quinzena/semana nos motivos, prévia antes de importar, acrescentar sem duplicar, editor do De-Para, impressão em PDF.

## Estrutura

```
index.html            página única (abas por #hash)
css/style.css
js/config.js          configuração da implantação (edite aqui)
js/engine.js          regras de cálculo (período, TMA, turnos, notas, motivos)
js/parser.js          leitura de CSV/XLSX e escrita de CSV
js/charts.js          gráficos SVG
js/app.js             interface, importação, armazenamento local
data/atendimentos.csv        base atual (sem dados pessoais)
data/depara_motivos.csv      padronização de motivos
tools/preparar_dados.py      prepara o relatório exportado
test/validate.js             conferência contra a planilha
Dockerfile, nginx.conf, docker-compose.yml, .htaccess, netlify.toml, vercel.json, .github/
```
