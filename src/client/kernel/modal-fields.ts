/**
 * kernel/modal-fields.ts — 弹窗表单里那一串字段的渲染（#698 由 slotRenderer-modal-view.ts 拆出，#23 扩展声明式向导字段原语）。
 *
 * 为什么拆：那个文件在布局小卡搬进弹窗座位之后到了 404 行，超了 350 行上限
 *   （门禁 tests/verify-file-granularity.ts 是零增长基线，不许留超标文件）。搬出来的这一块与弹窗的
 *   其余部分几乎没有关系 —— 它只管把 schema 里每个字段画成一行控件，谁来画、什么时候画它不关心。
 * 契约：内核模块（scripts/build.mts 的 KERNEL_MODULES 登记，marker kernel:modalFields 拼回
 *   src/client/index.ts 的 apply 闭包内原位）；纯函数，不读会话状态、不碰闭包里的东西，
 *   需要的一切都以 ctx 传进来。以后谁改它：改弹窗字段长什么样（单选、多选、文本框、密码框、下拉框、路径选择、指引与横幅、预览行）的人。
 * 反例：不要在这里读弹窗开关或提交状态，不要在这里直接调 emit 或 host，也绝不要硬编码任何平台品牌或 URL。
 */
declare const CONTAINER_ACCENT: any;
declare const MOTION: any; // #1236 动效时长统一在 kernel/motion.ts，本文件只引用不写真值
declare function openUrl(...args: any[]): any;
// #1296：激活态的紫只从中央色表 container-view.ts 的 CONTAINER_ACCENT 取；单独求值本文件（门禁环境）
//   时表还没拼进来，typeof 守卫退空串——那时断的是表单结构，不靠这里的颜色值。
const CONTAINER_ACCENT_FALLBACK: any = (typeof CONTAINER_ACCENT === 'object' && CONTAINER_ACCENT) ? CONTAINER_ACCENT.map : '';
const HOVER_FADE_MS: number = (typeof MOTION === 'object' && MOTION && typeof MOTION.hoverFadeMs === 'number') ? MOTION.hoverFadeMs : 120;

