const COMMANDS = {
  "/start": "help",
  "/ajuda": "help",
  "/help": "help",
  "/coletar": "collect",
  "/atualizar": "collect",
  "/imagens": "images",
  "/publicar": "deploy",
  "/deploy": "deploy",
  "/status": "status",
  "/site": "site",
};

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        return json({
          ok: true,
          name: "Mateus Telegram Actions Worker",
          webhook: "/telegram",
        });
      }
      const isTelegramWebhook = url.pathname === "/" || url.pathname === "/telegram";
      if (request.method !== "POST" || !isTelegramWebhook) {
        return new Response("Not found", { status: 404 });
      }

      const expectedSecret = String(env.TELEGRAM_WEBHOOK_SECRET || "");
      if (expectedSecret) {
        const receivedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
        if (receivedSecret !== expectedSecret) {
          return new Response("Unauthorized", { status: 401 });
        }
      }

      const update = await request.json();
      await handleTelegramUpdate(update, env);
      return json({ ok: true });
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: error.message }, 500);
    }
  },
};

async function handleTelegramUpdate(update, env) {
  const message = update.message || update.edited_message;
  if (!message || !message.chat) {
    return;
  }

  const chatId = String(message.chat.id);
  const allowedChatId = String(env.TELEGRAM_ALLOWED_CHAT_ID || "");
  if (allowedChatId && chatId !== allowedChatId) {
    await sendTelegramMessage(env, chatId, "Acesso nao autorizado para este bot.");
    return;
  }

  const text = String(message.text || "").trim();
  const command = normalizeCommand(text);
  const action = COMMANDS[command] || "";

  if (!action) {
    await sendTelegramMessage(env, chatId, helpText());
    return;
  }

  if (action === "help") {
    await sendTelegramMessage(env, chatId, helpText());
    return;
  }

  if (action === "site") {
    await sendTelegramMessage(env, chatId, env.CATALOG_URL || "https://maxdistac-dotcom.github.io/catalogo_mateus");
    return;
  }

  if (action === "status") {
    await sendTelegramMessage(env, chatId, await workflowStatusText(env));
    return;
  }

  const mode = modeFromText(action, text);
  await dispatchWorkflow(env, mode);
  await sendTelegramMessage(env, chatId, dispatchText(mode));
}

function normalizeCommand(text) {
  const first = text.split(/\s+/)[0] || "";
  return first.replace(/@[\w_]+$/, "").toLowerCase();
}

function modeFromText(action, text) {
  const normalized = removeAccents(text).toLowerCase();
  if (action === "deploy") return "deploy-only";
  if (action === "images") return "images";
  if (/\b(imagens|imagem|com\s+imagem|com\s+imagens|images)\b/.test(normalized)) return "images";
  if (/\b(publicar|deploy|site|funcionalidades)\b/.test(normalized)) return "deploy-only";
  return "no-images";
}

function dispatchText(mode) {
  if (mode === "images") {
    return "Coleta com imagens iniciada. Pode demorar mais, porque baixa e publica as imagens offline.";
  }
  if (mode === "deploy-only") {
    return "Publicacao iniciada em modo deploy-only. Vou reaproveitar o catalogo ja publicado e atualizar as funcionalidades.";
  }
  return "Coleta leve iniciada sem baixar imagens. Assim que terminar, o Actions publica o catalogo e envia o resumo.";
}

function helpText() {
  return [
    "Comandos do catalogo Mateus:",
    "",
    "/coletar - roda coleta leve sem imagens",
    "/coletar imagens - roda coleta completa com imagens",
    "/imagens - atalho para coleta com imagens",
    "/publicar - atualiza funcionalidades sem nova coleta",
    "/status - mostra o ultimo workflow",
    "/site - envia o link do catalogo",
  ].join("\n");
}

async function dispatchWorkflow(env, scrapeMode) {
  const owner = required(env.GITHUB_OWNER, "GITHUB_OWNER");
  const repo = required(env.GITHUB_REPO, "GITHUB_REPO");
  const workflow = env.GITHUB_WORKFLOW_FILE || "mateus-scrape.yml";
  const ref = env.GITHUB_REF || "main";
  const token = required(env.GITHUB_TOKEN, "GITHUB_TOKEN");

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({
      ref,
      inputs: {
        scrape_mode: scrapeMode,
      },
    }),
  });

  if (response.status !== 204) {
    const body = await response.text();
    throw new Error(`GitHub dispatch HTTP ${response.status}: ${body}`);
  }
}

async function workflowStatusText(env) {
  const owner = required(env.GITHUB_OWNER, "GITHUB_OWNER");
  const repo = required(env.GITHUB_REPO, "GITHUB_REPO");
  const workflow = env.GITHUB_WORKFLOW_FILE || "mateus-scrape.yml";
  const ref = env.GITHUB_REF || "main";
  const token = required(env.GITHUB_TOKEN, "GITHUB_TOKEN");

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?branch=${ref}&per_page=1`,
    {
      headers: githubHeaders(token),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub status HTTP ${response.status}: ${body}`);
  }

  const data = await response.json();
  const run = data.workflow_runs && data.workflow_runs[0];
  if (!run) {
    return "Ainda nao encontrei execucoes do workflow.";
  }

  const conclusion = run.conclusion ? ` / ${run.conclusion}` : "";
  return [
    `Ultimo workflow: ${run.status}${conclusion}`,
    `Inicio: ${formatDate(run.created_at)}`,
    `Atualizacao: ${formatDate(run.updated_at)}`,
    run.html_url,
  ].join("\n");
}

async function sendTelegramMessage(env, chatId, text) {
  const token = required(env.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram HTTP ${response.status}: ${body}`);
  }
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "mateus-telegram-actions-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function required(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`Variavel obrigatoria ausente: ${name}`);
  }
  return normalized;
}

function removeAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
