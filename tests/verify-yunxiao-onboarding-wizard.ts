#!/usr/bin/env node
/**
 * tests/verify-yunxiao-onboarding-wizard.ts —— 声明式向导字段原语、向导生命周期、云效令牌在线验真/0600 原子落盘，
 *   以及组织/项目发现与三模式一体化置备（规格 #21 / #23 / #24）。
 *
 * 门禁归属: src/shared/tracker/chain-types.ts
 * 门禁归属: src/shared/tracker/chain-validate.ts
 * 门禁归属: src/client/kernel/modal-fields.ts
 * 门禁归属: src/client/kernel/modal-wizard-step.ts
 * 门禁归属: src/client/kernel/slotRenderer-modal-view.ts
 * 门禁归属: src/client/kernel/slotRenderer-queue.ts
 * 门禁归属: src/client/kernel/actions.ts
 * 门禁归属: src/refresh/rooms/client/repo-sync-renderer.ts
 * 门禁归属: src/host/yunxiaoOnboarding.ts
 * 门禁归属: src/host/publishFlow.ts
 * 门禁归属: src/tracker/registry/builtins.ts
 * 门禁归属: src/tracker/rooms/yunxiao/room/fixes.ts
 * 门禁归属: src/tracker/rooms/yunxiao/model/yaml-flat.ts
 * 门禁归属: src/tracker/rooms/yunxiao/model/workspace-config.ts
 * 门禁归属: src/tracker/rooms/yunxiao/project/discover.ts
 * 门禁归属: src/tracker/rooms/yunxiao/project/init-project.ts
 * 门禁归属: src/tracker/rooms/yunxiao/project/init-project-helpers.ts
 * 门禁归属: src/tracker/rooms/yunxiao/project/init-project-persist.ts
 *
 * 用法：node --import ./scripts/ts-hook.mts tests/verify-yunxiao-onboarding-wizard.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { printGateResult } from './lib/gate-result.ts'

const GATE = 'verify-yunxiao-onboarding-wizard'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
let total = 0

function check(ok: boolean, msg: string, detail?: unknown): void {
  total += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok || detail === undefined ? '' : ' —— ' + JSON.stringify(detail)))
  if (!ok) failed += 1
}

const imp = (rel: string): Promise<any> => import(pathToFileURL(path.join(ROOT, rel)).href)

type VNode = { tag: any; props: Record<string, any>; children: any[] }

function h(tag: any, props?: Record<string, any> | null, ...rest: any[]): VNode {
  const flat: any[] = []
  const push = (item: any): void => {
    if (item === null || item === undefined || item === false) return
    if (Array.isArray(item)) {
      for (const sub of item) push(sub)
      return
    }
    flat.push(item)
  }
  for (const r of rest) push(r)
  return { tag, props: props || {}, children: flat }
}

function findNodes(root: any, pred: (n: VNode) => boolean): VNode[] {
  const out: VNode[] = []
  const walk = (node: any): void => {
    if (!node) return
    if (Array.isArray(node)) {
      for (const c of node) walk(c)
      return
    }
    if (typeof node === 'object' && 'tag' in node) {
      if (pred(node as VNode)) out.push(node as VNode)
      if (Array.isArray(node.children)) {
        for (const c of node.children) walk(c)
      }
    }
  }
  walk(root)
  return out
}

function textOf(node: any): string {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'children' in node) return textOf(node.children)
  return ''
}

// ── 注入用的替身端口（第 5、6 段用）──────────────────────────────────────────
// 都只模拟端口形状（fs：resolve/readText/writeText；env：get/has；exec：函数），
// 不碰真实网络与磁盘，保证整扇门禁离线可跑、结论可重复。

/** 记录写入的文件替身：store 是当前内容，writes 按调用顺序留痕（顺序本身就是 Persist-Before-Push 的判据）。 */
function makePortFs(files: Record<string, string>) {
  const writes: Array<{ path: string; text: string }> = []
  const store: Record<string, string> = Object.assign({}, files)
  return {
    writes,
    store,
    resolve: async (rel: string, opts?: { cwd?: string }) => {
      if (rel.startsWith('/')) return rel
      const base = opts && opts.cwd ? String(opts.cwd).replace(/\/+$/, '') + '/' : ''
      return base + rel
    },
    readText: async (target: unknown) => {
      const k = String(target || '')
      if (Object.prototype.hasOwnProperty.call(store, k)) return store[k]
      const stripped = k.replace(/^\/[^/]+\//, '')
      if (Object.prototype.hasOwnProperty.call(store, stripped)) return store[stripped]
      // 房间会把相对路径拼上 cwd 再读（/ws/x/docs/agents/yunxiao.yaml），
      // 而用例只关心「这份文件内容是什么」，所以按路径后缀认领，不要求 cwd 逐字相同。
      const bySuffix = Object.keys(store).find((key) => k.endsWith('/' + key) || key.endsWith('/' + k))
      if (bySuffix !== undefined) return store[bySuffix]
      const err = new Error('ENOENT: ' + k) as Error & { code?: string }
      err.code = 'ENOENT'
      throw err
    },
    writeText: async (target: unknown, text: unknown) => {
      const k = String(target || '')
      const t = String(text == null ? '' : text)
      store[k] = t
      writes.push({ path: k, text: t })
    },
  }
}

function makePortEnv(vars: Record<string, string>) {
  return {
    get: (k: string): string | undefined => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : undefined),
    has: (k: string): boolean => Object.prototype.hasOwnProperty.call(vars, k),
  }
}

/** 记录外部命令调用的 exec 替身：handler 决定每条命令怎么回，calls 留住全部调用以便断言顺序。 */
function makePortExec(handler: (cmd: string, args: string[]) => unknown) {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const fn = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args: args.slice() })
    return handler(cmd, args)
  }
  return { fn, calls }
}

/** 按「方法 + 路径特征」派发的 fetch 替身；命中的路由都记在 hits 里。 */
function makePortFetch(routes: Array<{ method?: string; match: (url: string) => boolean; reply: (url: string, init?: RequestInit) => { status: number; body?: unknown } }>) {
  const hits: Array<{ method: string; url: string }> = []
  const fn = async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const method = String((init && init.method) || 'GET').toUpperCase()
    hits.push({ method, url })
    for (const r of routes) {
      if (r.method && r.method !== method) continue
      if (!r.match(url)) continue
      const out = r.reply(url, init)
      return new Response(out.body === undefined ? '' : JSON.stringify(out.body), { status: out.status })
    }
    return new Response('unexpected: ' + method + ' ' + url, { status: 500 })
  }
  return { fn, hits }
}

