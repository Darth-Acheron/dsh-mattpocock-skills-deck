/**
 * src/tracker/rooms/yunxiao/issues/counts.ts —— Yunxiao Projex 工作项计数路由（#02 骨架接入，#03 实施完整业务逻辑）。
 */
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { OpContext } from '../../../contract/contexts.js'
import type { RepositoryRef } from '../../../contract/entities.js'
import type { ListFilter } from '../../../contract/inputs.js'
import type { CountsResult } from '../../../contract/results.js'
import { fail, HINT_UNSUPPORTED } from '../../../kernel/preflight.js'

export async function counts(
  _repo: RepositoryRef,
  _filter: ListFilter | undefined,
  _ctx: OpContext,
): Promise<CountsResult> {
  return fail(ERROR_KIND.UNSUPPORTED as ErrorKind, HINT_UNSUPPORTED, '')
}
