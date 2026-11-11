/**
 * src/tracker/rooms/yunxiao/model/normalize.ts —— Yunxiao Projex 原始工作项与评论形状归一化（规格 #03）。
 *
 * 为什么需要独立的归一化模块：
 *   1. 对外统一暴露剥离项目前缀（如 DCIAFS-）后的纯数字票号（"1"、"2"），同时在房间内通过
 *      rememberYunxiaoIssueIdentity 双向记住纯数字 key、serialNumber 与 26 位内部 id。
 *   2. 严格沿用三后端统一的读侧对象类型判据（#1403 T1）：
 *      文件头 DSH-ISSUE-KIND: spec -> wayfinder:map 标签 -> 普通 issue。
 *   3. 以文件头 <!-- DSH-ASSIGNEES: ... --> 作为认领真源：
 *      由于 Yunxiao Projex 创建工作项时 assignedTo 为必填字段且无法清空，若直接读原生 assignedTo，
 *      所有新建子票都会被误判为已认领而无法进入 Wayfinder frontier。因此未写或写空 DSH-ASSIGNEES 时，
 *      读侧返回 Issue.assignees = []。
 *   4. 将工作流阶段 statusStageId === "4"（已完成）与 "5"（已取消）映射为 closed，其余阶段映射为 open。
 *   5. 将 parentId 的 null、""、"EMPTY_VALUE" 三种空值形态统一归一为 null，原生优先、文件头 DSH-PARENT 回退。
 */

import { CLOSED_REASON, ISSUE_TYPE, STATE } from '../../../contract/vocabulary.js'
import type { Actor, ClosedReason, IssueType, State } from '../../../contract/identity.js'
import type { Comment, Issue, IssueRef, Label, RepositoryRef } from '../../../contract/entities.js'
import { normalizeColor } from '../../../../shared/label-color/src/colors.js'
import {
  classifyYunxiaoIssueInput, normalizeYunxiaoParentId, parseHiddenAssignees,
  parseHiddenBlockedBy, parseHiddenIssueKind, parseHiddenParent, parseVisibleBlockedBy,
  rememberYunxiaoIssueIdentity, resolveYunxiaoIssueKey,
} from './description-markers.js'
import { issueAddress } from '../room/links.js'
import { repoRefId } from './repo-identity.js'

type RawBag = Record<string, unknown>

function asBag(raw: unknown): RawBag | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as RawBag) : null
}

/** 提取工作项正文文本（优先 description，兼容 body）。 */
export function bodyOfWorkitem(raw: unknown): string {
  const bag = asBag(raw)
  if (!bag) return ''
  if (typeof bag['description'] === 'string') return bag['description']
  return typeof bag['body'] === 'string' ? bag['body'] : ''
}

/** 将毫秒时间戳、数字字符串或 ISO 字符串统一转换为 ISO 8601 字符串。 */
export function toIsoTimestamp(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return new Date(raw).toISOString()
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return ''
    if (/^\d{10,15}$/.test(trimmed)) {
      const n = Number(trimmed)
      if (Number.isFinite(n) && n > 0) return new Date(n).toISOString()
    }
    return trimmed
  }
  return ''
}

/** 归一化单个标签：将 #RRGGBB 或 RRGGBB 统一转为不带井号的 6 位小写十六进制颜色。 */
export function normalizeYunxiaoLabel(rawLabel: unknown): Label | null {
  if (typeof rawLabel === 'string') {
    const name = rawLabel.trim()
    return name ? { name, color: '' } : null
  }
  const bag = asBag(rawLabel)
  if (!bag) return null
  const name = typeof bag['name'] === 'string' ? bag['name'].trim() : ''
  if (!name) return null
  const out: Label = { name, color: normalizeColor(bag['color']) || '' }
  if (typeof bag['description'] === 'string' && bag['description'].trim() !== '') out.description = bag['description'].trim()
  return out
}

/** 归一化工作项标签数组。 */
export function normalizeYunxiaoLabels(raw: unknown): Label[] {
  const bag = asBag(raw)
  const list = bag && Array.isArray(bag['labels']) ? bag['labels'] : Array.isArray(raw) ? raw : null
  if (!list) return []
  const out: Label[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const l = normalizeYunxiaoLabel(item)
    if (l && !seen.has(l.name)) { seen.add(l.name); out.push(l) }
  }
  return out
}

