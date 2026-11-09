/**
 * src/tracker/rooms/yunxiao/issues/shared.ts —— Yunxiao Projex 工作项读写共用的坐标解析、票号双向桥接、详情补齐与标签映射助手（规格 #03）。
 *
 * 为什么抽在 issues/shared.ts 一处：
 *   1. 列表、单票详情、建票、改票、关票、评论、标签、认领与关系图谱都需要做三件事：
 *      - 从 RepositoryRef 解析出 { organizationId, projectId, refId }；
 *      - 将调用方传入的纯数字票号（"2"）、带前缀编号（"DCIAFS-2"）或 26 位内部 ID 双向桥接为
 *        GetWorkitem 可接受的标识及写接口必填的 26 位内部 id；
 *      - 在 SearchWorkitems 摘要缺失完整 description 时自动调用 GetWorkitem 补齐正文。
 *   2. 项目标签字典读取（含 HTTP 204 空响应归一与跨页翻页）、乐观并发校验与按需创建收口在本模块，供列表过滤、建票与改标签复用。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Label, RepositoryRef } from '../../../contract/entities.js'
import type { AssigneeInput, LabelInput, ListFilter, SetOpts } from '../../../contract/inputs.js'
import type { TrackerError } from '../../../contract/results.js'
import { PAGINATION } from '../../../contract/pagination.js'
import { normalizeColor } from '../../../../shared/label-color/src/colors.js'
import { fail } from '../../../kernel/preflight.js'
import { GITLAB_READ_TIMEOUT_MS, GITLAB_PROBE_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { hasNextYunxiaoPage, type YunxiaoCtx, type YunxiaoHttpResult } from '../client.js'
import { asRecord, errMsg, failYunxiao } from '../errors.js'
import {
  classifyYunxiaoIssueInput, getScopeCustomCode, rememberYunxiaoIssueIdentity,
  resolveYunxiaoIssueKey, resolveYunxiaoWorkitemId, toYunxiaoSerialNumber,
} from '../model/description-markers.js'
import { toIsoTimestamp } from '../model/normalize.js'
import {
  getLearnedYunxiaoContext, learnYunxiaoContextFor, parseYunxiaoProjectPayload,
  parseYunxiaoRefId, repoRefId,
} from '../model/repo-identity.js'
import { resolveYunxiaoCoordinates } from '../model/workspace-config.js'
import { looksLikeYunxiaoProjectRef } from '../repo/identity.js'
import {
  requestProjectGet, requestProjectLabelCreate, requestProjectLabelsList,
  requestWorkitemCommentsList, requestWorkitemGet,
} from '../requests.js'

/** 仓库引用入参兼容类型（只取 refId 与 name）。 */
export type RepoLike = Partial<RepositoryRef> | null | undefined
/** 云效房间操作上下文兼容类型。 */
export type CtxLike = Partial<OpContext> & Partial<BackendContext> & YunxiaoCtx
/** 云效远端 JSON 对象字典类型。 */
export type RawBag = Record<string, unknown>

/** 默认跨类别搜索范围：覆盖需求（Req）、任务（Task）与缺陷（Bug）。 */
export const DEFAULT_WORKITEM_CATEGORIES = 'Req,Task,Bug'

const DETAIL_CONCURRENCY = PAGINATION.gitlab.labelWriteConcurrencyMax
const COMMENTS_MAX = PAGINATION.gitlab.limitMax
const LABEL_LIST_PER_PAGE = PAGINATION.gitlab.labelListPerPage
const LABEL_LIST_MAX_PAGES = PAGINATION.gitlab.labelListMaxPages

/** 解析后的云效组织与项目坐标。 */
export interface ResolvedProjectRef { refId: string; organizationId: string; projectId: string }

/** 校验并拆解 RepositoryRef.refId（必须形如 organizationId/projectId）。 */
export function resolveProjectRef(repo: RepoLike): ResolvedProjectRef | null {
  const refId = repoRefId(repo)
  if (!looksLikeYunxiaoProjectRef(refId)) return null
  const parsed = parseYunxiaoRefId(refId)
  return parsed ? { refId, organizationId: parsed.organizationId, projectId: parsed.projectId } : null
}

