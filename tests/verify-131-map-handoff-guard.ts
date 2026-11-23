/**
 * tests/verify-131-map-handoff-guard.ts —— 探索地图完成后交棒 /to-spec、关闭护栏与已关闭地图补救入口门禁（#131）
 *
 * 守什么：
 *   A 探索地图关闭前置护栏（src/deck/shell/map-close-guard.ts + src/deck/tools/issue-patch.ts）：
 *     1. 探索地图下仍有未关闭的探索子票时关闭被拒（rule = map-close-children-open，逐张列出未关探索子票）；
 *     2. 探索子票全部关闭，但尚未挂接任何规格票、且调用中未给 closeReason 与结项说明评论时关闭被拒
 *        （rule = map-close-needs-handoff-or-reason），防止 AI 关完最后一张子票顺手把探索地图关掉；
 *     3. 纯调研探索无需生成规格时，同一次调用附带 closeReason 说明结项原因即可正常关闭；
 *     4. 已挂接规格票（远端或契约 parentKey 指向该探索地图，或本地 Markdown 票面留有规格目录指针）时，
 *        即使下挂规格票自身仍是 open，探索地图也可以直接关闭（规格有自己的三道收口闸，不阻塞地图结项）；
 *   B 客户端容器状态机（src/client/kernel/container-view.ts + row-actions.ts）：
 *     1. 开放探索地图在探索子票全关且未挂规格时判为 'handoff'，主按钮为紫色「生成规格」（act.toSpec / handoff），注入 mapToSpec；
 *     2. 开放探索地图在探索子票全关且已挂规格时判为 'done'，主按钮为绿色「完成」（act.done / check），注入 completePrompt；
 *     3. 已关闭探索地图未挂规格时判为 'handoff'，已挂规格时判为 'done'；规格容器与无 type 调用维持原三态不变；
 *   C 列表页与地图详情页交互（ListTab.ts + ListTabRow.ts + MapDetailTop.ts + DetailActionBar.ts）：
 *     1. 当面板无开放议题、底部存在未挂规格的已关闭探索地图时，列表底部「已关闭」折叠条默认展开，且该行保留「生成规格」与「新会话」补救按钮；
 *     2. 当已关闭探索地图已经挂接了规格票时，列表底部折叠条默认收起，且已关闭地图行不画「生成规格」动作按钮；
 *     3. 开放待交棒探索地图在详情页顶栏与底部动作栏同时提供「生成规格」主按钮与「直接结项」次按钮；已关闭待交棒地图只保留「生成规格」主按钮。
 *
 * 运行：node --import ./scripts/ts-hook.mts tests/verify-131-map-handoff-guard.ts
 */
// 门禁归属: src/deck/shell/map-close-guard.ts
// 门禁归属: src/deck/tools/issue-patch.ts
// 门禁归属: src/client/kernel/container-view.ts
// 门禁归属: src/client/kernel/row-actions.ts
// 门禁归属: src/client/kernel/router.ts
// 门禁归属: src/client/views/ListTabRow.ts
// 门禁归属: src/client/views/ListTab.ts
// 门禁归属: src/client/views/MapDetailTop.ts
// 门禁归属: src/client/views/DetailActionBar.ts

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { printGateResult } from './lib/gate-result.ts'
import { mapCloseGuard } from '../src/deck/shell/map-close-guard.ts'

const require = createRequire(import.meta.url)
const { makeDecideStub, chooseWorkspace } = require('./lib/deck-decide-stub.js')

const GATE = 'verify-131-map-handoff-guard'
let total = 0
let failed = 0

function check(cond: unknown, message: string, detail?: unknown): void {
  total += 1
  if (cond) {
    console.log('  PASS ' + message)
    return
  }
  failed += 1
  console.log('  FAIL ' + message + (detail === undefined ? '' : '（实得 ' + JSON.stringify(detail) + '）'))
}

function makeMarkdownWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-131-'))
  const plat = {
    path: path.posix,
    fs: {
      async resolve(p: string) { return String(p).replace(/\\/g, '/') },
      async readText(t: string) { return fs.readFileSync(t, 'utf8') },
      async writeText(t: string, c: string) { fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, c, 'utf8') },
      async lstat(t: string) { try { return fs.statSync(t) } catch (_e) { return null } },
      async listDir(t: string) { try { return fs.readdirSync(t) } catch (_e) { return [] } },
      async stat(t: string) { try { return fs.statSync(t) } catch (_e) { return null } },
    },
  }
  const rootPosix = root.replace(/\\/g, '/')
  return {
    root,
    rootPosix,
    ctx: { platform: plat, fs: plat.fs, cwd: rootPosix, get(name: string) { return name === 'fs' ? plat.fs : undefined } },
    cleanup() { try { fs.rmSync(root, { recursive: true, force: true }) } catch (_e) {} },
  }
}

async function testMapCloseGuardTools(): Promise<void> {
  console.log('\n-- A. 探索地图关闭前置护栏（真工具链 + 远端 parentKey 规格放行） --')
  const budget = await import('../src/refresh/kernel/host-budget.js')
  const ledgerMod = await import('../src/refresh/rooms/host/quota-ledger.ts')
  const gateMod = await import('../src/refresh/rooms/host/refresh-gate.ts')
  const registryMod = await import('../src/tracker/registry/core.ts')
  const { markdownModule } = await import('../src/tracker/rooms/markdown/index.ts')
  const toolCost = await import('../src/refresh/kernel/tool-call-budget.js')
  const workRouteMod = await import('../src/deck/shell/work-path-bindings.ts')
  const planMod = await import('../src/deck/tools/map-plan-create.ts')
  const patchMod = await import('../src/deck/tools/issue-patch.ts')
  const getMod = await import('../src/deck/tools/issue-get.ts')

  const ws = makeMarkdownWorkspace()
  const workPathHome = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-131-wp-'))
  let clock = 1700000000000
  const ledger = ledgerMod.createLedger({ now: () => clock })
  const gate = gateMod.createGate({ ledger, now: () => clock })
  const registry = registryMod.createRegistry(Object.assign({ logEvent: () => {}, isEnabled: () => false }, ws.ctx), { matchesTimeout: 200 })
  const dispose = registry.register(markdownModule)
  chooseWorkspace(ws.rootPosix, 'markdown')
  const workRouteBindings = workRouteMod.createWorkRouteBindings({
    homeDir: workPathHome, now: () => clock,
    readFile: (p: string) => fs.promises.readFile(p, 'utf8').then((t) => t, () => null),
    writeFile: (p: string, t: string) => fs.promises.writeFile(p, t, 'utf8'),
    mkdir: (dir: string) => fs.promises.mkdir(dir, { recursive: true }),
  })
  const planTable = new Map<string, any>()
  const deps: any = {
    gate, registry, budget,
    estimate: toolCost.estimateToolCost, costInputFrom: toolCost.toolCostInputFrom,
    backendCtx: ws.ctx, handleFor: () => ({ cwd: ws.rootPosix, refId: '.scratch/map-a' }),
    decideBackend: makeDecideStub(registry),
    log: { fire: () => {} }, now: () => clock, invalidate: () => {},
    workRouteNote: (i: any) => workRouteBindings.note(i),
    workRouteRead: (i: any) => workRouteBindings.read(i),
    workRouteRelease: (i: any) => workRouteBindings.release(i),
    planStore: { durable: true, load: (id: string) => planTable.get(String(id)) || null, save: (id: string, s: any) => { planTable.set(String(id), s) } },
  }
  const exec = { agent: { session: { id: 's-131', cwd: ws.rootPosix } } }
  const planCreate = planMod.createDeckMapPlanCreate(deps)
  const issuePatch = patchMod.createDeckIssuePatch(deps)
  const issueGet = getMod.createDeckIssueGet(deps)

  try {
    const created: any = await planCreate.run(exec, {
      effort: 'map-a',
      title: '探索地图 A',
      children: [
        { key: 'c1', title: '调研一', kind: 'map-ticket', label: 'wayfinder:research' },
      ],
      edges: [{ from: 'c1', to: '@map', type: 'parent' }],
    })
    check(created.ok && created.data && created.data.mapKey === '00', 'A0 建出探索地图 #00 与探索子票 #01', created)

    // 1) 探索子票未关时直接关地图 -> map-close-children-open
    const earlyClose: any = await issuePatch.run(exec, { effort: 'map-a', key: '00', close: true })
    check(!earlyClose.ok && earlyClose.data && earlyClose.data.rule === 'map-close-children-open',
      'A1 探索子票未关时关闭探索地图被拒（rule=map-close-children-open）', earlyClose.data)
    check(Array.isArray(earlyClose.data && earlyClose.data.missing) && earlyClose.data.missing.length === 1 && earlyClose.data.missing[0].key === '01',
      'A2 回执点名仍未关闭的探索子票 #01', earlyClose.data && earlyClose.data.missing)

    // 先正常关掉探索子票 #01
    const closeChild: any = await issuePatch.run(exec, { effort: 'map-a', key: '01', close: true, closeReason: '调研结论已明确' })
    check(closeChild.ok, 'A3 探索子票 #01 正常关闭', closeChild)

    // 2) 探索子票已全关，但未挂规格且没给 closeReason/comment -> map-close-no-spec-handoff
    const prematureClose: any = await issuePatch.run(exec, { effort: 'map-a', key: '00', close: true })
    check(!prematureClose.ok && prematureClose.data && prematureClose.data.rule === 'map-close-no-spec-handoff',
      'A4 子票全关但未挂规格且无结项说明时关闭被挡下（rule=map-close-no-spec-handoff）', prematureClose.data)
    check(String(prematureClose.text || '').includes('/to-spec') && String(prematureClose.text || '').includes('生成规格'),
      'A5 拒绝文案明确指引交由面板点击「生成规格」运行 /to-spec 或补结项原因与评论', prematureClose.text)
    const afterPremature: any = await issueGet.run(exec, { effort: 'map-a', key: '00' })
    check(afterPremature.ok && afterPremature.data && afterPremature.data.ticket && afterPremature.data.ticket.state === 'open',
      'A6 被护栏挡下后探索地图保持 open 状态', afterPremature.data && afterPremature.data.ticket && afterPremature.data.ticket.state)

    // 3) 附带明确 closeReason（无需转规格的纯调研结项）-> 放行关闭
    const reasonClose: any = await issuePatch.run(exec, {
      effort: 'map-a', key: '00', close: true,
      closeReason: '纯调研结论已明确，确认无需进入实施阶段生成规格。',
    })
    check(reasonClose.ok, 'A7 附带明确结项原因 closeReason 时允许关闭探索地图', reasonClose)
    const afterReason: any = await issueGet.run(exec, { effort: 'map-a', key: '00' })
    check(afterReason.ok && afterReason.data && afterReason.data.ticket && afterReason.data.ticket.state === 'closed',
      'A8 关闭成功后探索地图读回状态为 closed', afterReason.data && afterReason.data.ticket && afterReason.data.ticket.state)

    // 4) 远端/契约模型：探索地图下挂了 open 状态的 spec 容器时，既不算未关探索子票，也满足已挂接规格条件；缺评论拒、带评论放行
    const fakeRemoteTracker: any = {
      async get(_repo: any, key: string) {
        if (String(key) === '10') return { ok: true, data: { key: '10', title: '远端探索地图', state: 'open', type: 'map', labels: ['wayfinder:map'], body: '## Destination\nx' } }
        return { ok: false, error: { message: 'not found' } }
      },
      async list() {
        return {
          ok: true,
          data: [
            { key: '11', title: '子票一', state: 'closed', type: 'task', parentKey: '10', labels: ['wayfinder:grilling'] },
            { key: '21', title: '下挂规格', state: 'open', type: 'spec', parentKey: '10', labels: ['ready-for-agent'], body: '<!-- DSH-ISSUE-KIND: spec -->\n## 目的' },
          ],
        }
      },
    }
    const remoteNoComment = await mapCloseGuard({ tracker: fakeRemoteTracker, repo: {}, key: '10', opCtx: {}, hasComment: false, hasCloseReason: false })
    check(remoteNoComment.kind === 'refuse' && remoteNoComment.rule === 'map-close-no-comment',
      'A9a 探索地图下已挂接 open 规格票但没带结项评论时按 map-close-no-comment 提醒补评论', remoteNoComment)
    const remoteVerdict = await mapCloseGuard({ tracker: fakeRemoteTracker, repo: {}, key: '10', opCtx: {}, hasComment: true, hasCloseReason: false })
    check(remoteVerdict.kind === 'ok', 'A9b 探索地图下已挂接 open 规格票且带结项评论时无须 closeReason 直接放行关闭', remoteVerdict)
  } finally {
    if (typeof dispose === 'function') dispose()
    ws.cleanup()
    try { fs.rmSync(workPathHome, { recursive: true, force: true }) } catch (_e) {}
  }
}

