/**
 * src/tracker/registry/builtins.ts —— 内置房间的装配点（唯一）
 *
 * 这份文件回答一个问题：插件内置了哪几个后端房间、每个房间怎么加载、注册表要的是哪一份模块。
 * 在这之前，这份清单实际散在宿主侧：`src/host/platformChannel.js` 里三段 try 块各自 import 一间房。
 * 于是「有几间内置房间」有两个家，宿主也因此直接认识了每一间房的实现细节（#1161）。
 *
 * 三条约定，改这里之前先读：
 *
 *  1. 一律用动态 `import()`。加载时机必须与从前一致 —— 只有真正要用某个房间时才加载它，
 *     插件启动时不许多加载任何一间房。谁把它改成顶层静态 import，谁就改了启动行为。
 *  2. 这里只登记「有哪几个内置房间」和「怎么把房间的模块交给注册表」。能力清单不在这里
 *     （那是契约层 `CAPABILITIES` 那条线）；房间内部共用的判定件也不在这里（那是共享内核 #1159 的事）。
 *  3. 宿主侧不许再直接 import `src/tracker/rooms/**`（规则 `rooms-imported-only-by-assembly` 盯着）。
 *     宿主今天还需要房间里少数几件实现（单票状态归一、建仓错误分档、本地图谱解析），
 *     一律经本文件的 `loadGithubHostExtras()` / `loadMarkdownHostExtras()` 取 —— 房间的 `index.ts`
 *     只管房间自己的对外契约，不再为宿主转出实现件（#1170 收回了 #1161 时期的那几行临时转出）。
 */
import type { BackendModule } from '../contract/backend-module.js'

/** 内置房间的编号。房间名是数据：依赖规则的起点判据不写房名，房间清单只有这里一处。 */
export type BuiltinRoomId = 'github' | 'gitlab' | 'markdown' | 'yunxiao'

/**
 * 内置房间的名单与注册顺序：github → markdown → gitlab → yunxiao。
 *
 * 顺序有意义：注册表按注册序仲裁平局，而这个顺序必须与判定层那份明文裁剪顺序
 * （src/tracker/detection/backendDecision.ts 的 MULTI_CLAIM_ORDER，同样是 github → markdown → gitlab → yunxiao）
 * 逐位一致 —— 两处不一致时，同一组多命中会得出两种结论。门禁 tests/verify-detection-evidence.ts
 * 的 D 节读的就是这里，改名单就得同时看那两处。
 */
export const BUILTIN_ROOM_IDS: readonly BuiltinRoomId[] = ['github', 'markdown', 'gitlab', 'yunxiao']

/**
 * 挑出注册表要的那一份模块对象。
 *
 * 形状对不对由本函数的返回值类型回答：声明的是 `Promise<BackendModule>`，
 * 房间交出来的模块对象缺成员、错签名，编译就在这里报错（#1192 的收口）。
 * 所以这里不写任何形状断言——唯一的形状断言函数是 `registry/shape.ts` 的
 * `validateMod`（注册表在 `core.ts` 里调它，那是运行时那道口；门禁 3b 钉住这里零断言）。
 *
 * 没有 `|| ns.default` 兜底：具名导出缺失必须在编译期炸出来，
 * 不能在运行时悄悄拿一个不是模块的东西继续走（各家的 `default` 都是建后端的工厂，不是模块对象）。
 * 搬家前的容错写法在这里没有意义——这三个常量恒在，恒在的东西不需要兜底。
 *
 * github / gitlab 取模块对象本身；markdown 必须整份取 `markdownModule` —— 它的 `setupPrompt`
 * （setup 提示词的 locale 键名）挂在模块对象上，自己拼一份 create/matches 会把它丢掉，
 * 于是弹窗里选 Markdown 之后注入的 setup 提示词会落进 GitHub 的键组（#230 D10 实测过的故障）。
 */
async function backendModuleOf(id: BuiltinRoomId): Promise<BackendModule> {
  if (id === 'github') {
    const ns = await import('../rooms/github/room/index.js')
    return ns.githubModule
  }
  if (id === 'gitlab') {
    const ns = await import('../rooms/gitlab/index.js')
    return ns.gitlabBackend
  }
  if (id === 'yunxiao') {
    const ns = await import('../rooms/yunxiao/index.js')
    return ns.yunxiaoBackend
  }
  const ns = await import('../rooms/markdown/index.js')
  return ns.markdownModule
}

