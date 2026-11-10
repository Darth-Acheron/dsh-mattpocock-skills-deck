/**
 * src/tracker/rooms/yunxiao/project/init-project.ts —— Yunxiao Projex + Codeup 工作区一体化置备路由（规格 #04 + 架构加深 Candidate 1）。
 *
 * 为什么需要「Yunxiao Projex + Codeup + yunxiao.yaml」一体化开仓置备（Yunxiao workspace provisioning）：
 *   1. 对齐 GitHub 与 GitLab 房间的零配置 initProject 体验：当用户在全新本地目录仅配置了云效令牌时，
 *      自动通过 probeYunxiaoPlatformUser 获取用户身份与 lastOrganization（或经 ListOrganizations 兜底）锁定 organizationId。
 *   2. 当工作区尚未配置 projectId 时，先通过 SearchProjects 查找同名未归档 Yunxiao Projex 项目复用；
 *      若不存在则通过 ListProjectTemplates 自动选取 Scrum/敏捷默认模板（支持 templateId 覆盖），
 *      从仓库名派生 4~6 位全大写字母 customCode（如遇编号冲突自动递增后缀重试），调用 CreateProject 创建同名 Projex 项目。
 *   3. 完成本地 Git 属主自愈与首提交后，调用 Codeup CreateRepository（public 映射为 internal，避免 USER_GUIDE 冲突）
 *      + GetRepository 回查克隆地址、配置 origin 并推送 HEAD。
 *   4. 最后自动将 { organizationId, projectId, customCode, repositoryId } 写入 docs/agents/yunxiao.yaml 并更新 learnedYunxiaoContext。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { OpContext, RepoHandle } from '../../../contract/contexts.js'
import type { RepositoryRef } from '../../../contract/entities.js'
import type { InitProjectInput } from '../../../contract/inputs.js'
import { TRACKER_ERROR_STAGE, type OpResult, type TrackerError } from '../../../contract/results.js'
import { fail } from '../../../kernel/preflight.js'
import { isOwnershipMismatch, ownershipPathFrom, safeDirectoryCommand } from '../../../kernel/workspace-ownership.js'
import {
  GITLAB_CREATE_PROJECT_TIMEOUT_MS, GITLAB_READ_TIMEOUT_MS, VC_ADD_TIMEOUT_MS,
  VC_COMMIT_TIMEOUT_MS, VC_PUSH_TIMEOUT_MS, VC_READ_CMD_TIMEOUT_MS, VC_WORKTREE_OP_TIMEOUT_MS,
} from '../../../../shared/time-config/src/values.js'
import type { YunxiaoCtx } from '../client.js'
import { asRecord, errMsg, failYunxiao } from '../errors.js'
import {
  formatYunxiaoRefId, getLearnedYunxiaoContext, learnYunxiaoContextFor,
  normalizeCodeupRepositoryIdentity, parseYunxiaoRefId, type CodeupRepositoryIdentity,
} from '../model/repo-identity.js'
import {
  DEFAULT_YUNXIAO_API_BASE_URL, DEFAULT_YUNXIAO_WEB_BASE_URL, YUNXIAO_CONFIG_REL,
  deriveProjectCustomCode, formatYunxiaoConfigYaml, isValidOrganizationId, isValidProjectId,
  loadYunxiaoToken, resolveYunxiaoCoordinates,
} from '../model/workspace-config.js'
import { probeYunxiaoPlatformUser } from '../repo/current-user.js'
import {
  requestCodeupRepositoryCreate, requestCodeupRepositoryGet, requestPlatformOrganizations,
  requestProjectCreate, requestProjectsSearch, requestProjectTemplatesList, type YunxiaoCreateRepoBody,
} from '../requests.js'

interface ProcResult { code: number; stdout: string; stderr: string }

function toProc(raw: unknown): ProcResult {
  const bag = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const stdout = typeof bag['stdout'] === 'string' ? bag['stdout'] : typeof bag['text'] === 'string' ? bag['text'] : typeof bag['out'] === 'string' ? bag['out'] : ''
  const stderr = typeof bag['stderr'] === 'string' ? bag['stderr'] : typeof bag['error'] === 'string' ? bag['error'] : ''
  const code = typeof bag['code'] === 'number' ? bag['code'] : typeof bag['ok'] === 'boolean' ? (bag['ok'] ? 0 : 1) : 0
  return { code, stdout, stderr }
}

interface PartialInitCoords {
  organizationId: string
  projectId: string
  customCode: string
  namespaceId?: number
  templateId?: string
  apiBaseUrl: string
  webBaseUrl: string
  hadValidFileCoords: boolean
}

/** 读取本地已有的部分或完整云效坐标（允许缺少 organizationId 或 projectId 以便后续自动发现/创建）。 */
async function readPartialInitCoords(
  handle: RepoHandle, ctx: OpContext,
): Promise<{ ok: true; value: PartialInitCoords } | { ok: false; error: TrackerError }> {
  const cwd = String((handle && handle.cwd) || (ctx && ctx.cwd) || '').trim()
  const platform = ctx?.platform || null
  const fs = platform?.fs || ctx?.fs || null
  const env = platform?.env || null
  const coordsRes = await resolveYunxiaoCoordinates({ cwd, fs, env })
  if (coordsRes.ok) {
    const v = coordsRes.value
    return {
      ok: true,
      value: {
        organizationId: v.organizationId, projectId: v.projectId, customCode: v.customCode || '',
        ...(v.namespaceId ? { namespaceId: v.namespaceId } : {}),
        ...(v.templateId ? { templateId: v.templateId } : {}),
        apiBaseUrl: v.apiBaseUrl, webBaseUrl: v.webBaseUrl, hadValidFileCoords: true,
      },
    }
  }
  if (coordsRes.reason !== 'bad-shape') {
    return fail(ERROR_KIND.ENV as ErrorKind, coordsRes.message, JSON.stringify(coordsRes))
  }
  const fromHandle = parseYunxiaoRefId(handle?.refId)
  const learned = (cwd ? getLearnedYunxiaoContext(cwd) : null) || (handle?.refId ? getLearnedYunxiaoContext(handle.refId) : null)
  const readEnv = (k: string): string => (env && typeof env.get === 'function' ? String(env.get(k) || '').trim() : '')
  const nsRaw = readEnv('YUNXIAO_NAMESPACE_ID')
  const nsNum = nsRaw && /^\d+$/.test(nsRaw) ? Number(nsRaw) : undefined
  return {
    ok: true,
    value: {
      organizationId: readEnv('YUNXIAO_ORGANIZATION_ID') || fromHandle?.organizationId || learned?.organizationId || '',
      projectId: readEnv('YUNXIAO_PROJECT_ID') || fromHandle?.projectId || learned?.projectId || '',
      customCode: readEnv('YUNXIAO_CUSTOM_CODE') || learned?.customCode || '',
      ...(nsNum && nsNum > 0 ? { namespaceId: nsNum } : {}),
      ...(readEnv('YUNXIAO_TEMPLATE_ID') ? { templateId: readEnv('YUNXIAO_TEMPLATE_ID') } : {}),
      apiBaseUrl: readEnv('YUNXIAO_API_BASE_URL') || learned?.apiBaseUrl || DEFAULT_YUNXIAO_API_BASE_URL,
      webBaseUrl: readEnv('YUNXIAO_WEB_BASE_URL') || learned?.webBaseUrl || DEFAULT_YUNXIAO_WEB_BASE_URL,
      hadValidFileCoords: false,
    },
  }
}