async function main(): Promise<void> {
  const validateMod = await imp('src/shared/tracker/chain-validate.ts')
  const fieldsMod = await imp('src/client/kernel/modal-fields.ts')
  const queueMod = await imp('src/client/kernel/slotRenderer-queue.ts')
  const actionsMod = await imp('src/client/kernel/actions.ts')
  const fixesMod = await imp('src/tracker/rooms/yunxiao/room/fixes.ts')
  const builtinsMod = await imp('src/tracker/registry/builtins.ts')
  const wizMod = await imp('src/client/kernel/modal-wizard-step.ts').catch(() => ({}))
  if (typeof wizMod.isWizardFieldVisible === 'function') (globalThis as any).isWizardFieldVisible = wizMod.isWizardFieldVisible
  const onboardMod = await imp('src/host/yunxiaoOnboarding.ts').catch(() => ({}))

  console.log('== 1. 通用声明式 FieldSchema 与 chain-validate 扩展 ==')
  {
    const { validateAction } = validateMod
    const wizPass = validateAction({
      type: 'wizard',
      steps: [
        {
          title: '连接令牌',
          schema: [
            {
              name: 'token',
              type: 'password',
              required: true,
              label: { zh: '个人访问令牌', en: 'Personal Access Token' },
              helperLink: { label: { zh: '打开令牌页', en: 'Open token page' }, url: 'https://account-devops.aliyun.com/settings/personalAccessToken' },
              helperLines: [{ zh: '1. 只读', en: '1. Read' }],
            },
          ],
          stepAction: { type: 'rpc', method: 'wf.yunxiaoSaveToken' },
        },
        {
          title: '选择项目',
          schema: [
            {
              name: 'organizationId',
              type: 'select',
              label: '组织',
              options: [{ value: 'org-1', label: { zh: '组织一', en: 'Org 1' } }],
              readOnlyWhenSingle: true,
              rehydrateOnChange: true,
            },
          ],
        },
      ],
      submitAction: { type: 'contract-op', op: 'initProject' },
    })
    check(wizPass.ok === true, '1.1 validateAction 支持 wizard steps 中 password/select 字段及双语 label 对象', wizPass)

    const wizBadType = validateAction({
      type: 'wizard',
      steps: [{ title: '坏字段', schema: [{ name: 'x', type: 'checkbox-invalid', label: 'X' }] }],
      submitAction: { type: 'rpc', method: 'wf.test' },
    })
    check(wizBadType.ok === false, '1.2 validateAction 拒绝未知的字段 type', wizBadType)

    // 测试 modalFormFields 新原语
    let vals: Record<string, any> = {
      token: 'pt-secret-value-999',
      projectMode: 'existing',
      organizationId: 'org-1',
    }
    const setVals = (nxt: Record<string, any>) => { vals = nxt }
    const openedUrls: string[] = []
    let rehydrateCalls: Array<{ name: string; value: string; nextVals: Record<string, any> }> = []
    const m: any = {
      pending: false,
      valuesByStep: [vals],
      optionsByField: {
        projectId: [
          { value: 'p1', label: { zh: '项目一 (P1)', en: 'Project 1' } },
          { value: 'p2', label: { zh: '项目二 (P2)', en: 'Project 2' } },
        ],
      },
      bannersByField: {
        projectId: { level: 'warn', text: { zh: '检测到 MattDemo，建议切换项目', en: 'MattDemo detected' } },
      },
    }
    const testSchema = [
      {
        name: 'token',
        type: 'password',
        required: true,
        label: { zh: '个人访问令牌 (PAT)', en: 'Personal Access Token' },
        placeholder: { zh: '粘贴令牌', en: 'Paste token' },
        preview: '明文预览不应渲染 {name}',
        helperLink: {
          label: { zh: '打开云效令牌创建页 ↗', en: 'Open Yunxiao token page ↗' },
          url: 'https://account-devops.aliyun.com/settings/personalAccessToken',
        },
        helperLines: [
          { zh: '1. 组织管理 / 用户信息：只读', en: '1. Org & User: Read' },
          { zh: '2. 项目协作（Projex）项目与工作项：读写，项目成员：只读', en: '2. Projex: R/W' },
          { zh: '3. 代码管理（Codeup）代码库：读写（代码组只读可选）', en: '3. Codeup: R/W' },
        ],
        banner: { level: 'info', text: { zh: '令牌仅以 0600 权限保存在本机', en: 'Saved locally with 0600' } },
      },
      {
        name: 'organizationId',
        type: 'select',
        label: { zh: '云效组织', en: 'Organization' },
        options: [{ value: 'org-1', label: { zh: '默认组织 (org-1)', en: 'Default Org (org-1)' } }],
        readOnlyWhenSingle: true,
        rehydrateOnChange: true,
      },
      {
        name: 'projectId',
        type: 'select',
        label: { zh: '已有项目', en: 'Existing Project' },
        visibleWhen: { field: 'projectMode', equals: 'existing' },
        rehydrateOnChange: true,
      },
      {
        name: 'newProjectName',
        type: 'text',
        required: true,
        label: { zh: '新项目名称', en: 'New Project Name' },
        visibleWhen: { field: 'projectMode', equals: 'create' },
      },
    ]

    const rendered = fieldsMod.modalFormFields(testSchema, {
      m,
      isWizard: true,
      stepIndex: 0,
      vals,
      setVals,
      onPick: () => () => {},
      openUrl: (u: string) => openedUrls.push(u),
      onFieldChange: (name: string, value: string, nxt: Record<string, any>) => {
        rehydrateCalls.push({ name, value, nextVals: nxt })
      },
      h,
    })

    const pwdInputs = findNodes(rendered, (n) => n.tag === 'input' && n.props.type === 'password')
    const allText = textOf(rendered)
    check(
      pwdInputs.length === 1 &&
        pwdInputs[0].props.autocomplete === 'off' &&
        pwdInputs[0].props.spellcheck === 'false' &&
        !allText.includes('明文预览不应渲染') &&
        !allText.includes('pt-secret-value-999'),
      '1.3 password 字段渲染掩码 input(type=password, autocomplete=off, spellcheck=false) 且绝不渲染 preview 或令牌明文',
      { pwdCount: pwdInputs.length, props: pwdInputs[0]?.props },
    )

    const helperBtns = findNodes(rendered, (n) => n.tag === 'button' && String(n.props['data-log'] || '').startsWith('modal.field.helperlink.'))
    if (helperBtns[0]?.props?.onClick) helperBtns[0].props.onClick()
    check(
      helperBtns.length === 1 &&
        helperBtns[0].props['data-press'] === 'button' &&
        openedUrls[0] === 'https://account-devops.aliyun.com/settings/personalAccessToken' &&
        allText.includes('1. 组织管理 / 用户信息：只读') &&
        allText.includes('2. 项目协作（Projex）') &&
        allText.includes('3. 代码管理（Codeup）'),
      '1.4 helperLink 渲染深链按钮调起 openUrl，helperLines 渲染 3 行最小权限勾选口诀',
      { helperBtnCount: helperBtns.length, openedUrls },
    )

    const selectNodes = findNodes(rendered, (n) => n.tag === 'select')
    const lockedNodes = findNodes(rendered, (n) => n.props?.['data-readonly-single'] === 'true')
    check(
      lockedNodes.length === 1 &&
        textOf(lockedNodes[0]).includes('默认组织 (org-1)') &&
        selectNodes.length === 1,
      '1.5 select 支持 readOnlyWhenSingle 单项只读锁定摘要条，多项或未锁定时渲染下拉框 <select>',
      { lockedCount: lockedNodes.length, selectCount: selectNodes.length },
    )

    const newProjInputs = findNodes(rendered, (n) => n.tag === 'input' && n.props.id?.includes('newProjectName'))
    check(
      newProjInputs.length === 0 &&
        allText.includes('检测到 MattDemo，建议切换项目') &&
        allText.includes('令牌仅以 0600 权限保存在本机'),
      '1.6 visibleWhen 隐藏不匹配字段（newProjectName），banner 与 m.bannersByField 正常渲染 warn/info 横幅',
      { newProjInputs: newProjInputs.length },
    )

    // 触发 select onChange 验证 rehydrateOnChange 回调
    if (selectNodes[0]?.props?.onChange) {
      selectNodes[0].props.onChange({ target: { value: 'p2' } })
    }
    check(
      vals.projectId === 'p2' &&
        rehydrateCalls.length === 1 &&
        rehydrateCalls[0].name === 'projectId' &&
        rehydrateCalls[0].value === 'p2',
      '1.7 select 变更更新 vals 并对 rehydrateOnChange:true 字段触发 onFieldChange 水合回调',
      { vals, rehydrateCalls },
    )

    // 1.8 切换到 reuse / bind 且仅有一个候选时，下拉框显示的默认项必须同步进入 vals 与 valuesByStep
    const realStep1Schema = fixesMod.fixes['yunxiao:configured'].actions[0].steps[1].schema
    const realStep2Schema = fixesMod.fixes['yunxiao:configured'].actions[0].steps[2].schema
    const singleReuseVals: Record<string, any> = { organizationId: 'org-1', projectMode: 'reuse', projectId: '' }
    const singleBindVals: Record<string, any> = { repoMode: 'bind', repositoryId: '', remoteProtocol: 'auto' }
    const singleSelectModal: any = {
      pending: false,
      valuesByStep: [{}, { organizationId: 'org-1', projectMode: 'reuse' }, { repoMode: 'bind', remoteProtocol: 'auto' }],
      optionsByField: {
        organizationId: [{ value: 'org-1', label: { zh: '组织一', en: 'Org 1' } }],
        projectId: [{ value: '8efcbccd3981cb23178fc66bd1', label: { zh: '唯一项目 (PLAN)', en: 'Only Project' } }],
        repositoryId: [{ value: '7001', label: { zh: 'org-1/only-repo (#7001)', en: 'org-1/only-repo (#7001)' } }],
        namespaceId: [
          { value: '9001', label: { zh: 'org-1/apps', en: 'org-1/apps' } },
          { value: '', label: { zh: 'org-1 [组织根路径兜底]', en: 'org-1 [organization root]' } },
        ],
      },
    }
    fieldsMod.modalFormFields(realStep1Schema, { m: singleSelectModal, isWizard: true, stepIndex: 1, vals: singleReuseVals, setVals: () => {}, h })
    fieldsMod.modalFormFields(realStep2Schema, { m: singleSelectModal, isWizard: true, stepIndex: 2, vals: singleBindVals, setVals: () => {}, h })
    let rootNsVals: Record<string, any> = { repoMode: 'create', name: 'my-repo', namespaceId: '9001', visibility: 'private', remoteProtocol: 'auto' }
    singleSelectModal.valuesByStep[2] = Object.assign({}, rootNsVals)
    const nsTree1 = fieldsMod.modalFormFields(realStep2Schema, { m: singleSelectModal, isWizard: true, stepIndex: 2, vals: rootNsVals, setVals: (nxt: any) => { rootNsVals = nxt }, h })
    const nsSelectNode = findNodes(nsTree1, (n) => n.tag === 'select' && String(n.props.id || '').includes('namespaceId'))[0]
    if (nsSelectNode?.props?.onChange) nsSelectNode.props.onChange({ target: { value: '' } })
    fieldsMod.modalFormFields(realStep2Schema, { m: singleSelectModal, isWizard: true, stepIndex: 2, vals: rootNsVals, setVals: (nxt: any) => { rootNsVals = nxt }, h })
    const reuseValid = wizMod.validateWizardFields(realStep1Schema, singleReuseVals)
    const bindValid = wizMod.validateWizardFields(realStep2Schema, singleBindVals)
    check(
      singleReuseVals.projectId === '8efcbccd3981cb23178fc66bd1' &&
        singleSelectModal.valuesByStep[1].projectId === '8efcbccd3981cb23178fc66bd1' &&
        singleBindVals.repositoryId === '7001' &&
        reuseValid.ok === true &&
        bindValid.ok === true &&
        rootNsVals.namespaceId === '' &&
        singleSelectModal.valuesByStep[2].namespaceId === '',
      '1.8 下拉框首项默认值同步写入提交状态（单候选直过校验），且显式选中空串「组织根路径兜底」在重渲染后稳定保持',
      { singleReuseVals, singleBindVals, rootNsVals, stored2: singleSelectModal.valuesByStep[2], reuseValid, bindValid },
    )
  }

  console.log('== 2. 向导生命周期：visibleWhen 校验跳过、initialStepIndex 跳步、stepAction 在线门控、多深链成功弹窗 ==')
  {
    const isFieldVisible = wizMod.isWizardFieldVisible
    const validateFields = wizMod.validateWizardFields
    check(
      typeof isFieldVisible === 'function' &&
        typeof validateFields === 'function' &&
        isFieldVisible({ name: 'a', visibleWhen: { field: 'mode', equals: 'create' } }, { mode: 'existing' }) === false &&
        isFieldVisible({ name: 'a', visibleWhen: { field: 'mode', equals: ['create', 'fork'] } }, { mode: 'fork' }) === true &&
        isFieldVisible({ name: 'a', visibleWhen: { field: 'mode', notEquals: 'existing' } }, { mode: 'create' }) === true,
      '2.1 isWizardFieldVisible 正确判定 equals(字符串/数组) 与 notEquals 条件显隐',
    )

    const schemaWithHiddenRequired = [
      { name: 'mode', type: 'single', required: true, label: '模式' },
      { name: 'hiddenReq', type: 'text', required: true, pattern: '^[0-9]+$', label: '隐藏必填项', visibleWhen: { field: 'mode', equals: 'create' } },
    ]
    const validWhenHidden = typeof validateFields === 'function'
      ? validateFields(schemaWithHiddenRequired, { mode: 'existing', hiddenReq: '' })
      : { ok: false }
    const invalidWhenVisible = typeof validateFields === 'function'
      ? validateFields(schemaWithHiddenRequired, { mode: 'create', hiddenReq: '' })
      : { ok: true }
    check(
      validWhenHidden.ok === true && invalidWhenVisible.ok === false,
      '2.2 validateWizardFields 对隐藏字段跳过 required/pattern 校验，对可见字段严格执行校验',
      { validWhenHidden, invalidWhenVisible },
    )

    // 测试 openFormModal + hydrateWizardModal + runWizardStepNext
    const st: any = { cwd: '/ws/yx-test', tick: 0 }
    const yxWizardAction = fixesMod.fixes['yunxiao:configured']?.actions?.[0]
    queueMod.openFormModal(st, yxWizardAction, async (merged: any) => ({
      ok: true,
      data: {
        ok: true,
        repo: { owner: 'org-1', name: merged.name || 'my-repo' },
        repoUrl: 'https://codeup.aliyun.com/org-1/my-repo',
        links: [
          { label: { zh: '打开云效项目 ↗', en: 'Open Projex project ↗' }, url: 'https://devops.aliyun.com/projex/project/p1', primary: true },
          { label: { zh: '打开 Codeup 仓库 ↗', en: 'Open Codeup repo ↗' }, url: 'https://codeup.aliyun.com/org-1/my-repo' },
        ],
        hint: { zh: '工作区坐标已写入 docs/agents/yunxiao.yaml', en: 'Coordinates saved to docs/agents/yunxiao.yaml' },
      },
    }))

    check(
      st.formModal?.open === true &&
        st.formModal?.isWizard === true &&
        st.formModal?.stepIndex === 1 &&
        st.formModal?.hydrateRpc?.method === 'wf.yunxiaoDiscover' &&
        st.formModal?.steps?.[0]?.stepAction?.method === 'wf.yunxiaoSaveToken',
      '2.3 openFormModal 透传 initialStepIndex=1、hydrateRpc 与 steps[0].stepAction，已认证向导直达第 2 步(stepIndex=1)',
      {
        stepIndex: st.formModal?.stepIndex,
        hydrateRpc: st.formModal?.hydrateRpc,
        step0Action: st.formModal?.steps?.[0]?.stepAction,
      },
    )

    // 渲染 stepper 验证第 1 步标绿 ✓ 且可点击回退或点上一步回退
    if (typeof wizMod.renderWizardStepper === 'function') {
      const stepperVNode = wizMod.renderWizardStepper(st, st.formModal, { token: '' }, h)
      const stepperText = textOf(stepperVNode)
      check(
        stepperText.includes('✓'),
        '2.4 当 stepIndex=1 时第 1 步圆点显示绿色完成标记 ✓',
        { stepperText },
      )
    } else {
      check(false, '2.4 renderWizardStepper 尚未导出')
    }

    // 回退到第 1 步，测试 stepAction 失败阻断前进、成功推进并触发水合
    st.formModal.stepIndex = 0
    st.formModal.authenticated = false
    let saveCalls = 0
    let discoverCalls = 0
    const fakeHostFail = {
      call: async (method: string, params: any) => {
        if (method === 'wf.yunxiaoSaveToken') {
          saveCalls += 1
          return { ok: false, errorKind: 'auth', error: '令牌无效或已过期（HTTP 401）' }
        }
        return { ok: true }
      },
    }
    const nextFailRes = typeof wizMod.runWizardStepNext === 'function'
      ? await wizMod.runWizardStepNext(st, st.formModal, { token: 'pt-bad' }, fakeHostFail)
      : { ok: true }
    check(
      nextFailRes?.ok === false &&
        st.formModal.stepIndex === 0 &&
        Boolean(st.formModal.fail?.text?.includes('401')),
      '2.5 第 1 步 stepAction 返回失败时设置 m.fail 内联错误条并留在第 1 步（绝不前进）',
      { nextFailRes, stepIndex: st.formModal.stepIndex, fail: st.formModal.fail },
    )

    const fakeHostPass = {
      call: async (method: string, params: any) => {
        if (method === 'wf.yunxiaoSaveToken') {
          saveCalls += 1
          return {
            ok: true,
            user: { id: 'u1', name: 'Bryan' },
            tokenFilePath: '~/.config/yunxiao/token',
            envShadowWarning: true,
            warningText: { zh: '检测到环境变量 YUNXIAO_TOKEN，将优先于配置文件生效', en: 'YUNXIAO_TOKEN env overrides file' },
          }
        }
        if (method === 'wf.yunxiaoDiscover') {
          discoverCalls += 1
          return {
            ok: true,
            authenticated: true,
            bannersByField: {},
            optionsByField: {
              organizationId: [{ value: 'org-1', label: 'Org 1' }],
            },
            defaultsByField: {
              organizationId: 'org-1',
              projectMode: 'reuse',
              repoMode: 'bind',
            },
          }
        }
        return { ok: true }
      },
    }
    const nextPassRes = typeof wizMod.runWizardStepNext === 'function'
      ? await wizMod.runWizardStepNext(st, st.formModal, { token: 'pt-good-token' }, fakeHostPass)
      : { ok: false }
    check(
      nextPassRes?.ok === true &&
        st.formModal.stepIndex === 1 &&
        st.formModal.fail === null &&
        discoverCalls === 1 &&
        st.formModal.optionsByField?.organizationId?.length === 1 &&
        st.formModal.valuesByStep?.[1]?.organizationId === 'org-1' &&
        st.formModal.valuesByStep?.[1]?.projectMode === 'reuse' &&
        st.formModal.valuesByStep?.[2]?.repoMode === 'bind' &&
        Boolean(st.formModal.bannersByField?.token),
      '2.6 第 1 步 stepAction 成功后记录环境变量遮蔽警告横幅、自动调用 hydrateRpc 刷新第 2/3 步选项与默认值（覆盖静态 create 默认值），并推进到 stepIndex=1',
      {
        nextPassRes,
        stepIndex: st.formModal.stepIndex,
        discoverCalls,
        orgOpts: st.formModal.optionsByField?.organizationId,
        step1Vals: st.formModal.valuesByStep?.[1],
        tokenBanner: st.formModal.bannersByField?.token,
      },
    )

    // 测试多深链成功弹窗构建与渲染
    const successState = typeof wizMod.buildWizardSuccessState === 'function'
      ? wizMod.buildWizardSuccessState(
          {
            data: {
              ok: true,
              repo: { owner: 'org-1', name: 'my-repo' },
              repoUrl: 'https://codeup.aliyun.com/org-1/my-repo',
              links: [
                { label: { zh: '打开云效项目 ↗', en: 'Open Projex project ↗' }, url: 'https://devops.aliyun.com/projex/project/p1', primary: true },
                { label: { zh: '打开 Codeup 仓库 ↗', en: 'Open Codeup repo ↗' }, url: 'https://codeup.aliyun.com/org-1/my-repo' },
              ],
              hint: { zh: '工作区坐标已写入 docs/agents/yunxiao.yaml', en: 'Coordinates saved' },
            },
          },
          '私有',
        )
      : null
    const clickedSuccessUrls: string[] = []
    const successModalVNode = typeof wizMod.renderWizardSuccessModal === 'function' && successState
      ? wizMod.renderWizardSuccessModal(
          successState,
          () => {},
          () => {},
          { h, openUrl: (u: string) => clickedSuccessUrls.push(u), tr: (k: string) => k },
        )
      : null
    const linkBtns = findNodes(successModalVNode, (n) => n.tag === 'button' && String(n.props['data-log'] || '').startsWith('modal.success.link.'))
    for (const btn of linkBtns) {
      if (btn.props.onClick) btn.props.onClick()
    }
    check(
      Boolean(successState) &&
        linkBtns.length === 2 &&
        clickedSuccessUrls.includes('https://devops.aliyun.com/projex/project/p1') &&
        clickedSuccessUrls.includes('https://codeup.aliyun.com/org-1/my-repo') &&
        textOf(successModalVNode).includes('工作区坐标已写入 docs/agents/yunxiao.yaml'),
      '2.7 多深链成功弹窗渲染全部 links 按钮（点击调 openUrl）与 hint 提示，且无 links 时兼容单仓视图',
      { linkBtnCount: linkBtns.length, clickedSuccessUrls },
    )

    // 2.8 重新发现后清掉已经失效的项目预警，但不能抹掉令牌步骤的环境变量警告
    const rehydratedModal: any = {
      bannersByField: {
        token: { level: 'warn', text: { zh: '环境变量优先', en: 'Environment variable wins' } },
        projectMode: { level: 'warn', text: { zh: '旧项目错位', en: 'Stale project mismatch' } },
      },
    }
    wizMod.applyWizardHydratePayload(rehydratedModal, {
      bannersByField: { organizationId: { level: 'info', text: { zh: '新组织', en: 'New organization' } } },
    }, true)
    check(
      Boolean(rehydratedModal.bannersByField.token) &&
        !rehydratedModal.bannersByField.projectMode &&
        rehydratedModal.bannersByField.organizationId?.level === 'info',
      '2.8 水合刷新会清除旧项目预警，同时保留令牌警告并展示新组织横幅',
      rehydratedModal.bannersByField,
    )

    // 2.9 组织切换异步水合期间阻断步进与提交，水合完成后清理旧组织残留选择并剥离隐藏字段
    {
      const g = globalThis as Record<string, any>
      g.modalFormFields = fieldsMod.modalFormFields
      g.isWizardFieldVisible = wizMod.isWizardFieldVisible
      g.pruneHiddenWizardValues = wizMod.pruneHiddenWizardValues
      g.hydrateWizardModal = wizMod.hydrateWizardModal
      g.runWizardStepNext = wizMod.runWizardStepNext
      g.renderWizardStepper = wizMod.renderWizardStepper
      g.buildWizardSuccessState = wizMod.buildWizardSuccessState
      g.renderWizardSuccessModal = wizMod.renderWizardSuccessModal
      g.closeFormModal = queueMod.closeFormModal
      g._queueLen = (s: any) => (Array.isArray(s && s._formModalQueue) ? s._formModalQueue.length : 0)
      g.SLOT_MODAL_OPEN_DELAY_MS = 0
      g.tr = (k: string) => k
      g.visLabelOf = (v: string) => v
      g.startRepoSync = () => {}
      g.runRepoSyncRecheck = () => {}
      g.resolveFailText = (_st: any, _d: string, _c: string, msg: string) => msg
      let seatValsState: any = null
      g.React = {
        createElement: h,
        useContext: () => ({ h }),
        useState: (init: any) => {
          seatValsState = typeof init === 'function' ? init() : init
          return [seatValsState, (nxt: any) => { seatValsState = nxt }]
        },
        useEffect: () => {},
      }
      const modalViewMod = await imp('src/client/kernel/slotRenderer-modal-view.ts')
      let submittedMerged: any = null
      let submitCalls = 0
      const stHyd: any = { cwd: '/ws/org-switch', tick: 0 }
      const yxAct = fixesMod.fixes['yunxiao:configured'].actions[0]
      queueMod.openFormModal(stHyd, yxAct, async (merged: any) => {
        submitCalls += 1
        submittedMerged = merged
        return { ok: true, data: { ok: true, repo: { owner: 'org-2', name: 'org-switch' } } }
      })
      stHyd.formModal.valuesByStep[1] = { organizationId: 'org-1', projectMode: 'reuse', projectId: 'proj-from-org-1' }
      stHyd.formModal.valuesByStep[2] = { repoMode: 'bind', repositoryId: 'repo-from-org-1', remoteProtocol: 'auto' }

      let resolveDiscover!: (val: any) => void
      const pendingDiscover = new Promise((r) => { resolveDiscover = r })
      const hydratePromise = wizMod.hydrateWizardModal(
        stHyd,
        stHyd.formModal,
        { organizationId: 'org-2' },
        { call: () => pendingDiscover },
      )
      const stepNextWhileHydrating = await wizMod.runWizardStepNext(stHyd, stHyd.formModal, stHyd.formModal.valuesByStep[1])
      const treeStep1Hydrating = modalViewMod.FormModalSeat({ st: stHyd })
      const nextBtnHydrating = findNodes(treeStep1Hydrating, (n) => n.tag === 'button' && n.props['data-log'] === 'modal.wizard.next')[0]
      stHyd.formModal.stepIndex = 2
      const treeStep2Hydrating = modalViewMod.FormModalSeat({ st: stHyd })
      const submitBtnHydrating = findNodes(treeStep2Hydrating, (n) => n.tag === 'button' && n.props['data-log'] === 'modal.wizard.submit')[0]
      if (submitBtnHydrating?.props?.onClick) await submitBtnHydrating.props.onClick()
      const blockedDuringHydrate =
        stHyd.formModal.hydrating === true &&
        stepNextWhileHydrating.ok === false &&
        Boolean(nextBtnHydrating?.props?.disabled) &&
        Boolean(submitBtnHydrating?.props?.disabled) &&
        submitCalls === 0

      resolveDiscover({
        ok: true,
        authenticated: true,
        optionsByField: {
          organizationId: [{ value: 'org-1', label: { zh: '一', en: '1' } }, { value: 'org-2', label: { zh: '二', en: '2' } }],
          projectId: [{ value: 'proj-from-org-2', label: { zh: '组织二项目', en: 'Org 2 Proj' } }],
          repositoryId: [],
        },
        defaultsByField: {
          organizationId: 'org-2',
          projectMode: 'create',
          projectName: 'org-switch',
          customCode: 'ORGSW',
          repoMode: 'none',
        },
      })
      await hydratePromise
      stHyd.formModal.stepIndex = 2
      const treeAfterHydrate = modalViewMod.FormModalSeat({ st: stHyd })
      const submitBtnAfter = findNodes(treeAfterHydrate, (n) => n.tag === 'button' && n.props['data-log'] === 'modal.wizard.submit')[0]
      if (submitBtnAfter?.props?.onClick) await submitBtnAfter.props.onClick()

      check(
        blockedDuringHydrate &&
          submitCalls === 1 &&
          submittedMerged?.organizationId === 'org-2' &&
          submittedMerged?.projectMode === 'create' &&
          submittedMerged?.repoMode === 'none' &&
          !('projectId' in submittedMerged) &&
          !('repositoryId' in submittedMerged) &&
          !('remoteProtocol' in submittedMerged) &&
          !('visibility' in submittedMerged),
        '2.9 组织切换水合期间禁用下一步/提交并阻断运行时提交，水合完成后清理旧组织残留 ID 且提交时不夹带隐藏字段',
        { blockedDuringHydrate, submitCalls, submittedMerged },
      )
    }
  }

  console.log('== 3. 动作分发器 createActionDispatcher 透传向导扩展属性 ==')
  {
    let capturedModalPayload: any = null
    const dispatcher = actionsMod.createActionDispatcher({
      renderForm: async (payload: any) => {
        capturedModalPayload = payload
      },
      hostCall: async () => ({ ok: true }),
    })
    const wizardAct = fixesMod.fixes['yunxiao:authed']?.actions?.[0]
    await dispatcher.dispatch(wizardAct)
    check(
      capturedModalPayload?.type === 'wizard' &&
        capturedModalPayload?.initialStepIndex === 0 &&
        capturedModalPayload?.hydrateRpc?.method === 'wf.yunxiaoDiscover' &&
        capturedModalPayload?.steps?.[0]?.stepAction?.method === 'wf.yunxiaoSaveToken' &&
        capturedModalPayload?.steps?.[0]?.schema?.[0]?.name === 'token' &&
        capturedModalPayload?.steps?.[0]?.schema?.[0]?.type === 'password',
      '3.1 createActionDispatcher 将 wizard 的 initialStepIndex / hydrateRpc / steps[0].stepAction 完整透传给 renderForm，且 fixes.ts 第 1 步含 password 令牌字段',
      capturedModalPayload,
    )
  }

  console.log('== 4. 宿主 wf.yunxiaoSaveToken 在线验真、0700/0600 原子落盘、环境变量遮蔽警告与零明文泄露 ==')
  {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-yx-token-test-'))
    const tokenDir = path.join(tmpHome, '.config', 'yunxiao')
    const tokenFile = path.join(tokenDir, 'token')
    fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(tokenFile, 'pt-existing-valid-token\n', { encoding: 'utf8', mode: 0o600 })

    const loggedEvents: Array<{ level: string; event: string; fields: any }> = []
    const logCtx = {
      fire(level: string, event: string, fields: any) {
        loggedEvents.push({ level, event, fields: typeof fields === 'function' ? fields() : fields })
      },
      isEnabled() { return true },
    }

    const FAKE_SECRET_BAD = 'pt-SuperSecretInvalidToken987654321'
    const FAKE_SECRET_GOOD = 'pt-SuperSecretValidToken123456789'

    if (typeof onboardMod.createYunxiaoOnboarding === 'function') {
      // 4.1 格式非法（空串 / 含空格 / 含控制字符）直接拒绝，不发网络请求、不改已有文件
      let networkCalls = 0
      const onboarding = onboardMod.createYunxiaoOnboarding({
        homeDir: tmpHome,
        logCtx,
        loadExtras: () => builtinsMod.loadYunxiaoHostExtras(),
        fetch: async (input: string | URL, init?: RequestInit) => {
          networkCalls += 1
          const headers = (init?.headers || {}) as Record<string, string>
          const tok = headers['x-yunxiao-token'] || ''
          if (tok === FAKE_SECRET_GOOD) {
            return new Response(
              JSON.stringify({ id: 'u-100', name: 'BryanShao', username: 'bryan', lastOrganization: '673db5665c76405a332eebc4' }),
              { status: 200 },
            )
          }
          return new Response(JSON.stringify({ errorMessage: 'invalid token ' + tok }), { status: 401 })
        },
      })

      const emptyRes = await onboarding.handleYunxiaoSaveToken({ cwd: '/ws', token: '   ' })
      const spaceRes = await onboarding.handleYunxiaoSaveToken({ cwd: '/ws', token: 'pt-tok with space' })
      const ctrlRes = await onboarding.handleYunxiaoSaveToken({ cwd: '/ws', token: 'pt-tok\x07bell' })
      check(
        emptyRes.ok === false &&
          emptyRes.errorKind === 'parse' &&
          spaceRes.ok === false &&
          spaceRes.errorKind === 'parse' &&
          ctrlRes.ok === false &&
          ctrlRes.errorKind === 'parse' &&
          networkCalls === 0 &&
          fs.readFileSync(tokenFile, 'utf8') === 'pt-existing-valid-token\n',
        '4.1 空令牌、含空白或控制字符的令牌立即返回 parse 错误，零网络请求且不碰磁盘',
        { emptyRes, spaceRes, ctrlRes, networkCalls },
      )

      // 4.2 在线验真 401 失败时，绝不覆盖已有的 ~/.config/yunxiao/token，且不泄露令牌原文
      const authFailRes = await onboarding.handleYunxiaoSaveToken({ cwd: '/ws', token: FAKE_SECRET_BAD })
      const diskAfterFail = fs.readFileSync(tokenFile, 'utf8')
      check(
        authFailRes.ok === false &&
          authFailRes.errorKind === 'auth' &&
          networkCalls === 1 &&
          diskAfterFail === 'pt-existing-valid-token\n' &&
          !JSON.stringify(authFailRes).includes(FAKE_SECRET_BAD),
        '4.2 在线 GET /oapi/v1/platform/user 返回 401 时拒绝落盘，原 ~/.config/yunxiao/token 保持不变且报错零令牌回显',
        { authFailRes, diskAfterFail },
      )

      // 4.3 在线验真通过 + 环境变量遮蔽检测 + 0700/0600 原子写入
      const onboardingWithEnv = onboardMod.createYunxiaoOnboarding({
        homeDir: tmpHome,
        env: { get: (k: string) => (k === 'YUNXIAO_TOKEN' ? 'pt-env-override-token' : undefined) },
        logCtx,
        loadExtras: () => builtinsMod.loadYunxiaoHostExtras(),
        fetch: async (input: string | URL, init?: RequestInit) => {
          networkCalls += 1
          return new Response(
            JSON.stringify({ id: 'u-100', name: 'BryanShao', username: 'bryan', lastOrganization: '673db5665c76405a332eebc4' }),
            { status: 200 },
          )
        },
      })
      const saveOkRes = await onboardingWithEnv.handleYunxiaoSaveToken({
        cwd: '/ws',
        token: '  ' + FAKE_SECRET_GOOD + '\n',
      })
      const savedContent = fs.readFileSync(tokenFile, 'utf8')
      const dirMode = fs.statSync(tokenDir).mode & 0o777
      const fileMode = fs.statSync(tokenFile).mode & 0o777
      const remainingEntries = fs.readdirSync(tokenDir)
      const serializedLogs = JSON.stringify(loggedEvents)
      check(
        saveOkRes.ok === true &&
          saveOkRes.user?.id === 'u-100' &&
          saveOkRes.tokenFilePath === '~/.config/yunxiao/token' &&
          saveOkRes.envShadowWarning === true &&
          Boolean(saveOkRes.warningText) &&
          savedContent === FAKE_SECRET_GOOD + '\n' &&
          dirMode === 0o700 &&
          fileMode === 0o600 &&
          remainingEntries.length === 1 &&
          remainingEntries[0] === 'token' &&
          !JSON.stringify(saveOkRes).includes(FAKE_SECRET_GOOD) &&
          !serializedLogs.includes(FAKE_SECRET_GOOD) &&
          !serializedLogs.includes(FAKE_SECRET_BAD),
        '4.3 验真通过后以 0700 目录 + 0600 临时文件 + rename 原子落盘 ~/.config/yunxiao/token（无残留 tmp），返回 envShadowWarning，且返回值与日志零明文泄露',
        {
          saveOkRes,
          dirMode: dirMode.toString(8),
          fileMode: fileMode.toString(8),
          remainingEntries,
        },
      )

      // 4.4 handleYunxiaoDiscover 桩支持无令牌时返回 authenticated:false / initialStepIndex:0，有有效令牌时返回 authenticated:true / initialStepIndex:1
      const discAuthed = await onboarding.handleYunxiaoDiscover({ cwd: '/ws' })
      check(
        discAuthed.ok === true &&
          discAuthed.authenticated === true &&
          discAuthed.initialStepIndex === 1,
        '4.4 handleYunxiaoDiscover 在本机令牌已有效时返回 authenticated:true 与 initialStepIndex:1',
        discAuthed,
      )

      // 4.5 发现阶段切换组织或取消向导不得提前写入 preferences.json；仅新建项目成功后写入，且写失败记诊断日志
      const prefPath = path.join(tokenDir, 'preferences.json')
      await onboarding.handleYunxiaoDiscover({ cwd: '/ws', organizationId: '673db5665c76405a332eebc4' })
      const existedAfterDiscoverOnly = fs.existsSync(prefPath)
      if (typeof onboarding.savePreferredOrganization === 'function') {
        await onboarding.savePreferredOrganization('673db5665c76405a332eebc4')
      }
      const savedAfterCreate = fs.existsSync(prefPath) ? fs.readFileSync(prefPath, 'utf8') : ''
      const failPrefOnboarding = onboardMod.createYunxiaoOnboarding({
        homeDir: tmpHome,
        logCtx,
        fs: {
          mkdir: async () => { throw new Error('EACCES: read-only home') },
        },
      })
      const logCountBefore = loggedEvents.length
      if (typeof failPrefOnboarding.savePreferredOrganization === 'function') {
        await failPrefOnboarding.savePreferredOrganization('673db5665c76405a332eebc4')
      }
      const prefFailLogged = loggedEvents.slice(logCountBefore).some((e) => e.event === 'choiceStore.write.fail' && e.fields?.keyHash === 'yunxiao-pref')
      check(
        existedAfterDiscoverOnly === false &&
          savedAfterCreate.includes('673db5665c76405a332eebc4') &&
          prefFailLogged === true,
        '4.5 wf.yunxiaoDiscover 不提前污染 preferences.json；新建项目成功后原子落盘组织偏好，且持久化失败记录 choiceStore.write.fail 诊断事件',
        { existedAfterDiscoverOnly, savedAfterCreate, prefFailLogged },
      )
    } else {
      check(false, '4.1 createYunxiaoOnboarding 尚未实现')
      check(false, '4.2 handleYunxiaoSaveToken 401 保护尚未实现')
      check(false, '4.3 handleYunxiaoSaveToken 0600 原子落盘尚未实现')
      check(false, '4.4 handleYunxiaoDiscover 尚未实现')
    }

    try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {}
  }

  console.log('\n== 5. 组织与项目发现：401 未认证、403 降级、预选优先级、MattDemo 错位纠偏与双源命名空间 ==')
  {
    const discoverMod = await imp('src/tracker/rooms/yunxiao/project/discover.ts')
    const { discoverYunxiaoWorkspace } = discoverMod
    const ORG = '673db5665c76405a332eebc4'
    const ORG_FILE = '111122223333444455556666'
    const ORG_PREF = 'aaaabbbbccccddddeeeeffff'
    const ORG_ACTIVE = '0123456789abcdef01234567'
    const PROJ = '8efcbccd3981cb23178fc66bd1'
    const PROJ_SANDBOX = 'aabbccdd112233445566778899'
    const PROJ_MATCH = 'ccddeeff001122334455667788'
    const YAML_REL = 'docs/agents/yunxiao.yaml'

    const runDiscover = async (opts: any) => {
      const fsPort = makePortFs(opts.files || {})
      const envPort = makePortEnv(Object.assign({ YUNXIAO_TOKEN: 'pt-valid-token-123456', HOME: '/home/u' }, opts.env || {}))
      const execPort = makePortExec(opts.exec || (() => ({ code: 1, stdout: '', stderr: 'no ssh' })))
      const fetchPort = makePortFetch(opts.routes)
      const res = await discoverYunxiaoWorkspace({
        cwd: opts.cwd,
        ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        lastSelectedOrganizationId: opts.lastSelectedOrganizationId || '',
        deps: {
          platform: { fs: fsPort, env: envPort, exec: execPort.fn },
          workspaceFs: fsPort, fetch: fetchPort.fn, homeDir: '/home/u',
        },
      })
      return { res, fsPort, fetchPort, execPort }
    }

    // 公共路由：用户探针成功、模板列表、代码库列表为空、命名空间 403（验证默认的静默降级路径）。
    // extra 排在兜底路由前面 —— 派发是按顺序取第一条命中的，兜底在前会把用例自带的响应挡掉。
    const routesWith = (orgReply: any, searchReply: any, extra?: any[]) => ([
      { match: (u: string) => u.endsWith('/oapi/v1/platform/user'), reply: () => ({ status: 200, body: { id: 'u-1', name: 'Bryan', username: 'bryan', lastOrganization: ORG_ACTIVE } }) },
      { match: (u: string) => u.endsWith('/oapi/v1/platform/organizations'), reply: orgReply },
      { method: 'POST', match: (u: string) => u.includes('/projects:search'), reply: searchReply },
      { match: (u: string) => u.includes('/projectTemplates'), reply: () => ({ status: 200, body: [{ id: 'tpl-scrum', name: 'Scrum 敏捷' }] }) },
      ...(extra || []),
      { match: (u: string) => /\/repositories(\?|$)/.test(u), reply: () => ({ status: 200, body: [] }) },
      { match: (u: string) => u.includes('/namespaces'), reply: () => ({ status: 403, body: { message: 'forbidden' } }) },
    ])

    // 5.1 令牌无效（401）时如实回未认证，且不编造任何选项
    const unauth = await runDiscover({
      cwd: '/ws/plain',
      routes: [{ match: (u: string) => u.endsWith('/oapi/v1/platform/user'), reply: () => ({ status: 401, body: { message: 'unauthorized' } }) }],
    })
    check(
      unauth.res.ok === true && unauth.res.authenticated === false && unauth.res.initialStepIndex === 0 &&
        Object.keys(unauth.res.optionsByField).length === 0,
      '5.1 令牌验真失败（HTTP 401）时 wf.yunxiaoDiscover 返回 authenticated:false 与 initialStepIndex:0，不编造任何选项',
      unauth.res,
    )

    // 5.2 ListOrganizations 返回 403（令牌未勾「组织：只读」）→ 降级为 lastOrganization 单项，第 2 步只读锁定
    const singleOrg = await runDiscover({
      cwd: '/ws/one',
      routes: routesWith(() => ({ status: 403, body: { message: 'forbidden' } }), () => ({ status: 200, body: [] })),
    })
    const singleOrgOpts = singleOrg.res.optionsByField.organizationId || []
    check(
      singleOrg.res.authenticated === true && singleOrg.res.initialStepIndex === 1 &&
        singleOrgOpts.length === 1 && singleOrgOpts[0].value === ORG_ACTIVE &&
        String(singleOrgOpts[0].label.zh).includes('当前活跃企业') &&
        singleOrg.res.defaultsByField.organizationId === ORG_ACTIVE,
      '5.2 ListOrganizations 遇 HTTP 403 静默降级为 user.lastOrganization 的单项只读列表，并预选该组织',
      { opts: singleOrgOpts, defaults: singleOrg.res.defaultsByField },
    )

    // 5.3 预选优先级第一档：当前工作区配置 > 偏好记忆 > lastOrganization > 列表首项
    const fileYaml = 'organizationId: ' + ORG_FILE + '\nprojectId: ' + PROJ + '\n'
    const fileWins = await runDiscover({
      cwd: '/ws/file-wins',
      files: { ['/ws/file-wins/' + YAML_REL]: fileYaml },
      lastSelectedOrganizationId: ORG_PREF,
      routes: routesWith(() => ({ status: 200, body: [{ id: ORG, name: '组织一' }] }), () => ({ status: 200, body: [] })),
    })
    check(
      fileWins.res.defaultsByField.organizationId === ORG_FILE,
      '5.3 组织预选：当前工作区 docs/agents/yunxiao.yaml 里的 organizationId 优先于偏好记忆与 lastOrganization',
      fileWins.res.defaultsByField,
    )

    const prefWins = await runDiscover({
      cwd: '/ws/pref-wins',
      lastSelectedOrganizationId: ORG_PREF,
      routes: routesWith(() => ({ status: 200, body: [{ id: ORG, name: '组织一' }] }), () => ({ status: 200, body: [] })),
    })
    check(
      prefWins.res.defaultsByField.organizationId === ORG_PREF,
      '5.4 组织预选：跨工作区记忆 ~/.config/yunxiao/preferences.json 的 lastSelectedOrganizationId 优先于 lastOrganization',
      prefWins.res.defaultsByField,
    )

    const activeWins = await runDiscover({
      cwd: '/ws/active-wins',
      routes: routesWith(() => ({ status: 200, body: [{ id: ORG, name: '组织一' }] }), () => ({ status: 200, body: [] })),
    })
    check(
      activeWins.res.defaultsByField.organizationId === ORG_ACTIVE,
      '5.5 组织预选：user.lastOrganization 优先于组织列表首项',
      activeWins.res.defaultsByField,
    )

    // 5.6 MattDemo 错位：本地 projectId 指向测试沙箱项目 → 黄色预警 + 默认新建同名项目以显式覆盖
    const mismatch = await runDiscover({
      cwd: '/ws/MattDemo',
      files: { ['/ws/MattDemo/' + YAML_REL]: 'organizationId: ' + ORG + '\nprojectId: ' + PROJ_SANDBOX + '\n' },
      routes: routesWith(
        () => ({ status: 200, body: [{ id: ORG, name: '组织一' }] }),
        () => ({ status: 200, body: [] }),
        [{ match: (u: string) => u.includes('/projects/' + PROJ_SANDBOX), reply: () => ({ status: 200, body: { id: PROJ_SANDBOX, name: 'dci-agentic-forge-sandbox', customCode: 'SANDBOX', logicalStatus: 'NORMAL' } }) }],
      ),
    })
    check(
      Boolean(mismatch.res.projectMismatchBanner) &&
        mismatch.res.bannersByField.projectMode?.level === 'warn' &&
        mismatch.res.bannersByField.projectId?.level === 'warn' &&
        mismatch.res.defaultsByField.projectMode === 'create' &&
        mismatch.res.defaultsByField.projectName === 'MattDemo',
      '5.6 本地 projectId 指向与工作区名不一致的沙箱项目时，返回黄色预警横幅并把 projectMode 默认切为新建同名项目',
      { banner: mismatch.res.projectMismatchBanner, defaults: mismatch.res.defaultsByField },
    )

    // 5.7 同名项目已存在 → 默认推荐复用（不改新建，避免重复建项目）
    const reuse = await runDiscover({
      cwd: '/ws/MattDemo',
      files: { ['/ws/MattDemo/' + YAML_REL]: 'organizationId: ' + ORG + '\nprojectId: ' + PROJ_SANDBOX + '\n' },
      routes: routesWith(
        () => ({ status: 200, body: [{ id: ORG, name: '组织一' }] }),
        () => ({ status: 200, body: [{ id: PROJ_MATCH, name: 'MattDemo', customCode: 'MATT', logicalStatus: 'NORMAL' }] }),
        [{ match: (u: string) => u.includes('/projects/' + PROJ_SANDBOX), reply: () => ({ status: 200, body: { id: PROJ_SANDBOX, name: 'dci-agentic-forge-sandbox', customCode: 'SANDBOX', logicalStatus: 'NORMAL' } }) }],
      ),
    })
    check(
      reuse.res.defaultsByField.projectMode === 'reuse' && reuse.res.defaultsByField.projectId === PROJ_MATCH,
      '5.7 组织内已存在与工作区同名的 Yunxiao Projex 项目时，默认推荐复用该项目而不是重复新建',
      reuse.res.defaultsByField,
    )

    // 5.8 双源命名空间：ListRepositories 的 pathWithNamespace 前缀聚合出父代码组；ListNamespaces 403 静默降级；根路径始终兜底
    const REPO_A = { id: 7001, pathWithNamespace: ORG + '/platform/alpha', webUrl: 'https://codeup.aliyun.com/' + ORG + '/platform/alpha', accessLevel: 40, archived: false, namespace: { id: 9001, path: ORG + '/platform', name: 'platform' } }
    const REPO_B = { id: 7002, pathWithNamespace: ORG + '/platform/beta', webUrl: 'https://codeup.aliyun.com/' + ORG + '/platform/beta', accessLevel: 40, archived: false, namespace: { id: 9001, path: ORG + '/platform', name: 'platform' } }
    const dual = await runDiscover({
      cwd: '/ws/dual',
      routes: routesWith(
        () => ({ status: 200, body: [{ id: ORG, name: '组织一' }] }),
        () => ({ status: 200, body: [] }),
        [{ match: (u: string) => /\/repositories(\?|$)/.test(u), reply: () => ({ status: 200, body: [REPO_A, REPO_B] }) }],
      ),
    })
    const nsOpts = dual.res.optionsByField.namespaceId || []
    const nsValues = nsOpts.map((o: any) => String(o.value))
    check(
      nsValues.includes('9001') && nsValues.includes('') && nsValues.filter((v: string) => v === '9001').length === 1,
      '5.8 双源父代码组发现：ListNamespaces 遇 403 时由 ListRepositories 前缀聚合去重出父代码组，并始终提供组织根路径兜底',
      nsValues,
    )

    // 5.9 ListNamespaces 可用时合并「没有任何代码库」的空代码组
    const withNs = await runDiscover({
      cwd: '/ws/with-ns',
      routes: routesWith(
        () => ({ status: 200, body: [{ id: ORG, name: '组织一' }] }),
        () => ({ status: 200, body: [] }),
        [
          { match: (u: string) => /\/repositories(\?|$)/.test(u), reply: () => ({ status: 200, body: [REPO_A] }) },
          { match: (u: string) => u.includes('/namespaces'), reply: () => ({ status: 200, body: [{ id: 9002, fullPath: ORG + '/infra', nameWithNamespace: 'infra', parentId: 0 }] }) },
        ],
      ),
    })
    const nsValues2 = (withNs.res.optionsByField.namespaceId || []).map((o: any) => String(o.value))
    check(
      nsValues2.includes('9002') && nsValues2.includes('9001') && nsValues2.includes(''),
      '5.9 ListNamespaces 可用时把没有代码库的空代码组一并合并进父代码组下拉，与仓库前缀聚合结果去重共存',
      nsValues2,
    )

    // 5.10 bind 模式预选：本地 git origin 命中组织内已有代码库 → 默认 bind 并选中该库
    const originHit = await runDiscover({
      cwd: '/ws/origin',
      routes: routesWith(
        () => ({ status: 200, body: [{ id: ORG, name: '组织一' }] }),
        () => ({ status: 200, body: [] }),
        [{ match: (u: string) => /\/repositories(\?|$)/.test(u), reply: () => ({ status: 200, body: [REPO_A, REPO_B] }) }],
      ),
      exec: (cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('remote') && args.includes('get-url')) {
          return { code: 0, stdout: 'git@codeup.aliyun.com:' + ORG + '/platform/alpha.git', stderr: '' }
        }
        if (cmd === 'ssh') {
          return { code: 0, stdout: 'Welcome to Codeup, Bryan!\n', stderr: '' }
        }
        return { code: 1, stdout: '', stderr: 'no ssh' }
      },
    })
    check(
      originHit.res.defaultsByField.repoMode === 'bind' &&
        originHit.res.defaultsByField.repositoryId === '7001' &&
        originHit.res.defaultsByField.remoteProtocol === 'auto',
      '5.10 本地 git origin 命中组织内已有 Codeup 代码库时，默认回填 bind 模式并选中该代码库，且 remoteProtocol 默认保持 auto',
      { defaults: originHit.res.defaultsByField, repos: (originHit.res.optionsByField.repositoryId || []).length },
    )

    // 5.11 坐标齐全但仓库权限不足（accessLevel < 20）→ 初始步落到第 3 步，让用户处理仓库访问
    const repoDenied = await runDiscover({
      cwd: '/ws/MattDemo',
      files: { ['/ws/MattDemo/' + YAML_REL]: 'organizationId: ' + ORG + '\nprojectId: ' + PROJ + '\nrepositoryId: 7002\n' },
      routes: routesWith(
        () => ({ status: 200, body: [{ id: ORG, name: '组织一' }] }),
        () => ({ status: 200, body: [{ id: PROJ, name: 'MattDemo', customCode: 'MATT', logicalStatus: 'NORMAL' }] }),
        [
          { match: (u: string) => u.includes('/projects/' + PROJ), reply: () => ({ status: 200, body: { id: PROJ, name: 'MattDemo', customCode: 'MATT', logicalStatus: 'NORMAL' } }) },
          { match: (u: string) => /\/repositories(\?|$)/.test(u), reply: () => ({ status: 200, body: [Object.assign({}, REPO_B, { accessLevel: 10 })] }) },
        ],
      ),
    })
    check(
      repoDenied.res.initialStepIndex === 2 && !repoDenied.res.projectMismatchBanner,
      '5.11 组织与项目坐标齐全、但关联 Codeup 代码库权限不足时，初始步直接落到第 3 步',
      { initialStepIndex: repoDenied.res.initialStepIndex, banner: repoDenied.res.projectMismatchBanner },
    )

    // 5.12 即使 SearchProjects 已列出本地 projectId，也必须用 GetProject 核验这份存量坐标
    const verifyExisting = await runDiscover({
      cwd: '/ws/MattDemo',
      files: { ['/ws/MattDemo/' + YAML_REL]: 'organizationId: ' + ORG + '\nprojectId: ' + PROJ + '\n' },
      routes: routesWith(
        () => ({ status: 200, body: [{ id: ORG, name: '组织一' }] }),
        () => ({ status: 200, body: [{ id: PROJ, name: 'MattDemo', customCode: 'MATT', logicalStatus: 'NORMAL' }] }),
        [{ match: (u: string) => u.includes('/projects/' + PROJ), reply: () => ({ status: 200, body: { id: PROJ, name: 'MattDemo', customCode: 'MATT', logicalStatus: 'NORMAL' } }) }],
      ),
    })
    check(
      verifyExisting.fetchPort.hits.some((hit) => hit.method === 'GET' && hit.url.includes('/projects/' + PROJ)) &&
        !verifyExisting.res.projectMismatchBanner && verifyExisting.res.defaultsByField.projectMode === 'reuse',
      '5.12 本地 projectId 已出现在 SearchProjects 结果中时仍调用 GetProject 核验，不凭列表摘要跳过校验',
      { hits: verifyExisting.fetchPort.hits, banner: verifyExisting.res.projectMismatchBanner },
    )
  }

  console.log('\n== 6. 一体化置备：三模式、SSH 自动优选、Persist-Before-Push、半成功重推与双深链 ==')
  {
    const initMod = await imp('src/tracker/rooms/yunxiao/project/init-project.ts')
    const publishMod = await imp('src/host/publishFlow.ts')
    const { initProject } = initMod
    const ORG = '673db5665c76405a332eebc4'
    const PROJ = '8efcbccd3981cb23178fc66bd1'
    const YAML_REL = 'docs/agents/yunxiao.yaml'

    const baseRoutes = (extra?: any[]) => ([
      ...(extra || []),
      { match: (u: string) => u.endsWith('/oapi/v1/platform/user'), reply: () => ({ status: 200, body: { id: 'u-1', name: 'Bryan', username: 'bryan', lastOrganization: ORG } }) },
      { method: 'POST', match: (u: string) => u.includes('/projects:search'), reply: () => ({ status: 200, body: [] }) },
      { match: (u: string) => u.includes('/projectTemplates'), reply: () => ({ status: 200, body: [{ id: 'tpl-scrum', name: 'Scrum 敏捷' }] }) },
      { match: (u: string) => u.includes('/projects/' + PROJ), reply: () => ({ status: 200, body: { id: PROJ, name: 'planning', customCode: 'PLAN', logicalStatus: 'NORMAL' } }) },
    ])

    /** 组装一次 initProject 调用所需的注入上下文与留痕容器。 */
    const runInit = async (opts: any) => {
      const fsPort = makePortFs(opts.files || {})
      const envPort = makePortEnv(Object.assign({ YUNXIAO_TOKEN: 'pt-valid-token-123456' }, opts.env || {}))
      const execPort = makePortExec(opts.exec || (() => ({ code: 0, stdout: '', stderr: '' })))
      const fetchPort = makePortFetch(opts.routes)
      const ctx: any = {
        cwd: opts.cwd,
        platform: {
          fs: fsPort, env: envPort, exec: execPort.fn,
          ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
          resolveExecutable: async (bin: string) => (bin === 'git' ? '/usr/bin/git' : null),
        },
        exec: execPort.fn,
        fetch: fetchPort.fn,
      }
      const res = await initProject({ cwd: opts.cwd }, opts.input, ctx)
      return { res, fsPort, execPort, fetchPort }
    }

    const gitOk = (cmd: string, args: string[]) => {
      if (cmd !== 'git') return { code: 1, stdout: '', stderr: 'not git' }
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'true\n', stderr: '' }
      if (args[0] === 'remote' && args[1] === 'get-url') return { code: 2, stdout: '', stderr: 'No such remote' }
      return { code: 0, stdout: '', stderr: '' }
    }

    // 6.1 repoMode='none' 纯规划工作区：只落组织与项目坐标（清掉旧 repositoryId），不跑任何 git/Codeup 操作
    const noneRes = await runInit({
      cwd: '/ws/planning',
      files: { ['/ws/planning/' + YAML_REL]: 'organizationId: ' + ORG + '\nprojectId: ' + PROJ + '\ncustomCode: MATE\nrepositoryId: 1234567\n' },
      input: { name: 'planning', repoMode: 'none' },
      routes: baseRoutes(),
      exec: () => ({ code: 1, stdout: '', stderr: 'none 模式不该起任何外部命令' }),
    })
    const noneYaml = noneRes.fsPort.writes[0]?.text || ''
    check(
      noneRes.res.ok === true &&
        noneRes.res.data.projectUrl === 'https://devops.aliyun.com/projex/project/' + PROJ &&
        Array.isArray(noneRes.res.data.extraUrls) && noneRes.res.data.extraUrls.length === 1 &&
        String(noneRes.res.data.hint?.zh || '').includes('MATE-') &&
        noneRes.execPort.calls.filter((c) => c.cmd === 'git').length === 0 &&
        noneYaml.includes('organizationId: ' + ORG) && noneYaml.includes('projectId: ' + PROJ) &&
        noneYaml.includes('customCode: MATE') && !noneYaml.includes('repositoryId'),
      '6.1 repoMode=none 只写入组织与 Projex 项目坐标、清除旧 repositoryId，零 git/Codeup 调用，并返回 Projex 深链与提交关联提示',
      { res: noneRes.res, yaml: noneYaml, gitCalls: noneRes.execPort.calls.length },
    )

    // 6.2 projectMode='reuse'：经 GetProject 校验并继承远端项目的 customCode，而不是自己编一个
    const reuseRes = await runInit({
      cwd: '/ws/planning',
      input: { name: 'planning', repoMode: 'none', organizationId: ORG, projectMode: 'reuse', projectId: PROJ },
      routes: baseRoutes(),
      exec: () => ({ code: 0, stdout: '', stderr: '' }),
    })
    check(
      reuseRes.res.ok === true && reuseRes.res.data.customCode === 'PLAN' &&
        String(reuseRes.fsPort.writes[0]?.text || '').includes('customCode: PLAN'),
      '6.2 projectMode=reuse 经 GetProject 校验目标项目并沿用它的 customCode 落盘',
      { res: reuseRes.res, yaml: reuseRes.fsPort.writes[0]?.text },
    )

    // 6.3 repoMode='bind'：经 GetRepository 解析 canonical Codeup repository identity 并落到坐标文件
    const BIND_REPO = { id: 8194002, pathWithNamespace: ORG + '/legacy/app', webUrl: 'https://codeup.aliyun.com/' + ORG + '/legacy/app', httpUrlToRepo: 'https://codeup.aliyun.com/' + ORG + '/legacy/app.git', sshUrlToRepo: 'git@codeup.aliyun.com:' + ORG + '/legacy/app.git', accessLevel: 30, archived: false }
    const bindRes = await runInit({
      cwd: '/ws/legacy',
      input: { name: 'app', repoMode: 'bind', repositoryId: '8194002', organizationId: ORG, projectMode: 'reuse', projectId: PROJ },
      routes: baseRoutes([{ match: (u: string) => u.includes('/repositories/8194002'), reply: () => ({ status: 200, body: BIND_REPO }) }]),
      exec: gitOk,
    })
    const bindYaml = bindRes.fsPort.writes[0]?.text || ''
    check(
      bindRes.res.ok === true && bindYaml.includes('repositoryId: "8194002"') &&
        bindRes.execPort.calls.some((c) => c.cmd === 'git' && c.args[0] === 'remote' && c.args[1] === 'add') &&
        bindRes.res.data.repoUrl === BIND_REPO.webUrl,
      '6.3 repoMode=bind 经 GetRepository 解析 codeup repository identity 并把 repositoryId 写入 docs/agents/yunxiao.yaml',
      { res: bindRes.res, yaml: bindYaml },
    )

    // 6.4 Persist-Before-Push：先落盘坐标，之后才起 git remote/push —— 推送翻车也不丢坐标
    {
      const fsPort = makePortFs({})
      const envPort = makePortEnv({ YUNXIAO_TOKEN: 'pt-valid-token-123456' })
      const writesAtPush: number[] = []
      const execPort = makePortExec((cmd: string, args: string[]) => {
        if (cmd !== 'git') return { code: 1, stdout: '', stderr: 'not git' }
        if (args[0] === 'push') writesAtPush.push(fsPort.writes.length)
        return gitOk(cmd, args)
      })
      const fetchPort = makePortFetch(baseRoutes([
        { method: 'POST', match: (u: string) => /\/repositories(\?|$)/.test(u), reply: () => ({ status: 200, body: { id: 8899001, pathWithNamespace: ORG + '/apps/new-app' } }) },
        { match: (u: string) => u.includes('/repositories/8899001'), reply: () => ({ status: 200, body: { id: 8899001, pathWithNamespace: ORG + '/apps/new-app', webUrl: 'https://codeup.aliyun.com/' + ORG + '/apps/new-app', httpUrlToRepo: 'https://codeup.aliyun.com/' + ORG + '/apps/new-app.git', sshUrlToRepo: 'git@codeup.aliyun.com:' + ORG + '/apps/new-app.git', accessLevel: 40 } }) },
      ]))
      const res = await initProject({ cwd: '/ws/new-app' }, {
        name: 'new-app', repoMode: 'create', organizationId: ORG, projectMode: 'reuse', projectId: PROJ, remoteProtocol: 'https',
      }, {
        cwd: '/ws/new-app',
        platform: { fs: fsPort, env: envPort, exec: execPort.fn, resolveExecutable: async (b: string) => (b === 'git' ? '/usr/bin/git' : null) },
        exec: execPort.fn, fetch: fetchPort.fn,
      } as any)
      check(
        res.ok === true && writesAtPush.length === 1 && writesAtPush[0] >= 1 &&
          String(fsPort.writes[0]?.path || '').endsWith(YAML_REL),
        '6.4 Persist-Before-Push：git push 发起之前 docs/agents/yunxiao.yaml 已经落盘（先写坐标再推送）',
        { ok: res.ok, writesAtPush, writes: fsPort.writes.map((w) => w.path) },
      )
    }

    // 6.5 remoteProtocol 缺省即为 auto，且本机 SSH 免密可用 → 自动优选 sshUrlToRepo
    const sshReady = await runInit({
      cwd: '/ws/ssh-ready',
      input: { name: 'ssh-app', repoMode: 'create', organizationId: ORG, projectMode: 'reuse', projectId: PROJ },
      routes: baseRoutes([
        { method: 'POST', match: (u: string) => /\/repositories(\?|$)/.test(u), reply: () => ({ status: 200, body: { id: 8899002, pathWithNamespace: ORG + '/apps/ssh-app' } }) },
        { match: (u: string) => u.includes('/repositories/8899002'), reply: () => ({ status: 200, body: { id: 8899002, pathWithNamespace: ORG + '/apps/ssh-app', webUrl: 'https://codeup.aliyun.com/' + ORG + '/apps/ssh-app', httpUrlToRepo: 'https://codeup.aliyun.com/' + ORG + '/apps/ssh-app.git', sshUrlToRepo: 'git@codeup.aliyun.com:' + ORG + '/apps/ssh-app.git' } }) },
      ]),
      exec: (cmd: string, args: string[]) => {
        if (cmd === 'ssh') return { code: 0, stdout: 'Welcome to Codeup, Bryan!\n', stderr: '' }
        return gitOk(cmd, args)
      },
    })
    const sshOrigin = sshReady.execPort.calls.find((c) => c.cmd === 'git' && c.args[0] === 'remote' && c.args[1] === 'add')
    check(
      sshReady.res.ok === true && String(sshOrigin?.args[3] || '') === 'git@codeup.aliyun.com:' + ORG + '/apps/ssh-app.git',
      '6.5 remoteProtocol 缺省按 auto 处理，用 ssh -T 探测到免密可用后让 origin 自动优选 sshUrlToRepo',
      { url: sshOrigin?.args[3], calls: sshReady.execPort.calls.map((c) => c.cmd + ' ' + c.args[0]) },
    )

    // 6.6 SSH 不可用时回退 httpUrlToRepo
    const sshDown = await runInit({
      cwd: '/ws/ssh-down',
      input: { name: 'http-app', repoMode: 'create', organizationId: ORG, projectMode: 'reuse', projectId: PROJ, remoteProtocol: 'auto' },
      routes: baseRoutes([
        { method: 'POST', match: (u: string) => /\/repositories(\?|$)/.test(u), reply: () => ({ status: 200, body: { id: 8899003, pathWithNamespace: ORG + '/apps/http-app' } }) },
        { match: (u: string) => u.includes('/repositories/8899003'), reply: () => ({ status: 200, body: { id: 8899003, pathWithNamespace: ORG + '/apps/http-app', webUrl: 'https://codeup.aliyun.com/' + ORG + '/apps/http-app', httpUrlToRepo: 'https://codeup.aliyun.com/' + ORG + '/apps/http-app.git', sshUrlToRepo: 'git@codeup.aliyun.com:' + ORG + '/apps/http-app.git' } }) },
      ]),
      exec: (cmd: string, args: string[]) => {
        if (cmd === 'ssh') return { code: 255, stdout: '', stderr: 'Permission denied (publickey)' }
        return gitOk(cmd, args)
      },
    })
    const httpOrigin = sshDown.execPort.calls.find((c) => c.cmd === 'git' && c.args[0] === 'remote' && c.args[1] === 'add')
    check(
      sshDown.res.ok === true && String(httpOrigin?.args[3] || '') === 'https://codeup.aliyun.com/' + ORG + '/apps/http-app.git',
      '6.6 SSH 免密不可用时自动回退 httpUrlToRepo，不让向导卡在 SSH 上',
      { url: httpOrigin?.args[3] },
    )

    // 6.7 首次推送失败：坐标已落盘，错误信封带回 repoUrl 供弹窗内联一键重推（halfCreated）
    const pushFail = await runInit({
      cwd: '/ws/push-fail',
      input: { name: 'retry-app', repoMode: 'create', organizationId: ORG, projectMode: 'reuse', projectId: PROJ, remoteProtocol: 'https' },
      routes: baseRoutes([
        { method: 'POST', match: (u: string) => /\/repositories(\?|$)/.test(u), reply: () => ({ status: 200, body: { id: 8899004, pathWithNamespace: ORG + '/apps/retry-app' } }) },
        { match: (u: string) => u.includes('/repositories/8899004'), reply: () => ({ status: 200, body: { id: 8899004, pathWithNamespace: ORG + '/apps/retry-app', webUrl: 'https://codeup.aliyun.com/' + ORG + '/apps/retry-app', httpUrlToRepo: 'https://codeup.aliyun.com/' + ORG + '/apps/retry-app.git', sshUrlToRepo: 'git@codeup.aliyun.com:' + ORG + '/apps/retry-app.git' } }) },
      ]),
      exec: (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'push') return { code: 128, stdout: '', stderr: 'fatal: unable to access remote' }
        return gitOk(cmd, args)
      },
    })
    check(
      pushFail.res.ok === false && Boolean(pushFail.res.error && pushFail.res.error.repoUrl) &&
        String(pushFail.fsPort.writes[0]?.text || '').includes('repositoryId: "8899004"'),
      '6.7 远端代码库已建、坐标已落盘，但首次 git push 失败时如实报错并带回 repoUrl 供一键重推（不丢坐标、不重复建项）',
      { error: pushFail.res.error, yaml: pushFail.fsPort.writes[0]?.text },
    )

    // 6.8 宿主 handleContractOp 把向导参数透传给房间 initProject，透传双深链与提示，且仅在 projectCreated:true 时回调组织偏好记忆
    {
      const captured: any = { input: null }
      const savedOrgs: string[] = []
      const flow = publishMod.createPublishFlow({
        DEFAULT_CWD: '/ws/host',
        resolveGit: async () => '/usr/bin/git',
        execProc: async () => ({ ok: true, text: 'true' }),
        canonicalKey: async (c: any) => String(c),
        repoKeys: {}, repoRoots: {}, setCache: () => {},
        makeCreateErrorClassifier: () => (_t: unknown, k: unknown) => String(k || 'unknown'),
        KIND_UNKNOWN: 'unknown',
        onProjectCreated: async (info: any) => { savedOrgs.push(info.organizationId) },
        openSession: async () => ({
          ok: true, backendId: 'yunxiao',
          call: async (fn: any) => fn({
            initProject: async (_h: any, input: any) => {
              captured.input = input
              return {
                ok: true,
                data: {
                  backend: 'yunxiao', refId: ORG + '/' + PROJ, name: 'yx/app',
                  url: 'https://codeup.aliyun.com/' + ORG + '/apps/app',
                  projectUrl: 'https://devops.aliyun.com/projex/project/' + PROJ,
                  repoUrl: 'https://codeup.aliyun.com/' + ORG + '/apps/app',
                  customCode: 'APP',
                  ...(input.projectMode === 'create' ? { projectCreated: true } : {}),
                  extraUrls: [
                    { label: { zh: '打开 Yunxiao Projex 项目 ↗', en: 'Open' }, url: 'https://devops.aliyun.com/projex/project/' + PROJ, primary: true },
                    { label: { zh: '打开 Codeup 代码库 ↗', en: 'Open' }, url: 'https://codeup.aliyun.com/' + ORG + '/apps/app' },
                  ],
                  hint: { zh: '提交说明里带上 APP-<编号> 即可自动关联工作项。', en: 'Use APP-<number>.' },
                },
              }
            },
          }, {}),
        }),
      })
      const out: any = await flow.handleContractOp({
        op: 'initProject', cwd: '/ws/host', name: 'app', visibility: 'private',
        organizationId: ORG, projectMode: 'reuse', projectId: PROJ, repoMode: 'create',
        namespaceId: '2813489', remoteProtocol: 'auto', description: '一键开仓',
      })
      const savedCountAfterReuse = savedOrgs.length
      const outCreate: any = await flow.handleContractOp({
        op: 'initProject', cwd: '/ws/host', name: 'app', visibility: 'private',
        organizationId: ORG, projectMode: 'create', projectName: 'App', repoMode: 'none',
      })
      check(
        out.ok === true && outCreate.ok === true &&
          savedCountAfterReuse === 0 && savedOrgs.length === 1 && savedOrgs[0] === ORG &&
          captured.input?.organizationId === ORG && captured.input?.projectMode === 'create' &&
          Array.isArray(out.links) && out.links.length === 2 && Boolean(out.hint) &&
          typeof out.projectUrl === 'string' && out.customCode === 'APP',
        '6.8 宿主 handleContractOp 透传向导参数与双深链提示，且仅在新建项目成功后触发组织偏好记忆（复用项目不改写）',
        { out, savedCountAfterReuse, savedOrgs, input: captured.input },
      )
    }

    // 6.9 真实 initProject 首次推送失败 → halfCreated → retryPushFlow 一键重推成功后保留 Projex + Codeup 双深链与提交关联提示
    {
      const repoSyncMod = await imp('src/refresh/rooms/client/repo-sync-renderer.ts')
      const fsPort = makePortFs({})
      const envPort = makePortEnv({ YUNXIAO_TOKEN: 'pt-valid-token-123456' })
      const fetchPort = makePortFetch(baseRoutes([
        { method: 'POST', match: (u: string) => u.endsWith('/projects'), reply: () => ({ status: 200, body: { id: PROJ, name: 'retry-real', customCode: 'PLAN' } }) },
        { method: 'POST', match: (u: string) => /\/repositories(\?|$)/.test(u), reply: () => ({ status: 200, body: { id: 8899009, pathWithNamespace: ORG + '/apps/retry-real' } }) },
        { match: (u: string) => u.includes('/repositories/8899009'), reply: () => ({ status: 200, body: { id: 8899009, pathWithNamespace: ORG + '/apps/retry-real', webUrl: 'https://codeup.aliyun.com/' + ORG + '/apps/retry-real', httpUrlToRepo: 'https://codeup.aliyun.com/' + ORG + '/apps/retry-real.git' } }) },
      ]))
      let pushAttempt = 0
      const halfSavedOrgs: string[] = []
      const flow = publishMod.createPublishFlow({
        DEFAULT_CWD: '/ws/retry-real',
        resolveGit: async () => '/usr/bin/git',
        execProc: async (argv: string[]) => {
          const sub = argv.slice(1)
          if (sub[0] === 'push') {
            pushAttempt += 1
            return pushAttempt === 1
              ? { ok: false, code: 128, error: 'fatal: network timeout during first push' }
              : { ok: true, code: 0, text: 'Everything up-to-date' }
          }
          if (sub[0] === 'remote' && sub[1] === 'get-url') return { ok: false, code: 2, error: 'No such remote' }
          return { ok: true, code: 0, text: 'true' }
        },
        canonicalKey: async (c: any) => String(c),
        repoKeys: {}, repoRoots: {}, setCache: () => {},
        makeCreateErrorClassifier: () => (_t: unknown, k: unknown) => String(k || 'network'),
        KIND_UNKNOWN: 'unknown',
        onProjectCreated: async (info: any) => { halfSavedOrgs.push(info.organizationId) },
        openSession: async (_cwd: unknown, opts?: any) => ({
          ok: true, backendId: 'yunxiao',
          call: async (fn: any) => fn({
            initProject: (handle: any, inp: any, c: any) => initProject(handle, inp, c),
          }, {
            cwd: '/ws/retry-real',
            platform: { fs: fsPort, env: envPort, exec: opts?.exec, resolveExecutable: async (b: string) => (b === 'git' ? '/usr/bin/git' : null) },
            exec: opts?.exec,
            fetch: fetchPort.fn,
          }),
        }),
      })
      const half: any = await flow.handleContractOp({
        op: 'initProject', cwd: '/ws/retry-real', name: 'retry-real', visibility: 'private',
        organizationId: ORG, projectMode: 'create', projectName: 'retry-real', customCode: 'PLAN', repoMode: 'create', remoteProtocol: 'https',
      })
      const g = globalThis as Record<string, any>
      g.buildWizardSuccessState = wizMod.buildWizardSuccessState
      g.closeFormModal = queueMod.closeFormModal
      g.host = {
        call: (method: string, payload: any) => {
          if (method === 'wf.retryPush') return flow.handleRetryPush(payload)
          return Promise.resolve({ ok: false })
        },
      }
      const stRetry: any = {
        cwd: '/ws/retry-real',
        formModal: {
          open: true,
          lastVis: 'private',
          fail: {
            kind: 'half-created',
            code: half.errorKind,
            text: half.error,
            link: half.repoUrl,
            repo: half.repo,
            halfCreated: half.halfCreated,
            links: half.links,
            hint: half.hint,
            projectUrl: half.projectUrl,
            customCode: half.customCode,
          },
        },
      }
      repoSyncMod.retryPushFlow(stRetry, stRetry.formModal)
      await new Promise((r) => setTimeout(r, 25))
      const retrySuccess = stRetry.formModal.success
      check(
        half.ok === false &&
          half.halfCreated === true &&
          pushAttempt === 2 &&
          Array.isArray(retrySuccess?.links) &&
          retrySuccess.links.length === 2 &&
          retrySuccess.links.some((l: any) => String(l.url).includes('/projex/project/' + PROJ)) &&
          retrySuccess.links.some((l: any) => String(l.url).includes('/apps/retry-real')) &&
          String(retrySuccess?.hint?.zh || '').includes('PLAN-') &&
          halfSavedOrgs.includes(ORG),
        '6.9 真实 initProject 首次推送失败返回 halfCreated:true，经 retryPushFlow 重推成功后完整保留 Projex + Codeup 双深链与提交关联提示',
        { half, pushAttempt, retrySuccess },
      )
    }

    // 6.10 新建项目：Scrum 模板、当前令牌身份与编号冲突后最多五次递增重试
    {
      const newProjectId = 'ffee00112233445566778899'
      const createBodies: Array<Record<string, unknown>> = []
      let everyCreateUsedCurrentToken = true
      const created = await runInit({
        cwd: '/ws/alpha',
        homeDir: '/home/u',
        input: { name: 'alpha', projectName: 'Alpha', repoMode: 'none', organizationId: ORG, projectMode: 'create' },
        routes: baseRoutes([
          {
            method: 'POST',
            match: (u: string) => u.endsWith('/projects'),
            reply: (_u: string, init?: RequestInit) => {
              const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
              createBodies.push(body)
              const headers = new Headers(init?.headers)
              everyCreateUsedCurrentToken = everyCreateUsedCurrentToken && headers.get('x-yunxiao-token') === 'pt-valid-token-123456'
              if (createBodies.length <= 5) return { status: 400, body: { message: 'customCode conflict' } }
              return { status: 200, body: { id: newProjectId, name: 'Alpha', customCode: body.customCode } }
            },
          },
        ]),
      })
      const customCodes = createBodies.map((body) => String(body.customCode || ''))
      const prefWrite = created.fsPort.writes.find((w) => w.path === '/home/u/.config/yunxiao/preferences.json')
      const implicitReuse = await runInit({
        cwd: '/ws/implicit-reuse',
        homeDir: '/home/u',
        input: { name: 'alpha', repoMode: 'none', organizationId: ORG },
        routes: baseRoutes([
          { method: 'POST', match: (u: string) => u.includes('/projects:search'), reply: () => ({ status: 200, body: [{ id: PROJ, name: 'alpha', customCode: 'ALPH', logicalStatus: 'NORMAL' }] }) },
        ]),
      })
      const implicitPrefWrite = implicitReuse.fsPort.writes.find((w) => w.path === '/home/u/.config/yunxiao/preferences.json')
      check(
        created.res.ok === true && createBodies.length === 6 &&
          customCodes[0] === 'ALPHA' && customCodes[5] === 'ALPHAE' &&
          createBodies.every((body) => body.templateId === 'tpl-scrum') &&
          everyCreateUsedCurrentToken && created.res.data?.customCode === 'ALPHAE' &&
          String(created.fsPort.writes[0]?.text || '').includes('projectId: ' + newProjectId) &&
          Boolean(prefWrite && prefWrite.text.includes(ORG)) &&
          implicitReuse.res.ok === true && !implicitPrefWrite,
        '6.10 projectMode=create 优选 Scrum 模板，以当前令牌创建项目，在编号冲突后完成最多五次递增重试，并将所选 organizationId 记入 ~/.config/yunxiao/preferences.json',
        { ok: created.res.ok, attempts: createBodies.length, customCodes, everyCreateUsedCurrentToken, error: created.res.error },
      )
    }

    // 6.11 非认证推送错误不应被当成 SSH 失败再推一次；保留半成功坐标供人处理
    {
      let origin = ''
      const pushUrls: string[] = []
      const rejected = await runInit({
        cwd: '/ws/hook-rejected',
        input: { name: 'hook-app', repoMode: 'create', organizationId: ORG, projectMode: 'reuse', projectId: PROJ, remoteProtocol: 'auto' },
        routes: baseRoutes([
          { method: 'POST', match: (u: string) => /\/repositories(\?|$)/.test(u), reply: () => ({ status: 200, body: { id: 8899005, pathWithNamespace: ORG + '/apps/hook-app' } }) },
          { match: (u: string) => u.includes('/repositories/8899005'), reply: () => ({ status: 200, body: { id: 8899005, pathWithNamespace: ORG + '/apps/hook-app', webUrl: 'https://codeup.aliyun.com/' + ORG + '/apps/hook-app', httpUrlToRepo: 'https://codeup.aliyun.com/' + ORG + '/apps/hook-app.git', sshUrlToRepo: 'git@codeup.aliyun.com:' + ORG + '/apps/hook-app.git' } }) },
        ]),
        exec: (cmd: string, args: string[]) => {
          if (cmd === 'ssh') return { code: 0, stdout: 'Welcome to Codeup, Bryan!\n', stderr: '' }
          if (cmd === 'git' && args[0] === 'remote' && (args[1] === 'add' || args[1] === 'set-url')) origin = String(args[args.length - 1] || '')
          if (cmd === 'git' && args[0] === 'push') {
            pushUrls.push(origin)
            return { code: 1, stdout: '', stderr: 'remote: pre-receive hook declined' }
          }
          return gitOk(cmd, args)
        },
      })
      check(
        rejected.res.ok === false && pushUrls.length === 1 && pushUrls[0].startsWith('git@') &&
          rejected.execPort.calls.filter((c) => c.cmd === 'git' && c.args[0] === 'remote' && c.args[1] === 'set-url').length === 0 &&
          String(rejected.fsPort.writes[0]?.text || '').includes('repositoryId: "8899005"'),
        '6.11 非认证推送错误只推送一次并保留 halfCreated 坐标，不错误切换 HTTP 重推',
        { ok: rejected.res.ok, pushUrls, error: rejected.res.error },
      )
    }

    // 6.12 坐标写盘失败时必须停止在 remote/push 之前，不能把「先落盘」降级成尽力而为
    {
      const fsPort = makePortFs({})
      fsPort.writeText = async () => { throw new Error('injected read-only workspace') }
      const envPort = makePortEnv({ YUNXIAO_TOKEN: 'pt-valid-token-123456' })
      const execPort = makePortExec(gitOk)
      const fetchPort = makePortFetch(baseRoutes([
        { method: 'POST', match: (u: string) => /\/repositories(\?|$)/.test(u), reply: () => ({ status: 200, body: { id: 8899006, pathWithNamespace: ORG + '/apps/no-persist' } }) },
        { match: (u: string) => u.includes('/repositories/8899006'), reply: () => ({ status: 200, body: { id: 8899006, pathWithNamespace: ORG + '/apps/no-persist', webUrl: 'https://codeup.aliyun.com/' + ORG + '/apps/no-persist', httpUrlToRepo: 'https://codeup.aliyun.com/' + ORG + '/apps/no-persist.git' } }) },
      ]))
      const res = await initProject({ cwd: '/ws/no-persist' }, {
        name: 'no-persist', repoMode: 'create', organizationId: ORG, projectMode: 'reuse', projectId: PROJ, remoteProtocol: 'https',
      }, {
        cwd: '/ws/no-persist',
        platform: { fs: fsPort, env: envPort, exec: execPort.fn, resolveExecutable: async (b: string) => (b === 'git' ? '/usr/bin/git' : null) },
        exec: execPort.fn, fetch: fetchPort.fn,
      } as any)
      const remoteOrPushCalls = execPort.calls.filter((c) => c.cmd === 'git' && (c.args[0] === 'remote' || c.args[0] === 'push'))
      check(
        res.ok === false && remoteOrPushCalls.length === 0,
        '6.12 docs/agents/yunxiao.yaml 写盘失败时返回错误，且不执行 git remote 或 git push',
        { res, remoteOrPushCalls },
      )
    }

    // 6.13 bind 模式：git remote add / set-url 失败必须如实返回失败，且 bind 任何失败都绝不误判为 halfCreated 重试推送
    {
      const bindRepoRoutes = baseRoutes([{ match: (u: string) => u.includes('/repositories/8194002'), reply: () => ({ status: 200, body: BIND_REPO }) }])
      const bindAddFail = await runInit({
        cwd: '/ws/bind-add-fail',
        input: { name: 'app', repoMode: 'bind', repositoryId: '8194002', organizationId: ORG, projectMode: 'reuse', projectId: PROJ },
        routes: bindRepoRoutes,
        exec: (cmd: string, args: string[]) => {
          if (cmd === 'git' && args[0] === 'remote' && args[1] === 'add') return { code: 128, stdout: '', stderr: 'fatal: could not lock config file' }
          return gitOk(cmd, args)
        },
      })
      const bindSetUrlFail = await runInit({
        cwd: '/ws/bind-seturl-fail',
        input: { name: 'app', repoMode: 'bind', repositoryId: '8194002', organizationId: ORG, projectMode: 'reuse', projectId: PROJ },
        routes: bindRepoRoutes,
        exec: (cmd: string, args: string[]) => {
          if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') return { code: 0, stdout: 'https://codeup.aliyun.com/old/app.git\n', stderr: '' }
          if (cmd === 'git' && args[0] === 'remote' && args[1] === 'set-url') return { code: 128, stdout: '', stderr: 'fatal: could not set remote url' }
          return gitOk(cmd, args)
        },
      })
      const roFs = makePortFs({})
      roFs.writeText = async () => { throw new Error('EACCES: read-only docs/agents/yunxiao.yaml') }
      const bindFlow = publishMod.createPublishFlow({
        DEFAULT_CWD: '/ws/bind-ro',
        resolveGit: async () => '/usr/bin/git',
        execProc: async (argv: string[]) => {
          const sub = argv.slice(1)
          if (sub[0] === 'remote' && sub[1] === 'get-url') return { ok: true, code: 0, text: 'https://codeup.aliyun.com/' + ORG + '/legacy/app.git' }
          if (sub[0] === 'remote' && sub[1] === 'set-url') return { ok: false, code: 128, error: 'fatal: could not set-url' }
          return { ok: true, code: 0, text: 'true' }
        },
        canonicalKey: async (c: any) => String(c),
        repoKeys: {}, repoRoots: {}, setCache: () => {},
        makeCreateErrorClassifier: () => (_t: unknown, k: unknown) => String(k || 'env'),
        KIND_UNKNOWN: 'unknown',
        openSession: async (_cwd: unknown, opts?: any) => ({
          ok: true, backendId: 'yunxiao',
          call: async (fn: any) => fn({
            initProject: (handle: any, inp: any, c: any) => initProject(handle, inp, c),
          }, {
            cwd: '/ws/bind-ro',
            platform: { fs: roFs, env: makePortEnv({ YUNXIAO_TOKEN: 'pt-valid-token-123456' }), exec: opts?.exec, resolveExecutable: async () => '/usr/bin/git' },
            exec: opts?.exec,
            fetch: makePortFetch(bindRepoRoutes).fn,
          }),
        }),
      })
      const bindWriteFailHost: any = await bindFlow.handleContractOp({
        op: 'initProject', cwd: '/ws/bind-ro', name: 'app', repoMode: 'bind', repositoryId: '8194002', organizationId: ORG, projectMode: 'reuse', projectId: PROJ,
      })
      check(
        bindAddFail.res.ok === false &&
          String(bindAddFail.fsPort.writes[0]?.text || '').includes('repositoryId: "8194002"') &&
          bindSetUrlFail.res.ok === false &&
          bindWriteFailHost.ok === false &&
          bindWriteFailHost.halfCreated === false,
        '6.13 repoMode=bind 在 git remote add / set-url 失败时如实报错（保留已写入坐标），且 bind 模式任何失败在宿主侧均不会误标 halfCreated 重试推送',
        { addOk: bindAddFail.res.ok, setUrlOk: bindSetUrlFail.res.ok, bindWriteFailHost },
      )
    }
  }

  console.log('')
  console.log(failed ? '存在失败 — ' + GATE + ' 未通过' : '全部通过（' + total + ' 项断言）')
  printGateResult(GATE, total, failed)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('执行异常：', e)
  printGateResult(GATE, total, failed + 1)
  process.exit(1)
})
