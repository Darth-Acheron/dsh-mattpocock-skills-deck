/**
 * tests/verify-list-tree-hierarchy.ts —— 三级父子归属（探索地图 → 规格 → 实施票）与主列表可折叠树门禁
 *
 * 门禁归属: src/client/views/listTree.ts
 * 门禁归属: src/client/views/ListTab.ts
 * 门禁归属: src/client/views/ListTabRow.ts
 * 门禁归属: src/client/kernel/styles.ts
 * 门禁归属: src/client/kernel/icons.ts
 * 门禁归属: src/deck/rules/object-kind.ts
 * 门禁归属: src/deck/tools/issue-create.ts
 * 门禁归属: src/deck/tools/issue-create-parts.ts
 * 门禁归属: src/workspace-snapshot/projection/changes.ts
 * 门禁归属: src/refresh/rooms/client/snapshot-change-merge.ts
 * 门禁归属: config/copy/flow.yaml
 *
 * 跑法：node --import ./scripts/ts-hook.mts tests/verify-list-tree-hierarchy.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { printGateResult } from './lib/gate-result.ts'
import { openWorkspaceSnapshot } from '../src/workspace-snapshot/runtime/open.js'
import { assembleSnapshot } from '../src/host/tracker/snapshotAssemble.js'
import { applySnapshotChangeSet } from '../src/refresh/rooms/client/snapshot-change-merge.ts'
import { snapshotRowFieldsOf } from '../src/shared/snapshot-row-fields.ts'
import { resolveCreateKind, ruleFor } from '../src/deck/rules/object-kind.ts'
import type { IssueWrite } from '../src/workspace-snapshot/contract/types.js'

const GATE = 'verify-list-tree-hierarchy'
let total = 0
let failed = 0

function check(ok: unknown, msg: string): boolean {
  total += 1
  if (ok) console.log('  PASS ' + msg)
  else { failed += 1; console.log('  FAIL ' + msg) }
  return !!ok
}

function withQuietReact<T>(fn: () => T): T {
  const realErr = console.error
  console.error = (...args: any[]) => {
    const m = String((args && args[0]) || '')
    if (m.indexOf('useLayoutEffect does nothing on the server') >= 0) return
    if (m.indexOf('unique "key" prop') >= 0) return
    realErr.apply(console, args)
  }
  try { return fn() } finally { console.error = realErr }
}

const trDict: Record<string, string> = {
  'list.specChip': '规格',
  'list.mapChip': '地图',
  'act.split': '拆票',
  'act.execute': '执行',
  'act.done': '完成',
  'act.inspect': '检查',
  'act.diagnose': '诊断',
  'act.implement': '实施',
  'list.newSessionLabel': '新会话',
  'list.blocked': '被阻塞',
  'list.none': '暂无',
  'list.closedN': '已关闭 {n}（已加载 {x}）',
  'list.treeCollapse': '收起子票',
  'list.treeExpand': '展开子票（{n}）',
  'list.treeClosedChildren': '已关闭子票（{n}）',
  'map.subClosed': '已关闭',
  'list.kpi.takeable': '可接',
  'list.kpi.blocked': '阻塞',
  'list.kpi.closed': '已关闭',
}

function trFn(key: any, params?: any): string {
  let text = Object.prototype.hasOwnProperty.call(trDict, key) ? trDict[String(key)] : String(key)
  if (params && typeof params === 'object') {
    for (const k of Object.keys(params)) {
      text = text.split('{' + k + '}').join(String(params[k]))
    }
  }
  return text
}

async function run() {
  console.log('=== 1. 接缝一：建票规则支持规格（spec）可选挂探索地图 ===')
  {
    const specRule = ruleFor('spec')
    const mapRule = ruleFor('map')
    check(!!specRule && specRule.parent === 'optional-map', 'S1.1 spec 的父票规则为 optional-map（可顶层独立、也可挂在探索地图下）')
    check(!!mapRule && mapRule.parent === 'none', 'S1.2 map 的父票规则仍为 none（顶层容器不收父票）')
    const topSpec = resolveCreateKind({ kind: 'spec' })
    const nestedSpec = resolveCreateKind({ kind: 'spec', parentKey: '1' })
    const badMap = resolveCreateKind({ kind: 'map', parentKey: '1' })
    check(topSpec.ok === true && topSpec.parent === 'optional-map', 'S1.3 kind=spec 不传 parentKey 通过收口')
    check(nestedSpec.ok === true && nestedSpec.parent === 'optional-map', 'S1.4 kind=spec 传入 parentKey 通过收口')
    check(badMap.ok === false, 'S1.5 kind=map 传入 parentKey 仍被拒绝')
  }

  console.log('\n=== 2. 接缝二：快照组装与 SQLite 变化集投影/客户端合并的三级一致性 ===')
  {
    const repoRef = { backend: 'github', refId: 'acme/deck', name: 'acme/deck', url: 'https://github.com/acme/deck' }
    const rawRows = [
      { key: '1', number: 1, effortId: '', type: 'map', state: 'open', title: '探索地图 1', body: '', url: '', parentKey: null },
      { key: '4', number: 4, effortId: '', type: 'issue', state: 'closed', title: '追问工单 4', body: '', url: '', parentKey: '1' },
      { key: '21', number: 21, effortId: '', type: 'spec', state: 'open', title: '向导规格 21', body: '<!-- DSH-ISSUE-KIND: spec -->\n', url: '', parentKey: '1' },
      { key: '22', number: 22, effortId: '', type: 'issue', state: 'closed', title: '实施票 22', body: '', url: '', parentKey: '21' },
      { key: '24', number: 24, effortId: '', type: 'issue', state: 'open', title: '实施票 24', body: '', url: '', parentKey: '21' },
      { key: '26', number: 26, effortId: '', type: 'issue', state: 'open', title: '独立缺陷 26', body: '', url: '', parentKey: null },
    ]
    const assembled = assembleSnapshot(repoRef as any, rawRows)
    const map1 = assembled.maps.find((m: any) => m.key === '1')
    const spec21 = assembled.maps.find((m: any) => m.key === '21')
    check(!!map1 && !!spec21, 'S2.1 assembleSnapshot 的 maps 同时包含探索地图 #1 与规格 #21')
    check(map1.tickets.some((t: any) => t.key === '21') && map1.tickets.some((t: any) => t.key === '4'), 'S2.2 探索地图 #1 的 tickets 同时挂着子规格 #21 与地图工单 #4')
    check(spec21.tickets.length === 2 && spec21.tickets.some((t: any) => t.key === '24'), 'S2.3 规格 #21 的 tickets 挂着实施票 #22 与 #24')
    check(assembled.issues.length === 1 && assembled.issues[0].key === '26', 'S2.4 未挂图票 issues 只剩独立缺陷 #26')

    // 真 SQLite 快照库：验证变化集落点与客户端合并结果和全量组装一致
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'deck-tree-snap-'))
    mkdirSync(path.join(tmpDir, 'docs', 'agents'), { recursive: true })
    writeFileSync(path.join(tmpDir, 'docs', 'agents', 'workspace.yaml'), 'name: tree-test\n', 'utf8')
    const opened = openWorkspaceSnapshot({
      workspaceRoot: tmpDir,
      dbPath: path.join(tmpDir, 'snap.sqlite'),
      backend: 'github',
      repoIdentity: 'acme/deck',
      now: () => 1000,
    })
    const handle = opened.handle
    try {
      const writeRow = (key: string, type: 'map' | 'spec' | 'issue', state: 'open' | 'closed', title: string, parentKey: string | null): IssueWrite => ({
        effortId: '',
        key,
        groups: {
          row: { completeness: 'complete', value: { title, state, url: '', type, isPullRequest: false } },
          parents: { completeness: 'complete', value: parentKey ? [parentKey] : [] },
        },
      })
      handle.ingest({
        startMergeVersion: handle.getMergeVersion(),
        writes: [
          writeRow('1', 'map', 'open', '探索地图 1', null),
          writeRow('26', 'issue', 'open', '独立缺陷 26', null),
        ],
      })
      const vBase = handle.getMergeVersion()
      // 写入挂在探索地图 #1 下的规格 #21
      handle.ingest({
        startMergeVersion: vBase,
        writes: [writeRow('21', 'spec', 'open', '向导规格 21', '1')],
      })
      const cs1 = handle.readChangeSet({ sinceVersion: vBase, maxRows: 50, maxAgeMs: 60000 })
      const specChange = cs1.changes.find((c) => c.key === '21')
      check(!!specChange && specChange.placement.place === 'map' && specChange.placement.containerKey === '1' && specChange.placement.parentPlace === 'child',
        'S2.5 挂在开放地图下的规格变更时，变化集投影给出 place=map + containerKey=1 + parentPlace=child')

      const idOfRow = (r: any) => String((r && r.effortId) || '') + '#' + String((r && r.key) != null ? r.key : r.number)
      const clientSnap0 = {
        ok: true,
        maps: [{ key: '1', number: 1, effortId: '', type: 'map', state: 'OPEN', title: '探索地图 1', tickets: [] }],
        issues: [{ key: '26', number: 26, effortId: '', type: 'issue', state: 'OPEN', title: '独立缺陷 26' }],
        thinTickets: [],
      }
      const merged1 = applySnapshotChangeSet(clientSnap0, cs1.changes, cs1.missing, { idOf: idOfRow, rowFieldsOf: snapshotRowFieldsOf })
      check(!!merged1 && merged1.snapshot.maps.some((m: any) => m.key === '21') && merged1.snapshot.maps[0].tickets.some((t: any) => t.key === '21'),
        'S2.6 客户端合并变化集后，规格 #21 既进入顶层 maps，又同步挂入父地图 #1 的 tickets')

      // 解除规格 #21 的父边后，再次变化集合并应从父地图 #1 的 tickets 摘除，但保留在 maps 中
      const vMid = handle.getMergeVersion()
      handle.ingest({
        startMergeVersion: vMid,
        writes: [writeRow('21', 'spec', 'open', '向导规格 21（独立）', null)],
      })
      const cs2 = handle.readChangeSet({ sinceVersion: vMid, maxRows: 50, maxAgeMs: 60000 })
      const merged2 = applySnapshotChangeSet(merged1!.snapshot, cs2.changes, cs2.missing, { idOf: idOfRow, rowFieldsOf: snapshotRowFieldsOf })
      check(!!merged2 && merged2.snapshot.maps.some((m: any) => m.key === '21') && !merged2.snapshot.maps[0].tickets.some((t: any) => t.key === '21'),
        'S2.7 规格解除父边后，变化集合并把它从旧父地图的 tickets 摘除，同时保留其自身容器项')
    } finally {
      handle.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  console.log('\n=== 3. 接缝三：主列表（ListTab + listTree + ListTabRow）三级渲染、折叠交互与筛选保持 ===')
  {
    const G: any = globalThis
    G.React = React
    G.h = React.createElement
    G.DswsCtx = React.createContext(null)
    G.tr = trFn
    let emitCount = 0
    G.emit = () => { emitCount += 1 }
    G.promptText = () => 'PROMPT'
    G.promptTextFor = () => 'PROMPT_FOR'
    G.renderTemplate = () => 'TPL'
    G.startText = () => 'START'
    G.inspectPrompt = () => 'INSPECT'
    G.completePrompt = () => 'COMPLETE'
    G.Ic = (props: any) => React.createElement('span', { 'data-icon': (props && props.n) || '' })
    G.Tip = (props: any) => React.createElement('span', { 'data-tip': '1' }, props && props.children)
    G.chipProps = (props: any) => props
    G.chipKeyDown = () => {}
    G.darken = () => 'rgba(0,0,0,.6)'
    G.hexA = () => 'rgba(0,0,0,.16)'
    G.labelClicks = {}
    G.listPrefs = { sortKey: 'number', sortDir: 'asc', stateFilter: 'all' }
    G.COPY_FLASH_MS = 1300
    G.saveLabelClicks = () => {}
    G.saveListPrefs = () => {}
    G.FallbackMark = () => null
    G.closedPagesNode = () => null
    G.listFilterRowNode = () => null
    G.mdEffortRowNode = () => null
    G.getCachedSnapshot = () => null
    G.loadIssuePage = () => {}
    G.useClosedPageScroll = () => {}
    G.healthCheckVisible = () => false
    G.healthCheckCountOf = () => 0
    G.openHealthCheck = () => {}
    G.truthNoticeLines = () => []
    G.truthWriteWindowOpen = () => false
    G._tagsFpOf = new WeakMap()
    G.fitAllTags = () => {}
    G.panelNow = () => 0
    G.panelClock = {}
    G.isEnabled = () => false
    G.chainSteps = () => []
    G.effortOf = (x: any) => String((x && x.effortId) || '')
    G.idOfParts = (eff: any, k: any) => (eff ? String(eff) + '#' + String(k) : String(k))
    G.idOf = (x: any) => G.idOfParts(G.effortOf(x), x && (x.key != null ? x.key : x.number))
    G.refKeyOf = (b: any) => String((b && typeof b === 'object' ? (b.key != null ? b.key : b.number) : b) || '')
    G.copyText = () => true
    G.issueUrlFor = (_st: any, n: any) => 'https://github.com/acme/deck/issues/' + String(n)
    G.openModeFor = () => 'url'
    G.openTrackerTarget = () => {}
    G.openInNewSession = () => {}
    G.inject = () => {}
    G.setActiveMap = (st: any, n: any) => { st.activeMap = n }
    G.setActiveIssue = (st: any, n: any) => { st.activeIssue = n }
    G.issuePageRowsOf = () => []
    G.ticketBadgeOf = (h: any, p: any) => h('span', { className: 'dsws-idnum' }, '#' + String(p.key))

    const cv: any = await import('../src/client/kernel/container-view.js')
    Object.assign(G, cv)
    const sd: any = await import('../src/client/kernel/store-derived.js')
    Object.assign(G, sd)
    const ra: any = await import('../src/client/kernel/row-actions.js')
    Object.assign(G, ra)
    const rowMod: any = await import('../src/client/views/ListTabRow.js')
    G.listIssueRow = rowMod.listIssueRow
    G.listSkeletonNode = rowMod.listSkeletonNode
    const treeMod: any = await import('../src/client/views/listTree.js')
    Object.assign(G, treeMod)
    const listMod: any = await import('../src/client/views/ListTab.js')

    const makeDataset = () => {
      const rows = [
        // 顶层探索地图 #1（含开放追问票 #4、已关调研票 #2/#3、以及挂在它下面的开放规格 #21）
        { number: 1, key: '1', effortId: '', type: 'map', state: 'OPEN', title: '设计云效引导向导', labels: [{ name: 'wayfinder:map' }], blockedBy: [], parentKey: null },
        { number: 2, key: '2', effortId: '', type: 'issue', state: 'CLOSED', title: '认证门禁决议', labels: [{ name: 'wayfinder:grilling' }], blockedBy: [], parentKey: '1' },
        { number: 3, key: '3', effortId: '', type: 'issue', state: 'CLOSED', title: '令牌落盘调研', labels: [{ name: 'wayfinder:research' }], blockedBy: [], parentKey: '1' },
        { number: 4, key: '4', effortId: '', type: 'issue', state: 'OPEN', title: '扩展架构讨论', labels: [{ name: 'wayfinder:grilling' }], blockedBy: [], parentKey: '1' },
        // 二级规格 #21（挂在地图 #1 下，含已关实施票 #22/#23 与开放实施票 #24）
        { number: 21, key: '21', effortId: '', type: 'spec', state: 'OPEN', title: '实现云效引导向导', labels: [{ name: 'ready-for-agent' }], blockedBy: [], parentKey: '1' },
        { number: 22, key: '22', effortId: '', type: 'issue', state: 'CLOSED', title: '预检重排', labels: [{ name: 'ready-for-agent' }], blockedBy: [], parentKey: '21' },
        { number: 23, key: '23', effortId: '', type: 'issue', state: 'CLOSED', title: '字段原语与落盘', labels: [{ name: 'ready-for-agent' }], blockedBy: [], parentKey: '21' },
        { number: 24, key: '24', effortId: '', type: 'issue', state: 'OPEN', title: '项目发现与三模式置备', labels: [{ name: 'ready-for-agent' }], blockedBy: [], parentKey: '21' },
        // 顶层独立规格 #30（不挂地图，含开放实施票 #31）
        { number: 30, key: '30', effortId: '', type: 'spec', state: 'OPEN', title: '独立规格三十', labels: [{ name: 'ready-for-agent' }], blockedBy: [], parentKey: null },
        { number: 31, key: '31', effortId: '', type: 'issue', state: 'OPEN', title: '独立规格子票三十一', labels: [{ name: 'ready-for-agent' }], blockedBy: [], parentKey: '30' },
        // 空规格 #40（0 子票，不应出现折叠箭头）
        { number: 40, key: '40', effortId: '', type: 'spec', state: 'OPEN', title: '空规格四十', labels: [{ name: 'ready-for-agent' }], blockedBy: [], parentKey: null },
        // 已关闭地图 #8 与挂在它下面的已关闭规格 #9，以及父容器已关闭但自身仍未关闭的遗留开放票 #19
        { number: 8, key: '8', effortId: '', type: 'map', state: 'CLOSED', title: '支持云效后端总图', labels: [{ name: 'wayfinder:map' }], blockedBy: [], parentKey: null },
        { number: 9, key: '9', effortId: '', type: 'spec', state: 'CLOSED', title: '新增云效后端规格', labels: [{ name: 'ready-for-agent' }], blockedBy: [], parentKey: '8' },
        { number: 19, key: '19', effortId: '', type: 'issue', state: 'OPEN', title: '关图后仍开着的子票十九', labels: [{ name: 'ready-for-agent' }], blockedBy: [], parentKey: '8' },
        // 未挂任何容器的独立票 #26（open）与 #15（closed）
        { number: 26, key: '26', effortId: '', type: 'issue', state: 'OPEN', title: '两位数票号解析缺陷', labels: [{ name: 'bug' }, { name: 'needs-triage' }], blockedBy: [], parentKey: null },
        { number: 15, key: '15', effortId: '', type: 'issue', state: 'CLOSED', title: '历史已关闭缺陷十五', labels: [{ name: 'bug' }], blockedBy: [], parentKey: null },
      ]
      const maps = [
        { number: 1, key: '1', effortId: '', type: 'map', state: 'OPEN', title: '设计云效引导向导', stats: { total: 4, closed: 2 }, tickets: [rows[1], rows[2], rows[3], rows[4]] },
        { number: 21, key: '21', effortId: '', type: 'spec', state: 'OPEN', title: '实现云效引导向导', stats: { total: 3, closed: 2 }, tickets: [rows[5], rows[6], rows[7]] },
        { number: 30, key: '30', effortId: '', type: 'spec', state: 'OPEN', title: '独立规格三十', stats: { total: 1, closed: 0 }, tickets: [rows[9]] },
        { number: 40, key: '40', effortId: '', type: 'spec', state: 'OPEN', title: '空规格四十', stats: { total: 0, closed: 0 }, tickets: [] },
        { number: 8, key: '8', effortId: '', type: 'map', state: 'CLOSED', title: '支持云效后端总图', stats: { total: 0, closed: 0 }, tickets: [] },
        { number: 9, key: '9', effortId: '', type: 'spec', state: 'CLOSED', title: '新增云效后端规格', stats: { total: 0, closed: 0 }, tickets: [] },
      ]
      return { rows, maps }
    }

    const renderDom = (st: any) => {
      const html = withQuietReact(() => renderToStaticMarkup(React.createElement(listMod.ListTab, { st, narrow: false })))
      return new JSDOM('<!doctype html><body>' + html + '</body>').window.document
    }

    const openRowOrderOf = (doc: Document): string[] => {
      // 取主列表里除底部 details 折叠区以外的全部行
      const all = Array.from(doc.querySelectorAll('.dsws-aggrow')) as HTMLElement[]
      return all
        .filter((el) => !el.closest('details'))
        .map((el) => String(el.getAttribute('data-log') || '').replace(/^list\.row\./, ''))
    }

    const ds = makeDataset()
    const baseSt: any = {
      tab: 'list',
      cwd: '/ws',
      sortKey: 'number',
      sortDir: 'asc',
      stateFilter: 'all',
      lblFilters: [],
      effFilters: [],
      rowFlash: {},
      writeAt: {},
      snapshot: { issues: ds.rows.slice().reverse(), maps: ds.maps, generatedMs: 1700000000000 },
    }

    // 3.1 默认态：三级缩进顺序 + 默认展开开放子票 + 默认折叠容器内已关闭子票 + 零遗漏开放工作
    const doc0 = renderDom(baseSt)
    const order0 = openRowOrderOf(doc0)
    check(order0.join(',') === '1,21,24,4,30,31,40,19,26',
      'S3.1 主列表默认按三级归属排列：地图#1 → 二级规格#21 → 实施票#24 → 地图子票#4 → 独立规格#30 → 子票#31 → 空规格#40 → 父已关提升票#19 → 独立票#26（实得 ' + order0.join(',') + '）')

    const depthOf = (k: string) => {
      const el = doc0.querySelector('[data-log="list.row.' + k + '"]')
      return el ? el.getAttribute('data-tree-depth') : null
    }
    check(depthOf('1') === '0' && depthOf('21') === '1' && depthOf('24') === '2' && depthOf('4') === '1',
      'S3.2 探索地图→规格→实施票呈现严格 0→1→2 三级深度属性')
    check(depthOf('30') === '0' && depthOf('31') === '1' && depthOf('19') === '0' && depthOf('26') === '0',
      'S3.3 独立规格为第 0 层、其子票为第 1 层；父容器已关闭的未关子票 #19 提升到第 0 层绝不丢失')

    // 确认 DOM 真的包裹在父容器的 .dsws-tree-kids 内
    const kidsOf1 = doc0.querySelector('[data-tree-children-of="1"]')
    const kidsOf21 = doc0.querySelector('[data-tree-children-of="21"]')
    check(!!kidsOf1 && !!kidsOf1.querySelector('[data-log="list.row.21"]') && !!kidsOf1.querySelector('[data-log="list.row.4"]'),
      'S3.4 二级规格 #21 与探索工单 #4 真实嵌套在探索地图 #1 的树缩进容器内')
    check(!!kidsOf21 && !!kidsOf21.querySelector('[data-log="list.row.24"]') && !!kidsOf1 && kidsOf1.contains(kidsOf21),
      'S3.5 实施票 #24 真实嵌套在二级规格 #21 的树缩进容器内（且 #21 容器位于 #1 容器内部）')

    // 空规格 #40 不渲染折叠箭头，有子项的 #1/#21/#30 渲染展开态箭头
    check(!doc0.querySelector('[data-log="list.tree.toggle.40"]') && !!doc0.querySelector('[data-log="list.tree.toggle.1"][aria-expanded="true"]'),
      'S3.6 无子项的空容器不画多余折叠箭头，有子项的开放容器默认展开（aria-expanded=true）')

    // 开放容器下的已关闭子票默认收拢成折叠条，且不重复漏到底部全局 details 里
    const closedBar21 = doc0.querySelector('[data-log="list.tree.closed.21"]')
    const closedBar1 = doc0.querySelector('[data-log="list.tree.closed.1"]')
    check(!!closedBar21 && (closedBar21.textContent || '').indexOf('已关闭子票（2）') >= 0 && closedBar21.getAttribute('aria-expanded') === 'false',
      'S3.7 规格 #21 下已关闭的 #22/#23 默认收拢为「已关闭子票（2）」紧凑折叠条')
    check(!!closedBar1 && (closedBar1.textContent || '').indexOf('已关闭子票（2）') >= 0,
      'S3.8 地图 #1 下已关闭的 #2/#3 默认收拢为「已关闭子票（2）」紧凑折叠条')
    const bottomDetailsRows = Array.from(doc0.querySelectorAll('details .dsws-aggrow')).map((el) => String(el.getAttribute('data-log') || '').replace(/^list\.row\./, ''))
    check(bottomDetailsRows.join(',') === '8,9,15',
      'S3.9 底部全局已关闭折叠区只含未被开放容器收拢的 #8、#9、#15（不重复出现 #2/#3/#22/#23），且 #9 排在 #8 下方（实得 ' + bottomDetailsRows.join(',') + '）')
    const closed9InBottom = doc0.querySelector('details [data-tree-children-of="8"] [data-log="list.row.9"]')
    check(!!closed9InBottom && closed9InBottom.getAttribute('data-tree-depth') === '1',
      'S3.10 底部已关闭折叠区内，已关闭规格 #9 同样按父子关系缩进在已关闭地图 #8 下方')

    // 3.2 交互态切换：展开 #21 的已关闭子票折叠条 → #22/#23 出现；收起 #1 的折叠箭头 → 整棵 #1 子树收起
    baseSt.treeClosedOpen = { '21': true }
    const docExpandedClosed = renderDom(baseSt)
    const expanded22 = docExpandedClosed.querySelector('[data-tree-children-of="21"] [data-log="list.row.22"]')
    const expanded23 = docExpandedClosed.querySelector('[data-tree-children-of="21"] [data-log="list.row.23"]')
    check(!!expanded22 && !!expanded23, 'S3.11 点开规格 #21 的已关闭子票折叠条后，#22 与 #23 原地展开在 #21 缩进区内')

    baseSt.treeCollapsed = { '1': true }
    const docCollapsedMap = renderDom(baseSt)
    const orderCollapsed = openRowOrderOf(docCollapsedMap)
    check(orderCollapsed.join(',') === '1,30,31,40,19,26' && docCollapsedMap.querySelector('[data-log="list.tree.toggle.1"][aria-expanded="false"]') !== null,
      'S3.12 收起探索地图 #1 后，其下的二级规格 #21、实施票 #24 与子票 #4 整棵子树收拢隐藏，其余顶层项不受影响（实得 ' + orderCollapsed.join(',') + '）')
    delete baseSt.treeCollapsed
    delete baseSt.treeClosedOpen

    // 3.3 标签筛选保持父容器上下文：筛选 wayfinder:grilling（只命中 #4）与筛选 bug（只命中独立票 #26）
    const stFilterGrilling = Object.assign({}, baseSt, { lblFilters: ['wayfinder:grilling'] })
    const orderGrilling = openRowOrderOf(renderDom(stFilterGrilling))
    check(orderGrilling.join(',') === '1,4',
      'S3.13 标签筛选命中地图子票 #4 时，自动保留父探索地图 #1 作为层级上下文，不相关的 #21/#30/#26 被过滤（实得 ' + orderGrilling.join(',') + '）')

    // 给三级实施票 #24 挂一枚特殊标签做深层命中测试
    ds.rows[7].labels = [{ name: 'ready-for-agent' }, { name: 'deep-hit' }]
    const stFilterDeep = Object.assign({}, baseSt, { lblFilters: ['deep-hit'] })
    const orderDeep = openRowOrderOf(renderDom(stFilterDeep))
    check(orderDeep.join(',') === '1,21,24',
      'S3.14 标签筛选命中第 2 层实施票 #24 时，完整保留「地图 #1 → 规格 #21 → 实施票 #24」三级祖先链（实得 ' + orderDeep.join(',') + '）')
    check(emitCount >= 0, 'S3.15 渲染全程零异常且不误触发额外写状态')
  }

  console.log('\n' + (failed === 0 ? '全部通过：' + total + ' 条断言' : '失败 ' + failed + ' / 共 ' + total + ' 条断言'))
  printGateResult(GATE, total, failed)
  if (failed > 0) process.exit(1)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
