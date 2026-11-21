# dsh-web-search-toggle

**模型内置搜索优先，DeepSeek 只做备用。** 纯插件实现，没有修改 DSH 任何代码：它只是注册进既有搜索引擎的一个普通 `SearchProvider`，而 `web_search` 的可见性本来就跟随 `searchReady()`。

## 设计

| 模型路由 | 谁执行搜索 | 默认状态 | 费用 |
|---|---|---|---|
| `google-vertex`、`gcp-vertex`（Gemini） | **Gemini 原生 grounding**（`google_search`），插件在工具层发一次独立的 grounding 请求，返回 grounded 摘要 + 真实来源 URL | **常开**，无需开关 | Google 按 grounding 计费（以官网为准） |
| 其他路由（`deepseek-official`、`hl`…） | DeepSeek Search API | **关**；在「设置 → 模型」里打开 | $0.75 / 1,000 次成功请求 |

所以：

- 用 Gemini 时，`web_search` 自动出现，搜索走的是 Gemini 自己的检索（会自己扩写查询，例如 `江阴 天气` → `["江阴 天气","江阴 天气预报 今天"]`），**不花 DeepSeek 的钱**；
- 用没有内置搜索的模型时，默认不给工具；你手动打开备用开关后，才走 DeepSeek；
- 同一路由只会走其中一条，不存在重复调用、重复计费。

## 一次 Gemini 搜索发生了什么

1. 主模型（Gemini）决定查资料，调用 `web_search(["江阴今天天气"])`；
2. 插件向 Vertex 发一次 `generateContent`，带 `tools: [{ google_search: {} }]`；
3. Gemini 用它自己的 grounding 检索、扩写、融合，返回摘要与 `groundingMetadata`；
4. 插件把 `groundingChunks` 里的重定向 URL 逐个 `HEAD` 解析成真实页面地址，按域名去重，并把 grounded 摘要作为 `content`、来源作为 `sources`；
5. 结果作为工具结果回到主对话，模型据此作答并引用。

实测：一次调用约 7–30 秒（取决于 grounding 与重定向解析），结果形如

```text
content: 江阴今天（2026-11-21）天气要点…
sources: weather.com.cn / tianqi.so.com / rp5.kz / baidu.com
```

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `nativeRoutes` | `{google-vertex: true, gcp-vertex: true}` | 使用模型厂商原生搜索的路由 |
| `routes` | `{}` | DeepSeek 备用开关；缺省全关 |
| `geminiBaseURL` | `https://aiplatform.googleapis.com/v1` | Vertex 端点前缀 |
| `geminiModel` | `""` | grounding 用的模型；空 = 用当前会话的模型 |
| `geminiApiKeyEnv` | `GOOGLE_VERTEX_API_KEY` | Vertex/Gemini 凭据引用 |
| `proxyUrl` | `""` | Gemini 出网代理（本机为 `http://127.0.0.1:7890`） |
| `baseURL` | `https://api.deepseek.com/v1/tools` | DeepSeek 备用搜索端点 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | DeepSeek 凭据引用 |
| `count` | `10` | 每次搜索的来源上限（1–50） |
| `requestsPerSecond` | `5` | DeepSeek 备用搜索的本地限速 |

本次部署的 profile patch（`/root/.dsh/profiles/web/cordis.patch.yml`）：

```yaml
- id: web-search-toggle
  name: dsh-web-search-toggle
  config:
    routes: {}
    nativeRoutes:
      google-vertex: true
      gcp-vertex: true
    proxyUrl: http://127.0.0.1:7890
```

## 设置界面

「设置 → 模型 → 提供商列表下方 → 网页搜索」：每个提供商一个开关，含义是**该路由使用 DeepSeek 备用搜索**（Gemini 路由无需打开）。开关即时保存，对下一个模型步骤生效。

## 实验：把 grounding 注入主请求（SillyTavern 式）

设置面板新增一行开关「把 Gemini 搜索注入主请求（实验）」，对应配置 `inlineNative`（默认 `false`）。打开后：

1. 在 `llm/stream` 的异步作用域里包一层 fetch（SDK 用的是全局 fetch）；
2. 发往 Vertex 的 `:generateContent` / `:streamGenerateContent` 请求体被追加 `tools: [{ google_search: {} }]`，并删掉 `content-length` 让 fetch 重算；
3. `ready()` 对 Gemini 路由返回 false，`web_search` 工具消失——避免和内置 grounding 重复；
4. 模型在**自己的这次生成里**联网，像酒馆那样。

代价：DSH 拿不到 `groundingMetadata`，所以没有结构化来源、没有搜索卡片、无法审计查了哪些站点；失败时（body 不是 JSON、Headers 形状异常）会自动回退到原始请求，不会影响模型调用。改回 `inlineNative: false` 即恢复工具模式。

### DeepSeek 也能请求内搜索

`inlineDeepSeek`（默认 `false`）做同一件事，对象是 DeepSeek：它的主聊天路由走的是 Anthropic 兼容端点（`https://api.deepseek.com/anthropic/v1/messages`），该端点支持服务端 `web_search_20250305` 工具，并且**可以和函数工具放在同一个请求里**（已实测：返回 `server_tool_use` + `web_search_tool_result` + 带数据的回答，HTTP 200）。打开后插件在请求体 `tools` 追加该服务端工具，并让 `ready()` 对该路由返回 false（隐藏 `web_search` 工具）。

注意：不是把 Google 的 `google_search` 塞给 DeepSeek——那是 Google 的服务端工具，只有 Gemini 会执行；DeepSeek 用的是它自己的服务端搜索。该能力按模型 token 计费（官方自 2026-11-18 起，服务端搜索调用本身不再单独收费）。

## 已知限制

- 默认的 Gemini 原生搜索走**独立 grounding 请求**（可审计、可引用）；`inlineNative` 打开后才改为请求内注入，此时没有结构化来源。
- 只支持 API Key（`GOOGLE_VERTEX_API_KEY` / `DEEPSEEK_API_KEY`），未实现服务账号 JWT 或登录账号 token 路径。
- 出网需要代理时必须在 `proxyUrl` 里显式配置；DSH 的 `dsh-model-proxy` 不覆盖本插件的请求。
- 重定向解析失败时保留 grounding 的原始跳转 URL（仍可访问）。

## 卸载

从 profile `package.json` 删掉依赖与 `dsh.profile.bundles` 中的 `dsh-web-search-toggle`，删 `node_modules/dsh-web-search-toggle` 软链，重启 DSH。bundle patch 会随 bundle 消失，`web.searchProvider` 回到默认的 `deepseek-search-api`。
