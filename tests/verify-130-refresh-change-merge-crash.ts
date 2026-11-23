/**
 * tests/verify-130-refresh-change-merge-crash.ts —— 刷新后增量变化集合并子票缺省字段、无正文列表保留规格类型与面板会话级错误边界门禁（#130）
 *
 * 守什么：
 *   A 客户端变化集合并（applySnapshotChangeSet）将新子票（place: 'child'）或从顶层 issues 迁入容器的子票并入 map.tickets 时，
 *     即使库里 blockedBy 组为 unknown（changeRowPatch 不写 blockedBy），落进 map.tickets 的子票也必须补齐 blockedBy: [] 等默认字段，
 *     且从 issues 迁入时保留先前已知的 labels/assignees，随后喂给 store-derived 的 compute(st) 零异常分桶；
 *     同一批变化里子票排在父容器之前（按更新时间倒序）时，先落容器再落子票，子票准确挂入父容器 tickets；
 *   B 快照库（openWorkspaceSnapshot）写入带规格标记正文的 spec 容器后，后续无正文的列表扫描（row=complete、type='issue'、body 未表达）
 *     绝不把库内 spec 降级覆盖回 issue；即便旧库中 issue.type 已被写成 'issue' 而 issue_body 含规格标记，readList 与 readChangeSet
 *     仍按规格容器投影并把子票标为 place: 'child'；
 *   C DeckSidebarTab 内置会话级错误边界（getDeckPanelBoundary）：当单个工作区会话渲染抛错时，异常被拦在插件面板内部并给出重试按钮，
 *     绝不穿透到宿主 SlotErrorBoundary 触发 sidebar.right.pane.tab 全局退位，切换到其它会话/工作区照常显示面板，点重试可原地恢复。
 *
 * 运行：node --import ./scripts/ts-hook.mts tests/verify-130-refresh-change-merge-crash.ts
 */
// 门禁归属: src/refresh/rooms/client/snapshot-change-merge.ts
// 门禁归属: src/client/kernel/store-derived.ts
// 门禁归属: src/workspace-snapshot/persistence/issue-row-write.ts
// 门禁归属: src/workspace-snapshot/persistence/issue-body-write.ts
// 门禁归属: src/workspace-snapshot/projection/list.ts
// 门禁归属: src/workspace-snapshot/projection/edges.ts
// 门禁归属: src/refresh/rooms/host/snapshot-library-adapter.ts
// 门禁归属: src/client/kernel/router.ts

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React from 'react'
import * as ReactDOMClient from 'react-dom/client'
import { act } from 'react'
import { JSDOM } from 'jsdom'
import { printGateResult } from './lib/gate-result.ts'
import { spliceableJs } from './lib/source-text.ts'
import { compileFn } from './lib/eval-probe.ts'
import { applySnapshotChangeSet } from '../src/refresh/rooms/client/snapshot-change-merge.ts'
import { snapshotRowFieldsOf } from '../src/shared/snapshot-row-fields.ts'
import { openWorkspaceSnapshot } from '../src/workspace-snapshot/contract/index.ts'
import { issueWritesOf, receiptIssueWriteOf } from '../src/refresh/rooms/host/snapshot-library-adapter.ts'

const GATE = 'verify-130-refresh-change-merge-crash'
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

function idOf(row: any): string {
  const eff = String((row && row.effortId) || '')
  const k = String((row && (row.key != null ? row.key : row.number)) || '')
  return eff ? eff + '#' + k : k
}

