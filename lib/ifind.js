import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_CONFIG_PATH = "./private/ifind-mcp.json";
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const BLOCKED_TOOL_NAME = /(?:^|[^a-z])(delete|remove|update|insert|write|create|modify|submit|trade|order|send|publish|cancel)(?:[^a-z]|$)/i;

function publicStatus(status, message, serverName) {
  return { status, message, ...(serverName ? { serverName } : {}) };
}

function normalizeHeaders(headers) {
  if (headers == null) return {};
  if (typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("iFinD MCP 配置中的 headers 必须是对象。");
  }
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") throw new Error(`iFinD MCP 请求头 ${key} 必须是字符串。`);
    result[key] = value;
  }
  return result;
}

function selectServer(parsed, requestedName) {
  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error("配置文件缺少 mcpServers 对象。");
  }

  const names = Object.keys(servers);
  const wanted = requestedName || process.env.IFIND_MCP_SERVER_NAME;
  let serverName;
  if (wanted) {
    serverName = names.find(name => name.toLowerCase() === wanted.toLowerCase());
    if (!serverName) throw new Error(`配置文件中找不到 MCP 服务 ${wanted}。`);
  } else {
    serverName = names.find(name => name.toLowerCase().includes("ifind"));
    if (!serverName && names.length) serverName = names[0];
    if (!serverName) throw new Error("配置中没有 MCP 服务。");
  }

  const entry = servers[serverName];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`MCP 服务 ${serverName} 的配置格式无效。`);
  }
  if (entry.type && String(entry.type).toLowerCase() !== "streamablehttp") {
    throw new Error(`MCP 服务 ${serverName} 不是 Streamable HTTP 服务。`);
  }
  if (typeof entry.url !== "string" || !entry.url.trim()) {
    throw new Error(`MCP 服务 ${serverName} 缺少 url。`);
  }

  let endpoint;
  try {
    endpoint = new URL(entry.url);
  } catch {
    throw new Error(`MCP 服务 ${serverName} 的 url 无效。`);
  }
  const localHttp = endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !localHttp) {
    throw new Error("iFinD MCP 地址必须使用 HTTPS（本机测试可用 localhost HTTP）。");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("请将 MCP 凭据放在 headers 中，不要嵌入 url。");
  }

  return {
    serverName,
    endpoint: endpoint.toString(),
    headers: normalizeHeaders(entry.headers),
  };
}

async function readConfig(options = {}) {
  const configuredPath = options.configPath ?? process.env.IFIND_MCP_CONFIG_FILE;
  const configPath = resolve(configuredPath || DEFAULT_CONFIG_PATH);
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      const envConfig = String(process.env.IFIND_MCP_CONFIG_JSON || "").trim();
      if (envConfig) {
        try {
          const selected = selectServer(JSON.parse(envConfig.replace(/^\uFEFF/, "")), options.serverName);
          return {
            configPath,
            config: selected,
            status: publicStatus("configured", "iFinD MCP 配置已就绪。", selected.serverName),
          };
        } catch (envError) {
          return {
            configPath,
            config: null,
            status: publicStatus("invalid", envError.message),
          };
        }
      }
      return {
        configPath,
        config: null,
        status: publicStatus("unconfigured", "未找到 iFinD MCP 配置文件。"),
      };
    }
    return {
      configPath,
      config: null,
      status: publicStatus("invalid", "无法读取 iFinD MCP 配置文件。"),
    };
  }

  try {
    const selected = selectServer(JSON.parse(raw.replace(/^\uFEFF/, "")), options.serverName);
    return {
      configPath,
      config: selected,
      status: publicStatus("configured", "iFinD MCP 配置已就绪。", selected.serverName),
    };
  } catch (error) {
    return {
      configPath,
      config: null,
      status: publicStatus("invalid", error.message),
    };
  }
}

export async function getIfindConfigStatus(options = {}) {
  const { status } = await readConfig(options);
  return status;
}

export async function getIfindServerNames(options = {}) {
  const configuredPath = options.configPath ?? process.env.IFIND_MCP_CONFIG_FILE;
  const configPath = resolve(configuredPath || DEFAULT_CONFIG_PATH);
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("无法读取 iFinD MCP 配置文件。", { cause: error });
    raw = String(process.env.IFIND_MCP_CONFIG_JSON || "").trim();
    if (!raw) throw new Error("未找到 iFinD MCP 配置文件。");
  }
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error("配置文件缺少 mcpServers 对象。");
  }
  return Object.keys(servers);
}

function parseSse(text) {
  const messages = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      messages.push({ text: data });
    }
  }
  return messages;
}

