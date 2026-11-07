/**
 * src/tracker/rooms/yunxiao/preflight.ts —— Yunxiao backend 四步递进式环境预检（Preflight，规格 #02）。
 *
 * 为什么采用四步递进式预检：
 *   1. 第 1 关（本地坐标校验，Gate 1）：检查工作区 `docs/agents/yunxiao.yaml` 或 `YUNXIAO_*` 环境变量
 *      （以及可选传入的 `handle.refId`）是否具备合法的 24 位 `organizationId` 与 26 位 `projectId`。
 *      本地配置缺失或格式错误时直接返回 `ENV` 档位，不发起任何无意义的网络请求。
 *   2. 第 2 关（平台用户认证探针，Gate 2）：先确认个人访问令牌（`x-yunxiao-token`）已配置（缺失返回 `AUTH`），
 *      再调用 `GET /oapi/v1/platform/user` 校验令牌有效性并缓存当前用户的 `{ id, name, lastOrganization }`。
 *      401 `InvalidToken` 归 `AUTH`，超时/断网归 `NETWORK`，若因自定义 `apiBaseUrl` 指错路径导致 404 则收敛为 `ENV`。
 *   3. 第 3 关（Yunxiao Projex 项目访问探针，Gate 3）：调用
 *      `GET /oapi/v1/projex/organizations/{organizationId}/projects/{projectId}` 校验项目可读性并缓存
 *      项目代号 `customCode`（如 `DCIAFS`）。
 *      真机实测证实当项目 ID 不存在时云效返回 `HTTP 400 InvalidIdentifier.NotFound`（而非 404），
 *      经 `classifyYunxiaoError` 精准映射为 `NOTFOUND` 档位；跨组织越权 `403 UserNotInCurrentOrganization` 映射为 `AUTH`。
 *   4. 第 4 关（按需 Codeup 仓库可读性探针，Gate 4）：
 *      若工作区未关联任何 Codeup 仓库（无代码库的纯 Yunxiao Projex 规划工作区），在第 3 关通过后即判成功（`ok: true`）！
 *      若通过四级发现关联了 Codeup 仓库，则执行双步 `GetRepository` 解析，要求 `HTTP 200` 且
 *      `Number(accessLevel) >= 20`（只读 Reporter 及以上）。
 */

import { ERROR_KIND } from '../../contract/vocabulary.js'
import type { ErrorKind } from '../../contract/identity.js'
import type { BackendContext, OpContext } from '../../contract/contexts.js'
import type { RepositoryRef } from '../../contract/entities.js'
import type { PreflightResult } from '../../contract/results.js'
import { fail, HINT_UNRECOGNIZED } from '../../kernel/preflight.js'
import { GITLAB_PROBE_TIMEOUT_MS } from '../../../shared/time-config/src/values.js'
import type { YunxiaoCtx } from './client.js'
import { asRecord, classifyYunxiaoError } from './errors.js'
import {
  formatYunxiaoRefId,
  learnYunxiaoContextFor,
  parseYunxiaoProjectPayload,
  parseYunxiaoRefId,
  repoRefId,
} from './model/repo-identity.js'
import {
  DEFAULT_YUNXIAO_API_BASE_URL,
  DEFAULT_YUNXIAO_WEB_BASE_URL,
  isValidOrganizationId,
  isValidProjectId,
  loadYunxiaoToken,
  resolveYunxiaoCoordinates,
} from './model/workspace-config.js'
import { resolveCodeupRepositoryIdentity } from './repo/identity.js'
import { requestPlatformUser, requestProjectGet } from './requests.js'
import { emitPreflightGatePass, emitReadDegraded } from './support/read-log.js'

/** Codeup 仓库最低可读角色档位：Reporter (20)。 */
export const CODEUP_READ_MIN_ACCESS_LEVEL = 20

type PreflightHandle = Partial<OpContext> &
  Partial<BackendContext> & {
    refId?: string
    cwd?: string
    repository?: { refId?: string }
  } & Partial<RepositoryRef>

function loginProbeKind(kind: ErrorKind): ErrorKind {
  return kind === (ERROR_KIND.NOTFOUND as ErrorKind) ? (ERROR_KIND.ENV as ErrorKind) : kind
}

/**
 * 执行 Yunxiao backend 四步递进式环境预检（契约操作 `preflight`）。
 */
