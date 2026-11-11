/**
 * 传输层 —— 一个出口，三种走法。
 * ============================================================================
 * 为什么手搓这一层（都是实测踩出来的，别改回去）：
 *
 *  1. 运行时里**没有 undici**。Node 22 有全局 fetch，但 `import('undici')` 会
 *     MODULE_NOT_FOUND（它只在 app.asar 里，require/fs 都进不去）。
 *     ⇒ 不能 `new undici.ProxyAgent()`。
 *
 *  2. 也**不能**给 https.Agent 挂自定义 createConnection 来走代理 —— https.request
 *     会把回调里给的裸 socket 直接当 TLS socket 用，于是明文被丢进 443，
 *     Cloudflare 回 `400 The plain HTTP request was sent to HTTPS port`。
 *
 *  3. 所以走代理时**自己 CONNECT、自己 tls.connect**，再手写 HTTP/1.1。
 *     而且 pixiv 大量响应是 chunked，得自己拆 chunk。
 *
 *  4. 不走代理时（TUN 模式 / 本来通）直接用 https.request 就够了，别绕。
 *
 * ⚠️ 但**别把「走代理」当成默认**：本机实测过同一个地址十分钟内 TUN 时通时不通，
 *    裸直连也会整体超时。是通是断交给 route.mjs 去探，这一层只负责"按指定的路走"。
 * ============================================================================
 */
import https from 'node:https'
import http from 'node:http'
import tls from 'node:tls'
import net from 'node:net'
import dns from 'node:dns'
import { URL } from 'node:url'

/**
 * 已经连通过的地址（按主机名记）。
 *
 * 🔴 为什么需要它（2026-11-10 实测踩到，症状极具误导性）：
 *   `hibiapi.getloli.com` 有两条 A 记录：104.21.51.227（通）和 172.67.190.157（黑洞）。
 *   Node 的连接只认解析结果里的**第一个**地址（原生 https.get 也一样），
 *   挑中黑洞就死等到超时 —— 同时刻 curl 挑了好的那条，2.7~7.7 秒 200。
 *   于是表现成"HibiAPI 时快时慢"，其实是**我们挑错了地址**，
 *   还白写了一句"公共实例不稳"的提示去误导使用者。
 *   这一条缓存让下次先试上次成功的那个，避免每次都赌顺序。
 */
const GOOD_ADDR = new Map()

/** 解析域名的全部 IPv4。⚠️ 只要 IPv4：本机 curl -6 直接 000（v6 路是死的）。 */
async function resolveAddrs(hostname) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return [hostname]
  try {
    const all = await dns.promises.lookup(hostname, { all: true, family: 4 })
    return all.map((a) => String(a.address)).filter(Boolean)
  } catch {
    return []
  }
}


export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export const REFERER = 'https://www.pixiv.net/'

export class TransportError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'TransportError'
    this.detail = detail
  }
}

/* ─────────────────── 代理隧道 ─────────────────── */

/** 在代理上开一条到 target 的隧道，回调给裸 socket */
function tunnel(proxyUrl, targetHost, targetPort, timeoutMs, cb) {
  const p = new URL(proxyUrl)
  let called = false
  const fin = (err, socket) => { if (!called) { called = true; cb(err, socket) } }

  const req = http.request({
    host: p.hostname,
    port: Number(p.port) || 80,
    method: 'CONNECT',
    path: `${targetHost}:${targetPort}`,
    headers: {
      Host: `${targetHost}:${targetPort}`,
      ...(p.username
        ? {
            'Proxy-Authorization':
              'Basic ' +
              Buffer.from(
                `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password || '')}`,
              ).toString('base64'),
          }
        : {}),
    },
    timeout: timeoutMs,
  })
  req.once('connect', (res, socket) => {
    if (res.statusCode !== 200) {
      socket.destroy()
      fin(new TransportError(`代理 CONNECT 被拒：HTTP ${res.statusCode}（${proxyUrl}）`))
      return
    }
    fin(null, socket)
  })
  req.once('timeout', () => req.destroy(new TransportError(`代理 CONNECT 超时（${proxyUrl}）`)))
  req.once('error', (err) => fin(err))
  req.end()

  // 硬超时兜底：代理地址本身连不上时，http.request 的 timeout 也未必触发
  const t = setTimeout(() => {
    try { req.destroy() } catch { /* ignore */ }
    fin(new TransportError(`代理 CONNECT 超时（${timeoutMs}ms，${proxyUrl}）`))
  }, timeoutMs + 500)
  if (t.unref) t.unref()
}

