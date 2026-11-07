/**
 * src/tracker/rooms/yunxiao/model/repo-identity.ts —— Codeup 远端 URL 纯函数解析、权威仓库身份归一化与工作区上下文缓存（规格 #01）。
 *
 * 为什么需要独立的 Codeup 远端解析与身份模型：
 *   1. 云效中工作项归属 Yunxiao Projex 项目（projectId），代码归属 Codeup 仓库（repositoryId），两者解耦；
 *      但上游 views.ts 与会话管线只保留 RepositoryRef 的 { backend, refId, name, url, host, effortId } 六个字段。
 *      因此 RepositoryRef.refId 固定编码为 "${organizationId}/${projectId}"，而关联的 Codeup repository identity
 *      与学习到的 customCode / 当前用户信息缓存在本模块的 learnedYunxiaoContext 中。
 *   2. 实测证实 Codeup 的显示名（name / nameWithNamespace，含空格）与真实 URL 路径（path / pathWithNamespace）
 *      可能不一致（例如显示名 dci-new-api 而真实路径 cdi-new-api），且 GetRepository 严格按路径查询、保留 .git 会报 404。
 *      因此权威仓库身份（Codeup repository identity）只认数字 id 与 pathWithNamespace，绝不使用 name 或 nameWithNamespace。
 *   3. 严守工作区沙箱边界：不跨工作区读取宿主 ~/.ssh/config；未显式配置的未知 SSH 主机别名诚实返回 null，
 *      由用户在 yunxiao.yaml 或环境变量中通过 repositoryId 显式指定。
 */

import { DEFAULT_CODEUP_HOST, cleanCodeupRepoPath } from './workspace-config.js'

/** Codeup 支持的最大嵌套子代码组层级（首段组织标识 + 最多 4 级子组 + 末段仓库名 = 最多 6 段路径）。 */
export const MAX_CODEUP_SUBGROUP_LEVELS = 4
export const MIN_CODEUP_PATH_SEGMENTS = 2
export const MAX_CODEUP_PATH_SEGMENTS = 1 + MAX_CODEUP_SUBGROUP_LEVELS + 1

/** 从 Git remote URL 解析出的 Codeup 远端结构化坐标。 */
export interface CodeupRemoteCoords {
  /** 命中的小写主机名（如 codeup.aliyun.com）。 */
  host: string
  /** 对应的网页端 origin（如 https://codeup.aliyun.com）。 */
  origin: string
  /** 剥离首尾斜杠与末尾 .git 后的完整路径（如 673db5665c76405a332eebc4/Apple/enterpriseagentplatform/cdi-new-api）。 */
  fullPath: string
  /** 第一段路径（可能是 24 位 organizationId，也可能是企业自定义标识名）。 */
  firstSegment: string
  /** 中间嵌套代码组路径段（0..4 段）。 */
  groupSegments: string[]
  /** 末段仓库路径名（不含 .git）。 */
  repoPath: string
  /** 剥离首段组织标识后的相对组/仓库路径（供 GetRepository 企业标识名 404 回退第二步使用）。 */
  relativePathWithoutFirstSegment: string
  /** 兼容 RepoKey 形状的 owner（除最后一段外的前缀路径）。 */
  owner: string
  /** 兼容 RepoKey 形状的 name（末段仓库路径）。 */
  name: string
}

/**
 * 权威 Codeup 仓库身份（Codeup repository identity，词汇表真源见根目录 GLOSSARY.md）。
 * 只保存数字 id 与斜杠分隔的 pathWithNamespace（不含 .git），绝不保存含空格的显示名 nameWithNamespace。
 */
export interface CodeupRepositoryIdentity {
  /** Codeup 仓库数字 ID。 */
  id: number
  /** 服务端返回的权威完整路径（不含 .git）。 */
  pathWithNamespace: string
  /** 仓库网页访问地址。 */
  webUrl: string
  /** HTTPS 克隆地址（GetRepository 返回）。 */
  httpUrlToRepo?: string
  /** SSH 克隆地址（GetRepository 返回）。 */
  sshUrlToRepo?: string
  /** 当前用户在仓库上的权限数值（20=只读 Reporter, 30=Developer, 40=Master/Admin；已统一转为 number）。 */
  accessLevel?: number
  /** 仓库是否已归档。 */
  archived?: boolean
}

/** 房间内按规范化工作区目录（或 refId）缓存的云效运行时上下文。 */
export interface LearnedYunxiaoContext {
  organizationId: string
  projectId: string
  customCode?: string
  projectName?: string
  apiBaseUrl?: string
  webBaseUrl?: string
  codeupRepo?: CodeupRepositoryIdentity | null
  currentUser?: {
    id: string
    name: string
    username?: string
    lastOrganization?: string
  }
}

