// verify-1487-map-plan.ts —— 批量建图的工具链路在原文布局下走通（#1487，父票 #1480）。
// 门禁归属: src/deck/tools/map-plan-create.ts
// 门禁归属: src/deck/tools/map-plan-readback.ts
// 门禁归属: src/deck/tools/map-snapshot.ts
// 门禁归属: src/tracker/rooms/markdown/create-layout.ts
// 门禁归属: src/tracker/rooms/markdown/issues-create.ts
//
// 这一扇门禁守的是 #1487 里「工具链路」那一半：建图工具一次建出 map.md + 子票之后，
//   ① 落盘位置是原文的 `.scratch/<effort>/map.md` 与 `.scratch/<effort>/issues/NN-slug.md`，
//      不再出现旧扁平布局的 `01-map.md`；
//   ② 建后读回核对认得出原文布局的子票正文（文件头是 DSH-PARENT / DSH-CREATED 隐藏注释），
//      能核到「Type: 四值裸行」，回执里说的是「核对通过」而不是「没对上」；
//   ③ 地图快照按 00 号读回五区块与两张子票，统计数对得上。
//
// 跑法：node --import ./scripts/ts-hook.mts tests/verify-1487-map-plan.ts
const path = require('path')
const fs = require('fs')
const os = require('os')
const { pathToFileURL } = require('url')
// 判定出口桩（#1003 单出口）：夹具照生产接法给上，工作区选过这句话记在桩的账本里。
const { makeDecideStub, chooseWorkspace } = require('./lib/deck-decide-stub.ts')

const ROOT = path.resolve(__dirname, '..')
let checks = 0
const failures = []
const check = (ok, message) => { checks += 1; console.log((ok ? '  PASS ' : '  FAIL ') + message); if (!ok) failures.push(message) }
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

/** 最小平台文件层：与 markdown 后端现有门禁用的是同一套形状（resolve/readText/writeText/lstat/listDir/stat）。 */
function makePlat() {
  return {
    path: path.posix,
    fs: {
      async resolve(p) { return String(p).replace(/\\/g, '/') },
      async readText(t) { return fs.readFileSync(t, 'utf8') },
      async writeText(t, c) { fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, c, 'utf8') },
      async lstat(t) { try { return fs.statSync(t) } catch (e) { return null } },
      async listDir(t) { try { return fs.readdirSync(t) } catch (e) { return [] } },
      async stat(t) { try { return fs.statSync(t) } catch (e) { return null } },
    },
  }
}