/**
 * 按注册序给出「要注册进注册表的内置后端模块」。
 *
 * 某一间房加载失败就跳过它，其余房间照常注册 —— 与搬家前 `platformChannel.js` 里逐间 try/catch 同义：
 * 一间房坏掉不该让整个注册表建不起来。形状校验仍由注册表自己做（`registry/shape.ts` 的 `validateMod`）。
 */
export async function loadBuiltinBackendModules(): Promise<BackendModule[]> {
  const out: BackendModule[] = []
  for (const id of BUILTIN_ROOM_IDS) {
    try {
      out.push(await backendModuleOf(id))
    } catch {
      // 一间房加载失败不拖累其余两间；失败原因由调用方按需记录（这里不做日志，避免启动期噪音）。
    }
  }
  return out
}

// ── 宿主还要用的那几件房间实现（#1170）────────────────────────────────────────────────
// 这几件是房间的实现细节：GitHub 的单票状态归一与建仓错误分档、Markdown 的本地图谱解析。
// 它们既不是「与后端无关的判定」（那归共享内核 src/tracker/kernel/，见 #1159），
// 也不是契约层的东西（契约层只有类型与数据、没有运行时实现），而宿主又要用，
// 所以由本文件直接取出来交给宿主 —— 全仓允许 import 房间内部的地方只有本文件一处。
//
// 为什么不放回房间的 `index.ts` 转出（那是 #1161 时期的临时写法，已在 #1170 收回）：
// `index.ts` 是房间对外的契约面，每多一行转出，房间边界上就多一扇没人守的门。
// 加件之前先问：这一件真是某个房间独有的吗？不是就该去内核或契约层，而不是挂在这里。
export type GithubHostExtras = {
  /** 单票与拉取请求的状态归一：把 GitHub 的 OPEN/CLOSED/MERGED 收成契约里的状态。 */
  pullStateOf: typeof import('../rooms/github/model/normalize.js').pullStateOf
  /** 建仓发布失败的分档器：认 gh 的原话，分成可展示的几档。 */
  makeCreateErrorClassifier: typeof import('../rooms/github/support/init-project-error-kinds.js').makeCreateErrorClassifier
  /** 分档器认不出来的那一档的名字（调用方要拿它比对，所以跟分档器一起交）。 */
  KIND_UNKNOWN: typeof import('../rooms/github/support/init-project-error-kinds.js').KIND_UNKNOWN
}

/** 取出 GitHub 房那几件宿主实现。同一个房间第二次调用命中模块缓存，不会重复求值。 */
export async function loadGithubHostExtras(): Promise<GithubHostExtras> {
  const [normalize, kinds] = await Promise.all([
    import('../rooms/github/model/normalize.js'),
    import('../rooms/github/support/init-project-error-kinds.js'),
  ])
  return {
    pullStateOf: normalize.pullStateOf,
    makeCreateErrorClassifier: kinds.makeCreateErrorClassifier,
    KIND_UNKNOWN: kinds.KIND_UNKNOWN,
  }
}

export type MarkdownHostExtras = {
  /** 本地图谱解析：一张票在盘上长什么样、字段怎么读，只有 Markdown 房这一层知道。 */
  parseMd: typeof import('../rooms/markdown/parse.js').parseMd
  /**
   * 检查链三项判据（#1513）：md:workspace / md:scratchWritable / md:containersReadable。
   *
   * 为什么经装配点交给宿主，而不是让宿主自己拼：这三项是房间对工作区的理解（工作单元怎么发现、
   * 沙箱写许可怎么试、容器文件版本怎么认），宿主只该拿结论。房间 preflight 与宿主检查链共用这同三份
   * 实现（票面硬条件），所以这里转出的就是那三份函数本体，不是再包一层。
   */
  checkWorkspace: typeof import('../rooms/markdown/workspace-checks.js').checkWorkspace
  checkScratchWritable: typeof import('../rooms/markdown/workspace-checks.js').checkScratchWritable
  checkContainersReadable: typeof import('../rooms/markdown/workspace-checks.js').checkContainersReadable
}

/** 取出 Markdown 房那几件宿主实现（同一个房间第二次调用命中模块缓存，不会重复求值）。 */
export async function loadMarkdownHostExtras(): Promise<MarkdownHostExtras> {
  const [mod, checks] = await Promise.all([
    import('../rooms/markdown/parse.js'),
    import('../rooms/markdown/workspace-checks.js'),
  ])
  return {
    parseMd: mod.parseMd,
    checkWorkspace: checks.checkWorkspace,
    checkScratchWritable: checks.checkScratchWritable,
    checkContainersReadable: checks.checkContainersReadable,
  }
}

