// src/deck/shell/map-close-guard.ts —— 关探索地图前的交棒护栏（#131）
// 门禁归属: tests/verify-131-map-handoff-guard.ts
//
// 探索地图（wayfinder:map）负责扫清决策迷雾，不直接承担代码实施：当全部探索子票关闭后，
// 常规路径是保持探索地图处于开放状态，交由用户在右侧面板点击「生成规格」运行 /to-spec 生成规格容器。
// 如果没有这道护栏，AI 在关完最后一张探索子票后会顺手调 deck_issue_patch(close: true) 把整张地图关掉，
// 导致工作区尚未生成规格时右侧面板直接变空。
//
// 因此关闭探索地图前按顺序过三道闸：
//   1) 探索子票（不含下挂的 spec 容器）必须全部关闭；还有未关探索子票时整笔拒绝并列出缺口；
//   2) 若地图下尚未挂接任何规格容器（spec），不允许无理由顺手关图：必须在同一次调用里传入非空的 closeReason，
//      明确写出「纯调研无需生成规格」的结项理由或「本地 Markdown 已在独立目录生成规格」的交棒去向
//      （本地 Markdown 的 map.md 没有评论段，closeReason 对所有后端都可传）；
//   3) 若地图下已挂接规格容器（spec），须在同一次调用里带一条 comment（或 closeReason）记下交棒收口结论才放行关闭。
import { childrenOf } from './edge-landing.js'
import { markerKindInHeader } from '../../shared/issue-file/src/marker.js'
import type { SpecCloseTracker } from './spec-close-guard.js'

type ContractReply = { ok?: boolean; data?: unknown; error?: { message?: unknown; kind?: unknown } } | null | undefined

export type MapCloseGuardResult =
  | { kind: 'not-map' }
  | { kind: 'ok' }
  | { kind: 'timeout'; message: string }
  | { kind: 'refuse'; rule: string; text: string; data: Record<string, unknown>; reads: number }

function timeoutOf(reply: ContractReply): string | null {
  const e = reply && reply.error
  if (e && e.kind === 'timeout') return String(e.message || '执行层没回来')
  return null
}

function errorText(reply: ContractReply): string {
  return String((reply && reply.error && reply.error.message) || '后端没给出原因').slice(0, 200)
}

/** 判一张票是不是探索地图：契约归一层标了 type='map'，或标签里带 wayfinder:map（规格容器已在前序闸单独处理，这里显式排除）。 */
export function isExplorationMapRecord(data: Record<string, unknown>): boolean {
  if (String(data.type || '') === 'spec' || markerKindInHeader(String(data.body || '')) === 'spec') return false
  if (String(data.type || '').toLowerCase() === 'map') return true
  const labels = Array.isArray(data.labels) ? data.labels : []
  return labels.some((raw) => {
    const name = raw && typeof raw === 'object' ? String((raw as { name?: unknown }).name || '') : String(raw || '')
    return name.trim().toLowerCase() === 'wayfinder:map'
  })
}

function isSpecChildRow(row: Record<string, unknown>): boolean {
  return String(row.type || '').toLowerCase() === 'spec' || markerKindInHeader(String(row.body || '')) === 'spec'
}

