/**
 * views/listTree.ts —— 主列表父子层级归属树构建与可折叠渲染叶子。
 *
 * 为什么单独成片：
 *   1. ListTab.ts 已贴近单文件 350 有效行上限（同目录的 listFilterRow.ts、mdEffortRow.ts 均因此单列）；
 *   2. 「把排好序的容器与工单按 parentKey 归拢成三级树」是纯数据结构组装，单列出来后门禁可以直接验证
 *      树结构与渲染顺序，不依赖外层完整面板环境。
 *
 * 不能改的四条约定：
 *   1. 最大缩进深度为 2（共三级：0=顶层探索地图或独立规格或独立票，1=地图下的规格/探索工单或独立规格下的实施票，
 *      2=挂在探索地图下的规格内部的实施票），超出深度或环路引用一律截断到安全层级，绝不死循环。
 *   2. 零遗漏开放工作（延续 #1291）：任何未关闭的规格或未关闭的工单，若没有 parentKey、或 parentKey 指向已关闭/
 *      不存在的父容器，一律自动提升到顶层对应分组（独立规格组或独立开放票组）展示，绝不因父容器关闭而隐没。
 *   3. 无父子边时与平铺三段完全等价：当池子里所有行都没有命中开放父容器的 parentKey 时，渲染出的行顺序与
 *      「探索地图 → 规格 → 普通票」平铺顺序逐行一致。
 *   4. 会话私有折叠态：st.treeCollapsed[id] 默认 false（开放容器默认展开未关闭子票），
 *      st.treeClosedOpen[id] 默认 false（开放容器下的已关闭子票默认收拢成一条紧凑折叠条，点击再展开）。
 */

declare function Ic(...args: any[]): any;
declare function effortOf(...args: any[]): any;
declare function emit(...args: any[]): any;
declare function idOf(...args: any[]): any;
declare function idOfParts(...args: any[]): any;
declare function listIssueRow(...args: any[]): any;
declare function tr(...args: any[]): any;

/** 最大缩进层级：第 0 层顶层、第 1 层一级子项、第 2 层二级子项（共三级）。 */
export const LIST_TREE_MAX_DEPTH: number = 2

/** 树里的一个容器节点（探索地图或规格）。 */
export interface ListContainerTreeNode {
  row: any
  kind: 'map' | 'spec'
  depth: number
  /** 仅探索地图节点非空：挂在该地图下的开放规格节点（depth=1）。 */
  openSpecs: ListContainerTreeNode[]
  /** 直接挂在该容器下的开放工单行（排好序）。 */
  openTickets: any[]
  /** 直接挂在该容器下的已关闭行（含已关闭工单或已关闭子规格，排好序）。 */
  closedChildren: any[]
}

/** 整棵列表树的构建结果。 */
export interface ListTicketTreeModel {
  /** 顶层探索地图节点（depth=0）。 */
  rootMaps: ListContainerTreeNode[]
  /** 未挂在开放探索地图下的顶层独立规格节点（depth=0）。 */
  rootSpecs: ListContainerTreeNode[]
  /** 未挂在任何开放容器下的独立开放工单（depth=0）。 */
  standaloneOpen: any[]
  /** 未被上方开放容器收拢的其余已关闭行（供底部全局「已关闭」折叠区渲染，避免上下重复）。 */
  bottomClosedRows: any[]
}

function safeEffortOf(row: any): string {
  if (!row) return ''
  if (typeof effortOf === 'function') {
    try { return String(effortOf(row) || '') } catch (e) {}
  }
  return row.effortId !== undefined && row.effortId !== null ? String(row.effortId) : ''
}

function safeRowKeyOf(row: any): string {
  if (!row) return ''
  const raw = row.key !== undefined && row.key !== null && String(row.key).trim() !== ''
    ? String(row.key).trim()
    : (row.number !== undefined && row.number !== null ? String(row.number).trim() : '')
  return raw
}

