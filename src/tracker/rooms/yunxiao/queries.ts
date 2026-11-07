/**
 * src/tracker/rooms/yunxiao/queries.ts —— 云效 Platform、Yunxiao Projex 与 Codeup REST 路径及查询串构建器（规格 #01）。
 *
 * 为什么所有 REST 路径统一收在本文件：
 *   1. 中心版（openapi-rdc.aliyuncs.com）路径包含 /organizations/{organizationId}，而 Region 版路径省略该段；
 *      收在一处构建后，全房间 26 条能力不会各自手拼 URL 造成中心版/Region 版分叉。
 *   2. 实测证实 Codeup GetRepository 的 {repositoryId} 参数若为含斜杠的完整路径，必须先剥离末尾 .git，
 *      再把斜杠 / 编码为 %2F（未编码会触发网关 404 NotFound，保留 .git 会触发业务 404 SYSTEM_NOT_FOUND_ERROR）。
 */

/** 组织段前缀：传入非空 organizationId 时为中心版路径，为空时退化为 Region 版路径。 */
function orgPrefix(organizationId: string): string {
  const org = String(organizationId || '').trim()
  return org ? '/organizations/' + encodeURIComponent(org) : ''
}

function appendQuery(basePath: string, query = ''): string {
  const q = String(query || '').trim().replace(/^\?+/, '')
  return q ? basePath + '?' + q : basePath
}

/** 平台当前令牌用户探针路径：GET /oapi/v1/platform/user（中心版与 Region 版相同）。 */
export function platformUserPath(): string {
  return '/oapi/v1/platform/user'
}

/** 平台组织列表路径：GET /oapi/v1/platform/organizations。 */
export function platformOrganizationsPath(): string {
  return '/oapi/v1/platform/organizations'
}

/** Yunxiao Projex 单个项目详情路径：GET /oapi/v1/projex/organizations/{orgId}/projects/{projectId}。 */
export function projectPath(organizationId: string, projectId: string): string {
  return '/oapi/v1/projex' + orgPrefix(organizationId) + '/projects/' + encodeURIComponent(String(projectId).trim())
}

/** Yunxiao Projex 项目搜索路径：POST /oapi/v1/projex/organizations/{orgId}/projects:search。 */
export function projectsSearchPath(organizationId: string): string {
  return '/oapi/v1/projex' + orgPrefix(organizationId) + '/projects:search'
}

/** Yunxiao Projex 项目成员列表路径：GET .../projects/{projectId}/members。 */
export function projectMembersPath(organizationId: string, projectId: string, query = ''): string {
  return appendQuery(projectPath(organizationId, projectId) + '/members', query)
}

/** Yunxiao Projex 项目下按类别查询启用的工作项类型路径：GET .../projects/{projectId}/workitemTypes?category=...。 */
export function projectWorkitemTypesPath(organizationId: string, projectId: string, category: string): string {
  return appendQuery(
    projectPath(organizationId, projectId) + '/workitemTypes',
    'category=' + encodeURIComponent(String(category).trim()),
  )
}

/** 组织级全部工作项类型路径：GET /oapi/v1/projex/organizations/{orgId}/workitemTypes。 */
export function allWorkitemTypesPath(organizationId: string): string {
  return '/oapi/v1/projex' + orgPrefix(organizationId) + '/workitemTypes'
}

/** 组织级工作项关系矩阵查询路径：GET .../workitemTypes/{typeId}/relationWorkitemTypes（无 /projects/{id} 段）。 */
export function workitemRelationTypesPath(organizationId: string, workitemTypeId: string, relationType = ''): string {
  const base =
    '/oapi/v1/projex' +
    orgPrefix(organizationId) +
    '/workitemTypes/' +
    encodeURIComponent(String(workitemTypeId).trim()) +
    '/relationWorkitemTypes'
  return relationType ? appendQuery(base, 'relationType=' + encodeURIComponent(relationType.trim())) : base
}

/** 工作项类型字段配置路径：GET .../projects/{projectId}/workitemTypes/{typeId}/fields。 */
export function workitemFieldConfigPath(organizationId: string, projectId: string, workitemTypeId: string): string {
  return (
    projectPath(organizationId, projectId) +
    '/workitemTypes/' +
    encodeURIComponent(String(workitemTypeId).trim()) +
    '/fields'
  )
}

