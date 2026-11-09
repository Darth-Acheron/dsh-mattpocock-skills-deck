/**
 * src/tracker/rooms/yunxiao/graph/read.ts —— Yunxiao Projex 阻塞依赖关系读取与工作项存在性核验路由（规格 #04）。
 *
 * 为什么采用「原生 DEPEND_ON 关系记录 + 正文文件头 DSH-BLOCKED-BY（及可见 Blocked by: 行）」双源合并：
 *   1. 真机实测（Wayfinder #11）证实云效企业默认关系矩阵仅在 Topic -> Req 间开启 DEPEND_ON，
 *      而 Req / Task / Bug 之间的 DEPEND_ON 默认未启用；当企业开启了 DEPEND_ON 时，阻塞关系保存在
 *      ListWorkitemRelationRecords(relationType="DEPEND_ON") 中；当采用默认配置时，阻塞关系由
 *      setBlockedBy 自动回退写入成对正文标记（Blocked by: #n + <!-- DSH-BLOCKED-BY: n -->）并挂 ASSOCIATED 关联；
 *   2. ListWorkitemRelationRecords 仅返回目标工作项的 26 位 resourceId，不含目标标题与开闭状态；
 *   3. 因此读侧（getDependencies）合并原生 DEPEND_ON 记录与正文隐藏/可见阻塞标记，逐张补齐阻塞方标题与
 *      open/closed 状态（未知时按保守方向记为 open 以防 frontier 误放行），并通过原生 DEPENDED_BY 记录与
 *      项目工作项扫描推导反向 blocking 边。
 */

