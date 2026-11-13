/**
 * src/tracker/rooms/yunxiao/project/init-project-helpers.ts —— 云效工作区发现与一体化置备共用辅助模块（规格 #21 / #24）。
 *
 * 为什么独立成文件：
 *   1. 将工作区目录名提取、默认 Scrum 敏捷模板挑选、Codeup 双源命名空间聚合（ListRepositories + ListNamespaces）、
 *      SSH 免密连通性探测（ssh -T git@codeup.aliyun.com）、本地 origin 读取与 Projex 项目新建/冲突递增重试
 *      收敛在此，确保 discover.ts 与 init-project.ts 均远低于 250 有效行；
 *   2. 严格使用房间内部类型与请求边界，零第三方依赖。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { OpContext } from '../../../contract/contexts.js'
import { PAGINATION } from '../../../contract/pagination.js'
import type { TrackerError } from '../../../contract/results.js'
import { fail } from '../../../kernel/preflight.js'
import { isOwnershipMismatch, ownershipPathFrom, safeDirectoryCommand } from '../../../kernel/workspace-ownership.js'
import {
  GITLAB_CREATE_PROJECT_TIMEOUT_MS, GITLAB_READ_TIMEOUT_MS, VC_ADD_TIMEOUT_MS,
  VC_COMMIT_TIMEOUT_MS, VC_READ_CMD_TIMEOUT_MS, VC_WORKTREE_OP_TIMEOUT_MS,
} from '../../../../shared/time-config/src/values.js'
import type { YunxiaoCtx } from '../client.js'
import { asRecord, failYunxiao } from '../errors.js'
import { normalizeCodeupRepositoryIdentity, type CodeupRepositoryIdentity } from '../model/repo-identity.js'
import { cleanCodeupRepoPath, deriveProjectCustomCode } from '../model/workspace-config.js'
import { requestProjectCreate, requestProjectsSearch, requestProjectTemplatesList } from '../requests.js'

/** 本地子进程（git / ssh）统一返回信封：code 为退出码（0 表示成功），stdout 与 stderr 为完整输出文本。 */
export interface ProcResult { code: number; stdout: string; stderr: string }

/** 将不同执行器返回的子进程结果归一为标准 ProcResult（兼容 { code, stdout, stderr } 与 { ok, text, error } 两种宿主返回形状）。 */
export function toProc(raw: unknown): ProcResult {
  const bag = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const stdout = typeof bag['stdout'] === 'string' ? bag['stdout'] : typeof bag['text'] === 'string' ? bag['text'] : typeof bag['out'] === 'string' ? bag['out'] : ''
  const stderr = typeof bag['stderr'] === 'string' ? bag['stderr'] : typeof bag['error'] === 'string' ? bag['error'] : ''
  const code = typeof bag['code'] === 'number' ? bag['code'] : typeof bag['ok'] === 'boolean' ? (bag['ok'] ? 0 : 1) : 0
  return { code, stdout, stderr }
}

/** 提取目录末段名称（兼容 POSIX 与 Windows 分隔符）。 */
export function basenameOfCwd(cwd: string): string {
  const parts = String(cwd || '').trim().replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || ''
}

/** 从模板列表中挑选默认 Scrum / 敏捷模板（优先匹配名称含 Scrum/敏捷，次选 type === 0 系统模板，兜底第一项）。 */
export function pickDefaultProjectTemplateId(templates: Record<string, unknown>[]): string {
  const picked =
    templates.find((t) => t && typeof t['id'] === 'string' && /scrum|敏捷/i.test(String(t['name'] || ''))) ||
    templates.find((t) => t && typeof t['id'] === 'string' && t['type'] === 0) ||
    templates.find((t) => t && typeof t['id'] === 'string')
  return picked && typeof picked['id'] === 'string' ? picked['id'].trim() : ''
}