/** 自动发现或新建 Yunxiao Projex 项目：优先复用同名未归档项目，不存在时通过模板自动创建并在 customCode 冲突时递增重试。 */
async function ensureOrProvisionProjexProject(
  reqCtx: YunxiaoCtx, organizationId: string, name: string, description: string,
  visibility: 'public' | 'private', preferredTemplateId?: string, preferredCustomCode?: string,
): Promise<{ ok: true; projectId: string; customCode: string; created: boolean } | { ok: false; error: TrackerError }> {
  const searchConditions = JSON.stringify({
    conditionGroups: [[{ fieldIdentifier: 'name', operator: 'CONTAINS', value: [name], toValue: null, className: 'string', format: 'input' }]],
  })
  const searchRes = await requestProjectsSearch(reqCtx, organizationId, { conditions: searchConditions, page: 1, perPage: 20 }, GITLAB_READ_TIMEOUT_MS)
  if (searchRes.ok && Array.isArray(searchRes.data)) {
    const matched = (searchRes.data as Record<string, unknown>[]).find(
      (p) => p && typeof p['id'] === 'string' && String(p['name'] || '').trim().toLowerCase() === name.toLowerCase() && p['logicalStatus'] !== 'DELETED',
    )
    if (matched && typeof matched['id'] === 'string' && matched['id'].trim()) {
      return {
        ok: true,
        projectId: matched['id'].trim(),
        customCode: typeof matched['customCode'] === 'string' && matched['customCode'].trim() ? matched['customCode'].trim() : deriveProjectCustomCode(name, 0),
        created: false,
      }
    }
  }

  let templateId = preferredTemplateId ? preferredTemplateId.trim() : ''
  if (!templateId) {
    const tplRes = await requestProjectTemplatesList(reqCtx, organizationId, GITLAB_READ_TIMEOUT_MS)
    if (!tplRes.ok) return failYunxiao(tplRes, tplRes.stderr || tplRes.stdout || 'initProject: 获取 Yunxiao Projex 项目模板失败', tplRes, reqCtx)
    const list = Array.isArray(tplRes.data) ? (tplRes.data as Record<string, unknown>[]) : []
    const picked =
      list.find((t) => t && typeof t['id'] === 'string' && /scrum|敏捷/i.test(String(t['name'] || ''))) ||
      list.find((t) => t && typeof t['id'] === 'string' && t['type'] === 0) ||
      list.find((t) => t && typeof t['id'] === 'string')
    templateId = picked && typeof picked['id'] === 'string' ? picked['id'].trim() : ''
    if (!templateId) return fail(ERROR_KIND.ENV as ErrorKind, 'initProject: 当前云效组织下未找到可用的 Yunxiao Projex 项目模板', tplRes.stdout)
  }

  const scope: 'public' | 'private' = visibility === 'public' ? 'public' : 'private'
  let lastCreateRes = null
  for (let attempt = 0; attempt < 5; attempt++) {
    const customCode = attempt === 0 && preferredCustomCode && /^[A-Z]{4,6}$/.test(preferredCustomCode)
      ? preferredCustomCode
      : deriveProjectCustomCode(name, attempt)
    const createRes = await requestProjectCreate(
      reqCtx, organizationId,
      { name, customCode, scope, templateId, ...(description ? { description } : {}) },
      GITLAB_CREATE_PROJECT_TIMEOUT_MS,
    )
    lastCreateRes = createRes
    if (createRes.ok) {
      const bag = asRecord(createRes.data)
      const newId = bag && typeof bag['id'] === 'string' ? bag['id'].trim() : ''
      if (!newId) return fail(ERROR_KIND.PARSE as ErrorKind, 'initProject: CreateProject 响应缺少有效的项目 id', createRes.stdout)
      return { ok: true, projectId: newId, customCode, created: true }
    }
    const errText = (createRes.stderr + ' ' + createRes.stdout).toLowerCase()
    const isCodeConflict = createRes.status === 400 && /customcode|编号|代号|duplicate|已存在|occupied/.test(errText)
    if (!isCodeConflict) break
  }
  return failYunxiao(lastCreateRes, lastCreateRes?.stderr || lastCreateRes?.stdout || 'initProject: 创建 Yunxiao Projex 项目失败', lastCreateRes, reqCtx)
}

