/**
 * 投递通道 —— 把「图送到用户手里」抽象成可插拔的接口。
 * ============================================================================
 * 为什么要有这一层（做开源的关键）：
 *   本机的走法是 QQ 机器人（appId/appSecret 是号主自己的），**别人没有**。
 *   如果插件写死 QQ，那它就只对一个人有用。
 *   所以：**通道是接口，QQ 只是其中一个适配器**；默认永远有「落盘」这个通道，
 *   任何环境都能跑起来。
 *
 * 一个通道要实现：
 *   name    string                    通道标识
 *   label   string                    给人看的名字
 *   ready() Promise<{ok,why}>         现在能不能用（没有就如实说为什么）
 *   send({files, text}) Promise<{ok, results[], why}>   发出去
 *
 * files: [{ path, name, bytes, contentType }]
 * ============================================================================
 */
import { promises as fs } from 'node:fs'
import { basename } from 'node:path'

/* ─────────────────── 落盘通道（永远可用） ─────────────────── */

/**
 * 什么也不"发"，只确认文件确实在磁盘上、路径可用。
 * 这是默认通道，也是所有环境的兜底 —— 它永远不会因为缺配置而失败。
 */
export class LocalFolderChannel {
  constructor(opts = {}) {
    this.name = 'local'
    this.label = '存到本地文件夹'
    this.home = opts.home || ''
  }

  async ready() {
    if (!this.home) return { ok: false, why: '没有指定保存目录' }
    try {
      await fs.mkdir(this.home, { recursive: true })
      return { ok: true }
    } catch (err) {
      return { ok: false, why: `保存目录建不出来：${err && err.message ? err.message : err}` }
    }
  }

  async send({ files = [], text = '' }) {
    const results = []
    for (const f of files) {
      try {
        const st = await fs.stat(f.path)
        results.push({ name: f.name, path: f.path, bytes: st.size, ok: true })
      } catch (err) {
        results.push({ name: f.name, ok: false, why: `读不到文件：${f.path}` })
      }
    }
    return {
      ok: results.every((r) => r.ok),
      results,
      text,
      why: results.every((r) => r.ok) ? '' : '有文件没落盘成功',
    }
  }
}

/* ─────────────────── QQ 通道 ─────────────────── */

/**
 * QQ 机器人通道。
 *
 * ⚠️ 两个硬限制（写在这儿，免得以后又踩）：
 *   1. **QQ 机器人默认没有主动消息权限**。不带宽内 msg_id 直接发会被拒
 *      （HTTP 400 / code 40034105）。只能在收到消息 ~5 分钟内的**被动窗口**里回。
 *   2. 所以这个通道依赖"最近收到过一条消息"这个前提。窗口没了就只能退回落盘，
 *      并且**如实告诉用户**，不要假装发出去了。
 *
 * 具体发送交给宿主里的 im 通道（sendImage），这里只管找窗口 + 兜底。
 */
export class QQChannel {
  constructor(opts = {}) {
    this.name = 'qq'
    this.label = '发到 QQ'
    this.bot = opts.bot || null          // 宿主的 qqbot 实例
    this.manager = opts.manager || null  // SessionManager（找 replyTarget）
    this.msgsLog = opts.msgsLog || ''    // ~/.dsh-qqbot/msgs.log
    this.passiveWindowMs = Number(opts.passiveWindowMs) || 270_000
    this.maxBytes = Number(opts.maxBytes) || 10 * 1024 * 1024
  }

  async ready() {
    if (!this.bot) return { ok: false, why: '没有可用的 QQ 机器人实例（宿主里没挂 im-qqbot）' }
    const win = await this.recentWindow()
    if (!win) {
      return {
        ok: false,
        why: '没有可用的被动窗口 —— QQ 机器人只能在收到消息后约 5 分钟内回消息，' +
             '你需要先给机器人发一条消息。图已经存到本地了。',
      }
    }
    return { ok: true, ageMs: win.ageMs }
  }

  /**
   * 找最近一条还在窗口内的消息。
   * msgs.log 一行 = ts|scope|targetId|msgId|正文（由 dsh-qqbot 的本地补丁落盘）。
   */
  async recentWindow() {
    if (!this.msgsLog) return null
    let text = ''
    try {
      text = await fs.readFile(this.msgsLog, 'utf8')
    } catch {
      return null
    }
    const lines = text.split('\n').filter(Boolean)
    // 从后往前找，第一条在窗口内的就用它
    for (let i = lines.length - 1; i >= 0; i--) {
      const parts = lines[i].split('|')
      if (parts.length < 4) continue
      const ts = Number(parts[0])
      if (!Number.isFinite(ts)) continue
      const age = Date.now() - ts
      if (age >= 0 && age <= this.passiveWindowMs) {
        return { ts, ageMs: age, scope: parts[1], targetId: parts[2], msgId: parts[3] }
      }
    }
    return null
  }