/** 校验 SetOpts.expectedUpdatedAt 乐观并发前置条件：与远端更新时间不一致时返回中文 conflict 失败。 */
export function checkExpectedUpdatedAt(opts: SetOpts | null | undefined, raw: RawBag): { ok: false; error: TrackerError } | null {
  if (!opts || typeof opts.expectedUpdatedAt !== 'string' || opts.expectedUpdatedAt.trim() === '') return null
  const want = opts.expectedUpdatedAt.trim()
  const cur = toIsoTimestamp(raw['gmtModified'] ?? raw['updatedAt'] ?? raw['updated_at'])
  if (cur === want) return null
  return fail(
    ERROR_KIND.CONFLICT as ErrorKind,
    '并发冲突：工作项更新时间不匹配（期望 ' + want + '，实际 ' + cur + '），请先重读最新状态后再试。',
    JSON.stringify(raw),
  )
}

/** 提取认领人登录名数组（去重、去空，兼容裸字符串与 Actor 对象）。 */
export function extractAssigneeLogins(assignees: readonly AssigneeInput[] | undefined): string[] {
  if (!Array.isArray(assignees)) return []
  const out: string[] = []
  for (const item of assignees) {
    const l = typeof item === 'string' ? item.trim() : item && typeof item === 'object' && typeof item.login === 'string' ? item.login.trim() : ''
    if (l && !out.includes(l)) out.push(l)
  }
  return out
}

/** 归一化调用方传入的标签输入（裸字符串或带色对象）。 */
export function normalizeLabelInputs(labels: unknown): Label[] {
  if (!Array.isArray(labels)) return []
  const out: Label[] = []
  const seen = new Set<string>()
  for (const li of labels as LabelInput[]) {
    if (typeof li === 'string') {
      const name = li.trim()
      if (name && !seen.has(name)) { seen.add(name); out.push({ name, color: '' }) }
      continue
    }
    if (!li || typeof li !== 'object') continue
    const bag = li as Record<string, unknown>
    const name = typeof bag['name'] === 'string' ? bag['name'].trim() : ''
    if (!name || seen.has(name)) continue
    seen.add(name)
    const item: Label = { name, color: normalizeColor(bag['color']) || '' }
    if (typeof bag['description'] === 'string' && bag['description'].trim() !== '') item.description = bag['description'].trim()
    out.push(item)
  }
  return out
}

/** 获取项目代号 customCode（优先读缓存与本地配置，未命中时调 GetProject）。 */
export async function ensureProjectCustomCode(opCtx: CtxLike | null | undefined, proj: ResolvedProjectRef): Promise<string> {
  const fromLearned = getLearnedYunxiaoContext(proj.refId)?.customCode || (opCtx?.cwd ? getLearnedYunxiaoContext(opCtx.cwd)?.customCode : '') || getScopeCustomCode(proj.refId) || ''
  if (fromLearned) return fromLearned
  if (opCtx?.cwd || opCtx?.platform?.fs || opCtx?.fs || opCtx?.platform?.env) {
    const coords = await resolveYunxiaoCoordinates({ cwd: opCtx?.cwd, fs: opCtx?.platform?.fs || opCtx?.fs || null, env: opCtx?.platform?.env || null })
    if (coords.ok && coords.value.customCode) {
      learnYunxiaoContextFor({ cwd: opCtx?.cwd, refId: proj.refId }, { organizationId: proj.organizationId, projectId: proj.projectId, customCode: coords.value.customCode })
      return coords.value.customCode
    }
  }
  const res = await requestProjectGet(opCtx, proj.organizationId, proj.projectId, GITLAB_PROBE_TIMEOUT_MS)
  if (res.ok) {
    const parsed = parseYunxiaoProjectPayload(res.data)
    if (parsed?.customCode) {
      learnYunxiaoContextFor({ cwd: opCtx?.cwd, refId: proj.refId }, { organizationId: proj.organizationId, projectId: proj.projectId, customCode: parsed.customCode, ...(parsed.projectName ? { projectName: parsed.projectName } : {}) })
      return parsed.customCode
    }
  }
  return ''
}

/** 将调用方传入的票号（纯数字、DCIAFS-2 或 26 位 ID）转换为读接口可接受的路径参数。 */
export async function resolveIdOrSerialForRead(opCtx: CtxLike | null | undefined, proj: ResolvedProjectRef, rawKey: unknown): Promise<string | null> {
  const classified = classifyYunxiaoIssueInput(rawKey)
  if (!classified) return null
  if (classified.kind === 'internal-id') return classified.id
  if (classified.kind === 'serial') return classified.serialNumber
  const cachedId = resolveYunxiaoWorkitemId(proj.refId, classified.key)
  if (cachedId) return cachedId
  const customCode = await ensureProjectCustomCode(opCtx, proj)
  return customCode ? toYunxiaoSerialNumber(classified.key, customCode) : classified.key
}

