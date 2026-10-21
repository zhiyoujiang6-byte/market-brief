# 市场大势研判

一个可操作的 A 股研究终端。数据由服务端从扶摇 REST API 和用户账号生成的 iFinD MCP 服务读取；GPT‑6 Astra 只整理证据，不补造数值、来源或时间。页面支持指数切换、日线回看、市场宽度、成分股和估值、涨跌停池、热榜、板块目录、个股财务指标、手动执行 iFinD 只读查询、证据定位和定向追问。

## 在线产品与提交材料

- 在线产品：[市场大势研判](https://market-brief-1uxc.onrender.com/)。页面使用 HTTP Basic 登录保护，评审账号和口令已放在提交包中的独立文件 `market-brief-review-access.md`，随作品提供给评审。
- 源码仓库：[TriaEvenstar/market-brief](https://github.com/TriaEvenstar/market-brief)。仓库当前为私有，提交前需确认评审方有读取权限。
- [提交说明](docs/submission/提交说明.md)、[AI 使用与验证记录](docs/submission/AI使用与验证记录.md)、[测试与验收记录](docs/submission/测试与验收记录.md)和[提交通行清单](docs/submission/提交通行清单.md)记录交付范围与验证结果。

## 本地运行

需要 Node.js 22.9 或更新版本。将 `.env.example` 复制为 `.env` 并填写服务端密钥，然后运行：

```powershell
node --env-file-if-exists=.env server.js
```

打开 `http://localhost:4173`。项目没有第三方运行时依赖。若配置文件或密钥在服务器启动后发生变化，重启服务再刷新页面。

## 托管部署

项目包含可直接用于 Render Blueprint 的 `render.yaml` 和适用于 Render、Railway、Fly.io 等 Docker 托管平台的 `Dockerfile`。服务监听平台注入的 `PORT`，生产环境自动绑定 `0.0.0.0`；`GET /healthz` 返回不含密钥的进程存活状态，供平台健康检查使用。部署时只在平台的密钥设置中填写 `APP_ACCESS_PASSWORD`、`LLM_API_KEY` 和 `FUYAO_API_KEY`，不要把它们写入镜像或提交到代码库。

Docker 镜像不会复制 `private/`。托管时可将完整的 iFinD `mcpServers` JSON 作为平台密钥环境变量 `IFIND_MCP_CONFIG_JSON` 注入；文件配置（`IFIND_MCP_CONFIG_FILE`）存在时优先使用文件，只有文件不存在时才回退到该环境变量。若平台支持安全的私有文件挂载，也可将配置文件挂载到运行时并设置 `IFIND_MCP_CONFIG_FILE`，不要把含 MCP Key 的 JSON 放进构建上下文。

模型配置使用 CodeYu OpenAI-compatible API：

```dotenv
LLM_BASE_URL=https://codeyu.shop/v1
LLM_API_KEY=在本机或托管环境填写
LLM_MODEL=gpt-6-astra
LLM_REASONING_EFFORT=high
LLM_TIMEOUT_MS=180000
```

`LLM_API_KEY` 与运行环境注入的 `CODEYU_API_KEY` 二选一。密钥只由服务端读取。此前发到聊天的 API 密钥应先在 CodeYu 轮换，再配置新的密钥。

## 扶摇数据

在同花顺账号的扶摇 API Key 管理页签发密钥：

- [扶摇 API 文档](https://fuyao.aicubes.cn/docs/)
- [扶摇快速开始](https://fuyao.aicubes.cn/docs/quickstart/)
- [API Key 管理](https://fuyao.aicubes.cn/admin/)

设置 `FUYAO_API_KEY`。服务端使用 `X-api-key` 请求头，绝不把密钥发送到浏览器。

已接入接口：

- 指数行情快照、指数日线历史、股票日线历史：`/api/a-share-index/prices/snapshot`、`/api/a-share-index/prices/historical`、`/api/a-share/prices/historical`
- 全市场 A 股快照和市场宽度：`/api/a-share/prices/snapshot`，按默认每页 100 条读取最多 80 页；上涨/下跌/平盘、占比、中位数和成交额由服务器根据有效返回快照计算，并标明覆盖数。上游总数超过读取上限或分页失败时会标记为部分覆盖。
- 指数或板块成分、行业/概念/地域/同花顺指数目录：`/api/a-share-index/constituents/ths-stock-list`、`/api/a-share-index/catalog/ths-index-list`
- 当前估值快照：`/api/a-share/valuations/snapshot`，按每批最多 100 个代码请求。页面中的 PE/PB 中位数只统计当前成分股的正值，不加权；没有历史估值数据。
- 交易日历、涨停/跌停池、涨停统计、人气热榜：`/api/a-share/calendar/trading-days`、`/api/a-share/special-data/**`
- 个股财务指标：`/api/a-share/financials/indicators`。输入完整证券代码和报告期后读取，原始接口结构保留用于核对。

扶摇业务响应即使 HTTP 200 也要检查 `code`。行情涨跌幅 `price_change_ratio_pct` 使用百分数值（例如 1.74 表示 1.74%）；成交量为股，成交额为原始货币单位；历史 K 线使用 `date_ms`, `open_price`, `high_price`, `low_price`, `close_price`, `volume`, `turnover`。

## iFinD MCP

在 [iFinD MCP 站点](https://mcp.51ifind.com/?syncCookieTimes=1)登录后，按个人中心中的使用指引启用服务、获取 MCP Key 并生成服务配置：

- [开通与准备](https://mcp.51ifind.com/?syncCookieTimes=1#/docs/guide-prepare)
- [数据覆盖](https://mcp.51ifind.com/?syncCookieTimes=1#/domains)
- [常见问题](https://mcp.51ifind.com/?syncCookieTimes=1#/docs/guide-faq)

将官方生成的标准 `mcpServers` JSON 放在 `private/ifind-mcp.json`，或设置 `IFIND_MCP_CONFIG_FILE` 指向该文件。可以通过 `IFIND_MCP_SERVER_NAME` 指定配置项名称。配置文件与其中的 MCP Key 已由 `.gitignore` 排除，不要放到 `public/`、代码仓库或聊天里。不要复制示例里的服务 URL；每个账号生成的地址不同。

在没有可挂载私有文件的托管平台上，将同一份完整 JSON 放入密钥变量 `IFIND_MCP_CONFIG_JSON`。该变量只由服务端读取，不会出现在 `/api/config` 或配置状态响应中。

服务端通过 Streamable HTTP 执行 MCP 初始化、工具发现和只读工具调用。页面提供工具筛选、参数结构和手动查询；只读标注明确或可识别为数据查询的工具才会启用。未配置时不会生成假的资金、宏观、政策、新闻或跨市场数据。MCP 结果以不可信文本处理，并带工具名称和调用时间进入证据包。

## 研判与数据口径

模型只接收当前缓存的真实数据和用户实际执行的 MCP 结果。服务端校验模型引用的证据编号，引用不存在的数据会拒绝展示。全市场快照覆盖不完整、来源时间不一致或字段缺失时，页面和提示词都要求降低置信度。指标值、接口字段、数据时点和计算方法可在证据卡片中展开。

行情缓存有效期为 15 分钟；生成研判时发现缓存过期或服务重启后缓存丢失，页面会自动重新读取当前筛选条件的行情并继续生成一次。模型请求默认最多等待 180 秒，可用 `LLM_TIMEOUT_MS` 设置为 1000–300000 毫秒；保留高推理配置，不自动重复发起已失败的模型调用。

产品不生成确定性涨跌预测、收益承诺、仓位建议、买卖指令或个股推荐。行情数据可能延迟或受授权范围影响；用户应核验原始数据和交易所公告。本工具不构成投资建议。

## 公网运行

默认只监听本机回环地址。托管平台或反向代理需将 `HOST` 设为 `0.0.0.0`，并通过 HTTPS 对外服务。公网环境必须设置 `NODE_ENV=production` 和非空 `APP_ACCESS_PASSWORD`；服务端会用 HTTP Basic 访问口令保护页面和 API。数据源和模型密钥也必须放在服务端的 Secret 管理功能中。不要把无访问控制的实例暴露到公网，否则他人可能消耗你的 API 额度。

运行测试：

```powershell
node --test --test-isolation=none
```

