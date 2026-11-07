/**
 * src/tracker/rooms/yunxiao/issues/read.ts —— Yunxiao Projex 工作项列表与单票详情读取路由（规格 #03）。
 *
 * 核心行为：
 *   1. getIssue 兼容纯数字（"1"）、带前缀编号（"DCIAFS-1"）与 26 位内部 ID 三种入参，
 *      对外统一暴露剥离前缀后的纯数字 Issue.key，并按 opts.comments.first 富化 Markdown 评论列表。
 *   2. listIssues 搜索 category="Req,Task,Bug" 的工作项，当搜索摘要缺失完整 description 时自动
 *      并发调用 GetWorkitem 补齐详情，确保文件头标记（DSH-ISSUE-KIND / DSH-ASSIGNEES / DSH-PARENT / DSH-BLOCKED-BY）
 *      被完整读回；并在内存支持按 state、type、labels、parentKey、keys、since 二次过滤。
 *   3. 分页与截断严格依据 hasNextYunxiaoPage(res.headers)（即 xPage < xTotalPages），
 *      忽略单页响应中恒返回 "2" 的 x-next-page。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../../contract/entities.js'
import type { GetOpts, ListFilter } from '../../../contract/inputs.js'
import { LIST_TRUNCATED_REASON, TRACKER_ERROR_STAGE, type IssueDetailResult, type IssueListResult } from '../../../contract/results.js'
import { PAGINATION } from '../../../contract/pagination.js'
import { fail } from '../../../kernel/preflight.js'
import { GITLAB_SLOW_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { hasNextYunxiaoPage } from '../client.js'
import { failYunxiao } from '../errors.js'
import { classifyYunxiaoIssueInput, resolveYunxiaoIssueKey } from '../model/description-markers.js'
import { normalizeYunxiaoIssue } from '../model/normalize.js'
import { requestWorkitemsSearch } from '../requests.js'
import { emitReadDegraded } from '../support/read-log.js'
import {
  buildSearchConditions,
  DEFAULT_WORKITEM_CATEGORIES,
  enrichWorkitemComments,
  enrichWorkitemListDetails,
  errMsg,
  fetchRawWorkitem,
  resolveProjectLabelIdsByNames,
  resolveProjectRef,
  type CtxLike,
  type RawBag,
  type RepoLike,
} from './shared.js'

const COMMENTS_MAX = 200
const LIST_PER_PAGE = PAGINATION.gitlab.maxPerPage

function commentsWantOf(opts: GetOpts | null | undefined): number | null {
  const c = opts && opts.comments
  if (!c || typeof c.first !== 'number' || !Number.isFinite(c.first)) return null
  return Math.max(0, Math.min(COMMENTS_MAX, Math.floor(c.first)))
}

function filterMatchesIssue(issue: Issue, filter: ListFilter | null | undefined, refId: string): boolean {
  if (!filter) return true
  if (filter.state === 'open' || filter.state === 'closed') {
    if (issue.state !== filter.state) return false
  }
  if (filter.type && issue.type !== filter.type) return false
  if (filter.parentKey !== undefined) {
    if (filter.parentKey === null) {
      if (issue.parentKey !== null) return false
    } else {
      const wantParent = resolveYunxiaoIssueKey(refId, filter.parentKey) || String(filter.parentKey).trim()
      if (issue.parentKey !== wantParent) return false
    }
  }
  if (Array.isArray(filter.labels) && filter.labels.length > 0) {
    const issueLabelSet = new Set((issue.labels || []).map((l) => l.name.trim().toLowerCase()))
    for (const wantLabel of filter.labels) {
      const wl = String(wantLabel || '').trim().toLowerCase()
      if (wl && !issueLabelSet.has(wl)) return false
    }
  }
  if (Array.isArray(filter.keys) && filter.keys.length > 0) {
    const keySet = new Set(
      filter.keys.map((k) => resolveYunxiaoIssueKey(refId, k) || String(k || '').trim()).filter(Boolean),
    )
    if (!keySet.has(issue.key)) return false
  }
  if (typeof filter.since === 'string' && filter.since.trim()) {
    const sinceMs = Date.parse(filter.since.trim())
    const updatedMs = issue.updatedAt ? Date.parse(issue.updatedAt) : NaN
    if (Number.isFinite(sinceMs) && Number.isFinite(updatedMs) && updatedMs < sinceMs) return false
  }
  return true
}

/**
 * 列出工作项（契约操作 list）：支持按标签下推服务端查询，缺失正文摘要时自动并发补齐详情。
 */
