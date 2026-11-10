/**
 * src/tracker/rooms/yunxiao/repo/current-user.ts —— Yunxiao backend 平台用户与 Projex 项目元数据探针深模块（规格 #02 + 架构加深 Candidate 1）。
 *
 * 为什么将平台用户认证探针（GET /oapi/v1/platform/user）与 Projex 项目探针（GET .../projects/{id}）收敛在此：
 *   1. 此前 preflight.ts、repo/current-user.ts、repo/permissions.ts、project/init-project.ts 与 issues/write.ts
 *      各自重复拆解 `/oapi/v1/platform/user` 与 `GetProject` 响应并更新 `learnedYunxiaoContext`。
 *   2. 收口为 probeYunxiaoPlatformUser 与 probeYunxiaoProjexProject 两个深模块原语后，
 *      所有调用方通过单一窄缝拿到结构化用户身份（含 lastOrganization）与项目 customCode，并自动更新缓存。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { Actor, ErrorKind } from '../../../contract/identity.js'
import type { OpContext } from '../../../contract/contexts.js'
import type { RepositoryRef } from '../../../contract/entities.js'
import type { OpResult } from '../../../contract/results.js'
import { fail } from '../../../kernel/preflight.js'
import { GITLAB_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import type { YunxiaoCtx, YunxiaoHttpResult } from '../client.js'
import { asRecord, errMsg, failYunxiao } from '../errors.js'
import {
  learnYunxiaoContextFor,
  parseYunxiaoProjectPayload,
  parseYunxiaoRefId,
  repoRefId,
} from '../model/repo-identity.js'
import { requestPlatformUser, requestProjectGet } from '../requests.js'
import { emitReadDegraded } from '../support/read-log.js'
import { looksLikeYunxiaoProjectRef } from './identity.js'

export interface ProbedYunxiaoUser {
  id: string
  name: string
  login: string
  username?: string
  lastOrganization?: string
  avatarUrl?: string
  response: YunxiaoHttpResult
}

/**
 * 探测并解析当前令牌对应的云效平台用户（GET /oapi/v1/platform/user），若提供 organizationId/projectId 则自动写入 learnedYunxiaoContext。
 */
export async function probeYunxiaoPlatformUser(
  ctx: YunxiaoCtx | null | undefined,
  timeoutMs = GITLAB_READ_TIMEOUT_MS,
  scope?: { cwd?: string; refId?: string; organizationId?: string; projectId?: string; token?: string; apiBaseUrl?: string },
): Promise<
  | { ok: true; user: ProbedYunxiaoUser }
  | { ok: false; kind: 'transport' | 'json' | 'shape'; response: YunxiaoHttpResult }
> {
  const res = await requestPlatformUser(ctx, timeoutMs)
  if (!res.ok) return { ok: false, kind: 'transport', response: res }

  const bag = asRecord(res.data)
  if (!bag) return { ok: false, kind: 'json', response: res }

  const id = typeof bag['id'] === 'string' ? bag['id'].trim() : ''
  const name = typeof bag['name'] === 'string' ? bag['name'].trim() : ''
  const username = typeof bag['username'] === 'string' ? bag['username'].trim() : ''
  const lastOrganization = typeof bag['lastOrganization'] === 'string' ? bag['lastOrganization'].trim() : ''
  const login = username || name || id
  if (!id || !login) return { ok: false, kind: 'shape', response: res }

  const avatar =
    typeof bag['avatarUrl'] === 'string' && bag['avatarUrl'].trim()
      ? bag['avatarUrl'].trim()
      : typeof bag['avatar'] === 'string' && bag['avatar'].trim()
        ? bag['avatar'].trim()
        : ''

  if (scope?.organizationId && scope?.projectId) {
    learnYunxiaoContextFor(
      { cwd: scope.cwd ?? ctx?.cwd, refId: scope.refId },
      {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        ...(scope.apiBaseUrl ? { apiBaseUrl: scope.apiBaseUrl } : {}),
        ...(scope.token ? { token: scope.token } : {}),
        currentUser: {
          id,
          name: name || login,
          ...(username ? { username } : {}),
          ...(lastOrganization ? { lastOrganization } : {}),
        },
      },
    )
  }

  return {
    ok: true,
    user: {
      id,
      name: name || login,
      login,
      ...(username ? { username } : {}),
      ...(lastOrganization ? { lastOrganization } : {}),
      ...(avatar ? { avatarUrl: avatar } : {}),
      response: res,
    },
  }
}

