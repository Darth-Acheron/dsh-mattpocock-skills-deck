// persistence/issue-row-write.ts —— row 组落到 issue 表列上。
//
// 这一组只有两种写法，语义完全由合并决策（merge/row.ts）决定，这里只负责把决策翻译成 SQL：
//   replace：整组替换，没给的列写 NULL——"我现在全知道，这些就是全部"；
//   fill：只补当前为 NULL 的列——"我只拿到一部分，别拿一部分去覆盖已有的完整值"。
// 布尔在 STRICT 表里只收 0/1；null 继续表示没有值，不承担语义。
import type { DatabaseSync } from 'node:sqlite'
import type { IssueRowValue } from '../model/types.js'
import { isSpecHeaderMarked } from '../../shared/issue-file/src/marker.js'
import { pickPresentFields } from '../merge/row.js'

/** row 组字段 → issue 表列。顺序固定，门禁与排查都按这一份看。 */
export const ROW_COLUMNS: ReadonlyArray<readonly [keyof IssueRowValue, string]> = [
  ['type', 'type'],
  ['title', 'title'],
  ['state', 'state'],
  ['url', 'url'],
  ['createdAtMs', 'created_at_ms'],
  ['updatedAtMs', 'updated_at_ms'],
  ['closedAtMs', 'closed_at_ms'],
  ['stateReason', 'reason'],
  ['isPullRequest', 'is_pull_request'],
  ['commentCount', 'comment_count'],
  ['milestoneJson', 'milestone_json'],
  ['customFieldsJson', 'custom_fields_json'],
  ['status', 'status'],
  ['statusVisible', 'status_visible'],
  ['statusSource', 'status_source'],
  ['statusConflictJson', 'status_conflict_json'],
]

/**
 * complete 的 row：整组替换，没给的列写 NULL（这是「我全知道」的语义）。
 *
 * 例外（无正文列表写入保护）：GitHub / GitLab 的规格容器（spec）靠正文文件头标记
 * `<!-- DSH-ISSUE-KIND: spec -->` 识别，而周期性列表扫描（listPage）不拉取正文，会把规格行也标成
 * 泛化的 `type = 'issue'`。若本次写入未同时表达 `body` 组，且库内该票已是 `'spec'`（或已落盘的正文
 * 文件头含规格标记），则保留 `'spec'` 不被无正文列表降级覆盖。
 */
export function replaceIssueRow(
  db: DatabaseSync,
  issueId: number,
  value: IssueRowValue,
  nowMs: number,
  options?: { bodyExpressed?: boolean },
): void {
  let effectiveValue = value
  if (value.type === 'issue' && !(options && options.bodyExpressed)) {
    const prior = db.prepare(
      `SELECT i.type AS type, substr(b.body, 1, 1024) AS body_head
         FROM issue i
         LEFT JOIN issue_body b ON b.issue_id = i.issue_id
        WHERE i.issue_id = ?`,
    ).get(issueId) as { type?: string | null, body_head?: string | null } | undefined
    if (prior && (prior.type === 'spec' || isSpecHeaderMarked(prior.body_head))) {
      effectiveValue = Object.assign({}, value, { type: 'spec' })
    }
  }
  const assignments = ROW_COLUMNS.map(([, column]) => `${column} = ?`).join(', ')
  const params = ROW_COLUMNS.map(([field]) => sqlRowValue(field, effectiveValue[field]))
  db.prepare(
    `UPDATE issue SET ${assignments}, last_seen_ms = ? WHERE issue_id = ?`,
  ).run(...params, nowMs, issueId)
}

/** truncated 的 row：只补当前为 NULL 的列。COALESCE 让已有的值原样保留。 */
export function fillIssueRow(
  db: DatabaseSync,
  issueId: number,
  value: IssueRowValue,
  nowMs: number,
): void {
  const provided = pickPresentFields(value)
  const entries = ROW_COLUMNS.filter(([field]) => provided[field] !== undefined)
  if (entries.length === 0) {
    db.prepare('UPDATE issue SET last_seen_ms = ? WHERE issue_id = ?').run(nowMs, issueId)
    return
  }
  const assignments = entries.map(([, column]) => `${column} = COALESCE(${column}, ?)`).join(', ')
  const params = entries.map(([field]) => sqlRowValue(field, provided[field]))
  db.prepare(
    `UPDATE issue SET ${assignments}, last_seen_ms = ? WHERE issue_id = ?`,
  ).run(...params, nowMs, issueId)
}

/** 布尔在 STRICT 表里只收 0/1；null 继续表示没有值。 */
function sqlRowValue(
  field: keyof IssueRowValue,
  value: IssueRowValue[keyof IssueRowValue],
): null | number | string {
  if (value === undefined || value === null) return null
  if (field === 'isPullRequest') return value ? 1 : 0
  return value as number | string
}
