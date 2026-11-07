/**
 * src/tracker/rooms/yunxiao/graph/read.ts —— Yunxiao Projex 阻塞依赖关系读取路由（#02 骨架接入，#04 实施完整业务逻辑）。
 */
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { RepositoryRef } from '../../../contract/entities.js'
import type { DepsOpts } from '../../../contract/inputs.js'
import type { DependenciesResult } from '../../../contract/results.js'
import { fail, HINT_UNSUPPORTED } from '../../../kernel/preflight.js'

export async function getDependencies(
  _ctx: BackendContext,
  _repo: RepositoryRef,
  _key: string,
  _opts: DepsOpts | undefined,
  _opCtx: OpContext,
): Promise<DependenciesResult> {
  return fail(ERROR_KIND.UNSUPPORTED as ErrorKind, HINT_UNSUPPORTED, '')
}
