/**
 * 过度区（staging）—— 这一轮的候选先落这儿，点「存」才进主图库。
 * ============================================================================
 * 要解决什么（2026-11-09 老大提的）：
 *
 *   现在 `pixiv_pick` 只下一张**缩过的预览图**（长边 1600），
 *   用户点「存」的时候要**回 pixiv 重新下原图**。
 *   如果那一刻网络抽风（或代理掉了），就会出现
 *   「图我明明看得见，点存却说下不来」—— 很难受。
 *
 * 做法：预览时就**顺手把原图也存下来**，点存变成**移动**，不再重新下载。
 *   ⇒ 只要预览看到了，点存就**必成功**（文件已经在本地）。
 *   ⇒ 代价是要占地方，所以叫"过度区"，用完就清。
 *
 * 🔴 三条设计口径（都是跟老大对过的，别改）：
 *
 *   ① **放原图**，不是缩图。
 *      老大定的口径是「保存原图才是目的，缩略图只是这一轮的预览」。
 *      存原图才能让"点存=移动"，也才是他真正要的东西。
 *
 *   ② **按"轮"清理，不掐表**。
 *      原来讨论过"10 分钟后自动删"，否掉了 —— 边看边挑会被删到手，
 *      而且定时删除和目录结构打架。改成**事件驱动**：
 *      下一轮开始时清掉上一轮。简单，也不会"正看着呢文件没了"。
 *
 *   ③ **清理只许动 staging**，绝不许碰主图库。
 *      路径校验跟 deleteWork 一个规格（解析后的绝对路径必须真在
 *      staging 根目录之下）。★ 这条比功能重要：删文件的操作，
 *      项目里手抖过一次，不能再有。
 * ============================================================================
 */
import { promises as fs } from 'node:fs'
import { join, resolve, sep, dirname } from 'node:path'

/** 过度区的根目录 */
export function stagingRoot(home) {
  return join(home, 'staging')
}

/** 一轮一个目录，用日期+轮次标识，方便排序和"清上一轮" */
export function roundDir(home, roundId) {
  return join(stagingRoot(home), sanitizeRound(roundId))
}

