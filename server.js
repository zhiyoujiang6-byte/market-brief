import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEvidence, makeEvidencePrompt, parseModelJson } from "./lib/evidence.js";
import { analyzeWithModel } from "./lib/llm.js";
import { createIfindClient, getIfindConfigStatus, getIfindServerNames } from "./lib/ifind.js";
import { INDEXES, loadFuyaoMarket } from "./lib/fuyao.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = resolve(root, "public");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };
const marketCache = new Map();
const ifindEvidence = new Map();
const CACHE_TTL = 15 * 60 * 1000;

async function bodyJson(req, maxLength = 30000) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxLength) throw new Error("请求内容过长");
  }
  return JSON.parse(raw || "{}");
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function matchesSecret(expected, actual) {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authorized(req) {
  if (!process.env.APP_ACCESS_PASSWORD) return process.env.NODE_ENV !== "production";
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try { decoded = Buffer.from(header.slice(6), "base64").toString("utf8"); } catch { return false; }
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  const user = decoded.slice(0, colon);
  const password = decoded.slice(colon + 1);
  return matchesSecret(process.env.APP_ACCESS_USER || "research", user) && matchesSecret(process.env.APP_ACCESS_PASSWORD, password);
}

function safeProviderMessage(message) {
  return String(message || "请求失败")
    .replace(/MCPAPIKey\s+[^\s"']+/gi, "MCPAPIKey [已隐藏]")
    .replace(/(authorization\s*[:=]\s*)[^\s,;]+/gi, "$1[已隐藏]")
    .slice(0, 800);
}

function availableMarket(options) {
  const requestedIndex = INDEXES.some((item) => item.code === options.index) ? options.index : "000300.SH";
  const safeTicker = /^[0-9]{6}\.(SH|SZ|BJ)$/i.test(options.ticker || "") ? String(options.ticker).toUpperCase() : "";
  const report = /^\d{4}-[1-4]$/.test(options.report || "") ? options.report : "";
  const sector = /^[0-9]{6}\.(SH|SZ|BJ)$/i.test(options.sector || "") ? String(options.sector).toUpperCase() : "";
  const days = [20, 60, 120, 250, 365].includes(Number(options.days)) ? Number(options.days) : 60;
  return { index: requestedIndex, days, sector, ticker: safeTicker, report };
}

function renderTool(tool, serverName) {
  return {
    serverName,
    name: String(tool.name || ""),
    description: String(tool.description || ""),
    inputSchema: tool.inputSchema || { type: "object", properties: {} },
    annotations: tool.annotations || {}
  };
}

function isSafeMcpTool(tool) {
  if (tool.annotations?.destructiveHint === true || tool.annotations?.readOnlyHint === false) return false;
  const explicitlyAllowed = new Set(String(process.env.IFIND_READONLY_TOOLS || "").split(",").map((item) => item.trim()).filter(Boolean));
  if (tool.annotations?.readOnlyHint === true || explicitlyAllowed.has(tool.name)) return true;
  const name = String(tool.name || "");
  const description = String(tool.description || "");
  const blocked = /(?:^|[^a-z])(delete|remove|update|insert|write|create|modify|submit|trade|order|send|publish|cancel)(?:[^a-z]|$)/i;
  const readsMarketData = /(?:query|get|search|lookup|list|read|fetch|snapshot|quote|history|market|macro|news|capital|flow|index|stock|sector|financial|finance)/i;
  return !blocked.test(name) && !blocked.test(description) && (readsMarketData.test(name) || readsMarketData.test(description));
}

function parseToolContent(result) {
  if (result?.isError) throw new Error("iFinD 工具返回错误结果。");
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const values = (result?.content || []).filter((item) => item?.type === "text").map((item) => {
    const text = String(item.text || "");
    try { return JSON.parse(text); } catch { return text; }
  });
  return values.length === 1 ? values[0] : values;
}

function createIfindEvidence(serverName, toolName, value) {
  const asOf = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const clipped = serialized.length > 12000 ? `${serialized.slice(0, 12000)} [内容已截断]` : serialized;
  const id = `I-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    group: `iFinD MCP · ${serverName}`,
    name: `iFinD ${toolName}`,
    value: clipped,
    unit: "MCP 返回",
    source: "同花顺 iFinD MCP",
    endpoint: "MCP tools/call",
    field: `${serverName}.tools/call(${toolName})`,
    asOf,
    method: "用户选择并执行的只读工具结果；返回内容作为不可信事实材料处理"
  };
}

function pruneCaches() {
  const now = Date.now();
  for (const [id, value] of marketCache) if (value.expiresAt <= now) marketCache.delete(id);
  for (const [id, value] of ifindEvidence) if (value.expiresAt <= now) ifindEvidence.delete(id);
  while (marketCache.size > 8) marketCache.delete(marketCache.keys().next().value);
  while (ifindEvidence.size > 12) ifindEvidence.delete(ifindEvidence.keys().next().value);
}

async function loadIfind() {
  const configStatus = await getIfindConfigStatus({
    configPath: process.env.IFIND_MCP_CONFIG_FILE,
    serverName: process.env.IFIND_MCP_SERVER_NAME
  });
  if (configStatus.status !== "configured") return { status: configStatus, tools: [] };
  try {
    const serverNames = process.env.IFIND_MCP_SERVER_NAME
      ? [process.env.IFIND_MCP_SERVER_NAME]
      : await getIfindServerNames({ configPath: process.env.IFIND_MCP_CONFIG_FILE });
    const results = await Promise.all(serverNames.map(async (serverName) => {
      try {
        const client = await createIfindClient({
          configPath: process.env.IFIND_MCP_CONFIG_FILE,
          serverName,
          readOnlyToolNames: String(process.env.IFIND_READONLY_TOOLS || "").split(",").map((item) => item.trim()).filter(Boolean)
        });
        const discovery = await client.discoverTools();
        const tools = discovery.tools.map((tool) => renderTool(tool, serverName)).map((tool) => ({ ...tool, readOnly: isSafeMcpTool(tool) }));
        return { serverName, tools };
      } catch (error) {
        return { serverName, tools: [], error: safeProviderMessage(error.message) };
      }
    }));
    const tools = results.flatMap((result) => result.tools);
    const failures = results.filter((result) => result.error);
    if (!tools.length && failures.length) {
      return { status: { status: "error", message: failures.map((item) => `${item.serverName}: ${item.error}`).join("；") }, tools: [], servers: results.map(({ serverName, error }) => ({ serverName, error })) };
    }
    return {
      status: { status: failures.length ? "partial" : "ready", message: failures.length ? `已连接 ${results.length - failures.length}/${results.length} 个 iFinD 服务` : `iFinD 已连接 ${results.length} 个服务` },
      tools,
      servers: results.map(({ serverName, error }) => ({ serverName, ...(error ? { error } : {}) }))
    };
  } catch (error) {
    return { status: { status: "error", message: safeProviderMessage(error.message), serverName: configStatus.serverName }, tools: [] };
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    // Keep the liveness probe independent from application credentials and
    // upstream providers so a host can restart a healthy process reliably.
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ status: "ok" }));
    }

    if (!authorized(req)) {
      const missingPassword = process.env.NODE_ENV === "production" && !process.env.APP_ACCESS_PASSWORD;
      res.writeHead(missingPassword ? 503 : 401, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...(missingPassword ? {} : { "WWW-Authenticate": 'Basic realm="Market Research", charset="UTF-8"' })
      });
      return res.end(JSON.stringify({ error: missingPassword ? "公网模式必须配置 APP_ACCESS_PASSWORD。" : "请输入研究终端访问口令。" }));
    }
    if (req.method === "GET" && url.pathname === "/api/config") {
      return send(res, 200, {
        model: {
          provider: (process.env.LLM_BASE_URL || "https://codeyu.shop/v1").replace(/\/v1\/?$/, ""),
          name: process.env.LLM_MODEL || "gpt-6-astra",
          reasoningEffort: process.env.LLM_REASONING_EFFORT || "high",
          configured: Boolean(process.env.LLM_API_KEY || process.env.CODEYU_API_KEY),
          accessProtected: Boolean(process.env.APP_ACCESS_PASSWORD)
        },
        fuyaoConfigured: Boolean(process.env.FUYAO_API_KEY),
        ifindConfig: await getIfindConfigStatus({ configPath: process.env.IFIND_MCP_CONFIG_FILE, serverName: process.env.IFIND_MCP_SERVER_NAME })
      });
    }

    if (req.method === "GET" && url.pathname === "/api/ifind") return send(res, 200, await loadIfind());

    if (req.method === "GET" && url.pathname === "/api/market") {
      const options = availableMarket(Object.fromEntries(url.searchParams.entries()));
      const market = await loadFuyaoMarket(options);
      const evidence = buildEvidence(market, [...ifindEvidence.values()].map((entry) => entry.evidence));
      const marketId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      pruneCaches();
      marketCache.set(marketId, { market, evidence, options, expiresAt: Date.now() + CACHE_TTL });
      return send(res, 200, { marketId, market, options, evidence, ifindResults: [...ifindEvidence.values()].map((entry) => entry.evidence) });
    }

    if (req.method === "POST" && url.pathname === "/api/ifind/call") {
      const input = await bodyJson(req);
      const serverName = String(input.serverName || "");
      const name = String(input.name || "");
      if (!serverName || !name) return send(res, 400, { error: "请选择一个 iFinD MCP 工具。" });
      if (!input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments)) return send(res, 400, { error: "参数必须是 JSON 对象。" });
      const loaded = await loadIfind();
      if (loaded.status.status !== "ready") return send(res, 503, { error: loaded.status.message });
      const tool = loaded.tools.find((item) => item.serverName === serverName && item.name === name);
      if (!tool) return send(res, 404, { error: "iFinD 工具目录中没有这个工具，请重新加载目录。" });
      if (!tool.readOnly) return send(res, 403, { error: "该工具没有通过只读筛选，不能从本产品执行。" });
      try {
        const client = await createIfindClient({
          configPath: process.env.IFIND_MCP_CONFIG_FILE,
          serverName,
          readOnlyToolNames: [name]
        });
        const result = await client.callTool(name, input.arguments);
        const value = parseToolContent(result);
        const evidence = createIfindEvidence(serverName, name, value);
        pruneCaches();
        ifindEvidence.set(evidence.id, { evidence, expiresAt: Date.now() + CACHE_TTL });
        return send(res, 200, { evidence, value });
      } catch (error) {
        return send(res, 502, { error: safeProviderMessage(error.message) });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/analyze") {
      const input = await bodyJson(req);
      const question = String(input.question || "").trim().slice(0, 300);
      const followup = String(input.followup || "").trim().slice(0, 300);
      if (!question) return send(res, 400, { error: "请先填写研究问题。" });
      const cached = marketCache.get(String(input.marketId || ""));
      if (!cached || cached.expiresAt <= Date.now()) return send(res, 409, { code: "MARKET_EXPIRED", error: "市场数据已过期，请刷新后重试。" });
      if (!process.env.LLM_API_KEY && !process.env.CODEYU_API_KEY) return send(res, 503, { error: "未配置模型 API Key；请在服务端环境设置 LLM_API_KEY。" });
      const external = [...ifindEvidence.values()].map((entry) => entry.evidence);
      const evidence = buildEvidence(cached.market, external);
      if (!evidence.length) return send(res, 422, { error: "目前没有可供模型引用的真实数据证据。先配置扶摇或执行 iFinD 只读查询。" });
      const evidenceIds = evidence.map((item) => item.id);
      const meta = {
        sourceStatus: cached.market.source.status,
        sourceTime: cached.market.source.updatedAt,
        selectedIndex: cached.options.index,
        rangeDays: cached.options.days,
        breadthComplete: cached.market.breadth?.complete ?? false,
        evidenceCount: evidence.length
      };
      const prompt = makeEvidencePrompt(followup ? `${question}\n定向追问：${followup}` : question, evidence, meta);
      try {
        const content = await analyzeWithModel(prompt);
        return send(res, 200, {
          evidence,
          analysis: parseModelJson(content, evidenceIds),
          model: process.env.LLM_MODEL || "gpt-6-astra",
          reasoningEffort: process.env.LLM_REASONING_EFFORT || "high",
          generatedAt: new Date().toISOString()
        });
      } catch (error) {
        return send(res, error.code === "MODEL_TIMEOUT" ? 504 : 502, { code: error.code || "ANALYSIS_FAILED", error: safeProviderMessage(error.message), degraded: true, evidence });
      }
    }

    const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = resolve(publicRoot, requested);
    if (file !== publicRoot && !file.startsWith(`${publicRoot}${sep}`)) return send(res, 404, { error: "未找到内容。" });
    const content = await readFile(file);
    res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(content);
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : (error?.code === "ENOENT" ? 404 : 500);
    send(res, status, { error: status === 400 ? "请求格式无效。" : safeProviderMessage(error.message || "请求失败") });
  }
});

server.listen(port, host, () => console.log(`Market Brief running at http://localhost:${port}`));
