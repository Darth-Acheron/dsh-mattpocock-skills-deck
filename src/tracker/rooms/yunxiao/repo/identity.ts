/**
 * src/tracker/rooms/yunxiao/repo/identity.ts —— Yunxiao backend 仓库定位口、四级 Codeup 仓库发现与双步 GetRepository 解析（规格 #02）。
 *
 * 为什么需要「项目坐标 + 按需 Codeup 仓库解析」两层身份：
 *   1. 在云效中，工作项属于 Yunxiao Projex 项目（`projectId`），代码属于 Codeup 仓库（`repositoryId`），
 *      一个 Projex 项目可以关联 0 个（纯规划目录）、1 个或多个 Codeup 仓库。
 *   2. Deck 的 `RepositoryRef.refId` 固定编码为 `${organizationId}/${projectId}`，对应的契约定位口
 *      `getRepoKey(cwd, ctx)` 返回 `{ owner: organizationId, name: projectId }`，并在进程内
 *      `learnedYunxiaoContext` 中记录配置坐标。
 *   3. Codeup 仓库按四级优先级发现：
 *      Tier 1：环境变量 `YUNXIAO_REPOSITORY_ID` 显式覆盖；
 *      Tier 2：工作区配置文件 `docs/agents/yunxiao.yaml` 的 `repositoryId` 显式覆盖；
 *      Tier 3：`git remote get-url origin` 命令读取（当指向 Codeup 时）；
 *      Tier 4：`.git/config` 文件中的 `[remote ...]` 地址（`origin` 优先，其次第一个匹配的 Codeup 远端）。
 *   4. 双步 `GetRepository` 解析：
 *      实测证实云效企业可设置自定义组织标识名（如 `https://codeup.aliyun.com/myCompany/group/repo`），
 *      而 `GetRepository` 同时支持完整 `pathWithNamespace` 与剥离首段组织标识后的相对路径。
 *      因此先以完整路径（斜杠编码为 `%2F`）调用 `GetRepository`；若返回 `404 SYSTEM_NOT_FOUND_ERROR`
 *      且第一段不是 24 位 `organizationId`，则自动剥离第一段重试一次，锁定权威 `CodeupRepositoryIdentity`
 *      （数字 `id` 与 `pathWithNamespace`，绝不使用含空格的显示名 `name` 或 `nameWithNamespace`）。
 */

import type { OpContext } from '../../../contract/contexts.js'
import { remoteUrlsOfGitConfig } from '../../../kernel/git-remote.js'
import { GITLAB_REPO_GIT_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import type { YunxiaoCtx, YunxiaoHttpResult } from '../client.js'
import {
  extractHostFromUrlOrHost,
  formatYunxiaoRefId,
  learnYunxiaoContextFor,
  normalizeCodeupRepositoryIdentity,
  parseCodeupRepo,
  parseYunxiaoRefId,
} from '../model/repo-identity.js'
import type { CodeupRepositoryIdentity } from '../model/repo-identity.js'
import { cleanCodeupRepoPath, resolveYunxiaoCoordinates } from '../model/workspace-config.js'
import { requestCodeupRepositoryGet } from '../requests.js'
import { emitReadDegraded, emitRepoTier } from '../support/read-log.js'

export interface RepoKey {
  owner: string
  name: string
}

/** Codeup 仓库候选来源描述（还没发请求去远端核验前的本地发现结果）。 */
export interface DiscoveredCodeupCandidate {
  /** 命中的发现层级（1=环境变量, 2=配置文件, 3=git origin, 4=.git/config）。 */
  tier: 1 | 2 | 3 | 4
  /** 规范化后的仓库标识（纯数字 ID 或剥离 .git 后的路径）。 */
  repoIdOrPath: string
  /** 若为路径，第一段（可能是 24 位 organizationId 或企业标识名）。 */
  firstSegment: string
  /** 若为路径且段数 >= 2，剥离第一段后的相对组/仓库路径（供企业标识名 404 回退使用）。 */
  fallbackRelativePath: string
}

/** 双步 GetRepository 解析结果。 */
export type CodeupResolutionResult =
  | {
      ok: true
      associated: false
      candidate: null
      identity: null
      response: null
    }
  | {
      ok: true
      associated: true
      candidate: DiscoveredCodeupCandidate
      identity: CodeupRepositoryIdentity
      response: YunxiaoHttpResult
      retriedWithoutFirstSegment: boolean
    }
  | {
      ok: false
      associated: true
      candidate: DiscoveredCodeupCandidate
      response: YunxiaoHttpResult
      retriedWithoutFirstSegment: boolean
    }

/** 校验 `RepositoryRef.refId` 是否形如合法的 `${organizationId}/${projectId}`。 */
export function looksLikeYunxiaoProjectRef(refId: unknown): boolean {
  return parseYunxiaoRefId(refId) !== null
}

function candidateFromExplicitOverride(
  raw: string,
  tier: 1 | 2,
  extraHosts: readonly string[],
): DiscoveredCodeupCandidate | null {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null

  const asUrl = parseCodeupRepo(trimmed, { extraHosts })
  if (asUrl) {
    return {
      tier,
      repoIdOrPath: asUrl.fullPath,
      firstSegment: asUrl.firstSegment,
      fallbackRelativePath: asUrl.relativePathWithoutFirstSegment,
    }
  }

  const cleaned = cleanCodeupRepoPath(trimmed)
  if (!cleaned || /\s/.test(cleaned)) return null
  if (/^\d+$/.test(cleaned)) {
    return {
      tier,
      repoIdOrPath: cleaned,
      firstSegment: '',
      fallbackRelativePath: '',
    }
  }

  const segs = cleaned.split('/').filter((s) => s.length > 0)
  if (segs.length === 0 || segs.some((s) => s === '.' || s === '..')) return null
  return {
    tier,
    repoIdOrPath: segs.join('/'),
    firstSegment: segs[0],
    fallbackRelativePath: segs.length >= 2 ? segs.slice(1).join('/') : '',
  }
}

function extractOriginUrlFromGitConfig(text: string): string {
  if (typeof text !== 'string' || !text) return ''
  let inOrigin = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const head = /^\[([^\]]*)\]/.exec(line)
    if (head) {
      inOrigin = /^remote(?:\s+"origin"|\.origin)$/i.test(head[1].trim())
      continue
    }
    if (!inOrigin) continue
    const m = /^url\s*=\s*(.+)$/i.exec(line)
    if (m) return m[1].trim()
  }
  return ''
}

