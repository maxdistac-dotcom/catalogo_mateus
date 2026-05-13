# Mateus Mais - Produtos Disponíveis

Projeto local ou hospedado para consultar produtos disponíveis no Força de Vendas do Mateus Mais e gerar:

- `saida\catalogo.html`: catálogo visual offline, com busca, carrinho fictício e texto de alteração de tela.
- `saida\produtos.csv`: planilha simples para abrir no Excel.
- `saida\resumo.txt`: resumo da última execução.
- `saida\YYYY-MM-DD_HH-mm\`: histórico de cada coleta.

## Primeiro uso local

1. Abra um PowerShell nesta pasta.
2. Rode:

```powershell
npm run login
```

3. No navegador que abrir, entre no Mateus Mais e deixe a página inicial carregada.
4. Volte ao PowerShell e pressione Enter; o script clica em `Força de Vendas` e tenta selecionar o cliente.
5. Se o seletor de cliente continuar aberto, selecione manualmente no Chrome e só então pressione Enter no PowerShell para salvar.
6. Teste uma coleta:

```powershell
npm run scrape
```

Para tentar selecionar um cliente automaticamente pelo código:

```powershell
npm run login -- --client=3668393
```

Importante: não feche o Chrome antes de apertar Enter no PowerShell. Se fechar sem querer, o script tenta recuperar a sessão pelo perfil local, mas o caminho mais seguro é deixar o navegador aberto até aparecer `Sessão salva`.

Também dá para passar o cliente no scrape:

```powershell
npm run scrape:no-images -- --client=3668393
```

Se a coleta ficar lenta por causa das imagens, rode uma versão mais rápida:

```powershell
npm run scrape:no-images
```

Nesse modo o catálogo continua com produtos, preços, estoque e carrinho, mas as imagens podem depender de internet ao abrir.

Para uma coleta mais rápida ainda, sem imagens e sem provar mínimos no carrinho real:

```powershell
npm run scrape:fast -- --client=3668393
```

Esse modo só deve ser usado quando velocidade for mais importante que a regra de múltiplos.

## Regra de disponibilidade

O catálogo só inclui item quando o card do Mateus Mais parece vendável:

- sem selo/camada de `Indisponível`, bloqueio ou restrição;
- com preço numérico válido;
- com estoque maior que zero quando o estoque aparece;
- com controle de carrinho ativo no card (`app-add-cart-button`).

Isso evita confundir produto que aparece na busca, mas está bloqueado, indisponível ou sem venda para o cliente selecionado.

## Carrinho fictício

O `catalogo.html` tem um carrinho que fica salvo no navegador/celular pelo `localStorage`.

Recursos:

- adicionar item obedecendo o mínimo e o passo capturados do site;
- quando o site só mostra o `min` depois do clique no `+`, o scraper clica no item, lê `min/max` e remove o item logo em seguida;
- quando ainda assim não for possível capturar `min`, o catálogo usa mínimo `1` e marca o produto como `padrão`;
- alterar preço negociado por item no carrinho;
- aplicar preço por linha de produto, por exemplo `Havaianas Brasil` com `33,50`;
- gerar automaticamente o texto de solicitação:

```text
*ALTERAÇÃO DE TELA*

RCA: 39305 - Max JDE

Cliente: *9999999* - NOME FANTASIA OU RAZÃO

Supervisor: Natan

SKU-PREÇO
```

## Agendar no Windows, exceto domingo

Depois do login funcionar, rode:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agendar_mateus.ps1
```

A tarefa criada se chama `MateusMaisProdutosDisponiveis`.

## Hospedagem grátis recomendada

Para não depender do PC ligado, o caminho mais prático é:

1. **GitHub Actions** para rodar a coleta de segunda a sábado às 07h.
2. **GitHub Pages** para publicar o `catalogo.html`.
3. **Telegram** como entrega rápida do resumo/arquivos.

Este projeto já inclui o workflow em `.github\workflows\mateus-scrape.yml`.

## PWA e uso offline no celular

O GitHub Pages publica também um PWA:

- `index.html`: abre direto no link do Pages;
- `manifest.webmanifest`: permite instalar/adicionar à tela inicial;
- `sw.js`: salva o catálogo, CSV, resumo e imagens no cache do navegador;
- `imagens\`: imagens baixadas durante a coleta para uso offline.

Como usar no celular:

1. Abra o link do Pages em um local com Wi-Fi ou internet boa.
2. Aguarde o catálogo carregar e aparecer o aviso de cache offline.
3. No Chrome/Edge mobile, use `Adicionar à tela inicial` ou `Instalar app`.
4. Depois disso, abra pelo ícone ou pela aba já carregada mesmo em local com internet ruim.

Quando o workflow gerar um catálogo novo, o PWA baixa a versão nova na próxima vez que você abrir com internet.

Observação: se você rodar `scrape:no-images` ou `scrape:fast`, o catálogo fica leve, mas as imagens não ficam garantidas offline.

### Preparar sessão para GitHub Actions

Depois de rodar `npm run login` localmente, gere o valor base64 do arquivo de sessão:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("dados\storage-state.json"))
```

O script também salva o mesmo conteúdo pronto em `dados\storage-state.base64.txt`.

No GitHub, salve esse valor em:

- `Settings > Secrets and variables > Actions > New repository secret`
- nome: `MATEUS_STORAGE_STATE_BASE64`

Opcionalmente salve também:

- `MATEUS_CLIENT_CODE`, por exemplo `3668393`, para o robô tentar selecionar o cliente antes da coleta;
- `MATEUS_TELEGRAM_BOT_TOKEN`
- `MATEUS_TELEGRAM_CHAT_ID`

Se a sessão expirar, rode `npm run login` novamente e atualize o secret `MATEUS_STORAGE_STATE_BASE64`.

## Telegram opcional local

Se quiser receber o resumo e os arquivos no Telegram, crie um bot no BotFather e defina estas variáveis de ambiente do Windows:

```powershell
[Environment]::SetEnvironmentVariable("MATEUS_TELEGRAM_BOT_TOKEN", "SEU_TOKEN", "User")
[Environment]::SetEnvironmentVariable("MATEUS_TELEGRAM_CHAT_ID", "SEU_CHAT_ID", "User")
```

Depois feche e abra o PowerShell. Sem essas variáveis, a coleta continua gerando os arquivos locais normalmente.

## Produtos monitorados

- Todas as Havaianas disponíveis.
- Sabão em Barra Ypê 800g disponível.
- Sabão em Pó Tixan Ypê Sachê 400g disponível.
- Detergente Ypê 500ml disponível.

Os filtros ficam em `config\mateus.config.json`.
