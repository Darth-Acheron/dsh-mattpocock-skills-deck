/**
 * kernel/modal-wizard-step.ts — 向导动态水合、单步前置动作、条件可见字段校验与多深链成功弹窗（#23 拆出）。
 *
 * 为什么单独一层：slotRenderer-modal-view.ts 已达 328 有效行（贴近 350 行门禁上限）。
 *   将向导水合（hydrateRpc）、单步在线验真门控（stepAction）、条件显隐校验（visibleWhen）、
 *   已完成圆点导航回退以及多深链成功弹窗（links + hint）收敛在本模块，保持零品牌硬编码与零平台 URL 字面量。
 * 反例：不要在本模块写任何平台名称判断或硬编码 URL；点击事件必须同时携带合规的 data-press 与全小写唯一 data-log。
 */
declare function emit(...args: any[]): any;
declare function flash(...args: any[]): any;
declare const host: any;
declare function openUrl(...args: any[]): any;
declare function tr(...args: any[]): any;
declare function dswsNormalizeError(input: any, fallbackText: any): { kind: string; message: string; raw: string };

function _wizText(v: any): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') {
    if (typeof pickLangText === 'function') {
      try {
        const picked: string = pickLangText(v)
        if (picked) return picked
      } catch (_) {}
    }
    return String(v.zh || v.en || v.fallback || '')
  }
  return String(v)
}

/** 判定单个字段在当前步表单值下是否可见（支持 equals 字符串/数组与 notEquals）。 */
export function isWizardFieldVisible(f: any, vals: any): boolean {
  if (!f || !f.visibleWhen || typeof f.visibleWhen !== 'object') return true
  const vw: any = f.visibleWhen
  const depField: string = String(vw.field || '').trim()
  if (!depField) return true
  const actual: string = String((vals && vals[depField]) !== undefined && (vals && vals[depField]) !== null ? vals[depField] : '')
  const eqList: any = Array.isArray(vw.in) ? vw.in : vw.equals
  if (eqList !== undefined) {
    if (Array.isArray(eqList)) {
      let hit: boolean = false
      for (let i: number = 0; i < eqList.length; i++) {
        if (String(eqList[i]) === actual) { hit = true; break }
      }
      if (!hit) return false
    } else if (String(eqList) !== actual) {
      return false
    }
  }
  if (vw.notEquals !== undefined && String(vw.notEquals) === actual) return false
  return true
}

/** 校验一组字段中所有当前可见字段的 required 与 pattern 约束，隐藏字段一律跳过校验。 */
export function validateWizardFields(schema: any, vals: any): { ok: boolean; field?: any; message?: string } {
  const list: any[] = Array.isArray(schema) ? schema : []
  for (let i: number = 0; i < list.length; i++) {
    const f: any = list[i]
    if (!f || !isWizardFieldVisible(f, vals)) continue
    const label: string = _wizText((f && (f.label || f.labelKey)) || f.name || i)
    if (f.required) {
      const v: string = String((vals && vals[f.name]) || '').trim()
      if (!v) return { ok: false, field: f, message: _wizText({ zh: label + ' 必填', en: label + ' is required' }) }
    }
    if (typeof f.maxLength === 'number' && f.maxLength > 0) {
      if (String((vals && vals[f.name]) || '').length > f.maxLength) {
        return { ok: false, field: f, message: _wizText({ zh: label + ' 长度超出限制', en: label + ' exceeds max length' }) }
      }
    }
    if (f.pattern) {
      try {
        const re: RegExp = new RegExp(f.pattern)
        if (!re.test(String((vals && vals[f.name]) || ''))) {
          return { ok: false, field: f, message: _wizText({ zh: label + ' 格式不正确', en: label + ' has invalid format' }) }
        }
      } catch (_) {}
    }
  }
  return { ok: true }
}

