/**
 * src/tracker/rooms/yunxiao/model/description-markers.ts —— Yunxiao Projex 票号双标识桥接与工作项描述文件头隐藏标记编解码（规格 #01）。
 *
 * 为什么需要纯数字票号桥接与五类文件头隐藏标记：
 *   1. 上游 Deck 的 refresh-chain.ts、work-path-record.ts、issue-report.ts、SessionChainCapsule.ts 与 edge-landing.ts
 *      共 5 处硬编码校验纯数字票号（/^\d{1,10}$/），而 Yunxiao Projex 工作项同时拥有 26 位内部 id 与带项目前缀的
 *      serialNumber（如 DCIAFS-2）。因此对外统一暴露剥离前缀后的纯数字票号（"1"、"2"），在房间内部通过双向缓存
 *      桥接纯数字 key、serialNumber 与 26 位内部 id，入参同时兼容三种形态。
 *   2. Yunxiao Projex 创建工作项时 assignedTo 为必填字段且无法通过 UpdateWorkitem 清空，而 Wayfinder frontier
 *      要求未认领子票的 Issue.assignees 为空数组 []。因此以文件头 <!-- DSH-ASSIGNEES: ... --> 作为认领真源。
 *   3. 企业默认关系矩阵限制了 Bug 的原生父子层级与 Req/Task/Bug 的原生 DEPEND_ON 依赖关系，因此父子与阻塞边
 *      通过 <!-- DSH-PARENT: n --> 及成对的 Blocked by: #n + <!-- DSH-BLOCKED-BY: n --> 隐藏标记做无损读写与降级双写。
 */

import { isObjectKind, markerKindInHeader, markerKindOnLine, markerLineFor } from '../../../../shared/issue-file/src/marker.js'
import type { ObjectKind } from '../../../../shared/issue-file/src/marker.js'
import { anchorLineFor, idempotencyKeyOf, stripAnchorLines } from '../../../../refresh/contract/idempotency-keys.js'

export type YunxiaoIssueInputClassification =
  | { kind: 'numeric'; key: string }
  | { kind: 'serial'; key: string; customCode: string; serialNumber: string }
  | { kind: 'internal-id'; id: string }

/** 将纯数字字符串规范化为无前导零的标准数字票号（"02" -> "2"，"0" -> "0"）。 */
export function normalizeNumericKey(rawDigits: string): string {
  const trimmed = rawDigits.trim()
  if (!/^\d+$/.test(trimmed)) return ''
  const stripped = trimmed.replace(/^0+/, '')
  return stripped === '' ? '0' : stripped
}

