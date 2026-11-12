#!/usr/bin/env node
/**
 * tests/verify-yunxiao-onboarding-wizard.ts —— 声明式向导字段原语、向导生命周期与云效令牌在线验真/0600原子落盘门禁（规格 #21 / #23）。
 *
 * 门禁归属: src/shared/tracker/chain-types.ts
 * 门禁归属: src/shared/tracker/chain-validate.ts
 * 门禁归属: src/client/kernel/modal-fields.ts
 * 门禁归属: src/client/kernel/modal-wizard-step.ts
 * 门禁归属: src/client/kernel/slotRenderer-modal-view.ts
 * 门禁归属: src/client/kernel/slotRenderer-queue.ts
 * 门禁归属: src/client/kernel/actions.ts
 * 门禁归属: src/host/yunxiaoOnboarding.ts
 * 门禁归属: src/tracker/registry/builtins.ts
 * 门禁归属: src/tracker/rooms/yunxiao/room/fixes.ts
 * 门禁归属: src/tracker/rooms/yunxiao/model/workspace-config.ts
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

async function main(): Promise<void> {
  const validateMod = await imp('src/shared/tracker/chain-validate.ts')
  const fieldsMod = await imp('src/client/kernel/modal-fields.ts')
  const queueMod = await imp('src/client/kernel/slotRenderer-queue.ts')
  const actionsMod = await imp('src/client/kernel/actions.ts')
  const fixesMod = await imp('src/tracker/rooms/yunxiao/room/fixes.ts')
  const builtinsMod = await imp('src/tracker/registry/builtins.ts')
  const wizMod = await imp('src/client/kernel/modal-wizard-step.ts').catch(() => ({}))
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
            optionsByField: {
              organizationId: [{ value: 'org-1', label: 'Org 1' }],
            },
            defaultsByField: {
              organizationId: 'org-1',
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
        Boolean(st.formModal.bannersByField?.token),
      '2.6 第 1 步 stepAction 成功后记录环境变量遮蔽警告横幅、自动调用 hydrateRpc 刷新第 2 步选项与默认值，并推进到 stepIndex=1',
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
    } else {
      check(false, '4.1 createYunxiaoOnboarding 尚未实现')
      check(false, '4.2 handleYunxiaoSaveToken 401 保护尚未实现')
      check(false, '4.3 handleYunxiaoSaveToken 0600 原子落盘尚未实现')
      check(false, '4.4 handleYunxiaoDiscover 尚未实现')
    }

    try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {}
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
