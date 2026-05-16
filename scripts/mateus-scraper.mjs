import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(PROJECT_ROOT, "config", "mateus.config.json");
const BUNDLED_NODE_MODULES =
  "C:/Users/Max/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";

async function main() {
  const command = process.argv[2] || "scrape";
  const config = await readJson(CONFIG_PATH);
  const cliArgs = parseCliArgs(process.argv.slice(3));
  if (cliArgs["no-images"] || process.env.MATEUS_DOWNLOAD_IMAGES === "false") {
    config.downloadImages = false;
  }
  if (cliArgs["no-probe"] || process.env.MATEUS_QUANTITY_PROBE === "false") {
    config.quantityProbe = { ...(config.quantityProbe || {}), enabled: false };
  }

  if (command === "login") {
    await login(config, cliArgs);
    return;
  }

  if (command === "parse-samples") {
    const result = await collectFromSampleHtml(config);
    await writeOutputs(config, result.products, result.meta);
    return;
  }

  if (command === "deploy-only") {
    config.downloadImages = false;
    const result = await collectFromPublishedCatalog(config);
    await writeOutputs(config, result.products, result.meta);
    return;
  }

  if (command === "scrape") {
    const clientCode = cliArgs.client || cliArgs.cliente;
    if (clientCode) {
      config.login = { ...(config.login || {}), clientCode };
    }
    const result = await scrapeSite(config);
    await writeOutputs(config, result.products, result.meta);
    return;
  }

  throw new Error(`Comando desconhecido: ${command}`);
}

function parseCliArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const next = args[index + 1];
    if (inlineValue !== undefined) {
      parsed[rawKey] = inlineValue;
    } else if (next && !next.startsWith("--")) {
      parsed[rawKey] = next;
      index += 1;
    } else {
      parsed[rawKey] = true;
    }
  }
  return parsed;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function loadPlaywright() {
  const attempts = [
    () => createRequire(import.meta.url)("playwright"),
    () => createRequire(path.join(BUNDLED_NODE_MODULES, "__playwright.js"))("playwright"),
  ];

  if (process.env.NODE_PATH) {
    for (const moduleDir of process.env.NODE_PATH.split(path.delimiter).filter(Boolean)) {
      attempts.push(() => createRequire(path.join(moduleDir, "__playwright.js"))("playwright"));
    }
  }

  for (const attempt of attempts) {
    try {
      return attempt();
    } catch {
      // Try the next known module location.
    }
  }

  throw new Error(
    "Playwright não foi encontrado. Use o Node do Codex ou instale Playwright nesta pasta.",
  );
}

async function launchPersistentContext(chromium, userDataDir, options) {
  const launchOptions = [
    options,
    { ...options, channel: "chrome" },
    { ...options, channel: "msedge" },
  ];

  let lastError;
  for (const launchOption of launchOptions) {
    try {
      return await chromium.launchPersistentContext(userDataDir, launchOption);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function login(config, cliArgs = {}) {
  const { chromium } = await loadPlaywright();
  const userDataDir = absoluteFromProject(config.userDataDir);
  await fs.mkdir(userDataDir, { recursive: true });
  const clientCode =
    cliArgs.client ||
    cliArgs.cliente ||
    process.env.MATEUS_CLIENT_CODE ||
    config.login?.clientCode ||
    "";

  const context = await launchPersistentContext(chromium, userDataDir, {
    headless: false,
    viewport: { width: 1366, height: 768 },
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(`${trimSlash(config.baseUrl)}/#/`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  console.log("");
  console.log("Navegador aberto.");
  console.log("1. Faça login no Mateus Mais.");
  console.log("2. Deixe a página inicial carregada. O script vai clicar em Força de Vendas depois do seu Enter.");
  console.log("3. Não feche o Chrome.");
  if (!clientCode) {
    console.log("Dica: para tentar selecionar automaticamente, use: npm run login -- --client=3668393");
  }
  console.log("");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Depois do login carregar, pressione Enter para entrar no Força de Vendas...");

  await enterSalesForce(page, config);

  if (clientCode) {
    await trySelectClient(page, clientCode);
  }

  const clientModalOpen = await isClientModalOpen(page);
  if (clientModalOpen) {
    let attempts = 0;
    while ((await isClientModalOpen(page)) && attempts < 3) {
      console.log("");
      console.log("O seletor de cliente ainda está aberto.");
      console.log("Selecione o cliente manualmente clicando na seta azul à direita da linha do cliente e volte aqui.");
      await rl.question("Depois que o modal fechar e o cliente aparecer no Força de Vendas, pressione Enter...");
      attempts += 1;
    }
    if (await isClientModalOpen(page)) {
      rl.close();
      throw new Error(
        "O modal de cliente continuou aberto; a sessão não foi salva porque o scrape não conseguiria consultar preços/estoque por cliente.",
      );
    }
  } else {
    await rl.question("Confira se o cliente/CD está correto e pressione Enter para salvar a sessão...");
  }
  rl.close();

  try {
    await saveStorageState(context);
    await context.close();
  } catch (error) {
    if (/Target page, context or browser has been closed|browser has been closed/i.test(error.message)) {
      console.log("O Chrome foi fechado antes de salvar. Tentando recuperar a sessão pelo perfil local...");
      await recoverStorageState(chromium, userDataDir);
    } else {
      throw error;
    }
  }
  console.log("Sessão salva em dados/chrome-profile e dados/storage-state.json.");
}

async function enterSalesForce(page, config) {
  console.log("Abrindo área de vendas...");
  await page.goto(`${trimSlash(config.baseUrl)}/#/`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.waitForTimeout(1500);

  const salesButton = page.getByText("Força de vendas", { exact: false }).last();
  if (await salesButton.isVisible({ timeout: 8000 }).catch(() => false)) {
    await salesButton.click({ timeout: 10000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1800);
    return;
  }

  if (!/#\/forca-de-vendas/i.test(page.url())) {
    await page.goto(`${trimSlash(config.baseUrl)}/#/forca-de-vendas`, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    await page.waitForTimeout(1800);
  }
}

async function trySelectClient(page, clientCode) {
  console.log(`Tentando selecionar cliente ${clientCode} automaticamente...`);
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await openClientSelectionModal(page);

    const input = page.getByPlaceholder("Encontre um cliente");
    let clients = [];
    if (await input.isVisible({ timeout: 5000 }).catch(() => false)) {
      await clearClientSearch(page, input);
      clients = await collectClientOptions(page, { maxScrolls: 90, resetScroll: true });
      if (clients.length <= 1) {
        clients = mergeClientLists(clients, await collectClientsBySearchHints(page, input));
        await clearClientSearch(page, input);
      }
      if (clients.length) {
        console.log(`Clientes capturados no seletor: ${clients.length}`);
      }
      await input.fill(String(clientCode));
      await page.keyboard.press("Enter").catch(() => {});
      await clickClientSearchIcon(page).catch(() => {});
      await page.waitForTimeout(1200);
      clients = mergeClientLists(clients, await collectClientOptions(page, { maxScrolls: 6, resetScroll: true }));
    }

    const point = await getClientSelectPoint(page, clientCode);
    if (!point) {
      console.log(`Não encontrei o cliente ${clientCode} na lista visível.`);
      return { clients };
    }

    const selectedClient = parseClientText(point.text) || clients.find((client) => client.code === String(clientCode));
    clients = mergeClientLists(clients, selectedClient ? [{ ...selectedClient, selected: true }] : []);
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(800);
    await clickContinueClientSelection(page);
    const selected = selectedClient ? { ...selectedClient, selected: true } : null;
    const selectedClients = mergeClientLists(clients, selected ? [selected] : []);
    console.log((await isClientModalOpen(page)) ? "Modal de cliente ainda aberto." : "Cliente selecionado.");
    return {
      clients: selectedClients.map((client) => ({
        ...client,
        selected: client.code === String(clientCode),
      })),
      selectedClient: selected,
    };
  } catch (error) {
    console.log(`Seleção automática não concluiu: ${error.message}`);
  }
}

async function openClientSelectionModal(page) {
  if (await isClientModalOpen(page)) {
    return true;
  }

  const point = await page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    };
    const candidates = Array.from(document.querySelectorAll("button, a, span, div"))
      .filter((element) => visible(element) && /^trocar$/i.test((element.textContent || "").trim()))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const parentText = (element.closest("section, article, div")?.textContent || "").replace(/\s+/g, " ").trim();
        let score = 0;
        if (/cliente|cpf|cnpj|raz[aã]o|fantasia|contribuinte/i.test(parentText)) score += 8;
        if (/loja atual|mix mateus|rua miguel/i.test(parentText)) score -= 8;
        score += Math.min(4, rect.top / 100);
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, score };
      })
      .sort((a, b) => b.score - a.score)[0];
    return candidates || null;
  });

  if (point) {
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(1200);
  }
  return isClientModalOpen(page);
}

async function clearClientSearch(page, input) {
  await input.click({ timeout: 3000 }).catch(() => {});
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await input.fill("").catch(() => {});
  await input
    .evaluate((element) => {
      element.value = "";
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    })
    .catch(() => {});
  await clickClientSearchIcon(page).catch(() => {});
  await page.keyboard.press("Enter").catch(() => {});
  await page.waitForTimeout(1400);
}

async function collectClientsBySearchHints(page, input) {
  const hints = [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "a",
    "e",
    "i",
    "o",
    "u",
    "r",
    "s",
    "m",
    "c",
    "l",
    "p",
    "t",
  ];
  let clients = [];

  for (const hint of hints) {
    await input.fill(hint).catch(() => {});
    await clickClientSearchIcon(page).catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(900);
    clients = mergeClientLists(clients, await collectClientOptions(page, { maxScrolls: 35, resetScroll: true }));
  }

  return clients;
}

async function collectClientOptions(page, options = {}) {
  const maxScrolls = options.maxScrolls ?? 20;
  const byCode = new Map();
  let lastTop = -1;

  if (options.resetScroll !== false) {
    await resetClientListScroll(page);
  }

  for (let attempt = 0; attempt <= maxScrolls; attempt += 1) {
    const result = await page.evaluate(() => {
      const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
      const visible = (element) => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const parseClient = (element) => {
        const lines = (element.innerText || element.textContent || "")
          .split(/\n+/)
          .map(clean)
          .filter(Boolean);
        const headerIndex = lines.findIndex((line) => /^\d{4,}\s*-\s*/.test(line));
        if (headerIndex < 0) return null;
        const relevantLines = lines.slice(headerIndex);
        const header = relevantLines[0];
        const match = header.match(/^(\d{4,})\s*-\s*(.+)$/);
        if (!match) return null;
        const rect = element.getBoundingClientRect();
        if (rect.width < 240 || rect.height < 24 || rect.height > 210) return null;
        return {
          code: match[1],
          name: match[2],
          document:
            relevantLines
              .slice(1)
              .find((line) => /\d/.test(line) && !/^(av|avenida|rua|r\.?)\b/i.test(line) && !/contribuinte/i.test(line)) || "",
          address:
            relevantLines.find((line) => /^(av|avenida|rua|r\.?)\b|,\s*[a-z]/i.test(line) && !/^\d{4,}\s*-/.test(line)) ||
            "",
          taxStatus: relevantLines.find((line) => /contribuinte/i.test(line)) || "",
          text: relevantLines.join(" | "),
          height: rect.height,
          top: rect.top,
        };
      };
      const candidates = Array.from(document.querySelectorAll("body *"))
        .filter(visible)
        .map((element) => ({ element, client: parseClient(element) }))
        .filter((item) => item.client)
        .sort((a, b) => a.client.height - b.client.height);
      const clientsByCode = new Map();
      for (const item of candidates) {
        if (!clientsByCode.has(item.client.code)) {
          clientsByCode.set(item.client.code, item.client);
        }
      }

      const findScrollParent = (element) => {
        let current = element?.parentElement || null;
        while (current && current !== document.body) {
          const style = window.getComputedStyle(current);
          const canScroll =
            current.scrollHeight > current.clientHeight + 16 &&
            !/hidden/i.test(`${style.overflowY} ${style.overflow}`);
          if (canScroll) return current;
          current = current.parentElement;
        }
        return null;
      };
      const firstRow = candidates[0]?.element || null;
      const rowScroller = findScrollParent(firstRow);
      const fallbackScroller = Array.from(document.querySelectorAll("body *"))
        .filter((element) => visible(element) && element.scrollHeight > element.clientHeight + 20)
        .map((element) => ({
          element,
          score: ((element.innerText || "").match(/\d{4,}\s*-/g) || []).length,
          overflow: element.scrollHeight - element.clientHeight,
          area: element.clientWidth * element.clientHeight,
        }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || b.overflow - a.overflow || b.area - a.area)[0]?.element;

      const scroller = rowScroller || fallbackScroller || null;
      const before = scroller ? scroller.scrollTop : 0;
      const maxTop = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
      const rect = scroller?.getBoundingClientRect();
      if (scroller && before < maxTop) {
        scroller.scrollTop = Math.min(maxTop, before + Math.max(120, Math.floor(scroller.clientHeight * 0.85)));
      }
      return {
        clients: [...clientsByCode.values()],
        before,
        top: scroller ? scroller.scrollTop : 0,
        maxTop,
        wheelPoint: rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null,
      };
    });

    for (const client of result.clients || []) {
      const current = byCode.get(client.code);
      if (!current || (client.text || "").length > (current.text || "").length) {
        byCode.set(client.code, client);
      }
    }

    const canScroll = result.maxTop && result.top < result.maxTop;
    if (!canScroll) {
      break;
    }
    if (result.top === result.before && result.wheelPoint) {
      await page.mouse.move(result.wheelPoint.x, result.wheelPoint.y).catch(() => {});
      await page.mouse.wheel(0, 650).catch(() => {});
    } else if (result.top === lastTop) {
      break;
    }
    lastTop = result.top;
    await page.waitForTimeout(150);
  }

  return normalizeClients([...byCode.values()]);
}

async function resetClientListScroll(page) {
  await page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    };
    const scroller = Array.from(document.querySelectorAll("body *"))
      .filter((element) => visible(element) && element.scrollHeight > element.clientHeight + 20)
      .map((element) => ({
        element,
        score: ((element.innerText || "").match(/\d{4,}\s*-/g) || []).length,
        overflow: element.scrollHeight - element.clientHeight,
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.overflow - a.overflow)[0]?.element;
    if (scroller) {
      scroller.scrollTop = 0;
    }
  });
  await page.waitForTimeout(250);
}

function mergeClientLists(...lists) {
  const byCode = new Map();
  for (const client of lists.flat().filter(Boolean)) {
    if (!client.code) continue;
    const current = byCode.get(client.code) || {};
    byCode.set(client.code, {
      ...current,
      ...client,
      selected: Boolean(current.selected || client.selected),
    });
  }
  return normalizeClients([...byCode.values()]);
}

function parseClientText(value = "") {
  const cleanText = clean(value);
  const match = cleanText.match(/(\d{4,})\s*-\s*(.+?)(?=\s{2,}|\s+\d{2}\s|\s+Av\b|\s+Rua\b|\s+R\b|\s+Contribuinte|\s+Não contribuinte|$)/i);
  if (!match) {
    return null;
  }
  return {
    code: match[1],
    name: clean(match[2]),
    text: cleanText,
  };
}

async function clickContinueClientSelection(page) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const point = await getContinueButtonPoint(page);
    if (point?.enabled) {
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(2200);
      return true;
    }
    await page.waitForTimeout(500);
  }
  const button = page.getByText("Continuar", { exact: true });
  if (await button.isVisible({ timeout: 1000 }).catch(() => false)) {
    await button.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(2200);
    return !(await isClientModalOpen(page));
  }
  return false;
}

