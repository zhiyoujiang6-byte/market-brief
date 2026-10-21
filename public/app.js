const $ = (selector) => document.querySelector(selector);
const state = { market: null, marketId: "", evidence: [], ifindResults: [], tools: [], analysisQuestion: "", sector: "", analysisBusy: false };
let marketLoadPromise = null;
let marketLoadRequest = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function number(value, digits = 2) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "--";
  return Number(value).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function dateLabel(value) {
  if (!value) return "上游未提供时点";
  const raw = Number(value);
  const date = Number.isFinite(raw) ? new Date(raw < 100000000000 ? raw * 1000 : raw) : new Date(value);
  if (Number.isNaN(date.getTime())) return "上游时点无效";
  return date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function statusLabel(status) {
  return ({ ready: "正常", configured: "正常", partial: "部分可用", unconfigured: "暂不可用", invalid: "暂不可用", error: "暂不可用" })[status] || "暂不可用";
}

function setPill(selector, status, title) {
  const el = $(selector);
  if (!el) return;
  el.className = `status-chip ${status === "ready" || status === "configured" ? "ready" : status === "partial" ? "partial" : status === "unconfigured" ? "" : "error"}`;
  el.innerHTML = `<i></i>${escapeHtml(title)}：${escapeHtml(statusLabel(status))}`;
}

function formatChange(value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return `<span class="flat">--</span>`;
  const n = Number(value);
  const cls = n > 0 ? "up" : n < 0 ? "down" : "flat";
  return `<span class="${cls}">${n > 0 ? "+" : ""}${number(n)}%</span>`;
}

function formatCurrency(value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "--";
  return `${number(Number(value) / 100000000)} 亿元`;
}

function renderIndexStrip(market) {
  const chosen = state.market?.options?.index;
  const indexes = market.indexes || [];
  $("#index-strip").innerHTML = indexes.length ? indexes.map((item) => `
    <article class="index-card ${item.thscode === chosen ? "selected" : ""}">
      <div class="index-name"><span>${escapeHtml(item.name || item.thscode || "指数")}</span><span class="index-code">${escapeHtml(item.thscode || "")}</span></div>
      <div class="index-last">${number(item.last_price)}</div>
      <div class="index-change">${formatChange(item.price_change_ratio_pct)}<span class="muted-small"> · 成交 ${formatCurrency(item.turnover)}</span></div>
    </article>`).join("") : `<div class="empty-inline">扶摇指数快照未返回数据。</div>`;
}

function renderChart(market) {
  const canvas = $("#price-chart");
  const empty = $("#chart-empty");
  const historyData = market.company?.ticker ? market.company.history : market.history;
  const historyRows = Array.isArray(historyData) ? historyData : (historyData?.item || []);
  const rows = historyRows.filter((item) => Number.isFinite(Number(item.date_ms)) && Number.isFinite(Number(item.close_price)))
    .sort((a, b) => Number(a.date_ms) - Number(b.date_ms));
  $("#chart-title").textContent = `${market.company?.ticker ? `${market.company.ticker} · ` : ""}${state.sector ? "所选板块" : state.market?.options?.index || "指数"} 历史行情`;
  const timestamp = market.company?.ticker ? historyData?.timestamp : market.historyTimestamp;
  $("#history-source").textContent = timestamp ? `扶摇日线 · ${dateLabel(timestamp)}` : "扶摇日线";
  if (!rows.length) {
    empty.textContent = "暂无历史行情数据";
    empty.hidden = false;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  empty.hidden = true;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = rect.width;
  const height = rect.height;
  const pad = { left: 42, right: 12, top: 15, bottom: 24 };
  const values = rows.map((item) => Number(item.close_price));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(1, Math.abs(max) * 0.01);
  const xAt = (index) => pad.left + index / Math.max(1, rows.length - 1) * (width - pad.left - pad.right);
  const yAt = (value) => pad.top + (max - value) / span * (height - pad.top - pad.bottom);
  ctx.clearRect(0, 0, width, height);
  ctx.font = "9px DM Mono, monospace";
  ctx.fillStyle = "#879188";
  ctx.strokeStyle = "#e8ece8";
  ctx.lineWidth = 1;
  for (let line = 0; line <= 3; line += 1) {
    const y = pad.top + line / 3 * (height - pad.top - pad.bottom);
    const value = max - line / 3 * span;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    ctx.fillText(number(value, value < 10 ? 2 : 0), 2, y + 3);
  }
  const first = new Date(Number(rows[0].date_ms)).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" });
  const last = new Date(Number(rows.at(-1).date_ms)).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" });
  ctx.fillText(first, pad.left, height - 5);
  ctx.fillText(last, Math.max(pad.left, width - pad.right - 35), height - 5);
  const positive = values.at(-1) >= values[0];
  ctx.strokeStyle = positive ? "#c04a41" : "#18805a";
  ctx.lineWidth = 1.7;
  ctx.beginPath();
  values.forEach((value, index) => index ? ctx.lineTo(xAt(index), yAt(value)) : ctx.moveTo(xAt(index), yAt(value)));
  ctx.stroke();
  ctx.fillStyle = positive ? "#c04a41" : "#18805a";
  ctx.beginPath(); ctx.arc(xAt(values.length - 1), yAt(values.at(-1)), 3, 0, Math.PI * 2); ctx.fill();
}

function renderBreadth(breadth) {
  if (!breadth) {
    $("#breadth-coverage").textContent = "未读取";
    $("#breadth-metrics").innerHTML = `<p class="empty-inline">暂无市场宽度数据</p>`;
    $("#advance-bar").style.width = "0%";
    $("#decline-bar").style.width = "0%";
    $("#flat-bar").style.width = "0%";
    return;
  }
  const coverage = breadth.total == null ? `${breadth.observed} 只返回` : `${breadth.observed}/${breadth.total} 只返回${breadth.complete ? " · 完整" : " · 部分"}`;
  $("#breadth-coverage").textContent = coverage;
  const denominator = breadth.changeObserved || 0;
  const pct = (value) => denominator ? (value / denominator * 100) : 0;
  $("#advance-bar").style.width = `${pct(breadth.advancing)}%`;
  $("#decline-bar").style.width = `${pct(breadth.declining)}%`;
  $("#flat-bar").style.width = `${pct(breadth.unchanged)}%`;
  $("#breadth-metrics").innerHTML = [
    ["上涨 / 下跌 / 平盘", `${number(breadth.advancing, 0)} / ${number(breadth.declining, 0)} / ${number(breadth.unchanged, 0)}`, `有效涨跌幅 ${number(denominator, 0)} 只`],
    ["上涨家数占比", `${number(breadth.advanceRatioPct)}%`, "分母为有效涨跌幅快照数"],
    ["涨跌幅中位数", `${number(breadth.medianChangePct)}%`, "仅对已返回有效值计算"],
    ["快照成交额合计", formatCurrency(breadth.turnover), "按已返回行情快照汇总"],
    ["目录覆盖", coverage, breadth.complete ? "上游总数已全部分页返回" : "覆盖不完整时降低判断置信度"],
    ["数据时点", dateLabel(state.market?.marketSnapshotTimestamp), "以扶摇快照时间为准"]
  ].map(([label, value, foot]) => `<div class="metric"><span class="metric-label">${escapeHtml(label)}</span><strong class="metric-value">${escapeHtml(value)}</strong><span class="metric-foot">${escapeHtml(foot)}</span></div>`).join("");
}

function renderSpecials(market) {
  const stats = market.limitStats?.item || market.limitStats || {};
  const twoBoardPromotionRate = Array.isArray(stats.page_boards) ? stats.page_boards.find((item) => item.board_level === "two")?.promotion_rate : null;
  $("#special-date").textContent = `交易日 ${market.tradingDay?.date || "未确认"}`;
  $("#limit-metrics").innerHTML = [
    ["涨停", stats.limit_up_stock_count, "只", "up", false],
    ["触板", stats.touched_limit_up_stock_count, "只", "up", false],
    ["炸板", stats.open_stock_count, "只", "down", false],
    ["封板率", stats.seal_rate, "%", "flat", true],
    ["2板晋级率", twoBoardPromotionRate, "%", "flat", true]
  ].map(([label, value, unit, cls, ratio]) => `<div class="limit-metric"><span>${escapeHtml(label)}</span><strong class="${cls}">${escapeHtml(value == null ? "--" : number(ratio ? Number(value) * 100 : value))}<small> ${escapeHtml(unit)}</small></strong></div>`).join("");
  renderCompactList("#limit-up-list", "#limit-up-count", market.limitUp || []);
  renderCompactList("#limit-down-list", "#limit-down-count", market.limitDown || []);
  renderCompactList("#hot-list", null, market.hotList || []);
}

function renderCompactList(listSelector, countSelector, rows) {
  if (countSelector) $(countSelector).textContent = `${rows.length} 条`;
  const name = (item) => item.name || item.ticker || item.thscode || item.stock_name || "未命名";
  const metadata = (item) => {
    const parts = [];
    if (item.rank != null) parts.push(`#${item.rank}`);
    if (item.continue_day_text) parts.push(item.continue_day_text);
    else if (item.continue_day_cnt != null) parts.push(`${item.continue_day_cnt}连板`);
    if (item.limit_up_time) parts.push(`封板 ${item.limit_up_time}`);
    if (item.first_limit_time || item.last_limit_time) parts.push(`跌停 ${item.first_limit_time || "--"}/${item.last_limit_time || "--"}`);
    if (item.open_times != null) parts.push(`开板 ${item.open_times}次`);
    if (item.price_change_ratio_pct != null) parts.push(`${number(item.price_change_ratio_pct)}%`);
    if (item.turnover_ratio_pct != null) parts.push(`换手 ${number(item.turnover_ratio_pct)}%`);
    if (item.seal_money != null) parts.push(`封单 ${formatCurrency(item.seal_money)}`);
    if (item.turnover != null) parts.push(`成交 ${formatCurrency(item.turnover)}`);
    if (item.heat != null && !parts.length) parts.push(String(item.heat));
    return parts.join(" · ");
  };
  $(listSelector).innerHTML = rows.length ? rows.slice(0, 12).map((item) => `
    <div class="compact-row"><span class="compact-name" title="${escapeHtml(item.thscode || item.ticker || "")}">${escapeHtml(name(item))}</span><span class="compact-meta" title="${escapeHtml(metadata(item))}">${escapeHtml(metadata(item))}</span></div>`).join("") : `<p class="empty-inline">扶摇未返回记录。</p>`;
}

function renderConstituents(market) {
  const list = market.constituentRows || market.constituents || [];
  $("#constituent-title").textContent = state.sector ? "板块成分" : "指数成分";
  $("#constituent-count").textContent = `${list.length} 只`;
  $("#constituent-rows").innerHTML = list.length ? list.slice(0, 50).map((item) => `
    <tr><td>${escapeHtml(item.thscode || "--")}</td><td>${escapeHtml(item.name || "--")}</td><td>${formatChange(item.priceChangePct)}</td><td>${item.peTTM == null ? "--" : number(item.peTTM)}</td></tr>`).join("") : `<tr><td colspan="4" class="empty-cell">扶摇未返回成分数据。</td></tr>`;
}

function renderCompany(market) {
  const company = market.company;
  $("#company-panel").hidden = !company;
  if (!company) return;
  $("#company-heading").textContent = `${company.ticker} 财务指标`;
  $("#company-report").textContent = company.report ? `报告期 ${company.report}` : "未选择报告期";
  const errorLabels = new Set((company.errors || []).map((item) => item.label));
  const details = errorLabels.size
    ? [errorLabels.has("companyHistory") && "个股日线暂不可用", errorLabels.has("companyFinancials") && "财务数据暂不可用"].filter(Boolean).join("；")
    : company.report ? "财务指标" : "个股历史日线已读取。选择财报期后可加载财务指标。";
  $("#company-status").textContent = details;
  $("#company-financials").textContent = company.financials ? JSON.stringify(company.financials, null, 2) : "当前没有财务指标返回。";
}

function renderCatalog(market) {
  const group = $("#catalog-type").value;
  const search = $("#sector-search").value.trim().toLowerCase();
  const items = market.catalogs?.[group] || [];
  const filtered = items.filter((item) => `${item.name || ""} ${item.thscode || ""} ${item.ticker || ""}`.toLowerCase().includes(search));
  $("#sector-list").innerHTML = filtered.length ? filtered.slice(0, 80).map((item) => {
    const code = item.thscode || item.ticker || "";
    return `<button class="sector-item" type="button" data-sector="${escapeHtml(code)}" title="读取 ${escapeHtml(item.name || code)} 当前成分"><span class="sector-name">${escapeHtml(item.name || "未命名板块")}</span><span class="sector-code">${escapeHtml(code)}</span></button>`;
  }).join("") : `<p class="empty-inline">没有匹配目录项目，或该目录不可用。</p>`;
  document.querySelectorAll("[data-sector]").forEach((button) => button.addEventListener("click", () => {
    state.sector = button.dataset.sector;
    loadMarket();
  }));
}

function renderEvidence(evidence = []) {
  state.evidence = evidence;
  $("#evidence-count").textContent = `${evidence.length} 项`;
  $("#evidence-grid").innerHTML = evidence.length ? evidence.map((item) => `
    <article class="evidence-card" id="e-${escapeHtml(item.id)}" tabindex="0" role="button" aria-label="查看 ${escapeHtml(item.name)} 来源">
      <div class="evidence-group">${escapeHtml(item.group)} · ${escapeHtml(item.id)}</div><div class="evidence-name">${escapeHtml(item.name)}</div>
      <div class="evidence-value">${escapeHtml(typeof item.value === "object" ? JSON.stringify(item.value) : item.value)} ${escapeHtml(item.unit)}</div>
      <div class="evidence-meta">${escapeHtml(item.asOf)} · ${escapeHtml(item.source)}</div>
      <div class="evidence-detail">字段：${escapeHtml(item.field)}<br>接口：${escapeHtml(item.endpoint)}<br>口径：${escapeHtml(item.method)}</div>
    </article>`).join("") : `<p class="empty-inline">暂无可引用的数据。</p>`;
  document.querySelectorAll(".evidence-card").forEach((card) => {
    const toggle = () => card.classList.toggle("active");
    card.addEventListener("click", toggle);
    card.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); } });
  });
}

