const API_ROOT = "https://fuyao.aicubes.cn";
const INDEXES = [
  { code: "000001.SH", name: "上证指数", style: "综合" },
  { code: "000300.SH", name: "沪深300", style: "大盘" },
  { code: "000905.SH", name: "中证500", style: "中盘" },
  { code: "000852.SH", name: "中证1000", style: "小盘" },
  { code: "399006.SZ", name: "创业板指", style: "成长" },
  { code: "000688.SH", name: "科创50", style: "成长" }
];

function query(path, params = {}) {
  const url = new URL(path, API_ROOT);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

export function unwrapFuyao(response, endpoint) {
  if (!response || Number(response.code) !== 0) {
    const code = response?.code ?? "unknown";
    const message = response?.message || "接口返回业务错误";
    throw new Error(`扶摇 ${endpoint}: code=${code} ${message}`);
  }
  return response.data || {};
}

export async function fetchFuyao(path, params = {}, env = process.env) {
  const key = env.FUYAO_API_KEY;
  if (!key) throw new Error("未配置扶摇 API Key（FUYAO_API_KEY）");
  const endpoint = query(path, params);
  const response = await fetch(endpoint, {
    headers: { "X-api-key": key, Accept: "application/json" },
    signal: AbortSignal.timeout(20000)
  });
  if (response.status === 429) throw new Error("扶摇接口触发限流（HTTP 429），请稍后重试");
  if (!response.ok) throw new Error(`扶摇接口 HTTP ${response.status}`);
  return unwrapFuyao(await response.json(), path);
}

function isRetryableError(error) {
  return /HTTP (?:429|5\d\d)|fetch failed|network|timeout|timed out|aborted|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(String(error?.message || error));
}

async function fetchFuyaoWithRetry(path, params, env, attempts = 3) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchFuyao(path, params, env);
    } catch (error) {
      if (attempt + 1 >= attempts || !isRetryableError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

export function shanghaiDate(ms) {
  if (!Number.isFinite(Number(ms))) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(Number(ms));
}

function asArray(data) {
  return Array.isArray(data?.item) ? data.item : [];
}

function snapshotTurnover(items) {
  let seen = false;
  const sum = items.reduce((total, item) => {
    if (item.turnover === null || item.turnover === undefined || item.turnover === "") return total;
    const value = Number(item.turnover);
    if (!Number.isFinite(value)) return total;
    seen = true;
    return total + value;
  }, 0);
  return seen ? sum : null;
}

export function summarizeBreadth(items, total, pagesComplete) {
  const changes = items.filter((item) => item.price_change_ratio_pct !== null && item.price_change_ratio_pct !== undefined && item.price_change_ratio_pct !== "").map((item) => Number(item.price_change_ratio_pct)).filter(Number.isFinite);
  const advancing = changes.filter((value) => value > 0).length;
  const declining = changes.filter((value) => value < 0).length;
  const unchanged = changes.length - advancing - declining;
  const sorted = [...changes].sort((a, b) => a - b);
  const median = !sorted.length ? null : sorted.length % 2
    ? sorted[Math.floor(sorted.length / 2)]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return {
    observed: items.length,
    changeObserved: changes.length,
    total: total !== null && total !== undefined && total !== "" && Number.isFinite(Number(total)) ? Number(total) : null,
    advancing,
    declining,
    unchanged,
    advanceRatioPct: changes.length ? advancing / changes.length * 100 : null,
    medianChangePct: median,
    turnover: snapshotTurnover(items),
    complete: pagesComplete !== false && total !== null && total !== undefined && total !== "" && Number.isFinite(Number(total)) && items.length >= Number(total)
  };
}

async function loadAllMarketSnapshots(env) {
  const pageSize = 100;
  const items = new Map();
  const unkeyedItems = [];
  const errors = [];
  let total = null;
  let timestamp = null;
  const maxPages = 80;
  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * pageSize;
    if (total !== null && offset >= total) break;
    let data;
    try {
      data = await fetchFuyaoWithRetry("/api/a-share/prices/snapshot", { limit: pageSize, offset }, env);
    } catch (error) {
      errors.push({ offset, error: error.message });
      if (total === null) break;
      continue;
    }
    const pageTotal = data.total !== null && data.total !== undefined && data.total !== "" && Number.isFinite(Number(data.total)) ? Number(data.total) : null;
    if (page === 0) {
      total = pageTotal;
      timestamp = data.timestamp ?? null;
    }
    const rows = asArray(data);
    for (const row of rows) {
      if (row.thscode) items.set(row.thscode, row);
      else unkeyedItems.push(row);
    }
    if (total === null && rows.length < pageSize) break;
  }
  const allItems = [...items.values(), ...unkeyedItems];
  const expectedPages = total === null ? null : Math.ceil(total / pageSize);
  if (expectedPages !== null && expectedPages > maxPages) errors.push({ offset: maxPages * pageSize, error: `全市场快照共 ${expectedPages} 页，超过读取上限` });
  const complete = total !== null && errors.length === 0 && (expectedPages === 0 || expectedPages !== null && expectedPages <= maxPages) && allItems.length >= total;
  return { items: allItems, total, timestamp, complete, errors };
}

async function loadSpecialPool(path, dateMs, env) {
  const size = 200;
  const maxPages = 20;
  const items = new Map();
  const unkeyedItems = [];
  const errors = [];
  let timestamp = null;
  let pagination = null;
  let pages = 1;
  for (let page = 1; page <= Math.min(pages, maxPages); page += 1) {
    let data;
    try {
      data = await fetchFuyaoWithRetry(path, { date_ms: dateMs, page, size }, env);
    } catch (error) {
      if (page === 1) throw error;
      errors.push({ page, error: error.message });
      continue;
    }
    if (page === 1) {
      timestamp = data.timestamp ?? null;
      pagination = data.pagination ?? null;
      const reportedPages = Number(pagination?.pages);
      if (Number.isFinite(reportedPages) && reportedPages > 0) {
        pages = Math.ceil(reportedPages);
        if (pages > maxPages) errors.push({ page: maxPages + 1, error: `涨跌停池共 ${pages} 页，超过读取上限` });
        pages = Math.min(pages, maxPages);
      } else if (Number.isFinite(Number(pagination?.total))) {
        pages = Math.ceil(Number(pagination.total) / size);
        if (pages > maxPages) errors.push({ page: maxPages + 1, error: `涨跌停池共 ${pages} 页，超过读取上限` });
        pages = Math.min(pages, maxPages);
      }
    }
    for (const row of asArray(data)) {
      if (row.thscode) items.set(row.thscode, row);
      else unkeyedItems.push(row);
    }
  }
  return { items: [...items.values(), ...unkeyedItems], timestamp, pagination, errors };
}

async function settled(label, run) {
  try {
    return { status: "ready", label, data: await run(), error: null };
  } catch (error) {
    return { status: "error", label, data: null, error: error.message };
  }
}

export function normalizeTradingDate(value) {
  const raw = String(value ?? "").trim();
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return raw;
}

export function latestTradingDay(calendar, now = Date.now()) {
  const rows = asArray(calendar);
  const dates = rows.map((row) => ({
    date: normalizeTradingDate(typeof row === "string" ? row : row.date || shanghaiDate(row.date_ms)),
    dateMs: typeof row === "object"
      ? row.date_ms !== null && row.date_ms !== undefined && row.date_ms !== "" && Number.isFinite(Number(row.date_ms)) ? Number(row.date_ms) : Date.parse(`${normalizeTradingDate(row.date)}T00:00:00+08:00`)
      : Date.parse(`${normalizeTradingDate(row)}T00:00:00+08:00`)
  })).filter((row) => row.date && Number.isFinite(row.dateMs) && row.dateMs <= now).sort((a, b) => a.date.localeCompare(b.date));
  const last = dates.at(-1);
  return last || { date: shanghaiDate(now), dateMs: NaN };
}

function dateStart(days, endMs = Date.now()) {
  return endMs - days * 24 * 60 * 60 * 1000;
}

export async function loadFuyaoMarket({ index = "000300.SH", days = 60, sector = "", ticker = "", report = "" } = {}, env = process.env) {
  const source = { id: "fuyao", name: "扶摇金融数据 API", status: "unconfigured", error: null, updatedAt: null };
  if (!env.FUYAO_API_KEY) {
    source.error = "请在服务端配置 FUYAO_API_KEY。密钥从同花顺账号的扶摇 API Key 管理页签发。";
    return { source, indexes: [], history: [], breadth: null, calendar: [], limitStats: null, limitUp: [], limitDown: [], hotList: [], constituents: [], valuations: [], sectors: [], company: null, evidence: [] };
  }

  source.status = "partial";
  const end = Date.now();
  const safeDays = Math.min(Math.max(Number(days) || 60, 10), 365 * 5);
  const indexCodes = INDEXES.map((item) => item.code).join(",");
  const fixed = await Promise.all([
    settled("indexSnapshot", () => fetchFuyao("/api/a-share-index/prices/snapshot", { thscodes: indexCodes }, env)),
    settled("calendar", () => fetchFuyao("/api/a-share/calendar/trading-days", {}, env)),
    settled("marketSnapshots", () => loadAllMarketSnapshots(env)),
    settled("history", () => fetchFuyao("/api/a-share-index/prices/historical", { thscode: index, interval: "1d", start: dateStart(safeDays, end), end }, env)),
    settled("constituents", () => fetchFuyao("/api/a-share-index/constituents/ths-stock-list", { thscode: sector || index }, env)),
    settled("industryCatalog", () => fetchFuyao("/api/a-share-index/catalog/ths-index-list", { tag: "industry" }, env)),
    settled("conceptCatalog", () => fetchFuyao("/api/a-share-index/catalog/ths-index-list", { tag: "cn_concept" }, env)),
    settled("regionCatalog", () => fetchFuyao("/api/a-share-index/catalog/ths-index-list", { tag: "region" }, env)),
    settled("thsIndexCatalog", () => fetchFuyao("/api/a-share-index/catalog/ths-index-list", { tag: "tszs" }, env))
  ]);
  const result = Object.fromEntries(fixed.map((item) => [item.label, item]));
  const calendarData = result.calendar.data;
  const today = shanghaiDate(end);
  const tradingDay = calendarData
    ? latestTradingDay(calendarData, end)
    : { date: today, dateMs: Date.parse(`${today}T00:00:00+08:00`) };
  const dateMs = Number.isFinite(tradingDay.dateMs) ? tradingDay.dateMs : Date.parse(`${tradingDay.date}T00:00:00+08:00`);
  const statsDate = tradingDay.date;
  const specials = await Promise.all([
    settled("limitStats", () => fetchFuyao("/api/a-share/special-data/limit-up-statistics", { date: statsDate }, env)),
    settled("limitUp", () => loadSpecialPool("/api/a-share/special-data/limit-up-pool", dateMs, env)),
    settled("limitDown", () => loadSpecialPool("/api/a-share/special-data/limit-down-pool", dateMs, env)),
    settled("hotList", () => fetchFuyao("/api/a-share/special-data/hot-stock-list", { period: "day", limit: 30 }, env))
  ]);
  Object.assign(result, Object.fromEntries(specials.map((item) => [item.label, item])));

  const members = asArray(result.constituents.data);
  const memberCodes = members.map((item) => item.thscode).filter(Boolean);
  const valuationBatches = [];
  for (let offset = 0; offset < memberCodes.length; offset += 100) {
    const batch = memberCodes.slice(offset, offset + 100);
    valuationBatches.push(settled(`valuationBatch${valuationBatches.length + 1}`, () => fetchFuyao("/api/a-share/valuations/snapshot", { thscodes: batch.join(",") }, env)));
  }
  const valuations = await Promise.all(valuationBatches);
  result.valuations = { status: valuations.some((item) => item.status === "ready") ? "ready" : (valuationBatches.length ? "error" : "partial"), data: valuations.flatMap((item) => asArray(item.data)), errors: valuations.filter((item) => item.status === "error").map((item) => item.error) };
  const marketQuotes = new Map((result.marketSnapshots.data?.items || []).map((item) => [item.thscode, item]));
  const valuationByCode = new Map(result.valuations.data.map((item) => [item.thscode, item]));
  const constituentRows = members.map((member) => ({
    ...member,
    priceChangePct: marketQuotes.get(member.thscode)?.price_change_ratio_pct ?? null,
    peTTM: valuationByCode.get(member.thscode)?.pe_ttm ?? null
  }));

  let company = null;
  const safeTicker = String(ticker).trim().toUpperCase();
  if (/^[0-9]{6}\.(SH|SZ|BJ)$/.test(safeTicker)) {
    const safeReport = /^\d{4}-[1-4]$/.test(String(report)) ? String(report) : "";
    const [stockHistory, financialIndicators] = await Promise.all([
      settled("companyHistory", () => fetchFuyao("/api/a-share/prices/historical", { thscode: safeTicker, interval: "1d", start: dateStart(safeDays, end), end, adjust: "forward" }, env)),
      ...(safeReport ? [settled("companyFinancials", () => fetchFuyao("/api/a-share/financials/indicators", { thscode: safeTicker, report: safeReport }, env))] : [Promise.resolve({ status: "unconfigured", label: "companyFinancials", data: null, error: "选择报告期后读取财务指标" })])
    ]);
    company = { ticker: safeTicker, report: safeReport || "", history: stockHistory.data, financials: financialIndicators.data, errors: [stockHistory, financialIndicators].filter((item) => item.status === "error").map(({ label, error }) => ({ label, error })) };
  }

  const sourceTimestamp = result.indexSnapshot.data?.timestamp ?? result.marketSnapshots.data?.timestamp ?? null;
  if (sourceTimestamp) {
    const timestampDate = new Date(Number(sourceTimestamp));
    source.updatedAt = Number.isNaN(timestampDate.getTime()) ? null : timestampDate.toISOString();
  }
  const catalogFailures = [result.industryCatalog, result.conceptCatalog, result.regionCatalog, result.thsIndexCatalog].filter((item) => item.status === "error");
  const snapshotData = result.marketSnapshots.data;
  const pageFailures = [
    ...(snapshotData?.errors || []).map((failure) => ({ label: "marketSnapshots", error: `offset=${failure.offset}: ${failure.error}` })),
    ...(snapshotData && !snapshotData.complete && !snapshotData.errors.length ? [{ label: "marketSnapshots", error: `快照覆盖 ${snapshotData.items.length}/${snapshotData.total ?? "未知"}` }] : []),
    ...["limitUp", "limitDown"].flatMap((label) => (result[label].data?.errors || []).map((failure) => ({ label, error: `page=${failure.page}: ${failure.error}` })))
  ];
  const companyFailures = company?.errors || [];
  const failures = [
    ...[...fixed, ...specials, ...valuations, ...catalogFailures].filter((item) => item.status === "error").map(({ label, error }) => ({ label, error })),
    ...companyFailures
  ];
  const uniqueFailures = [...new Map([...failures, ...pageFailures].map((item) => [`${item.label}:${item.error}`, item])).values()];
  source.status = uniqueFailures.length ? "partial" : (result.indexSnapshot.status === "ready" ? "ready" : "partial");
  source.error = uniqueFailures.map((item) => item.error).join("；") || null;
  return {
    source,
    indexes: asArray(result.indexSnapshot.data).map((row) => {
      const info = INDEXES.find((item) => item.code === row.thscode);
      return { ...row, name: row.name || info?.name || row.thscode, style: info?.style || "" };
    }),
    indexTimestamp: result.indexSnapshot.data?.timestamp ?? null,
    history: asArray(result.history.data),
    historyTimestamp: result.history.data?.timestamp ?? null,
    breadth: result.marketSnapshots.data ? summarizeBreadth(result.marketSnapshots.data.items, result.marketSnapshots.data.total, result.marketSnapshots.data.complete) : null,
    marketSnapshotTimestamp: result.marketSnapshots.data?.timestamp ?? null,
    calendar: asArray(calendarData),
    tradingDay,
    limitStats: result.limitStats.data || null,
    limitUp: result.limitUp.data?.items || [],
    limitDown: result.limitDown.data?.items || [],
    hotList: asArray(result.hotList.data),
    constituents: members,
    constituentRows,
    constituentTimestamp: result.constituents.data?.timestamp ?? null,
    valuations: result.valuations.data,
    valuationTimestamp: valuations.map((item) => item.data?.timestamp).find(Boolean) || null,
    valuationErrors: result.valuations.errors,
    catalogs: {
      industry: asArray(result.industryCatalog.data),
      concept: asArray(result.conceptCatalog.data),
      region: asArray(result.regionCatalog.data),
      thsIndex: asArray(result.thsIndexCatalog.data)
    },
    catalogErrors: catalogFailures.map((item) => item.error),
    company,
    failures: uniqueFailures
  };
}

export { INDEXES };
