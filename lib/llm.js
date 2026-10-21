const DEFAULT_TIMEOUT_MS = 180_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;

export class ModelError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "ModelError";
    this.code = code;
    this.status = status;
  }
}

function timeoutFromEnv(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  const timeout = Math.trunc(parsed);
  return timeout >= MIN_TIMEOUT_MS && timeout <= MAX_TIMEOUT_MS ? timeout : DEFAULT_TIMEOUT_MS;
}

function modelError(code, message, status = 502) {
  return new ModelError(code, message, status);
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

async function readResponseText(response) {
  if (typeof response?.text === "function") return response.text();
  if (typeof response?.json === "function") return JSON.stringify(await response.json());
  throw modelError("MODEL_INVALID_RESPONSE", "模型服务返回了无法读取的响应。", 502);
}

function responseStatus(response) {
  const status = Number(response?.status);
  if (Number.isFinite(status) && status > 0) return status;
  return response?.ok === false ? 502 : 200;
}

function checkHttpResponse(response) {
  const status = responseStatus(response);
  const ok = response?.ok === undefined ? status >= 200 && status < 300 : response.ok;
  if (ok) return;
  if (status === 401 || status === 403) {
    throw modelError("MODEL_AUTH_ERROR", "模型服务鉴权失败，请检查模型 API Key。", 502);
  }
  if (status === 429) {
    throw modelError("MODEL_RATE_LIMITED", "模型服务当前请求过多，请稍后重试。", 429);
  }
  if (status >= 500) {
    throw modelError("MODEL_UPSTREAM_ERROR", "模型服务暂时不可用，请稍后重试。", 502);
  }
  throw modelError("MODEL_HTTP_ERROR", "模型服务返回了无法处理的状态。", 502);
}

export async function analyzeWithModel(prompt, env = process.env, fetchImpl = globalThis.fetch) {
  const apiKey = env.LLM_API_KEY || env.CODEYU_API_KEY;
  if (!apiKey) throw modelError("MODEL_NOT_CONFIGURED", "未配置模型 API Key。", 503);
  if (typeof fetchImpl !== "function") throw modelError("MODEL_NETWORK_ERROR", "无法连接模型服务，请检查网络或模型服务配置。", 502);

  const baseUrl = (env.LLM_BASE_URL || "https://codeyu.shop/v1").replace(/\/$/, "");
  const timeoutMs = timeoutFromEnv(env.LLM_TIMEOUT_MS);
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: env.LLM_MODEL || "gpt-6-astra",
          reasoning_effort: env.LLM_REASONING_EFFORT || "high",
          messages: [
            { role: "system", content: "你是审慎的A股市场研究助理。只做基于证据的市场状态分析，不作个股推荐、涨跌预测或交易建议。严格输出用户要求的结构化 JSON。" },
            { role: "user", content: prompt }
          ],
          response_format: { type: "json_object" },
          temperature: 0.2
        }),
        signal: controller.signal
      });
    } catch (error) {
      if (timedOut || isAbortError(error)) {
        throw modelError("MODEL_TIMEOUT", "模型服务请求超时，请稍后重试。", 504);
      }
      throw modelError("MODEL_NETWORK_ERROR", "无法连接模型服务，请检查网络或模型服务配置。", 502);
    }

    checkHttpResponse(response);

    let raw;
    try {
      raw = await readResponseText(response);
    } catch (error) {
      if (timedOut || isAbortError(error)) {
        throw modelError("MODEL_TIMEOUT", "模型服务请求超时，请稍后重试。", 504);
      }
      if (error instanceof ModelError) throw error;
      throw modelError("MODEL_NETWORK_ERROR", "读取模型服务响应失败，请稍后重试。", 502);
    }
    if (timedOut) throw modelError("MODEL_TIMEOUT", "模型服务请求超时，请稍后重试。", 504);
    if (!String(raw || "").trim()) throw modelError("MODEL_EMPTY_RESPONSE", "模型服务返回了空响应，请稍后重试。", 502);

    let data;
    try {
      data = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      throw modelError("MODEL_INVALID_RESPONSE", "模型服务返回的内容不是有效 JSON。", 502);
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw modelError("MODEL_EMPTY_RESPONSE", "模型服务未返回有效分析文本，请稍后重试。", 502);
    }
    return content;
  } catch (error) {
    if (error instanceof ModelError) throw error;
    if (timedOut || isAbortError(error)) throw modelError("MODEL_TIMEOUT", "模型服务请求超时，请稍后重试。", 504);
    throw modelError("MODEL_NETWORK_ERROR", "模型服务请求失败，请稍后重试。", 502);
  } finally {
    clearTimeout(timeoutId);
  }
}