function renderMarket(payload) {
  state.market = { ...payload.market, options: payload.options || {} };
  state.marketId = payload.marketId;
  state.ifindResults = payload.ifindResults || [];
  const market = payload.market;
  setPill("#fuyao-status", market.source.status, "扶摇");
  $("#market-state").textContent = market.source.status === "ready" ? "行情已同步" : market.source.status === "unconfigured" ? "行情暂不可用" : "行情部分可用";
  $("#asof").textContent = dateLabel(market.source.updatedAt || market.indexTimestamp);
  $("#trading-day").textContent = `交易日：${market.tradingDay?.date || "未确认"}`;
  if (market.source.status === "unconfigured") showError("当前暂无行情数据，请稍后重试。", false);
  else if (market.failures?.length) {
    const labels = {
      indexSnapshot: "指数行情", calendar: "交易日历", marketSnapshots: "市场宽度",
      history: "历史行情", constituents: "指数成分", industryCatalog: "行业目录",
      conceptCatalog: "概念目录", regionCatalog: "地域目录", thsIndexCatalog: "同花顺指数目录",
      limitStats: "涨停统计", limitUp: "涨停池", limitDown: "跌停池", hotList: "人气榜",
      companyHistory: "个股历史行情", companyFinancials: "个股财务", valuations: "估值"
    };
    showError(`部分数据暂不可用：${market.failures.map((failure) => labels[failure.label] || "其他数据").join("、")}。其余数据仍可查看。`, false);
  }
  else clearError();
  renderIndexStrip(market);
  renderChart(market);
  renderBreadth(market.breadth);
  renderSpecials(market);
  renderConstituents(market);
  renderCompany(market);
  renderCatalog(market);
  state.ifindResults = payload.ifindResults || state.ifindResults;
  const combined = [...(payload.evidence || []), ...state.ifindResults];
  renderEvidence(uniqueEvidence(combined));
  $("#footer-meta").textContent = `扶摇更新 ${dateLabel(market.source.updatedAt)} · iFinD 结果 ${state.ifindResults.length} 项`;
}