async function getContinueButtonPoint(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    };
    const buttons = Array.from(document.querySelectorAll("button"))
      .filter((button) => visible(button) && /continuar/i.test(button.textContent || ""))
      .map((button) => {
        const rect = button.getBoundingClientRect();
        const style = window.getComputedStyle(button);
        const enabled =
          !button.disabled &&
          button.getAttribute("aria-disabled") !== "true" &&
          style.pointerEvents !== "none" &&
          style.opacity !== "0" &&
          !/disabled/i.test(button.className || "");
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          enabled,
          width: rect.width,
        };
      })
      .sort((a, b) => b.width - a.width);
    return buttons[0] || null;
  });
}

async function clickClientSearchIcon(page) {
  const point = await page.evaluate(() => {
    const input = Array.from(document.querySelectorAll("input")).find((element) =>
      /cliente/i.test(element.getAttribute("placeholder") || ""),
    );
    if (!input) return null;
    const inputRect = input.getBoundingClientRect();
    return {
      x: inputRect.right + 18,
      y: inputRect.top + inputRect.height / 2,
    };
  });
  if (point) {
    await page.mouse.click(point.x, point.y);
  }
}

async function getClientSelectPoint(page, clientCode) {
  return page.evaluate((code) => {
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const scoreRow = (element) => {
      const rect = element.getBoundingClientRect();
      const text = (element.textContent || "").replace(/\s+/g, " ").trim();
      if (!text.includes(code)) return -1;
      if (rect.width < 360 || rect.height < 45 || rect.height > 180) return -1;
      let score = 0;
      if (/contribuinte|não contribuinte|nao contribuinte/i.test(text)) score += 4;
      if (/av |rua|ce\b|me\b/i.test(text)) score += 2;
      if (element.querySelector("svg, i, img, button, [role='button']")) score += 2;
      score -= Math.abs(rect.width - 720) / 1000;
      score -= Math.abs(rect.height - 106) / 1000;
      return score;
    };

    const matches = Array.from(document.querySelectorAll("body *"))
      .filter(visible)
      .map((element) => ({ element, score: scoreRow(element) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score);

    const best = matches[0]?.element;
    if (!best) return null;
    const rect = best.getBoundingClientRect();
    return {
      x: Math.max(rect.left + 20, rect.right - 24),
      y: rect.top + rect.height / 2,
      text: (best.textContent || "").replace(/\s+/g, " ").trim().slice(0, 220),
    };
  }, String(clientCode));
}

async function isClientModalOpen(page) {
  return page
    .getByText("Busque por um cliente", { exact: false })
    .isVisible({ timeout: 3000 })
    .catch(() => false);
}

async function saveStorageState(context) {
  const dadosDir = absoluteFromProject("dados");
  const storagePath = path.join(dadosDir, "storage-state.json");
  const base64Path = path.join(dadosDir, "storage-state.base64.txt");
  await fs.mkdir(dadosDir, { recursive: true });
  await context.storageState({ path: storagePath });
  const base64 = Buffer.from(await fs.readFile(storagePath)).toString("base64");
  await fs.writeFile(base64Path, base64, "utf8");
}

async function recoverStorageState(chromium, userDataDir) {
  const context = await launchPersistentContext(chromium, userDataDir, {
    headless: true,
    viewport: { width: 1366, height: 768 },
  });
  try {
    await saveStorageState(context);
  } finally {
    await context.close();
  }
}

async function scrapeSite(config) {
  const { chromium } = await loadPlaywright();
  const userDataDir = absoluteFromProject(config.userDataDir);
  await fs.mkdir(userDataDir, { recursive: true });

  const headless = process.argv.includes("--headed")
    ? false
    : process.env.MATEUS_HEADLESS
      ? process.env.MATEUS_HEADLESS !== "false"
      : config.headless !== false;

  const session = await openScrapeSession(chromium, userDataDir, {
    headless,
    viewport: { width: 1366, height: 768 },
  });
  const context = session.context;

  const page = context.pages()[0] || (await context.newPage());
  const collected = [];
  const seenPages = [];
  const clientCode = process.env.MATEUS_CLIENT_CODE || config.login?.clientCode || "";
  let salesContext = { clients: [] };

  try {
    salesContext = await ensureSalesContext(page, config, clientCode);

    for (const productGroup of config.products) {
      const url = buildProductsUrl(config, productGroup);
      console.log(`Buscando: ${productGroup.title}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForTimeout(config.waitAfterNavigationMs || 2000);
      const expandStats = await expandAllProducts(page, config.maxVerMaisClicks || 25);

      const pageProducts = await extractProductsFromPage(page);
      if (!pageProducts.length) {
        await throwIfLooksLoggedOut(page, productGroup.title);
      }

      const normalizedPageProducts = pageProducts.map(normalizeProduct);
      const quantityRules = await probeQuantityRules(
        page,
        normalizedPageProducts.filter(
          (product) =>
            matchesFilter(product, productGroup.filter || {}) &&
            (config.availableOnly === false || product.available),
        ),
        config,
      );
      applyQuantityRules(normalizedPageProducts, quantityRules);
      const filteredCount = normalizedPageProducts.filter(
        (product) =>
          matchesFilter(product, productGroup.filter || {}) &&
          (config.availableOnly === false || product.available),
      ).length;
      console.log(
        `  Cards lidos: ${pageProducts.length} | "Ver mais": ${expandStats.clicks} clique(s) | Dentro do filtro: ${filteredCount}`,
      );

      for (const product of normalizedPageProducts) {
        collected.push({
          ...product,
          source: productGroup.title,
          sourceUrl: url,
        });
      }
      seenPages.push({ title: productGroup.title, url, count: pageProducts.length });
    }
  } finally {
    await session.close();
  }

  return {
    products: applyConfiguredFilters(config, collected),
    meta: {
      mode: "scrape",
      pages: seenPages,
      clients: salesContext.clients || [],
      selectedClient: salesContext.selectedClient || null,
    },
  };
}

async function ensureSalesContext(page, config, clientCode) {
  console.log("Conferindo contexto do Força de Vendas...");
  await enterSalesForce(page, config);
  let selection = { clients: [] };
  if (clientCode) {
    selection = (await trySelectClient(page, clientCode)) || selection;
  }

  const clientModalOpen = await isClientModalOpen(page);
  if (clientModalOpen) {
    throw new Error(
      "O Força de Vendas está pedindo seleção de cliente. Rode `npm run login -- --client=CODIGO` ou selecione manualmente no login e salve a sessão antes de raspar.",
    );
  }

  return selection;
}

async function openScrapeSession(chromium, userDataDir, launchOptions) {
  const encodedStorageState = process.env.MATEUS_STORAGE_STATE_BASE64;
  if (encodedStorageState) {
    const storagePath = path.join(absoluteFromProject("dados"), "storage-state.github.json");
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, Buffer.from(encodedStorageState, "base64"));

    const browser = await chromium.launch({ headless: launchOptions.headless });
    const context = await browser.newContext({
      viewport: launchOptions.viewport,
      storageState: storagePath,
    });
    return {
      context,
      close: async () => {
        await context.close();
        await browser.close();
      },
    };
  }

  const context = await launchPersistentContext(chromium, userDataDir, launchOptions);
  return {
    context,
    close: async () => context.close(),
  };
}

function buildProductsUrl(config, productGroup) {
  const params = new URLSearchParams({ market: config.marketId });
  if (productGroup.search) {
    params.set("search", productGroup.search);
  }
  for (const [key, value] of Object.entries(productGroup.urlParams || {})) {
    params.set(key, value);
  }
  return `${trimSlash(config.baseUrl)}/#/produtos?${params.toString()}`;
}

async function expandAllProducts(page, maxClicks) {
  let stableClicks = 0;
  let clicks = 0;

  for (let index = 0; index < maxClicks; index += 1) {
    const before = await page.locator("app-product-card").count().catch(() => 0);
    const button = page.locator('button:has-text("Ver mais")').last();

    if (!(await button.isVisible().catch(() => false))) {
      break;
    }

    await button.scrollIntoViewIfNeeded().catch(() => {});
    await button.click({ timeout: 10000 }).catch(async () => {
      await page.getByText("Ver mais", { exact: true }).last().click({ timeout: 10000 });
    });
    clicks += 1;
    await page
      .waitForFunction(
        (cardCount) => {
          const cards = document.querySelectorAll("app-product-card").length;
          const hasMoreButton = Array.from(document.querySelectorAll("button")).some((button) =>
            /ver mais/i.test(button.textContent || ""),
          );
          return cards > cardCount || !hasMoreButton;
        },
        before,
        { timeout: 5000 },
      )
      .catch(() => {});
    await page.waitForTimeout(700);

    const after = await page.locator("app-product-card").count().catch(() => 0);
    if (after <= before) {
      stableClicks += 1;
    } else {
      stableClicks = 0;
    }
    if (stableClicks >= 2) {
      break;
    }
  }

  return {
    clicks,
    cards: await page.locator("app-product-card").count().catch(() => 0),
  };
}

async function throwIfLooksLoggedOut(page, title) {
  const body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const loggedOut = /(entrar|login|senha|cpf|e-mail|email)/i.test(body);
  if (loggedOut) {
    throw new Error(
      `Não encontrei produtos ao buscar "${title}" e a página parece estar deslogada. Rode: npm run login`,
    );
  }
}

async function probeQuantityRules(page, products, config) {
  if (config.quantityProbe?.enabled === false) {
    return new Map();
  }

  const candidates = products
    .filter((product) => product.sku && product.minQtySource !== "site")
    .slice(0, config.quantityProbe?.maxItemsPerPage || 700);

  if (!candidates.length) {
    return new Map();
  }

  console.log(`  Capturando mínimos de carrinho no Mateus (${candidates.length} item(ns))...`);
  const rules = new Map();
  let processed = 0;

  for (const product of candidates) {
    const rule = await probeSingleQuantityRule(page, product.sku, config).catch((error) => ({
      sku: product.sku,
      error: error.message,
    }));

    if (rule?.sku && (rule.minQty || rule.maxQty)) {
      rules.set(rule.sku, rule);
    }

    processed += 1;
    if (processed % 25 === 0 || processed === candidates.length) {
      console.log(`    Mínimos processados: ${processed}/${candidates.length}`);
    }
  }

  return rules;
}

async function probeSingleQuantityRule(page, sku, config) {
  await scrollProductCardIntoView(page, sku);
  const start = await getQuantityProbeState(page, sku);
  if (!start) {
    return { sku, error: "card não encontrado" };
  }

  if (start.minQty) {
    return {
      sku,
      minQty: parseInteger(start.minQty),
      maxQty: parseInteger(start.maxQty),
      source: "site",
      wasAlreadyInCart: true,
    };
  }

  if (!start.addPoint) {
    return {
      sku,
      minQty: parseInteger(start.minQty),
      maxQty: parseInteger(start.maxQty),
      source: start.maxQty ? "site" : "",
      error: "botão de adicionar não encontrado",
    };
  }

  await page.mouse.click(start.addPoint.x, start.addPoint.y);
  let afterAdd = null;
  try {
    await page.waitForTimeout(config.quantityProbe?.delayMs || 350);
    afterAdd = await waitForQuantityInput(page, sku, 3500);
    return {
      sku,
      minQty: parseInteger(afterAdd?.minQty),
      maxQty: parseInteger(afterAdd?.maxQty),
      source: "site",
      wasAlreadyInCart: false,
    };
  } finally {
    const trashPoint = afterAdd?.trashPoint || (await getQuantityProbeState(page, sku))?.trashPoint;
    if (trashPoint) {
      await page.mouse.click(trashPoint.x, trashPoint.y);
      await page.waitForTimeout(180);
    }
  }
}

async function waitForQuantityInput(page, sku, timeoutMs) {
  const started = Date.now();
  let state = await getQuantityProbeState(page, sku);
  while (Date.now() - started < timeoutMs) {
    if (state?.minQty) {
      return state;
    }
    if ((state?.maxQty || state?.trashPoint) && Date.now() - started > 700) {
      return state;
    }
    await page.waitForTimeout(150);
    state = await getQuantityProbeState(page, sku);
  }
  return state;
}

async function scrollProductCardIntoView(page, sku) {
  const found = await page.evaluate((targetSku) => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    const card = Array.from(document.querySelectorAll("app-product-card")).find((candidate) =>
      clean(candidate.textContent).includes(`SKU: ${targetSku}`),
    );
    if (!card) {
      return false;
    }
    card.scrollIntoView({ block: "center", inline: "nearest" });
    return true;
  }, String(sku));
  if (found) {
    await page.waitForTimeout(120);
  }
  return found;
}

async function getQuantityProbeState(page, sku) {
  return page.evaluate((targetSku) => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const center = (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    const card = Array.from(document.querySelectorAll("app-product-card")).find((candidate) =>
      clean(candidate.textContent).includes(`SKU: ${targetSku}`),
    );
    if (!card) {
      return null;
    }
    const input = card.querySelector('app-add-cart-button input[type="number"]');
    const trash = Array.from(card.querySelectorAll("app-add-cart-button img")).find((img) =>
      /trash/i.test(img.getAttribute("src") || ""),
    );
    const addElement =
      Array.from(card.querySelectorAll("app-add-cart-button button, app-add-cart-button img")).find((element) =>
        /add-icon/i.test(element.getAttribute("src") || ""),
      ) || card.querySelector("app-add-cart-button button");
    const counterText = clean(card.querySelector("app-add-cart-button")?.textContent || "");
    const currentQty = input?.value || input?.getAttribute("value") || (counterText.match(/\b\d+\b/) || [""])[0];
    const minQty = input?.getAttribute("min") || input?.getAttribute("step") || currentQty || "";

    return {
      sku: targetSku,
      minQty,
      maxQty: input?.getAttribute("max") || "",
      addPoint: visible(addElement) ? center(addElement) : null,
      trashPoint: visible(trash) ? center(trash) : null,
    };
  }, String(sku));
}

function applyQuantityRules(products, rules) {
  for (const product of products) {
    const rule = rules.get(product.sku);
    if (!rule) {
      continue;
    }
    if (rule.minQty) {
      product.minQty = rule.minQty;
      product.minQtySource = "site";
    }
    if (rule.maxQty) {
      product.maxQty = rule.maxQty;
    }
  }
}

async function extractProductsFromPage(page) {
  return page.evaluate(() => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    const text = (root, selector) => clean(root.querySelector(selector)?.textContent || "");
    const attr = (root, selector, name) => root.querySelector(selector)?.getAttribute(name) || "";

    return Array.from(document.querySelectorAll("app-product-card"))
      .map((card) => {
        const bodyText = clean(card.textContent || "");
        const footerText = text(card, "app-product-card-footer");
        const measureText = text(card, ".measure-container");
        const skuMatch = measureText.match(/SKU:\s*([A-Z0-9.-]+)/i);
        const stockMatch = footerText.match(/Estoque:\s*([\d.,]+)/i);
        const boxMatch = footerText.match(/Cx:\s*([\d.,]+)/i);
        const priceText = text(card, ".price-container .gm-price-small").replace(/\bunid\.?$/i, "").trim();
        const qtyInput = card.querySelector('app-add-cart-button input[type="number"]');
        const addCartButton = card.querySelector("app-add-cart-button button, app-add-cart-button input");
        const addCartRoot = card.querySelector("app-add-cart-button");
        const sealText = text(card, ".seal");
        const hasDisabledLayer = Boolean(card.querySelector(".layer-disable"));
        const addCartDisabled = Boolean(
          addCartButton?.disabled ||
            addCartButton?.getAttribute("aria-disabled") === "true" ||
            addCartRoot?.classList.contains("disabled"),
        );
        const canAddToCart = Boolean(addCartButton || addCartRoot) && !addCartDisabled && !hasDisabledLayer;
        const blockedText = /Indisponível|Indisponivel|Bloquead|Restrit|Não disponível|Nao disponivel|Produto não encontrado|Produto nao encontrado/i.test(
          `${bodyText} ${sealText}`,
        );

        return {
          brand: text(card, "app-product-card-body > span.gm-caption-small, .gm-caption-small"),
          name: text(card, ".container-name .gm-body-small-bold") || attr(card, "img.product-image", "alt"),
          measure: text(card, ".measure.active"),
          sku: skuMatch ? clean(skuMatch[1]) : "",
          priceText,
          cx: boxMatch ? clean(boxMatch[1]) : "",
          stock: stockMatch ? clean(stockMatch[1]) : "",
          minQty: qtyInput?.getAttribute("min") || "",
          maxQty: qtyInput?.getAttribute("max") || "",
          canAddToCart,
          hasDisabledLayer,
          sealText,
          unavailable: blockedText || hasDisabledLayer || /R\$\s*--,--/i.test(bodyText) || !canAddToCart,
          image: card.querySelector("img.product-image")?.src || "",
        };
      })
      .filter((product) => product.name || product.sku);
  });
}

async function collectFromSampleHtml(config) {
  const products = [];
  const pages = [];

  for (const filePath of config.sampleHtmlFiles || []) {
    if (!fsSync.existsSync(filePath)) {
      continue;
    }
    const html = await fs.readFile(filePath, "utf8");
    const parsed = extractProductsFromHtml(html, filePath).map((product) => ({
      ...product,
      source: path.basename(filePath),
      sourceFile: filePath,
    }));
    products.push(...parsed);
    pages.push({ title: path.basename(filePath), count: parsed.length });
  }

  return {
    products: applyConfiguredFilters(config, products.map(normalizeProduct)),
    meta: {
      mode: "parse-samples",
      pages,
    },
  };
}

async function collectFromPublishedCatalog(config) {
  const catalogUrl = String(
    process.env.MATEUS_PUBLISHED_CATALOG_URL || config.publishedCatalogUrl || "https://maxdistac-dotcom.github.io/catalogo_mateus",
  ).replace(/\/+$/, "");
  const produtosUrl = `${catalogUrl}/produtos.json?ts=${Date.now()}`;
  let payload = null;

  try {
    console.log(`Baixando catálogo publicado: ${produtosUrl}`);
    const response = await fetch(produtosUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    payload = await response.json();
  } catch (error) {
    const fallback = path.join(absoluteFromProject(config.outputDir), "produtos.json");
    console.log(`Aviso: não consegui baixar o catálogo publicado (${error.message}). Tentando ${fallback}.`);
    payload = await readJson(fallback);
  }

  const products = Array.isArray(payload.products) ? payload.products : [];
  if (!products.length) {
    throw new Error("O catálogo publicado não tem produtos para reaproveitar.");
  }

  return {
    products: products.map((product) => ({
      ...product,
      localImage: product.localImage || (product.image ? `imagens/${imageFilename(product)}` : ""),
    })),
    meta: {
      ...(payload.meta || {}),
      mode: "deploy-only",
      sourceGeneratedAt: payload.generatedAt || payload.meta?.generatedAt || null,
      skipTelegram: true,
      pages: [
        {
          title: "Catálogo publicado reaproveitado",
          count: products.length,
        },
      ],
    },
  };
}

function extractProductsFromHtml(html, sourceFile = "") {
  const chunks = html.match(/<app-product-card\b[\s\S]*?<\/app-product-card>/g) || [];
  return chunks
    .map((chunk) => {
      const brand = firstText(/class="gm-caption-small"[^>]*>([\s\S]*?)<\/span>/i, chunk);
      const name =
        firstText(/class="gm-body-small-bold"[^>]*>([\s\S]*?)<\/span>/i, chunk) ||
        firstAttr(/<img[^>]+class="product-image"[^>]+alt="([^"]*)"/i, chunk);
      const measure = firstText(/class="measure active[^"]*"[^>]*>([\s\S]*?)<\/span>/i, chunk);
      const sku = firstText(/SKU:\s*([^<]*)/i, chunk);
      const priceText = firstText(/class="gm-price-small"[^>]*>([\s\S]*?)<\/span>/i, chunk)
        .replace(/\bunid\.?$/i, "")
        .trim();
      const cx = firstText(/Cx:\s*<span[^>]*>\s*([^<]*)/i, chunk);
      const stock = firstText(/Estoque:\s*<span[^>]*>\s*([^<]*)/i, chunk);
      const qtyInputAttrs = firstTagAttrs(/<input\b[^>]*type="number"[^>]*>/i, chunk);
      const image = firstAttr(/<img[^>]+class="product-image"[^>]+src="([^"]*)"/i, chunk);
      const sealText = firstText(/class="seal[^"]*"[^>]*>([\s\S]*?)<\/div>/i, chunk);
      const hasDisabledLayer = /class="[^"]*\blayer-disable\b/i.test(chunk);
      const canAddToCart = /<app-add-cart-button\b/i.test(chunk) && !hasDisabledLayer;
      const blockedText = /Indisponível|Indisponivel|Bloquead|Restrit|Não disponível|Nao disponivel|Produto não encontrado|Produto nao encontrado/i.test(
        `${stripTags(chunk)} ${sealText}`,
      );

      return {
        brand,
        name,
        measure,
        sku,
        priceText,
        cx,
        stock,
        minQty: attrFromTag(qtyInputAttrs, "min"),
        maxQty: attrFromTag(qtyInputAttrs, "max"),
        canAddToCart,
        hasDisabledLayer,
        sealText,
        unavailable: blockedText || hasDisabledLayer || /R\$\s*--,--/i.test(stripTags(chunk)) || !canAddToCart,
        image,
        sourceFile,
      };
    })
    .filter((product) => product.name || product.sku);
}

function firstText(regex, text) {
  const match = text.match(regex);
  return match ? stripTags(match[1]) : "";
}

function firstAttr(regex, text) {
  const match = text.match(regex);
  return match ? decodeHtml(match[1]) : "";
}

function firstTagAttrs(regex, text) {
  const match = text.match(regex);
  return match ? match[0] : "";
}

function attrFromTag(tag, name) {
  if (!tag) {
    return "";
  }
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return match ? decodeHtml(match[1]) : "";
}

function stripTags(value = "") {
  return decodeHtml(value.replace(/<[^>]+>/g, " "));
}

function decodeHtml(value = "") {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeProduct(product) {
  const stockNumber = parseInteger(product.stock);
  const priceNumber = parsePrice(product.priceText);
  const minQtyFromSite = parseInteger(product.minQty);
  const maxQtyFromSite = parseInteger(product.maxQty);
  const unavailable = Boolean(product.unavailable);
  const canAddToCart = product.canAddToCart !== false;
  const availabilityReason = getAvailabilityReason({
    unavailable,
    canAddToCart,
    priceNumber,
    stockNumber,
    hasDisabledLayer: product.hasDisabledLayer,
    sealText: product.sealText,
  });

  return {
    brand: clean(product.brand),
    name: clean(product.name),
    measure: clean(product.measure),
    sku: clean(product.sku),
    priceText: clean(product.priceText),
    priceNumber,
    cx: clean(product.cx),
    stock: clean(product.stock),
    stockNumber,
    minQty: minQtyFromSite || 1,
    maxQty: maxQtyFromSite || stockNumber || "",
    minQtySource: minQtyFromSite ? "site" : "padrao",
    canAddToCart,
    hasDisabledLayer: Boolean(product.hasDisabledLayer),
    sealText: clean(product.sealText),
    status: availabilityReason || "Disponível",
    available: !availabilityReason,
    image: product.image || "",
    source: product.source || "",
    sourceUrl: product.sourceUrl || "",
    sourceFile: product.sourceFile || "",
  };
}

function getAvailabilityReason(product) {
  if (product.hasDisabledLayer) {
    return "Indisponível";
  }
  if (product.unavailable) {
    return "Indisponível";
  }
  if (!product.canAddToCart) {
    return "Não vendável";
  }
  if (product.priceNumber === null) {
    return "Sem preço";
  }
  if (product.stockNumber !== null && product.stockNumber <= 0) {
    return "Sem estoque";
  }
  if (/bloquead|restrit/i.test(product.sealText || "")) {
    return "Bloqueado";
  }
  return "";
}

function clean(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeClients(clients = []) {
  const byCode = new Map();
  for (const client of clients) {
    const code = clean(client.code);
    const name = clean(client.name);
    if (!code || !name) {
      continue;
    }
    const current = byCode.get(code) || {};
    byCode.set(code, {
      code,
      name,
      document: clean(client.document || current.document),
      address: clean(client.address || current.address),
      taxStatus: clean(client.taxStatus || current.taxStatus),
      text: clean(client.text || current.text),
      selected: Boolean(current.selected || client.selected),
    });
  }
  return [...byCode.values()].sort((a, b) => {
    if (a.selected !== b.selected) return a.selected ? -1 : 1;
    return a.name.localeCompare(b.name, "pt-BR");
  });
}

function parseInteger(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits ? Number(digits) : null;
}

function parsePrice(value) {
  const match = String(value || "").match(/([\d.]+,\d{2})/);
  if (!match) return null;
  return Number(match[1].replace(/\./g, "").replace(",", "."));
}

function applyConfiguredFilters(config, rawProducts) {
  const output = [];
  const seen = new Set();

  for (const group of config.products) {
    for (const product of rawProducts) {
      if (!matchesFilter(product, group.filter || {})) {
        continue;
      }
      if (config.availableOnly !== false && !product.available) {
        continue;
      }

      const key = `${group.id}:${product.sku || normalizeText(product.name)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      output.push(applyQuantityOverrides({ ...product, groupId: group.id, groupTitle: group.title }, group, config));
    }
  }

  return output.sort((a, b) => {
    const groupOrder =
      config.products.findIndex((group) => group.id === a.groupId) -
      config.products.findIndex((group) => group.id === b.groupId);
    if (groupOrder !== 0) return groupOrder;
    return `${a.brand} ${a.name}`.localeCompare(`${b.brand} ${b.name}`, "pt-BR");
  });
}

function matchesFilter(product, filter) {
  const haystack = normalizeText(
    [product.brand, product.name, product.measure, product.sku].filter(Boolean).join(" "),
  );

  for (const required of filter.mustContain || []) {
    if (!haystack.includes(normalizeText(required))) {
      return false;
    }
  }

  for (const pattern of filter.regex || []) {
    if (!new RegExp(pattern, "i").test(haystack)) {
      return false;
    }
  }

  return true;
}

function applyQuantityOverrides(product, group, config) {
  for (const override of config.quantityOverrides || []) {
    if (!matchesQuantityOverride(product, group, override)) {
      continue;
    }
    const minQty = parseInteger(override.minQty);
    if (minQty) {
      product.minQty = minQty;
      product.minQtySource = override.source || "regra";
      if (product.maxQty && Number(product.maxQty) < minQty && product.stockNumber && product.stockNumber >= minQty) {
        product.maxQty = product.stockNumber;
      }
    }
  }
  return product;
}

function matchesQuantityOverride(product, group, override) {
  if (override.groupId && override.groupId !== group.id && override.groupId !== product.groupId) {
    return false;
  }

  const haystack = normalizeText([product.groupTitle, product.brand, product.name, product.measure, product.sku].join(" "));

  for (const required of override.mustContain || []) {
    if (!haystack.includes(normalizeText(required))) {
      return false;
    }
  }

  if (override.mustContainAny?.length) {
    const hasAny = override.mustContainAny.some((required) => haystack.includes(normalizeText(required)));
    if (!hasAny) {
      return false;
    }
  }

  for (const blocked of override.mustNotContain || []) {
    if (haystack.includes(normalizeText(blocked))) {
      return false;
    }
  }

  return true;
}

function normalizeText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function writeOutputs(config, products, meta) {
  const generatedAt = new Date();
  const stamp = zonedStamp(generatedAt, config.timezone);
  const outputRoot = absoluteFromProject(config.outputDir);
  const runDir = path.join(outputRoot, stamp.file);
  const imagesDir = path.join(runDir, "imagens");

  await fs.mkdir(imagesDir, { recursive: true });
  console.log("Gerando arquivos...");
  await cacheImages(products, imagesDir, config);
  await installPdfJsAssets(runDir);

  const encryptedClientBase = await readEncryptedClientBase(config);
  const clients = encryptedClientBase ? [] : normalizeClients(meta.clients || []);
  const normalizedMeta = {
    ...meta,
    clients,
    selectedClient: encryptedClientBase ? null : meta.selectedClient || null,
  };
  const summary = buildSummary(config, products, generatedAt, normalizedMeta);
  const html = buildCatalogHtml(config, products, summary, generatedAt, normalizedMeta, encryptedClientBase);
  const csv = buildCsv(products);
  const manifest = buildWebManifest(config);
  const serviceWorker = buildServiceWorker(products, generatedAt, config);
  const iconSvg = buildIconSvg();

  const runFiles = {
    html: path.join(runDir, "catalogo.html"),
    index: path.join(runDir, "index.html"),
    csv: path.join(runDir, "produtos.csv"),
    json: path.join(runDir, "produtos.json"),
    clients: path.join(runDir, "clientes.json"),
    summary: path.join(runDir, "resumo.txt"),
    manifest: path.join(runDir, "manifest.webmanifest"),
    serviceWorker: path.join(runDir, "sw.js"),
    icon: path.join(runDir, "icon.svg"),
  };

  await fs.writeFile(runFiles.html, html, "utf8");
  await fs.writeFile(runFiles.index, html, "utf8");
  await fs.writeFile(runFiles.csv, "\uFEFF" + csv, "utf8");
  await fs.writeFile(runFiles.json, JSON.stringify({ generatedAt, meta: normalizedMeta, products }, null, 2), "utf8");
  await fs.writeFile(runFiles.clients, JSON.stringify({ generatedAt, clients, encryptedClientBase }, null, 2), "utf8");
  await fs.writeFile(runFiles.summary, summary, "utf8");
  await fs.writeFile(runFiles.manifest, manifest, "utf8");
  await fs.writeFile(runFiles.serviceWorker, serviceWorker, "utf8");
  await fs.writeFile(runFiles.icon, iconSvg, "utf8");

  await publishLatest(outputRoot, runDir, runFiles);
  if (!normalizedMeta.skipTelegram) {
    await maybeSendTelegram(config, summary, [runFiles.html, runFiles.csv]);
  }

  console.log("");
  console.log(`Produtos disponíveis: ${products.length}`);
  console.log(`Catálogo: ${runFiles.html}`);
  console.log(`Planilha CSV: ${runFiles.csv}`);
}

async function readEncryptedClientBase(config) {
  const clientBaseFile = config.clientBaseEncryptedFile || "config/clientes-base.enc.json";
  const clientBasePath = absoluteFromProject(clientBaseFile);
  try {
    return JSON.parse(await fs.readFile(clientBasePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.log(`Aviso: não consegui ler a base de clientes ${clientBaseFile}: ${error.message}`);
    }
    return null;
  }
}

async function publishLatest(outputRoot, runDir, runFiles) {
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.copyFile(runFiles.html, path.join(outputRoot, "catalogo.html"));
  await fs.copyFile(runFiles.index, path.join(outputRoot, "index.html"));
  await fs.copyFile(runFiles.csv, path.join(outputRoot, "produtos.csv"));
  await fs.copyFile(runFiles.json, path.join(outputRoot, "produtos.json"));
  await fs.copyFile(runFiles.clients, path.join(outputRoot, "clientes.json"));
  await fs.copyFile(runFiles.summary, path.join(outputRoot, "resumo.txt"));
  await fs.copyFile(runFiles.manifest, path.join(outputRoot, "manifest.webmanifest"));
  await fs.copyFile(runFiles.serviceWorker, path.join(outputRoot, "sw.js"));
  await fs.copyFile(runFiles.icon, path.join(outputRoot, "icon.svg"));

  const latestPdfJsDir = path.join(outputRoot, "pdfjs");
  await fs.rm(latestPdfJsDir, { recursive: true, force: true });
  await copyDirectory(path.join(runDir, "pdfjs"), latestPdfJsDir);

  const latestImagesDir = path.join(outputRoot, "imagens");
  await fs.rm(latestImagesDir, { recursive: true, force: true });
  await copyDirectory(path.join(runDir, "imagens"), latestImagesDir);
}

async function installPdfJsAssets(runDir) {
  const pdfJsFiles = await resolvePdfJsBuildFiles();
  const targetDir = path.join(runDir, "pdfjs");
  await fs.mkdir(targetDir, { recursive: true });
  await fs.copyFile(pdfJsFiles.main, path.join(targetDir, "pdf.min.mjs"));
  await fs.copyFile(pdfJsFiles.worker, path.join(targetDir, "pdf.worker.min.mjs"));
}

async function resolvePdfJsBuildFiles() {
  const attempts = [
    path.join(PROJECT_ROOT, "node_modules", "pdfjs-dist", "legacy", "build"),
    path.join(PROJECT_ROOT, "node_modules", "pdfjs-dist", "build"),
    path.join(BUNDLED_NODE_MODULES, "pdfjs-dist", "legacy", "build"),
    path.join(BUNDLED_NODE_MODULES, "pdfjs-dist", "build"),
  ];

  for (const candidate of attempts) {
    const main = ["pdf.min.mjs", "pdf.mjs"].map((filename) => path.join(candidate, filename)).find((file) => fsSync.existsSync(file));
    const worker = ["pdf.worker.min.mjs", "pdf.worker.mjs"].map((filename) => path.join(candidate, filename)).find((file) => fsSync.existsSync(file));
    if (main && worker) {
      return { main, worker };
    }
  }

  throw new Error(
    "Nao encontrei os arquivos do pdfjs-dist. Instale com `npm install --no-save pdfjs-dist` antes de gerar o catalogo.",
  );
}

async function copyDirectory(source, target) {
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
    } else {
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

async function cacheImages(products, imagesDir, config) {
  if (config.downloadImages === false) {
    for (const product of products.filter((item) => item.image)) {
      product.localImage = `imagens/${imageFilename(product)}`;
    }
    console.log("Imagens locais desativadas nesta execucao; usando caminhos locais esperados com fallback remoto.");
    return;
  }

  const queue = products.filter((product) => product.image);
  if (!queue.length) {
    return;
  }

  console.log(`Preparando imagens offline (${queue.length} item(ns))...`);
  const totalImages = queue.length;
  let done = 0;
  const workerCount = Math.min(6, queue.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length) {
      const product = queue.shift();
      const filename = imageFilename(product);
      const target = path.join(imagesDir, filename);
      const relative = `imagens/${filename}`;

      try {
        if (/^https?:\/\//i.test(product.image)) {
          await downloadFile(product.image, target, config.imageDownloadTimeoutMs || 8000);
          product.localImage = relative;
        } else if (product.sourceFile) {
          const sourcePath = path.resolve(path.dirname(product.sourceFile), product.image);
          if (fsSync.existsSync(sourcePath)) {
            await fs.copyFile(sourcePath, target);
            product.localImage = relative;
          }
        }
      } catch (error) {
        product.imageError = error.message;
      } finally {
        done += 1;
        if (done === totalImages || done % 25 === 0) {
          console.log(`  Imagens processadas: ${done}/${totalImages}`);
        }
      }
    }
  });

  await Promise.all(workers);
}

async function downloadFile(url, target, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    await fs.writeFile(target, bytes);
  } finally {
    clearTimeout(timeout);
  }
}

function imageFilename(product) {
  const sourcePath = product.image.split("?")[0];
  const ext = path.extname(sourcePath).replace(/[^a-z0-9.]/gi, "") || ".png";
  const base = safeFilename(product.sku || product.name || crypto.randomUUID());
  const hash = crypto.createHash("sha1").update(product.image).digest("hex").slice(0, 8);
  return `${base}-${hash}${ext}`;
}

function buildSummary(config, products, generatedAt, meta) {
  const lines = [];
  lines.push("Mateus Mais - Produtos disponíveis");
  lines.push(`Gerado em: ${formatDateTime(generatedAt, config.timezone)}`);
  lines.push(`Modo: ${meta.mode}`);
  lines.push("");
  lines.push(`Total disponível: ${products.length}`);

  for (const group of config.products) {
    const count = products.filter((product) => product.groupId === group.id).length;
    lines.push(`- ${group.title}: ${count}`);
  }

  if (meta.pages?.length) {
    lines.push("");
    lines.push("Páginas consultadas:");
    for (const page of meta.pages) {
      lines.push(`- ${page.title}: ${page.count} card(s) lido(s)`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function buildCsv(products) {
  const headers = [
    "grupo",
    "marca",
    "produto",
    "medida",
    "sku",
    "preco",
    "preco_numero",
    "minimo_carrinho",
    "origem_minimo",
    "maximo_carrinho",
    "caixa_minima",
    "estoque",
    "status",
    "imagem",
  ];

  const rows = products.map((product) => [
    product.groupTitle,
    product.brand,
    product.name,
    product.measure,
    product.sku,
    product.priceText,
    product.priceNumber == null ? "" : product.priceNumber.toFixed(2).replace(".", ","),
    product.minQty,
    product.minQtySource,
    product.maxQty,
    product.cx,
    product.stockNumber == null ? product.stock : String(product.stockNumber),
    product.status,
    product.localImage || product.image,
  ]);

  return [headers, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function normalizeSupabaseConfig(supabase = {}) {
  const rawUrl = String(supabase.url || "").trim();
  const url = rawUrl.replace(/\/rest\/v1\/?$/i, "").replace(/\/+$/, "");
  const anonKey = String(supabase.anonKey || supabase.anon_key || "").trim();
  return { url, anonKey };
}

function buildCatalogHtml(config, products, summary, generatedAt, meta = {}, encryptedClientBase = null) {
  const catalogProducts = products.map((product, index) => ({
    ...product,
    cartKey: product.sku || `item-${index + 1}`,
  }));
  const clients = normalizeClients([...(meta.clients || []), ...(config.manualClients || [])]);
  const hasAuthGate = Boolean(encryptedClientBase);
  const groups = config.products.map((group) => ({
    ...group,
    products: catalogProducts.filter((product) => product.groupId === group.id),
  }));
  const priceRequestTemplate = config.cart?.priceRequestTemplate || {
    title: "*ALTERAÇÃO DE TELA*",
    rca: "RCA: 39305 - Max JDE",
    client: "Cliente: *9999999* - NOME FANTASIA OU RAZÃO",
    supervisor: "Supervisor: Natan",
  };
  const supabaseConfig = normalizeSupabaseConfig(config.supabase);

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0478d1">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="icon" href="icon.svg" type="image/svg+xml">
  <title>Mateus Mais - Produtos disponíveis</title>
  <style>
    :root {
      --blue: #0478d1;
      --green: #12805c;
      --ink: #172033;
      --muted: #667085;
      --line: #d9e1ec;
      --soft: #f5f7fb;
      --paper: #ffffff;
      --warn: #f3a712;
      --danger: #b42318;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      color: var(--ink);
      background: var(--soft);
      overflow-x: hidden;
    }
    body[data-auth="locked"] header,
    body[data-auth="locked"] main,
    body[data-auth="locked"] footer {
      display: none;
    }
    .auth-screen {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 18px;
      background: var(--soft);
    }
    body[data-auth="open"] .auth-screen {
      display: none;
    }
    .auth-card {
      width: min(420px, 100%);
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      box-shadow: 0 16px 36px rgba(23, 32, 51, 0.12);
    }
    .auth-card h1 {
      white-space: normal;
      margin-bottom: 4px;
    }
    .auth-card p {
      margin: 0 0 14px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.4;
    }
    .auth-card form {
      display: grid;
      gap: 10px;
    }
    .auth-card input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 11px 12px;
      font-size: 15px;
    }
    .auth-error {
      min-height: 18px;
      color: var(--danger);
      font-size: 12px;
      font-weight: 700;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 30;
      background: var(--paper);
      border-bottom: 1px solid var(--line);
      padding: 8px 18px;
    }
    .top {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) auto minmax(240px, 420px) auto;
      gap: 10px;
      align-items: center;
      max-width: 1180px;
      margin: 0 auto;
    }
    .title-block {
      min-width: 0;
    }
    h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.2;
      letter-spacing: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .date {
      margin-top: 2px;
      color: var(--muted);
      font-size: 12px;
    }
    input[type="search"] {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 9px 12px;
      font-size: 15px;
      background: #fff;
      color: var(--ink);
    }
    .tabs {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      padding-bottom: 2px;
      min-width: 0;
    }
    .tab-button {
      flex: 0 0 auto;
      border-color: var(--line);
      background: #fff;
      color: var(--ink);
      padding: 8px 11px;
      white-space: nowrap;
    }
    .tab-button.active {
      border-color: var(--blue);
      background: var(--blue);
      color: #fff;
    }
    .cart-badge {
      display: inline-flex;
      min-width: 22px;
      height: 22px;
      align-items: center;
      justify-content: center;
      margin-left: 6px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.2);
      color: inherit;
      font-size: 12px;
    }
    .account-menu {
      position: relative;
      justify-self: end;
    }
    .account-menu summary,
    .cart-actions-menu summary {
      list-style: none;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fff;
      color: var(--muted);
      padding: 7px 10px;
      font-size: 13px;
      font-weight: 700;
      line-height: 1;
      cursor: pointer;
      white-space: nowrap;
    }
    .account-menu summary::-webkit-details-marker,
    .cart-actions-menu summary::-webkit-details-marker {
      display: none;
    }
    .account-menu[open] summary,
    .cart-actions-menu[open] summary {
      border-color: var(--blue);
      color: var(--blue);
    }
    .account-panel,
    .cart-actions {
      position: absolute;
      right: 0;
      top: calc(100% + 6px);
      z-index: 40;
      display: grid;
      gap: 6px;
      min-width: 150px;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--paper);
      box-shadow: 0 12px 28px rgba(23, 32, 51, 0.14);
    }
    .account-panel button,
    .cart-actions button {
      width: 100%;
      padding: 8px 10px;
      text-align: left;
      white-space: nowrap;
    }
    button, input, textarea {
      font: inherit;
    }
    button {
      border: 1px solid var(--blue);
      border-radius: 8px;
      background: var(--blue);
      color: #fff;
      padding: 10px 12px;
      font-weight: 700;
      cursor: pointer;
      min-width: 0;
    }
    button.secondary {
      background: #fff;
      color: var(--blue);
    }
    button.danger {
      background: #fff;
      border-color: #f1b8b1;
      color: var(--danger);
    }
    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 16px 18px 28px;
    }
    .view.hidden {
      display: none;
    }
    .summary,
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 10px;
      margin-bottom: 18px;
    }
    .summary,
    .cart-section {
      display: none;
    }
    body[data-active-view="summary"] .summary {
      display: grid;
    }
    body[data-active-view="cart"] .cart-section {
      display: block;
    }
    body[data-active-view="cart"] section[data-group],
    body[data-active-view="summary"] section[data-group] {
      display: none;
    }
    .metric {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
    }
    .metric strong {
      display: block;
      font-size: 22px;
      color: var(--blue);
    }
    .metric span {
      color: var(--muted);
      font-size: 13px;
    }
    .summary-text {
      display: none;
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      color: var(--ink);
      white-space: pre-wrap;
      line-height: 1.45;
      overflow-x: auto;
    }
    body[data-active-view="summary"] .summary-text {
      display: block;
    }
    section {
      margin-top: 22px;
    }
    h2 {
      margin: 0 0 10px;
      font-size: 18px;
      letter-spacing: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(185px, 1fr));
      gap: 12px;
      min-width: 0;
    }
    .product-card {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      min-height: 100%;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .image {
      height: 142px;
      background: #eef2f7;
      display: flex;
      align-items: center;
      justify-content: center;
      border-bottom: 1px solid var(--line);
    }
    .image img {
      max-width: 100%;
      max-height: 138px;
      object-fit: contain;
      display: block;
    }
    .body {
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex: 1;
    }
    .brand {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .name {
      font-size: 14px;
      line-height: 1.25;
      font-weight: 700;
      min-height: 36px;
    }
    .sku, .measure {
      font-size: 12px;
      color: var(--muted);
    }
    .price {
      font-size: 18px;
      color: var(--blue);
      font-weight: 800;
      margin-top: 2px;
    }
    .stock {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
      color: var(--muted);
      margin-top: auto;
      padding-top: 8px;
      border-top: 1px solid var(--line);
    }
    .stock strong {
      color: var(--green);
    }
    .cart-controls {
      display: grid;
      grid-template-columns: minmax(62px, 0.42fr) minmax(92px, 0.58fr);
      gap: 8px;
      margin-top: 8px;
    }
    .cart-controls input,
    .client-search,
    .client-select,
    .rule-bar input,
    .cart-row input {
      width: 100%;
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 9px 10px;
      background: #fff;
      color: var(--ink);
    }
    .cart-controls button {
      width: 100%;
      padding-left: 8px;
      padding-right: 8px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cart-controls button.in-cart {
      border-color: var(--green);
      background: var(--green);
    }
    .min-note {
      color: var(--muted);
      font-size: 11px;
    }
    .added-note {
      color: var(--green);
      font-size: 11px;
      font-weight: 700;
    }
    .cart-section {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0;
      overflow: visible;
    }
    .cart-toolbar {
      position: sticky;
      top: calc(var(--header-height, 64px) - 1px);
      z-index: 20;
      background: var(--paper);
      border-bottom: 1px solid var(--line);
      border-radius: 8px 8px 0 0;
      padding: 12px 14px;
      box-shadow: 0 8px 16px rgba(23, 32, 51, 0.06);
    }
    .cart-body {
      padding: 12px 14px 14px;
    }
    .cart-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }
    .cart-header h2 {
      margin: 0;
    }
    .cart-actions-menu {
      position: relative;
      flex: 0 0 auto;
      justify-self: end;
    }
    .cart-actions {
      min-width: 190px;
    }
    .client-bar {
      display: grid;
      grid-template-columns: minmax(160px, 1fr);
      gap: 4px;
      min-width: 0;
    }
    .client-bar label,
    .request-box label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .client-hint {
      min-height: 14px;
      color: var(--muted);
      font-size: 11px;
    }
    .cart-tools {
      display: grid;
      grid-template-columns: minmax(260px, 0.8fr) minmax(360px, 1.2fr);
      gap: 8px;
      align-items: end;
    }
    .rule-bar {
      display: grid;
      grid-template-columns: minmax(160px, 1fr) minmax(110px, 150px) auto;
      gap: 8px;
      padding: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: transparent;
    }
    .rule-bar input {
      border: 0;
      border-right: 1px solid var(--line);
      border-radius: 0;
    }
    .rule-bar input:first-child {
      border-radius: 8px 0 0 8px;
    }
    .rule-bar button {
      border-radius: 0 8px 8px 0;
      border: 0;
    }
    .short-label {
      display: none;
    }
    .cart-items {
      display: grid;
      gap: 8px;
    }
    .cart-row {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) auto 64px;
      gap: 8px;
      align-items: center;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .cart-name {
      min-width: 0;
    }
    .cart-name strong {
      display: block;
      font-size: 13px;
      line-height: 1.25;
    }
    .cart-name span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-top: 3px;
    }
    .cart-editors {
      display: grid;
      grid-template-columns: 84px 116px auto;
      gap: 8px;
      align-items: center;
    }
    .cart-thumb {
      width: 58px;
      height: 58px;
      justify-self: end;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #eef2f7;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .cart-thumb img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      background: #fff;
    }
    .cart-total {
      display: flex;
      justify-content: flex-end;
      gap: 18px;
      margin: 12px 0;
      color: var(--muted);
      font-size: 13px;
    }
    .cart-total strong {
      color: var(--ink);
      font-size: 16px;
    }
    .request-box {
      display: grid;
      gap: 8px;
    }
    .request-box textarea {
      width: 100%;
      min-height: 190px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #fff;
      color: var(--ink);
      line-height: 1.35;
      white-space: pre;
    }
    .empty {
      background: var(--paper);
      border: 1px dashed var(--line);
      border-radius: 8px;
      color: var(--muted);
      padding: 14px;
    }
    .hidden { display: none !important; }
    .pwa-status {
      position: fixed;
      right: 12px;
      bottom: 12px;
      z-index: 20;
      display: none;
      max-width: min(320px, calc(100vw - 24px));
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--paper);
      box-shadow: 0 10px 30px rgba(23, 32, 51, 0.16);
      padding: 10px 12px;
      color: var(--muted);
      font-size: 12px;
    }
    .pwa-status.show { display: block; }
    footer {
      max-width: 1180px;
      margin: 0 auto;
      padding: 0 18px 24px;
      color: var(--muted);
      font-size: 12px;
      white-space: pre-wrap;
    }
    @media (max-width: 980px) {
      .top {
        grid-template-columns: minmax(220px, 1fr) minmax(220px, 360px) auto;
      }
      .tabs {
        grid-column: 1 / -1;
        order: 3;
      }
      .account-menu {
        order: 4;
      }
      .cart-tools {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 720px) {
      .top {
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
      }
      header { padding: 8px 10px; }
      main { padding: 12px; }
      h1 { font-size: 18px; }
      .date {
        font-size: 11px;
      }
      #search {
        grid-column: 1 / -1;
        order: 3;
      }
      body:not([data-active-view="products"]) #search {
        display: none;
      }
      .tabs {
        grid-column: 1 / -1;
        order: 4;
        gap: 6px;
        padding-bottom: 0;
      }
      .account-menu {
        grid-column: 2;
        grid-row: 1;
        order: 2;
      }
      .account-menu summary {
        padding: 8px 10px;
      }
      .account-panel {
        min-width: 126px;
      }
      .tab-button { padding: 7px 10px; }
      .cart-toolbar { padding: 8px 10px; }
      .cart-header {
        align-items: center;
        flex-direction: row;
        margin-bottom: 6px;
      }
      .cart-header h2 {
        font-size: 17px;
      }
      .cart-actions-menu summary {
        padding: 8px 10px;
      }
      .cart-tools {
        gap: 6px;
      }
      .client-bar {
        gap: 3px;
      }
      .client-bar label {
        display: none;
      }
      .client-hint {
        min-height: 0;
      }
      .client-hint:empty {
        display: none;
      }
      .grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
      .rule-bar {
        grid-template-columns: minmax(0, 1fr) minmax(76px, 92px) 58px;
      }
      .rule-bar input,
      .rule-bar button {
        padding: 8px 7px;
        font-size: 14px;
      }
      .long-label {
        display: none;
      }
      .short-label {
        display: inline;
      }
      .cart-row {
        grid-template-columns: minmax(0, 1fr) 68px;
        gap: 6px;
        padding: 8px;
      }
      .cart-name {
        grid-column: 1;
      }
      .cart-editors {
        grid-column: 1;
        grid-template-columns: minmax(64px, 1fr) minmax(76px, 1fr) 42px;
        gap: 6px;
      }
      .cart-editors input {
        padding: 8px;
      }
      .cart-thumb {
        grid-column: 2;
        grid-row: 1 / span 2;
        width: 64px;
        height: 64px;
        align-self: start;
      }
      .cart-row button[data-remove-key] {
        width: 42px;
        min-height: 38px;
        padding: 0;
        overflow: hidden;
        font-size: 0;
      }
      .cart-row button[data-remove-key]::before {
        content: "X";
        font-size: 16px;
        line-height: 1;
      }
      .image { height: 120px; }
      .image img { max-height: 116px; }
    }
    @media (max-width: 760px) {
      .grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .body {
        padding: 9px;
      }
      .cart-controls {
        grid-template-columns: 1fr;
      }
      .cart-controls input,
      .cart-controls button {
        padding: 8px;
      }
      .name {
        font-size: 13px;
        min-height: 48px;
      }
      .price {
        font-size: 17px;
      }
      .stock {
        flex-direction: column;
        gap: 2px;
      }
    }
    @media (max-width: 430px) {
      .rule-bar {
        grid-template-columns: minmax(0, 1fr) 74px 52px;
      }
      .rule-bar input,
      .rule-bar input:first-child {
        border-radius: 0;
        border: 0;
        border-right: 1px solid var(--line);
      }
      .rule-bar input:first-child {
        border-radius: 8px 0 0 8px;
      }
      .rule-bar button {
        border-radius: 0 8px 8px 0;
        border-color: var(--blue);
        grid-column: auto;
      }
      .cart-row {
        grid-template-columns: minmax(0, 1fr) 62px;
      }
      .cart-editors {
        grid-template-columns: minmax(58px, 1fr) minmax(70px, 1fr) 40px;
      }
      .cart-thumb {
        width: 58px;
        height: 58px;
      }
      .cart-total {
        justify-content: space-between;
        gap: 8px;
      }
    }
  </style>
</head>
<body data-active-view="products" data-auth="${hasAuthGate ? "locked" : "open"}">
  ${
    hasAuthGate
      ? `<div class="auth-screen">
    <div class="auth-card">
      <h1>Acesso ao catálogo</h1>
      <p>Entre para abrir o catálogo, carrinho e base de clientes.</p>
      <form id="authForm">
        <input id="authEmail" type="email" autocomplete="username" placeholder="Email" value="max.distac@gmail.com">
        <input id="authPassword" type="password" autocomplete="current-password" placeholder="Senha">
        <button type="submit">Entrar</button>
        <div id="authError" class="auth-error"></div>
      </form>
    </div>
  </div>`
      : ""
  }
  <header>
    <div class="top">
      <div class="title-block">
        <h1>Mateus Mais - Produtos disponíveis</h1>
        <div class="date">${escapeHtml(formatDateTime(generatedAt, config.timezone))}</div>
      </div>
      <nav class="tabs" aria-label="Páginas do catálogo">
        <button type="button" class="tab-button active" data-view-target="products">Produtos</button>
        <button type="button" class="tab-button" data-view-target="cart">Carrinho <span id="cartBadge" class="cart-badge">0</span></button>
        <button type="button" class="tab-button" data-view-target="summary">Resumo</button>
      </nav>
      <input id="search" type="search" autocomplete="off" placeholder="Buscar produto, SKU, marca ou tamanho">
      <details class="account-menu">
        <summary>Conta</summary>
        <div class="account-panel">
          <button id="changePassword" type="button" class="secondary">Senha</button>
          <button id="logout" type="button" class="secondary">Sair</button>
        </div>
      </details>
    </div>
  </header>
  <main>
    <div class="summary">
      <div class="metric"><strong>${products.length}</strong><span>Total disponível</span></div>
      ${groups
        .map(
          (group) =>
            `<div class="metric"><strong>${group.products.length}</strong><span>${escapeHtml(
              group.title,
            )}</span></div>`,
        )
        .join("")}
    </div>
    <pre class="summary-text">${escapeHtml(summary)}</pre>
    <section class="cart-section" data-cart-panel>
      <div class="cart-toolbar">
      <div class="cart-header">
        <h2>Carrinho fictício (<span id="cartCount">0</span>)</h2>
        <details class="cart-actions-menu">
          <summary>Acoes</summary>
          <div class="cart-actions">
            <button id="exportImportCart" type="button" class="secondary">Exportar planilha</button>
            <button id="importCartPdf" type="button" class="secondary">Importar PDF</button>
            <input id="importCartPdfFile" type="file" accept="application/pdf,.pdf" class="hidden">
            <button id="clearCart" type="button" class="danger">Limpar</button>
          </div>
        </details>
      </div>
      <div class="cart-tools">
      <div class="client-bar">
        <label for="clientSearch">Cliente para o modelo de alteração</label>
        <input id="clientSearch" class="client-search" type="search" list="clientOptions" autocomplete="off" placeholder="Digite código, documento ou nome">
        <datalist id="clientOptions"></datalist>
        <div id="clientHint" class="client-hint"></div>
      </div>
      <div class="rule-bar">
        <input id="linePattern" type="text" autocomplete="off" placeholder="Linha/modelo: Slim Square">
        <input id="linePrice" type="text" inputmode="decimal" autocomplete="off" placeholder="Preço">
        <button id="applyLinePrice" type="button"><span class="long-label">Aplicar</span><span class="short-label">OK</span></button>
      </div>
      </div>
      </div>
      <div class="cart-body">
      <div id="cartItems" class="cart-items"></div>
      <div class="cart-total">
        <span>Itens: <strong id="cartTotalQty">0</strong></span>
        <span>Total negociado: <strong id="cartTotalValue">R$ 0,00</strong></span>
      </div>
      <div class="request-box">
        <label for="requestText">Modelo de alteração de tela</label>
        <textarea id="requestText" readonly></textarea>
        <button id="copyRequest" type="button" class="secondary">Copiar solicitação</button>
      </div>
      </div>
    </section>
    ${groups.map(renderGroup).join("\n")}
  </main>
  <footer>Catálogo gerado em ${escapeHtml(formatDateTime(generatedAt, config.timezone))}. Abra com internet uma vez para atualizar o cache offline.</footer>
  <div id="pwaStatus" class="pwa-status"></div>
  <script type="application/json" id="products-data">${safeJsonForScript(catalogProducts)}</script>
  <script type="application/json" id="clients-data">${safeJsonForScript(clients)}</script>
  <script type="application/json" id="encrypted-clients-data">${safeJsonForScript(encryptedClientBase)}</script>
  <script type="application/json" id="price-template">${safeJsonForScript(priceRequestTemplate)}</script>
  <script type="application/json" id="supabase-config">${safeJsonForScript(supabaseConfig)}</script>
  <script>
    const input = document.getElementById("search");
    const cards = Array.from(document.querySelectorAll(".product-card"));
    const sections = Array.from(document.querySelectorAll("section[data-group]"));
    const products = JSON.parse(document.getElementById("products-data").textContent);
    const productsByKey = new Map(products.map((product) => [product.cartKey, product]));
    const productsBySku = new Map(products.filter((product) => product.sku).map((product) => [String(product.sku), product]));
    let clients = JSON.parse(document.getElementById("clients-data").textContent);
    let clientsByCode = new Map(clients.map((client) => [client.code, client]));
    const encryptedClientBase = JSON.parse(document.getElementById("encrypted-clients-data").textContent);
    const priceTemplate = JSON.parse(document.getElementById("price-template").textContent);
    const supabaseConfig = JSON.parse(document.getElementById("supabase-config").textContent);
    const supabaseEnabled = Boolean(supabaseConfig.url && supabaseConfig.anonKey);
    const supabaseUrl = String(supabaseConfig.url || "")
      .replace(new RegExp("/rest/v1/?$", "i"), "")
      .replace(new RegExp("/+$"), "");
    const supabaseAuthUrl = supabaseUrl ? supabaseUrl + "/auth/v1" : "";
    const supabaseRestUrl = supabaseUrl ? supabaseUrl + "/rest/v1" : "";
    const cartKey = "mateus-fictitious-cart-v2";
    const cartMetaKey = "mateus-fictitious-cart-meta-v1";
    const clientKey = "mateus-selected-client-v1";
    const authSessionKey = "mateus-auth-session-v1";
    const supabaseSessionKey = "mateus-supabase-session-v1";
    const localClientBaseKey = "mateus-local-client-base-v1";
    const authEmail = (encryptedClientBase && encryptedClientBase.email) || "max.distac@gmail.com";
    const cartItems = document.getElementById("cartItems");
    const cartCount = document.getElementById("cartCount");
    const cartBadge = document.getElementById("cartBadge");
    const cartTotalQty = document.getElementById("cartTotalQty");
    const cartTotalValue = document.getElementById("cartTotalValue");
    const requestText = document.getElementById("requestText");
    const importCartPdfButton = document.getElementById("importCartPdf");
    const importCartPdfFile = document.getElementById("importCartPdfFile");
    const clientSearch = document.getElementById("clientSearch");
    const clientOptions = document.getElementById("clientOptions");
    const clientHint = document.getElementById("clientHint");
    const changePasswordButton = document.getElementById("changePassword");
    const logoutButton = document.getElementById("logout");
    const linePattern = document.getElementById("linePattern");
    const linePrice = document.getElementById("linePrice");
    const pwaStatus = document.getElementById("pwaStatus");
    let cart = readCart();
    let selectedClientCode = localStorage.getItem(clientKey) || "";
    let pdfJsLibPromise = null;
    let supabaseSession = null;
    let cloudSaveTimer = null;
    let cloudSyncInFlight = false;
    let cloudSyncQueued = false;
    let cloudErrorShown = false;

    document.querySelectorAll("[data-view-target]").forEach((button) => {
      button.addEventListener("click", () => setActiveView(button.dataset.viewTarget));
    });
    window.addEventListener("hashchange", () => setActiveView(viewFromHash(), { updateHash: false }));
    window.addEventListener("resize", updateStickyOffsets);
    window.addEventListener("online", () => scheduleCloudCartSync({ immediate: true }));
    updateStickyOffsets();
    initializeCatalog();

    input.addEventListener("input", () => {
      const tokens = normalizeForMatch(input.value).split(" ").filter(Boolean);
      for (const card of cards) {
        const haystack = card.dataset.search || "";
        const matches = tokens.length === 0 || tokens.every((token) => haystack.includes(token));
        card.classList.toggle("hidden", !matches);
      }
      for (const section of sections) {
        const visible = section.querySelector(".product-card:not(.hidden)");
        section.classList.toggle("hidden", !visible && tokens.length > 0);
      }
    });

    document.addEventListener("click", (event) => {
      const addButton = event.target.closest("[data-add-key]");
      const removeButton = event.target.closest("[data-remove-key]");

      if (addButton) {
        addToCart(addButton.dataset.addKey);
      }
      if (removeButton) {
        delete cart[removeButton.dataset.removeKey];
        saveCart();
      }
    });

    document.addEventListener("change", (event) => {
      const qtyInput = event.target.closest("[data-cart-qty]");
      const priceInput = event.target.closest("[data-cart-price]");
      const cardQtyInput = event.target.closest("[data-card-qty]");

      if (cardQtyInput) {
        const product = productsByKey.get(cardQtyInput.dataset.cardQty);
        const qty = normalizeQty(cardQtyInput.value, product);
        cardQtyInput.value = qty;
        if (cart[cardQtyInput.dataset.cardQty]) {
          cart[cardQtyInput.dataset.cardQty].qty = qty;
          saveCart();
        }
      }
      if (qtyInput) {
        const product = productsByKey.get(qtyInput.dataset.cartQty);
        cart[qtyInput.dataset.cartQty].qty = normalizeQty(qtyInput.value, product);
        saveCart();
      }
      if (priceInput) {
        const price = parseMoney(priceInput.value);
        cart[priceInput.dataset.cartPrice].negotiatedPrice = price;
        saveCart();
      }
    });

    document.getElementById("clearCart").addEventListener("click", () => {
      cart = {};
      saveCart();
    });

    window.addEventListener("online", () => {
      if (supabaseEnabled && supabaseSession?.user?.id) {
        initializeCloudCart();
      }
    });

    document.getElementById("exportImportCart").addEventListener("click", exportImportCart);
    if (importCartPdfButton && importCartPdfFile) {
      importCartPdfButton.addEventListener("click", () => importCartPdfFile.click());
      importCartPdfFile.addEventListener("change", () => {
        const file = importCartPdfFile.files && importCartPdfFile.files[0];
        if (file) {
          importCartFromPdf(file).finally(() => {
            importCartPdfFile.value = "";
          });
        }
      });
    }

    linePattern.addEventListener("input", () => {
      const suggested = suggestedPriceForLine(linePattern.value);
      if (suggested != null) {
        linePrice.value = formatMoney(suggested);
      }
    });

    document.getElementById("applyLinePrice").addEventListener("click", () => {
      const pattern = linePattern.value;
      const price = parseMoney(linePrice.value);
      if (!pattern.trim() || price == null) {
        return;
      }
      for (const key of Object.keys(cart)) {
        const product = productsByKey.get(key);
        if (product && matchesLine(pattern, product)) {
          cart[key].negotiatedPrice = price;
        }
      }
      saveCart();
    });

    if (clientSearch) {
      clientSearch.addEventListener("input", updateSelectedClientFromSearch);
      clientSearch.addEventListener("change", updateSelectedClientFromSearch);
    }
    if (logoutButton) {
      logoutButton.addEventListener("click", logoutCatalog);
    }
    if (changePasswordButton) {
      changePasswordButton.addEventListener("click", changeCatalogPassword);
    }

    document.getElementById("copyRequest").addEventListener("click", async () => {
      requestText.select();
      try {
        await navigator.clipboard.writeText(requestText.value);
      } catch {
        document.execCommand("copy");
      }
    });

    async function initializeCatalog() {
      if (supabaseEnabled) {
        supabaseSession = await restoreSupabaseSession();
        if (supabaseSession) {
          const savedClientSession = readAuthSession();
          if (savedClientSession) {
            unlockCatalog(savedClientSession.clients, { saveSession: false, syncCloud: true });
            return;
          }
          const cloudClients = await loadCloudClientBase();
          if (cloudClients.length) {
            unlockCatalog(cloudClients, {
              saveSession: true,
              email: supabaseSession.user?.email || authEmail,
              syncCloud: true,
              skipClientBaseUpload: true,
            });
            return;
          }
          setupAuthGate();
          showPwaStatus("Sessao Supabase ativa. Abra o catalogo uma vez no aparelho que ja tem a base para sincronizar os clientes.");
          return;
        }
        setupAuthGate();
        return;
      }

      const savedClientSession = readAuthSession();
      if (savedClientSession) {
        unlockCatalog(savedClientSession.clients, { saveSession: false });
        return;
      }
      if (encryptedClientBase || readLocalClientBase()) {
        setupAuthGate();
        return;
      }
      unlockCatalog(clients, { saveSession: false });
    }

    function setupAuthGate() {
      const form = document.getElementById("authForm");
      const emailInput = document.getElementById("authEmail");
      const passwordInput = document.getElementById("authPassword");
      const error = document.getElementById("authError");
      const localBase = readLocalClientBase();
      const loginBase = localBase || encryptedClientBase;
      if (emailInput) {
        emailInput.value = (loginBase && loginBase.email) || authEmail;
      }
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        error.textContent = "";
        const emailValue = emailInput.value.trim();
        const email = normalizeForMatch(emailValue);
        let decrypted = null;
        try {
          if (supabaseEnabled) {
            try {
              supabaseSession = await signInSupabase(emailValue, passwordInput.value);
            } catch (authError) {
              console.error(authError);
              error.textContent = "Supabase recusou o login. Confira se o usuario existe, se o email foi confirmado e se a senha esta correta.";
              return;
            }
          } else if (!loginBase || email !== normalizeForMatch(loginBase.email || authEmail)) {
            error.textContent = "Email ou senha incorretos.";
            return;
          }
          try {
            decrypted = await decryptClientBase(loginBase, passwordInput.value);
          } catch (decryptError) {
            console.error(decryptError);
            if (supabaseEnabled) {
              const cloudClients = await loadCloudClientBase({ showError: false });
              if (cloudClients.length) {
                unlockCatalog(cloudClients, {
                  saveSession: true,
                  email: emailValue || authEmail,
                  syncCloud: true,
                  skipClientBaseUpload: true,
                });
                passwordInput.value = "";
                return;
              }
              error.textContent =
                "Login aceito no Supabase, mas a base de clientes ainda nao esta sincronizada. Abra uma vez no aparelho que ja entra no catalogo.";
            } else {
              error.textContent = "Email ou senha incorretos.";
            }
            return;
          }
          unlockCatalog(decrypted.clients || decrypted, {
            saveSession: true,
            email: emailValue || loginBase.email || authEmail,
            syncCloud: supabaseEnabled,
          });
          passwordInput.value = "";
        } catch (unexpectedError) {
          console.error(unexpectedError);
          error.textContent = "Nao consegui abrir o catalogo. Tente novamente.";
        }
      });
    }

    function unlockCatalog(unlockedClients, options = {}) {
      clients = mergeBrowserClients(clients, unlockedClients || []);
      clientsByCode = new Map(clients.map((client) => [client.code, client]));
      document.body.dataset.auth = "open";
      setupClientSearch();
      setActiveView(viewFromHash(), { updateHash: false, keepScroll: true });
      renderCart();
      if (options.saveSession) {
        saveAuthSession(options.email || authEmail);
      }
      if (options.syncCloud && supabaseEnabled && supabaseSession) {
        const cartSync = initializeCloudCart();
        if (!options.skipClientBaseUpload) {
          cartSync.finally(() => syncCloudClientBase());
        }
      }
      registerOfflineCache();
    }

    async function restoreSupabaseSession() {
      const saved = readSupabaseSession();
      if (!saved) {
        return null;
      }
      if (saved.expires_at && saved.expires_at * 1000 > Date.now() + 60000) {
        return saved;
      }
      if (!saved.refresh_token) {
        localStorage.removeItem(supabaseSessionKey);
        return null;
      }
      try {
        return await refreshSupabaseSession(saved.refresh_token);
      } catch {
        if (navigator.onLine === false) {
          return saved;
        }
        localStorage.removeItem(supabaseSessionKey);
        return null;
      }
    }

    function readSupabaseSession() {
      try {
        const session = JSON.parse(localStorage.getItem(supabaseSessionKey) || "null");
        return session && session.access_token && session.user ? session : null;
      } catch {
        localStorage.removeItem(supabaseSessionKey);
        return null;
      }
    }

    function saveSupabaseSession(session) {
      if (!session || !session.access_token) {
        return null;
      }
      const normalized = {
        access_token: session.access_token,
        refresh_token: session.refresh_token || supabaseSession?.refresh_token || "",
        expires_at: session.expires_at || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600),
        user: session.user || supabaseSession?.user,
      };
      localStorage.setItem(supabaseSessionKey, JSON.stringify(normalized));
      return normalized;
    }

    async function signInSupabase(email, password) {
      const response = await supabaseAuthRequest("/token?grant_type=password", {
        method: "POST",
        body: { email, password },
      });
      return saveSupabaseSession(response);
    }

    async function refreshSupabaseSession(refreshToken) {
      const response = await supabaseAuthRequest("/token?grant_type=refresh_token", {
        method: "POST",
        body: { refresh_token: refreshToken },
      });
      return saveSupabaseSession(response);
    }

    async function signOutSupabase() {
      if (!supabaseSession?.access_token) {
        return;
      }
      await supabaseAuthRequest("/logout", {
        method: "POST",
        auth: true,
      });
    }

    async function updateSupabasePassword(password) {
      await supabaseAuthRequest("/user", {
        method: "PUT",
        auth: true,
        body: { password },
      });
    }

    async function supabaseAuthRequest(path, options = {}) {
      return supabaseRequest(supabaseAuthUrl + path, options);
    }

    async function supabaseRestRequest(path, options = {}) {
      return supabaseRequest(supabaseRestUrl + path, { ...options, auth: true });
    }

    async function supabaseRequest(url, options = {}) {
      const headers = {
        apikey: supabaseConfig.anonKey,
        Authorization: "Bearer " + (options.auth && supabaseSession?.access_token ? supabaseSession.access_token : supabaseConfig.anonKey),
        "Content-Type": "application/json",
        ...(options.headers || {}),
      };
      if (options.auth && supabaseSession?.access_token) {
        headers.Authorization = "Bearer " + supabaseSession.access_token;
      }
      const response = await fetch(url, {
        method: options.method || "GET",
        headers,
        body: options.body == null ? undefined : JSON.stringify(options.body),
      });
      if (response.status === 401 && options.auth && supabaseSession?.refresh_token && !options.retry) {
        supabaseSession = await refreshSupabaseSession(supabaseSession.refresh_token);
        return supabaseRequest(url, { ...options, retry: true });
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        let message = text;
        try {
          const parsed = JSON.parse(text);
          message = parsed.msg || parsed.message || parsed.error_description || parsed.error || text;
        } catch {}
        throw new Error(message || "Supabase HTTP " + response.status);
      }
      if (response.status === 204) {
        return null;
      }
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }

    function readAuthSession() {
      try {
        const session = JSON.parse(localStorage.getItem(authSessionKey) || "null");
        if (session && Array.isArray(session.clients) && session.clients.length) {
          return session;
        }
      } catch {
        localStorage.removeItem(authSessionKey);
      }
      return null;
    }

    function saveAuthSession(email) {
      try {
        localStorage.setItem(
          authSessionKey,
          JSON.stringify({
            email: email || authEmail,
            savedAt: new Date().toISOString(),
            clients,
          }),
        );
      } catch {
        showPwaStatus("Nao consegui salvar a sessao neste aparelho.");
      }
    }

    function readLocalClientBase() {
      try {
        return JSON.parse(localStorage.getItem(localClientBaseKey) || "null");
      } catch {
        localStorage.removeItem(localClientBaseKey);
        return null;
      }
    }

    function logoutCatalog() {
      if (supabaseEnabled) {
        signOutSupabase().catch(() => {});
      }
      supabaseSession = null;
      localStorage.removeItem(supabaseSessionKey);
      localStorage.removeItem(authSessionKey);
      document.body.dataset.auth = encryptedClientBase || readLocalClientBase() ? "locked" : "open";
      window.location.reload();
    }

    async function changeCatalogPassword() {
      if (supabaseEnabled) {
        await changeSupabasePassword();
        return;
      }
      await changeLocalPassword();
    }

    async function changeSupabasePassword() {
      if (!supabaseSession) {
        showPwaStatus("Entre novamente para trocar a senha.");
        return;
      }
      const first = window.prompt("Digite a nova senha:");
      if (!first) {
        return;
      }
      if (first.length < 6) {
        showPwaStatus("Use uma senha com pelo menos 6 caracteres.");
        return;
      }
      const second = window.prompt("Repita a nova senha:");
      if (first !== second) {
        showPwaStatus("As senhas nao conferem.");
        return;
      }
      try {
        await updateSupabasePassword(first);
        if (clients.length) {
          const sealed = await encryptClientBase({ clients }, first, authEmail);
          localStorage.setItem(localClientBaseKey, JSON.stringify(sealed));
          saveAuthSession(authEmail);
        }
        showPwaStatus("Senha alterada no Supabase e neste aparelho.");
      } catch {
        showPwaStatus("Nao consegui trocar a senha no Supabase.");
      }
    }

    async function changeLocalPassword() {
      if (!clients.length) {
        showPwaStatus("Entre no catalogo antes de trocar a senha.");
        return;
      }
      const first = window.prompt("Digite a nova senha para este aparelho:");
      if (!first) {
        return;
      }
      if (first.length < 6) {
        showPwaStatus("Use uma senha com pelo menos 6 caracteres.");
        return;
      }
      const second = window.prompt("Repita a nova senha:");
      if (first !== second) {
        showPwaStatus("As senhas nao conferem.");
        return;
      }
      try {
        const sealed = await encryptClientBase({ clients }, first, authEmail);
        localStorage.setItem(localClientBaseKey, JSON.stringify(sealed));
        saveAuthSession(authEmail);
        showPwaStatus("Senha alterada neste aparelho. Use Sair para testar o novo acesso.");
      } catch {
        showPwaStatus("Nao consegui trocar a senha neste navegador.");
      }
    }

    async function decryptClientBase(sealed, password) {
      const encoder = new TextEncoder();
      const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
        "deriveKey",
      ]);
      const key = await crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          salt: base64ToBytes(sealed.salt),
          iterations: sealed.iterations || 210000,
          hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"],
      );
      const cipherBytes = concatBytes([base64ToBytes(sealed.ciphertext), base64ToBytes(sealed.tag)]);
      const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(sealed.iv) }, key, cipherBytes);
      return JSON.parse(new TextDecoder().decode(plainBuffer));
    }

    async function encryptClientBase(payload, password, email) {
      const encoder = new TextEncoder();
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
        "deriveKey",
      ]);
      const key = await crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          salt,
          iterations: 210000,
          hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"],
      );
      const sealedBytes = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(payload))),
      );
      const tagLength = 16;
      return {
        version: 1,
        source: "local-browser",
        email: email || authEmail,
        algorithm: "AES-256-GCM",
        kdf: "PBKDF2-SHA256",
        iterations: 210000,
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
        tag: bytesToBase64(sealedBytes.slice(sealedBytes.length - tagLength)),
        ciphertext: bytesToBase64(sealedBytes.slice(0, sealedBytes.length - tagLength)),
      };
    }

    function base64ToBytes(value) {
      return Uint8Array.from(atob(value || ""), (char) => char.charCodeAt(0));
    }

    function bytesToBase64(bytes) {
      let binary = "";
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      return btoa(binary);
    }

    function mergeBrowserClients(...lists) {
      const byCode = new Map();
      for (const client of lists.flat().filter(Boolean)) {
        const code = String(client.code || "").trim();
        const name = String(client.name || "").replace(/\s+/g, " ").trim();
        if (!code || !name) {
          continue;
        }
        const current = byCode.get(code) || {};
        byCode.set(code, {
          ...current,
          ...client,
          code,
          name,
          selected: Boolean(current.selected || client.selected),
        });
      }
      return [...byCode.values()].sort((a, b) => {
        if (a.selected !== b.selected) return a.selected ? -1 : 1;
        return a.name.localeCompare(b.name, "pt-BR");
      });
    }

    function viewFromHash() {
      const view = (window.location.hash || "").replace("#", "");
      return ["products", "cart", "summary"].includes(view) ? view : "products";
    }

    function setActiveView(view, options = {}) {
      document.body.dataset.activeView = view;
      document.querySelectorAll("[data-view-target]").forEach((button) => {
        button.classList.toggle("active", button.dataset.viewTarget === view);
      });
      if (options.updateHash !== false && window.location.hash !== "#" + view) {
        history.replaceState(null, "", "#" + view);
      }
      if (!options.keepScroll) {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      updateStickyOffsets();
    }

    function updateStickyOffsets() {
      const header = document.querySelector("header");
      if (header) {
        document.documentElement.style.setProperty("--header-height", header.offsetHeight + "px");
      }
    }

    function setupClientSearch() {
      const saved = selectedClientCode || localStorage.getItem(clientKey) || "";
      const defaultClient = clients.find((client) => client.selected) || clients[0];
      selectedClientCode = saved && clientsByCode.has(saved) ? saved : defaultClient?.code || "";
      renderClientOptions(clients);
      syncClientSearchInput();
      localStorage.setItem(clientKey, selectedClientCode || "");
    }

    function renderClientOptions(list) {
      if (!clientOptions) {
        return;
      }
      const options = ['<option value="Cliente padrão do modelo"></option>'].concat(
        list.slice(0, 500).map((client) => '<option value="' + escapeText(clientLabel(client)) + '"></option>'),
      );
      clientOptions.innerHTML = options.join("");
    }

    function updateSelectedClientFromSearch() {
      if (!clientSearch) {
        return;
      }
      const value = clientSearch.value || "";
      const directCode = clientCodeFromText(value);
      if (!value.trim() || normalizeForMatch(value) === normalizeForMatch("Cliente padrão do modelo")) {
        selectedClientCode = "";
        localStorage.setItem(clientKey, "");
        setClientHint("");
        renderCart();
        scheduleCloudCartSync();
        return;
      }
      if (directCode && clientsByCode.has(directCode)) {
        selectedClientCode = directCode;
        localStorage.setItem(clientKey, selectedClientCode);
        setClientHint("Cliente selecionado.");
        renderCart();
        scheduleCloudCartSync();
        return;
      }

      const matches = findClientMatches(value, 20);
      renderClientOptions(matches.length ? matches : clients);
      if (matches.length === 1) {
        selectedClientCode = matches[0].code;
        localStorage.setItem(clientKey, selectedClientCode);
        setClientHint("Cliente selecionado.");
      } else {
        selectedClientCode = "";
        localStorage.setItem(clientKey, "");
        setClientHint(matches.length ? matches.length + " cliente(s) encontrado(s). Escolha um da lista." : "Nenhum cliente encontrado.");
      }
      renderCart();
      scheduleCloudCartSync();
    }

    function syncClientSearchInput() {
      if (!clientSearch) {
        return;
      }
      const client = clientsByCode.get(selectedClientCode || "");
      clientSearch.value = client ? clientLabel(client) : "Cliente padrão do modelo";
      setClientHint(client ? "" : "Sem cliente especifico no modelo.");
    }

    function setClientHint(message) {
      if (clientHint) {
        clientHint.textContent = message || "";
      }
    }

    function clientCodeFromText(value) {
      const match = String(value || "").match(/^\s*(\d{4,})\b/);
      return match ? match[1] : "";
    }

    function findClientMatches(query, limit = 20) {
      const tokens = normalizeForMatch(query).split(" ").filter(Boolean);
      if (!tokens.length) {
        return [];
      }
      return clients
        .filter((client) => {
          const haystack = normalizeForMatch([client.code, client.document, client.name, client.tradeName].join(" "));
          return tokens.every((token) => haystack.includes(token));
        })
        .slice(0, limit);
    }

    function clientLabel(client) {
      return client ? client.code + " - " + client.name : "";
    }

    function addToCart(key) {
      const product = productsByKey.get(key);
      if (!product) {
        return;
      }
      const input = document.querySelector('[data-card-qty="' + cssEscape(key) + '"]');
      const qty = normalizeQty(input ? input.value : product.minQty, product);
      const current = cart[key] || { qty: 0, negotiatedPrice: product.priceNumber };
      current.qty = qty;
      if (current.negotiatedPrice == null) {
        current.negotiatedPrice = product.priceNumber;
      }
      cart[key] = current;
      saveCart();
    }

    function readCart() {
      try {
        return JSON.parse(localStorage.getItem(cartKey) || "{}");
      } catch {
        return {};
      }
    }

    function saveCart(options = {}) {
      if (!options.keepTimestamp) {
        localStorage.setItem(cartMetaKey, JSON.stringify({ updatedAt: new Date().toISOString() }));
      }
      localStorage.setItem(cartKey, JSON.stringify(cart));
      renderCart();
      if (!options.skipCloud) {
        scheduleCloudCartSync();
      }
    }

    function readCartMeta() {
      try {
        return JSON.parse(localStorage.getItem(cartMetaKey) || "{}");
      } catch {
        return {};
      }
    }

    async function loadCloudClientBase(options = {}) {
      if (!supabaseEnabled || !supabaseSession?.user?.id) {
        return [];
      }
      if (navigator.onLine === false) {
        if (options.showError !== false) {
          showPwaStatus("Sem internet. Nao consegui carregar a base de clientes do Supabase.");
        }
        return [];
      }
      try {
        const rows = await supabaseRestRequest(
          "/cart_states?user_id=eq." + encodeURIComponent(supabaseSession.user.id) + "&select=client_base",
        );
        const clientBase = rows && rows[0] && rows[0].client_base;
        const loadedClients = clientBase && Array.isArray(clientBase.clients) ? clientBase.clients : Array.isArray(clientBase) ? clientBase : [];
        return mergeBrowserClients(loadedClients);
      } catch (error) {
        console.error(error);
        if (options.showError !== false) {
          showPwaStatus("Nao consegui carregar a base de clientes do Supabase. Rode o setup.sql atualizado.");
        }
        return [];
      }
    }

    async function syncCloudClientBase() {
      if (!supabaseEnabled || !supabaseSession?.user?.id || !clients.length) {
        return;
      }
      if (navigator.onLine === false) {
        return;
      }
      try {
        await supabaseRestRequest("/cart_states?on_conflict=user_id", {
          method: "POST",
          headers: {
            Prefer: "resolution=merge-duplicates",
          },
          body: {
            user_id: supabaseSession.user.id,
            client_base: {
              clients,
              updated_at: new Date().toISOString(),
            },
          },
        });
      } catch (error) {
        console.error(error);
        showPwaStatus("Nao consegui enviar a base de clientes ao Supabase. Rode o setup.sql atualizado.");
      }
    }

    async function initializeCloudCart() {
      if (!supabaseEnabled || !supabaseSession?.user?.id) {
        return;
      }
      if (navigator.onLine === false) {
        showPwaStatus("Sem internet. Carrinho local sera sincronizado quando voltar.");
        return;
      }
      try {
        const rows = await supabaseRestRequest(
          "/cart_states?user_id=eq." + encodeURIComponent(supabaseSession.user.id) + "&select=cart,selected_client_code,updated_at",
        );
        if (Array.isArray(rows) && rows[0]) {
          mergeCloudCart(rows[0]);
        } else {
          await scheduleCloudCartSync({ immediate: true });
        }
      } catch (error) {
        console.error(error);
        showCloudError();
      }
    }

    function mergeCloudCart(row) {
      const remoteCart = row && row.cart && typeof row.cart === "object" ? row.cart : {};
      const localCart = cart && typeof cart === "object" && !Array.isArray(cart) ? cart : {};
      const localMeta = readCartMeta();
      const remoteTime = Date.parse(row.updated_at || "") || 0;
      const localTime = Date.parse(localMeta.updatedAt || "") || 0;
      const remoteWins = remoteTime > localTime;
      cart = remoteWins ? { ...remoteCart } : { ...localCart };
      if (row.selected_client_code && (remoteWins || !selectedClientCode)) {
        selectedClientCode = String(row.selected_client_code);
        localStorage.setItem(clientKey, selectedClientCode);
        syncClientSearchInput();
      }
      localStorage.setItem(
        cartMetaKey,
        JSON.stringify({ updatedAt: new Date(remoteWins ? remoteTime : Math.max(localTime, Date.now())).toISOString() }),
      );
      saveCart({ skipCloud: true, keepTimestamp: true });
      if (!remoteWins) {
        scheduleCloudCartSync({ immediate: true });
      }
    }

    function scheduleCloudCartSync(options = {}) {
      if (!supabaseEnabled || !supabaseSession?.user?.id) {
        return;
      }
      if (cloudSaveTimer) {
        window.clearTimeout(cloudSaveTimer);
      }
      if (options.immediate) {
        return syncCloudCart();
      }
      cloudSaveTimer = window.setTimeout(syncCloudCart, 900);
      return null;
    }

    async function syncCloudCart() {
      if (!supabaseEnabled || !supabaseSession?.user?.id) {
        return;
      }
      if (navigator.onLine === false) {
        showPwaStatus("Sem internet. Carrinho salvo localmente.");
        return;
      }
      if (cloudSyncInFlight) {
        cloudSyncQueued = true;
        return;
      }
      cloudSyncInFlight = true;
      try {
        await supabaseRestRequest("/cart_states?on_conflict=user_id", {
          method: "POST",
          headers: {
            Prefer: "resolution=merge-duplicates",
          },
          body: {
            user_id: supabaseSession.user.id,
            cart,
            selected_client_code: selectedClientCode || null,
            updated_at: new Date().toISOString(),
          },
        });
        cloudErrorShown = false;
      } catch (error) {
        console.error(error);
        showCloudError();
      } finally {
        cloudSyncInFlight = false;
        if (cloudSyncQueued) {
          cloudSyncQueued = false;
          scheduleCloudCartSync({ immediate: true });
        }
      }
    }

    function showCloudError() {
      if (!cloudErrorShown) {
        showPwaStatus("Nao consegui sincronizar com Supabase. Verifique a tabela cart_states e a internet.");
      }
      cloudErrorShown = true;
    }

    function cartEntries() {
      return Object.entries(cart)
        .map(([key, item]) => ({ key, item, product: productsByKey.get(key) }))
        .filter((entry) => entry.product);
    }

    function renderCart() {
      const entries = cartEntries();

      cartCount.textContent = String(entries.length);
      cartBadge.textContent = String(entries.length);
      cartItems.innerHTML = entries.length
        ? entries.map(renderCartRow).join("")
        : '<div class="empty">Nenhum item no carrinho.</div>';

      let totalQty = 0;
      let totalValue = 0;
      for (const entry of entries) {
        const qty = normalizeQty(entry.item.qty, entry.product);
        const price = entry.item.negotiatedPrice ?? entry.product.priceNumber ?? 0;
        totalQty += qty;
        totalValue += qty * price;
      }
      cartTotalQty.textContent = String(totalQty);
      cartTotalValue.textContent = "R$ " + formatMoney(totalValue);
      requestText.value = buildRequestText(entries);
      updateProductButtons(entries);
      if (linePattern.value.trim() && document.activeElement !== linePrice) {
        const suggested = suggestedPriceForLine(linePattern.value);
        if (suggested != null) {
          linePrice.value = formatMoney(suggested);
        }
      }
    }

    function updateProductButtons(entries) {
      const quantities = new Map(entries.map((entry) => [entry.key, normalizeQty(entry.item.qty, entry.product)]));
      document.querySelectorAll("[data-add-key]").forEach((button) => {
        const qty = quantities.get(button.dataset.addKey) || 0;
        button.textContent = qty ? "Adicionado" : "Adicionar";
        button.classList.toggle("in-cart", Boolean(qty));
        button.setAttribute("aria-label", qty ? "Item adicionado ao carrinho" : "Adicionar ao carrinho");
        const input = document.querySelector('[data-card-qty="' + cssEscape(button.dataset.addKey) + '"]');
        if (input && qty) {
          input.value = qty;
        }
      });
      document.querySelectorAll("[data-added-key]").forEach((note) => {
        const qty = quantities.get(note.dataset.addedKey) || 0;
        note.textContent = qty ? "No carrinho: " + qty : "";
        note.classList.toggle("hidden", !qty);
      });
    }

    function renderCartRow(entry) {
      const product = entry.product;
      const item = entry.item;
      const qty = normalizeQty(item.qty, product);
      const price = item.negotiatedPrice ?? product.priceNumber;
      const maxAttr = product.maxQty ? ' max="' + product.maxQty + '"' : "";
      const image = product.localImage || product.image || "";
      const fallbackImage = product.localImage && product.image && product.localImage !== product.image ? product.image : "";
      const fallbackAttr = fallbackImage
        ? ' data-fallback-src="' + escapeText(fallbackImage) + '" onerror="if (this.dataset.fallbackSrc) { this.onerror = null; this.src = this.dataset.fallbackSrc; }"'
        : "";
      const thumb = image
        ? '<div class="cart-thumb"><img loading="lazy" src="' + escapeText(image) + '" alt="' + escapeText(product.name) + '"' + fallbackAttr + '></div>'
        : '<div class="cart-thumb"></div>';
      return '<div class="cart-row">'
        + '<div class="cart-name"><strong>' + escapeText(product.name) + '</strong><span>SKU: ' + escapeText(product.sku || "-") + ' | Min: ' + product.minQty + ' | Estoque: ' + escapeText(product.stock || String(product.stockNumber || "-")) + '</span></div>'
        + '<div class="cart-editors">'
        + '<input data-cart-qty="' + escapeText(entry.key) + '" type="number" min="' + product.minQty + '" step="' + product.minQty + '"' + maxAttr + ' value="' + qty + '">'
        + '<input data-cart-price="' + escapeText(entry.key) + '" type="text" inputmode="decimal" value="' + (price == null ? "" : formatMoney(price)) + '">'
        + '<button type="button" class="danger" data-remove-key="' + escapeText(entry.key) + '">Remover</button>'
        + '</div>'
        + thumb
        + '</div>';
    }

    function buildRequestText(entries) {
      const lines = entries
        .map((entry) => {
          const price = entry.item.negotiatedPrice ?? entry.product.priceNumber;
          return entry.product.sku && price != null ? entry.product.sku + "-" + formatMoney(price) : "";
        })
        .filter(Boolean);

      return [
        priceTemplate.title,
        "",
        priceTemplate.rca,
        "",
        selectedClientLine(),
        "",
        priceTemplate.supervisor,
        "",
        lines.join("\\n"),
      ].join("\\n");
    }

    async function importCartFromPdf(file) {
      try {
        showPwaStatus("Lendo PDF do carrinho...");
        const rows = await parseCartPdf(file);
        if (!rows.length) {
          showPwaStatus("Nao encontrei itens de carrinho nesse PDF.");
          return;
        }

        let imported = 0;
        const missing = [];
        for (const row of rows) {
          const product = productsBySku.get(String(row.sku));
          if (!product) {
            missing.push(row);
            continue;
          }
          const qty = normalizeQty(row.qty, product);
          cart[product.cartKey] = {
            qty,
            negotiatedPrice: row.price ?? product.priceNumber,
          };
          imported += 1;
        }

        saveCart();
        setActiveView("cart");
        const message = missing.length
          ? imported + " item(ns) importados. " + missing.length + " SKU(s) nao estao no catalogo atual."
          : imported + " item(ns) importados do PDF.";
        showPwaStatus(message);
        if (missing.length) {
          console.warn("SKUs do PDF nao encontrados no catalogo atual:", missing);
        }
      } catch (error) {
        console.error(error);
        const localFileMessage = window.location.protocol === "file:"
          ? " Abra pelo link do GitHub Pages para importar PDF."
          : "";
        showPwaStatus("Nao consegui importar esse PDF." + localFileMessage);
      }
    }

    async function parseCartPdf(file) {
      const pdfjsLib = await loadPdfJs();
      const data = new Uint8Array(await file.arrayBuffer());
      const loadingTask = pdfjsLib.getDocument({ data });
      const pdf = await loadingTask.promise;
      const rows = [];
      const seen = new Set();

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const items = content.items
          .map((item) => ({
            text: String(item.str || "").trim(),
            x: Number(item.transform && item.transform[4]) || 0,
            y: Number(item.transform && item.transform[5]) || 0,
          }))
          .filter((item) => item.text);

        for (const item of items) {
          if (!/^\\d{4,8}$/.test(item.text) || item.x < 90 || item.x > 165) {
            continue;
          }
          const lineItems = items.filter((candidate) => Math.abs(candidate.y - item.y) <= 3);
          const qtyItem = lineItems.find((candidate) => candidate.x >= 430 && candidate.x <= 510 && /^\\d+$/.test(candidate.text));
          const priceItem = lineItems.find((candidate) => candidate.x >= 520 && candidate.x <= 620 && /R\\$\\s*[\\d.,]+/.test(candidate.text));
          if (!qtyItem) {
            continue;
          }
          const sku = item.text;
          const key = pageNumber + ":" + sku + ":" + Math.round(item.y);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          rows.push({
            sku,
            qty: Number(qtyItem.text) || 1,
            price: priceItem ? parseMoney(priceItem.text) : null,
          });
        }
      }

      return rows;
    }

    async function loadPdfJs() {
      if (!pdfJsLibPromise) {
        pdfJsLibPromise = import("./pdfjs/pdf.min.mjs").then((pdfjsLib) => {
          pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdfjs/pdf.worker.min.mjs";
          return pdfjsLib;
        });
      }
      return pdfJsLibPromise;
    }

    function exportImportCart() {
      const entries = cartEntries();
      if (!entries.length) {
        showPwaStatus("Carrinho vazio. Adicione itens antes de exportar.");
        return;
      }

      const rows = [["sku", "quantidade"]];
      for (const entry of entries) {
        if (!entry.product.sku) {
          continue;
        }
        rows.push([String(entry.product.sku), normalizeQty(entry.item.qty, entry.product)]);
      }

      if (rows.length === 1) {
        showPwaStatus("Nenhum SKU válido no carrinho para exportar.");
        return;
      }

      const blob = createXlsxBlob(rows, "Página1");
      downloadBlob(blob, "import_cart_" + exportStamp() + ".xlsx");
    }

    function createXlsxBlob(rows, sheetName) {
      const sheetXml = buildWorksheetXml(rows);
      const files = [
        {
          name: "[Content_Types].xml",
          content:
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="xml" ContentType="application/xml"/>' +
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
            "</Types>",
        },
        {
          name: "_rels/.rels",
          content:
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
            "</Relationships>",
        },
        {
          name: "xl/workbook.xml",
          content:
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
            '<sheets><sheet name="' +
            xmlEscape(sheetName) +
            '" sheetId="1" r:id="rId1"/></sheets></workbook>',
        },
        {
          name: "xl/_rels/workbook.xml.rels",
          content:
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
            "</Relationships>",
        },
        {
          name: "xl/styles.xml",
          content:
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
            '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
            '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
            '<borders count="1"><border/></borders>' +
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
            '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
            '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
            '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
            "</styleSheet>",
        },
        { name: "xl/worksheets/sheet1.xml", content: sheetXml },
      ];

      return new Blob([createZip(files)], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
    }

    function buildWorksheetXml(rows) {
      const sheetRows = rows
        .map((row, rowIndex) => {
          const rowNumber = rowIndex + 1;
          const cells = row
            .map((value, colIndex) => {
              const cellRef = columnName(colIndex + 1) + rowNumber;
              if (typeof value === "number") {
                return '<c r="' + cellRef + '"><v>' + value + "</v></c>";
              }
              return '<c r="' + cellRef + '" t="inlineStr"><is><t>' + xmlEscape(value) + "</t></is></c>";
            })
            .join("");
          return '<row r="' + rowNumber + '">' + cells + "</row>";
        })
        .join("");

      return (
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<dimension ref="A1:B' +
        rows.length +
        '"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>' +
        "<sheetData>" +
        sheetRows +
        "</sheetData></worksheet>"
      );
    }

    function createZip(files) {
      const encoder = new TextEncoder();
      const localParts = [];
      const centralParts = [];
      let offset = 0;

      for (const file of files) {
        const nameBytes = encoder.encode(file.name);
        const dataBytes = typeof file.content === "string" ? encoder.encode(file.content) : file.content;
        const crc = crc32(dataBytes);
        const localHeader = zipHeader(0x04034b50, [
          20,
          0,
          0,
          0,
          0,
          crc,
          dataBytes.length,
          dataBytes.length,
          nameBytes.length,
          0,
        ]);
        localParts.push(localHeader, nameBytes, dataBytes);

        const centralHeader = zipHeader(0x02014b50, [
          20,
          20,
          0,
          0,
          0,
          0,
          crc,
          dataBytes.length,
          dataBytes.length,
          nameBytes.length,
          0,
          0,
          0,
          0,
          0,
          offset,
        ]);
        centralParts.push(centralHeader, nameBytes);
        offset += localHeader.length + nameBytes.length + dataBytes.length;
      }

      const centralSize = totalLength(centralParts);
      const end = zipHeader(0x06054b50, [0, 0, files.length, files.length, centralSize, offset, 0]);
      return concatBytes(localParts.concat(centralParts, [end]));
    }

    function zipHeader(signature, values) {
      const sizes =
        signature === 0x04034b50
          ? [2, 2, 2, 2, 2, 4, 4, 4, 2, 2]
          : signature === 0x02014b50
            ? [2, 2, 2, 2, 2, 2, 4, 4, 4, 2, 2, 2, 2, 2, 4, 4]
            : [2, 2, 2, 2, 4, 4, 2];
      const bytes = new Uint8Array(4 + sizes.reduce((sum, size) => sum + size, 0));
      const view = new DataView(bytes.buffer);
      view.setUint32(0, signature, true);
      let offset = 4;
      for (let index = 0; index < values.length; index += 1) {
        if (sizes[index] === 2) {
          view.setUint16(offset, values[index], true);
        } else {
          view.setUint32(offset, values[index], true);
        }
        offset += sizes[index];
      }
      return bytes;
    }

    function concatBytes(parts) {
      const output = new Uint8Array(totalLength(parts));
      let offset = 0;
      for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
      }
      return output;
    }

    function totalLength(parts) {
      return parts.reduce((sum, part) => sum + part.length, 0);
    }

    function crc32(bytes) {
      let crc = -1;
      for (const byte of bytes) {
        crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
      }
      return (crc ^ -1) >>> 0;
    }

    const crcTable = (() => {
      const table = [];
      for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
          c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
      }
      return table;
    })();

    function columnName(index) {
      let name = "";
      while (index > 0) {
        const remainder = (index - 1) % 26;
        name = String.fromCharCode(65 + remainder) + name;
        index = Math.floor((index - 1) / 26);
      }
      return name;
    }

    function xmlEscape(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function exportStamp() {
      const now = new Date();
      return [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
        "_",
        String(now.getHours()).padStart(2, "0"),
        String(now.getMinutes()).padStart(2, "0"),
      ].join("");
    }

    function selectedClientLine() {
      const client = clientsByCode.get(selectedClientCode || "");
      if (!client) {
        return priceTemplate.client;
      }
      return "Cliente: *" + client.code + "* - " + client.name;
    }

    function normalizeQty(value, product) {
      const max = Number(product.maxQty) || 0;
      let min = Number(product.minQty) || 1;
      if (max && max < min) {
        min = max;
      }
      let qty = Math.floor(Number(value) || min);
      if (qty < min) {
        qty = min;
      }
      const remainder = qty % min;
      if (remainder) {
        qty += min - remainder;
      }
      if (max && qty > max) {
        qty = max - (max % min);
        if (qty < min) {
          qty = max;
        }
      }
      return qty;
    }

    function parseMoney(value) {
      const cleaned = String(value || "").replace(/R\\$/g, "").replace(/\\s/g, "");
      if (!cleaned) {
        return null;
      }
      const normalized = cleaned.includes(",")
        ? cleaned.replace(/\\./g, "").replace(",", ".")
        : cleaned;
      const number = Number(normalized);
      return Number.isFinite(number) ? number : null;
    }

    function formatMoney(value) {
      return Number(value || 0).toLocaleString("pt-BR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }

    function matchesLine(pattern, product) {
      const haystack = normalizeForMatch([product.groupTitle, product.brand, product.name].join(" "));
      const tokens = normalizeForMatch(pattern).split(" ").filter(Boolean);
      return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
    }

    function suggestedPriceForLine(pattern) {
      const matches = cartEntries().filter((entry) => matchesLine(pattern, entry.product));
      if (!matches.length) {
        return null;
      }

      const prices = new Map();
      for (const entry of matches) {
        const price = entry.item.negotiatedPrice ?? entry.product.priceNumber;
        if (price == null || !Number.isFinite(Number(price))) {
          continue;
        }
        const key = Number(price).toFixed(2);
        prices.set(key, (prices.get(key) || 0) + 1);
      }

      const best = [...prices.entries()].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0];
      return best ? Number(best[0]) : null;
    }

    function normalizeForMatch(value) {
      return String(value || "")
        .normalize("NFD")
        .replace(/[\\u0300-\\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    }

    function cssEscape(value) {
      return String(value).replace(/["\\\\]/g, "\\\\$&");
    }

    function escapeText(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    async function registerOfflineCache() {
      if (!("serviceWorker" in navigator)) {
        return;
      }
      try {
        const registration = await navigator.serviceWorker.register("sw.js");
        if (navigator.serviceWorker.controller) {
          showPwaStatus("Catálogo preparado para uso offline neste aparelho.");
        } else {
          navigator.serviceWorker.addEventListener("controllerchange", () => {
            showPwaStatus("Catálogo preparado para uso offline neste aparelho.");
          }, { once: true });
        }
        if (registration.waiting) {
          registration.waiting.postMessage({ type: "SKIP_WAITING" });
        }
      } catch {
        // The catalog still works online if service worker registration is blocked.
      }
    }

    function showPwaStatus(message) {
      if (!pwaStatus) {
        return;
      }
      pwaStatus.textContent = message;
      pwaStatus.classList.add("show");
      window.setTimeout(() => pwaStatus.classList.remove("show"), 6000);
    }
  </script>
</body>
</html>`;
}

function renderGroup(group) {
  return `<section data-group="${escapeAttr(group.id)}">
  <h2>${escapeHtml(group.title)} (${group.products.length})</h2>
  ${
    group.products.length
      ? `<div class="grid">${group.products.map(renderProductCard).join("\n")}</div>`
      : `<div class="empty">Nenhum item disponível nesta coleta.</div>`
  }
</section>`;
}

function renderProductCard(product) {
  const search = normalizeText(
    [product.groupTitle, product.brand, product.name, product.measure, product.sku].join(" "),
  );
  const image = product.localImage || product.image;
  const fallbackImage =
    product.localImage && product.image && product.localImage !== product.image ? product.image : "";
  const fallbackAttr = fallbackImage
    ? ` data-fallback-src="${escapeAttr(fallbackImage)}" onerror="if (this.dataset.fallbackSrc) { this.onerror = null; this.src = this.dataset.fallbackSrc; }"`
    : "";
  const maxAttr = product.maxQty ? ` max="${escapeAttr(product.maxQty)}"` : "";
  const minSourceText =
    product.minQtySource === "site" ? "(site)" : product.minQtySource === "regra" ? "(regra)" : "(padrão)";
  return `<article class="product-card" data-search="${escapeAttr(search)}">
  <div class="image">${
    image
      ? `<img loading="lazy" src="${escapeAttr(image)}" alt="${escapeAttr(product.name)}"${fallbackAttr}>`
      : ""
  }</div>
  <div class="body">
    <div class="brand">${escapeHtml(product.brand || product.groupTitle)}</div>
    <div class="name">${escapeHtml(product.name)}</div>
    <div class="measure">${escapeHtml(product.measure || "Unidade")}</div>
    <div class="sku">SKU: ${escapeHtml(product.sku || "-")}</div>
    <div class="price">${escapeHtml(product.priceText || "Preço indisponível")}</div>
    <div class="stock"><span>Cx: ${escapeHtml(product.cx || "-")}</span><span>Estoque: <strong>${escapeHtml(
      product.stock || String(product.stockNumber ?? "-"),
    )}</strong></span></div>
    <div class="min-note">Mínimo carrinho: ${escapeHtml(product.minQty)} ${minSourceText}</div>
    <div class="added-note hidden" data-added-key="${escapeAttr(product.cartKey)}"></div>
    <div class="cart-controls">
      <input data-card-qty="${escapeAttr(product.cartKey)}" type="number" min="${escapeAttr(
        product.minQty,
      )}" step="${escapeAttr(product.minQty)}"${maxAttr} value="${escapeAttr(product.minQty)}">
      <button type="button" data-add-key="${escapeAttr(product.cartKey)}">Adicionar</button>
    </div>
  </div>
</article>`;
}

function buildWebManifest(config) {
  return `${JSON.stringify(
    {
      name: "Mateus Mais - Catálogo",
      short_name: "Mateus Catálogo",
      description: "Catálogo offline de produtos disponíveis no Força de Vendas.",
      start_url: "./",
      scope: "./",
      display: "standalone",
      background_color: "#f5f7fb",
      theme_color: "#0478d1",
      lang: "pt-BR",
      icons: [
        {
          src: "icon.svg",
          sizes: "any",
          type: "image/svg+xml",
          purpose: "any maskable",
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function buildServiceWorker(products, generatedAt, config = {}) {
  const localImages = [...new Set(products.map((product) => product.localImage).filter(Boolean))];
  const assets = [
    "./",
    "index.html",
    "catalogo.html",
    "produtos.csv",
    "produtos.json",
    "clientes.json",
    "resumo.txt",
    "manifest.webmanifest",
    "icon.svg",
    "pdfjs/pdf.min.mjs",
    "pdfjs/pdf.worker.min.mjs",
    ...localImages,
  ];
  const cacheName = `mateus-catalogo-${generatedAt.toISOString().replace(/[^0-9]/g, "").slice(0, 12)}`;
  const cacheLocalImages = config.downloadImages !== false;

  return `const CACHE_NAME = ${JSON.stringify(cacheName)};
const PRECACHE_ASSETS = ${JSON.stringify(assets, null, 2)};
const RUNTIME_CACHE = "mateus-runtime-images-v1";
const CACHE_LOCAL_IMAGES = ${JSON.stringify(cacheLocalImages)};

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const asset of PRECACHE_ASSETS) {
      try {
        await putCachedOrFetch(cache, asset);
      } catch (error) {
        console.warn("Falha ao salvar no cache", asset, error);
      }
    }
    await self.skipWaiting();
  })());
});

