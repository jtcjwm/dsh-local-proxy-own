# dsh-local-proxy-own

DSH bundle 插件：**一键开 / 一键关的本地代理，关掉像没装过。**

- 只在 `127.0.0.1:<port>` 起一个**零依赖**代理进程，同一端口同时说 **SOCKS5** 与 **HTTP**（CONNECT 隧道 + 绝对 URI 转发）。
- **默认不改系统代理**；只有面板开关打开（或工具参数 `systemProxy=true`）才写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`，关停时按**开前精确快照**还原——原本不存在的值会被**删除**，不是置空串。
- 不装驱动、不建 TUN/TAP、不装根证书、不做 TLS 解密：字节原样透传，HTTPS 仍端到端。
- 没有上游时它是**直连收口/分流工具，不是翻墙工具**。要出网得自己填一个能用的上游。

---

## 1. 文件结构

```
D:\DSH\plugins\dsh-local-proxy-own\
├─ package.json            # name / main / exports["./client","./locale/*.json"] / icon / dsh.bundle
├─ cordis.patch.yml        # 三行：把插件行插进 profile 名册
├─ icon.svg                # 列表图标源文件（绯红渐变 + 🌐 + 角标「研」）
├─ icon.png                # 宿主实际吃的那个（manifest.icon 指向它，80754 B ≤ 256 KiB）
├─ locale\zh.json          # 列表标题/描述：本地代理 · 自研
├─ locale\en.json          # Local Proxy · Self-built（宿主以 en.json 为词典入口）
├─ src\index.js            # 宿主侧：7 个工具 + 4 条回环路由 + 起停/快照/自检
├─ src\client.js           # 浏览器侧：开关卡片（slot plugins.row.config）
├─ bin\proxy.js            # 代理进程本体（SOCKS5 + HTTP，零第三方依赖）
├─ bin\node-parse.js       # 分享链接解析器（vmess/vless/hysteria2/tuic）
├─ bin\probe.js            # 逐条真拨号探活竞速，排名写 .runtime\probe.json
├─ bin\singbox-node.js     # 节点池 CLI：list/probe/start/reload/watch/stop/status
├─ bin\route-rules.js      # 分流策略 + 内置国内域名表（运行时不联网）
├─ bin\pac.js              # 生成 PAC
├─ bin\with-proxy.js       # 只给一个进程注入代理环境变量
├─ bin\sing-box.exe        # 本地内核副本（go1.24.7 windows/amd64）
├─ nodes.txt               # 节点池（45 条，10 个国家/地区）
├─ nodes-foxlink.txt       # 早先 FoxLink REALITY 节点备份（22 条）
├─ scripts\verify.ps1      # 八面 + 加测的零残留验收（PASS/FAIL）
├─ scripts\headless-test.mjs   # 不启动 DSH 的全生命周期自测（7 工具 + 4 路由 + inject 哨兵）
├─ scripts\tool-schema-check.mjs  # 用宿主自带 node 跑 apply()，结构校验 7 个工具定义
├─ scripts\meta-check.mjs      # 复刻宿主 readPluginMeta，重启前预测列表标题与图标
├─ scripts\client-check.mjs    # 浏览器 bundle 注册/渲染自检（stub loader）
├─ config.json             # 端口/上游/开关 + 节点池策略（mode/split/top/reprobeMin）
└─ .runtime\               # 仅运行期存在：state.json / registry-snapshot.json / proxy.pid
                           #   / sing-box.json / singbox.pid / singbox-state.json
                           #   / probe.json / watch.pid / proxy.pac