function uniqueEvidence(items) {
  return [...new Map(items.filter(Boolean).map((item) => [item.id, item])).values()];
}

function showError(message, isError = true) {
  $("#error").textContent = message;
  $("#error").className = `error-banner ${isError ? "" : "notice-banner"}`;
  $("#error").hidden = false;
}

function clearError() { $("#error").hidden = true; }

async function readResponse(response, fallback) {
  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    const error = new Error(`${fallback}（HTTP ${response.status}，服务返回格式异常）`);
    error.httpStatus = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(payload?.error || `${fallback}（HTTP ${response.status}）`);
    error.httpStatus = response.status;
    error.code = payload?.code;
    throw error;
  }
  return payload;
}

function loadMarket() {
  const params = new URLSearchParams({
    index: $("#index-select").value,
    days: $("#days-select").value,
    ticker: $("#ticker").value.trim().toUpperCase(),
    report: $("#report-select").value,
    sector: state.sector
  }).toString();
  marketLoadRequest = { key: params };
  if (marketLoadPromise) return marketLoadPromise;
  marketLoadPromise = (async () => {
    const button = $("#refresh");
    button.disabled = true;
    button.textContent = "读取中…";
    state.marketId = "";
    clearError();
    try {
      while (true) {
        const request = marketLoadRequest;
        try {
          const response = await fetch(`/api/market?${request.key}`);
          const payload = await readResponse(response, "读取行情失败");
          if (request.key !== marketLoadRequest.key) continue;
          renderMarket(payload);
          return payload;
        } catch (error) {
          if (request.key !== marketLoadRequest.key) continue;
          state.marketId = "";
          showError(error.message || "读取行情失败");
          return null;
        }
      }
    } finally {
      button.disabled = false;
      button.textContent = "刷新数据";
      marketLoadPromise = null;
      marketLoadRequest = null;
    }
  })();
  return marketLoadPromise;
}