/** 单个工作项读取与双向标识登记结果。 */
export type FetchWorkitemOutcome =
  | { ok: true; raw: RawBag; workitemId: string; key: string; response: YunxiaoHttpResult }
  | { ok: false; error: TrackerError; response?: YunxiaoHttpResult }

/** 按任意合法票号拉取单个工作项的原始对象并更新纯数字 key <-> 26 位 id 双向映射。 */
export async function fetchRawWorkitem(opCtx: CtxLike | null | undefined, proj: ResolvedProjectRef, rawKey: unknown): Promise<FetchWorkitemOutcome> {
  const idOrSerial = await resolveIdOrSerialForRead(opCtx, proj, rawKey)
  if (!idOrSerial) return fail(ERROR_KIND.NOTFOUND as ErrorKind, '工作项编号格式不合法：' + String(rawKey ?? ''), String(rawKey ?? ''))
  const res = await requestWorkitemGet(opCtx, proj.organizationId, idOrSerial, GITLAB_READ_TIMEOUT_MS)
  if (!res.ok) {
    const failed = failYunxiao(res, res.stderr || res.stdout || '读取工作项 ' + String(rawKey) + ' 失败', res, opCtx ?? undefined)
    return { ok: false, error: failed.error, response: res }
  }
  const bag = asRecord(res.data)
  if (!bag) return fail(ERROR_KIND.PARSE as ErrorKind, 'GetWorkitem 返回的不是有效的工作项 JSON 对象', res.stdout)
  const key = rememberYunxiaoIssueIdentity(proj.refId, { id: bag['id'], serialNumber: bag['serialNumber'], key: bag['key'] ?? rawKey })
  const workitemId = typeof bag['id'] === 'string' && bag['id'].trim() ? bag['id'].trim() : idOrSerial
  return { ok: true, raw: bag, workitemId, key, response: res }
}

/** 解析写接口必填的 26 位内部工作项 ID（命中缓存零请求，未命中调一次 GetWorkitem）。 */
export async function resolveRequiredWorkitemId(
  opCtx: CtxLike | null | undefined, proj: ResolvedProjectRef, rawKey: unknown,
): Promise<{ ok: true; workitemId: string; key: string; raw?: RawBag } | { ok: false; error: TrackerError }> {
  const cachedId = resolveYunxiaoWorkitemId(proj.refId, rawKey)
  const cachedKey = resolveYunxiaoIssueKey(proj.refId, rawKey)
  if (cachedId && cachedKey) return { ok: true, workitemId: cachedId, key: cachedKey }
  const fetched = await fetchRawWorkitem(opCtx, proj, rawKey)
  return fetched.ok ? { ok: true, workitemId: fetched.workitemId, key: fetched.key, raw: fetched.raw } : fetched
}

/** 判断 SearchWorkitems 列表摘要是否缺失完整正文。 */
export function needsDetailEnrichment(raw: RawBag): boolean {
  return typeof raw['description'] !== 'string' || (raw['formatType'] === null && raw['description'] === '')
}

/** 为列表项按需并发补齐完整工作项详情（限制并发数为 PAGINATION.gitlab.labelWriteConcurrencyMax，确保文件头标记与标签不丢失）。 */
export async function enrichWorkitemListDetails(opCtx: CtxLike | null | undefined, proj: ResolvedProjectRef, items: RawBag[]): Promise<RawBag[]> {
  const out = items.slice()
  const indices: number[] = []
  for (let i = 0; i < out.length; i++) {
    rememberYunxiaoIssueIdentity(proj.refId, { id: out[i]['id'], serialNumber: out[i]['serialNumber'], key: out[i]['key'] })
    if (needsDetailEnrichment(out[i])) indices.push(i)
  }
  if (indices.length === 0) return out
  const concurrency = Math.min(DETAIL_CONCURRENCY, indices.length)
  let cursor = 0
  const workers: Promise<void>[] = []
  for (let w = 0; w < concurrency; w++) {
    workers.push((async () => {
      for (;;) {
        const pos = cursor++
        if (pos >= indices.length) return
        const idx = indices[pos]
        const item = out[idx]
        const idOrSerial = (typeof item['id'] === 'string' && item['id'].trim()) || (typeof item['serialNumber'] === 'string' && item['serialNumber'].trim()) || ''
        if (!idOrSerial) continue
        try {
          const res = await requestWorkitemGet(opCtx, proj.organizationId, idOrSerial, GITLAB_READ_TIMEOUT_MS)
          const fullBag = res.ok ? asRecord(res.data) : null
          if (fullBag) {
            rememberYunxiaoIssueIdentity(proj.refId, { id: fullBag['id'] ?? item['id'], serialNumber: fullBag['serialNumber'] ?? item['serialNumber'] })
            out[idx] = { ...item, ...fullBag }
          }
        } catch { /* best-effort */ }
      }
    })())
  }
  await Promise.all(workers)
  return out
}

