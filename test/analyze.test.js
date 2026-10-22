import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

function marketPayload(id) {
  return {
    marketId: id,
    options: { index: "000300.SH", days: 60, ticker: "", report: "", sector: "" },
    market: {
      source: { status: "ready", updatedAt: 1760000000000 },
      indexes: [], history: [], tradingDay: { date: "2025-10-09" }, failures: [],
      breadth: null, limitStats: {}, limitUp: [], limitDown: [], hotList: [],
      constituents: [], catalogs: { industry: [], concept: [], region: [], thsIndex: [] }
    },
    evidence: [], ifindResults: []
  };
}

function response(payload, status = 200, contentType = "application/json") {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": contentType } });
}

function makeEnvironment(fetchImpl) {
  const elements = new Map();
  const canvasContext = { clearRect() {}, setTransform() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {} };
  const makeElement = (selector) => ({
    selector, value: selector === "#index-select" ? "000300.SH" : selector === "#days-select" ? "60" : selector === "#catalog-type" ? "industry" : selector === "#question" ? "测试问题" : "",
    textContent: "", innerHTML: "", hidden: false, disabled: false, className: "", style: {}, open: false, listeners: new Map(),
    addEventListener(name, callback) { this.listeners.set(name, callback); }, setAttribute() {}, scrollIntoView() {},
    getBoundingClientRect: () => ({ width: 640, height: 240 }),
    getContext: () => canvasContext,
    querySelectorAll: () => []
  });
  const document = {
    querySelector(selector) { if (!elements.has(selector)) elements.set(selector, makeElement(selector)); return elements.get(selector); },
    querySelectorAll() { return []; },
    getElementById(id) { return this.querySelector("#" + id); }
  };
  const context = vm.createContext({
    console, document, window: { devicePixelRatio: 1, addEventListener() {} }, fetch: fetchImpl,
    URLSearchParams, Response, AbortSignal, setTimeout, clearTimeout, Math, Date, JSON, Number, String, Intl
  });
  const source = appSource.replace(/\ninit\(\);\s*$/, "") + "\nglobalThis.__marketBrief = { analyze, loadMarket, state };";
  vm.runInContext(source, context);
  document.querySelector("#followup");
  return { api: context.__marketBrief, elements };
}

function analyzePayload() {
  return {
    evidence: [], model: "gpt-6-astra", generatedAt: 1760000000000,
    analysis: { headline: "状态待核验", summary: "基于当前证据。", confidence: "中", support: [], counter: [], unknowns: [], conditions: [], followups: [] }
  };
}

test("没有 marketId 时先读取行情再生成研判", async () => {
  const calls = [];
  const env = makeEnvironment(async (input, init) => {
    const url = String(input); calls.push({ url, init });
    return url.startsWith("/api/market") ? response(marketPayload("fresh-1")) : response(analyzePayload());
  });
  assert.equal(await env.api.analyze(), true);
  assert.deepEqual(calls.map((call) => call.url), ["/api/market?index=000300.SH&days=60&ticker=&report=&sector=", "/api/analyze"]);
  assert.equal(env.api.state.marketId, "fresh-1");
});

test("行情过期时刷新并只重试一次", async () => {
  const calls = [];
  const env = makeEnvironment(async (input) => {
    const url = String(input); calls.push(url);
    if (url.startsWith("/api/market")) return response(marketPayload("fresh-2"));
    if (calls.filter((item) => item === "/api/analyze").length === 1) return response({ error: "market expired", code: "MARKET_EXPIRED" }, 409);
    return response(analyzePayload());
  });
  env.api.state.marketId = "stale";
  assert.equal(await env.api.analyze(), true);
  assert.equal(calls.filter((url) => url.startsWith("/api/market")).length, 1);
  assert.equal(calls.filter((url) => url === "/api/analyze").length, 2);
  assert.equal(env.api.state.marketId, "fresh-2");
});

test("过期刷新失败时不再次请求模型", async () => {
  const calls = [];
  const env = makeEnvironment(async (input) => {
    const url = String(input); calls.push(url);
    if (url === "/api/analyze") return response({ error: "expired" }, 409);
    return response({ error: "upstream unavailable" }, 503);
  });
  env.api.state.marketId = "stale";
  assert.equal(await env.api.analyze(), false);
  assert.equal(calls.filter((url) => url === "/api/analyze").length, 1);
  assert.equal(calls.filter((url) => url.startsWith("/api/market")).length, 1);
  assert.equal(env.api.state.marketId, "");
});