function evidenceRefs(ids = []) {
  return ids.map((id) => `<button class="ref" type="button" data-ref="${escapeHtml(id)}">${escapeHtml(id)}</button>`).join("");
}

function evidenceList(items = []) {
  return items.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item.text || item)}${evidenceRefs(item.evidenceIds)}</li>`).join("")}</ul>` : `<p class="unknown-list">当前证据不足以支持该项。</p>`;
}

function renderAnalysis(result, meta) {
  const conditions = result.conditions.map((item) => `<div class="condition-row"><span class="condition-direction ${item.direction === "削弱" ? "weak" : ""}">${escapeHtml(item.direction || "待核验")}</span><span>${escapeHtml(item.text || "")}${evidenceRefs(item.evidenceIds)}</span></div>`).join("") || `<p class="unknown-list">暂无可核验的状态条件。</p>`;
  const unknowns = result.unknowns.length ? `<ul class="unknown-list">${result.unknowns.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p class="unknown-list">模型未列出其他数据缺口。</p>`;
  const followups = result.followups.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  $("#brief").innerHTML = `
    <div class="brief-head"><div><span class="section-kicker">模型归纳 · ${escapeHtml(meta.generatedAt ? dateLabel(meta.generatedAt) : "刚刚")}</span><h3>${escapeHtml(result.headline)}</h3><p>${escapeHtml(result.summary)}</p></div><div class="confidence">置信度 ${escapeHtml(result.confidence)}</div></div>
    <div class="brief-grid">
      <section class="brief-panel"><h4><i class="panel-mark"></i>支持证据</h4>${evidenceList(result.support)}</section>
      <section class="brief-panel counter"><h4><i class="panel-mark"></i>反向证据</h4>${evidenceList(result.counter)}</section>
      <section class="brief-panel"><h4><i class="panel-mark"></i>状态切换条件</h4><div>${conditions}</div></section>
      <section class="brief-panel"><h4><i class="panel-mark"></i>尚不确定</h4>${unknowns}${followups ? `<ul class="unknown-list" style="margin-top:7px">${followups}</ul>` : ""}</section>
    </div>
    <div class="analysis-meta">${escapeHtml(meta.model)} · 引用 ${state.evidence.length} 项数据</div>`;
  $("#empty-state").hidden = true;
  $("#brief").hidden = false;
  document.querySelectorAll("[data-ref]").forEach((button) => button.addEventListener("click", () => {
    const card = document.getElementById(`e-${button.dataset.ref}`);
    if (card) { card.scrollIntoView({ behavior: "smooth", block: "center" }); card.classList.add("active"); setTimeout(() => card.classList.remove("active"), 1600); }
  }));
}

