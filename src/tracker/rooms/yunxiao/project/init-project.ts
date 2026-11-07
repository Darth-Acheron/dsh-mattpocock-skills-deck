/**
 * src/tracker/rooms/yunxiao/project/init-project.ts —— Codeup 一键开仓发布路由（#02 骨架接入，#04 实施完整业务逻辑）。
 */
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { OpContext, RepoHandle } from '../../../contract/contexts.js'
import type { RepositoryRef } from '../../../contract/entities.js'
import type { InitProjectInput } from '../../../contract/inputs.js'
import type { OpResult } from '../../../contract/results.js'
import { fail, HINT_UNSUPPORTED } from '../../../kernel/preflight.js'

export async function initProject(
  _handle: RepoHandle,
  _input: InitProjectInput,
  _ctx: OpContext,
): Promise<OpResult<RepositoryRef>> {
  return fail(ERROR_KIND.UNSUPPORTED as ErrorKind, HINT_UNSUPPORTED, '')
}