function safeIdOf(row: any): string {
  if (!row) return ''
  if (typeof idOf === 'function') {
    try {
      const got = idOf(row)
      if (got) return String(got)
    } catch (e) {}
  }
  const eff = safeEffortOf(row)
  const k = safeRowKeyOf(row)
  if (typeof idOfParts === 'function') {
    try { return String(idOfParts(eff, k)) } catch (e) {}
  }
  return eff ? eff + '#' + k : k
}

/** 规范化票号：纯数字折掉前导零（兼容本地 Markdown 补零键 '00' 与数字 0），非数字原样保留。 */
function normTicketKey(raw: any): string {
  const s = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!s) return ''
  const m = /^0*(\d+)$/.exec(s)
  return m ? String(Number(m[1])) : s
}

/** 在容器索引表里同时登记原样键与去前导零规范键（严格限定在同一工作单元内，不跨目录串号）。 */
function registerLookupKeys(table: Record<string, ListContainerTreeNode>, row: any, node: ListContainerTreeNode): void {
  const eff = safeEffortOf(row)
  const raw = safeRowKeyOf(row)
  if (!raw) return
  const exact = eff + '\u0000' + raw
  if (!table[exact]) table[exact] = node
  const norm = normTicketKey(raw)
  if (norm) {
    const normSlot = eff + '\u0000' + norm
    if (!table[normSlot]) table[normSlot] = node
  }
}

function lookupParentNode(table: Record<string, ListContainerTreeNode>, row: any): ListContainerTreeNode | null {
  if (!row || row.parentKey === undefined || row.parentKey === null) return null
  const parentRaw = String(row.parentKey).trim()
  if (!parentRaw) return null
  const eff = safeEffortOf(row)
  const hitExact = table[eff + '\u0000' + parentRaw]
  if (hitExact && hitExact.row !== row) return hitExact
  const norm = normTicketKey(parentRaw)
  if (!norm) return null
  const hitNorm = table[eff + '\u0000' + norm]
  return (hitNorm && hitNorm.row !== row) ? hitNorm : null
}

/** 会话私有的两份折叠表指纹：供 ListTab 的布局测量缓存感知折叠变化，展开新行时立即补做标签与宽度测量。 */
export const listTreeFoldFingerprintOf = function (st: any): string {
  if (!st) return ''
  const a = st.treeCollapsed && typeof st.treeCollapsed === 'object' ? Object.keys(st.treeCollapsed).filter(function (k: string) { return st.treeCollapsed[k] === true }).sort().join(',') : ''
  const b = st.treeClosedOpen && typeof st.treeClosedOpen === 'object' ? Object.keys(st.treeClosedOpen).filter(function (k: string) { return st.treeClosedOpen[k] === true }).sort().join(',') : ''
  return a + ';' + b
}

/**
 * 把已经按面板排序档排好序、且通过工作单元筛选的行组装成三级归属树。
 *
 * 输入的四个数组本身已按 sortIssues 排好序，因此挂入各父容器子数组后天然继承同一套面板排序档。
 */