export async function mapCloseGuard(input: {
  tracker: SpecCloseTracker
  repo: unknown
  key: string
  opCtx: unknown
  hasComment: boolean
  hasCloseReason: boolean
  /** 前序 specCloseGuard 已读回的目标票对象；传入时直接复用，避免普通票关票时多发一次 get 请求。 */
  target?: Record<string, unknown> | null
}): Promise<MapCloseGuardResult> {
  const t = input.tracker
  const key = input.key
  let data: Record<string, unknown>
  let baseReads = 1
  if (input.target && typeof input.target === 'object') {
    data = input.target
  } else {
    const rawSelf = await t.get(input.repo, key, {}, input.opCtx)
    const selfTimeout = timeoutOf(rawSelf)
    if (selfTimeout) return { kind: 'timeout', message: selfTimeout }
    if (!rawSelf || rawSelf.ok !== true) {
      const msg = errorText(rawSelf)
      return {
        kind: 'refuse',
        rule: 'map-close-unreadable',
        text: '这张票没读回来（后端原话：' + msg + '）：判不了它是不是探索地图，先不关。等能读回再调一次。',
        data: { error: { message: msg } },
        reads: 1,
      }
    }
    data = (rawSelf.data && typeof rawSelf.data === 'object') ? rawSelf.data as Record<string, unknown> : {}
  }

  if (!isExplorationMapRecord(data)) return { kind: 'not-map' }

  const rawKids = await t.list(input.repo, { parentKey: key }, input.opCtx)
  const kidsTimeout = timeoutOf(rawKids)
  if (kidsTimeout) return { kind: 'timeout', message: kidsTimeout }
  if (!rawKids || rawKids.ok !== true) {
    const msg = errorText(rawKids)
    return {
      kind: 'refuse',
      rule: 'map-close-children-unreadable',
      text: '这张探索地图下面的子票清单没取到（后端原话：' + msg + '）：判不了子票与规格交棒状态，先不关。等能读回子票清单再调一次。',
      data: { error: { message: msg } },
      reads: baseReads + 1,
    }
  }

  const targetEffort = String(data.effortId || '')
  const directChildren = childrenOf(Array.isArray(rawKids.data) ? rawKids.data : [], key).children
    .map((c) => ((c && typeof c === 'object') ? c as Record<string, unknown> : {}))
    .filter((row) => {
      if (String(row.key || '') === String(key)) return false
      if (row.parentKey === undefined || row.parentKey === null || String(row.parentKey) !== String(key)) return false
      const childEffort = String(row.effortId || '')
      if (targetEffort && childEffort && childEffort !== targetEffort) return false
      return true
    })

  const specChildren = directChildren.filter((row) => isSpecChildRow(row))
  const explorationChildren = directChildren.filter((row) => !isSpecChildRow(row) && String(row.type || '').toLowerCase() !== 'map')

  const openKids = explorationChildren.filter((c) => String(c.state || '').toLowerCase() !== 'closed')
  if (openKids.length > 0) {
    const missing = openKids.map((c) => ({ key: String(c.key || ''), title: String(c.title || ''), state: String(c.state || '') }))
    return {
      kind: 'refuse',
      rule: 'map-close-children-open',
      text: '这张探索地图下面还有 ' + missing.length + ' 张探索子票没关：'
        + missing.map((m) => '#' + m.key + '（' + (m.title || '没标题') + '，当前 ' + (m.state || '未知') + '）').join('；')
        + '。探索子票没全关时不能关闭探索地图：请先把未完成的探索子票收敛关闭，再交棒 /to-spec。',
      data: { missing: missing },
      reads: baseReads + 1,
    }
  }

  if (specChildren.length === 0) {
    if (!input.hasCloseReason) {
      return {
        kind: 'refuse',
        rule: 'map-close-no-spec-handoff',
        text: '这张探索地图下面还没有挂接实施规格（spec）：探索子票全部关闭后请保持地图开放，交由用户在右侧面板点击「生成规格」运行 /to-spec，不要顺手把探索地图关掉。只有在「纯调研结论无需生成规格」或「本地 Markdown 已在独立规格目录生成规格」时，才允许在同一次调用里传入非空的 closeReason 写明结项原因或已交棒的规格位置后再关闭。',
        data: { hasSpec: false, hasComment: input.hasComment, hasCloseReason: input.hasCloseReason },
        reads: baseReads + 1,
      }
    }
    return { kind: 'ok' }
  }

  if (!input.hasComment && !input.hasCloseReason) {
    const specKeys = specChildren.map((s) => String(s.key || '')).filter(Boolean)
    return {
      kind: 'refuse',
      rule: 'map-close-no-comment',
      text: '关探索地图前必须在同一次调用里留一条 comment（或 closeReason）写明规格交棒与收口结论（已挂接规格：'
        + specKeys.map((k) => '#' + k).join('、')
        + '）：这次调用没带收口说明，关闭动作没做。请带上 comment 与 close:true 再调一次。',
      data: { hasSpec: true, specKeys: specKeys },
      reads: baseReads + 1,
    }
  }

  return { kind: 'ok' }
}
