/**
 * src/tracker/rooms/yunxiao/index.ts —— Yunxiao backend（云效 Projex + Codeup）适配器房间入口（规格 #02）。
 *
 * 入口职责（对齐 GitLab 房间 `src/tracker/rooms/gitlab/index.ts`）：
 *   1. 模块对象 `yunxiaoBackend`（兼名 `yunxiaoModule`）、工厂 `createYunxiaoBackend`、
 *      自动识别 `matches` 与同步描述定位器 `describe`；
 *   2. 链接与地址收在 `./room/links.ts`，提示文案收在 `./room/prompts.ts`，修复指引收在 `./room/fixes.ts`，
 *      由本入口显式再导出；
 *   3. 27 条能力（24 条操作 + 3 条定位口）中 26 条提供、1 条（`ensureLabelColorsFile`）按设计不支持，
 *      成员集合 `YunxiaoBackendMembers` 与字面量形状 `YunxiaoBackendShape` 直接从
 *      `./support/capability-register.ts` 推导并用 `satisfies` 在编译期钉死。
 */

import type { Tracker } from '../../contract/operations.js'
import type { BackendModule } from '../../contract/backend-module.js'
import type { BackendId } from '../../contract/identity.js'
import type { RepositoryRef } from '../../contract/entities.js'
import type { BackendContext, OpContext, RepoHandle } from '../../contract/contexts.js'
import type { PartiallyProvidedCapability, ProvidedCapability } from '../../contract/capability-answer.js'
import type { YUNXIAO_CAPABILITY_REGISTER } from './support/capability-register.js'
import { remoteUrlsOfGitConfig } from '../../kernel/git-remote.js'
import { normalizeTrackerText, parseIssueTracker } from '../../kernel/issue-tracker-declaration.js'
import { GITLAB_FALLBACK_TIMEOUT_MS } from '../../../shared/time-config/src/values.js'
import { YUNXIAO_BUDGET_MODEL, readYunxiaoBudget } from './budget.js'
import { attachYunxiaoOpUsage } from './client.js'
import { yunxiaoPreflight } from './preflight.js'
import { emitReadDegraded } from './support/read-log.js'
import {
  formatYunxiaoRefId,
  getLearnedYunxiaoContext,
  learnYunxiaoContextFor,
  parseCodeupRepo,
  parseYunxiaoRefId,
} from './model/repo-identity.js'
import {
  YUNXIAO_CONFIG_REL,
  parseYunxiaoConfigText,
} from './model/workspace-config.js'
import { collectExtraHosts, getRepoKey } from './repo/identity.js'
import { getCurrentUser } from './repo/current-user.js'
import { getRepoPermissions } from './repo/permissions.js'
import { listIssues, getIssue } from './issues/read.js'
import { createIssue, closeIssue, reopenIssue, updateIssue } from './issues/write.js'
import { counts } from './issues/counts.js'
import { listPage } from './issues/pages.js'
import { listMaps } from './issues/maps.js'
import { listSubIssues } from './issues/sub-issues.js'
import { addComment } from './comments/write.js'
import { setLabels } from './labels/assign.js'
import { listLabels } from './labels/list.js'
import { setLabelColors } from './labels/colors.js'
import { getDependencies } from './graph/read.js'
import { setBlockedBy } from './graph/write.js'
import { setParent, setAssignees } from './graph/membership.js'
import { initProject } from './project/init-project.js'
import { DEFAULT_YUNXIAO_WEB_ORIGIN, issueAddress, issueRefPattern, links, repoSearchAddress } from './room/links.js'
import { prompts, YUNXIAO_ISSUE_TRACKER_TEMPLATE } from './room/prompts.js'
import { fixes } from './room/fixes.js'

export { issueAddress, repoSearchAddress, issueRefPattern, links }
export { fixes }
export { prompts, YUNXIAO_ISSUE_TRACKER_TEMPLATE }

/** Yunxiao 房间工厂交出的成员集合（26 条提供能力 + id）。 */
export type YunxiaoBackendMembers =
  | 'id'
  | (ProvidedCapability<typeof YUNXIAO_CAPABILITY_REGISTER> | PartiallyProvidedCapability<typeof YUNXIAO_CAPABILITY_REGISTER>)

/** 工厂返回对象的编译期形状约束（缺一条、多一条均在编译期报错）。 */
export type YunxiaoBackendShape = { [K in YunxiaoBackendMembers]: Tracker[K] }

