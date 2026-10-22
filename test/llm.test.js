import test from "node:test";
import assert from "node:assert/strict";
import { analyzeWithModel, ModelError } from "../lib/llm.js";

const env = { LLM_API_KEY: "test-secret-key" };
const jsonResponse = (content = '{"headline":"市场分化"}') => new Response(JSON.stringify({ choices: [{ message: { content } }] }));

function matchesError(code, status = 502) {
  return (error) => {
    assert.ok(error instanceof ModelError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.match(error.message, /[\u4e00-\u9fff]/);
    assert.doesNotMatch(error.message, /test-secret-key|raw-private-provider-detail/);
    return true;
  };
}

test("model request preserves Astra high and returns analysis text", async () => {
  let calls = 0;
  const output = await analyzeWithModel("研究问题", env, async (url, options) => {
    calls += 1;
    assert.equal(url, "https://codeyu.shop/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer test-secret-key");
    assert.equal(options.method, "POST");
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.equal(body.model, "gpt-6-astra");
    assert.equal(body.reasoning_effort, "high");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.messages[1].content, "研究问题");
    return jsonResponse();
  });
  assert.equal(output, '{"headline":"市场分化"}');
  assert.equal(calls, 1);
});

test("model timeout validates configuration and never retries a billed request", async (t) => {
  const cases = [
    [undefined, 180000], ["1000", 1000], ["300000", 300000],
    ["999", 180000], ["300001", 180000], ["invalid", 180000], ["", 180000]
  ];
  for (const [configured, expected] of cases) {
    await t.test(`timeout ${configured ?? "default"} resolves to ${expected} ms`, async (subtest) => {
      subtest.mock.timers.enable({ apis: ["setTimeout"] });
      let signal;
      let calls = 0;
      const pending = analyzeWithModel("问题", { ...env, LLM_TIMEOUT_MS: configured }, async (_url, options) => {
        calls += 1;
        signal = options.signal;
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("raw-private-provider-detail", "AbortError")), { once: true }));
      });
      const assertion = assert.rejects(pending, matchesError("MODEL_TIMEOUT", 504));
      subtest.mock.timers.tick(expected - 1);
      assert.equal(signal.aborted, false);
      subtest.mock.timers.tick(1);
      assert.equal(signal.aborted, true);
      await assertion;
      assert.equal(calls, 1);
    });
  }
});

test("timeout remains active while reading the response body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let readStarted;
  const started = new Promise((resolve) => { readStarted = resolve; });
  let signal;
  const pending = analyzeWithModel("问题", { ...env, LLM_TIMEOUT_MS: "1000" }, async (_url, options) => {
    signal = options.signal;
    return {
      status: 200,
      ok: true,
      text: () => {
        readStarted();
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("raw-private-provider-detail", "AbortError")), { once: true }));
      }
    };
  });
  const assertion = assert.rejects(pending, matchesError("MODEL_TIMEOUT", 504));
  await started;
  t.mock.timers.tick(1000);
  await assertion;
});

test("HTTP failures expose stable errors without upstream details or retries", async (t) => {
  const cases = [[401, "MODEL_AUTH_ERROR", 502], [403, "MODEL_AUTH_ERROR", 502], [429, "MODEL_RATE_LIMITED", 429], [500, "MODEL_UPSTREAM_ERROR", 502], [503, "MODEL_UPSTREAM_ERROR", 502], [400, "MODEL_HTTP_ERROR", 502]];
  for (const [status, code, publicStatus] of cases) {
    await t.test(String(status), async () => {
      let calls = 0;
      await assert.rejects(analyzeWithModel("问题", env, async () => {
        calls += 1;
        return new Response("raw-private-provider-detail test-secret-key", { status });
      }), matchesError(code, publicStatus));
      assert.equal(calls, 1);
    });
  }
});

test("network failures do not expose the original error", async () => {
  await assert.rejects(analyzeWithModel("问题", env, async () => {
    throw new Error("raw-private-provider-detail test-secret-key");
  }), matchesError("MODEL_NETWORK_ERROR"));
});

test("response body network failures are classified safely", async () => {
  await assert.rejects(analyzeWithModel("问题", env, async () => ({
    ok: true, status: 200, text: async () => { throw new Error("raw-private-provider-detail test-secret-key"); }
  })), matchesError("MODEL_NETWORK_ERROR"));
});

test("invalid JSON and empty model replies have distinct safe errors", async (t) => {
  for (const [name, response, code] of [
    ["non JSON", () => new Response("raw-private-provider-detail test-secret-key"), "MODEL_INVALID_RESPONSE"],
    ["empty body", () => new Response(""), "MODEL_EMPTY_RESPONSE"],
    ["missing content", () => new Response('{"choices":[]}'), "MODEL_EMPTY_RESPONSE"],
    ["blank content", () => jsonResponse("  "), "MODEL_EMPTY_RESPONSE"]
  ]) {
    await t.test(name, async () => {
      await assert.rejects(analyzeWithModel("问题", env, async () => response()), matchesError(code));
    });
  }
});

test("missing key fails without contacting a provider", async () => {
  let called = false;
  await assert.rejects(analyzeWithModel("问题", {}, async () => { called = true; }), matchesError("MODEL_NOT_CONFIGURED", 503));
  assert.equal(called, false);
});
