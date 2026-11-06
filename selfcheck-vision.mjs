/**
 * 自检 —— 阶段 C：视觉特征 + 返回值无损。
 * ============================================================================
 * 这个套件盯两件事，都是**实测踩过的真 bug**，不是假想出来的：
 *
 * 一、**返回值必须能无损 JSON 往返**（2026-11-07 踩到，最严重的一个）
 *     `pixiv_search` 在「画像没开 / 没有报错」时必然失败，模型只看到
 *         tool "pixiv_search" returned invalid output: value is not lossless JSON
 *     根因：代码里大量 `x.length ? x : undefined`，而 JSON.stringify
 *     **静默丢掉 undefined 键** ⇒ 往返后不等于原值 ⇒ 宿主判不合格。
 *
 *     ⚠️ 为什么以前的自检抓不到：自检直接 `await tool.execute(args)` 拿对象，
 *        **根本不过宿主那道校验**。所以这个套件必须自己模拟那道校验 ——
 *        这是它存在的首要理由。
 *
 * 二、**视觉特征必须"量得准、缺得诚实"**
 *     · 量不准（把纯黑说成"中等饱和冷色调"、把纯白说成"有边缘"）
 *       是我们自己踩过的两个真 bug，这里各钉一条回归；
 *     · 缺得诚实：分析失败时 visual 必须是 null，**绝不能拿标签猜画面** ——
 *       否则 explain() 就会跟着对用户撒谎。
 * ============================================================================
 */
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { deepSanitize, lossless } from './lib/toolset.mjs'
import { analyzeImages, describeVisual, MAX_BATCH } from './lib/vision.mjs'
import { explain } from './lib/explore.mjs'

const here = dirname(fileURLToPath(import.meta.url))

let pass = 0
let fail = 0
const failures = []

/** 安全序列化 —— 自检**自己**不能因为被测对象脏就崩掉 */
function safeStr(v) {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) + 'n' : x))
  } catch {
    return String(v)
  }
}

function ok(cond, name, extra) {
  if (cond) { pass++; return }
  fail++
  failures.push(extra ? `${name}  → ${extra}` : name)
}

function eq(a, b, name) {
  const A = safeStr(a)
  const B = safeStr(b)
  ok(A === B, name, `得到 ${A}，期望 ${B}`)
}

/* ══════════════════ 一、无损 JSON 往返 ══════════════════ */

/**
 * 宿主那句校验的等价实现。
 *
 * ⚠️ 这里有个**很容易写错**的地方（我第一版就写错了，自检自己报了 4 条不该有的失败）：
 *    判据**不能**是 `JSON.stringify(JSON.parse(s)) === s` ——
 *    因为 `s` 本身已经是 stringify 的产物，`undefined` 键在**那一步就没了**，
 *    两边比的是同一个已被削过的字符串，永远相等 ⇒ 判据恒真、什么都测不出来。
 *
 *    正确的判据是拿**原值**跟"往返回来的值"比**深比较**：
 *    原值里有的键，往返后必须还在、且相等。
 */
function isLossless(v) {
  let s
  try {
    s = JSON.stringify(v)
  } catch {
    return false                       // 循环引用等：序列化就失败
  }
  if (s === undefined) return false    // 顶层是 undefined/函数/Symbol
  let back
  try {
    back = JSON.parse(s)
  } catch {
    return false
  }
  return deepEqual(v, back)
}

/** 深比较：**键的集合**必须一致（多余/缺失都算不等），NaN 视为不等 */
function deepEqual(a, b) {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (typeof a !== 'object') return Object.is(a, b)
  // Set/Map/Date 等：往返后类型会变，直接判不等（宿主也认不出来）
  const aPlain = Object.getPrototypeOf(a) === Object.prototype || Array.isArray(a)
  const bPlain = Object.getPrototypeOf(b) === Object.prototype || Array.isArray(b)
  if (!aPlain || !bPlain) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false      // ← undefined 键丢在这里现形
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!deepEqual(a[k], b[k])) return false
  }
  return true
}