/** 推导契约 Issue.type（严格沿用三级规则：DSH-ISSUE-KIND: spec -> wayfinder:map 标签 -> 普通 issue）。 */
export function deriveYunxiaoIssueType(raw: unknown, labels?: readonly Label[]): IssueType {
  if (parseHiddenIssueKind(bodyOfWorkitem(raw)) === 'spec') return ISSUE_TYPE.SPEC as IssueType
  const resolvedLabels = labels || normalizeYunxiaoLabels(raw)
  if (resolvedLabels.some((l) => l.name.trim().toLowerCase() === 'wayfinder:map')) return ISSUE_TYPE.MAP as IssueType
  const bag = asBag(raw)
  if (bag && (bag['isMap'] === true || bag['type'] === 'map')) return ISSUE_TYPE.MAP as IssueType
  if (bag && bag['type'] === 'spec') return ISSUE_TYPE.SPEC as IssueType
  return ISSUE_TYPE.ISSUE as IssueType
}

const COMPLETED_STATUS_NAME_ENS = new Set(['done', 'completed', 'closed'])
const COMPLETED_STATUS_NAMES = new Set(['已完成', '已关闭', '完成'])
const CANCELED_STATUS_NAME_ENS = new Set(['canceled', 'cancelled'])
const CANCELED_STATUS_NAMES = new Set(['已取消'])
const REOPEN_STATUS_NAME_ENS = new Set(['to do', 'todo', 'open', 'in progress', 'doing'])
const REOPEN_STATUS_NAMES = new Set(['待处理', '待办', '处理中', '进行中'])

/** 提取状态对象（statuses[] 元素或工作项嵌套 status 对象）的唯一标识。 */
export function readYunxiaoStatusId(statusItem: unknown): string {
  const sb = asBag(statusItem)
  if (!sb) return ''
  if (typeof sb['id'] === 'string') return sb['id'].trim()
  if (typeof sb['statusId'] === 'string') return sb['statusId'].trim()
  if (typeof sb['identifier'] === 'string') return sb['identifier'].trim()
  return ''
}

/** 判断状态对象是否表示已完成/已关闭终态（兼容 nameEn、name、displayName 与内置完成状态 ID 100014）。 */
export function isYunxiaoCompletedStatus(statusItem: unknown): boolean {
  const sb = asBag(statusItem)
  if (!sb) return false
  if (readYunxiaoStatusId(sb) === '100014') return true
  const nameEn = typeof sb['nameEn'] === 'string' ? sb['nameEn'].trim().toLowerCase() : ''
  if (nameEn && COMPLETED_STATUS_NAME_ENS.has(nameEn)) return true
  const name = typeof sb['name'] === 'string' ? sb['name'].trim() : ''
  const displayName = typeof sb['displayName'] === 'string' ? sb['displayName'].trim() : ''
  return (name !== '' && COMPLETED_STATUS_NAMES.has(name)) || (displayName !== '' && COMPLETED_STATUS_NAMES.has(displayName))
}

/** 判断状态对象是否表示已取消终态（兼容 nameEn、name、displayName 与内置取消状态 ID 141230）。 */
export function isYunxiaoCanceledStatus(statusItem: unknown): boolean {
  const sb = asBag(statusItem)
  if (!sb) return false
  if (readYunxiaoStatusId(sb) === '141230') return true
  const nameEn = typeof sb['nameEn'] === 'string' ? sb['nameEn'].trim().toLowerCase() : ''
  if (nameEn && CANCELED_STATUS_NAME_ENS.has(nameEn)) return true
  const name = typeof sb['name'] === 'string' ? sb['name'].trim() : ''
  const displayName = typeof sb['displayName'] === 'string' ? sb['displayName'].trim() : ''
  return (name !== '' && CANCELED_STATUS_NAMES.has(name)) || (displayName !== '' && CANCELED_STATUS_NAMES.has(displayName))
}

/** 判断状态对象是否表示初始或进行中状态（供重开工作项兜底匹配使用）。 */
export function isYunxiaoReopenStatus(statusItem: unknown): boolean {
  const sb = asBag(statusItem)
  if (!sb) return false
  const id = readYunxiaoStatusId(sb)
  if (id === '100005' || id === '100010') return true
  const nameEn = typeof sb['nameEn'] === 'string' ? sb['nameEn'].trim().toLowerCase() : ''
  if (nameEn && REOPEN_STATUS_NAME_ENS.has(nameEn)) return true
  const name = typeof sb['name'] === 'string' ? sb['name'].trim() : ''
  const displayName = typeof sb['displayName'] === 'string' ? sb['displayName'].trim() : ''
  return (name !== '' && REOPEN_STATUS_NAMES.has(name)) || (displayName !== '' && REOPEN_STATUS_NAMES.has(displayName))
}

