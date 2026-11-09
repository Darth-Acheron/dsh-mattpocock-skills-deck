/**
 * src/tracker/rooms/yunxiao/issues/counts.ts —— Yunxiao Projex 工作项计数路由（规格 #03）。
 *
 * 核心行为：
 *   1. 支持按 filter.labels（先解析项目标签 ID 并下推 tag CONTAINS 条件）与 filter.state 统计
 *      open、closed、total 三个非负整数；
 *   2. 按页拉取工作项的 statusStageId（阶段 4 已完成、阶段 5 已取消计入 closed，其余阶段计入 open），
 *      严格以 hasNextYunxiaoPage(res.headers) 判断是否继续翻页（忽略单页时恒为 "2" 的 x-next-page）；
 *   3. 任何一页失败时如实整体失败并记录 read.degraded，绝不捏造数字。
 */

import { ERROR_KIND, STATE } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { OpContext } from '../../../contract/contexts.js'
import type { RepositoryRef } from '../../../contract/entities.js'
import type { ListFilter } from '../../../contract/inputs.js'
import type { Counts, CountsResult } from '../../../contract/results.js'
import { PAGINATION } from '../../../contract/pagination.js'
import { fail } from '../../../kernel/preflight.js'
import { GITLAB_SLOW_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { hasNextYunxiaoPage } from '../client.js'
import { failYunxiao } from '../errors.js'
import { deriveYunxiaoStateAndReason } from '../model/normalize.js'
import { requestWorkitemsSearch } from '../requests.js'
import { emitReadDegraded } from '../support/read-log.js'
import {
  DEFAULT_WORKITEM_CATEGORIES,
  errMsg,
  resolveLabelFilterConditions,
  resolveProjectRef,
  type CtxLike,
  type RawBag,
  type RepoLike,
} from './shared.js'

const COUNT_PER_PAGE = PAGINATION.gitlab.maxPerPage
const COUNT_MAX_PAGES = PAGINATION.gitlab.labelListMaxPages

function narrowStateOf(filter: ListFilter | null | undefined): 'open' | 'closed' | '' {
  const s = filter && typeof filter.state === 'string' ? filter.state.trim().toLowerCase() : ''
  return s === 'open' || s === 'closed' ? s : ''
}

/** 统计符合条件的工作项数量（契约操作 counts）：返回 open、closed 与 total 三个非负整数。 */
export async function counts(
  repo: RepositoryRef,
  filter: ListFilter | undefined,
  ctx: OpContext,
): Promise<CountsResult> {
  const t0 = Date.now()
  const effective = ctx as CtxLike
  const proj = resolveProjectRef(repo as RepoLike)
  if (!proj) {
    emitReadDegraded(ctx, 'counts', 'counts:repo-ref', Date.now() - t0, ERROR_KIND.NOTFOUND)
    return fail(ERROR_KIND.NOTFOUND as ErrorKind, 'counts: repo.refId 缺失或格式不是 organizationId/projectId', repo)
  }

  const narrow = narrowStateOf(filter)
  try {
    const lblFilter = await resolveLabelFilterConditions(effective, proj, filter)
    if (!lblFilter.ok) {
      emitReadDegraded(ctx, 'counts', 'counts:transport', Date.now() - t0, lblFilter.error.kind)
      return lblFilter
    }
    if (!lblFilter.matchedAll) {
      return { ok: true, data: { open: 0, closed: 0, total: 0 } }
    }

    let opened = 0
    let closed = 0
    for (let page = 1; page <= COUNT_MAX_PAGES; page++) {
      const res = await requestWorkitemsSearch(
        effective,
        proj.organizationId,
        {
          spaceId: proj.projectId,
          spaceType: 'Project',
          category: DEFAULT_WORKITEM_CATEGORIES,
          ...(lblFilter.conditions ? { conditions: lblFilter.conditions } : {}),
          page,
          perPage: COUNT_PER_PAGE,
          orderBy: 'gmtCreate',
          sort: 'desc',
        },
        GITLAB_SLOW_READ_TIMEOUT_MS,
      )

      if (!res.ok) {
        const failed = failYunxiao(res, res.stderr || res.stdout || 'counts: SearchWorkitems 请求失败', res, ctx)
        emitReadDegraded(ctx, 'counts', 'counts:transport', Date.now() - t0, failed.error.kind)
        return failed
      }

      if (!Array.isArray(res.data)) {
        emitReadDegraded(ctx, 'counts', 'counts:shape', Date.now() - t0, ERROR_KIND.PARSE)
        return fail(ERROR_KIND.PARSE as ErrorKind, 'counts: SearchWorkitems 返回值不是数组', res.stdout)
      }

      const rows = res.data as unknown[]
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          emitReadDegraded(ctx, 'counts', 'counts:stat', Date.now() - t0, ERROR_KIND.PARSE)
          return fail(ERROR_KIND.PARSE as ErrorKind, 'counts: 列表项不是有效对象', res.stdout)
        }
        const { state } = deriveYunxiaoStateAndReason(row as RawBag)
        if (state === STATE.CLOSED) closed += 1
        else opened += 1
      }

      if (!hasNextYunxiaoPage(res.headers)) break
      if (page === COUNT_MAX_PAGES) {
        emitReadDegraded(ctx, 'counts', 'counts:stat', Date.now() - t0, ERROR_KIND.ENV)
        return fail(ERROR_KIND.ENV as ErrorKind, 'counts: 项目工作项数量超出深分页统计上限（10000 条）', res.stdout)
      }
    }

    const all = opened + closed
    const data: Counts =
      narrow === 'closed'
        ? { open: 0, closed, total: closed }
        : narrow === 'open'
          ? { open: opened, closed: 0, total: opened }
          : { open: opened, closed, total: all }
    return { ok: true, data }
  } catch (err: unknown) {
    const failed = failYunxiao(err, errMsg(err), err, ctx)
    emitReadDegraded(ctx, 'counts', 'counts:transport', Date.now() - t0, failed.error.kind)
    return failed
  }
}

export default { counts }
