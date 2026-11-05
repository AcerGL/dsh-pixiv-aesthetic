/**
 * 登录（可选）的自检。
 *   node selfcheck-auth.mjs
 *
 * 不真连 pixiv —— 真连要你的 refresh_token。这里覆盖：
 * 凭证存取、锁、token 校验形状、降级分支、以及**最要紧的：token 不泄漏**。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = join(tmpdir(), 'px-auth-' + Date.now())
await fs.mkdir(home, { recursive: true })

let pass = 0
const fails = []
const ok = (n, c, extra) => { if (c) pass++; else fails.push(n + (extra ? '  → ' + extra : '')) }
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)
const rejects = async (fn) => { try { await fn(); return false } catch { return true } }

const auth = await import('./lib/auth.mjs')
const { Session, readCredential, writeCredential, clearCredential, credentialPath, AuthError } = auth

/* ─────────── 凭证存取 ─────────── */
{
  eq('开始没有凭证', await readCredential(home), {})

  await writeCredential(home, { refreshToken: 'abc123', userId: '999', userName: 'tester' })
  const c = await readCredential(home)
  eq('写进去读得回', c.userId, '999')
  eq('token 也在', c.refreshToken, 'abc123')

  // 原子写：不该留 .tmp
  const files = await fs.readdir(home)
  ok('没留 .tmp', !files.some((f) => f.endsWith('.tmp')), files.join(','))

  await clearCredential(home)
  eq('清掉之后是空的', await readCredential(home), {})
}

/* ─────────── 文件权限（能设就设） ─────────── */
{
  await writeCredential(home, { refreshToken: 'x'.repeat(30) })
  const p = credentialPath(home)
  const st = await fs.stat(p)
  // Windows 上 0o600 未必生效，所以只提示不判失败
  const mode = st.mode & 0o777
  ok('凭证文件写成功了', st.isFile())
  if (process.platform !== 'win32') {
    ok('权限是 0600', mode === 0o600, mode.toString(8))
  }
  await clearCredential(home)
}

/* ─────────── Session：没配登录时安静降级 ─────────── */
{
  const s = new Session(home, () => ({ useLogin: false, proxyUrl: '' }))
  eq('关着的时候 token() 返回 null', await s.token(), null)
  eq('who() 说没登录', (await s.who()).loggedIn, false)
  eq('hasCredential 是 false', await s.hasCredential(), false)
}

/* ─────────── Session：开着但没贴 token → 明确报错 ─────────── */
{
  const s = new Session(home, () => ({ useLogin: true, proxyUrl: '', timeoutMs: 5000 }))
  let msg = ''
  try { await s.token() } catch (e) { msg = e.message }
  ok('开了登录但没 token 会说清楚', msg.includes('refresh_token'), msg || '(没报错)')
  ok('报的是 AuthError', await rejects(() => s.token()))

  // 但 who() 不该抛
  const w = await s.who()
  eq('who() 不抛且说没登录', w.loggedIn, false)
}

/* ─────────── setRefreshToken 的形状校验（不联网） ─────────── */
{
  const s = new Session(home, () => ({ useLogin: true, proxyUrl: 'http://127.0.0.1:1', timeoutMs: 2000 }))
  ok('空 token 被拒', await rejects(() => s.setRefreshToken('')))
  ok('太短的 token 被拒', await rejects(() => s.setRefreshToken('abc')))
  ok('带空格的被拒', await rejects(() => s.setRefreshToken('this is not a token at all')))
  let m = ''
  try { await s.setRefreshToken('  ') } catch (e) { m = e.message }
  ok('空 token 的报错可读', m.includes('不能为空'), m)
  // 形状对但连不上：应该报网络/代理错，而不是"形状不对"
  let m2 = ''
  try { await s.setRefreshToken('a'.repeat(40)) } catch (e) { m2 = e.message }
  ok('形状对了才去连网（报的是连接问题）', !m2.includes('不像'), m2.slice(0, 90))
}

/* ─────────── 锁：拿不到锁要说清楚，不能死等 ─────────── */
{
  // 手工造一个锁文件，模拟"另一个进程正在刷新"
  await fs.writeFile(join(home, 'credential.lock'), '99999', 'utf8')
  const s = new Session(home, () => ({ useLogin: true, proxyUrl: 'http://127.0.0.1:1', timeoutMs: 1500 }))
  await writeCredential(home, {
    refreshToken: 'r'.repeat(40),
    accessToken: 'old',
    expiresAt: Date.now() - 1000, // 已过期，逼它去刷新
  })
  let msg = ''
  const t0 = Date.now()
  try { await s.token() } catch (e) { msg = e.message }
  const el = Date.now() - t0
  ok('锁被别人占着时报错而不是死等', msg.length > 0, msg.slice(0, 90))
  ok('没有无限等下去', el < 30_000, `${el}ms`)
  await fs.unlink(join(home, 'credential.lock')).catch(() => {})
}