/** 从一段 URL 或主机配置项中提取纯小写主机名（剥离协议、用户、端口与路径）。 */
export function extractHostFromUrlOrHost(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      const u = new URL(trimmed)
      return u.hostname.toLowerCase()
    }
  } catch {
    // 回退到手工剥离
  }
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const authority = withoutScheme.split('/')[0].replace(/^[^@]*@/, '')
  return authority.split(':')[0].trim().toLowerCase()
}

/** 构造本次解析允许识别的 Codeup 主机集合（默认含 codeup.aliyun.com 及调用方显式传入的自定义域名）。 */
function buildAllowedHosts(extraHosts?: readonly string[]): Set<string> {
  const set = new Set<string>([DEFAULT_CODEUP_HOST])
  if (Array.isArray(extraHosts)) {
    for (const item of extraHosts) {
      const h = extractHostFromUrlOrHost(item)
      if (h && h.includes('.')) set.add(h)
    }
  }
  return set
}

/**
 * 纯函数解析 Codeup Git 远端地址（支持 HTTPS、SSH URL 与 scp-like SSH 三种语法）。
 *
 * 规则：
 *   1. 支持 http(s)://[user@]host[:port]/<path>、ssh://[git@]host[:port]/<path>、git@host:<path>；
 *   2. 剥离 userinfo@、端口、查询串/锚点、首尾斜杠与末尾单个 .git（不区分大小写）；
 *   3. 路径段数必须满足 2 <= segments.length <= 6（首段组织 + 最多 4 级嵌套代码组 + 末段仓库名）；
 *   4. 主机名必须命中 codeup.aliyun.com（不区分大小写）或 opts.extraHosts 显式配置的自定义主机；
 *      不读取宿主 ~/.ssh/config，未知 SSH 主机别名一律返回 null。
 */