```

`.runtime\` 里的**运行期状态**（`state.json` / `proxy.pid` / `sing-box.json` / `singbox.pid` /
`singbox-state.json` / `watch.pid` / `sing-box.log` / `probe\`）在正常关停后删除；
**派生产物**（`probe.json` 探活排名缓存、`proxy.pac`）故意保留 —— 删掉缓存下次 `start` 就得重跑
一遍约 70s 的全量探活。`config.json` 是设置，保留。

---

## 2. 挂载到 DSH（三步，主文件由 Lead 决定何时改）

> 本插件没有被任何脚本自动并入 profile；下面三行是唯一需要人工落地的改动。

1. 在 profile 的 `package.json` 里加依赖（链接本机目录，不走 npm）：

   ```json
   "dependencies": {
     "dsh-local-proxy-own": "link:D:/DSH/plugins/dsh-local-proxy-own"
   }
   ```

2. 在同一个 `package.json` 的 `dsh.profile.bundles` 数组里追加（顺序即加载顺序）：

   ```json
   "dsh.profile.bundles": ["...已有项", "dsh-local-proxy-own"]
   ```

3. 在 profile 的 `cordis.yml` 名册里插入插件行（等价于本插件 `cordis.patch.yml` 的内容）：

   ```yaml
   - id: dsh-local-proxy-own
     name: 'dsh-local-proxy-own'
     inject:
       - tools
       - webServer
   ```

> **`inject` 不能省。** cordis 只有在名册声明的服务都就绪之后才启动插件，也只有那时
> `ctx.get('tools')` / `ctx.get('webServer')` 才拿得到真服务。漏写它的后果极其安静：
> 模块照常 import、`apply()` 照常返回、宿主不报任何错，但 `registerTools()` 在
> `if (!tools || typeof tools.register !== 'function') return` 这行静默退出，
> 路由也落进永不触发的 `ctx.inject()` 分支 —— 结果是**0 个工具、0 条路由**。
> 2026-10-21 实测：漏写 inject 时同端口下 `dsh-meme` 的 `/dsh-memes-api` 返 200，
> 我们的 `/dsh-local-proxy-own/status` 返 404；三处（模块导出 / `cordis.patch.yml` / 活动 `cordis.yml`）
> 补齐并重启后，同一条请求返 **200**，7 个工具全部进会话工具表并逐个实调通过。
> `scripts/headless-test.mjs` 已把它做成回归哨兵。

改完**重启 DSH**（宿主侧插件不会热加载）。启动后：

- 工具（7 个）：`local_proxy_status` / `local_proxy_start` / `local_proxy_stop` / `local_proxy_selftest`
  / `local_proxy_nodes` / `local_proxy_switch` / `local_proxy_pac`
- 面板：设置 → 插件 → `dsh-local-proxy-own` 行右侧配置入口（slot `plugins.row.config`）
- 路由：`GET /dsh-local-proxy-own/status`、`POST /dsh-local-proxy-own/{start,stop,selftest}`（仅回环）

---

## 3. 怎么开

### 面板

打开插件卡片 → 填端口（默认 7899）→ 需要的话填上游 → 点「开启」。

- 「同时把系统代理指到本代理」**默认不勾**。勾了才会写注册表。
- 开启后自动跑本机连通性自检；自检不过会自动关停并回报原因。

### 工具（agent 侧）

```jsonc
// 只起代理，不动系统代理（最安全）
{ "name": "local_proxy_start", "arguments": { "port": 7899 } }

// 起代理并把系统代理指过来（关停会精确还原）
{ "name": "local_proxy_start", "arguments": { "port": 7899, "systemProxy": true } }

// 串联上游：socks5 / http 都行，也支持 user:pass@
{ "name": "local_proxy_start", "arguments": { "upstream": "socks5://127.0.0.1:1080" } }

