/**
 * src/tracker/rooms/yunxiao/preflight.ts —— Yunxiao backend 认证先行的四步递进式环境预检（规格 #21 / #22）。
 *
 * 为什么采用认证先行的四步递进式预检：
 *   1. 第 1 关（平台用户认证探针）：网络前只轻量读取服务地址并拦截损坏配置或内联凭证；
 *      再确认个人访问令牌存在并调用 `GET /oapi/v1/platform/user`，保留当前用户供后续坐标发现使用。
 *   2. 第 2 关（本地坐标校验）：令牌有效后才检查 24 位 `organizationId` 与 26 位 `projectId`；
 *      缺少坐标返回 `ENV`，但不再阻止第 1 关认证，也保留合法 `handle.refId` 的既有回退。
 *   3. 第 3 关（Yunxiao Projex 项目访问探针）：调用 `probeYunxiaoProjexProject` 校验项目可读性并缓存
 *      项目代号 `customCode`（如 `DCIAFS`），将 `HTTP 400 InvalidIdentifier.NotFound` 精准映射为 `NOTFOUND`。
 *   4. 第 4 关（按需 Codeup 仓库可读性探针）：无代码库的纯规划工作区在第 3 关通过后即判成功；
 *      若关联了 Codeup 仓库，则执行双步 `GetRepository` 解析并要求 `Number(accessLevel) >= 20`。
 */

import { ERROR_KIND } from '../../contract/vocabulary.js'
import type { ErrorKind } from '../../contract/identity.js'
import type { BackendContext, OpContext } from '../../contract/contexts.js'
import type { RepositoryRef } from '../../contract/entities.js'
import type { PreflightResult } from '../../contract/results.js'
import { fail, HINT_UNRECOGNIZED } from '../../kernel/preflight.js'
import { GITLAB_PROBE_TIMEOUT_MS } from '../../../shared/time-config/src/values.js'
import type { YunxiaoCtx } from './client.js'
import { classifyYunxiaoError } from './errors.js'
import {
  formatYunxiaoRefId,
  learnYunxiaoContextFor,
  parseYunxiaoRefId,
  repoRefId,
} from './model/repo-identity.js'
import {
  isValidOrganizationId,
  isValidProjectId,
  loadYunxiaoToken,
  resolveYunxiaoBaseUrls,
  resolveYunxiaoCoordinates,
} from './model/workspace-config.js'
import { probeYunxiaoPlatformUser, probeYunxiaoProjexProject } from './repo/current-user.js'
import { resolveCodeupRepositoryIdentity } from './repo/identity.js'
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

