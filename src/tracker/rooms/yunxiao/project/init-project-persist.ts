/**
 * src/tracker/rooms/yunxiao/project/init-project-persist.ts —— 云效置备坐标读取、先落盘后推送（Persist-Before-Push）、偏好记忆与双深链信封组装（规格 #21 / #24）。
 *
 * 为什么拆分为独立模块：
 *   1. 将文件/环境坐标预读取、docs/agents/yunxiao.yaml 持久化、新建项目后的偏好记忆与半成功重推元数据收敛到一处，
 *      确保 discover.ts、init-project.ts 与本文件全部严格低于 250 有效行；
 *   2. 严格区分「首次 git push 失败可一键重推（retryablePush: true）」与「写盘或 git remote 绑定失败不可重推（retryablePush: false）」。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { OpContext, RepoHandle, SandboxFs } from '../../../contract/contexts.js'
import type { OpResult, TrackerError } from '../../../contract/results.js'
import { fail } from '../../../kernel/preflight.js'
import {
  getLearnedYunxiaoContext, learnYunxiaoContextFor, parseYunxiaoRefId, type CodeupRepositoryIdentity,
} from '../model/repo-identity.js'
import {
  DEFAULT_YUNXIAO_API_BASE_URL, DEFAULT_YUNXIAO_WEB_BASE_URL, YUNXIAO_CONFIG_REL,
  formatYunxiaoConfigYaml, resolveYunxiaoCoordinates,
} from '../model/workspace-config.js'
import { buildAddress } from '../room/links.js'
import { emitReadDegraded } from '../support/read-log.js'

/** 置备前从本地文件、环境变量与内存上下文收集到的存量坐标摘要（允许缺省，未配置时由向导或平台用户接口补齐）。 */
export interface PartialInitCoords {
  organizationId: string; projectId: string; customCode: string; namespaceId?: number
  templateId?: string; apiBaseUrl: string; webBaseUrl: string; hadValidFileCoords: boolean
}

/** 带有云效半成功重推与双深链上下文的扩展错误形状。 */
export type YunxiaoInitTrackerError = TrackerError & {
  retryablePush?: boolean
  repoUrl?: string
  projectUrl?: string
  customCode?: string
  extraUrls?: Array<{ label: { zh: string; en: string }; url: string; primary?: boolean }>
  hint?: { zh: string; en: string }
}

/** 解析发现接口运行所需的环境变量、工作区文件服务、主目录与子进程端口。 */
export async function resolveDiscoverRuntime(input: { cwd?: string; deps?: any }) {
  const deps = input.deps || {}
  let plat: any = deps.platform || null
  if (!plat && typeof deps.getPlatform === 'function') { try { plat = await deps.getPlatform() } catch { plat = null } }
  const envObj = deps.env || (plat && plat.env) || null
  const env = {
    get: (k: string): string | undefined => (envObj && typeof envObj.get === 'function' ? envObj.get(k) : undefined),
    has: (k: string): boolean => (envObj && typeof envObj.get === 'function' ? envObj.get(k) !== undefined : false),
  }
  const wsFs = deps.workspaceFs || (plat && plat.fs) || null
  let home = String(deps.homeDir || '').trim()
  if (!home && typeof deps.getHome === 'function') { try { home = String((await deps.getHome()) || '').trim() } catch { home = '' } }
  if (!home && plat && typeof plat.getHome === 'function') { try { home = String((await plat.getHome()) || '').trim() } catch { home = '' } }
  if (!home) home = String(env.get('HOME') || env.get('USERPROFILE') || '').trim()
  const execFn = typeof deps.exec === 'function' ? deps.exec : (plat && typeof plat.exec === 'function' ? plat.exec.bind(plat) : null)
  const prefOrgId = String(deps.lastSelectedOrganizationId || '').trim()
  return { env, wsFs, home, plat, execFn, fetchFn: deps.fetch, prefOrgId }
}

