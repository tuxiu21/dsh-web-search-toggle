/**
 * dsh-web-search-toggle — model-native search first, DeepSeek as fallback.
 *
 * The shipped composition pins `searchProvider` to DeepSeek, so `web_search`
 * is always billed to DeepSeek no matter which model the conversation runs on.
 * This plugin replaces that selection with a routing provider:
 *
 * - A route listed in `nativeRoutes` (Gemini by default) sees `web_search`
 *   backed by that model vendor's own search: the plugin issues an auxiliary
 *   Gemini request with the `google_search` grounding tool and returns the
 *   grounded answer plus its resolved source URLs. Search therefore uses the
 *   model family's own retrieval (query fan-out, ranking), not a third party.
 * - Every other route is OFF by default. Switching a route ON in
 *   Settings → Models admits `web_search` there and executes it through the
 *   DeepSeek Search API — the explicit fallback for models without native
 *   search.
 *
 * Nothing here modifies DSH: this is an ordinary SearchProvider in the
 * existing registry, and tool visibility already follows `searchReady()`.
 *
 * @module dsh-web-search-toggle
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

/** Cordis plugin name; also the Config namespace the Client face writes. */
export const name = 'web-search-toggle'

/** Services this plugin needs: the web seam and the credential store. */
export const inject = ['web', 'credentials']

/**
 * Runtime settings. Every field is volatile so a settings write changes the
 * next tool step without reloading the plugin.
 */
export const Config = z.object({
  /** Fallback switch per model route (DeepSeek backend). Absent/false = OFF. */
  routes: z.dict(z.boolean()).default({}).volatile(),
  /** Routes served by the model vendor's own search. */
  nativeRoutes: z.dict(z.boolean()).default({ 'google-vertex': true, 'gcp-vertex': true }).volatile(),
  /**
   * Experimental: inject the Gemini grounding tool into the model's own
   * request instead of serving `web_search` from an auxiliary request. The
   * model then searches inside its answer (SillyTavern-like); structured
   * sources are unavailable in that mode.
   */
  inlineNative: z.boolean().default(false).volatile(),
  /** Experimental: same idea for DeepSeek's own server-side search (Anthropic-compatible route). */
  inlineDeepSeek: z.boolean().default(false).volatile(),
  /** DeepSeek Search endpoint base including its path prefix; `/search` is appended. */
  baseURL: z.string().default('https://api.deepseek.com/v1/tools').volatile(),
  /** Credential reference holding the DeepSeek API key. */
  apiKeyEnv: z.string().default('DEEPSEEK_API_KEY').volatile(),
  /** Results requested per search, 1..50. */
  count: z.number().default(10).volatile(),
  /** DeepSeek requests started per second; the public limit is 5 QPS. */
  requestsPerSecond: z.number().default(5).volatile(),
  /** Gemini/Vertex endpoint base, with its `/v1` prefix. */
  geminiBaseURL: z.string().default('https://aiplatform.googleapis.com/v1').volatile(),
  /** Grounding model; empty uses the conversation's own model when known. */
  geminiModel: z.string().default('').volatile(),
  /** Credential reference holding the Vertex/Gemini API key. */
  geminiApiKeyEnv: z.string().default('GOOGLE_VERTEX_API_KEY').volatile(),
  /** Outbound HTTP proxy for Gemini calls (empty = direct). */
  proxyUrl: z.string().default('').volatile(),
})

/** Registry id; the bundle patch pins it through `web.searchProvider`. */
const PROVIDER_ID = 'web-search-toggle'

/** Per-request wall clock budget; the tool itself allows 60s. */
const REQUEST_TIMEOUT_MS = 55_000

/** Timeout for resolving one grounding redirect to its real URL. */
const REDIRECT_TIMEOUT_MS = 6_000

/** Default grounding model when neither config nor the session names one. */
const FALLBACK_GEMINI_MODEL = 'gemini-3.8-flash'