/** 提取并合并 CreateRepository 与 GetRepository 的权威 Codeup 仓库身份及远程克隆地址。 */
function buildCreatedRepoIdentity(createData: unknown, getData: unknown): { identity: CodeupRepositoryIdentity; cloneUrl: string } | null {
  const fromGet = normalizeCodeupRepositoryIdentity(getData)
  const fromCreate = normalizeCodeupRepositoryIdentity(createData)
  const base = fromGet || fromCreate
  if (!base) return null
  const identity: CodeupRepositoryIdentity = {
    ...fromCreate, ...fromGet, id: base.id, pathWithNamespace: base.pathWithNamespace,
    webUrl: (fromGet && fromGet.webUrl) || (fromCreate && fromCreate.webUrl) || '',
  }
  const httpClone = (identity.httpUrlToRepo && identity.httpUrlToRepo.trim()) || (identity.webUrl ? identity.webUrl.replace(/\.git$/i, '').replace(/\/+$/, '') + '.git' : '')
  return httpClone ? { identity, cloneUrl: httpClone } : null
}

/** 初始化本地工作区并一键在云效置备 Yunxiao Projex 项目与 Codeup 代码库、配置 origin、推送 HEAD 并落盘 yunxiao.yaml（契约操作 initProject）。 */
export async function initProject(handle: RepoHandle, input: InitProjectInput, ctx: OpContext): Promise<OpResult<RepositoryRef>> {
  const cwd = String((handle && typeof handle.cwd === 'string' && handle.cwd) || (ctx && ctx.cwd) || '').trim()
  const name = input && typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) return fail(ERROR_KIND.PARSE as ErrorKind, 'initProject: 仓库名不能为空', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.length > 100) {
    return fail(ERROR_KIND.PARSE as ErrorKind, 'initProject: 仓库名只支持字母、数字、点、下划线、连字符，最长 100 个字符', String(input.name), TRACKER_ERROR_STAGE.INPUT_REFUSED)
  }
  const description = input && typeof (input as { description?: unknown }).description === 'string' ? String((input as { description?: unknown }).description).trim() : ''
  const projexVisibility: 'public' | 'private' = input && input.visibility === 'public' ? 'public' : 'private'
  const codeupVisibility: 'private' | 'internal' = projexVisibility === 'public' ? 'internal' : 'private'
  const platform = ctx?.platform || null
  const fs = platform?.fs || ctx?.fs || null
  const env = platform?.env || null
  const execFn = ctx && typeof ctx.exec === 'function' ? ctx.exec.bind(ctx) : platform && typeof platform.exec === 'function' ? platform.exec.bind(platform) : null

  async function git(args: string[], timeout: number): Promise<ProcResult> {
    if (!execFn) return { code: -1, stdout: '', stderr: 'exec unavailable' }
    try { return toProc(await execFn('git', args, { cwd: cwd || undefined, signal: ctx?.signal || undefined, timeout })) }
    catch (e: unknown) { return { code: -1, stdout: '', stderr: errMsg(e) } }
  }

  if (platform && typeof platform.resolveExecutable === 'function') {
    let gitExe: string | null = null
    try { gitExe = await platform.resolveExecutable('git') } catch { gitExe = null }
    if (!gitExe) return fail(ERROR_KIND.ENV as ErrorKind, 'initProject: 未找到 git（请先安装 https://git-scm.com/）', '')
  }

  const partialRes = await readPartialInitCoords(handle, ctx)
  if (!partialRes.ok) return partialRes
  const partial = partialRes.value

  const homeDirRaw = platform && typeof (platform as unknown as { homeDir?: unknown }).homeDir === 'string' ? (platform as unknown as { homeDir: string }).homeDir : undefined
  const tokenRes = await loadYunxiaoToken({ fs, env, homeDir: homeDirRaw })
  if (!tokenRes.token && typeof (ctx as YunxiaoCtx)?.fetch !== 'function') {
    return fail(ERROR_KIND.AUTH as ErrorKind, 'initProject: 未检测到云效个人访问令牌（请配置环境变量 YUNXIAO_TOKEN 或 ~/.config/yunxiao/token）', '')
  }

  const reqCtx: YunxiaoCtx = { ...(ctx as YunxiaoCtx), cwd, apiBaseUrl: partial.apiBaseUrl, ...(tokenRes.token ? { token: tokenRes.token } : {}) }
  const userProbed = await probeYunxiaoPlatformUser(reqCtx, GITLAB_READ_TIMEOUT_MS)
  if (!userProbed.ok) {
    if (userProbed.kind === 'transport') {
      return failYunxiao(userProbed.response, userProbed.response.stderr || userProbed.response.stdout || 'initProject: 云效当前用户认证失败', userProbed.response, reqCtx)
    }
    return fail(ERROR_KIND.PARSE as ErrorKind, 'initProject: 平台用户响应缺少有效的 id 字段', userProbed.response.stdout)
  }
  const { id: userId, name: userName, lastOrganization } = userProbed.user

  let organizationId = partial.organizationId
  if (!isValidOrganizationId(organizationId, partial.apiBaseUrl)) {
    if (lastOrganization && isValidOrganizationId(lastOrganization, partial.apiBaseUrl)) {
      organizationId = lastOrganization
    } else {
      const orgsRes = await requestPlatformOrganizations(reqCtx, GITLAB_READ_TIMEOUT_MS)
      if (orgsRes.ok && Array.isArray(orgsRes.data)) {
        const firstOrg = (orgsRes.data as Record<string, unknown>[]).find((o) => o && typeof o['id'] === 'string' && isValidOrganizationId(String(o['id']), partial.apiBaseUrl))
        if (firstOrg) organizationId = String(firstOrg['id']).trim()
      }
    }
  }
  if (!isValidOrganizationId(organizationId, partial.apiBaseUrl)) {
    return fail(ERROR_KIND.ENV as ErrorKind, 'initProject: 未配置云效 organizationId 且无法从当前用户自动发现企业组织 ID', '')
  }

  let projectId = partial.projectId
  let customCode = partial.customCode
  let provisionedNewProject = false
  if (!isValidProjectId(projectId)) {
    const projProvisioned = await ensureOrProvisionProjexProject(reqCtx, organizationId, name, description, projexVisibility, partial.templateId, customCode)
    if (!projProvisioned.ok) return projProvisioned
    projectId = projProvisioned.projectId
    customCode = projProvisioned.customCode
    provisionedNewProject = true
  }
  const refId = formatYunxiaoRefId(organizationId, projectId)

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

  const createBody: YunxiaoCreateRepoBody = {
    name, path: name, visibility: codeupVisibility,
    ...(description ? { description } : {}),
    ...(partial.namespaceId ? { namespaceId: partial.namespaceId } : {}),
  }
  const createRes = await requestCodeupRepositoryCreate(reqCtx, organizationId, createBody, GITLAB_CREATE_PROJECT_TIMEOUT_MS)
  if (!createRes.ok) return failYunxiao(createRes, createRes.stderr || createRes.stdout || 'initProject: Codeup CreateRepository 创建远端代码库失败', createRes, reqCtx)

  const createdBag = asRecord(createRes.data)
  const createdIdRaw = createdBag ? createdBag['id'] : undefined
  const createdId = typeof createdIdRaw === 'number' ? createdIdRaw : typeof createdIdRaw === 'string' && /^\d+$/.test(createdIdRaw.trim()) ? Number(createdIdRaw.trim()) : 0
  let getRepoData: unknown = null
  if (createdId > 0) {
    const getRes = await requestCodeupRepositoryGet(reqCtx, organizationId, createdId, GITLAB_READ_TIMEOUT_MS)
    if (getRes.ok) getRepoData = getRes.data
  }

  const built = buildCreatedRepoIdentity(createRes.data, getRepoData)
  if (!built) return fail(ERROR_KIND.PARSE as ErrorKind, 'initProject: 远端 Codeup 代码库已创建，但响应缺少有效的 id、pathWithNamespace 或克隆地址', createRes.stdout)

  const hasOrigin = (await git(['remote', 'get-url', 'origin'], VC_READ_CMD_TIMEOUT_MS)).code === 0
  const wireRes = hasOrigin ? await git(['remote', 'set-url', 'origin', built.cloneUrl], VC_READ_CMD_TIMEOUT_MS) : await git(['remote', 'add', 'origin', built.cloneUrl], VC_READ_CMD_TIMEOUT_MS)
  if (wireRes.code !== 0) return failYunxiao(wireRes, 'initProject: 远端代码库已创建，但配置 origin 失败，本地提交仍在', wireRes, ctx)

  const pushRes = await git(['push', '-u', 'origin', 'HEAD'], VC_PUSH_TIMEOUT_MS)
  if (pushRes.code !== 0) return failYunxiao(pushRes, 'initProject: 远端代码库已创建且已配置 origin，但 git push 失败，修复权限或网络后重推即可', pushRes, ctx)

  if ((!partial.hadValidFileCoords || provisionedNewProject) && fs && typeof fs.writeText === 'function') {
    try {
      const target = typeof fs.resolve === 'function' ? await fs.resolve(YUNXIAO_CONFIG_REL, cwd ? { cwd } : undefined) : (cwd ? cwd.replace(/\/+$/, '') + '/' : '') + YUNXIAO_CONFIG_REL
      const yamlContent = formatYunxiaoConfigYaml({
        organizationId, projectId, ...(customCode ? { customCode } : {}),
        repositoryId: String(built.identity.id),
        ...(partial.namespaceId ? { namespaceId: partial.namespaceId } : {}),
        ...(partial.templateId ? { templateId: partial.templateId } : {}),
        apiBaseUrl: partial.apiBaseUrl, webBaseUrl: partial.webBaseUrl,
      })
      await fs.writeText(target, yamlContent)
    } catch { /* best-effort 写入 */ }
  }

  learnYunxiaoContextFor(
    { cwd, refId },
    {
      organizationId, projectId, ...(customCode ? { customCode } : {}),
      apiBaseUrl: partial.apiBaseUrl, webBaseUrl: partial.webBaseUrl,
      ...(tokenRes.token ? { token: tokenRes.token } : {}),
      codeupRepo: built.identity,
      currentUser: { id: userId, name: userName, ...(lastOrganization ? { lastOrganization } : {}) },
    },
  )
  const repoUrl = built.identity.webUrl || built.cloneUrl.replace(/\.git$/i, '').replace(/\/+$/, '')
  return { ok: true, data: { backend: 'yunxiao', refId, name: built.identity.pathWithNamespace || name, url: repoUrl } }
}

export default initProject