/** 项目 + 工作项类型的工作流状态列表路径：GET .../projects/{projectId}/workitemTypes/{typeId}/workflows。 */
export function workitemWorkflowPath(organizationId: string, projectId: string, workitemTypeId: string): string {
  return (
    projectPath(organizationId, projectId) +
    '/workitemTypes/' +
    encodeURIComponent(String(workitemTypeId).trim()) +
    '/workflows'
  )
}

/** 搜索工作项路径：POST /oapi/v1/projex/organizations/{orgId}/workitems:search。 */
export function workitemsSearchPath(organizationId: string): string {
  return '/oapi/v1/projex' + orgPrefix(organizationId) + '/workitems:search'
}

/** 创建工作项路径：POST /oapi/v1/projex/organizations/{orgId}/workitems。 */
export function workitemsCreatePath(organizationId: string): string {
  return '/oapi/v1/projex' + orgPrefix(organizationId) + '/workitems'
}

/** 单个工作项读取或更新路径：GET/PUT .../workitems/{idOrSerial}。 */
export function workitemPath(organizationId: string, workitemIdOrSerial: string | number): string {
  return (
    '/oapi/v1/projex' +
    orgPrefix(organizationId) +
    '/workitems/' +
    encodeURIComponent(String(workitemIdOrSerial).trim())
  )
}

/** 单个工作项的工作流详情路径：GET .../workitems/{workitemId}/workflow（必须传 26 位 id，不传 X-Tenant-Id）。 */
export function workitemWorkflowInfoPath(organizationId: string, workitemId: string): string {
  return workitemPath(organizationId, workitemId) + '/workflow'
}

/** 工作项评论列表或新增路径：GET/POST .../workitems/{idOrSerial}/comments。 */
export function workitemCommentsPath(
  organizationId: string,
  workitemIdOrSerial: string | number,
  query = '',
): string {
  return appendQuery(workitemPath(organizationId, workitemIdOrSerial) + '/comments', query)
}

/** 工作项关联记录读取、创建或删除路径：GET/POST/DELETE .../workitems/{idOrSerial}/relationRecords。 */
export function workitemRelationRecordsPath(
  organizationId: string,
  workitemIdOrSerial: string | number,
  query = '',
): string {
  return appendQuery(workitemPath(organizationId, workitemIdOrSerial) + '/relationRecords', query)
}

/** 项目标签列表与创建路径：GET/POST .../projects/{projectId}/labels。 */
export function projectLabelsPath(organizationId: string, projectId: string, query = ''): string {
  return appendQuery(projectPath(organizationId, projectId) + '/labels', query)
}

/** 项目单个标签更新路径：PUT .../projects/{projectId}/labels/{labelId}。 */
export function projectLabelItemPath(organizationId: string, projectId: string, labelId: string): string {
  return projectPath(organizationId, projectId) + '/labels/' + encodeURIComponent(String(labelId).trim())
}

/**
 * Codeup 单个代码库查询路径（GetRepository）：
 *   GET /oapi/v1/codeup/organizations/{orgId}/repositories/{repositoryId}
 * 自动剥离末尾 .git 与首尾斜杠，并将路径中的 / 编码为 %2F。
 */
import { cleanCodeupRepoPath } from './model/workspace-config.js'

export function codeupRepositoryPath(organizationId: string, repoIdOrPath: string | number): string {
  const cleaned = cleanCodeupRepoPath(repoIdOrPath)
  return (
    '/oapi/v1/codeup' +
    orgPrefix(organizationId) +
    '/repositories/' +
    encodeURIComponent(cleaned)
  )
}

/**
 * Codeup 创建代码库路径（CreateRepository）：
 *   POST /oapi/v1/codeup/organizations/{orgId}/repositories?createParentPath=true
 */
export function codeupRepositoriesCreatePath(organizationId: string, createParentPath = true): string {
  const base = '/oapi/v1/codeup' + orgPrefix(organizationId) + '/repositories'
  return createParentPath ? base + '?createParentPath=true' : base
}
