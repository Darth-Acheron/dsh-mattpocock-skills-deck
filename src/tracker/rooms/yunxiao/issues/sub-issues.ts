/**
 * src/tracker/rooms/yunxiao/issues/sub-issues.ts —— Yunxiao Projex 子工作项列表路由（#02 骨架接入，#04 实施完整业务逻辑）。
 */
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { OpContext } from '../../../contract/contexts.js'
import type { RepositoryRef } from '../../../contract/entities.js'
import type { SubIssueListResult } from '../../../contract/results.js'
import { fail, HINT_UNSUPPORTED } from '../../../kernel/preflight.js'

export async function listSubIssues(
  _repo: RepositoryRef,
  _mapKey: string,
  _opts: Record<string, never> | undefined,
  _ctx: OpContext,
): Promise<SubIssueListResult> {
  return fail(ERROR_KIND.UNSUPPORTED as ErrorKind, HINT_UNSUPPORTED, '')
}