{ "name": "local_proxy_selftest", "arguments": { "external": true } }
```

### 手动验证

```bat
curl -x http://127.0.0.1:7899    http://127.0.0.1:13382/ -o NUL -w "%{http_code}\n"
curl -x socks5h://127.0.0.1:7899 http://127.0.0.1:13382/ -o NUL -w "%{http_code}\n"
```

两条都应返回一个 HTTP 状态码（DSH 的 13382 会回 `401`——这已经证明字节通路成立）。
有外网时再跑：

```bat
curl -x socks5h://127.0.0.1:7899 https://api.ipify.org
```

---

## 4. 怎么关

面板点「关停」，或：

```jsonc
{ "name": "local_proxy_stop", "arguments": {} }
```

关停顺序（每一步都可单独断言）：

1. 子进程 `stdin` EOF → 2.5s 未退则 SIGTERM → 再 1.5s 未退则 `taskkill /F`；
2. 等端口真的可重新 bind（最多 5s）；
3. 若有注册表快照：逐值还原（`ProxyEnable=0`，`ProxyServer/AutoConfigURL/AutoDetect` 删除）；
4. 删除 `.runtime\` 全部文件与目录；
5. 再查一遍注册表，确认 `ProxyEnable=0` 且三个值不存在。

端口本来就空、注册表本来就没动过时，`stop` 同样返回成功（幂等）。

---

## 5. 零残留验收

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File D:\DSH\plugins\dsh-local-proxy-own\scripts\verify.ps1
```

八面 + 加测，逐条 `PASS/FAIL`，`FAIL` 时退出码 1：

| 面 | 断言 | 基线 |
|---|---|---|
| 1 进程 | 本插件代理进程 0；mihomo/clash/... 0；相关服务 0 | 0 / 0 / 0 |
| 2 文件 | `.runtime\` 已删；无 pid 残留；无代理根证书；无快捷方式；日志 ≤2MB | 全 0（日志除外） |
| 3 注册表 | `ProxyEnable=0`；`ProxyServer/AutoConfigURL/AutoDetect` 不存在；`ProxyOverride=<local>`；portproxy 空；AppInit 空 | 完全符合 |
| 4 网卡 | TAP/TUN/WireGuard/wintun/... 0 | 0 |
| 5 路由 | 默认路由 1 条 → 192.168.1.1；持久化路由 0 | 1 / 0 |
| 6 自启 | Run 键命中 0；用户启动夹仍 3 项；公共启动夹无代理项 | 3 项不变 |
| 7 计划任务 | 代理相关任务 0（排除系统 `Autochk\Proxy`） | 0 |
| 8 hosts | 有效行 5；无代理条目 | 5 |
| 加测 | 端口无 LISTENING；代理环境变量 24 槽空；WinHTTP 无代理服务器 | 0 / 空 / 直连 |

> hosts 那 5 条是用户既有配置（missav ×2 / av01.media / 18comic.vip / supjav.com），**不许清零，也不许改**。插件全程不碰 hosts。

关停状态下实测：`28 PASS / 0 FAIL`。

---

## 6. 回滚 / 卸载

1. 先 `local_proxy_stop`（或面板关停）。
2. 跑 `verify.ps1`，确认 28 项全 PASS。
3. 从 profile 的 `package.json` 删掉 `dsh-local-proxy-own` 依赖与 `dsh.profile.bundles` 里的条目，从 `cordis.yml` 删掉那两行。
4. 重启 DSH。
5. 删目录 `D:\DSH\plugins\dsh-local-proxy-own`（连同 `config.json`）。
6. 想彻底回到装机基线，再跑一次 `verify.ps1`（脚本不依赖插件目录，只读系统状态；`-PluginDir` 可指向已删路径）。

**没有**需要清理的：服务、驱动、证书、防火墙规则、计划任务、自启项、环境变量、hosts、WinHTTP、Winsock LSP。插件一概不写。

---

## 7. 失败排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `端口 xxx 被其它进程占用` | 目标端口已有监听 | 换端口；先用 `netstat -ano \| findstr :7899` 找占用者 |
| `端口 xxx 被 DSH 占用` | 13382/19388 是宿主端口 | 换端口 |
| `代理进程 10s 内未就绪` | 找不到 node / 脚本报错 | 设 `LOCAL_PROXY_NODE=<node.exe 绝对路径>`；或直接 `node bin\proxy.js --port 7899` 看报错 |
| `系统代理未生效` | 组策略或安全软件锁了 Internet Settings | 插件已自动回滚；改用「只起代理」，应用内自己填 `127.0.0.1:7899` |
| `系统代理未能完全还原` | 还原时有值被别的进程改写 | `.runtime\registry-snapshot.json` 会保留，手工按快照写回；再跑 `local_proxy_stop` |
| `local-http 失败` | 本机没有可当靶子的 HTTP 服务 | 启动任意本地 HTTP 服务，或忽略（`port-listening` 通过即代理本身可用） |
| `external-egress 失败` | 本机没有可用出口 / 上游不通 | 属正常；先确认上游地址与端口，再 `local_proxy_selftest` |
| 面板没有卡片 | bundle 未挂载或未重启 | 按第 2 节三步重做，重启 DSH |
| 端口被「幽灵」占用 | 宿主被强杀留下的监听 | 重新加载插件会自动 reconcile（接管或还原）；或手动 `local_proxy_stop` |

日志：`D:\DSH\dsh-网络\flywheel-re\plugin-logs\local-proxy-YYYYMMDD.log`（ASCII 文件名，单文件 2MB 滚动到 `.1`，内容 ASCII 化）。

---

## 8. 自测命令（开发/验收用）

```bat
cd /d D:\DSH\plugins\dsh-local-proxy-own

