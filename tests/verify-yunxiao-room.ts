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
 * 门禁归属: src/tracker/rooms/yunxiao/model/normalize.ts
 * 门禁归属: src/tracker/rooms/yunxiao/issues/shared.ts
 * 门禁归属: src/tracker/rooms/yunxiao/issues/idempotency.ts
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

  console.log('\n== Slice 6：Yunxiao Projex 工作项读路径（单票双标识桥接、列表摘要详情补齐、三级 Issue.type、分页、计数与探索地图） ==')
  {
    markersMod.clearYunxiaoIssueKeyCache()
    repoIdModelMod.clearLearnedYunxiaoContexts()
    const backend = roomMod.createYunxiaoBackend({} as any)
    const repoRef = {
      backend: 'yunxiao',
      refId: REF_ID,
      name: 'dci-agentic-forge-sandbox',
      url: 'https://devops.aliyun.com/projex/project/' + PROJ_ID,
    }

    const workitem1 = {
      id: 'f7d327d50b8fca57a146979938',
      serialNumber: 'DCIAFS-1',
      subject: '为 Deck 新增云效后端规格',
      description: '<!-- DSH-ISSUE-KIND: spec -->\n# 规格正文\n\n## 进度\n',
      formatType: 'MARKDOWN',
      statusStageId: '1',
      parentId: null,
      gmtCreate: 1788775497000,
      gmtModified: 1788775497000,
      assignedTo: { id: '6a86ddf4dfcb465c20f193e2', name: 'BryanShao' },
      labels: [{ id: 'lbl-ready', name: 'ready-for-agent', color: '#0E8A16' }],
    }
    const workitem2 = {
      id: '25ac2befde335fcc2218d7c8bb',
      serialNumber: 'DCIAFS-2',
      subject: '让 Deck 支持云效探索地图',
      description: '<!-- DSH-ASSIGNEES: lead -->\n# 探索地图\n\n## Goal\n',
      formatType: 'MARKDOWN',
      statusStageId: '2',
      parentId: 'EMPTY_VALUE',
      gmtCreate: 1788776000000,
      gmtModified: 1788779000000,
      assignedTo: { id: '6a86ddf4dfcb465c20f193e2', name: 'BryanShao' },
      labels: [{ id: 'lbl-map', name: 'wayfinder:map', color: '#8B5CF6' }],
    }
    const workitem3 = {
      id: '268aa8ac348507516359714df3',
      serialNumber: 'DCIAFS-3',
      subject: '已完成子票',
      description: '<!-- DSH-PARENT: 2 -->\n# 子票 3\n',
      formatType: 'MARKDOWN',
      statusStageId: '4',
      parentId: '25ac2befde335fcc2218d7c8bb',
      gmtCreate: 1788777000000,
      gmtModified: 1788778000000,
      assignedTo: { id: '6a86ddf4dfcb465c20f193e2', name: 'BryanShao' },
      labels: [{ id: 'lbl-task', name: 'wayfinder:task', color: '#10B981' }],
    }
    const workitem4 = {
      id: '87db091efc8fa4189e507ea93b',
      serialNumber: 'DCIAFS-4',
      subject: '已取消工单',
      description: '# 已取消\n',
      formatType: 'MARKDOWN',
      statusStageId: '5',
      parentId: '',
      gmtCreate: 1788777500000,
      gmtModified: 1788778500000,
      assignedTo: { id: '6a86ddf4dfcb465c20f193e2', name: 'BryanShao' },
      labels: [],
    }

    const readCtx: any = {
      cwd: '/ws-read',
      platform: {
        fs: makeFakeFs({ 'docs/agents/yunxiao.yaml': VALID_YUNXIAO_YAML }),
        env: makeFakeEnv({ YUNXIAO_TOKEN: 'pt-validtoken12345678' }),
      },
      fetch: async (input: string | URL, init?: RequestInit) => {
        const u = String(input)
        if (u.endsWith('/workitems/DCIAFS-1') || u.endsWith('/workitems/' + workitem1.id)) {
          return new Response(JSON.stringify(workitem1), { status: 200 })
        }
        if (u.endsWith('/workitems/DCIAFS-2') || u.endsWith('/workitems/' + workitem2.id)) {
          return new Response(JSON.stringify(workitem2), { status: 200 })
        }
        if (u.endsWith('/workitems/DCIAFS-3') || u.endsWith('/workitems/' + workitem3.id)) {
          return new Response(JSON.stringify(workitem3), { status: 200 })
        }
        if (u.endsWith('/workitems/DCIAFS-4') || u.endsWith('/workitems/' + workitem4.id)) {
          return new Response(JSON.stringify(workitem4), { status: 200 })
        }
        if (u.includes('/comments')) {
          return new Response(
            JSON.stringify([
              {
                id: '24121019',
                content: '第一条 Markdown 评论',
                contentFormat: 'MARKDOWN',
                user: { id: '6a86ddf4dfcb465c20f193e2', name: 'BryanShao' },
                gmtCreate: 1788776500000,
                gmtModified: 1788776500000,
              },
            ]),
            { status: 200, headers: { 'x-total': '1' } },
          )
        }
        if (u.endsWith('/labels')) {
          return new Response(
            JSON.stringify([
              { id: 'lbl-ready', name: 'ready-for-agent', color: '#0E8A16' },
              { id: 'lbl-map', name: 'wayfinder:map', color: '#8B5CF6' },
              { id: 'lbl-task', name: 'wayfinder:task', color: '#10B981' },
            ]),
            { status: 200 },
          )
        }
        if (u.endsWith('/workitems:search')) {
          const reqBody = init?.body ? JSON.parse(String(init.body)) : {}
          const condStr = String(reqBody.conditions || '')
          let items = [
            // 故意省略 description 以验证 SearchWorkitems 摘要缺失正文时自动调 GetWorkitem 补齐详情
            { ...workitem1, description: undefined, formatType: null },
            { ...workitem2, description: undefined, formatType: null },
            workitem3,
            workitem4,
          ]
          if (condStr.includes('lbl-map')) {
            items = [{ ...workitem2, description: undefined, formatType: null }]
          }
          return new Response(JSON.stringify(items), {
            status: 200,
            headers: {
              'x-page': String(reqBody.page || 1),
              'x-per-page': String(reqBody.perPage || 100),
              'x-total': String(items.length),
              'x-total-pages': '1',
              'x-next-page': '2', // 真机实测陷阱：单页时 x-next-page 仍返回 "2"
            },
          })
        }
        return new Response('unexpected: ' + u, { status: 500 })
      },
    }

    // 6.1 getIssue 兼容纯数字 "1"、带前缀 "DCIAFS-2" 与 26 位内部 ID 三种入参，对外统一暴露纯数字 key
    const getByNum = await backend.get(repoRef, '1', { comments: { first: 10 } }, readCtx)
    const getBySerial = await backend.get(repoRef, 'DCIAFS-2', { comments: { first: 0 } }, readCtx)
    const getByInternalId = await backend.get(repoRef, workitem3.id, {}, readCtx)
    check(
      getByNum.ok === true &&
        getByNum.data.key === '1' &&
        getByNum.data.type === 'spec' &&
        getByNum.data.assignees.length === 0 &&
        getByNum.data.comments.length === 1 &&
        getByNum.data.labels[0]?.color === '0e8a16' &&
        getBySerial.ok === true &&
        getBySerial.data.key === '2' &&
        getBySerial.data.type === 'map' &&
        getBySerial.data.assignees[0]?.login === 'lead' &&
        getByInternalId.ok === true &&
        getByInternalId.data.key === '3' &&
        getByInternalId.data.type === 'issue' &&
        getByInternalId.data.state === 'closed' &&
        getByInternalId.data.reason === 'completed' &&
        getByInternalId.data.parentKey === '2',
      '6.1 getIssue 兼容纯数字、DCIAFS-n 与 26 位 id 三种入参，统一返回纯数字 key，准确识别三级 Issue.type、DSH-ASSIGNEES 认领真源与父票 key',
      { getByNum, getBySerial, getByInternalId },
    )

    // 6.2 listIssues 自动补齐摘要缺失的详情正文，准确将阶段 4/5 映射为 closed、其余阶段映射为 open
    const listAll = await backend.list(repoRef, undefined, readCtx)
    const listOpenOnly = await backend.list(repoRef, { state: 'open' }, readCtx)
    const listClosedOnly = await backend.list(repoRef, { state: 'closed' }, readCtx)
    check(
      listAll.ok === true &&
        listAll.data.length === 4 &&
        listAll.data.find((i: any) => i.key === '1')?.type === 'spec' &&
        listAll.data.find((i: any) => i.key === '2')?.type === 'map' &&
        listAll.data.find((i: any) => i.key === '3')?.state === 'closed' &&
        listAll.data.find((i: any) => i.key === '4')?.state === 'closed' &&
        listAll.data.find((i: any) => i.key === '4')?.reason === 'not_planned' &&
        listOpenOnly.ok === true &&
        listOpenOnly.data.length === 2 &&
        listClosedOnly.ok === true &&
        listClosedOnly.data.length === 2,
      '6.2 listIssues 自动对摘要缺失正文的项调 GetWorkitem 补齐详情，并将阶段 4/5 映射为 closed、其余阶段映射为 open',
      { listAllCount: listAll.data?.length, listOpenCount: listOpenOnly.data?.length, listClosedCount: listClosedOnly.data?.length },
    )

    // 6.3 counts、listPage（忽略 x-next-page: "2" 假阳性）与 listMaps 探索地图薄行列表
    const countsRes = await backend.counts(repoRef, undefined, readCtx)
    const countsByLabel = await backend.counts(repoRef, { labels: ['wayfinder:map'] }, readCtx)
    const pageRes = await backend.listPage(repoRef, undefined, { limit: 50 }, readCtx)
    const mapsRes = await backend.listMaps(repoRef, readCtx)
    check(
      countsRes.ok === true &&
        countsRes.data.open === 2 &&
        countsRes.data.closed === 2 &&
        countsRes.data.total === 4 &&
        countsByLabel.ok === true &&
        countsByLabel.data.open === 1 &&
        countsByLabel.data.closed === 0 &&
        countsByLabel.data.total === 1 &&
        pageRes.ok === true &&
        pageRes.data.items.length === 4 &&
        pageRes.data.nextCursor === null &&
        pageRes.data.total === 4 &&
        mapsRes.ok === true &&
        mapsRes.data.rows.length === 1 &&
        mapsRes.data.rows[0]?.key === '2' &&
        mapsRes.data.rows[0]?.title === '让 Deck 支持云效探索地图' &&
        mapsRes.data.truncated === false,
      '6.3 counts（含按标签计数）、listPage（以 xPage < xTotalPages 判定尾页，忽略 x-next-page:2）与 listMaps 探索地图列表全部通过',
      { countsRes, countsByLabel, pageRes, mapsRes },
    )
  }

  console.log('\n== Slice 7：六种位置建票映射（Req/Task/Bug 及 Bug 未启用时回退 Task+bug）、幂等防重与生命周期状态流转 ==')
  {
    markersMod.clearYunxiaoIssueKeyCache()
    repoIdModelMod.clearLearnedYunxiaoContexts()
    const backend = roomMod.createYunxiaoBackend({} as any)
    const repoRef = {
      backend: 'yunxiao',
      refId: REF_ID,
      name: 'dci-agentic-forge-sandbox',
      url: 'https://devops.aliyun.com/projex/project/' + PROJ_ID,
    }

    let bugEnabled = true
    const createdStore = new Map<string, any>()
    let nextSerial = 10
    const createPayloads: any[] = []
    const updatePayloads: Array<{ id: string; body: any }> = []

    const writeCtx: any = {
      cwd: '/ws-write',
      platform: {
        fs: makeFakeFs({ 'docs/agents/yunxiao.yaml': VALID_YUNXIAO_YAML }),
        env: makeFakeEnv({ YUNXIAO_TOKEN: 'pt-validtoken12345678' }),
      },
      fetch: async (input: string | URL, init?: RequestInit) => {
        const u = String(input)
        const method = (init?.method || 'GET').toUpperCase()
        if (u.endsWith('/oapi/v1/platform/user')) {
          return new Response(
            JSON.stringify({ id: '6a86ddf4dfcb465c20f193e2', name: 'BryanShao', lastOrganization: ORG_ID }),
            { status: 200 },
          )
        }
        if (u.includes('/workitemTypes?category=Req')) {
          return new Response(
            JSON.stringify([{ id: '9uy29901re573f561d69jn40', name: '产品类需求', categoryId: 'Req', defaultType: true, enable: true }]),
            { status: 200 },
          )
        }
        if (u.includes('/workitemTypes?category=Task')) {
          return new Response(
            JSON.stringify([{ id: 'ba102e46bc6a8483d9b7f25c', name: '任务', categoryId: 'Task', defaultType: true, enable: true }]),
            { status: 200 },
          )
        }
        if (u.includes('/workitemTypes?category=Bug')) {
          return new Response(
            JSON.stringify(
              bugEnabled
                ? [{ id: '37da3a07df4d08aef2e3b393', name: '缺陷', categoryId: 'Bug', defaultType: true, enable: true }]
                : [],
            ),
            { status: 200 },
          )
        }
        if (u.endsWith('/labels') && method === 'GET') {
          return new Response(
            JSON.stringify([
              { id: 'lbl-map', name: 'wayfinder:map', color: '#8B5CF6' },
              { id: 'lbl-task', name: 'wayfinder:task', color: '#10B981' },
              { id: 'lbl-ready', name: 'ready-for-agent', color: '#0E8A16' },
              { id: 'lbl-bug', name: 'bug', color: '#D73A4A' },
            ]),
            { status: 200 },
          )
        }
        if (u.endsWith('/workitems:search')) {
          const items = Array.from(createdStore.values())
          return new Response(JSON.stringify(items), {
            status: 200,
            headers: { 'x-page': '1', 'x-per-page': '100', 'x-total': String(items.length), 'x-total-pages': '1', 'x-next-page': '2' },
          })
        }
        if (u.endsWith('/workitems') && method === 'POST') {
          const body = JSON.parse(String(init?.body || '{}'))
          createPayloads.push(body)
          const num = nextSerial++
          const id = ('createditem00000000000000' + String(num)).slice(-26)
          const labelObjs = Array.isArray(body.labels)
            ? body.labels.map((lid: string) => ({
                id: lid,
                name:
                  lid === 'lbl-map'
                    ? 'wayfinder:map'
                    : lid === 'lbl-task'
                      ? 'wayfinder:task'
                      : lid === 'lbl-bug'
                        ? 'bug'
                        : 'ready-for-agent',
                color: '#10B981',
              }))
            : []
          const record = {
            id,
            serialNumber: 'DCIAFS-' + String(num),
            subject: body.subject,
            description: body.description || '',
            formatType: body.formatType || 'MARKDOWN',
            workitemType: { id: body.workitemTypeId },
            statusStageId: '1',
            parentId: body.parentId || null,
            assignedTo: { id: body.assignedTo, name: 'BryanShao' },
            labels: labelObjs,
            gmtCreate: 1788780000000 + num * 1000,
            gmtModified: 1788780000000 + num * 1000,
          }
          createdStore.set(id, record)
          createdStore.set(record.serialNumber, record)
          return new Response(JSON.stringify({ id }), { status: 200 })
        }
        if (u.includes('/workflow')) {
          return new Response(
            JSON.stringify({
              defaultStatusId: '100005',
              statuses: [
                { id: '100005', name: '待处理', statusStageId: '1' },
                { id: '100010', name: '处理中', statusStageId: '2' },
                { id: '100014', name: '已完成', statusStageId: '4' },
                { id: '141230', name: '已取消', statusStageId: '5' },
              ],
            }),
            { status: 200 },
          )
        }
        const wiMatch = u.match(/\/workitems\/([^/?]+)$/)
        if (wiMatch && method === 'GET') {
          const keyOrId = decodeURIComponent(wiMatch[1])
          const item = createdStore.get(keyOrId)
          if (!item) {
            return new Response(JSON.stringify({ errorCode: 'InvalidWorkitem.NotFound', errorMessage: '工作项不存在' }), { status: 404 })
          }
          return new Response(JSON.stringify(item), { status: 200 })
        }
        if (wiMatch && method === 'PUT') {
          const wid = decodeURIComponent(wiMatch[1])
          const item = createdStore.get(wid)
          const body = JSON.parse(String(init?.body || '{}'))
          updatePayloads.push({ id: wid, body })
          if (item) {
            if (typeof body.subject === 'string') item.subject = body.subject
            if (typeof body.description === 'string') item.description = body.description
            if (typeof body.status === 'string') {
              item.statusStageId = body.status === '100014' ? '4' : body.status === '141230' ? '5' : '1'
            }
          }
          return new Response(null, { status: 204 })
        }
        if (u.includes('/comments')) {
          return new Response(JSON.stringify([]), { status: 200 })
        }
        return new Response('unexpected: ' + method + ' ' + u, { status: 500 })
      },
    }

    // 7.1 六种建票位置映射：map -> Req, spec -> Req (DSH-ISSUE-KIND: spec), map-ticket/spec-ticket/issue -> Task, bug -> Bug
    const cMap = await backend.create(
      repoRef,
      { title: 'Map 容器', body: '# Map', type: 'map', labels: ['wayfinder:map'], idempotencyKey: 'idem-map-1' },
      writeCtx,
    )
    const cSpec = await backend.create(
      repoRef,
      { title: 'Spec 容器', body: '# Spec', type: 'spec', labels: ['ready-for-agent'], idempotencyKey: 'idem-spec-1' },
      writeCtx,
    )
    const cMapTicket = await backend.create(
      repoRef,
      { title: 'Map 子票', body: '# Sub', type: 'issue', fileKind: 'map-ticket', parentKey: cMap.data?.key, labels: ['wayfinder:task'] },
      writeCtx,
    )
    const cSpecTicket = await backend.create(
      repoRef,
      { title: 'Spec 实施票', body: '<!-- DSH-ISSUE-KIND: ticket -->\n# Ticket', type: 'issue', fileKind: 'spec-ticket', parentKey: cSpec.data?.key },
      writeCtx,
    )
    const cPlainIssue = await backend.create(
      repoRef,
      { title: '普通 Issue', body: '# Issue', type: 'issue', fileKind: 'plain-issue' },
      writeCtx,
    )
    const cBugNative = await backend.create(
      repoRef,
      { title: '原生缺陷票', body: '# Bug', type: 'issue', fileKind: 'bug', labels: ['bug'] },
      writeCtx,
    )

    // 7.2 当项目未启用 Bug 类型时，bug 自动回退创建为带 bug 标签的 Task
    bugEnabled = false
    const cBugFallback = await backend.create(
      repoRef,
      { title: '回退缺陷票', body: '# Bug Fallback', type: 'issue', fileKind: 'bug' },
      writeCtx,
    )
    check(
      cMap.ok === true &&
        cMap.data.type === 'map' &&
        cMap.data.assignees.length === 0 &&
        createPayloads[0]?.workitemTypeId === '9uy29901re573f561d69jn40' &&
        createPayloads[0]?.assignedTo === '6a86ddf4dfcb465c20f193e2' &&
        createPayloads[0]?.formatType === 'MARKDOWN' &&
        cSpec.ok === true &&
        cSpec.data.type === 'spec' &&
        cSpec.data.body.includes('<!-- DSH-ISSUE-KIND: spec -->') &&
        createPayloads[1]?.workitemTypeId === '9uy29901re573f561d69jn40' &&
        cMapTicket.ok === true &&
        cMapTicket.data.parentKey === cMap.data.key &&
        createPayloads[2]?.workitemTypeId === 'ba102e46bc6a8483d9b7f25c' &&
        cSpecTicket.ok === true &&
        createPayloads[3]?.workitemTypeId === 'ba102e46bc6a8483d9b7f25c' &&
        cPlainIssue.ok === true &&
        createPayloads[4]?.workitemTypeId === 'ba102e46bc6a8483d9b7f25c' &&
        cBugNative.ok === true &&
        createPayloads[5]?.workitemTypeId === '37da3a07df4d08aef2e3b393' &&
        cBugFallback.ok === true &&
        createPayloads[6]?.workitemTypeId === 'ba102e46bc6a8483d9b7f25c' &&
        cBugFallback.data.labels.some((l: any) => l.name === 'bug'),
      '7.1 六种位置映射准确（map/spec->Req、map-ticket/spec-ticket/issue->Task、bug->Bug 及未启用 Bug 时回退为带 bug 标签的 Task），未认领票用当前用户填充 assignedTo 且 Issue.assignees 返回 []',
      { createPayloadsCount: createPayloads.length, cBugFallbackLabels: cBugFallback.data?.labels },
    )

    // 7.3 DSH-IDEMPOTENCY-KEY 幂等防重：重复提交相同 idempotencyKey 直接复用已有 open 工作项，不发第二次 POST
    const countBeforeRetry = createPayloads.length
    const cMapRetry = await backend.create(
      repoRef,
      { title: 'Map 容器', body: '# Map', type: 'map', labels: ['wayfinder:map'], idempotencyKey: 'idem-map-1' },
      writeCtx,
    )
    check(
      cMapRetry.ok === true &&
        cMapRetry.data.key === cMap.data.key &&
        createPayloads.length === countBeforeRetry,
      '7.2 DSH-IDEMPOTENCY-KEY 幂等防重：相同幂等键重试直接命中并返回既有工作项 key，不重复创建',
      { firstKey: cMap.data.key, retryKey: cMapRetry.data?.key, createPayloadsCount: createPayloads.length },
    )

    // 7.4 updateIssue（Markdown 正文与标题更新）、closeIssue（自动查询并流转至阶段 4 状态）与 reopenIssue
    const updatedRes = await backend.update(
      repoRef,
      cPlainIssue.data.key,
      { title: '更新后的标题', body: '# 更新后的 Markdown 正文\n\n内容段落' },
      writeCtx,
    )
    const closedRes = await backend.close(repoRef, cPlainIssue.data.key, { reason: 'completed' }, writeCtx)
    const reopenedRes = await backend.reopen(repoRef, cPlainIssue.data.key, writeCtx)
    check(
      updatedRes.ok === true &&
        updatedRes.data.title === '更新后的标题' &&
        updatedRes.data.body.includes('更新后的 Markdown 正文') &&
        updatePayloads.some((p) => p.body.formatType === 'MARKDOWN') &&
        closedRes.ok === true &&
        closedRes.data.state === 'closed' &&
        updatePayloads.some((p) => p.body.status === '100014') &&
        reopenedRes.ok === true &&
        reopenedRes.data.state === 'open' &&
        updatePayloads.some((p) => p.body.status === '100005'),
      '7.3 updateIssue 以 MARKDOWN 格式更新标题正文，closeIssue 自动查询阶段 4 状态（100014）流转关闭，reopenIssue 流转回阶段 1（100005）',
      { updatedRes, closedRes, reopenedRes, updatePayloads },
    )
  }

  console.log('\n== Slice 8：认领真源（setAssignees 同步 DSH-ASSIGNEES 与原生负责人/参与人）、Markdown 评论与标签闭环（含 HTTP 204 空标签） ==')
  {
    markersMod.clearYunxiaoIssueKeyCache()
    repoIdModelMod.clearLearnedYunxiaoContexts()
    const backend = roomMod.createYunxiaoBackend({} as any)
    const repoRef = {
      backend: 'yunxiao',
      refId: REF_ID,
      name: 'dci-agentic-forge-sandbox',
      url: 'https://devops.aliyun.com/projex/project/' + PROJ_ID,
    }

    let labelsEmpty204 = true
    const projectLabels: Array<{ id: string; name: string; color: string; description?: string }> = []
    const workitemState: any = {
      id: '268aa8ac348507516359714df3',
      serialNumber: 'DCIAFS-3',
      subject: '测试认领、评论与标签',
      description: '<!-- DSH-PARENT: 2 -->\n# 子票 3\n\n正文内容\n',
      formatType: 'MARKDOWN',
      workitemType: { id: 'ba102e46bc6a8483d9b7f25c' },
      statusStageId: '2',
      parentId: '25ac2befde335fcc2218d7c8bb',
      assignedTo: { id: '6a86ddf4dfcb465c20f193e2', name: 'BryanShao' },
      participants: [],
      labels: [],
      gmtCreate: 1788777000000,
      gmtModified: 1788778000000,
    }
    const putBodies: any[] = []
    const commentPostBodies: any[] = []

    const claimCtx: any = {
      cwd: '/ws-claim',
      platform: {
        fs: makeFakeFs({ 'docs/agents/yunxiao.yaml': VALID_YUNXIAO_YAML }),
        env: makeFakeEnv({ YUNXIAO_TOKEN: 'pt-validtoken12345678' }),
      },
      fetch: async (input: string | URL, init?: RequestInit) => {
        const u = String(input)
        const method = (init?.method || 'GET').toUpperCase()
        if (u.endsWith('/oapi/v1/platform/user')) {
          return new Response(
            JSON.stringify({ id: '6a86ddf4dfcb465c20f193e2', name: 'BryanShao', lastOrganization: ORG_ID }),
            { status: 200 },
          )
        }
        if (u.endsWith('/members')) {
          return new Response(
            JSON.stringify([
              { userId: '6a86ddf4dfcb465c20f193e2', userName: 'BryanShao' },
              { userId: '11223344556677889900aabb', userName: 'Alice' },
            ]),
            { status: 200 },
          )
        }
        if (u.includes('/fields')) {
          return new Response(
            JSON.stringify([
              { id: 'tag', identifier: 'labels', name: '标签', format: 'multiList', className: 'tag' },
            ]),
            { status: 200 },
          )
        }
        if (u.endsWith('/labels') && method === 'GET') {
          if (labelsEmpty204 && projectLabels.length === 0) {
            return new Response(null, { status: 204 })
          }
          return new Response(JSON.stringify(projectLabels), { status: 200 })
        }
        if (u.endsWith('/labels') && method === 'POST') {
          const b = JSON.parse(String(init?.body || '{}'))
          const newLbl = {
            id: 'lbl-' + String(projectLabels.length + 1),
            name: b.name,
            color: b.color || '#10B981',
          }
          projectLabels.push(newLbl)
          labelsEmpty204 = false
          return new Response(JSON.stringify({ id: newLbl.id }), { status: 200 })
        }
        const lblUpdateMatch = u.match(/\/labels\/([^/?]+)$/)
        if (lblUpdateMatch && method === 'PUT') {
          const lid = decodeURIComponent(lblUpdateMatch[1])
          const b = JSON.parse(String(init?.body || '{}'))
          const found = projectLabels.find((l) => l.id === lid || l.name === lid)
          if (!found) return new Response(JSON.stringify({ errorMessage: 'label not found' }), { status: 404 })
          if (b.color) found.color = b.color
          return new Response(JSON.stringify(found), { status: 200 })
        }
        if (u.includes('/comments') && method === 'POST') {
          const b = JSON.parse(String(init?.body || '{}'))
          commentPostBodies.push(b)
          return new Response(
            JSON.stringify({
              id: '24129999',
              content: b.content,
              contentFormat: b.formatType,
              user: { id: '6a86ddf4dfcb465c20f193e2', name: 'BryanShao' },
              gmtCreate: 1788790000000,
              gmtModified: 1788790000000,
            }),
            { status: 200 },
          )
        }
        if (u.includes('/comments') && method === 'GET') {
          return new Response(JSON.stringify([]), { status: 200 })
        }
        if ((u.endsWith('/workitems/DCIAFS-3') || u.endsWith('/workitems/' + workitemState.id)) && method === 'GET') {
          return new Response(JSON.stringify(workitemState), { status: 200 })
        }
        if (u.endsWith('/workitems/' + workitemState.id) && method === 'PUT') {
          const b = JSON.parse(String(init?.body || '{}'))
          putBodies.push(b)
          if (typeof b.description === 'string') workitemState.description = b.description
          if (typeof b.assignedTo === 'string') {
            workitemState.assignedTo = {
              id: b.assignedTo,
              name: b.assignedTo === '11223344556677889900aabb' ? 'Alice' : 'BryanShao',
            }
          }
          if (Array.isArray(b.participants)) {
            workitemState.participants = b.participants.map((uid: string) => ({ id: uid }))
          }
          if (Array.isArray(b.labels)) {
            workitemState.labels = b.labels.map((lid: string) => {
              const found = projectLabels.find((l) => l.id === lid)
              return found || { id: lid, name: lid, color: '#000000' }
            })
          }
          return new Response(null, { status: 204 })
        }
        return new Response('unexpected: ' + method + ' ' + u, { status: 500 })
      },
    }

    // 8.1 setAssignees 认领与释放：同步更新文件头 DSH-ASSIGNEES、原生 assignedTo 与 participants（释放时 participants 置 [] 且 Issue.assignees 回 []）
    const claimRes = await backend.setAssignees(repoRef, '3', ['Alice', 'lead'], undefined, claimCtx)
    const releaseRes = await backend.setAssignees(repoRef, '3', [], undefined, claimCtx)
    check(
      claimRes.ok === true &&
        JSON.stringify(claimRes.data.assignees.map((a: any) => a.login)) === JSON.stringify(['Alice', 'lead']) &&
        workitemState.description.includes('# 子票 3') &&
        putBodies[0]?.assignedTo === '11223344556677889900aabb' &&
        Array.isArray(putBodies[0]?.participants) &&
        putBodies[0]?.participants.length === 2 &&
        releaseRes.ok === true &&
        releaseRes.data.assignees.length === 0 &&
        !workitemState.description.includes('DSH-ASSIGNEES') &&
        Array.isArray(putBodies[1]?.participants) &&
        putBodies[1]?.participants.length === 0,
      '8.1 setAssignees 认领时同步写入 DSH-ASSIGNEES 与原生 assignedTo/participants，释放时清空 DSH-ASSIGNEES 并传 participants:[]，读回 Issue.assignees 为 []',
      { claimRes, releaseRes, putBodies },
    )

    // 8.2 addComment：以 formatType: "MARKDOWN" 创建评论并返回归一化 Comment 实体
    const commentRes = await backend.comment(repoRef, '3', '## 进展汇报\n\n已完成离线测试验证。', claimCtx)
    check(
      commentRes.ok === true &&
        commentRes.data.id === '24129999' &&
        commentRes.data.body === '## 进展汇报\n\n已完成离线测试验证。' &&
        commentRes.data.author.login === 'BryanShao' &&
        commentPostBodies[0]?.formatType === 'MARKDOWN',
      '8.2 comment 以 formatType: MARKDOWN 创建工作项评论并返回规范 Comment 对象',
      { commentRes, commentPostBodies },
    )

    // 8.3 listLabels（HTTP 204 空响应归一为 []）、setLabels（自动创建/匹配标签并指派）与 setLabelColors（6 位十六进制颜色双向归一）
    const emptyLabelsRes = await backend.listLabels(repoRef, claimCtx)
    const assignLabelsRes = await backend.setLabels(
      repoRef,
      '3',
      [{ name: 'wayfinder:task', color: '10B981' }, 'ready-for-agent'],
      undefined,
      claimCtx,
    )
    const listLabelsAfterCreate = await backend.listLabels(repoRef, claimCtx)
    const colorBatchRes = await backend.setLabelColors(
      repoRef,
      [
        { name: 'wayfinder:task', color: '8B5CF6' },
        { name: 'ready-for-agent', color: 'not-a-hex' },
      ],
      claimCtx,
    )
    const clearLabelsRes = await backend.setLabels(repoRef, '3', [], undefined, claimCtx)
    check(
      emptyLabelsRes.ok === true &&
        Array.isArray(emptyLabelsRes.data) &&
        emptyLabelsRes.data.length === 0 &&
        assignLabelsRes.ok === true &&
        assignLabelsRes.data.labels.length === 2 &&
        listLabelsAfterCreate.ok === true &&
        listLabelsAfterCreate.data.length === 2 &&
        listLabelsAfterCreate.data[0]?.color === '10b981' &&
        colorBatchRes.ok === true &&
        colorBatchRes.data.applied.length === 1 &&
        colorBatchRes.data.applied[0]?.name === 'wayfinder:task' &&
        colorBatchRes.data.applied[0]?.color === '8b5cf6' &&
        colorBatchRes.data.failed.length === 1 &&
        colorBatchRes.data.failed[0]?.name === 'ready-for-agent' &&
        projectLabels.find((l) => l.name === 'wayfinder:task')?.color === '#8b5cf6' &&
        clearLabelsRes.ok === true &&
        clearLabelsRes.data.labels.length === 0,
      '8.3 listLabels 将 HTTP 204 空响应归一为 []，setLabels 支持标签自动创建/指派与清空，setLabelColors 完成 6 位十六进制颜色双向归一与逐条记账',
      { emptyLabelsRes, assignLabelsRes, listLabelsAfterCreate, colorBatchRes, clearLabelsRes },
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
