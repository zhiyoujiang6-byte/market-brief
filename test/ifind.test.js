import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIfindClient, getIfindConfigStatus, getIfindServerNames } from "../lib/ifind.js";

async function withConfig(config, run) {
  const directory = await mkdtemp(join(tmpdir(), "ifind-mcp-test-"));
  const configPath = join(directory, "mcp.json");
  try {
    await writeFile(configPath, JSON.stringify(config), "utf8");
    await run(configPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function responseJson(payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function mcpConfig() {
  return {
    mcpServers: {
      ifind: {
        type: "streamablehttp",
        url: "https://ifind.invalid/mcp/user-service",
        headers: { Authorization: "MCPAPIKey test-secret" },
      },
    },
  };
}

test("config status does not expose the endpoint or authorization header", async () => {
  await withConfig(mcpConfig(), async configPath => {
    const status = await getIfindConfigStatus({ configPath });
    assert.equal(status.status, "configured");
    assert.equal(status.serverName, "ifind");
    assert.equal(JSON.stringify(status).includes("test-secret"), false);
    assert.equal(JSON.stringify(status).includes("ifind.invalid"), false);
  });
});

test("config supports multiple generated service entries and enumerates their names", async () => {
  const config = mcpConfig();
  config.mcpServers.ifind2 = { ...config.mcpServers.ifind, url: "https://ifind.invalid/mcp/second-service" };
  await withConfig(config, async configPath => {
    const names = await getIfindServerNames({ configPath });
    assert.deepEqual(names, ["ifind", "ifind2"]);
    const status = await getIfindConfigStatus({ configPath });
    assert.equal(status.status, "configured");
  });
});

test("config falls back to hosted JSON env when the file is absent and keeps file precedence", async () => {
  const missingPath = join(tmpdir(), `missing-ifind-config-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const previous = process.env.IFIND_MCP_CONFIG_JSON;
  process.env.IFIND_MCP_CONFIG_JSON = JSON.stringify(mcpConfig());
  try {
    const status = await getIfindConfigStatus({ configPath: missingPath });
    assert.equal(status.status, "configured");
    assert.equal(status.serverName, "ifind");
    assert.equal(JSON.stringify(status).includes("test-secret"), false);
    assert.deepEqual(await getIfindServerNames({ configPath: missingPath }), ["ifind"]);

    await withConfig(mcpConfig(), async configPath => {
      process.env.IFIND_MCP_CONFIG_JSON = "{invalid hosted fallback";
      const fileStatus = await getIfindConfigStatus({ configPath });
      assert.equal(fileStatus.status, "configured");
      assert.equal(fileStatus.serverName, "ifind");
    });
  } finally {
    if (previous === undefined) delete process.env.IFIND_MCP_CONFIG_JSON;
    else process.env.IFIND_MCP_CONFIG_JSON = previous;
  }
});

test("client initializes, retains the MCP session, parses SSE, and forwards exact tool arguments", async () => {
  await withConfig(mcpConfig(), async configPath => {
    const seen = [];
    const fetchImpl = async (_url, init) => {
      const request = JSON.parse(init.body);
      seen.push({ request, headers: new Headers(init.headers) });
      if (request.method === "initialize") {
        return responseJson({
          jsonrpc: "2.0",
          id: request.id,
          result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "iFinD", version: "1" } },
        }, { "MCP-Session-ID": "session-123" });
      }
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.method === "tools/list") {
        const payload = JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { tools: [{ name: "query_market_width", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } }] },
        });
        return new Response(`event: message\ndata: ${payload}\n\n`, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "MCP-Session-ID": "session-123" },
        });
      }
      if (request.method === "tools/call") {
        return responseJson({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "ok" }] } });
      }
      throw new Error(`Unexpected method ${request.method}`);
    };

    const client = await createIfindClient({ configPath, fetchImpl });
    const discovery = await client.discoverTools();
    assert.equal(discovery.status, "ready");
    assert.equal(discovery.tools[0].name, "query_market_width");
    const args = { date: "2026-10-19", index: "000300.SH" };
    await client.callTool("query_market_width", args);

    assert.deepEqual(seen.map(item => item.request.method), [
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    assert.equal(seen[1].headers.get("MCP-Session-ID"), "session-123");
    assert.equal(seen[2].headers.get("MCP-Protocol-Version"), "2025-03-26");
    assert.equal(seen[3].headers.get("Authorization"), "MCPAPIKey test-secret");
    assert.deepEqual(seen[3].request.params, { name: "query_market_width", arguments: args });
  });
});

test("tools without a read-only annotation require an exact application allowlist", async () => {
  await withConfig(mcpConfig(), async configPath => {
    let listHeaders;
    const fetchImpl = async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.method === "initialize") {
        return responseJson({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-03-26" } });
      }
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.method === "tools/list") {
        listHeaders = new Headers(init.headers);
        return responseJson({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "lookup_data", inputSchema: { type: "object" } }] } });
      }
      if (request.method === "tools/call") {
        return responseJson({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
      }
      throw new Error(`Unexpected method ${request.method}`);
    };

    const unreviewed = await createIfindClient({ configPath, fetchImpl });
    await unreviewed.discoverTools();
    assert.equal(listHeaders.get("MCP-Protocol-Version"), "2025-03-26");
    assert.equal(listHeaders.get("MCP-Session-ID"), null);
    await assert.rejects(unreviewed.callTool("lookup_data", {}), /未声明只读/);

    const reviewed = await createIfindClient({ configPath, fetchImpl, readOnlyToolNames: ["lookup_data"] });
    await reviewed.discoverTools();
    await reviewed.callTool("lookup_data", {});
  });
});

test("unconfigured client reports status without making a network request", async () => {
  const status = await getIfindConfigStatus({ configPath: join(tmpdir(), "missing-ifind-config.json") });
  assert.equal(status.status, "unconfigured");
  const client = await createIfindClient({
    configPath: join(tmpdir(), "missing-ifind-config.json"),
    fetchImpl: () => assert.fail("fetch must not be called"),
  });
  assert.equal((await client.discoverTools()).status, "unconfigured");
  await assert.rejects(client.callTool("any", {}), /未找到/);
});

test("upstream HTTP error bodies are not returned to callers", async () => {
  await withConfig(mcpConfig(), async configPath => {
    const fetchImpl = async () => new Response("upstream secret token", { status: 401 });
    const client = await createIfindClient({ configPath, fetchImpl });
    await assert.rejects(client.discoverTools(), /HTTP 401/);
    await assert.rejects(client.discoverTools(), error => !error.message.includes("upstream secret token"));
  });
});
