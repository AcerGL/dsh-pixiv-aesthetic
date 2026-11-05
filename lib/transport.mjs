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
import { URL } from 'node:url'

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
 */
export function httpGet(urlStr, o = {}) {
  const { proxyUrl, timeoutMs = 25_000, headers = {}, maxBytes = 0, redirects = 5 } = o
  return httpGetOnce(urlStr, { proxyUrl, timeoutMs, headers, maxBytes }, redirects)
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

function httpGetOnce(urlStr, o, redirectsLeft) {
  const { proxyUrl, timeoutMs, headers, maxBytes, body, method = 'GET' } = o
  const u = new URL(urlStr)
  const isHttps = u.protocol === 'https:'
  // ⚠️ u.host 是带端口的（127.0.0.1:8080），但拼 Host 头时要带端口、
  //    连 socket 和 TLS servername 时只能用 u.hostname。混用会
  //    getaddrinfo ENOTFOUND 127.0.0.1:8080 这种怪错。
  const hostname = u.hostname
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
    const dropSocket = () => {
      const s = currentSocket
      currentSocket = null
      if (!s) return
      try { s.destroy() } catch { /* ignore */ }
      // TLS socket 底下还有一层 TCP，两层都要收
      try { if (s.socket && typeof s.socket.destroy === 'function') s.socket.destroy() } catch { /* ignore */ }
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
    } else if (isHttps) {
      const t = tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false }, () => send(t))
      track(t) // 关键：握手期间就登记，否则超时时无 socket 可销毁
      t.on('error', onFail)
    } else {
      const s = net.connect({ host: hostname, port }, () => send(s))
      track(s)
      s.on('error', onFail)
    }
  })
}
