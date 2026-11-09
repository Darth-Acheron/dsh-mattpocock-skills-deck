/**
 * src/tracker/rooms/yunxiao/project/init-project.ts —— Codeup 工作区一键开仓发布路由（规格 #04）。
 *
 * 为什么需要这套开仓发布流程：
 *   1. 对齐 GitHub 与 GitLab 房间的 initProject 契约：先校验仓库名、本地环境与云效认证，再改动工作区，
 *      避免在未配置坐标或令牌无效时污染本地 Git 提交记录。
 *   2. 动手修改工作区前先执行 Git 属主可用性检查（#994），若检测到 dubious ownership 则自动补充
 *      `git config --global --add safe.directory <dir>` 自愈一次。
 *   3. Codeup 企业代码库的 CreateRepository 接口可见性枚举仅支持 `"private"`（私有）与 `"internal"`（企业内公开），
 *      因此将 `InitProjectInput.visibility === "public"` 映射为 `"internal"`，其余映射为 `"private"`，
 *      支持从工作区配置或环境变量透传可选 `namespaceId`（父代码组 ID），且不传 `readMeType: "USER_GUIDE"`，
 *      防止远端自动生成初始引导提交与本地首提交产生 non-fast-forward 推送冲突。
 *   4. CreateRepository 成功后用返回的 `id` 调用 `GetRepository` 回查权威克隆地址，配置 `origin` 并推送 `HEAD`，
 *      最后将新建的权威 `CodeupRepositoryIdentity` 写入 `learnedYunxiaoContext`。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { OpContext, RepoHandle } from '../../../contract/contexts.js'
import type { RepositoryRef } from '../../../contract/entities.js'
import type { InitProjectInput } from '../../../contract/inputs.js'
import { TRACKER_ERROR_STAGE, type OpResult } from '../../../contract/results.js'
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
import { DEFAULT_YUNXIAO_WEB_BASE_URL, loadYunxiaoToken, resolveYunxiaoCoordinates } from '../model/workspace-config.js'
import {
  requestCodeupRepositoryCreate, requestCodeupRepositoryGet, requestPlatformUser, type YunxiaoCreateRepoBody,
} from '../requests.js'

interface ProcResult { code: number; stdout: string; stderr: string }

function toProc(raw: unknown): ProcResult {
  const bag = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const stdout = typeof bag['stdout'] === 'string' ? bag['stdout'] : typeof bag['text'] === 'string' ? bag['text'] : typeof bag['out'] === 'string' ? bag['out'] : ''
  const stderr = typeof bag['stderr'] === 'string' ? bag['stderr'] : typeof bag['error'] === 'string' ? bag['error'] : ''
  const code = typeof bag['code'] === 'number' ? bag['code'] : typeof bag['ok'] === 'boolean' ? (bag['ok'] ? 0 : 1) : 0
  return { code, stdout, stderr }
}

/** 解析当前工作区的云效组织、项目与可选 namespaceId 坐标。 */
async function resolveInitCoordinates(
  handle: RepoHandle, ctx: OpContext,
): Promise<{ ok: true; organizationId: string; projectId: string; namespaceId?: number; webBaseUrl: string; refId: string } | { ok: false; message: string; raw: string }> {
  const cwd = String((handle && handle.cwd) || (ctx && ctx.cwd) || '').trim()
  const platform = ctx && ctx.platform ? ctx.platform : null
  const fs = (platform && platform.fs) || (ctx && ctx.fs) || null
  const env = (platform && platform.env) || null
  const coordsRes = await resolveYunxiaoCoordinates({ cwd, fs, env })
  if (coordsRes.ok) {
    const v = coordsRes.value
    return {
      ok: true, organizationId: v.organizationId, projectId: v.projectId,
      ...(v.namespaceId ? { namespaceId: v.namespaceId } : {}),
      webBaseUrl: v.webBaseUrl, refId: formatYunxiaoRefId(v.organizationId, v.projectId),
    }
  }
  const fromHandle = parseYunxiaoRefId(handle?.refId)
  const learned = (cwd ? getLearnedYunxiaoContext(cwd) : null) || (handle?.refId ? getLearnedYunxiaoContext(handle.refId) : null)
  const organizationId = fromHandle?.organizationId || learned?.organizationId || ''
  const projectId = fromHandle?.projectId || learned?.projectId || ''
  if (organizationId && projectId) {
    return {
      ok: true, organizationId, projectId,
      webBaseUrl: learned?.webBaseUrl || DEFAULT_YUNXIAO_WEB_BASE_URL,
      refId: formatYunxiaoRefId(organizationId, projectId),
    }
  }
  return { ok: false, message: coordsRes.message || 'initProject: 未配置云效 organizationId 与 projectId', raw: JSON.stringify(coordsRes) }
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

/** 初始化本地工作区并一键在云效 Codeup 创建远端代码库、配置 origin 并推送 HEAD（契约操作 initProject）。 */
export async function initProject(handle: RepoHandle, input: InitProjectInput, ctx: OpContext): Promise<OpResult<RepositoryRef>> {
  const cwd = String((handle && typeof handle.cwd === 'string' && handle.cwd) || (ctx && ctx.cwd) || '').trim()
  const name = input && typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) return fail(ERROR_KIND.PARSE as ErrorKind, 'initProject: 仓库名不能为空', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.length > 100) {
    return fail(ERROR_KIND.PARSE as ErrorKind, 'initProject: 仓库名只支持字母、数字、点、下划线、连字符，最长 100 个字符', String(input.name), TRACKER_ERROR_STAGE.INPUT_REFUSED)
  }
  const description = input && typeof (input as { description?: unknown }).description === 'string' ? String((input as { description?: unknown }).description).trim() : ''
  const codeupVisibility: 'private' | 'internal' = input && input.visibility === 'public' ? 'internal' : 'private'
  const platform = ctx && ctx.platform ? ctx.platform : null
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

  const coords = await resolveInitCoordinates(handle, ctx)
  if (!coords.ok) return fail(ERROR_KIND.ENV as ErrorKind, coords.message, coords.raw)

  const homeDirRaw = platform && typeof (platform as unknown as { homeDir?: unknown }).homeDir === 'string' ? (platform as unknown as { homeDir: string }).homeDir : undefined
  const tokenRes = await loadYunxiaoToken({
    fs: (platform && platform.fs) || (ctx && ctx.fs) || null,
    env: (platform && platform.env) || null,
    homeDir: homeDirRaw,
  })
  if (!tokenRes.token && typeof (ctx as YunxiaoCtx)?.fetch !== 'function') {
    return fail(ERROR_KIND.AUTH as ErrorKind, 'initProject: 未检测到云效个人访问令牌（请配置环境变量 YUNXIAO_TOKEN 或 ~/.config/yunxiao/token）', '')
  }

  const userRes = await requestPlatformUser(ctx as YunxiaoCtx, GITLAB_READ_TIMEOUT_MS)
  if (!userRes.ok) return failYunxiao(userRes, userRes.stderr || userRes.stdout || 'initProject: 云效当前用户认证失败', userRes, ctx)
  const userBag = asRecord(userRes.data)
  const userId = userBag && typeof userBag['id'] === 'string' ? userBag['id'].trim() : ''
  const userName = userBag && typeof userBag['name'] === 'string' ? userBag['name'].trim() : userId
  if (!userId) return fail(ERROR_KIND.PARSE as ErrorKind, 'initProject: 平台用户响应缺少有效的 id 字段', userRes.stdout)

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
    ...(coords.namespaceId ? { namespaceId: coords.namespaceId } : {}),
  }
  const createRes = await requestCodeupRepositoryCreate(ctx as YunxiaoCtx, coords.organizationId, createBody, GITLAB_CREATE_PROJECT_TIMEOUT_MS)
  if (!createRes.ok) return failYunxiao(createRes, createRes.stderr || createRes.stdout || 'initProject: Codeup CreateRepository 创建远端代码库失败', createRes, ctx)

  const createdBag = asRecord(createRes.data)
  const createdIdRaw = createdBag ? createdBag['id'] : undefined
  const createdId = typeof createdIdRaw === 'number' ? createdIdRaw : typeof createdIdRaw === 'string' && /^\d+$/.test(createdIdRaw.trim()) ? Number(createdIdRaw.trim()) : 0
  let getRepoData: unknown = null
  if (createdId > 0) {
    const getRes = await requestCodeupRepositoryGet(ctx as YunxiaoCtx, coords.organizationId, createdId, GITLAB_READ_TIMEOUT_MS)
    if (getRes.ok) getRepoData = getRes.data
  }

  const built = buildCreatedRepoIdentity(createRes.data, getRepoData)
  if (!built) return fail(ERROR_KIND.PARSE as ErrorKind, 'initProject: 远端 Codeup 代码库已创建，但响应缺少有效的 id、pathWithNamespace 或克隆地址', createRes.stdout)

  const hasOrigin = (await git(['remote', 'get-url', 'origin'], VC_READ_CMD_TIMEOUT_MS)).code === 0
  const wireRes = hasOrigin ? await git(['remote', 'set-url', 'origin', built.cloneUrl], VC_READ_CMD_TIMEOUT_MS) : await git(['remote', 'add', 'origin', built.cloneUrl], VC_READ_CMD_TIMEOUT_MS)
  if (wireRes.code !== 0) return failYunxiao(wireRes, 'initProject: 远端代码库已创建，但配置 origin 失败，本地提交仍在', wireRes, ctx)

  const pushRes = await git(['push', '-u', 'origin', 'HEAD'], VC_PUSH_TIMEOUT_MS)
  if (pushRes.code !== 0) return failYunxiao(pushRes, 'initProject: 远端代码库已创建且已配置 origin，但 git push 失败，修复权限或网络后重推即可', pushRes, ctx)

  learnYunxiaoContextFor(
    { cwd, refId: coords.refId },
    { organizationId: coords.organizationId, projectId: coords.projectId, webBaseUrl: coords.webBaseUrl, codeupRepo: built.identity, currentUser: { id: userId, name: userName } },
  )
  const repoUrl = built.identity.webUrl || built.cloneUrl.replace(/\.git$/i, '').replace(/\/+$/, '')
  return { ok: true, data: { backend: 'yunxiao', refId: coords.refId, name: built.identity.pathWithNamespace || name, url: repoUrl } }
}

export default initProject
