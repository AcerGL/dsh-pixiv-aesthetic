/**
 * 凭证 —— pixiv 登录态（可选）。
 * ============================================================================
 * 为什么走 App API 而不是网页登录（2026-11-04 实测）：
 *   网页 cookie 喂不动这些接口，**全是 404**：
 *     我的关注流 / 我的收藏 / 推荐 / 为你推荐 / 我的资料
 *   ⇒ 想拿关注流和个性化推荐，必须用 app-api.pixiv.net 的 Bearer token。
 *
 * 三条硬规矩：
 *   1. **只用 readonly 权限**。pixiv 的 token 是带 scope 的，我们用 readonly，
 *      不可能点赞/收藏/关注/评论 —— 从权限上就保证"只读"。
 *   2. **token 不进 config.json、不进日志、不进 prompt**。它只住 credential.json。
 *   3. **refresh_token 会轮换**：pixiv 每次刷新都换发新值，旧的立即作废。
 *      所以：① 刷新后必须立刻落盘；② 加文件锁，避免两个进程同时刷新互相踢掉。
 *          （隔壁 dafayu-pixiv-duty 的 README 专门警告过这一点）
 * ============================================================================
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const TOKEN_URL = 'https://oauth.secure.pixiv.net/auth/token'
const APP_API = 'https://app-api.pixiv.net'

/** pixiv 官方 Android 客户端的公开 client 凭据（pixivpy 等库用同一套） */
const CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT'
const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj'
/** 用官方 HashSecret 生成的哈希；没它 pixiv 会在部分接口拒绝 */
const HASH_SECRET = '28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c'

export class AuthError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'AuthError'
    this.code = code
  }
}

/** 凭证文件路径 */
export function credentialPath(home) {
  return join(home, 'credential.json')
}

/**
 * 读凭证。
 * @returns {Promise<{refreshToken?:string, accessToken?:string, expiresAt?:number, userId?:string, userName?:string}>}
 */
