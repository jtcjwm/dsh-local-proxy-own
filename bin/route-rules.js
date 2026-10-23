// route-rules.js - split-tunnel routing for dsh-local-proxy-own.
//
// Two independent layers, neither of which touches the Windows global proxy or
// creates a TUN adapter:
//
//   1. CORE rules (this file, buildRoute) - baked into the generated sing-box
//      config. Chinese / LAN destinations go DIRECT, everything else goes
//      through the node group. Zero external rule-set download: the list is
//      inline, so nothing rots when a subscription URL dies.
//   2. PAC + per-process env (pac.js / with-proxy.js) - for apps that must be
//      told where the proxy is.
//
// Domain-based rules are matched WITHOUT resolving, so a poisoned A record
// cannot drag a foreign site into the direct path.
//
// ⚠ DO NOT "IMPROVE" THIS BY ADDING DNS. Measured 2026-10-22 07:00 on this
// machine (DNS server 211.137.191.26, 烟台移动): local nslookup of
// www.google.com / www.facebook.com / www.youtube.com returns the injected
// fake `2001::1` plus bogus IPv4s (69.171.235.22 / 157.240.7.20 /
// 174.132.167.252), and direct fetches of all three die at exit=28 after 8s.
// Through this proxy the same three answer 204/200/200 in 0.35-0.91s with
// egress 新加坡 13.212.177.113, while direct egress stays 烟台移动
// 111.15.93.33. The tunnel is immune *because it never resolves*: the
// outbound receives the NAME and hands it to the far node.
// Adding a `dns` block, an outbound `domain_strategy` (prefer_ipv4 /
// ipv4_only / prefer_ipv6 ...), or any geoip / geosite / rule_set route rule
// makes sing-box resolve locally, which feeds it exactly those poisoned
// answers and reopens the hole that is currently closed.
// scripts/dns-poison-test.mjs asserts both layers (behaviour + config), so a
// regression fails loudly instead of degrading into "some sites stopped
// working" with nobody knowing why.
export const CN_DIRECT_SUFFIXES = [
  'cn', 'gov.cn', 'org.cn', 'com.cn', 'net.cn', 'edu.cn',
  'baidu.com', 'bdstatic.com', 'baidubce.com',
  'taobao.com', 'tmall.com', 'alicdn.com', 'aliyun.com', 'aliyuncs.com', 'alipay.com', 'alibaba.com',
  'jd.com', 'jdcloud.com', '360buyimg.com',
  'qq.com', 'weixin.qq.com', 'tencent.com', 'gtimg.cn', 'qpic.cn', 'myqcloud.com', 'dnspod.cn',
  'netease.com', '163.com', '126.com', '127.net', 'yeah.net', 'neteasegame.com',
  'bilibili.com', 'bilivideo.com', 'hdslb.com', 'acgvideo.com',
  'zhihu.com', 'zhimg.com',
  'weibo.com', 'sinaimg.cn', 'sina.com.cn',
  'douyin.com', 'bytedance.com', 'byteimg.com', 'tiktokv.com', 'amemv.com',
  'xiaomi.com', 'mi.com', 'miui.com', 'huawei.com', 'vmall.com', 'honor.com', 'oppo.com', 'vivo.com.cn',
  'cctv.com', 'cntv.cn', 'people.com.cn', 'xinhuanet.com', 'chinanews.com.cn',
  'meituan.com', 'dianping.com', 'ele.me', 'ctrip.com', 'qunar.com', '12306.cn',
  'csdn.net', 'oschina.net', 'gitee.com', 'cnblogs.com', 'jianshu.com', 'segmentfault.com',
  'iqiyi.com', 'youku.com', 'sohu.com', 'ifeng.com', 'huya.com', 'douyu.com',
  'kuaishou.com', 'pinduoduo.com', 'yangkeduo.com', 'suning.com', 'vip.com',
  'lenovo.com.cn', 'zte.com.cn', 'chinatelecom.com.cn', '10086.cn', '10010.com',
  'onlinedown.net', 'pcpop.com', 'zol.com.cn', 'eastmoney.com', 'hexun.com',
  'tianyancha.com', 'qcc.com', 'dingtalk.com', 'feishu.cn', 'larksuite.com', 'wps.cn',
]

