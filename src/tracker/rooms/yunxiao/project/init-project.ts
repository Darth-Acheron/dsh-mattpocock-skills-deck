/**
 * src/tracker/rooms/yunxiao/project/init-project.ts —— Yunxiao Projex + Codeup 工作区三模式一体化置备路由（规格 #04 / #21 / #24）。
 *
 * 为什么需要「Yunxiao Projex + Codeup + yunxiao.yaml」三模式一体化置备与先落盘后推送（Persist-Before-Push）：
 *   1. 支持向导显式覆盖 organizationId、projectMode（reuse / existing / create）、projectId、projectName、customCode、templateId；
 *   2. 支持 Codeup 三种置备模式：none（纯规划工作区，不建代码库、不跑 Git）、bind（兼容 existing / bind-origin，关联已有代码库）、
 *      create（新建远端代码库并配置 origin 后推送）；
 *   3. 严格执行 Persist-Before-Push（远端项目与代码库确认后、执行 git remote 与 git push 前立即落盘 docs/agents/yunxiao.yaml 并更新内存上下文）：
 *      即便网络或权限导致推送中断，已创建或选定的组织、Projex 项目与 Codeup 代码库坐标也已持久化落盘，支持一键 retryPushFlow；
 *   4. 支持 remoteProtocol: 'auto' | 'ssh' | 'https'：auto 默认通过 ssh -T 探测本机 SSH 免密，可用则优先选 sshUrlToRepo，
 *      若 auto 模式下 SSH 推送因认证失败则自动回退 httpUrlToRepo 重推一次；
 *   5. 返回 extraUrls 双深链与 hint（${customCode}-<number> 提交自动关联提示）。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { OpContext, RepoHandle } from '../../../contract/contexts.js'
import type { RepositoryRef } from '../../../contract/entities.js'
import type { InitProjectInput } from '../../../contract/inputs.js'
import { TRACKER_ERROR_STAGE, type OpResult, type TrackerError } from '../../../contract/results.js'
import { fail } from '../../../kernel/preflight.js'
import {
  GITLAB_CREATE_PROJECT_TIMEOUT_MS, GITLAB_READ_TIMEOUT_MS, VC_PUSH_TIMEOUT_MS, VC_READ_CMD_TIMEOUT_MS,
} from '../../../../shared/time-config/src/values.js'
import type { YunxiaoCtx } from '../client.js'
import { asRecord, errMsg, failYunxiao } from '../errors.js'
import {
  formatYunxiaoRefId, getLearnedYunxiaoContext, learnYunxiaoContextFor,
  parseCodeupRemoteUrl, parseYunxiaoRefId, type CodeupRepositoryIdentity,
} from '../model/repo-identity.js'
import {
  DEFAULT_YUNXIAO_API_BASE_URL, DEFAULT_YUNXIAO_WEB_BASE_URL, YUNXIAO_CONFIG_REL, cleanCodeupRepoPath,
  formatYunxiaoConfigYaml, isValidOrganizationId, isValidProjectId, loadYunxiaoToken, resolveYunxiaoCoordinates,
} from '../model/workspace-config.js'
import { probeYunxiaoPlatformUser } from '../repo/current-user.js'
import { collectExtraHosts, discoverCodeupCandidate } from '../repo/identity.js'
import {
  requestCodeupRepositoryCreate, requestCodeupRepositoryGet, requestPlatformOrganizations,
  requestProjectGet, type YunxiaoCreateRepoBody,
} from '../requests.js'
import { buildAddress } from '../room/links.js'
import {
  basenameOfCwd, buildCodeupCloneTarget, ensureLocalGitInitialized, ensureOrProvisionProjexProject,
  probeCodeupSshConnectivity, toProc, type ProcResult,
} from './init-project-helpers.js'

interface PartialInitCoords {
  organizationId: string; projectId: string; customCode: string; namespaceId?: number
  templateId?: string; apiBaseUrl: string; webBaseUrl: string; hadValidFileCoords: boolean
}

async function readPartialInitCoords(
  handle: RepoHandle, ctx: OpContext,
): Promise<{ ok: true; value: PartialInitCoords } | { ok: false; error: TrackerError }> {
  const cwd = String((handle && handle.cwd) || (ctx && ctx.cwd) || '').trim()
  const platform = ctx?.platform || null, fs = platform?.fs || ctx?.fs || null, env = platform?.env || null
  const coordsRes = await resolveYunxiaoCoordinates({ cwd, fs, env })
  if (coordsRes.ok) {
    const v = coordsRes.value
    return {
      ok: true,
      value: {
        organizationId: v.organizationId, projectId: v.projectId, customCode: v.customCode || '',
        ...(v.namespaceId ? { namespaceId: v.namespaceId } : {}), ...(v.templateId ? { templateId: v.templateId } : {}),
        apiBaseUrl: v.apiBaseUrl, webBaseUrl: v.webBaseUrl, hadValidFileCoords: true,
      },
    }
  }
  if (coordsRes.reason !== 'bad-shape') return fail(ERROR_KIND.ENV as ErrorKind, coordsRes.message, JSON.stringify(coordsRes))
  const fromHandle = parseYunxiaoRefId(handle?.refId)
  const learned = (cwd ? getLearnedYunxiaoContext(cwd) : null) || (handle?.refId ? getLearnedYunxiaoContext(handle.refId) : null)
  const readEnv = (k: string): string => (env && typeof env.get === 'function' ? String(env.get(k) || '').trim() : '')
  const nsRaw = readEnv('YUNXIAO_NAMESPACE_ID'), nsNum = nsRaw && /^\d+$/.test(nsRaw) ? Number(nsRaw) : undefined
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

export async function initProject(handle: RepoHandle, input: InitProjectInput, ctx: OpContext): Promise<OpResult<RepositoryRef>> {
  const cwd = String((handle && typeof handle.cwd === 'string' && handle.cwd) || (ctx && ctx.cwd) || '').trim()
  const rawMode = input?.repoMode
  const repoMode: 'none' | 'bind' | 'bind-origin' | 'existing' | 'create' =
    rawMode === 'none' || rawMode === 'bind' || rawMode === 'bind-origin' || rawMode === 'existing' ? rawMode : 'create'
  const rawRepoIdInput = input?.repositoryId != null ? cleanCodeupRepoPath(input.repositoryId) : ''
  const rawNameInput = input && typeof input.name === 'string' ? input.name.trim() : ''
  const fallbackSlug = (rawRepoIdInput.split('/').filter(Boolean).pop() || '') || basenameOfCwd(cwd) || 'yunxiao-project'
  const name = rawNameInput || (repoMode !== 'create' ? fallbackSlug : '')
  if (!name) return fail(ERROR_KIND.PARSE as ErrorKind, 'initProject: 仓库名不能为空', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.length > 100) {
    return fail(ERROR_KIND.PARSE as ErrorKind, 'initProject: 仓库名只支持字母、数字、点、下划线、连字符，最长 100 个字符', String(input?.name || name), TRACKER_ERROR_STAGE.INPUT_REFUSED)
  }
  const description = input && typeof input.description === 'string' ? input.description.trim() : ''
  const projexVisibility: 'public' | 'private' = input && input.visibility === 'public' ? 'public' : 'private'
  const codeupVisibility: 'private' | 'internal' = projexVisibility === 'public' ? 'internal' : 'private'
  const rawProto = input?.remoteProtocol
  const requestedProtocol: 'auto' | 'https' | 'ssh' = rawProto === 'ssh' || rawProto === 'https' || rawProto === 'auto' ? rawProto : 'auto'
  const platform = ctx?.platform || null, fs = platform?.fs || ctx?.fs || null, env = platform?.env || null
  const execFn = ctx && typeof ctx.exec === 'function' ? ctx.exec.bind(ctx) : platform && typeof platform.exec === 'function' ? platform.exec.bind(platform) : null

  async function git(args: string[], timeout: number): Promise<ProcResult> {
    if (!execFn) return { code: -1, stdout: '', stderr: 'exec unavailable' }
    try { return toProc(await execFn('git', args, { cwd: cwd || undefined, signal: ctx?.signal || undefined, timeout })) }
    catch (e: unknown) { return { code: -1, stdout: '', stderr: errMsg(e) } }
  }

  if (repoMode !== 'none' && platform && typeof platform.resolveExecutable === 'function') {
    let gitExe: string | null = null
    try { gitExe = await platform.resolveExecutable('git') } catch { gitExe = null }
    if (!gitExe) return fail(ERROR_KIND.ENV as ErrorKind, 'initProject: 未找到 git（请先安装 https://git-scm.com/）', '')
  }

  const partialRes = await readPartialInitCoords(handle, ctx)
  if (!partialRes.ok) return partialRes
  const partial = partialRes.value

  let homeDirRaw = platform && typeof (platform as unknown as { homeDir?: unknown }).homeDir === 'string' ? (platform as unknown as { homeDir: string }).homeDir : undefined
  if (!homeDirRaw && platform && typeof (platform as unknown as { getHome?: () => Promise<string> }).getHome === 'function') {
    try { homeDirRaw = String((await (platform as unknown as { getHome: () => Promise<string> }).getHome()) || '').trim() || undefined } catch {}
  }
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

  let organizationId = (input?.organizationId ? String(input.organizationId).trim() : '') || partial.organizationId
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

  const explicitProjMode = input?.projectMode
  const explicitProjId = input?.projectId ? String(input.projectId).trim() : ''
  const explicitTplId = input?.templateId ? String(input.templateId).trim() : partial.templateId
  const explicitCustomCode = input?.customCode ? String(input.customCode).trim() : partial.customCode
  const explicitNsRaw = input?.namespaceId != null ? String(input.namespaceId).trim() : ''
  const namespaceId = explicitNsRaw && /^\d+$/.test(explicitNsRaw) ? Number(explicitNsRaw) : partial.namespaceId
  const hadWizardOverrides = Boolean(
    input?.organizationId || input?.projectMode || input?.projectId || input?.projectName ||
    input?.customCode || input?.templateId || input?.repoMode || input?.repositoryId || input?.namespaceId != null,
  )

  let projectId = explicitProjMode === 'create' ? '' : (explicitProjId || partial.projectId)
  let customCode = explicitCustomCode || ''
  let provisionedNewProject = false
  if (explicitProjMode === 'reuse' || explicitProjMode === 'existing' || (!explicitProjMode && explicitProjId)) {
    if (!isValidProjectId(projectId)) return fail(ERROR_KIND.PARSE as ErrorKind, 'initProject: 指定的 Yunxiao Projex projectId 格式不合法', projectId)
    const projRes = await requestProjectGet(reqCtx, organizationId, projectId, GITLAB_READ_TIMEOUT_MS)
    if (!projRes.ok) return failYunxiao(projRes, projRes.stderr || projRes.stdout || 'initProject: 读取指定的 Yunxiao Projex 项目失败', projRes, reqCtx)
    const projBag = asRecord(projRes.data)
    if (!projBag || projBag['logicalStatus'] === 'DELETED') return fail(ERROR_KIND.NOTFOUND as ErrorKind, 'initProject: 指定的 Yunxiao Projex 项目不存在或已删除', projRes.stdout)
    if (typeof projBag['customCode'] === 'string' && projBag['customCode'].trim()) customCode = projBag['customCode'].trim()
  } else if (explicitProjMode === 'create' || !isValidProjectId(projectId)) {
    const targetProjName = (input?.projectName ? String(input.projectName).trim() : '') || name
    const projProvisioned = await ensureOrProvisionProjexProject(reqCtx, organizationId, targetProjName, description, projexVisibility, explicitTplId, customCode, explicitProjMode === 'create')
    if (!projProvisioned.ok) return projProvisioned
    projectId = projProvisioned.projectId; customCode = projProvisioned.customCode; provisionedNewProject = true
  }
  const refId = formatYunxiaoRefId(organizationId, projectId)
  const projexUrl = buildAddress({ webBaseUrl: partial.webBaseUrl, organizationId, projectId, customCode }, { kind: 'project' }) ||
    (partial.webBaseUrl.replace(/\/+$/, '') + '/projex/project/' + encodeURIComponent(projectId))
  const commitHint = customCode
    ? {
        zh: '提示：在 Git 提交说明或合并请求中带上 ' + customCode + '-<编号> 即可自动关联云效工作项。',
        en: 'Tip: Include ' + customCode + '-<number> in commit messages or merge requests to auto-link Yunxiao work items.',
      }
    : undefined

  const persistConfigAndLearn = async (builtIdentity: CodeupRepositoryIdentity | null) => {
    if (!fs || typeof fs.writeText !== 'function') {
      return fail(ERROR_KIND.ENV as ErrorKind, 'initProject: 当前环境无法写入 docs/agents/yunxiao.yaml；为避免丢失坐标，已停止配置 origin 与推送', '')
    }
    try {
      const target = typeof fs.resolve === 'function' ? await fs.resolve(YUNXIAO_CONFIG_REL, cwd ? { cwd } : undefined) : (cwd ? cwd.replace(/\/+$/, '') + '/' : '') + YUNXIAO_CONFIG_REL
      const yamlContent = formatYunxiaoConfigYaml({
        organizationId, projectId, ...(customCode ? { customCode } : {}),
        ...(builtIdentity ? { repositoryId: String(builtIdentity.id) } : {}),
        ...(builtIdentity && namespaceId ? { namespaceId } : {}), ...(explicitTplId ? { templateId: explicitTplId } : {}),
        apiBaseUrl: partial.apiBaseUrl, webBaseUrl: partial.webBaseUrl,
      })
      await fs.writeText(target, yamlContent)
    } catch (error) {
      const failure = fail(ERROR_KIND.ENV as ErrorKind, 'initProject: 无法写入 docs/agents/yunxiao.yaml；为避免丢失坐标，已停止配置 origin 与推送', error instanceof Error ? error.message : String(error))
      const repoUrl = builtIdentity && (builtIdentity.webUrl || (builtIdentity.httpUrlToRepo || '').replace(/\.git$/i, '').replace(/\/+$/, ''))
      if (!failure.ok && repoUrl) (failure.error as TrackerError & { repoUrl?: string }).repoUrl = repoUrl
      return failure
    }
    learnYunxiaoContextFor(
      { cwd, refId },
      {
        organizationId, projectId, ...(customCode ? { customCode } : {}),
        apiBaseUrl: partial.apiBaseUrl, webBaseUrl: partial.webBaseUrl,
        ...(tokenRes.token ? { token: tokenRes.token } : {}),
        ...(builtIdentity ? { codeupRepo: builtIdentity } : {}),
        currentUser: { id: userId, name: userName, ...(lastOrganization ? { lastOrganization } : {}) },
      },
    )
    return null
  }

  if (repoMode === 'none') {
    const persistFailure = await persistConfigAndLearn(null)
    if (persistFailure) return persistFailure
    const extraUrls = [{ label: { zh: '打开 Yunxiao Projex 项目 ↗', en: 'Open Yunxiao Projex project ↗' }, url: projexUrl, primary: true }]
    return {
      ok: true,
      data: {
        backend: 'yunxiao', refId, name: (input?.projectName ? String(input.projectName).trim() : '') || name,
        url: projexUrl, projectUrl: projexUrl, ...(customCode ? { customCode } : {}), extraUrls, ...(commitHint ? { hint: commitHint } : {}),
      },
    }
  }

  let effectiveProtocol: 'https' | 'ssh' = requestedProtocol === 'ssh' ? 'ssh' : 'https'
  if (requestedProtocol === 'auto') {
    const sshOk = await probeCodeupSshConnectivity(execFn, cwd)
    effectiveProtocol = sshOk ? 'ssh' : 'https'
  }

  let built: { identity: CodeupRepositoryIdentity; cloneUrl: string; httpCloneUrl: string; sshCloneUrl: string } | null = null
  if (repoMode === 'bind-origin' || repoMode === 'bind' || repoMode === 'existing') {
    let lookupTarget = rawRepoIdInput
    if (!lookupTarget) {
      const originRes = await git(['remote', 'get-url', 'origin'], VC_READ_CMD_TIMEOUT_MS)
      const extraHosts = collectExtraHosts(reqCtx, partial.webBaseUrl, partial.apiBaseUrl)
      const parsedOrigin = originRes.code === 0 ? parseCodeupRemoteUrl(originRes.stdout, { extraHosts }) : null
      if (parsedOrigin) lookupTarget = parsedOrigin.fullPath
      else {
        const cand = await discoverCodeupCandidate(cwd, reqCtx, { webBaseUrl: partial.webBaseUrl, apiBaseUrl: partial.apiBaseUrl })
        if (cand) lookupTarget = cand.repoIdOrPath
      }
    }
    if (!lookupTarget) return fail(ERROR_KIND.PARSE as ErrorKind, 'initProject: 关联已有代码库模式必须提供目标 Codeup repositoryId', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
    const getRes = await requestCodeupRepositoryGet(reqCtx, organizationId, lookupTarget, GITLAB_READ_TIMEOUT_MS)
    if (!getRes.ok) return failYunxiao(getRes, getRes.stderr || getRes.stdout || 'initProject: 查询目标 Codeup 代码库失败', getRes, reqCtx)
    built = buildCodeupCloneTarget(getRes.data, null, effectiveProtocol)
    if (!built) return fail(ERROR_KIND.PARSE as ErrorKind, 'initProject: GetRepository 响应缺少有效的 id 或克隆地址', getRes.stdout)
    // Persist-Before-Push：在任何 git remote / git push 之前立即写入 docs/agents/yunxiao.yaml 并更新上下文
    const persistFailure = await persistConfigAndLearn(built.identity)
    if (persistFailure) return persistFailure
    if (repoMode !== 'bind-origin') {
      const probeTree = await git(['rev-parse', '--is-inside-work-tree'], VC_READ_CMD_TIMEOUT_MS)
      if (probeTree.code === 0) {
        const hasOrigin = (await git(['remote', 'get-url', 'origin'], VC_READ_CMD_TIMEOUT_MS)).code === 0
        await (hasOrigin ? git(['remote', 'set-url', 'origin', built.cloneUrl], VC_READ_CMD_TIMEOUT_MS) : git(['remote', 'add', 'origin', built.cloneUrl], VC_READ_CMD_TIMEOUT_MS))
        if (repoMode === 'existing') {
          const headRes = await git(['rev-parse', '--verify', 'HEAD'], VC_READ_CMD_TIMEOUT_MS)
          if (headRes.code === 0) {
            const pushRes = await git(['push', '-u', 'origin', 'HEAD'], VC_PUSH_TIMEOUT_MS)
            if (pushRes.code !== 0) return failYunxiao(pushRes, 'initProject: 已写入 docs/agents/yunxiao.yaml 并配置 origin，但 git push 失败，修复权限或网络后重推即可', pushRes, ctx)
          }
        }
      }
    }
  } else {
    const gitInit = await ensureLocalGitInitialized(git, cwd, userName, ctx, true)
    if (!gitInit.ok) return gitInit
    const createBody: YunxiaoCreateRepoBody = {
      name, path: name, visibility: codeupVisibility,
      ...(description ? { description } : {}), ...(namespaceId ? { namespaceId } : {}),
    }
    const createRes = await requestCodeupRepositoryCreate(reqCtx, organizationId, createBody, GITLAB_CREATE_PROJECT_TIMEOUT_MS)
    if (!createRes.ok) return failYunxiao(createRes, createRes.stderr || createRes.stdout || 'initProject: Codeup CreateRepository 创建远端代码库失败', createRes, reqCtx)
    const createdBag = asRecord(createRes.data), createdIdRaw = createdBag ? createdBag['id'] : undefined
    const createdId = typeof createdIdRaw === 'number' ? createdIdRaw : typeof createdIdRaw === 'string' && /^\d+$/.test(createdIdRaw.trim()) ? Number(createdIdRaw.trim()) : 0
    let getRepoData: unknown = null
    if (createdId > 0) {
      const getRes = await requestCodeupRepositoryGet(reqCtx, organizationId, createdId, GITLAB_READ_TIMEOUT_MS)
      if (getRes.ok) getRepoData = getRes.data
    }
    built = buildCodeupCloneTarget(getRepoData || createRes.data, createRes.data, effectiveProtocol)
    if (!built) return fail(ERROR_KIND.PARSE as ErrorKind, 'initProject: 远端 Codeup 代码库已创建，但响应缺少有效的 id、pathWithNamespace 或克隆地址', createRes.stdout)
    // Persist-Before-Push：远端确认后、执行 git remote 与 git push 之前立即写入 docs/agents/yunxiao.yaml
    const persistFailure = await persistConfigAndLearn(built.identity)
    if (persistFailure) return persistFailure
    const hasOrigin = (await git(['remote', 'get-url', 'origin'], VC_READ_CMD_TIMEOUT_MS)).code === 0
    const wireRes = hasOrigin ? await git(['remote', 'set-url', 'origin', built.cloneUrl], VC_READ_CMD_TIMEOUT_MS) : await git(['remote', 'add', 'origin', built.cloneUrl], VC_READ_CMD_TIMEOUT_MS)
    if (wireRes.code !== 0) return failYunxiao(wireRes, 'initProject: 远端代码库已创建且坐标已保存，但配置 origin 失败，本地提交仍在', wireRes, ctx)
    let pushRes = await git(['push', '-u', 'origin', 'HEAD'], VC_PUSH_TIMEOUT_MS)
    const sshPushAuthFailed = /permission denied|publickey|authentication failed|authorization failed|invalid credentials|could not read username/i.test(pushRes.stderr + ' ' + pushRes.stdout)
    if (pushRes.code !== 0 && sshPushAuthFailed && requestedProtocol === 'auto' && effectiveProtocol === 'ssh' && built.httpCloneUrl && built.httpCloneUrl !== built.cloneUrl) {
      await git(['remote', 'set-url', 'origin', built.httpCloneUrl], VC_READ_CMD_TIMEOUT_MS)
      pushRes = await git(['push', '-u', 'origin', 'HEAD'], VC_PUSH_TIMEOUT_MS)
    }
    if (pushRes.code !== 0) {
      const codeupUrlFail = built.identity.webUrl || built.httpCloneUrl.replace(/\.git$/i, '').replace(/\/+$/, '')
      const failOut = failYunxiao(pushRes, 'initProject: 远端代码库已创建且已写入 docs/agents/yunxiao.yaml，但 git push 失败，可一键重试推送', pushRes, ctx)
      if (!failOut.ok && codeupUrlFail) (failOut.error as TrackerError & { repoUrl?: string }).repoUrl = codeupUrlFail
      return failOut
    }
  }

  const codeupUrl = built.identity.webUrl || built.httpCloneUrl.replace(/\.git$/i, '').replace(/\/+$/, '')
  const extraUrls = [
    { label: { zh: '打开 Yunxiao Projex 项目 ↗', en: 'Open Yunxiao Projex project ↗' }, url: projexUrl, primary: true },
    { label: { zh: '打开 Codeup 代码库 ↗', en: 'Open Codeup repository ↗' }, url: codeupUrl },
  ]
  return {
    ok: true,
    data: {
      backend: 'yunxiao', refId, name: built.identity.pathWithNamespace || name,
      url: codeupUrl, projectUrl: projexUrl, repoUrl: codeupUrl,
      ...(customCode ? { customCode } : {}), extraUrls, ...(commitHint ? { hint: commitHint } : {}),
    },
  }
}

export default initProject
