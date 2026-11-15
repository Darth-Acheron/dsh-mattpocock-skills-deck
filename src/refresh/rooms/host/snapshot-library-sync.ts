// src/refresh/rooms/host/snapshot-library-sync.ts —— 同步簿记、差分基线与「变化先落库」的库门面（#1888）
//
// 为什么单列：宿主侧门面（snapshot-library.ts）贴着 350 有效行上限；#1888 要给它加四个口，
// 而这四个口说的是同一件事 —— 行级增量要用的那三样（基线、簿记、变化行）都从库这一侧读写。
// 句柄缓存留在 snapshot-library-handles.ts，这里只做业务读写，不碰连接与租约。
//
// 三条不能改的约定：
//   1. 簿记不是数据：只写簿记不动合并版本；行与簿记要一起写时由 commitChangeRows 走一个事务。
//   2. 行级增量遇到 stale 就整批丢掉，**不重试**：stale 说明期间有更新的结果先落了地，
//      重试等于用旧读结果盖新数据。列表写入那条路会重试一次，两条路的语义本来就不同。
//   3. 差分基线用组装层的同一份口径（indexFromSnapshot + 库回放出来的快照），不另写一套
//      「哪些票算进索引」的规则：两套口径迟早会漂成「探测说变了、补行却按没变处理」。
import type { Issue } from '../../../tracker/contract/entities.js'
import type {
  IssueWrite,
  ListProjection,
  SyncBookkeeping,
  SyncBookkeepingResult,
  SyncBookkeepingWrite,
  WorkspaceSnapshotHandle,
} from '../../../workspace-snapshot/contract/types.js'
import { changeIssueWriteOf } from './snapshot-library-adapter.js'
import { handleOf, type SnapshotLibraryKey } from './snapshot-library-handles.js'

/** 读簿记时顺带交回的合并版本：行级增量发起时要拿它当 startMergeVersion。 */
export interface LibrarySyncState {
  state: SyncBookkeeping
  mergeVersion: number
}

/**
 * 读同步簿记与合并版本。库开不出来回 null（调用方据此决定「这一趟按失败处理」还是回落旧路），
 * 库在但读失败也回 null：读不出簿记就没法判断世代号，硬写下去只会把旧值盖到新值上。
 */
export async function readSyncState(input: SnapshotLibraryKey): Promise<LibrarySyncState | null> {
  const handle = await handleOf(input)
  if (!handle) return null
  try {
    return { state: handle.readSyncBookkeeping(), mergeVersion: handle.getMergeVersion() }
  } catch (e) {
    return null
  }
}

/**
 * 只写同步簿记（水印、世代号、待办），不碰数据。库开不出来回 null。
 * 给了 expectedGeneration 而库里世代号对不上时回 committed:false / stale，一个字节不改。
 */
export async function writeSyncState(
  input: SnapshotLibraryKey,
  write: SyncBookkeepingWrite,
): Promise<SyncBookkeepingResult | null> {
  const handle = await handleOf(input)
  if (!handle) return null
  try {
    return handle.writeSyncBookkeeping(write)
  } catch (e) {
    return null
  }
}

/**
 * 差分基线：库里那批行按组装层同一份口径压成「票号 → 状态|更新时间」。
 * 库为空（或开不出来）回 null —— 调用方据此整池，而不是拿一份空基线去判「票号都变了」。
 */
export async function readIssueIndex(input: SnapshotLibraryKey): Promise<Record<string, string> | null> {
  const handle = await handleOf(input)
  if (!handle) return null
  let projection: ListProjection
  try {
    projection = handle.readList({ state: 'all' })
  } catch (e) {
    return null
  }
  if (!projection || !projection.issues.length) return null
  try {
    const out: Record<string, string> = {}
    for (const item of projection.issues) {
      if (!item || !item.row || item.row.isPullRequest === true) continue
      const n = parseInt(String(item.key), 10)
      const k = !isNaN(n) ? String(n) : String(item.key || '')
      if (!k) continue
      const ms = item.row.updatedAtMs
      const iso = typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : ''
      out[k] = String(item.row.state || '').toUpperCase() + '|' + iso
    }
    return Object.keys(out).length ? out : null
  } catch (e) {
    return null
  }
}

/** 完整来源对账选项：指明本次列表覆盖了哪一类完整集合，缺席的旧行将写成墓碑。 */
export interface ReconcileScopeOptions {
  reconcileOpen?: boolean
  reconcileClosedMaps?: boolean
  reconcileAll?: boolean
  effortId?: string
}

/**
 * 在完整来源写入时，找出库里属于该完整集合但本次缺席的非 PR 工单，生成墓碑写入项（#127）。
 *
 * 为什么只在明确传入 reconcile* 时生成：常规分批写入或列表被截断/降级时来源不完整，必须遵守「只补不删」；
 * 只有调用方确认本次开放工作集、已关闭地图集或整仓枚举完整无截断时，缺席才代表在远端已不再属于该集合。
 */
