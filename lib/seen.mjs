/**
 * 台账 —— 判重与额度的**唯一真相源**。
 * ============================================================================
 * 为什么是 JSONL 而不是 JSON：
 *   - 追加便宜，崩了也只丢最后一行；全量重写一个几千行的 JSON 会越来越慢
 *   - 出问题能直接 tail 看最后几件，不用解析整个文件
 *   - 一行一件，坏行跳过就好，不会整个台账打不开
 *
 * ⚠️ 额度判定必须以这个文件为准。之前刷B站那边踩过"status 数尝试次数、
 *    看着在涨其实每轮都失败"的坑 —— 所以这里记的是**真正存下来的**，
 *    和"尝试过的"分开。
 * ============================================================================
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export class Ledger {
  constructor(home) {
    this.home = home
    this.file = join(home, 'ledger.jsonl')
    this._ids = null // 懒加载的 id 集合
    this._rows = null
  }

  /** 读全部行（坏行跳过） */
  async rows() {
    if (this._rows) return this._rows
    let text = ''
    try {
      text = await fs.readFile(this.file, 'utf8')
    } catch {
      this._rows = []
      this._ids = new Set()
      return this._rows
    }
    const out = []
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        out.push(JSON.parse(t))
      } catch {
        // 坏行跳过 —— 一行坏了不该让整个台账打不开
      }
    }
    this._rows = out
    this._ids = new Set(out.map((r) => String(r.id)))
    return out
  }

  /** 已经存过的作品 id 集合（判重用） */
  async seenIds() {
    if (!this._ids) await this.rows()
    return this._ids
  }

  async has(id) {
    const s = await this.seenIds()
    return s.has(String(id))
  }

  /** 追加一条 */
  async add(entry) {
    await fs.mkdir(this.home, { recursive: true })
    const row = {
      ts: new Date().toISOString(),
      id: String(entry.id),
      title: entry.title || '',
      artist: entry.artist || '',
      dir: entry.dir || '',
      pages: Number(entry.pages) || 0,
      bytes: Number(entry.bytes) || 0,
      via: entry.via || '',
      keyword: entry.keyword || '',
      source: entry.source || '',
    }
    await fs.appendFile(this.file, JSON.stringify(row) + '\n', 'utf8')
    if (this._ids) this._ids.add(row.id)
    if (this._rows) this._rows.push(row)
    return row
  }

  /** 某天的存量（本地日期） */
  async countOn(day) {
    const d = day || localDay()
    const rs = await this.rows()
    return rs.filter((r) => localDay(new Date(r.ts)) === d).length
  }

  /** 今天已经存了几件 */
  async countToday() {
    return await this.countOn(localDay())
  }

  /** 某天的台账（报告用） */
  async on(day) {
    const d = day || localDay()
    const rs = await this.rows()
    return rs.filter((r) => localDay(new Date(r.ts)) === d)
  }

  /**
   * 今天的额度还剩多少。**以真正存下的为准**。
   *
   * ⚠️ 这个函数原来叫 `quota(left, limit)`，把「还剩多少」和「够不够存 N 件」
   *    两件事塞进一个签名里 —— 调用方极容易传错。实测就踩了：
   *    保存成功后调 `quota(0, limit)` 想报告剩余额度，结果 `left` 被算成 0，
   *    还输出「今天的额度用完了」这种吓人的话（其实还剩 4 件）。
   *    现在拆成两个语义独立的函数，别再合回去。
   *
   * @param {number} limit 每日上限
   * @returns {Promise<{ok:boolean, used:number, limit:number, left:number, why:string}>}
   */
  async remaining(limit) {
    const used = await this.countToday()
    const lim = Number(limit) || 0
    // limit 为 0 表示不限（配置里 perDay=0）—— 这时不设上限
    const left = lim > 0 ? Math.max(0, lim - used) : Infinity
    const capped = Number.isFinite(left) ? left : Number.MAX_SAFE_INTEGER
    return {
      ok: left > 0,
      used,
      limit: lim,
      left: capped,
      unlimited: lim <= 0,
      why: left > 0 ? '' : `今天的额度用完了（${used}/${lim}）`,
    }
  }

  /**
   * 还想再存 `need` 件，够不够？
   * @param {number} need  这次想存几件
   * @param {number} limit 每日上限
   */
  async hasRoomFor(need, limit) {
    const r = await this.remaining(limit)
    const want = Math.max(1, Number(need) || 1)
    const canDo = r.unlimited ? want : Math.min(want, r.left)
    return {
      ...r,
      ok: canDo > 0,
      canDo,
      why: canDo > 0 ? '' : (r.why || '额度不够'),
    }
  }

  /**
   * 把**文件已经不在**的行从台账里摘掉。
   *
   * 🔴 为什么需要（2026-11-07 实测踩到）：
   *    台账是**判重的唯一真相源**，而 `seenIds()` 原来只看 id、
   *    从不看那条记录的目录**还在不在**。于是只要图库文件被删掉
   *    （换保存目录、手动清理、早期测试写进临时目录后被清……），
   *    这个 id 就**永远**算"存过了" —— 用户碰到同一张图再也存不进来，
   *    只看到一句"存过了"，没有任何线索。
   *
   *    实测现场：台账 7 条里有 6 条的 dir 指向早期自检的临时目录
   *    （`Temp\pixiv-e2e2\…`、`workspace\_tmp\…`），早就不存在了。
   *
   * ⚠️ 只删"目录**确实不存在**"的行 —— 断网、网络盘暂时掉线这类不能算，
   *    所以判据是 stat 明确报 ENOENT/ENOTDIR，**别的错一律留着**。
   *
   * @param {object} [o]
   * @param {boolean} [o.dryRun] 只统计不写回
   * @returns {Promise<{checked:number, removed:number, kept:number, removedIds:string[]}>}
   */
  async prune(o = {}) {
    const rows = await this.rows()
    if (!rows.length) return { checked: 0, removed: 0, kept: 0, removedIds: [] }

    const alive = []
    const gone = []
    for (const r of rows) {
      const dir = String(r.dir || '')
      // 没记目录的老行不动它（没依据判断，宁可留着）
      if (!dir) { alive.push(r); continue }
      try {
        await fs.stat(dir)
        alive.push(r)
      } catch (err) {
        if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) gone.push(r)
        else alive.push(r)
      }
    }

    if (gone.length && !o.dryRun) {
      try { await fs.copyFile(this.file, this.file + '.bak-before-prune') } catch { /* 备份失败不阻断 */ }
      const text = alive.map((r) => JSON.stringify(r)).join('\n') + (alive.length ? '\n' : '')
      await fs.writeFile(this.file, text, 'utf8')
      this._rows = alive
      this._ids = new Set(alive.map((r) => String(r.id)))
    }

    return {
      checked: rows.length,
      removed: gone.length,
      kept: alive.length,
      removedIds: gone.map((r) => String(r.id)),
    }
  }
}

/** 本地日期 YYYY-MM-DD */
export function localDay(d) {
  const t = d instanceof Date ? d : new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
}
