/**
 * tests/verify-127-deleted-issue-tombstone.ts —— 后端已删工单在快照库落墓碑且刷新后不回退（#127）
 *
 * 守什么：
 *  A. 手动刷新（wf.refresh）或强制首屏在完整来源下，对库里原先为 open 但已不在远端工作集里的工单/规格、
 *     以及已不在远端已关闭地图集里的旧地图写入墓碑（issue_tombstone），且回包携带写库后的整数库版本号；
 *     随后的常规回放（readSnapshotReplay / wf.snapshot）不再把已删除工单重新画出来。
 *  B. 来源不完整（列表截断或 REST 降级）时严格遵守「只补不删」，绝不误写墓碑。
 *  C. 探针整仓完整枚举（fetchIssueIndex 在无 since 窗口且翻完所有页时）对库里缺席的全部非 PR 工单
 *     （含已关闭普通票）补齐墓碑，且 issue-index-scan 在 full=true 时以本次远端索引重置基线，不再并入旧键。
 *  D. readIssueIndex 直接从库行生成差分基线，包含已关闭容器下的已关闭子票，避免被组装层藏进 thinTickets 后
 *     在每拍探针里误判成「新增工单」触发无限重建循环。
 *
 * 运行：node --import ./scripts/ts-hook.mts tests/verify-127-deleted-issue-tombstone.ts
 */
// 门禁归属: src/refresh/rooms/host/snapshot-library.ts
// 门禁归属: src/refresh/rooms/host/snapshot-library-sync.ts
// 门禁归属: src/refresh/rooms/host/snapshot-library-first-screen.ts
// 门禁归属: src/refresh/rooms/host/session-refresh-schedule.ts
// 门禁归属: src/refresh/rooms/host/issue-list-fetch.ts
// 门禁归属: src/refresh/rooms/host/issue-index-scan.ts
// 门禁归属: src/host/tracker/snapshot.ts
// 门禁归属: src/host/tracker/snapshotWorkingSet.ts
// 门禁归属: src/refresh/rooms/client/snapshot-sync.ts
// 门禁归属: src/refresh/rooms/client/snapshot-cache-store.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { printGateResult } from './lib/gate-result.ts'
import { createSessionRefresh } from '../src/refresh/rooms/host/session-refresh-schedule.ts'
import { createIssueList } from '../src/refresh/rooms/host/issue-list-fetch.ts'
import * as snapshotLibrary from '../src/refresh/rooms/host/snapshot-library.ts'
import { createSnapshotEnvelope } from '../src/host/snapshotEnvelope.ts'
import type { Issue, RepositoryRef } from '../src/tracker/contract/entities.ts'

const GATE = 'verify-127-deleted-issue-tombstone'
const REF: RepositoryRef = {
  backend: 'github',
  refId: 'Darth-Acheron/dsh-mattpocock-skills-deck',
  name: 'dsh-mattpocock-skills-deck',
  url: 'https://github.com/Darth-Acheron/dsh-mattpocock-skills-deck',
}
const quiet = { fire: () => {}, isEnabled: () => false }

let total = 0
let failed = 0
function check(cond: unknown, message: string, detail?: unknown): void {
  total += 1
  if (cond) {
    console.log('PASS ' + message)
    return
  }
  failed += 1
  console.log('FAIL ' + message + (detail === undefined ? '' : '（实得 ' + JSON.stringify(detail) + '）'))
}

function issue(input: Partial<Issue> & { key: string; title: string }): Issue {
  return Object.assign({
    key: input.key,
    effortId: '',
    type: input.type || 'issue',
    title: input.title,
    state: input.state || 'open',
    body: '',
    url: 'https://github.com/Darth-Acheron/dsh-mattpocock-skills-deck/issues/' + input.key,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: input.updatedAt || '2026-11-14T00:00:00Z',
    closedAt: input.state === 'closed' ? '2026-11-14T00:00:00Z' : null,
    parentKey: input.parentKey === undefined ? null : input.parentKey,
    labels: input.labels || (input.type === 'map' ? [{ name: 'wayfinder:map', color: '5319e7' }] : []),
    assignees: [],
    blockedBy: [],
    isPullRequest: false,
  }, input)
}

