/**
 * Client face of dsh-web-search-toggle: per model-provider switches inside
 * Settings → Models, written straight into the plugin's live Config
 * (`routes.<providerId>`). The Host face reads that map on every tool step, so
 * a switch takes effect on the next turn without a reload.
 *
 * Written directly in the loader's closure-factory format to keep this bundle
 * dependency-free: React and the UI primitives are resolved through the
 * injected `require`, never from node_modules.
 */
window.__ModuleLoader__.load({
  id: 'dsh-web-search-toggle',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const Switch = primitives.Switch
    const h = React.createElement

    const en = {
      title: 'Web search',
      hint: 'Gemini models search through Gemini native grounding automatically — no switch needed. The switches below are the DeepSeek fallback for models without native search; it stays off by default.',
      useFor: 'Use DeepSeek fallback search for {provider}',
      empty: 'No model providers are registered yet.',
      loading: 'Loading model providers…',
      loadFailed: 'Unable to load model providers.',
      footnote: 'Switches save immediately and apply to the next model step. Gemini native search never bills DeepSeek; the fallback does (per request). web_fetch stays available either way.',
      inline: 'Ground inside the model request (experimental)',
      inlineHint: 'Gemini searches during its own answer, like a chat client. Sources are no longer structured, so the web_search card disappears on Gemini routes.',
      inlineDs: 'Inject DeepSeek server-side search (experimental)',
      inlineDsHint: 'DeepSeek searches inside its own answer through its Anthropic-compatible route. No structured sources and no web_search card on that route.',
    }
    const zh = {
      title: '网页搜索',
      hint: 'Gemini 模型自动使用 Gemini 原生搜索，无需开关。下面的开关是给没有内置搜索的模型用的 DeepSeek 备用搜索，默认全部关闭。',
      useFor: '为 {provider} 启用 DeepSeek 备用搜索',
      empty: '尚未注册模型提供商',
      loading: '正在加载模型提供商…',
      loadFailed: '模型提供商列表加载失败',
      footnote: '开关立即保存，对下一个模型步骤生效。Gemini 原生搜索不产生 DeepSeek 费用；备用搜索按次计费。web_fetch 始终可用，不受此处影响。',
      inline: '把 Gemini 搜索注入主请求（实验）',
      inlineHint: 'Gemini 在回答过程中直接联网，像聊天客户端那样。来源不再结构化，Gemini 路由的 web_search 卡片会消失。',
      inlineDs: '把 DeepSeek 服务端搜索注入主请求（实验）',
      inlineDsHint: 'DeepSeek 通过它的 Anthropic 兼容端点在回答过程中直接联网；该路由没有结构化来源，web_search 卡片会消失。',
    }

    const styles = {
      panel: {
        border: '1px solid var(--dsw-alias-settings-card-stroke)',
        borderRadius: 'var(--dsw-radius-lg)',
        padding: '16px',
        display: 'grid',
        gap: '12px',
        minWidth: 0,
      },
      paragraph: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' },
      heading: { margin: 0, fontSize: '15px', fontWeight: 500 },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', fontSize: '13px', minWidth: 0 },
      identity: { display: 'grid', gap: '2px', minWidth: 0 },
      id: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      list: { display: 'grid', gap: '12px' },
      notice: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
    }

    function Controls(props) {
      const { useSearch, write, loadProviders, subscribeProviders, t } = props
      const snapshot = useSearch((value) => value)
      const values = (snapshot && snapshot.value) || {}
      const routes = values.routes || {}
      const [providers, setProviders] = React.useState(undefined)
      const [loadFailed, setLoadFailed] = React.useState(false)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let active = true
        let generation = 0
        const refresh = async () => {
          const current = ++generation
          try {
            const list = await loadProviders()
            if (!active || current !== generation) return
            setProviders(list)
            setLoadFailed(false)
          } catch {
            if (active && current === generation) setLoadFailed(true)
          }
        }
        const dispose = subscribeProviders(refresh)
        void refresh()
        return () => {
          active = false
          dispose()
        }
      }, [loadProviders, subscribeProviders])

      const disabled = busy || !snapshot || snapshot.status !== 'ready' || !snapshot.writable

      const toggle = async (id, value) => {
        setBusy(true)
        try {
          await write(['routes', id], value)
        } catch {
          // The next snapshot still carries the previous value; nothing to revert locally.
        } finally {
          setBusy(false)
        }
      }

      const rows = (providers || []).map((provider) => h(
        'div',
        { key: provider.id, style: styles.row },
        h(
          'span',
          { style: styles.identity },
          h('span', null, provider.name),
          provider.name === provider.id ? null : h('small', { style: styles.id }, provider.id),
        ),
        h(Switch, {
          label: t('useFor').replace('{provider}', provider.name),
          checked: routes[provider.id] === true,
          disabled,
          onChange: (value) => { void toggle(provider.id, value) },
        }),
      ))

      const inlineRow = h(
        'div',
        { style: styles.row },
        h('span', { style: styles.identity }, h('span', null, t('inline')), h('small', { style: styles.id }, t('inlineHint'))),
        h(Switch, {
          label: t('inline'),
          checked: values.inlineNative === true,
          disabled,
          onChange: (value) => { void write(['inlineNative'], value) },
        }),
      )

      const inlineDsRow = h(
        'div',
        { style: styles.row },
        h('span', { style: styles.identity }, h('span', null, t('inlineDs')), h('small', { style: styles.id }, t('inlineDsHint'))),
        h(Switch, {
          label: t('inlineDs'),
          checked: values.inlineDeepSeek === true,
          disabled,
          onChange: (value) => { void write(['inlineDeepSeek'], value) },
        }),
      )

      return h(
        'section',
        { 'aria-label': t('title'), style: styles.panel },
        h('h3', { style: styles.heading }, t('title')),
        h('p', { style: styles.paragraph }, t('hint')),
        providers === undefined && !loadFailed ? h('p', { role: 'status', style: styles.paragraph }, t('loading')) : null,
        loadFailed ? h('p', { role: 'alert', style: styles.paragraph }, t('loadFailed')) : null,
        providers !== undefined && providers.length === 0 ? h('p', { style: styles.paragraph }, t('empty')) : null,
        inlineRow,
        inlineDsRow,
        h('div', { style: styles.list }, rows),
        h('p', { style: styles.notice }, t('footnote')),
      )
    }

    const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.llm']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register('web-search-toggle', {
        en, zh, ja: en, es: en, fr: en, de: en, ru: en, pt: en,
      }))
      const scope = ctx.configForms.get('web-search-toggle')
      const loadProviders = async () => {
        const result = await ctx.remote.llm.listProviders()
        if (!result.ok) throw new Error('Unable to load model providers')
        return result.value
      }
      const subscribeProviders = (listener) => {
        const disposers = [ctx.remote.$on('llm/adapters-updated', listener), ctx.on('connection/reset', listener)]
        return () => {
          for (const dispose of disposers) dispose()
        }
      }
      const write = (path, value) => scope.mutate([{ op: 'set', path, value }])
      const injected = () => ({
        hooks: { search: scope },
        write,
        loadProviders,
        subscribeProviders,
        t: ctx.locale.bind('web-search-toggle'),
      })
      ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
        name: 'settings.models.footer',
        id: 'web-search-toggle',
        order: 110,
        inject: injected,
      }, Controls))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
  meta: () => ({ stylesheets: {} }),
})