// —— 裸值：不处理就是无损的，先确认判据本身没写错 ——
ok(isLossless({ a: 1, b: 'x' }), '裸对象本来就是无损的（判据自检）')
ok(!isLossless({ a: 1, b: undefined }), 'undefined 键确实会让往返不无损（这就是那个 bug）')
ok(!isLossless({ a: NaN }), 'NaN 会让往返不无损')
ok(!isLossless({ a: Infinity }), 'Infinity 会让往返不无损')

// —— lossless() 之后必须全部无损 ——
const CASES = [
  ['undefined 键', { a: 1, b: undefined, c: 'x' }],
  ['嵌套 undefined', { items: [{ id: 1, note: undefined }] }],
  ['深层嵌套', { a: { b: { c: undefined, d: 2 } } }],
  ['数组里的 undefined', { arr: [1, undefined, 3] }],
  ['NaN / ±Infinity', { x: NaN, y: Infinity, z: -Infinity }],
  ['Set', { s: new Set([1, 2, 3]) }],
  ['Map', { m: new Map([['k', 'v']]) }],
  ['Date', { d: new Date('2026-11-07T00:00:00Z') }],
  ['bigint', { b: 9007199254740993n }],
  ['函数', { f: () => 1 }],
  ['Symbol 值', { s: Symbol('x') }],
  ['Uint8Array', { bytes: new Uint8Array([1, 2, 3]) }],
  ['混合', { a: [undefined, NaN], b: new Set([undefined, 1]), c: { d: undefined } }],
]
for (const [name, v] of CASES) {
  const s = lossless(v)
  ok(isLossless(s), `lossless 后必须无损：${name}`, safeStr(s))
}
// 循环引用不能抛
{
  const c = { a: 1 }
  c.self = c
  let threw = false
  let s = null
  try { s = lossless(c) } catch { threw = true }
  ok(!threw, '循环引用不能抛')
  ok(s && isLossless(s), '循环引用也要能无损')
}
// 语义：undefined 键应当**消失**（保持"省略"的意思），不是变成 null
eq(lossless({ a: 1, b: undefined }), { a: 1 }, 'undefined 键是省略，不是 null')
// 语义：数组里的空位补 null（不能删元素，删了会挪下标）
eq(lossless({ arr: [1, undefined, 3] }), { arr: [1, null, 3] }, '数组空位补 null')
// 语义：假值必须原样保留（0 / '' / false 不是 undefined）
eq(lossless({ a: 0, b: '', c: false, d: null }), { a: 0, b: '', c: false, d: null },
   '0 / 空串 / false / null 都要原样留着')
// 不能改坏正常数据
eq(lossless({ n: 1.5, s: '中文', arr: [{ x: 1 }] }), { n: 1.5, s: '中文', arr: [{ x: 1 }] },
   '正常数据不能被改坏')

// —— 真实形状回归：pixiv_search 那种"有就带上、没有就省略"的返回 ——
{
  const searchShape = {
    ok: true,
    plan: '刷排行',
    found: 59,
    afterFilter: 40,
    returned: 5,
    quota: { familiar: 3, explore: 1, diversify: 1, ratios: { familiar: 0.6 } },
    actual: { familiar: 3, explore: 1, total: 5 },
    shortfall: undefined,          // ← 画像关着 / 池子够 时就是这个
    items: [{ id: '1', tags: ['a'], visual: undefined }],
    taste: { enabled: false, warm: false, note: undefined },
    mood: undefined,               // ← 非 mood 模式时就是这个
    errors: undefined,             // ← 没出错时就是这个
  }
  ok(!isLossless(searchShape), 'search 的原始形状本来是不无损的（复现那个 bug）')
  const cleaned = lossless(searchShape)
  ok(isLossless(cleaned), '🔴 pixiv_search 形状经 lossless 后必须无损（否则整个工具挂掉）')
  ok(!('shortfall' in cleaned), 'shortfall 为空时该省略')
  ok(!('mood' in cleaned), 'mood 为空时该省略')
  eq(cleaned.items, [{ id: '1', tags: ['a'] }], 'items 里的嵌套 undefined 也要清掉')
}