/** 将水合返回的 defaultsByField 填入各步 valuesByStep（默认用服务端发现的推荐值覆盖静态 defaultValue）。 */
export function applyWizardHydratePayload(m: any, res: any, overwriteDefaults?: boolean): void {
  if (!m || !res || typeof res !== 'object') return
  const shouldOverwrite: boolean = overwriteDefaults !== false
  if (typeof res.authenticated === 'boolean') m.authenticated = res.authenticated
  if (res.optionsByField && typeof res.optionsByField === 'object') {
    m.optionsByField = Object.assign({}, m.optionsByField || {}, res.optionsByField)
  }
  if (res.bannersByField && typeof res.bannersByField === 'object') {
    const tokenBanner = m.bannersByField && m.bannersByField.token
    m.bannersByField = Object.assign({}, res.bannersByField)
    if (tokenBanner && !m.bannersByField.token) m.bannersByField.token = tokenBanner
  }
  if (res.defaultsByField && typeof res.defaultsByField === 'object') {
    m.defaultsByField = Object.assign({}, m.defaultsByField || {}, res.defaultsByField)
    const steps: any[] = Array.isArray(m.steps) ? m.steps : []
    if (Array.isArray(m.valuesByStep)) {
      const assignedKeys: Record<string, boolean> = {}
      for (let si: number = 0; si < steps.length; si++) {
        const sch: any[] = (steps[si] && Array.isArray(steps[si].schema)) ? steps[si].schema : []
        const stepVals: any = Object.assign({}, m.valuesByStep[si] || {})
        for (let fi: number = 0; fi < sch.length; fi++) {
          const fn: string = sch[fi] && sch[fi].name ? String(sch[fi].name) : ''
          if (fn && res.defaultsByField[fn] !== undefined && res.defaultsByField[fn] !== null) {
            assignedKeys[fn] = true
            if (shouldOverwrite || stepVals[fn] === undefined || stepVals[fn] === '') {
              stepVals[fn] = String(res.defaultsByField[fn])
            }
          } else if (fn && res.optionsByField && Array.isArray(res.optionsByField[fn]) && stepVals[fn]) {
            const validOpts: any[] = res.optionsByField[fn]
            const curS: string = String(stepVals[fn])
            const stillExists: boolean = validOpts.some(function (o: any): boolean {
              const ov: string = (o && typeof o === 'object') ? String(o.value !== undefined && o.value !== null ? o.value : (o.id || '')) : String(o || '')
              return ov === curS
            })
            if (!stillExists) stepVals[fn] = ''
          }
        }
        m.valuesByStep[si] = stepVals
      }
      if (m.valuesByStep.length > 1) {
        const fallbackStepVals: any = Object.assign({}, m.valuesByStep[1] || {})
        for (const k in res.defaultsByField) {
          if (Object.prototype.hasOwnProperty.call(res.defaultsByField, k) && !assignedKeys[k] && res.defaultsByField[k] !== undefined && res.defaultsByField[k] !== null) {
            if (shouldOverwrite || fallbackStepVals[k] === undefined || fallbackStepVals[k] === '') {
              fallbackStepVals[k] = String(res.defaultsByField[k])
            }
          }
        }
        m.valuesByStep[1] = fallbackStepVals
      }
    }
  }
  if (typeof res.initialStepIndex === 'number' && Array.isArray(m.steps) && m.steps.length > 0 && !m._userNavigated) {
    const clamped: number = Math.max(0, Math.min(m.steps.length - 1, Math.floor(res.initialStepIndex)))
    m.stepIndex = clamped
    if (clamped >= 1) m.authenticated = true
  }
}

/** 调用向导声明的 hydrateRpc 拉取动态下拉选项、默认值与横幅。 */
export async function hydrateWizardModal(st: any, m: any, extraParams?: any, hostOverride?: any): Promise<any> {
  if (!m || !m.isWizard || !m.hydrateRpc || typeof m.hydrateRpc.method !== 'string' || !m.hydrateRpc.method) return null
  const hRPC: any = hostOverride || (typeof host !== 'undefined' ? host : null)
  if (!hRPC || typeof hRPC.call !== 'function') return null
  const seq: number = (m._hydrateSeq = (m._hydrateSeq || 0) + 1)
  m.hydrating = true
  try { if (typeof emit === 'function') emit(st) } catch (_) {}
  try {
    const payload: any = Object.assign({ cwd: (st && st.cwd) || '' }, m.hydrateRpc.params || {}, extraParams || {})
    const res: any = await hRPC.call(m.hydrateRpc.method, payload)
    if (m._hydrateSeq !== seq) return res
    m.hydrating = false
    if (res && typeof res === 'object') {
      applyWizardHydratePayload(m, res, true)
    }
    try { if (typeof emit === 'function') emit(st) } catch (_) {}
    return res
  } catch (_) {
    if (m._hydrateSeq === seq) m.hydrating = false
    try { if (typeof emit === 'function') emit(st) } catch (__) {}
    return null
  }
}

/** 执行向导当前步的「下一步」：支持已认证跳过的令牌步免重输前进，或调用 stepAction 在线验真通过后推进。 */
/** 提交前剔除当前条件显隐规则判定为隐藏的步骤字段，防止切换组织或切换模式后的残留键值混入契约参数。 */
export function pruneHiddenWizardValues(wizardSteps: any, merged: any): any {
  const out: any = Object.assign({}, merged || {})
  const steps: any[] = Array.isArray(wizardSteps) ? wizardSteps : []
  for (let si: number = 0; si < steps.length; si++) {
    const sch: any[] = (steps[si] && Array.isArray(steps[si].schema)) ? steps[si].schema : []
    for (let fi: number = 0; fi < sch.length; fi++) {
      const f: any = sch[fi]
      if (f && f.name && !isWizardFieldVisible(f, out)) {
        delete out[f.name]
      }
    }
  }
  return out
}

