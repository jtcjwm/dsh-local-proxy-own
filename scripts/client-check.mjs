// Verify the browser bundle registers itself and its plugin-page card under a
// stubbed module loader (no browser, no DSH).
const registered = []
const disposers = []

const reactStub = {
  createElement: (...args) => ({ type: args[0], props: args[1], children: args.slice(2) }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
}

globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      const module = factory((name) => {
        if (name === 'react') return reactStub
        throw new Error(`unexpected require: ${name}`)
      })
      if (typeof module.apply !== 'function') throw new Error('module has no apply()')
      registered.push({ id, module })
    },
  },
  setInterval: () => 0,
  clearInterval: () => {},
}

globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild: () => {} },
}

globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, running: false, port: 7899, config: { port: 7899 }, systemProxy: {} }),
})

await import('../src/client.js')

let card = null
// 与真实 SlotRegistry 同构的最小面（2026-10-22 实测语义）：row.config 由
// plugin-manager main 挂载时声明；已声明时 apply 直接 register，不走 inject。
const slots = {
  spec(name) {
    return name === 'plugins.row.config' ? { kind: 'keyed', scope: 'root' } : undefined
  },
  register(config, component) {
    if (config.name !== 'plugins.row.config') throw new Error(`unexpected slot ${config.name}`)
    card = { config, component }
    return () => {}
  },
  subscribe: () => () => {},
}

const ctx = { slots }

const entry = registered.find((item) => item.id === 'dsh-local-proxy-own')
if (!entry) throw new Error(`client bundle not registered: ${registered.map((item) => item.id).join(',')}`)
entry.module.apply(ctx)

if (!card) throw new Error('plugin row.config card was not registered')
if (card.config.key !== 'dsh-local-proxy-own#dsh-local-proxy-own') throw new Error(`unexpected slot key: ${card.config.key}`)
if (typeof card.component !== 'function') throw new Error('card component is not a component')

// Render both views with the stub: must return a node, never throw.
const summary = card.component({ view: 'summary' })
const page = card.component({ view: 'page' })
if (!summary || !page) throw new Error('card render returned nothing')

console.log('PASS client bundle registers dsh-local-proxy-own')
console.log(`PASS slot key ${card.config.key}`)
console.log('PASS summary/page render paths return nodes')
