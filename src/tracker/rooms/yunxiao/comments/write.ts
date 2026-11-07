/**
 * src/tracker/rooms/yunxiao/comments/write.ts —— Yunxiao Projex 评论创建路由（#02 骨架接入，#03 实施完整业务逻辑）。
 */
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Comment, RepositoryRef } from '../../../contract/entities.js'
import type { OpResult } from '../../../contract/results.js'
import { fail, HINT_UNSUPPORTED } from '../../../kernel/preflight.js'

export async function addComment(
  _ctx: BackendContext,
  _repo: RepositoryRef,
  _key: string,
  _body: string,
  _opCtx: OpContext,
): Promise<OpResult<Comment>> {
  return fail(ERROR_KIND.UNSUPPORTED as ErrorKind, HINT_UNSUPPORTED, '')
}
