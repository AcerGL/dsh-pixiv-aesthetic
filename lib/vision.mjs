/**
 * 视觉特征 —— Node 侧调度 lib/vision.py。
 * ============================================================================
 * 跟 shrink.mjs 同一个套路（shell 出去调 Python/Pillow），但立场不同：
 *
 *   shrink 是「发图前的加工」，挂了就发原图；
 *   这里是「给候选补一层画面信息」，挂了就**没有这一层** ——
 *   而"没有这一层"必须被**如实标注**，不能假装读过图。
 *
 * 🔴 本文件最重要的一条纪律（规格第四节 + 第六节）：
 *   视觉分析**失败/没做**时，返回的 visual 必须是 null，
 *   绝不能退回"用标签猜画面"。上层 explain() 靠 visual 是否为 null
 *   来决定说"读过图"还是"没读图" —— 这里撒谎，上面就跟着撒谎。
 * ============================================================================
 */
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 一次能分析几张（太多会拖长一轮；调用方自己分批） */
export const MAX_BATCH = 12

/**
 * 对一批本地图片文件跑视觉特征。
 *
 * @param {object} o
 * @param {string} o.python     python 可执行文件
 * @param {string[]} o.paths    本地图片路径
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{ok:boolean, byPath:Map<string,object>, why?:string, ms?:number}>}
 *   ⚠️ ok=false 表示**整批都没成**（比如 python 起不来），此时 byPath 为空，
 *      调用方必须据此走"没读图"那条路。
 */
export async function analyzeImages(o = {}) {
  const { python } = o
  const paths = (Array.isArray(o.paths) ? o.paths : []).filter(Boolean)
  if (!python) return { ok: false, byPath: new Map(), why: '没给 python 路径' }
  if (!paths.length) return { ok: false, byPath: new Map(), why: '没有要分析的图' }

  const script = join(here, 'vision.py')
  try {
    await fs.access(script)
  } catch {
    return { ok: false, byPath: new Map(), why: 'vision.py 不在插件目录里' }
  }

  const batch = paths.slice(0, MAX_BATCH)
  const started = Date.now()

  const raw = await new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }

    let child
    try {
      child = spawn(python, [script, ...batch], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      finish({ ok: false, why: `拉不起 python：${err && err.message}` })
      return
    }

    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => finish({ ok: false, why: `python 跑不起来：${e && e.message}` }))
    child.on('close', (code) => {
      if (!out.trim()) {
        finish({ ok: false, why: `vision.py 没输出（退出码 ${code}）${err ? '：' + err.slice(0, 200) : ''}` })
        return
      }
      try {
        const line = out.trim().split('\n').filter(Boolean).pop()
        finish(JSON.parse(line))
      } catch {
        finish({ ok: false, why: `读不懂 vision.py 的输出：${out.slice(0, 160)}` })
      }
    })

    setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish({ ok: false, why: '视觉分析超时' })
    }, Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 90_000)
  })

  if (!raw || raw.ok !== true) {
    return { ok: false, byPath: new Map(), why: (raw && raw.error) || (raw && raw.why) || '视觉分析失败' }
  }

  const byPath = new Map()
  for (const it of raw.items || []) {
    if (it && it.path && !it.error) byPath.set(String(it.path), it)
  }

  return {
    ok: byPath.size > 0,
    byPath,
    why: byPath.size ? undefined : '这一批一张都没分析成',
    ms: Date.now() - started,
    partial: (raw.items || []).some((x) => x && x.error),
  }
}

/**
 * 把一坨视觉特征压成**人能读的一句话**。
 *
 * ⚠️ 措辞纪律：这里说的每个词都必须是**量出来的**。
 *    可以量化成"偏暖/低饱和/画面很满"，因为背后有数字；
 *    不许写"很有氛围感""构图精妙"—— 那是审美判断，我们没有测它。
 *
 * @param {object} v  analyzeImages 给的单条特征
 * @returns {string}
 */
export function describeVisual(v) {
  if (!v) return ''
  const bits = []

  const l = { dark: '偏暗', dim: '略暗', mid: '中间调', bright: '明亮', 'very-bright': '很亮' }[v.lightness]
  if (l) bits.push(l)

  const t = { flat: '对比平', soft: '对比柔', normal: '对比适中', strong: '对比强', punchy: '对比很冲' }[v.tonality]
  if (t) bits.push(t)

  const s = { muted: '低饱和', subtle: '淡彩', moderate: '中等饱和', rich: '高饱和', vivid: '很艳' }[v.saturationBand]
  if (s) bits.push(s)

  const w = {
    cool: '冷色', 'slightly-cool': '偏冷', neutral: '色温中性',
    'slightly-warm': '偏暖', warm: '暖色',
  }[v.temperature]
  // 色温在暗图上不可信（见 vision.py 的门控），低置信度就不报
  if (w && (v.warmthConfidence === undefined || v.warmthConfidence >= 0.5)) bits.push(w)

  if (v.palette === 'colorful') bits.push('色彩丰富')
  else if (v.palette === 'near-monochrome') bits.push('接近单色')

  if (typeof v.edgeDensity === 'number') {
    if (v.edgeDensity >= 0.55) bits.push('画面很满')
    else if (v.edgeDensity <= 0.12) bits.push('画面简洁')
  }

  if (v.composition && typeof v.composition.ruleOfThirds === 'number' && v.composition.ruleOfThirds >= 0.45) {
    bits.push('主体压在三分点附近')
  }
  if (v.orientation === 'portrait') bits.push('竖图')
  else if (v.orientation === 'landscape') bits.push('横图')
  else if (v.orientation === 'square') bits.push('方图')

  return bits.join(' · ')
}