export async function readCredential(home) {
  try {
    const j = JSON.parse(await fs.readFile(credentialPath(home), 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

/**
 * 写凭证。**权限收紧**（Windows 下尽量只留当前用户）。
 */
export async function writeCredential(home, cred) {
  await fs.mkdir(home, { recursive: true })
  const p = credentialPath(home)
  const tmp = p + '.tmp'
  // Windows 上 mode 基本不起作用，但还是写上（跨平台）
  await fs.writeFile(tmp, JSON.stringify(cred, null, 2), { encoding: 'utf8', mode: 0o600 })
  await fs.chmod(tmp, 0o600).catch(() => {})
  await fs.rename(tmp, p)
  await fs.chmod(p, 0o600).catch(() => {})
  return cred
}

export async function clearCredential(home) {
  try { await fs.unlink(credentialPath(home)) } catch { /* 没有就算了 */ }
}

/** 简单文件锁：避免两个进程同时刷新 token 互相踢掉 */
async function withLock(home, fn) {
  const lock = join(home, 'credential.lock')
  const deadline = Date.now() + 15_000
  let held = false
  while (Date.now() < deadline) {
    try {
      const fh = await fs.open(lock, 'wx')
      await fh.write(String(process.pid))
      await fh.close()
      held = true
      break
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  if (!held) throw new AuthError('刷新 token 的锁拿不到（可能有另一个进程正在刷新）', 'LOCKED')
  try {
    return await fn()
  } finally {
    try { await fs.unlink(lock) } catch { /* ignore */ }
  }
}

/**
 * 用 refresh_token 换 access_token。
 * ⚠️ pixiv **每次刷新都会换发新的 refresh_token**，所以这里必须把两个都存回去。
 */
export async function refreshAccessToken(refreshToken, o = {}) {
  if (!refreshToken) throw new AuthError('没有 refresh_token', 'NO_TOKEN')
  const { httpGet } = await import('./transport.mjs')

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    include_policy: 'true',
  }).toString()

  const res = await httpPost(TOKEN_URL, body, {
    proxyUrl: o.proxyUrl,
    timeoutMs: o.timeoutMs || 20_000,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'App-OS': 'android',
      'App-OS-Version': '9.0',
      'App-Version': '7.6.2',
      'User-Agent': 'PixivAndroidApp/5.0.234 (Android 9.0; Pixel 3)',
    },
  })

  if (res.status === 400 || res.status === 401) {
    let why = 'refresh_token 无效或已过期'
    try {
      const j = JSON.parse(res.body.toString('utf8'))
      if (j && j.errors && j.errors.system && j.errors.system.message) why += `：${j.errors.system.message}`
    } catch { /* 忽略解析失败 */ }
    throw new AuthError(why + '\n（token 会轮换 —— 如果你在别处也用了同一个 token，两边会互相踢掉，只能重新贴一个）', 'BAD_TOKEN')
  }
  if (res.status !== 200) {
    throw new AuthError(`换 token 失败：HTTP ${res.status}`, 'HTTP')
  }

  let j
  try {
    j = JSON.parse(res.body.toString('utf8'))
  } catch {
    throw new AuthError('换 token 的响应读不懂', 'PARSE')
  }
  if (!j.access_token) throw new AuthError('响应里没有 access_token', 'NO_ACCESS')

  const expiresIn = Number(j.expires_in) || 3600
  return {
    accessToken: j.access_token,
    // ⚠️ 轮换：新的 refresh_token 必须覆盖旧的
    refreshToken: j.refresh_token || refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    userId: j.user && j.user.id ? String(j.user.id) : '',
    userName: j.user && j.user.name ? String(j.user.name) : '',
    scope: j.scope || '',
  }
}

/** 一个极小的 POST（transport 只做了 GET，这里补上） */
async function httpPost(url, body, o = {}) {
  const { httpRequest } = await import('./transport.mjs')
  return await httpRequest('POST', url, { ...o, body })
}

/**
 * 登录会话 —— 管着 access_token 的生命周期。
 * 用法：`const s = new Session(home, getConfig); await s.token()` —— 它会按需刷新。
 */
export class Session {
  /**
   * @param {string} home
   * @param {() => object} getConfig
   * @param {(msg:string)=>void} [log]
   */
  constructor(home, getConfig, log) {
    this.home = home
    this.getConfig = getConfig
    this.log = log || (() => {})
    this._cache = null
    /**
     * 取「实际可用的代理」的回调 —— 由 PixivClient 注入。
     *
     * 为什么需要（2026-11-06 踩到）：本机直连 pixiv 不通，只有本地代理通。
     * 用户没填 proxyUrl 时，代理是**自动发现**出来的，结果存在 RouteProbe 里；
     * Session 只看得到 cfg.proxyUrl（空的）⇒ App API 请求直连 ⇒ 超时 ⇒
     * 「个性化推荐取不到：连不上 app-api.pixiv.net」。
     * ⇒ 让 client 把这个回调注进来，两边用同一个代理。
     */
    this._getEffectiveProxy = null
  }

  /** 由 PixivClient 注入：拿实际可用的代理（空字符串 = 不代理） */
  setEffectiveProxy(fn) {
    this._getEffectiveProxy = typeof fn === 'function' ? fn : null
  }

  /** 内部：解析这次请求该走哪个代理 */
  _proxy() {
    const cfg = this.getConfig()
    if (this._getEffectiveProxy) {
      try {
        const p = this._getEffectiveProxy()
        if (p) return p
      } catch { /* 拿不到就退回配置里的 */ }
    }
    return cfg.proxyUrl
  }

  /** 有没有配 token（不校验有效性） */
  async hasCredential() {
    const c = await readCredential(this.home)
    return !!c.refreshToken
  }

  /** 当前身份（供状态显示） */
  async who() {
    const c = await readCredential(this.home)
    if (!c.refreshToken) return { loggedIn: false }
    return {
      loggedIn: true,
      userId: c.userId || '',
      userName: c.userName || '',
      scope: c.scope || '',
      expiresAt: c.expiresAt || 0,
    }
  }

  /** 手贴 refresh_token 保存起来 */
  async setRefreshToken(token) {
    const t = String(token || '').trim()
    if (!t) throw new AuthError('refresh_token 不能为空', 'EMPTY')
    if (!/^[\w.\-]{20,}$/.test(t)) {
      throw new AuthError('这看起来不像 refresh_token（应该是一长串字符，没有空格）', 'SHAPE')
    }
    const cfg = this.getConfig()
    // 立刻验一次，别存一个用不了的进去
    // ⚠️ 用 _proxy()（会考虑自动发现的代理），不是 cfg.proxyUrl —— 见 _proxy 的说明
    const fresh = await refreshAccessToken(t, { proxyUrl: this._proxy(), timeoutMs: cfg.timeoutMs })
    await writeCredential(this.home, {
      refreshToken: fresh.refreshToken, // ⚠️ 存轮换后的新值
      accessToken: fresh.accessToken,
      expiresAt: fresh.expiresAt,
      userId: fresh.userId,
      userName: fresh.userName,
      scope: fresh.scope,
      updatedAt: new Date().toISOString(),
    })
    this._cache = fresh
    this.log(`登录成功：${fresh.userName || fresh.userId || '(未知)'}（scope=${fresh.scope || '?'}）`)
    return await this.who()
  }

  async logout() {
    await clearCredential(this.home)
    this._cache = null
    this.log('已退出登录（本地凭证已删）')
  }

  /**
   * 拿一个可用的 access_token，过期就刷新。
   * @returns {Promise<string|null>} 没配登录就返回 null（调用方据此降级到游客模式）
   */
  async token() {
    const cfg = this.getConfig()
    if (!cfg.useLogin) return null

    // 内存缓存还新鲜
    if (this._cache && this._cache.accessToken && this._cache.expiresAt - Date.now() > 60_000) {
      return this._cache.accessToken
    }

    const c = await readCredential(this.home)
    if (!c.refreshToken) throw new AuthError(
      '开了登录但没配 refresh_token。去设置页贴一个，或者把「使用登录」关掉。',
      'NO_CREDENTIAL',
    )

    // 磁盘上的还没过期
    if (c.accessToken && c.expiresAt && c.expiresAt - Date.now() > 60_000) {
      this._cache = { accessToken: c.accessToken, expiresAt: c.expiresAt, refreshToken: c.refreshToken }
      return c.accessToken
    }

    // 刷新（加锁，且刷新后立刻落盘）
    const fresh = await withLock(this.home, async () => {
      // 双重检查：可能另一个进程刚刷过
      const again = await readCredential(this.home)
      if (again.accessToken && again.expiresAt && again.expiresAt - Date.now() > 60_000) {
        return { accessToken: again.accessToken, expiresAt: again.expiresAt, refreshToken: again.refreshToken }
      }
      const f = await refreshAccessToken(again.refreshToken || c.refreshToken, {
        proxyUrl: this._proxy(), timeoutMs: cfg.timeoutMs,
      })
      await writeCredential(this.home, {
        refreshToken: f.refreshToken,
        accessToken: f.accessToken,
        expiresAt: f.expiresAt,
        userId: f.userId || again.userId || '',
        userName: f.userName || again.userName || '',
        scope: f.scope || again.scope || '',
        updatedAt: new Date().toISOString(),
      })
      return f
    })

    this._cache = fresh
    return fresh.accessToken
  }

  /** 发一个 App API 的 GET（带登录） */
  async apiGet(path, params = {}) {
    const token = await this.token()
    if (!token) throw new AuthError('没有登录态', 'NO_TOKEN')
    const cfg = this.getConfig()
    const url = APP_API + path + (Object.keys(params).length
      ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString()
      : '')
    /**
     * ⚠️ 代理要用 effectiveProxy，**不是** cfg.proxyUrl。
     *
     * 踩过（2026-11-06）：本机直连 pixiv 不通、只有 7897 代理通。
     * 用户没填 proxyUrl（靠自动发现找到的），而这里读 cfg.proxyUrl 是空的
     * ⇒ 直连 ⇒ 超时 ⇒ 「个性化推荐取不到：连不上 app-api.pixiv.net」。
     * 跟 pxclient 里那个坑是同一个（那边已经改成 effectiveProxy 了）。
     *
     * 拿不到 client 时退回 cfg.proxyUrl（那时反正也没自动发现）。
     */
    const proxyUrl = this._proxy()
    const res = await httpGetRaw(url, {
      proxyUrl,
      timeoutMs: cfg.timeoutMs,
      headers: {
        Authorization: `Bearer ${token}`,
        'App-OS': 'android',
        'App-OS-Version': '9.0',
        'App-Version': '7.6.2',
        'User-Agent': 'PixivAndroidApp/5.0.234 (Android 9.0; Pixel 3)',
        Accept: 'application/json',
      },
    })
    if (res.status === 401) {
      // token 突然失效：清掉内存缓存，下次会重新刷
      this._cache = null
      throw new AuthError('登录态失效（401）。可能 token 被别处刷新踢掉了，重新贴一个。', 'UNAUTHORIZED')
    }
    if (res.status !== 200) throw new AuthError(`App API HTTP ${res.status}：${path}`, 'HTTP')
    try {
      return JSON.parse(res.body.toString('utf8'))
    } catch {
      throw new AuthError(`App API 返回的不是 JSON：${path}`, 'PARSE')
    }
  }
}

/** 直接走 transport 拿原始响应（不给它加 pixiv 网页的 Referer） */
async function httpGetRaw(url, o) {
  const { httpRequest } = await import('./transport.mjs')
  return await httpRequest('GET', url, o)
}

export const APP_API_BASE = APP_API