/** 提取并合并 CreateRepository / GetRepository 的权威 Codeup 仓库身份及按协议选择的远端克隆地址。 */
export function buildCodeupCloneTarget(
  primaryData: unknown, secondaryData?: unknown, preferredProtocol: 'https' | 'ssh' = 'https',
): { identity: CodeupRepositoryIdentity; cloneUrl: string; httpCloneUrl: string; sshCloneUrl: string } | null {
  const fromPrimary = normalizeCodeupRepositoryIdentity(primaryData)
  const fromSecondary = secondaryData ? normalizeCodeupRepositoryIdentity(secondaryData) : null
  const base = fromPrimary || fromSecondary
  if (!base) return null
  const identity: CodeupRepositoryIdentity = {
    ...fromSecondary, ...fromPrimary, id: base.id, pathWithNamespace: base.pathWithNamespace,
    webUrl: (fromPrimary && fromPrimary.webUrl) || (fromSecondary && fromSecondary.webUrl) || '',
  }
  const httpCloneUrl = (identity.httpUrlToRepo && identity.httpUrlToRepo.trim()) || (identity.webUrl ? identity.webUrl.replace(/\.git$/i, '').replace(/\/+$/, '') + '.git' : '')
  const sshCloneUrl = (identity.sshUrlToRepo && identity.sshUrlToRepo.trim()) || ''
  const cloneUrl = preferredProtocol === 'ssh' && sshCloneUrl ? sshCloneUrl : (httpCloneUrl || sshCloneUrl)
  return cloneUrl ? { identity, cloneUrl, httpCloneUrl: httpCloneUrl || cloneUrl, sshCloneUrl } : null
}

/**
 * 双通道父代码组发现（Dual-source Codeup namespace discovery）：
 *   1. 主源从 ListRepositories 列表项聚合提取去重的父代码组路径 { namespaceId -> groupFullPath }；
 *   2. 辅源合并 ListNamespaces（对 HTTP 403 静默降级）；
 *   3. 始终把根命名空间排在首位。
 */
export function aggregateCodeupNamespaces(
  nsListRaw: unknown, repoListRaw: unknown, organizationId: string,
): Array<{ id: number; path: string; name: string; isRoot: boolean }> {
  const byId = new Map<number, { id: number; path: string; name: string; isRoot: boolean }>()
  const orgLower = String(organizationId || '').trim().toLowerCase()
  const addNs = (rawId: unknown, rawPath: unknown, rawName: unknown, parentIdRaw?: unknown) => {
    const id = typeof rawId === 'number' ? rawId : typeof rawId === 'string' && /^\d+$/.test(rawId.trim()) ? Number(rawId.trim()) : NaN
    if (!Number.isSafeInteger(id) || id <= 0) return
    const pathStr = cleanCodeupRepoPath(rawPath) || String(rawName || id).trim()
    const nameStr = String(rawName || pathStr || id).trim()
    const segs = pathStr.split('/').filter(Boolean)
    const isRoot = parentIdRaw === null || parentIdRaw === 0 || parentIdRaw === '0' || segs.length <= 1 || (segs.length === 1 && segs[0].toLowerCase() === orgLower)
    const prev = byId.get(id)
    if (!prev || (prev.path === String(id) && pathStr !== String(id))) {
      byId.set(id, { id, path: pathStr, name: nameStr, isRoot: prev ? (prev.isRoot || isRoot) : isRoot })
    }
  }
  if (Array.isArray(repoListRaw)) {
    for (const item of repoListRaw) {
      const b = asRecord(item)
      if (!b) continue
      const nsBag = asRecord(b['namespace'])
      const nsId = (nsBag && nsBag['id']) ?? b['namespaceId']
      const repoPath = cleanCodeupRepoPath(b['pathWithNamespace'])
      const parentPath = repoPath.includes('/') ? repoPath.slice(0, repoPath.lastIndexOf('/')) : (nsBag && nsBag['path']) || ''
      const nsName = (nsBag && (nsBag['nameWithNamespace'] || nsBag['name'] || nsBag['path'])) || parentPath
      addNs(nsId, parentPath, nsName, nsBag ? nsBag['parentId'] : undefined)
    }
  }
  if (Array.isArray(nsListRaw)) {
    for (const item of nsListRaw) {
      const b = asRecord(item)
      if (b) addNs(b['id'], b['fullPath'] || b['pathWithNamespace'] || b['path'], b['nameWithNamespace'] || b['name'], b['parentId'])
    }
  }
  return Array.from(byId.values()).sort((a, b) => (a.isRoot !== b.isRoot ? (a.isRoot ? -1 : 1) : a.id - b.id))
}

