/**
 * src/tracker/rooms/yunxiao/graph/write.ts —— Yunxiao Projex 阻塞依赖关系写入路由（#02 骨架接入，#04 实施完整业务逻辑）。
 */
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../../contract/entities.js'
import type { SetOpts } from '../../../contract/inputs.js'
import type { OpResult } from '../../../contract/results.js'
import { fail, HINT_UNSUPPORTED } from '../../../kernel/preflight.js'

export async function setBlockedBy(
  _ctx: BackendContext,
  _repo: RepositoryRef,
  _key: string,
  _blockers: string[],
  _opts: SetOpts | undefined,
  _opCtx: OpContext,
): Promise<OpResult<Issue>> {
  return fail(ERROR_KIND.UNSUPPORTED as ErrorKind, HINT_UNSUPPORTED, '')
}