export const buildListTicketTree = function (input: {
  maps: any[]
  specs: any[]
  openTickets: any[]
  closedRows: any[]
}): ListTicketTreeModel {
  const mapsIn = Array.isArray(input && input.maps) ? input.maps : []
  const specsIn = Array.isArray(input && input.specs) ? input.specs : []
  const openIn = Array.isArray(input && input.openTickets) ? input.openTickets : []
  const closedIn = Array.isArray(input && input.closedRows) ? input.closedRows : []

  const mapByKey: Record<string, ListContainerTreeNode> = {}
  const specByKey: Record<string, ListContainerTreeNode> = {}
  const rootMaps: ListContainerTreeNode[] = []
  const rootSpecs: ListContainerTreeNode[] = []
  const standaloneOpen: any[] = []

  for (let i = 0; i < mapsIn.length; i++) {
    const m = mapsIn[i]
    if (!m) continue
    const node: ListContainerTreeNode = { row: m, kind: 'map', depth: 0, openSpecs: [], openTickets: [], closedChildren: [] }
    rootMaps.push(node)
    registerLookupKeys(mapByKey, m, node)
  }

  for (let i = 0; i < specsIn.length; i++) {
    const s = specsIn[i]
    if (!s) continue
    const parentMap = lookupParentNode(mapByKey, s)
    const depth = parentMap ? Math.min(LIST_TREE_MAX_DEPTH, parentMap.depth + 1) : 0
    const node: ListContainerTreeNode = { row: s, kind: 'spec', depth: depth, openSpecs: [], openTickets: [], closedChildren: [] }
    if (parentMap) parentMap.openSpecs.push(node)
    else rootSpecs.push(node)
    registerLookupKeys(specByKey, s, node)
  }

  for (let i = 0; i < openIn.length; i++) {
    const t = openIn[i]
    if (!t) continue
    const parentSpec = lookupParentNode(specByKey, t)
    if (parentSpec) { parentSpec.openTickets.push(t); continue }
    const parentMap = lookupParentNode(mapByKey, t)
    if (parentMap) { parentMap.openTickets.push(t); continue }
    standaloneOpen.push(t)
  }

  const attachedClosed: Record<string, boolean> = {}
  for (let i = 0; i < closedIn.length; i++) {
    const c = closedIn[i]
    if (!c) continue
    const parentSpec = lookupParentNode(specByKey, c)
    if (parentSpec) {
      parentSpec.closedChildren.push(c)
      attachedClosed[safeIdOf(c)] = true
      continue
    }
    const parentMap = lookupParentNode(mapByKey, c)
    if (parentMap) {
      parentMap.closedChildren.push(c)
      attachedClosed[safeIdOf(c)] = true
    }
  }

  const bottomClosedRows: any[] = []
  for (let i = 0; i < closedIn.length; i++) {
    const c = closedIn[i]
    if (!c) continue
    if (!attachedClosed[safeIdOf(c)]) bottomClosedRows.push(c)
  }

  return { rootMaps: rootMaps, rootSpecs: rootSpecs, standaloneOpen: standaloneOpen, bottomClosedRows: bottomClosedRows }
}

/** 计算底部全局「已关闭」折叠区应当展示的行（排除已被上方开放容器收进子折叠条的行，避免重复出现）。 */
export const listBottomClosedRowsOf = function (tree: ListTicketTreeModel | null | undefined, fallbackClosedRows: any[]): any[] {
  if (!tree || !Array.isArray(tree.bottomClosedRows)) return fallbackClosedRows
  return tree.bottomClosedRows
}

/**
 * 渲染已关闭列表（用于状态筛到「已关闭」或展开底部「已关闭」折叠区时）：
 * 若某张已关闭子票或子规格的父容器也在同一批已关闭行里，同样缩进排在父容器下方，保持层级归属一致。
 */