import { ERROR_KIND, ISSUE_TYPE, STATE } from '../../../contract/vocabulary.js'
import type { ErrorKind, IssueType, State } from '../../../contract/identity.js'
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { IssueRef, RepositoryRef } from '../../../contract/entities.js'
import type { DepsOpts } from '../../../contract/inputs.js'
import { TRACKER_ERROR_STAGE, type DependenciesResult, type TrackerError } from '../../../contract/results.js'
import { PAGINATION } from '../../../contract/pagination.js'
import { fail } from '../../../kernel/preflight.js'
import { GITLAB_READ_TIMEOUT_MS, GITLAB_SLOW_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { errMsg, failYunxiao } from '../errors.js'
import {
  classifyYunxiaoIssueInput,
  parseBlockedByFallback,
  rememberYunxiaoIssueIdentity,
  resolveYunxiaoIssueKey,
} from '../model/description-markers.js'
import {
  bodyOfWorkitem,
  deriveYunxiaoIssueType,
  deriveYunxiaoStateAndReason,
  normalizeYunxiaoIssue,
} from '../model/normalize.js'
import { requestWorkitemRelationRecordsList, requestWorkitemsSearch } from '../requests.js'
import {
  DEFAULT_WORKITEM_CATEGORIES,
  enrichWorkitemListDetails,
  extractRelationWorkitemId,
  fetchRawWorkitem,
  resolveProjectRef,
  type CtxLike,
  type RawBag,
  type RepoLike,
  type ResolvedProjectRef,
} from '../issues/shared.js'

const SCAN_PAGE_SIZE = PAGINATION.gitlab.maxPerPage

export { extractRelationWorkitemId }
export type { CtxLike, RawBag, RepoLike, ResolvedProjectRef }

/** 原生阻塞关系记录探测结果。 */
export interface YunxiaoNativeDependProbe {
  /** 原生关系记录中的目标工作项 26 位 ID 列表。 */
  targetIds: string[]
  /** 探测请求是否失败。 */
  probeFailed: boolean
}

/**
 * 核验指定工作项是否存在（供阻塞边写入与图谱校验复用）：
 *   - 存在时返回 `{ ok: true, exists: true, key, workitemId, raw }`；
 *   - 远端明确返回 not-found 时返回 `{ ok: true, exists: false }`；
 *   - 其它传输或鉴权错误如实返回 `{ ok: false, error }`。
 */
export async function checkIssueExists(
  opCtx: CtxLike | null | undefined,
  repo: RepoLike,
  rawKey: unknown,
): Promise<
  | { ok: true; exists: true; key: string; workitemId: string; raw: RawBag }
  | { ok: true; exists: false }
  | { ok: false; error: TrackerError }
> {
  const proj = resolveProjectRef(repo)
  if (!proj) {
    return fail(ERROR_KIND.NOTFOUND as ErrorKind, 'checkIssueExists: repo.refId 缺失或格式不是 organizationId/projectId', '')
  }
  const k = String(rawKey == null ? '' : rawKey).trim()
  if (!k || !classifyYunxiaoIssueInput(k)) {
    return { ok: true, exists: false }
  }
  const fetched = await fetchRawWorkitem(opCtx, proj, k)
  if (fetched.ok) {
    return { ok: true, exists: true, key: fetched.key, workitemId: fetched.workitemId, raw: fetched.raw }
  }
  if (fetched.error.kind === ERROR_KIND.NOTFOUND) {
    return { ok: true, exists: false }
  }
  return { ok: false, error: fetched.error }
}

/** 查询工作项上的原生 DEPEND_ON（或 DEPENDED_BY）关联关系记录。 */
export async function probeNativeRelationTargets(
  opCtx: CtxLike | null | undefined,
  proj: ResolvedProjectRef,
  workitemId: string,
  relationType: 'DEPEND_ON' | 'DEPENDED_BY' | 'ASSOCIATED',
): Promise<YunxiaoNativeDependProbe> {
  try {
    const res = await requestWorkitemRelationRecordsList(
      opCtx,
      proj.organizationId,
      workitemId,
      relationType,
      GITLAB_READ_TIMEOUT_MS,
    )
    if (!res.ok || !Array.isArray(res.data)) {
      return { targetIds: [], probeFailed: true }
    }
    const targetIds: string[] = []
    for (const item of res.data) {
      const tid = extractRelationWorkitemId(item)
      if (tid && !targetIds.includes(tid)) targetIds.push(tid)
    }
    return { targetIds, probeFailed: false }
  } catch {
    return { targetIds: [], probeFailed: true }
  }
}

/**
 * 将一组目标工作项标识（纯数字 key 或 26 位 ID）逐张解析并补齐标题与开闭状态。
 * 若某张目标票无法读取，按保守方向（state: 'open'）返回，防止 Wayfinder frontier 误放行。
 */
export async function resolveIssueRefsWithState(
  opCtx: CtxLike | null | undefined,
  proj: ResolvedProjectRef,
  rawTargets: readonly string[],
  knownByKeyOrId?: Map<string, RawBag>,
): Promise<IssueRef[]> {
  const out: IssueRef[] = []
  const seenKeys = new Set<string>()

  for (const rawTarget of rawTargets) {
    const t = String(rawTarget || '').trim()
    if (!t) continue

    const cachedRaw = knownByKeyOrId?.get(t) || knownByKeyOrId?.get(t.toLowerCase())
    if (cachedRaw) {
      const k = rememberYunxiaoIssueIdentity(proj.refId, {
        id: cachedRaw['id'],
        serialNumber: cachedRaw['serialNumber'],
        key: cachedRaw['key'] ?? t,
      })
      if (k && !seenKeys.has(k)) {
        seenKeys.add(k)
        const title =
          typeof cachedRaw['subject'] === 'string' && cachedRaw['subject'].trim()
            ? cachedRaw['subject'].trim()
            : typeof cachedRaw['title'] === 'string' && cachedRaw['title'].trim()
              ? cachedRaw['title'].trim()
              : '#' + k
        out.push({
          key: k,
          title,
          state: deriveYunxiaoStateAndReason(cachedRaw).state,
          type: deriveYunxiaoIssueType(cachedRaw),
        })
      }
      continue
    }

    const fetched = await fetchRawWorkitem(opCtx, proj, t)
    if (fetched.ok) {
      if (seenKeys.has(fetched.key)) continue
      seenKeys.add(fetched.key)
      const title =
        typeof fetched.raw['subject'] === 'string' && fetched.raw['subject'].trim()
          ? fetched.raw['subject'].trim()
          : typeof fetched.raw['title'] === 'string' && fetched.raw['title'].trim()
            ? fetched.raw['title'].trim()
            : '#' + fetched.key
      out.push({
        key: fetched.key,
        title,
        state: deriveYunxiaoStateAndReason(fetched.raw).state,
        type: deriveYunxiaoIssueType(fetched.raw),
      })
    } else {
      const fallbackKey = resolveYunxiaoIssueKey(proj.refId, t) || t
      if (seenKeys.has(fallbackKey)) continue
      seenKeys.add(fallbackKey)
      out.push({
        key: fallbackKey,
        title: '#' + fallbackKey,
        state: STATE.OPEN as State,
        type: ISSUE_TYPE.ISSUE as IssueType,
      })
    }
  }
  return out
}

/**
 * 拉取项目内工作项快照并构建已知票面字典（key/id -> RawBag）与阻塞邻接表（key -> blockerKeys[]）。
 * 同时用于 getDependencies 反向推导 blocking 边与 setBlockedBy 写前图环检测。
 */
export async function scanProjectBlockingSnapshot(
  opCtx: CtxLike | null | undefined,
  proj: ResolvedProjectRef,
  repo?: RepoLike,
): Promise<{ knownRaw: Map<string, RawBag>; blockedByMap: Map<string, string[]>; complete: boolean }> {
  const knownRaw = new Map<string, RawBag>()
  const blockedByMap = new Map<string, string[]>()
  let complete = true

  try {
    const res = await requestWorkitemsSearch(
      opCtx,
      proj.organizationId,
      {
        spaceId: proj.projectId,
        spaceType: 'Project',
        category: DEFAULT_WORKITEM_CATEGORIES,
        page: 1,
        perPage: SCAN_PAGE_SIZE,
        orderBy: 'gmtCreate',
        sort: 'desc',
      },
      GITLAB_SLOW_READ_TIMEOUT_MS,
    )
    if (!res.ok || !Array.isArray(res.data)) {
      return { knownRaw, blockedByMap, complete: false }
    }
    const rawRows = (res.data as unknown[]).filter(
      (r): r is RawBag => Boolean(r) && typeof r === 'object' && !Array.isArray(r),
    )
    if (rawRows.length >= SCAN_PAGE_SIZE) complete = false
    const enriched = await enrichWorkitemListDetails(opCtx, proj, rawRows)
    for (const r of enriched) {
      const issue = normalizeYunxiaoIssue(r, repo || undefined)
      if (!issue.key) continue
      knownRaw.set(issue.key, r)
      const wid = typeof r['id'] === 'string' ? r['id'].trim() : ''
      if (wid) knownRaw.set(wid.toLowerCase(), r)
      const blockers = (issue.blockedBy || []).map((b) => b.key).filter(Boolean)
      blockedByMap.set(issue.key, blockers)
    }
  } catch {
    complete = false
  }
  return { knownRaw, blockedByMap, complete }
}

/**
 * 读取工作项的阻塞依赖关系（契约操作 getDependencies）：
 *   1. 合并原生 DEPEND_ON 关系记录与正文文件头 DSH-BLOCKED-BY（及可见 Blocked by: 行）；
 *   2. 补齐所有阻塞方（blockedBy）的纯数字票号、标题与开闭状态；
 *   3. 合并原生 DEPENDED_BY 关系记录与项目工作项快照反向扫描结果，推导反向 blocking 边。
 */
export async function getDependencies(
  ctx: BackendContext,
  repo: RepositoryRef,
  key: string,
  opts: DepsOpts | undefined,
  opCtx: OpContext,
): Promise<DependenciesResult> {
  void opts
  const effective = (opCtx || ctx) as CtxLike
  const proj = resolveProjectRef(repo as RepoLike)
  if (!proj) {
    return fail(ERROR_KIND.NOTFOUND as ErrorKind, 'getDependencies: repo.refId 缺失或格式不是 organizationId/projectId', '')
  }
  const k = String(key == null ? '' : key).trim()
  if (!k || !classifyYunxiaoIssueInput(k)) {
    return fail(
      ERROR_KIND.PARSE as ErrorKind,
      'getDependencies: 工作项编号不能为空或格式非法',
      k,
      TRACKER_ERROR_STAGE.INPUT_REFUSED,
    )
  }

  try {
    const selfFetched = await fetchRawWorkitem(effective, proj, k)
    if (!selfFetched.ok) return { ok: false, error: selfFetched.error }

    const selfKey = selfFetched.key
    const selfId = selfFetched.workitemId

    // 1) 正向 blockedBy：合并原生 DEPEND_ON 记录与正文文件头 DSH-BLOCKED-BY / 可见行
    const nativeDependOn = await probeNativeRelationTargets(effective, proj, selfId, 'DEPEND_ON')
    const bodyBlockers = parseBlockedByFallback(bodyOfWorkitem(selfFetched.raw)) || []
    const combinedBlockerTargets: string[] = [...nativeDependOn.targetIds]
    for (const bk of bodyBlockers) {
      if (bk && !combinedBlockerTargets.includes(bk)) combinedBlockerTargets.push(bk)
    }

    // 2) 扫描项目快照，既用于加速补齐 blockedBy 标题状态，也用于推导反向 blocking 边
    const snapshot = await scanProjectBlockingSnapshot(effective, proj, repo)
    snapshot.knownRaw.set(selfKey, selfFetched.raw)
    snapshot.knownRaw.set(selfId.toLowerCase(), selfFetched.raw)

    const blockedBy = await resolveIssueRefsWithState(effective, proj, combinedBlockerTargets, snapshot.knownRaw)

    // 3) 反向 blocking：合并原生 DEPENDED_BY 记录与快照中 blockedBy 指向 selfKey 的工作项
    const nativeDependedBy = await probeNativeRelationTargets(effective, proj, selfId, 'DEPENDED_BY')
    const reverseTargets: string[] = [...nativeDependedBy.targetIds]
    for (const [candidateKey, candidateBlockers] of snapshot.blockedByMap.entries()) {
      if (candidateKey === selfKey) continue
      if (candidateBlockers.includes(selfKey) && !reverseTargets.includes(candidateKey)) {
        reverseTargets.push(candidateKey)
      }
    }
    const blocking = await resolveIssueRefsWithState(effective, proj, reverseTargets, snapshot.knownRaw)

    return {
      ok: true,
      data: {
        blockedBy,
        blocking,
        blockedByComplete: true,
        blockingComplete: snapshot.complete,
        blockingSource: nativeDependedBy.targetIds.length > 0 && snapshot.complete ? 'native' : 'scan',
      },
    }
  } catch (err: unknown) {
    return failYunxiao(err, errMsg(err), err, effective)
  }
}

export default { getDependencies, checkIssueExists }