function keysInSnapshot(snap: any): string[] {
  const keys = new Set<string>()
  for (const m of (snap?.maps || [])) {
    if (m?.key != null) keys.add(String(m.key))
    for (const t of (m?.tickets || [])) {
      if (t?.key != null) keys.add(String(t.key))
    }
  }
  for (const it of (snap?.issues || [])) {
    if (it?.key != null) keys.add(String(it.key))
  }
  return Array.from(keys).sort((a, b) => Number(a) - Number(b))
}

function depsFor(cwd: string, backendRows: Issue[], opts?: { truncated?: boolean }) {
  const table = new Map<string, any>()
  const adopt = (snap: unknown, c: string) => {
    table.set(c, { ts: Date.now(), snapshot: snap, error: null, cwd: c })
    return snap
  }
  const tracker = {
    list: async (_ref: any, filter: any) => {
      const wantState = filter?.state
      const data = backendRows
        .filter((r) => !wantState || r.state === wantState)
        .map((r) => Object.assign({}, r))
      return { ok: true, data, ...(opts?.truncated ? { truncated: true } : null) }
    },
    listPage: async (_ref: any, filter: any) => {
      let items = backendRows.slice()
      if (filter?.state) items = items.filter((r) => r.state === filter.state)
      if (Array.isArray(filter?.labels) && filter.labels.length > 0) {
        items = items.filter((r) => (r.labels || []).some((l: any) => filter.labels.includes(l.name)))
      }
      return { ok: true, data: { items: items.map((r) => Object.assign({}, r)), nextCursor: null, total: items.length } }
    },
    counts: async () => ({ ok: false, error: { kind: 'unsupported' } }),
    getCurrentUser: async () => ({ ok: true, data: { login: 'octo' } }),
  }
  const reg = { modules: () => [], describe: () => REF, get: () => tracker }
  return {
    canonicalKey: async () => cwd,
    selectEarly: async () => ({ backendId: 'github', rev: 1 }),
    isComposerSelection: () => true,
    getTrackerRegistry: async () => reg,
    getPlatform: async () => ({}),
    ctx: { get: () => null },
    getCache: (c: string) => table.get(String(c)) || { ts: 0, snapshot: null, error: null, cwd: String(c) },
    setCache: (v: any) => { if (v && v.cwd) table.set(String(v.cwd), v) },
    upcaseSnapStates: (s: any) => s,
    computeLevels: () => ({ byNumber: {}, byKey: {} }),
    groupTickets: (tickets: any[]) => ({
      total: tickets.length,
      open: tickets.filter((t) => String(t.state).toUpperCase() !== 'CLOSED').length,
      closed: tickets.filter((t) => String(t.state).toUpperCase() === 'CLOSED').length,
      frontier: 0, claimed: 0, blocked: 0, levels: [], levelOf: {},
    }),
    getRepoRoot: async () => cwd,
    getRepoKey: async () => ({ owner: 'Darth-Acheron', name: 'dsh-mattpocock-skills-deck' }),
    readDiskCache: async () => null,
    writeDiskCache: () => {},
    adoptSnapshot: adopt,
    detectionExec: async () => ({ ok: false }),
    resetGhCache: () => {},
    getGhPath: () => '',
    getGhLastError: () => '',
    errText: (e: any) => String((e && e.message) || e),
    logCtx: quiet,
    envelope: createSnapshotEnvelope({ getGhPath: () => '', getGhLastError: () => '', adoptSnapshot: adopt, logCtx: quiet }),
    getSnapshotLibrary: () => snapshotLibrary,
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verify-127-tombstone-'))
  try {
    mkdirSync(path.join(dir, 'docs', 'agents'), { recursive: true })
    writeFileSync(path.join(dir, 'docs', 'agents', 'workspace.yaml'), 'backend: github\n')

    const key = { workspaceRoot: dir, backend: 'github', repoIdentity: REF.refId }

    // ── A. 种子库含真实票（#1 已关闭地图、#2 开放工单、#50 已关闭普通票）与随后在后端被删的 #31（已关地图）、#33（开放规格）、#38（开放工单）
    const seeded = await snapshotLibrary.recordIssueRows(Object.assign({}, key, {
      atomic: true,
      rows: [
        issue({ key: '1', type: 'map', state: 'closed', title: '保留的已关闭地图 #1' }),
        issue({ key: '2', state: 'open', title: '保留的开放工单 #2' }),
        issue({ key: '31', type: 'map', state: 'closed', title: '已在后端删除的已关闭地图 #31' }),
        issue({ key: '33', type: 'spec', state: 'open', title: '已在后端删除的开放规格 #33' }),
        issue({ key: '38', state: 'open', title: '已在后端删除的开放工单 #38' }),
        issue({ key: '50', state: 'closed', title: '已在后端删除的已关闭普通票 #50（留待整仓枚举清理）' }),
      ],
    }))
    check(seeded.ok === true && typeof seeded.mergeVersion === 'number', 'A1 种子数据成功写入快照库', seeded)
    const vSeed = Number(seeded.mergeVersion)

    // B. 来源截断（不完整来源）时：绝不误删库里已有的 #31、#33、#38
    const truncRefresh = createSessionRefresh(depsFor(dir, [
      issue({ key: '1', type: 'map', state: 'closed', title: '保留的已关闭地图 #1' }),
      issue({ key: '2', state: 'open', title: '保留的开放工单 #2' }),
    ], { truncated: true }) as any)
    await truncRefresh.handleRefresh({ cwd: dir })
    const replayAfterTrunc = await snapshotLibrary.readSnapshotReplay(Object.assign({ repo: REF }, key))
    const keysAfterTrunc = keysInSnapshot(replayAfterTrunc?.snapshot)
    check(
      keysAfterTrunc.includes('33') && keysAfterTrunc.includes('38'),
      'B1 列表截断（来源不完整）时不给缺席的开放票写墓碑（只补不删）',
      keysAfterTrunc,
    )

    // A2. 完整来源下执行 wf.refresh：#31（已删地图）、#33（已删开放规格）、#38（已删开放工单）必须被落墓碑清除
    const fullRefresh = createSessionRefresh(depsFor(dir, [
      issue({ key: '1', type: 'map', state: 'closed', title: '保留的已关闭地图 #1' }),
      issue({ key: '2', state: 'open', title: '保留的开放工单 #2' }),
    ]) as any)
    const refreshReply: any = await fullRefresh.handleRefresh({ cwd: dir })
    const refreshKeys = keysInSnapshot(refreshReply)
    check(refreshKeys.join(',') === '1,2', 'A2 手动刷新当次返回只含真实存在的 #1 与 #2（#31 不从 previousMaps 带回）', refreshKeys)
    check(typeof refreshReply?.version === 'number' && refreshReply.version > vSeed, 'A3 手动刷新回包携带推进后的整数库版本号', refreshReply?.version)

    const replayAfterRefresh = await snapshotLibrary.readSnapshotReplay(Object.assign({ repo: REF }, key))
    const replayKeysAfterRefresh = keysInSnapshot(replayAfterRefresh?.snapshot)
    check(
      !replayKeysAfterRefresh.includes('31') && !replayKeysAfterRefresh.includes('33') && !replayKeysAfterRefresh.includes('38')
        && replayKeysAfterRefresh.includes('1') && replayKeysAfterRefresh.includes('2') && replayKeysAfterRefresh.includes('50'),
      'A4 随后从快照库回放（wf.snapshot）不再复活已删除的 #31、#33、#38，且未误删已关闭普通票 #50',
      replayKeysAfterRefresh,
    )

    const changesAfterRefresh = await snapshotLibrary.readLibraryChangeSet(Object.assign({ sinceVersion: vSeed, maxRows: 0, maxAgeMs: 0 }, key))
    const missingAfterRefresh = ((changesAfterRefresh && !changesAfterRefresh.full ? changesAfterRefresh.missing : []) || []).map((m: any) => m.key).sort()
    check(
      missingAfterRefresh.join(',') === '31,33,38',
      'A5 变化集（readLibraryChangeSet）如实把 #31、#33、#38 作为墓碑删除（missing）交出',
      missingAfterRefresh,
    )

    // ── C. 探针整仓完整枚举（w.full === true）：清理包括已关闭普通票 #50 在内的所有已删非 PR 工单，且重置索引基线
    const liveBackendRows = [
      issue({ key: '1', type: 'map', state: 'closed', title: '保留的已关闭地图 #1', updatedAt: '2026-11-14T01:00:00Z' }),
      issue({ key: '2', state: 'closed', parentKey: '1', title: '已关闭地图 #1 下的已关闭子票 #2', updatedAt: '2026-11-14T02:00:00Z' }),
    ]
    const session = {
      listPage: async (_ref: any, _filter: any) => ({
        ok: true,
        data: { items: liveBackendRows.map((r) => Object.assign({}, r)), nextCursor: null, total: liveBackendRows.length },
      }),
    }
    const issueList = createIssueList({
      getRepoKey: async () => ({ owner: 'Darth-Acheron', name: 'dsh-mattpocock-skills-deck' }),
      openSession: async () => ({
        ok: true,
        backendId: 'github',
        repoRef: REF,
        call: (fn: any) => fn(session, {}),
      }),
      onIssueRows: async (c: any, r: any, rows: any[], extra?: any) => snapshotLibrary.recordIssueRows(Object.assign({
        workspaceRoot: c,
        backend: String(r?.backend || 'github'),
        repoIdentity: String(r?.refId || REF.refId),
        rows,
      }, extra || {})),
      getSnapshotLibrary: () => snapshotLibrary,
      logCtx: quiet,
    })
    // 先直接调 fetchIssueIndex(dir, '') 跑一次完整枚举
    const fullIdxRes: any = await issueList.fetchIssueIndex(dir, '')
    check(fullIdxRes && fullIdxRes.ok === true && Object.keys(fullIdxRes.index).sort().join(',') === '1,2', 'C1 整仓枚举返回远端真实的 #1、#2', fullIdxRes?.index)

    const replayAfterFullEnum = await snapshotLibrary.readSnapshotReplay(Object.assign({ repo: REF }, key))
    const replayKeysAfterFullEnum = keysInSnapshot(replayAfterFullEnum?.snapshot)
    check(
      !replayKeysAfterFullEnum.includes('50') && replayKeysAfterFullEnum.includes('1'),
      'C2 整仓完整枚举后，库里已删除的已关闭普通票 #50 也被写入墓碑不再回放',
      replayKeysAfterFullEnum,
    )

    // ── D. readIssueIndex 包含已关闭容器（#1）下的已关闭子票（#2），不会因 thinTickets 隐藏而丢键
    const libIndex = await snapshotLibrary.readIssueIndex(key)
    check(
      libIndex !== null && Object.keys(libIndex).sort().join(',') === '1,2',
      'D1 readIssueIndex 包含已关闭容器 #1 及其已关闭子票 #2，与远端 listPage 基线一致',
      libIndex,
    )

    // C3. 窗口扫描入口（issue-index-scan）从快照库立起点后，基线包含 #1 与 #2，同一状态不再误报 changed
    const winRes: any = await issueList.fetchIssueIndexWindowed(dir, { commit: true, backendId: 'github' })
    check(
      winRes && winRes.ok === true && winRes.changed === false && Object.keys(winRes.index).sort().join(',') === '1,2',
      'C3 窗口扫描从库立起点时包含已关闭容器的已关闭子票 #2，稳态探测不再误报 changed',
      winRes,
    )
  } finally {
    snapshotLibrary.closeSnapshotLibraries()
    rmSync(dir, { recursive: true, force: true })
  }
  printGateResult(GATE, total, failed)
  if (failed > 0) process.exitCode = 1
}

main().catch((e) => {
  console.log('FAIL 门禁异常退出：' + ((e && e.stack) || e))
  printGateResult(GATE, total, failed + 1)
  process.exitCode = 1
})