/** 识别并拆解调用方传入的工作项标识（纯数字、带前缀 serialNumber、26 位内部 ID）。 */
export function classifyYunxiaoIssueInput(raw: unknown): YunxiaoIssueInputClassification | null {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return { kind: 'numeric', key: String(raw) }
  if (typeof raw !== 'string') return null
  const text = raw.trim().replace(/^#/, '')
  if (!text) return null
  if (/^\d+$/.test(text)) return { kind: 'numeric', key: normalizeNumericKey(text) }
  const serialMatch = text.match(/^([A-Za-z][A-Za-z0-9_]{0,31})-(\d+)$/)
  if (serialMatch) {
    const customCode = serialMatch[1]
    const key = normalizeNumericKey(serialMatch[2])
    return { kind: 'serial', key, customCode, serialNumber: customCode + '-' + key }
  }
  if (/^[0-9a-z]{26}$/i.test(text)) return { kind: 'internal-id', id: text }
  return null
}

/** 由纯数字票号与项目 customCode 拼出 Yunxiao Projex 的 serialNumber（如 "2" + "DCIAFS" -> "DCIAFS-2"）。 */
export function toYunxiaoSerialNumber(keyOrInput: unknown, customCode: unknown): string {
  const classified = classifyYunxiaoIssueInput(keyOrInput)
  if (!classified) return ''
  if (classified.kind === 'serial') return classified.serialNumber
  if (classified.kind === 'numeric') {
    const prefix = typeof customCode === 'string' ? customCode.trim() : ''
    return prefix ? prefix + '-' + classified.key : classified.key
  }
  return classified.id
}

/** 归一化 Yunxiao Projex 返回的三种空父项形态（null、""、"EMPTY_VALUE" 均归一为 null）。 */
export function normalizeYunxiaoParentId(rawParentId: unknown): string | null {
  if (rawParentId === null || rawParentId === undefined) return null
  const text = String(rawParentId).trim()
  return !text || text === 'EMPTY_VALUE' ? null : text
}

interface ScopeIssueKeyMap {
  keyToId: Map<string, string>
  idToKey: Map<string, string>
  customCode?: string
}

const SCOPE_CACHE_CAPACITY = 100
const PER_SCOPE_ITEM_CAPACITY = 2000
const issueKeyScopes = new Map<string, ScopeIssueKeyMap>()

function getOrCreateScopeMap(scope: unknown): ScopeIssueKeyMap | null {
  const k = typeof scope === 'string' ? scope.trim().toLowerCase() : ''
  if (!k) return null
  let bag = issueKeyScopes.get(k)
  if (!bag) {
    bag = { keyToId: new Map(), idToKey: new Map() }
    issueKeyScopes.set(k, bag)
    while (issueKeyScopes.size > SCOPE_CACHE_CAPACITY) {
      const oldest = issueKeyScopes.keys().next()
      if (oldest.done) break
      issueKeyScopes.delete(oldest.value)
    }
  }
  return bag
}

/** 记录一条工作项的 { id, serialNumber, key } 双向映射关系，并返回归一化后的纯数字票号。 */
export function rememberYunxiaoIssueIdentity(
  scope: unknown,
  item: { id?: unknown; serialNumber?: unknown; key?: unknown },
): string {
  const rawId = typeof item.id === 'string' ? item.id.trim() : ''
  const serialClass = classifyYunxiaoIssueInput(item.serialNumber)
  const keyClass = classifyYunxiaoIssueInput(item.key)
  const numericKey =
    serialClass?.kind === 'serial' || serialClass?.kind === 'numeric'
      ? serialClass.key
      : keyClass?.kind === 'numeric' || keyClass?.kind === 'serial'
        ? keyClass.key
        : ''

  const bag = getOrCreateScopeMap(scope)
  if (bag) {
    if (serialClass?.kind === 'serial' && serialClass.customCode) bag.customCode = serialClass.customCode
    if (numericKey && rawId) {
      bag.keyToId.set(numericKey, rawId)
      bag.idToKey.set(rawId.toLowerCase(), numericKey)
      while (bag.keyToId.size > PER_SCOPE_ITEM_CAPACITY) {
        const oldest = bag.keyToId.keys().next()
        if (oldest.done) break
        const oldId = bag.keyToId.get(oldest.value)
        bag.keyToId.delete(oldest.value)
        if (oldId) bag.idToKey.delete(oldId.toLowerCase())
      }
    }
  }
  return numericKey || rawId
}

/** 将任意入参（纯数字、DCIAFS-n、26 位 id）解析为对外暴露的纯数字票号；未知的 26 位 id 返回 null。 */
export function resolveYunxiaoIssueKey(scope: unknown, input: unknown): string | null {
  const c = classifyYunxiaoIssueInput(input)
  if (!c) return null
  if (c.kind === 'numeric' || c.kind === 'serial') return c.key
  return getOrCreateScopeMap(scope)?.idToKey.get(c.id.toLowerCase()) || null
}

/** 将任意入参（纯数字、DCIAFS-n、26 位 id）解析为 26 位内部工作项 id；缓存未命中时返回 null。 */
export function resolveYunxiaoWorkitemId(scope: unknown, input: unknown): string | null {
  const c = classifyYunxiaoIssueInput(input)
  if (!c) return null
  if (c.kind === 'internal-id') return c.id
  return getOrCreateScopeMap(scope)?.keyToId.get(c.key) || null
}

/** 读取当前作用域通过工作项 serialNumber 学习到的项目代号 customCode。 */
export function getScopeCustomCode(scope: unknown): string | null {
  return getOrCreateScopeMap(scope)?.customCode || null
}

/** 清空票号双向映射缓存（供离线测试使用）。 */
export function clearYunxiaoIssueKeyCache(): void {
  issueKeyScopes.clear()
}

const ANCHOR_LINE_RE = /^\s*<!--\s*DSH-IDEMPOTENCY-KEY\s*:/
const HIDDEN_PARENT_RE = /^<!--\s*DSH-PARENT\s*:\s*([A-Za-z0-9_-]+)\s*-->$/
const HIDDEN_ASSIGNEES_RE = /^<!--\s*DSH-ASSIGNEES\s*:\s*(.*?)\s*-->$/
const HIDDEN_BLOCKED_RE = /^<!--\s*DSH-BLOCKED-BY\s*:\s*(.*?)\s*-->$/
const VISIBLE_BLOCKED_LINE_RE = /^Blocked by:\s*(.*)$/
const VISIBLE_BLOCKED_ANY_RE = /^Blocked by:\s*.*$/m

function splitHeaderAndRest(body: string): { headerLines: string[]; restLines: string[] } {
  const lines = String(body || '').split('\n')
  const hIdx = lines.findIndex((line) => /^#+\s+/.test(line))
  const cut = hIdx >= 0 ? hIdx : Math.min(lines.length, 10)
  return { headerLines: lines.slice(0, cut), restLines: lines.slice(cut) }
}

function headerTextOf(body: unknown): string {
  return typeof body === 'string' && body ? splitHeaderAndRest(body).headerLines.join('\n') : ''
}

/** 读文件头中的幂等锚（DSH-IDEMPOTENCY-KEY）；不存在返回 null。 */
export function parseHiddenIdempotencyKey(body: unknown): string | null {
  const head = headerTextOf(body)
  return (head && idempotencyKeyOf(head)) || null
}

/** 在描述文件头最前写入幂等锚（先剥除文件头已有锚行，保持正文示例不动）。 */
export function withAnchor(description: string, key: string | null | undefined): string {
  const raw = String(description || '')
  if (!key || !String(key).trim()) return raw
  const { headerLines, restLines } = splitHeaderAndRest(raw)
  const cleanedHeader = stripAnchorLines(headerLines.join('\n'))
  const rebuilt = [cleanedHeader, restLines.join('\n')].filter((s) => s.length > 0).join('\n')
  return anchorLineFor(String(key).trim()) + rebuilt
}

/** 读文件头中的对象类型标记（DSH-ISSUE-KIND）；不存在返回 null。 */
export function parseHiddenIssueKind(body: unknown): ObjectKind | null {
  return markerKindInHeader(body)
}

function rewriteHeaderLines(
  oldBody: string | null | undefined,
  removePred: (line: string) => boolean,
  skipBeforePred: (line: string) => boolean,
  insertedLines: readonly string[],
): string {
  const { headerLines, restLines } = splitHeaderAndRest(String(oldBody || ''))
  const keptHeader = headerLines.filter((line) => !removePred(line))
  while (keptHeader.length > 0 && keptHeader[0].trim() === '') keptHeader.shift()
  if (insertedLines.length > 0) {
    let at = 0
    while (at < keptHeader.length && skipBeforePred(keptHeader[at])) at++
    keptHeader.splice(at, 0, ...insertedLines)
  }
  return [...keptHeader, ...restLines].join('\n')
}

/** 在描述文件头中写入或移除对象类型标记（DSH-ISSUE-KIND），仅修改文件头区域。 */
export function rewriteDescriptionWithIssueKind(oldBody: string | null | undefined, kind: ObjectKind | null | undefined): string {
  const inserted = kind && isObjectKind(kind) ? [markerLineFor(kind).replace(/\n$/, '')] : []
  return rewriteHeaderLines(oldBody, (line) => markerKindOnLine(line) !== null, (line) => ANCHOR_LINE_RE.test(line), inserted)
}

/** 读文件头中的认领人标记（DSH-ASSIGNEES）；未写或为空时返回 []。 */
export function parseHiddenAssignees(body: unknown): string[] {
  const head = headerTextOf(body)
  if (!head) return []
  for (const rawLine of head.split('\n')) {
    const m = HIDDEN_ASSIGNEES_RE.exec(rawLine.trim())
    if (!m) continue
    const inner = (m[1] || '').trim()
    if (!inner) return []
    const out: string[] = []
    const seen = new Set<string>()
    for (const part of inner.split(/[\s,]+/)) {
      const login = part.trim()
      if (login && !seen.has(login)) { seen.add(login); out.push(login) }
    }
    return out
  }
  return []
}

/** 在描述文件头中写入或清空认领人标记（<!-- DSH-ASSIGNEES: ... -->）。 */
export function rewriteDescriptionWithAssignees(oldBody: string | null | undefined, assignees: readonly string[] | null | undefined): string {
  const cleanList = [...new Set((Array.isArray(assignees) ? assignees : []).map((a) => String(a || '').trim()).filter(Boolean))]
  const inserted = cleanList.length > 0 ? ['<!-- DSH-ASSIGNEES: ' + cleanList.join(', ') + ' -->'] : []
  return rewriteHeaderLines(
    oldBody,
    (line) => HIDDEN_ASSIGNEES_RE.test(line.trim()),
    (line) => ANCHOR_LINE_RE.test(line) || markerKindOnLine(line) !== null,
    inserted,
  )
}

function parseHeaderRef(body: unknown, re: RegExp): string | null {
  const head = headerTextOf(body)
  if (!head) return null
  for (const line of head.split('\n')) {
    const m = re.exec(line.trim())
    if (!m) continue
    const c = classifyYunxiaoIssueInput(m[1])
    return c && (c.kind === 'numeric' || c.kind === 'serial') ? c.key : m[1]
  }
  return null
}

/** 读文件头中的隐藏父票标记（DSH-PARENT）。 */
export function parseHiddenParent(body: unknown): string | null { return parseHeaderRef(body, HIDDEN_PARENT_RE) }

/** 在描述文件头中写入或移除隐藏父票标记（<!-- DSH-PARENT: <key> -->）。 */
export function rewriteDescriptionWithHiddenParent(oldBody: string | null | undefined, parentKey: string | null | undefined): string {
  let inserted: string[] = []
  if (parentKey != null && String(parentKey).trim() !== '') {
    const c = classifyYunxiaoIssueInput(parentKey)
    const normKey = c && (c.kind === 'numeric' || c.kind === 'serial') ? c.key : String(parentKey).trim()
    inserted = ['<!-- DSH-PARENT: ' + normKey + ' -->']
  }
  return rewriteHeaderLines(
    oldBody,
    (line) => HIDDEN_PARENT_RE.test(line.trim()),
    (line) => ANCHOR_LINE_RE.test(line) || markerKindOnLine(line) !== null || HIDDEN_ASSIGNEES_RE.test(line.trim()),
    inserted,
  )
}

/** 读文件头中的阻塞机器表（<!-- DSH-BLOCKED-BY: 1, 2 -->）；不存在返回 null，空表返回 []。 */
export function parseHiddenBlockedBy(body: unknown): string[] | null {
  const head = headerTextOf(body)
  if (!head) return null
  for (const rawLine of head.split('\n')) {
    const m = HIDDEN_BLOCKED_RE.exec(rawLine.trim())
    if (!m) continue
    const inner = (m[1] || '').trim()
    if (!inner) return []
    const out: string[] = []
    const seen = new Set<string>()
    for (const part of inner.split(/[\s,]+/)) {
      const c = classifyYunxiaoIssueInput(part)
      const key = c && (c.kind === 'numeric' || c.kind === 'serial') ? c.key : ''
      if (key && !seen.has(key)) { seen.add(key); out.push(key) }
    }
    return out
  }
  return null
}

/** 正文可见 Blocked by: 行解析出的单个阻塞项引用。 */
export interface VisibleBlockedRef { key: string; title: string }

/** 读正文中的可见 Blocked by: 行（隐藏机器表缺失时的回退读法）。 */
export function parseVisibleBlockedBy(body: unknown): VisibleBlockedRef[] | null {
  if (typeof body !== 'string' || !body) return null
  const m = body.match(/^Blocked by:\s*(.+)$/m)
  if (!m) return null
  const line = (m[1] || '').trim()
  if (!line) return []
  const out: VisibleBlockedRef[] = []
  const seen = new Set<string>()
  for (const p of line.split(',').map((s) => s.trim()).filter(Boolean)) {
    const tailMatch = p.match(/#(\d+)\s*$/)
    const c = classifyYunxiaoIssueInput(tailMatch ? tailMatch[1] : p)
    const key = c && (c.kind === 'numeric' || c.kind === 'serial') ? c.key : ''
    if (key && !seen.has(key)) { seen.add(key); out.push({ key, title: p }) }
  }
  return out
}

/** 正文回退读阻塞列表（隐藏机器表优先，可见 Blocked by: 行兜底）。 */
export function parseBlockedByFallback(body: unknown): string[] | null {
  const hidden = parseHiddenBlockedBy(body)
  if (hidden !== null) return hidden
  const visible = parseVisibleBlockedBy(body)
  return visible !== null ? visible.map((r) => r.key) : null
}

/**
 * 成对写入或移除可见 Blocked by: #n 行与隐藏 <!-- DSH-BLOCKED-BY: n --> 机器表。
 * 与 parseVisibleBlockedBy 保持对称：不仅清理文件头中的隐藏机器表与可见行，若标题下方存在第一处旧可见
 * Blocked by: 行，也会一并清理或替换，避免清空阻塞边后 parseBlockedByFallback 读到残留的旧可见行。
 */
export function rewriteDescriptionWithBlockedPair(oldBody: string | null | undefined, keys: readonly string[] | null | undefined): string {
  const normalizedKeys: string[] = []
  const seen = new Set<string>()
  for (const rawKey of Array.isArray(keys) ? keys : []) {
    const c = classifyYunxiaoIssueInput(rawKey)
    const k = c && (c.kind === 'numeric' || c.kind === 'serial') ? c.key : String(rawKey || '').replace(/^#/, '').trim()
    if (k && !seen.has(k)) { seen.add(k); normalizedKeys.push(k) }
  }
  const strippedFirstVisible = String(oldBody || '').replace(VISIBLE_BLOCKED_ANY_RE, '').replace(/^\n+/, '')
  const inserted =
    normalizedKeys.length > 0
      ? [
          'Blocked by: ' + normalizedKeys.map((k) => '#' + k).join(', '),
          '<!-- DSH-BLOCKED-BY: ' + normalizedKeys.join(', ') + ' -->',
        ]
      : []
  return rewriteHeaderLines(
    strippedFirstVisible,
    (line) => HIDDEN_BLOCKED_RE.test(line.trim()) || VISIBLE_BLOCKED_LINE_RE.test(line.trim()),
    (line) =>
      ANCHOR_LINE_RE.test(line) ||
      markerKindOnLine(line) !== null ||
      HIDDEN_ASSIGNEES_RE.test(line.trim()) ||
      HIDDEN_PARENT_RE.test(line.trim()),
    inserted,
  )
}