// —— deepSanitize 的深度上限：病态结构不能把栈打爆 ——
{
  let deep = { v: 1 }
  for (let i = 0; i < 500; i++) deep = { n: deep }
  let threw = false
  try { lossless(deep) } catch { threw = true }
  ok(!threw, '超深结构不能抛')
}

/* ══════════════════ 二、视觉特征：量得准 ══════════════════ */

const PY = process.env.PIXIV_SELFCHECK_PYTHON || findPython()

function findPython() {
  const cands = [
    join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources',
      'runtime', 'primary-runtime', 'dependencies', 'python', 'python.exe'),
    join(process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'),
      'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
  ]
  for (const c of cands) if (c && existsSync(c)) return c
  return 'python'
}

function havePillow(py) {
  try {
    execFileSync(py, ['-c', 'import PIL'], { stdio: 'ignore', timeout: 20000 })
    return true
  } catch { return false }
}

const PILLOW = havePillow(PY)
if (!PILLOW) {
  console.log(`⚠️  没找到带 Pillow 的 python（试过 ${PY}）—— 跳过需要真分析的断言。`)
}

/** 造测试图（只依赖 Pillow，不依赖别的东西） */
function makeFixtures(dir) {
  const script = `
from PIL import Image, ImageDraw
import random, os, json
t = r'''${dir}'''
def save(n, im): im.save(os.path.join(t, n))
save('black.png', Image.new('RGB', (600, 400), (5, 5, 8)))
save('white.png', Image.new('RGB', (600, 400), (250, 250, 250)))
save('flat_grey.png', Image.new('RGB', (600, 400), (128, 128, 128)))
save('warm.png', Image.new('RGB', (600, 400), (220, 170, 110)))
save('cool.png', Image.new('RGB', (600, 400), (180, 195, 215)))
random.seed(7)
im = Image.new('RGB', (600, 400))
im.putdata([(random.randint(0,255),)*3 for _ in range(600*400)])
save('noise.png', im)
im = Image.new('RGB', (600, 400))
d = ImageDraw.Draw(im)
for i in range(600):
    d.line([(i,0),(i,400)], fill=(int(255*i/600), int(255*(1-abs(i-300)/300)), int(255*(i%120)/120)))
save('rainbow.png', im)
# 竖图 + 主体压在三分点：用来验 orientation / ruleOfThirds
im = Image.new('RGB', (300, 600), (30, 30, 40))
d = ImageDraw.Draw(im)
d.ellipse([100-45, 200-45, 100+45, 200+45], fill=(240, 240, 250))
save('portrait_roi.png', im)
print('ok')
`
  execFileSync(PY, ['-c', script], { stdio: 'ignore', timeout: 60000 })
}

let dir = null
if (PILLOW) {
  dir = mkdtempSync(join(tmpdir(), 'pixvis-selfcheck-'))
  makeFixtures(dir)
}

async function analyze(name) {
  const p = join(dir, name)
  const r = await analyzeImages({ python: PY, paths: [p] })
  return r.byPath.get(p) || null
}

