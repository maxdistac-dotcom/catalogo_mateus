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

    const input = page.getByPlaceholder("Encontre um cliente");
    if (await input.isVisible({ timeout: 5000 }).catch(() => false)) {
      await input.fill(String(clientCode));
      await page.keyboard.press("Enter").catch(() => {});
      await clickClientSearchIcon(page).catch(() => {});
      await page.waitForTimeout(1200);
    }

    const point = await getClientSelectPoint(page, clientCode);
    if (!point) {
      console.log(`Não encontrei o cliente ${clientCode} na lista visível.`);
      return;
    }

    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(800);
    await clickContinueClientSelection(page);
    console.log((await isClientModalOpen(page)) ? "Cliquei na seta do cliente, mas o modal ainda está aberto." : "Cliente selecionado.");
  } catch (error) {
    console.log(`Seleção automática não concluiu: ${error.message}`);
  }
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
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
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

  try {
    await ensureSalesContext(page, config, clientCode);

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
    },
  };
}

async function ensureSalesContext(page, config, clientCode) {
  console.log("Conferindo contexto do Força de Vendas...");
  await enterSalesForce(page, config);
  if (clientCode) {
    await trySelectClient(page, clientCode);
  }

  const clientModalOpen = await isClientModalOpen(page);
  if (clientModalOpen) {
    throw new Error(
      "O Força de Vendas está pedindo seleção de cliente. Rode `npm run login -- --client=CODIGO` ou selecione manualmente no login e salve a sessão antes de raspar.",
    );
  }
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
  const start = await getQuantityProbeState(page, sku);
  if (!start) {
    return { sku, error: "card não encontrado" };
  }

  if (start.minQty || start.maxQty) {
    return {
      sku,
      minQty: parseInteger(start.minQty),
      maxQty: parseInteger(start.maxQty),
      source: "site",
      wasAlreadyInCart: true,
    };
  }

  if (!start.addPoint) {
    return { sku, error: "botão de adicionar não encontrado" };
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
    if (state?.minQty || state?.maxQty || state?.trashPoint) {
      return state;
    }
    await page.waitForTimeout(150);
    state = await getQuantityProbeState(page, sku);
  }
  return state;
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

    return {
      sku: targetSku,
      minQty: input?.getAttribute("min") || "",
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
      output.push({ ...product, groupId: group.id, groupTitle: group.title });
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

  const summary = buildSummary(config, products, generatedAt, meta);
  const html = buildCatalogHtml(config, products, summary, generatedAt);
  const csv = buildCsv(products);
  const manifest = buildWebManifest(config);
  const serviceWorker = buildServiceWorker(products, generatedAt);
  const iconSvg = buildIconSvg();

  const runFiles = {
    html: path.join(runDir, "catalogo.html"),
    index: path.join(runDir, "index.html"),
    csv: path.join(runDir, "produtos.csv"),
    json: path.join(runDir, "produtos.json"),
    summary: path.join(runDir, "resumo.txt"),
    manifest: path.join(runDir, "manifest.webmanifest"),
    serviceWorker: path.join(runDir, "sw.js"),
    icon: path.join(runDir, "icon.svg"),
  };

  await fs.writeFile(runFiles.html, html, "utf8");
  await fs.writeFile(runFiles.index, html, "utf8");
  await fs.writeFile(runFiles.csv, "\uFEFF" + csv, "utf8");
  await fs.writeFile(runFiles.json, JSON.stringify({ generatedAt, meta, products }, null, 2), "utf8");
  await fs.writeFile(runFiles.summary, summary, "utf8");
  await fs.writeFile(runFiles.manifest, manifest, "utf8");
  await fs.writeFile(runFiles.serviceWorker, serviceWorker, "utf8");
  await fs.writeFile(runFiles.icon, iconSvg, "utf8");

  await publishLatest(outputRoot, runDir, runFiles);
  await maybeSendTelegram(config, summary, [runFiles.html, runFiles.csv]);

  console.log("");
  console.log(`Produtos disponíveis: ${products.length}`);
  console.log(`Catálogo: ${runFiles.html}`);
  console.log(`Planilha CSV: ${runFiles.csv}`);
}

async function publishLatest(outputRoot, runDir, runFiles) {
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.copyFile(runFiles.html, path.join(outputRoot, "catalogo.html"));
  await fs.copyFile(runFiles.index, path.join(outputRoot, "index.html"));
  await fs.copyFile(runFiles.csv, path.join(outputRoot, "produtos.csv"));
  await fs.copyFile(runFiles.summary, path.join(outputRoot, "resumo.txt"));
  await fs.copyFile(runFiles.manifest, path.join(outputRoot, "manifest.webmanifest"));
  await fs.copyFile(runFiles.serviceWorker, path.join(outputRoot, "sw.js"));
  await fs.copyFile(runFiles.icon, path.join(outputRoot, "icon.svg"));

  const latestImagesDir = path.join(outputRoot, "imagens");
  await fs.rm(latestImagesDir, { recursive: true, force: true });
  await copyDirectory(path.join(runDir, "imagens"), latestImagesDir);
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
    console.log("Imagens locais desativadas nesta execução.");
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

function buildCatalogHtml(config, products, summary, generatedAt) {
  const catalogProducts = products.map((product, index) => ({
    ...product,
    cartKey: product.sku || `item-${index + 1}`,
  }));
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
    }
    header {
      position: sticky;
      top: 0;
      z-index: 10;
      background: var(--paper);
      border-bottom: 1px solid var(--line);
      padding: 14px 18px;
    }
    .top {
      display: grid;
      grid-template-columns: 1fr minmax(220px, 420px);
      gap: 14px;
      align-items: center;
      max-width: 1180px;
      margin: 0 auto;
    }
    h1 {
      margin: 0;
      font-size: 22px;
      line-height: 1.2;
      letter-spacing: 0;
    }
    .date {
      margin-top: 4px;
      color: var(--muted);
      font-size: 13px;
    }
    input[type="search"] {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px 13px;
      font-size: 15px;
      background: #fff;
      color: var(--ink);
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
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 10px;
      margin-bottom: 18px;
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
    }
    .product-card {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      min-height: 100%;
      display: flex;
      flex-direction: column;
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
      grid-template-columns: 74px 1fr;
      gap: 8px;
      margin-top: 8px;
    }
    .cart-controls input,
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
    .min-note {
      color: var(--muted);
      font-size: 11px;
    }
    .cart-section {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      margin-bottom: 18px;
    }
    .cart-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 12px;
    }
    .cart-header h2 {
      margin: 0;
    }
    .rule-bar {
      display: grid;
      grid-template-columns: minmax(160px, 1fr) minmax(110px, 150px) auto;
      gap: 8px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #f8fafc;
      margin-bottom: 12px;
    }
    .cart-items {
      display: grid;
      gap: 8px;
    }
    .cart-row {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) 84px 116px auto;
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
    @media (max-width: 720px) {
      .top { grid-template-columns: 1fr; }
      header { padding: 12px; }
      main { padding: 12px; }
      .grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
      .rule-bar,
      .cart-row {
        grid-template-columns: 1fr;
      }
      .image { height: 120px; }
      .image img { max-height: 116px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="top">
      <div>
        <h1>Mateus Mais - Produtos disponíveis</h1>
        <div class="date">${escapeHtml(formatDateTime(generatedAt, config.timezone))}</div>
      </div>
      <input id="search" type="search" autocomplete="off" placeholder="Buscar produto, SKU, marca ou tamanho">
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
    <section class="cart-section" data-cart-panel>
      <div class="cart-header">
        <h2>Carrinho fictício (<span id="cartCount">0</span>)</h2>
        <button id="clearCart" type="button" class="danger">Limpar</button>
      </div>
      <div class="rule-bar">
        <input id="linePattern" type="text" autocomplete="off" placeholder="Linha de produto: Havaianas Brasil">
        <input id="linePrice" type="text" inputmode="decimal" autocomplete="off" placeholder="33,50">
        <button id="applyLinePrice" type="button">Aplicar preço</button>
      </div>
      <div id="cartItems" class="cart-items"></div>
      <div class="cart-total">
        <span>Itens: <strong id="cartTotalQty">0</strong></span>
        <span>Total negociado: <strong id="cartTotalValue">R$ 0,00</strong></span>
      </div>
      <div class="request-box">
        <textarea id="requestText" readonly></textarea>
        <button id="copyRequest" type="button" class="secondary">Copiar solicitação</button>
      </div>
    </section>
    ${groups.map(renderGroup).join("\n")}
  </main>
  <footer>${escapeHtml(summary)}</footer>
  <div id="pwaStatus" class="pwa-status"></div>
  <script type="application/json" id="products-data">${safeJsonForScript(catalogProducts)}</script>
  <script type="application/json" id="price-template">${safeJsonForScript(priceRequestTemplate)}</script>
  <script>
    const input = document.getElementById("search");
    const cards = Array.from(document.querySelectorAll(".product-card"));
    const sections = Array.from(document.querySelectorAll("section[data-group]"));
    const products = JSON.parse(document.getElementById("products-data").textContent);
    const productsByKey = new Map(products.map((product) => [product.cartKey, product]));
    const priceTemplate = JSON.parse(document.getElementById("price-template").textContent);
    const cartKey = "mateus-fictitious-cart-v2";
    const cartItems = document.getElementById("cartItems");
    const cartCount = document.getElementById("cartCount");
    const cartTotalQty = document.getElementById("cartTotalQty");
    const cartTotalValue = document.getElementById("cartTotalValue");
    const requestText = document.getElementById("requestText");
    const pwaStatus = document.getElementById("pwaStatus");
    let cart = readCart();

    input.addEventListener("input", () => {
      const query = input.value.normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().trim();
      for (const card of cards) {
        card.classList.toggle("hidden", query && !card.dataset.search.includes(query));
      }
      for (const section of sections) {
        const visible = section.querySelector(".product-card:not(.hidden)");
        section.classList.toggle("hidden", !visible && query.length > 0);
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
        cardQtyInput.value = normalizeQty(cardQtyInput.value, product);
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

    document.getElementById("applyLinePrice").addEventListener("click", () => {
      const pattern = document.getElementById("linePattern").value;
      const price = parseMoney(document.getElementById("linePrice").value);
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

    document.getElementById("copyRequest").addEventListener("click", async () => {
      requestText.select();
      try {
        await navigator.clipboard.writeText(requestText.value);
      } catch {
        document.execCommand("copy");
      }
    });

    renderCart();
    registerOfflineCache();

    function addToCart(key) {
      const product = productsByKey.get(key);
      if (!product) {
        return;
      }
      const input = document.querySelector('[data-card-qty="' + cssEscape(key) + '"]');
      const qty = normalizeQty(input ? input.value : product.minQty, product);
      const current = cart[key] || { qty: 0, negotiatedPrice: product.priceNumber };
      current.qty = normalizeQty((Number(current.qty) || 0) + qty, product);
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

    function saveCart() {
      localStorage.setItem(cartKey, JSON.stringify(cart));
      renderCart();
    }

    function renderCart() {
      const entries = Object.entries(cart)
        .map(([key, item]) => ({ key, item, product: productsByKey.get(key) }))
        .filter((entry) => entry.product);

      cartCount.textContent = String(entries.length);
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
    }

    function renderCartRow(entry) {
      const product = entry.product;
      const item = entry.item;
      const qty = normalizeQty(item.qty, product);
      const price = item.negotiatedPrice ?? product.priceNumber;
      const maxAttr = product.maxQty ? ' max="' + product.maxQty + '"' : "";
      return '<div class="cart-row">'
        + '<div class="cart-name"><strong>' + escapeText(product.name) + '</strong><span>SKU: ' + escapeText(product.sku || "-") + ' | Min: ' + product.minQty + ' | Estoque: ' + escapeText(product.stock || String(product.stockNumber || "-")) + '</span></div>'
        + '<input data-cart-qty="' + escapeText(entry.key) + '" type="number" min="' + product.minQty + '" step="' + product.minQty + '"' + maxAttr + ' value="' + qty + '">'
        + '<input data-cart-price="' + escapeText(entry.key) + '" type="text" inputmode="decimal" value="' + (price == null ? "" : formatMoney(price)) + '">'
        + '<button type="button" class="danger" data-remove-key="' + escapeText(entry.key) + '">Remover</button>'
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
        priceTemplate.client,
        "",
        priceTemplate.supervisor,
        "",
        lines.join("\\n"),
      ].join("\\n");
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
  const maxAttr = product.maxQty ? ` max="${escapeAttr(product.maxQty)}"` : "";
  return `<article class="product-card" data-search="${escapeAttr(search)}">
  <div class="image">${
    image
      ? `<img loading="lazy" src="${escapeAttr(image)}" alt="${escapeAttr(product.name)}">`
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
    <div class="min-note">Mínimo carrinho: ${escapeHtml(product.minQty)} ${
      product.minQtySource === "site" ? "(site)" : "(padrão)"
    }</div>
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

function buildServiceWorker(products, generatedAt) {
  const localImages = [...new Set(products.map((product) => product.localImage).filter(Boolean))];
  const assets = [
    "./",
    "index.html",
    "catalogo.html",
    "produtos.csv",
    "resumo.txt",
    "manifest.webmanifest",
    "icon.svg",
    ...localImages,
  ];
  const cacheName = `mateus-catalogo-${generatedAt.toISOString().replace(/[^0-9]/g, "").slice(0, 12)}`;

  return `const CACHE_NAME = ${JSON.stringify(cacheName)};
const PRECACHE_ASSETS = ${JSON.stringify(assets, null, 2)};
const RUNTIME_CACHE = "mateus-runtime-images-v1";

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