function setAnalysisBusy(busy) {
  state.analysisBusy = busy;
  const button = $("#analyze");
  const followupButton = $("#followup-submit");
  const followupInput = $("#followup");
  if (button) {
    button.disabled = busy;
    button.textContent = busy ? "正在分析…" : "生成研判";
  }
  if (followupButton) followupButton.disabled = busy;
  if (followupInput) followupInput.disabled = busy;
}

async function analyze(followup = "") {
  if (state.analysisBusy) return false;
  setAnalysisBusy(true);
  clearError();
  $("#model-badge").textContent = "GPT‑6 Astra · 正在分析";
  state.analysisQuestion = $("#question").value.trim();
  let retriedAfterRefresh = false;
  try {
    if (marketLoadPromise || !state.marketId) {
      const refreshed = await loadMarket();
      if (!refreshed) throw new Error($("#error").textContent || "读取行情失败，请重试。");
    }
    while (true) {
      try {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: state.analysisQuestion, followup, marketId: state.marketId })
        });
        const payload = await readResponse(response, "模型分析失败");
        renderEvidence(payload.evidence);
        renderAnalysis(payload.analysis, payload);
        $("#model-badge").textContent = payload.model;
        return true;
      } catch (error) {
        const expired = error.httpStatus === 409 || error.code === "MARKET_EXPIRED";
        if (!retriedAfterRefresh && expired) {
          retriedAfterRefresh = true;
          const refreshed = await loadMarket();
          if (!refreshed) throw new Error($("#error").textContent || "读取行情失败，请重试。");
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    const message = /api key|模型 API|未配置模型/i.test(error.message) ? "当前暂时无法生成研判，请稍后重试。" : error.message;
    showError(`${message}；本次未生成研判。`, true);
    $("#model-badge").textContent = "分析未完成";
    return false;
  } finally {
    setAnalysisBusy(false);
  }
}

