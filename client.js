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
[data-px-chips]{display:flex;flex-wrap:wrap;gap:6px;}
[data-px-chip]{padding:3px 9px;border-radius:999px;font-size:11px;cursor:pointer;
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

    return {
      inject: ['slots'],
      apply(ctx) {
        // 样式挂一次，卸载时收掉
        const style = document.createElement('style')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-pixiv-aesthetic: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'pixiv-scroll', order: 31, label: 'Pixiv 美学漫游' },
          () => h(Panel),
        ))
      },
    }
  },
})