async function main() {
  console.log('#1487 门禁：批量建图与快照在原文布局下走通')
  const { slugify } = await imp('src/tracker/rooms/markdown/parse.ts')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '1487-plan-'))
  const rootPosix = tmp.replace(/\\/g, '/')
  const effortDir = path.join(tmp, '.scratch', 'plan-effort')
  const plat = makePlat()
  const ctx = { platform: plat, fs: plat.fs, cwd: rootPosix, get(n) { return n === 'fs' ? plat.fs : undefined } }

  const budget = await imp('src/refresh/kernel/host-budget.js')
  const ledgerMod = await imp('src/refresh/rooms/host/quota-ledger.ts')
  const gateMod = await imp('src/refresh/rooms/host/refresh-gate.ts')
  const registryMod = await imp('src/tracker/registry/core.ts')
  const markdownModule = (await imp('src/tracker/rooms/markdown/index.ts')).markdownModule
  const toolCost = await imp('src/refresh/kernel/tool-call-budget.js')
  const planMod = await imp('src/deck/tools/map-plan-create.ts')
  const snapMod = await imp('src/deck/tools/map-snapshot.ts')

  let clock = 1700000000000
  const ledger = ledgerMod.createLedger({ now: () => clock })
  const gate = gateMod.createGate({ ledger: ledger, now: () => clock })
  const registry = registryMod.createRegistry(Object.assign({ logEvent: () => {}, isEnabled: () => false }, ctx), { matchesTimeout: 200 })
  const dispose = registry.register(markdownModule)
  // 这个工作区选过 markdown：跳过自动识别，直接落本地后端。
  chooseWorkspace(rootPosix, 'markdown')
  // #1446 账本按后端分键：读数落在这一个后端的桶里，换后端不许混账。
  ledger.ensureBackend('github', { kind: 'two-buckets' })
  ledger.syncServer('github', { rest: { limit: 5000, remaining: 5000, reset: clock + 3600000 }, graphql: { limit: 5000, remaining: 5000, reset: clock + 3600000 } }, clock)

  const makePlanStore = () => { const t = new Map(); return { durable: true, load(id) { return t.get(id) || null }, save(id, s) { t.set(id, s) } } }
  const deps = {
    gate: gate, registry: registry, budget: budget,
    estimate: toolCost.estimateToolCost, costInputFrom: toolCost.toolCostInputFrom,
    backendCtx: ctx, handleFor: () => ({ cwd: rootPosix }),
    log: { fire: () => {} }, now: () => clock,
    invalidate: () => {},
    decideBackend: makeDecideStub(registry),
    planStore: makePlanStore(),
  }
  const readbackMod = await imp('src/deck/tools/map-plan-readback.ts')
  const kindRules = await imp('src/deck/rules/object-kind.ts')
  const planTool = planMod.createDeckMapPlanCreate(deps)
  const snapTool = snapMod.createDeckMapSnapshot(deps)
  const exec = { agent: { session: { id: 's-1487-plan', cwd: rootPosix } } }

  // ⓪ 读回核对（readbackMapPlan）形状判据：远端票正文含 DSH-PARENT（云效双写兜底、GitLab 父子唯一真相）
  // 但不含 DSH-FORMAT / DSH-CREATED 等整份文件标记时，不该误判成整份文件去核 Type 行；
  // 本地整份文件（含 DSH-FORMAT）仍照常核对 Type 行。
  {
    const stubMapBody = '## Destination\n\n目标\n\n## Notes\n\n## Decisions so far\n\n## Not yet specified\n\n## Out of scope\n\n## 进度\n\n- 0%'
    const childKinds = new Map([['c1', kindRules.resolveCreateKind({ kind: 'map-ticket', label: 'wayfinder:research', parentKey: '1' })]])
    const runReadback = (childBody) => readbackMod.readbackMapPlan({
      tracker: { get: async () => ({ ok: true, data: { key: '1', body: stubMapBody } }) },
      repo: {}, opCtx: {}, mapKey: '1', outOfBudget: false, pickedNote: '',
      liveRows: [{ key: '2', parentKey: '1', labels: ['wayfinder:research'], body: childBody }],
      children: [{ key: 'c1', title: '子票一', kind: 'map-ticket', label: 'wayfinder:research' }],
      childKinds: childKinds, keys: { c1: '2' },
    })
    const remoteParentOnly = await runReadback('<!-- DSH-IDEMPOTENCY-KEY: deck-123 -->\n<!-- DSH-PARENT: 1 -->\n\n远端正文\n\n## 进度\n\n- 0%')
    const remoteTypeFails = (remoteParentOnly.items || []).filter((i) => String(i.reason || '').indexOf('Type 行') >= 0)
    check(remoteParentOnly.items.length === 0 && remoteTypeFails.length === 0 && (remoteParentOnly.notes || []).some((n) => n.indexOf('建后读回核对通过') >= 0 && n.indexOf('与 Type 行') < 0),
      '远端正文只含 DSH-PARENT 与幂等锚（云效/GitLab 形状）、无 Type 行时，不误判成整份文件、不报 Type 行失败：' + JSON.stringify(remoteParentOnly))

    const localWholeOk = await runReadback('<!-- DSH-FORMAT: md-v1 -->\n<!-- DSH-PARENT: 1 -->\n<!-- DSH-CREATED: 2026-11-11T00:00:00.000Z -->\n# 02: 子票一\n\nType: research\n\n## Question\n\n正文\n\n## 进度\n\n- 0%')
    check(localWholeOk.items.length === 0 && (localWholeOk.notes || []).some((n) => n.indexOf('与 Type 行') >= 0),
      '本地整份文件（含 DSH-FORMAT + Type 行）仍触发并核对通过 Type 行：' + JSON.stringify(localWholeOk.notes))

    const localWholeBad = await runReadback('<!-- DSH-FORMAT: md-v1 -->\n<!-- DSH-PARENT: 1 -->\n<!-- DSH-CREATED: 2026-11-11T00:00:00.000Z -->\n# 02: 子票一\n\nType: task\n\n## Question\n\n正文\n\n## 进度\n\n- 0%')
    check(localWholeBad.items.length === 1 && String(localWholeBad.items[0].reason || '').indexOf('Type 行不是 research') >= 0,
      '本地整份文件 Type 行写错时仍如实报出 verify 失败：' + JSON.stringify(localWholeBad.items))

    const legacyWholeOk = await runReadback('<!-- parentKey: 1 -->\n<!-- created: 2026-10-01T00:00:00.000Z -->\n# 02: 旧布局子票\n\nType: research\n\n## Question\n\n正文\n\n## 进度\n\n- 0%')
    check(legacyWholeOk.items.length === 0 && (legacyWholeOk.notes || []).some((n) => n.indexOf('与 Type 行') >= 0),
      '本地旧布局整份文件（parentKey / created 裸名注释）仍触发并核对通过 Type 行：' + JSON.stringify(legacyWholeOk.notes))

    const githubShape = await runReadback('<!-- DSH-IDEMPOTENCY-KEY: deck-123 -->\n\n远端正文\n\n## 进度\n\n- 0%')
    check(githubShape.items.length === 0 && (githubShape.notes || []).some((n) => n.indexOf('建后读回核对通过') >= 0 && n.indexOf('与 Type 行') < 0),
      '无任何文件头标记的远端形状（GitHub 形状）照旧跳过 Type 行核对并通过：' + JSON.stringify(githubShape.notes))
  }

  // ⓪b 车道级：云效（Yunxiao）房间上跑 deck_map_plan_create，子票正文带 DSH-PARENT 但不写 Type 行，
  // 建后读回核对不报 Type 行假失败，整单结论为 ok。
  {
    const yxMod = await imp('src/tracker/rooms/yunxiao/index.ts')
    const yxRepoIdMod = await imp('src/tracker/rooms/yunxiao/model/repo-identity.ts')
    const yxMarkersMod = await imp('src/tracker/rooms/yunxiao/model/description-markers.ts')
    const bridgeMod = await imp('src/refresh/registry/deck-tool-bridge.ts')
    yxRepoIdMod.clearLearnedYunxiaoContexts()
    yxMarkersMod.clearYunxiaoIssueKeyCache()
    const orgId = '673db5665c76405a332eebc4'
    const projId = '8efcbccd3981cb23178fc66bd1'
    const refId = orgId + '/' + projId
    const yxYaml = ['version: 1', 'organizationId: ' + orgId, 'projectId: ' + projId, 'customCode: DCIAFS'].join('\n')
    const createdStore = new Map()
    const projectLabels = [
      { id: 'lbl-map', name: 'wayfinder:map', color: '#8B5CF6' },
      { id: 'lbl-research', name: 'wayfinder:research', color: '#0EA5E9' },
      { id: 'lbl-task', name: 'wayfinder:task', color: '#10B981' },
    ]
    let nextSerial = 1
    const yxCtx = {
      cwd: '/ws-1487-yx',
      platform: {
        fs: { resolve: async (rel) => '/ws-1487-yx/' + rel, readText: async () => yxYaml, writeText: async () => {} },
        env: { get: (k) => (k === 'YUNXIAO_TOKEN' ? 'pt-validtoken12345678' : undefined), has: (k) => k === 'YUNXIAO_TOKEN' },
      },
      fetch: async (input, init) => {
        const u = String(input)
        const method = ((init && init.method) || 'GET').toUpperCase()
        if (u.endsWith('/oapi/v1/platform/user')) return new Response(JSON.stringify({ id: '6a86ddf4dfcb465c20f193e2', name: 'BryanShao', lastOrganization: orgId }), { status: 200 })
        if (u.indexOf('/projex/organizations/' + orgId + '/projects/' + projId) >= 0 && method === 'GET' && u.indexOf('/workitemTypes') < 0 && u.indexOf('/labels') < 0) {
          return new Response(JSON.stringify({ id: projId, name: 'Deck Yunxiao', customCode: 'DCIAFS' }), { status: 200 })
        }
        if (u.indexOf('/workitemTypes') >= 0 && method === 'GET') {
          const isReq = u.indexOf('category=Req') >= 0
          return new Response(JSON.stringify([{ id: isReq ? 'type-req-1' : 'type-task-1', categoryId: isReq ? 'Req' : 'Task', name: isReq ? '需求' : '任务', enable: true, defaultType: true }]), { status: 200 })
        }
        if (u.indexOf('/labels') >= 0 && method === 'GET') return new Response(JSON.stringify(projectLabels), { status: 200 })
        if (u.endsWith('/workitems:search') && method === 'POST') {
          const all = Array.from(new Set(createdStore.values()))
          return new Response(JSON.stringify(all), { status: 200, headers: { 'x-page': '1', 'x-per-page': '100', 'x-total': String(all.length), 'x-total-pages': '1' } })
        }
        if (u.endsWith('/workitems') && method === 'POST') {
          const b = JSON.parse(String((init && init.body) || '{}'))
          const num = nextSerial++
          const id = ('createditem00000000000000' + String(num)).slice(-26)
          const lbls = (b.labels || []).map((lid) => projectLabels.find((l) => l.id === lid) || { id: lid, name: lid, color: '#000000' })
          const rec = { id: id, serialNumber: 'DCIAFS-' + String(num), subject: b.subject, description: b.description || '', formatType: 'MARKDOWN', workitemType: { id: b.workitemTypeId }, statusStageId: '1', parentId: b.parentId || null, assignedTo: { id: b.assignedTo, name: 'BryanShao' }, labels: lbls }
          createdStore.set(id, rec)
          createdStore.set(rec.serialNumber, rec)
          return new Response(JSON.stringify({ id: id }), { status: 200 })
        }
        if (u.indexOf('/relationRecords') >= 0 && method === 'GET') return new Response(JSON.stringify([]), { status: 200 })
        if (u.indexOf('/comments') >= 0 && method === 'GET') return new Response(JSON.stringify([]), { status: 200 })
        if (u.indexOf('/workitems/') >= 0 && method === 'GET') {
          const keyOrId = decodeURIComponent(u.split('/workitems/')[1].split('?')[0])
          const item = createdStore.get(keyOrId)
          return item ? new Response(JSON.stringify(item), { status: 200 }) : new Response('{}', { status: 404 })
        }
        return new Response('[]', { status: 200 })
      },
    }
    ledger.ensureBackend('yunxiao', { kind: 'requests-only' })
    ledger.syncServer('yunxiao', { requests: { limit: 2000, remaining: 2000, reset: clock + 3600000 } }, clock)
    const yxReg = registryMod.createRegistry({ logEvent: () => {}, isEnabled: () => false }, { matchesTimeout: 200 })
    const yxDispose = yxReg.register(yxMod.yunxiaoBackend)
    chooseWorkspace('/ws-1487-yx', 'yunxiao')
    const yxPorts = bridgeMod.buildTrackerPorts({ ledger: ledger, registry: yxReg })
    const yxPlanTool = planMod.createDeckMapPlanCreate({
      gate: gate, registry: yxReg, budget: budget,
      estimate: toolCost.estimateToolCost, costInputFrom: toolCost.toolCostInputFrom,
      handleFor: () => ({ cwd: '/ws-1487-yx', refId: refId }),
      backendCtx: () => yxCtx,
      getCachedReading: yxPorts.getCachedReading, admit: yxPorts.admit, accountPort: yxPorts.account,
      now: () => clock, log: { fire: () => {} }, decideBackend: makeDecideStub(yxReg),
      planStore: makePlanStore(),
      invalidate: () => {},
    })
    const yxPlan = await yxPlanTool.run({ agent: { session: { id: 's-1487-yx', cwd: '/ws-1487-yx' } } }, {
      planId: '1487-yx-plan-1', title: '云效探索地图',
      children: [
        { key: 'c1', title: '云效调研子票', kind: 'map-ticket', label: 'wayfinder:research' },
        { key: 'c2', title: '云效任务子票', kind: 'map-ticket', label: 'wayfinder:task' },
      ],
    })
    const yxFailed = ((yxPlan && yxPlan.items) || []).filter((i) => i.status !== 'ok')
    const yxChild1 = createdStore.get('DCIAFS-2')
    check(!!yxChild1 && String(yxChild1.description || '').indexOf('<!-- DSH-PARENT: 1 -->') >= 0 && !/^\s*Type\s*[：:]/m.test(String(yxChild1.description || '')),
      '云效建出的地图工单子票正文含 DSH-PARENT 且不含 Type 行：' + JSON.stringify(yxChild1 && yxChild1.description))
    check(yxPlan && yxPlan.ok === true && yxPlan.status === 'ok' && yxFailed.length === 0 && ((yxPlan.notes || []).some((n) => n.indexOf('建后读回核对通过') >= 0 && n.indexOf('与 Type 行') < 0)),
      '云效车道 deck_map_plan_create 建图读回核对通过、整体 status=ok、无 Type 行假失败：' + JSON.stringify({ status: yxPlan && yxPlan.status, notes: yxPlan && yxPlan.notes, failed: yxFailed }))
    try { yxDispose.dispose() } catch (e) {}
  }

  // ① 建整张地图：地图 + 两张地图子票，全部落在 .scratch/plan-effort 下。
  const plan = await planTool.run(exec, {
    planId: '1487-plan-1', title: '探索地图乙', effort: 'plan-effort',
    children: [
      { key: 'q1', title: '现成方案有哪些？', kind: 'map-ticket', label: 'wayfinder:research', body: '先查有没有现成的做法。' },
      { key: 'q2', title: '要不要自研？', kind: 'map-ticket', label: 'wayfinder:grilling', body: '把自研的代价摆出来。' },
    ],
  })
  check(plan && plan.status === 'ok', '建图整体成功（实得 ' + (plan && plan.status) + '，回执 ' + JSON.stringify(plan && plan.text) + '）')
  const mapKey = String((plan && plan.data && plan.data.mapKey) || '')
  check(mapKey === '00', '地图票号是 00（实得 ' + (mapKey || '空') + '）')
  const builtKeys = (plan && plan.data && plan.data.builtKeys) || []
  check(builtKeys.length === 2, '回执说建出两张子票（实得 ' + builtKeys.length + ' 张：' + JSON.stringify(builtKeys) + '）')
  check(String((plan && plan.data && plan.data.counts && plan.data.counts.actual) || '') === '3', '逐项校验认为实际建了 3 张（地图 + 2 子票，实得 ' + ((plan && plan.data && plan.data.counts && plan.data.counts.actual) || '?') + '）')
  const planNotes = ((plan && plan.notes) || []).join('\n')
  check(planNotes.indexOf('建后读回核对通过') >= 0, '建后读回核对通过：' + JSON.stringify(((plan && plan.notes) || []).slice(-2)))
  check(planNotes.indexOf('与 Type 行') >= 0, '读回核到了 Type 行（原文布局的文件头注释认得出）：' + JSON.stringify(((plan && plan.notes) || []).filter((n) => n.indexOf('读回核对') >= 0)))
  check(planNotes.indexOf('没对上') < 0, '读回没有报「没对上」：' + JSON.stringify(((plan && plan.notes) || []).filter((n) => n.indexOf('没对上') >= 0)))
  check(planNotes.indexOf('这次没核对') < 0, '读回没有退成「这次没核对」：' + JSON.stringify(((plan && plan.notes) || []).filter((n) => n.indexOf('没核对') >= 0)))

  // ② 盘上位置：map.md 在 effort 目录下，旧扁平布局的 01-map.md 不再出现。
  const mapPath = path.join(effortDir, 'map.md')
  check(fs.existsSync(mapPath), '盘上有 .scratch/plan-effort/map.md（路径 ' + mapPath + '）')
  check(!fs.existsSync(path.join(effortDir, '01-map.md')), '旧扁平布局的 01-map.md 不再出现')
  const mapText = fs.existsSync(mapPath) ? fs.readFileSync(mapPath, 'utf8') : ''
  check(!/^#[ \t]+\S/m.test(mapText), '地图不写可见一级标题（原文模板没有标题行）：' + JSON.stringify(mapText.slice(0, 80)))
  check(mapText.indexOf('<!-- DSH-TITLE: 探索地图乙 -->') >= 0, '地图标题写进 DSH-TITLE 隐藏注释：' + JSON.stringify(mapText.slice(0, 200)))
  check(mapText.indexOf('## Destination') >= 0 && mapText.indexOf('## Notes') >= 0 && mapText.indexOf('## Decisions so far') >= 0 && mapText.indexOf('## Not yet specified') >= 0 && mapText.indexOf('## Out of scope') >= 0, '地图五区块齐（原文模板）')
  check(mapText.indexOf('## 进度') >= 0, '地图有 ## 进度（原文件末尾追加）')
  check(/<!--\s*DSH-STATUS\s*:/.test(mapText), '地图的状态写在隐藏注释里，没有可见 Status 行：' + JSON.stringify(mapText.split('\n').slice(0, 8)))

  const issuesDir = path.join(effortDir, 'issues')
  const childFiles = fs.existsSync(issuesDir) ? fs.readdirSync(issuesDir).filter((f) => f.endsWith('.md')) : []
  check(childFiles.length === 2, '子票落成两个文件（实得 ' + JSON.stringify(childFiles) + '）')
  const childOneName = '01-' + slugify('现成方案有哪些？') + '.md'
  const childTwoName = '02-' + slugify('要不要自研？') + '.md'
  check(childFiles.indexOf(childOneName) >= 0, '第一张子票文件名按原文编号加标题 slug：' + childOneName)
  check(childFiles.indexOf(childTwoName) >= 0, '第二张子票文件名按原文编号加标题 slug：' + childTwoName)
  const childOne = fs.existsSync(path.join(issuesDir, childOneName)) ? fs.readFileSync(path.join(issuesDir, childOneName), 'utf8') : ''
  check(childOne.indexOf('# 01: 现成方案有哪些？') >= 0, '子票一级标题是「# NN: 标题」：' + JSON.stringify(childOne.slice(0, 120)))
  check(/^Type:\s*research\s*$/m.test(childOne), '子票正文有可见的裸行 Type: research')
  check(/^Status:\s*(claimed|resolved)\s*$/m.test(childOne) || childOne.indexOf('Status:') < 0, '子票的 Status 行要么写可见裸行，要么不写（没有别的写法）')
  check(childOne.indexOf('## Question') >= 0, '子票正文落在 ## Question 段下')
  check(/<!--\s*DSH-PARENT\s*:\s*00\s*-->/.test(childOne), '子票文件头写明父票是 00：' + JSON.stringify(childOne.split('\n').slice(0, 7)))
  check(childOne.indexOf('## 进度') >= 0, '子票有 ## 进度（原文件末尾追加）')
  const childTwo = fs.existsSync(path.join(issuesDir, childTwoName)) ? fs.readFileSync(path.join(issuesDir, childTwoName), 'utf8') : ''
  check(/^Type:\s*grilling\s*$/m.test(childTwo), '第二张子票的 Type 行是 grilling')

  // ③ 地图快照按 00 号读回：五区块与两张子票都在，统计数对得上。
  const snap = await snapTool.run(exec, { key: '00', effort: 'plan-effort' })
  check(snap && snap.status === 'ok', '快照回 ok（实得 ' + (snap && snap.status) + '，话术 ' + JSON.stringify(snap && snap.text) + '）')
  const snapData = (snap && snap.data) || {}
  check(String((snapData.map && snapData.map.key) || '') === '00', '快照里的地图是 00 号（实得 ' + ((snapData.map && snapData.map.key) || '空') + '）')
  check(Array.isArray(snapData.children) && snapData.children.length === 2, '快照列出两张子票（实得 ' + ((snapData.children && snapData.children.length) || '?') + ' 张）')
  // 五区块都要读回同一份形状：Destination 是字符串（原文建骨架时这段可以空着），其余四段是数组。
  const blocks = snapData.blocks || {}
  check(typeof blocks.destination === 'string' && Array.isArray(blocks.notes) && Array.isArray(blocks.decisions) && Array.isArray(blocks.fog) && Array.isArray(blocks.outOfScope), '快照读出地图五区块：' + JSON.stringify({ destination: blocks.destination, notes: blocks.notes, decisions: blocks.decisions, fog: blocks.fog, outOfScope: blocks.outOfScope }).slice(0, 240))
  check(!!(snapData.stats && snapData.stats.open === 2), '快照统计未关闭 2 张（实得 ' + JSON.stringify(snapData.stats) + '）')

  try { dispose.dispose() } catch (e) { /* 清理失败不影响结论 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (e) { /* 临时目录清不掉不影响结论 */ }

  console.log('\n' + (failures.length === 0 ? 'PASS' : 'FAIL') + ' verify-1487-map-plan: ' + checks + ' checks, ' + failures.length + ' failed')
  if (failures.length) {
    console.log('失败项：\n- ' + failures.join('\n- '))
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('门禁脚本自己抛了：', e)
  process.exitCode = 1
})