type MarkerFs = OpContext['fs']

async function readWorkspaceFile(fs: MarkerFs, cwd: string, rel: string): Promise<string | null> {
  try {
    const target = await fs.resolve(rel, { cwd })
    const text = await fs.readText(target)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

/**
 * Yunxiao matches：启发式判断工作区是否属于云效（Yunxiao Projex / Codeup）。
 *
 * 依次检查五处本地证据（不出网，只读本地文件与 git remote）：
 *   1. `handle.refId` 显式指向 yunxiao / codeup / devops.aliyun.com，或形如 `24位orgId/26位projectId`；
 *   2. 工作区存在合法的 `docs/agents/yunxiao.yaml`（解析成功时顺手将组织与项目坐标记入进程内缓存）；
 *   3. `.git/config` 的 `[remote ...]` 段中存在合法的 Codeup 远端地址（仅通过 `remoteUrlsOfGitConfig` 与 `parseCodeupRepo` 识别，分支名带关键词不误认）；
 *   4. `docs/agents/issue-tracker.md` 中存在高置信标题行 `# Issue tracker: Yunxiao`（与判定层共用 `parseIssueTracker`）；
 *   5. 兜底执行 `git remote get-url origin` 检查是否指向 Codeup。
 */
export async function matches(
  handle: RepoHandle | null | undefined,
  ctx: OpContext | null | undefined,
): Promise<boolean> {
  const startedAt = Date.now()
  try {
    if (!handle || typeof handle !== 'object') return false
    if (typeof handle.refId === 'string' && handle.refId.trim()) {
      const refText = handle.refId.trim()
      if (/yunxiao|codeup\.aliyun\.com|devops\.aliyun\.com/i.test(refText)) return true
      const parsedRef = parseYunxiaoRefId(refText)
      if (
        parsedRef &&
        /^[0-9a-f]{24}$/i.test(parsedRef.organizationId) &&
        /^[0-9a-z]{26}$/i.test(parsedRef.projectId)
      ) {
        return true
      }
    }

    const cwd = handle.cwd
    if (!cwd || typeof cwd !== 'string') return false
    const platform = ctx && ctx.platform
    const fs = (ctx && ctx.fs) || (platform && platform.fs)
    const canRead =
      !!fs &&
      typeof (fs as { resolve?: unknown }).resolve === 'function' &&
      typeof (fs as { readText?: unknown }).readText === 'function'
    if (!canRead) {
      emitReadDegraded(ctx, 'matches', 'matches:fs-unavailable', Date.now() - startedAt)
      return false
    }

    const extraHosts = collectExtraHosts(ctx)

    // 1) docs/agents/yunxiao.yaml 工作区坐标配置
    const yxCfgText = await readWorkspaceFile(fs, cwd, YUNXIAO_CONFIG_REL)
    if (yxCfgText === null) {
      emitReadDegraded(ctx, 'matches', 'matches:yunxiao-config', Date.now() - startedAt)
    } else {
      const parsedCfg = parseYunxiaoConfigText(yxCfgText)
      if (parsedCfg.ok) {
        const refId = formatYunxiaoRefId(parsedCfg.value.organizationId, parsedCfg.value.projectId)
        const patch = {
          organizationId: parsedCfg.value.organizationId,
          projectId: parsedCfg.value.projectId,
          ...(parsedCfg.value.customCode ? { customCode: parsedCfg.value.customCode } : {}),
          apiBaseUrl: parsedCfg.value.apiBaseUrl,
          webBaseUrl: parsedCfg.value.webBaseUrl,
        }
        learnYunxiaoContextFor({ cwd, refId }, patch)
        return true
      }
    }

    // 2) .git/config 里的远端地址是否指向 Codeup（只看 [remote ...] 段）
    const gitCfg = await readWorkspaceFile(fs, cwd, '.git/config')
    if (gitCfg === null) {
      emitReadDegraded(ctx, 'matches', 'matches:git-config', Date.now() - startedAt)
    } else if (remoteUrlsOfGitConfig(gitCfg).some((u) => parseCodeupRepo(u, { extraHosts }) !== null)) {
      return true
    }

    // 3) docs/agents/issue-tracker.md 的高置信标题行声明
    const doc = await readWorkspaceFile(fs, cwd, 'docs/agents/issue-tracker.md')
    if (doc === null) {
      emitReadDegraded(ctx, 'matches', 'matches:tracker-doc', Date.now() - startedAt)
    } else {
      const parsed = parseIssueTracker(normalizeTrackerText(doc))
      if (parsed && parsed.confidence === 'high' && parsed.explicitBackendId === 'yunxiao') {
        return true
      }
    }

    // 4) git remote get-url origin 兜底
    const execFn = ctx && ctx.exec
    if (execFn) {
      const res = await execFn('git', ['remote', 'get-url', 'origin'], {
        cwd,
        timeout: GITLAB_FALLBACK_TIMEOUT_MS,
      })
      const out = String((res && (res.stdout || res.stderr)) || '')
      if (parseCodeupRepo(out, { extraHosts }) !== null) return true
    }

    return false
  } catch {
    emitReadDegraded(ctx, 'matches', 'matches:unknown', Date.now() - startedAt)
    return false
  }
}

/**
 * 产出云效工作区的 `RepositoryRef`（契约同步定位口 `describe`）。
 *
 * 规则：
 *   1. `refId` 优先取 `handle.refId`，若未传则从 `learnedYunxiaoContext(cwd)` 恢复 `${organizationId}/${projectId}`；
 *   2. `url` 优先使用关联的 Codeup 仓库 `webUrl`（当工作区关联了 Codeup 仓库时），否则使用 Yunxiao Projex 项目网页地址；
 *   3. 自定义网页域名（与默认 `https://devops.aliyun.com` 不同时）写入 `ref.host`。
 */
export function describe(
  handle: RepoHandle | Partial<RepositoryRef> | null | undefined,
  backendId: BackendId = 'yunxiao',
): RepositoryRef {
  const rawRef =
    handle && typeof handle.refId === 'string' && handle.refId.trim() ? handle.refId.trim() : ''
  const maybeCwd = (handle as RepoHandle | null | undefined)?.cwd
  const cwd = typeof maybeCwd === 'string' ? maybeCwd.trim() : ''

  const learnedByCwd = cwd ? getLearnedYunxiaoContext(cwd) : null
  const learnedByRef = rawRef ? getLearnedYunxiaoContext(rawRef) : null
  const learned = learnedByRef || learnedByCwd

  const refId =
    rawRef ||
    (learned ? formatYunxiaoRefId(learned.organizationId, learned.projectId) : '')
  const parsedRef = parseYunxiaoRefId(refId)

  const declaredHost =
    handle && typeof (handle as Partial<RepositoryRef>).host === 'string'
      ? String((handle as Partial<RepositoryRef>).host).trim().replace(/\/+$/, '')
      : ''
  const learnedWebOrigin = learned?.webBaseUrl ? learned.webBaseUrl.trim().replace(/\/+$/, '') : ''
  const host = declaredHost || learnedWebOrigin
  const webOrigin = host || DEFAULT_YUNXIAO_WEB_ORIGIN

  const name =
    learned?.projectName ||
    refId ||
    (cwd ? cwd.split(/[\\/]/).pop() || cwd : backendId) ||
    backendId

  let url = ''
  if (learned?.codeupRepo?.webUrl) {
    url = learned.codeupRepo.webUrl
  } else if (parsedRef) {
    url = webOrigin + '/projex/project/' + encodeURIComponent(parsedRef.projectId)
  }

  const ref: RepositoryRef = {
    backend: backendId || 'yunxiao',
    refId: refId || '',
    name,
    url,
  }
  if (host && host !== DEFAULT_YUNXIAO_WEB_ORIGIN) {
    ref.host = host
  }
  return ref
}

const openRepository = 'url'

/**
 * 创建 Yunxiao backend 适配器实例（26 条能力 + id，外层统一包裹 `attachYunxiaoOpUsage` 请求记账）。
 */
export function createYunxiaoBackend(ctx: BackendContext) {
  const backend = {
    id: 'yunxiao',
    describe: (handle) => describe(handle, 'yunxiao'),
    issueAddress: (ref, key) => issueAddress(ref, key),
    getRepoKey: (cwd, opCtx) => getRepoKey(cwd, opCtx || (ctx as unknown as OpContext)),
    preflight: (handle, opCtx) => yunxiaoPreflight(handle, opCtx || ctx),
    list: (repo, filter, opCtx) => listIssues(ctx, repo, filter, opCtx || (ctx as unknown as OpContext)),
    get: (repo, key, opts, opCtx) => getIssue(ctx, repo, key, opts, opCtx || (ctx as unknown as OpContext)),
    getDependencies: (repo, key, opts, opCtx) =>
      getDependencies(ctx, repo, key, opts, opCtx || (ctx as unknown as OpContext)),
    create: (repo, input, opCtx) => createIssue(ctx, repo, input, opCtx || (ctx as unknown as OpContext)),
    close: (repo, key, opts, opCtx) => closeIssue(ctx, repo, key, opts, opCtx || (ctx as unknown as OpContext)),
    reopen: (repo, key, opCtx) => reopenIssue(ctx, repo, key, opCtx || (ctx as unknown as OpContext)),
    comment: (repo, key, body, opCtx) => addComment(ctx, repo, key, body, opCtx || (ctx as unknown as OpContext)),
    update: (repo, key, patch, opCtx) => updateIssue(ctx, repo, key, patch, opCtx || (ctx as unknown as OpContext)),
    setLabels: (repo, key, labels, opts, opCtx) =>
      setLabels(ctx, repo, key, labels, opts, opCtx || (ctx as unknown as OpContext)),
    setAssignees: (repo, key, assignees, opts, opCtx) =>
      setAssignees(ctx, repo, key, assignees, opts, opCtx || (ctx as unknown as OpContext)),
    setParent: (repo, key, parentKey, opts, opCtx) =>
      setParent(ctx, repo, key, parentKey, opts, opCtx || (ctx as unknown as OpContext)),
    setBlockedBy: (repo, key, blockers, opts, opCtx) =>
      setBlockedBy(ctx, repo, key, blockers, opts, opCtx || (ctx as unknown as OpContext)),
    counts: (repo, filter, opCtx) => counts(repo, filter, opCtx || (ctx as unknown as OpContext)),
    listPage: (repo, filter, opts, opCtx) => listPage(repo, filter, opts, opCtx || (ctx as unknown as OpContext)),
    listLabels: (repo, opCtx) => listLabels(repo, opCtx || (ctx as unknown as OpContext)),
    setLabelColors: (repo, changes, opCtx) => setLabelColors(repo, changes, opCtx || (ctx as unknown as OpContext)),
    getCurrentUser: (repo, opCtx) => getCurrentUser(repo, opCtx || (ctx as unknown as OpContext)),
    getRepoPermissions: (repo, opCtx) => getRepoPermissions(repo, opCtx || (ctx as unknown as OpContext)),
    listSubIssues: (repo, mapKey, opts, opCtx) =>
      listSubIssues(repo, mapKey, opts, opCtx || (ctx as unknown as OpContext)),
    initProject: (handle, input, opCtx) => initProject(handle, input, opCtx || (ctx as unknown as OpContext)),
    listMaps: (repo, opCtx) => listMaps(repo, opCtx || (ctx as unknown as OpContext)),
    readBudget: (opCtx) => readYunxiaoBudget(opCtx || (ctx as unknown as OpContext)),
  } satisfies YunxiaoBackendShape
  return attachYunxiaoOpUsage(backend)
}

/** BackendModule（供注册表装配使用）。 */
export const yunxiaoBackend = {
  id: 'yunxiao',
  label: 'Yunxiao',
  setupPrompt: {
    trackerLine: 'setup.yunxiao.trackerLine',
    trackerChoice: 'setup.yunxiao.trackerChoice',
    backendNote: 'setup.yunxiao.backendNote',
    labelReqs: 'setup.yunxiao.labelReqs',
  },
  describe,
  issueAddress,
  issueRefPattern,
  repoSearchAddress,
  links,
  openRepository,
  openIssue: 'url',
  openContainer: 'url',
  presentation: {
    color: '#ff6a00',
    darkColor: '#ff8f40',
    bg: 'light-dark(rgba(255,106,0,.12), rgba(255,143,64,.14))',
    border: 'light-dark(rgba(255,106,0,.25), rgba(255,143,64,.30))',
  },
  create: createYunxiaoBackend,
  matches,
  budget: YUNXIAO_BUDGET_MODEL,
  prompts,
  fixes,
} satisfies BackendModule

/** 别名导出，兼容 `yunxiaoModule` 与 `yunxiaoBackend` 两种引用。 */
export const yunxiaoModule = yunxiaoBackend

export default createYunxiaoBackend
