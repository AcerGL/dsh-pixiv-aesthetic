/**
 * 配置 —— 默认值、钳制、双层读写。
 * ============================================================================
 * ⚠️ 踩过的坑（刷B站那边翻过车，这里直接绕开）：
 *   profile 的 cordis.patch.yml 里 `- id: xxx` entry 的 config 段**不进插件 user 层**，
 *   宿主那边始终是 schema 默认值。所以**真值必须放在自己的 config.json**，
 *   这里 loadCfg 末尾以文件为准。
 * ============================================================================
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export const DEFAULTS = {
  enabled: true,

  /* ── 网络 ── */
  proxyUrl: '',           // 空 = 直连；本机常见 http://127.0.0.1:7897
  /**
   * **外部源** —— 一个能上 pixiv 的 HTTP 端点，兼容 pixiv 官方接口形态。
   * 空 = 不用。填了就走它（优先级高于直连/代理）。
   * 典型：用户自己的反代、自建 Nginx、能连 pixiv 的客户端。
   */
  externalApi: '',
  mirrorHost: 'pixiv.re', // 图片镜像兜底
  timeoutMs: 25_000,
  probeTimeoutMs: 8_000,

  /* ── 收什么 ── */
  keywords: [],           // 搜索关键词；空 = 只刷排行
  rankModes: ['daily'],   // 排行池塘
  excludeTags: [],
  requireTags: [],
  tagWeights: {},         // { "初音ミク": 10 }
  minBookmarks: 0,
  minLongEdge: 0,
  maxPages: 0,            // 0 = 不限
  maxAgeDays: 7,
  allowR18: false,        // ⚠️ 默认关
  dropAiGenerated: false,

  /* ── 口味画像（可选） ──
   * **默认关**（老大 2026-11-05 定的）。关着时插件行为跟没有这功能一样：
   * 不学、不写 taste.json、不影响排序。
   * 开了之后**全自动**：每存一件就学一件，「存下来」本身就是投票。
   * 要调权重不去设置页 —— 在会话里跟 agent 说，它改 taste.json（明文 JSON）。 */
  tasteEnabled: false,
  /** 反向找图时，最多拿几个高权重标签去搜 */
  tasteKeywords: 3,
  /** 权重门槛：低于这个的标签不拿去搜（防止噪声稀释池子） */
  tasteMinWeight: 2,
  /** 口味对排序的影响强度（1 = 正常；调大就更认口味） */
  tasteScale: 1,

  /* ── 登录（可选） ──
   * ⚠️ 默认关。登录走 **App API + 手贴 refresh_token**，不是网页登录 ——
   *    实测网页 cookie 喂不动 follow/recommended 这些接口（全 404），
   *    只有 App API 的 Bearer 才行。
   *    登录后能多拿到：关注流、个性化推荐、限制级详情。
   *    token 存在 credential.json，**不进配置文件、不进日志、不进 prompt**。 */
  useLogin: false,
  loginSources: [],       // 登录后额外刷哪些池：'follow' | 'recommend'
  followLimit: 30,
  recommendLimit: 30,

  /* ── 存 ── */
  saveRoot: '',           // 空 = <DSH_HOME>/pixiv-scroll/library
  dirTemplate: '{artist}/{title}_{id}',

  /**
   * 从「已收藏」里删掉一张时，删到哪一层（2026-11-08 老大要求"让用户自己选"）。
   *
   *   'forget' —— 删文件 + 清台账 + 撤掉它在口味画像里学到的权重
   *                = **当作从没存过**（默认）
   *   'remove' —— 删文件 + 清台账，**口味留着**
   *                （图没了，但"你喜欢过它"这件事还在影响推荐）
   *   'files'  —— 只删文件，**台账留着**
   *                ⚠️ 这一档会让那张图**永远**显示"存过了"、再也存不回来。
   *                   听着没用，但老大要"让用户自行选择"，就摆上来。
   */
  deleteMode: 'forget',

  /* ── 额度 ── */
  perDay: 6,              // 每天最多存几件
  perRound: 2,            // 每轮最多挑几件
  maxLook: 40,            // 一轮最多看几条候选
  maxPagesPerWork: 8,     // 单件最多存几页（漫画会很多页）

  /* ── 投递 ── */
  channels: ['local'],    // 默认只落盘；想推 QQ 就加 'qq'
  qqPassiveWindowMs: 270_000,
  qqMaxBytes: 10 * 1024 * 1024,

  /* ── 压缩（发 QQ 前） ── */
  shrinkEnabled: true,
  shrinkLongEdge: 1600,
  shrinkMaxBytes: 1_800_000,

  /* ── 定时 ── */
  intervalMin: 0,         // 0 = 不定时
  peakValley: true,       // 只在谷时跑
  noon: true,
  night: true,
}