function filterTools() {
  const labels = {
    get_stock_summary: "股票概况", search_stocks: "股票检索", get_stock_performance: "个股表现",
    get_stock_info: "股票资料", get_stock_shareholders: "股东信息", get_stock_financials: "财务指标",
    get_risk_indicators: "风险指标", get_stock_events: "公司事件", get_esg_data: "ESG 数据",
    stock_highfreq_quotes: "股票高频行情", get_edb_data: "宏观指标数据", search_edb: "宏观指标检索",
    search_notice: "公告与政策检索", search_news: "新闻资讯检索", search_trending_news: "热点资讯",
    search_global_stocks: "跨市场股票检索", global_stock_profile: "跨市场公司资料",
    global_stock_quotes: "跨市场行情", global_stock_financial: "跨市场财务数据",
    global_stock_events: "跨市场公司事件", index_data: "指数数据", sector_data: "板块数据",
    index_highfreq_quotes: "指数高频行情"
  };
  const search = $("#tool-search").value.trim().toLowerCase();
  const filtered = state.tools.filter((tool) => `${tool.name} ${tool.serverName} ${tool.description}`.toLowerCase().includes(search));
  const select = $("#tool-select");
  const previous = select.value;
  select.innerHTML = `<option value="">选择数据主题 (${filtered.length})</option>` + filtered.map((tool) => {
    const key = JSON.stringify({ serverName: tool.serverName, name: tool.name });
    return `<option value="${escapeHtml(key)}">${escapeHtml(labels[tool.name] || tool.description?.split(/[。:：]/)[0] || tool.name)}</option>`;
  }).join("");
  if (filtered.some((tool) => JSON.stringify({ serverName: tool.serverName, name: tool.name }) === previous)) select.value = previous;
  updateToolDetails();
}

