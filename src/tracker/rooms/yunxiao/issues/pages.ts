/**
 * src/tracker/rooms/yunxiao/issues/pages.ts —— Yunxiao Projex 工作项分页读取路由（规格 #03）。
 *
 * 核心行为：
 *   1. 游标 cursor 编码为十进制正整数页码字符串（"1"、"2"...）；非法游标记录 listPage:cursor 并返回 NOTFOUND。
 *   2. 严格使用 hasNextYunxiaoPage(res.headers)（即 xPage < xTotalPages）判断是否存在下一页，
 *      绝不被云效单页响应中恒为 "2" 的 x-next-page 误导。
 *   3. 当未指定 state 收窄且响应头 xTotal 可用时直接采用 xTotal，否则调用同房间 counts 计算精确总数。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { OpContext } from '../../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../../contract/entities.js'
import type { ListFilter, PageOpts } from '../../../contract/inputs.js'
import type { PageResult, ReadPageResult } from '../../../contract/results.js'
import { PAGINATION } from '../../../contract/pagination.js'
import { fail } from '../../../kernel/preflight.js'
import { GITLAB_SLOW_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { hasNextYunxiaoPage } from '../client.js'
import { failYunxiao } from '../errors.js'
import { enrichYunxiaoIssuesGraph } from '../graph/read.js'
import { normalizeYunxiaoIssue } from '../model/normalize.js'
import { requestWorkitemsSearch } from '../requests.js'
import { emitReadDegraded } from '../support/read-log.js'
import { counts } from './counts.js'
import {
  DEFAULT_WORKITEM_CATEGORIES,
  enrichWorkitemListDetails,
  errMsg,
  resolveLabelFilterConditions,
  resolveProjectRef,
  type CtxLike,
  type RawBag,
  type RepoLike,
} from './shared.js'

const DEFAULT_LIMIT = PAGINATION.gitlab.limitDefault
const MAX_LIMIT = PAGINATION.gitlab.limitMax
const MAX_PER_PAGE = PAGINATION.gitlab.maxPerPage

function limitOf(opts: PageOpts | null | undefined): number {
  const raw = opts?.limit
  if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.floor(raw) !== raw || raw <= 0) {
    return DEFAULT_LIMIT
  }
  return Math.min(raw, MAX_LIMIT, MAX_PER_PAGE)
}

function parsePageCursor(cursor: unknown): number | null {
  if (cursor === undefined || cursor === null) return 1
  if (typeof cursor !== 'string') return null
  const trimmed = cursor.trim()
  if (!trimmed) return 1
  if (!/^[0-9]+$/.test(trimmed)) return null
  const page = Number(trimmed)
  return Number.isSafeInteger(page) && page >= 1 ? page : null
}

/** 按页读取工作项列表（契约操作 listPage）：按创建时间倒序返回单页结果、下一页游标与同口径总数。 */
export async function listPage(
  repo: RepositoryRef,
  filter: ListFilter | undefined,
  opts: PageOpts | undefined,
  ctx: OpContext,
): Promise<ReadPageResult> {
  const t0 = Date.now()
  const effective = ctx as CtxLike
  const proj = resolveProjectRef(repo as RepoLike)
  if (!proj) {
    emitReadDegraded(ctx, 'listPage', 'listPage:repo-ref', Date.now() - t0, ERROR_KIND.NOTFOUND)
    return fail(ERROR_KIND.NOTFOUND as ErrorKind, 'listPage: repo.refId 缺失或格式不是 organizationId/projectId', repo)
  }

  const perPage = limitOf(opts)
  const page = parsePageCursor(opts?.cursor)
  if (page === null) {
    emitReadDegraded(ctx, 'listPage', 'listPage:cursor', Date.now() - t0, ERROR_KIND.NOTFOUND)
    return fail(
      ERROR_KIND.NOTFOUND as ErrorKind,
      'listPage: 游标已失效，请重新加载（' + String(opts?.cursor || '').slice(0, 200) + '）',
      opts?.cursor ?? '',
    )
  }

  try {
    const lblFilter = await resolveLabelFilterConditions(effective, proj, filter)
    if (!lblFilter.ok) {
      emitReadDegraded(ctx, 'listPage', 'listPage:transport', Date.now() - t0, lblFilter.error.kind)
      return lblFilter
    }
    if (!lblFilter.matchedAll) {
      return { ok: true, data: { items: [], nextCursor: null, total: 0 } }
    }

    const res = await requestWorkitemsSearch(
      effective,
      proj.organizationId,
      {
        spaceId: proj.projectId,
        spaceType: 'Project',
        category: DEFAULT_WORKITEM_CATEGORIES,
        ...(lblFilter.conditions ? { conditions: lblFilter.conditions } : {}),
        page,
        perPage,
        orderBy: 'gmtCreate',
        sort: 'desc',
      },
      GITLAB_SLOW_READ_TIMEOUT_MS,
    )

    if (!res.ok) {
      const failed = failYunxiao(res, res.stderr || res.stdout || 'listPage: SearchWorkitems 请求失败', res, ctx)
      emitReadDegraded(ctx, 'listPage', 'listPage:transport', Date.now() - t0, failed.error.kind)
      return failed
    }

    if (!Array.isArray(res.data)) {
      emitReadDegraded(ctx, 'listPage', 'listPage:shape', Date.now() - t0, ERROR_KIND.PARSE)
      return fail(ERROR_KIND.PARSE as ErrorKind, 'listPage: SearchWorkitems 返回值不是数组', res.stdout)
    }

    const rawRows: RawBag[] = []
    for (const row of res.data as unknown[]) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        emitReadDegraded(ctx, 'listPage', 'listPage:shape', Date.now() - t0, ERROR_KIND.PARSE)
        return fail(ERROR_KIND.PARSE as ErrorKind, 'listPage: 列表项不是有效对象', row)
      }
      rawRows.push(row as RawBag)
    }

    const enriched = await enrichWorkitemListDetails(effective, proj, rawRows)
    let items: Issue[] = enriched.map((r) => normalizeYunxiaoIssue(r, repo))
    await enrichYunxiaoIssuesGraph(effective, proj, enriched, items)
    const wantState = filter && (filter.state === 'open' || filter.state === 'closed') ? filter.state : ''
    if (wantState) {
      items = items.filter((iss) => iss.state === wantState)
    }

    const nextCursor = hasNextYunxiaoPage(res.headers) ? String(page + 1) : null
    let total: number
    if (!wantState && typeof res.headers.xTotal === 'number' && res.headers.xTotal >= 0) {
      total = res.headers.xTotal
    } else {
      const counted = await counts(repo, filter, ctx)
      if (!counted.ok) {
        emitReadDegraded(ctx, 'listPage', 'listPage:total', Date.now() - t0, counted.error.kind)
        return counted
      }
      total = counted.data.total
    }

    const out: PageResult = { items, nextCursor, total }
    return { ok: true, data: out }
  } catch (err: unknown) {
    const failed = failYunxiao(err, errMsg(err), err, ctx)
    emitReadDegraded(ctx, 'listPage', 'listPage:transport', Date.now() - t0, failed.error.kind)
    return failed
  }
}

export default { listPage }
