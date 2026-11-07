/**
 * src/tracker/rooms/yunxiao/issues/idempotency.ts —— Yunxiao Projex 建票幂等锚回查（规格 #03）。
 *
 * 契约要求（#711）：
 *   1. 同一个 idempotencyKey 提交两次，只创建一张工作项并返回同一个纯数字 key；
 *   2. 回查唯一证据是远端工作项票面 description 文件头中的 <!-- DSH-IDEMPOTENCY-KEY: <key> -->，
 *      绝不只信本进程内存；
 *   3. 回查路径失败或超过扫描上限拿不准时，如实返回 stage: ANCHOR_LOOKUP 失败，绝不盲目建重复票。
 */

import { ERROR_KIND, STATE } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { Issue } from '../../../contract/entities.js'
import { TRACKER_ERROR_STAGE, type TrackerError } from '../../../contract/results.js'
import { PAGINATION } from '../../../contract/pagination.js'
import {
  anchorUnsupported,
  describeAnchorFailure,
  isAnchorHit,
  matchAnchor,
  type AnchorCandidate,
  type AnchorMatch,
} from '../../../../refresh/contract/idempotency-keys.js'
import { GITLAB_SLOW_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { classifyYunxiaoError, hintFor, type YunxiaoVerdict } from '../errors.js'
import { rememberYunxiaoIssueIdentity, withAnchor } from '../model/description-markers.js'
import { bodyOfWorkitem, deriveYunxiaoStateAndReason, normalizeYunxiaoIssue } from '../model/normalize.js'
import { requestWorkitemsSearch } from '../requests.js'
import {
  DEFAULT_WORKITEM_CATEGORIES,
  enrichWorkitemListDetails,
  errMsg,
  resolveProjectRef,
  type CtxLike,
  type RawBag,
  type RepoLike,
} from './shared.js'

const SCAN_LIMIT = PAGINATION.gitlab.anchorLookupScanLimit

/** 建票前幂等锚回查的三态返回：命中既有票、确认未建过或回查失败。 */
export type LookupByAnchorResult =
  | { ok: true; hit: false; reason: string }
  | { ok: true; hit: true; issue: Issue }
  | { ok: false; error: TrackerError }

function toCandidate(raw: RawBag, refId: string): AnchorCandidate | null {
  const key = rememberYunxiaoIssueIdentity(refId, {
    id: raw['id'],
    serialNumber: raw['serialNumber'],
    key: raw['key'],
  })
  if (!key) return null
  const body = bodyOfWorkitem(raw)
  const { state } = deriveYunxiaoStateAndReason(raw)
  return {
    key,
    body,
    state: state === STATE.CLOSED ? 'closed' : 'open',
    refId,
  }
}

function lookupFailure(
  verdict: YunxiaoVerdict | null | undefined,
  message: string,
  raw: string,
): { ok: false; error: TrackerError } {
  const native = '带锚创建的回查没能做成：' + String(message || '原因不明').slice(0, 500) + '。这一次没有建票。'
  return {
    ok: false,
    error: {
      kind: (verdict && verdict.kind) || (ERROR_KIND.UNSUPPORTED as ErrorKind),
      message: hintFor(verdict, native),
      raw: String(raw || ''),
      stage: TRACKER_ERROR_STAGE.ANCHOR_LOOKUP,
    },
  }
}

/**
 * 建票前按幂等锚回查远端工作项。
 */
export async function lookupByAnchor(
  repo: RepoLike,
  key: string,
  opCtx: CtxLike | null | undefined,
): Promise<LookupByAnchorResult> {
  const proj = resolveProjectRef(repo)
  if (!proj) {
    return lookupFailure(
      { kind: ERROR_KIND.UNSUPPORTED as ErrorKind, fallback: false },
      '这个仓库的 refId 是空的或格式不对，回查无从做起',
      '',
    )
  }

  try {
    const res = await requestWorkitemsSearch(
      opCtx,
      proj.organizationId,
      {
        spaceId: proj.projectId,
        spaceType: 'Project',
        category: DEFAULT_WORKITEM_CATEGORIES,
        page: 1,
        perPage: SCAN_LIMIT,
        orderBy: 'gmtCreate',
        sort: 'desc',
      },
      GITLAB_SLOW_READ_TIMEOUT_MS,
    )

    if (!res.ok) {
      const reason = res.stderr || res.stdout || '搜索工作项列表失败'
      return lookupFailure(classifyYunxiaoError(res, opCtx ?? undefined), reason, reason)
    }
    if (!Array.isArray(res.data)) {
      return lookupFailure(
        { kind: ERROR_KIND.PARSE as ErrorKind, fallback: false },
        '工作项列表返回的不是数组',
        res.stdout,
      )
    }

    const rawRows = (res.data as unknown[]).filter(
      (r): r is RawBag => Boolean(r) && typeof r === 'object' && !Array.isArray(r),
    )
    const enrichedRows = await enrichWorkitemListDetails(opCtx, proj, rawRows)

    for (const raw of enrichedRows) {
      const cand = toCandidate(raw, proj.refId)
      if (!cand) continue
      const m = matchAnchor([cand], proj.refId, key) as unknown as AnchorMatch
      if (isAnchorHit(m)) {
        return { ok: true, hit: true, issue: normalizeYunxiaoIssue(raw, repo) }
      }
    }

    if (rawRows.length >= SCAN_LIMIT) {
      return lookupFailure(
        { kind: ERROR_KIND.UNSUPPORTED as ErrorKind, fallback: false },
        '按创建时间倒序看完了前 ' + String(SCAN_LIMIT) + ' 张工作项还没找到这个锚，这次不敢断定「还没建过」',
        'perPage=' + String(SCAN_LIMIT),
      )
    }

    const miss = matchAnchor([], proj.refId, key) as unknown as AnchorMatch
    return { ok: true, hit: false, reason: miss.reason }
  } catch (err: unknown) {
    const msg = errMsg(err)
    return lookupFailure(classifyYunxiaoError(err, opCtx ?? undefined), msg, msg)
  }
}

/** 生成带锚创建回查失败时的可读说明文本。 */
export function describeLookupFailure(match: AnchorMatch | null | undefined): string {
  return describeAnchorFailure(match || anchorUnsupported('回查没有做成'))
}

export { withAnchor }
export default { withAnchor, lookupByAnchor, describeLookupFailure }
