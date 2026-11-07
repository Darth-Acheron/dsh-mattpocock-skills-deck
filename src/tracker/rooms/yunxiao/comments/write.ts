/**
 * src/tracker/rooms/yunxiao/comments/write.ts —— Yunxiao Projex 评论创建路由（规格 #03）。
 *
 * 核心行为：
 *   1. 支持纯数字、带前缀 serialNumber 或 26 位内部 ID 入参；
 *   2. 调用 requestWorkitemCommentCreate（POST .../workitems/{id}/comments，formatType: "MARKDOWN"）；
 *   3. 将响应归一化为契约 Comment 实体返回。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Comment, RepositoryRef } from '../../../contract/entities.js'
import { TRACKER_ERROR_STAGE, type OpResult } from '../../../contract/results.js'
import { fail } from '../../../kernel/preflight.js'
import { GITLAB_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { asRecord, failYunxiao } from '../errors.js'
import { normalizeYunxiaoComment } from '../model/normalize.js'
import { requestWorkitemCommentCreate } from '../requests.js'
import {
  errMsg,
  resolveIdOrSerialForRead,
  resolveProjectRef,
  type CtxLike,
  type RepoLike,
} from '../issues/shared.js'

/** 在指定工作项下创建一条 Markdown 格式评论（契约操作 comment）。 */
export async function addComment(
  ctx: BackendContext,
  repo: RepositoryRef,
  key: string,
  body: string,
  opCtx: OpContext,
): Promise<OpResult<Comment>> {
  const effective = (opCtx || ctx) as CtxLike
  const proj = resolveProjectRef(repo as RepoLike)
  if (!proj) {
    return fail(ERROR_KIND.NOTFOUND as ErrorKind, 'comment: repo.refId 缺失或格式不是 organizationId/projectId', '')
  }
  const k = String(key == null ? '' : key).trim()
  if (!k) {
    return fail(ERROR_KIND.PARSE as ErrorKind, 'comment: 工作项编号不能为空', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  }
  if (typeof body !== 'string' || !body.trim()) {
    return fail(ERROR_KIND.PARSE as ErrorKind, 'comment: 评论内容不能为空', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  }

  try {
    const idOrSerial = await resolveIdOrSerialForRead(effective, proj, k)
    if (!idOrSerial) {
      return fail(ERROR_KIND.NOTFOUND as ErrorKind, 'comment: 工作项编号格式不合法：' + k, k)
    }

    const res = await requestWorkitemCommentCreate(effective, proj.organizationId, idOrSerial, body, GITLAB_READ_TIMEOUT_MS)
    if (!res.ok) {
      return failYunxiao(res, res.stderr || res.stdout || '创建工作项评论失败', res, effective)
    }

    const now = new Date().toISOString()
    const bag = asRecord(res.data)
    const normalized =
      (bag && normalizeYunxiaoComment({ ...bag, content: typeof bag['content'] === 'string' ? bag['content'] : body })) || {
        ...(bag && bag['id'] != null ? { id: String(bag['id']) } : {}),
        author: { login: '' },
        authorAssociation: '',
        body,
        createdAt: now,
        updatedAt: now,
      }
    if (!normalized.createdAt) normalized.createdAt = now
    if (!normalized.updatedAt) normalized.updatedAt = normalized.createdAt
    return { ok: true, data: normalized }
  } catch (err: unknown) {
    return failYunxiao(err, errMsg(err), err, effective)
  }
}

export default { addComment }