function _fieldText(v: any): string {
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

function _isFieldVisible(f: any, vals: any): boolean {
  if (!f || !f.visibleWhen || typeof f.visibleWhen !== 'object') return true
  const vw: any = f.visibleWhen
  const depField: string = String(vw.field || '').trim()
  if (!depField) return true
  const actual: string = String((vals && vals[depField]) !== undefined && (vals && vals[depField]) !== null ? vals[depField] : '')
  if (vw.equals !== undefined) {
    if (Array.isArray(vw.equals)) {
      let hit: boolean = false
      for (let i: number = 0; i < vw.equals.length; i++) {
        if (String(vw.equals[i]) === actual) { hit = true; break }
      }
      if (!hit) return false
    } else if (String(vw.equals) !== actual) {
      return false
    }
  }
  if (vw.notEquals !== undefined && String(vw.notEquals) === actual) return false
  return true
}

function _normSelectOpt(opt: any): { value: string; label: string } {
  if (opt && typeof opt === 'object' && !Array.isArray(opt)) {
    const val: string = String(opt.value !== undefined && opt.value !== null ? opt.value : (opt.id || ''))
    const lbl: string = _fieldText(opt.label !== undefined ? opt.label : val)
    return { value: val, label: lbl || val }
  }
  const s: string = String(opt !== undefined && opt !== null ? opt : '')
  return { value: s, label: s }
}

export const modalFormFields = function (curSchema: any, ctx: any): any {
  const m: any = (ctx && ctx.m) || {}, isWizard: any = ctx && ctx.isWizard, stepIndex: any = (ctx && ctx.stepIndex) || 0, vals: any = (ctx && ctx.vals) || {}, setVals: any = (ctx && ctx.setVals) || function () {}, onPick: any = (ctx && ctx.onPick) || function () { return function () {} }, h: any = ctx && ctx.h
  const openUrlFn: any = (ctx && typeof ctx.openUrl === 'function') ? ctx.openUrl : (typeof openUrl === 'function' ? openUrl : null)
  const onFieldChange: any = (ctx && typeof ctx.onFieldChange === 'function') ? ctx.onFieldChange : null
  const applyVal = function (f: any, nextVal: any): void {
    const nxt: any = Object.assign({}, vals)
    nxt[f.name] = nextVal
    setVals(nxt)
    if (isWizard && m && m.valuesByStep && m.valuesByStep[stepIndex]) {
      m.valuesByStep[stepIndex] = Object.assign({}, nxt)
    }
    if (f && f.rehydrateOnChange && onFieldChange) {
      try { onFieldChange(f.name, nextVal, nxt) } catch (_) {}
    }
  }
  const list: any[] = Array.isArray(curSchema) ? curSchema : []
  const fields: any[] = []
  for (let idx: number = 0; idx < list.length; idx++) {
    const f: any = list[idx]
    if (!f || !_isFieldVisible(f, vals)) continue
    const id: string = 'modal-form-' + String(f.name || idx) + (isWizard ? '-s' + stepIndex : '')
    const rawLabel: any = (f && (f.label || f.labelKey)) || (f && f.name) || String(idx)
    const label: string = _fieldText(rawLabel)
    const placeholder: string = _fieldText((f && (f.placeholder || f.placeholderKey)) || '')
    const isSingle: boolean = f.type === 'single'
    const isMulti: boolean = f.type === 'multi'
    const isSelect: boolean = f.type === 'select'
    const isPassword: boolean = f.type === 'password'
    const isDirectory: boolean = f.type === 'directory'
    const isFile: boolean = f.type === 'file'
    const isPicker: boolean = isDirectory || isFile
    const rawOpts: any[] = (m && m.optionsByField && Array.isArray(m.optionsByField[f.name])) ? m.optionsByField[f.name] : (Array.isArray(f.options) ? f.options : [])
    const helperLink: any = (f.helperLink && typeof f.helperLink === 'object' && f.helperLink.url) ? f.helperLink : null
    const helperLines: any[] = Array.isArray(f.helperLines) ? f.helperLines : []
    const dynBanner: any = (m && m.bannersByField && m.bannersByField[f.name]) ? m.bannersByField[f.name] : null
    const staticBanner: any = (f.banner && typeof f.banner === 'object') ? f.banner : null
    const banners: any[] = []
    if (staticBanner && staticBanner.text) banners.push(staticBanner)
    if (dynBanner && dynBanner.text) banners.push(dynBanner)

    const labelRow: any = h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 } }, [
      h('label', { htmlFor: id, style: { fontSize: 11, color: '#a1a1aa', display: 'flex', alignItems: 'center', gap: 4 } }, [
        h('span', null, label),
        f.required ? h('span', { style: { color: '#f87171' } }, '*') : null,
      ]),
      helperLink ? h('button', {
        type: 'button',
        className: 'dsws-btn ghost dsws-hov',
        'data-press': 'button',
        'data-log': 'modal.field.helperlink.' + String(f.name || idx).toLowerCase().replace(/[^a-z0-9._-]/g, '_'),
        onClick: function (): void { try { if (openUrlFn) openUrlFn(String(helperLink.url)) } catch (_) {} },
        style: { fontSize: 11, padding: '2px 8px', color: '#58a6ff' },
      }, _fieldText(helperLink.label) || String(helperLink.url)) : null,
    ])

    const helperBox: any = helperLines.length > 0 ? h('div', {
      style: { fontSize: 11, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary,#a1a1aa)', background: 'var(--dsw-alias-bg-layer-2,#16181d)', border: '1px solid var(--dsw-alias-border-l1,#2a2d35)', borderRadius: 6, padding: '6px 8px' },
    }, helperLines.map(function (line: any, li: number): any {
      return h('div', { key: li }, _fieldText(line))
    })) : null

    const bannerNodes: any[] = banners.map(function (bn: any, bi: number): any {
      const isWarn: boolean = String(bn.level || 'info') === 'warn'
      return h('div', {
        key: 'bn-' + String(bi),
        role: isWarn ? 'alert' : 'status',
        style: {
          fontSize: 11,
          lineHeight: 1.45,
          padding: '6px 8px',
          borderRadius: 6,
          border: isWarn ? '1px solid rgba(251,191,36,.4)' : '1px solid rgba(88,166,255,.35)',
          background: isWarn ? 'rgba(251,191,36,.10)' : 'rgba(88,166,255,.10)',
          color: isWarn ? '#fcd34d' : '#93c5fd',
        },
      }, _fieldText(bn.text))
    })

    if (isPicker) {
      fields.push(h('div', { key: f.name || idx, style: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 } }, [
        labelRow,
        helperBox,
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } }, [
          h('input', { id: id, type: 'text', value: String(vals[f.name] || ''), placeholder: placeholder || (isDirectory ? '请选择目录或手动输入' : '请选择文件或手动输入'), disabled: !!m.pending, onChange: function (e: any): void { applyVal(f, e.target.value) }, style: { flex: 1, minWidth: 0, fontSize: 12, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#2a2d35)', background: 'var(--dsw-alias-bg-layer-1,#10131a)', color: 'var(--dsw-alias-label-primary,#e6edf3)' } }),
          // 接线（#1335 界面反馈）：这颗按钮调起宿主的目录/文件选择器。日志名按字段类型分两枚
          //   （选目录与选文件是两种动作），都不写按钮上那句文字。
          h('button', { type: 'button', className: 'dsws-btn dsws-hov', 'data-press': 'button', 'data-log': 'modal.field.browse.' + (isDirectory ? 'dir' : 'file'), disabled: !!m.pending, onClick: onPick(f), style: { fontSize: 11, padding: '4px 10px', flex: 'none' } }, isDirectory ? '浏览目录…' : '浏览文件…'),
        ]),
        ...bannerNodes,
      ]))
      continue
    }

    let controlNode: any = null
    if (isSingle) {
      controlNode = h('div', { style: { display: 'flex', gap: 8 } }, rawOpts.map(function (rawOpt: any, optIdx: number): any {
        const normOpt = _normSelectOpt(rawOpt)
        const optVal: string = normOpt.value
        const optLabel: string = normOpt.label
        const active: boolean = String(vals[f.name] || '') === optVal
        // 接线（#1335 界面反馈）：单选药丸整颗可点（role=radio 的 label），按药丸接 chip 形状；
        //   日志名用字段名加选项序号拼出来，不把选项上那句展示文字写进日志。
        return h('label', { key: optVal, role: 'radio', tabIndex: m.pending ? -1 : 0, className: 'dsws-hov', 'data-press': 'chip', 'data-log': 'modal.field.single.' + String(f.name || idx).toLowerCase() + '.' + String(optIdx), 'aria-checked': active ? 'true' : 'false', 'aria-label': optLabel, onClick: function (): void { if (m.pending) return; applyVal(f, optVal) }, onKeyDown: function (e: any): void { const k: any = e && e.key; if (k === ' ' || k === 'Enter' || k === 'Spacebar' || k === 'Space') { try { if (e.preventDefault) e.preventDefault() } catch (_) {} if (m.pending) return; applyVal(f, optVal) } }, style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '9px 8px', border: '1px solid ' + (active ? 'var(--dsw-alias-interactive-bg-primary,' + CONTAINER_ACCENT_FALLBACK + ')' : 'var(--dsw-alias-border-l1,#2a2d35)'), borderRadius: 10, background: active ? 'rgba(192,132,252,.08)' : 'var(--dsw-alias-bg-layer-2,#16181d)', color: active ? 'var(--dsw-alias-interactive-bg-primary,' + CONTAINER_ACCENT_FALLBACK + ')' : 'var(--dsw-alias-label-secondary,#a1a1aa)', cursor: m.pending ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', transition: 'border-color ' + HOVER_FADE_MS + 'ms,background ' + HOVER_FADE_MS + 'ms', opacity: m.pending ? 0.6 : 1 } }, [
          h('span', { style: { width: 13, height: 13, borderRadius: '50%', border: '1.5px solid ' + (active ? 'var(--dsw-alias-interactive-bg-primary,' + CONTAINER_ACCENT_FALLBACK + ')' : 'var(--dsw-alias-border-l2,#3a3f4a)'), flex: 'none', display: 'grid', placeItems: 'center' } }, active ? h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: 'var(--dsw-alias-interactive-bg-primary,' + CONTAINER_ACCENT_FALLBACK + ')' } }) : null),
          h('span', null, optLabel),
          (f.optionSubs && f.optionSubs[optVal]) ? h('span', { style: { fontSize: 11, color: (active ? 'var(--dsw-alias-interactive-bg-primary,' + CONTAINER_ACCENT_FALLBACK + ')' : 'var(--dsw-alias-label-caption,#8b8b95)'), fontWeight: 400, whiteSpace: 'nowrap' } }, _fieldText(f.optionSubs[optVal])) : null,
        ])
      }))
    } else if (isMulti) {
      controlNode = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } }, rawOpts.map(function (opt: any, optIdx: number): any {
        const checked: boolean = Array.isArray(vals[f.name]) ? vals[f.name].indexOf(opt) >= 0 : false
        // 接线（#1335 界面反馈）：多选药丸靠 label 带着里面的 checkbox 一起点，label 才是那颗可点的药丸；
        //   日志名同样用字段名加选项序号，不写选项上的文字。
        return h('label', { key: opt, className: 'dsws-hov', 'data-press': 'chip', 'data-log': 'modal.field.multi.' + String(f.name || idx).toLowerCase() + '.' + String(optIdx), style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, border: '1px solid #2a2d35', borderRadius: 6, padding: '2px 6px', cursor: m.pending ? 'not-allowed' : 'pointer', background: checked ? 'rgba(88,166,255,.12)' : 'transparent', opacity: m.pending ? 0.6 : 1 } }, [
          h('input', { type: 'checkbox', checked: checked, disabled: !!m.pending, onChange: function (e: any): void { const arr: any[] = Array.isArray(vals[f.name]) ? vals[f.name].slice() : []; if (e.target.checked) { if (arr.indexOf(opt) < 0) arr.push(opt) } else { const p: number = arr.indexOf(opt); if (p >= 0) arr.splice(p, 1) } applyVal(f, arr) } }),
          h('span', null, opt),
        ])
      }))
    } else if (isSelect) {
      const normOpts: Array<{ value: string; label: string }> = rawOpts.map(_normSelectOpt)
      if (f.readOnlyWhenSingle && normOpts.length === 1) {
        const singleOpt = normOpts[0]
        if (String(vals[f.name] || '') !== singleOpt.value) {
          vals[f.name] = singleOpt.value
          if (isWizard && m && m.valuesByStep && m.valuesByStep[stepIndex]) {
            m.valuesByStep[stepIndex][f.name] = singleOpt.value
          }
        }
        controlNode = h('div', {
          id: id,
          'data-readonly-single': 'true',
          style: { fontSize: 12, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#2a2d35)', background: 'var(--dsw-alias-bg-layer-2,#16181d)', color: 'var(--dsw-alias-label-primary,#e6edf3)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
        }, [
          h('span', null, singleOpt.label),
          h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-caption,#8b8b95)' } }, '唯一可用项'),
        ])
      } else {
        const curVal: string = vals[f.name] !== undefined && vals[f.name] !== null ? String(vals[f.name]) : (normOpts[0] ? normOpts[0].value : '')
        controlNode = h('select', {
          id: id,
          value: curVal,
          disabled: !!m.pending,
          onChange: function (e: any): void { applyVal(f, e.target.value) },
          style: { fontSize: 12, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#2a2d35)', background: 'var(--dsw-alias-bg-layer-1,#10131a)', color: 'var(--dsw-alias-label-primary,#e6edf3)' },
        }, normOpts.map(function (o: { value: string; label: string }): any {
          return h('option', { key: o.value, value: o.value }, o.label)
        }))
      }
    } else if (isPassword) {
      controlNode = h('input', {
        id: id,
        type: 'password',
        autocomplete: 'off',
        spellcheck: 'false',
        value: String(vals[f.name] || ''),
        placeholder: placeholder,
        disabled: !!m.pending,
        onChange: function (e: any): void { applyVal(f, e.target.value) },
        style: { fontSize: 12, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#2a2d35)', background: 'var(--dsw-alias-bg-layer-1,#10131a)', color: 'var(--dsw-alias-label-primary,#e6edf3)' },
      })
    } else {
      controlNode = h('input', {
        id: id,
        type: f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text',
        value: String(vals[f.name] || ''),
        placeholder: placeholder,
        disabled: !!m.pending,
        onChange: function (e: any): void { applyVal(f, e.target.value) },
        style: { fontSize: 12, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#2a2d35)', background: 'var(--dsw-alias-bg-layer-1,#10131a)', color: 'var(--dsw-alias-label-primary,#e6edf3)' },
      })
    }

    const previewText: string = (!isPassword && f && f.preview) ? _fieldText(f.preview) : ''
    fields.push(h('div', { key: f.name || idx, style: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 } }, [
      labelRow,
      helperBox,
      controlNode,
      ...bannerNodes,
      // #1388：类名给浅色层挂钩，浅色下换宿主链接深蓝（深色走内联色不变）；password 字段严禁渲染明文 preview。
      previewText ? h('div', { className: 'dsws-modal-preview', style: { fontSize: 12, fontWeight: 500, color: '#58a6ff', marginTop: 2, wordBreak: 'break-all', letterSpacing: '.01em', lineHeight: 1.5 } }, [
        h('span', null, String(previewText).replace(/\{owner\}/g, 'owner').replace(/\{name\}/g, String(vals[f.name] || '').trim() || '...')),
      ]) : null,
    ]))
  }
  return fields
}