/** 数值钳制，防止有人写个负数把插件搞崩 */
function clampInt(v, lo, hi, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}

/**
 * 归一化配置：把外部（profile / 设置页 / config.json）来的值收拢成可信的形状。
 * 所有取值都经过这里，别在业务代码里裸读。
 */
export function normalize(raw = {}) {
  const o = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  const arr = (v, fb) => (Array.isArray(v) ? v.map(String).filter(Boolean) : fb)

  return {
    enabled: o.enabled !== false,

    proxyUrl: String(o.proxyUrl || '').trim(),
    // 外部源：规范化成"带协议、末尾不带斜杠"。用户填 `127.0.0.1:8080` 也行。
    externalApi: (() => {
      const s = String(o.externalApi || '').trim()
      if (!s) return ''
      const noSlash = s.replace(/\/+$/, '')
      return /^https?:\/\//i.test(noSlash) ? noSlash : `http://${noSlash}`
    })(),
    mirrorHost: String(o.mirrorHost || DEFAULTS.mirrorHost).trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    timeoutMs: clampInt(o.timeoutMs, 3000, 120_000, DEFAULTS.timeoutMs),
    probeTimeoutMs: clampInt(o.probeTimeoutMs, 1000, 60_000, DEFAULTS.probeTimeoutMs),

    keywords: arr(o.keywords, []),
    rankModes: arr(o.rankModes, DEFAULTS.rankModes).filter((m) => !!m),
    excludeTags: arr(o.excludeTags, []),
    requireTags: arr(o.requireTags, []),
    tagWeights: (o.tagWeights && typeof o.tagWeights === 'object' && !Array.isArray(o.tagWeights)) ? o.tagWeights : {},
    minBookmarks: clampInt(o.minBookmarks, 0, 1_000_000, 0),
    minLongEdge: clampInt(o.minLongEdge, 0, 20_000, 0),
    maxPages: clampInt(o.maxPages, 0, 9999, 0),
    maxAgeDays: clampInt(o.maxAgeDays, 0, 3650, DEFAULTS.maxAgeDays),
    allowR18: o.allowR18 === true,
    dropAiGenerated: o.dropAiGenerated === true,

    tasteEnabled: o.tasteEnabled === true,
    tasteKeywords: clampInt(o.tasteKeywords, 1, 10, DEFAULTS.tasteKeywords),
    tasteMinWeight: (() => {
      const n = Number(o.tasteMinWeight)
      if (!Number.isFinite(n)) return DEFAULTS.tasteMinWeight
      return Math.min(50, Math.max(0.5, n)) // 允许小数（权重是小数）
    })(),
    tasteScale: (() => {
      const n = Number(o.tasteScale)
      if (!Number.isFinite(n)) return DEFAULTS.tasteScale
      return Math.min(5, Math.max(0.1, n))
    })(),

    useLogin: o.useLogin === true,
    loginSources: arr(o.loginSources, []).filter((s) => ['follow', 'recommend'].includes(s)),
    followLimit: clampInt(o.followLimit, 1, 100, DEFAULTS.followLimit),
    recommendLimit: clampInt(o.recommendLimit, 1, 100, DEFAULTS.recommendLimit),

    saveRoot: String(o.saveRoot || '').trim(),
    dirTemplate: String(o.dirTemplate || DEFAULTS.dirTemplate).trim(),

    perDay: clampInt(o.perDay, 0, 999, DEFAULTS.perDay),
    perRound: clampInt(o.perRound, 1, 99, DEFAULTS.perRound),
    maxLook: clampInt(o.maxLook, 1, 500, DEFAULTS.maxLook),
    maxPagesPerWork: clampInt(o.maxPagesPerWork, 1, 200, DEFAULTS.maxPagesPerWork),

    channels: arr(o.channels, DEFAULTS.channels).filter((c) => ['local', 'qq'].includes(c)),
    qqPassiveWindowMs: clampInt(o.qqPassiveWindowMs, 30_000, 600_000, DEFAULTS.qqPassiveWindowMs),
    qqMaxBytes: clampInt(o.qqMaxBytes, 100_000, 50 * 1024 * 1024, DEFAULTS.qqMaxBytes),

    shrinkEnabled: o.shrinkEnabled !== false,
    shrinkLongEdge: clampInt(o.shrinkLongEdge, 200, 8000, DEFAULTS.shrinkLongEdge),
    shrinkMaxBytes: clampInt(o.shrinkMaxBytes, 50_000, 20 * 1024 * 1024, DEFAULTS.shrinkMaxBytes),

    intervalMin: clampInt(o.intervalMin, 0, 24 * 60, 0),
    peakValley: o.peakValley !== false,
    noon: o.noon !== false,
    night: o.night !== false,
  }
}

