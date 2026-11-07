/**
 * src/tracker/rooms/yunxiao/issues/write.ts —— Yunxiao Projex 工作项写操作路由（#02 骨架接入，#03 实施完整业务逻辑）。
 */
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../../contract/entities.js'
import type { CloseOpts, CreateInput, UpdatePatch } from '../../../contract/inputs.js'
import type { OpResult } from '../../../contract/results.js'
import { fail, HINT_UNSUPPORTED } from '../../../kernel/preflight.js'

export async function createIssue(
  _ctx: BackendContext,
  _repo: RepositoryRef,
  _input: CreateInput,
  _opCtx: OpContext,
): Promise<OpResult<Issue>> {
  return fail(ERROR_KIND.UNSUPPORTED as ErrorKind, HINT_UNSUPPORTED, '')
}

export async function closeIssue(
  _ctx: BackendContext,
  _repo: RepositoryRef,
  _key: string,
  _opts: CloseOpts | undefined,
  _opCtx: OpContext,
): Promise<OpResult<Issue>> {
  return fail(ERROR_KIND.UNSUPPORTED as ErrorKind, HINT_UNSUPPORTED, '')
}

export async function reopenIssue(
  _ctx: BackendContext,
  _repo: RepositoryRef,
  _key: string,
  _opCtx: OpContext,
): Promise<OpResult<Issue>> {
  return fail(ERROR_KIND.UNSUPPORTED as ErrorKind, HINT_UNSUPPORTED, '')
}

export async function updateIssue(
  _ctx: BackendContext,
  _repo: RepositoryRef,
  _key: string,
  _patch: UpdatePatch,
  _opCtx: OpContext,
): Promise<OpResult<Issue>> {
  return fail(ERROR_KIND.UNSUPPORTED as ErrorKind, HINT_UNSUPPORTED, '')
}