/** Instruction wrapper for the auxiliary grounding request. */
const GROUNDING_INSTRUCTION = '你是检索助手。使用 Google 搜索核实事实，用简体中文给出简短要点，保留可核对的信息。'

/** Global marker for the scoped fetch rewriter, so a plugin reload never stacks wrappers. */
const INLINE_FETCH = Symbol.for('dsh-web-search-toggle.inline-fetch')

/**
 * Install, once per process, a fetch wrapper that appends a vendor-native
 * search tool to model requests issued inside an inline scope:
 *
 * - Vertex `:generateContent` gets Gemini's `google_search` grounding tool.
 * - DeepSeek's Anthropic-compatible `/v1/messages` gets its server-side
 *   `web_search_20250305` tool (verified accepted alongside client tools).
 *
 * The injection is opt-in and fully guarded: any surprise (non-JSON body, an
 * unexpected Headers shape) falls back to the untouched request, so a bug here
 * costs search, never the model call.
 */

/** Server-side search uses granted per DeepSeek request; refreshed from config by `apply`. */
const inlinePolicy = { deepseekMaxUses: 5 }

function installInlineFetch() {
  if (globalThis[INLINE_FETCH] !== undefined) return
  const storage = new AsyncLocalStorage()
  const original = globalThis.fetch
  globalThis[INLINE_FETCH] = storage
  globalThis.fetch = async (input, init) => {
    try {
      if (storage.getStore() !== true) return await original(input, init)
      const url = typeof input === 'string' ? input : input?.url
      if (typeof url !== 'string' || typeof init?.body !== 'string') return await original(input, init)
      const gemini = /:(?:stream)?[gG]enerateContent/u.test(url)
      const deepseek = /\/v1\/messages(?:\?|$)/u.test(url)
      if (!gemini && !deepseek) return await original(input, init)
      const payload = JSON.parse(init.body)
      const tools = Array.isArray(payload.tools) ? [...payload.tools] : []
      if (gemini) {
        const grounded = tools.some((tool) => tool !== null && typeof tool === 'object'
          && ('google_search' in tool || 'googleSearch' in tool))
        if (!grounded) tools.push({ google_search: {} })
      } else {
        const grounded = tools.some((tool) => tool !== null && typeof tool === 'object'
          && typeof tool.type === 'string' && tool.type.startsWith('web_search_'))
        if (!grounded) tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: inlinePolicy.deepseekMaxUses })
      }
      const headers = new Headers(init.headers ?? {})
      // The body length changed; let fetch compute the new one.
      headers.delete('content-length')
      return await original(input, { ...init, headers, body: JSON.stringify({ ...payload, tools }) })
    } catch {
      return original(input, init)
    }
  }
}

/**
 * Yield a model stream while the inline scope is active, so every fetch the
 * adapter performs inside it is eligible for the grounding rewrite.
 * @param storage - the scope installed by {@link installInlineFetch}.
 * @param next - the adapter call the waterfall hands over.
 */
async function* runInline(storage, next) {
  const iterator = storage.run(true, () => next()[Symbol.asyncIterator]())
  let done = false
  try {
    for (;;) {
      const step = await storage.run(true, () => iterator.next())
      if (step.done === true) {
        done = true
        return
      }
      yield step.value
    }
  } finally {
    if (!done && typeof iterator.return === 'function') await storage.run(true, () => iterator.return())
  }
}

