/**
 * src/tracker/rooms/yunxiao/issues/maps.ts —— Yunxiao Projex 探索地图薄行列表路由（规格 #03）。
 *
 * 核心行为：
 *   1. 先通过项目标签列表定位 wayfinder:map 标签 ID；若该标签在项目中尚不存在，直接返回空列表（零额外搜索）；
 *   2. 按页拉取带 wayfinder:map 标签的候选工作项，内存复核后按更新时间倒序产出 MapRow（{ key, title, state, url }）；
 *   3. 严格依据 hasNextYunxiaoPage(res.headers) 翻页（最多 PAGINATION.gitlab.mapListMaxPages 页）。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { OpContext } from '../../../contract/contexts.js'
import type { RepositoryRef } from '../../../contract/entities.js'
import type { MapListOpResult, MapListResult, MapRow } from '../../../contract/results.js'
import { PAGINATION } from '../../../contract/pagination.js'
import { fail } from '../../../kernel/preflight.js'
import { GITLAB_SLOW_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { hasNextYunxiaoPage } from '../client.js'
import { failYunxiao } from '../errors.js'
import { normalizeYunxiaoIssue } from '../model/normalize.js'
import { requestWorkitemsSearch } from '../requests.js'
import {
  buildSearchConditions,
  DEFAULT_WORKITEM_CATEGORIES,
  errMsg,
  resolveProjectLabelIdsByNames,
  resolveProjectRef,
  type CtxLike,
  type RawBag,
  type RepoLike,
} from './shared.js'

const MAP_LABEL = 'wayfinder:map'
const PAGE_SIZE = PAGINATION.gitlab.maxPerPage
const MAX_MAP_PAGES = PAGINATION.gitlab.mapListMaxPages

function hasMapLabel(labels: unknown): boolean {
  if (!Array.isArray(labels)) return false
  return labels.some((l) => {
    const name = l !== null && typeof l === 'object' ? (l as { name?: unknown }).name : l
    return String(name || '').trim().toLowerCase() === MAP_LABEL
  })
}

/** 列出项目中的全部探索地图薄行（契约操作 listMaps）：按更新时间倒序返回 MapRow 列表。 */
export async function listMaps(
  repo: RepositoryRef,
  ctx: OpContext,
): Promise<MapListOpResult> {
  const effective = ctx as CtxLike
  const proj = resolveProjectRef(repo as RepoLike)
  if (!proj) {
    return fail(ERROR_KIND.NOTFOUND as ErrorKind, 'listMaps: repo.refId 缺失或格式不是 organizationId/projectId', '')
  }

  const kept: { row: MapRow; updatedAt: string; seq: number }[] = []
  let seq = 0
  let truncated = false

  try {
    const lblResolved = await resolveProjectLabelIdsByNames(effective, proj, [MAP_LABEL])
    if (!lblResolved.ok) return lblResolved
    if (!lblResolved.matchedAll || lblResolved.labelIds.length === 0) {
      return { ok: true, data: { rows: [], total: 0, truncated: false } }
    }
    const conditions = buildSearchConditions({ labelIds: lblResolved.labelIds })

    for (let page = 1; page <= MAX_MAP_PAGES; page++) {
      const res = await requestWorkitemsSearch(
        effective,
        proj.organizationId,
        {
          spaceId: proj.projectId,
          spaceType: 'Project',
          category: DEFAULT_WORKITEM_CATEGORIES,
          ...(conditions ? { conditions } : {}),
          page,
          perPage: PAGE_SIZE,
          orderBy: 'gmtCreate',
          sort: 'desc',
        },
        GITLAB_SLOW_READ_TIMEOUT_MS,
      )

      if (!res.ok) {
        return failYunxiao(res, res.stderr || res.stdout || 'listMaps: SearchWorkitems 请求失败', res, ctx)
      }
      if (!Array.isArray(res.data)) {
        return fail(ERROR_KIND.PARSE as ErrorKind, 'listMaps: SearchWorkitems 返回值不是数组', res.stdout)
      }

      for (const raw of res.data as unknown[]) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const issue = normalizeYunxiaoIssue(raw as RawBag, repo)
        if (issue.type !== 'map' && !hasMapLabel(issue.labels)) continue
        kept.push({
          row: { key: String(issue.key), title: issue.title, state: issue.state, url: issue.url },
          updatedAt: typeof issue.updatedAt === 'string' ? issue.updatedAt : '',
          seq: seq++,
        })
      }

      if (!hasNextYunxiaoPage(res.headers)) break
      if (page === MAX_MAP_PAGES) truncated = true
    }
  } catch (err: unknown) {
    return failYunxiao(err, errMsg(err), err, ctx)
  }

  kept.sort((a, b) => {
    if (a.updatedAt === b.updatedAt) return a.seq - b.seq
    if (!a.updatedAt) return 1
    if (!b.updatedAt) return -1
    return a.updatedAt < b.updatedAt ? 1 : -1
  })

  const rows = kept.map((k) => k.row)
  const out: MapListResult = { rows, total: rows.length, truncated }
  return { ok: true, data: out }
}

export default { listMaps }
