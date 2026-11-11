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
    /**
     * 额度计数（**只增不减**，跟可删的台账行分开存）。
     *
     * 🔴 为什么必须分开（2026-11-09 实测抓到）：
     *   额度原来靠 `countToday()` 数台账行，而**删图会把行删掉**
     *   （`removeById`）⇒ 删一张额度就回涨一张。
     *   当天实际发生：存 5 张 → 删 1 张 → 又存 2 张 = **7 张**，
     *   上限 5 被"存了删、删了存"整个绕开（老大拍的板：删了不退）。
     *   闸门拦的是「今天下了多少次」这件事本身，删图改变不了已经下过的事实。
     *   所以：额度看这个文件，判重/图库清单仍旧看 ledger.jsonl。
     */
    this.quotaFile = join(home, 'quota.jsonl')
    this._ids = null // 懒加载的 id 集合
    this._rows = null
    this._quotaRows = null
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
    /**
     * 额度计数单独追加一行 —— **删图不会碰这个文件**，所以"删了不退"。
     * ⚠️ 写失败不该让「已存下」变成失败：图已经在图库了，额度计数漏一笔
     *    最多是多存一张，比报错强（而且台账行仍然在，判重照常）。
     *
     * 🔴 但 `byUser`（**使用者自己在浮窗点存**）**不写这一行**（2026-11-11 老大要求）：
     *    额度是给"替我自动刷"上的闸，不是替我做主不让我存图。
     *    ⇒ 额度只管 agent 存的：既不拦他，也不占他的额度。
     */
    if (entry.byUser !== true) {
      try {
        await fs.appendFile(this.quotaFile, JSON.stringify({ ts: row.ts, id: row.id }) + '\n', 'utf8')
        if (this._quotaRows) this._quotaRows.push({ ts: row.ts, id: row.id })
      } catch { /* 不阻断 */ }
    }
    if (this._ids) this._ids.add(row.id)
    if (this._rows) this._rows.push(row)
    return row
  }

  /** 额度计数行（坏行跳过） */
  async quotaRows() {
    if (this._quotaRows) return this._quotaRows
    let text = ''
    try {
      text = await fs.readFile(this.quotaFile, 'utf8')
    } catch {
      /**
       * 还没这个文件（升级上来的老家目录）⇒ 拿台账现有的行**建一次**，
       * 之后它就独立了。不回填的话今天已存的会被算成 0，等于白送额度。
       */
      const rows = await this.rows()
      const seeded = rows.map((r) => ({ ts: r.ts, id: String(r.id) }))
      this._quotaRows = seeded
      try {
        await fs.mkdir(this.home, { recursive: true })
        await fs.writeFile(this.quotaFile, seeded.map((r) => JSON.stringify(r)).join('\n') + (seeded.length ? '\n' : ''), 'utf8')
      } catch { /* 建不了就先用内存里的，下次再说 */ }
      return this._quotaRows
    }
    const out = []
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try { out.push(JSON.parse(t)) } catch { /* 坏行跳过 */ }
    }
    this._quotaRows = out
    return out
  }

  /** 某天存了几件（**额度口径**：只增不减，删图不退） */
  async usedOn(day) {
    const d = day || localDay()
    const rs = await this.quotaRows()
    return rs.filter((r) => localDay(new Date(r.ts)) === d).length
  }

  /** 某天的存量（本地日期） */
  async countOn(day) {
    const d = day || localDay()
    const rs = await this.rows()
    return rs.filter((r) => localDay(new Date(r.ts)) === d).length
  }

  /**
   * 今天已经存了几件 —— **额度用这个**（删了不退）。
   * ⚠️ 别改回 `countOn()`：那是"台账里现存几条"，删图会让它变小。
   */
  async countToday() {
    return await this.usedOn(localDay())
  }

  /** 台账里今天还剩几件（**图库清单口径**，删图会减少 —— 报告/展示用） */
  async storedToday() {
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
      // 说清"删了不退"——不然用户删完图发现额度没回来会以为坏了
      why: left > 0 ? '' : `今天的额度用完了（已存 ${used} / 上限 ${lim}；删掉今天的图不会退额度）`,
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
   * 按 id 删掉台账里的行（从「已收藏」删图时用）。
   *
   * ⚠️ 跟 `prune()` 分工不同，别混：
   *    · `prune()` = 自动对账，只清"**文件已经不在了**"的行；
   *    · `removeById()` = 用户**明确要删**这一件，不管文件在不在。
   *
   * 删之前备份，删完刷新缓存（不然同一个进程里 `seenIds()` 还是旧的）。
   *
   * @param {string} id
   * @returns {Promise<{removed:number}>}
   */
  async removeById(id) {
    const want = String(id || '').trim()
    if (!want) return { removed: 0 }
    const rows = await this.rows()
    const keep = rows.filter((r) => String(r.id) !== want)
    const removed = rows.length - keep.length
    if (!removed) return { removed: 0 }

    try { await fs.copyFile(this.file, this.file + '.bak-before-remove') } catch { /* 备份失败不阻断 */ }
    const text = keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : '')
    await fs.writeFile(this.file, text, 'utf8')
    this._rows = keep
    this._ids = new Set(keep.map((r) => String(r.id)))
    return { removed }
  }

  /**
   * 🔴 标记"用户**明确删掉**了这一件" —— 行留着，只打一个记号。
   *
   * 为什么不能直接删行（2026-11-10 老大要的"删了别再被找到"）：
   *   删了行，判重就认不出它 ⇒ 下一轮它又被推回来（老大碰到的就是这个）。
   *   留行 + 打标记：`seenIds()` 依旧拦得住它；而 `prune()` 见到标记会放行 ——
   *   否则"台账有记录但文件不在"正好是删完的状态，prune 一跑（每次存图前都跑）
   *   就把行清了，承诺当天就破。
   *
   * ⚠️ 只打标记、**不删偏好**：留着"你喜欢过它"这件事（要连偏好一起忘，
   *    那是 `forget` 档 + `undoLearn()` 的事，别混）。
   *
   * @param {string} id
   * @param {object} [o]
   * @param {boolean} [o.createIfMissing] 台账里**已经没有这一行**时补一行只带标记的。
   *   为什么要这个（2026-11-10）：旧的 'forget' 档删图会把行整条清掉，
   *   于是"删过的"在台账里查无此人 —— 想补标记就没地方补。
   *   ⚠️ 补出来的行**不写 quota.jsonl**：那只在 `add()`（真存下一件）里写。
   *      额度算的是"今天下过几张"，补历史标记不是下载，绝不能占额度。
   * @returns {Promise<{marked:number, created:boolean}>}
   */
  async rejectById(id, o = {}) {
    const want = String(id || '').trim()
    if (!want) return { marked: 0, created: false }
    const rows = await this.rows()
    const at = new Date().toISOString()
    let matched = false
    let marked = 0
    const next = rows.map((r) => {
      if (String(r.id) !== want) return r
      matched = true
      if (r.rejected) return r
      marked++
      return { ...r, rejected: at }
    })
    let created = false
    // ⚠️ 判据是 `matched`（这一行**在不在**），不是 `marked` ——
    //    已经打过标记的行也算"在"，用 marked 判会再插一行重复的（自检抓到过）
    if (!matched && o.createIfMissing) {
      next.push({
        ts: at, id: want, title: '', artist: '', dir: '', pages: 0, bytes: 0,
        via: '', keyword: '', source: '', rejected: at,
      })
      created = true
    }
    if (!matched && !created) return { marked: 0, created: false }

    try { await fs.copyFile(this.file, this.file + '.bak-before-reject') } catch { /* 备份失败不阻断 */ }
    const text = next.map((r) => JSON.stringify(r)).join('\n') + (next.length ? '\n' : '')
    await fs.writeFile(this.file, text, 'utf8')
    // 缓存要跟着刷，不然同一进程里 seenIds()/rejectedIds() 还是旧的
    this._rows = next
    this._ids = new Set(next.map((r) => String(r.id)))
    return { marked, created }
  }

  /** 被用户明确删掉的那些 id（用来把候选剔除原因说准，而不是笼统说"存过了"） */
  async rejectedIds() {
    const rs = await this.rows()
    return new Set(rs.filter((r) => r.rejected).map((r) => String(r.id)))
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
      /**
       * ⚠️ 用户**明确删掉**的行（打过 rejected 标记）永远留着 —— 见 `rejectById()`。
       *    那种行的目录本来就该不在，prune 要是把它当死行清了，
       *    "删了不再推回来"就成了空话。
       */
      if (r.rejected) { alive.push(r); continue }
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