/* ─────────── 内存里还有效的 token 不该反复刷新 ─────────── */
{
  await writeCredential(home, {
    refreshToken: 'r'.repeat(40),
    accessToken: 'GOOD',
    expiresAt: Date.now() + 3_600_000,
  })
  const s = new Session(home, () => ({ useLogin: true, proxyUrl: '', timeoutMs: 3000 }))
  eq('磁盘上的有效 token 直接用', await s.token(), 'GOOD')
}

/* ─────────── 硬性红线：token 不能进 config / 日志 ─────────── */
{
  const cfg = await import('./lib/config.mjs')
  // normalize 出来的配置里不该有任何 token 字段
  const n = cfg.normalize({ useLogin: true, refreshToken: 'SHOULD_NOT_BE_HERE', accessToken: 'NOPE' })
  const keys = Object.keys(n)
  ok('配置里没有 refreshToken', !keys.includes('refreshToken'), keys.join(','))
  ok('配置里没有 accessToken', !keys.includes('accessToken'))
  ok('配置里没有 password', !keys.includes('password'))
  const dumped = JSON.stringify(n)
  ok('配置值里也不含 token 内容', !dumped.includes('SHOULD_NOT_BE_HERE') && !dumped.includes('NOPE'), dumped.slice(0, 140))

  // saveConfig 也要挡住
  const home2 = join(home, 'cfgtest')
  await fs.mkdir(home2, { recursive: true })
  await cfg.saveConfig(home2, { refreshToken: 'SECRET_TOKEN_VALUE', perDay: 3 }, {})
  const raw = await fs.readFile(join(home2, 'config.json'), 'utf8')
  ok('saveConfig 拒绝把 token 写进配置文件', !raw.includes('SECRET_TOKEN_VALUE'), raw.slice(0, 160))
  ok('但正常字段照写', raw.includes('"perDay": 3'), raw)

  ok('SECRET_KEYS 有声明', Array.isArray(cfg.SECRET_KEYS) && cfg.SECRET_KEYS.includes('refreshToken'))
}

/* ─────────── 登录相关的配置项 ─────────── */
{
  const cfg = await import('./lib/config.mjs')
  const d = cfg.normalize({})
  eq('默认不登录', d.useLogin, false)
  eq('默认不刷关注流/推荐', d.loginSources, [])
  ok('followLimit 有钳制', cfg.normalize({ followLimit: 99999 }).followLimit <= 100)
  ok('recommendLimit 有钳制', cfg.normalize({ recommendLimit: -5 }).recommendLimit >= 1)
  eq('loginSources 只认 follow/recommend',
    cfg.normalize({ loginSources: ['follow', 'bogus', 'recommend'] }).loginSources, ['follow', 'recommend'])
  ok('useLogin 只认显式 true', cfg.normalize({ useLogin: 'yes' }).useLogin === false)
}

/* ─────────── 客户端在没登录时的降级 ─────────── */
{
  const { PixivClient } = await import('./lib/pxclient.mjs')
  const c = new PixivClient({ proxyUrl: '' }) // 没有 session
  eq('没 session 时 usingLogin=false', await c.usingLogin(), false)
  const f = await c.following()
  ok('关注流返回空且说明原因', f.skipped === true && f.items.length === 0, JSON.stringify(f))
  ok('原因提到「没登录」', f.why.includes('没登录'), f.why)
  const r = await c.recommended()
  ok('推荐同理', r.skipped === true && r.why.includes('没登录'), JSON.stringify(r))
}

/* ─────────── 客户端在有 session 但没 token 时也不该崩 ─────────── */
{
  const { PixivClient } = await import('./lib/pxclient.mjs')
  // ⚠️ 必须用**独立的家目录**：前面的段落往 home 里写过有效凭证，
  //    复用的话 usingLogin() 会（正确地）返回 true，测的就成了别人。
  const emptyHome = join(home, 'no-cred')
  await fs.mkdir(emptyHome, { recursive: true })

  const s = new Session(emptyHome, () => ({ useLogin: true, proxyUrl: '', timeoutMs: 1000 }))
  const c = new PixivClient({ proxyUrl: '', session: s })
  eq('没凭证时 usingLogin=false', await c.usingLogin(), false)
  const f = await c.following()
  ok('关注流优雅降级', f.skipped === true, JSON.stringify(f))
  ok('记下了登录错误原因', typeof c.lastAuthError === 'string' && c.lastAuthError.length > 0, String(c.lastAuthError).slice(0, 80))
}

/* ─────────── 凭证有效时确实是登录态（反向验一次，别只会测失败） ─────────── */
{
  const { PixivClient } = await import('./lib/pxclient.mjs')
  const goodHome = join(home, 'has-cred')
  await fs.mkdir(goodHome, { recursive: true })
  await writeCredential(goodHome, {
    refreshToken: 'r'.repeat(40), accessToken: 'GOOD', expiresAt: Date.now() + 3_600_000,
  })
  const s = new Session(goodHome, () => ({ useLogin: true, proxyUrl: '', timeoutMs: 1000 }))
  const c = new PixivClient({ proxyUrl: '', session: s })
  eq('有有效凭证时是登录态', await c.usingLogin(), true)
}

await fs.rm(home, { recursive: true, force: true }).catch(() => {})
console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