/** 构造带真实失败关卡的预检结果；阶段放在 PreflightResult 上，不占用 TrackerError.stage 的既有语义。 */
function failAtPreflightStage(
  stage: 'auth' | 'gh' | 'repo',
  kind: ErrorKind,
  message: string,
  raw: unknown,
): PreflightResult {
  return { ...fail(kind, message, raw), stage }
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

  // ── 网络前安全闸：只读取服务地址；坐标缺失不在这里失败，语法损坏与内联凭证必须立即失败 ──
  const baseUrlsRes = await resolveYunxiaoBaseUrls({ cwd, fs, env })
  if (!baseUrlsRes.ok) {
    emitReadDegraded(ctx, 'preflight', 'preflight:config', Date.now() - startedAt, ERROR_KIND.ENV)
    return failAtPreflightStage('auth', ERROR_KIND.ENV as ErrorKind, baseUrlsRes.message, baseUrlsRes.message)
  }

  const handleRef = repoRefId(
    handle && typeof (handle as Record<string, unknown>)['refId'] !== 'undefined'
      ? (handle as { refId?: unknown; name?: unknown })
      : (handle?.repository as { refId?: unknown; name?: unknown } | undefined),
  )
  const parsedHandleRef = parseYunxiaoRefId(handleRef)

  let organizationId = ''
  let projectId = ''
  let customCode = ''
  let apiBaseUrl = baseUrlsRes.value.apiBaseUrl
  let webBaseUrl = baseUrlsRes.value.webBaseUrl
  let refId = parsedHandleRef ? formatYunxiaoRefId(parsedHandleRef.organizationId, parsedHandleRef.projectId) : ''
  let coordsForCodeup: { repositoryId?: string; webBaseUrl?: string; apiBaseUrl?: string } | null = null

  // ── Gate 1：平台当前令牌用户认证有效性探针（GET /oapi/v1/platform/user） ──
  const g1Start = Date.now()
  let token = typeof ctx.token === 'string' ? ctx.token.trim() : ''
  if (!token) {
    const loaded = await loadYunxiaoToken({ env, fs, platform })
    token = loaded.token
  }
  if (!token) {
    const msg = 'Missing Yunxiao token: set YUNXIAO_TOKEN or ~/.config/yunxiao/token'
    emitReadDegraded(ctx, 'preflight', 'preflight:auth', Date.now() - startedAt, ERROR_KIND.AUTH)
    return failAtPreflightStage('auth', ERROR_KIND.AUTH as ErrorKind, msg, '')
  }

  const reqCtx: YunxiaoCtx = { ...ctx, cwd, apiBaseUrl, token }
  const userProbed = await probeYunxiaoPlatformUser(reqCtx, GITLAB_PROBE_TIMEOUT_MS, {
    cwd,
    refId,
    apiBaseUrl,
    token,
  })
  if (!userProbed.ok) {
    if (userProbed.kind === 'transport') {
      const verdict = classifyYunxiaoError(userProbed.response, reqCtx)
      const kind = loginProbeKind(verdict.kind)
      const rawText = (userProbed.response.stderr || userProbed.response.stdout || '').trim()
      const message = verdict.fallback ? HINT_UNRECOGNIZED : rawText.slice(0, 500) || '云效用户认证探针失败'
      emitReadDegraded(ctx, 'preflight', 'preflight:auth', Date.now() - startedAt, kind)
      return failAtPreflightStage('auth', kind, message, rawText)
    }
    emitReadDegraded(ctx, 'preflight', 'preflight:auth', Date.now() - startedAt, ERROR_KIND.PARSE)
    return failAtPreflightStage('auth', ERROR_KIND.PARSE as ErrorKind, '云效平台用户探针回包缺少有效用户 id', userProbed.response.stdout)
  }
  const authenticatedUser = {
    id: userProbed.user.id,
    name: userProbed.user.name || userProbed.user.login,
    ...(userProbed.user.lastOrganization ? { lastOrganization: userProbed.user.lastOrganization } : {}),
  }
  // 身份一旦探明就立即保留，不能等坐标成功；这里只写用户与服务地址，绝不把令牌放进 learned context。
  learnYunxiaoContextFor(
    { cwd, refId },
    {
      organizationId: parsedHandleRef?.organizationId || '',
      projectId: parsedHandleRef?.projectId || '',
      apiBaseUrl,
      webBaseUrl,
      currentUser: authenticatedUser,
    },
  )
  emitPreflightGatePass(ctx, 1, Date.now() - g1Start)

  // ── Gate 2：认证成功后校验本地组织与项目坐标；缺失时进入工作区配置，而不是阻碍令牌探针 ──
  const g2Start = Date.now()
  const coordsRes = await resolveYunxiaoCoordinates({ cwd, fs, env })
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
    return failAtPreflightStage('gh', ERROR_KIND.ENV as ErrorKind, coordsRes.message, coordsRes.message)
  }

  refId = formatYunxiaoRefId(organizationId, projectId)
  learnYunxiaoContextFor(
    { cwd, refId },
    {
      organizationId,
      projectId,
      ...(customCode ? { customCode } : {}),
      apiBaseUrl,
      webBaseUrl,
      currentUser: authenticatedUser,
    },
  )
  // 坐标可能来自合法 handle.refId 回退；把同一令牌与服务地址交给后续项目、仓库请求。
  reqCtx.apiBaseUrl = apiBaseUrl
  emitPreflightGatePass(ctx, 2, Date.now() - g2Start)

  // ── Gate 3：Yunxiao Projex 项目访问权限探针与 customCode 缓存 ──
  const g3Start = Date.now()
  const projProbed = await probeYunxiaoProjexProject(reqCtx, organizationId, projectId, GITLAB_PROBE_TIMEOUT_MS, {
    cwd,
    refId,
  })
  if (!projProbed.ok) {
    if (projProbed.kind === 'transport') {
      const verdict = classifyYunxiaoError(projProbed.response, reqCtx)
      const rawText = (projProbed.response.stderr || projProbed.response.stdout || '').trim()
      const message = verdict.fallback ? HINT_UNRECOGNIZED : rawText.slice(0, 500) || 'Yunxiao Projex 项目访问失败'
      emitReadDegraded(ctx, 'preflight', 'preflight:project', Date.now() - startedAt, verdict.kind)
      return failAtPreflightStage('repo', verdict.kind, message, rawText)
    }
    emitReadDegraded(ctx, 'preflight', 'preflight:project', Date.now() - startedAt, ERROR_KIND.PARSE)
    return failAtPreflightStage('repo', ERROR_KIND.PARSE as ErrorKind, 'Yunxiao Projex GetProject 回包不是有效的项目对象', projProbed.response.stdout)
  }
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
    return { ok: true }
  }

  if (!codeupRes.ok) {
    const verdict = classifyYunxiaoError(codeupRes.response, reqCtx)
    const rawText = (codeupRes.response.stderr || codeupRes.response.stdout || '').trim()
    const message = verdict.fallback ? HINT_UNRECOGNIZED : rawText.slice(0, 500) || 'Codeup 仓库访问探针失败'
    emitReadDegraded(ctx, 'preflight', 'preflight:codeup', Date.now() - startedAt, verdict.kind)
    return failAtPreflightStage('repo', verdict.kind, message, rawText)
  }

  const level = codeupRes.identity.accessLevel
  if (typeof level !== 'number' || !Number.isFinite(level) || level < CODEUP_READ_MIN_ACCESS_LEVEL) {
    const msg = '当前账号对关联的 Codeup 仓库缺少可读权限（要求 accessLevel >= 20）'
    // 令牌与坐标均已通过，这里是确定的仓库权限失败；kind=auth 保留统一契约，stage=repo 表达失败关卡。
    emitReadDegraded(ctx, 'preflight', 'preflight:codeup', Date.now() - startedAt, ERROR_KIND.AUTH)
    return failAtPreflightStage('repo', ERROR_KIND.AUTH as ErrorKind, msg, codeupRes.response.stdout)
  }

  emitPreflightGatePass(ctx, 4, Date.now() - g4Start)
  return { ok: true }
}

export default yunxiaoPreflight