function updateToolDetails() {
  let selected = {};
  try { selected = JSON.parse($("#tool-select").value || "{}"); } catch {}
  const tool = state.tools.find((item) => item.serverName === selected.serverName && item.name === selected.name);
  $("#call-ifind").disabled = !tool || !tool.readOnly;
  const fields = $("#tool-argument-fields");
  if (!tool) {
    $("#tool-description").textContent = state.tools.length ? "选择数据主题查看可用指标。" : "当前暂无可用的扩展数据主题。";
    fields.innerHTML = "";
    return;
  }
  const schema = tool.inputSchema || { type: "object", properties: {} };
  const properties = schema.properties || {};
  const required = new Set(schema.required || []);
  const fieldLabels = {
    query: "查询内容", time_start: "开始日期", time_end: "结束日期", size: "返回数量",
    start_date: "开始日期", end_date: "结束日期", ticker: "证券代码", thscode: "证券代码",
    stock_code: "证券代码", index_code: "指数代码", sector_code: "板块代码", keyword: "关键词",
    period: "统计周期", date: "日期", limit: "返回数量", page: "页码"
  };
  $("#tool-description").innerHTML = escapeHtml(tool.description || "按条件查询该数据主题。") + `<details class="tool-schema"><summary>查看指标参数</summary><pre>${escapeHtml(JSON.stringify(schema, null, 2))}</pre></details>`;
  fields.innerHTML = Object.entries(properties).map(([name, spec]) => {
    const type = spec.type === "integer" ? "number" : spec.type || "string";
    const label = spec.title || fieldLabels[name] || name.replaceAll("_", " ");
    const placeholder = spec.description || "";
    if (type === "boolean") return `<label class="argument-check"><input type="checkbox" data-argument="${escapeHtml(name)}" data-type="boolean" data-required="${required.has(name)}">${escapeHtml(label)}${required.has(name) ? " *" : ""}</label>`;
    if (Array.isArray(spec.enum)) return `<label class="argument-field">${escapeHtml(label)}${required.has(name) ? " *" : ""}<select data-argument="${escapeHtml(name)}" data-type="string" data-required="${required.has(name)}"><option value="">请选择</option>${spec.enum.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}</select></label>`;
    if (type === "object" || type === "array") return `<label class="argument-field">${escapeHtml(label)}${required.has(name) ? " *" : ""}<textarea data-argument="${escapeHtml(name)}" data-type="${escapeHtml(type)}" data-required="${required.has(name)}" placeholder='${type === "array" ? "[]" : "{}"}'></textarea></label>`;
    const inputType = type === "number" ? "number" : "text";
    return `<label class="argument-field">${escapeHtml(label)}${required.has(name) ? " *" : ""}<input data-argument="${escapeHtml(name)}" data-type="${escapeHtml(type)}" data-required="${required.has(name)}" type="${inputType}" placeholder="${escapeHtml(placeholder)}" ${spec.default !== undefined ? `value="${escapeHtml(spec.default)}"` : ""}></label>`;
  }).join("");
}