if (PILLOW) {
  const black = await analyze('black.png')
  const white = await analyze('white.png')
  const flat = await analyze('flat_grey.png')
  const warm = await analyze('warm.png')
  const cool = await analyze('cool.png')
  const noise = await analyze('noise.png')
  const rainbow = await analyze('rainbow.png')

  ok(black && white && flat && warm && cool && noise && rainbow, '每张测试图都该分析出来')

  if (black && white && flat && warm && cool && noise && rainbow) {
    /* —— 🔴 回归 1：纯黑不是"中等饱和的冷色调"（真 bug） —— */
    ok(black.saturation < 0.12,
       '🔴 纯黑图的饱和必须≈0（曾错报 0.373："中等饱和"）', `得到 ${black.saturation}`)
    ok(Math.abs(black.warmth - 0.5) < 0.08,
       '🔴 纯黑图的色温必须落在中性（曾因 R<B 错报"冷色调"）', `得到 ${black.warmth}`)
    ok(black.temperature === 'neutral',
       '🔴 纯黑图的色温措辞必须是 neutral', `得到 ${black.temperature}`)
    ok(black.warmthConfidence < 0.3,
       '暗图的色温置信度必须低（写明它不可信）', `得到 ${black.warmthConfidence}`)

    /* —— 🔴 回归 2：平坦图不该有边缘（真 bug） —— */
    ok(white.edgeDensity === 0,
       '🔴 纯白图的边缘密度必须是 0（曾因 FIND_EDGES 核和不为零错报 0.057）',
       `得到 ${white.edgeDensity}`)
    ok(flat.edgeDensity === 0, '纯灰图的边缘密度也必须是 0', `得到 ${flat.edgeDensity}`)
    ok(black.edgeDensity === 0, '纯黑图不该有边缘', `得到 ${black.edgeDensity}`)
    ok(noise.edgeDensity > 0.15,
       '噪声图的边缘密度必须明显高（否则这个指标没在量边缘）', `得到 ${noise.edgeDensity}`)

    /* —— 亮度 —— */
    ok(black.brightness < 0.1, '黑图亮度≈0', `得到 ${black.brightness}`)
    ok(white.brightness > 0.9, '白图亮度≈1', `得到 ${white.brightness}`)
    ok(black.lightness === 'dark', '黑图判 dark', `得到 ${black.lightness}`)

    /* —— 色温方向 —— */
    ok(warm.warmth > cool.warmth,
       '暖图的暖度必须高于冷图', `暖 ${warm.warmth} vs 冷 ${cool.warmth}`)
    ok(warm.temperature === 'warm' || warm.temperature === 'slightly-warm',
       '暖图判偏暖', `得到 ${warm.temperature}`)
    ok(cool.temperature === 'cool' || cool.temperature === 'slightly-cool',
       '冷图判偏冷', `得到 ${cool.temperature}`)

    /* —— 饱和 / 色彩丰富度 —— */
    ok(rainbow.saturation > flat.saturation,
       '彩虹图饱和必须高于灰图', `${rainbow.saturation} vs ${flat.saturation}`)
    ok(rainbow.colorfulness > 0.8, '彩虹图色彩丰富度必须高', `得到 ${rainbow.colorfulness}`)
    ok(flat.colorfulness < 0.05, '灰图色彩丰富度必须≈0', `得到 ${flat.colorfulness}`)

    /* —— 主色 —— */
    ok(Array.isArray(warm.dominant) && warm.dominant.length > 0, '暖图该有主色')
    ok(warm.dominant[0].hex === '#d0a060',
       '暖图主色该是它的实际颜色', `得到 ${warm.dominant[0].hex}`)
    ok(typeof warm.dominant[0].share === 'number' && warm.dominant[0].share > 0.9,
       '纯色图的主色占比该接近 1', `得到 ${warm.dominant[0].share}`)

    /* —— 构图 / 方向 —— */
    const roi = await analyze('portrait_roi.png')
    ok(roi && roi.orientation === 'portrait', '竖图该判 portrait', `得到 ${roi && roi.orientation}`)
    ok(roi && roi.composition && roi.composition.ruleOfThirds > 0.2,
       '主体压在三分点的图，ruleOfThirds 该明显大于平坦图',
       `得到 ${roi && roi.composition && roi.composition.ruleOfThirds}`)
    ok(white.composition && white.composition.ruleOfThirds === 0,
       '纯色图没有三分法落点', `得到 ${white.composition && white.composition.ruleOfThirds}`)

    /* —— 尺寸 / 宽高比 —— */
    eq([white.width, white.height], [600, 400], '宽高要如实报')
    ok(Math.abs(white.aspect - 1.5) < 0.01, '宽高比要算对', `得到 ${white.aspect}`)

    /* —— 描述文本：只能说量出来的话 —— */
    const dWarm = describeVisual(warm)
    ok(dWarm.includes('暖') || dWarm.includes('饱和'), '暖图的描述该提到暖/饱和', dWarm)
    ok(!/氛围|好看|精妙|优美|惊艳|艺术感/.test(dWarm),
       '🔴 描述里不许出现审美判断词（那是编的）', dWarm)
    ok(describeVisual(null) === '', '没有特征时描述为空串')
  }

  /* —— 批处理 / 失败降级 —— */
  {
    const r = await analyzeImages({ python: PY, paths: [join(dir, 'warm.png'), join(dir, 'cool.png')] })
    ok(r.ok, '批量分析该成功')
    ok(r.byPath.size === 2, '两张都该有结果', `得到 ${r.byPath.size}`)
  }
  {
    const r = await analyzeImages({ python: PY, paths: [join(dir, 'does-not-exist.png')] })
    ok(!r.ok, '️🔴 图不存在时必须 ok=false（不能假装成功）')
    ok(r.byPath.size === 0, '失败时不能编出特征来')
  }
  {
    const r = await analyzeImages({ python: PY, paths: [join(dir, 'warm.png'), join(dir, 'nope.png')] })
    ok(r.ok, '一张成一张败时整体仍算成')
    ok(r.byPath.size === 1, '只带成功的那个', `得到 ${r.byPath.size}`)
  }
  {
    const r = await analyzeImages({ python: PY, paths: [] })
    ok(!r.ok, '没给图时 ok=false')
  }
  {
    const r = await analyzeImages({ python: 'definitely-not-a-real-python-xyz', paths: [join(dir, 'warm.png')] })
    ok(!r.ok, '🔴 python 起不来时必须 ok=false（这是"没读图"那条路的入口）')
    ok(typeof r.why === 'string' && r.why.length > 0, '失败必须给出 why')
  }
}