/** 提取工作流阶段标识 statusStageId（兼容顶层 statusStageId 与嵌套 status.statusStageId / status.stageId）。 */
export function extractStatusStageId(raw: unknown): string {
  const bag = asBag(raw)
  if (!bag) return ''
  if (bag['statusStageId'] !== undefined && bag['statusStageId'] !== null) return String(bag['statusStageId']).trim()
  const sb = asBag(bag['status'])
  if (sb && sb['statusStageId'] != null) return String(sb['statusStageId']).trim()
  if (sb && sb['stageId'] != null) return String(sb['stageId']).trim()
  return ''
}

/**
 * 将工作流阶段或嵌套 status 对象映射为契约两态 state 与关闭原因 reason：
 *   1. 优先按阶段标识判定（阶段 4 -> closed/completed，阶段 5 -> closed/not_planned，其余非空阶段 -> open）；
 *   2. 当顶层 statusStageId 缺失为空时，检查嵌套 status 对象的名称、英文名与状态 ID 进行兜底推导。
 */
export function deriveYunxiaoStateAndReason(raw: unknown): { state: State; reason: ClosedReason } {
  const stageId = extractStatusStageId(raw)
  if (stageId === '4') return { state: STATE.CLOSED as State, reason: CLOSED_REASON.COMPLETED as ClosedReason }
  if (stageId === '5') return { state: STATE.CLOSED as State, reason: 'not_planned' as ClosedReason }
  const bag = asBag(raw)
  if (!stageId && bag) {
    const statusObj = bag['status']
    if (isYunxiaoCompletedStatus(statusObj)) {
      return { state: STATE.CLOSED as State, reason: CLOSED_REASON.COMPLETED as ClosedReason }
    }
    if (isYunxiaoCanceledStatus(statusObj)) {
      return { state: STATE.CLOSED as State, reason: 'not_planned' as ClosedReason }
    }
  }
  const rawState = bag && typeof bag['state'] === 'string' ? bag['state'].trim().toLowerCase() : ''
  if (rawState === 'closed' || rawState === 'close') {
    return { state: STATE.CLOSED as State, reason: (bag && typeof bag['reason'] === 'string' ? bag['reason'].trim() : CLOSED_REASON.COMPLETED) as ClosedReason }
  }
  return { state: STATE.OPEN as State, reason: '' }
}

/** 归一化云效用户对象为契约 Actor。 */
export function normalizeYunxiaoActor(rawUser: unknown): Actor | null {
  if (typeof rawUser === 'string') { const login = rawUser.trim(); return login ? { login } : null }
  const bag = asBag(rawUser)
  if (!bag) return null
  const username = typeof bag['username'] === 'string' ? bag['username'].trim() : ''
  const loginField = typeof bag['login'] === 'string' ? bag['login'].trim() : ''
  const name = typeof bag['name'] === 'string' ? bag['name'].trim() : typeof bag['userName'] === 'string' ? bag['userName'].trim() : ''
  const id = typeof bag['id'] === 'string' ? bag['id'].trim() : typeof bag['userId'] === 'string' ? bag['userId'].trim() : ''
  const login = loginField || username || name || id
  if (!login) return null
  const out: Actor = { login }
  if (name) out.name = name
  const avatar = typeof bag['avatarUrl'] === 'string' && bag['avatarUrl'].trim() ? bag['avatarUrl'].trim() : typeof bag['avatar'] === 'string' && bag['avatar'].trim() ? bag['avatar'].trim() : ''
  if (avatar) out.avatarUrl = avatar
  return out
}

/** 以正文文件头 DSH-ASSIGNEES 作为契约认领真源（未写或为空时返回 [] 以进入 Wayfinder frontier）。 */
export function deriveYunxiaoAssignees(raw: unknown): Actor[] {
  const hiddenLogins = parseHiddenAssignees(bodyOfWorkitem(raw))
  if (hiddenLogins.length === 0) return []
  const bag = asBag(raw)
  const nativeAssigned = bag ? asBag(bag['assignedTo']) : null
  const nativeParticipants = bag && Array.isArray(bag['participants']) ? bag['participants'] : []
  return hiddenLogins.map((login) => {
    const actor: Actor = { login }
    if (nativeAssigned) {
      const nId = typeof nativeAssigned['id'] === 'string' ? nativeAssigned['id'].trim() : ''
      const nName = typeof nativeAssigned['name'] === 'string' ? nativeAssigned['name'].trim() : ''
      const nUser = typeof nativeAssigned['username'] === 'string' ? nativeAssigned['username'].trim() : ''
      if ((login === nId || login === nName || login === nUser) && nName) actor.name = nName
    }
    if (!actor.name) {
      for (const p of nativeParticipants) {
        const pb = asBag(p)
        const pId = pb && typeof pb['id'] === 'string' ? pb['id'].trim() : ''
        const pName = pb && typeof pb['name'] === 'string' ? pb['name'].trim() : ''
        if ((login === pId || login === pName) && pName) { actor.name = pName; break }
      }
    }
    return actor
  })
}