node --check bin\proxy.js
node --check src\index.js
node --check src\client.js

:: 不启动 DSH，跑完整生命周期（会真的起停代理）
:: 断言含：7 个工具全在、4 条路由全在、模块导出 inject=[tools,webServer]、
::         3 个新工具的 execute 真跑、stop 后 probe.json/proxy.pac 仍在
node scripts\headless-test.mjs --port 17899
:: 连注册表快照/还原一起测（会短暂改 ProxyEnable/ProxyServer，结束自动还原）
node scripts\headless-test.mjs --port 17900 --system-proxy

:: 用宿主自带的 node 运行时（不是 PATH 上的开发版）跑一遍 apply()，
:: 顺带结构校验 7 个工具定义；宿主 import 不了或 inject 漏了都会在这里炸
"C:\Users\L1772\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" scripts\tool-schema-check.mjs

node scripts\client-check.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify.ps1
```

---

## 9. 设计要点

- **单端口双协议**：按首字节分流，`0x05` 走 SOCKS5，ASCII 走 HTTP。一个端口同时满足 `socks5h://` 与 `http://` 两种客户端。
- **只监听回环**：`server.listen(port, '127.0.0.1')`，路由另做 loopback socket + Host 校验 + 同源校验。
- **上游是纯 TCP 跳**：`socks5://`（含用户名密码子协商）与 `http://`（CONNECT）都实现为「拿到一条到目标的裸字节隧道」，因此同一条通道既跑 HTTP 也跑 HTTPS。
- **上游每连接解析**：`proxy.js` 不在启动时固化上游，而是每条连接现读。所以内核在 18999 上重启、换节点集，上层 17899 不用动，客户端也不用重连。
- **关停可断言**：正常路径先 EOF 再信号再强杀；快照驱动还原；端口用「能否重新 bind」判定，而不是看 TIME_WAIT。
- **崩溃自愈**：子进程带 `--parent-pid` 看门狗（宿主被强杀后 ≤4s 自行退出）；插件加载时 `reconcile` —— 有活着的遗留就接管，没有就按快照还原注册表并删运行期文件。

---

## 10. 节点池：探活竞速 / 热更新 / 分流

不绑定任何客户端。节点来自 `nodes.txt`（每行一条分享链接，`vmess://` / `vless://` / `hysteria2://` / `tuic://`），插件自己解析、自己竞速、自己热更。

**文件**