/* —— 不依赖 Pillow 的降级断言 —— */
{
  const r = await analyzeImages({ paths: ['x'] })
  ok(!r.ok, '没给 python 时 ok=false')
  ok(r.byPath.size === 0, '没给 python 时不给任何特征')
}
{
  const r = await analyzeImages({ python: 'whatever', paths: Array.from({ length: 50 }, (_, i) => 'p' + i) })
  ok(!r.ok || r.byPath.size <= MAX_BATCH, `一次最多分析 ${MAX_BATCH} 张（别把一轮拖死）`)
}

/* ══════════════════ 三、explain() 的三态诚实 ══════════════════ */

{
  // ① 真读过图
  const a = explain({ id: '1', vision: { confidence: 0.8 } })
  ok(a.visualChecked === true, '读过图时 visualChecked=true')
  ok(a.visualNote.includes('读过图'), '读过图时说明白读过了', a.visualNote)

  // ② 量过但没人看 —— 这一态必须**说得不一样**
  const b = explain({
    id: '2',
    visual: { brightness: 0.7, saturation: 0.5, palette: 'colorful' },
    visualText: '明亮 · 高饱和',
  })
  ok(b.visualChecked === false, '只量过特征时 visualChecked 必须仍是 false（没人看过）')
  ok(b.visualNote.includes('没人看'), '🔴 必须说清"没人看过这张图"', b.visualNote)
  ok(b.visualNote.includes('量过'), '同时说明特征量过了', b.visualNote)
  ok(b.visual && b.visual.brightness === 0.7, '数值要原样带出来给上层看')

  // ③ 什么都没有
  const c = explain({ id: '3' })
  ok(c.visualChecked === false, '没读图时 visualChecked=false')
  ok(c.visualNote.includes('没有读图'), '必须说没读图', c.visualNote)
  ok(c.visual === null, '没有特征时 visual 必须是 null')

  // 🔴 最要紧的一条：只量过**不等于**读过图，两者说明必须可区分
  ok(a.visualNote !== b.visualNote,
     '🔴 "读过图"和"只量过"必须给出不同的说明（不能混为一谈）')
}

/* ══════════════════ 收尾 ══════════════════ */

if (dir) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } }

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
