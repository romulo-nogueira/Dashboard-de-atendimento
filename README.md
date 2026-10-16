# Dashboard de Atendimentos (versão web com banco de dados)

Versão web da planilha `Dashboard_Atendimentos_OPA_V3.xlsx`. Agora com **servidor + banco de dados**: você carrega o relatório uma vez, ele fica gravado no banco, e **qualquer pessoa que abrir o link vê exatamente os mesmos dados que você**. Nada depende do seu computador (localhost) nem do seu navegador.

```
 Navegador (você e quem recebe o link)  ──►  Servidor Node.js  ──►  Banco SQLite (arquivo no disco do servidor)
        painel (HTML/JS)                      API  /api/...             atendimentos, De-Para, configurações
```

- **Sem dependências para instalar**: usa só o Node.js 22.13+ (o SQLite já vem embutido).
- Quem **visualiza** só lê. Quem **atualiza** dados e configurações precisa da **senha de administrador**.
- Os cálculos continuam no navegador (mesmas regras da planilha, conferidas ponto a ponto).

## Testar no seu computador

```bash
cd opa-dashboard
ADMIN_PASSWORD=minha-senha npm start          # Windows (PowerShell): $env:ADMIN_PASSWORD="minha-senha"; npm start
# abra http://localhost:3000
```

Na primeira execução o banco (`storage/opa.db`) é preenchido com `data/atendimentos.csv`. Depois disso, **o banco é a fonte da verdade**: o CSV da pasta `data/` não é mais lido nem servido.

## Publicar para outras pessoas

É preciso uma hospedagem que **rode Node.js** e tenha **disco persistente** (o banco é um arquivo). Hospedagens só de arquivos estáticos (Netlify, Vercel, GitHub Pages) **não servem para este modo**, porque não executam o servidor nem guardam dados.

**Opção A: servidor próprio / VPS com Docker (recomendada)**

```bash
cp .env.example .env        # defina ADMIN_PASSWORD (e VIEW_PASSWORD, se quiser restringir a leitura)
docker compose up -d --build                       # http://IP-DO-SERVIDOR:3000
# HTTPS automático com seu domínio: edite o Caddyfile, aponte o DNS e rode:
docker compose --profile https up -d
```

O banco fica no volume `opa-data` e sobrevive a reinícios e a atualizações da imagem.

**Opção B: plataformas como Railway, Render ou Fly.io**
Crie o serviço a partir do repositório/pasta (o `Dockerfile` já está pronto), monte um **volume persistente em `/data`** e defina as variáveis `ADMIN_PASSWORD`, `VIEW_PASSWORD` (opcional) e `TRUST_PROXY=1`. Confira se o seu plano oferece volume/disco persistente: sem ele, o banco é apagado a cada novo deploy.

**Opção C: sem Docker**
Em qualquer servidor com Node 22.13+: `ADMIN_PASSWORD=... DB_PATH=/var/lib/opa/opa.db PORT=3000 npm start` (use systemd/pm2 para manter no ar e um proxy como Nginx/Caddy para HTTPS).

> **Use sempre HTTPS** ao publicar: as senhas trafegam nos cabeçalhos das requisições. Caddy (incluso), Railway, Render e Fly já fornecem isso.

### Variáveis de ambiente

| Variável | Para que serve |
|---|---|
| `ADMIN_PASSWORD` | **Obrigatória para gravar.** Senha de quem publica dados e salva configurações. Sem ela o painel só lê |
| `VIEW_PASSWORD` | Opcional. Se definida, o link inteiro pede essa senha (usuário: qualquer um) |
| `DB_PATH` | Local do arquivo do banco (padrão `storage/opa.db`; no Docker, `/data/opa.db`) |
| `PORT` | Porta (padrão 3000) |
| `TRUST_PROXY=1` | Use atrás de proxy/HTTPS (para identificar o IP real e ativar HSTS) |
| `SEED_FROM_DATA=0` | Não carregar `data/*.csv` na primeira execução (começa vazio) |
| `MAX_UPLOAD_MB` | Limite de cada envio (padrão 50) |
| `COLUNAS_SENSIVEIS` | Termos extras (separados por vírgula) que marcam uma coluna como dado do cliente, além dos padrões. Ex.: `protocolo externo,matricula` |

## Como atualizar os dados

1. **Pelo painel (mais simples).** Aba **Atualizar dados** → arraste o CSV/XLSX exportado do OPA (ou cole as linhas do Excel) → confira a prévia → escolha **Substituir tudo** ou **Acrescentar à base atual** (junta pelo Protocolo, sem duplicar) → informe a senha de administrador → **Publicar no banco**. Todos os visitantes passam a ver os dados novos: quem está com o painel aberto é atualizado sozinho em até 5 minutos (`autoRefreshMinutes` em `js/config.js`); os demais já abrem com a versão nova.
   O botão **Só visualizar aqui** mostra o arquivo sem gravar nada (para conferir antes de publicar).