| 文件 | 作用 |
|---|---|
| `nodes.txt` | 节点池（当前 45 条：hysteria2 17 · vmess/ws 15 · vmess/http 13，10 个国家/地区） |
| `nodes-foxlink.txt` | 早先 FoxLink REALITY 节点备份，22 条，`--nodes` 指过去即可用 |
| `bin/node-parse.js` | 零依赖分享链接解析器（vmess/vless/hysteria2/tuic → sing-box outbound） |
| `bin/probe.js` | 逐条真拨号探活竞速，一条一个内核实例，排名写 `.runtime/probe.json` |
| `bin/singbox-node.js` | `list / probe / start / reload / watch / stop / status` |
| `bin/route-rules.js` | 分流策略与内置国内域名表（运行时不联网取规则） |
| `bin/pac.js` | 生成 PAC 文件 |
| `bin/with-proxy.js` | 只给一个进程注入代理环境变量 |
| `bin/sing-box.exe` | 本地内核副本，`go1.24.7 windows/amd64`，`mixed` 入站已核 |

**四件事怎么做的**

1. **探活竞速** — `probe` 给每条节点起一个独立内核实例（端口 19200+），走 SOCKS5 打 `generate_204`，再查出口 IP。**判活标准是「出口 IP ≠ 直连基线」**，不是「能连上」；出口等于基线一律判死。默认并发 2，**失败的自动串行复测一遍再判死**。
2. **竞速** — `start race` 把全部存活节点塞进一个 sing-box `urltest` 组（`interval 30s`，`tolerance 50ms`），由内核自己选最快、自己亚秒切换，**不需要重启**。`--top N` 只取排名前 N。
3. **热更新** — `reload` 在**同一个端口**上重建配置、杀旧内核、起新内核、等端口回来；`watch` 是守护，节点文件一变就自动 `reload`，可选每 N 分钟重探活。
4. **分流** — 三种策略：`cn-direct`（默认，国内域名 + 内网直连，其余走隧道）/ `all`（全走隧道）/ `direct`（全直连）。域名规则**不做解析**就匹配，所以本地 DNS 被污染也不会把国外站甩到直连路上。

**工具（agent 侧）**

```jsonc
// 开：默认竞速模式 + cn-direct 分流，端口 17899
{ "name": "local_proxy_start", "arguments": {} }

// 指定策略与节点数
{ "name": "local_proxy_start", "arguments": { "mode": "race", "split": "cn-direct", "top": 8 } }

// 单节点（诊断用，默认 split=all，好判断节点本身通不通）
{ "name": "local_proxy_start", "arguments": { "node": "日本-JP15-H2" } }

// 探活排名 / 看池子
{ "name": "local_proxy_nodes", "arguments": { "action": "probe" } }
{ "name": "local_proxy_nodes", "arguments": { "action": "list" } }

// 运行时换线路：端口不变，上层代理与系统代理都不用动
{ "name": "local_proxy_switch", "arguments": { "race": true } }
{ "name": "local_proxy_switch", "arguments": { "node": "瑞士-CH2-H2" } }
{ "name": "local_proxy_switch", "arguments": { "reload": true } }
{ "name": "local_proxy_switch", "arguments": { "split": "all" } }
{ "name": "local_proxy_switch", "arguments": { "watch": true, "reprobeMin": 30 } }

// PAC（给浏览器/单个程序用，不动全局代理）
{ "name": "local_proxy_pac", "arguments": { "split": "cn-direct" } }

// 关：守护 → 内核 → 代理，注册表按快照还原
{ "name": "local_proxy_stop", "arguments": {} }
```

**命令行**

```bash
node bin/singbox-node.js list   --nodes nodes.txt
node bin/singbox-node.js probe  --nodes nodes.txt --concurrency 2
node bin/singbox-node.js start race --port 18999 --nodes nodes.txt --split cn-direct
node bin/singbox-node.js reload --port 18999 --nodes nodes.txt --top 8
node bin/singbox-node.js watch  --port 18999 --nodes nodes.txt --reprobe-min 30
node bin/singbox-node.js status
node bin/singbox-node.js stop            # 先杀守护，再杀内核，清 .runtime
node bin/pac.js --port 17899 --split cn-direct
node bin/with-proxy.js --port 17899 -- curl.exe -s https://api.ip.sb/geoip
```