/** 轮次 id 只允许这些字符（它会被拼进路径） */
function sanitizeRound(s) {
  return String(s || '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 40) || 'round'
}

/**
 * 生成一个轮次 id（给新一轮用）。
 *
 * 🔴 **必须保证同一秒内连开两轮也不撞**（2026-11-09 实测踩到）：
 *   原来只有"年月日-时分秒"（秒级），我连着调两次 `startRound()`
 *     → 两轮拿到**同一个 id** → "清上一轮"时它被认为是"当前轮"而保留
 *     → **什么都没清掉**，过度区一直涨。
 *   修法：加一个进程内自增序号。同一秒开两轮也各不相同。
 */
let _roundSeq = 0
export function newRoundId(now = Date.now()) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  _roundSeq = (_roundSeq + 1) % 1000
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(_roundSeq).padStart(3, '0')}`
}

/**
 * 🔴 路径安全：把"staging 里的相对路径"解析成绝对路径，并确认它真的在 staging 内。
 *
 * 跟 deleteWork 同一套规格。**任何操作 staging 的函数都必须先过这里。**
 * 拒绝：绝对路径、盘符、UNC、`..` 段。
 */
export function safeStagingPath(home, rel) {
  const root = resolve(stagingRoot(home))
  const raw = String(rel || '').replace(/\\/g, '/')
  if (!raw.trim()) throw new Error('没给路径')
  if (/^[a-zA-Z]:/.test(raw)) throw new Error('路径不合法（不接受绝对路径）')
  if (raw.startsWith('/')) throw new Error('路径不合法（不接受绝对路径）')
  // ⚠️ 按**段**判 `..`，不能全文 includes —— 作品标题里可能有省略号
  //    （`管理人...？` 那次就是这么栽的）
  const segs = raw.split('/').filter((x) => x !== '')
  if (segs.some((x) => x === '..' || x === '.')) throw new Error('路径不合法')
  const full = resolve(root, ...segs)
  if (full !== root && !full.startsWith(root + sep)) throw new Error('路径越界')
  return full
}

/**
 * 把一组页写进过度区。
 *
 * @param {object} o
 * @param {string} o.home
 * @param {string} o.roundId
 * @param {string} o.id        作品 id
 * @param {Array<{page:number, bytes:Uint8Array, contentType:string}>} o.pages
 * @param {object} [o.meta]    标题/画师/页数等（免得存的时候再取一次详情）
 * @returns {Promise<{dir:string, rel:string, files:Array}>}
 */
export async function putWork(o) {
  const dir = join(roundDir(o.home, o.roundId), sanitizeId(o.id))
  await fs.mkdir(dir, { recursive: true })

  const files = []
  for (const p of o.pages || []) {
    const ext = extOf(p.contentType, p.bytes)
    const target = join(dir, String(Number(p.page) + 1).padStart(3, '0') + ext)
    await fs.writeFile(target, Buffer.from(p.bytes))
    files.push({ page: Number(p.page), path: target, bytes: p.bytes.byteLength, contentType: p.contentType })
  }

  if (o.meta) {
    try {
      await fs.writeFile(join(dir, 'meta.json'), JSON.stringify(o.meta, null, 2), 'utf8')
    } catch { /* meta 写不进去不影响图 */ }
  }

  const rel = relFromStaging(o.home, dir)
  return { dir, rel, files }
}

function sanitizeId(id) {
  return String(id || '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 40) || 'unknown'
}

function extOf(contentType, bytes) {
  const ct = String(contentType || '')
  if (/png/i.test(ct)) return '.png'
  if (/webp/i.test(ct)) return '.webp'
  if (/gif/i.test(ct)) return '.gif'
  if (/jpe?g/i.test(ct)) return '.jpg'
  // 没给类型就按字节嗅（跟 toolset 里 sniffExt 一个道理）
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50) return '.png'
  if (b.length >= 12 && b[8] === 0x57 && b[9] === 0x45) return '.webp'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49) return '.gif'
  return '.jpg'
}

/** 相对 staging 根的路径（给上层当键用） */
export function relFromStaging(home, abs) {
  const root = resolve(stagingRoot(home))
  const a = resolve(abs)
  if (a === root) return ''
  if (!a.startsWith(root + sep)) throw new Error('路径越界')
  return a.slice(root.length + sep.length).replace(/\\/g, '/')
}

/**
 * 找过度区里某件作品（**跨轮次找**）。
 *
 * ⚠️ 为什么要跨轮次找：用户可能上一轮的候选还没点完，这一轮又跑了。
 *    按"最新的一轮优先"找，找到就用。
 *
 * @returns {Promise<{dir:string, round:string}|null>}
 */
export async function findWork(home, id) {
  const want = sanitizeId(id)
  const root = stagingRoot(home)
  let rounds = []
  try {
    rounds = await fs.readdir(root, { withFileTypes: true })
  } catch { return null }
  // 轮次目录名带时间戳，倒序 = 新的在前
  const dirs = rounds.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse()
  for (const r of dirs) {
    const d = join(root, r, want)
    try {
      const st = await fs.stat(d)
      if (st.isDirectory()) return { dir: d, round: r }
    } catch { /* 这轮没有，继续往前找 */ }
  }
  return null
}

/**
 * 从过度区**取走**一件（移动语义）—— 存进主图库时用。
 *
 * 返回文件清单，调用方负责搬到目的地；搬完调 `dropWork` 收尾。
 * ⚠️ 这里**不删**：万一上层搬到一半失败，原图还在，能重来。
 */
export async function takeWork(home, id) {
  const hit = await findWork(home, id)
  if (!hit) return null
  const files = []
  let entries = []
  try { entries = await fs.readdir(hit.dir, { withFileTypes: true }) } catch { return null }
  for (const e of entries) {
    if (!e.isFile()) continue
    if (e.name === 'meta.json') continue
    const p = join(hit.dir, e.name)
    let bytes = 0
    try { bytes = (await fs.stat(p)).size } catch { /* ignore */ }
    files.push({ name: e.name, path: p, bytes })
  }
  let meta = null
  try { meta = JSON.parse(await fs.readFile(join(hit.dir, 'meta.json'), 'utf8')) } catch { /* 没 meta 也能用 */ }
  files.sort((a, b) => a.name.localeCompare(b.name))
  return { dir: hit.dir, round: hit.round, files, meta }
}

/** 收掉一件（搬完之后） */
export async function dropWork(home, id) {
  const hit = await findWork(home, id)
  if (!hit) return { removed: false }
  await fs.rm(hit.dir, { recursive: true, force: true })
  // 这一轮空了就把轮次目录也收掉
  try {
    const roundPath = dirname(hit.dir)
    if ((await fs.readdir(roundPath)).length === 0) await fs.rmdir(roundPath)
  } catch { /* 收不掉不算错 */ }
  return { removed: true }
}

/**
 * 清掉**除 keepRounds 之外**的轮次目录（"下一轮开始时清上一轮"）。
 *
 * @param {object} o
 * @param {string} o.home
 * @param {string[]} [o.keep]  要保留的轮次 id
 * @param {boolean} [o.dryRun]
 * @returns {Promise<{removed:string[], kept:string[], bytes:number}>}
 */
export async function cleanRounds(o) {
  const root = resolve(stagingRoot(o.home))
  const keep = new Set((o.keep || []).map(sanitizeRound))
  const out = { removed: [], kept: [], bytes: 0 }
  let entries = []
  try { entries = await fs.readdir(root, { withFileTypes: true }) } catch { return out }

  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (keep.has(e.name)) { out.kept.push(e.name); continue }
    const full = resolve(root, e.name)
    // ★ 安全：只删 staging 底下的目录，绝不越界
    if (!full.startsWith(root + sep)) continue
    if (o.dryRun) { out.removed.push(e.name); continue }
    try {
      out.bytes += await dirSize(full)
      await fs.rm(full, { recursive: true, force: true })
      out.removed.push(e.name)
    } catch { /* 删不掉就留着，下次再说 */ }
  }
  return out
}

async function dirSize(dir) {
  let total = 0
  try {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) total += await dirSize(p)
      else { try { total += (await fs.stat(p)).size } catch { /* ignore */ } }
    }
  } catch { /* ignore */ }
  return total
}

/** 过度区现在占多少、有几轮（给设置页/状态显示用） */
export async function stagingStats(home) {
  const root = stagingRoot(home)
  let entries = []
  try { entries = await fs.readdir(root, { withFileTypes: true }) } catch { return { rounds: 0, works: 0, bytes: 0, path: root } }
  let works = 0
  let bytes = 0
  const rounds = entries.filter((e) => e.isDirectory())
  for (const r of rounds) {
    const rp = join(root, r.name)
    try {
      for (const w of await fs.readdir(rp, { withFileTypes: true })) {
        if (!w.isDirectory()) continue
        works++
        bytes += await dirSize(join(rp, w.name))
      }
    } catch { /* ignore */ }
  }
  return { rounds: rounds.length, works, bytes, path: root }
}