/** 拆 HTTP/1.1 chunked。不拆就会拿到 "13a5\r\n{..." 这种开头的脏数据。 */
export function dechunk(buf) {
  const out = []
  let i = 0
  while (i < buf.length) {
    const nl = buf.indexOf('\r\n', i, 'latin1')
    if (nl < 0) break
    const size = parseInt(buf.toString('latin1', i, nl).split(';')[0].trim(), 16)
    if (!Number.isFinite(size) || size === 0) break
    const start = nl + 2
    out.push(buf.subarray(start, start + size))
    i = start + size + 2
  }
  return Buffer.concat(out)
}

/** 解析响应头 */
function parseHead(headText) {
  const lines = headText.split('\r\n')
  const status = Number((lines[0] || '').split(' ')[1])
  const headers = {}
  for (const line of lines.slice(1)) {
    const c = line.indexOf(':')
    if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim()
  }
  return { status, headers }
}

/* ─────────────────── 主出口 ─────────────────── */

/**
 * GET 一个 URL，返回 { status, headers, body:Buffer }。
 * @param {string} urlStr
 * @param {object} o
 * @param {string} [o.proxyUrl]  给了就 CONNECT 走代理；不给就直连
 * @param {number} [o.timeoutMs]
 * @param {object} [o.headers]
 * @param {number} [o.maxBytes]  上限，超了截断（防拉 30MB 原图把内存打爆）
 * @param {number} [o.redirects] 最多跟几次跳转（镜像会 301 到 -1 形式）
 * @param {object} [o.resolve]   { 主机名: IP } —— 连这个 IP，但 SNI / Host 仍用主机名。
 *   为什么（2026-11-09 实测）：系统 DNS 把 pixiv.re 解析成**污染地址**（TCP 黑洞），
 *   而直接连 Cloudflare 的 104.x 节点、SNI 填 pixiv.re 就是 200。
 *   这就是 pixivpy3 ByPassSniApi 的"固定 IP"那一半；它的 DoH 那一半在本机不可达，没用。
 *   跳转时按**新的主机名**再查一次表，换了域名就不会误用这个 IP。
 *   ⚠️ 值也可以是**数组**：按顺序试，连不上就换下一个（见 httpGetOnce 里那段）。
 */
export function httpGet(urlStr, o = {}) {
  const { proxyUrl, timeoutMs = 25_000, headers = {}, maxBytes = 0, redirects = 5, resolve, minRate, rateGraceMs } = o
  return httpGetOnce(urlStr, { proxyUrl, timeoutMs, headers, maxBytes, resolve, minRate, rateGraceMs }, redirects)
}

/**
 * 通用请求（GET / POST）。
 * pixiv 的 OAuth 换 token 是 POST 表单，所以 transport 不能只有 GET。
 * GET 与它同源，只是多了 method 和 body。
 * @param {'GET'|'POST'} method
 * @param {string} urlStr
 * @param {object} o  httpGet 的参数 + { body?: string }
 */
export function httpRequest(method, urlStr, o = {}) {
  const { proxyUrl, timeoutMs = 25_000, headers = {}, maxBytes = 0, redirects = 5, body } = o
  const merged = { proxyUrl, timeoutMs, headers, maxBytes, body, method: String(method || 'GET').toUpperCase() }
  return httpGetOnce(urlStr, merged, redirects)
}