**已验证**（2026-10-21 19:30，Windows / 直连基线 `CN 111.15.93.33`）

```
探活      45/45 存活，0 判死，71.6s，并发 2；UDP 17/17，TCP 28/28；10 个国家
          延迟 最快 577ms / 中位 1470ms / 最慢 5959ms
          并发 3 时同样 45 条只测出 42 活 —— 3 条已知可用节点返回假阴性，
          串行复测全部通过，故默认并发改 2 + 失败自动串行复测
竞速      start race 45 条 → urltest 组，国外 204×3，出口 SG 172.104.171.180
热更新    reload 中断 230ms（45→8 条，端口不变）
          中断期间 14 连发：13×204 / 1×000（正在飞的那一条）
          reload 后 204×3，出口不变
分流      cn-direct：国内 baidu 200 / 0.127s 走直连，国外走隧道（SG 出口）
          决定性反证：把节点换成不可达的 10.255.255.1
            split=cn-direct → baidu 200（直连活着） / gstatic 000（隧道死了）
            split=all       → baidu 000 / gstatic 000（全被拖进死隧道）
端到端    内核 18999 → proxy.js 17899：HTTP 204×3、SOCKS5 204、国内直连 200
按进程    with-proxy.js 里的 curl → 204 + SG 出口；
          同一时刻系统代理 ProxyEnable=0，本 shell 直连出口仍是 CN 111.15.93.33
PAC       1890 B，file:///D:/DSH/plugins/dsh-local-proxy-own/.runtime/proxy.pac
```

**注意**

- **并发别调高**：实测并发 3 就会让已知可用的节点返回 `000`，看起来像节点死了。判死之前先看有没有串行复测过。
- **UDP 与 TCP 独立失效**：hysteria2（QUIC/UDP）不通不代表 vmess/ws（TCP）不通，反之亦然。同一组 IP 的两条链路要分别判。
- **hysteria2 密码要带 `user:` 前缀**，裸密码会被服务端 `503 authentication failed` 拒掉。
- **sing-box 的 `utls` 必须嵌在 `tls` 里面**（`{"tls":{"enabled":true,"utls":{"enabled":true,"fingerprint":"chrome"}}}`）；写在顶层直接 `FATAL decode config`，不写则服务端 `wsarecv: An existing connection was forcibly closed`。
- `watch` 是常驻进程，`stop` 会先杀它再杀内核（否则它会把内核又拉起来）。它的 pid 记在 `.runtime/watch.pid`。
- 节点参数由服务端按账号下发、会轮换。大面积失效时重新抓一份 `nodes.txt` 覆盖即可，插件本身不用改。
- `scripts/proxyctl.ps1`（CLI 版一键脚本）在测试中出现 Start-Process 句柄继承导致的挂起，**暂不使用**；走插件工具或直接调 `bin/singbox-node.js`。

---

## 11. 插件列表里的名字与图标

「设置 → 插件」那一行显示的**不是**包名，而是宿主 `readPluginMeta()` 解析出的本地化元数据。
本包缺 `locale/` 与 `icon` 时，列表里就是默认蓝方块 + 包名 `dsh-local-proxy-own`。

### 宿主契约（2026-10-21 读自 `dsh-app-boot/lib/index.js`）

| 项 | 规则 | 本包对应 |
|---|---|---|
| 词典入口 | 先解析 `${specifier}/locale/en.json`；解析不到就把词典整个置空，标题回落 `manifest.name` | `exports` 里的 `"./locale/*.json"` 必须放行，否则回落成包名 |
| 其余语言 | 读 en.json **同目录**下所有 `.json`，文件名必须匹配 `LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/`，且每个都要能通过 `${specifier}/locale/<name>` 解析 | `zh.json` / `en.json` |
| 结构 | `{ "meta": { "title": 非空字符串, "description": 非空字符串 } }`；任一文件不合法 ⇒ **整份元数据降级成 error 诊断** | 见 `locale/*.json` |
| 图标 | `manifest.icon` 优先于导出的 `<specifier>/icon`；必须**相对路径**（带盘符或 URL scheme 直接抛错）、留在 manifest 目录内、扩展名限 `.svg/.png/.jpg/.jpeg/.webp`、常规文件、**≤ 256 KiB**；最终转成 `data:<mime>;base64,…` | `"icon": "icon.png"`，80754 B → data URL 107694 字符 |
| 生效时机 | 只在宿主启动时解析一次 | **改完必须完全退出并重开 DSH**，刷新页面 / Ctrl+R 无效 |

