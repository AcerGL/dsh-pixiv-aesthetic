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
  /**
   * **无代理通道**（2026-11-09 加，详见 lib/hibi.mjs 顶部的实测记录）。
   * 外部源 / 直连 / 代理 全不通时，元数据改走 HibiAPI，图片走镜像 + 固定 IP。
   * ⚠️ 搜索词会发给第三方（HibiAPI 实例）；登录 token **永远不走这里**。
   */
  hibiEnabled: true,
  hibiApi: 'https://hibiapi.getloli.com', // 可换成自建实例
  mirrorIps: [], // 镜像额外的固定 IP（内置池之外的），留空用内置池
  timeoutMs: 25_000,
  /**
   * **取图片**的超时（跟上面那个分开，2026-11-09 加）。
   *
   * 为什么要分开：元数据是几十 KB 的 JSON，25 秒绰绰有余；
   * 而原图是 5~20MB 的字节流，用同一个 25 秒会被**掐在半路**
   * （实测一张 3008×4160 就报「请求超时（25000ms 硬超时）」，换 60 秒就下来了）。
   * 一个预算伺候两种请求，必然一边不够、一边浪费。
   */
  imageTimeoutMs: 120_000,
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
   *   'files'  —— 删文件、**台账记录留着** ⇒ 以后不会再被推回来（**默认**，
   *                2026-11-10 老大改的：删掉的就是不想再看到，别再推回来）
   *   'remove' —— 删文件 + 清台账，**口味留着** ⇒ 以后可能又被推回来
   *   'forget' —— 删文件 + 清台账 + 撤掉它在口味画像里学到的权重
   *                = **当作从没存过** ⇒ 以后可能又被推回来
   *
   * ⚠️ 'files' 光"留着行不删"是不够的：`prune()` 会把"台账有记录但文件不在"
   *    当成死行清掉（它本来是给"换过保存目录/手动清理"兜底的）⇒ 承诺当场破。
   *    所以那一档要 `rejectById()` **给行打标记**，prune 见到标记就让行留着。
   */
  deleteMode: 'files',

  /**
   * **过度区**（2026-11-09 老大要的）。
   *
   * 开着（默认）：`pixiv_pick` 预览时把**原图**也存到 `staging/`，
   *   点「存」就是**搬一下**，不回 pixiv 重下。
   *   ⇒ 只要预览看到了，点存就**必成功**（网络抽风也不怕）。
   *   ⇒ 代价是占地方；所以按"轮"清理：下一轮开始时清上一轮。
   *
   * 关掉：退回老行为 —— 预览只留缩图，点存时再回 pixiv 下原图。
   */
  stagingEnabled: true,

  /* ── 额度 ── */
  perDay: 6,              // 每天最多存几件
  perRound: 5,            // 一次 pixiv_pick 最多挑几件（见 toolPick 里的说明）
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
 * 超时专用：**0（或负数）当"没设"处理，回落到默认值**。
 *
 * 🔴 跟 clampInt 的差别（2026-11-09 修）：
 *   `clampInt(0, 10000, 600000, 120000)` 会把 0 夹到**下限 10000**，
 *   而不是回落到默认的 120000。对"秒数"这种字段 0 显然是想说"没设"，
 *   结果拿到一个**比默认小得多**的值 —— 手改 config.json 写个 0，
 *   大图就又被掐了，而且看不出为什么。
 *
 * ⚠️ 老的 `timeoutMs` / `probeTimeoutMs` 也有这毛病（给 0 会得到 3000/1000）。
 *    这里只用于新字段；老字段**不动**（改行为可能影响既有配置，
 *    而且它们的下限本来就够用）。要一并改的话单独说。
 */
function clampTimeout(v, lo, hi, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return dflt
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
    hibiEnabled: o.hibiEnabled !== false,
    hibiApi: (() => {
      const s = String(o.hibiApi || '').trim().replace(/\/+$/, '')
        // 用户顺手把 /api/pixiv 也粘进来了 ⇒ 去掉，代码里会自己拼
        .replace(/\/api\/pixiv$/i, '')
      if (!s) return DEFAULTS.hibiApi
      return /^https?:\/\//i.test(s) ? s : `https://${s}`
    })(),
    // 只收 IPv4 字面量 —— 写域名进来会被当主机名去解析，正好绕回污染的 DNS
    mirrorIps: arr(o.mirrorIps, []).map((s) => String(s).trim())
      .filter((s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s)),
    timeoutMs: clampInt(o.timeoutMs, 3000, 120_000, DEFAULTS.timeoutMs),
    // 取图超时：下限给高一点（10 秒以下取图毫无意义），上限 10 分钟
    // ⚠️ 用 clampTimeout：给 0 / 负数当"没设"，回落默认 120s，
    //    而不是被夹到下限（那会得到一个比默认小得多的值）
    //    （定义位置见下面「存」那一组 —— 放一起好找）
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

    /**
     * 🔴 这两个**必须列在这儿**，否则设置页改了存不进去（2026-11-09 实测踩到）。
     *
     * `normalize()` 是**白名单**式的：只认它显式列出的键，其余全丢。
     * 我当初只在 DEFAULTS 里加了 `deleteMode` / `stagingEnabled`，
     * 忘了加到这儿 ⇒ 两个设置**都存不下来**：
     *   · 选「删除方式」→ 界面看着变了，落盘时被丢掉，下次还是默认值；
     *   · 关「过度区」→ `o.stagingEnabled` 被丢掉 ⇒ 变 undefined
     *     ⇒ 代码里 `!== false` 恒为 true ⇒ **永远关不掉**。
     *
     * 判据就是"加新配置项时要动几个地方"，这也是为什么自检里要有一条
     * "DEFAULTS 里的键都能被 normalize 保留"。
     */
    deleteMode: ['forget', 'remove', 'files'].includes(o.deleteMode) ? o.deleteMode : DEFAULTS.deleteMode,
    stagingEnabled: o.stagingEnabled !== false,
    imageTimeoutMs: clampTimeout(o.imageTimeoutMs, 10_000, 600_000, DEFAULTS.imageTimeoutMs),

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
  // ⚠️ 这两条也别忘了（同 normalize 那条注释里说的坑）
  'deleteMode', 'stagingEnabled',
  // 超时类
  'timeoutMs', 'imageTimeoutMs', 'probeTimeoutMs',
  // 无代理通道
  'hibiEnabled', 'hibiApi', 'mirrorIps',
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