/** 读取当前工作区已有的云效组织与项目坐标，区分「尚未配置（允许继续新建）」与「格式损坏或内联密钥（立即报错拒绝）」。 */
export async function readPartialInitCoords(
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

/** 在新建 Yunxiao Projex 项目成功后，将所选组织 ID 记入 ~/.config/yunxiao/preferences.json；写入异常记入结构化降级日志，不阻断主流程。 */
export async function savePreferredYunxiaoOrganization(
  organizationId: string,
  opts?: { homeDir?: string; fs?: SandboxFs | null; ctx?: Partial<OpContext> | null },
): Promise<void> {
  const orgId = String(organizationId || '').trim()
  const home = String(opts?.homeDir || '').trim()
  const fs = opts?.fs || null
  if (!orgId || !home || !fs || typeof fs.writeText !== 'function') return
  const t0 = Date.now()
  const payload = JSON.stringify({ lastSelectedOrganizationId: orgId }, null, 2) + '\n'
  const prefRel = home.replace(/[\\/]+$/, '') + '/.config/yunxiao/preferences.json'
  try {
    const target = typeof fs.resolve === 'function' ? await fs.resolve(prefRel) : prefRel
    await fs.writeText(target, payload)
  } catch {
    emitReadDegraded(opts?.ctx || null, 'coordinates', 'coordinates:pref-write-fail', Date.now() - t0, 'env')
  }
}

/** 构造 Yunxiao Projex 项目深链、可选 Codeup 代码库深链与提交自动关联提示语。 */
export function buildYunxiaoLinksAndHint(params: {
  webBaseUrl: string; organizationId: string; projectId: string; customCode: string; codeupUrl?: string
}) {
  const projexUrl = buildAddress(
    { webBaseUrl: params.webBaseUrl, organizationId: params.organizationId, projectId: params.projectId, customCode: params.customCode },
    { kind: 'project' },
  ) || (params.webBaseUrl.replace(/\/+$/, '') + '/projex/project/' + encodeURIComponent(params.projectId))
  const commitHint = params.customCode
    ? {
        zh: '提示：在 Git 提交说明或合并请求中带上 ' + params.customCode + '-<编号> 即可自动关联云效工作项。',
        en: 'Tip: Include ' + params.customCode + '-<number> in commit messages or merge requests to auto-link Yunxiao work items.',
      }
    : undefined
  const extraUrls: Array<{ label: { zh: string; en: string }; url: string; primary?: boolean }> = [
    { label: { zh: '打开 Yunxiao Projex 项目 ↗', en: 'Open Yunxiao Projex project ↗' }, url: projexUrl, primary: true },
  ]
  if (params.codeupUrl) {
    extraUrls.push({ label: { zh: '打开 Codeup 代码库 ↗', en: 'Open Codeup repository ↗' }, url: params.codeupUrl })
  }
  return { projexUrl, commitHint, extraUrls }
}

/** 在首次推送失败的错误对象上附加 retryablePush:true 与完整双深链/提示元数据，供一键重试推送成功后原样恢复成功弹窗。 */
export function attachYunxiaoPushRetryMeta<T>(
  failResult: OpResult<T>,
  meta: { webBaseUrl: string; organizationId: string; projectId: string; customCode: string; repoUrl: string },
): OpResult<T> {
  if (!failResult.ok) {
    const builtLinks = buildYunxiaoLinksAndHint({
      webBaseUrl: meta.webBaseUrl,
      organizationId: meta.organizationId,
      projectId: meta.projectId,
      customCode: meta.customCode,
      codeupUrl: meta.repoUrl,
    })
    const err = failResult.error as YunxiaoInitTrackerError
    err.retryablePush = true
    if (meta.repoUrl) err.repoUrl = meta.repoUrl
    err.projectUrl = builtLinks.projexUrl
    if (meta.customCode) err.customCode = meta.customCode
    err.extraUrls = builtLinks.extraUrls
    if (builtLinks.commitHint) err.hint = builtLinks.commitHint
  }
  return failResult
}

/** 执行 Persist-Before-Push：写入 docs/agents/yunxiao.yaml、按需记忆新建项目的组织偏好，并刷新内存上下文。 */
export async function persistYunxiaoWorkspaceState(params: {
  cwd: string; refId: string; fs: SandboxFs | null; homeDirRaw?: string; ctx: OpContext
  organizationId: string; projectId: string; customCode: string; namespaceId?: number; templateId?: string
  apiBaseUrl: string; webBaseUrl: string; token: string; provisionedNewProject: boolean
  repoMode: 'none' | 'bind' | 'bind-origin' | 'existing' | 'create'
  builtIdentity: CodeupRepositoryIdentity | null
  currentUser: { id: string; name: string; lastOrganization?: string }
}): Promise<OpResult<never> | null> {
  const { fs, cwd, builtIdentity, organizationId, projectId, customCode } = params
  if (!fs || typeof fs.writeText !== 'function') {
    const noFsFail = fail(ERROR_KIND.ENV as ErrorKind, 'initProject: 当前环境无法写入 docs/agents/yunxiao.yaml；为避免丢失坐标，已停止配置 origin 与推送', '')
    if (!noFsFail.ok) (noFsFail.error as YunxiaoInitTrackerError).retryablePush = false
    return noFsFail
  }
  try {
    const target = typeof fs.resolve === 'function' ? await fs.resolve(YUNXIAO_CONFIG_REL, cwd ? { cwd } : undefined) : (cwd ? cwd.replace(/\/+$/, '') + '/' : '') + YUNXIAO_CONFIG_REL
    const yamlContent = formatYunxiaoConfigYaml({
      organizationId, projectId, ...(customCode ? { customCode } : {}),
      ...(builtIdentity ? { repositoryId: String(builtIdentity.id) } : {}),
      ...(builtIdentity && params.namespaceId ? { namespaceId: params.namespaceId } : {}),
      ...(params.templateId ? { templateId: params.templateId } : {}),
      apiBaseUrl: params.apiBaseUrl, webBaseUrl: params.webBaseUrl,
    })
    await fs.writeText(target, yamlContent)
  } catch (error) {
    const writeFailure = fail(ERROR_KIND.ENV as ErrorKind, 'initProject: 无法写入 docs/agents/yunxiao.yaml；为避免丢失坐标，已停止配置 origin 与推送', error instanceof Error ? error.message : String(error))
    if (!writeFailure.ok) {
      const err = writeFailure.error as YunxiaoInitTrackerError
      err.retryablePush = false
      if (params.repoMode === 'create' && builtIdentity) {
        const repoUrl = builtIdentity.webUrl || (builtIdentity.httpUrlToRepo || '').replace(/\.git$/i, '').replace(/\/+$/, '')
        if (repoUrl) err.repoUrl = repoUrl
      }
    }
    return writeFailure
  }
  if (params.provisionedNewProject) {
    await savePreferredYunxiaoOrganization(organizationId, { homeDir: params.homeDirRaw, fs, ctx: params.ctx })
  }
  learnYunxiaoContextFor(
    { cwd, refId: params.refId },
    {
      organizationId, projectId, ...(customCode ? { customCode } : {}),
      apiBaseUrl: params.apiBaseUrl, webBaseUrl: params.webBaseUrl,
      ...(params.token ? { token: params.token } : {}),
      ...(builtIdentity ? { codeupRepo: builtIdentity } : {}),
      currentUser: params.currentUser,
    },
  )
  return null
}