/** 归一化单条云效评论（ListWorkitemComments 或 CreateWorkitemComment 响应项）。 */
export function normalizeYunxiaoComment(rawComment: unknown): Comment | null {
  const bag = asBag(rawComment)
  if (!bag) return null
  const body = typeof bag['content'] === 'string' ? bag['content'] : typeof bag['body'] === 'string' ? bag['body'] : ''
  const author = normalizeYunxiaoActor(bag['user']) || normalizeYunxiaoActor(bag['author']) || normalizeYunxiaoActor(bag['creator']) || { login: '' }
  const createdAt = toIsoTimestamp(bag['gmtCreate'] ?? bag['createdAt'] ?? bag['created_at'])
  const updatedAt = toIsoTimestamp(bag['gmtModified'] ?? bag['updatedAt'] ?? bag['updated_at']) || createdAt
  const out: Comment = { author, authorAssociation: typeof bag['authorAssociation'] === 'string' ? bag['authorAssociation'] : '', body, createdAt, updatedAt }
  if (bag['id'] != null && String(bag['id']).trim() !== '') out.id = String(bag['id']).trim()
  return out
}

/** 归一化工作项评论列表。 */
export function normalizeYunxiaoComments(raw: unknown): Comment[] {
  const bag = asBag(raw)
  const src = bag && Array.isArray(bag['comments']) ? bag['comments'] : Array.isArray(raw) ? raw : []
  const out: Comment[] = []
  for (const item of src) { const c = normalizeYunxiaoComment(item); if (c) out.push(c) }
  return out
}

/** 将单个原始工作项字典与已知票号转换为契约 IssueRef（自动提取标题、开闭状态与对象类型）。 */
export function toYunxiaoIssueRef(key: string, raw: unknown): IssueRef {
  const k = key.trim()
  const bag = asBag(raw)
  if (!bag) {
    return { key: k, title: '#' + k, state: STATE.OPEN as State, type: ISSUE_TYPE.ISSUE as IssueType }
  }
  const title =
    typeof bag['subject'] === 'string' && bag['subject'].trim()
      ? bag['subject'].trim()
      : typeof bag['title'] === 'string' && bag['title'].trim()
        ? bag['title'].trim()
        : '#' + k
  return {
    key: k,
    title,
    state: deriveYunxiaoStateAndReason(bag).state,
    type: deriveYunxiaoIssueType(bag),
  }
}

/** 推导父工作项纯数字票号 parentKey（归一三种空值形态，原生 parentId 解析为数字票号优先，文件头 DSH-PARENT 回退，避免泄漏 26 位内部 ID）。 */
export function deriveYunxiaoParentKey(raw: unknown, scope: unknown): string | null {
  const bag = asBag(raw)
  const hiddenParent = parseHiddenParent(bodyOfWorkitem(raw))
  if (!bag) return hiddenParent
  const normParentId = normalizeYunxiaoParentId(bag['parentId'])
  if (normParentId) {
    const resolved = resolveYunxiaoIssueKey(scope, normParentId)
    if (resolved) return resolved
    const c = classifyYunxiaoIssueInput(normParentId)
    if (c && (c.kind === 'numeric' || c.kind === 'serial')) return c.key
    if (hiddenParent) return hiddenParent
  }
  if (hiddenParent) return hiddenParent
  if (typeof bag['parentKey'] === 'string' && bag['parentKey'].trim()) {
    const c = classifyYunxiaoIssueInput(bag['parentKey'])
    return c && (c.kind === 'numeric' || c.kind === 'serial') ? c.key : bag['parentKey'].trim()
  }
  return null
}