async function putCachedOrFetch(cache, asset) {
  const isImage = /(^|\\/)imagens\\//.test(asset) || /\\.(png|jpe?g|webp|gif|svg)(\\?|$)/i.test(asset);
  if (isImage) {
    const existing = await caches.match(asset);
    if (existing) {
      await cache.put(asset, existing.clone());
      return;
    }
    if (!CACHE_LOCAL_IMAGES) {
      return;
    }
  }
  await cache.add(new Request(asset, { cache: "reload" }));
}

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([CACHE_NAME, RUNTIME_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter((name) => !keep.has(name)).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        cache.put("index.html", response.clone());
        return response;
      } catch {
        return (await caches.match("index.html")) || (await caches.match("catalogo.html"));
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }

    try {
      const response = await fetch(request);
      const url = new URL(request.url);
      const isImage = request.destination === "image" || /\\.(png|jpe?g|webp|gif|svg)(\\?|$)/i.test(url.pathname);
      const sameOrigin = url.origin === self.location.origin;
      if ((sameOrigin || isImage) && response && response.status < 500) {
        const cache = await caches.open(isImage ? RUNTIME_CACHE : CACHE_NAME);
        cache.put(request, response.clone());
      }
      return response;
    } catch {
      return caches.match("index.html");
    }
  })());
});
`;
}

function buildIconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#0478d1"/>
  <path d="M137 175c0-42 34-76 76-76 22 0 43 10 57 26 14-16 35-26 57-26 42 0 76 34 76 76 0 89-133 164-133 164S137 264 137 175Z" fill="none" stroke="#fff" stroke-width="38" stroke-linejoin="round"/>
  <path d="M150 390h212" stroke="#fff" stroke-width="32" stroke-linecap="round"/>
  <path d="M178 433h156" stroke="#fff" stroke-width="24" stroke-linecap="round" opacity=".9"/>
</svg>
`;
}

