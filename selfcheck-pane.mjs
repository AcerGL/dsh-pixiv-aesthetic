/**
 * 浮窗（右侧停靠面板）的自检。
 *   node selfcheck-pane.mjs
 *
 * 不联网。验：
 *   · 缩略图 URL 推导（那个双重 replace 的坑）
 *   · 图库列举（depth=0 不当作品的那个坑）
 *   · 路径穿越必须被挡住（**安全**，参数来自 HTTP）
 *   · client bundle 的接线（tab 注册、样式、两个正文）
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = join(tmpdir(), 'px-pane-' + Date.now())
const libRoot = join(home, 'library')
await fs.mkdir(libRoot, { recursive: true })

let pass = 0
const fails = []
const ok = (n, c, extra) => { if (c) pass++; else fails.push(n + (extra ? '  → ' + extra : '')) }
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)

const TS = await import('./lib/toolset.mjs')

/* ─────────── ① 缩略图 URL 推导（双重 replace 的坑） ─────────── */
{
  const { thumbFromOriginal } = TS
  const original = 'https://i.pximg.net/img-original/img/2026/11/06/23/27/27/151759763_p0.png'
  const t = thumbFromOriginal(original)
  eq('原图 → 缩略图',
    t, 'https://i.pximg.net/c/540x540_70/img-master/img/2026/11/06/23/27/27/151759763_p0.png')
  ok('🔴 不含双重前缀（那个坑）', !t.includes('/c/540x540_70/c/540x540_70/'), t)
  // 幂等：已经是缩略图就别再套一层
  eq('再次调用不变（幂等）', thumbFromOriginal(t), t)
  // img-master 形态
  const m = thumbFromOriginal('https://i.pximg.net/img-master/img/2026/11/06/00/00/00/1_p0.jpg')
  ok('img-master 形态也能转', m.includes('/c/540x540_70/img-master/') && !m.includes('/c/540x540_70/c/'), m)
  // 空/异形
  eq('空输入返回空', thumbFromOriginal(''), '')
  eq('非 pixiv 地址原样返回', thumbFromOriginal('https://x.com/a.png'), 'https://x.com/a.png')
}