async function httpGetOnce(urlStr, o, redirectsLeft) {
  const { proxyUrl, timeoutMs, headers, maxBytes, body, method = 'GET', resolve } = o
  const u = new URL(urlStr)
  const isHttps = u.protocol === 'https:'
  // ⚠️ u.host 是带端口的（127.0.0.1:8080），但拼 Host 头时要带端口、
  //    连 socket 和 TLS servername 时只能用 u.hostname。混用会
  //    getaddrinfo ENOTFOUND 127.0.0.1:8080 这种怪错。
  const hostname = u.hostname
  // 固定 IP：只换"连谁"，SNI 和 Host 头照旧是 hostname（见 httpGet 的说明）
  /**
   * 要连的地址，**按顺序试**。
   *   ① 调用方固定了 IP（`resolve`）⇒ 就用它给的那几个（可以是数组）
   *   ② 走代理 ⇒ 让代理自己去解析，这里只给主机名
   *   ③ 直连 ⇒ 解析出**全部** IPv4，上次成功的排最前
   * 🔴 见 GOOD_ADDR 上面那段：只试第一个地址会把"多 A 记录里有黑洞"
   *    变成现在这种"服务时好时坏"的假象。
   */
  const pinnedRaw = resolve && typeof resolve === 'object' ? resolve[hostname] : undefined
  let hostsToTry = []
  if (Array.isArray(pinnedRaw)) hostsToTry = pinnedRaw.map(String).filter(Boolean)
  else if (pinnedRaw) hostsToTry = [String(pinnedRaw)]
  else if (!proxyUrl) {
    const known = GOOD_ADDR.get(hostname)
    const found = await resolveAddrs(hostname)
    hostsToTry = [...new Set([...(known ? [known] : []), ...found])]
  }
  if (!hostsToTry.length) hostsToTry = [hostname]

  const hostHeader = u.host
  const port = Number(u.port) || (isHttps ? 443 : 80)
  const path = u.pathname + u.search

  return new Promise((resolve, reject) => {
    let settled = false
    let currentSocket = null
    /**
     * 收尾时保证 socket 一定被销毁。
     * ⚠️ 坑：TLS 那条路是**握手完成才调 send()** 的，所以连接卡在握手的阶段时
     *    currentSocket 还是 null，dropSocket() 什么都没得销毁 —— 实测每超时一次
     *    就漏 2 个 socket（ConnectWrap + TCPSocketWrap）。对长期跑的插件就是慢性泄漏。
     *    解法：socket 一造出来就登记，别等到 send()。
     */
    const track = (s) => { try { currentSocket = s } catch { /* ignore */ } }
    /**
     * 竞速期的候选 socket（按地址记）。
     * 🔴 硬超时和收尾都**必须**连它们一起收：只登记赢家的话，
     *    正在握手的候选就会漏掉 —— 正是上面那段注释踩过的漏 socket。
     */
    const pending = new Map()
    const killSocket = (s) => {
      try { s.destroy() } catch { /* ignore */ }
      // TLS socket 底下还有一层 TCP，两层都要收
      try { if (s.socket && typeof s.socket.destroy === 'function') s.socket.destroy() } catch { /* ignore */ }
    }
    const killPending = (key) => {
      const s = pending.get(key)
      pending.delete(key)
      if (s) killSocket(s)
    }
    const killAllPending = () => {
      for (const [k, s] of [...pending]) { pending.delete(k); killSocket(s) }
    }
    const dropSocket = () => {
      const s = currentSocket
      currentSocket = null
      if (s) killSocket(s)
      killAllPending()
    }
    const done = (fn, v) => {
      if (settled) return
      settled = true
      clearTimeout(hardTimer)
      fn(v)
    }

    // ⚠️⚠️ 这个硬超时是必须的，别删。
    //   socket.setTimeout() 只在 socket **空闲**时触发；而一个还在
    //   connect 阶段的 TCP（对端不回 SYN-ACK，典型是被墙的地址）
    //   永远不会"空闲"，于是 setTimeout 永远不触发 —— 整个请求无限挂住。
    //   实测：直连 pixiv 时 5 秒兜底都能被绕过，进程直接卡死。
    let hardTimer = setTimeout(() => {
      dropSocket()
      done(reject, new TransportError(`请求超时（${timeoutMs}ms 硬超时）：${urlStr}`))
    }, timeoutMs + 500)
    if (hardTimer.unref) hardTimer.unref()

    const send = (socket) => {
      /**
       * ⚠️ 保险（2026-11-10 加）：socket 要是**已经销毁**，再挂监听可能一个事件都等不到，
       *    请求就静默挂在那儿（变异测试复现过：竞速收尾时误伤了赢家 ⇒ 套件整个挂死）。
       *    生产里硬超时兜得住，但"挂死"是最难查的失败形态 —— 直接说清楚。
       */
      if (!socket || socket.destroyed) {
        done(reject, new TransportError(`连接已被关闭，没能发出请求：${urlStr}`))
        return
      }
      currentSocket = socket
      socket.setTimeout(timeoutMs, () => {
        dropSocket()
        done(reject, new TransportError(`请求超时（${timeoutMs}ms）：${urlStr}`))
      })
      const extra =
        // 默认 UA；调用方给的 headers 排在后面，可以覆盖它
        `User-Agent: ${UA}\r\n` +
        Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') +
        // 不让服务端压缩：省得再引一个解压器
        `Accept-Encoding: identity\r\n` +
        (body != null && body !== ''
          ? `Content-Length: ${Buffer.byteLength(String(body))}\r\n`
          : '') +
        `Connection: close\r\n\r\n`
      const head =
        `${method} ${path} HTTP/1.1\r\n` +
        `Host: ${hostHeader}\r\n` +
        `Referer: ${REFERER}\r\n` +
        `Accept: */*\r\n` +
        `Accept-Language: zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7\r\n` +
        extra
      socket.write(head + (body != null && body !== '' ? String(body) : ''))

      const chunks = []
      let total = 0
      /**
       * 速度下限（可选，2026-11-09 加）：过了宽限期平均速度还低于 minRate 就掐掉。
       * 为什么：镜像固定 IP 时，同一个 Cloudflare 节点对不同文件快慢差上百倍
       * （实测 104.16.0.1 下 24MB 原图 5.9s，同 IP 另一张 21s 0 字节；
       *  104.18.42.239 正好反过来，21KB/s）。死等 120 秒不如早掐、换个节点。
       * 不给 minRate 就不检查（官方/代理那几条路行为不变）。
       */
      const minRate = Number(o.minRate) > 0 ? Number(o.minRate) : 0
      const graceMs = Number(o.rateGraceMs) > 0 ? Number(o.rateGraceMs) : 10_000
      const tStart = Date.now()
      let rateTimer = null
      if (minRate) {
        rateTimer = setInterval(() => {
          const el = Date.now() - tStart
          if (el < graceMs) return
          if (total / (el / 1000) < minRate) {
            clearInterval(rateTimer)
            dropSocket()
            done(reject, new TransportError(
              `太慢（${Math.round(total / 1024)}KB / ${(el / 1000).toFixed(0)}s，低于 ${Math.round(minRate / 1024)}KB/s）：${urlStr}`,
            ))
          }
        }, 2_000)
        if (rateTimer.unref) rateTimer.unref()
        socket.once('close', () => clearInterval(rateTimer))
      }
      socket.on('data', (c) => {
        total += c.length
        if (maxBytes > 0 && total > maxBytes) {
          socket.destroy()
          done(reject, new TransportError(
            `响应超过上限（${(maxBytes / 1048576).toFixed(1)}MB）：${urlStr}`,
          ))
          return
        }
        chunks.push(c)
      })
      socket.on('end', () => {
        // 拿到完整响应就把 socket 收了，别留着（实测会漏 ConnectWrap/TCPSocketWrap）
        const raw = Buffer.concat(chunks)
        const rest = raw
        dropSocket()
        const sep = rest.indexOf('\r\n\r\n', 0, 'latin1')
        if (sep < 0) { done(reject, new TransportError(`响应不完整：${urlStr}`)); return }
        const { status, headers: h } = parseHead(rest.toString('latin1', 0, sep))

        // 跟跳转：镜像 pixiv.re/<id>.jpg 会 301 到 /<id>-1.jpg
        if (status >= 300 && status < 400 && h.location) {
          if (redirectsLeft <= 0) {
            done(reject, new TransportError(`跳转次数太多：${urlStr}`))
            return
          }
          let next
          try {
            next = new URL(h.location, urlStr).toString()
          } catch {
            done(reject, new TransportError(`跳转地址不合法：${h.location}`))
            return
          }
          if (next === urlStr) {
            done(reject, new TransportError(`跳转到自己：${urlStr}`))
            return
          }
          done(resolve, httpGetOnce(next, o, redirectsLeft - 1))
          return
        }

        let body = rest.subarray(sep + 4)
        if (String(h['transfer-encoding'] || '').includes('chunked')) body = dechunk(body)
        done(resolve, { status, headers: h, body })
      })
      socket.on('error', (e) => { dropSocket(); done(reject, e) })
      socket.on('close', () => { dropSocket() })
    }

    const onFail = (err) => {
      dropSocket()
      if (err instanceof TransportError) { done(reject, err); return }
      done(reject, new TransportError(
        `连不上 ${hostname}：${urlStr}\n` +
          (proxyUrl ? `  （走了代理 ${proxyUrl}）` : '  （直连）') +
          `\n  原因：${err && err.message ? err.message : err}`,
      ))
    }

    if (proxyUrl) {
      tunnel(proxyUrl, hostname, port, timeoutMs, (err, socket) => {
        if (err) { onFail(err); return }
        track(socket)
        if (!isHttps) { send(socket); return }
        const t = tls.connect({ socket, servername: hostname, rejectUnauthorized: false }, () => send(t))
        track(t) // 握手期间也要能被销毁
        t.on('error', onFail)
      })
    } else {
      /**
       * 🔴 多个地址**并发抢**，谁先握上手谁赢（2026-11-10，curl 的 happy eyeballs 同理）。
       *
       * 为什么不能"一个一个等"：黑洞地址（不回应 SYN 的那种）要**等到超时**才让位，
       * 实测第一次请求因此白等 4 秒，调用方超时紧的时候直接判死。
       * 隔 STAGGER 毫秒起下一个，好地址通常几百毫秒就赢。
       *
       * ⚠️ 一旦有人赢了：其余候选**立刻销毁**，并且只有赢家会 send()
       *    ⇒ 同一个请求绝不会被发两遍（POST 也安全）。
       * ⚠️ 全部候选都失败了才报错，报错要带上试过哪些地址 ——
       *    不然又变成"连不上"这种没法查的话。
       */
      const STAGGER = 300
      const t0 = Date.now()
      let won = false
      let failed = 0
      let lastErr = null
      let nextIdx = 0
      let staggerTimer = null

      const failAll = () => {
        const why = lastErr && lastErr.message ? lastErr.message : String(lastErr || '未知原因')
        onFail(new Error(`试过 ${hostsToTry.length} 个地址（${hostsToTry.join(', ')}）都不通：${why}`))
      }
      const oneFailed = (target, err) => {
        failed++
        lastErr = err
        killPending(target)
        if (!won && !settled && failed >= hostsToTry.length) failAll()
      }

      const startOne = (target) => {
        if (settled || won) return
        // 每段给一段预算（还被硬超时兜着）。好地址 TCP+TLS 握手几百毫秒就够
        const budget = Math.max(2000, Math.min(6000, timeoutMs))
        let finished = false
        const attTimer = setTimeout(() => {
          if (finished) return
          finished = true
          oneFailed(target, new TransportError(`连 ${target} 超时（${budget}ms）`))
        }, budget)
        if (attTimer.unref) attTimer.unref()

        const ok = (socket) => {
          if (finished) { killSocket(socket); return }
          finished = true
          clearTimeout(attTimer)
          if (settled || won) { killSocket(socket); return }
          won = true
          if (staggerTimer) clearTimeout(staggerTimer)
          // ⚠️ 必须**先**把赢家从候选表里摘出来，再收其余的 ——
          //    否则 killAllPending() 会把赢家自己一起销毁（实测直接把请求挂死）
          pending.delete(target)
          killAllPending()
          track(socket)
          if (GOOD_ADDR.get(hostname) !== target) GOOD_ADDR.set(hostname, target)
          send(socket)
        }
        const bad = (e) => {
          if (finished) return
          finished = true
          clearTimeout(attTimer)
          oneFailed(target, e)
        }
        try {
          const s = isHttps
            ? tls.connect({ host: target, port, servername: hostname, rejectUnauthorized: false }, () => ok(s))
            : net.connect({ host: target, port }, () => ok(s))
          pending.set(target, s)
          s.on('error', bad)
        } catch (e) { bad(e) }
      }

      const scheduleNext = () => {
        if (settled || won || nextIdx >= hostsToTry.length) return
        startOne(hostsToTry[nextIdx++])
        if (nextIdx < hostsToTry.length) {
          staggerTimer = setTimeout(scheduleNext, STAGGER)
          if (staggerTimer.unref) staggerTimer.unref()
        }
      }
      scheduleNext()
    }
  })
}