export function reconcileMissingWrites(
  handle: WorkspaceSnapshotHandle,
  rows: readonly Issue[],
  opts: ReconcileScopeOptions,
): IssueWrite[] {
  if (!opts.reconcileOpen && !opts.reconcileClosedMaps && !opts.reconcileAll) return []
  let projection: ListProjection
  try {
    projection = handle.readList({ state: 'all' })
  } catch (e) {
    return []
  }
  if (!projection || !projection.issues.length) return []
  const seen = new Set<string>()
  for (const r of rows || []) {
    if (!r) continue
    const eff = String((r as any).effortId || '')
    const rawKey = String((r as any).key ?? (r as any).number ?? '')
    if (!rawKey) continue
    seen.add(eff + '\u0000' + rawKey)
    const n = parseInt(rawKey, 10)
    if (!isNaN(n)) seen.add(eff + '\u0000' + String(n))
  }
  const missing: IssueWrite[] = []
  for (const item of projection.issues) {
    if (!item || !item.row || item.row.isPullRequest === true) continue
    if (opts.effortId && item.effortId !== opts.effortId) continue
    const id1 = item.effortId + '\u0000' + item.key
    const n = parseInt(String(item.key), 10)
    const id2 = !isNaN(n) ? (item.effortId + '\u0000' + String(n)) : id1
    if (seen.has(id1) || seen.has(id2)) continue
    const st = String(item.row.state || '').toLowerCase()
    const hit = opts.reconcileAll === true
      || (opts.reconcileOpen === true && st === 'open')
      || (opts.reconcileClosedMaps === true && item.row.type === 'map' && st === 'closed')
    if (!hit) continue
    missing.push({
      effortId: item.effortId,
      key: item.key,
      groups: {
        row: {
          completeness: 'complete',
          value: null,
          source: 'refresh-list',
          operation: 'list',
        },
      },
    })
  }
  return missing
}

/**
 * 整仓完整枚举（无 since 窗口且翻完所有页）收尾对账：把库里存在但远端完整索引里已不存在的非 PR 工单写成墓碑（#127）。
 */
export async function reconcileFullEnumeration(
  input: SnapshotLibraryKey & { presentKeys: Record<string, unknown> | readonly string[]; effortId?: string },
): Promise<{ ok: boolean; marked: number; mergeVersion: number | null }> {
  const handle = await handleOf(input)
  if (!handle) return { ok: false, marked: 0, mergeVersion: null }
  const keys = Array.isArray(input.presentKeys)
    ? input.presentKeys
    : Object.keys((input.presentKeys as Record<string, unknown>) || {})
  const pseudoRows: Issue[] = keys.map((k) => ({
    key: String(k),
    effortId: String(input.effortId || ''),
  } as Issue))
  const writes = reconcileMissingWrites(handle, pseudoRows, {
    reconcileAll: true,
    effortId: input.effortId,
  })
  if (!writes.length) return { ok: true, marked: 0, mergeVersion: handle.getMergeVersion() }
  let res = handle.ingest({ startMergeVersion: handle.getMergeVersion(), writes })
  if (!res.committed && res.reason === 'stale') {
    res = handle.ingest({ startMergeVersion: handle.getMergeVersion(), writes })
  }
  if (!res.committed) return { ok: false, marked: 0, mergeVersion: null }
  return { ok: true, marked: writes.length, mergeVersion: res.mergeVersion }
}

/** 一批变化行 + 簿记的提交输入。rows 是假后端交回来的 tracker 票（适配层换算成组写入）。 */
export interface ChangeRowsInput extends SnapshotLibraryKey {
  rows: Issue[]
  /** 这一趟发起时读到的合并版本；版本门拿它判「期间有没有别人先提交」。 */
  startMergeVersion: number
  /** 与行同一个事务写下的同步簿记；不给就只写行。 */
  sync?: SyncBookkeepingWrite
  /** 行写入的来源与操作名，只进排查记录（缺省 refresh-patch / probe）。 */
  operation?: string
}

/** 变化行提交的回执。ok 为真才该更新界面；stale 表示这一趟已被更新的结果顶掉。 */
export interface ChangeRowsResult {
  ok: boolean
  rows: number
  mergeVersion: number | null
  /** 与行同一个事务写下的簿记（这一批给了 sync 才有）。 */
  sync?: SyncBookkeeping | null
  /** 失败原因：unavailable（库开不出来）/ stale（版本或世代门）/ 其余是事务失败的原话代号。 */
  reason?: string
}

/**
 * 后台探测补到的变化：先写进库、再交给调用方去更新界面（#1888 的核心一句）。
 *
 * 行与簿记在同一个事务里：行写进去了、水印与世代号却没写，下一拍会重扫；簿记走了、行没进去，
 * 界面又会拿到一份不满意的结果。两样一起提交，才谈得上「库是唯一真相」。
 * stale 不重试（见文件头第 2 条）：这不是失败，是「这一份结果已经过期」，调用方该原样丢掉。
 */
export async function commitChangeRows(input: ChangeRowsInput): Promise<ChangeRowsResult> {
  const handle = await handleOf(input)
  if (!handle) return { ok: false, rows: 0, mergeVersion: null, reason: 'unavailable' }
  const operation = String(input.operation || 'probe')
  const writes = (Array.isArray(input.rows) ? input.rows : [])
    .filter((issue) => !!issue && issue.key != null)
    .map((issue) => changeIssueWriteOf(issue, operation, input.backend))
  if (!writes.length && !input.sync) return { ok: true, rows: 0, mergeVersion: null }
  let result
  try {
    result = handle.ingest({
      startMergeVersion: Number(input.startMergeVersion) || 0,
      writes,
      ...(input.sync ? { sync: input.sync } : null),
    })
  } catch (e) {
    return { ok: false, rows: 0, mergeVersion: null, reason: 'ingest-threw' }
  }
  if (!result.committed) return { ok: false, rows: 0, mergeVersion: null, reason: result.reason || 'write-failed' }
  return {
    ok: true,
    rows: writes.length,
    mergeVersion: result.mergeVersion,
    sync: result.sync || null,
  }
}
