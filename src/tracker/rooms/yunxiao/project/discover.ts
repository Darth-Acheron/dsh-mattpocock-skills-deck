/**
 * src/tracker/rooms/yunxiao/project/discover.ts —— 云效组织、Yunxiao Projex 项目、MattDemo 错位纠偏与 Codeup 双源命名空间发现（规格 #21 / #24）。
 *
 * 为什么独立成文件：
 *   1. 严格通过房间请求边界（../requests.ts）调用云效 REST API，并经 src/tracker/registry/builtins.ts
 *      的 loadYunxiaoHostExtras() 暴露给宿主 wf.yunxiaoDiscover，遵守 rooms-imported-only-by-assembly；
 *   2. 与 init-project-helpers.ts 拆开后，保持单文件低于 250 有效行。
 */

import { GITLAB_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import type { YunxiaoCtx } from '../client.js'
import { asRecord } from '../errors.js'
import { normalizeCodeupRepositoryIdentity, parseCodeupRemoteUrl, type CodeupRepositoryIdentity } from '../model/repo-identity.js'
import {
  DEFAULT_YUNXIAO_API_BASE_URL, DEFAULT_YUNXIAO_WEB_BASE_URL,
  deriveProjectCustomCode, isValidOrganizationId, isValidProjectId, loadYunxiaoToken,
  readYunxiaoFileDoc, resolveYunxiaoBaseUrls,
} from '../model/workspace-config.js'
import { probeYunxiaoPlatformUser } from '../repo/current-user.js'
import { collectExtraHosts } from '../repo/identity.js'
import {
  requestCodeupNamespacesList, requestCodeupRepositoriesList, requestCodeupRepositoryGet,
  requestPlatformOrganizations, requestProjectGet, requestProjectsSearch, requestProjectTemplatesList,
} from '../requests.js'
import {
  aggregateCodeupNamespaces, basenameOfCwd, pickDefaultProjectTemplateId,
  probeCodeupSshConnectivity, readLocalOriginUrl,
} from './init-project-helpers.js'

export { aggregateCodeupNamespaces, basenameOfCwd, buildCodeupCloneTarget, pickDefaultProjectTemplateId } from './init-project-helpers.js'

export interface BilingualOption { value: string; label: { zh: string; en: string } }
export interface DiscoverFieldBanner { kind: 'warning' | 'info'; level: 'warn' | 'info'; text: { zh: string; en: string } }
export interface YunxiaoDiscoverResult {
  ok: true; authenticated: boolean; initialStepIndex: 0 | 1 | 2
  user?: { id: string; name: string; login: string; lastOrganization?: string }
  optionsByField: Record<string, BilingualOption[]>
  defaultsByField: Record<string, string>
  bannersByField: Record<string, DiscoverFieldBanner>
  projectMismatchBanner?: DiscoverFieldBanner
}

async function resolveDiscoverRuntime(input: { cwd?: string; deps?: any }) {
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

const unauthedResult = (): YunxiaoDiscoverResult => ({
  ok: true, authenticated: false, initialStepIndex: 0, optionsByField: {}, defaultsByField: {}, bannersByField: {},
})

/** 发现当前工作区的云效组织、Yunxiao Projex 项目（含 MattDemo 错位预警与自动纠偏）、项目模板与 Codeup 代码库/命名空间（wf.yunxiaoDiscover）。 */
export async function discoverYunxiaoWorkspace(input: {
  cwd?: string; organizationId?: string; projectId?: string; lastSelectedOrganizationId?: string; deps?: any
}): Promise<YunxiaoDiscoverResult> {
  const cwd = String(input.cwd || input.deps?.DEFAULT_CWD || '').trim()
  const { env, wsFs, home, plat, execFn, fetchFn, prefOrgId: depPrefOrgId } = await resolveDiscoverRuntime(input)
  const prefOrgId = String(input.lastSelectedOrganizationId || depPrefOrgId || '').trim()
  const baseUrlsRes = await resolveYunxiaoBaseUrls({ cwd, fs: wsFs, env })
  const apiBaseUrl = baseUrlsRes.ok ? baseUrlsRes.value.apiBaseUrl : DEFAULT_YUNXIAO_API_BASE_URL
  const webBaseUrl = baseUrlsRes.ok ? baseUrlsRes.value.webBaseUrl : DEFAULT_YUNXIAO_WEB_BASE_URL

  const tokRes = await loadYunxiaoToken({ env, fs: wsFs, homeDir: home, platform: (plat || { env, fs: wsFs, getHome: async () => home }) as any })
  if (!tokRes.token && typeof fetchFn !== 'function') return unauthedResult()

  const reqCtx: YunxiaoCtx = {
    cwd, apiBaseUrl, ...(tokRes.token ? { token: tokRes.token } : {}),
    ...(typeof fetchFn === 'function' ? { fetch: fetchFn } : {}), platform: { fs: wsFs, env } as any,
  }
  const probeRes = await probeYunxiaoPlatformUser(reqCtx, GITLAB_READ_TIMEOUT_MS, { cwd, apiBaseUrl, token: tokRes.token })
  if (!probeRes.ok) return unauthedResult()

  const fileDocRes = await readYunxiaoFileDoc({ cwd, fs: wsFs })
  const fileDoc = fileDocRes.ok ? fileDocRes.doc : {}
  const readField = (envKey: string, docKey: string): string => {
    const ev = env.get(envKey)
    if (typeof ev === 'string' && ev.trim()) return ev.trim()
    const dv = fileDoc[docKey]
    return dv != null && String(dv).trim() ? String(dv).trim() : ''
  }
  const fileOrgId = readField('YUNXIAO_ORGANIZATION_ID', 'organizationId')
  const fileProjectId = readField('YUNXIAO_PROJECT_ID', 'projectId')
  const fileRepoId = readField('YUNXIAO_REPOSITORY_ID', 'repositoryId')
  const fileNsRaw = readField('YUNXIAO_NAMESPACE_ID', 'namespaceId')
  const fileTplId = readField('YUNXIAO_TEMPLATE_ID', 'templateId')

  const repoSlug = basenameOfCwd(cwd)
  const extraHosts = collectExtraHosts(reqCtx, webBaseUrl, apiBaseUrl)
  const originUrl = await readLocalOriginUrl(cwd, wsFs, execFn)
  const originParsed = originUrl ? parseCodeupRemoteUrl(originUrl, { extraHosts }) : null
  const remoteSlug = originParsed ? originParsed.name : ''
  const targetSlug = remoteSlug || repoSlug

  const optionsByField: Record<string, BilingualOption[]> = {}
  const defaultsByField: Record<string, string> = {}
  const bannersByField: Record<string, DiscoverFieldBanner> = {}

  const orgsRes = await requestPlatformOrganizations(reqCtx, GITLAB_READ_TIMEOUT_MS)
  const rawOrgs = orgsRes.ok && Array.isArray(orgsRes.data) ? (orgsRes.data as Record<string, unknown>[]) : []
  const orgs = rawOrgs.map((o) => ({ id: String(o?.['id'] || o?.['organizationId'] || '').trim(), name: String(o?.['name'] || o?.['organizationName'] || '').trim() })).filter((o) => Boolean(o.id))

  const reqOrgId = String(input.organizationId || '').trim()
  // 组织预选优先级：显式切换参数 > 当前工作区配置 > ~/.config/yunxiao/preferences.json#lastSelectedOrganizationId > user.lastOrganization > 列表首项
  const activeOrgId =
    (reqOrgId && isValidOrganizationId(reqOrgId, apiBaseUrl) ? reqOrgId : '') ||
    (fileOrgId && isValidOrganizationId(fileOrgId, apiBaseUrl) ? fileOrgId : '') ||
    (prefOrgId && isValidOrganizationId(prefOrgId, apiBaseUrl) ? prefOrgId : '') ||
    (probeRes.user.lastOrganization && isValidOrganizationId(probeRes.user.lastOrganization, apiBaseUrl) ? probeRes.user.lastOrganization : '') ||
    orgs[0]?.id || reqOrgId || fileOrgId || prefOrgId || probeRes.user.lastOrganization || ''

  // 组织列表拿不到时（典型是令牌没勾「组织：只读」→ HTTP 403），不能空着，也不能报错打断向导：
  // 降级成「当前活跃企业」这一项，让第 2 步的单项只读锁定照常成立。
  if (activeOrgId && !orgs.some((o) => o.id === activeOrgId)) {
    orgs.unshift({ id: activeOrgId, name: orgsRes.ok ? activeOrgId : '当前活跃企业' })
  }
  optionsByField['organizationId'] = orgs.map((o) => { const lbl = o.name && o.name !== o.id ? o.name + ' (' + o.id + ')' : o.id; return { value: o.id, label: { zh: lbl, en: lbl } } })
  if (activeOrgId) defaultsByField['organizationId'] = activeOrgId

  const userOut = {
    id: probeRes.user.id, name: probeRes.user.name, login: probeRes.user.login,
    ...(probeRes.user.lastOrganization ? { lastOrganization: probeRes.user.lastOrganization } : {}),
  }
  if (!activeOrgId) return { ok: true, authenticated: true, initialStepIndex: 1, user: userOut, optionsByField, defaultsByField, bannersByField }

  const [projRes, tplRes, reposRes, nsRes, sshOk] = await Promise.all([
    requestProjectsSearch(reqCtx, activeOrgId, { conditions: '', page: 1, perPage: 50 }, GITLAB_READ_TIMEOUT_MS),
    requestProjectTemplatesList(reqCtx, activeOrgId, GITLAB_READ_TIMEOUT_MS),
    requestCodeupRepositoriesList(reqCtx, activeOrgId, 'page=1&perPage=50', GITLAB_READ_TIMEOUT_MS),
    requestCodeupNamespacesList(reqCtx, activeOrgId, 'page=1&perPage=50', GITLAB_READ_TIMEOUT_MS),
    probeCodeupSshConnectivity(execFn, cwd),
  ])

  const rawProjects = projRes.ok && Array.isArray(projRes.data) ? (projRes.data as Record<string, unknown>[]) : []
  const projects = rawProjects.filter((p) => p && typeof p['id'] === 'string' && p['logicalStatus'] !== 'DELETED').map((p) => ({
    id: String(p['id']).trim(), name: String(p['name'] || p['id']).trim(), customCode: String(p['customCode'] || '').trim(),
  }))

  const targetProjectsId = String(input.projectId || fileProjectId || '').trim()
  let configuredProj = targetProjectsId ? projects.find((p) => p.id === targetProjectsId) || null : null
  let configuredProjUnreachable = false
  if (targetProjectsId && isValidProjectId(targetProjectsId)) {
    const singleProj = await requestProjectGet(reqCtx, activeOrgId, targetProjectsId, GITLAB_READ_TIMEOUT_MS)
    const b = asRecord(singleProj.data)
    if (singleProj.ok && b && typeof b['id'] === 'string' && b['logicalStatus'] !== 'DELETED') {
      configuredProj = { id: String(b['id']).trim(), name: String(b['name'] || b['id']).trim(), customCode: String(b['customCode'] || '').trim() }
      if (!projects.some((p) => p.id === targetProjectsId)) projects.unshift(configuredProj)
    } else {
      configuredProjUnreachable = true
    }
  }

  optionsByField['projectId'] = projects.map((p) => {
    const text = p.customCode ? p.name + ' (' + p.customCode + ')' : p.name + ' (' + p.id + ')'
    return { value: p.id, label: { zh: text, en: text } }
  })

  const rawTemplates = tplRes.ok && Array.isArray(tplRes.data) ? (tplRes.data as Record<string, unknown>[]) : []
  optionsByField['templateId'] = rawTemplates.filter((t) => t && typeof t['id'] === 'string').map((t) => {
    const id = String(t['id']).trim(), name = String(t['name'] || id).trim()
    return { value: id, label: { zh: name, en: name } }
  })
  const defaultTplId = fileTplId || pickDefaultProjectTemplateId(rawTemplates)
  if (defaultTplId) defaultsByField['templateId'] = defaultTplId

  const slugCandidates = [targetSlug, repoSlug, remoteSlug].map((s) => s.trim().toLowerCase()).filter(Boolean)
  const matchesSlug = (p: { name: string; customCode: string }) => slugCandidates.some((s) => p.name.toLowerCase() === s || p.customCode.toLowerCase() === s)
  const matchedProj = slugCandidates.length > 0 ? projects.find(matchesSlug) || null : null

  let hasProjectMismatch = false
  let projectMismatchBanner: DiscoverFieldBanner | undefined
  const effectiveConfiguredId = fileProjectId && isValidProjectId(fileProjectId) ? fileProjectId : ''
  if (effectiveConfiguredId && (configuredProjUnreachable || configuredProj)) {
    const isDemoName = configuredProj ? /mattdemo|sandbox|示例|demo/i.test(configuredProj.name) : false
    const alignedWithWorkspace = configuredProj ? (slugCandidates.length === 0 ? !isDemoName : matchesSlug(configuredProj)) : false
    if (configuredProjUnreachable || !alignedWithWorkspace) {
      hasProjectMismatch = true
      const slugDisp = targetSlug || repoSlug || '当前工作区'
      const oldDesc = configuredProj ? (configuredProj.name + ' (' + configuredProj.id + ')') : effectiveConfiguredId
      if (matchedProj && (!configuredProj || matchedProj.id !== configuredProj.id)) {
        const warnBanner: DiscoverFieldBanner = {
          kind: 'warning', level: 'warn',
          text: {
            zh: '检测到 docs/agents/yunxiao.yaml 当前指向项目「' + oldDesc + '」，与当前工作区「' + slugDisp + '」不一致或不可达；已自动为您推荐同名项目「' + matchedProj.name + '」。',
            en: 'docs/agents/yunxiao.yaml points to "' + oldDesc + '", which mismatches or is unreachable for "' + slugDisp + '". Recommended matching project "' + matchedProj.name + '".',
          },
        }
        projectMismatchBanner = warnBanner
        bannersByField['projectMode'] = warnBanner; bannersByField['projectId'] = warnBanner
        defaultsByField['projectMode'] = 'reuse'; defaultsByField['projectId'] = matchedProj.id
      } else {
        const newProjName = targetSlug || 'my-project', derivedCode = deriveProjectCustomCode(newProjName, 0)
        const warnBanner: DiscoverFieldBanner = {
          kind: 'warning', level: 'warn',
          text: {
            zh: '检测到 docs/agents/yunxiao.yaml 当前指向项目「' + oldDesc + '」，与当前工作区「' + slugDisp + '」不一致或不可达；已默认切为新建同名项目「' + newProjName + '」（代号 ' + derivedCode + '）以覆盖旧 projectId。',
            en: 'docs/agents/yunxiao.yaml points to "' + oldDesc + '", which mismatches or is unreachable for "' + slugDisp + '". Defaulted to create "' + newProjName + '" (' + derivedCode + ').',
          },
        }
        projectMismatchBanner = warnBanner
        bannersByField['projectMode'] = warnBanner; bannersByField['projectId'] = warnBanner
        defaultsByField['projectMode'] = 'create'; defaultsByField['projectName'] = newProjName; defaultsByField['customCode'] = derivedCode
      }
    } else if (configuredProj) {
      defaultsByField['projectMode'] = 'reuse'; defaultsByField['projectId'] = configuredProj.id
    }
  } else if (matchedProj) {
    defaultsByField['projectMode'] = 'reuse'; defaultsByField['projectId'] = matchedProj.id
  } else {
    const newProjName = targetSlug || 'my-project'
    defaultsByField['projectMode'] = 'create'; defaultsByField['projectName'] = newProjName; defaultsByField['customCode'] = deriveProjectCustomCode(newProjName, 0)
  }

  const rawRepoList = reposRes.ok && Array.isArray(reposRes.data) ? (reposRes.data as Record<string, unknown>[]) : []
  const namespaces = aggregateCodeupNamespaces(nsRes.ok ? nsRes.data : null, rawRepoList, activeOrgId)
  const nsOptions: BilingualOption[] = namespaces.map((ns) => ({
    value: String(ns.id),
    label: { zh: ns.path + ' (' + String(ns.id) + ')' + (ns.isRoot ? ' [组织根空间]' : ''), en: ns.path + ' (' + String(ns.id) + ')' + (ns.isRoot ? ' [Root]' : '') },
  }))
  nsOptions.push({
    value: '',
    label: { zh: activeOrgId + ' [组织根路径兜底]', en: activeOrgId + ' [Organization root fallback]' },
  })
  optionsByField['namespaceId'] = nsOptions
  const defaultNsId = (fileNsRaw && /^\d+$/.test(fileNsRaw) ? fileNsRaw : '') || (namespaces[0] ? String(namespaces[0].id) : '')
  defaultsByField['namespaceId'] = defaultNsId

  const discoveredRepos: CodeupRepositoryIdentity[] = []
  for (const item of rawRepoList) {
    const norm = normalizeCodeupRepositoryIdentity(item)
    if (norm && !norm.archived && !discoveredRepos.some((r) => r.id === norm.id)) discoveredRepos.push(norm)
  }

  let originRepo: CodeupRepositoryIdentity | null = null
  if (originParsed) {
    const fullLower = originParsed.fullPath.toLowerCase(), relLower = originParsed.relativePathWithoutFirstSegment.toLowerCase()
    originRepo = discoveredRepos.find((r) => { const p = r.pathWithNamespace.toLowerCase(); return p === fullLower || (relLower && p.endsWith('/' + relLower)) }) || null
    if (!originRepo) {
      let getRes = await requestCodeupRepositoryGet(reqCtx, activeOrgId, originParsed.fullPath, GITLAB_READ_TIMEOUT_MS)
      if (!getRes.ok && originParsed.relativePathWithoutFirstSegment && originParsed.firstSegment.toLowerCase() !== activeOrgId.toLowerCase()) {
        getRes = await requestCodeupRepositoryGet(reqCtx, activeOrgId, originParsed.relativePathWithoutFirstSegment, GITLAB_READ_TIMEOUT_MS)
      }
      const norm = getRes.ok ? normalizeCodeupRepositoryIdentity(getRes.data) : null
      if (norm) { originRepo = norm; if (!discoveredRepos.some((r) => r.id === norm.id)) discoveredRepos.unshift(norm) }
    }
  }

  let configuredRepo: CodeupRepositoryIdentity | null = null
  if (fileRepoId) {
    configuredRepo = discoveredRepos.find((r) => String(r.id) === fileRepoId || r.pathWithNamespace.toLowerCase() === fileRepoId.toLowerCase()) || null
    if (!configuredRepo) {
      const getRes = await requestCodeupRepositoryGet(reqCtx, activeOrgId, fileRepoId, GITLAB_READ_TIMEOUT_MS)
      const norm = getRes.ok ? normalizeCodeupRepositoryIdentity(getRes.data) : null
      if (norm) { configuredRepo = norm; if (!discoveredRepos.some((r) => r.id === norm.id)) discoveredRepos.unshift(norm) }
    }
  }

  optionsByField['repositoryId'] = discoveredRepos.map((r) => ({
    value: String(r.id), label: { zh: r.pathWithNamespace + ' (#' + String(r.id) + ')', en: r.pathWithNamespace + ' (#' + String(r.id) + ')' },
  }))
  defaultsByField['remoteProtocol'] = sshOk ? 'ssh' : 'auto'
  defaultsByField['visibility'] = 'private'
  defaultsByField['name'] = targetSlug || 'my-repo'

  const matchedRepo = targetSlug ? discoveredRepos.find((r) => (r.pathWithNamespace.split('/').pop() || '').toLowerCase() === targetSlug.toLowerCase()) || null : null
  if (originRepo) { defaultsByField['repoMode'] = 'bind'; defaultsByField['repositoryId'] = String(originRepo.id) }
  else if (configuredRepo) { defaultsByField['repoMode'] = 'bind'; defaultsByField['repositoryId'] = String(configuredRepo.id) }
  else if (matchedRepo) { defaultsByField['repoMode'] = 'bind'; defaultsByField['repositoryId'] = String(matchedRepo.id) }
  else { defaultsByField['repoMode'] = 'create' }

  const fileCoordsValid = Boolean(fileOrgId && isValidOrganizationId(fileOrgId, apiBaseUrl)) && Boolean(fileProjectId && isValidProjectId(fileProjectId) && configuredProj)
  const repoBoundAndAccessible = Boolean(configuredRepo && typeof configuredRepo.accessLevel === 'number' && configuredRepo.accessLevel >= 20)
  const initialStepIndex: 0 | 1 | 2 = fileCoordsValid && !hasProjectMismatch && Boolean(fileRepoId) && !repoBoundAndAccessible ? 2 : 1
  return {
    ok: true, authenticated: true, initialStepIndex, user: userOut,
    optionsByField, defaultsByField, bannersByField,
    ...(projectMismatchBanner ? { projectMismatchBanner } : {}),
  }
}

export default discoverYunxiaoWorkspace