/** 收集当前工作区配置与环境变量中声明的自定义 Codeup 主机名。 */
export function collectExtraHosts(
  ctx: YunxiaoCtx | null | undefined,
  webBaseUrl?: string,
  apiBaseUrl?: string,
): string[] {
  const out: string[] = []
  const add = (v: unknown) => {
    const h = extractHostFromUrlOrHost(v)
    if (h && h.includes('.') && !out.includes(h)) out.push(h)
  }
  add(webBaseUrl)
  add(apiBaseUrl)
  const env = ctx?.platform?.env
  if (env && typeof env.get === 'function') {
    add(env.get('YUNXIAO_CODEUP_HOST'))
    add(env.get('YUNXIAO_WEB_BASE_URL'))
    add(env.get('YUNXIAO_API_BASE_URL'))
  }
  return out
}

/**
 * 按四级顺序在本地发现关联的 Codeup 仓库候选（不发起远端 HTTP 请求）：
 *   1. 环境变量 `YUNXIAO_REPOSITORY_ID`
 *   2. 工作区配置文件 `docs/agents/yunxiao.yaml` 的 `repositoryId`
 *   3. `git remote get-url origin`
 *   4. `.git/config`（`origin` 优先，其次第一个匹配的 Codeup remote）
 *
 * 若当前工作区是无代码库的纯 Yunxiao Projex 规划工作区，返回 `null`。
 */
