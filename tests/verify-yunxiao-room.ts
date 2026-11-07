#!/usr/bin/env node
/**
 * tests/verify-yunxiao-room.ts —— Yunxiao backend 房间骨架、三层证据识别、四步递进式 Preflight 与 Codeup 仓库权限核验门禁（规格 #02）。
 *
 * 门禁归属: src/tracker/rooms/yunxiao/index.ts
 * 门禁归属: src/tracker/rooms/yunxiao/preflight.ts
 * 门禁归属: src/tracker/rooms/yunxiao/repo/identity.ts
 * 门禁归属: src/tracker/rooms/yunxiao/repo/current-user.ts
 * 门禁归属: src/tracker/rooms/yunxiao/repo/permissions.ts
 * 门禁归属: src/tracker/rooms/yunxiao/room/links.ts
 * 门禁归属: src/tracker/rooms/yunxiao/room/prompts.ts
 * 门禁归属: src/tracker/rooms/yunxiao/room/fixes.ts
 * 门禁归属: src/tracker/rooms/yunxiao/support/capability-register.ts
 * 门禁归属: src/tracker/rooms/yunxiao/support/read-sources.ts
 * 门禁归属: src/tracker/rooms/yunxiao/issues/read.ts
 * 门禁归属: src/tracker/rooms/yunxiao/issues/write.ts
 * 门禁归属: src/tracker/rooms/yunxiao/issues/counts.ts
 * 门禁归属: src/tracker/rooms/yunxiao/issues/pages.ts
 * 门禁归属: src/tracker/rooms/yunxiao/issues/maps.ts
 * 门禁归属: src/tracker/rooms/yunxiao/issues/sub-issues.ts
 * 门禁归属: src/tracker/rooms/yunxiao/comments/write.ts
 * 门禁归属: src/tracker/rooms/yunxiao/labels/assign.ts
 * 门禁归属: src/tracker/rooms/yunxiao/labels/list.ts
 * 门禁归属: src/tracker/rooms/yunxiao/labels/colors.ts
 * 门禁归属: src/tracker/rooms/yunxiao/graph/read.ts
 * 门禁归属: src/tracker/rooms/yunxiao/graph/write.ts
 * 门禁归属: src/tracker/rooms/yunxiao/graph/membership.ts
 * 门禁归属: src/tracker/rooms/yunxiao/project/init-project.ts
 * 门禁归属: src/tracker/kernel/issue-tracker-declaration.ts
 *
 * 用法：node --import ./scripts/ts-hook.mts tests/verify-yunxiao-room.ts
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { printGateResult } from './lib/gate-result.ts'

const GATE = 'verify-yunxiao-room'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
let total = 0

function check(ok: boolean, msg: string, detail?: unknown): void {
  total += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok || detail === undefined ? '' : ' —— ' + JSON.stringify(detail)))
  if (!ok) failed += 1
}

const imp = (rel: string): Promise<any> => import(pathToFileURL(path.join(ROOT, rel)).href)

const ORG_ID = '673db5665c76405a332eebc4'
const PROJ_ID = '8efcbccd3981cb23178fc66bd1'
const REF_ID = ORG_ID + '/' + PROJ_ID
const VALID_YUNXIAO_YAML = [
  'version: 1',
  'organizationId: ' + ORG_ID,
  'projectId: ' + PROJ_ID,
  'customCode: DCIAFS',
].join('\n')

function makeFakeFs(files: Record<string, string>) {
  return {
    resolve: async (rel: string, opts?: { cwd?: string }) => {
      if (rel.startsWith('/')) return rel
      const base = opts?.cwd ? opts.cwd.replace(/\/+$/, '') + '/' : ''
      return base + rel
    },
    readText: async (target: unknown) => {
      const k = String(target || '')
      if (Object.prototype.hasOwnProperty.call(files, k)) return files[k]
      const stripped = k.replace(/^\/[^/]+\//, '')
      if (Object.prototype.hasOwnProperty.call(files, stripped)) return files[stripped]
      const err = new Error('ENOENT: ' + k) as Error & { code?: string }
      err.code = 'ENOENT'
      throw err
    },
    writeText: async () => {},
  }
}

function makeFakeEnv(vars: Record<string, string>) {
  return {
    get: (k: string) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : undefined),
    has: (k: string) => Object.prototype.hasOwnProperty.call(vars, k),
  }
}

async function main(): Promise<void> {
  const roomMod = await imp('src/tracker/rooms/yunxiao/index.ts')
  const capRegMod = await imp('src/tracker/rooms/yunxiao/support/capability-register.ts')
  const readSourcesMod = await imp('src/tracker/rooms/yunxiao/support/read-sources.ts')
  const catalogMod = await imp('src/tracker/contract/operations-catalog.ts')
  const encMod = await imp('src/tracker/contract/operations-encyclopedia.ts')
  const regCoreMod = await imp('src/tracker/registry/core.ts')
  const builtinsMod = await imp('src/tracker/registry/builtins.ts')
  const declMod = await imp('src/tracker/kernel/issue-tracker-declaration.ts')
  const decisionMod = await imp('src/tracker/detection/backendDecision.ts')
  const repoIdModelMod = await imp('src/tracker/rooms/yunxiao/model/repo-identity.ts')
  const markersMod = await imp('src/tracker/rooms/yunxiao/model/description-markers.ts')
  const repoIdentityMod = await imp('src/tracker/rooms/yunxiao/repo/identity.ts')

  console.log('== Slice 1：Yunxiao backend 模块骨架、27 项能力登记表与 3 个同步/异步定位器 ==')
  {
    repoIdModelMod.clearLearnedYunxiaoContexts()
    markersMod.clearYunxiaoIssueKeyCache()

    // 1.1 模块对象满足注册表 validateMod 校验并可成功注册
    const reg = regCoreMod.createRegistry({})
    const registered = reg.register(roomMod.yunxiaoBackend)
    check(
      Boolean(registered) &&
        roomMod.yunxiaoBackend.id === 'yunxiao' &&
        roomMod.yunxiaoBackend.label === 'Yunxiao' &&
        roomMod.yunxiaoBackend.openRepository === 'url' &&
        roomMod.yunxiaoBackend.openIssue === 'url' &&
        roomMod.yunxiaoBackend.openContainer === 'url' &&
        roomMod.yunxiaoBackend.budget.kind === 'requests-only',
      '1.1 yunxiaoBackend 模块对象通过注册表 validateMod 校验，声明 requests-only 预算与 url 打开方式',
      roomMod.yunxiaoBackend.budget,
    )

    // 1.2 27 项能力登记表（26 provided + 1 unsupported-by-design）与工厂实例成员精确对齐，ensureLabelColorsFile 由注册表补桩
    const allCaps: string[] = [...catalogMod.OPERATIONS, ...catalogMod.LOCATORS]
    const regKeys = Object.keys(capRegMod.YUNXIAO_CAPABILITY_REGISTER)
    const providedCaps = regKeys.filter((k) => capRegMod.YUNXIAO_CAPABILITY_REGISTER[k].tier === 'provided')
    const unsupportedCaps = regKeys.filter(
      (k) => capRegMod.YUNXIAO_CAPABILITY_REGISTER[k].tier === 'unsupported-by-design',
    )
    const instance = roomMod.createYunxiaoBackend({} as any)
    const tracker = reg.get('yunxiao')
    const stubRes = await tracker.ensureLabelColorsFile({ backend: 'yunxiao', refId: REF_ID, name: REF_ID, url: '' }, {} as any)
    check(
      regKeys.length === 27 &&
        allCaps.every((c) => regKeys.includes(c)) &&
        providedCaps.length === 26 &&
        unsupportedCaps.length === 1 &&
        unsupportedCaps[0] === 'ensureLabelColorsFile' &&
        providedCaps.every((c) => typeof (instance as Record<string, unknown>)[c] === 'function') &&
        (instance as Record<string, unknown>)['ensureLabelColorsFile'] === undefined &&
        stubRes.ok === false &&
        stubRes.error.kind === 'unsupported',
      '1.2 YUNXIAO_CAPABILITY_REGISTER 登记 26 项 provided 与 1 项 unsupported-by-design（ensureLabelColorsFile），注册表自动为缺省项补 unsupported 桩',
      { providedCount: providedCaps.length, unsupportedCaps, stubRes },
    )

    // 1.3 YUNXIAO_READ_SOURCES 覆盖全部 12 条读操作且通道为 yunxiao-api
    const readOps = catalogMod.OPERATIONS.filter((op: string) => encMod.OPERATION_ENCYCLOPEDIA[op]?.kind === 'read')
    const readSourceKeys = Object.keys(readSourcesMod.YUNXIAO_READ_SOURCES)
    check(
      readSourceKeys.length === readOps.length &&
        readOps.every(
          (op: string) =>
            readSourcesMod.YUNXIAO_READ_SOURCES[op]?.channel === 'yunxiao-api' &&
            readSourcesMod.YUNXIAO_READ_SOURCES[op]?.completeness === 'complete',
        ),
      '1.3 YUNXIAO_READ_SOURCES 覆盖全部 12 条读操作并声明 yunxiao-api 默认来源',
      readSourceKeys,
    )

    // 1.4 3 个定位口（getRepoKey、describe、issueAddress）：支持 Projex 默认 URL、Codeup webUrl 覆盖与双标识网页地址
    const locCtx: any = {
      cwd: '/ws-loc',
      platform: {
        fs: makeFakeFs({ 'docs/agents/yunxiao.yaml': VALID_YUNXIAO_YAML }),
        env: makeFakeEnv({}),
      },
    }
    const keyRes = await instance.getRepoKey('/ws-loc', locCtx)
    const descProjex = roomMod.describe({ cwd: '/ws-loc' }, 'yunxiao')
    markersMod.rememberYunxiaoIssueIdentity(REF_ID, {
      id: '25ac2befde335fcc2218d7c8bb',
      serialNumber: 'DCIAFS-2',
    })
    const addrWithCachedId = roomMod.issueAddress(descProjex, '2')
    const addrWithCustomCode = roomMod.issueAddress(descProjex, '99')

    repoIdModelMod.learnYunxiaoContext('/ws-loc', {
      organizationId: ORG_ID,
      projectId: PROJ_ID,
      codeupRepo: {
        id: 7360166,
        pathWithNamespace: ORG_ID + '/Apple/enterpriseagentplatform/cdi-new-api',
        webUrl: 'https://codeup.aliyun.com/' + ORG_ID + '/Apple/enterpriseagentplatform/cdi-new-api',
      },
    })
    const descWithCodeup = roomMod.describe({ cwd: '/ws-loc' }, 'yunxiao')
    check(
      keyRes !== null &&
        keyRes.owner === ORG_ID &&
        keyRes.name === PROJ_ID &&
        descProjex.refId === REF_ID &&
        descProjex.url === 'https://devops.aliyun.com/projex/project/' + PROJ_ID &&
        addrWithCachedId === 'https://devops.aliyun.com/projex/project/' + PROJ_ID + '/workitem/25ac2befde335fcc2218d7c8bb' &&
        addrWithCustomCode === 'https://devops.aliyun.com/projex/project/' + PROJ_ID + '/workitem/DCIAFS-99' &&
        descWithCodeup.url === 'https://codeup.aliyun.com/' + ORG_ID + '/Apple/enterpriseagentplatform/cdi-new-api',
      '1.4 getRepoKey 返回 {owner: organizationId, name: projectId}，describe 与 issueAddress 准确产出 Projex / Codeup 网页地址',
      { keyRes, descProjex, addrWithCachedId, addrWithCustomCode, descWithCodeup },
    )
  }

  console.log('\n== Slice 2：三层证据链识别（工作区配置 > 主锚高置信标题 > 房间自动识别）与平局仲裁零回归 ==')
  {
    // 2.1 主锚声明解析：高置信标题行识别为 yunxiao，正文仅提一句云效/yunxiao 不误触发低置信结论
    const pTitle1 = declMod.parseIssueTracker('# Issue tracker: Yunxiao\n\n使用云效 Projex 管理工单。\n')
    const pTitle2 = declMod.parseIssueTracker('# Issue tracker: Yunxiao Projex\n')
    const pBodyMention = declMod.parseIssueTracker('本仓库曾讨论过 yunxiao 与 codeup，但未声明标题行。\n')
    check(
      pTitle1.explicitBackendId === 'yunxiao' &&
        pTitle1.confidence === 'high' &&
        pTitle1.reason === 'title-yunxiao' &&
        pTitle2.explicitBackendId === 'yunxiao' &&
        pTitle2.confidence === 'high' &&
        pBodyMention.explicitBackendId === null &&
        pBodyMention.confidence === 'none',
      '2.1 parseIssueTracker 识别 # Issue tracker: Yunxiao (Projex) 高置信标题，且正文提及不产生低置信误判',
      { pTitle1, pTitle2, pBodyMention },
    )

    // 2.2 matches() 覆盖 yunxiao.yaml、.git/config Codeup 远端、高置信声明文件与 git remote 兜底，且忽略分支名里的 codeup 字样
    const mByConfig = await roomMod.matches(
      { cwd: '/ws-m1' },
      {
        cwd: '/ws-m1',
        fs: makeFakeFs({ 'docs/agents/yunxiao.yaml': VALID_YUNXIAO_YAML }),
      } as any,
    )
    const mByGitConfig = await roomMod.matches(
      { cwd: '/ws-m2' },
      {
        cwd: '/ws-m2',
        fs: makeFakeFs({
          '.git/config': '[remote "origin"]\n\turl = git@codeup.aliyun.com:' + ORG_ID + '/Apple/cdi-new-api.git\n',
        }),
      } as any,
    )
    const mByBranchFalsePositive = await roomMod.matches(
      { cwd: '/ws-m3' },
      {
        cwd: '/ws-m3',
        fs: makeFakeFs({
          '.git/config':
            '[branch "feat/codeup.aliyun.com-support"]\n\tremote = origin\n[remote "origin"]\n\turl = git@github.com:owner/repo.git\n',
        }),
        exec: async () => ({ code: 0, stdout: 'git@github.com:owner/repo.git\n', stderr: '' }),
      } as any,
    )
    const mByDecl = await roomMod.matches(
      { cwd: '/ws-m4' },
      {
        cwd: '/ws-m4',
        fs: makeFakeFs({ 'docs/agents/issue-tracker.md': '# Issue tracker: Yunxiao\n' }),
      } as any,
    )
    const mByGitExec = await roomMod.matches(
      { cwd: '/ws-m5' },
      {
        cwd: '/ws-m5',
        fs: makeFakeFs({}),
        exec: async () => ({
          code: 0,
          stdout: 'https://codeup.aliyun.com/' + ORG_ID + '/Apple/cdi-new-api.git\n',
          stderr: '',
        }),
      } as any,
    )
    const mByCustomHost = await roomMod.matches(
      { cwd: '/ws-m6' },
      {
        cwd: '/ws-m6',
        fs: makeFakeFs({
          '.git/config': '[remote "origin"]\n\turl = git@codeup.corp.example.com:myOrg/myTeam/myRepo.git\n',
        }),
        platform: {
          env: makeFakeEnv({ YUNXIAO_CODEUP_HOST: 'codeup.corp.example.com' }),
        },
      } as any,
    )
    check(
      mByConfig === true &&
        mByGitConfig === true &&
        mByBranchFalsePositive === false &&
        mByDecl === true &&
        mByGitExec === true &&
        mByCustomHost === true,
      '2.2 matches() 准确识别 yunxiao.yaml、.git/config Codeup 远端（含自定义主机）、高置信声明与 git origin 兜底，且不因分支名含 codeup 误认领 GitHub 仓库',
      { mByConfig, mByGitConfig, mByBranchFalsePositive, mByDecl, mByGitExec, mByCustomHost },
    )

    // 2.3 三层证据链（decideBackend）接入与平局仲裁排在 github/markdown/gitlab 之后
    const reg4 = regCoreMod.createRegistry({})
    const builtinMods = await builtinsMod.loadBuiltinBackendModules()
    for (const m of builtinMods) reg4.register(m)
    reg4.register(roomMod.yunxiaoBackend)

    const dTier1 = await decisionMod.decideBackend('/ws-d1', {
      fs: makeFakeFs({
        'docs/agents/workspace.yaml': JSON.stringify({
          version: 2,
          backendId: 'yunxiao',
          pickedAt: 1,
          source: 'user',
        }),
      }),
      registry: reg4,
      skipAutodetect: true,
    })
    const dTier2 = await decisionMod.decideBackend('/ws-d2', {
      fs: makeFakeFs({
        'docs/agents/issue-tracker.md': '# Issue tracker: Yunxiao\n',
      }),
      registry: reg4,
      skipAutodetect: true,
    })
    const dTier3 = await decisionMod.decideBackend('/ws-d3', {
      fs: makeFakeFs({
        'docs/agents/yunxiao.yaml': VALID_YUNXIAO_YAML,
      }),
      registry: reg4,
    })
    const orderedClaims = decisionMod.orderClaims(['yunxiao', 'gitlab', 'markdown', 'github'])
    check(
      dTier1.backendId === 'yunxiao' &&
        dTier1.canWrite === true &&
        dTier1.origin === 'user-file' &&
        dTier2.backendId === 'yunxiao' &&
        dTier2.canWrite === false &&
        dTier2.origin === 'declaration' &&
        dTier3.backendId === 'yunxiao' &&
        dTier3.canWrite === false &&
        dTier3.origin === 'autodetect' &&
        JSON.stringify(orderedClaims) === JSON.stringify(['github', 'markdown', 'gitlab', 'yunxiao']),
      '2.3 三层证据链（workspace-file 可写 > declaration 只读 > autodetect 只读）完整打通，且多命中裁剪顺序将 yunxiao 排在现有三后端末尾',
      {
        dTier1: { id: dTier1.backendId, canWrite: dTier1.canWrite, origin: dTier1.origin },
        dTier2: { id: dTier2.backendId, canWrite: dTier2.canWrite, origin: dTier2.origin },
        dTier3: { id: dTier3.backendId, canWrite: dTier3.canWrite, origin: dTier3.origin },
        orderedClaims,
      },
    )
  }

  console.log('\n== Slice 3：四步递进式 Preflight（本地坐标 -> 平台认证 -> Projex 项目 -> 按需 Codeup 仓库） ==')
  {
    // 3.1 第 1 步失败：缺少或写错本地坐标（不发任何 HTTP 请求，直接返回 env）
    let fetchCalls = 0
    const rStep1 = await roomMod.yunxiaoBackend.create({} as any).preflight(
      { cwd: '/ws-pf-1' },
      {
        cwd: '/ws-pf-1',
        fetch: async () => {
          fetchCalls += 1
          return new Response('{}', { status: 200 })
        },
        platform: {
          fs: makeFakeFs({}),
          env: makeFakeEnv({}),
        },
      } as any,
    )
    check(
      rStep1.ok === false && rStep1.error?.kind === 'env' && fetchCalls === 0,
      '3.1 Preflight 第 1 步：本地组织与项目坐标缺失时直接返回 env 档且零网络请求',
      rStep1,
    )

    // 3.2 第 2 步失败：缺少令牌或 GET /oapi/v1/platform/user 返回 401 InvalidToken -> auth
    const rStep2NoToken = await roomMod.yunxiaoBackend.create({} as any).preflight(
      { cwd: '/ws-pf-2a' },
      {
        cwd: '/ws-pf-2a',
        platform: {
          fs: makeFakeFs({ 'docs/agents/yunxiao.yaml': VALID_YUNXIAO_YAML }),
          env: makeFakeEnv({}),
        },
      } as any,
    )
    const rStep2InvalidToken = await roomMod.yunxiaoBackend.create({} as any).preflight(
      { cwd: '/ws-pf-2b' },
      {
        cwd: '/ws-pf-2b',
        fetch: async () =>
          new Response(JSON.stringify({ errorCode: 'InvalidToken', errorMessage: 'Invalid token.' }), {
            status: 401,
          }),
        platform: {
          fs: makeFakeFs({ 'docs/agents/yunxiao.yaml': VALID_YUNXIAO_YAML }),
          env: makeFakeEnv({ YUNXIAO_TOKEN: 'pt-expiredtoken123456' }),
        },
      } as any,
    )
    check(
      rStep2NoToken.ok === false &&
        rStep2NoToken.error?.kind === 'auth' &&
        rStep2InvalidToken.ok === false &&
        rStep2InvalidToken.error?.kind === 'auth',
      '3.2 Preflight 第 2 步：缺失令牌或平台用户探针返回 401 InvalidToken 时准确归为 auth 档',
      { rStep2NoToken, rStep2InvalidToken },
    )

    // 3.3 第 3 步失败：Projex GetProject 返回 HTTP 400 InvalidIdentifier.NotFound -> not-found；返回 403 UserNotInCurrentOrganization -> auth
    const rStep3NotFound = await roomMod.yunxiaoBackend.create({} as any).preflight(
      { cwd: '/ws-pf-3a' },
      {
        cwd: '/ws-pf-3a',
        fetch: async (input: string | URL) => {
          const u = String(input)
          if (u.endsWith('/oapi/v1/platform/user')) {
            return new Response(
              JSON.stringify({ id: '6a86ddf4dfcb465c20f193e2', name: 'BryanShao', lastOrganization: ORG_ID }),
              { status: 200 },
            )
          }
          return new Response(
            JSON.stringify({ errorCode: 'InvalidIdentifier.NotFound', errorMessage: '项目不存在或已经彻底删除' }),
            { status: 400 },
          )
        },
        platform: {
          fs: makeFakeFs({ 'docs/agents/yunxiao.yaml': VALID_YUNXIAO_YAML }),
          env: makeFakeEnv({ YUNXIAO_TOKEN: 'pt-validtoken12345678' }),
        },
      } as any,
    )

    const rStep3WrongOrg = await roomMod.yunxiaoBackend.create({} as any).preflight(
      { cwd: '/ws-pf-3b' },
      {
        cwd: '/ws-pf-3b',
        fetch: async (input: string | URL) => {
          const u = String(input)
          if (u.endsWith('/oapi/v1/platform/user')) {
            return new Response(
              JSON.stringify({ id: '6a86ddf4dfcb465c20f193e2', name: 'BryanShao', lastOrganization: ORG_ID }),
              { status: 200 },
            )
          }
          return new Response(
            JSON.stringify({
              errorCode: 'Forbidden.InvalidUser.UserNotInCurrentOrganization',
              errorMessage: 'The current user is not in the organization',
            }),
            { status: 403 },
          )
        },
        platform: {
          fs: makeFakeFs({ 'docs/agents/yunxiao.yaml': VALID_YUNXIAO_YAML }),
          env: makeFakeEnv({ YUNXIAO_TOKEN: 'pt-validtoken12345678' }),
        },
      } as any,
    )
    check(
      rStep3NotFound.ok === false &&
        rStep3NotFound.error?.kind === 'not-found' &&
        rStep3WrongOrg.ok === false &&
        rStep3WrongOrg.error?.kind === 'auth',
      '3.3 Preflight 第 3 步：将 GetProject 的 HTTP 400 InvalidIdentifier.NotFound 精准映射为 not-found，403 跨组织越权映射为 auth',
      { rStep3NotFound, rStep3WrongOrg },
    )

    // 3.4 无代码库的纯 Yunxiao Projex 规划工作区：在第 3 步通过后即判成功，并缓存 customCode 与 currentUser
    repoIdModelMod.clearLearnedYunxiaoContexts()
    const gatesPassed: number[] = []
    const rPureProjex = await roomMod.yunxiaoBackend.create({} as any).preflight(
      { cwd: '/ws-pf-pure' },
      {
        cwd: '/ws-pf-pure',
        logEvent: (_level: string, event: string, fields: Record<string, unknown>) => {
          if (event === 'preflight.gate' && typeof fields.gate === 'number') {
            gatesPassed.push(fields.gate)
          }
        },
        fetch: async (input: string | URL) => {
          const u = String(input)
          if (u.endsWith('/oapi/v1/platform/user')) {
            return new Response(
              JSON.stringify({ id: '6a86ddf4dfcb465c20f193e2', name: 'BryanShao', lastOrganization: ORG_ID }),
              { status: 200 },
            )
          }
          if (u.includes('/projects/' + PROJ_ID)) {
            return new Response(
              JSON.stringify({
                id: PROJ_ID,
                name: 'dci-agentic-forge-sandbox',
                customCode: 'DCIAFS',
                logicalStatus: 'NORMAL',
              }),
              { status: 200 },
            )
          }
          return new Response('unexpected url: ' + u, { status: 500 })
        },
        platform: {
          fs: makeFakeFs({
            'docs/agents/yunxiao.yaml': ['version: 1', 'organizationId: ' + ORG_ID, 'projectId: ' + PROJ_ID].join('\n'),
          }),
          env: makeFakeEnv({ YUNXIAO_TOKEN: 'pt-validtoken12345678' }),
        },
      } as any,
    )
    const learnedPure = repoIdModelMod.getLearnedYunxiaoContext('/ws-pf-pure')
    check(
      rPureProjex.ok === true &&
        JSON.stringify(gatesPassed) === JSON.stringify([1, 2, 3]) &&
        learnedPure?.customCode === 'DCIAFS' &&
        learnedPure?.currentUser?.id === '6a86ddf4dfcb465c20f193e2',
      '3.4 无代码库的纯 Yunxiao Projex 规划工作区在第 3 步通过后即判成功（ok: true），并缓存 customCode 与当前用户',
      { rPureProjex, gatesPassed, learnedPure },
    )
  }

  console.log('\n== Slice 4：Codeup 四级发现、双步 GetRepository 解析（企业标识名首段剥离回退）与第 4 步 Preflight ==')
  {
    // 4.1 四级发现顺序：环境变量 > yunxiao.yaml#repositoryId > git remote get-url origin > .git/config
    const cTier1 = await repoIdentityMod.discoverCodeupCandidate(
      '/ws-disc',
      {
        cwd: '/ws-disc',
        platform: {
          env: makeFakeEnv({ YUNXIAO_REPOSITORY_ID: '7360166' }),
          fs: makeFakeFs({
            'docs/agents/yunxiao.yaml': VALID_YUNXIAO_YAML + '\nrepositoryId: "9999999"',
            '.git/config': '[remote "origin"]\n\turl = git@codeup.aliyun.com:' + ORG_ID + '/Apple/from-git-config.git\n',
          }),
        },
        exec: async () => ({
          code: 0,
          stdout: 'git@codeup.aliyun.com:' + ORG_ID + '/Apple/from-git-origin.git\n',
          stderr: '',
        }),
      },
      { repositoryId: '9999999' },
    )

    const cTier2 = await repoIdentityMod.discoverCodeupCandidate(
      '/ws-disc',
      {
        cwd: '/ws-disc',
        platform: {
          env: makeFakeEnv({}),
          fs: makeFakeFs({
            '.git/config': '[remote "origin"]\n\turl = git@codeup.aliyun.com:' + ORG_ID + '/Apple/from-git-config.git\n',
          }),
        },
        exec: async () => ({
          code: 0,
          stdout: 'git@codeup.aliyun.com:' + ORG_ID + '/Apple/from-git-origin.git\n',
          stderr: '',
        }),
      },
      { repositoryId: ORG_ID + '/Apple/from-config.git' },
    )

    const cTier3 = await repoIdentityMod.discoverCodeupCandidate(
      '/ws-disc',
      {
        cwd: '/ws-disc',
        platform: {
          env: makeFakeEnv({}),
          fs: makeFakeFs({
            '.git/config': '[remote "origin"]\n\turl = git@codeup.aliyun.com:' + ORG_ID + '/Apple/from-git-config.git\n',
          }),
        },
        exec: async () => ({
          code: 0,
          stdout: 'git@codeup.aliyun.com:' + ORG_ID + '/Apple/from-git-origin.git\n',
          stderr: '',
        }),
      },
      {},
    )

    const cTier4 = await repoIdentityMod.discoverCodeupCandidate(
      '/ws-disc',
      {
        cwd: '/ws-disc',
        platform: {
          env: makeFakeEnv({}),
          fs: makeFakeFs({
            '.git/config':
              '[remote "upstream"]\n\turl = https://github.com/other/repo.git\n[remote "codeup"]\n\turl = ssh://git@codeup.aliyun.com:22/myCompany/Apple/enterpriseagentplatform/cdi-new-api.git\n',
          }),
        },
        exec: async () => ({ code: 1, stdout: '', stderr: 'not origin' }),
      },
      {},
    )
    check(
      cTier1?.tier === 1 &&
        cTier1.repoIdOrPath === '7360166' &&
        cTier2?.tier === 2 &&
        cTier2.repoIdOrPath === ORG_ID + '/Apple/from-config' &&
        cTier3?.tier === 3 &&
        cTier3.repoIdOrPath === ORG_ID + '/Apple/from-git-origin' &&
        cTier4?.tier === 4 &&
        cTier4.repoIdOrPath === 'myCompany/Apple/enterpriseagentplatform/cdi-new-api' &&
        cTier4.fallbackRelativePath === 'Apple/enterpriseagentplatform/cdi-new-api',
      '4.1 discoverCodeupCandidate 严格遵循「环境变量 > 配置文件 > git origin > .git/config」四级优先级',
      { cTier1, cTier2, cTier3, cTier4 },
    )

    // 4.2 双步 GetRepository 解析：全路径遇 404 SYSTEM_NOT_FOUND_ERROR 且首段非 24 位 organizationId 时，自动剥离首段重试并锁定权威身份
    const requestedUrls: string[] = []
    const rPreflightWithAlias = await roomMod.yunxiaoBackend.create({} as any).preflight(
      { cwd: '/ws-pf-alias' },
      {
        cwd: '/ws-pf-alias',
        fetch: async (input: string | URL) => {
          const u = String(input)
          requestedUrls.push(u)
          if (u.endsWith('/oapi/v1/platform/user')) {
            return new Response(
              JSON.stringify({ id: '6a86ddf4dfcb465c20f193e2', name: 'BryanShao', lastOrganization: ORG_ID }),
              { status: 200 },
            )
          }
          if (u.includes('/projects/' + PROJ_ID)) {
            return new Response(
              JSON.stringify({ id: PROJ_ID, name: 'dci-agentic-forge-sandbox', customCode: 'DCIAFS' }),
              { status: 200 },
            )
          }
          if (u.endsWith('/repositories/myCompany%2FApple%2Fenterpriseagentplatform%2Fcdi-new-api')) {
            return new Response(
              JSON.stringify({
                code: 404,
                errorCode: 'SYSTEM_NOT_FOUND_ERROR',
                errorMessage: '404 NOT_FOUND - There is not project with path',
              }),
              { status: 404 },
            )
          }
          if (u.endsWith('/repositories/Apple%2Fenterpriseagentplatform%2Fcdi-new-api')) {
            return new Response(
              JSON.stringify({
                id: 7360166,
                name: 'dci-new-api',
                nameWithNamespace: ORG_ID + ' / Apple / enterpriseagentplatform / dci-new-api',
                path: 'cdi-new-api',
                pathWithNamespace: ORG_ID + '/Apple/enterpriseagentplatform/cdi-new-api',
                webUrl: 'https://codeup.aliyun.com/' + ORG_ID + '/Apple/enterpriseagentplatform/cdi-new-api',
                accessLevel: '20',
                allowPush: false,
                archived: false,
              }),
              { status: 200 },
            )
          }
          return new Response('unexpected: ' + u, { status: 500 })
        },
        platform: {
          fs: makeFakeFs({
            'docs/agents/yunxiao.yaml': VALID_YUNXIAO_YAML,
            '.git/config':
              '[remote "origin"]\n\turl = git@codeup.aliyun.com:myCompany/Apple/enterpriseagentplatform/cdi-new-api.git\n',
          }),
          env: makeFakeEnv({ YUNXIAO_TOKEN: 'pt-validtoken12345678' }),
        },
      } as any,
    )
    const learnedAlias = repoIdModelMod.getLearnedYunxiaoContext('/ws-pf-alias')
    check(
      rPreflightWithAlias.ok === true &&
        requestedUrls.some((u) => u.endsWith('/repositories/myCompany%2FApple%2Fenterpriseagentplatform%2Fcdi-new-api')) &&
        requestedUrls.some((u) => u.endsWith('/repositories/Apple%2Fenterpriseagentplatform%2Fcdi-new-api')) &&
        learnedAlias?.codeupRepo?.id === 7360166 &&
        learnedAlias?.codeupRepo?.pathWithNamespace === ORG_ID + '/Apple/enterpriseagentplatform/cdi-new-api',
      '4.2 双步 GetRepository：企业标识名首段 myCompany 触发 404 SYSTEM_NOT_FOUND_ERROR 后自动剥离首段重试，锁定权威 id 与 pathWithNamespace（忽略含空格的 nameWithNamespace）',
      { rPreflightWithAlias, requestedUrls, codeupRepo: learnedAlias?.codeupRepo },
    )
  }

  console.log('\n== Slice 5：getCurrentUser、readBudget 与 getRepoPermissions 权限核验（不受只读 PAT 下 allowPush:false 误导） ==')
  {
    const backend = roomMod.createYunxiaoBackend({} as any)
    const repoRef = {
      backend: 'yunxiao',
      refId: REF_ID,
      name: 'dci-agentic-forge-sandbox',
      url: 'https://devops.aliyun.com/projex/project/' + PROJ_ID,
    }

    // 5.1 getCurrentUser 与 usage 请求记账
    const userOpRes = await backend.getCurrentUser(repoRef, {
      cwd: '/ws-perm',
      fetch: async () =>
        new Response(
          JSON.stringify({
            id: '6a86ddf4dfcb465c20f193e2',
            name: 'BryanShao',
            username: 'bryan.shao',
            lastOrganization: ORG_ID,
            avatarUrl: 'https://devops.aliyun.com/avatar.png',
          }),
          { status: 200 },
        ),
      platform: {
        fs: makeFakeFs({ 'docs/agents/yunxiao.yaml': VALID_YUNXIAO_YAML }),
        env: makeFakeEnv({ YUNXIAO_TOKEN: 'pt-validtoken12345678' }),
      },
    } as any)
    const budgetOpRes = await backend.readBudget({} as any)
    check(
      userOpRes.ok === true &&
        userOpRes.data.login === 'bryan.shao' &&
        userOpRes.data.name === 'BryanShao' &&
        userOpRes.usage?.requests === 1 &&
        userOpRes.usage?.points === 0 &&
        budgetOpRes.ok === true &&
        budgetOpRes.data.known === false &&
        budgetOpRes.data.reason === 'unsupported',
      '5.1 getCurrentUser 返回规范 Actor 并附加 usage: { requests: 1, points: 0 }，readBudget 返回 known: false',
      { userOpRes, budgetOpRes },
    )

    // 5.2 getRepoPermissions 场景 A：关联未归档 Codeup 仓库，只读 PAT 返回 accessLevel: "40" 但 allowPush: false & permissions: null -> { push: true, triage: true }
    const permAdminReadonlyPat = await backend.getRepoPermissions(repoRef, {
      cwd: '/ws-perm-admin',
      fetch: async (input: string | URL) => {
        const u = String(input)
        if (u.includes('/projects/' + PROJ_ID)) {
          return new Response(JSON.stringify({ id: PROJ_ID, name: 'sandbox', customCode: 'DCIAFS' }), { status: 200 })
        }
        return new Response(
          JSON.stringify({
            id: 7360166,
            pathWithNamespace: ORG_ID + '/Apple/enterpriseagentplatform/cdi-new-api',
            webUrl: 'https://codeup.aliyun.com/' + ORG_ID + '/Apple/enterpriseagentplatform/cdi-new-api',
            accessLevel: '40',
            permissions: { groupAccess: null, projectAccess: null },
            allowPush: false,
            archived: false,
          }),
          { status: 200 },
        )
      },
      platform: {
        fs: makeFakeFs({
          'docs/agents/yunxiao.yaml': VALID_YUNXIAO_YAML + '\nrepositoryId: "7360166"',
        }),
        env: makeFakeEnv({ YUNXIAO_TOKEN: 'pt-validtoken12345678' }),
      },
    } as any)

    // 5.3 getRepoPermissions 场景 B：Reporter 只读角色（accessLevel: "20"）或已归档仓库（archived: true, accessLevel: 40） -> { push: false, triage: true }
    const permReporter = await backend.getRepoPermissions(repoRef, {
      cwd: '/ws-perm-reporter',
      fetch: async (input: string | URL) => {
        const u = String(input)
        if (u.includes('/projects/' + PROJ_ID)) {
          return new Response(JSON.stringify({ id: PROJ_ID, name: 'sandbox', customCode: 'DCIAFS' }), { status: 200 })
        }
        return new Response(
          JSON.stringify({
            id: 7360166,
            pathWithNamespace: ORG_ID + '/Apple/enterpriseagentplatform/cdi-new-api',
            webUrl: 'https://codeup.aliyun.com/' + ORG_ID + '/Apple/enterpriseagentplatform/cdi-new-api',
            accessLevel: '20',
            allowPush: false,
            archived: false,
          }),
          { status: 200 },
        )
      },
      platform: {
        fs: makeFakeFs({
          'docs/agents/yunxiao.yaml': VALID_YUNXIAO_YAML + '\nrepositoryId: "7360166"',
        }),
        env: makeFakeEnv({ YUNXIAO_TOKEN: 'pt-validtoken12345678' }),
      },
    } as any)

    const permArchived = await backend.getRepoPermissions(repoRef, {
      cwd: '/ws-perm-archived',
      fetch: async (input: string | URL) => {
        const u = String(input)
        if (u.includes('/projects/' + PROJ_ID)) {
          return new Response(JSON.stringify({ id: PROJ_ID, name: 'sandbox', customCode: 'DCIAFS' }), { status: 200 })
        }
        return new Response(
          JSON.stringify({
            id: 7360166,
            pathWithNamespace: ORG_ID + '/Apple/enterpriseagentplatform/cdi-new-api',
            webUrl: 'https://codeup.aliyun.com/' + ORG_ID + '/Apple/enterpriseagentplatform/cdi-new-api',
            accessLevel: 40,
            allowPush: true,
            archived: true,
          }),
          { status: 200 },
        )
      },
      platform: {
        fs: makeFakeFs({
          'docs/agents/yunxiao.yaml': VALID_YUNXIAO_YAML + '\nrepositoryId: "7360166"',
        }),
        env: makeFakeEnv({ YUNXIAO_TOKEN: 'pt-validtoken12345678' }),
      },
    } as any)

    // 5.4 getRepoPermissions 场景 C：无代码库的纯 Yunxiao Projex 规划工作区 -> { push: false, triage: true }
    const permRepoless = await backend.getRepoPermissions(repoRef, {
      cwd: '/ws-perm-repoless',
      fetch: async (input: string | URL) => {
        const u = String(input)
        if (u.includes('/projects/' + PROJ_ID)) {
          return new Response(JSON.stringify({ id: PROJ_ID, name: 'sandbox', customCode: 'DCIAFS' }), { status: 200 })
        }
        return new Response('unexpected codeup call', { status: 500 })
      },
      platform: {
        fs: makeFakeFs({
          'docs/agents/yunxiao.yaml': VALID_YUNXIAO_YAML,
        }),
        env: makeFakeEnv({ YUNXIAO_TOKEN: 'pt-validtoken12345678' }),
      },
    } as any)

    check(
      permAdminReadonlyPat.ok === true &&
        permAdminReadonlyPat.data.push === true &&
        permAdminReadonlyPat.data.triage === true &&
        permAdminReadonlyPat.usage?.requests === 2 &&
        permReporter.ok === true &&
        permReporter.data.push === false &&
        permReporter.data.triage === true &&
        permArchived.ok === true &&
        permArchived.data.push === false &&
        permArchived.data.triage === true &&
        permRepoless.ok === true &&
        permRepoless.data.push === false &&
        permRepoless.data.triage === true &&
        permRepoless.usage?.requests === 1,
      '5.2 getRepoPermissions：由 Projex 可读性判 triage，由未归档且 Number(accessLevel) >= 30 判 push（不受只读 PAT 下 allowPush:false 误导），纯 Projex 工作区返回 {push:false, triage:true}',
      { permAdminReadonlyPat, permReporter, permArchived, permRepoless },
    )
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
