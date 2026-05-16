# Bot Telegram para disparar GitHub Actions

Este Worker recebe comandos do Telegram e dispara o workflow `mateus-scrape.yml` pelo `workflow_dispatch`.

## Comandos

- `/coletar` - roda a coleta leve sem imagens (`no-images`)
- `/coletar imagens` - roda a coleta completa com imagens (`images`)
- `/imagens` - atalho para coleta com imagens
- `/publicar` - atualiza funcionalidades sem nova coleta (`deploy-only`)
- `/status` - mostra a ultima execucao do workflow
- `/site` - envia o link do catalogo

## Variaveis no Cloudflare Worker

Crie estas variaveis/secrets no Worker:

- `TELEGRAM_BOT_TOKEN` - token do BotFather
- `TELEGRAM_ALLOWED_CHAT_ID` - seu chat id do Telegram
- `TELEGRAM_WEBHOOK_SECRET` - texto aleatorio para proteger o webhook
- `GITHUB_TOKEN` - fine-grained token do GitHub com permissao de Actions: Read and write no repositorio
- `GITHUB_OWNER` - `maxdistac-dotcom`
- `GITHUB_REPO` - `catalogo_mateus`
- `GITHUB_REF` - `main`
- `GITHUB_WORKFLOW_FILE` - `mateus-scrape.yml`
- `CATALOG_URL` - `https://maxdistac-dotcom.github.io/catalogo_mateus`

O arquivo `wrangler.toml` ja define as variaveis nao secretas. Configure como secrets no Cloudflare:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_CHAT_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- `GITHUB_TOKEN`

## Deploy pelo Cloudflare

No Cloudflare Workers, defina o diretorio raiz do projeto como:

```text
telegram-actions-worker
```

E o comando de deploy:

```text
npx wrangler deploy
```

## Configurar o webhook do Telegram

Depois de publicar o Worker, rode no PowerShell, trocando os valores:

```powershell
$TOKEN="TOKEN_DO_BOT"
$WORKER_URL="https://SEU_WORKER.workers.dev/telegram"
$SECRET="UM_TEXTO_ALEATORIO_IGUAL_AO_TELEGRAM_WEBHOOK_SECRET"
Invoke-RestMethod "https://api.telegram.org/bot$TOKEN/setWebhook" -Method Post -Body @{
  url = $WORKER_URL
  secret_token = $SECRET
}
```

Para conferir:

```powershell
Invoke-RestMethod "https://api.telegram.org/bot$TOKEN/getWebhookInfo"
```

Se voce usar a URL sem `/telegram`, o Worker tambem aceita, mas `/telegram` deixa mais claro que aquela rota e o webhook do bot.
