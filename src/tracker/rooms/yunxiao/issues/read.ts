/**
 * src/tracker/rooms/yunxiao/issues/read.ts —— Yunxiao Projex 工作项列表与单票详情读取路由（#02 骨架接入，#03 实施完整业务逻辑）。
 */
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { RepositoryRef } from '../../../contract/entities.js'
import type { GetOpts, ListFilter } from '../../../contract/inputs.js'
import type { IssueDetailResult, IssueListResult } from '../../../contract/results.js'
import { fail, HINT_UNSUPPORTED } from '../../../kernel/preflight.js'

export async function listIssues(
  _ctx: BackendContext,
  _repo: RepositoryRef,
  _filter: ListFilter | undefined,
  _opCtx: OpContext,
): Promise<IssueListResult> {
  return fail(ERROR_KIND.UNSUPPORTED as ErrorKind, HINT_UNSUPPORTED, '')
}

export async function getIssue(
  _ctx: BackendContext,
  _repo: RepositoryRef,
  _key: string,
  _opts: GetOpts | undefined,
  _opCtx: OpContext,
): Promise<IssueDetailResult> {
  return fail(ERROR_KIND.UNSUPPORTED as ErrorKind, HINT_UNSUPPORTED, '')
}
