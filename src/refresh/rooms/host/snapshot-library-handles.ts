// src/refresh/rooms/host/snapshot-library-handles.ts —— 快照库句柄的缓存与开关（#1863 立起，#1888 拆出）
//
// 为什么单列：宿主侧的快照库门面（snapshot-library.ts）贴着 350 有效行上限，而 #1888 要往门面上
// 加「同步簿记读写、变化行提交、差分基线」四个口。句柄缓存这件事与那些新口无关，搬出来之后
// 门面只留业务读写，句柄这件事仍然只有一份实现。
//
// 约定（与搬出来之前逐字一致）：
//   1. 按 (工作区, 后端, 仓库身份) 懒开一个库句柄，最多同时留 MAX_HANDLES 个；淘汰时关掉最旧的。
//   2. 缓存句柄是为了让租约心跳与连接只建一次：每次请求都开/关库会让两个并发请求互相抢租约。
//   3. 日志出口由宿主注入；没注入就完全不记（与快照树 runtime/log.ts 的可选注入同一口径）。
/// <reference path="../../../workspace-snapshot/node-ambient.d.ts" />
import type {
  OpenWorkspaceSnapshotOptions,
  SnapshotBackend,
  WorkspaceSnapshotHandle,
} from '../../../workspace-snapshot/contract/types.js'
// 只读句柄重开的节流窗就取单写者租约的过期时长：租约不可能比这更快释放，节流比它短只是白费连接。
import { SNAPSHOT_LEASE_TTL_MS } from '../../../shared/time-config/src/values.js'

declare const process: { pid: number } | undefined

/** 快照树只暴露契约；开库这一句是本目录唯一一处动态 import 契约实现的地方。 */
async function openSnapshot(options: OpenWorkspaceSnapshotOptions): Promise<{ handle: WorkspaceSnapshotHandle }> {
  const mod = await import('../../../workspace-snapshot/contract/index.js')
  return mod.openWorkspaceSnapshot(options)
}

/** 同一工作区最多同时留几个库句柄；工作区一般只有一个，留 4 是给多仓库/多后端切换。 */
export const MAX_HANDLES = 4

/** 开库身份：三个格一起决定库文件与句柄，缺一个都会串工作区。 */
export interface SnapshotLibraryKey {
  workspaceRoot: string
  backend: string
  repoIdentity: string
}

interface HandleEntry {
  handle: WorkspaceSnapshotHandle
  key: string
  /** 上一次对只读句柄尝试重开抢租约的时刻；按租约 TTL 节流，避免每拍重开一个确实被占着的库。 */
  leaseRetryAtMs?: number
}

const handles = new Map<string, HandleEntry>()
let leaseSeq = 0

/** #1869：快照库四族事件（开库、租约、写入、损坏重建）的出口；由宿主装配时注入。 */
export type SnapshotLogSink = (level: string, event: string, fields: Record<string, unknown>) => void
let logSink: SnapshotLogSink | null = null

/** 接上日志出口。传 null 关掉（门禁与测试用）。 */
export function setSnapshotLogSink(sink: SnapshotLogSink | null): void {
  logSink = sink
}

function cacheKeyOf(input: SnapshotLibraryKey): string {
  return [input.workspaceRoot, input.backend, input.repoIdentity].join('\u0000')
}

export function supportedBackend(backend: string): backend is SnapshotBackend {
  return backend === 'github' || backend === 'gitlab' || backend === 'markdown'
}

/** 开一份新句柄；开不出来回 null（首屏不许因为库不可用而空，调用方会回落在线路径）。 */
async function openHandle(input: SnapshotLibraryKey, clock: () => number): Promise<WorkspaceSnapshotHandle | null> {
  try {
    leaseSeq += 1
    const pid = (typeof process !== 'undefined' && process) ? process.pid : 0
    const opened = await openSnapshot({
      workspaceRoot: input.workspaceRoot,
      // handleOf 已用 supportedBackend 挡过一道，这里后端必是三者之一；窄化只在 handleOf 作用域生效，故此处显式断言。
      backend: input.backend as SnapshotBackend,
      repoIdentity: input.repoIdentity,
      leaseOwner: 'refresh-' + pid + '-' + leaseSeq,
      now: clock,
      ...(logSink ? { logEvent: logSink as any } : null),
    })
    return opened.handle
  } catch (e) {
    return null
  }
}

/** 拿一个可用的句柄；开不出来回 null（首屏不许因为库不可用而空，调用方会回落在线路径）。
 * now 缺省用真实时钟；测试注入假时钟以便跨过租约 TTL 而不真等。 */
export async function handleOf(input: SnapshotLibraryKey, now?: () => number): Promise<WorkspaceSnapshotHandle | null> {
  if (!input.workspaceRoot || !supportedBackend(input.backend)) return null
  const clock = now ?? (() => Date.now())
  const key = cacheKeyOf(input)
  const hit = handles.get(key)
  if (hit) {
    // Map 的插入顺序当 LRU：每次命中挪到队尾。
    handles.delete(key)
    handles.set(key, hit)
    if (hit.handle.mode === 'writable') return hit.handle
    // 只读句柄：写者租约可能被上一个宿主实例占着（重载或崩溃）。租约最迟一个 TTL 后过期，
    // 上一进程关库也会立刻释放；但缓存若一直返回这份只读句柄，本进程就永远写不进库——
    // 刷新与写回执都被库层判 readonly，面板停在新票建出之前的旧数据（#128）。
    // 所以按租约 TTL 节流重开：重开会自动重抢租约，抢到就升级回可写，仍被占就继续只读。
    // 节流是为了不去每拍重开一个确实被别的活进程拿着的库——TTL 内重开也抢不到，白费连接。
    const t = clock()
    if (t - (hit.leaseRetryAtMs ?? 0) < SNAPSHOT_LEASE_TTL_MS) return hit.handle
    hit.leaseRetryAtMs = t
    const reopened = await openHandle(input, clock)
    if (reopened) {
      try { hit.handle.close() } catch (e) { /* 旧只读句柄关不掉也不影响新句柄 */ }
      hit.handle = reopened
    }
    return hit.handle
  }
  const opened = await openHandle(input, clock)
  if (!opened) return null
  while (handles.size >= MAX_HANDLES) {
    const oldestKey = handles.keys().next().value as string | undefined
    if (oldestKey === undefined) break
    const oldest = handles.get(oldestKey)
    handles.delete(oldestKey)
    try { if (oldest) oldest.handle.close() } catch (e) { /* 关不掉也不影响新句柄 */ }
  }
  handles.set(key, { handle: opened, key })
  return opened
}

/** 测试与进程收尾用：关掉所有缓存句柄；之后再用会重新开库。 */
export function closeSnapshotLibraries(): void {
  for (const entry of handles.values()) {
    try { entry.handle.close() } catch (e) { /* 幂等关闭 */ }
  }
  handles.clear()
}

/** 当前缓存的句柄数（测试断言句柄上限用）。 */
export function snapshotLibraryHandleCount(): number {
  return handles.size
}