export function apply(ctx, config) {
  /** Monotonic DeepSeek request start times inside the current one-second window. */
  const starts = []
  /** Cached undici proxy dispatcher per proxy URL. */
  const dispatchers = new Map()

  /** The model route of the request that is calling this tool, when known. */
  const currentRoute = () => {
    try { return ctx.get('agents')?.currentInitiator()?.session.requestContext()?.provider } catch { return undefined }
  }

  /** The model id of the request that is calling this tool, when known. */
  const currentModel = () => {
    try { return ctx.get('agents')?.currentInitiator()?.session.requestContext()?.model } catch { return undefined }
  }

  /** Whether this route is served by the vendor's own search. */
  const nativeFor = (route) => route !== undefined && config.nativeRoutes.get()[route] === true

  /** Whether this route has the DeepSeek fallback switched on. */
  const fallbackOn = (route) => route !== undefined && config.routes.get()[route] === true

  /** Whether this route grounds inside the model's own request instead of a tool. */
  const inlineFor = (route) => route !== undefined
    && ((config.inlineNative.get() === true && nativeFor(route))
      || (config.inlineDeepSeek.get() === true && route === 'deepseek-official'))

  /** Resolve a named credential: provider-managed store first, environment second. */
  async function readKey(envName) {
    const name = envName
    try {
      const resolved = await ctx.credentials.resolve(credentialRef(name))
      if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) return resolved.value
    } catch {
      // An unreadable store behaves like an absent key; the environment fallback still applies.
    }
    const fromEnv = process.env[name]
    return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined
  }

  /** One HTTP request, optionally through the configured proxy dispatcher. */
  async function transmit(url, init) {
    const proxyUrl = config.proxyUrl.get()
    if (proxyUrl.length === 0) return fetch(url, init)
    const { ProxyAgent, fetch: proxied } = await import('undici')
    let dispatcher = dispatchers.get(proxyUrl)
    if (dispatcher === undefined) {
      dispatcher = new ProxyAgent({ uri: proxyUrl, proxyTunnel: true })
      dispatchers.set(proxyUrl, dispatcher)
    }
    return proxied(url, { ...init, dispatcher })
  }

  /** A per-request signal that also expires after `ms`. */
  const budget = (signal, ms) => AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(ms)])

  /**
   * Resolve one grounding redirect to the page it points at.
   * @param uri - the `vertexaisearch.cloud.google.com/grounding-api-redirect/...` URL.
   * @returns the redirect target when one is exposed, else the original URL.
   */
  async function resolveGroundingUrl(uri) {
    try {
      const response = await transmit(uri, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(REDIRECT_TIMEOUT_MS) })
      const location = response.headers.get('location')
      return location === null ? uri : new URL(location, uri).toString()
    } catch {
      return uri
    }
  }

  /**
   * Ask Gemini to search through its own grounding and project the result.
   * @param request - the tool request (one query, optional result cap).
   * @param signal - caller cancellation.
   * @returns the grounded answer as `content` and its resolved sources.
   */
  async function geminiSearch(request, signal) {
    const key = await readKey(config.geminiApiKeyEnv.get())
    if (key === undefined) {
      const ref = JSON.stringify(config.geminiApiKeyEnv.get())
      throw new WebError(`Gemini 内置搜索已启用，但没有可用的凭据 ${ref}。请在凭据设置中保存它，或在启动环境里导出。`, 'WEB_PROVIDER_CREDENTIAL_MISSING')
    }

    const base = config.geminiBaseURL.get().replace(/\/+$/u, '')
    const configuredModel = config.geminiModel.get()
    const model = configuredModel.length > 0 ? configuredModel : (currentModel() ?? FALLBACK_GEMINI_MODEL)
    const endpoint = `${base}/publishers/google/models/${model}:generateContent`
    const maxResults = Math.min(config.count.get(), request.maxResults ?? config.count.get())

    const body = {
      contents: [{ role: 'user', parts: [{ text: `${GROUNDING_INSTRUCTION}\n\n查询：${request.query}` }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0, maxOutputTokens: 900 },
    }

    let response
    try {
      response = await transmit(endpoint, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: budget(signal, REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      if (signal?.aborted === true) throw aborted(signal, error)
      throw new WebError(`Gemini 搜索请求失败：${message(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      let detail = ''
      try {
        const payload = await response.json()
        const text = payload?.error?.message ?? payload?.message
        if (typeof text === 'string' && text.length > 0) detail = `：${text}`
      } catch {
        // A non-JSON error body only costs the richer detail, never the status.
      }
      throw new WebError(`Gemini 搜索返回 HTTP ${response.status}${detail}`, 'WEB_PROVIDER_ERROR')
    }

    let payload
    try {
      payload = await response.json()
    } catch (error) {
      if (signal?.aborted === true) throw aborted(signal, error)
      throw new WebError(`Gemini 搜索返回了无法解析的响应：${message(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    const candidate = payload?.candidates?.[0]
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
    const content = parts.map((part) => typeof part?.text === 'string' ? part.text : '').join('').trim()
    const metadata = candidate?.groundingMetadata
    const chunks = Array.isArray(metadata?.groundingChunks) ? metadata.groundingChunks : []
    const supports = Array.isArray(metadata?.groundingSupports) ? metadata.groundingSupports : []

    const collected = []
    const seen = new Set()
    // Resolve every distinct redirect concurrently: the HEAD round trips are
    // independent, and doing them in series dominates this backend's latency.
    const candidates = []
    for (const [index, chunk] of chunks.entries()) {
      const web = chunk?.web
      const uri = typeof web?.uri === 'string' ? web.uri : undefined
      if (uri === undefined || seen.has(uri)) continue
      seen.add(uri)
      candidates.push({ index, uri, web })
      if (candidates.length >= maxResults * 2) break
    }
    const resolved = await Promise.all(candidates.map((candidate) => resolveGroundingUrl(candidate.uri)))
    for (const [position, candidate] of candidates.entries()) {
      const url = resolved[position]
      // A grounding chunk can point at a Google SERP rather than the page itself.
      if (/\bgoogle\.[a-z.]+\/search\b/u.test(url)) continue
      // Keep one source per host: the model only needs a diverse citation list.
      let host
      try { host = new URL(url).hostname } catch { host = url }
      if (seen.has(`host:${host}`)) continue
      seen.add(`host:${host}`)
      const web = candidate.web
      const snippet = supports
        .filter((support) => Array.isArray(support?.groundingChunkIndices) && support.groundingChunkIndices.includes(candidate.index))
        .map((support) => typeof support?.segment?.text === 'string' ? support.segment.text : '')
        .join(' ')
        .replace(/\s+/gu, ' ')
        .trim()
      const title = typeof web?.title === 'string' && web.title.length > 0 ? web.title : web?.domain
      collected.push({
        url,
        ...typeof title === 'string' && title.length > 0 ? { title } : {},
        ...snippet.length > 0 ? { snippet: snippet.slice(0, 300) } : {},
      })
      if (collected.length >= maxResults) break
    }

    return {
      ...content.length > 0 ? { content } : {},
      sources: collected,
      truncated: collected.length >= maxResults && chunks.length > collected.length,
    }
  }

  /** Resolve once the rolling one-second window has room; abortable. */
  async function waitForSlot(limit, signal) {
    for (;;) {
      if (signal?.aborted === true) throw aborted(signal)
      const now = performance.now()
      while (starts.length > 0 && starts[0] < now - 1000) starts.shift()
      if (starts.length < limit) {
        starts.push(now)
        return
      }
      await delay(starts[0] + 1001 - now, signal)
    }
  }

  /** One DeepSeek Search API request; the explicit fallback backend. */
  async function deepSeekSearch(request, signal) {
    const key = await readKey(config.apiKeyEnv.get())
    if (key === undefined) {
      const ref = JSON.stringify(config.apiKeyEnv.get())
      throw new WebError(
        `该模型已改为使用 DeepSeek 备用搜索，但没有可用的凭据 ${ref}。`
        + ' 请在凭据设置中保存它，或在启动环境里导出，然后重试。',
        'WEB_PROVIDER_CREDENTIAL_MISSING',
      )
    }

    const configured = config.count.get()
    const count = Math.min(configured, typeof request.maxResults === 'number' ? request.maxResults : configured)
    const endpoint = `${config.baseURL.get().replace(/\/+$/u, '')}/search`
    await waitForSlot(config.requestsPerSecond.get(), signal)

    let response
    try {
      response = await transmit(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'deepseek-harness-web-search-toggle/1.0',
        },
        body: JSON.stringify({ query: request.query, count, need_content: false }),
        signal: budget(signal, REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      if (signal?.aborted === true) throw aborted(signal, error)
      throw new WebError(`DeepSeek Search 请求失败：${message(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      let detail = ''
      try {
        const payload = await response.json()
        const error = payload?.error
        const text = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : payload?.message
        if (typeof text === 'string' && text.length > 0) detail = `：${text}`
      } catch {
        // A non-JSON error body only costs the richer detail, never the status.
      }
      throw new WebError(`DeepSeek Search 返回 HTTP ${response.status}${detail}`, 'WEB_PROVIDER_ERROR')
    }

    try {
      return mapSearchResponse(await response.json())
    } catch (error) {
      if (error instanceof WebError) throw error
      if (signal?.aborted === true) throw aborted(signal, error)
      throw new WebError(`DeepSeek Search 返回了无法解析的响应：${message(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  const provider = {
    id: PROVIDER_ID,
    title: '模型内置搜索（DeepSeek 备用）',
    description: {
      en: 'Gemini routes search through Gemini grounding automatically. Other routes are off until enabled in Settings → Models, where they fall back to the DeepSeek Search API (billed per request).',
      zh: 'Gemini 路由自动使用 Gemini 原生搜索；其他模型默认关闭，在「设置 → 模型」里打开后才使用 DeepSeek Search API 作为备用（按次计费）。',
    },
    /** The router is always selectable; visibility is decided by `ready`. */
    available: () => true,
    /**
     * Tool admission per model step. Native routes are admitted whenever the
     * vendor credential is present — unless inline grounding is on, because
     * then the model searches inside its own request and a tool would only
     * duplicate it. Other routes are admitted only when switched on.
     */
    ready: async (llmProvider) => {
      if (llmProvider === undefined) return false
      if (inlineFor(llmProvider)) return false
      if (nativeFor(llmProvider)) {
        return (await readKey(config.geminiApiKeyEnv.get())) !== undefined
      }
      return fallbackOn(llmProvider)
    },
    search: async (request, signal) => {
      const route = currentRoute()
      if (nativeFor(route)) return geminiSearch(request, signal)
      return deepSeekSearch(request, signal)
    },
  }

  installInlineFetch()
  inlinePolicy.deepseekMaxUses = 5
  const inlineStorage = globalThis[INLINE_FETCH]
  ctx.on('llm/stream', (options, next) => inlineFor(options?.provider) ? runInline(inlineStorage, next) : next())

  ctx.effect(() => ctx.web.registerSearchProvider(provider))
}

/**
 * Validate an untrusted DeepSeek Search payload and project it into `WebSearchResult`.
 * @param payload - decoded JSON body.
 * @returns sources in provider order with optional fields only when present.
 */
export function mapSearchResponse(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.results)) throw invalidResponse()
  const sources = payload.results.map((item) => {
    if (!isRecord(item) || typeof item.url !== 'string' || item.url.length === 0
      || typeof item.title !== 'string' || typeof item.snippet !== 'string'
      || (item.summary !== undefined && typeof item.summary !== 'string')
      || (item.date !== null && typeof item.date !== 'string')) throw invalidResponse()
    return {
      url: item.url,
      ...item.title.length > 0 ? { title: item.title } : {},
      ...item.snippet.length > 0 ? { snippet: item.snippet } : {},
      ...typeof item.summary === 'string' && item.summary.length > 0 ? { summary: item.summary } : {},
      ...item.date !== null && item.date.length > 0 ? { publishedAt: item.date } : {},
    }
  })
  return { sources, truncated: false }
}

/** Narrow a decoded JSON value to a plain object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The stable malformed-response error. */
function invalidResponse() {
  return new WebError('DeepSeek Search 返回了无效的响应体', 'WEB_PROVIDER_ERROR')
}

/** The stable cancellation error, retaining the caller's reason. */
function aborted(signal, fallback) {
  return new WebError('网页搜索已取消', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** Delay resolution, or early when the caller aborts. */
function delay(ms, signal) {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Best-effort message extraction for diagnostics. */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}
