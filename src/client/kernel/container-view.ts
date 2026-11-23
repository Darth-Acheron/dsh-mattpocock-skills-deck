/**
 * src/client/kernel/container-view.ts —— 面板里「容器」这一概念的客户端单一真源（#1286）。
 *
 * 容器 = 能装子票的票。现在有两种：
 * - 探索地图：type 是 map，或带 wayfinder:map 标签（老数据都走这条）。
 * - 规格（实施地图）：type 是 spec；宿主按正文首行独占一行的隐藏标记
 *   <!-- DSH-ISSUE-KIND: spec --> 认出来（识别口径归 #1274/#1275，本票只消费结果）。
 *
 * 认种类的顺序在宿主那边定，客户端只读它给的那一格 type。顺序按 GLOSSARY.md
 * 「对象类型（objectKind）」词条：正文首行的隐藏标记 → 表达对象类型的标签 → 正文形状。
 * 也就是说标记优先于标签：一张既带隐藏标记又带 wayfinder:map 标签的票按规格算。
 * 客户端这一层不再自己判一遍「是不是容器」，一律调 containerKindOf。
 *
 * 两种容器在面板里共用同一套行渲染与详情页骨架，差的是身份颜色、角标、
 * 三态按钮（文字、底色、注入的提示词）与计数文案。
 *
 * 为什么单独一份：容器这个词横跨列表页、详情页与提示词注入。
 * 各处各判一次就会出「列表说它是地图、详情说它是普通票」这种自相矛盾，
 * 所以判定、取色与提示词只在这里做一次，别处不再各写一份。
 *
 * 数据来源：快照里的 maps 数组。这个数组名是历史名——它现在装的是「容器」，
 * 探索地图与规格都住在里面，靠各自的 type 字段分辨种类。
 * 口径（2026-10-20 定）：不另开 specs 数组。拆开要动二十来处读点，
 * 收益只有数组名好看，代价是「列表页多一行」「实施票散成孤儿票」这类真 bug。
 */
declare function inspectPrompt(...args: any[]): string;
declare function completePrompt(...args: any[]): string;
declare function effortOf(...args: any[]): any;
declare function startText(...args: any[]): string;
declare function promptTextFor(...args: any[]): string;

// 身份色：探索紫、规格蓝（2026-10-20 当面拍板；#1286 设计文档里把后者叫「实施贵族蓝」，是同一个颜色）
export const CONTAINER_ACCENT: any = { map: '#c084fc', spec: '#1D4ED8' };
// 行底色：身份色同色系的一层薄底（探索沿用现状，实施是新加的）
export const CONTAINER_TINT: any = { map: 'rgba(188,140,255,.07)', spec: 'rgba(29,78,216,.10)' };
// 角标 chip 的样式类与词表键（角标图标两种容器都用地图图标，区别在那两个字）
export const CONTAINER_CHIP_CLASS: any = { map: 'dsws-chip-m', spec: 'dsws-chip-s' };
export const CONTAINER_CHIP_LABEL_KEY: any = { map: 'list.mapChip', spec: 'list.specChip' };
// 两种容器角标共用的 DOM 标记类：列表页靠它一眼认出「这一行的编号列里是容器角标」
// （src/client/views/ListTab.ts 的宽行横排与护栏查的就是这个类，别改回去查 .dsws-chip-m）
export const CONTAINER_CHIP_MARKER_CLASS = 'dsws-chip-container';
// 三态里的两枚固定色：空态橙、完成态绿；执行态按容器类型取（见 containerTriState）
export const CONTAINER_EMPTY_COLOR = '#f59e0b';
export const CONTAINER_DONE_COLOR = '#3fb950';

/** 这张票是不是容器、是哪种容器？普通票返回 null。 */
export const containerKindOf = function (x: any): string | null {
  if (!x) return null;
  if (x.type === 'spec') return 'spec';
  const labels: any[] = Array.isArray(x.labels) ? x.labels : [];
  const isMapTag: boolean = labels.some(function (l: any): boolean {
    return (typeof l === 'string') ? l === 'wayfinder:map' : !!(l && l.name === 'wayfinder:map');
  });
  if (x.type === 'map' || isMapTag) return 'map';
  return null;
};