test("非过期模型错误不会循环重试，且非 JSON 错误可读", async () => {
  const calls = [];
  const env = makeEnvironment(async (input) => {
    const url = String(input); calls.push(url);
    if (url === "/api/analyze") return new Response("gateway failed", { status: 502, headers: { "Content-Type": "text/plain" } });
    return response(marketPayload("fresh-3"));
  });
  env.api.state.marketId = "current";
  assert.equal(await env.api.analyze(), false);
  assert.equal(calls.filter((url) => url === "/api/analyze").length, 1);
  assert.equal(calls.filter((url) => url.startsWith("/api/market")).length, 0);
  assert.match(env.elements.get("#error").textContent, /HTTP 502.*格式异常/);
});

test("并发刷新复用同一个请求，分析期间锁住重复提交", async () => {
  let resolveMarket;
  let marketCalls = 0;
  let analyzeCalls = 0;
  let submittedMarketId;
  const env = makeEnvironment(async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/market")) {
      marketCalls += 1;
      await new Promise((resolve) => { resolveMarket = resolve; });
      return response(marketPayload("fresh-4"));
    }
    analyzeCalls += 1;
    submittedMarketId = JSON.parse(init.body).marketId;
    return response(analyzePayload());
  });
  const first = env.api.loadMarket();
  const second = env.api.loadMarket();
  assert.strictEqual(first, second);
  env.api.state.marketId = "old";
  const analysis = env.api.analyze();
  assert.equal(await env.api.analyze(), false);
  assert.equal(analyzeCalls, 0);
  assert.equal(env.elements.get("#analyze").disabled, true);
  assert.equal(env.elements.get("#followup-submit").disabled, true);
  resolveMarket();
  await first;
  assert.equal(marketCalls, 1);
  assert.equal(await analysis, true);
  assert.equal(analyzeCalls, 1);
  assert.equal(submittedMarketId, "fresh-4");
  assert.equal(env.elements.get("#analyze").disabled, false);
  assert.equal(env.elements.get("#followup-submit").disabled, false);
});

test("再次过期时停止重试并保留追问输入", async () => {
  let analyzeCalls = 0;
  const bodies = [];
  const env = makeEnvironment(async (input, init) => {
    if (String(input).startsWith("/api/market")) return response(marketPayload("fresh-5"));
    analyzeCalls += 1;
    bodies.push(JSON.parse(init.body));
    return response({ error: "expired" }, 409);
  });
  env.api.state.marketId = "old";
  env.elements.get("#followup").value = "哪些证据需要降级？";
  const form = env.elements.get("#followup-form");
  await form.listeners.get("submit")({ preventDefault() {} });
  assert.equal(analyzeCalls, 2);
  assert.equal(env.elements.get("#followup").value, "哪些证据需要降级？");
  assert.equal(env.elements.get("#question").value, "测试问题");
  assert.deepEqual(bodies.map((body) => [body.question, body.followup, body.marketId]), [
    ["测试问题", "哪些证据需要降级？", "old"],
    ["测试问题", "哪些证据需要降级？", "fresh-5"]
  ]);
});

test("追问成功后才清空输入", async () => {
  let finish;
  const env = makeEnvironment(async () => {
    await new Promise((resolve) => { finish = resolve; });
    return response(analyzePayload());
  });
  env.api.state.marketId = "current";
  env.elements.get("#followup").value = "需要跟踪什么？";
  const submission = env.elements.get("#followup-form").listeners.get("submit")({ preventDefault() {} });
  assert.equal(env.elements.get("#followup").value, "需要跟踪什么？");
  finish();
  await submission;
  assert.equal(env.elements.get("#followup").value, "");
});

test("读取中更改筛选只加载最终选择，分析使用最新行情 ID", async () => {
  let finishInitialMarket;
  const marketRequests = [];
  const analyzeRequests = [];
  const env = makeEnvironment(async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/market")) {
      const query = new URL(url, "http://example.test").searchParams;
      marketRequests.push([query.get("index"), query.get("days"), query.get("ticker")]);
      if (marketRequests.length === 1) {
        await new Promise((resolve) => { finishInitialMarket = resolve; });
        return response(marketPayload("old-range"));
      }
      return response(marketPayload("latest-range"));
    }
    analyzeRequests.push(JSON.parse(init.body));
    return response(analyzePayload());
  });
  const initial = env.api.loadMarket();
  env.elements.get("#index-select").value = "000001.SH";
  const intermediate = env.api.loadMarket();
  env.elements.get("#days-select").value = "120";
  env.elements.get("#ticker").value = "300033.SZ";
  const latest = env.api.loadMarket();
  const analysis = env.api.analyze();
  assert.strictEqual(initial, intermediate);
  assert.strictEqual(initial, latest);
  assert.equal(analyzeRequests.length, 0);
  finishInitialMarket();
  assert.equal(await analysis, true);
  assert.deepEqual(marketRequests, [
    ["000300.SH", "60", ""],
    ["000001.SH", "120", "300033.SZ"]
  ]);
  assert.equal(analyzeRequests.length, 1);
  assert.equal(analyzeRequests[0].marketId, "latest-range");
  assert.equal(env.api.state.marketId, "latest-range");
});