/** 读取本地 Git 工作区的 origin 远端 URL（优先 git remote get-url origin，回退解析 .git/config）。 */
export async function readLocalOriginUrl(cwd: string, wsFs: any, execFn: any): Promise<string> {
  if (cwd && typeof execFn === 'function') {
    try {
      const r = await execFn('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { cwd, timeout: VC_READ_CMD_TIMEOUT_MS })
      const code = typeof r?.code === 'number' ? r.code : (r?.ok === false ? 1 : 0)
      const out = String(r?.stdout ?? r?.text ?? '').trim()
      if (code === 0 && out) return out
    } catch { /* 回退读 .git/config */ }
  }
  if (cwd && wsFs && typeof wsFs.readText === 'function') {
    try {
      const target = typeof wsFs.resolve === 'function' ? await wsFs.resolve('.git/config', { cwd }) : cwd.replace(/\/+$/, '') + '/.git/config'
      const text = String((await wsFs.readText(target)) || '')
      let inOrigin = false
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim()
        const head = /^\[([^\]]*)\]/.exec(line)
        if (head) { inOrigin = /^remote(?:\s+"origin"|\.origin)$/i.test(head[1].trim()); continue }
        if (inOrigin) { const m = /^url\s*=\s*(.+)$/i.exec(line); if (m) return m[1].trim() }
      }
    } catch { /* 无本地 git 配置 */ }
  }
  return ''
}

/**
 * 探测本机到 Codeup 的 SSH 免密可用性：
 *   ssh -T -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new git@codeup.aliyun.com
 *   输出含 Codeup 的欢迎或认证成功文本才视为可用；只看退出码会把无输出的失败误判为可用。
 */
export async function probeCodeupSshConnectivity(execFn: any, cwd: string): Promise<boolean> {
  if (typeof execFn !== 'function') return false
  try {
    const r = await execFn(
      'ssh',
      ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', 'git@codeup.aliyun.com'],
      { cwd: cwd || undefined },
    )
    const combined = String(r?.stdout ?? r?.text ?? '') + '\n' + String(r?.stderr ?? r?.error ?? '')
    return /Welcome to Codeup|successfully authenticated/i.test(combined)
  } catch {
    return false
  }
}

/**
 * 复用同名未删除 Yunxiao Projex 项目，或按 Scrum 敏捷模板新建项目（customCode 冲突时最多递增重试 5 次）。
 */
export async function ensureOrProvisionProjexProject(
  reqCtx: YunxiaoCtx, organizationId: string, name: string, description: string,
  visibility: 'public' | 'private', preferredTemplateId?: string, preferredCustomCode?: string, forceCreate = false,
): Promise<{ ok: true; projectId: string; customCode: string; created: boolean } | { ok: false; error: TrackerError }> {
  if (!forceCreate) {
    const searchConditions = JSON.stringify({
      conditionGroups: [[{ fieldIdentifier: 'name', operator: 'CONTAINS', value: [name], toValue: null, className: 'string', format: 'input' }]],
    })
    const searchRes = await requestProjectsSearch(reqCtx, organizationId, { conditions: searchConditions, page: 1, perPage: PAGINATION.github.anchorLookupSearchLimit }, GITLAB_READ_TIMEOUT_MS)
    if (searchRes.ok && Array.isArray(searchRes.data)) {
      const matched = (searchRes.data as Record<string, unknown>[]).find(
        (p) => p && typeof p['id'] === 'string' && String(p['name'] || '').trim().toLowerCase() === name.toLowerCase() && p['logicalStatus'] !== 'DELETED',
      )
      if (matched && typeof matched['id'] === 'string' && matched['id'].trim()) {
        return {
          ok: true, projectId: matched['id'].trim(), created: false,
          customCode: typeof matched['customCode'] === 'string' && matched['customCode'].trim() ? matched['customCode'].trim() : deriveProjectCustomCode(name, 0),
        }
      }
    }
  }

  let templateId = preferredTemplateId ? preferredTemplateId.trim() : ''
  if (!templateId) {
    const tplRes = await requestProjectTemplatesList(reqCtx, organizationId, GITLAB_READ_TIMEOUT_MS)
    if (!tplRes.ok) return failYunxiao(tplRes, tplRes.stderr || tplRes.stdout || 'initProject: 获取 Yunxiao Projex 项目模板失败', tplRes, reqCtx)
    templateId = pickDefaultProjectTemplateId(Array.isArray(tplRes.data) ? (tplRes.data as Record<string, unknown>[]) : [])
    if (!templateId) return fail(ERROR_KIND.ENV as ErrorKind, 'initProject: 当前云效组织下未找到可用的 Yunxiao Projex 项目模板', tplRes.stdout)
  }

  const scope: 'public' | 'private' = visibility === 'public' ? 'public' : 'private'
  const normPreferredCode = preferredCustomCode ? preferredCustomCode.trim().toUpperCase() : ''
  let lastCreateRes = null
  // 首次创建之外最多再递增重试 5 次，因此编号冲突时总共最多发出 6 次创建请求。
  for (let attempt = 0; attempt <= 5; attempt++) {
    const customCode = attempt === 0 && normPreferredCode && /^[A-Z]{4,6}$/.test(normPreferredCode) ? normPreferredCode : deriveProjectCustomCode(name, attempt)
    const createRes = await requestProjectCreate(
      reqCtx, organizationId, { name, customCode, scope, templateId, ...(description ? { description } : {}) }, GITLAB_CREATE_PROJECT_TIMEOUT_MS,
    )
    lastCreateRes = createRes
    if (createRes.ok) {
      const bag = asRecord(createRes.data), newId = bag && typeof bag['id'] === 'string' ? bag['id'].trim() : ''
      if (!newId) return fail(ERROR_KIND.PARSE as ErrorKind, 'initProject: CreateProject 响应缺少有效的项目 id', createRes.stdout)
      return { ok: true, projectId: newId, customCode, created: true }
    }
    const errText = (createRes.stderr + ' ' + createRes.stdout).toLowerCase()
    if (!(createRes.status === 400 && /customcode|编号|代号|duplicate|已存在|occupied/.test(errText))) break
  }
  return failYunxiao(lastCreateRes, lastCreateRes?.stderr || lastCreateRes?.stdout || 'initProject: 创建 Yunxiao Projex 项目失败', lastCreateRes, reqCtx)
}

