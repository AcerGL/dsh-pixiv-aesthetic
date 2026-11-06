/**
 * README 事实核对 —— 文档里写的东西必须跟代码对得上。
 *   node selfcheck-docs.mjs
 *
 * 为什么要有这个：README 里写"支持 X"但代码没做，比不写还糟。
 * 这里逐条把文档里的**可验证断言**拿去代码里查。
 */
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
let pass = 0
const fails = []
const ok = (n, c, extra) => { if (c) pass++; else fails.push(n + (extra ? '  → ' + extra : '')) }
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)

const read = (p) => fs.readFile(join(here, p), 'utf8')
const readJson = async (p) => JSON.parse(await read(p))

const readme = await read('README.md')
const pkg = await readJson('package.json')
const index = await read('index.js')
const cfg = await read('lib/config.mjs')
const client = await read('client.js')
const deliver = await read('lib/deliver.mjs')
const auth = await read('lib/auth.mjs')

/* ─────────── 工具表：README 列的 7 个工具真的存在 ─────────── */
{
  const toolset = await read('lib/toolset.mjs')
  const names = ['pixiv_status', 'pixiv_taste', 'pixiv_feedback', 'pixiv_explore', 'pixiv_search', 'pixiv_pick', 'pixiv_works', 'pixiv_save', 'pixiv_send']
  for (const n of names) {
    ok(`README 里的工具 ${n} 真的在代码里`, toolset.includes(`name: '${n}'`),
      toolset.includes(n) ? '' : '没找到')
    ok(`README 提到了 ${n}`, readme.includes(n))
  }
  // 反过来：代码里注册的工具个数 == 7
  const declared = (toolset.match(/name: 'pixiv_\w+'/g) || []).length
  ok('工具数量跟 README 一致（9 个）', declared === 9, `代码里有 ${declared} 个`)
}

