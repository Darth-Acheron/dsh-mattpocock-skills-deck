/**
 * src/tracker/rooms/yunxiao/labels/assign.ts —— Yunxiao Projex 工作项标签指派路由（#02 骨架接入，#03 实施完整业务逻辑）。
 */
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../../contract/entities.js'
import type { LabelInput, SetOpts } from '../../../contract/inputs.js'
import type { OpResult } from '../../../contract/results.js'
import { fail, HINT_UNSUPPORTED } from '../../../kernel/preflight.js'

export async function setLabels(
  _ctx: BackendContext,
  _repo: RepositoryRef,
  _key: string,
  _labels: LabelInput[],
  _opts: SetOpts | undefined,
  _opCtx: OpContext,
): Promise<OpResult<Issue>> {
  return fail(ERROR_KIND.UNSUPPORTED as ErrorKind, HINT_UNSUPPORTED, '')
}