export async function listIssues(
  ctx: BackendContext,
  repo: RepositoryRef,
  filter: ListFilter | undefined,
  opCtx: OpContext,
): Promise<IssueListResult> {
  const t0 = Date.now()
  const effective = (opCtx || ctx) as CtxLike
  const proj = resolveProjectRef(repo as RepoLike)
  if (!proj) {
    emitReadDegraded(effective, 'list', 'list:repo-ref', Date.now() - t0, ERROR_KIND.NOTFOUND)
    return fail(ERROR_KIND.NOTFOUND as ErrorKind, 'list: repo.refId 缺失或格式不是 organizationId/projectId', '')
  }

  try {
    let conditions: string | undefined
    if (filter && Array.isArray(filter.labels) && filter.labels.length > 0) {
      const lblResolved = await resolveProjectLabelIdsByNames(effective, proj, filter.labels)
      if (!lblResolved.ok) {
        emitReadDegraded(effective, 'list', 'list:transport', Date.now() - t0, lblResolved.error.kind)
        return lblResolved
      }
      if (!lblResolved.matchedAll) return { ok: true, data: [] }
      if (lblResolved.labelIds.length > 0) {
        conditions = buildSearchConditions({ labelIds: lblResolved.labelIds })
      }
    }

    const res = await requestWorkitemsSearch(
      effective,
      proj.organizationId,
      {
        spaceId: proj.projectId,
        spaceType: 'Project',
        category: DEFAULT_WORKITEM_CATEGORIES,
        ...(conditions ? { conditions } : {}),
        page: 1,
        perPage: LIST_PER_PAGE,
        orderBy: 'gmtCreate',
        sort: 'desc',
      },
      GITLAB_SLOW_READ_TIMEOUT_MS,
    )

    if (!res.ok) {
      const failed = failYunxiao(res, res.stderr || res.stdout || 'list: SearchWorkitems 请求失败', res, effective)
      emitReadDegraded(effective, 'list', 'list:transport', Date.now() - t0, failed.error.kind)
      return failed
    }

    if (!Array.isArray(res.data)) {
      emitReadDegraded(effective, 'list', 'list:shape', Date.now() - t0, ERROR_KIND.PARSE)
      return fail(ERROR_KIND.PARSE as ErrorKind, 'list: SearchWorkitems 返回值不是数组', res.stdout)
    }

    const rawRows = (res.data as unknown[]).filter(
      (r): r is RawBag => Boolean(r) && typeof r === 'object' && !Array.isArray(r),
    )
    const enrichedRows = await enrichWorkitemListDetails(effective, proj, rawRows)
    const allIssues = enrichedRows.map((raw) => normalizeYunxiaoIssue(raw, repo))
    const filtered = allIssues.filter((iss) => filterMatchesIssue(iss, filter, proj.refId))

    const hasMore = hasNextYunxiaoPage(res.headers) || rawRows.length >= LIST_PER_PAGE
    const out: IssueListResult = { ok: true, data: filtered }
    if (hasMore) {
      emitReadDegraded(effective, 'list', LIST_TRUNCATED_REASON, Date.now() - t0)
      out.truncated = true
    }
    return out
  } catch (err: unknown) {
    const failed = failYunxiao(err, errMsg(err), err, effective)
    emitReadDegraded(effective, 'list', 'list:transport', Date.now() - t0, failed.error.kind)
    return failed
  }
}

/**
 * 读取单张工作项详情（契约操作 get）：支持三种票号入参并富化评论。
 */
export async function getIssue(
  ctx: BackendContext,
  repo: RepositoryRef,
  key: string,
  opts: GetOpts | undefined,
  opCtx: OpContext,
): Promise<IssueDetailResult> {
  const t0 = Date.now()
  const effective = (opCtx || ctx) as CtxLike
  const proj = resolveProjectRef(repo as RepoLike)
  if (!proj) {
    emitReadDegraded(effective, 'get', 'get:repo-ref', Date.now() - t0, ERROR_KIND.NOTFOUND)
    return fail(ERROR_KIND.NOTFOUND as ErrorKind, 'get: repo.refId 缺失或格式不是 organizationId/projectId', '')
  }
  const k = String(key == null ? '' : key).trim()
  if (!k || !classifyYunxiaoIssueInput(k)) {
    return fail(ERROR_KIND.PARSE as ErrorKind, 'get: 工作项编号不能为空或格式非法', k, TRACKER_ERROR_STAGE.INPUT_REFUSED)
  }

  try {
    const fetched = await fetchRawWorkitem(effective, proj, k)
    if (!fetched.ok) {
      emitReadDegraded(effective, 'get', 'get:transport', Date.now() - t0, fetched.error.kind)
      return { ok: false, error: fetched.error }
    }

    const wantComments = commentsWantOf(opts)
    await enrichWorkitemComments(effective, proj, fetched.raw, fetched.workitemId, wantComments)
    const issue = normalizeYunxiaoIssue(fetched.raw, repo)
    return { ok: true, data: issue }
  } catch (err: unknown) {
    const failed = failYunxiao(err, errMsg(err), err, effective)
    emitReadDegraded(effective, 'get', 'get:transport', Date.now() - t0, failed.error.kind)
    return failed
  }
}

export default { listIssues, getIssue }
