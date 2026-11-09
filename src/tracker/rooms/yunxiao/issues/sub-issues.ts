/**
 * src/tracker/rooms/yunxiao/issues/sub-issues.ts —— Yunxiao Projex 子工作项列表路由（规格 #04）。
 *
 * 为什么采用「原生 SUB 关系记录 + 翻页工作项列表（原生 parentId 与文件头 DSH-PARENT）」双源合并：
 *   1. 真机实测（Wayfinder #11）证实 SearchWorkitems 不支持在 conditions 中按 parent / parentId 过滤子项，
 *      且无父项的根工作项在各接口中存在 null、""、"EMPTY_VALUE" 三种空值形态；
 *   2. 对于 Req -> Task 等支持原生父子层级的类型，ListWorkitemRelationRecords(relationType="SUB") 可返回
 *      原生子工作项 ID 集合；而对于 Bug 等因企业默认关系矩阵限制降级为 DSH-PARENT + ASSOCIATED 的子票，
 *      其父子归属保存在正文文件头 <!-- DSH-PARENT: <mapKey> --> 中；
 *   3. 因此先核对父容器存在并读取原生 SUB 关系记录，再按页扫描项目工作项（补齐缺失摘要正文、归一三种空父项形态），
 *      合并两路来源并去重，确保探索地图与规格下的全部子票（含降级双写的 Bug 子票）100% 完整返回。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../../contract/entities.js'
import type { SubIssueListResult } from '../../../contract/results.js'
import { PAGINATION } from '../../../contract/pagination.js'
import { fail } from '../../../kernel/preflight.js'
import { GITLAB_READ_TIMEOUT_MS, GITLAB_SLOW_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { hasNextYunxiaoPage, type YunxiaoHttpResult } from '../client.js'
import { asRecord, classifyYunxiaoError, errMsg, failYunxiao } from '../errors.js'
import {
  classifyYunxiaoIssueInput,
  normalizeYunxiaoParentId,
  rememberYunxiaoIssueIdentity,
} from '../model/description-markers.js'
import { normalizeYunxiaoIssue } from '../model/normalize.js'
import { requestWorkitemRelationRecordsList, requestWorkitemsSearch } from '../requests.js'
import { emitReadDegraded } from '../support/read-log.js'
import {
  DEFAULT_WORKITEM_CATEGORIES,
  enrichWorkitemListDetails,
  extractRelationWorkitemId,
  fetchRawWorkitem,
  resolveProjectRef,
  type CtxLike,
  type RawBag,
  type RepoLike,
} from './shared.js'

const MAX_SUB_ISSUES = PAGINATION.gitlab.subIssuesMax
const PAGE_SIZE = PAGINATION.gitlab.subIssuesPageSize
const MAX_SCAN_PAGES = PAGINATION.gitlab.labelListMaxPages

/**
 * 读取指定父容器（探索地图或规格）下的全部子工作项（契约操作 listSubIssues）。
 */