export type YunxiaoHostExtras = {
  /** 云效议题跟踪器说明模板（issue-tracker-yunxiao.md 的英文原文与中文译文）。 */
  YUNXIAO_ISSUE_TRACKER_TEMPLATE: typeof import('../rooms/yunxiao/room/prompts.js').YUNXIAO_ISSUE_TRACKER_TEMPLATE
  /** 注入云效房间自定义 fetch 函数（供按需真机冒烟脚本或测试在不深引房间的情况下使用）。 */
  setYunxiaoCustomFetch: typeof import('../rooms/yunxiao/client.js').setYunxiaoCustomFetch
  /** 探测当前令牌对应的云效平台用户身份（GET /oapi/v1/platform/user）。 */
  probeYunxiaoPlatformUser: typeof import('../rooms/yunxiao/repo/current-user.js').probeYunxiaoPlatformUser
  /** 解析云效工作区基础地址（apiBaseUrl / webBaseUrl）。 */
  resolveYunxiaoBaseUrls: typeof import('../rooms/yunxiao/model/workspace-config.js').resolveYunxiaoBaseUrls
  /** 解析云效工作区非敏感坐标（organizationId / projectId / repositoryId 等）。 */
  resolveYunxiaoCoordinates: typeof import('../rooms/yunxiao/model/workspace-config.js').resolveYunxiaoCoordinates
  /** 从环境变量或本机受保护文件加载云效个人访问令牌。 */
  loadYunxiaoToken: typeof import('../rooms/yunxiao/model/workspace-config.js').loadYunxiaoToken
  /** 提取多行文本中的第一行非空非注释内容。 */
  firstNonEmptyLine: typeof import('../rooms/yunxiao/model/workspace-config.js').firstNonEmptyLine
  /** 将云效响应或异常归入契约错误分类。 */
  classifyYunxiaoError: typeof import('../rooms/yunxiao/errors.js').classifyYunxiaoError
  /** 发现当前工作区的云效组织、Yunxiao Projex 项目、错位纠偏建议与 Codeup 代码库/命名空间（规格 #24）。 */
  discoverYunxiaoWorkspace: typeof import('../rooms/yunxiao/project/discover.js').discoverYunxiaoWorkspace
}

/** 取出 Yunxiao 房的宿主实现。 */
export async function loadYunxiaoHostExtras(): Promise<YunxiaoHostExtras> {
  const [prompts, client, currentUser, wsCfg, errors, discover] = await Promise.all([
    import('../rooms/yunxiao/room/prompts.js'),
    import('../rooms/yunxiao/client.js'),
    import('../rooms/yunxiao/repo/current-user.js'),
    import('../rooms/yunxiao/model/workspace-config.js'),
    import('../rooms/yunxiao/errors.js'),
    import('../rooms/yunxiao/project/discover.js'),
  ])
  return {
    YUNXIAO_ISSUE_TRACKER_TEMPLATE: prompts.YUNXIAO_ISSUE_TRACKER_TEMPLATE,
    setYunxiaoCustomFetch: client.setYunxiaoCustomFetch,
    probeYunxiaoPlatformUser: currentUser.probeYunxiaoPlatformUser,
    resolveYunxiaoBaseUrls: wsCfg.resolveYunxiaoBaseUrls,
    resolveYunxiaoCoordinates: wsCfg.resolveYunxiaoCoordinates,
    loadYunxiaoToken: wsCfg.loadYunxiaoToken,
    firstNonEmptyLine: wsCfg.firstNonEmptyLine,
    classifyYunxiaoError: errors.classifyYunxiaoError,
    discoverYunxiaoWorkspace: discover.discoverYunxiaoWorkspace,
  }
}

// ── 房间形状的类型出口（#1161）────────────────────────────────────────────────────────
// 契约能力的编译期断言（src/tracker/capability-assertions.ts）要用三个房间的「成员集合」与
// 「工厂返回类型」。它同样不许直接 import 房间（规则 rooms-imported-only-by-assembly），
// 所以形状经装配点转出 —— 全仓允许 import 房间的地方只有本文件一处，别处的取用一律走这里。
export type { GithubBackendMembers, GithubBackendShape, createGithubBackend } from '../rooms/github/room/backend.js'
export type { GitlabBackendMembers, GitlabBackendShape, createGitlabBackend } from '../rooms/gitlab/index.js'
export type { MarkdownBackendMembers, MarkdownBackendShape, createMarkdownBackend } from '../rooms/markdown/index.js'
export type { YunxiaoBackendMembers, YunxiaoBackendShape, createYunxiaoBackend } from '../rooms/yunxiao/index.js'
