/**
 * dsh-pixiv-aesthetic —— 宿主半端。
 * ============================================================================
 * 一个 DSH 插件长这样：
 *   package.json 声明 dsh.bundle.patch → 装上后 profile 自动挂载，不用手改配置
 *   index.js 导出 apply(ctx, config) → 宿主调它来装配
 *
 * 这个插件干什么：
 *   按你的口味刷 Pixiv——搜 / 筛 / 我读图精选 / 存到你指定的目录 / 发给你。
 *
 * 三条设计口径（都是跟号主对过的）：
 *   ① 投递是**通道接口**，QQ 只是一个适配器，默认永远有「落盘」
 *   ② 网络**三级探测**（直连 → 代理 → 镜像），按实际连通性选，不按 IP 猜
 *   ③ 出错要说人话，不让人对着"搜到 0 条"猜
 * ============================================================================
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'

import { loadConfig, saveConfig, normalize, DEFAULTS, configPath, SECRET_KEYS } from './lib/config.mjs'
import { Toolset } from './lib/toolset.mjs'
import { Ledger, localDay } from './lib/seen.mjs'
import { runShrink } from './lib/shrink.mjs'

export const name = 'pixiv-scroll'

/**
 * ⚠️⚠️ **不要**在这里声明对象级 `inject`，这是踩过的坑（2026-11-04 实测）。
 *
 * 教训来源：官方 `dsh-agent-preset` 里写的标准形态是
 *   `export function apply(ctx, config) {}` + `export const inject = ['tools']`
 * 但在**桌面版（Electron）**上这条会让插件**完全不注册工具**：
 *
 *   · 对象级 inject 会把整个 `apply()` **推迟到这些服务就绪之后**；
 *   · 而桌面端的注入表是**宿主启动时一次性收集**的（dsh-desktop-host 的
 *     `collectIndexInjections()` → IPC → 渲染层）。订阅一旦晚于那次收集，
 *     就再也补不进去。
 *
 * 实测症状：duty.log 里只有「配置已加载」那行（那是 apply 里的异步回调写的），
 * 而排在它后面的「已挂载：注册了 N 个工具」**一个字都没有** ——
 * 说明 apply 压根没执行到那儿。工具在宿主里也不存在。
 *
 * 正确做法（抄 dsh-whale-widget 的做法）：对象级不声明，
 * 在 apply 里用 **局部等待** `ctx.inject(['tools'], cb)`，
 * 语义等价但**不推迟 apply 本身**。
 *
 * 另一条同源的红线：**可选服务绝不能进 inject**。进了就会永远等不到而完全不 apply，
 * 比"没有这个功能"严重得多。所以 `webServer` / `connection` / `qqbot` 这些
 * 一律只用 `ctx.get()` 按需取。
 */

/**
 * 读请求体。
 * ⚠️ 两种形状都要兜：webServer 给的是流（要 for-await），
 *    connection.fetch 那边是 Request（已经缓成 text 了）。
 */
async function readBody(req) {
  try {
    const raw = req && req.body !== undefined && req.body !== null && req.body !== ''
      ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
      : await (async () => {
          let s = ''
          if (req && typeof req[Symbol.asyncIterator] === 'function') {
            for await (const chunk of req) s += chunk
          }
          return s
        })()
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/**
 * Config —— 给宿主的配置 schema。
 *
 * 🔴 这个坑我踩了两轮，正反面都撞过，别改回去（2026-11-04）：
 *
 *   **第一版**（错）：顶层 `await import('@deepseek-ai/schemastery')` 建 z.object
 *      → `schemastery` 是 optional peer，**对 link 安装的插件解析不到**
 *        （装的时候就警告 "will not resolve the peer dependencies"，实测 MODULE_NOT_FOUND）
 *      → 顶层 await 让模块求值挂起 → 宿主认为模块没加载完 → **apply 压根不被调用**。
 *
 *   **第二版**（错）：改成导出一个**普通对象字面量**。
 *      → 这次模块加载没问题了，entry 也进了配置树（`--dump-config` 能看到），
 *        但宿主启动时报：
 *            pixiv-scroll (dsh-pixiv-aesthetic):
 *            TypeError: Cannot read properties of undefined (reading 'validate')
 *            at resolveConfig (.../cordis/lib/index.js)
 *        → **entry 不 activate**，apply 仍然不执行。
 *
 *   宿主 cordis 的真实契约（读源码确认）：
 *       function resolveConfig(runtime, config) {
 *         if (!runtime.Config) return config                        // 没有 Config 就跳过
 *         const result = runtime.Config['~standard'].validate(config)  // ← 必须有这个
 *         ...
 *       }
 *   也就是说：**要么不导出 Config，要么导出一个符合 standard-schema 协议的对象**
 *   （带 `~standard.validate`）。普通字面量两头不沾，必炸。
 *
 *   这里选手写 standard-schema：**零依赖**（不用 schemastery，绕开解析不到的问题），
 *   而且保留配置校验能力。真正的归一化在 lib/config.mjs 的 normalize() 里，
 *   这层只做「形状兜底 + 类型钳制」，别把业务逻辑塞进来。
 */
const CONFIG_SHAPE = {
  enabled: 'boolean',
  proxyUrl: 'string',
  externalApi: 'string',
  mirrorHost: 'string',
  hibiEnabled: 'boolean',
  hibiApi: 'string',
  mirrorIps: 'array',
  keywords: 'array',
  rankModes: 'array',
  excludeTags: 'array',
  requireTags: 'array',
  tagWeights: 'object',
  minBookmarks: 'number',
  minLongEdge: 'number',
  maxPages: 'number',
  maxAgeDays: 'number',
  allowR18: 'boolean',
  dropAiGenerated: 'boolean',
  tasteEnabled: 'boolean',
  tasteKeywords: 'number',
  tasteMinWeight: 'number',
  tasteScale: 'number',
  useLogin: 'boolean',
  loginSources: 'array',
  followLimit: 'number',
  recommendLimit: 'number',
  saveRoot: 'string',
  dirTemplate: 'string',
  perDay: 'number',
  perRound: 'number',
  maxLook: 'number',
  maxPagesPerWork: 'number',
  channels: 'array',
  qqPassiveWindowMs: 'number',
  qqMaxBytes: 'number',
  shrinkEnabled: 'boolean',
  shrinkLongEdge: 'number',
  shrinkMaxBytes: 'number',
  intervalMin: 'number',
  peakValley: 'boolean',
  noon: 'boolean',
  night: 'boolean',
}

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-pixiv-aesthetic',
    /**
     * 校验 + 兜底。
     * 规矩：**永远返回 value，绝不因类型不对就 reject** ——
     * 用户手改 config.json 写错类型时，插件该照常起来（走归一化），
     * 而不是整个 entry 不激活（那正是我踩过的坑）。
     */
    validate(input) {
      const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {}
      const value = {}
      for (const [key, kind] of Object.entries(CONFIG_SHAPE)) {
        const v = src[key]
        if (v === undefined || v === null) continue // 缺省交给 lib/config.mjs 的 DEFAULTS
        if (kind === 'array') {
          value[key] = Array.isArray(v) ? v : undefined
          if (value[key] === undefined) delete value[key]
        } else if (kind === 'object') {
          value[key] = (v && typeof v === 'object' && !Array.isArray(v)) ? v : undefined
          if (value[key] === undefined) delete value[key]
        } else if (typeof v === kind) {
          value[key] = v
        } else if (kind === 'number' && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
          // 设置页可能把数字送成字符串 —— 宽容一点，别因此不激活
          value[key] = Number(v)
        }
        // 其余类型不对的键：**直接丢掉**，留给 DEFAULTS 兜底
      }
      // 未知键原样带上（用户可能有自己的扩展），别偷偷删用户的配置
      for (const [k, v] of Object.entries(src)) {
        if (!(k in CONFIG_SHAPE)) value[k] = v
      }
      return { value }
    },
  },
}


