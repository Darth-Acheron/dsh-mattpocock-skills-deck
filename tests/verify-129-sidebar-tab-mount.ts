/**
 * tests/verify-129-sidebar-tab-mount.ts —— 右侧边栏面板标签页 props 透传与 rAF 挂起兜底门禁（#129）
 *
 * 守什么：
 *   A DeckSidebarTab 渲染 DetailsDock 时必须把宿主 SessionEntry 注入的完整 props（如 useSessions、session）
 *     连同 sessionId 一起透传下去，不能只传 { sessionId } 把 useSessions 丢掉（丢掉会让 DetailsDock 的
 *     summaryCwd 恒为 undefined，切会话时失去工作区路径响应式同步）；
 *   B DeckSidebarTab 的双跳 requestAnimationFrame 在后台标签页或隐藏会话子树（hidden: !active）被浏览器挂起时，
 *     必须由宏任务定时器兜底推进 ready=true，绝不永久停在 <div class="dsws-hold"></div> 纯黑空白壳；
 *   C 正常前台帧下仍保持「首帧空壳、两跳 rAF 后挂内容」的节奏，且组件卸载时一并清理定时器与 rAF。
 *
 * 运行：node --import ./scripts/ts-hook.mts tests/verify-129-sidebar-tab-mount.ts
 */
// 门禁归属: src/client/kernel/router.ts

import { spliceableJs } from './lib/source-text.ts'
import { compileFn } from './lib/eval-probe.ts'
import { printGateResult } from './lib/gate-result.ts'

const GATE = 'verify-129-sidebar-tab-mount'
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

interface EnvOptions {
  initialReady: boolean
  rafStalled: boolean
}

function makeEnv(opts: EnvOptions) {
  let stateVal = opts.initialReady
  let setReadyCalls = 0
  let effectCleanup: (() => void) | null = null
  const rafScheduled: Array<() => void> = []
  const rafCancelled: number[] = []
  const timeoutScheduled: Array<{ id: number; fn: () => void; ms: number }> = []
  const timeoutCleared: number[] = []
  let dockReceivedProps: any = null

  const prevRaf = (globalThis as any).requestAnimationFrame
  const prevCancelRaf = (globalThis as any).cancelAnimationFrame
  const prevSetTimeout = globalThis.setTimeout
  const prevClearTimeout = globalThis.clearTimeout

  ;(globalThis as any).requestAnimationFrame = function (fn: () => void): number {
    rafScheduled.push(fn)
    return rafScheduled.length
  }
  ;(globalThis as any).cancelAnimationFrame = function (id: number): void {
    rafCancelled.push(id)
  }
  ;(globalThis as any).setTimeout = function (fn: () => void, ms?: number): any {
    const id = timeoutScheduled.length + 100
    timeoutScheduled.push({ id, fn, ms: Number(ms ?? 0) })
    return id
  }
  ;(globalThis as any).clearTimeout = function (id: any): void {
    timeoutCleared.push(Number(id))
  }

  function restoreGlobals(): void {
    ;(globalThis as any).requestAnimationFrame = prevRaf
    ;(globalThis as any).cancelAnimationFrame = prevCancelRaf
    globalThis.setTimeout = prevSetTimeout
    globalThis.clearTimeout = prevClearTimeout
  }

  const body = spliceableJs('src/client/kernel/router.js').replace(/^[ \t]*export[ \t]+/gm, '')
  const noop = function () {}
  const sandbox: Record<string, any> = {
    isEnabled: () => false,
    log: noop,
    ctx: { get: () => null },
    h: (type: any, props: any, ...children: any[]) => ({ type, props: props || {}, children }),
    React: {
      useState: (init: any) => [
        stateVal,
        (next: any) => {
          stateVal = typeof next === 'function' ? next(stateVal) : next
          setReadyCalls += 1
        },
      ],
      useEffect: (fn: () => any) => {
        const clean = fn()
        if (typeof clean === 'function') effectCleanup = clean
      },
    },
    DetailsDock: function DetailsDock(p: any): any {
      dockReceivedProps = p
      return { type: 'DetailsDockRendered', props: p }
    },
    tr: (k: string) => k,
    flash: noop,
    emit: noop,
    getCwdSync: () => '/Users/bryan/projects/dci-agent-bill',
    hydrateFromCache: noop,
    getCachedSnapshot: () => null,
    snapFresh: () => false,
    loadSnapshot: noop,
    startAttentionSignals: noop,
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
    SLOT_QUEUE_STEP_MS: 80,
  }
  const names = Object.keys(sandbox)
  const factory = compileFn(names, body + '\n;return { DeckSidebarTab: DeckSidebarTab }')
  const mod = factory(...names.map((n) => sandbox[n]))
  return {
    mod,
    getStateVal: () => stateVal,
    getSetReadyCalls: () => setReadyCalls,
    getEffectCleanup: () => effectCleanup,
    getDockReceivedProps: () => dockReceivedProps,
    rafScheduled,
    rafCancelled,
    timeoutScheduled,
    timeoutCleared,
    restoreGlobals,
  }
}