/** 哪些键以 config.json 为准（profile 改不动的那些） */
const FILE_WINS = [
  'proxyUrl', 'externalApi', 'mirrorHost', 'keywords', 'rankModes', 'excludeTags', 'requireTags', 'tagWeights',
  'minBookmarks', 'minLongEdge', 'maxPages', 'maxAgeDays', 'allowR18', 'dropAiGenerated',
  'tasteEnabled', 'tasteKeywords', 'tasteMinWeight', 'tasteScale',
  'useLogin', 'loginSources', 'followLimit', 'recommendLimit',
  'saveRoot', 'dirTemplate', 'perDay', 'perRound', 'maxLook', 'maxPagesPerWork',
  'channels', 'qqPassiveWindowMs', 'qqMaxBytes', 'shrinkEnabled', 'shrinkLongEdge', 'shrinkMaxBytes',
  'intervalMin', 'peakValley', 'noon', 'night',
]

/**
 * 绝不写进 config.json 的键 —— token 有自己的家（credential.json），
 * 配置文件和日志里都不该出现它。
 */
export const SECRET_KEYS = ['refreshToken', 'accessToken', 'password', 'token']

export function configPath(home) {
  return join(home, 'config.json')
}

export async function readConfig(home) {
  try {
    return JSON.parse(await fs.readFile(configPath(home), 'utf8'))
  } catch {
    return {}
  }
}

export async function writeConfig(home, cfg) {
  await fs.mkdir(home, { recursive: true })
  const tmp = configPath(home) + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  await fs.rename(tmp, configPath(home))
  return cfg
}

/**
 * 合并：宿主给的（来自 profile）打底，**config.json 覆盖它**。
 * 这就是绕开「profile config 不进 user 层」那个坑的地方。
 */
export async function loadConfig(home, hostCfg = {}) {
  const base = normalize(hostCfg)
  const file = await readConfig(home)
  if (!file || !Object.keys(file).length) return base

  const merged = { ...base }
  for (const k of FILE_WINS) {
    if (Object.prototype.hasOwnProperty.call(file, k)) merged[k] = file[k]
  }
  return normalize(merged)
}

/**
 * 只把 FILE_WINS 里的键写回文件（别把宿主的默认值也存进去，否则以后改默认值就不生效了）。
 *
 * 🔴 安全闸：**凭证类键永远不写进配置文件**。token 有自己的家（credential.json）。
 *    这里挡一道，是个兜底 —— 就算某个调用方手滑把 refreshToken 混进来，也写不出去。
 */
export async function saveConfig(home, patch, hostCfg = {}) {
  const current = await readConfig(home)
  const next = { ...current }
  for (const [k, v] of Object.entries(patch || {})) {
    if (SECRET_KEYS.includes(k)) continue // 🔴 凭证不落配置文件
    if (FILE_WINS.includes(k)) next[k] = v
  }
  await writeConfig(home, next)
  return await loadConfig(home, hostCfg)
}