/** 拉取工作项评论列表并挂入 raw.comments（best-effort）。 */
export async function enrichWorkitemComments(opCtx: CtxLike | null | undefined, proj: ResolvedProjectRef, raw: RawBag, idOrSerial: string, commentsWant?: number | null): Promise<RawBag> {
  if (commentsWant === 0) return raw
  try {
    const limit = typeof commentsWant === 'number' && Number.isFinite(commentsWant) && commentsWant > 0 ? Math.min(COMMENTS_MAX, Math.floor(commentsWant)) : PAGINATION.github.anchorLookupSearchLimit
    const res = await requestWorkitemCommentsList(opCtx, proj.organizationId, idOrSerial, 'page=1&perPage=' + String(limit), GITLAB_READ_TIMEOUT_MS)
    if (res.ok && Array.isArray(res.data)) {
      const all = res.data as unknown[]
      raw['commentCount'] = typeof res.headers.xTotal === 'number' && res.headers.xTotal >= 0 ? res.headers.xTotal : all.length
      raw['comments'] = all.slice(0, limit)
    }
  } catch { /* best-effort */ }
  return raw
}

/** 构造 SearchWorkitems 的 conditions JSON 字符串。 */
export function buildSearchConditions(opts?: { labelIds?: readonly string[]; subjectKeyword?: string; serialNumbers?: readonly string[] }): string | undefined {
  const filterItems: Record<string, unknown>[] = []
  if (opts?.labelIds && opts.labelIds.length > 0) filterItems.push({ fieldIdentifier: 'tag', operator: 'CONTAINS', value: [...opts.labelIds], toValue: null, className: 'tag', format: 'multiList' })
  if (opts?.subjectKeyword && opts.subjectKeyword.trim()) filterItems.push({ fieldIdentifier: 'subject', operator: 'CONTAINS', value: [opts.subjectKeyword.trim()], toValue: null, className: 'string', format: 'input' })
  if (opts?.serialNumbers && opts.serialNumbers.length > 0) filterItems.push({ fieldIdentifier: 'serialNumber', operator: 'CONTAINS', value: [...opts.serialNumbers], toValue: null, className: 'string', format: 'input' })
  return filterItems.length > 0 ? JSON.stringify({ conditionGroups: [filterItems] }) : undefined
}

/** 读取项目全量标签字典（按 hasNextYunxiaoPage 自动翻页，兼容 HTTP 204 空响应）。 */
export async function fetchProjectLabelNameMap(
  opCtx: CtxLike | null | undefined, proj: ResolvedProjectRef,
): Promise<{ ok: true; nameToId: Map<string, string>; rows: RawBag[] } | { ok: false; error: TrackerError }> {
  const nameToId = new Map<string, string>()
  const allRows: RawBag[] = []
  for (let page = 1; page <= LABEL_LIST_MAX_PAGES; page++) {
    const query = page === 1 ? '' : 'page=' + String(page) + '&perPage=' + String(LABEL_LIST_PER_PAGE)
    const res = await requestProjectLabelsList(opCtx, proj.organizationId, proj.projectId, query, GITLAB_READ_TIMEOUT_MS)
    if (!res.ok) return failYunxiao(res, res.stderr || res.stdout || '查询项目标签列表失败', res, opCtx ?? undefined)
    if (res.status === 204 || res.data === null || (res.stdout.trim() === '' && res.data === null)) break
    if (!Array.isArray(res.data)) return fail(ERROR_KIND.PARSE as ErrorKind, '项目标签列表响应不是合法数组', res.stdout)
    for (const r of res.data as RawBag[]) {
      if (!r || typeof r !== 'object') continue
      allRows.push(r)
      const n = typeof r['name'] === 'string' ? r['name'].trim() : ''
      const id = typeof r['id'] === 'string' ? r['id'].trim() : ''
      if (n && id) { nameToId.set(n, id); nameToId.set(n.toLowerCase(), id) }
    }
    if (!hasNextYunxiaoPage(res.headers)) break
  }
  return { ok: true, nameToId, rows: allRows }
}

