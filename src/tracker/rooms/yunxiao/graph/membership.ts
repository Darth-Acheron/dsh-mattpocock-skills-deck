/**
 * src/tracker/rooms/yunxiao/graph/membership.ts —— Yunxiao Projex 父子挂载与认领指派路由（#03 实施 setAssignees，#04 实施 setParent）。
 *
 * 为什么 setAssignees 以正文文件头 <!-- DSH-ASSIGNEES: ... --> 为契约真源：
 *   1. 真机实测（Wayfinder #11）证实 Yunxiao Projex 的 assignedTo 必填且不可清空（传 ""/null/"EMPTY_VALUE" 均报 400），
 *      而 participants 支持传 [] 清空为 null。
 *   2. 认领或释放时，setAssignees 先重写文件头 DSH-ASSIGNEES 标记，同时将认领人解析为云效用户 ID
 *      同步更新原生 assignedTo 与 participants（释放认领时将 participants 置为 []，原生 assignedTo 保持当前 PAT 用户），
 *      使 Deck 契约（未认领回 []）与云效网页端展示协同一致。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../../contract/entities.js'
import type { AssigneeInput, SetOpts } from '../../../contract/inputs.js'
import { TRACKER_ERROR_STAGE, type OpResult } from '../../../contract/results.js'
import { fail, HINT_UNSUPPORTED } from '../../../kernel/preflight.js'
import { GITLAB_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { failYunxiao } from '../errors.js'
import { rewriteDescriptionWithAssignees } from '../model/description-markers.js'
import { bodyOfWorkitem, normalizeYunxiaoIssue } from '../model/normalize.js'
import { requestWorkitemUpdate } from '../requests.js'
import {
  checkExpectedUpdatedAt,
  errMsg,
  extractAssigneeLogins,
  fetchRawWorkitem,
  resolveProjectRef,
  type CtxLike,
  type RawBag,
  type RepoLike,
} from '../issues/shared.js'
import { resolveNativeUserIdsForAssignees } from '../issues/write.js'

/** 设置或移除工作项的父工作项（契约操作 setParent，由实施票 #04 实现）。 */
export async function setParent(
  _ctx: BackendContext,
  _repo: RepositoryRef,
  _key: string,
  _parentKey: string | null,
  _opts: SetOpts | undefined,
  _opCtx: OpContext,
): Promise<OpResult<Issue>> {
  return fail(ERROR_KIND.UNSUPPORTED as ErrorKind, HINT_UNSUPPORTED, '')
}

/**
 * 覆盖式更新工作项认领人（契约操作 setAssignees）。
 */
export async function setAssignees(
  ctx: BackendContext,
  repo: RepositoryRef,
  key: string,
  assignees: AssigneeInput[],
  opts: SetOpts | undefined,
  opCtx: OpContext,
): Promise<OpResult<Issue>> {
  const effective = (opCtx || ctx) as CtxLike
  const proj = resolveProjectRef(repo as RepoLike)
  if (!proj) {
    return fail(ERROR_KIND.NOTFOUND as ErrorKind, 'setAssignees: repo.refId 缺失或格式不是 organizationId/projectId', '')
  }
  const k = String(key == null ? '' : key).trim()
  if (!k) {
    return fail(ERROR_KIND.PARSE as ErrorKind, 'setAssignees: 工作项编号不能为空', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  }

  const wanted = extractAssigneeLogins(assignees)
  try {
    const fetched = await fetchRawWorkitem(effective, proj, k)
    if (!fetched.ok) return { ok: false, error: fetched.error }

    const conflict = checkExpectedUpdatedAt(opts, fetched.raw)
    if (conflict) return conflict

    const oldBody = bodyOfWorkitem(fetched.raw)
    const newBody = rewriteDescriptionWithAssignees(oldBody, wanted)
    const userResolved = await resolveNativeUserIdsForAssignees(effective, proj, wanted)
    if (!userResolved.ok) return userResolved

    const updateFields: Record<string, unknown> = {
      description: newBody,
      formatType: 'MARKDOWN',
      assignedTo: userResolved.primaryUserId,
      participants: wanted.length > 0 ? userResolved.participantIds : [],
    }

    const updRes = await requestWorkitemUpdate(
      effective,
      proj.organizationId,
      fetched.workitemId,
      updateFields,
      GITLAB_READ_TIMEOUT_MS,
    )
    if (!updRes.ok) {
      return failYunxiao(updRes, updRes.stderr || updRes.stdout || '更新工作项认领人失败', updRes, effective)
    }

    const after = await fetchRawWorkitem(effective, proj, fetched.workitemId)
    if (!after.ok) {
      const fallbackRaw: RawBag = { ...fetched.raw, description: newBody }
      return { ok: true, data: normalizeYunxiaoIssue(fallbackRaw, repo) }
    }
    return { ok: true, data: normalizeYunxiaoIssue(after.raw, repo) }
  } catch (err: unknown) {
    return failYunxiao(err, errMsg(err), err, effective)
  }
}

export default { setParent, setAssignees }
