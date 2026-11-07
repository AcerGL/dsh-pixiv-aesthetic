/**
 * dsh-pixiv-aesthetic —— 浏览器半端（设置页里的「Pixiv 美学漫游」那一项）。
 * ============================================================================
 * ⚠️ client bundle **不是 ESM**，是自注册脚本（2026-10-14 从官方包挖出来的约定）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                        // ⚠️ 必须等于 package.json 的 name
 *       factory: (require) => { ... return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 * ⚠️ 分清两件事，别手滑：
 *     · **包名** = `dsh-pixiv-aesthetic`（带 v）→ `load({id})` 必须用它；
 *     · **显示名** = 「Pixiv 美学漫游」（给人看的，中文）→ 只出现在 label 和 locale。
 *       取这个是因为姊妹插件「刷B站」、参考实现「刷Pixiv」的显示名也是中文人话；
 *       原来那个 `dsh-pixi-scroll` 既不是包名也不像人话，是历史遗留。
 *   把 load 的 id 也改成显示名的话，插件会**静默不加载**（宿主按包名找 factory）。
 *
 * ⚠️ 怎么进「设置」：注册到 settings.section，label 就是左侧导航那一项。
 *    别自己糊一个标题栏按钮 + 全屏 overlay —— 那看着就跟别的插件不一样。
 *
 * ⚠️ 桌面版（Electron）走的是自定义协议，webServer 注册的路由**收不到请求**。
 *    所以 index.js 那边同时在 connection.fetch 上注册了一份；
 *    这里 resolveBase() 先试 /api/… 再退 /pixiv-scroll/api/…。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-pixiv-aesthetic',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /* ── 后端接口：两条通道都试 ──
     * 桌面版（Electron）走 /api/…（connection.fetch 注册的精确路由）；
     * 普通 web 版走 /pixiv-scroll/api/…（webServer 前缀路由）。
     *
     * ⚠️ 探测必须只看「通不通」，别把 404 当成功：
     *   桌面版里 /pixiv-scroll/api/… 会 404（webServer 路由收不到请求），
     *   而 404 也是「响应」，不判 ok 的话会误选到那条死路上去。
     */
    const CANDIDATES = ['/api/pixiv-scroll', '/pixiv-scroll/api']
    let basePromise = null
    const resolveBase = () => {
      if (basePromise) return basePromise
      basePromise = (async () => {
        for (const base of CANDIDATES) {
          try {
            const r = await fetch(base + '/ping', { credentials: 'same-origin' })
            if (r.ok) return base
          } catch { /* 试下一条 */ }
        }
        // 两条都不通：返回第一条，让调用方拿到如实的错误（而不是静默错在别处）
        return CANDIDATES[0]
      })()
      return basePromise
    }

    /* ⚠️ 必须看 res.ok —— 不然 HTTP 500 的 {ok:false} 会被当成"已保存/成功"，
     *    绿色提示把故障盖掉（刷B站那边踩过，2026-10-16 审查修的） */
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch((await resolveBase()) + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch((await resolveBase()) + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    /* ── 样式：只用 host 的 --dsw-alias-* 变量，别写死颜色 ── */
    const CSS = `
[data-px-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:660px;}
[data-px-sec]{display:flex;flex-direction:column;gap:8px;}
[data-px-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-px-row]{display:flex;align-items:center;gap:10px;}
[data-px-grow]{flex:1;min-width:0;}
[data-px-label]{font-size:13px;}
[data-px-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-px-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-px-sw][data-on]{background:#3b82f6;}
[data-px-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-px-sw][data-on] i{left:19px;}
[data-px-sw][disabled]{opacity:.45;cursor:default;}
[data-px-sub]{margin-left:14px;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
  display:flex;flex-direction:column;gap:10px;}
[data-px-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  background:var(--dsw-alias-bg-base,rgba(127,127,127,.08));color:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));outline:none;font-family:inherit;}
[data-px-input]:focus{border-color:#3b82f6;}
[data-px-num]{width:88px;box-sizing:border-box;padding:6px 8px;border-radius:8px;font-size:12px;
  background:var(--dsw-alias-bg-base,rgba(127,127,127,.08));color:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));outline:none;font-family:inherit;}
[data-px-btn]{padding:6px 13px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));white-space:nowrap;}
[data-px-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.24));}
[data-px-btn][disabled]{opacity:.5;cursor:default;}
[data-px-btn][data-primary]{background:#3b82f6;color:#fff;border-color:#3b82f6;}
[data-px-btn][data-danger]{color:#ef4444;}
[data-px-st]{padding:9px 11px;border-radius:8px;font-size:12px;line-height:18px;white-space:pre-wrap;
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));
  background:var(--dsw-alias-bg-base,rgba(127,127,127,.06));}
[data-px-st][data-tone="ok"]{border-color:rgba(34,197,94,.5);}
[data-px-st][data-tone="warn"]{border-color:rgba(234,179,8,.55);}
[data-px-st][data-tone="bad"]{border-color:rgba(239,68,68,.55);}
/* ── 浮窗（右侧停靠面板）──
   列宽有限（默认视口 45%），所以做成自适应网格：窄了自动少列。
   ⚠️ 用 auto-fill + minmax，别写死列数 —— 用户会拖宽。 */
/* 标签条上的标题 chip —— 注册进 sidebar.right.pane.tab.title 的那个组件。
   ⚠️ 别给它加外边距/内边距：它嵌在宿主的标签条里，宿主管布局，
      我们只管文字本身，否则会跟别的 tab 对不齐。 */
[data-px-tabtitle]{font-size:12px;line-height:1;white-space:nowrap;}
[data-px-pane]{display:flex;flex-direction:column;gap:10px;padding:10px 10px 16px;height:100%;box-sizing:border-box;overflow:auto;}
[data-px-panehead]{display:flex;align-items:center;justify-content:space-between;gap:8px;
  font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-px-grid]{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));}
[data-px-card]{display:flex;flex-direction:column;gap:5px;min-width:0;}
[data-px-thumb]{width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:8px;display:block;
  background:var(--dsw-alias-bg-overlay,rgba(127,127,127,.12));
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));}
[data-px-meta]{display:flex;flex-direction:column;gap:1px;min-width:0;}
[data-px-t]{font-size:11px;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-px-a]{font-size:10px;line-height:13px;color:var(--dsw-alias-label-tertiary,#9aa0a6);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-px-acts]{display:flex;gap:4px;}
[data-px-mini]{flex:1;padding:3px 0;border-radius:6px;font-size:11px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));
  background:transparent;color:inherit;line-height:16px;}
[data-px-mini]:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.24));}
[data-px-mini][disabled]{opacity:.45;cursor:default;}
[data-px-mini][data-on]{border-color:#3b82f6;color:#3b82f6;}
/* 标记过的卡片给个视觉反馈，省得用户不确定点了没 */
[data-px-card][data-px-mark]{opacity:.75;}
[data-px-card][data-px-mark="no"] [data-px-thumb]{filter:grayscale(1);}
[data-px-card][data-px-mark="saved"] [data-px-thumb]{outline:2px solid rgba(34,197,94,.6);}
[data-px-msg]{white-space:pre-wrap;}
[data-px-chips]{display:flex;flex-wrap:wrap;gap:6px;}[data-px-chip]{padding:3px 9px;border-radius:999px;font-size:11px;cursor:pointer;
  background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));}
[data-px-chip][data-on]{background:#3b82f6;color:#fff;border-color:#3b82f6;}
[data-px-kv]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
`

    /* ── 小组件 ── */
    const Sec = ({ title, children }) =>
      h('div', { 'data-px-sec': '' }, title ? h('div', { 'data-px-h': '' }, title) : null, children)

    const Note = ({ children }) => h('div', { 'data-px-note': '' }, children)

    const Sw = ({ on, onChange, disabled }) =>
      h('button', {
        'data-px-sw': '', 'data-on': on ? '' : undefined, disabled: !!disabled,
        onClick: () => !disabled && onChange(!on),
        'aria-pressed': on ? 'true' : 'false', role: 'switch', 'aria-checked': on ? 'true' : 'false',
      }, h('i', null))

    const Row = ({ label, note, children }) =>
      h('div', { 'data-px-row': '' },
        h('div', { 'data-px-grow': '' },
          h('div', { 'data-px-label': '' }, label),
          note ? h('div', { 'data-px-note': '' }, note) : null),
        children)

    const Chip = ({ on, onClick, children }) =>
      h('span', { 'data-px-chip': '', 'data-on': on ? '' : undefined, onClick }, children)

    const Btn = ({ onClick, children, primary, danger, disabled }) =>
      h('button', {
        'data-px-btn': '', 'data-primary': primary ? '' : undefined,
        'data-danger': danger ? '' : undefined, disabled: !!disabled, onClick,
      }, children)

    /* ══════════════════════ 主面板 ══════════════════════ */
    function Panel() {
      const [cfg, setCfg] = React.useState(null)
      const [def, setDef] = React.useState({})
      const [home, setHome] = React.useState('')
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [check, setCheck] = React.useState(null)
      const [status, setStatus] = React.useState('')   // 保存提示
      const [kwDraft, setKwDraft] = React.useState('')
      const [tokDraft, setTokDraft] = React.useState('')
      const [loginInfo, setLoginInfo] = React.useState(null)

      const load = async () => {
        try {
          const r = await jget('/config')
          setCfg(r.config)
          setDef(r.defaults || {})
          setHome(r.home || '')
          setErr('')
        } catch (e) { setErr(String(e.message || e)) }
      }
      React.useEffect(() => { load() }, [])

      // 每次改动立刻存（不用「保存」按钮 —— 刷B站那边也是这个手感）
      const save = async (patch, okMsg) => {
        setStatus('')
        try {
          const r = await jpost('/config', patch)
          setCfg(r.config)
          if (okMsg) { setStatus(okMsg); setTimeout(() => setStatus(''), 2200) }
        } catch (e) { setErr(String(e.message || e)) }
      }

      const runCheck = async () => {
        setBusy('check'); setCheck(null)
        try {
          const r = await jget('/check')
          setCheck(r)
        } catch (e) { setCheck({ ok: false, why: String(e.message || e) }) }
        setBusy('')
      }

      const doLoginCheck = async () => {
        setBusy('login'); setLoginInfo(null)
        try {
          const r = await jpost('/login/who', {})
          setLoginInfo(r)
        } catch (e) { setLoginInfo({ ok: false, why: String(e.message || e) }) }
        setBusy('')
      }

      const doLoginSet = async () => {
        const t = tokDraft.trim()
        if (!t) return
        setBusy('set'); setLoginInfo(null)
        try {
          const r = await jpost('/login/token', { refreshToken: t })
          setLoginInfo(r)
          if (r.ok) { setTokDraft(''); setStatus('登录成功'); setTimeout(() => setStatus(''), 2500) }
        } catch (e) { setLoginInfo({ ok: false, why: String(e.message || e) }) }
        setBusy('')
      }

      const doLogout = async () => {
        setBusy('out'); setLoginInfo(null)
        try {
          const r = await jpost('/login/logout', {})
          setLoginInfo({ ok: true, why: '已退出登录' })
          await load()
        } catch (e) { setLoginInfo({ ok: false, why: String(e.message || e) }) }
        setBusy('')
      }

      if (err && !cfg) {
        return h('div', { 'data-px-page': '' },
          h('div', { 'data-px-st': '', 'data-tone': 'bad' },
            '读不到插件配置：' + err + '\n（插件还没被宿主挂上，或者需要重启一次 DSH）'))
      }
      if (!cfg) return h('div', { 'data-px-page': '' }, h(Note, null, '读取配置中…'))

      const modes = ['daily', 'weekly', 'monthly', 'rookie', 'original']
      const modeLabel = { daily: '今日', weekly: '本周', monthly: '本月', rookie: '新人', original: '原创' }

      return h('div', { 'data-px-page': '' },

        /* ── 总开关 ── */
        h(Sec, { title: '总开关' },
          h(Row, { label: '启用插件', note: '关了就完全不动（定时轮也不跑）' },
            h(Sw, { on: cfg.enabled, onChange: (v) => save({ enabled: v }, v ? '已启用' : '已停用') })),
          status ? h(Note, null, '✓ ' + status) : null),

        /* ── 网络 ── */
        h(Sec, { title: '网络' },
          h(Row, {
            label: '外部源',
            note: '★ 一个**能上 pixiv** 的地址，兼容 pixiv 官方接口形态。\n' +
              '填了就走它（优先级最高）。你的机器上不去 pixiv 时，用这个接上你自己的反代 / 自己的服务器 / 能连 pixiv 的客户端。\n' +
              '例：http://127.0.0.1:8080 或 https://你的反代.example.com',
          }),
          h('input', {
            'data-px-input': '', value: cfg.externalApi || '',
            placeholder: 'http://127.0.0.1:8080（留空 = 不用外部源）',
            onChange: (e) => setCfg({ ...cfg, externalApi: e.target.value }),
            onBlur: (e) => save({ externalApi: e.target.value }, '外部源已保存'),
          }),
          h(Row, {
            label: '代理地址',
            note: '留空 = 直连。国内常见填 http://127.0.0.1:7897（Clash 之类）。\n插件会按「外部源 → 直连 → 代理」的顺序挑通的那条。',
          }),
          h('input', {
            'data-px-input': '', value: cfg.proxyUrl || '', placeholder: 'http://127.0.0.1:7897（留空直连）',
            onChange: (e) => setCfg({ ...cfg, proxyUrl: e.target.value }),
            onBlur: (e) => save({ proxyUrl: e.target.value }, '代理已保存'),
          }),
          h(Row, { label: '图片镜像', note: '官方取不到图时的兜底。默认 pixiv.re' }),
          h('input', {
            'data-px-input': '', value: cfg.mirrorHost || '',
            onChange: (e) => setCfg({ ...cfg, mirrorHost: e.target.value }),
            onBlur: (e) => save({ mirrorHost: e.target.value }, '镜像已保存'),
          }),
          h('div', { 'data-px-row': '' },
            h(Btn, { onClick: runCheck, disabled: busy === 'check' },
              busy === 'check' ? '检测中…' : '测一下'),
            h(Note, null, '看网络通不通、通道能不能用')),
          check ? h(CheckView, { r: check }) : null),

        /* ── 找什么 ── */
        h(Sec, { title: '找什么' },
          h(Row, {
            label: '关键词',
            note: '中文/日文/英文标签都行。留空 = 只刷排行榜（零配置也能用）',
          }),
          h('div', { 'data-px-row': '' },
            h('input', {
              'data-px-input': '', value: kwDraft, placeholder: '输入一个标签，回车加进去',
              onChange: (e) => setKwDraft(e.target.value),
              onKeyDown: (e) => {
                if (e.key !== 'Enter') return
                const v = kwDraft.trim()
                if (!v) return
                const next = [...(cfg.keywords || [])]
                if (!next.includes(v)) next.push(v)
                setKwDraft('')
                save({ keywords: next }, '已加入关键词')
              },
            })),
          (cfg.keywords || []).length
            ? h('div', { 'data-px-chips': '' },
                ...(cfg.keywords || []).map((k) => h(Chip, {
                  key: k, on: true,
                  onClick: () => save({ keywords: (cfg.keywords || []).filter((x) => x !== k) }, '已移除'),
                }, k + ' ✕')))
            : h(Note, null, '（还没加关键词，现在只刷排行榜）'),

          h(Row, { label: '排行榜池塘', note: '没关键词时刷这些' }),
          h('div', { 'data-px-chips': '' },
            ...modes.map((m) => h(Chip, {
              key: m, on: (cfg.rankModes || []).includes(m),
              onClick: () => {
                const cur = cfg.rankModes || []
                const next = cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]
                if (!next.length) return
                save({ rankModes: next }, '池塘已更新')
              },
            }, modeLabel[m])))),

        /* ── 口味 ── */
        h(Sec, { title: '口味' },
          h(Row, { label: '排除标签', note: '命中任一就淘汰。用逗号分隔' }),
          h('input', {
            'data-px-input': '', defaultValue: (cfg.excludeTags || []).join(', '),
            placeholder: '例如：漫画, グロ',
            onBlur: (e) => save({
              excludeTags: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
            }, '排除标签已保存'),
          }),
          h(Row, { label: '必须标签', note: '全都要有才留下（AND）。用逗号分隔' }),
          h('input', {
            'data-px-input': '', defaultValue: (cfg.requireTags || []).join(', '),
            placeholder: '留空 = 不限制',
            onBlur: (e) => save({
              requireTags: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
            }, '必须标签已保存'),
          }),
          h(Row, { label: '收藏数下限', note: '0 = 不限' },
            h('input', {
              'data-px-num': '', type: 'number', min: 0, value: cfg.minBookmarks,
              onChange: (e) => setCfg({ ...cfg, minBookmarks: Number(e.target.value) }),
              onBlur: (e) => save({ minBookmarks: Number(e.target.value) }, '已保存'),
            })),
          h(Row, { label: '只看最近几天', note: '0 = 不限时间' },
            h('input', {
              'data-px-num': '', type: 'number', min: 0, value: cfg.maxAgeDays,
              onChange: (e) => setCfg({ ...cfg, maxAgeDays: Number(e.target.value) }),
              onBlur: (e) => save({ maxAgeDays: Number(e.target.value) }, '已保存'),
            }))),

        /* ── 分级 ── */
        h(Sec, { title: '分级' },
          h(Row, {
            label: '收 R-18',
            note: '默认关。过滤是**尽力而为**：只按标签和内容标记，不逐张读图复查，会有漏网。',
          }, h(Sw, { on: cfg.allowR18, onChange: (v) => save({ allowR18: v }, v ? '已开（会收到限制级内容）' : '已关') })),
          h(Row, { label: '过滤 AI 生成', note: '按作品的 AI 标记过滤' },
            h(Sw, { on: cfg.dropAiGenerated, onChange: (v) => save({ dropAiGenerated: v }, '已保存') }))),

        /* ── 登录（可选） ── */
        h(Sec, { title: '登录（可选）' },
          h(Note, null,
            '不登录也能用（游客模式：排行榜 + 搜索）。\n' +
            '登录后能多拿「关注流」和「个性化推荐」—— 这才是真正按你口味的。\n' +
            '⚠️ 只申请只读权限，不可能点赞/收藏/关注。token 只存在本地凭证文件里，不进配置、不进日志。'),
          h(Row, { label: '使用登录', note: '关着就是游客模式' },
            h(Sw, { on: cfg.useLogin, onChange: (v) => save({ useLogin: v }, v ? '已开启（还需贴 token）' : '已关闭登录') })),
          cfg.useLogin ? h('div', { 'data-px-sub': '' },
            h(Row, { label: '额外刷哪些', note: '登录才有意义的池子' }),
            h('div', { 'data-px-chips': '' },
              ...[['follow', '关注流'], ['recommend', '个性化推荐']].map(([k, lbl]) =>
                h(Chip, {
                  key: k, on: (cfg.loginSources || []).includes(k),
                  onClick: () => {
                    const cur = cfg.loginSources || []
                    const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]
                    save({ loginSources: next }, '已更新')
                  },
                }, lbl))),

            h(Row, { label: 'refresh_token', note: '在设置页贴一次就行。它会自动刷新，你不用管' }),
            h('div', { 'data-px-row': '' },
              h('input', {
                'data-px-input': '', type: 'password', value: tokDraft, placeholder: '粘贴 refresh_token',
                onChange: (e) => setTokDraft(e.target.value),
              }),
              h(Btn, { onClick: doLoginSet, primary: true, disabled: busy === 'set' || !tokDraft.trim() },
                busy === 'set' ? '验证中…' : '登录'),
              h(Btn, { onClick: doLoginCheck, disabled: busy === 'login' }, busy === 'login' ? '…' : '查看状态'),
              h(Btn, { onClick: doLogout, danger: true, disabled: busy === 'out' }, '退出'),
            ),
            loginInfo ? h('div', { 'data-px-st': '', 'data-tone': loginInfo.ok ? 'ok' : 'bad' },
              loginInfo.ok
                ? (loginInfo.text || loginInfo.why || '好')
                : ('失败：' + (loginInfo.why || '未知'))) : null,
            h(Note, null, '贴进来的 token 只用于换访问令牌，验证通过后才落盘；输入框里不会回显。'),
          ) : null),

        /* ── 存放 ── */
        h(Sec, { title: '存放' },
          h(Row, { label: '保存根目录', note: '留空 = ' + (home ? home + '\\library' : '插件家目录\\library') }),
          h('input', {
            'data-px-input': '', value: cfg.saveRoot || '', placeholder: '例如 D:\\Pixiv（留空用默认）',
            onChange: (e) => setCfg({ ...cfg, saveRoot: e.target.value }),
            onBlur: (e) => save({ saveRoot: e.target.value }, '保存目录已保存'),
          }),
          h(Row, { label: '目录模板', note: '可用：{artist} {title} {id} {kind}。必须含 {id}，否则不同作品会撞在一起' }),
          h('input', {
            'data-px-input': '', value: cfg.dirTemplate || '',
            onChange: (e) => setCfg({ ...cfg, dirTemplate: e.target.value }),
            onBlur: (e) => save({ dirTemplate: e.target.value }, '模板已保存'),
          })),

        /* ── 额度 ── */
        h(Sec, { title: '额度' },
          h(Row, { label: '每天最多存', note: '件。0 = 不限（不建议）' },
            h('input', {
              'data-px-num': '', type: 'number', min: 0, value: cfg.perDay,
              onChange: (e) => setCfg({ ...cfg, perDay: Number(e.target.value) }),
              onBlur: (e) => save({ perDay: Number(e.target.value) }, '已保存'),
            })),
          h(Row, { label: '每轮最多挑', note: '件' },
            h('input', {
              'data-px-num': '', type: 'number', min: 1, value: cfg.perRound,
              onChange: (e) => setCfg({ ...cfg, perRound: Number(e.target.value) }),
              onBlur: (e) => save({ perRound: Number(e.target.value) }, '已保存'),
            })),
          h(Row, { label: '单件最多存几页', note: '漫画可能几十页' },
            h('input', {
              'data-px-num': '', type: 'number', min: 1, value: cfg.maxPagesPerWork,
              onChange: (e) => setCfg({ ...cfg, maxPagesPerWork: Number(e.target.value) }),
              onBlur: (e) => save({ maxPagesPerWork: Number(e.target.value) }, '已保存'),
            }))),

        /* ── 投递 ── */
        h(Sec, { title: '发到哪' },
          h(Note, null,
            'DSH 的聊天框**不支持助手发图**（官方附件只做用户→模型），所以图只能经通道送出去。\n' +
            '「存到本地」永远可用；QQ 要你自己配机器人，且只在收到消息后约 5 分钟内能主动回。'),
          h('div', { 'data-px-chips': '' },
            ...[['local', '存到本地'], ['qq', '发到 QQ']].map(([k, lbl]) =>
              h(Chip, {
                key: k, on: (cfg.channels || []).includes(k),
                onClick: () => {
                  const cur = cfg.channels || []
                  let next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]
                  if (!next.includes('local')) next = ['local', ...next] // 本地永远保留当兜底
                  save({ channels: next }, '已更新')
                },
              }, lbl))) ),

        /* ── 定时 ── */
        h(Sec, { title: '定时' },
          h(Row, { label: '自动刷', note: '0 = 不定时。单位：分钟' },
            h('input', {
              'data-px-num': '', type: 'number', min: 0, value: cfg.intervalMin,
              onChange: (e) => setCfg({ ...cfg, intervalMin: Number(e.target.value) }),
              onBlur: (e) => save({ intervalMin: Number(e.target.value) }, '已保存'),
            })),
          h(Row, { label: '只在谷时跑', note: '工作日 9–12 / 14–18 是高峰，其余算谷时' },
            h(Sw, { on: cfg.peakValley, onChange: (v) => save({ peakValley: v }, '已保存') })),
          cfg.peakValley ? h('div', { 'data-px-sub': '' },
            h(Row, { label: '中午（12–14）', note: '' },
              h(Sw, { on: cfg.noon, onChange: (v) => save({ noon: v }, '已保存') })),
            h(Row, { label: '晚上/夜间（18–9）', note: '' },
              h(Sw, { on: cfg.night, onChange: (v) => save({ night: v }, '已保存') })),
          ) : null),

        /* ── 状态 ── */
        h(Sec, { title: '状态' },
          h('div', { 'data-px-kv': '' },
            '插件家目录：' + (home || '(未知)') + '\n' +
            '配置文件：' + (home ? home + '\\config.json' : '(未知)') + '\n' +
            '  真值是这份文件 —— 改 profile 的 cordis.patch.yml 对运行期无效。'),
          h('div', { 'data-px-row': '' },
            h(Btn, { onClick: runCheck, disabled: busy === 'check' },
              busy === 'check' ? '检测中…' : '全面自检')),
          check ? h(CheckView, { r: check }) : null),
      )
    }

    /** 自检结果渲染 —— 说人话，别只丢 JSON */
    function CheckView({ r }) {
      const net = r.network || {}
      const tone = net.ok ? 'ok' : (net.mirror ? 'warn' : 'bad')
      const lines = []
      lines.push('网络：' + (net.text || '（没结果）').replace(/\n\s*/g, '\n      '))
      if (r.login) lines.push('登录：' + (r.login.text || '—'))
      if (r.quota) lines.push(`额度：今天已存 ${r.quota.used}/${r.quota.limit}，还能 ${r.quota.left}`)
      if (Array.isArray(r.channels)) {
        lines.push('通道：' + r.channels.map((c) => `${c.label}${c.ok ? ' ✓' : ' ✗'}${c.ok ? '' : '（' + c.why + '）'}`).join('\n      '))
      }
      if (r.saveRoot) lines.push('存到：' + r.saveRoot)
      return h('div', { 'data-px-st': '', 'data-tone': tone }, lines.join('\n'))
    }

    /**
     * 浮窗的两个 tab 正文。
     * ============================================================================
     * 为什么走「右侧停靠面板」而不是自己糊浮层：
     *   官方 `dsh-client-ui-sidebar-right` 就是干这个的 —— 它管停靠、拖宽、
     *   全屏、以及"浮出为独立浮窗"（dockkit 的 float/dock）。
     *   自己糊一个全屏 overlay 会跟别的插件长得不一样（bili-scroll 踩过，注释里记着）。
     *
     * 🔴 注册要**三步**，少一步 tab 就出不来（2026-11-07 实测踩到，面板始终只有一个
     *    思考小窗、两个 tab 根本不出现）。官方那几个插件（ui-plan / ui-schedule）
     *    的写法是：
     *
     *    ① `ctx.sidebarRightTabs.register({ id, kind, patterns, priority, canOpen, title })`
     *       —— 声明"有这么一类 tab"
     *    ② `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
     *          { name: 'sidebar.right.pane.tab', key: <id>, locale: NS }, Body))`
     *       —— 这个 tab 的**正文**
     *    ③ `ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
     *          { name: 'sidebar.right.pane.tab.title', key: <id>, locale: NS }, Title))`
     *       —— 这个 tab 在标签条上的**标题 chip**
     *
     *   之前只做了 ① 和 ② 的一半（②还没给 locale），**③ 完全没做** ⇒
     *   宿主侧 tab 类型存在、但渲染标签条时找不到标题组件，于是整个 tab 不显示。
     *   而且没有一个地方去 `openTab`，所以就算注册好了也不会自己冒出来。
     * ============================================================================
     */
    const PANE_TABS = [
      { kind: 'pixiv-board', id: 'dsh-pixiv-aesthetic/board', title: '这一轮' },
      { kind: 'pixiv-library', id: 'dsh-pixiv-aesthetic/library', title: '图库' },
    ]

    /** 标签条上的标题 chip —— 官方给的是个组件，不是一个字符串 */
    const makeTitle = (text) => function PaneTitle() {
      return h('span', { 'data-px-tabtitle': '' }, text)
    }

    /**
     * 把 client 半端的异常报给宿主，落成 ~/.dsh/pixiv-scroll/client-error.log。
     *
     * 🔴 为什么非要有这个（2026-11-07 踩到，代价是 DSH 起不来）：
     *    client apply 抛异常时，宿主只把 entry 标成 failed，界面弹一句
     *    「N 个插件未能激活」，**不给任何具体原因**；浏览器控制台我们也看不到
     *    （DSH 自己的窗口不给控制）。没有这条路，就只能靠猜 —— 我这次就猜错了。
     *
     * ⚠️ 上报本身绝不能再抛：它是在错误处理路径上跑的，
     *    再炸一次会把 apply 也带下去，那就回到"启动失败"了。
     */
    const reportClientError = async (where, err) => {
      try {
        const base = await resolveBase()
        const payload = {
          where: String(where || '?'),
          message: String((err && err.message) || err || '?'),
          stack: String((err && err.stack) || ''),
          ua: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
        }
        await fetch(base + '/client-error', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } catch { /* 上报失败也绝不能影响宿主 */ }
    }

    /** 图片接口的完整地址（要兼容 web/connection 两条通道） */
    const imgApi = async (path) => (await resolveBase()) + path

    /**
     * 缩略图地址 —— 交给 `<img src>` 用。
     *
     * ⚠️ 为什么不让浏览器直连 i.pximg.net：
     *   ① pximg 有防盗链（要 Referer）
     *   ② 本机直连 pixiv 不通，得走插件的网络层
     * 两条浏览器都做不到，所以走插件接口代取。
     *
     * ⚠️ 这里**同步**返回地址（`<img>` 要的是字符串，不能 await）——
     *    所以 base 用一次探测的结果缓存住，别每张图都探一遍。
     */
    let _baseCache = null
    const ensureBase = () => { if (!_baseCache) resolveBase().then((b) => { _baseCache = b }).catch(() => {}) }
    const thumbSrc = (id, page = 0) => {
      ensureBase()
      const b = _baseCache || ''
      return `${b}/thumb?id=${encodeURIComponent(id)}&page=${page}`
    }
    const fileSrc = (rel) => {
      ensureBase()
      const b = _baseCache || ''
      return `${b}/file?p=${encodeURIComponent(rel)}`
    }

    /** 「这一轮」：显示最近一次推荐，能点选、能存 */
    const BoardBody = (props) => {
      const [data, setData] = React.useState({ items: [], at: '', label: '' })
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [picked, setPicked] = React.useState({})   // id -> 'like' | 'no'

      const load = async () => {
        try {
          const r = await jget('/board')
          setData(r)
          setErr('')
        } catch (e) { setErr(String(e.message || e)) }
      }
      React.useEffect(() => { load() }, [])

      /** 反馈：这一下就是"在浮窗上选择" */
      const send = async (id, action, extra) => {
        setBusy(id + action)
        try {
          const r = await jpost('/feedback', { action, id, ...(extra || {}) })
          setMsg(r && r.text ? r.text : '已记录')
          setPicked((p) => ({ ...p, [id]: action === 'unlike' ? 'no' : 'like' }))
        } catch (e) { setMsg('没成功：' + String(e.message || e)) }
        setBusy('')
      }

      const save = async (id) => {
        setBusy(id + 'save')
        try {
          const r = await jpost('/save', { id })
          setMsg(r && r.ok ? `已收进图库：${r.title || id}` : `没存：${(r && r.reason) || '未知'}`)
          // 存了就不再是"候选"了
          setPicked((p) => ({ ...p, [id]: 'saved' }))
        } catch (e) { setMsg('存失败：' + String(e.message || e)) }
        setBusy('')
      }

      if (err) return h('div', { 'data-px-note': '' }, '读取失败：' + err)
      if (!data.items || !data.items.length) {
        return h('div', { 'data-px-pane': '' },
          h('div', { 'data-px-note': '' }, '还没有这一轮的结果。'),
          h('div', { 'data-px-note': '' }, '让助手跑一次搜索/漫游，推出来的图会出现在这儿。'),
          h('button', { 'data-px-btn': '', onClick: load }, '刷新'))
      }

      return h('div', { 'data-px-pane': '' },
        h('div', { 'data-px-panehead': '' },
          h('span', null, `${data.items.length} 条${data.label ? ' · ' + data.label : ''}`),
          h('button', { 'data-px-btn': '', onClick: load }, '刷新')),
        msg ? h('div', { 'data-px-note': '', 'data-px-msg': '' }, msg) : null,
        h('div', { 'data-px-grid': '' },
          data.items.map((it) => {
            const mark = picked[it.id]
            return h('div', { 'data-px-card': '', 'data-px-mark': mark || undefined, key: it.id },
              h('img', { 'data-px-thumb': '', src: thumbSrc(it.id), loading: 'lazy', alt: it.title || '', title: it.title || '' }),
              h('div', { 'data-px-meta': '' },
                h('div', { 'data-px-t': '', title: it.title || '' }, it.title || `#${it.id}`),
                h('div', { 'data-px-a': '' }, it.artist || '')),
              h('div', { 'data-px-acts': '' },
                h('button', {
                  'data-px-mini': '', 'data-on': mark === 'like' ? '' : undefined,
                  disabled: busy === it.id + 'more_like_this',
                  onClick: () => send(it.id, 'more_like_this'),
                  title: '喜欢，多来点这种',
                }, '👍'),
                h('button', {
                  'data-px-mini': '', 'data-on': mark === 'no' ? '' : undefined,
                  disabled: busy === it.id + 'unlike',
                  onClick: () => send(it.id, 'unlike'),
                  title: '不喜欢这一张（不会牵连它的标签）',
                }, '👎'),
                h('button', {
                  'data-px-mini': '',
                  disabled: busy === it.id + 'save' || mark === 'saved',
                  onClick: () => save(it.id),
                  title: '收进图库',
                }, mark === 'saved' ? '✓' : '存')))
          })))
    }

    /** 「图库」：显示已经存下来的图 */
    const LibraryBody = (props) => {
      const [data, setData] = React.useState({ items: [] })
      const [err, setErr] = React.useState('')
      const [msg, setMsg] = React.useState('')

      const load = async () => {
        try {
          const r = await jget('/library')
          setData(r)
          setErr('')
        } catch (e) { setErr(String(e.message || e)) }
      }
      React.useEffect(() => { load() }, [])

      const reveal = async (rel) => {
        try {
          const r = await jpost('/reveal', { p: rel })
          setMsg(r && r.ok ? '已在文件管理器里打开' : ('打不开：' + ((r && r.why) || '未知')))
        } catch (e) { setMsg('打不开：' + String(e.message || e)) }
      }

      if (err) return h('div', { 'data-px-note': '' }, '读取失败：' + err)
      if (!data.items || !data.items.length) {
        return h('div', { 'data-px-pane': '' },
          h('div', { 'data-px-note': '' }, '图库还是空的。'),
          h('div', { 'data-px-note': '' }, `存到：${data.root || '（未知）'}`),
          h('button', { 'data-px-btn': '', onClick: load }, '刷新'))
      }

      return h('div', { 'data-px-pane': '' },
        h('div', { 'data-px-panehead': '' },
          h('span', null, `${data.count} 件`),
          h('button', { 'data-px-btn': '', onClick: load }, '刷新')),
        msg ? h('div', { 'data-px-note': '', 'data-px-msg': '' }, msg) : null,
        h('div', { 'data-px-grid': '' },
          data.items.map((it) => h('div', { 'data-px-card': '', key: it.rel, title: it.name },
            h('img', { 'data-px-thumb': '', src: fileSrc(it.rel), loading: 'lazy', alt: it.name || '' }),
            h('div', { 'data-px-meta': '' },
              h('div', { 'data-px-t': '', title: it.name }, (it.name || '').replace(/_\d+$/, '')),
              h('div', { 'data-px-a': '' }, `${it.pages} 页`)),
            h('div', { 'data-px-acts': '' },
              h('button', { 'data-px-mini': '', onClick: () => reveal(it.rel), title: '在文件管理器里打开' }, '📂'))))))
    }

    return {
      /**
       * ⚠️ inject 里只放**真的必需**的服务。
       *
       * 踩过的坑（2026-11-07）：原来这里是
       *     inject: ['slots', 'sidebarRightTabs', 'sidebarRight']
       * 看着合理，实际有个要命的行为 —— **inject 里的服务缺任何一个，
       * 宿主就不跑 apply()**。于是只要 `sidebarRight` 这个名字对不上
       * （或者宿主某个版本没提供），**整块 client 逻辑全都不执行**：
       * 不只是浮窗没有，连「设置页」那一项也一起消失，而且**一点报错都没有**。
       *
       * 所以：只把 `slots` 当硬依赖；浮窗那两个服务在 apply() 里现取，
       * 拿不到就降级（设置页照常工作，只少浮窗）。
       */
      inject: ['slots'],
      apply(ctx) {
        const step = (where, fn) => {
          try { return fn() } catch (e) {
            try { console.error('[pixiv-aesthetic] ' + where, e) } catch { /* ignore */ }
            reportClientError(where, e)
            return undefined
          }
        }

        // 样式挂一次，卸载时收掉
        step('样式', () => {
          const style = document.createElement('style')
          style.textContent = CSS
          document.head.appendChild(style)
          ctx.effect(() => () => style.remove(), 'dsh-pixiv-aesthetic: 设置页样式')
        })

        const slots = step('取 slots', () => ((typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots))
        if (!slots || typeof slots.register !== 'function' || typeof slots.inject !== 'function') {
          reportClientError('slots 不可用', new Error(
            'slots=' + String(slots) + ' register=' + typeof (slots && slots.register) +
            ' inject=' + typeof (slots && slots.inject)))
          return
        }

        step('设置页', () => slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'pixiv-scroll', order: 31, label: 'Pixiv 美学漫游' },
          () => h(Panel),
        )))

        /* ── 浮窗：注册两个 tab（这一轮 / 图库）──
         *
         * ⚠️ 这两个服务是**可选**的：拿不到就只少浮窗，设置页不受影响。
         *    别再放回 inject —— 那样会连设置页一起带走。
         */
        const tabs = step('取 sidebarRightTabs', () => ((typeof ctx.get === 'function' ? ctx.get('sidebarRightTabs') : undefined) || ctx.sidebarRightTabs))
        const side = step('取 sidebarRight', () => ((typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined) || ctx.sidebarRight))
        if (!tabs || typeof tabs.register !== 'function') {
          // 宿主没给这个席位就别硬来 —— 如实留痕，但**不阻断**设置页
          reportClientError('sidebarRightTabs 不可用', new Error('sidebarRightTabs=' + String(tabs)))
          return
        }

        const bodies = { 'pixiv-board': BoardBody, 'pixiv-library': LibraryBody }

        for (const t of PANE_TABS) {
          // ① 声明这一"类" tab 存在
          step(`tab 类型 ${t.kind}`, () => ctx.effect(() => tabs.register({
            id: t.id,
            kind: t.kind,
            priority: 'builtin',
            title: () => t.title,
            // canOpen：宿主判断"这条资源该不该用本 tab 打开"。
            // 我们不是资源型 tab，所以只认自己的 id。
            canOpen: (address) => String(address || '') === t.id,
          }), `pixiv-aesthetic: tab 类型 ${t.kind}`))

          // ② 正文
          step(`tab 正文 ${t.kind}`, () => ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register(
            { name: 'sidebar.right.pane.tab', key: t.id },
            bodies[t.kind],
          )), `pixiv-aesthetic: tab 正文 ${t.kind}`))

          // ③ 🔴 标题 chip —— **漏了这个 tab 就整条不显示**（这次踩到的就是它）
          step(`tab 标题 ${t.kind}`, () => ctx.effect(() => slots.inject('sidebar.right.pane.tab.title', () => slots.register(
            { name: 'sidebar.right.pane.tab.title', key: t.id },
            makeTitle(t.title),
          )), `pixiv-aesthetic: tab 标题 ${t.kind}`))
        }

        /* ── ④ 把 tab 真的打开 ──
         *
         * ⚠️ 光"注册"不会让 tab 出现在面板里 —— 那只是声明了一种类型，
         *    得有人 `openTab` 才会实例化一个标签页。
         *    官方都是由某个入口（点 Session 里的卡片之类）触发的；
         *    我们没有那种入口，所以插件一加载就自己打开这两个 tab。
         *
         *    找不到 openTab 就静默算了 —— 有的宿主版本可能没这个方法，
         *    那时 tab 类型仍然注册着，能通过别的方式打开。
         */
        step('打开 tab', () => ctx.effect(() => {
          const open = side && typeof side.openTab === 'function' ? side.openTab.bind(side) : null
          if (!open) {
            reportClientError('没有 sidebarRight.openTab', new Error('sidebarRight=' + String(side)))
            return
          }
          // 稍等一下再开：让 slots 的注册先落定
          const timer = setTimeout(() => {
            for (const t of PANE_TABS) {
              try { open(t.kind, { params: {} }) } catch (e) { reportClientError('openTab ' + t.kind, e) }
            }
          }, 300)
          return () => clearTimeout(timer)
        }, 'pixiv-aesthetic: 打开浮窗 tab'))
      },
    }
  },
})