// Kept short on purpose: only what is unambiguously domestic. A false entry here
// sends a foreign site direct (fails); a missing entry only costs a little speed.
export const CN_DIRECT_KEYWORDS = []

export const MODES = ['all', 'cn-direct', 'direct']

export function buildRoute(mode = 'cn-direct', opts = {}) {
  const group = opts.group || 'auto'
  if (mode === 'direct') {
    return { final: 'direct', rules: [] }
  }
  if (mode === 'all') {
    return { final: group, rules: [{ ip_is_private: true, outbound: 'direct' }] }
  }
  // cn-direct: LAN + domestic domains straight out, everything else tunneled.
  // No DNS rule on purpose: domain destinations are handed to the outbound as
  // NAMES and resolved remotely, so a poisoned local A record cannot redirect
  // a foreign site into the direct path (or into the tunnel when it should not
  // be there). Adding a dns-out outbound would buy nothing here.
  const rules = [
    { ip_is_private: true, outbound: 'direct' },
    {
      domain_suffix: [...CN_DIRECT_SUFFIXES, ...(opts.extraDirect || [])],
      outbound: 'direct',
    },
  ]
  if (CN_DIRECT_KEYWORDS.length || (opts.extraKeyword || []).length) {
    rules.push({
      domain_keyword: [...CN_DIRECT_KEYWORDS, ...(opts.extraKeyword || [])],
      outbound: 'direct',
    })
  }
  if (opts.directIpCidr && opts.directIpCidr.length) {
    rules.push({ ip_cidr: opts.directIpCidr, outbound: 'direct' })
  }
  // A rule with an undefined key is invalid sing-box; strip those.
  return { final: group, rules: rules.filter((r) => Object.values(r).some((v) => v !== undefined)) }
}

// PAC body: same policy, expressed for browsers/system proxy consumers.
export function buildPac({ port = 7899, host = '127.0.0.1', mode = 'cn-direct', extraDirect = [] } = {}) {
  const proxy = `PROXY ${host}:${port}; DIRECT`
  const suffixes = [...CN_DIRECT_SUFFIXES, ...extraDirect]
  if (mode === 'all') return `function FindProxyForURL(url, host) {\n  return "${proxy}";\n}\n`
  if (mode === 'direct') return 'function FindProxyForURL(url, host) {\n  return "DIRECT";\n}\n'
  return `// Generated by dsh-local-proxy-own. Domestic hosts go DIRECT, everything else
// goes through the local proxy. No external list is fetched at runtime.
var CN_SUFFIXES = ${JSON.stringify(suffixes, null, 0)};
var PRIVATE_RE = /^(localhost|127\\.|10\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|\\[?::1)/i;

function isCn(host) {
  host = host.toLowerCase();
  for (var i = 0; i < CN_SUFFIXES.length; i++) {
    var s = CN_SUFFIXES[i];
    if (host === s || host.slice(-s.length - 1) === "." + s) return true;
  }
  return false;
}

function FindProxyForURL(url, host) {
  if (PRIVATE_RE.test(host) || isCn(host)) return "DIRECT";
  return "${proxy}";
}
`
}

// Env vars that make one process tree use the proxy without any system change.
export function proxyEnv({ port = 7899, host = '127.0.0.1', mode = 'cn-direct' } = {}) {
  const url = `http://${host}:${port}`
  const noProxy = mode === 'all'
    ? 'localhost,127.0.0.1,::1'
    : ['localhost', '127.0.0.1', '::1', ...CN_DIRECT_SUFFIXES.map((s) => '.' + s)].join(',')
  return {
    HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: `socks5h://${host}:${port}`,
    http_proxy: url, https_proxy: url, all_proxy: `socks5h://${host}:${port}`,
    NO_PROXY: noProxy, no_proxy: noProxy,
  }
}
