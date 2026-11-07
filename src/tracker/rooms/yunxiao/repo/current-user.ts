/**
 * src/tracker/rooms/yunxiao/repo/current-user.ts —— Yunxiao backend 单点读：查询当前令牌对应的云效用户（规格 #02）。
 *
 * 远端端点：`GET /oapi/v1/platform/user`（收口在 `../requests.ts` 的 `requestPlatformUser`）。
 * 实测响应形状（Wayfinder #10 / #11）：
 *   `{ id: "6a86ddf4dfcb465c20f193e2", name: "BryanShao", username?: "...", lastOrganization: "673db5665c76405a332eebc4", avatar?: "..." }`
 *
 * 契约行为：
 *   1. 入口先经 `looksLikeYunxiaoProjectRef` 检查 `repo.refId` 是否形如 `${organizationId}/${projectId}`；
 *      缺失或格式不合法时记录 `currentUser:repo-ref` 并返回 `NOTFOUND` 失败（与 GitLab 房间同一道入口纪律）。
 *   2. 成功解析后将 `{ id, name, username, lastOrganization }` 缓存在 `learnedYunxiaoContext`，
 *      供后续创建未认领工作项填充必填的原生 `assignedTo` 字段使用。
 *   3. 返回契约 `Actor`：`login` 优先取 `username`，缺省取 `name` 或 `id`；`name` 取 `name`；有 `avatarUrl` / `avatar` 时一并附上。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { Actor, ErrorKind } from '../../../contract/identity.js'
import type { OpContext } from '../../../contract/contexts.js'
import type { RepositoryRef } from '../../../contract/entities.js'
import type { OpResult } from '../../../contract/results.js'
import { fail } from '../../../kernel/preflight.js'
import { GITLAB_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { asRecord, errMsg, failYunxiao } from '../errors.js'
import { learnYunxiaoContextFor, parseYunxiaoRefId, repoRefId } from '../model/repo-identity.js'
import { requestPlatformUser } from '../requests.js'
import { emitReadDegraded } from '../support/read-log.js'
import { looksLikeYunxiaoProjectRef } from './identity.js'

/**
 * 查询当前令牌对应的云效用户身份（契约操作 `getCurrentUser`）。
 */
export async function getCurrentUser(repo: RepositoryRef, ctx: OpContext): Promise<OpResult<Actor>> {
  const t0 = Date.now()
  const refId = repoRefId(repo)
  if (!looksLikeYunxiaoProjectRef(refId)) {
    emitReadDegraded(ctx, 'currentUser', 'currentUser:repo-ref', Date.now() - t0, ERROR_KIND.NOTFOUND)
    return fail(
      ERROR_KIND.NOTFOUND as ErrorKind,
      'getCurrentUser: repo.refId 缺失或不像是「organizationId/projectId」',
      '',
    )
  }

  try {
    const res = await requestPlatformUser(ctx, GITLAB_READ_TIMEOUT_MS)
    if (!res.ok) {
      const failed = failYunxiao(res, res.stderr || res.stdout || 'getCurrentUser 请求失败', res, ctx)
      emitReadDegraded(ctx, 'currentUser', 'currentUser:transport', Date.now() - t0, failed.error.kind)
      return failed
    }

    const bag = asRecord(res.data)
    if (!bag) {
      emitReadDegraded(ctx, 'currentUser', 'currentUser:json', Date.now() - t0, ERROR_KIND.PARSE)
      return fail(ERROR_KIND.PARSE as ErrorKind, 'getCurrentUser: 回包不是 JSON 对象', res.stdout)
    }

    const id = typeof bag['id'] === 'string' ? bag['id'].trim() : ''
    const name = typeof bag['name'] === 'string' ? bag['name'].trim() : ''
    const username = typeof bag['username'] === 'string' ? bag['username'].trim() : ''
    const lastOrganization = typeof bag['lastOrganization'] === 'string' ? bag['lastOrganization'].trim() : ''

    const login = username || name || id
    if (!login || !id) {
      emitReadDegraded(ctx, 'currentUser', 'currentUser:shape', Date.now() - t0, ERROR_KIND.PARSE)
      return fail(ERROR_KIND.PARSE as ErrorKind, 'getCurrentUser: 回包缺少有效的用户 id 或名称', res.stdout)
    }

    const parsedRef = parseYunxiaoRefId(refId)
    if (parsedRef) {
      learnYunxiaoContextFor(
        { cwd: ctx?.cwd, refId },
        {
          organizationId: parsedRef.organizationId,
          projectId: parsedRef.projectId,
          currentUser: {
            id,
            name: name || login,
            ...(username ? { username } : {}),
            ...(lastOrganization ? { lastOrganization } : {}),
          },
        },
      )
    }

    const actor: Actor = { login }
    if (name) actor.name = name
    const avatar =
      typeof bag['avatarUrl'] === 'string' && bag['avatarUrl'].trim()
        ? bag['avatarUrl'].trim()
        : typeof bag['avatar'] === 'string' && bag['avatar'].trim()
          ? bag['avatar'].trim()
          : ''
    if (avatar) actor.avatarUrl = avatar

    return { ok: true, data: actor }
  } catch (err: unknown) {
    const failed = failYunxiao(err, errMsg(err), err, ctx)
    emitReadDegraded(ctx, 'currentUser', 'currentUser:transport', Date.now() - t0, failed.error.kind)
    return failed
  }
}

export default { getCurrentUser }