async function maybeSendTelegram(config, summary, files) {
  if (!config.telegram?.enabled) {
    return;
  }

  const token = process.env[config.telegram.botTokenEnv || "MATEUS_TELEGRAM_BOT_TOKEN"];
  const chatId = process.env[config.telegram.chatIdEnv || "MATEUS_TELEGRAM_CHAT_ID"];
  if (!token || !chatId) {
    console.log("Telegram não configurado; arquivos locais gerados normalmente.");
    return;
  }

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: summary.slice(0, 3500) }),
    });

    if (config.telegram.sendFiles) {
      for (const filePath of files) {
        await sendTelegramDocument(token, chatId, filePath);
      }
    }
  } catch (error) {
    console.warn(`Falha ao enviar para Telegram: ${error.message}`);
  }
}

async function sendTelegramDocument(token, chatId, filePath) {
  const form = new FormData();
  const bytes = await fs.readFile(filePath);
  form.append("chat_id", chatId);
  form.append("document", new Blob([bytes]), path.basename(filePath));
  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Telegram HTTP ${response.status}`);
  }
}

function zonedStamp(date, timeZone) {
  const parts = dateParts(date, timeZone);
  return {
    file: `${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}`,
  };
}

function formatDateTime(date, timeZone) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function dateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return parts;
}

function absoluteFromProject(value) {
  return path.isAbsolute(value) ? value : path.join(PROJECT_ROOT, value);
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function safeFilename(value) {
  return normalizeText(value).replace(/\s+/g, "-").slice(0, 80) || "produto";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function safeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

main().catch((error) => {
  console.error("");
  console.error(`Erro: ${error.message}`);
  if (process.env.DEBUG) {
    console.error(error.stack);
  }
  process.exitCode = 1;
});