/** 判断探索地图是否已经关联了规格票（下挂在 tickets 中，或快照 maps/issues/thinTickets 里有 parentKey 指向该地图的 spec）。 */
export const mapHasLinkedSpec = function (mapObj: any, snap?: any): boolean {
  if (!mapObj || typeof mapObj !== 'object') return false;
  const effOf = function (r: any): string {
    if (!r || typeof r !== 'object') return '';
    return r.effort !== undefined && r.effort !== null ? String(r.effort) : (r.effortId !== undefined && r.effortId !== null ? String(r.effortId) : '');
  };
  const mKey: string = String((mapObj.key != null && String(mapObj.key) !== '' ? mapObj.key : mapObj.number) ?? '');
  const mNum: string = String(mapObj.number ?? '');
  const mEff: string = effOf(mapObj);
  if (Array.isArray(mapObj.tickets) && mapObj.tickets.some(function (t: any): boolean { return containerKindOf(t) === 'spec'; })) {
    return true;
  }
  if (!snap || typeof snap !== 'object') return false;
  const matchSpec = function (s: any): boolean {
    if (containerKindOf(s) !== 'spec' || s.parentKey == null) return false;
    const pk: string = String(s.parentKey).replace(/^#/, '');
    if (!pk || (pk !== mKey && pk !== mNum)) return false;
    const sEff: string = effOf(s);
    if (mEff && sEff && mEff !== sEff) return false;
    return true;
  };
  return (Array.isArray(snap.maps) && snap.maps.some(matchSpec))
    || (Array.isArray(snap.issues) && snap.issues.some(matchSpec))
    || (Array.isArray(snap.thinTickets) && snap.thinTickets.some(matchSpec));
};

/** 容器状态：
  * - 规格（或未标类型的纯统计入参）：没有子票 empty，还有未关子票 open，子票全关 done。
  * - 探索地图：没有子票 empty，还有未关子票 open；探索子票全关但尚未挂接规格票（或地图已关闭但尚未挂接规格票）时为 handoff（提示「生成规格」注入 /to-spec）；已挂接规格票且探索子票全关（或已关闭且已挂接规格票）时为 done。 */
export const containerStateOf = function (container: any, snap?: any): string {
  const kind: string | null = containerKindOf(container);
  const stats: any = container && container.stats;
  if (kind === 'map') {
    const isClosed: boolean = String((container && container.state) || '').toUpperCase() === 'CLOSED';
    if (isClosed) return mapHasLinkedSpec(container, snap) ? 'done' : 'handoff';
    if (!stats || !stats.total) return 'empty';
    if (stats.closed < stats.total) return 'open';
    return mapHasLinkedSpec(container, snap) ? 'done' : 'handoff';
  }
  if (!stats || !stats.total) return 'empty';
  return stats.closed === stats.total ? 'done' : 'open';
};

/** 容器主按钮的取色与话术：
  * - 探索地图：检查（empty）/ 执行（open）/ 生成规格（handoff，注入 /to-spec）/ 完成（done，已挂规格后收尾）。
  * - 规格：拆票（empty）/ 执行（open）/ 完成（done）。
  * labelKey 与 titleKey 是词表键（由界面自己 tr() 出来），color 是按钮底色，icon 是图标名。 */
export const containerTriState = function (kind: string, state: string): any {
  if (kind === 'spec') {
    if (state === 'empty') return { labelKey: 'act.split', color: CONTAINER_EMPTY_COLOR, icon: 'branch', titleKey: 'spec.splitTitle' };
    if (state === 'done') return { labelKey: 'act.done', color: CONTAINER_DONE_COLOR, icon: 'check', titleKey: 'spec.doneTitle' };
    return { labelKey: 'act.execute', color: CONTAINER_ACCENT.spec, icon: 'play', titleKey: 'spec.executeTitle' };
  }
  if (state === 'empty') return { labelKey: 'act.inspect', color: CONTAINER_EMPTY_COLOR, icon: 'search', titleKey: 'map.inspectTitle' };
  if (state === 'handoff') return { labelKey: 'act.toSpec', color: CONTAINER_ACCENT.map, icon: 'handoff', titleKey: 'map.toSpecTitle' };
  if (state === 'done') return { labelKey: 'act.done', color: CONTAINER_DONE_COLOR, icon: 'check', titleKey: 'map.doneTitle' };
  return { labelKey: 'act.execute', color: CONTAINER_ACCENT.map, icon: 'play', titleKey: 'map.executeTitle' };
};

/** 编号徽章取色：完成/待交棒态绿、空态橙，未完成时按容器身份取色。
  * fallback 是调用方按老口径算出的颜色（探索地图今天走 actionColorOf），
  * 传进来是为了让探索地图的观感一字不变。 */
export const containerNumberColor = function (kind: string, state: string, fallback: string): string {
  if (state === 'done' || state === 'handoff') return CONTAINER_DONE_COLOR;
  if (state === 'empty') return CONTAINER_EMPTY_COLOR;
  return kind === 'spec' ? CONTAINER_ACCENT.spec : fallback;
};

/** 详情页计数文案的词表键：本图 N 张子票 / 本规格 N 张实施票。 */
export const containerCountKey = function (kind: string): string {
  return kind === 'spec' ? 'map.specSubCount' : 'map.subCount';
};

/** 列表行悬停提示的词表键：探索是 list.mapTitle，规格是 list.specTitle。 */
export const containerTitleKey = function (kind: string): string {
  return kind === 'spec' ? 'list.specTitle' : 'list.mapTitle';
};

/** 合并快照中的 issues、maps 容器及其子票（去重）：避免 applySnapshotChangeSet 将容器或子票从 issues 摘除后列表/计数漏行。 */
export const allSnapshotIssuesOf = function (snap: any): any[] {
  const issues: any[] = (snap && Array.isArray(snap.issues)) ? snap.issues : [];
  const maps: any[] = (snap && Array.isArray(snap.maps)) ? snap.maps : [];
  if (!maps.length) return issues;
  const out: any[] = [];
  const seen: Record<string, boolean> = {};
  const idOf = function (r: any): string {
    if (!r || typeof r !== 'object') return '';
    const eff = r.effort !== undefined && r.effort !== null ? String(r.effort) : (r.effortId !== undefined && r.effortId !== null ? String(r.effortId) : '');
    const k = r.key !== undefined && r.key !== null && String(r.key) !== '' ? String(r.key) : (r.number !== undefined && r.number !== null ? String(r.number) : '');
    return k ? (eff + '\u0000' + k) : '';
  };
  const push = function (r: any): void {
    const id = idOf(r);
    if (!id || seen[id]) return;
    seen[id] = true;
    out.push(r);
  };
  issues.forEach(push);
  maps.forEach(function (m: any): void {
    if (m && Array.isArray(m.tickets)) m.tickets.forEach(push);
  });
  maps.forEach(push);
  return out;
};

/** 这一态该注入什么提示词。列表页与详情页共用这一份，
  * 这样「按钮上写什么」与「点下去注入什么」永远对得上。
  * url 由调用方给（issueUrlFor 在各视图里已经算过一次链接）。 */
export const containerPromptText = function (st: any, c: any, kind: string, state: string, url: string): string {
  const num: any = c && c.number;
  const title: string = String((c && c.title) || '');
  const stats: any = (c && c.stats) || {};
  try {
    // #1281：完成态两种容器各走各的收口提示词——探索地图是「按 wayfinder 核对完成并交棒」，
    //   规格是「逐张核对，通过后才关闭」；两者语义不同，不能再共用 completePrompt。
    if (state === 'handoff') {
      return promptTextFor(st, 'mapToSpec', { url: url });
    }
    if (state === 'done') {
      if (kind === 'spec') return promptTextFor(st, 'specComplete', { url: url, total: stats.total || 0, closed: stats.closed || 0 });
      // #1595：容器对象自带 effort，把它传给 completePrompt 让链接按 effort 取；单 effort 时 effortOf 回空串，行为与原来一致。
      return completePrompt(st, num, title, stats.total || 0, stats.closed || 0, (typeof effortOf === 'function') ? effortOf(c) : undefined);
    }
    if (kind === 'spec') {
      // 规格空态：还没有实施票，按钮是「拆票」，注入 to-tickets 模板（正文首行 /to-tickets）。
      if (state === 'empty') return promptTextFor(st, 'specSplit', { url: url });
      // 规格未完成：注入 implement-spec 模板（正文首行 /implement-spec）。
      //   通用执行模板首行是 /wayfinder（探索地图的路子），用在规格上不对，所以规格走自己这两条。
      return promptTextFor(st, 'specExecute', { url: url });
    }
    // #1595：同上，把容器的 effort 传给 inspectPrompt，让检查提示词里的链接按 effort 取。
    if (state === 'empty') return inspectPrompt(st, num, title, (typeof effortOf === 'function') ? effortOf(c) : undefined);
    return startText(st, c);
  } catch (e) {
    // 提示词取不到时退回推进式提示词，跟今天地图侧的行为一致（不静默吞掉）。
    try { return startText(st, c); } catch (e2) { return ''; }
  }
};