export async function listSubIssues(
  repo: RepoLike,
  mapKey: unknown,
  opts: Record<string, never> | undefined,
  ctx: (Partial<OpContext> & Partial<BackendContext>) | null | undefined,
): Promise<SubIssueListResult> {
  void opts
  const t0 = Date.now()
  const effective = (ctx || {}) as CtxLike
  const proj = resolveProjectRef(repo)
  const rawKey = mapKey === null || mapKey === undefined ? '' : String(mapKey).trim()

  if (!proj || !rawKey || !classifyYunxiaoIssueInput(rawKey)) {
    emitReadDegraded(effective, 'subIssues', 'subIssues:repo-ref', Date.now() - t0, ERROR_KIND.NOTFOUND)
    return fail(
      ERROR_KIND.NOTFOUND as ErrorKind,
      'listSubIssues: repo.refId 或父工作项编号缺失、格式非法',
      rawKey,
    )
  }

  try {
    // 1) 解析父工作项，确认存在并拿到规范纯数字 parentKey 与 26 位 parentWorkitemId
    const parentFetched = await fetchRawWorkitem(effective, proj, rawKey)
    if (!parentFetched.ok) {
      const reason = parentFetched.error.kind === ERROR_KIND.NOTFOUND ? 'subIssues:notfound' : 'subIssues:transport'
      emitReadDegraded(effective, 'subIssues', reason, Date.now() - t0, parentFetched.error.kind)
      return { ok: false, error: parentFetched.error }
    }
    const wantParentKey = parentFetched.key
    const wantParentId = parentFetched.workitemId

    // 2) 查询原生 SUB 关系记录（best-effort：记录所有原生登记的子工作项 ID）
    const nativeSubIds = new Set<string>()
    try {
      const subRelRes = await requestWorkitemRelationRecordsList(
        effective,
        proj.organizationId,
        wantParentId,
        'SUB',
        GITLAB_READ_TIMEOUT_MS,
      )
      if (subRelRes.ok && Array.isArray(subRelRes.data)) {
        for (const rec of subRelRes.data) {
          const tid = extractRelationWorkitemId(rec)
          if (tid && tid.toLowerCase() !== wantParentId.toLowerCase()) {
            nativeSubIds.add(tid.toLowerCase())
          }
        }
      }
    } catch {
      /* best-effort */
    }

    // 3) 翻页扫描项目工作项列表，补齐摘要缺失正文，合并「原生 SUB 命中 / 原生 parentId 命中 / 文件头 DSH-PARENT 命中」
    const items: Issue[] = []
    const seenKeys = new Set<string>()
    const seenWorkitemIds = new Set<string>()
    let dropped = 0
    let capped = false
    let lastRes: YunxiaoHttpResult | null = null

    for (let page = 1; page <= MAX_SCAN_PAGES; page++) {
      let searchRes = await requestWorkitemsSearch(
        effective,
        proj.organizationId,
        {
          spaceId: proj.projectId,
          spaceType: 'Project',
          category: DEFAULT_WORKITEM_CATEGORIES,
          page,
          perPage: PAGE_SIZE,
          orderBy: 'gmtCreate',
          sort: 'asc',
        },
        GITLAB_SLOW_READ_TIMEOUT_MS,
      )
      if (!searchRes.ok) {
        searchRes = await requestWorkitemsSearch(
          effective,
          proj.organizationId,
          {
            spaceId: proj.projectId,
            spaceType: 'Project',
            category: DEFAULT_WORKITEM_CATEGORIES,
            page,
            perPage: PAGE_SIZE,
            orderBy: 'gmtCreate',
            sort: 'asc',
          },
          GITLAB_SLOW_READ_TIMEOUT_MS,
        )
      }
      lastRes = searchRes
      if (!searchRes.ok) {
        const verdict = classifyYunxiaoError(searchRes, effective)
        const notfound = verdict.kind === ERROR_KIND.NOTFOUND
        emitReadDegraded(effective, 'subIssues', notfound ? 'subIssues:notfound' : 'subIssues:page-fail', Date.now() - t0, verdict.kind)
        return failYunxiao(searchRes, searchRes.stderr || searchRes.stdout || 'listSubIssues: 第 ' + page + ' 页查询失败', searchRes, effective)
      }
      if (!Array.isArray(searchRes.data)) {
        emitReadDegraded(effective, 'subIssues', 'subIssues:json', Date.now() - t0, ERROR_KIND.PARSE)
        return fail(ERROR_KIND.PARSE as ErrorKind, 'listSubIssues: 第 ' + page + ' 页返回不是数组', searchRes.stdout)
      }

      const rawPage = searchRes.data as unknown[]
      if (rawPage.length === 0) break

      const validRows: RawBag[] = []
      for (const row of rawPage) {
        const bag = asRecord(row)
        const hasIdentity =
          bag &&
          ((typeof bag['id'] === 'string' && bag['id'].trim() !== '') ||
            (typeof bag['serialNumber'] === 'string' && bag['serialNumber'].trim() !== '') ||
            (typeof bag['key'] === 'string' && bag['key'].trim() !== ''))
        if (!bag || !hasIdentity) {
          dropped += 1
          continue
        }
        validRows.push(bag)
      }

      const enrichedRows = await enrichWorkitemListDetails(effective, proj, validRows)
      for (const raw of enrichedRows) {
        if (items.length >= MAX_SUB_ISSUES) {
          capped = true
          break
        }
        try {
          const rawId = typeof raw['id'] === 'string' ? raw['id'].trim() : ''
          if (rawId) seenWorkitemIds.add(rawId.toLowerCase())
          const normParentId = normalizeYunxiaoParentId(raw['parentId'])
          const matchedByNativeSub = Boolean(rawId && nativeSubIds.has(rawId.toLowerCase()))
          const matchedByNativeParentId = Boolean(normParentId && normParentId.toLowerCase() === wantParentId.toLowerCase())

          // 若原生 SUB 关系记录中指认该项为子项，但列表项的 parentId 尚未填充，则注入 parentId 以便归一化
          const rowForNormalize: RawBag =
            (matchedByNativeSub || matchedByNativeParentId) && !normParentId
              ? { ...raw, parentId: wantParentId }
              : raw

          const issue = normalizeYunxiaoIssue(rowForNormalize, repo || undefined)
          if (issue.key === wantParentKey) continue

          if (matchedByNativeSub || matchedByNativeParentId || issue.parentKey === wantParentKey) {
            if (issue.parentKey !== wantParentKey) issue.parentKey = wantParentKey
            if (!seenKeys.has(issue.key)) {
              seenKeys.add(issue.key)
              items.push(issue)
            }
          }
        } catch {
          dropped += 1
        }
      }

      if (capped) break
      if (!hasNextYunxiaoPage(searchRes.headers) && rawPage.length < PAGE_SIZE) break
    }

    // 4) 若原生 SUB 关系记录中有未出现在当前搜索列表中的子工作项，按 ID 逐张拉取补齐
    for (const subIdLower of nativeSubIds) {
      if (items.length >= MAX_SUB_ISSUES) {
        capped = true
        break
      }
      if (seenWorkitemIds.has(subIdLower)) continue
      const subFetched = await fetchRawWorkitem(effective, proj, subIdLower)
      if (!subFetched.ok) continue
      rememberYunxiaoIssueIdentity(proj.refId, { id: subFetched.workitemId, key: subFetched.key })
      const issue = normalizeYunxiaoIssue({ ...subFetched.raw, parentId: wantParentId }, repo || undefined)
      if (issue.key !== wantParentKey && !seenKeys.has(issue.key)) {
        issue.parentKey = wantParentKey
        seenKeys.add(issue.key)
        items.push(issue)
      }
    }

    if (dropped > 0 && items.length === 0) {
      emitReadDegraded(effective, 'subIssues', 'subIssues:shape', Date.now() - t0, ERROR_KIND.PARSE)
      return fail(
        ERROR_KIND.PARSE as ErrorKind,
        'listSubIssues: 父工作项 #' + wantParentKey + ' 的候选行全部因格式异常被丢弃（' + dropped + ' 行）',
        lastRes ? lastRes.stdout : '',
      )
    }

    const fetched = items.length
    if (capped) emitReadDegraded(effective, 'subIssues', 'subIssues:truncated', Date.now() - t0)
    return {
      ok: true,
      data: {
        items,
        total: fetched,
        fetched,
        capped,
        missing: 0,
        dropped,
      },
    }
  } catch (err: unknown) {
    const failed = failYunxiao(err, errMsg(err), err, effective)
    emitReadDegraded(effective, 'subIssues', 'subIssues:transport', Date.now() - t0, failed.error.kind)
    return failed
  }
}

export default { listSubIssues }