async function loadIfind() {
  try {
    const response = await fetch("/api/ifind");
    const payload = await response.json();
    setPill("#ifind-status", payload.status.status, "iFinD");
    state.tools = (payload.tools || []).filter((tool) => tool.readOnly);
    $("#ifind-tool-count").textContent = `${state.tools.length} 个数据主题`;
    if (payload.status.status === "unconfigured" || payload.status.status === "invalid" || payload.status.status === "error") {
      $("#ifind-unconfigured").textContent = "iFinD 数据暂不可用。";
      $("#ifind-unconfigured").hidden = false;
    } else {
      $("#ifind-unconfigured").hidden = true;
    }
    filterTools();
  } catch (error) {
    setPill("#ifind-status", "error", "iFinD");
    $("#ifind-unconfigured").textContent = "iFinD 数据暂不可用。";
    $("#ifind-unconfigured").hidden = false;
  }
}

async function callIfind() {
  clearError();
  let selected = {};
  try { selected = JSON.parse($("#tool-select").value || "{}"); } catch {}
  const { name, serverName } = selected;
  let args;
  const formFields = [...$("#tool-argument-fields").querySelectorAll("[data-argument]")];
  try {
    if (formFields.length && !$(".raw-arguments").open) {
      args = {};
      for (const field of formFields) {
        if (field.dataset.required === "true" && field.type !== "checkbox" && !field.value.trim()) throw new Error("请填写必填查询条件。");
        if (field.type === "checkbox") { args[field.dataset.argument] = field.checked; continue; }
        if (!field.value.trim()) continue;
        if (field.dataset.type === "number") args[field.dataset.argument] = Number(field.value);
        else if (field.dataset.type === "object" || field.dataset.type === "array") args[field.dataset.argument] = JSON.parse(field.value);
        else args[field.dataset.argument] = field.value;
      }
    } else args = JSON.parse($("#tool-arguments").value || "{}");
  } catch (error) { showError(error.message === "请填写必填查询条件。" ? error.message : "请检查查询条件。", true); return; }
  if (!args || typeof args !== "object" || Array.isArray(args)) { showError("请检查查询条件。", true); return; }
  const button = $("#call-ifind");
  button.disabled = true;
  button.textContent = "查询中…";
  try {
    const response = await fetch("/api/ifind/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverName, name, arguments: args }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "iFinD 查询失败");
    state.ifindResults.push(payload.evidence);
    state.evidence = uniqueEvidence([...state.evidence, payload.evidence]);
    renderEvidence(state.evidence);
    $("#ifind-result").innerHTML = `<div class="source-label">${escapeHtml(payload.evidence.id)} · 已加入后续分析证据</div><pre>${escapeHtml(JSON.stringify(payload.value, null, 2))}</pre>`;
    $("#ifind-result").hidden = false;
    $("#footer-meta").textContent = `扶摇更新 ${dateLabel(state.market?.source?.updatedAt)} · iFinD 结果 ${state.ifindResults.length} 项`;
  } catch (error) {
    showError(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "查询数据";
  }
}

$("#refresh").addEventListener("click", loadMarket);
$("#index-select").addEventListener("change", () => { state.sector = ""; loadMarket(); });
$("#days-select").addEventListener("change", loadMarket);
$("#ticker").addEventListener("change", loadMarket);
$("#report-select").addEventListener("change", () => { if ($("#ticker").value.trim()) loadMarket(); });
$("#analyze").addEventListener("click", () => analyze());
$("#tool-search").addEventListener("input", filterTools);
$("#tool-select").addEventListener("change", updateToolDetails);
$("#call-ifind").addEventListener("click", callIfind);
$("#catalog-type").addEventListener("change", () => state.market && renderCatalog(state.market));
$("#sector-search").addEventListener("input", () => state.market && renderCatalog(state.market));
$("#followup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const followup = $("#followup").value.trim();
  if (!followup || state.analysisBusy) return;
  if (await analyze(followup)) $("#followup").value = "";
});

window.addEventListener("resize", () => { if (state.market) renderChart(state.market); });

async function init() {
  try {
    const config = await fetch("/api/config").then((response) => response.json());
    $("#model-badge").textContent = config.model.name;
  } catch {
    $("#model-badge").textContent = "模型暂不可用";
  }
  await Promise.all([loadIfind(), loadMarket()]);
}

init();
