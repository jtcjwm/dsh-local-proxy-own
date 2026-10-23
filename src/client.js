// dsh-local-proxy-own - client half.
//
// Renders the plugin row card (slot `plugins.row.config`, key is
// `<package>#<patch row id>` = dsh-local-proxy-own#dsh-local-proxy-own):
//
//   summary view -> one line: running/stopped + port + split + system proxy
//   page view    -> status lights, port/upstream, split radio, system-proxy
//                   radio + guard, node pool with latency grouped by country,
//                   one-click node/race switch, egress measurement, and
//                   start / stop / selftest.
//
// Everything talks to the host half over loopback JSON routes
// (/dsh-local-proxy-own/{status,start,stop,selftest,nodes,egress,switch}); no SDK
// import, so the card survives core UI revisions that keep the slot contract.
//
// Two polling rates on purpose: status is cheap (registry reads + a socket
// probe) so it refreshes every 2.5 s; the node table comes from a cache file
// and changes only on reprobe, so it refreshes every 20 s. Egress is NEVER
// polled - each call is a real 1~3 s round trip to a foreign host.
//
// The card never claims to bypass a network: with no upstream the proxy is a
// direct funnel, which is exactly what the copy in the card says.
window.__ModuleLoader__.load({
  id: 'dsh-local-proxy-own',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement

    const NS = 'dsh-local-proxy-own'
    const STYLE_ID = `${NS}-style`
    const STATUS_MS = 2500
    const NODES_MS = 20000

    const zh = {
      title: '本地代理',
      running: '运行中',
      stopped: '已停止',
      port: '端口',
      upstream: '上游（可选）',
      upstreamHint: '留空 = 直连；也可填 socks5://127.0.0.1:1080 或 http://host:port',
      localOnly: '只监听 127.0.0.1，不装驱动、不建 TUN、不装根证书、不做 TLS 解密。没有上游时它是直连收口工具，不承诺翻墙。',
      start: '开启',
      apply: '应用设置',
      stop: '关停',
      selftest: '自检',
      measure: '测当前出口',
      measuring: '测量中…',
      starting: '启动中…',
      stopping: '关停中…',
      testing: '自检中…',
      switching: '切换中…',
      summaryRunning: (port, split) => `运行中 127.0.0.1:${port} · ${split}`,
      summaryStopped: (port) => `已停止（端口 ${port} 待用）`,
      orphan: '检测到上一轮遗留进程，可点“关停”接管',
      logLine: (file) => `日志：${file}`,
      failed: '操作失败：',
      split: '分流',
      sysProxy: '系统代理',
      wireDsh: 'DSH 自身',
      wireDshHint: '开启后 DSH 自己的联网请求（web_fetch、搜索、子进程）也走这个代理；关停代理时自动卸下，不会把你锁在死端口上。',
      wireDshOn: '接上',
      wireDshOff: '不接',
      wireDshLive: (url) => `当前已接上 ${url}`,
      wireDshOff2: '当前未接线（DSH 自己的联网仍走直连）',
      guard: '守卫',
      guardHint: '每 N 秒核对注册表，被 Windows 自动检测／其它 VPN／组策略改回去就写回；代理进程一消失自动还原并停摆。',
      guardOn: (mode, sec, checks, repairs) => `守卫开着：档 ${mode}，每 ${sec} 秒，已巡 ${checks} 次，写回 ${repairs} 次`,
      guardOff: '守卫未开',
      pool: '节点池',
      race: '竞速（内核自己选最快）',
      single: '单节点',
      watcher: '节点文件守护',
      watcherOn: '开（改节点文件自动热更新）',
      watcherOff: '关',
      nodes: '节点',
      probeAge: (min) => (min == null ? '无探活缓存' : min < 60 ? `探活于 ${min} 分钟前` : `探活于 ${(min / 60).toFixed(1)} 小时前`),
      useNode: '用这条',
      inUse: '在用',
      backToRace: '切回竞速',
      reprobe: '重新探活',
      reprobeRunning: '探活进行中（全量约 2 分钟）…',
      reprobeStarted: '已起探活：内核逐条拨完会自动刷新这里（约 2 分钟）。',
      subTitle: '订阅',
      subHint: '一行一个节点链接（vmess/vless/trojan/ss/hysteria2…），或 base64 聚合订阅；拉来的节点写进节点文件并热更新，解析 0 条时绝不动旧文件。',
      subPlaceholder: 'https://…/subscribe/…（也可 file:// 或本地路径试格式）',
      subFetch: '拉取并更新节点',
      subFetching: '拉取中…',
      subApplied: (n, reload) => `订阅已更新 ${n} 条（${reload === 'watcher' ? '守护将热更' : reload === 'reload' ? '已热更内核' : '下次开启生效'}）`,
      subAuto: '自动刷新',
      subOff: '不自动',
      subEvery: (m) => (m >= 60 ? `${Math.round(m / 60)} 小时` : `${m} 分`),
      subLast: (t) => {
        const min = Math.max(0, Math.round((Date.now() - t.at) / 60000))
        return `上次拉取 ${min < 60 ? `${min} 分钟前` : `${(min / 60).toFixed(1)} 小时前`} · ${t.count} 条 · ${t.form === 'base64' ? 'base64 订阅' : '直链'}`
      },
      dead: '判死',
      egressTitle: '当前出口',
      egressVia: (t) => `经代理：${t}`,
      egressDirect: (t) => `直连：${t}`,
      egressDiffers: '两者不同 ⇒ 隧道真的在承载流量',
      egressSame: '⚠ 两者相同 ⇒ 当前是直连档，或隧道没生效',
      sysOff: '关闭',
      sysPac: 'PAC 分流',
      // 不叫「全局」：分流档里已经有一个「全局」（含义是全走隧道），两组同名
      // 会让用户分不清点的是哪个维度。这里叫「全代理」＝系统流量全交给代理。
      sysGlobal: '全代理',
      sysForeign: '⚠ 开着但不指向我们（别的软件设的，本插件不动它）',
      splitDirect: '直连',
      splitRule: '规则',
      splitAll: '全局',
      needRunning: '系统代理要先把代理开起来，否则等于把系统流量指向死端口。',
    }

    const SYS_MODES = [
      { key: 'off', label: zh.sysOff },
      { key: 'pac', label: zh.sysPac },
      { key: 'global', label: zh.sysGlobal },
    ]
    const SPLITS = [
      { key: 'direct', label: zh.splitDirect },
      { key: 'cn-direct', label: zh.splitRule },
      { key: 'all', label: zh.splitAll },
    ]

    // DSH 自身接线：与「系统代理」是两件不同的事——系统代理改注册表（整机流量），
    // 这里只改 DSH 自己进程内的 dispatcher（web_fetch / 搜索 / 子进程）。
    const WIRE_MODES = [
      { key: 'off', label: zh.wireDshOff },
      { key: 'on', label: zh.wireDshOn },
    ]

    // 国家码 → 中文名。探活缓存里存的是两位码，面板给人看要中文。
    const CC = {
      NL: '荷兰', JP: '日本', SG: '新加坡', EE: '爱沙尼亚', FR: '法国', CH: '瑞士',
      DK: '丹麦', RU: '俄罗斯', RO: '罗马尼亚', FI: '芬兰', DE: '德国', GB: '英国',
      US: '美国', HK: '香港', KR: '韩国', IN: '印度', BR: '巴西', PL: '波兰',
      LU: '卢森堡', SE: '瑞典', NO: '挪威', IT: '意大利', ES: '西班牙', CA: '加拿大',
      AU: '澳大利亚', CN: '中国',
    }
    // tag 形如「新加坡-HK04-H2」，国家名就在开头，比 country 字段更可靠
    function countryOf(node) {
      const tag = String(node.tag || '')
      const head = tag.split('-')[0]
      if (head && /[\u4e00-\u9fa5]/.test(head)) return head
      return CC[node.country] || node.country || '其它'
    }

    function msColor(ms) {
      if (ms == null) return 'var(--dsw-alias-text-secondary,#8b8b8b)'
      if (ms < 1000) return 'var(--dsw-alias-state-success-primary,#30a46c)'
      if (ms < 2500) return 'var(--dsw-alias-state-warning-primary,#f5a623)'
      return 'var(--dsw-alias-state-error-primary,#e5484d)'
    }

    function ensureStyle() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.dlp-card{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.5}
.dlp-head{display:flex;align-items:center;gap:8px;font-weight:600;flex-wrap:wrap}
.dlp-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#e5484d);flex:none}
.dlp-dot.on{background:var(--dsw-alias-state-success-primary,#30a46c);box-shadow:0 0 0 3px rgba(48,164,108,.16)}
.dlp-sub{color:var(--dsw-alias-text-secondary,#8b8b8b);font-weight:400}
.dlp-facts{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--dsw-alias-text-secondary,#8b8b8b)}
.dlp-facts b{color:inherit;font-weight:600}
.dlp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.dlp-field{display:flex;flex-direction:column;gap:4px}
.dlp-label{font-size:12px;color:var(--dsw-alias-text-secondary,#8b8b8b)}
.dlp-input{border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.35));border-radius:6px;padding:6px 8px;background:var(--dsw-alias-bg-elevated,transparent);color:inherit;font:inherit;min-width:0}
.dlp-input:focus{outline:2px solid var(--dsw-alias-border-focus,#4c8dff);outline-offset:0}
.dlp-input:disabled{opacity:.6}
.dlp-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.35));border-radius:6px;overflow:hidden;flex-wrap:wrap}
.dlp-seg button{border:0;border-right:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.35));padding:5px 12px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.dlp-seg button:last-child{border-right:0}
.dlp-seg button:hover:not(:disabled){background:var(--dsw-alias-bg-hover,rgba(127,127,127,.12))}
.dlp-seg button[aria-pressed="true"]{background:var(--dsw-alias-button-primary,#2f6feb);color:#fff}
.dlp-seg button:disabled{opacity:.5;cursor:default}
.dlp-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dlp-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.dlp-btn{border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.35));border-radius:6px;padding:6px 14px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.dlp-btn:hover:not(:disabled){background:var(--dsw-alias-bg-hover,rgba(127,127,127,.12))}
.dlp-btn:disabled{opacity:.5;cursor:default}
.dlp-btn.primary{border-color:transparent;background:var(--dsw-alias-button-primary,#2f6feb);color:#fff}
.dlp-btn.danger{border-color:transparent;background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff}
.dlp-btn.tiny{padding:2px 8px;font-size:12px;border-radius:5px}
.dlp-hint{font-size:12px;color:var(--dsw-alias-text-secondary,#8b8b8b)}
.dlp-note{font-size:12px;color:var(--dsw-alias-text-secondary,#8b8b8b);border-left:2px solid var(--dsw-alias-border-default,rgba(127,127,127,.35));padding-left:8px}
.dlp-err{font-size:12px;color:var(--dsw-alias-state-error-primary,#e5484d);white-space:pre-wrap;word-break:break-word}
.dlp-log{font-size:12px;color:var(--dsw-alias-text-secondary,#8b8b8b);word-break:break-all}
.dlp-checks{margin:0;padding-left:16px;font-size:12px;color:var(--dsw-alias-text-secondary,#8b8b8b)}
.dlp-checks li{word-break:break-word}
.dlp-egress{font-size:12px;border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.35));border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:3px}
.dlp-nodes{border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.35));border-radius:6px;overflow:hidden}
.dlp-nodes-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:7px 10px;background:var(--dsw-alias-bg-hover,rgba(127,127,127,.07));font-size:12px}
.dlp-cc{border-top:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.25))}
.dlp-cc:first-child{border-top:0}
.dlp-cc-head{padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer;display:flex;gap:8px;align-items:center;user-select:none}
.dlp-cc-head:hover{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.08))}
.dlp-cc-body{padding:0 10px 6px}
.dlp-node{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px;flex-wrap:wrap}
.dlp-node.dead{opacity:.5}
.dlp-rank{color:var(--dsw-alias-text-secondary,#8b8b8b);min-width:22px;text-align:right;font-variant-numeric:tabular-nums}
.dlp-tag{font-weight:500;min-width:150px}
.dlp-ms{font-variant-numeric:tabular-nums;min-width:58px;text-align:right;font-weight:600}
.dlp-meta{color:var(--dsw-alias-text-secondary,#8b8b8b);font-size:11px}
.dlp-cur{border:1px solid var(--dsw-alias-button-primary,#2f6feb);border-radius:4px;padding:0 5px;font-size:11px;color:var(--dsw-alias-button-primary,#2f6feb)}
`
      document.head.appendChild(style)
    }

    async function request(path, body) {
      const response = await fetch(`/dsh-local-proxy-own/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      })
      let data = {}
      try {
        data = await response.json()
      } catch {
        data = { ok: false, error: `HTTP ${response.status}` }
      }
      if (!response.ok && response.status !== 400) {
        const error = new Error(data.error || data.message || `HTTP ${response.status}`)
        error.payload = data
        throw error
      }
      return data
    }

    /** 分组并按延迟排序；死节点排到各组末尾。 */
    function groupNodes(ranked) {
      const groups = new Map()
      for (const n of ranked || []) {
        const c = countryOf(n)
        if (!groups.has(c)) groups.set(c, [])
        groups.get(c).push(n)
      }
      const out = []
      for (const [country, list] of groups) {
        list.sort((a, b) => {
          if (a.pass !== b.pass) return a.pass ? -1 : 1
          return (a.ms ?? 1e9) - (b.ms ?? 1e9)
        })
        const best = list.find((n) => n.pass)
        out.push({
          country,
          list,
          alive: list.filter((n) => n.pass).length,
          bestMs: best ? best.ms : null,
        })
      }
      out.sort((a, b) => b.alive - a.alive || (a.bestMs ?? 1e9) - (b.bestMs ?? 1e9))
      return out
    }

    function Segmented({ value, options, onChange, disabled, isDisabled, title }) {
      return h(
        'div',
        { className: 'dlp-seg', role: 'group', 'aria-label': title },
        options.map((o) =>
          h(
            'button',
            {
              key: o.key,
              type: 'button',
              // isDisabled 支持逐项控制：同一组按钮里有的该灰、有的不该灰。
              disabled: disabled || (isDisabled ? isDisabled(o.key) === true : false),
              'aria-pressed': value === o.key ? 'true' : 'false',
              title: o.hint || o.label,
              onClick: () => onChange(o.key),
            },
            o.label,
          ),
        ),
      )
    }

    function LocalProxyCard({ view }) {
      const [status, setStatus] = react.useState(null)
      const [nodes, setNodes] = react.useState(null)
      const [egress, setEgress] = react.useState(null)
      const [port, setPort] = react.useState('')
      const [upstream, setUpstream] = react.useState('')
      const [busy, setBusy] = react.useState('')
      const [error, setError] = react.useState('')
      const [notice, setNotice] = react.useState('')
      const [checks, setChecks] = react.useState(null)
      const [open, setOpen] = react.useState(() => new Set())
      // 订阅区：sub = 后端 /sub 快照 {subUrl, subRefreshMin, last}；
      // subUrlInput = 输入框内容；subTouched 防快照回填盖住正在打的字。
      const [sub, setSub] = react.useState(null)
      const [subUrlInput, setSubUrlInput] = react.useState('')
      // reprobing: 后台探活是否在跑（/reprobe GET）
      const [reprobing, setReprobing] = react.useState(false)
      const alive = react.useRef(true)
      const touched = react.useRef(false)
      const subTouched = react.useRef(false)

      react.useEffect(() => {
        ensureStyle()
        alive.current = true
        const pullStatus = async () => {
          try {
            const next = await request('status')
            if (!alive.current) return
            setStatus(next)
            if (!touched.current) {
              setPort(String(next.config?.port ?? ''))
              setUpstream(next.config?.upstream ?? '')
            }
          } catch {
            // host route missing (plugin half not loaded yet) - keep quiet
          }
        }
        const pullNodes = async () => {
          try {
            const next = await request('nodes')
            if (alive.current) setNodes(next)
          } catch {}
          // 订阅快照与后台探活状态跟节点表同频（都是低频、轻读）。
          try {
            const s = await request('sub')
            if (alive.current && s && s.ok !== false) {
              setSub(s)
              if (!subTouched.current) setSubUrlInput(s.subUrl || '')
            }
          } catch {}
          try {
            const rp = await request('reprobe')
            if (alive.current) setReprobing(rp?.running === true)
          } catch {}
        }
        pullStatus()
        pullNodes()
        const t1 = window.setInterval(pullStatus, STATUS_MS)
        const t2 = window.setInterval(pullNodes, NODES_MS)
        return () => {
          alive.current = false
          window.clearInterval(t1)
          window.clearInterval(t2)
        }
      }, [])

      const running = status?.running === true
      const disabled = busy !== ''

      const run = async (kind, fn) => {
        setBusy(kind)
        setError('')
        setNotice('')
        try {
          const msg = await fn()
          if (msg) setNotice(msg)
        } catch (caught) {
          setError(caught?.message || String(caught))
        } finally {
          if (alive.current) setBusy('')
        }
        if (alive.current) {
          const next = await request('status').catch(() => null)
          if (next && alive.current) setStatus(next)
        }
      }

      const doStart = () =>
        run('start', async () => {
          touched.current = false
          const r = await request('start', { port: Number(port) || undefined, upstream: upstream.trim() })
          if (r.selftest?.checks) setChecks(r.selftest)
          if (r.ok === false) throw new Error(r.message || r.error || '启动失败')
          return null
        })

      const doStop = () =>
        run('stop', async () => {
          const r = await request('stop', {})
          setChecks(null)
          if (r.ok === false) throw new Error(`${r.message || '关停未完全成功'}\n${(r.actions || []).join('\n')}`)
          return null
        })

      const doSelftest = () =>
        run('selftest', async () => {
          setChecks(null)
          const r = await request('selftest', {})
          setChecks(r)
          return r.ok === false ? '自检有 FAIL 项，见下方明细' : null
        })

      const doSwitch = (body, label) =>
        run('switch', async () => {
          const r = await request('switch', body)
          if (r.status) setStatus(r.status)
          if (r.ok === false) throw new Error(r.text || `${label}失败`)
          return r.text || `${label}完成`
        })

      // 后台探活：POST 只是「起飞」（不阻塞 2 分钟），之后由 pullNodes 的
      // 低频轮询看 probe.json 新鲜度与 running 标记自然收场。
      const doReprobe = () =>
        run('reprobe', async () => {
          const r = await request('reprobe', {})
          if (r.ok === false) throw new Error(r.error || '起不来')
          if (r.started) setReprobing(true)
          return r.started ? zh.reprobeStarted : `已在探活中（${r.sinceMin ?? 0} 分钟）`
        })

      const doSubFetch = () =>
        run('sub', async () => {
          const url = subUrlInput.trim()
          const r = await request('sub', { url, apply: true })
          if (r.ok === false) throw new Error(r.error || '订阅失败')
          setSub({ ok: true, subUrl: url, subRefreshMin: sub?.subRefreshMin || 0, last: { at: Date.now(), count: r.count, form: r.form } })
          return zh.subApplied(r.count, r.reload)
        })

      const doSubRefresh = (v) =>
        run('sub', async () => {
          const min = Number(v)
          const r = await request('sub', { refreshMin: min })
          if (r.ok === false) throw new Error(r.error || '设置失败')
          setSub((prev) => ({ ...(prev || {}), ok: true, subRefreshMin: (r.subRefreshMin ?? min) }))
          return min >= 5 ? `自动刷新已设为每 ${min} 分钟` : '自动刷新已关'
        })

      const doEgress = () =>
        run('egress', async () => {
          setEgress(null)
          const r = await request('egress')
          if (r.ok === false) throw new Error(r.error || '测不了出口')
          setEgress(r)
          return null
        })

      if (view === 'summary') {
        if (!status) return h('span', { className: 'dlp-sub' }, '…')
        return h(
          'span',
          { className: 'dlp-sub' },
          running
            ? zh.summaryRunning(status.port, status.splitLabel || status.split || '')
            : zh.summaryStopped(status.config?.port ?? 17899),
        )
      }

      const sysMode = status?.sysMode || 'off'
      const guard = status?.guard || null
      const groups = groupNodes(nodes?.probe?.ranked)
      // mode/node 取自 singbox-state.json（内核真实状态），不是配置里的意图——
      // 配置说 race、内核实际跑单节点时，面板必须显示内核那一套。
      const coreMode = nodes?.mode || 'race'
      const currentNode = coreMode === 'single' ? nodes?.node : null

      return h(
        'div',
        { className: 'dlp-card' },

        // --- 状态头 ---
        h(
          'div',
          { className: 'dlp-head' },
          h('span', { className: `dlp-dot${running ? ' on' : ''}` }),
          h('span', null, running ? zh.running : zh.stopped),
          h('span', { className: 'dlp-sub' }, running ? `127.0.0.1:${status.port}` : `端口 ${status?.config?.port ?? 17899} 待用`),
          status?.orphan ? h('span', { className: 'dlp-err' }, zh.orphan) : null,
        ),
        h(
          'div',
          { className: 'dlp-facts' },
          h('span', null, '上游 ', h('b', null, status?.upstream || '直连')),
          h('span', null, '分流 ', h('b', null, status?.splitLabel || status?.split || '—')),
          h('span', null, '系统代理 ', h('b', null, sysMode === 'foreign' ? zh.sysForeign : (SYS_MODES.find((m) => m.key === sysMode) || {}).label || sysMode)),
          h('span', null, guard ? zh.guardOn(guard.mode, guard.intervalSec, guard.checks, guard.repairs) : zh.guardOff),
          nodes?.watcher?.alive ? h('span', null, '守护 ', h('b', null, `开着（pid ${nodes.watcher.pid}）`)) : h('span', null, '守护 ', h('b', null, '未开')),
        ),
        guard?.lastDrift ? h('div', { className: 'dlp-hint' }, `最近漂移：${guard.lastDrift.join('；')}`) : null,

        // --- 配置 ---
        h(
          'div',
          { className: 'dlp-grid' },
          h(
            'label',
            { className: 'dlp-field' },
            h('span', { className: 'dlp-label' }, zh.port),
            h('input', {
              className: 'dlp-input',
              type: 'number',
              min: 1024,
              max: 65535,
              value: port,
              disabled: running || disabled,
              onChange: (e) => { touched.current = true; setPort(e.target.value) },
            }),
          ),
          h(
            'label',
            { className: 'dlp-field' },
            h('span', { className: 'dlp-label' }, zh.upstream),
            h('input', {
              className: 'dlp-input',
              type: 'text',
              value: upstream,
              placeholder: 'socks5://127.0.0.1:18999',
              disabled: running || disabled,
              onChange: (e) => { touched.current = true; setUpstream(e.target.value) },
            }),
          ),
        ),
        h('div', { className: 'dlp-hint' }, zh.upstreamHint),

        // --- 分流档 ---
        h(
          'div',
          { className: 'dlp-row' },
          h('span', { className: 'dlp-label' }, zh.split),
          h(Segmented, {
            value: status?.split || 'cn-direct',
            options: SPLITS,
            disabled,
            title: zh.split,
            onChange: (v) => doSwitch({ split: v }, '改分流'),
          }),
          h('span', { className: 'dlp-hint' }, (status?.splitLabel || '').replace(/^[^（]*/, '')),
        ),

        // --- 系统代理档 ---
        h(
          'div',
          { className: 'dlp-row' },
          h('span', { className: 'dlp-label' }, zh.sysProxy),
          h(Segmented, {
            value: sysMode === 'foreign' ? '' : sysMode,
            options: SYS_MODES,
            disabled,
            // off 永远可点——它是还原动作，任何状态下都安全；pac / global 必须
            // 代理在跑，否则就是把系统流量指向一个死端口，等于自己给自己断网。
            // 旧写法 disabled || (!running && sysMode !== 'off') 在停止态下算出
            // false（sysMode 本就是 off），三个按钮全可点，是个真 bug。
            isDisabled: (key) => key !== 'off' && !running,
            title: zh.sysProxy,
            onChange: (v) => doSwitch({ sysMode: v, guardSec: 30 }, '改系统代理'),
          }),
          h('span', { className: 'dlp-hint' }, running ? '' : zh.needRunning),
        ),
        sysMode === 'foreign' ? h('div', { className: 'dlp-err' }, zh.sysForeign) : null,
        h('div', { className: 'dlp-hint' }, zh.guardHint),

        // --- DSH 自身接线（与上面的系统代理是两个独立维度）---
        h(
          'div',
          { className: 'dlp-row' },
          h('span', { className: 'dlp-label' }, zh.wireDsh),
          h(Segmented, {
            value: status?.wireDsh ? 'on' : 'off',
            options: WIRE_MODES,
            disabled,
            // 代理没跑时不能接：没有监听端口可接，硬接就是把请求指向死端口。
            isDisabled: (key) => key === 'on' && !running,
            title: zh.wireDsh,
            onChange: (v) => doSwitch({ wireDsh: v === 'on' }, '改 DSH 接线'),
          }),
          h('span', { className: 'dlp-hint' }, running ? '' : zh.needRunning),
        ),
        h('div', { className: 'dlp-hint' }, zh.wireDshHint),
        h(
          'div',
          { className: 'dlp-hint' },
          status?.hostWired?.wired ? zh.wireDshLive(status.hostWired.proxyUrl) : zh.wireDshOff2,
        ),

        h('div', { className: 'dlp-note' }, zh.localOnly),

        // --- 动作 ---
        h(
          'div',
          { className: 'dlp-actions' },
          h('button', { type: 'button', className: 'dlp-btn primary', disabled, onClick: doStart },
            busy === 'start' ? zh.starting : running ? zh.apply : zh.start),
          h('button', {
            type: 'button',
            className: 'dlp-btn danger',
            disabled: disabled || (!running && !status?.orphan && sysMode === 'off'),
            onClick: doStop,
          }, busy === 'stop' ? zh.stopping : zh.stop),
          h('button', { type: 'button', className: 'dlp-btn', disabled: disabled || !running, onClick: doSelftest },
            busy === 'selftest' ? zh.testing : zh.selftest),
          h('button', { type: 'button', className: 'dlp-btn', disabled: disabled || !running, onClick: doEgress },
            busy === 'egress' ? zh.measuring : zh.measure),
          h('button', {
            type: 'button',
            className: 'dlp-btn',
            disabled: disabled || !running,
            onClick: () => doSwitch(nodes?.watcher?.alive ? { watch: false } : { watch: true }, '守护'),
          }, busy === 'switch' ? zh.switching : nodes?.watcher?.alive ? '关守护' : zh.watcherOn),
        ),

        error ? h('div', { className: 'dlp-err' }, `${zh.failed}${error}`) : null,
        notice ? h('div', { className: 'dlp-hint' }, notice) : null,

        // --- 出口 ---
        egress
          ? h(
              'div',
              { className: 'dlp-egress' },
              h('b', null, zh.egressTitle),
              h('span', null, zh.egressVia(egress.proxied?.text || egress.proxied?.error || '测不出')),
              h('span', null, zh.egressDirect(egress.direct?.text || egress.direct?.error || '测不出')),
              h('span', { className: egress.differs ? 'dlp-hint' : 'dlp-err' },
                egress.differs ? zh.egressDiffers : zh.egressSame),
            )
          : null,

        // --- 自检明细 ---
        checks
          ? h('ul', { className: 'dlp-checks' },
              (checks.checks || []).map((c) =>
                h('li', { key: c.name }, `${c.pass ? 'PASS' : 'FAIL'} ${c.name} — ${c.detail}${c.skipped ? '（跳过）' : ''}`)))
          : null,

        // --- 节点池 ---
        h(
          'div',
          { className: 'dlp-nodes' },
          h(
            'div',
            { className: 'dlp-nodes-head' },
            h('b', null, zh.pool),
            h('span', null, nodes?.probe?.ok
              ? `${zh.nodes} ${nodes.probe.alive}/${nodes.probe.total} 可用 · ${nodes.probe.countries?.length || 0} 个国家 · 延迟中位 ${nodes.probe.latencyMs?.median ?? '—'}ms`
              : '无探活缓存'),
            h('span', { className: 'dlp-sub' }, nodes?.probe?.ok ? zh.probeAge(nodes.probe.ageMin) : ''),
            reprobing
              ? h('span', { className: 'dlp-sub' }, zh.reprobeRunning)
              : h('button', { type: 'button', className: 'dlp-btn tiny', disabled, onClick: () => doReprobe(), title: '后台逐条真拨号刷新延迟排名' }, zh.reprobe),
            h('span', { className: 'dlp-sub' }, coreMode === 'race' ? `${zh.race}${nodes?.coreNodes ? `（${nodes.coreNodes} 条）` : ''}` : `${zh.single}${currentNode ? `：${currentNode}` : ''}`),
            coreMode !== 'race'
              ? h('button', { type: 'button', className: 'dlp-btn tiny', disabled, onClick: () => doSwitch({ race: true }, '切回竞速') }, zh.backToRace)
              : null,
          ),
          groups.length === 0
            ? h('div', { className: 'dlp-hint', style: { padding: '8px 10px' } }, nodes?.probe?.error || '节点列表为空')
            : groups.map((g) => {
                const isOpen = open.has(g.country)
                return h(
                  'div',
                  { className: 'dlp-cc', key: g.country },
                  h('div', {
                    className: 'dlp-cc-head',
                    onClick: () => setOpen((prev) => {
                      const next = new Set(prev)
                      if (next.has(g.country)) next.delete(g.country)
                      else next.add(g.country)
                      return next
                    }),
                  },
                    h('span', null, isOpen ? '▾' : '▸'),
                    h('span', null, g.country),
                    h('span', { className: 'dlp-sub' }, `${g.alive}/${g.list.length} 可用${g.bestMs != null ? ` · 最快 ${g.bestMs}ms` : ''}`),
                  ),
                  isOpen
                    ? h('div', { className: 'dlp-cc-body' },
                        g.list.map((n) =>
                          h('div', { className: `dlp-node${n.pass ? '' : ' dead'}`, key: `${n.tag}-${n.port}` },
                            h('span', { className: 'dlp-rank' }, String(n.rank)),
                            h('span', { className: 'dlp-tag' }, n.tag),
                            h('span', { className: 'dlp-ms', style: { color: msColor(n.ms) } }, n.pass ? `${n.ms}ms` : zh.dead),
                            h('span', { className: 'dlp-meta' }, `${n.type}/${n.kind} · ${n.egress || n.server}`),
                            n.pass
                              ? h('button', {
                                  type: 'button',
                                  className: 'dlp-btn tiny',
                                  disabled,
                                  onClick: () => doSwitch({ node: n.tag }, `切到 ${n.tag}`),
                                }, currentNode === n.tag ? zh.inUse : zh.useNode)
                              : h('span', { className: 'dlp-meta', title: n.error }, n.error ? '✗' : ''),
                          )))
                    : null,
                )
              }),
        ),
        // --- 订阅（Group 5）：拉取落盘热更 + 自动刷新间隔 ---
        h(
          'div',
          { className: 'dlp-row' },
          h('span', { className: 'dlp-label' }, zh.subTitle),
          h('input', {
            className: 'dlp-input',
            type: 'text',
            style: { flex: '1 1 220px', minWidth: '180px' },
            value: subUrlInput,
            placeholder: zh.subPlaceholder,
            disabled,
            onChange: (e) => { subTouched.current = true; setSubUrlInput(e.target.value) },
          }),
          h('button', {
            type: 'button',
            className: 'dlp-btn',
            disabled: disabled || !subUrlInput.trim(),
            onClick: () => doSubFetch(),
          }, busy === 'sub' ? zh.subFetching : zh.subFetch),
          h(Segmented, {
            value: String(sub?.subRefreshMin || 0),
            options: [
              { key: '0', label: zh.subOff },
              { key: '30', label: zh.subEvery(30) },
              { key: '120', label: zh.subEvery(120) },
              { key: '1440', label: zh.subEvery(1440) },
            ],
            disabled,
            title: zh.subAuto,
            onChange: (v) => doSubRefresh(v),
          }),
        ),
        h('div', { className: 'dlp-hint' },
          sub?.last ? `${zh.subLast(sub.last)}${sub.subRefreshMin >= 5 ? ` · 自动：每 ${sub.subRefreshMin} 分` : ''}` : zh.subHint),
        status?.logFile ? h('div', { className: 'dlp-log' }, zh.logLine(status.logFile)) : null,
      )
    }

    function apply(ctx) {
      const slots = ctx.slots
      if (!slots) return
      // plugins.row.config is declared LATE: the plugin-manager 'main' entry
      // owns the children table, and our bootstrap apply can outrun it (the
      // direct register then throws "not declared"), while its lazy inject
      // factory never fires in the immediately seat. Mount whenever the slot
      // exists: try now, else listen to the slot's declaration/entry events,
      // with a slow poll as belt-and-braces. All paths funnel through one
      // idempotent mount.
      let mounted = false
      const mount = () => {
        if (mounted) return true
        try {
          if (!slots.spec('plugins.row.config')) return false
          slots.register({ name: 'plugins.row.config', key: 'dsh-local-proxy-own#dsh-local-proxy-own' }, LocalProxyCard)
          mounted = true
          return true
        } catch (err) {
          console.warn('[dlp] mount attempt failed:', err)
          return false
        }
      }
      if (mount()) return
      let off = null
      try {
        off = slots.subscribe('plugins.row.config', () => { if (mount() && off) off() })
      } catch { /* listener shape drifts: poll still carries us */ }
      const timer = setInterval(() => {
        if (mount()) clearInterval(timer)
      }, 400)
      setTimeout(() => clearInterval(timer), 60_000)
    }

    return { inject: ["slots"], apply }
  },
})