/** 将标签名列表解析为项目中的标签 ID 列表（供 SearchWorkitems 按 tag 过滤使用）。 */
export async function resolveProjectLabelIdsByNames(
  opCtx: CtxLike | null | undefined, proj: ResolvedProjectRef, labelNames: readonly string[],
): Promise<{ ok: true; matchedAll: boolean; labelIds: string[] } | { ok: false; error: TrackerError }> {
  const cleanNames = [...new Set(labelNames.map((n) => String(n || '').trim()).filter(Boolean))]
  if (cleanNames.length === 0) return { ok: true, matchedAll: true, labelIds: [] }
  const mapRes = await fetchProjectLabelNameMap(opCtx, proj)
  if (!mapRes.ok) return mapRes
  const ids: string[] = []
  for (const want of cleanNames) {
    const id = mapRes.nameToId.get(want) || mapRes.nameToId.get(want.toLowerCase())
    if (!id) return { ok: true, matchedAll: false, labelIds: [] }
    if (!ids.includes(id)) ids.push(id)
  }
  return { ok: true, matchedAll: true, labelIds: ids }
}

/** 将 ListFilter.labels 解析为 SearchWorkitems 的 conditions 字符串（统一收口 listIssues / counts / listPage 的标签前置过滤）。 */
export async function resolveLabelFilterConditions(
  opCtx: CtxLike | null | undefined, proj: ResolvedProjectRef, filter: ListFilter | null | undefined,
): Promise<{ ok: true; matchedAll: boolean; conditions?: string } | { ok: false; error: TrackerError }> {
  if (!filter || !Array.isArray(filter.labels) || filter.labels.length === 0) return { ok: true, matchedAll: true }
  const lblResolved = await resolveProjectLabelIdsByNames(opCtx, proj, filter.labels)
  if (!lblResolved.ok) return lblResolved
  if (!lblResolved.matchedAll) return { ok: true, matchedAll: false }
  const conditions = lblResolved.labelIds.length > 0 ? buildSearchConditions({ labelIds: lblResolved.labelIds }) : undefined
  return { ok: true, matchedAll: true, ...(conditions ? { conditions } : {}) }
}

/** 确保目标标签在项目中全部存在并返回对应的标签 ID 数组（缺失时自动调用 CreateLabel，创建失败如实报错）。 */
export async function ensureProjectLabelIdsForWrite(
  opCtx: CtxLike | null | undefined, proj: ResolvedProjectRef, items: readonly (string | Label)[],
): Promise<{ ok: true; labelIds: string[] } | { ok: false; error: TrackerError }> {
  const normalized = normalizeLabelInputs(items)
  if (normalized.length === 0) return { ok: true, labelIds: [] }
  const mapRes = await fetchProjectLabelNameMap(opCtx, proj)
  if (!mapRes.ok) return mapRes
  const ids: string[] = []
  for (const item of normalized) {
    let id = mapRes.nameToId.get(item.name) || mapRes.nameToId.get(item.name.toLowerCase()) || ''
    if (!id) {
      const createBody: { name: string; color?: string } = { name: item.name }
      if (item.color) createBody.color = '#' + item.color
      const created = await requestProjectLabelCreate(opCtx, proj.organizationId, proj.projectId, createBody, GITLAB_READ_TIMEOUT_MS)
      if (!created.ok) return failYunxiao(created, created.stderr || created.stdout || '创建项目标签「' + item.name + '」失败', created, opCtx ?? undefined)
      const cBag = asRecord(created.data)
      id = cBag && typeof cBag['id'] === 'string' ? cBag['id'].trim() : ''
      if (!id) return fail(ERROR_KIND.PARSE as ErrorKind, '创建项目标签「' + item.name + '」响应缺少有效的 id', created.stdout)
      mapRes.nameToId.set(item.name, id)
      mapRes.nameToId.set(item.name.toLowerCase(), id)
    }
    if (!ids.includes(id)) ids.push(id)
  }
  return { ok: true, labelIds: ids }
}

/** 从关系记录行（ListWorkitemRelationRecords 响应元素）中提取对端工作项 26 位 ID。 */
export function extractRelationWorkitemId(record: unknown): string {
  const bag = asRecord(record)
  if (!bag) return ''
  const raw = bag['resourceId'] ?? bag['workitemId'] ?? bag['targetWorkitemId'] ?? bag['id']
  return typeof raw === 'string' ? raw.trim() : ''
}

export { errMsg }