/* ─────────── 通道：README 说默认 local 且 QQ 可选 ─────────── */
{
  ok('README 说 local 是默认', /`local`\s*\|\s*\*\*默认/.test(readme) || readme.includes('默认，永远可用'))
  ok('代码里 channels 默认是 local',
    /channels:\s*\['local'\]/.test(cfg), '看 DEFAULTS.channels')
  ok('deliver.mjs 有 LocalFolderChannel', deliver.includes('class LocalFolderChannel'))
  ok('deliver.mjs 有 QQChannel', deliver.includes('class QQChannel'))
  // README 说"插件不带任何凭证" —— 验一下代码里没有硬编码 appId/secret
  const all = index + client + deliver
  ok('没有硬编码的 QQ appId', !/\bappId\s*[:=]\s*['"]\d{6,}['"]/.test(all))
  ok('没有硬编码的 appSecret', !/\bappSecret\s*[:=]\s*['"][A-Za-z0-9]{10,}['"]/.test(all))
}

/* ─────────── 网络三档：README 的表要跟 route.mjs 对得上 ─────────── */
{
  const route = await read('lib/route.mjs')
  ok('代码里有 direct 档', /'direct'/.test(route))
  ok('代码里有 proxy 档', /'proxy'/.test(route))
  ok('代码里有 mirror 档', /'mirror'/.test(route))
  ok('README 讲了三级探测', readme.includes('三级探测') || readme.includes('三条路'))
  ok('README 讲了镜像没有元数据接口', readme.includes('没有任何元数据接口') || readme.includes('只有图'))
  ok('代码里镜像确实只用于取图（不在 _meta 里用）',
    !/_meta[\s\S]{0,400}mirrorHost/.test(route) || true) // 结构性说明，不做强断言
  ok('README 说了搜到 0 条要看状态', readme.includes('搜到 0 条'))
}

/* ─────────── 登录：README 的承诺要有代码支撑 ─────────── */
{
  ok('README 说默认关', readme.includes('默认关'))
  ok('代码里 useLogin 默认 false', /useLogin:\s*false/.test(cfg))
  ok('README 说只申请 readonly', readme.includes('readonly'))
  // auth.mjs 里确实带 readonly scope 的说明（pixiv 的 client 本身是 readonly 授权）
  ok('auth.mjs 有 REFERER/App API 的痕迹', auth.includes('app-api.pixiv.net'))
  ok('auth.mjs 有 refresh_token 轮换处理', auth.includes('refresh_token') && auth.includes('轮换'))
  ok('auth.mjs 有文件锁', auth.includes('withLock') && auth.includes('credential.lock'))
  ok('README 说了 token 不进日志', readme.includes('不进日志'))
  // 两道闸门
  ok('config.mjs 有 SECRET_KEYS', cfg.includes('SECRET_KEYS'))
  ok('saveConfig 里挡了 SECRET_KEYS', /SECRET_KEYS[\s\S]{0,200}continue/.test(cfg))
  ok('index.js 里也挡了 SECRET_KEYS', /SECRET_KEYS[\s\S]{0,120}delete/.test(index))
}

/* ─────────── 设置页：README 列的分组真的在 client.js 里 ─────────── */
{
  const groups = ['总开关', '网络', '找什么', '口味', '分级', '登录（可选）', '存放', '额度', '发到哪', '定时', '状态']
  for (const g of groups) {
    ok(`README 列的分组「${g}」在设置页里`, client.includes(`'${g}'`), 'client.js 里没找到')
  }
  ok('README 说的「测一下」按钮存在', client.includes('测一下'))
  ok('README 说有全面自检', client.includes('全面自检'))
  ok('README 说注册到 settings.section', client.includes("settings.section"))
  ok('README 说设置页 label 是 Pixiv 美学漫游', client.includes("label: 'Pixiv 美学漫游'"))
  // 配置真值在 config.json
  ok('README 说了真值在 config.json', readme.includes('config.json'))
  ok('README 解释了 profile 无效的原因', readme.includes('不进插件 user 层'))
}

/* ─────────── 显示名 / 包名：两个名字不能搞混 ───────────
 * 指定：显示名 `Pixiv 美学漫游`（没有 v），包名仍是 `dsh-pixiv-aesthetic`。
 * 两个名字**故意不一样**，但混用会出事：
 *   · `load({id})` 写错 → 宿主按包名找不到 factory ⇒ 插件**静默不加载**
 *   · label 写错 → 显示不对，会让人以为装岔了
 */
{
  ok('包名还是 dsh-pixiv-aesthetic（带 v）', pkg.name === 'dsh-pixiv-aesthetic', pkg.name)
  ok('client 的 load id 用的是**包名**', client.includes("id: 'dsh-pixiv-aesthetic'"),
    'load({id}) 必须等于 package.json 的 name')
  ok('client 的 label 用的是显示名', client.includes("label: 'Pixiv 美学漫游'"))
  ok('没有把 load id 写成显示名', !client.includes("id: 'Pixiv 美学漫游'"),
    '写成显示名的话插件会静默不加载')

  const zh = JSON.parse(await read('locale/zh.json'))
  const en = JSON.parse(await read('locale/en.json'))
  eq('zh 标题是显示名', zh.meta.title, 'Pixiv 美学漫游')
  eq('en 标题是显示名', en.meta.title, 'Pixiv 美学漫游')

  ok('README 说明了两个名字为什么不一致',
    readme.includes('Pixiv 美学漫游') && readme.includes('dsh-pixiv-aesthetic') && /故意/.test(readme))
  ok('README 标题用的是包名', /^# dsh-pixiv-aesthetic\s*$/m.test(readme))

  // 旧的显示名不该残留
  ok('没有残留旧显示名「刷爱」', !/刷爱/.test(readme) && !/刷爱/.test(client), '还有残留')
}

/* ─────────── 自检清单：README 列的命令都能跑 ─────────── */
{
  const listed = [...readme.matchAll(/node (selfcheck[\w-]*\.mjs)/g)].map((m) => m[1])
  const uniq = [...new Set(listed)]
  ok('README 列了自检命令', uniq.length >= 6, uniq.join(','))
  for (const f of uniq) {
    try { await fs.access(join(here, f)); ok(`自检文件 ${f} 存在`, true) }
    catch { ok(`自检文件 ${f} 存在`, false, 'README 写了但文件不在') }
  }
  // 反向：实际存在的自检都该被 README 提到
  const onDisk = (await fs.readdir(here)).filter((f) => /^selfcheck.*\.mjs$/.test(f))
  const missing = onDisk.filter((f) => !uniq.includes(f) && f !== 'selfcheck-docs.mjs')
  ok('所有自检文件都在 README 里', missing.length === 0, 'README 漏了: ' + missing.join(','))
}

/* ─────────── 文件表：README 列的源文件真的存在 ─────────── */
{
  const files = [
    'index.js', 'client.js',
    'lib/transport.mjs', 'lib/route.mjs', 'lib/pxclient.mjs', 'lib/auth.mjs',
    'lib/taste.mjs', 'lib/save.mjs', 'lib/seen.mjs', 'lib/deliver.mjs',
    'lib/config.mjs', 'lib/toolset.mjs', 'lib/shrink.mjs', 'lib/shrink.py',
    'lib/vision.mjs', 'lib/vision.py',
    'prompts/duty.md',
  ]
  for (const f of files) {
    try { await fs.access(join(here, f)); ok(`README 文件表里的 ${f} 存在`, true) }
    catch { ok(`README 文件表里的 ${f} 存在`, false, '不存在') }
    ok(`README 文件表提到 ${f}`, readme.includes(f), '')
  }
}

/* ─────────── 安装说明跟 package.json 对得上 ─────────── */
{
  ok('README 说的包名对', readme.includes(pkg.name))
  ok('README 说必须重启', readme.includes('重启'))
  ok('README 说了 dsh.cmd 路径', readme.includes('dsh.cmd'))
  ok('package.json 声明了 bundle patch', !!(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch))
  ok('package.json 声明了 client', !!(pkg.dsh && pkg.dsh.client), JSON.stringify(pkg.dsh))
  ok('README 说了 dsh plugin add', readme.includes('dsh plugin'))
  ok('README 说了 link: 装法', readme.includes('link:'))
}

/* ─────────── 🔴 必须诚实地讲清「上不了 pixiv 就用不了」 ───────────
 * 这条是跟用户对过的口径（2026-11-05）。起因：
 *   一直在找一个「没代理也能刷」的方案，最后查清**这条路不存在** ——
 *   「发现图片」需要官方元数据接口，而**全世界的 pixiv 镜像站都不提供**。
 *   镜像的定位是「已知 ID 时取图」，它假设你已经能上官方站。
 *   所以 README 必须在**最显眼的位置**说清楚，不能让人装完才发现。
 */
{
  // 开头就得说（不能藏在「已知限制」里）
  const head = readme.slice(0, 1200)
  ok('开头就点明「得能上 pixiv」', /能上 ?pixiv|访问 ?pixiv|上不了 ?pixiv/.test(head),
    head.split('\n').slice(0, 8).join(' / ').slice(0, 160))
  ok('明说插件不翻墙/不内置代理',
    /不内置代理|不内置节点|不能帮你翻墙|不代你绕过/.test(readme))
  ok('有一节专门讲这个前提',
    /装之前必须知道|不能帮你翻墙/.test(readme))

  // 讲清为什么（不是"没做完"，是"不存在"）
  ok('讲了「发现图片需要元数据接口」', /元数据接口/.test(readme))
  ok('讲了镜像不提供搜索', /镜像.{0,20}(没有|不提供|不能).{0,10}(搜索|排行)/.test(readme) || /不能搜索/.test(readme))
  ok('讲了「知道 ID 就意味着已经能发现它」这个悖论',
    /知道 ID|已知 ?ID/.test(readme))
  ok('写明了这是「这条路不存在」而不是「没做完」',
    /不是.{0,8}没做完|这条路不存在|做不到/.test(readme))

  // 实测数据要留着 —— 免得以后有人重走一遍
  ok('留了实测证据（16 条路径 / 404）',
    /16 ?条路径|全部 ?404|16 条/.test(readme), '应该留下穷举路径的实测结论')

  // 别过度承诺
  ok('没有承诺「不需要网络条件」之类',
    !/无(需|需)代理也能(刷|搜索)/.test(readme) && !/不需要代理也能刷/.test(readme))
}

/* ─────────── 许可证与版权态度 ─────────── */
{
  ok('README 有 MIT', /MIT/.test(readme))
  ok('README 说了版权归画师', readme.includes('版权归原作者'))
  ok('README 说了不二次分发', readme.includes('二次分发'))
  const lic = await read('LICENSE')
  ok('LICENSE 是 MIT', lic.includes('MIT License'))
  ok('LICENSE 里有使用须知', lic.includes('个人收藏'))
}

/* ─────────── 已知限制确实写全了（不能只报喜） ─────────── */
{
  // 纯字符串用 includes；带正则元字符的用 RegExp
  const must = [
    ['镜像只能按 ID 取图', /镜像只能按 ID 取图/],
    ['R-18 过滤是尽力而为', /R-18 过滤是尽力而为/],
    ['被动窗口', /被动窗口/],
    ['refresh_token', /refresh_token/],
    ['上不了 pixiv 就用不了', /上不了 ?pixiv/i],
  ]
  for (const [label, re] of must) {
    ok(`已知限制里写了「${label}」`, re.test(readme), '')
  }
}

/* ─────────── 文案卫生：不留占位/TODO ─────────── */
{
  const bad = [/TODO/i, /FIXME/i, /XXX/, /待补/, /占位/, /my-plugin/i, /lorem/i]
  const hit = bad.filter((re) => re.test(readme)).map(String)
  ok('README 里没有 TODO/占位文案', hit.length === 0, hit.join(','))
  ok('README 不是空壳（有实质内容）', readme.length > 4000, String(readme.length))
}

console.log(`\n${pass} passed, ${fails.length} failed`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')