export const listClosedTreeNodes = function (opts: {
  h: any
  st: any
  rows: any[]
  narrow: any
  blockOf: any
  colorOf: any
  multiEffort: any
  containerKindOf: (x: any) => any
}): any[] {
  const h = opts.h, st = opts.st, rows = Array.isArray(opts.rows) ? opts.rows : []
  const kindOf = opts.containerKindOf
  const containersByKey: Record<string, { row: any, kind: 'map' | 'spec', children: any[] }> = {}
  const register = function (r: any, k: 'map' | 'spec') {
    const eff = safeEffortOf(r), raw = safeRowKeyOf(r)
    if (!raw) return null
    const entry = { row: r, kind: k, children: [] as any[] }
    containersByKey[eff + '\u0000' + raw] = entry
    const norm = normTicketKey(raw)
    if (norm && !containersByKey[eff + '\u0000' + norm]) containersByKey[eff + '\u0000' + norm] = entry
    return entry
  }
  const entries: Array<{ row: any, kind: any, entry: any }> = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const k = kindOf ? kindOf(r) : null
    const entry = (k === 'map' || k === 'spec') ? register(r, k) : null
    entries.push({ row: r, kind: k, entry: entry })
  }
  const attached: Record<string, boolean> = {}
  for (let i = 0; i < entries.length; i++) {
    const it = entries[i]
    const r = it.row
    if (!r || r.parentKey === undefined || r.parentKey === null || String(r.parentKey).trim() === '') continue
    if (it.kind === 'map') continue
    const eff = safeEffortOf(r), pRaw = String(r.parentKey).trim()
    const parent = containersByKey[eff + '\u0000' + pRaw] || (normTicketKey(pRaw) ? containersByKey[eff + '\u0000' + normTicketKey(pRaw)] : null)
    if (!parent || parent.row === r) continue
    if (it.kind === 'spec' && parent.kind !== 'map') continue
    parent.children.push(it)
    attached[safeIdOf(r)] = true
  }
  const renderClosedItem = function (it: { row: any, kind: any, entry: any }, depth: number): any {
    const r = it.row
    const rowId = safeIdOf(r)
    const kids = (it.entry && depth < LIST_TREE_MAX_DEPTH) ? it.entry.children : []
    const collapsed = !!(st.treeCollapsed && st.treeCollapsed[rowId] === true)
    const meta = {
      depth: depth,
      hasChildren: kids.length > 0,
      collapsed: collapsed,
      childTotal: kids.length,
      onToggle: kids.length > 0 ? function () {
        st.treeCollapsed = st.treeCollapsed || {}
        st.treeCollapsed[rowId] = !collapsed
        emit(st)
      } : undefined,
    }
    const rowEl = listIssueRow(h, st, r, false, opts.narrow, opts.blockOf, opts.colorOf, opts.multiEffort, meta)
    if (!kids.length || collapsed) return rowEl
    const railCls = it.kind === 'spec' ? 'spec-rail' : 'map-rail'
    return h('div', { key: 'closed-tree-' + rowId, 'data-tree-group': safeRowKeyOf(r) }, [
      rowEl,
      h('div', { className: 'dsws-tree-kids ' + railCls, 'data-tree-children-of': safeRowKeyOf(r) }, kids.map(function (ch: any) {
        return renderClosedItem(ch, Math.min(LIST_TREE_MAX_DEPTH, depth + 1))
      })),
    ])
  }
  const out: any[] = []
  for (let i = 0; i < entries.length; i++) {
    if (attached[safeIdOf(entries[i].row)]) continue
    out.push(renderClosedItem(entries[i], 0))
  }
  return out
}

/**
 * 渲染开放主列表的三级可折叠树节点数组；返回空数组表示当前筛选下没有任何可见开放项（调用方据此渲染「暂无」）。
 */
