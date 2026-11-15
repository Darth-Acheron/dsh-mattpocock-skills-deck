/**
 * tests/verify-128-lease-readonly-recover.ts —— 只读快照句柄在租约释放后必须能恢复可写（#128）
 *
 * 守什么：宿主进程重载时，新进程开工作区快照库可能撞上「上一个进程还拿着写者租约」，
 * 于是退回只读并把这份只读句柄缓存起来。租约最迟 15 秒（TTL）后过期、或上一进程关库释放，
 * 但缓存若一直返回这份只读句柄，本进程就永远写不进库——刷新与写回执都被库层判 readonly，
 * 面板停在新票建出之前的旧数据（dci-agent-bill 2026-11-15 实测卡了约 83 分钟）。
 * 这扇门禁打在句柄缓存的真实接缝 handleOf 上，逐条证明：
 *   A 上一进程关库释放租约后，handleOf 重开升级回可写，新票写得进库；
 *   B 上一进程没关库（崩溃）但租约已过期，handleOf 同样能接手升级回可写；
 *   C 租约确实被别的活进程拿着时，按 TTL 节流：到点重开一次（仍只读），TTL 内不再重开（不抖）；
 *   D 可写句柄照常缓存复用，不被这次改动误伤。
 *
 * 为什么用真库 + 假时钟：租约过期与重开只有真 SQLite 才有；时钟注入让 TTL 边界不用真等 15 秒。
 * 临时目录用 os.tmpdir()（避开本仓 workspace.yaml 的向上认根），每趟结束删干净。
 *
 * 运行：node --import ./scripts/ts-hook.mts tests/verify-128-lease-readonly-recover.ts
 */
// 门禁归属: src/refresh/rooms/host/snapshot-library-handles.ts

import { mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { printGateResult } from './lib/gate-result.ts'
import { openWorkspaceSnapshot } from '../src/workspace-snapshot/contract/index.ts'
import { SNAPSHOT_LEASE_TTL_MS } from '../src/shared/time-config/src/values.ts'
import {
  handleOf,
  closeSnapshotLibraries,
  setSnapshotLogSink,
  snapshotLibraryHandleCount,
} from '../src/refresh/rooms/host/snapshot-library-handles.ts'

const GATE = 'verify-128-lease-readonly-recover'
const CLOCK = 1762300000000
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

/** 一趟一个临时工作区根与注入时钟；时钟可前进，用来跨过租约 TTL 而不真等。 */
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deck-lease-128-'))
  let currentTime = CLOCK
  const clock = () => currentTime
  const key = { workspaceRoot: dir, backend: 'github', repoIdentity: 'Darth-Acheron/dci-agent-bill' }
  return {
    dir,
    key,
    clock,
    advance: (ms: number) => { currentTime += ms },
    now: () => currentTime,
  }
}

async function main(): Promise<void> {
  setSnapshotLogSink(null)

  // ── A 上一进程关库释放租约：只读句柄必须升级回可写，新票写得进 ─────────────────────────────
  {
    const f = fixture()
    try {
      const old = openWorkspaceSnapshot({ ...f.key, leaseOwner: 'refresh-OLD-A', now: f.clock })
      check(old.mode === 'writable', 'A0 上一进程先开库拿到写租约（可写）', old.mode)
      const h1: any = await handleOf(f.key, f.clock)
      check(h1 && h1.mode === 'readonly', 'A1 租约被占时新进程经 handleOf 退回只读', h1 && h1.mode)
      old.handle.close() // 上一进程退出，释放租约
      f.advance(SNAPSHOT_LEASE_TTL_MS + 1)
      const h2: any = await handleOf(f.key, f.clock)
      check(h2 && h2.mode === 'writable', 'A2 租约释放后 handleOf 重开升级回可写（不再永久只读）', h2 && h2.mode)
      check(h2 !== h1, 'A3 恢复用的是重开的新句柄，不是原来那份只读句柄', { same: h2 === h1 })
      const res = h2.ingest({ startMergeVersion: h2.getMergeVersion(), writes: [] })
      check(res.committed === true, 'A4 恢复可写后新票写得进库（面板能看到新票）', res)
    } finally {
      closeSnapshotLibraries()
      rmSync(f.dir, { recursive: true, force: true })
    }
  }

  // ── B 上一进程没关库（崩溃）但租约已过期：同样能接手 ────────────────────────────────────────
  {
    const f = fixture()
    try {
      const old = openWorkspaceSnapshot({ ...f.key, leaseOwner: 'refresh-OLD-B', now: f.clock })
      const h1: any = await handleOf(f.key, f.clock)
      check(h1 && h1.mode === 'readonly', 'B1 租约被占时退回只读', h1 && h1.mode)
      f.advance(SNAPSHOT_LEASE_TTL_MS + 1) // 不关 old，只让它的租约过期
      const h2: any = await handleOf(f.key, f.clock)
      check(h2 && h2.mode === 'writable', 'B2 上一进程崩溃、租约过期后 handleOf 接手升级回可写', h2 && h2.mode)
      old.handle.close()
    } finally {
      closeSnapshotLibraries()
      rmSync(f.dir, { recursive: true, force: true })
    }
  }

  // ── C 租约确实被别的活进程拿着：按 TTL 节流，到点重开一次，TTL 内不抖 ──────────────────────────
  {
    const f = fixture()
    try {
      const old = openWorkspaceSnapshot({ ...f.key, leaseOwner: 'refresh-OLD-C', now: f.clock })
      const h1: any = await handleOf(f.key, f.clock)
      check(h1 && h1.mode === 'readonly', 'C1 租约被占时退回只读', h1 && h1.mode)
      // 首次命中只读句柄：距上次重试（初始 0）已超过 TTL → 重开一次；租约仍被占 → 仍只读。
      const h2: any = await handleOf(f.key, f.clock)
      check(h2 && h2.mode === 'readonly' && h2 !== h1, 'C2 到点重开一次但租约仍被占：仍只读、换了新句柄', { mode: h2 && h2.mode, same: h2 === h1 })
      // TTL 内再问：节流，直接返回缓存句柄，不再重开。
      const h3: any = await handleOf(f.key, f.clock)
      check(h3 === h2, 'C3 TTL 内再问命中缓存、不重开（不抖）', { same: h3 === h2 })
      check(snapshotLibraryHandleCount() === 1, 'C4 同一工作区缓存里始终只留一个句柄', snapshotLibraryHandleCount())
      old.handle.close()
    } finally {
      closeSnapshotLibraries()
      rmSync(f.dir, { recursive: true, force: true })
    }
  }

  // ── D 可写句柄照常缓存复用：不被这次改动误伤 ────────────────────────────────────────────────
  {
    const f = fixture()
    try {
      const h1: any = await handleOf(f.key, f.clock)
      check(h1 && h1.mode === 'writable', 'D1 无竞争时开库即可写', h1 && h1.mode)
      const h2: any = await handleOf(f.key, f.clock)
      check(h2 === h1, 'D2 可写句柄命中缓存原样复用（不重开）', { same: h2 === h1 })
    } finally {
      closeSnapshotLibraries()
      rmSync(f.dir, { recursive: true, force: true })
    }
  }

  console.log('')
  console.log(failed ? '存在失败 — ' + GATE + ' 未通过' : '全部通过 — 只读句柄租约恢复门禁生效（' + total + ' 项断言）')
  printGateResult(GATE, total, failed)
  process.exit(failed ? 1 : 0)
}

main()
