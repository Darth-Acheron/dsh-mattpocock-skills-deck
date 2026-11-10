/**
 * src/tracker/rooms/yunxiao/repo/permissions.ts —— Yunxiao backend 仓库与项目权限核验（规格 #02 + 架构加深 Candidate 1）。
 *
 * 为什么 Yunxiao backend 的 `triage` 与 `push` 必须分别依据 Yunxiao Projex 与 Codeup 的角色档位判定：
 *   1. 工作项托管在 Yunxiao Projex 项目（`projectId`），只要 `probeYunxiaoProjexProject` 成功返回项目对象，
 *      即可整理与操作工作项（`triage: true`）。
 *   2. 真机实测（Wayfinder #10）证实：当用户配置「代码仓库：只读」令牌时，`GetRepository` 返回的 `allowPush`
 *      仍恒为 `false`。因此判断用户是否具备代码推送角色（`push`），必须且只能依据
 *      `archived !== true && Number(accessLevel) >= 30`。
 *   3. 当工作区是无代码库的纯 Yunxiao Projex 规划工作区时，直接返回 `{ push: false, triage: true }`。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { OpContext } from '../../../contract/contexts.js'
import type { RepositoryRef } from '../../../contract/entities.js'
import type { OpResult, RepoPermissions } from '../../../contract/results.js'
import { fail } from '../../../kernel/preflight.js'
import { GITLAB_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import type { YunxiaoCtx } from '../client.js'
import { errMsg, failYunxiao } from '../errors.js'
import { parseYunxiaoRefId, repoRefId } from '../model/repo-identity.js'
import { resolveYunxiaoCoordinates } from '../model/workspace-config.js'
import { emitReadDegraded } from '../support/read-log.js'
import { probeYunxiaoProjexProject } from './current-user.js'
import { looksLikeYunxiaoProjectRef, resolveCodeupRepositoryIdentity } from './identity.js'

/** Codeup 允许推送代码的最低角色档位：Developer (30)。 */
export const CODEUP_PUSH_MIN_ACCESS_LEVEL = 30

/**
 * 查询当前账号在 Yunxiao Projex 项目与关联 Codeup 仓库上的权限（契约操作 `getRepoPermissions`）。
 */
export async function getRepoPermissions(
  repo: RepositoryRef,
  ctx: OpContext,
): Promise<OpResult<RepoPermissions>> {
  const t0 = Date.now()
  const refId = repoRefId(repo)
  const parsedRef = parseYunxiaoRefId(refId)
  if (!looksLikeYunxiaoProjectRef(refId) || !parsedRef) {
    emitReadDegraded(ctx, 'permissions', 'permissions:repo-ref', Date.now() - t0, ERROR_KIND.NOTFOUND)
    return fail(
      ERROR_KIND.NOTFOUND as ErrorKind,
      'getRepoPermissions: repo.refId 缺失或不像是「organizationId/projectId」',
      '',
    )
  }

  try {
    const cwd = String(ctx?.cwd || '').trim()
    const fs = ctx?.platform?.fs || ctx?.fs || null
    const env = ctx?.platform?.env || null
    let coordsVal: { repositoryId?: string; webBaseUrl?: string; apiBaseUrl?: string } | null = null
    if (cwd || fs || env) {
      const coords = await resolveYunxiaoCoordinates({ cwd, fs, env })
      if (coords.ok) coordsVal = coords.value
    }

    const reqCtx: YunxiaoCtx =
      coordsVal?.apiBaseUrl && !(ctx as YunxiaoCtx)?.apiBaseUrl
        ? { ...(ctx as YunxiaoCtx), apiBaseUrl: coordsVal.apiBaseUrl }
        : (ctx as YunxiaoCtx)

    // 1) 校验 Yunxiao Projex 项目访问权限（决定 triage）
    const projProbed = await probeYunxiaoProjexProject(
      reqCtx,
      parsedRef.organizationId,
      parsedRef.projectId,
      GITLAB_READ_TIMEOUT_MS,
      { cwd, refId },
    )
    if (!projProbed.ok) {
      if (projProbed.kind === 'transport') {
        const failed = failYunxiao(
          projProbed.response,
          projProbed.response.stderr || projProbed.response.stdout || 'getRepoPermissions: GetProject 请求失败',
          projProbed.response,
          ctx,
        )
        emitReadDegraded(ctx, 'permissions', 'permissions:transport', Date.now() - t0, failed.error.kind)
        return failed
      }
      emitReadDegraded(ctx, 'permissions', 'permissions:json', Date.now() - t0, ERROR_KIND.PARSE)
      return fail(ERROR_KIND.PARSE as ErrorKind, 'getRepoPermissions: GetProject 回包不是有效的项目对象', projProbed.response.stdout)
    }

    // 2) 检查是否关联了 Codeup 仓库（决定 push）
    const codeupResolved = await resolveCodeupRepositoryIdentity({
      cwd,
      organizationId: parsedRef.organizationId,
      projectId: parsedRef.projectId,
      ctx: reqCtx,
      timeoutMs: GITLAB_READ_TIMEOUT_MS,
      coords: coordsVal,
    })

    if (!codeupResolved.associated) {
      return { ok: true, data: { push: false, triage: true } }
    }

    if (!codeupResolved.ok) {
      const failed = failYunxiao(
        codeupResolved.response,
        codeupResolved.response.stderr || codeupResolved.response.stdout || 'getRepoPermissions: GetRepository 请求失败',
        codeupResolved.response,
        ctx,
      )
      emitReadDegraded(ctx, 'permissions', 'permissions:transport', Date.now() - t0, failed.error.kind)
      return failed
    }

    const identity = codeupResolved.identity
    if (typeof identity.accessLevel !== 'number' || !Number.isFinite(identity.accessLevel)) {
      emitReadDegraded(ctx, 'permissions', 'permissions:no-fields', Date.now() - t0, ERROR_KIND.PARSE)
      return fail(
        ERROR_KIND.PARSE as ErrorKind,
        'getRepoPermissions: GetRepository 回包缺少有效的 accessLevel 数值',
        codeupResolved.response.stdout,
      )
    }

    const canPush = identity.archived !== true && identity.accessLevel >= CODEUP_PUSH_MIN_ACCESS_LEVEL
    return { ok: true, data: { push: canPush, triage: true } }
  } catch (err: unknown) {
    const failed = failYunxiao(err, errMsg(err), err, ctx)
    emitReadDegraded(ctx, 'permissions', 'permissions:transport', Date.now() - t0, failed.error.kind)
    return failed
  }
}

export default { getRepoPermissions }