export const listTicketTreeNodes = function (opts: {
  h: any
  st: any
  tree: ListTicketTreeModel
  narrow: any
  blockOf: any
  colorOf: any
  multiEffort: any
  matchOpen: (x: any) => boolean
  hasSubFilter: boolean
  containerKindOf?: (x: any) => any
}): any[] {
  const h = opts.h, st = opts.st, tree = opts.tree
  const matchOpen = opts.matchOpen
  const hasSubFilter = opts.hasSubFilter === true
  const kindOf = typeof opts.containerKindOf === 'function' ? opts.containerKindOf : function () { return null }

  const renderContainerNode = function (node: ListContainerTreeNode): any | null {
    const visSpecsNodes: any[] = []
    let visSpecsCount = 0
    for (let i = 0; i < node.openSpecs.length; i++) {
      const childRendered = renderContainerNode(node.openSpecs[i])
      if (childRendered !== null) {
        visSpecsNodes.push(childRendered)
        visSpecsCount++
      }
    }
    const visTickets = hasSubFilter ? node.openTickets.filter(matchOpen) : node.openTickets
    const closedList = hasSubFilter ? [] : node.closedChildren
    const selfMatched = hasSubFilter ? matchOpen(node.row) : true
    if (!selfMatched && visSpecsCount === 0 && visTickets.length === 0) return null

    const cId = safeIdOf(node.row)
    const rowKey = safeRowKeyOf(node.row)
    const logKey = String(rowKey || node.row.number || '0').toLowerCase()
    const childTotal = visSpecsCount + visTickets.length + closedList.length
    const hasChildren = childTotal > 0
    const collapsed = !!(st.treeCollapsed && st.treeCollapsed[cId] === true)
    const meta = {
      depth: node.depth,
      hasChildren: hasChildren,
      collapsed: collapsed,
      childTotal: childTotal,
      onToggle: hasChildren ? function () {
        st.treeCollapsed = st.treeCollapsed || {}
        st.treeCollapsed[cId] = !collapsed
        emit(st)
      } : undefined,
    }
    const headRow = listIssueRow(h, st, node.row, true, opts.narrow, opts.blockOf, opts.colorOf, opts.multiEffort, meta)
    if (!hasChildren || collapsed) return headRow

    const ticketDepth = Math.min(LIST_TREE_MAX_DEPTH, node.depth + 1)
    const openTicketEls = visTickets.map(function (t: any) {
      return listIssueRow(h, st, t, true, opts.narrow, opts.blockOf, opts.colorOf, opts.multiEffort, { depth: ticketDepth, hasChildren: false, collapsed: false, childTotal: 0 })
    })

    let closedBlock: any = null
    if (closedList.length > 0) {
      const closedOpen = !!(st.treeClosedOpen && st.treeClosedOpen[cId] === true)
      closedBlock = h('div', { key: 'tree-closed-wrap-' + cId, 'data-tree-closed-of': rowKey }, [
        h('button', {
          type: 'button',
          className: 'dsws-tree-closed-bar',
          'data-press': 'button',
          'data-log': 'list.tree.closed.' + logKey,
          'aria-expanded': closedOpen ? 'true' : 'false',
          onClick: function (e: any) {
            e.stopPropagation()
            st.treeClosedOpen = st.treeClosedOpen || {}
            st.treeClosedOpen[cId] = !closedOpen
            emit(st)
          },
        }, [
          Ic({ n: closedOpen ? 'chev-down' : 'chev-right', size: 11 }),
          Ic({ n: 'check', size: 10 }),
          h('span', null, tr('list.treeClosedChildren', { n: closedList.length })),
        ]),
        closedOpen ? h('div', { className: 'dsws-tree-closed-items', style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 } },
          listClosedTreeNodes({
            h: h, st: st, rows: closedList, narrow: opts.narrow,
            blockOf: opts.blockOf, colorOf: opts.colorOf, multiEffort: opts.multiEffort,
            containerKindOf: kindOf,
          }).map(function (el: any) { return el })
        ) : null,
      ])
    }

    const railCls = node.kind === 'spec' ? 'spec-rail' : 'map-rail'
    return h('div', { key: 'tree-node-' + cId, 'data-tree-group': rowKey }, [
      headRow,
      h('div', { className: 'dsws-tree-kids ' + railCls, 'data-tree-children-of': rowKey },
        visSpecsNodes.concat(openTicketEls).concat(closedBlock ? [closedBlock] : [])),
    ])
  }

  const out: any[] = []
  for (let i = 0; i < tree.rootMaps.length; i++) {
    const el = renderContainerNode(tree.rootMaps[i])
    if (el !== null) out.push(el)
  }
  for (let i = 0; i < tree.rootSpecs.length; i++) {
    const el = renderContainerNode(tree.rootSpecs[i])
    if (el !== null) out.push(el)
  }
  const visStandalone = hasSubFilter ? tree.standaloneOpen.filter(matchOpen) : tree.standaloneOpen
  for (let i = 0; i < visStandalone.length; i++) {
    out.push(listIssueRow(h, st, visStandalone[i], true, opts.narrow, opts.blockOf, opts.colorOf, opts.multiEffort, { depth: 0, hasChildren: false, collapsed: false, childTotal: 0 }))
  }
  return out
}