export async function discoverCodeupCandidate(
  cwd: string,
  ctx: YunxiaoCtx | null | undefined,
  coords?: { repositoryId?: string; webBaseUrl?: string; apiBaseUrl?: string } | null,
): Promise<DiscoveredCodeupCandidate | null> {
  const t0 = Date.now()
  const execCwd = String(cwd || ctx?.cwd || '').trim()
  const platform = ctx?.platform || null
  const fs = platform?.fs || ctx?.fs || null
  const env = platform?.env || null
  const extraHosts = collectExtraHosts(ctx, coords?.webBaseUrl, coords?.apiBaseUrl)

  // Tier 1：环境变量 YUNXIAO_REPOSITORY_ID 显式覆盖
  const envRepo = env && typeof env.get === 'function' ? String(env.get('YUNXIAO_REPOSITORY_ID') || '').trim() : ''
  if (envRepo) {
    const c1 = candidateFromExplicitOverride(envRepo, 1, extraHosts)
    if (c1) {
      emitRepoTier(ctx, 1, true, t0)
      return c1
    }
  }

  // Tier 2：工作区配置文件 repositoryId 覆盖
  let cfgRepo = coords && typeof coords.repositoryId === 'string' ? coords.repositoryId.trim() : ''
  if (!cfgRepo && execCwd && fs) {
    const resolved = await resolveYunxiaoCoordinates({ cwd: execCwd, fs, env })
    if (resolved.ok && resolved.value.repositoryId) {
      cfgRepo = resolved.value.repositoryId
    }
  }
  if (cfgRepo) {
    const c2 = candidateFromExplicitOverride(cfgRepo, 2, extraHosts)
    if (c2) {
      emitRepoTier(ctx, 2, true, t0)
      return c2
    }
  }

  // Tier 3：git remote get-url origin
  const execFn = ctx?.exec || (platform as { exec?: OpContext['exec'] } | null)?.exec
  if (execCwd && typeof execFn === 'function') {
    try {
      const canRunGit =
        !platform || typeof platform.resolveExecutable !== 'function'
          ? true
          : Boolean(await platform.resolveExecutable('git'))
      if (canRunGit) {
        const res = await execFn('git', ['-C', execCwd, 'remote', 'get-url', 'origin'], {
          cwd: execCwd,
          timeout: GITLAB_REPO_GIT_TIMEOUT_MS,
        })
        const out = String((res && (res.stdout || res.text)) || '').trim()
        const parsed = parseCodeupRepo(out, { extraHosts })
        if (parsed) {
          emitRepoTier(ctx, 3, true, t0)
          return {
            tier: 3,
            repoIdOrPath: parsed.fullPath,
            firstSegment: parsed.firstSegment,
            fallbackRelativePath: parsed.relativePathWithoutFirstSegment,
          }
        }
      }
    } catch {
      // git 未安装或当前目录非 git 仓库，继续走第 4 层 .git/config
    }
  }

  // Tier 4：直读 .git/config（origin 优先，其次第一个匹配的 Codeup remote）
  if (execCwd && fs && typeof fs.resolve === 'function' && typeof fs.readText === 'function') {
    try {
      const target = await fs.resolve('.git/config', { cwd: execCwd })
      const cfgText = String((await fs.readText(target)) || '')
      if (cfgText) {
        const originUrl = extractOriginUrlFromGitConfig(cfgText)
        const originParsed = originUrl ? parseCodeupRepo(originUrl, { extraHosts }) : null
        if (originParsed) {
          emitRepoTier(ctx, 4, true, t0)
          return {
            tier: 4,
            repoIdOrPath: originParsed.fullPath,
            firstSegment: originParsed.firstSegment,
            fallbackRelativePath: originParsed.relativePathWithoutFirstSegment,
          }
        }
        for (const u of remoteUrlsOfGitConfig(cfgText)) {
          const parsed = parseCodeupRepo(u, { extraHosts })
          if (parsed) {
            emitRepoTier(ctx, 4, true, t0)
            return {
              tier: 4,
              repoIdOrPath: parsed.fullPath,
              firstSegment: parsed.firstSegment,
              fallbackRelativePath: parsed.relativePathWithoutFirstSegment,
            }
          }
        }
      }
    } catch {
      // 无 .git/config，属于无代码库的纯规划目录
    }
  }

  return null
}

function isSystemNotFound404(res: YunxiaoHttpResult): boolean {
  if (res.status !== 404) return false
  const text = String(res.stderr || res.stdout || '')
  if (/SYSTEM_NOT_FOUND_ERROR/i.test(text)) return true
  if (res.data && typeof res.data === 'object') {
    const code = String((res.data as Record<string, unknown>)['errorCode'] || '')
    if (/SYSTEM_NOT_FOUND_ERROR/i.test(code)) return true
  }
  return false
}

function shouldRetryWithoutFirstSegment(
  organizationId: string,
  candidate: DiscoveredCodeupCandidate,
  firstRes: YunxiaoHttpResult,
): boolean {
  if (!candidate.fallbackRelativePath) return false
  if (!candidate.firstSegment) return false
  if (!isSystemNotFound404(firstRes)) return false
  return candidate.firstSegment.toLowerCase() !== String(organizationId || '').trim().toLowerCase()
}