export async function runWizardStepNext(st: any, m: any, vals: any, hostOverride?: any, setVals?: any): Promise<{ ok: boolean }> {
  if (!m || !m.isWizard || !Array.isArray(m.steps) || m.pending || m.hydrating) return { ok: false }
  const stepIndex: number = typeof m.stepIndex === 'number' ? m.stepIndex : 0
  const totalSteps: number = m.steps.length
  const curStep: any = m.steps[stepIndex] || {}
  const curSchema: any[] = Array.isArray(curStep.schema) ? curStep.schema : []
  const stepAction: any = curStep.stepAction && typeof curStep.stepAction === 'object' ? curStep.stepAction : null

  const hasPasswordField: boolean = curSchema.some(function (f: any): boolean { return Boolean(f && f.type === 'password') })
  const tokenVal: string = vals && vals.token !== undefined ? String(vals.token).trim() : ''
  const canSkipAuthedStep: boolean = Boolean(stepIndex === 0 && hasPasswordField && !tokenVal && (m.authenticated || (typeof m.initialStepIndex === 'number' && m.initialStepIndex >= 1)))

  if (!canSkipAuthedStep) {
    const vRes = validateWizardFields(curSchema, vals)
    if (!vRes.ok) {
      try { if (typeof flash === 'function') flash(st, vRes.message || '请检查必填项', 'warn') } catch (_) {}
      return { ok: false }
    }
  }

  m.fail = null
  if (m.valuesByStep) m.valuesByStep[stepIndex] = Object.assign({}, vals)

  if (stepAction && typeof stepAction.method === 'string' && stepAction.method && !canSkipAuthedStep) {
    const hRPC: any = hostOverride || (typeof host !== 'undefined' ? host : null)
    if (hRPC && typeof hRPC.call === 'function') {
      m.pending = true
      try { if (typeof emit === 'function') emit(st) } catch (_) {}
      try {
        const rpcParams: any = Object.assign({ cwd: (st && st.cwd) || '' }, stepAction.params || {}, vals || {})
        const res: any = await hRPC.call(stepAction.method, rpcParams)
        m.pending = false
        if (!res || res.ok === false) {
          const errText: string = _wizText((res && (res.error || res.message)) || '操作失败，请检查输入')
          const errKind: string = String((res && (res.errorKind || res.kind)) || 'auth')
          m.fail = { kind: errKind, code: errKind, text: errText, link: null, repo: null, halfCreated: false }
          try { if (typeof emit === 'function') emit(st) } catch (_) {}
          return { ok: false }
        }
        m.authenticated = true
        if (res.envShadowWarning && res.warningText) {
          m.bannersByField = Object.assign({}, m.bannersByField || {}, {
            token: { level: 'warn', text: res.warningText },
          })
        }
        if (m.hydrateRpc && typeof m.hydrateRpc.method === 'string') {
          m._userNavigated = true
          await hydrateWizardModal(st, m, {}, hRPC)
        }
      } catch (e: any) {
        m.pending = false
        const normalized = dswsNormalizeError(e, '请求失败')
        m.fail = { kind: normalized.kind, code: normalized.kind, text: _wizText(normalized.message), raw: normalized.raw, link: null, repo: null, halfCreated: false }
        try { if (typeof emit === 'function') emit(st) } catch (_) {}
        return { ok: false }
      }
    }
  }

  if (stepIndex < totalSteps - 1) {
    m._userNavigated = true
    m.stepIndex = stepIndex + 1
    if (typeof setVals === 'function' && m.valuesByStep && m.valuesByStep[m.stepIndex]) {
      try { setVals(Object.assign({}, m.valuesByStep[m.stepIndex])) } catch (_) {}
    }
    try { if (typeof emit === 'function') emit(st) } catch (_) {}
  }
  return { ok: true }
}