async function main(): Promise<void> {
  // 挂载 store-derived 所需的闭包身份辅助函数
  const G: any = globalThis as any
  G.effortOf = (x: any) => String((x && x.effortId) || '')
  G.idOfParts = (eff: any, k: any) => (eff ? String(eff) + '#' + String(k) : String(k))
  G.idOf = idOf
  G.normIdentityKey = (k: any) => String(k == null ? '' : k).replace(/^0+(?=\d)/, '')
  G.refKeyOf = (b: any) => String((b && typeof b === 'object' ? (b.key != null ? b.key : b.number) : b) || '')

  const storeDerived: any = await import('../src/client/kernel/store-derived.ts')

  // ── A. 客户端增量合并（putChild / putMap）+ store-derived compute 零异常验证 ──
  {
    const initialSnapshot = {
      ok: true,
      maps: [
        {
          key: '27',
          number: 27,
          effortId: '',
          type: 'spec',
          title: '规格 #27：待导入数据文件执行计划',
          state: 'OPEN',
          tickets: [],
          sections: {},
        },
      ],
      issues: [
        {
          key: '28',
          number: 28,
          effortId: '',
          type: 'issue',
          title: '导入 DDC006 明细',
          state: 'OPEN',
          labels: [{ name: 'ready-for-agent', color: '0e8a16' }],
          assignees: [{ login: 'alice' }],
        },
      ],
      thinTickets: [],
    }

    // 模拟 5 秒后 wf.snapshotChanges 返回：#28 与新增 #29 的 blockedBy 组均为 unknown，且 #28 的 labels/assignees 为 unknown
    const change28 = {
      effortId: '',
      key: '28',
      row: { type: 'issue', title: '导入 DDC006 明细', state: 'open', url: '', createdAtMs: 1000, updatedAtMs: 2000, closedAtMs: null, isPullRequest: false, commentCount: 0 },
      labels: [],
      assignees: [],
      parents: ['27'],
      blockedBy: [],
      groups: {
        row: { completeness: 'complete' },
        labels: { completeness: 'unknown' },
        assignees: { completeness: 'unknown' },
        parents: { completeness: 'complete' },
        blockedBy: { completeness: 'unknown' },
      },
      placement: { place: 'child', containerEffortId: '', containerKey: '27' },
    }
    const change29 = {
      effortId: '',
      key: '29',
      row: { type: 'issue', title: '导入 DDC010 明细', state: 'open', url: '', createdAtMs: 1000, updatedAtMs: 3000, closedAtMs: null, isPullRequest: false, commentCount: 0 },
      labels: [{ name: 'ready-for-agent', color: '0e8a16' }],
      assignees: [],
      parents: ['27'],
      blockedBy: [],
      groups: {
        row: { completeness: 'complete' },
        labels: { completeness: 'complete' },
        assignees: { completeness: 'complete' },
        parents: { completeness: 'complete' },
        blockedBy: { completeness: 'unknown' },
      },
      placement: { place: 'child', containerEffortId: '', containerKey: '27' },
    }

    const merged = applySnapshotChangeSet(initialSnapshot, [change28, change29], [], {
      idOf,
      rowFieldsOf: snapshotRowFieldsOf,
    })
    check(!!merged && merged.snapshot.maps[0].tickets.length === 2, 'A1 变化集合并后两张子票均挂入规格 #27 的 tickets', merged?.snapshot.maps[0].tickets)

    const t28 = merged!.snapshot.maps[0].tickets[0]
    const t29 = merged!.snapshot.maps[0].tickets[1]
    check(
      Array.isArray(t28.blockedBy) && t28.blockedBy.length === 0 && Array.isArray(t29.blockedBy) && t29.blockedBy.length === 0,
      'A2 blockedBy 组为 unknown 的新子票并入 map.tickets 时自动补齐 blockedBy: []，不为 undefined',
      { t28BlockedBy: t28.blockedBy, t29BlockedBy: t29.blockedBy },
    )
    check(
      Array.isArray(t28.labels) && t28.labels.length === 1 && t28.labels[0].name === 'ready-for-agent' && t28.claimedBy === 'alice',
      'A3 从顶层 issues 迁入容器 tickets 的子票保留先前已知的 labels 与 assignees（claimedBy=alice）',
      { labels: t28.labels, claimedBy: t28.claimedBy },
    )

    let computeGroups: any = null
    let computeErr: any = null
    try {
      computeGroups = storeDerived.compute({ snapshot: merged!.snapshot })
    } catch (e) {
      computeErr = e
    }
    check(
      computeErr === null && Array.isArray(computeGroups) && computeGroups.length === 1,
      'A4 合并后的快照喂给 compute(st) 不抛 TypeError（彻底消除 reading some 崩溃）',
      computeErr ? String(computeErr) : computeGroups?.length,
    )
    check(
      computeGroups && computeGroups[0].claimed.length === 1 && computeGroups[0].frontier.length === 1,
      'A5 compute(st) 准确将 #28 分入 claimed、将 #29 分入 frontier',
      computeGroups ? { claimed: computeGroups[0].claimed.length, frontier: computeGroups[0].frontier.length } : null,
    )

    // 同一批变化中子票（updatedAt 更新）排在父容器之前到达时，先落容器再落子票
    const childBeforeMapChanges = [
      {
        effortId: '',
        key: '51',
        row: { type: 'issue', title: '新规格下的子票 #51', state: 'open', url: '', createdAtMs: 1000, updatedAtMs: 5000, closedAtMs: null, isPullRequest: false, commentCount: 0 },
        labels: [],
        assignees: [],
        parents: ['50'],
        blockedBy: [],
        groups: { row: { completeness: 'complete' }, blockedBy: { completeness: 'unknown' } },
        placement: { place: 'child', containerEffortId: '', containerKey: '50' },
      },
      {
        effortId: '',
        key: '50',
        row: { type: 'spec', title: '新规格 #50', state: 'open', url: '', createdAtMs: 1000, updatedAtMs: 4000, closedAtMs: null, isPullRequest: false, commentCount: 0 },
        labels: [],
        assignees: [],
        parents: [],
        blockedBy: [],
        groups: { row: { completeness: 'complete' } },
        placement: { place: 'map', parentPlace: 'detached' },
      },
    ]
    const mergedOrder = applySnapshotChangeSet({ ok: true, maps: [], issues: [], thinTickets: [] }, childBeforeMapChanges, [], {
      idOf,
      rowFieldsOf: snapshotRowFieldsOf,
    })
    const spec50 = mergedOrder?.snapshot.maps.find((m: any) => m.key === '50')
    check(
      !!spec50 && spec50.tickets.length === 1 && spec50.tickets[0].key === '51' && Array.isArray(spec50.tickets[0].blockedBy),
      'A6 同批变化中子票排在新容器之前时，先落容器再落子票，子票准确进入新容器 tickets 且带 blockedBy: []',
      spec50,
    )
  }

  // ── B. 快照库无正文列表扫描不降级已有 spec 容器 + 已有 spec 正文自愈投影 ──
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-130-db-'))
  try {
    const dbPath = path.join(tmpDir, 'github.sqlite')
    const opened = openWorkspaceSnapshot({
      workspaceRoot: tmpDir,
      backend: 'github',
      repoIdentity: 'Darth-Acheron/dci-agent-bill',
      dbPath,
      now: () => 1700000000000,
    })
    const handle = opened.handle

    // 1) 建票写回执：写入规格 #27（含 <!-- DSH-ISSUE-KIND: spec --> 正文）及子票 #28（挂父 #27）
    const specReceipt = receiptIssueWriteOf({
      key: '27',
      number: 27,
      effortId: '',
      type: 'issue' as any, // 即使调用方传了泛化 issue，只要正文头含 spec 标记也应识别为 spec
      title: '规格：FY27Q1 待导入数据文件执行计划',
      state: 'open',
      body: '<!-- DSH-IDEMPOTENCY-KEY: deck-1 -->\n<!-- DSH-ISSUE-KIND: spec -->\n## 目的\n\n测试规格容器。\n',
      url: 'https://github.com/Darth-Acheron/dci-agent-bill/issues/27',
      createdAt: '2026-11-15T10:00:00Z',
      updatedAt: '2026-11-15T10:00:00Z',
      labels: [],
      assignees: [],
    } as any, 'create', 'github')
    const childReceipt = receiptIssueWriteOf({
      key: '28',
      number: 28,
      effortId: '',
      type: 'issue',
      title: '导入 [DDC006.FYQ127.xlsx]：费用明细',
      state: 'open',
      body: '<!-- DSH-ISSUE-KIND: spec-ticket -->\n',
      url: 'https://github.com/Darth-Acheron/dci-agent-bill/issues/28',
      createdAt: '2026-11-15T10:01:00Z',
      updatedAt: '2026-11-15T10:01:00Z',
      parentKey: '27',
      labels: [{ name: 'ready-for-agent', color: '0e8a16' }],
      assignees: [],
      blockedBy: [{ key: '26', effortId: '' }],
    } as any, 'create', 'github')

    const r1 = handle.ingest({ startMergeVersion: handle.getMergeVersion(), kind: 'receipt', writes: [specReceipt, childReceipt] })
    check(r1.committed === true, 'B1 规格 #27 与子票 #28 写回执成功入库', r1)

    // 2) 模拟周期性无正文列表扫描（listPage 不带 body、不带 parentKey，parents 与 dependencies 均为 not-expressed）
    const listScanWrites = issueWritesOf([
      {
        key: '27',
        number: 27,
        effortId: '',
        type: 'issue',
        title: '规格：FY27Q1 待导入数据文件执行计划',
        state: 'open',
        body: '',
        url: 'https://github.com/Darth-Acheron/dci-agent-bill/issues/27',
        createdAt: '2026-11-15T10:00:00Z',
        updatedAt: '2026-11-15T10:05:00Z',
        labels: [],
        assignees: [],
        fieldStates: {
          dependencies: { known: false, reason: 'not-expressed' },
          parents: { known: false, reason: 'not-expressed' },
        },
      } as any,
      {
        key: '28',
        number: 28,
        effortId: '',
        type: 'issue',
        title: '导入 [DDC006.FYQ127.xlsx]：费用明细',
        state: 'open',
        body: '',
        url: 'https://github.com/Darth-Acheron/dci-agent-bill/issues/28',
        createdAt: '2026-11-15T10:01:00Z',
        updatedAt: '2026-11-15T10:06:00Z',
        labels: [{ name: 'ready-for-agent', color: '0e8a16' }],
        assignees: [],
        fieldStates: {
          dependencies: { known: false, reason: 'not-expressed' },
          parents: { known: false, reason: 'not-expressed' },
        },
      } as any,
    ], 'github')

    const r2 = handle.ingest({ startMergeVersion: handle.getMergeVersion(), writes: listScanWrites })
    check(r2.committed === true, 'B2 无正文列表扫描批次成功入库', r2)

    const listProj = handle.readList({ state: 'all' })
    const row27 = listProj.issues.find((x) => x.key === '27')
    const row28 = listProj.issues.find((x) => x.key === '28')
    const fields28 = row28 ? snapshotRowFieldsOf(row28) : null
    check(
      !!row27 && row27.row.type === 'spec',
      'B3 无正文列表扫描不会把已有的 spec 容器 #27 降级覆盖回 issue',
      row27?.row,
    )
    check(
      !!fields28 && fields28.parentKey.known === true && fields28.parentKey.value === '27' && fields28.blockedBy.known === true && Array.isArray(fields28.blockedBy.value) && fields28.blockedBy.value.length === 1 && fields28.blockedBy.value[0]?.key === '26',
      'B3b 无正文列表扫描（parents/dependencies not-expressed）不会把子票 #28 已落库的 parentKey 与 blockedBy 冲成 unknown',
      { groups: row28?.groups, fields28 },
    )

    // 3) 兼容旧库修复：若旧库中已有父边/阻塞边但 issue_group 被写成 unknown/not-expressed，readList 与 readDetail 投影自动恢复为 complete
    handle.ingest({
      startMergeVersion: handle.getMergeVersion(),
      writes: [
        {
          effortId: '',
          key: '28',
          groups: {
            parents: { completeness: 'unknown', reason: 'not-expressed', source: 'refresh-list', operation: 'list' },
            blockedBy: { completeness: 'unknown', reason: 'not-expressed', source: 'refresh-list', operation: 'list' },
          },
        },
      ],
    })
    const listAfterLegacy = handle.readList({ state: 'all' })
    const legacyRow28 = listAfterLegacy.issues.find((x) => x.key === '28')
    const legacyFields28 = legacyRow28 ? snapshotRowFieldsOf(legacyRow28) : null
    const legacyDetail28 = handle.readIssueDetail({ effortId: '', key: '28' })
    check(
      !!legacyFields28 && legacyFields28.parentKey.known === true && legacyFields28.parentKey.value === '27' && legacyFields28.blockedBy.known === true && legacyFields28.blockedBy.value.length === 1 && legacyDetail28.issue?.groups.parents?.completeness === 'complete' && legacyDetail28.issue?.groups.blockedBy?.completeness === 'complete',
      'B3c 历史旧库中 issue_edge 存有父边/阻塞边但 issue_group 曾被写成 unknown(not-expressed) 时，列表与详情投影自动恢复完整度',
      { legacyFields28, detailGroups: legacyDetail28.issue?.groups },
    )

    const cs = handle.readChangeSet({ sinceVersion: 0, maxRows: 100, maxAgeMs: 3600_000 })
    const cs27 = cs.changes.find((x) => x.key === '27')
    const cs28 = cs.changes.find((x) => x.key === '28')
    check(
      !!cs27 && cs27.placement.place === 'map' && !!cs28 && cs28.placement.place === 'child' && cs28.placement.containerKey === '27',
      'B4 变化集投影将 #27 标为 place:map、将 #28 标为 place:child（containerKey=27）',
      { cs27: cs27?.placement, cs28: cs28?.placement },
    )

    // 将真实 SQLite readChangeSet 结果并入客户端快照并跑 compute(st)
    const clientMerged = applySnapshotChangeSet(
      { ok: true, maps: [], issues: [], thinTickets: [] },
      cs.changes,
      cs.missing,
      { idOf, rowFieldsOf: snapshotRowFieldsOf },
    )
    const groupsAfterDbMerge = storeDerived.compute({ snapshot: clientMerged!.snapshot })
    check(
      groupsAfterDbMerge.length === 1 && groupsAfterDbMerge[0].m.key === '27' && groupsAfterDbMerge[0].frontier.length === 1 && groupsAfterDbMerge[0].frontier[0].key === '28',
      'B5 真实 SQLite 变化集经 applySnapshotChangeSet + compute(st) 完整闭环，#28 进入 #27 的 frontier 且零异常',
      groupsAfterDbMerge,
    )

    handle.close()
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  // ── C. DeckSidebarTab 会话级错误边界：阻断单会话渲染异常触发宿主 SlotErrorBoundary 全局退位 ──
  {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:62699/' })
    const prevWin = G.window
    const prevDoc = G.document
    const prevRaf = G.requestAnimationFrame
    const prevCancelRaf = G.cancelAnimationFrame
    G.window = dom.window
    G.document = dom.window.document
    G.requestAnimationFrame = (cb: any) => setTimeout(cb, 0)
    G.cancelAnimationFrame = clearTimeout

    try {
      let shouldThrowInBill = true
      const body = spliceableJs('src/client/kernel/router.js').replace(/^[ \t]*export[ \t]+/gm, '')
      const sandbox: Record<string, any> = {
        isEnabled: () => false,
        log: () => {},
        ctx: { get: () => null },
        h: React.createElement,
        React,
        DetailsDock: function DetailsDock(p: any): any {
          if (p.sessionId === 'sid-bill' && shouldThrowInBill) {
            throw new TypeError("Cannot read properties of undefined (reading 'some')")
          }
          return React.createElement('div', { className: 'dsws-tabs', 'data-dock-sid': p.sessionId }, '正常面板:' + p.sessionId)
        },
        tr: (k: string) => (k === 'lc.retry' ? '重试' : k),
        flash: () => {},
        emit: () => {},
        getCwdSync: () => '/Users/bryan/projects/dci-agent-bill',
        hydrateFromCache: () => {},
        getCachedSnapshot: () => null,
        snapFresh: () => false,
        loadSnapshot: () => {},
        startAttentionSignals: () => {},
        keyOf: (c: any) => String(c || ''),
        getSnapshotVersion: () => '',
        issueUrlFor: () => '',
        repoUrlFor: () => '',
        effortOf: () => '',
        idOf: () => 0,
        renderTemplate: () => '',
        promptText: () => '',
        promptTextFor: () => '',
        uiText: () => '',
        newWayfinderPrompt: () => '',
        newSpecPrompt: () => '',
        NEW_BUG_FIELDS_BODY: '',
        inspectPrompt: () => '',
        completePrompt: () => '',
        dswsLogHash: () => 'hash',
        isDeckClosed: () => false,
        SLOT_QUEUE_STEP_MS: 10,
        requestAnimationFrame: (cb: any) => setTimeout(cb, 0),
        cancelAnimationFrame: clearTimeout,
      }
      const names = Object.keys(sandbox)
      const factory = compileFn(names, body + '\n;return { DeckSidebarTab: DeckSidebarTab }')
      const { DeckSidebarTab } = factory(...names.map((n) => sandbox[n]))

      let slotAbdicated = false
      class HostSlotErrorBoundary extends React.Component<{ onEntryError: () => void; children?: React.ReactNode }, { failed: boolean }> {
        state = { failed: false }
        static getDerivedStateFromError() { return { failed: true } }
        componentDidCatch() { this.props.onEntryError() }
        render() {
          if (this.state.failed) return React.createElement('div', { 'data-slot-error': '1' }, '这类内容还没有可用的查看方式。')
          return this.props.children
        }
      }

      const container = dom.window.document.getElementById('root')!
      const root = ReactDOMClient.createRoot(container)
      const renderSession = async (sid: string) => {
        await act(async () => {
          root.render(
            slotAbdicated
              ? React.createElement('p', { 'data-abdicated': '1' }, '这类内容还没有可用的查看方式。')
              : React.createElement(
                  HostSlotErrorBoundary,
                  { onEntryError: () => { slotAbdicated = true } },
                  React.createElement(DeckSidebarTab, { sessionId: sid }),
                ),
          )
          await new Promise((r) => setTimeout(r, 25))
        })
        await act(async () => {
          await new Promise((r) => setTimeout(r, 25))
        })
      }

      // 1) sid-bill 内部抛错：被 DeckSidebarTab 内部错误边界拦截，宿主 SlotErrorBoundary 不退位
      await renderSession('sid-bill')
      check(
        slotAbdicated === false && !!container.querySelector('[data-deck-error-boundary="1"]'),
        'C1 单会话 DetailsDock 渲染抛错时被插件内部错误边界拦截，宿主槽位不退位（slotAbdicated=false）',
        { slotAbdicated, html: container.innerHTML },
      )

      // 2) 切换到 sid-other：正常渲染，不受 sid-bill 异常连坐
      await renderSession('sid-other')
      check(
        slotAbdicated === false && !!container.querySelector('[data-dock-sid="sid-other"]'),
        'C2 切换到其它工作区会话 sid-other 时面板正常渲染，不再全工作区连坐失效',
        { slotAbdicated, html: container.innerHTML },
      )

      // 3) 切回 sid-bill 并点击重试按钮：恢复正常渲染
      shouldThrowInBill = false
      await renderSession('sid-bill')
      const retryBtn = container.querySelector('[data-deck-error-boundary="1"] button') as HTMLElement | null
      if (retryBtn) {
        await act(async () => {
          retryBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
          await new Promise((r) => setTimeout(r, 20))
        })
      }
      check(
        slotAbdicated === false && !!container.querySelector('[data-dock-sid="sid-bill"]'),
        'C3 点击面板内重试按钮后 sid-bill 原地恢复渲染，无需刷新整个 DSH UI',
        { slotAbdicated, html: container.innerHTML },
      )

      root.unmount()
    } finally {
      G.window = prevWin
      G.document = prevDoc
      G.requestAnimationFrame = prevRaf
      G.cancelAnimationFrame = prevCancelRaf
      dom.window.close()
    }
  }

  console.log('')
  if (failed > 0) {
    console.log(`FAIL：${failed}/${total} 项未通过`)
  } else {
    console.log(`全部通过 — 刷新后增量合并、规格类型保留与会话级错误边界门禁生效（${total} 项断言）`)
  }
  printGateResult(GATE, total, failed)
  process.exit(failed > 0 ? 1 : 0)
}

main()