/* ─────────── ② 图库列举 ─────────── */
{
  // 造一个真实形状：<root>/<画师>/<标题_id>/001.png
  await fs.mkdir(join(libRoot, 'Nitoha', '雲の上_151759763'), { recursive: true })
  await fs.writeFile(join(libRoot, 'Nitoha', '雲の上_151759763', '001.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await fs.writeFile(join(libRoot, 'Nitoha', '雲の上_151759763', '002.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await fs.mkdir(join(libRoot, 'Kuro', '安魂曲_151762557'), { recursive: true })
  await fs.writeFile(join(libRoot, 'Kuro', '安魂曲_151762557', '001.jpg'), Buffer.from([0xff, 0xd8, 0xff]))
  // 🔴 根目录直接躺一张散图 —— 这正是那个 bug 的触发条件
  await fs.writeFile(join(libRoot, 'preview_151759763.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

  const ts = new TS.Toolset({
    home,
    getConfig: () => ({ saveRoot: libRoot, proxyUrl: '', timeoutMs: 1000 }),
    getDelivery: () => null, python: '', log: () => {},
  })
  const lib = await ts.libraryList({ limit: 50 })
  const names = lib.items.map((x) => x.name)
  ok('🔴 根目录有散图时，子目录的作品仍被列出来', names.includes('雲の上_151759763'), JSON.stringify(names))
  ok('第二件也在', names.includes('安魂曲_151762557'), JSON.stringify(names))
  ok('根目录的散图也收进来了', names.includes('preview_151759763.png'), JSON.stringify(names))
  eq('总共 3 项（2 作品 + 1 散图）', lib.count, 3)
  // 作品 id 从目录名解出来
  const w1 = lib.items.find((x) => x.name === '雲の上_151759763')
  eq('从目录名解出作品 id', w1.id, '151759763')
  eq('页数数对了', w1.pages, 2)
  // 散图标记了 loose
  const loose = lib.items.find((x) => x.name === 'preview_151759763.png')
  eq('散图标了 loose', loose.loose, true)
  // 不存在的目录：返回空、不抛
  const ts2 = new TS.Toolset({
    home, getConfig: () => ({ saveRoot: join(home, 'nope'), proxyUrl: '' }),
    getDelivery: () => null, python: '', log: () => {},
  })
  const empty = await ts2.libraryList({})
  eq('目录不存在时返回 0 件（不抛）', empty.count, 0)
}

/* ─────────── ③ 路径穿越（安全，必须挡住） ─────────── */
{
  const ts = new TS.Toolset({
    home,
    getConfig: () => ({ saveRoot: libRoot, proxyUrl: '' }),
    getDelivery: () => null, python: '', log: () => {},
  })
  const evil = [
    '../../../../Windows/System32/drivers/etc/hosts',
    '..\\..\\secret.png',
    '/etc/passwd',
    'a/../../../x.png',
    './../y.png',
    '',
  ]
  for (const e of evil) {
    let blocked = false
    try { await ts.libraryFileBytes(e) } catch { blocked = true }
    ok(`挡住了路径穿越：${JSON.stringify(e)}`, blocked)
  }
  // 非图片后缀也要挡（不然能读任意文本）
  let blockedTxt = false
  try { await ts.libraryFileBytes('a/b.txt') } catch { blockedTxt = true }
  ok('挡住非图片后缀', blockedTxt)
  // 正常路径要能读
  const good = await ts.libraryFileBytes('Nitoha/雲の上_151759763/001.png')
  ok('正常路径读得到', good.bytes.length > 0 && good.contentType === 'image/png', good.contentType)
  // 反斜杠也要能处理（Windows 手输）
  const good2 = await ts.libraryFileBytes('Nitoha\\雲の上_151759763\\001.png')
  ok('反斜杠路径也能读', good2.bytes.length > 0)
  // revealInExplorer 也要挡穿越
  let blockedReveal = false
  try { await ts.revealInExplorer('../../x.png') } catch { blockedReveal = true }
  ok('revealInExplorer 也挡穿越', blockedReveal)

  /* ─────────── 🔴 图库删除（2026-11-08 新增）───────────
   *
   * 老大要求"图库里加个删除键"，删除行为做成设置项（三档）。
   *
   * **安全比功能重要** —— 这是删文件的操作，路径校验必须硬。
   * 项目里清测试数据时手抖过一次（把整个 library 当目标），
   * 所以这里把"能删什么 / 不能删什么"逐条钉住。
   */
  {
    const { Toolset } = await import('./lib/toolset.mjs')
    const { Ledger } = await import('./lib/seen.mjs')
    const { readProfile, writeProfile, learn } = await import('./lib/profile.mjs')
    const { mkdtempSync } = await import('node:fs')
    const os = await import('node:os')
    const pmod = await import('node:path')

    const mk = () => {
      const home = mkdtempSync(pmod.join(os.tmpdir(), 'px-del-sc-'))
      const root = pmod.join(home, 'library')
      return { home, root }
    }

    /* ── 🔴 名字里带「..」的**合法**作品不能被杀（2026-11-08 实际栽在这） ──
     *
     * 现场：老大点删除报「路径不合法」，而报错路径是
     *     Kairasii4\管理人...？_151743550\001.png
     * —— 作品标题里那三个点是**省略号**，被旧的
     *    `raw.includes('..')` 当成路径穿越拒了。
     *
     * ⚠️ 我上一版的测试**完全没覆盖这个**：用的全是
     *    `A/W_151111111` 这种干干净净的 ASCII 名。
     *    教训：**测试数据要带真实世界的脏名字**（省略号、空格、
     *    全角括弧、emoji），否则安全校验会误伤正常输入而无人发现。
     */
    {
      const { home, root } = mk()
      const tricky = [
        ['管理人...？_151743550', '标题带省略号（真实那条）'],
        ['无题_151576867', '中文标题'],
        ['氷雨ぺんちゃ メイド衣装Ver. ＋差分_151798653', '空格+全角+加号'],
        ['a.b_151111111', '普通点'],
        ['..._151222222', '纯省略号开头'],
        ['x ..y_151333333', '段内有空格和点'],
      ]
      for (const [name, why] of tricky) {
        const wd = pmod.join(root, 'ArtistX', name)
        await fs.mkdir(wd, { recursive: true })
        await fs.writeFile(pmod.join(wd, '001.png'), Buffer.alloc(16))
        const tsd = new Toolset({
          home, getConfig: () => ({ deleteMode: 'forget', saveRoot: root }),
          getDelivery: () => ({ channels: [] }), python: 'python',
        })
        let okDel = false
        let err = ''
        try {
          const r = await tsd.deleteWork('ArtistX/' + name)
          okDel = r.ok === true
        } catch (e) { err = e.message }
        ok(`🔴 合法作品能删：${why}`, okDel,
          okDel ? '' : `被拒了（${err}）—— 安全校验误伤了正常名字`)
      }
      await fs.rm(home, { recursive: true, force: true })
    }

    /* ── 🔴 传**文件**路径也要能删（前端万一还传 rel） ── */
    {
      const { home, root } = mk()
      const wd = pmod.join(root, 'A', '管理人...？_151743550')
      await fs.mkdir(wd, { recursive: true })
      await fs.writeFile(pmod.join(wd, '001.png'), Buffer.alloc(16))
      const tsd = new Toolset({
        home, getConfig: () => ({ deleteMode: 'forget', saveRoot: root }),
        getDelivery: () => ({ channels: [] }), python: 'python',
      })
      let r = null
      let err = ''
      try { r = await tsd.deleteWork('A\\管理人...？_151743550\\001.png') } catch (e) { err = e.message }
      ok('🔴 传文件路径会退到作品目录（不报错）',
        r && r.ok === true,
        err ? `报错了：${err}（这正是老大遇到的那条）` : JSON.stringify(r))
      ok('传文件路径时删掉的是整个作品目录',
        !(await fs.stat(wd).then(() => true).catch(() => false)))
      await fs.rm(home, { recursive: true, force: true })
    }

    /* —— ① 路径安全：这些**必须**拒绝 —— */
    {
      const { home, root } = mk()
      await fs.mkdir(pmod.join(root, 'A', 'W_151111111'), { recursive: true })
      await fs.writeFile(pmod.join(root, 'A', 'W_151111111', '001.png'), Buffer.alloc(8))
      const tsd = new Toolset({
        home, getConfig: () => ({ deleteMode: 'forget', saveRoot: root }),
        getDelivery: () => ({ channels: [] }), python: 'python',
      })
      const bads = [
        ['../../etc', '相对穿越'],
        ['..\\..\\Windows', '反斜杠穿越'],
        ['/abs/path', '绝对路径（/ 开头）'],
        ['/', '根斜杠'],
        ['C:/Windows/System32', '盘符（正斜杠）'],
        ['C:\\Windows', '盘符（反斜杠）'],
        ['//server/share', 'UNC'],
        ['..', '纯点点'],
        ['.', '图库根自己'],
        ['', '空'],
      ]
      for (const [bad, why] of bads) {
        let refused = false
        let msg = ''
        try { await tsd.deleteWork(bad) } catch (e) { refused = true; msg = e.message }
        ok(`🔴 删图拒绝越界：${why}`, refused, `${JSON.stringify(bad)} 竟然被放过（msg=${msg}）`)
      }
      // 越界被拒之后，图库必须**原封不动**
      ok('🔴 越界尝试之后图库没被破坏',
        await fs.stat(pmod.join(root, 'A', 'W_151111111', '001.png')).then(() => true).catch(() => false),
        '拒绝归拒绝，别把东西删了')
      await fs.rm(home, { recursive: true, force: true })
    }

    /* —— ② 正常删：文件没了、画师空目录收起、不碰别人 —— */
    {
      const { home, root } = mk()
      const wd = pmod.join(root, 'A', 'W_151111111')
      const keep = pmod.join(root, 'Keep', 'K_152222222')
      await fs.mkdir(wd, { recursive: true })
      await fs.mkdir(keep, { recursive: true })
      await fs.writeFile(pmod.join(wd, '001.png'), Buffer.alloc(1000))
      await fs.writeFile(pmod.join(wd, '002.png'), Buffer.alloc(2000))
      await fs.writeFile(pmod.join(keep, '001.png'), Buffer.alloc(50))
      const cfgd = { deleteMode: 'forget', saveRoot: root }
      const tsd = new Toolset({ home, getConfig: () => cfgd, getDelivery: () => ({ channels: [] }), python: 'python' })
      const r = await tsd.deleteWork('A/W_151111111')
      ok('正常删：ok + 报出删了几个文件',
        r.ok === true && r.removedFiles === 2 && r.removedBytes === 3000,
        JSON.stringify({ ok: r.ok, files: r.removedFiles, bytes: r.removedBytes }))
      ok('正常删：目录真没了',
        !(await fs.stat(wd).then(() => true).catch(() => false)))
      ok('正常删：空掉的画师目录收掉',
        !(await fs.stat(pmod.join(root, 'A')).then(() => true).catch(() => false)))
      ok('🔴 正常删：别的地方**一点没动**',
        await fs.stat(pmod.join(keep, '001.png')).then(() => true).catch(() => false),
        '只该删目标，不能连坐')
      await fs.rm(home, { recursive: true, force: true })
    }

    /* —— ③ 三档行为必须**真的不同** —— */
    {
      const seen = {}
      for (const mode of ['forget', 'remove', 'files']) {
        const { home, root } = mk()
        const id = '15111111' + mode.length
        const wd = pmod.join(root, 'A', 'W_' + id)
        await fs.mkdir(wd, { recursive: true })
        await fs.writeFile(pmod.join(wd, '001.png'), Buffer.alloc(10))
        const cfgd = { deleteMode: mode, saveRoot: root }
        const tsd = new Toolset({ home, getConfig: () => cfgd, getDelivery: () => ({ channels: [] }), python: 'python' })
        await tsd.ledger().add({ id, title: 'W', dir: wd })
        let prof = await readProfile(home)
        prof = learn(prof, { id, title: 'W', userName: 'A', tags: ['tagX'], width: 2000, height: 2000, illustType: 0 })
        await writeProfile(home, prof)

        await tsd.deleteWork('A/W_' + id)
        const led2 = new Ledger(home)
        const ledgerStill = await led2.has(id)
        const rejected = (await led2.rejectedIds()).has(id)
        const after = await readProfile(home)
        seen[mode] = { ledgerStill, rejected, learned: after.learned, tagLeft: !!(after.tags || {}).tagX }
        await fs.rm(home, { recursive: true, force: true })
      }
      ok('🔴 forget：台账清掉 + 画像撤掉',
        seen.forget && seen.forget.ledgerStill === false && seen.forget.learned === 0 && seen.forget.tagLeft === false,
        JSON.stringify(seen.forget))
      ok('🔴 remove：台账清掉，但**画像留着**',
        seen.remove && seen.remove.ledgerStill === false && seen.remove.learned === 1 && seen.remove.tagLeft === true,
        JSON.stringify(seen.remove))
      ok('🔴 files：台账留着 + 打了"明确删掉"的标记（删了不再推回来）',
        seen.files && seen.files.ledgerStill === true && seen.files.rejected === true,
        JSON.stringify(seen.files))
      ok('只有 files 档打标记（另外两档台账都清了，谈不上标记）',
        seen.files.rejected === true && seen.remove.rejected === false && seen.forget.rejected === false,
        JSON.stringify(seen))
      ok('三档行为确实不同（不是同一个效果）',
        seen.forget.learned !== seen.remove.learned || seen.remove.ledgerStill !== seen.files.ledgerStill,
        JSON.stringify(seen))
    }

    /* —— ④ 源码层面：界面接线对 —— */
    // ⚠️ codeOnly0 是在**后面**那段才声明的，这里够不着，所以自己读一份并去注释
    const cliRaw = await fs.readFile(new URL('./client.js', import.meta.url), 'utf8')
    const cli = cliRaw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/[^\n]*/gm, '')

    ok('🔴 已收藏里有删除按钮',
      /🗑/.test(cli))
    ok('🔴 删除要二次确认（不能一点就没）',
      /确认删除/.test(cli) && /armDelete/.test(cli),
      '原图删了要重下，误删代价高')
    ok('🔴 删除走 /delete 接口',
      /jpost\('\/delete'/.test(cli))
    ok('🔴 设置页有删除方式选项（三档）',
      /deleteMode/.test(cli) && /完全忘掉/.test(cli) &&
      /只从图库移除/.test(cli) && /只删文件/.test(cli))
    ok('路由注册了 /delete',
      /'\/api\/pixiv-scroll\/delete'/.test(await fs.readFile(new URL('./index.js', import.meta.url), 'utf8')))
  }

  /* ── 🔴 「打开文件管理器」不能假装成功 ──
   *
   * 2026-11-07 老大反馈「点他没反应」。查下来后端**确实**起了 explorer，
   * 但两个问题叠加成了"没反应"的观感：
   *   ① 原来 spawn 之后**不问结果**就返回 ok:true —— 起不来也显示"已打开"；
   *   ② explorer 不抢焦点，可能开在 DSH 窗口后面。
   * 现在：等一下子看起没起来 + 返回 note 如实提示"不一定跳到最前面"。
   */
  {
    const tsrcRaw = await fs.readFile(new URL('./lib/toolset.mjs', import.meta.url), 'utf8')
    /**
     * ⚠️ **必须先去注释再查** —— 这是本项目第三次踩同一个坑了：
     *    "不一定跳到最前面" 这句话在**注释**里也出现（那段正解释着为什么加这条提示），
     *    不去注释的话，把真正的 note 删掉断言照样通过 = 假通过。
     */
    const tsrc = tsrcRaw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/[^\n]*/gm, '')

    /**
     * 🔴 打开文件夹：**不许假装成功**，且要开得可靠。
     *
     * 这个函数改过三轮（2026-11-07，老大反馈"点了没反应"）：
     *   一轮：只 spawn 就 return ok:true —— spawn 失败也说"已打开"（假成功）
     *   二轮：改成等 spawn 结果 —— 但 Explorer **不抢焦点**，还是"看着没反应"
     *   三轮（现在）：改用 **ShellExecuteW**（Windows 官方开文件夹接口），
     *        开**目录本身**，再尽量把窗口带到前台。
     *
     * ⚠️ 断言要盯**现在的契约**，不能盯着上一版的写法 ——
     *    "盯着旧写法"正是本项目的经典翻车姿势（断言把错误做法锁死）。
     */
    ok('🔴 用 ShellExecuteW 开目录（比 explorer 命令行可靠）',
      /ShellExecuteW/.test(tsrc),
      'explorer.exe /select, 在路径含空格/中文/括弧时容易出幺蛾子')
    ok('🔴 打不开时如实报错（不许再说"已打开"）',
      /ShellExecute 返回/.test(tsrc),
      'ShellExecute 返回 <=32 表示失败，必须抛出来')
    ok('🔴 会尝试把窗口带到前台',
      /Focus\(\)/.test(tsrc) || /AppActivate/.test(tsrc),
      'Explorer 默认不抢焦点，不前置的话用户看着就是"点了没反应"')
    ok('🔴 前端把**路径**显示出来（抢不到焦点时用户能自己找）',
      /已打开/.test(await fs.readFile(new URL('./client.js', import.meta.url), 'utf8')),
      '最靠谱的兜底是把路径摆到界面上')
    ok('有「打开图库」按钮（不用一件件点）',
      /openRoot/.test(await fs.readFile(new URL('./client.js', import.meta.url), 'utf8')))
  }
}

/* ─────────── 🔴 过度区（staging）───────────
 *
 * 2026-11-09 老大要的：预览时就把**原图**存到本地，点「存」变成**搬一下**。
 * 这样"图看得见却存不下"（网络抽风 / 代理掉了）就不会发生。
 *
 * 三件事必须钉住：
 *   ① **路径安全** —— 清理/读取只许在 staging 之内（删文件的操作，红线）
 *   ② **清理只动 staging** —— 绝不能碰主图库
 *   ③ **轮次 id 唯一** —— 同一秒连开两轮也不能撞（撞了就永远清不掉，
 *      实测踩到过：两轮拿到同一个 id ⇒ "清上一轮"认为它是"当前轮"而保留）
 */
{
  const S = await import('./lib/staging.mjs')
  const { Toolset } = await import('./lib/toolset.mjs')
  const { normalize } = await import('./lib/config.mjs')
  const { mkdtempSync } = await import('node:fs')
  const os2 = await import('node:os')
  const pm = await import('node:path')

  /* —— ① 路径安全 —— */
  {
    const home = mkdtempSync(pm.join(os2.tmpdir(), 'px-st-sec-'))
    const bads = [
      ['../../etc', '相对穿越'],
      ['..\\..\\Windows', '反斜杠穿越'],
      ['/abs/path', '绝对路径'],
      ['/', '根斜杠'],
      ['C:/Windows', '盘符（正斜杠）'],
      ['C:\\Windows', '盘符（反斜杠）'],
      ['//server/share', 'UNC'],
      ['..', '纯点点'],
      ['a/../../b', '中段穿越'],
      ['', '空'],
    ]
    for (const [bad, why] of bads) {
      let refused = false
      try { S.safeStagingPath(home, bad) } catch { refused = true }
      ok(`🔴 过度区路径校验拒绝：${why}`, refused, `"${bad}" 被放过了`)
    }
    // 合法路径要能过
    let okPath = false
    try { S.safeStagingPath(home, '20261109-1100-001/151830367') ; okPath = true } catch { /* ignore */ }
    ok('合法的过度区路径能过', okPath)
    // ⚠️ 标题带省略号也要能过（删图那次栽过同样的校验）
    let okDots = false
    try { S.safeStagingPath(home, 'r/管理人...？_151743550') ; okDots = true } catch { /* ignore */ }
    ok('🔴 名字带省略号的合法路径能过（别再误伤）', okDots)
    await fs.rm(home, { recursive: true, force: true })
  }

  /* —— ② 轮次 id 唯一 —— */
  {
    const seen = new Set()
    for (let i = 0; i < 200; i++) seen.add(S.newRoundId(1700000000000))
    ok('🔴 轮次 id 同一毫秒连开 200 次也不撞',
      seen.size === 200, `只生成了 ${seen.size} 个不同 id`)
  }

  /* —— ③ 放进 / 取回 / 清理 —— */
  {
    const home = mkdtempSync(pm.join(os2.tmpdir(), 'px-st-'))
    const r1 = await S.putWork({
      home, roundId: 'R1', id: '151830367',
      pages: [{ page: 0, bytes: Buffer.alloc(5000), contentType: 'image/png' }],
      meta: { title: '三峡' },
    })
    ok('放进去会返回相对路径', typeof r1.rel === 'string' && r1.rel.includes('151830367'), r1.rel)
    const hit = await S.findWork(home, '151830367')
    ok('能找回来', !!hit && hit.round === 'R1')
    const tk = await S.takeWork(home, '151830367')
    ok('取回拿到文件', !!tk && tk.files.length === 1 && tk.files[0].bytes === 5000)
    ok('取回带着 meta', !!tk.meta && tk.meta.title === '三峡')

    /* —— ④ 清理：只清不保留的，且**不碰主图库** —— */
    const libWork = pm.join(home, 'library', 'X', 'W_999')
    await fs.mkdir(libWork, { recursive: true })
    await fs.writeFile(pm.join(libWork, '001.png'), Buffer.alloc(777))

    await S.putWork({ home, roundId: 'R2', id: '222',
      pages: [{ page: 0, bytes: Buffer.alloc(100), contentType: 'image/jpeg' }] })

    const c = await S.cleanRounds({ home, keep: ['R2'] })
    ok('清掉了不保留的那一轮', c.removed.includes('R1'), JSON.stringify(c.removed))
    ok('保留了当前轮', c.kept.includes('R2'), JSON.stringify(c.kept))
    ok('🔴 清理**绝不动主图库**',
      await fs.stat(pm.join(libWork, '001.png')).then(() => true).catch(() => false),
      '主图库那件被误删了 —— 这是红线')
    await fs.rm(home, { recursive: true, force: true })
  }

  /* —— ⑤ Toolset.startRound：开新轮顺手清上一轮 —— */
  {
    const home = mkdtempSync(pm.join(os2.tmpdir(), 'px-st-ts-'))
    const cfg = normalize({ saveRoot: pm.join(home, 'library'), stagingEnabled: true })
    const ts = new Toolset({ home, getConfig: () => cfg, getDelivery: () => ({ channels: [] }), python: 'python' })

    const a = await ts.startRound()
    ok('startRound 给出轮次 id', typeof a.roundId === 'string' && a.roundId.length > 0, a.roundId)
    await S.putWork({ home, roundId: a.roundId, id: '111',
      pages: [{ page: 0, bytes: Buffer.alloc(10), contentType: 'image/png' }] })

    const b = await ts.startRound()
    ok('🔴 开第二轮时上一轮被清掉',
      b.cleaned && b.cleaned.removed.includes(a.roundId),
      `removed=${JSON.stringify(b.cleaned && b.cleaned.removed)}，期望含 ${a.roundId}`)
    const st = await S.stagingStats(home)
    ok('清完之后过度区是空的', st.rounds === 0 && st.works === 0, JSON.stringify(st))

    // 关掉开关就不该动过度区
    const cfg2 = normalize({ saveRoot: pm.join(home, 'library'), stagingEnabled: false })
    const ts2 = new Toolset({ home, getConfig: () => cfg2, getDelivery: () => ({ channels: [] }), python: 'python' })
    await S.putWork({ home, roundId: ts2.roundId(), id: '333',
      pages: [{ page: 0, bytes: Buffer.alloc(10), contentType: 'image/png' }] })
    await ts2.startRound()
    const st2 = await S.stagingStats(home)
    ok('关掉开关后不再自动清（尊重设置）', st2.works >= 1, JSON.stringify(st2))
    await fs.rm(home, { recursive: true, force: true })
  }

  /* —— ⑥ 源码接线 —— */
  {
    const tsSrc = (await fs.readFile(new URL('./lib/toolset.mjs', import.meta.url), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '')
    ok('🔴 pixiv_pick 里存的是**原字节**（缩之前）',
      /staging\.putWork\([\s\S]{0,400}?pages:\s*\[\{\s*page:\s*0,\s*bytes,/.test(tsSrc),
      '存成缩过的那份的话，"存原图"就是空话')
    ok('🔴 toolSave 优先从过度区取（不重下）',
      /staging\.takeWork/.test(tsSrc))
    ok('存完把过度区那份收掉', /staging\.dropWork/.test(tsSrc))
    ok('过度区可关（尊重 stagingEnabled）',
      /stagingEnabled\s*!==\s*false/.test(tsSrc))

    const cli = (await fs.readFile(new URL('./client.js', import.meta.url), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '')
    ok('设置页有「过度区」开关', /stagingEnabled/.test(cli) && /过度区/.test(cli))
  }
}

/* ─────────── ④ 结果推给浮窗（onResult） ─────────── */
{
  let got = null
  const ts = new TS.Toolset({
    home,
    getConfig: () => ({ saveRoot: libRoot, proxyUrl: '' }),
    getDelivery: () => null, python: '', log: () => {},
    onResult: (p) => { got = p },
  })
  ts.publish([{ id: '1', title: 'T' }], '测试')
  ok('publish 调到了 onResult', got && got.items.length === 1)
  eq('label 传过去了', got.label, '测试')

  // onResult 抛异常不能影响 publish 的调用方
  const ts2 = new TS.Toolset({
    home, getConfig: () => ({ saveRoot: libRoot }), getDelivery: () => null, python: '', log: () => {},
    onResult: () => { throw new Error('浮窗炸了') },
  })
  let threw = false
  try { ts2.publish([{ id: '1' }], 'x') } catch { threw = true }
  ok('🔴 浮窗异常不影响主流程（展示层不该拖垮工具）', !threw)

  // 没有 onResult 时 publish 也不该抛
  const ts3 = new TS.Toolset({
    home, getConfig: () => ({ saveRoot: libRoot }), getDelivery: () => null, python: '', log: () => {},
  })
  let threw3 = false
  try { ts3.publish([{ id: '1' }], 'x') } catch { threw3 = true }
  ok('没接 onResult 时 publish 不抛', !threw3)
}

/* ─────────── ⑤ client bundle 接线 ─────────── */
{
  const src = await fs.readFile(new URL('./client.js', import.meta.url), 'utf8')
  ok('注册了两个 tab 类型', /'pixiv-board'/.test(src) && /'pixiv-library'/.test(src))
  ok('用 sidebarRightTabs.register', /tabs\.register\(\{/.test(src))
  ok('正文注册到 sidebar.right.pane.tab', /'sidebar\.right\.pane\.tab'/.test(src))

  /**
   * 🔴 三步注册，缺一步 tab 就不显示（2026-11-07 实测踩到）。
   *
   * 这里以前断言的是 `inject: ['slots','sidebarRightTabs','sidebarRight']` ——
   * **那条断言把 bug 锁住了**：它要求把两个可选服务写进 inject，
   * 而当时我误以为"inject 里缺服务宿主就不跑 apply()"，于是把列表删成
   * `['slots']` —— 那才是 2026-11-07 把 DSH 弄崩的真因。
   * 现在反过来断言"三个都得在"。
   */
  /**
   * ⚠️ 查"有没有这段代码"之前**必须先去注释** —— 否则断言会命中注释里
   *    那段解释文字而**假通过**（2026-11-07 实测踩到：把标题 chip 的注册
   *    整段删掉，自检照样全绿，因为它匹配的是注释里写的
   *    `sidebar.right.pane.tab.title`）。这类"断言在测文档"的假通过
   *    比没断言更坏 —— 它会让人以为安全。
   */
  const codeOnly0 = src
    .replace(/\/\*[\s\S]*?\*\//g, '')     // 块注释
    .replace(/^\s*\/\/[^\n]*/gm, '')      // 整行行注释

  ok('① 声明 tab 类型（带 priority）',
     /priority:\s*'builtin'/.test(codeOnly0))
  ok('①b 声明了 guide 入口（官方给的打开入口）',
     /guide:\s*\[/.test(codeOnly0),
     "page 类型靠 guide 让用户从面板的「指南」页点开")
  ok('② 正文注册（带 key）',
     /name:\s*'sidebar\.right\.pane\.tab'[\s\S]{0,80}?key:\s*t\.id/.test(codeOnly0))
  ok('🔴 ③ 标题 chip 也注册（漏了 tab 整条不显示）',
     /'sidebar\.right\.pane\.tab\.title'/.test(codeOnly0),
     '必须注册 sidebar.right.pane.tab.title，否则标签条上没这个 tab')
  ok('🔴 不在加载时硬开 tab（面板是会话级的，硬开必抛）',
     !/openTab\s*\(/.test(codeOnly0),
     'openTab 要求有挂载中的 session；插件加载时没有 ⇒ ' +
     '必然抛 sidebarRight: no session surface is mounted（实测踩到）')
  ok('🔴 inject 必须列全要用的服务（少一个 ⇒ 摸一下就抛 ⇒ 整个应用起不来）',
     /inject:\s*\['slots',\s*'sidebarRightTabs',\s*'sidebarRight'\]/.test(codeOnly0),
     'ctx 是 Proxy：没写进 inject 的服务，ctx.get(\'x\') 和 ctx.x 都会抛 ' +
     'cannot get property "x" without inject。2026-11-07 就是因为把这个列表删成 ' +
     "['slots']，又把 DSH 弄崩了一次")

  ok('有「发现」正文', /const BoardBody/.test(codeOnly0))
  ok('有「已收藏」正文', /const LibraryBody/.test(codeOnly0))

  /* ── 🔴 tab 名字（老大 2026-11-08 定的）──
   *
   * 原来叫「这一轮 / 图库」，他说"这一轮听着像半成品"。
   * 改成「**发现 / 已收藏**」—— 从名字就能看出谁是临时的、谁是留下的。
   *
   * ⚠️ 这条之前**根本没测**（改名后自检照样全绿），是查覆盖率时发现的。
   *    名字是用户直接看到的东西，值得钉住。
   */
  ok('🔴 tab 叫「发现」（不再是"这一轮"）',
    /title:\s*'发现'/.test(codeOnly0), '老大嫌"这一轮"像半成品')
  ok('🔴 tab 叫「已收藏」（不再是"图库"）',
    /title:\s*'已收藏'/.test(codeOnly0))
  ok('🔴 guide 入口也用新名字',
    /guide:\s*\{\s*id:\s*'board'[\s\S]{0,60}title:\s*'发现'/.test(codeOnly0) &&
    /guide:\s*\{\s*id:\s*'library'[\s\S]{0,60}title:\s*'已收藏'/.test(codeOnly0),
    'guide 里还是旧名字的话，面板「指南」页显示的就是旧的')

  // 浮窗上要能选（老大明确要求）
  // ⚠️ 这一条以前断言 `more_like_this` —— **是假通过**：
  //    那时候这个 action 已经删掉了，断言匹配到的只是**注释里解释它为什么被删**的文字。
  //    而且它跟本文件后面那条「代码里不许有 more_like_this」自相矛盾。
  //    现在改成断言真正的契约：👍 走 save()。
  ok('浮窗上👍走 save（正向偏好的唯一入口是存）',
    /save\(it\.id\)/.test(codeOnly0), '发 more_like_this 那种不存在的 action 会直接报错')
  ok('浮窗上有不喜欢按钮', /'unlike'/.test(codeOnly0))
  ok('浮窗上有存按钮', /jpost\('\/save'/.test(codeOnly0))
  // 缩略图走插件接口，不是直连 pximg
  ok('缩略图走插件接口', /\/thumb\?id=/.test(src))

  /* ── 🔴 预览不能因为"原图大"就取不到；保存必须是原图 ──
   *
   * 2026-11-07 老大定口径：
   *    「**保存原图**才是目的，缩略图只是这一轮的预览」
   *
   * 实测栽过两次（`Cold Harbor. K48` 4500×6000、`管理人...？` 2894×4093
   * 占 10.2MB）—— 两张都是高分作品，而 `pixiv_pick` 卡在 8MB
   * ⇒ 直接 error，**连看都看不到**。
   */
  {
    const ts = (await fs.readFile(new URL('./lib/toolset.mjs', import.meta.url), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/[^\n]*/gm, '')

    ok('🔴 预览的下载上限已抬到 8MB 以上（原图大也要能看）',
      /WANT_MAX\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.test(ts) &&
      Number((ts.match(/WANT_MAX\s*=\s*(\d+)/) || [])[1]) >= 16,
      '卡 8MB 会让 10MB 级的原图直接 error，用户连预览都看不到')

    ok('🔴 预览过大时本地缩（而不是放弃）',
      /PREVIEW_EDGE/.test(ts) && /runShrink/.test(ts),
      '缩的是预览副本，画面内容不打折，省的是读图/落盘成本')

    ok('🔴 缩图失败要退回原图（绝不能因此看不到图）',
      /缩失败就用原字节/.test(ts) || /previewShrunk/.test(ts))

    ok('🔴 保存那条路仍取原图（上限比预览高）',
      /maxBytes:\s*64\s*\*\s*1024\s*\*\s*1024/.test(ts),
      '保存要的是原图 —— 它的上限必须高于预览那条')

    ok('🔴 如实标注这张预览是缩过的',
      /preview:\s*previewShrunk/.test(ts),
      '不标的话用户会以为看到的就是原图')
  }

  /* ── 🔴 三个实测踩到的浮窗 bug（2026-11-07 老大逐个报上来的）──
   *
   * ① 首屏图片全破图（刷新一下就好）
   * ② 在「这一轮」点了存，「图库」里看不到
   * ③ 图库只在挂载时 load 一次，之后永不刷新
   */
  ok('🔴 base 没好时不拼相对路径（那必然破图）',
     // ⚠️ 断言要盯"结果"，不能盯"某个写法"（上一版只查了 `if (!b) return BLANK`，
     //    把返回改成 `'' + '/thumb?id=…'` 照样通过 —— 而那正是破图的老写法）
     !/\|\|\s*''\s*[\s\S]{0,40}\/thumb\?id=/.test(codeOnly0) &&
     !/return\s*''\s*\+\s*'\/thumb/.test(codeOnly0),
     'base 为空时拼出来的是 /thumb?id=… 相对路径，在 dsh-app:// 下取不到')
  ok('🔴 有占位图常量（别让浏览器画破图）',
     /BLANK\s*=\s*'data:image\/gif/.test(codeOnly0))
  ok('🔴 两个 tab 都订阅了 base 就绪（要重渲染才能换真图）',
     (codeOnly0.match(/useBase\(\)/g) || []).length >= 2,
     'BoardBody / LibraryBody 各要订阅一次')
  ok('🔴 img 的 src 跟着 baseReady 走（base 一到就重渲染）',
     /baseReady\s*\?\s*thumbSrc/.test(codeOnly0) && /baseReady\s*\?\s*fileSrc/.test(codeOnly0),
     'src 直接调 thumbSrc() 的话，首屏生成的占位地址**永远不会更新**')
  ok('🔴 存成功后要通知图库刷新',
     /notifyLibraryChanged\(\)/.test(codeOnly0),
     '「这一轮」和「图库」是两个独立组件，不通知的话图库毫不知情')
  ok('🔴 只在真的存进去时才通知（被闸门拦下别刷）',
     /if\s*\(r\s*&&\s*r\.ok\)\s*notifyLibraryChanged\(\)/.test(codeOnly0))
  ok('🔴 图库订阅了变更信号',
     /libListeners\.add/.test(codeOnly0))

  /* ── 🔴 浮窗发的 action 必须是工具真认的 ──
   *
   * 2026-11-07 实测：👍 按钮发的是 `more_like_this`，
   * 而 pixiv_feedback 只认 unlike / artist_down / style_down
   * ⇒ 工具抛「不认识的 action」⇒ **👍 从来没好用过**。
   *
   * 这条把"面板发什么"和"工具认什么"对齐 —— 以后再错配立刻报红。
   */
  {
    const fb = await fs.readFile(new URL('./lib/feedback.mjs', import.meta.url), 'utf8')
    const kinds = [...fb.matchAll(/'(unlike|artist_down|style_down)'/g)].map((m) => m[1])
    ok('拿到工具认的 action 列表', new Set(kinds).size >= 3, JSON.stringify([...new Set(kinds)]))

    // 面板里所有 send(id, 'xxx') 的 action
    const sent = [...codeOnly0.matchAll(/send\([^,]+,\s*'([a-z_]+)'/g)].map((m) => m[1])
    ok('面板确实发了反馈', sent.length > 0, JSON.stringify(sent))

    const bad = [...new Set(sent)].filter((a) => !kinds.includes(a))
    ok('🔴 面板发的每个 action 工具都认（不然按钮点了就报错）',
      bad.length === 0,
      bad.length ? `面板发了工具不认的：${bad.join(', ')}（工具只认 ${[...new Set(kinds)].join('/')}）` : '')

    ok('🔴 代码里不再有 more_like_this（那不是真的 action）',
      !/more_like_this/.test(codeOnly0),
      '正向偏好的唯一入口是「存」：toolSave 内部会 learnFromSaved()')
  }
  // 🔴 防回归：代码里不能直连 i.pximg.net（会被防盗链拦）
  //    ⚠️ 要**去掉注释再查** —— 注释里正解释着"为什么不直连"，会误伤
  {
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
      .replace(/^\s*\/\/[^\n]*/gm, '')       // 整行行注释
      .replace(/([^:])\/\/[^\n]*/g, '$1')    // 行尾注释（避开 http://）
    ok('🔴 代码里没有直连 i.pximg.net（会被防盗链拦）', !/i\.pximg\.net/.test(codeOnly),
      '注释里提它是可以的（那是在解释为什么不那么做）')
  }
  // 样式
  ok('有 grid 样式', /\[data-px-grid\]/.test(src))
  ok('网格自适应（不写死列数）', /auto-fill,minmax/.test(src))
}

/* ─────────── ⑥ 宿主接口接线 ─────────── */
{
  const idx = await fs.readFile(new URL('./index.js', import.meta.url), 'utf8')
  for (const p of ['/thumb', '/file', '/board', '/library', '/feedback', '/save', '/reveal']) {
    ok(`注册了 ${p} 路由`, idx.includes(`'/api/pixiv-scroll${p}'`), '浮窗拿不到数据')
  }
  ok('有发二进制的 binary()', /const binary = \(code, bytes/.test(idx))
  ok('🔴 connection 分支会原样透传二进制（不当字符串用）',
    /out\.body !== undefined && out\.body !== null\)\s*\n\s*\? out\.body/.test(idx),
    '原来无条件当字符串，图片会变成 [object Uint8Array]')
  ok('看板只在内存（不落盘）', /let lastBoard = \{/.test(idx) && !/board\.json/.test(idx))
  ok('接了 onResult', /onResult: \(payload\) =>/.test(idx))
}

await fs.rm(home, { recursive: true, force: true }).catch(() => {})
console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