/**
 * 执行双步 `GetRepository` 解析：
 *   1. 若工作区未关联任何 Codeup 仓库，返回 `{ ok: true, associated: false }`；
 *   2. 先用完整路径（或数字 ID）调用 `GetRepository`；
 *   3. 若返回 `404 SYSTEM_NOT_FOUND_ERROR` 且首段不是 24 位 `organizationId`（例如企业自定义标识名），
 *      自动剥离首段以相对组/仓库路径重试一次；
 *   4. 解析成功后将权威 `CodeupRepositoryIdentity` 写入 `learnedYunxiaoContext`。
 */
export async function resolveCodeupRepositoryIdentity(input: {
  cwd?: string
  organizationId: string
  projectId: string
  ctx: YunxiaoCtx | null | undefined
  timeoutMs: number
  coords?: { repositoryId?: string; webBaseUrl?: string; apiBaseUrl?: string } | null
}): Promise<CodeupResolutionResult> {
  const cwd = String(input.cwd || input.ctx?.cwd || '').trim()
  const candidate = await discoverCodeupCandidate(cwd, input.ctx, input.coords)
  if (!candidate) {
    return {
      ok: true,
      associated: false,
      candidate: null,
      identity: null,
      response: null,
    }
  }

  let res = await requestCodeupRepositoryGet(
    input.ctx,
    input.organizationId,
    candidate.repoIdOrPath,
    input.timeoutMs,
  )
  let retried = false

  if (!res.ok && shouldRetryWithoutFirstSegment(input.organizationId, candidate, res)) {
    retried = true
    res = await requestCodeupRepositoryGet(
      input.ctx,
      input.organizationId,
      candidate.fallbackRelativePath,
      input.timeoutMs,
    )
  }

  if (!res.ok) {
    return {
      ok: false,
      associated: true,
      candidate,
      response: res,
      retriedWithoutFirstSegment: retried,
    }
  }

  const identity = normalizeCodeupRepositoryIdentity(res.data)
  if (!identity) {
    return {
      ok: false,
      associated: true,
      candidate,
      response: {
        ...res,
        ok: false,
        code: 1,
        stderr: 'GetRepository 响应缺少合法的数字 id 或 pathWithNamespace：' + String(res.stdout || '').slice(0, 200),
      },
      retriedWithoutFirstSegment: retried,
    }
  }

  const refId = formatYunxiaoRefId(input.organizationId, input.projectId)
  learnYunxiaoContextFor(
    { cwd, refId },
    {
      organizationId: input.organizationId,
      projectId: input.projectId,
      codeupRepo: identity,
    },
  )

  return {
    ok: true,
    associated: true,
    candidate,
    identity,
    response: res,
    retriedWithoutFirstSegment: retried,
  }
}

/**
 * 从工作区目录解析出 Yunxiao backend 的仓库坐标键（契约定位口 `getRepoKey`）。
 *
 * 返回 `{ owner: organizationId, name: projectId }`，使上层会话补齐身份时拼出
 * `refId = "${organizationId}/${projectId}"`；配置缺失或非法时诚实返回 `null`（不抛异常）。
 */
export async function getRepoKey(cwd: string, ctx: OpContext): Promise<RepoKey | null> {
  const t0 = Date.now()
  const execCwd = String(cwd || ctx?.cwd || '').trim()
  const platform = ctx && ctx.platform ? ctx.platform : null
  const fs = (platform && platform.fs) || (ctx && ctx.fs) || null
  const env = platform && platform.env ? platform.env : null

  try {
    const resolved = await resolveYunxiaoCoordinates({ cwd: execCwd, fs, env })
    if (!resolved.ok) {
      emitReadDegraded(ctx, 'repoKey', 'repoKey:notfound', Date.now() - t0)
      emitRepoTier(ctx, 1, false, t0)
      return null
    }

    const { organizationId, projectId, customCode, apiBaseUrl, webBaseUrl } = resolved.value
    const refId = formatYunxiaoRefId(organizationId, projectId)
    const patch = {
      organizationId,
      projectId,
      ...(customCode ? { customCode } : {}),
      apiBaseUrl,
      webBaseUrl,
    }
    learnYunxiaoContextFor({ cwd: execCwd, refId }, patch)

    emitRepoTier(ctx, 1, true, t0)
    return { owner: organizationId, name: projectId }
  } catch {
    emitReadDegraded(ctx, 'repoKey', 'repoKey:unknown', Date.now() - t0)
    emitRepoTier(ctx, 1, false, t0)
    return null
  }
}

export default { getRepoKey, discoverCodeupCandidate, resolveCodeupRepositoryIdentity, looksLikeYunxiaoProjectRef }