/** 初始化本地 Git 仓库并在需要时生成初始提交（含 safe.directory 属主自愈与 git user 身份兜底）。 */
export async function ensureLocalGitInitialized(
  git: (args: string[], timeout: number) => Promise<ProcResult>, cwd: string, userName: string, ctx: OpContext, requireCommit: boolean,
): Promise<{ ok: true; hasHead: boolean } | { ok: false; error: TrackerError }> {
  let probe = await git(['rev-parse', '--is-inside-work-tree'], VC_READ_CMD_TIMEOUT_MS)
  if (probe.code !== 0) {
    const probeErr = (probe.stderr + '\n' + probe.stdout).trim()
    if (isOwnershipMismatch(probeErr)) {
      const dir = ownershipPathFrom(probeErr) || cwd
      await git(['config', '--global', '--add', 'safe.directory', dir], VC_READ_CMD_TIMEOUT_MS)
      probe = await git(['rev-parse', '--is-inside-work-tree'], VC_READ_CMD_TIMEOUT_MS)
      const secondErr = (probe.stderr + '\n' + probe.stdout).trim()
      if (probe.code !== 0 && isOwnershipMismatch(secondErr)) {
        const cmd = safeDirectoryCommand(ownershipPathFrom(secondErr) || cwd)
        return fail(ERROR_KIND.ENV as ErrorKind, 'initProject: 工作区目录属主与当前用户不一致，git 拒绝操作。' + (cmd ? '请执行：' + cmd : ''), secondErr)
      }
    }
  }
  if (probe.code !== 0) {
    const initRes = await git(['init'], VC_WORKTREE_OP_TIMEOUT_MS)
    if (initRes.code !== 0) return failYunxiao(initRes, 'initProject: git init 失败：' + (initRes.stderr || initRes.stdout), initRes, ctx)
  }
  if (!requireCommit) {
    const headRes = await git(['rev-parse', '--verify', 'HEAD'], VC_READ_CMD_TIMEOUT_MS)
    return { ok: true, hasHead: headRes.code === 0 }
  }
  const addRes = await git(['add', '.'], VC_ADD_TIMEOUT_MS)
  if (addRes.code !== 0) return failYunxiao(addRes, 'initProject: git add 失败：' + (addRes.stderr || addRes.stdout), addRes, ctx)
  let commitRes = await git(['commit', '-m', 'initial commit', '--allow-empty'], VC_COMMIT_TIMEOUT_MS)
  if (commitRes.code !== 0) {
    const low = (commitRes.stderr + '\n' + commitRes.stdout).toLowerCase()
    if (/please tell me who you are|user\.name|user\.email|author identity unknown|unable to auto-detect email/.test(low)) {
      await git(['config', 'user.email', 'dsh@local'], VC_READ_CMD_TIMEOUT_MS)
      await git(['config', 'user.name', userName || 'DSH User'], VC_READ_CMD_TIMEOUT_MS)
      commitRes = await git(['commit', '-m', 'initial commit', '--allow-empty'], VC_COMMIT_TIMEOUT_MS)
    }
    if (commitRes.code !== 0) return failYunxiao(commitRes, 'initProject: git commit 失败：' + (commitRes.stderr || commitRes.stdout), commitRes, ctx)
  }
  return { ok: true, hasHead: true }
}