2. **Pelo terminal do servidor** (ótimo para automatizar com cron):
   ```bash
   node server/importar.js relatorio.xlsx                 # substitui a base
   node server/importar.js relatorio.csv --acrescentar    # junta sem duplicar
   node server/recriar.js relatorio.xlsx                  # REFAZ o banco do zero (guarda backup do anterior)
   # no Docker: docker compose exec dashboard node server/importar.js /data/relatorio.csv --acrescentar
   ```
   **Refazer o banco por completo** (por exemplo, para preencher colunas novas em dados antigos): pare o servidor e rode `node server/recriar.js relatorio.xlsx` (no Docker: `docker compose stop dashboard`, depois `docker compose run --rm dashboard node server/recriar.js /data/relatorio.xlsx`, e `docker compose start dashboard`). O banco atual não é apagado: vira `opa.db.bak-AAAAMMDD-HHMMSS`, e o De-Para e as configurações são copiados para o banco novo. Se o servidor subir sobre um banco criado por versão anterior, ele acrescenta as colunas que faltam sozinho (sem apagar nada) e avisa no log.
3. **Bairro e condomínio dos clientes.** O relatório de atendimentos do OPA traz o *Id do Cliente*, mas **não o bairro nem o condomínio**. Há dois caminhos, e os dois podem conviver:
   - Se o relatório passar a incluir uma coluna **Bairro**, **Condomínio**, **Cidade** ou **Região** (também reconhece "Endereço - Bairro"), ela é gravada automaticamente.
   - Caso contrário, exporte do seu sistema (provedor/ERP) um **cadastro** com *Id do Cliente* + *Bairro* e/ou *Condomínio* e envie na aba **Atualizar dados > Cadastro de clientes** (ou `node server/importar-clientes.js cadastro.xlsx`, com `--substituir` para trocar tudo). O painel cruza pelo Id; nome, telefone e endereço do arquivo são descartados. A tela mostra a cobertura: % dos atendimentos com bairro e com condomínio.
   Exemplos de consulta no banco (reincidência e região):
   ```sql
   -- clientes com 2+ atendimentos
   SELECT idCliente, COUNT(*) n FROM atendimentos WHERE idCliente <> '' GROUP BY idCliente HAVING n >= 2 ORDER BY n DESC;
   -- atendimentos e clientes distintos por bairro
   SELECT c.bairro, COUNT(*) atendimentos, COUNT(DISTINCT a.idCliente) clientes
   FROM atendimentos a JOIN clientes c ON c.idCliente = a.idCliente GROUP BY c.bairro ORDER BY atendimentos DESC;
   ```
4. **Configurações compartilhadas.** Na aba **Configurações**, o mínimo de avaliações do ranking, o **teto de duração do TMA** e o **De-Para de motivos** são salvos no banco com o botão **Salvar no banco** (senha de administrador) e passam a valer para todos. Enquanto não salvar, a mudança só aparece para você.

O período exibido (mês, intervalo) é uma escolha de cada visitante e não é compartilhado.

## Segurança, LGPD e backup

- O painel mostra **nomes de atendentes e desempenho individual**. Se isso não deve ser público, defina `VIEW_PASSWORD` (ou coloque o servidor atrás de VPN/Cloudflare Access).
- **O que o banco guarda:** todas as colunas do relatório (25 conhecidas, inclusive as que o painel ainda não usa: etiquetas, aberto por, encerrado por, mensagens enviadas/recebidas, aiEvaluation, tempo de espera no último departamento, **Id do Cliente** e as de localização **Bairro, Condomínio, Cidade e Região**) **e qualquer coluna nova** que o OPA passe a exportar (ficam na coluna `extras`, em JSON).
- **O que nunca é gravado:** o que identifica a pessoa: *Contato*, *Número do contato*, *Nome do cliente*, além de qualquer coluna desconhecida cujo cabeçalho contenha termos como telefone, celular, CPF, CNPJ, e-mail, endereço, documento, nome ou cep. O descarte acontece no navegador (a prévia mostra o que foi descartado) e de novo no servidor, que também barra esses nomes dentro de `extras`.
- **Id do Cliente, bairro e condomínio ficam gravados.** São úteis para reincidência e análise por região, mas **Id + localização ainda são dados pessoais para a LGPD quando é possível chegar ao cliente por eles** (pseudonimização não elimina a obrigação). Como a base inteira é entregue ao navegador de quem abre o link, **defina `VIEW_PASSWORD`** (ou use VPN/Cloudflare Access) e limite o acesso a quem precisa.
- A regra olha o **cabeçalho**, não o conteúdo das células. Se uma coluna de uso livre (por exemplo, observações) puder trazer dados pessoais digitados pelo atendente, inclua o nome dela em `COLUNAS_SENSIVEIS` ou em `colunasSensiveis` (`js/config.js`).
- Escrita só com senha de administrador (comparação em tempo constante); após 10 tentativas erradas o IP é bloqueado por 10 minutos. Pastas `data/`, `server/` e o arquivo do banco **não são servidos** pela web.
- **Backup:** copie o arquivo do banco (`/data/opa.db`, com o servidor parado) ou, mais simples, baixe o CSV pela aba Atualizar dados (**Baixar CSV tratado**), que exporta exatamente o conteúdo do banco.
- Não suba o `.env` nem arquivos `*.db` para repositórios públicos (já estão no `.gitignore`).