### 本包的标注口径

- 标题后缀「**· 自研**」（en `· Self-built`），图标右下角标「**研**」。
  判据沿用 2026-10-18 的裁定：完全自研 = 自己写代码、既不复制也不依赖**他人插件**的源码或能力。
  本包 1878 行 `src/index.js` + 7 个 `bin/` 脚本全部自写，不包装任何其他 DSH 插件；
  `sing-box.exe` 是被驱动的内核二进制（等同于生图用 ComfyUI），不构成「改他人插件」。
- 包名**不加 `-own` 后缀**。`-own` 的用途是把「自己改的那份」与「同时装着的原版」区分开
  （`dsh-meme-copy-own` 之于 `dsh-meme`）；本包没有上游原版可混，加后缀只会逼着同步改
  `cordis.yml` 的 id/name、profile 的 dependencies/bundles/lock，风险大收益零。
- 主色**绯红** `#FF7B93 → #9E0F3C`。已占用：紫 `#9B7BFF`（黑话）、橙 `#FFB259`（表情包复制）、
  蓝 `#5FB6FF`（版本号徽标）、绿 `#4FD694`（REA）；绯红与四者色相分离度最大，48px 下不混。

### 图标选型是怎么定的

本会话模型不能读图，所以不靠「看着像」，靠可量化指标：把图标缩到侧栏真实尺寸 48px，
测**主体区边缘密度**（相邻像素亮度差均值），越高说明缩小后轮廓保留越多；再拿已验收的
四个图标当参照带（主体 25.94 – 32.71）。

```
🌐 1F310 网络代理   整图 29.29  主体 37.77  → 高于参照带 ✓ 选定（语义也正好是「代理/网络」）
🔀 1F500 分流切换   整图 19.14  主体 19.59  → 低于下沿，淘汰（细箭头缩小后糊）
⚡ 26A1  竞速       整图 21.52  主体 23.84  → 低于下沿，淘汰
```