function main(): void {
  // ── A. props 透传：宿主交进来的 useSessions 等标准属性必须原样传给 DetailsDock ──
  {
    const env = makeEnv({ initialReady: true, rafStalled: false })
    try {
      const useSessionsStub = function () { return 'sid-bill' }
      const tree = env.mod.DeckSidebarTab({
        sessionId: 'sid-bill',
        useSessions: useSessionsStub,
        extraProp: 'kept',
      })
      const dockNode = tree && tree.children && tree.children[0]
      const dockProps = dockNode && dockNode.props
      check(
        !!dockProps && dockProps.sessionId === 'sid-bill',
        'A1 DeckSidebarTab 把 sessionId 传给 DetailsDock',
        dockProps,
      )
      check(
        !!dockProps && dockProps.useSessions === useSessionsStub && dockProps.extraProp === 'kept',
        'A2 DeckSidebarTab 把宿主注入的完整 props（含 useSessions）透传给 DetailsDock，不吞掉',
        dockProps ? Object.keys(dockProps) : null,
      )
    } finally {
      env.restoreGlobals()
    }
  }

  // ── B. 后台/隐藏帧 rAF 挂起兜底：rAF 不触发时，宏任务定时器必须把 ready 推成 true ──
  {
    const env = makeEnv({ initialReady: false, rafStalled: true })
    try {
      const firstTree = env.mod.DeckSidebarTab({ sessionId: 'sid-bill' })
      check(
        firstTree && firstTree.props && firstTree.props.className === 'dsws-hold' && firstTree.children.length === 0,
        'B1 首帧 ready=false 时仍先画 .dsws-hold 空壳（保持 #603/#670 首帧约定）',
        firstTree,
      )
      check(env.rafScheduled.length === 1, 'B2 已排第一跳 rAF', env.rafScheduled.length)
      check(
        env.timeoutScheduled.length === 1 && env.timeoutScheduled[0].ms === 80,
        'B3 同时排了一支 SLOT_QUEUE_STEP_MS（80ms）宏任务兜底定时器',
        env.timeoutScheduled.map((t) => t.ms),
      )
      // 模拟后台/隐藏帧：rAF 永远不触发，但宏任务定时器到点执行
      if (env.timeoutScheduled[0]) env.timeoutScheduled[0].fn()
      check(
        env.getStateVal() === true && env.getSetReadyCalls() === 1,
        'B4 rAF 被挂起不触发时，兜底定时器到点把 ready 置为 true（不再永久卡在空白壳）',
        { ready: env.getStateVal(), calls: env.getSetReadyCalls() },
      )
    } finally {
      env.restoreGlobals()
    }
  }

  // ── C. 正常前台两跳 rAF 与卸载清理：rAF 两跳正常置 ready，卸载时清理定时器与 rAF ──
  {
    const env = makeEnv({ initialReady: false, rafStalled: false })
    try {
      env.mod.DeckSidebarTab({ sessionId: 'sid-bill' })
      // 第一跳 rAF 触发 → 排第二跳 rAF，此时 ready 仍为 false
      if (env.rafScheduled[0]) env.rafScheduled[0]()
      check(
        env.getStateVal() === false && env.rafScheduled.length === 2,
        'C1 第一跳 rAF 后仍为外壳、排入第二跳 rAF',
        { ready: env.getStateVal(), rafCount: env.rafScheduled.length },
      )
      // 第二跳 rAF 触发 → ready 变 true
      if (env.rafScheduled[1]) env.rafScheduled[1]()
      check(env.getStateVal() === true, 'C2 第二跳 rAF 后 ready 置为 true', env.getStateVal())
      // 卸载清理：定时器与两跳 rAF 都被清理
      const cleanup = env.getEffectCleanup()
      if (cleanup) cleanup()
      check(
        env.timeoutCleared.length === 1 && env.rafCancelled.length === 2,
        'C3 卸载清理函数一并撤销兜底定时器与两跳 rAF 句柄',
        { timeoutCleared: env.timeoutCleared, rafCancelled: env.rafCancelled },
      )
    } finally {
      env.restoreGlobals()
    }
  }

  console.log('')
  console.log(failed ? '存在失败 — ' + GATE + ' 未通过' : '全部通过 — 右侧面板挂载与属性透传门禁生效（' + total + ' 项断言）')
  printGateResult(GATE, total, failed)
  process.exit(failed ? 1 : 0)
}

main()