## API (referência)

| Rota | Acesso | O que faz |
|---|---|---|
| `GET /api/status` | leitura | Total, período, versão, últimas cargas |
| `GET /api/dados` | leitura | Base completa (JSON compacto, gzip, com ETag) |
| `GET /api/config` | leitura | Configurações e De-Para |
| `POST /api/dados` | admin | `{ modo: "substituir"\|"acrescentar", arquivo, rows: [...] }` |
| `PUT /api/config` | admin | `{ settings: {minAval, tmaMaxH}, depara: [{key, padrao}] }` |
| `GET /healthz` | livre | Verificação de saúde |

A senha de administrador vai no cabeçalho `X-Admin-Password`.

## Modo sem banco (opcional)

Se você só quiser hospedar arquivos estáticos (Netlify, Vercel, GitHub Pages, Apache/cPanel), deixe `apiUrl: ""` em `js/config.js`: o painel volta a ler `data/atendimentos.csv`, e as atualizações pelo navegador ficam salvas só no navegador de quem enviou (sem compartilhar). Para isso há `netlify.toml`, `vercel.json`, `.htaccess` e o workflow `.github/workflows/pages.yml`; atualize o CSV com `python3 tools/preparar_dados.py relatorio.xlsx`.

## O que o painel tem

| Aba | Conteúdo |
|---|---|
| **Painel** | Total, TMA ponderado, nota média, satisfação, canal líder; TMA por canal; volume e TMA por dia, turno e hora; canais; canal por semana; top 15 motivos; atendimentos e desempenho por atendente |
| **Avaliações** | Nota média, taxa de resposta, satisfeitos/neutros/insatisfeitos, distribuição, nota por dia, ranking, notas por turno/semana/canal |
| **Motivos** | Ranking completo por canal, recorte por mês/quinzena/semana, busca e CSV |
| **Atualizar dados** | Publicar no banco, histórico de cargas, prévia, baixar CSV tratado |
| **Configurações** | Mínimo de avaliações, teto do TMA, De-Para de motivos |

Seletor de período (automático = último mês da base, mês específico ou intervalo), impressão em PDF e tema escuro automático.

## Diferenças em relação à planilha (propositais)

1. **Neutros (2,5 a 3,5)**: a planilha mostrava **0** por erro de critério decimal quando o Excel está em português. Aqui são contados corretamente (**227 avaliações, 11,0%** em outubro); satisfeitos e insatisfeitos já batiam.
2. **% dos motivos**: a planilha dividia pelo total dos 73 motivos cadastrados no De-Para e ignorava os demais. Aqui o total inclui todos (os 16 sem De-Para aparecem com o texto original). "Instabilidade": 42,5% aqui contra 42,7% lá; as quantidades são idênticas.
3. **Atendentes**: a planilha tinha uma lista fixa e juntava o resto em "Outros / Novos". Aqui todo atendente que aparece nos dados entra sozinho; quem não tem nome fica em "Sem atendente".
4. **TMA ponderado com teto de duração**: TMA de cada canal ponderado pelo volume do canal, com mediana ao lado. Atendimentos acima do teto (padrão **24 h**) ficam fora da média, pois são tickets esquecidos abertos. Outubro: 52,8 min sem teto → **41,2 min** com teto de 24 h (28 atendimentos fora; mediana 27,1 min). Com o teto em 0 o número volta ao da planilha.
5. **Mínimo de avaliações do ranking**: 10 (valor real da planilha; o Leia-me citava 20), configurável.
6. **Extras**: período por mês ou intervalo, recorte por quinzena/semana, prévia antes de importar, acrescentar sem duplicar, editor do De-Para, impressão em PDF.

## Conferência dos cálculos

`node test/validate.js` roda o motor (`js/engine.js`) sobre os dados e compara com os valores calculados pela planilha: total, TMA, volumes por dia/turno/hora/canal/atendente, top 15 motivos, notas e ranking. **Os 280 pontos conferem** (com o teto do TMA em 0).

## Estrutura

```
server/server.js       servidor HTTP: site + API + senhas
server/db.js           banco SQLite (atendimentos, configurações, histórico de cargas)
server/importar.js     carga pelo terminal (CSV/XLSX)
index.html, css/, js/  painel (js/config.js = configuração; engine/parser/charts/app)
data/                  carga inicial (só é lida se o banco estiver vazio) e modo sem banco
tools/preparar_dados.py  prepara CSV para o modo sem banco
test/validate.js       conferência contra a planilha
Dockerfile, docker-compose.yml, Caddyfile, .env.example   implantação
```