async function testClientKernelAndViews(): Promise<void> {
  console.log('\n-- B & C. 客户端容器 handoff/done 状态机、列表默认展开补救与详情页双按钮 --')
  const trDict: Record<string, string> = {
    'list.specChip': '规格',
    'list.mapChip': '地图',
    'act.split': '拆票',
    'act.execute': '执行',
    'act.done': '完成',
    'act.inspect': '检查',
    'act.toSpec': '生成规格',
    'act.closeMap': '直接结项',
    'list.newSessionLabel': '新会话',
    'list.empty': '暂无议题',
    'list.closedN': '已关闭 {n}（已加载 {x}）',
    'map.toSpecTitle': '全部探索子议题已完成，基于结论生成实施规格（/to-spec）',
    'map.closedToSpecTitle': '这张探索地图已关闭但尚未挂接规格，基于结论补建实施规格（/to-spec）',
    'map.closeMapTitle': '确认无需生成规格或已完成交接，核对并直接结项关闭地图',
    'map.doneTitle': '探索与规格交棒已就绪，核对并结项关闭这张地图',
    'map.archive': '打开地图链接',
    'detail.backList': '返回列表',
    'tip.copyLink': '复制链接',
    'tip.copied': '已复制',
    'tip.openLink': '打开链接',
  }
  const G: any = globalThis
  G.React = React
  G.tr = (k: any, p?: any) => {
    let s = trDict[String(k)] !== undefined ? trDict[String(k)] : String(k)
    if (p) s = s.replace(/\{(\w+)\}/g, (m: string, n: string) => (n in p ? String(p[n]) : m))
    return s
  }
  G.emit = () => {}
  G.Ic = (props: any) => '[icon:' + ((props && props.n) || '?') + ']'
  G.Tip = (props: any) => React.createElement('span', { 'data-tip': String(props.content) }, props.children)
  G.chipProps = (props: any) => props
  G.COPY_FLASH_MS = 1300

  const identityMod = await import('../src/tracker/kernel/identity-keys.js')
  const linkMod = await import('../src/client/kernel/link.js')
  const { DswsCtx } = await import('../src/client/kernel/ctx.js')
  const cv: any = await import('../src/client/kernel/container-view.js')
  const rowActionsMod: any = await import('../src/client/kernel/row-actions.js')
  G.DswsCtx = DswsCtx
  G.idOf = identityMod.idOf
  G.effortOf = identityMod.effortOf
  G.normIdentityKey = identityMod.normIdentityKey
  G.issueUrlFor = () => 'https://github.com/acme/demo/issues/10'
  G.openModeFor = linkMod.openModeFor
  G.openTrackerTarget = linkMod.openTrackerTarget
  Object.assign(G, cv)

  const injected: string[] = []
  G.inject = (_st: any, txt: string) => { injected.push(String(txt)) }
  G.promptTextFor = (_st: any, id: string, vars: any) => 'PROMPT:' + id + ':' + ((vars && vars.url) || '')
  G.completePrompt = (_st: any, n: any) => 'COMPLETE:' + String(n)
  G.inspectPrompt = (_st: any, n: any) => 'INSPECT:' + String(n)
  G.startText = (_st: any, t: any) => 'START:' + String(t && t.number)
  G.renderTemplate = (id: string, vars: any) => 'TPL:' + id + ':' + ((vars && vars.url) || '')
  G.findMapByIdentity = (maps: any[], num: any) => (Array.isArray(maps) ? maps.find((x) => String(x.number) === String(num)) || null : null)
  G.containerActionOf = rowActionsMod.containerActionOf
  G.isLightHex = (c: any) => ['#3fb950', '#f59e0b', '#c084fc'].indexOf(String(c)) >= 0
  G.actionColorOf = () => '#c084fc'
  G.mkRowAction = () => null
  G.authorColor = () => '#7aa2f7'
  G.darken = () => 'rgba(188,140,255,.6)'
  G.hexA = () => 'rgba(188,140,255,.16)'
  G.effortNamesOf = () => ['']
  G.effortOptionNamesOf = () => ['']
  G.ticketRowsOf = (arr: any) => arr
  G.issuePageRowsOf = () => []
  G.chipKeyDown = () => {}
  G.copyText = async () => true
  G.openInNewSession = () => {}
  G.openHealthCheck = () => {}
  G.setActiveIssue = () => {}
  G.setActiveMap = () => {}
  G.showPop = () => {}
  G.truthWriteWindowOpen = () => false
  G.fitAllTags = () => {}
  G._tagsFpOf = new Map()
  G.isEnabled = () => false
  G.panelNow = () => 0
  G.panelClock = {}
  G.chainSteps = () => []
  G.compute = () => ([{ blocked: [], claimed: [] }])
  G.deckCountsOf = () => null
  G.openIssuesOf = (st: any) => ((st && st.snapshot && st.snapshot.issues) || []).filter((x: any) => String(x.state).toUpperCase() !== 'CLOSED')
  G.isOccupied = () => false
  G.mapBlockOf = () => ({})
  G.applyStandaloneBlocks = () => {}
  G.healthCheckVisible = () => false
  G.healthCheckCountOf = () => 0
  G.closedPagesNode = () => null
  G.truthNoticeLines = () => []
  G.getCachedSnapshot = () => null
  G.loadIssuePage = () => {}
  G.FallbackMark = () => null
  G.useClosedPageScroll = () => {}
  G.labelClicks = {}
  G.listPrefs = {}
  G.saveLabelClicks = () => {}
  G.saveListPrefs = () => {}
  G.useLiquidInk = () => null
  G.liquidInkRemember = () => {}
  G.useIssueDetailFold = () => null
  const { ticketLabelOf, ticketLabelNodesOf, TICKET_LABEL_MAX_WIDTH } = await import('../src/client/kernel/ticket-label.js')
  G.ticketLabelOf = ticketLabelOf
  G.ticketLabelNodesOf = ticketLabelNodesOf
  G.TICKET_LABEL_MAX_WIDTH = TICKET_LABEL_MAX_WIDTH
  G.ticketBadgeOf = (await import('../src/client/views/shared/ticketBadge.js')).ticketBadgeOf
  G.listFilterRowNode = (await import('../src/client/views/listFilterRow.js')).listFilterRowNode
  const rowMod: any = await import('../src/client/views/ListTabRow.js')
  G.listIssueRow = rowMod.listIssueRow
  const listMod: any = await import('../src/client/views/ListTab.js')
  const topMod: any = await import('../src/client/views/MapDetailTop.js')
  const barMod: any = await import('../src/client/views/DetailActionBar.js')

  // B1–B4：containerStateOf 与 containerTriState 分流
  const openMapDoneNoSpec = { number: 10, key: '10', type: 'map', state: 'OPEN', labels: [{ name: 'wayfinder:map' }], stats: { total: 2, closed: 2 }, tickets: [] }
  const closedMapNoSpec = { number: 10, key: '10', type: 'map', state: 'CLOSED', labels: [{ name: 'wayfinder:map' }], stats: { total: 0, closed: 0 }, tickets: [] }
  const snapNoSpec = { issues: [], maps: [openMapDoneNoSpec] }
  const snapWithSpec = { issues: [], maps: [openMapDoneNoSpec, { number: 21, key: '21', type: 'spec', parentKey: '10', state: 'OPEN', stats: { total: 0, closed: 0 } }] }

  check(cv.containerStateOf(openMapDoneNoSpec, snapNoSpec) === 'handoff', 'B1 开放探索地图子票全关且未挂规格时判为 handoff')
  check(cv.containerStateOf(openMapDoneNoSpec, snapWithSpec) === 'done', 'B2 开放探索地图子票全关且已挂规格时判为 done')
  check(cv.containerStateOf(closedMapNoSpec, { issues: [], maps: [closedMapNoSpec] }) === 'handoff', 'B3 已关闭探索地图未挂规格时判为 handoff')
  check(cv.containerStateOf(closedMapNoSpec, { issues: [], maps: [closedMapNoSpec, { number: 21, key: '21', type: 'spec', parentKey: '10', state: 'CLOSED' }] }) === 'done',
    'B4 已关闭探索地图已挂规格时判为 done')
  const triHandoff = cv.containerTriState('map', 'handoff')
  check(triHandoff.labelKey === 'act.toSpec' && triHandoff.icon === 'handoff' && triHandoff.color === cv.CONTAINER_ACCENT.map,
    'B5 handoff 态按钮配置为「生成规格」+ handoff 图标 + 地图紫', triHandoff)
  check(cv.containerNumberColor('map', 'handoff') === cv.CONTAINER_DONE_COLOR, 'B6 handoff 态探索地图编号徽章保持完成绿')
  check(cv.containerPromptText({ snapshot: snapNoSpec }, openMapDoneNoSpec, 'map', 'handoff', 'https://github.com/acme/demo/issues/10') === 'PROMPT:mapToSpec:https://github.com/acme/demo/issues/10',
    'B7 handoff 态提示词注入 mapToSpec')

  // C1–C2：ListTab 在无开放票但有未挂规格的已关闭探索地图时默认展开折叠条并保留「生成规格」补救按钮
  const stClosedRecover = {
    snapshot: { issues: [closedMapNoSpec], maps: [closedMapNoSpec] },
    stateFilter: 'all', sortKey: 'updatedAt', sortDir: 'desc', effortFilter: '', search: '', labelFilter: [],
  }
  const htmlRecover = renderToStaticMarkup(React.createElement(DswsCtx.Provider, { value: { h: React.createElement } }, React.createElement(listMod.ListTab, { st: stClosedRecover })))
  check(htmlRecover.includes('<details style="margin-top:8px" open="">') || htmlRecover.includes('<details open=""'),
    'C1 无开放议题但有待交棒已关闭探索地图时，底部「已关闭」折叠条默认展开')
  check(htmlRecover.includes('data-log="list.row.tospec.10"') && htmlRecover.includes('>生成规格<') && htmlRecover.includes('data-log="list.row.newsession.10"'),
    'C2 待交棒已关闭探索地图行保留「生成规格」主按钮与「新会话」按钮')

  // C3：已挂规格的已关闭探索地图不再默认展开，也不再渲染「生成规格」行按钮
  const closedSpecRow = { number: 21, key: '21', type: 'spec', parentKey: '10', state: 'CLOSED', labels: [{ name: 'ready-for-agent' }], stats: { total: 2, closed: 2 } }
  const stClosedSettled = {
    snapshot: { issues: [closedMapNoSpec, closedSpecRow], maps: [closedMapNoSpec, closedSpecRow] },
    stateFilter: 'all', sortKey: 'updatedAt', sortDir: 'desc', effortFilter: '', search: '', labelFilter: [],
  }
  const htmlSettled = renderToStaticMarkup(React.createElement(DswsCtx.Provider, { value: { h: React.createElement } }, React.createElement(listMod.ListTab, { st: stClosedSettled })))
  check(!htmlSettled.includes('open=""') && !htmlSettled.includes('data-log="list.row.tospec.10"'),
    'C3 已挂规格的已关闭探索地图折叠条默认收起且不渲染「生成规格」补救按钮')

  // C4–C6：详情页顶栏与底栏在开放 handoff 态同时渲染「生成规格」与「直接结项」，已关闭 handoff 态只渲染「生成规格」
  const stOpenHandoff = { snapshot: snapNoSpec, copiedKey: '' }
  const topOpenHtml = renderToStaticMarkup(React.createElement(DswsCtx.Provider, { value: { h: React.createElement } },
    React.createElement(topMod.MapDetailTop, { st: stOpenHandoff, m: openMapDoneNoSpec, effStats: openMapDoneNoSpec.stats, kind: 'map', goBack: () => {} })))
  const barOpenHtml = renderToStaticMarkup(React.createElement(DswsCtx.Provider, { value: { h: React.createElement } },
    React.createElement(barMod.DetailActionBar, { st: stOpenHandoff, m: openMapDoneNoSpec, kind: 'map', cState: 'handoff', effStats: openMapDoneNoSpec.stats })))
  check(topOpenHtml.includes('data-log="map.top.exec"') && topOpenHtml.includes('>生成规格<') && topOpenHtml.includes('data-log="map.top.close"') && topOpenHtml.includes('>直接结项<'),
    'C4 开放待交棒探索地图顶栏同时提供「生成规格」主按钮与「直接结项」次按钮')
  check(barOpenHtml.includes('data-log="map.dest.exec"') && barOpenHtml.includes('>生成规格<') && barOpenHtml.includes('data-log="map.dest.close"') && barOpenHtml.includes('>直接结项<'),
    'C5 开放待交棒探索地图底部动作栏同时提供「生成规格」主按钮与「直接结项」次按钮')

  const stClosedHandoff = { snapshot: { issues: [closedMapNoSpec], maps: [closedMapNoSpec] }, copiedKey: '' }
  const topClosedHtml = renderToStaticMarkup(React.createElement(DswsCtx.Provider, { value: { h: React.createElement } },
    React.createElement(topMod.MapDetailTop, { st: stClosedHandoff, m: closedMapNoSpec, effStats: { total: 2, closed: 2 }, kind: 'map', goBack: () => {} })))
  check(topClosedHtml.includes('>生成规格<') && !topClosedHtml.includes('data-log="map.top.close"') && topClosedHtml.includes(trDict['map.closedToSpecTitle']),
    'C6 已关闭待交棒探索地图顶栏保留「生成规格」补救入口且不画多余的「直接结项」按钮')
}

async function main(): Promise<void> {
  await testMapCloseGuardTools()
  await testClientKernelAndViews()
  console.log('\n' + GATE + ': ' + (total - failed) + '/' + total + ' 通过')
  printGateResult(GATE, total, failed)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