export async function yunxiaoPreflight(
  handle: PreflightHandle | null | undefined,
  opCtx?: YunxiaoCtx | null,
): Promise<PreflightResult> {
  const startedAt = Date.now()
  const ctx: YunxiaoCtx = Object.assign({}, handle || {}, opCtx || {})
  const cwd =
    (handle && typeof handle.cwd === 'string' && handle.cwd.trim() ? handle.cwd.trim() : '') ||
    (opCtx && typeof opCtx.cwd === 'string' && opCtx.cwd.trim() ? opCtx.cwd.trim() : '')
  const platform = ctx.platform || null
  const fs = platform?.fs || ctx.fs || null
  const env = platform?.env || null

  // ── Gate 1：本地组织与项目坐标完整性检查 ──
  const g1Start = Date.now()
  const coordsRes = await resolveYunxiaoCoordinates({ cwd, fs, env })

  const handleRef = repoRefId(
    handle && typeof (handle as Record<string, unknown>)['refId'] !== 'undefined'
      ? (handle as { refId?: unknown; name?: unknown })
      : (handle?.repository as { refId?: unknown; name?: unknown } | undefined),
  )
  const parsedHandleRef = parseYunxiaoRefId(handleRef)

  let organizationId = ''
  let projectId = ''
  let customCode = ''
  let apiBaseUrl = DEFAULT_YUNXIAO_API_BASE_URL
  let webBaseUrl = DEFAULT_YUNXIAO_WEB_BASE_URL
  let coordsForCodeup: { repositoryId?: string; webBaseUrl?: string; apiBaseUrl?: string } | null = null

  if (coordsRes.ok) {
    organizationId = coordsRes.value.organizationId
    projectId = coordsRes.value.projectId
    customCode = coordsRes.value.customCode || ''
    apiBaseUrl = coordsRes.value.apiBaseUrl
    webBaseUrl = coordsRes.value.webBaseUrl
    coordsForCodeup = coordsRes.value
  } else if (
    parsedHandleRef &&
    isValidOrganizationId(parsedHandleRef.organizationId, apiBaseUrl) &&
    isValidProjectId(parsedHandleRef.projectId) &&
    coordsRes.reason === 'bad-shape'
  ) {
    organizationId = parsedHandleRef.organizationId
    projectId = parsedHandleRef.projectId
  } else {
    emitReadDegraded(ctx, 'preflight', 'preflight:config', Date.now() - startedAt, ERROR_KIND.ENV)
    return fail(ERROR_KIND.ENV as ErrorKind, coordsRes.message, coordsRes.message)
  }

  const refId = formatYunxiaoRefId(organizationId, projectId)
  learnYunxiaoContextFor(
    { cwd, refId },
    {
      organizationId,
      projectId,
      ...(customCode ? { customCode } : {}),
      apiBaseUrl,
      webBaseUrl,
    },
  )
  emitPreflightGatePass(ctx, 1, Date.now() - g1Start)

  // ── Gate 2：平台当前令牌用户认证有效性探针（GET /oapi/v1/platform/user） ──
  const g2Start = Date.now()
  let token = typeof ctx.token === 'string' ? ctx.token.trim() : ''
  if (!token) {
    const loaded = await loadYunxiaoToken({ env, fs, platform })
    token = loaded.token
  }
  if (!token) {
    const msg = 'Missing Yunxiao token: set YUNXIAO_TOKEN or ~/.config/yunxiao/token'
    emitReadDegraded(ctx, 'preflight', 'preflight:auth', Date.now() - startedAt, ERROR_KIND.AUTH)
    return fail(ERROR_KIND.AUTH as ErrorKind, msg, '')
  }

  const reqCtx: YunxiaoCtx = { ...ctx, cwd, apiBaseUrl, token }
  const userRes = await requestPlatformUser(reqCtx, GITLAB_PROBE_TIMEOUT_MS)
  if (!userRes.ok) {
    const verdict = classifyYunxiaoError(userRes, reqCtx)
    const kind = loginProbeKind(verdict.kind)
    const rawText = (userRes.stderr || userRes.stdout || '').trim()
    const message = verdict.fallback ? HINT_UNRECOGNIZED : rawText.slice(0, 500) || '云效用户认证探针失败'
    emitReadDegraded(ctx, 'preflight', 'preflight:auth', Date.now() - startedAt, kind)
    return fail(kind, message, rawText)
  }

  const userBag = asRecord(userRes.data)
  const userId = userBag && typeof userBag['id'] === 'string' ? userBag['id'].trim() : ''
  const userName = userBag && typeof userBag['name'] === 'string' ? userBag['name'].trim() : ''
  const userLogin = userBag && typeof userBag['username'] === 'string' ? userBag['username'].trim() : ''
  const lastOrg = userBag && typeof userBag['lastOrganization'] === 'string' ? userBag['lastOrganization'].trim() : ''
  if (!userId) {
    emitReadDegraded(ctx, 'preflight', 'preflight:auth', Date.now() - startedAt, ERROR_KIND.PARSE)
    return fail(
      ERROR_KIND.PARSE as ErrorKind,
      '云效平台用户探针回包缺少有效用户 id',
      userRes.stdout,
    )
  }

  learnYunxiaoContextFor(
    { cwd, refId },
    {
      organizationId,
      projectId,
      currentUser: {
        id: userId,
        name: userName || userLogin || userId,
        ...(userLogin ? { username: userLogin } : {}),
        ...(lastOrg ? { lastOrganization: lastOrg } : {}),
      },
    },
  )
  emitPreflightGatePass(ctx, 2, Date.now() - g2Start)

  // ── Gate 3：Yunxiao Projex 项目访问权限探针与 customCode 缓存 ──
  const g3Start = Date.now()
  const projRes = await requestProjectGet(reqCtx, organizationId, projectId, GITLAB_PROBE_TIMEOUT_MS)
  if (!projRes.ok) {
    const verdict = classifyYunxiaoError(projRes, reqCtx)
    const rawText = (projRes.stderr || projRes.stdout || '').trim()
    const message = verdict.fallback ? HINT_UNRECOGNIZED : rawText.slice(0, 500) || 'Yunxiao Projex 项目访问失败'
    emitReadDegraded(ctx, 'preflight', 'preflight:project', Date.now() - startedAt, verdict.kind)
    return fail(verdict.kind, message, rawText)
  }

  const projParsed = parseYunxiaoProjectPayload(projRes.data)
  if (!projParsed) {
    emitReadDegraded(ctx, 'preflight', 'preflight:project', Date.now() - startedAt, ERROR_KIND.PARSE)
    return fail(
      ERROR_KIND.PARSE as ErrorKind,
      'Yunxiao Projex GetProject 回包不是有效的项目对象',
      projRes.stdout,
    )
  }

  learnYunxiaoContextFor(
    { cwd, refId },
    {
      organizationId,
      projectId,
      ...(projParsed.customCode ? { customCode: projParsed.customCode } : {}),
      ...(projParsed.projectName ? { projectName: projParsed.projectName } : {}),
    },
  )
  emitPreflightGatePass(ctx, 3, Date.now() - g3Start)

  // ── Gate 4：按需 Codeup 仓库可读性探针（无代码库工作区在第 3 步通过后即判成功） ──
  const g4Start = Date.now()
  const codeupRes = await resolveCodeupRepositoryIdentity({
    cwd,
    organizationId,
    projectId,
    ctx: reqCtx,
    timeoutMs: GITLAB_PROBE_TIMEOUT_MS,
    coords: coordsForCodeup,
  })

  if (!codeupRes.associated) {
    // 纯 Yunxiao Projex 规划工作区（未关联 Codeup 仓库）：第 3 步通过即整体成功
    return { ok: true }
  }

  if (!codeupRes.ok) {
    const verdict = classifyYunxiaoError(codeupRes.response, reqCtx)
    const rawText = (codeupRes.response.stderr || codeupRes.response.stdout || '').trim()
    const message = verdict.fallback ? HINT_UNRECOGNIZED : rawText.slice(0, 500) || 'Codeup 仓库访问探针失败'
    emitReadDegraded(ctx, 'preflight', 'preflight:codeup', Date.now() - startedAt, verdict.kind)
    return fail(verdict.kind, message, rawText)
  }

  const level = codeupRes.identity.accessLevel
  if (typeof level !== 'number' || !Number.isFinite(level) || level < CODEUP_READ_MIN_ACCESS_LEVEL) {
    const msg = '当前账号对关联的 Codeup 仓库缺少可读权限（要求 accessLevel >= 20）'
    emitReadDegraded(ctx, 'preflight', 'preflight:codeup', Date.now() - startedAt, ERROR_KIND.AUTH)
    return fail(ERROR_KIND.AUTH as ErrorKind, msg, codeupRes.response.stdout)
  }

  emitPreflightGatePass(ctx, 4, Date.now() - g4Start)
  return { ok: true }
}

export default yunxiaoPreflight