/** 推导工作项上的阻塞入边列表 blockedBy（原生聚合优先，文件头 DSH-BLOCKED-BY 与可见行回退）。 */
export function deriveYunxiaoBlockedBy(raw: unknown, scope: unknown): IssueRef[] {
  const bag = asBag(raw)
  const out: IssueRef[] = []
  const seen = new Set<string>()
  const pushRef = (key: string, title?: string, state?: State, type?: IssueType) => {
    const k = key.trim()
    if (!k || seen.has(k)) return
    seen.add(k)
    out.push({ key: k, title: title && title.trim() ? title.trim() : '#' + k, state: state || (STATE.OPEN as State), type: type || (ISSUE_TYPE.ISSUE as IssueType) })
  }
  const nativeList = bag && Array.isArray(bag['blockedBy']) ? bag['blockedBy'] : bag && Array.isArray(bag['blocked_by']) ? bag['blocked_by'] : null
  if (Array.isArray(nativeList)) {
    for (const item of nativeList) {
      const ib = asBag(item)
      if (!ib) continue
      const rawKey = ib['key'] ?? ib['serialNumber'] ?? ib['workitemId'] ?? ib['resourceId'] ?? ib['id']
      const k = resolveYunxiaoIssueKey(scope, rawKey) || (typeof rawKey === 'string' ? rawKey.trim() : '')
      if (!k) continue
      const title = typeof ib['title'] === 'string' ? ib['title'] : typeof ib['subject'] === 'string' ? ib['subject'] : '#' + k
      pushRef(k, title, deriveYunxiaoStateAndReason(ib).state, deriveYunxiaoIssueType(ib))
    }
  }
  const body = bodyOfWorkitem(raw)
  const hiddenKeys = parseHiddenBlockedBy(body)
  if (hiddenKeys !== null) {
    for (const k of hiddenKeys) pushRef(k, '#' + k)
  } else {
    const visibleRefs = parseVisibleBlockedBy(body)
    if (visibleRefs !== null) { for (const r of visibleRefs) pushRef(r.key, r.title) }
  }
  return out
}

/** 将 Yunxiao Projex 原始工作项对象归一化为契约 Issue 实体。 */
export function normalizeYunxiaoIssue(raw: unknown, repo?: Partial<RepositoryRef> | null): Issue {
  const bag = asBag(raw) || {}
  const scope = repoRefId(repo)
  const key = rememberYunxiaoIssueIdentity(scope, { id: bag['id'], serialNumber: bag['serialNumber'], key: bag['key'] }) || '0'
  const labels = normalizeYunxiaoLabels(bag)
  const type = deriveYunxiaoIssueType(bag, labels)
  const { state, reason } = deriveYunxiaoStateAndReason(bag)
  const assignees = deriveYunxiaoAssignees(bag)
  const comments = normalizeYunxiaoComments(bag)
  const parentKey = deriveYunxiaoParentKey(bag, scope)
  const blockedBy = deriveYunxiaoBlockedBy(bag, scope)
  const title = typeof bag['subject'] === 'string' ? bag['subject'] : typeof bag['title'] === 'string' ? bag['title'] : ''
  const body = bodyOfWorkitem(bag)
  const createdAt = toIsoTimestamp(bag['gmtCreate'] ?? bag['createdAt'] ?? bag['created_at'])
  const updatedAt = toIsoTimestamp(bag['gmtModified'] ?? bag['updatedAt'] ?? bag['updated_at']) || createdAt
  const closedAtRaw = toIsoTimestamp(bag['gmtClosed'] ?? bag['closedAt'] ?? bag['closed_at'] ?? bag['finishTime'])
  const closedAt = state === STATE.CLOSED ? closedAtRaw || updatedAt || null : null
  const explicitUrl = typeof bag['url'] === 'string' && bag['url'].trim() ? bag['url'].trim() : typeof bag['webUrl'] === 'string' && bag['webUrl'].trim() ? bag['webUrl'].trim() : ''
  const url = explicitUrl || (repo ? issueAddress(repo, key) : '')
  const issue: Issue = {
    key, effortId: '', type, title, state, body, url, createdAt, updatedAt, closedAt,
    parentKey, labels, assignees, comments, blockedBy, reason,
  }
  const creator = normalizeYunxiaoActor(bag['creator'] ?? bag['author'])
  if (creator) issue.author = creator
  if (typeof bag['commentCount'] === 'number' && Number.isFinite(bag['commentCount']) && bag['commentCount'] >= 0) {
    issue.commentCount = Math.floor(bag['commentCount'])
  } else if (Array.isArray(bag['comments'])) {
    issue.commentCount = comments.length
  }
  return issue
}

export default normalizeYunxiaoIssue