  async send({ files = [], text = '' }) {
    const win = await this.recentWindow()
    if (!win) {
      return {
        ok: false,
        results: [],
        why: '被动窗口过期了，QQ 没发出去（图已存本地）',
      }
    }

    const results = []
    for (const f of files) {
      if (f.bytes && f.bytes > this.maxBytes) {
        results.push({
          name: f.name, ok: false,
          why: `图太大（${(f.bytes / 1048576).toFixed(1)}MB > ${(this.maxBytes / 1048576).toFixed(0)}MB）`,
        })
        continue
      }
      try {
        // 优先用 buffer 直接发（SDK 支持，省一次临时文件）
        const source = f.buffer
          ? { buffer: Buffer.from(f.buffer) }
          : { localPath: f.path }
        const res = await this.bot.sendImage(
          { scope: win.scope, targetId: win.targetId, msgId: win.msgId },
          source,
          f.note ? { content: f.note } : undefined,
        )
        results.push({
          name: f.name, ok: true,
          messageId: res && res.message && res.message.id,
        })
      } catch (err) {
        const msg = err && err.message ? err.message : String(err)
        // 权限类错误要说人话 —— 这是最常见的失败
        const isNoPerm = /40034105|主动消息|无权限|no permission/i.test(msg)
        results.push({
          name: f.name, ok: false,
          why: isNoPerm ? 'QQ 拒绝了主动消息（没有权限，需要在窗口内回复）' : msg.slice(0, 160),
        })
      }
    }

    const allOk = results.length > 0 && results.every((r) => r.ok)
    const someOk = results.some((r) => r.ok)
    return {
      ok: allOk,
      partial: !allOk && someOk,
      results,
      text,
      why: allOk ? '' : results.filter((r) => !r.ok).map((r) => r.why).filter(Boolean).join('；'),
    }
  }
}

/* ─────────────────── 通道管理器 ─────────────────── */

/**
 * 按顺序试通道，第一个成功的算数；全失败也不谎报。
 * 默认顺序：用户启用的通道 → 落盘兜底。
 */
export class Delivery {
  constructor(channels = []) {
    this.channels = channels.filter(Boolean)
  }

  get(name) {
    return this.channels.find((c) => c.name === name) || null
  }

  /** 所有通道的就绪状况（设置页「测一下」用） */
  async status() {
    const out = []
    for (const c of this.channels) {
      let r
      try {
        r = await c.ready()
      } catch (err) {
        r = { ok: false, why: (err && err.message) || String(err) }
      }
      out.push({ name: c.name, label: c.label, ok: !!r.ok, why: r.why || '' })
    }
    return out
  }

  /**
   * 投递。按 order 指定的顺序试（默认按 channels 顺序）。
   *
   * ⚠️ `tried` 与 `skipped` 分得很清，别混：
   *    tried   = **真的把文件发出去了**但失败的（比如 QQ 权限被拒）
   *    skipped = 连发都没发（没配置 / 窗口过期 / 没这个通道）
   *    报告时这两类要分开说，否则用户分不清"没配"和"发失败了"。
   * @returns {Promise<{ok, channel, results, why, skipped, tried}>}
   */
  async deliver(files, o = {}) {
    const order = Array.isArray(o.order) && o.order.length
      ? o.order
      : this.channels.map((c) => c.name)
    const tried = []
    const skipped = []
    const sent = []

    for (const name of order) {
      const c = this.get(name)
      if (!c) { skipped.push({ name, why: '没有这个通道' }); continue }

      let rdy
      try {
        rdy = await c.ready()
      } catch (err) {
        rdy = { ok: false, why: (err && err.message) || String(err) }
      }
      if (!rdy.ok) { skipped.push({ name, why: rdy.why }); continue }

      let res
      try {
        res = await c.send({ files, text: o.text || '' })
      } catch (err) {
        res = { ok: false, results: [], why: (err && err.message) || String(err) }
      }
      tried.push({ name, ok: res.ok, why: res.why || '', results: res.results || [] })
      if (res.ok) sent.push({ name, results: res.results || [] })

      // 成功就收工；失败继续试下一个通道
      if (res.ok) {
        return {
          ok: true,
          channel: name,
          results: res.results || [],
          why: '',
          skipped,
          tried,
          alsoSent: sent.length > 1 ? sent.slice(0, -1) : [],
        }
      }
    }

    return {
      ok: false,
      channel: null,
      results: [],
      why: tried.length
        ? tried.map((t) => `${t.name}: ${t.why}`).join('；')
        : (skipped.length
            ? skipped.map((s) => `${s.name}: ${s.why}`).join('；')
            : '没有任何可用通道'),
      skipped,
      tried,
    }
  }
}

/**
 * 多通道投递：**每个通道都试一遍**，只要有一个成功就算成功。
 * 用于「落盘 + QQ 两条腿都要」这类需求 —— 一条腿挂了另一条还在。
 * @returns {Promise<{ok, sent:string[], failed:object[], skipped:object[]}>}
 */
export async function broadcast(delivery, files, o = {}) {
  const order = Array.isArray(o.order) && o.order.length
    ? o.order
    : delivery.channels.map((c) => c.name)
  const sent = []
  const failed = []
  const skipped = []

  for (const name of order) {
    const c = delivery.get(name)
    if (!c) { skipped.push({ name, why: '没有这个通道' }); continue }
    let rdy
    try { rdy = await c.ready() } catch (err) { rdy = { ok: false, why: (err && err.message) || String(err) } }
    if (!rdy.ok) { skipped.push({ name, why: rdy.why }); continue }

    let res
    try { res = await c.send({ files, text: o.text || '' }) }
    catch (err) { res = { ok: false, why: (err && err.message) || String(err) } }

    if (res.ok) sent.push(name)
    else failed.push({ name, why: res.why || '未知原因' })
  }

  return { ok: sent.length > 0, sent, failed, skipped }
}

/** 把落盘结果整理成投递用的 files 形参 */
export function filesFromSaved(saved, images) {
  const out = []
  for (const f of saved.files || []) {
    if (f.preexisting) continue
    const img = (images || []).find((i) => Number(i.page) + 1 === Number(f.page) + 1)
    const p = saved.dir + '\\' + f.name
    out.push({
      path: p,
      name: basename(f.name),
      bytes: f.bytes,
      contentType: f.contentType,
      buffer: img && img.bytes ? img.bytes : undefined,
      note: '',
    })
  }
  return out
}