export function parseCodeupRepo(
  url: unknown,
  opts?: { extraHosts?: readonly string[] },
): CodeupRemoteCoords | null {
  if (typeof url !== 'string') return null
  const firstLine = url.trim().split(/\r?\n/)[0].trim()
  if (!firstLine) return null

  let scheme = ''
  let hostPort = ''
  let rawPath = ''

  const withScheme = firstLine.match(/^([a-z][a-z0-9+.-]*):\/\/([^/\s]+)\/(.+)$/i)
  const scpLike = firstLine.match(/^[^\s/@]+@([^/\s:]+):(.+)$/)

  if (withScheme) {
    scheme = withScheme[1].toLowerCase()
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ssh' && scheme !== 'git') {
      return null
    }
    hostPort = withScheme[2].replace(/^[^@]*@/, '')
    rawPath = withScheme[3]
  } else if (scpLike) {
    scheme = 'ssh'
    hostPort = scpLike[1]
    rawPath = scpLike[2]
  } else {
    return null
  }

  const host = hostPort.split(':')[0].trim().toLowerCase()
  if (!host || !host.includes('.')) return null

  const allowedHosts = buildAllowedHosts(opts?.extraHosts)
  if (!allowedHosts.has(host)) return null

  const cleanPath = cleanCodeupRepoPath(rawPath.split(/[?#]/)[0])

  if (!cleanPath || /\s/.test(cleanPath) || cleanPath.includes('//')) return null

  const segs = cleanPath.split('/').filter((s) => s.length > 0)
  if (segs.length < MIN_CODEUP_PATH_SEGMENTS || segs.length > MAX_CODEUP_PATH_SEGMENTS) {
    return null
  }
  if (segs.some((seg) => seg === '.' || seg === '..')) return null

  const firstSegment = segs[0]
  const repoPath = segs[segs.length - 1]
  const groupSegments = segs.slice(1, -1)
  const fullPath = segs.join('/')
  const relativePathWithoutFirstSegment = segs.slice(1).join('/')
  const owner = segs.slice(0, -1).join('/')
  const origin =
    scheme === 'http' || scheme === 'https'
      ? scheme + '://' + hostPort.toLowerCase()
      : 'https://' + host

  return {
    host,
    origin,
    fullPath,
    firstSegment,
    groupSegments,
    repoPath,
    relativePathWithoutFirstSegment,
    owner,
    name: repoPath,
  }
}

/**
 * 将 GetRepository 或 CreateRepository 的响应对象归一化为权威 Codeup repository identity。
 * 严格读取数字 id 与 pathWithNamespace（剥离可能附带的 .git），并将字符串或数字 accessLevel 统一转为 number。
 */
export function normalizeCodeupRepositoryIdentity(raw: unknown): CodeupRepositoryIdentity | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const bag = raw as Record<string, unknown>

  const rawId = bag['id']
  const id = typeof rawId === 'number' ? rawId : typeof rawId === 'string' && /^\d+$/.test(rawId.trim()) ? Number(rawId.trim()) : NaN
  if (!Number.isSafeInteger(id) || id <= 0) return null

  const pathWithNamespace = cleanCodeupRepoPath(bag['pathWithNamespace'])
  if (!pathWithNamespace || /\s/.test(pathWithNamespace)) return null

  const webUrl = typeof bag['webUrl'] === 'string' ? bag['webUrl'].trim().replace(/\/+$/, '') : ''
  const out: CodeupRepositoryIdentity = {
    id,
    pathWithNamespace,
    webUrl,
  }

  if (typeof bag['httpUrlToRepo'] === 'string' && bag['httpUrlToRepo'].trim()) {
    out.httpUrlToRepo = bag['httpUrlToRepo'].trim()
  }
  if (typeof bag['sshUrlToRepo'] === 'string' && bag['sshUrlToRepo'].trim()) {
    out.sshUrlToRepo = bag['sshUrlToRepo'].trim()
  }
  if (bag['accessLevel'] !== undefined && bag['accessLevel'] !== null && String(bag['accessLevel']).trim() !== '') {
    const level = Number(String(bag['accessLevel']).trim())
    if (Number.isFinite(level)) out.accessLevel = level
  }
  if (typeof bag['archived'] === 'boolean') {
    out.archived = bag['archived']
  }

  return out
}

/** 编码 Yunxiao backend 的标准 RepositoryRef.refId（固定为 "${organizationId}/${projectId}"）。 */
export function formatYunxiaoRefId(organizationId: string, projectId: string): string {
  const org = String(organizationId || '').trim()
  const proj = String(projectId || '').trim()
  if (!org || !proj) return ''
  return org + '/' + proj
}

/** 从 RepositoryRef.refId 解析出 { organizationId, projectId }；不合法时返回 null。 */
export function parseYunxiaoRefId(refId: unknown): { organizationId: string; projectId: string } | null {
  if (typeof refId !== 'string') return null
  const trimmed = refId.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  const parts = trimmed.split('/')
  if (parts.length !== 2) return null
  const [organizationId, projectId] = parts
  if (!organizationId || !projectId) return null
  return { organizationId, projectId }
}

/** 从仓库引用或句柄中取出原始 refId（优先 refId，次选 name）。 */
export function repoRefId(repo: { refId?: unknown; name?: unknown } | null | undefined): string {
  if (!repo) return ''
  if (typeof repo.refId === 'string' && repo.refId.trim()) return repo.refId.trim()
  if (typeof repo.name === 'string' && repo.name.trim()) return repo.name.trim()
  return ''
}

// 进程内按规范化工作区路径或 refId 维护的云效上下文缓存（上限 200 条 LRU）。
const LEARNED_CONTEXT_CAPACITY = 200
const learnedContexts = new Map<string, LearnedYunxiaoContext>()

function normalizeCacheKey(key: unknown): string {
  if (typeof key !== 'string') return ''
  return key.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 更新或记录某个工作区（或 refId）学习到的云效上下文。 */
export function learnYunxiaoContext(
  cwdOrRefId: unknown,
  patch: Partial<LearnedYunxiaoContext> & { organizationId: string; projectId: string },
): LearnedYunxiaoContext | null {
  const key = normalizeCacheKey(cwdOrRefId)
  if (!key || !patch.organizationId || !patch.projectId) return null
  const prev = learnedContexts.get(key)
  const next: LearnedYunxiaoContext = {
    ...(prev || {}),
    ...patch,
  }
  if (learnedContexts.has(key)) learnedContexts.delete(key)
  learnedContexts.set(key, next)
  while (learnedContexts.size > LEARNED_CONTEXT_CAPACITY) {
    const oldest = learnedContexts.keys().next()
    if (oldest.done) break
    learnedContexts.delete(oldest.value)
  }
  return next
}

/** 读取某个工作区（或 refId）已缓存的云效上下文。 */
export function getLearnedYunxiaoContext(cwdOrRefId: unknown): LearnedYunxiaoContext | null {
  const key = normalizeCacheKey(cwdOrRefId)
  if (!key) return null
  return learnedContexts.get(key) || null
}

/** 清空已学习的云效上下文缓存（供离线测试隔离使用）。 */
export function clearLearnedYunxiaoContexts(): void {
  learnedContexts.clear()
}