/**
 * 探测并解析 Yunxiao Projex 项目详情（GET .../projects/{projectId}），成功时将 customCode 与 projectName 自动写入 learnedYunxiaoContext。
 */
export async function probeYunxiaoProjexProject(
  ctx: YunxiaoCtx | null | undefined,
  organizationId: string,
  projectId: string,
  timeoutMs = GITLAB_READ_TIMEOUT_MS,
  scope?: { cwd?: string; refId?: string },
): Promise<
  | { ok: true; project: { id: string; customCode: string; projectName: string }; response: YunxiaoHttpResult }
  | { ok: false; kind: 'transport' | 'json'; response: YunxiaoHttpResult }
> {
  const res = await requestProjectGet(ctx, organizationId, projectId, timeoutMs)
  if (!res.ok) return { ok: false, kind: 'transport', response: res }

  const parsed = parseYunxiaoProjectPayload(res.data)
  if (!parsed) return { ok: false, kind: 'json', response: res }

  learnYunxiaoContextFor(
    { cwd: scope?.cwd ?? ctx?.cwd, refId: scope?.refId || organizationId + '/' + projectId },
    {
      organizationId,
      projectId,
      ...(parsed.customCode ? { customCode: parsed.customCode } : {}),
      ...(parsed.projectName ? { projectName: parsed.projectName } : {}),
    },
  )
  return { ok: true, project: parsed, response: res }
}

/**
 * 查询当前令牌对应的云效用户身份（契约操作 `getCurrentUser`）。
 */
export async function getCurrentUser(repo: RepositoryRef, ctx: OpContext): Promise<OpResult<Actor>> {
  const t0 = Date.now()
  const refId = repoRefId(repo)
  const parsedRef = parseYunxiaoRefId(refId)
  if (!looksLikeYunxiaoProjectRef(refId) || !parsedRef) {
    emitReadDegraded(ctx, 'currentUser', 'currentUser:repo-ref', Date.now() - t0, ERROR_KIND.NOTFOUND)
    return fail(
      ERROR_KIND.NOTFOUND as ErrorKind,
      'getCurrentUser: repo.refId 缺失或不像是「organizationId/projectId」',
      '',
    )
  }

  try {
    const probed = await probeYunxiaoPlatformUser(ctx, GITLAB_READ_TIMEOUT_MS, {
      cwd: ctx?.cwd,
      refId,
      organizationId: parsedRef.organizationId,
      projectId: parsedRef.projectId,
    })
    if (!probed.ok) {
      if (probed.kind === 'transport') {
        const failed = failYunxiao(probed.response, probed.response.stderr || probed.response.stdout || 'getCurrentUser 请求失败', probed.response, ctx)
        emitReadDegraded(ctx, 'currentUser', 'currentUser:transport', Date.now() - t0, failed.error.kind)
        return failed
      }
      emitReadDegraded(ctx, 'currentUser', probed.kind === 'json' ? 'currentUser:json' : 'currentUser:shape', Date.now() - t0, ERROR_KIND.PARSE)
      return fail(
        ERROR_KIND.PARSE as ErrorKind,
        probed.kind === 'json' ? 'getCurrentUser: 回包不是 JSON 对象' : 'getCurrentUser: 回包缺少有效的用户 id 或名称',
        probed.response.stdout,
      )
    }

    const actor: Actor = { login: probed.user.login }
    if (probed.user.name) actor.name = probed.user.name
    if (probed.user.avatarUrl) actor.avatarUrl = probed.user.avatarUrl
    return { ok: true, data: actor }
  } catch (err: unknown) {
    const failed = failYunxiao(err, errMsg(err), err, ctx)
    emitReadDegraded(ctx, 'currentUser', 'currentUser:transport', Date.now() - t0, failed.error.kind)
    return failed
  }
}

export default { getCurrentUser, probeYunxiaoPlatformUser, probeYunxiaoProjexProject }