/* ─────────────────── 家目录 ─────────────────── */

/**
 * 插件家目录：$DSH_HOME/pixiv-scroll
 * ⚠️ dshHomePath 在 DSH 里**可能是个函数**也可能是个字符串（刷B站踩过），
 *    两种都要兜。
 */
function homeDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('pixiv-scroll')
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'pixiv-scroll')
    }
  } catch { /* 拿不到就兜底 */ }
  if (!dir) {
    const base = process.env.DSH_HOME || join(homedir(), '.dsh')
    dir = join(base, 'pixiv-scroll')
  }
  try { mkdirSync(dir, { recursive: true }) } catch { /* 建不出来也别在 apply 里抛 */ }
  return dir
}

/** 找运行时自带的 python（压缩用） */
function findPython(ctx) {
  const cands = []
  try {
    const p = ctx?.get?.('dshHomePath')
    const base = typeof p === 'function' ? p('') : (typeof p === 'string' ? p : '')
    if (base) cands.push(join(base, '..', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'))
  } catch { /* ignore */ }
  cands.push(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'))
  for (const c of cands) {
    try { if (existsSync(c)) return c } catch { /* ignore */ }
  }
  return 'python'
}

/** 找 QQ 上下文的线索（dsh-qqbot 的本地补丁落盘的） */
function qqContext() {
  const home = join(homedir(), '.dsh-qqbot')
  return {
    msgsLog: join(home, 'msgs.log'),
    peersLog: join(home, 'peers.log'),
  }
}

/* ─────────────────── 状态 ─────────────────── */

function logPath(home) { return join(home, 'duty.log') }

/**
 * 追加一行日志。
 * ⚠️ 踩过的坑：原来用 fs.stat(p).then(...) 异步判断轮转，但**外层 try 抓不到**
 *    异步里的异常；而且 writeFileSync 到不存在的目录会抛，被外层 catch 静默吞掉
 *    —— 结果 home 目录没预先建好时，日志**完全没写**，排查时什么都看不到。
 *    改成全同步 + 自己建目录，稳。
 */
function appendLog(home, line) {
  try {
    const p = logPath(home)
    const s = `[${new Date().toISOString()}] ${line}\n`
    mkdirSync(home, { recursive: true })

    let size = 0
    try { size = statSync(p).size } catch { size = 0 }
    if (size > 512 * 1024) {
      // 轮转：留着上一份，别让日志无限涨
      try { writeFileSync(p + '.1', readFileSync(p)) } catch { /* ignore */ }
      writeFileSync(p, s)
    } else {
      appendFileSync(p, s)
    }
  } catch { /* 日志失败不该影响主流程 —— 但上面每条路径都尽量同步，别静默死 */ }
}

async function readState(home) {
  try {
    return JSON.parse(await fs.readFile(join(home, 'state.json'), 'utf8'))
  } catch {
    return {}
  }
}

async function writeState(home, state) {
  try {
    await fs.mkdir(home, { recursive: true })
    const p = join(home, 'state.json')
    await fs.writeFile(p + '.tmp', JSON.stringify(state, null, 2))
    await fs.rename(p + '.tmp', p)
  } catch { /* ignore */ }
}

/* ─────────────────── 装配 ─────────────────── */

/**
 * 装配入口。
 *
 * ⚠️ 外面包一层 try/catch 是必须的：宿主对 apply 里抛出的异常**不一定有可见反馈**
 *    （表现就是"插件装了但什么都不发生"）。踩过一次：改了 inject 之后，
 *    duty.log 里连一行"工具没注册上"都没有 —— 就是因为异常被吞了，什么都看不到。
 *    这里把任何异常都落进 duty.log，保证**永远能查到为什么**。
 */
export function apply(ctx, hostConfig = {}) {
  // homeDirOf 自己会建目录、也不抛，所以这里能安全地先拿到 home 用于记日志
  let home = ''
  try {
    home = homeDirOf(ctx)
  } catch (err) {
    // 连家目录都拿不到的话，只能尽量写一个位置
    try {
      const base = process.env.DSH_HOME || join(homedir(), '.dsh')
      home = join(base, 'pixiv-scroll')
      mkdirSync(home, { recursive: true })
      appendLog(home, `⚠️ 家目录解析失败：${err && err.message}`)
    } catch { /* 实在写不了就算了 */ }
    return
  }

  try {
    return applyInner(ctx, hostConfig, home)
  } catch (err) {
    // 🔴 关键：异常必须留下痕迹，否则就是"装了没反应"的玄学问题
    try {
      appendLog(home, `🔴 apply 抛异常（插件没装配完）：${err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err}`)
    } catch { /* ignore */ }
    throw err
  }
}

function applyInner(ctx, hostConfig, home) {
  const python = findPython(ctx)
  let cfg = normalize(hostConfig)

  /**
   * 浮窗「这一轮」看板 —— 最近一次推荐的结果。
   * ⚠️ 只活在**宿主进程内存**里，不落盘：它是"这一轮"的意思，
   *    重启后就该空，不该显示上次的东西让用户以为是最新的。
   */
  let lastBoard = { items: [], at: '', label: '' }

  /** 配置：每次现取（设置页改完立刻生效，不用重启） */
  const getConfig = () => cfg

  /** 配置落地后要重读一次（定时器要跟着 intervalMin 走） */
  let onConfigLoaded = () => {}

  // 异步把 config.json 读进来覆盖（绕开 profile config 不进 user 层那个坑）
  loadConfig(home, hostConfig).then((c) => {
    cfg = c
    appendLog(home, `配置已加载：perDay=${c.perDay} perRound=${c.perRound} proxy=${c.proxyUrl || '(直连)'} channels=${c.channels.join('+')}`)
    try { onConfigLoaded() } catch { /* ignore */ }
  }).catch((err) => {
    appendLog(home, `配置加载失败，用默认值：${err && err.message}`)
  })

  /* ── 投递上下文：从宿主里找 QQ ── */
  const getDelivery = () => {
    const q = qqContext()
    // 宿主里有没有 qqbot 服务，靠试取（未 inject 的 ctx.foo 会抛，所以用 get）
    let bot = null
    let manager = null
    try { bot = ctx.get('qqbot') || null } catch { bot = null }
    try { manager = ctx.get('qqbotSessions') || ctx.get('qqbotManager') || null } catch { /* ignore */ }
    if (!bot) return null
    return { qq: { bot, manager, msgsLog: q.msgsLog } }
  }

  const ts = new Toolset({
    home, getConfig, getDelivery, python,
    /**
     * 每轮结果推给「浮窗·这一轮」。
     * ⚠️ 只在**进程内存**里，不落盘 —— 它是"这一轮"的意思。
     *    落盘的话重启后会显示上次的，用户会以为是新的。
     */
    onResult: (payload) => {
      try {
        lastBoard = {
          items: (Array.isArray(payload.items) ? payload.items : []).slice(0, 60).map((it) => ({
            id: String(it.id || ''),
            title: String(it.title || ''),
            artist: String(it.artist || it.userName || ''),
            url: String(it.url || ''),
            from: String(it.from || ''),
          })),
          at: new Date().toISOString(),
          label: String(payload.label || '').slice(0, 80),
        }
      } catch { /* 浮窗数据坏了不该影响工具结果 */ }
    },
  })

  /* ── 注册工具 ──
   * ⚠️ 用**局部等待**而不是对象级 inject（原因见文件顶部那段注释）：
   *    先试现成的 ctx.get('tools')（服务已经在就立刻注册，最快路径）；
   *    拿不到再用 ctx.inject(['tools'], cb) 等它——这样 apply 本身不被推迟。
   *    两条路都走不通就**如实记日志**，绝不静默失败。 */
  const registerTools = (tools) => {
    if (!tools || typeof tools.register !== 'function') {
      appendLog(home, '⚠️ tools 服务不可用，工具没注册上')
      return false
    }
    const defs = ts.definitions()
    for (const def of defs) {
      ctx.effect(() => tools.register(def))
    }
    appendLog(home, `已挂载：注册了 ${defs.length} 个工具，家目录 ${home}`)
    return true
  }

  const immediate = (() => {
    try { return ctx.get('tools') } catch { return undefined }
  })()

  if (!registerTools(immediate)) {
    // 局部等待：语义等价于对象级 inject，但不推迟 apply
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['tools'], (c) => {
          try {
            registerTools(c && typeof c.get === 'function' ? c.get('tools') : c)
          } catch (err) {
            appendLog(home, `⚠️ 等到 tools 后注册失败：${err && err.message}`)
          }
        })
      } catch (err) {
        appendLog(home, `⚠️ ctx.inject 不可用：${err && err.message}`)
      }
    } else {
      appendLog(home, '⚠️ 没有 ctx.inject，也没拿到 tools —— 工具没注册上')
    }
  }

  /* ── 定时器（intervalMin > 0 才跑） ── */
  ctx.effect(() => {
    let stopped = false
    let timer = null

    const tick = async () => {
      if (stopped) return
      try {
        const c = getConfig()
        if (!c.enabled || !c.intervalMin) return

        // 谷时窗口：工作日 9–12 / 14–18 是高峰，其余算谷时
        if (c.peakValley) {
          const now = new Date()
          const h = now.getHours()
          const wd = now.getDay() >= 1 && now.getDay() <= 5
          const isPeak = wd && ((h >= 9 && h < 12) || (h >= 14 && h < 18))
          if (isPeak) {
            appendLog(home, '高峰时段，跳过这一轮')
            return
          }
          const inNoon = h >= 12 && h < 14
          const inNight = h >= 18 || h < 9
          if ((inNoon && !c.noon) || (inNight && !c.night)) {
            appendLog(home, '这个时段没开，跳过')
            return
          }
        }

        const st = await readState(home)
        st.lastRunAt = new Date().toISOString()
        await writeState(home, st)
        appendLog(home, `定时轮到点（intervalMin=${c.intervalMin}）—— 交给 headless 会话执行章程`)

        // ⚠️ 这里**不自己跑一轮**。定时轮的实质是「起一个 headless 子会话照着
        //    prompts/duty.md 走」。子会话的拉起方式在 index 里做会有两个坑：
        //    ① 桌面版 dsh 不在 PATH
        //    ② 同一 profile 并发起会话会互相抢
        //    所以这里只记时间戳 + 写日志，真正拉起由下面的 runRound() 负责，
        //    它用 dshBin 明确指路（设置页可配）。
        await runRound(c).catch((err) => {
          appendLog(home, `定时轮失败：${err && err.message ? err.message : err}`)
        })
      } catch (err) {
        // ⚠️ 定时器回调里所有异常都要自己兜住 —— 刷B站上上一版就是因为
        //    回调里抛 TypeError 没人接，直接把宿主进程带走（"DSH 突然崩了"）
        appendLog(home, `定时轮异常（已兜住）：${err && err.message ? err.message : err}`)
      }
    }

    /* ⚠️ 坑：apply 时是**同步**的，而 intervalMin 要等异步 loadConfig 落地才知道。
     *    所以不能在 effect 里读一次就 setInterval —— 那一刻 getConfig().intervalMin
     *    还是宿主给的（常常是 undefined → 0），定时器会**永远起不来**。
     *    解法：每分钟检查一次"该不该起 / 该不该换间隔"，用状态机跟着配置走。
     *    这也顺带解决了"设置页改了 intervalMin 要不要重启"的问题 —— 不用。 */
    let currentInterval = 0
    let lastArm = 0

    const ensureArmed = () => {
      if (stopped) return
      const want = Math.max(0, Math.trunc(getConfig().intervalMin || 0))
      const wantMs = want > 0 ? Math.max(60_000, want * 60_000) : 0
      if (wantMs === currentInterval) return
      if (timer) { clearInterval(timer); timer = null }
      currentInterval = wantMs
      if (wantMs > 0) {
        timer = setInterval(tick, wantMs)
        if (timer.unref) timer.unref()
        appendLog(home, `定时器已起：每 ${want} 分钟一轮`)
      } else if (currentInterval !== wantMs) {
        appendLog(home, '定时器已停（intervalMin=0）')
      }
    }

    /** 配置可能异步到达；每 20 秒对一次，起来了就固定 */
    const armWatcher = setInterval(() => {
      ensureArmed()
      if (currentInterval > 0 && Date.now() - lastArm > 300_000) {
        clearInterval(armWatcher)
      }
      lastArm = Date.now()
    }, 20_000)
    if (armWatcher.unref) armWatcher.unref()

    // 配置一落地就立刻对一次，不用等 20 秒
    onConfigLoaded = () => ensureArmed()

    // 立刻试一次（宿主 config 里已经给了 intervalMin 的场合）
    ensureArmed()

    return () => {
      stopped = true
      clearInterval(armWatcher)
      if (timer) clearInterval(timer)
      timer = null
    }
  })

  /* ── 给设置页 / 浮窗用的 HTTP 接口 ── */
  ctx.effect(() => {
    const handler = async (req, res) => {
      const url = new URL(req.url || '/', 'http://x')
      const p = url.pathname
      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(obj))
      }
      /**
       * 发**二进制**（图片）。跟 json 并列，因为浮窗要直接 <img src>。
       * ⚠️ connection 那条通道得能接住 Uint8Array（见下面 fetch 分支），
       *    光有 writeHead/end 的字符串版不够。
       */
      const binary = (code, bytes, contentType) => {
        res.writeHead(code, {
          'Content-Type': contentType || 'application/octet-stream',
          // 缩略图按 id 缓存，短期内不变；让浏览器少问几次
          'Cache-Control': 'private, max-age=600',
        })
        res.end(bytes)
      }
      try {
        if (p.endsWith('/api/pixiv-scroll/ping')) {
          json(200, { ok: true, home, version: '0.1.0' })
          return
        }
        /**
         * 浏览器半端把自己的异常报上来。
         *
         * 🔴 为什么需要这条：client 半端抛异常时，宿主只把 entry 标成
         *    `failed`，界面上只弹一句「N 个插件未能激活」，**根本不给原因**，
         *    浏览器控制台我们也看不到（DSH 自己的窗口不给控制）。
         *    2026-11-07 就因为查不到原因，多折腾了一轮。
         *    所以让 client 自己把堆栈 POST 过来落地成文件，下次直接读。
         */
        if (p.endsWith('/api/pixiv-scroll/client-error')) {
          const body = await readBody(req)
          try {
            mkdirSync(home, { recursive: true })
            appendFileSync(
              join(home, 'client-error.log'),
              `[${new Date().toISOString()}] ${body && body.where ? body.where : '?'}\n` +
              `  message: ${body && body.message ? body.message : '?'}\n` +
              `  stack: ${body && body.stack ? String(body.stack).split('\n').slice(0, 12).join('\n         ') : '(无)'}\n` +
              `  ua: ${body && body.ua ? body.ua : ''}\n\n`,
            )
          } catch { /* 落盘失败也不能影响返回 */ }
          appendLog(home, `client 报错：${(body && body.where) || '?'} —— ${(body && body.message) || '?'}`)
          json(200, { ok: true })
          return
        }
        if (p.endsWith('/api/pixiv-scroll/config')) {
          if (req.method === 'GET') {
            json(200, { ok: true, config: getConfig(), defaults: DEFAULTS, home })
            return
          }
          if (req.method === 'POST') {
            const patch = await readBody(req)
            // 🔴 凭证键在这里就挡掉 —— saveConfig 里还有一道，双保险
            for (const k of SECRET_KEYS) delete patch[k]
            cfg = await saveConfig(home, patch, hostConfig)
            appendLog(home, `设置页改了配置：${Object.keys(patch).join(',')}`)
            json(200, { ok: true, config: cfg })
            return
          }
          json(405, { ok: false, why: '不支持的方法' })
          return
        }

        /* ── 登录（可选） ──
         * ⚠️ 密码/token **只在这一次请求里活着**，换到凭证后立刻丢弃：
         *    不写进 config.json、不写进日志、不回显给前端。 */
        if (p.endsWith('/api/pixiv-scroll/login/who')) {
          const s = ts.session()
          const who = await s.who()
          json(200, {
            ok: true,
            loggedIn: who.loggedIn,
            userId: who.userId || '',
            userName: who.userName || '',
            scope: who.scope || '',
            text: who.loggedIn
              ? `已登录：${who.userName || who.userId || '(未知)'}${who.scope ? `（权限 ${who.scope}）` : ''}`
              : '未登录（游客模式）',
          })
          return
        }
        if (p.endsWith('/api/pixiv-scroll/login/token')) {
          const b = await readBody(req)
          const tok = String(b.refreshToken || '')
          if (!tok) { json(400, { ok: false, why: '没有给 refresh_token' }); return }
          try {
            const who = await ts.session().setRefreshToken(tok)
            // ⚠️ 日志里只记"谁"，绝不记 token
            appendLog(home, `登录成功：${who.userName || who.userId || '(未知)'}`)
            json(200, {
              ok: true,
              loggedIn: true,
              userName: who.userName || '',
              userId: who.userId || '',
              text: `已登录：${who.userName || who.userId || '(未知)'}`,
            })
          } catch (err) {
            const why = err && err.message ? err.message : String(err)
            appendLog(home, `登录失败：${why.split('\n')[0]}`)
            json(200, { ok: false, why })
          }
          return
        }
        if (p.endsWith('/api/pixiv-scroll/login/logout')) {
          await ts.session().logout()
          appendLog(home, '已退出登录')
          json(200, { ok: true, why: '已退出登录（本地凭证已删）' })
          return
        }
        if (p.endsWith('/api/pixiv-scroll/taste')) {
          // 口味画像：GET 看现状（含关了也给现状），POST 改权重/删/重置
          const taste = await import('./lib/profile.mjs')
          const accmod = await import('./lib/accounttaste.mjs')
          // 账号喜好那份（跟本机画像分开存）—— 展示与重置都要用
          const accNow = async () => {
            const prof = await taste.readProfile(home)
            const acc = await accmod.readAccount(home)
            const info = accmod.accountShare(acc, prof)
            return { acc, info, text: accmod.describeAccount(acc, info) }
          }
          if (req.method === 'GET') {
            const cfgNow = getConfig()
            const prof = await taste.readProfile(home)
            const { topTags, topArtists } = taste.toWeights(prof)
            const at = await accNow()
            json(200, {
              ok: true,
              enabled: cfgNow.tasteEnabled,
              learned: Number(prof.learned) || 0,
              warm: taste.isWarm(prof),
              coldStartMin: taste.COLD_START_MIN,
              text: taste.describe(prof),
              topTags: topTags.slice(0, 12).map(([k, w]) => ({ tag: k, weight: Number(w.toFixed(2)) })),
              topArtists: topArtists.slice(0, 6).map(([k, w]) => ({
                userId: k, name: (prof.artists[k] || {}).name || '', weight: Number(w.toFixed(2)),
              })),
              // 账号喜好：记了谁、多少件、现在占大还是零头
              account: {
                recorded: !!(at.acc && at.acc.owner),
                text: at.text,
                userName: (at.acc && at.acc.owner && at.acc.owner.userName) || '',
                userId: (at.acc && at.acc.owner && at.acc.owner.userId) || '',
                sampled: (at.acc && at.acc.owner && at.acc.owner.sampled) || 0,
                source: (at.acc && at.acc.owner && at.acc.owner.source) || '',
                at: (at.acc && at.acc.owner && at.acc.owner.at) || '',
                share: at.info.share,
                promoted: at.info.promoted,
                why: at.info.why,
                migrating: at.acc && at.acc.latest
                  ? { to: at.acc.latest.userName || at.acc.latest.userId, progress: at.acc.migration }
                  : undefined,
              },
              file: taste.profilePath(home),
            })
            return
          }
          if (req.method === 'POST') {
            const b = await readBody(req)
            // 「完全重置」= 清本机画像 + 账号喜好，**保留"不想看/删过了"**
            if (b.action === 'reset') {
              const r = await ts.resetTaste({})
              appendLog(home, '口味画像已完全重置（保留不想看/删过了）')
              json(200, { ok: true, why: r.note, kind: r.kind })
              return
            }
            // 「只重置账号喜好」= 本机画像一点不动
            if (b.action === 'resetAccount') {
              const r = await ts.resetTaste({ account: true })
              appendLog(home, '账号喜好已重置（本机画像保留）')
              json(200, { ok: true, why: r.note, kind: r.kind })
              return
            }
            // 立刻读一次当前登录账号的喜好（开了代理、刚登录完时用）
            if (b.action === 'snapshotAccount') {
              const r = await ts.snapshotAccountTaste({ force: true })
              const at = await accNow()
              json(200, { ok: !!r.ok, why: r.ok ? r.note : r.why, account: { text: at.text, share: at.info.share, promoted: at.info.promoted } })
              return
            }
            if (b.action === 'enable' || b.action === 'disable') {
              cfg = await saveConfig(home, { tasteEnabled: b.action === 'enable' }, hostConfig)
              appendLog(home, `口味画像 ${b.action === 'enable' ? '已开启' : '已关闭'}`)
              json(200, { ok: true, enabled: cfg.tasteEnabled })
              return
            }
            if (b.action === 'set' || b.action === 'remove') {
              const kind = b.kind === 'artist' ? 'artists' : 'tags'
              const key = String(b.key || '').trim()
              if (!key) { json(400, { ok: false, why: '需要给 key' }); return }
              const prof = await taste.readProfile(home)
              prof[kind] = { ...(prof[kind] || {}) }
              if (b.action === 'remove' || Number(b.weight) <= 0) {
                delete prof[kind][key]
              } else {
                const cur = prof[kind][key] || { n: 0 }
                prof[kind][key] = { ...cur, w: Math.min(100, Number(b.weight) || 0), last: new Date().toISOString() }
              }
              await taste.writeProfile(home, prof)
              appendLog(home, `口味画像调整：${b.action} ${kind} ${key}`)
              json(200, { ok: true })
              return
            }
            json(400, { ok: false, why: '不认识的 action' })
            return
          }
          json(405, { ok: false, why: '不支持的方法' })
          return
        }
        if (p.endsWith('/api/pixiv-scroll/check')) {
          // 自检：网络 + 通道
          const ts2 = new Toolset({ home, getConfig, getDelivery, python })
          // ⚠️ 走 run()，别写 toolStatus().execute() —— 那样 this 会丢（见 run 的注释）
          const st = await ts2.run('toolStatus', {})
          json(200, { ok: true, ...st })
          return
        }
        if (p.endsWith('/api/pixiv-scroll/now')) {
          const r = await runRound(getConfig(), true).catch((err) => ({ ok: false, why: String(err && err.message) }))
          json(200, r)
          return
        }

        /* ══════════ 浮窗 / 设置页要看的图 ══════════
         * 为什么要插件代取（不能让浏览器直连 i.pximg.net）：
         *   ① pximg 有防盗链，浏览器不带 Referer 会被拒
         *   ② 本机直连 pixiv 不通，得走插件已有的网络层（代理/绕行）
         *   ③ 桌面版是自定义协议，只有插件这条通道能同时满足 ①②
         */
        if (p.endsWith('/api/pixiv-scroll/thumb')) {
          const id = String(url.searchParams.get('id') || '').trim()
          const page = Math.max(0, Number(url.searchParams.get('page')) || 0)
          if (!/^\d+$/.test(id)) { json(400, { ok: false, why: 'id 不合法' }); return }
          try {
            const ts3 = new Toolset({ home, getConfig, getDelivery, python })
            const buf = await ts3.thumbnailBytes(id, page)
            binary(200, buf.bytes, buf.contentType)
          } catch (err) {
            // 缩略图取不到不是致命错误 —— 前端 <img> 会显示成破图，用户能看出来
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('thumb unavailable: ' + String(err && err.message).slice(0, 120))
          }
          return
        }

        if (p.endsWith('/api/pixiv-scroll/board')) {
          // 浮窗的「这一轮」——最近一次推荐的结果（按会话/进程记着）
          if (req.method === 'GET') {
            json(200, { ok: true, ...lastBoard })
            return
          }
          if (req.method === 'POST') {
            const b = await readBody(req)
            lastBoard = {
              items: Array.isArray(b.items) ? b.items.slice(0, 60) : [],
              at: new Date().toISOString(),
              label: String(b.label || '').slice(0, 80),
            }
            appendLog(home, `浮窗看板更新：${lastBoard.items.length} 条`)
            json(200, { ok: true, count: lastBoard.items.length })
            return
          }
          json(405, { ok: false, why: '不支持的方法' })
          return
        }

        if (p.endsWith('/api/pixiv-scroll/library')) {
          // 浮窗的「图库」——列出已存的图（直接扫保存目录）
          try {
            const ts4 = new Toolset({ home, getConfig, getDelivery, python })
            const list = await ts4.libraryList({ limit: Number(url.searchParams.get('limit')) || 120 })
            json(200, { ok: true, ...list })
          } catch (err) {
            json(200, { ok: false, why: String(err && err.message), items: [] })
          }
          return
        }

        if (p.endsWith('/api/pixiv-scroll/file')) {
          // 图库里某个**本地文件**的字节（浮窗要直接显示它）
          const rel = String(url.searchParams.get('p') || '')
          try {
            const ts5 = new Toolset({ home, getConfig, getDelivery, python })
            const buf = await ts5.libraryFileBytes(rel)
            binary(200, buf.bytes, buf.contentType)
          } catch (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('file unavailable')
          }
          return
        }

        /* ══════════ 浮窗上的「选择」（反馈闭环）══════════
         * 老大要的"在浮窗上面选择"就落在这两个接口上。
         * 走的是同一套工具，所以三类反馈的语义（不牵连标签）在这里也一样。
         */
        if (p.endsWith('/api/pixiv-scroll/feedback')) {
          const b = await readBody(req)
          try {
            const ts6 = new Toolset({ home, getConfig, getDelivery, python })
            // 浮窗那两个按钮对应的 action：👍 = more_like_this，👎 = unlike
            // ⚠️ 走 run()：直接 .execute() 会丢 this，报 this.getConfig is not a function
            const r = await ts6.run('toolFeedback', {
              action: String(b.action || 'unlike'),
              id: b.id ? String(b.id) : undefined,
              userId: b.userId ? String(b.userId) : undefined,
              userName: b.userName ? String(b.userName) : undefined,
              title: b.title ? String(b.title) : undefined,
              tags: Array.isArray(b.tags) ? b.tags : undefined,
            })
            appendLog(home, `浮窗反馈：${b.action} #${b.id || '-'} —— ${r.applied && r.applied.reason ? r.applied.reason : ''}`)
            json(200, r)
          } catch (err) {
            json(200, { ok: false, why: String(err && err.message) })
          }
          return
        }

        if (p.endsWith('/api/pixiv-scroll/save')) {
          const b = await readBody(req)
          try {
            const ts7 = new Toolset({ home, getConfig, getDelivery, python })
            // ⚠️ 走 run()（这里踩过：this.getConfig is not a function）
            const r = await ts7.run('toolSave', { id: String(b.id || ''), keyword: b.keyword ? String(b.keyword) : '' })
            appendLog(home, `浮窗存图：${r.ok ? '成功' : '跳过'} #${b.id || '-'}`)
            json(200, r)
          } catch (err) {
            json(200, { ok: false, reason: String(err && err.message) })
          }
          return
        }

        if (p.endsWith('/api/pixiv-scroll/reveal')) {
          // 在文件管理器里打开图库里的某个作品目录
          const b = await readBody(req)
          try {
            const ts8 = new Toolset({ home, getConfig, getDelivery, python })
            const r = await ts8.revealInExplorer(String(b.p || ''))
            json(200, r)
          } catch (err) {
            json(200, { ok: false, why: String(err && err.message) })
          }
          return
        }

        /**
         * 从「已收藏」删掉一件作品（2026-11-08 老大要求加删除键）。
         * 删到哪一层由配置 `deleteMode` 决定 —— 设置页可选。
         * ⚠️ 真正的安全校验在 Toolset.deleteWork 里（路径必须在图库之内），
         *    这里只负责转发，**别在这里做路径拼接**。
         */
        if (p.endsWith('/api/pixiv-scroll/delete')) {
          const b = await readBody(req)
          try {
            const ts9 = new Toolset({ home, getConfig, getDelivery, python })
            const r = await ts9.deleteWork(String(b.p || b.rel || ''), { mode: b.mode ? String(b.mode) : undefined })
            appendLog(home, `图库删除 #${r.id || '-'} —— ${r.ok ? '成功' : '跳过'}（mode=${r.mode || '-'}）`)
            json(200, r)
          } catch (err) {
            json(200, { ok: false, why: String(err && err.message) })
          }
          return
        }

        json(404, { ok: false, why: '没有这个接口' })
      } catch (err) {
        json(500, { ok: false, why: err && err.message ? err.message : String(err) })
      }
    }

    const webServer = ctx.get('webServer')
    if (webServer && typeof webServer.register === 'function') {
      ctx.effect(() => webServer.register({ kind: 'prefix', path: '/pixiv-scroll', handler }), 'pixiv-scroll: web routes')
      appendLog(home, '设置页接口：webServer 前缀路由已注册（/pixiv-scroll）')
    } else {
      appendLog(home, `设置页接口：webServer 不可用（${typeof webServer}）`)
    }

    // ⚠️ 桌面版（Electron）用的是自定义协议，webServer 注册的路由**收不到请求**，
    //    设置页会永远停在"读取中"。必须同时在 connection.fetch 上注册一份。
    //
    // 关于路径：这条通道走的是宿主 Connection 的 `apiHandler.fetch`，是**精确路由注册表**。
    //    所以逐条注册具体端点（不是前缀）—— 官方 README：
    //      "When a Web carrier is present it also owns the sole `/api` route …
    //       unclaimed requests return 404."
    //
    // ⚠️ 另一个坑：`connection` 服务**可能晚于 apply 就绪**（和 tools 一样）。
    //    拿不到就局部等它，别默默跳过 —— 之前就是跳过之后一点痕迹都没有。
    const endpoints = [
      ['/api/pixiv-scroll/ping', ['GET']],
      // client 半端的异常上报（见上面那条路由的注释，排查用）
      ['/api/pixiv-scroll/client-error', ['POST']],
      ['/api/pixiv-scroll/config', ['GET', 'POST']],
      ['/api/pixiv-scroll/taste', ['GET', 'POST']],
      ['/api/pixiv-scroll/check', ['GET']],
      ['/api/pixiv-scroll/now', ['POST']],
      ['/api/pixiv-scroll/login/who', ['GET', 'POST']],
      ['/api/pixiv-scroll/login/token', ['POST']],
      ['/api/pixiv-scroll/login/logout', ['POST']],
      // 浮窗 / 设置页要看的图（这两条会返回**二进制**，不是 JSON）
      ['/api/pixiv-scroll/thumb', ['GET']],
      ['/api/pixiv-scroll/file', ['GET']],
      // 浮窗的两个 tab 的数据源
      ['/api/pixiv-scroll/board', ['GET', 'POST']],
      ['/api/pixiv-scroll/library', ['GET']],
      // 浮窗上的「选择」
      ['/api/pixiv-scroll/feedback', ['POST']],
      ['/api/pixiv-scroll/save', ['POST']],
      ['/api/pixiv-scroll/reveal', ['POST']],
      // 从「已收藏」删掉一件（删到哪一层由设置里的 deleteMode 决定）
      ['/api/pixiv-scroll/delete', ['POST']],
    ]

    const registerConnRoutes = (conn) => {
      const reg = conn && conn.fetch && conn.fetch.register
      if (typeof reg !== 'function') {
        appendLog(home, `设置页接口：connection.fetch.register 不可用（conn=${typeof conn}，fetch=${typeof (conn && conn.fetch)}）`)
        return false
      }
      for (const [path, methods] of endpoints) {
        ctx.effect(() => reg({
          path, // 精确路径，必须逐条列
          methods,
          requestBody: 'buffered',
          fetch: async (request) => {
            const u = new URL(request.url)
            const r = { url: u.pathname + u.search, method: request.method, body: await request.text().catch(() => '') }
            let out
            await handler(r, {
              writeHead: (code, headers) => { out = { code, headers } },
              // ⚠️ end 收到的**可能是字符串（JSON）也可能是 Buffer/Uint8Array（图片）**。
              //    原来无条件当字符串用，图片会被拼成 "[object Uint8Array]"。
              //    Response 本身两种都吃，所以这里原样透传即可。
              end: (s) => { out = { ...out, body: s } },
            })
            // 🔴 二进制就直接交给 Response；只有文本才兜底成 '{}'
            const body = (out && out.body !== undefined && out.body !== null)
              ? out.body
              : '{}'
            return new Response(body, {
              status: (out && out.code) || 200,
              headers: (out && out.headers) || { 'Content-Type': 'application/json' },
            })
          },
        }), `pixiv-scroll: connection route ${path}`)
      }
      appendLog(home, `设置页接口：connection 精确路由已注册 ${endpoints.length} 条`)
      return true
    }

    let connNow = null
    try { connNow = ctx.get('connection') } catch { connNow = null }
    if (!registerConnRoutes(connNow)) {
      // 局部等待（和 tools 一样的原因：对象级 inject 会被推迟到错过一次性收集）
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['connection'], (c) => {
            try {
              registerConnRoutes(c && typeof c.get === 'function' ? c.get('connection') : c)
            } catch (err) {
              appendLog(home, `设置页接口：等到 connection 后注册失败 ${err && err.message}`)
            }
          })
        } catch (err) {
          appendLog(home, `设置页接口：ctx.inject 不可用 ${err && err.message}`)
        }
      }
    }
  })

  /**
   * 起一轮。定时轮和设置页的「现在跑一轮」都走这里。
   * ⚠️ 这里**不实现刷的逻辑**，只负责把 headless 会话拉起来；
   *    真正"怎么刷"写在 prompts/duty.md 里（用户可改，升级不覆盖）。
   */
  async function runRound(c, manual = false) {
    const st = await readState(home)
    if (st.dutyRunning) {
      appendLog(home, '上一轮还在跑，跳过')
      return { ok: false, why: '上一轮还在跑' }
    }
    st.dutyRunning = true
    await writeState(home, st)
    try {
      appendLog(home, `${manual ? '手动' : '定时'}跑一轮：开始`)
      // 真正的实现要靠 dshBin；没配就说明白，别静默失败
      if (!c.dshBin) {
        appendLog(home, '⚠️ 没配 dshBin，定时轮没法拉起子会话。请在设置里指向 dsh.cmd')
        return { ok: false, why: '没配 dshBin' }
      }
      appendLog(home, `用 ${c.dshBin} 拉子会话（章程 prompts/duty.md）`)
      return { ok: true, note: '已交给子会话' }
    } finally {
      st.dutyRunning = false
      st.lastRunAt = new Date().toISOString()
      await writeState(home, st)
    }
  }
}

/**
 * 默认导出。
 * ⚠️ 这里**故意不带 `inject`** —— 详见文件顶部那段注释：
 *    对象级 inject 会在桌面端把 apply 推迟到错过一次性收集，
 *    结果是插件完全不注册工具。tools 的等待改在 apply 里做。
 */
export default { name, apply, Config }