素材：OpenMoji 彩色 SVG（CC BY-SA 4.0，hfg-gmuend/openmoji）。
生成器与选型脚本在 `D:\DSH\dsh-自检\_icon-src\`：`make_icon_local_proxy.py`（出 SVG）、
`preview_local_proxy.py`（选型 + 效果模拟）、`install_icon_local_proxy.py`（装包 + 硬约束自检）。
PNG 由 Edge headless 渲染，**必须带 `--default-background-color=00000000`**，
否则圆角外是白像素、深色列表里会显示成白块。

### 重启前自查

```bat
cd /d D:\DSH\plugins\dsh-local-proxy-own
node scripts\meta-check.mjs
```

它复刻宿主 `readPluginMeta` / `iconOf` / `dictionariesOf` 的判据，直接打印「宿主将渲染的标题」
与图标 data URL 信息。用同一份逻辑跑已生效的四个对照包，标题一字不差：

```
dsh-slang-own          {"en":"Slang Corpus · Self-built","zh":"黑话语料库 · 自研"}        icon .png 110685B
dsh-meme-copy-own      {"en":"Meme Copy · Modded","zh":"表情包复制 · 改"}                 icon .png 112849B
dsh-rea-own            {"en":"REA — Reverse Engineer Anything · Modded","zh":"REA 万物皆可逆向 · 改"}  icon .png 123662B
dsh-version-badge-own  {"en":"Version Badge · Self-built","zh":"版本号徽标 · 自研"}        icon .png 112026B
dsh-local-proxy-own        {"en":"Local Proxy · Self-built","zh":"本地代理 · 自研"}           icon .png  80754B
```

> **已知不一致（不属本包，未擅自改）**：上轮的 `make_comic.py` 把角标字硬编码成「改」，
> 所以 `dsh-slang-own` 与 `dsh-version-badge-own` 的标题是「· 自研」而图标角标却是「改」。
> 本包的生成器已把角标参数化（`badge_text`），要顺手修那两个各改一行重渲染即可。

---

## 12. DSH 自身接线（`wireDsh`，2026-10-23 加入）

**要解决的断层**：起代理 ≠ DSH 自己会走这个代理。桌面版的启动路径（`dsh-app-boot`）**不调**
`@deepseek-ai/dsh-http-proxy` 的 `installProxyFromEnvironment()`——实测 0.2.1-rc.2：只有 CLI 的
`runProfile()` 调（`@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:256`），`dsh-app-boot` 全包 0 处调用。
后果是 agent 自己的 `web_fetch` / 联网工具**永远直连**，而从 shell 里起的 `curl`、`git` 却会读环境变量——
同一个会话两套网络行为，面板上看着一切正常。

`wireDsh=true` 时，本插件把 `http://127.0.0.1:<port>` 装进宿主：进程内 dispatcher + 子进程环境变量
（`HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`，`NO_PROXY` 默认 `localhost,127.0.0.1,::1`，本地 ComfyUI / DSH
自身端口不受影响）。关停、退出、自检失败自动卸下。

- 开关：`config.json` 的 `wireDsh`（默认 `false`，与「不要求就不动」一致）；`local_proxy_start` 带
  `wireDsh: true` 一次性开启（会被 `saveConfig` 持久化）；`local_proxy_status` 回 `wired / wiredUrl`。
- 代码：`src/host-wire.js`（发现 + 安装 + 卸下 + 解析兜底），`src/index.js` 只在
  start / stop / apply 三处调用它。日志 `.runtime/host-wire.log`。
- 发现优先级：本次起的端口 → `.env` 里用户显式写的 → Windows 系统代理注册表 → 继承来的变量（只兜底）。
  只接受 `http/https` + 只接受回环地址，任何一步失败都降级成「什么都不做」，绝不让原本可用的直连失效。
- **为什么还要一层文件路径兜底**：上游同名包的写法是裸 `import('@deepseek-ai/dsh-http-proxy')`，它住在
  profile 的 `node_modules` 里能同级解析；本插件住在 `D:\DSH\plugins\`，实测 `ERR_MODULE_NOT_FOUND`
  （`D:/DSH/plugins`、`D:/DSH`、`D:/` 三级都没有 node_modules）。`importHostModule()` 先试裸 import，
  失败再按 `process.execPath` 推 `resources/app/dsh/node_modules` 等候选根读包的 `main` 直接按文件导入。
- 装机时**先清掉继承来的代理变量再装**：宿主的 `proxyEnvironmentForChild()` 用
  `inherited[name] !== undefined` 判断「用户设过」，分不清「用户设的」和「上一代泄漏的」，
  会把旧端口发给子进程（代理换端口后 web_fetch 正常、子进程 ECONNREFUSED 就是这么来的）。
- 与系统代理是两个独立维度：`systemProxy` 改的是 HKCU 注册表（全局生效、需精确还原），
  `wireDsh` 只改 DSH 这一个进程的行为（不写注册表、不碰别的软件）。
- 机制验收（独立进程，不碰宿主）：`node "D:\DSH\dsh-插件\_check\20261023-lp\wire-e2e.mjs"` → 12/12 两遍全绿；
  反证是「接线后杀掉代理 → 同一请求 ECONNREFUSED 127.0.0.1:18123，卸下后恢复 200」。
  负向测试把模块根指向不存在的路径 → 5 红且**直连没被破坏**（200）。
