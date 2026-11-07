/**
 * src/tracker/rooms/yunxiao/labels/colors.ts —— Yunxiao Projex 项目标签改色路由（#02 骨架接入，#03 实施完整业务逻辑）。
 */
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { OpContext } from '../../../contract/contexts.js'
import type { LabelColorChange, RepositoryRef } from '../../../contract/entities.js'
import type { LabelColorBatchResult, OpResult } from '../../../contract/results.js'
import { fail, HINT_UNSUPPORTED } from '../../../kernel/preflight.js'

export async function setLabelColors(
  _repo: RepositoryRef,
  _changes: LabelColorChange[],
  _ctx: OpContext,
): Promise<OpResult<LabelColorBatchResult>> {
  return fail(ERROR_KIND.UNSUPPORTED as ErrorKind, HINT_UNSUPPORTED, '')
}
