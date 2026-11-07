/**
 * src/tracker/rooms/yunxiao/labels/list.ts —— Yunxiao Projex 项目标签列表路由（#02 骨架接入，#03 实施完整业务逻辑）。
 */
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { OpContext } from '../../../contract/contexts.js'
import type { RepositoryRef } from '../../../contract/entities.js'
import type { LabelListResult } from '../../../contract/results.js'
import { fail, HINT_UNSUPPORTED } from '../../../kernel/preflight.js'

export async function listLabels(
  _repo: RepositoryRef,
  _ctx: OpContext,
): Promise<LabelListResult> {
  return fail(ERROR_KIND.UNSUPPORTED as ErrorKind, HINT_UNSUPPORTED, '')
}
