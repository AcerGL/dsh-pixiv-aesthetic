/**
 * 命名与落盘 —— 把作品存到磁盘上。
 * ============================================================================
 * 规矩（都是踩出来的）：
 *   1. **按 Windows 规则清洗文件名**：`< > : " / \ | ? *` → `_`，
 *      去掉结尾的点和空格（Windows 不允许），`CON/NUL/COM1…` 这些保留名加前缀，
 *      超长要截断但**保留 _ID**（ID 是回查的唯一钥匙）。
 *   2. **原子落盘**：先写 .tmp 再 rename。写到一半断电不会留半个文件。
 *   3. **同名同 ID 合并**：补缺的页、更新 updatedAt，不重复占额度。
 *   4. metadata 里带 sha256 —— 以后要校验或去重都靠它。
 * ============================================================================
 */
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, extname } from 'node:path'

/** Windows 保留设备名 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 单段文件名的最大长度（留余量给后缀和 _ID） */
const MAX_SEG = 60

/**
 * 清洗一段路径名（目录名或文件名，不含扩展名）。
 * @param {string} name
 * @param {object} [o]
 * @param {number} [o.max] 最大长度
 */
export function sanitize(name, o = {}) {
  const max = Number(o.max) || MAX_SEG
  let s = String(name == null ? '' : name)

  // 控制字符先干掉
  s = s.replace(/[\u0000-\u001f\u007f]/g, '')
  // Windows 非法字符
  s = s.replace(/[<>:"/\\|?*]/g, '_')
  // 折叠空白
  s = s.replace(/\s+/g, ' ').trim()
  // 结尾的点和空格（Windows 不允许，且会引起各种怪问题）
  s = s.replace(/[. ]+$/g, '')

  if (RESERVED.test(s)) s = '_' + s
  if (!s) s = 'untitled'

  if (s.length > max) {
    // 截断，但别把 UTF-8 字符切一半
    let cut = s.slice(0, max)
    // 避免留下半个代理对
    const last = cut.charCodeAt(cut.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
    s = cut.trim() + '…'
  }
  return s
}

/** 从 content-type 或 url 猜扩展名 */
export function extFor(contentType, url) {
  const ct = String(contentType || '').toLowerCase()
  if (ct.includes('png')) return '.png'
  if (ct.includes('webp')) return '.webp'
  if (ct.includes('gif')) return '.gif'
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg'
  const m = /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.exec(String(url || ''))
  if (m) return '.' + (m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase())
  return '.jpg'
}

/**
 * 按模板算出这件作品该落在哪。
 * 模板里可用的占位：{artist} {title} {id} {kind}
 * @returns {string} 目录绝对路径
 */
export function dirFor(root, item, o = {}) {
  const tpl = String(o.dirTemplate || '{artist}/{title}_{id}')
  const artist = sanitize(item.userName || item.userId || 'unknown', { max: 40 })
  const title = sanitize(item.title || ('illust_' + item.id), { max: 50 })
  const kind = sanitize(o.kind || '插画', { max: 12 })
  const id = String(item.id || '')

  let rel = tpl
    .replace(/\{artist\}/g, artist)
    .replace(/\{title\}/g, title)
    .replace(/\{id\}/g, id)
    .replace(/\{kind\}/g, kind)

  // 模板必须含 {id}，否则不同作品会撞在一起 —— 强制补上
  if (!tpl.includes('{id}')) rel = join(rel, id)

  // ⚠️ 防目录穿越：**按段**检查，别用正则replace（那只能清掉字面的 "..\"，
  //    拦不住模板作者写的 "a/../../b"，也容易把正常名字里的点误伤）。
  const segs = rel.split(/[/\\]+/).filter((s) => s && s !== '.')
  const safe = []
  for (const s of segs) {
    if (s === '..') continue // 整段丢弃 —— 不许往上一层走
    safe.push(s)
  }
  if (!safe.length) safe.push(id)
  return join(root, ...safe)
}

/** 原子写：先 .tmp 再 rename */
export async function writeAtomic(path, data) {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, path)
}

/** 原子写 JSON */
export async function writeJson(path, obj) {
  await writeAtomic(path, JSON.stringify(obj, null, 2))
}

export function sha256(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

/**
 * 存一件作品的所有页。
 * @param {object} o
 * @param {string} o.root        保存根目录
 * @param {object} o.item        作品元数据（来自 pxclient）
 * @param {Array<{page:number,bytes:Uint8Array,contentType:string,via:string}>} o.images
 * @param {object} [o.opts]      dirTemplate / kind / keyword
 * @returns {Promise<object>} 落盘结果摘要
 */
export async function saveWork(o) {
  const { root, item, images } = o
  const opts = o.opts || {}
  if (!root) throw new Error('saveWork: 没有保存根目录')
  if (!item || !item.id) throw new Error('saveWork: 作品没有 id')
  if (!Array.isArray(images) || !images.length) throw new Error('saveWork: 没有可存的图')

  const dir = dirFor(root, item, opts)
  await fs.mkdir(dir, { recursive: true })

  // 已有文件（用于合并：只补缺的页）
  const existing = new Set(await fs.readdir(dir).catch(() => []))

  const saved = []
  const skipped = []
  const files = []

  // 按页号排序，保证 001 002 顺序稳定
  const sorted = [...images].sort((a, b) => (a.page || 0) - (b.page || 0))
  const total = sorted.length
  const width = Math.max(3, String(total).length)

  for (const img of sorted) {
    const pageNo = Number(img.page) || 0
    const idx = String(pageNo + 1).padStart(width, '0')
    const ext = extFor(img.contentType, img.url)
    const name = `${idx}${ext}`

    if (existing.has(name)) {
      skipped.push(name)
      continue
    }
    const full = join(dir, name)
    await writeAtomic(full, Buffer.from(img.bytes))
    saved.push(name)
    files.push({
      name,
      page: pageNo,
      bytes: img.bytes.byteLength,
      sha256: sha256(img.bytes),
      via: img.via || '',
      contentType: img.contentType || '',
    })
  }

  // 已经存在的页也要记进 metadata（重新存档时不丢信息）
  for (const name of existing) {
    if (name.endsWith('.json') || name.endsWith('.tmp')) continue
    if (files.some((f) => f.name === name)) continue
    files.push({ name, preexisting: true })
  }
  files.sort((a, b) => String(a.name).localeCompare(String(b.name)))

  const meta = {
    id: String(item.id),
    title: item.title || '',
    artist: { id: item.userId || '', name: item.userName || '' },
    url: item.url || `https://www.pixiv.net/artworks/${item.id}`,
    tags: item.tags || [],
    pageCount: Number(item.pageCount) || total,
    width: item.width || 0,
    height: item.height || 0,
    xRestrict: item.xRestrict || 0,
    aiType: item.aiType || 0,
    createDate: item.createDate || '',
    source: item.source || '',
    keyword: opts.keyword || '',
    savedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    files,
    // 只供个人收藏，不二次分发
    licenseNote: '原作版权归画师所有；本文件仅供个人收藏，请勿再分发。',
  }

  // 合并时保留原来的 savedAt
  const metaPath = join(dir, `metadata.${sanitize(opts.keyword || 'default', { max: 24 })}.json`)
  try {
    const old = JSON.parse(await fs.readFile(metaPath, 'utf8'))
    if (old && old.savedAt) meta.savedAt = old.savedAt
  } catch { /* 没有旧的就算了 */ }

  await writeJson(metaPath, meta)

  return {
    dir,
    metaPath,
    saved,
    skipped,
    fileCount: files.length,
    bytes: files.reduce((n, f) => n + (f.bytes || 0), 0),
    merged: skipped.length > 0,
  }
}
