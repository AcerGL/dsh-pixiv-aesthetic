/**
 * 图片压缩 —— 发 QQ 前把原图缩到能发的尺寸。
 * ============================================================================
 * ⚠️ 为什么走 Python：运行时里**没有 sharp**（只在 app.asar 里，
 *    require 和 fs 都进不去，实测过）。而 Python 侧的 Pillow 是现成的。
 *    所以这一层 shell 出去调 lib/shrink.py。
 *
 * 压缩**失败不该让发图失败** —— 大不了发原图，绝不因为缩图挂了就丢图。
 * ============================================================================
 */
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 缩小一张图。
 * @param {object} o
 * @param {string} o.python       python 可执行文件
 * @param {string} o.src          输入图路径
 * @param {number} [o.longEdge]   长边上限
 * @param {number} [o.quality]    JPEG 质量
 * @param {string} [o.outDir]     输出目录
 * @returns {Promise<{ok,out?,bytes?,width?,height?,why?}>}
 */
export async function runShrink(o) {
  const { python, src } = o
  if (!python || !src) return { ok: false, why: '没给 python 或输入图' }

  const script = join(here, 'shrink.py')
  try {
    await fs.access(script)
  } catch {
    return { ok: false, why: 'shrink.py 不在插件目录里' }
  }

  const outDir = o.outDir || join(tmpdir(), 'pixiv-shrink-' + Date.now())
  await fs.mkdir(outDir, { recursive: true })
  const dst = join(outDir, 'out.jpg')

  return await new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }

    let child
    try {
      child = spawn(python, [script, src, dst, String(o.longEdge || 1600), String(o.quality || 88)], {
        stdio: ['ignore', 'pipe', 'pipe'], // 注意：沙箱里 pipe 可能被拒，下面兜住
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
      if (code !== 0 && !out.trim()) {
        finish({ ok: false, why: `shrink.py 退出码 ${code}${err ? '：' + err.slice(0, 160) : ''}` })
        return
      }
      try {
        const line = out.trim().split('\n').filter(Boolean).pop() || '{}'
        const j = JSON.parse(line)
        finish(j.ok ? { ok: true, ...j } : { ok: false, why: j.error || '缩图失败' })
      } catch (e) {
        finish({ ok: false, why: `读不懂 shrink.py 的输出：${out.slice(0, 120)}` })
      }
    })

    // 兜个超时，别把一轮卡死
    setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish({ ok: false, why: '缩图超时' })
    }, 60_000)
  })
}

/**
 * 取一页图的字节，必要时先缩小。
 * 返回 { bytes, contentType, shrunk, why } —— **永远尽量给字节**，
 * 缩图失败就给原图（why 里说明），不给空。
 * @param {object} o
 * @param {Uint8Array} o.bytes
 * @param {string} o.contentType
 * @param {object} o.cfg         插件配置（控制开关与阈值）
 * @param {string} o.python
 * @param {string} [o.tag]       临时文件名用的标识
 */
export async function maybeShrink(o) {
  const { bytes, contentType, cfg, python } = o
  const orig = { bytes, contentType, shrunk: false }

  if (!cfg || cfg.shrinkEnabled === false) return orig
  if (!bytes || bytes.byteLength <= (cfg.shrinkMaxBytes || 1_800_000)) return orig

  // 写临时文件（shrink.py 要的是路径）
  const dir = join(tmpdir(), 'pixiv-shrink-src-' + Date.now() + '-' + (o.tag || 'x'))
  try {
    await fs.mkdir(dir, { recursive: true })
    const src = join(dir, 'in.bin')
    await fs.writeFile(src, Buffer.from(bytes))
    const r = await runShrink({
      python,
      src,
      longEdge: cfg.shrinkLongEdge || 1600,
      quality: 88,
      outDir: join(dir, 'out'),
    })
    if (r.ok && r.out) {
      const shrunk = new Uint8Array(await fs.readFile(r.out))
      if (shrunk.byteLength > 0 && shrunk.byteLength < bytes.byteLength) {
        return { bytes: shrunk, contentType: 'image/jpeg', shrunk: true }
      }
      return { ...orig, why: '缩完没变小，按原图发' }
    }
    return { ...orig, why: '缩图没成（' + (r.why || '未知') + '），按原图发' }
  } catch (err) {
    return { ...orig, why: `缩图异常（${err && err.message}），按原图发` }
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