/** 渲染向导顶部步进条：已完成步骤显示绿色 ✓ 且支持点击回退查看/更换凭证。 */
export function renderWizardStepper(st: any, m: any, vals: any, h: any): any {
  const wizardSteps: any[] = (m && Array.isArray(m.steps)) ? m.steps : []
  const stepIndex: number = (m && typeof m.stepIndex === 'number') ? m.stepIndex : 0
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' } }, wizardSteps.map(function (s: any, i: number): any {
    const active: boolean = i === stepIndex
    const done: boolean = i < stepIndex || (i === 0 && Boolean(m && m.authenticated) && stepIndex > 0)
    const bg: string = done ? '#16a34a' : active ? '#58a6ff' : '#2a2d35'
    const color: string = done || active ? '#fff' : '#8b8b95'
    const title: string = _wizText(s && s.title) || ('步骤 ' + String(i + 1))
    const canJumpBack: boolean = i < stepIndex && !(m && (m.pending || m.hydrating))
    return h('div', {
      key: i,
      className: canJumpBack ? 'dsws-hov' : '',
      'data-press': canJumpBack ? 'chip' : undefined,
      'data-log': canJumpBack ? ('modal.wizard.step.' + String(i)) : undefined,
      onClick: canJumpBack ? function (): void {
        if (m.pending || m.hydrating) return
        m.fail = null
        m._userNavigated = true
        if (m.valuesByStep) m.valuesByStep[stepIndex] = Object.assign({}, vals)
        m.stepIndex = i
        try { if (typeof emit === 'function') emit(st) } catch (_) {}
      } : undefined,
      style: { display: 'flex', alignItems: 'center', gap: 6, cursor: canJumpBack ? 'pointer' : 'default' },
    }, [
      h('span', { style: { width: 22, height: 22, borderRadius: '50%', background: bg, color: color, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 } }, done ? '✓' : String(i + 1)),
      h('span', { style: { fontSize: 11, color: active ? '#e6edf3' : '#8b8b95', fontWeight: active ? 600 : 400 } }, title),
      i < wizardSteps.length - 1 ? h('span', { style: { width: 16, height: 1, background: '#2a2d35', flex: 'none' } }) : null,
    ])
  }))
}

/** 从提交回包构建 m.success 状态：兼容多深链 links/hint 与原有单仓 owner/name/url。 */
export function buildWizardSuccessState(out: any, visLabel: string): any {
  const repoData: any = (out && out.data && out.data.ok) ? out.data : ((out && out.ok) ? out : null)
  if (!repoData) return null
  const repo: any = repoData.repo || null
  const rawLinks: any[] = Array.isArray(repoData.links) ? repoData.links : (Array.isArray(repoData.extraUrls) ? repoData.extraUrls : [])
  const links: any[] = rawLinks.filter(function (lk: any): boolean { return Boolean(lk && typeof lk.url === 'string' && lk.url) })
  const hint: any = repoData.hint || null
  if ((repo && (repo.owner || repo.name)) || links.length > 0) {
    return {
      owner: (repo && repo.owner) ? repo.owner : '',
      name: (repo && repo.name) ? repo.name : '',
      url: repoData.repoUrl || (repo && repo.url) || (links[0] ? links[0].url : ''),
      visLabel: visLabel,
      links: links,
      hint: hint,
    }
  }
  return null
}

/** 渲染多深链成功弹窗的提示框与深链按钮数组（弹窗外壳仍由 slotRenderer-modal-view.ts 持有，保证全仓 data-log 跨文件唯一）。 */
export function renderWizardSuccessModal(sv: any, _onClose?: any, _onOverlayClick?: any, ctx?: any): any {
  const hFn: any = (ctx && ctx.h) || null
  const openUrlFn: any = (ctx && ctx.openUrl) || (typeof openUrl === 'function' ? openUrl : null)
  const links: any[] = (sv && Array.isArray(sv.links)) ? sv.links : []
  const hintText: string = (sv && sv.hint) ? _wizText(sv.hint) : ''
  const hintNode: any = hintText ? hFn('div', { key: 'wiz-hint', style: { marginTop: 6, fontSize: 11, color: '#93c5fd', background: 'rgba(88,166,255,.10)', border: '1px solid rgba(88,166,255,.35)', borderRadius: 6, padding: '6px 8px', lineHeight: 1.5 } }, hintText) : null
  const linkBtns: any[] = links.map(function (lk: any, li: number): any {
    return hFn('button', {
      key: 'lk-' + String(li),
      className: (lk.primary || li === 0) ? 'dsws-btn primary dsws-hov' : 'dsws-btn dsws-hov',
      'data-press': 'button',
      'data-log': 'modal.success.link.' + String(li),
      onClick: function (): void { try { if (openUrlFn) openUrlFn(String(lk.url)) } catch (_) {} },
      style: { fontSize: 12, padding: '6px 12px', fontWeight: 600 },
    }, _wizText(lk.label) || String(lk.url))
  })
  return hFn('div', { key: 'wiz-success-extra' }, [hintNode, ...linkBtns])
}
