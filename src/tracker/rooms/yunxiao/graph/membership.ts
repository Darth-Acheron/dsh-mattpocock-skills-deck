/**
 * src/tracker/rooms/yunxiao/graph/membership.ts —— Yunxiao Projex 父子挂载与认领指派路由（#02 骨架接入，#03/#04 实施完整业务逻辑）。
 */
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../../contract/entities.js'
import type { AssigneeInput, SetOpts } from '../../../contract/inputs.js'
import type { OpResult } from '../../../contract/results.js'
import { fail, HINT_UNSUPPORTED } from '../../../kernel/preflight.js'

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

export async function setAssignees(
  _ctx: BackendContext,
  _repo: RepositoryRef,
  _key: string,
  _assignees: AssigneeInput[],
  _opts: SetOpts | undefined,
  _opCtx: OpContext,
): Promise<OpResult<Issue>> {
  return fail(ERROR_KIND.UNSUPPORTED as ErrorKind, HINT_UNSUPPORTED, '')
}