async function parseResponse(response, expectedId) {
  if (response.status === 202 || response.status === 204) return null;
  const text = await response.text();
  if (!text.trim()) return null;

  let messages;
  if (/text\/event-stream/i.test(response.headers.get("content-type") || "") || /^\s*(?:event:|data:)/m.test(text)) {
    messages = parseSse(text);
  } else {
    try {
      const parsed = JSON.parse(text);
      messages = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return { text };
    }
  }
  if (!messages.length) return null;
  if (expectedId !== undefined) {
    const matching = messages.find(message => message?.id === expectedId);
    if (matching) return matching;
  }
  return messages.at(-1);
}

function mcpError(message) {
  if (message?.error) {
    const error = new Error("iFinD MCP 返回 JSON-RPC 错误。");
    error.code = message.error.code;
    error.data = message.error.data;
    return error;
  }
  return null;
}

export async function createIfindClient(options = {}) {
  const loaded = await readConfig(options);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number(options.timeoutMs || 30_000);
  const allowedReadOnlyNames = new Set(options.readOnlyToolNames || []);
  let requestId = 0;
  let sessionId = "";
  let protocolVersion = DEFAULT_PROTOCOL_VERSION;
  let initialized = false;
  let initializePromise = null;
  let discoveredTools = null;

  if (typeof fetchImpl !== "function") throw new Error("当前运行环境没有 fetch 实现。");

  async function post(message, { expectedId, allowEmpty = false } = {}) {
    const headers = new Headers(loaded.config.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json, text/event-stream");
    if (initialized) {
      headers.set("MCP-Protocol-Version", protocolVersion);
      if (sessionId) headers.set("MCP-Session-ID", sessionId);
    }

    let response;
    try {
      response = await fetchImpl(loaded.config.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error("iFinD MCP 网络请求失败。", { cause: error });
    }

    const returnedSessionId = response.headers.get("MCP-Session-ID");
    if (returnedSessionId) sessionId = returnedSessionId;
    if (!response.ok) {
      if (response.status === 404 || response.status === 410) sessionId = "";
      throw new Error(`iFinD MCP 返回 HTTP ${response.status}。`);
    }

    const parsed = await parseResponse(response, expectedId);
    if (!parsed && !allowEmpty) throw new Error("iFinD MCP 返回了空响应。");
    const error = mcpError(parsed);
    if (error) throw error;
    return parsed;
  }

  async function initialize() {
    if (loaded.status.status !== "configured") throw new Error(loaded.status.message);
    if (!initializePromise) {
      initializePromise = (async () => {
        const id = ++requestId;
        const response = await post({
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            protocolVersion: DEFAULT_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "market-brief", version: "1.0.0" },
          },
        }, { expectedId: id });
        const result = response?.result;
        if (!result || typeof result !== "object") throw new Error("iFinD MCP 初始化响应无效。");
        if (typeof result.protocolVersion === "string") protocolVersion = result.protocolVersion;
        initialized = true;
        await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { allowEmpty: true });
        return result;
      })().catch(error => {
        initialized = false;
        sessionId = "";
        initializePromise = null;
        throw error;
      });
    }
    return initializePromise;
  }

  async function rpc(method, params = {}) {
    await initialize();
    const id = ++requestId;
    const response = await post({ jsonrpc: "2.0", id, method, params }, { expectedId: id });
    if (!response || !Object.hasOwn(response, "result")) throw new Error(`iFinD MCP ${method} 响应缺少 result。`);
    return response.result;
  }

  async function discoverTools() {
    if (loaded.status.status !== "configured") {
      return { status: loaded.status.status, tools: [], message: loaded.status.message };
    }
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const result = await rpc("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(result?.tools)) throw new Error("iFinD MCP tools/list 响应格式无效。");
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor) break;
      if (page === 19) throw new Error("iFinD MCP 工具目录分页超过 20 页。");
    }
    discoveredTools = tools;
    return { status: "ready", tools };
  }

  async function callTool(name, args) {
    if (loaded.status.status !== "configured") throw new Error(loaded.status.message);
    if (typeof name !== "string" || !name) throw new TypeError("必须指定 MCP 工具的精确名称。");
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new TypeError("工具参数必须是调用方提供的 JSON 对象。");
    }
    const tools = discoveredTools || (await discoverTools()).tools;
    const tool = tools.find(item => item?.name === name);
    if (!tool) throw new Error(`iFinD MCP 工具目录中不存在 ${name}。`);

    const annotations = tool.annotations || {};
    if (annotations.destructiveHint === true || annotations.readOnlyHint === false || BLOCKED_TOOL_NAME.test(name)) {
      throw new Error(`工具 ${name} 未通过只读检查。`);
    }
    if (annotations.readOnlyHint !== true && !allowedReadOnlyNames.has(name)) {
      throw new Error(`工具 ${name} 未声明只读；需由应用显式加入只读工具白名单后才能调用。`);
    }

    return rpc("tools/call", { name, arguments: args });
  }

  return {
    status: loaded.status,
    async discoverTools() {
      return discoverTools();
    },
    async callTool(name, args) {
      return callTool(name, args);
    },
  };
}
