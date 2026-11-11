/**
 * src/tracker/rooms/yunxiao/requests.ts —— 云效 REST 请求边界：每个远端端点一个具名函数（规格 #01）。
 *
 * 对齐 docs/adr/20261105-gitlab-room-request-boundary.md 的房间请求边界纪律：
 *   1. 参数只收领域值（organizationId、projectId、workitemIdOrSerial、查询条件、timeoutMs），
 *      URL 路径统一由本文件调用 queries.ts 拼装，子目录文件不直接手拼 REST 路径。
 *   2. 超时毫秒（timeoutMs）作为每个具名函数的最后一个参数，原样交给 client.ts。
 *   3. 返回值原样交回 YunxiaoHttpResult，由调用方按操作上下文解析与判档。
 */

import { yunxiaoClient } from './client.js'
import type { YunxiaoCtx, YunxiaoHttpResult } from './client.js'
import {
  allWorkitemTypesPath, codeupRepositoriesCreatePath, codeupRepositoryPath,
  platformOrganizationsPath, platformUserPath, projectLabelItemPath, projectLabelsPath,
  projectMembersPath, projectPath, projectsCreatePath, projectsSearchPath, projectTemplatesPath,
  projectWorkitemTypesPath, workitemCommentsPath, workitemFieldConfigPath, workitemPath,
  workitemRelationRecordsPath, workitemRelationTypesPath, workitemsCreatePath, workitemsSearchPath,
  workitemWorkflowInfoPath, workitemWorkflowPath,
} from './queries.js'

type MaybeCtx = YunxiaoCtx | null | undefined
export type YunxiaoRelationType = 'PARENT' | 'SUB' | 'ASSOCIATED' | 'DEPEND_ON' | 'DEPENDED_BY'

/** 查询当前令牌对应的云效用户：GET /oapi/v1/platform/user。 */
export function requestPlatformUser(opCtx: MaybeCtx, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(platformUserPath(), { method: 'GET', timeoutMs, cmd: 'platform:user', bucket: 'probe' })
}

/** 查询当前用户可访问的云效组织列表：GET /oapi/v1/platform/organizations。 */
export function requestPlatformOrganizations(opCtx: MaybeCtx, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(platformOrganizationsPath(), { method: 'GET', timeoutMs, cmd: 'platform:organizations', bucket: 'probe' })
}

/** 查询单个 Yunxiao Projex 项目详情：GET .../projects/{projectId}。 */
export function requestProjectGet(opCtx: MaybeCtx, organizationId: string, projectId: string, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(projectPath(organizationId, projectId), { method: 'GET', timeoutMs, cmd: 'projex:project-get' })
}

/** 搜索 Yunxiao Projex 项目列表：POST .../projects:search。 */
export function requestProjectsSearch(opCtx: MaybeCtx, organizationId: string, body: Record<string, unknown>, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(projectsSearchPath(organizationId), { method: 'POST', body, timeoutMs, cmd: 'projex:projects-search', bucket: 'read' })
}

/** 查询组织下可用的 Yunxiao Projex 项目模板列表：GET .../projectTemplates。 */
export function requestProjectTemplatesList(opCtx: MaybeCtx, organizationId: string, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(projectTemplatesPath(organizationId), { method: 'GET', timeoutMs, cmd: 'projex:project-templates', bucket: 'read' })
}

export interface YunxiaoCreateProjectBody {
  name: string; customCode: string; scope: 'public' | 'private'; templateId: string; description?: string; customFieldValues?: Record<string, unknown>
}

/** 创建 Yunxiao Projex 项目：POST .../projects。 */
export function requestProjectCreate(opCtx: MaybeCtx, organizationId: string, body: YunxiaoCreateProjectBody, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(projectsCreatePath(organizationId), { method: 'POST', body, timeoutMs, cmd: 'projex:project-create', bucket: 'write' })
}

/** 查询 Yunxiao Projex 项目成员列表：GET .../projects/{projectId}/members。 */
export function requestProjectMembers(opCtx: MaybeCtx, organizationId: string, projectId: string, query: string, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(projectMembersPath(organizationId, projectId, query), { method: 'GET', timeoutMs, cmd: 'projex:project-members' })
}

/** 查询项目下指定类别启用的工作项类型：GET .../projects/{projectId}/workitemTypes?category=...。 */
export function requestProjectWorkitemTypes(opCtx: MaybeCtx, organizationId: string, projectId: string, category: string, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(projectWorkitemTypesPath(organizationId, projectId, category), { method: 'GET', timeoutMs, cmd: 'projex:workitem-types' })
}

/** 查询组织级全部工作项类型：GET .../workitemTypes。 */
export function requestAllWorkitemTypes(opCtx: MaybeCtx, organizationId: string, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(allWorkitemTypesPath(organizationId), { method: 'GET', timeoutMs, cmd: 'projex:all-workitem-types' })
}

/** 查询工作项类型允许关联的目标类型矩阵：GET .../workitemTypes/{typeId}/relationWorkitemTypes。 */
export function requestWorkitemRelationTypes(opCtx: MaybeCtx, organizationId: string, workitemTypeId: string, relationType: string, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(workitemRelationTypesPath(organizationId, workitemTypeId, relationType), { method: 'GET', timeoutMs, cmd: 'projex:relation-types' })
}

/** 查询工作项类型的字段配置：GET .../projects/{projectId}/workitemTypes/{typeId}/fields。 */
export function requestWorkitemFieldConfig(opCtx: MaybeCtx, organizationId: string, projectId: string, workitemTypeId: string, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(workitemFieldConfigPath(organizationId, projectId, workitemTypeId), { method: 'GET', timeoutMs, cmd: 'projex:field-config' })
}

/** 查询项目下某工作项类型的工作流状态列表：GET .../projects/{projectId}/workitemTypes/{typeId}/workflows。 */
export function requestWorkitemWorkflow(opCtx: MaybeCtx, organizationId: string, projectId: string, workitemTypeId: string, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(workitemWorkflowPath(organizationId, projectId, workitemTypeId), { method: 'GET', timeoutMs, cmd: 'projex:workflow' })
}

/** 查询单个工作项的工作流详情：GET .../workitems/{workitemId}/workflow（需 26 位 id）。 */
export function requestWorkitemWorkflowInfo(opCtx: MaybeCtx, organizationId: string, workitemId: string, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(workitemWorkflowInfoPath(organizationId, workitemId), { method: 'GET', timeoutMs, cmd: 'projex:workitem-workflow' })
}

export interface YunxiaoSearchBody {
  spaceId: string; category: string; spaceType?: string; conditions?: string; orderBy?: string; sort?: string; page?: number; perPage?: number
}

/** 搜索工作项列表：POST .../workitems:search。 */
export function requestWorkitemsSearch(opCtx: MaybeCtx, organizationId: string, body: YunxiaoSearchBody, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(workitemsSearchPath(organizationId), { method: 'POST', body, timeoutMs, cmd: 'projex:workitems-search', bucket: 'read' })
}

/** 读取单个工作项详情：GET .../workitems/{idOrSerial}（支持 26 位 id 或 DCIAFS-n）。 */
export function requestWorkitemGet(opCtx: MaybeCtx, organizationId: string, workitemIdOrSerial: string | number, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(workitemPath(organizationId, workitemIdOrSerial), { method: 'GET', timeoutMs, cmd: 'projex:workitem-get' })
}

export interface YunxiaoCreateWorkitemBody {
  spaceId: string; workitemTypeId: string; subject: string; assignedTo: string; description?: string;
  formatType?: 'MARKDOWN' | 'RICHTEXT'; parentId?: string; labels?: string[]; participants?: string[]; customFieldValues?: Record<string, unknown>
}

/** 创建工作项：POST .../workitems。 */
export function requestWorkitemCreate(opCtx: MaybeCtx, organizationId: string, body: YunxiaoCreateWorkitemBody, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(workitemsCreatePath(organizationId), { method: 'POST', body, timeoutMs, cmd: 'projex:workitem-create', bucket: 'write' })
}

/** 更新工作项字段（标题、描述、状态、负责人、参与人、标签、父项等）：PUT .../workitems/{workitemId}（返回 204）。 */
export function requestWorkitemUpdate(opCtx: MaybeCtx, organizationId: string, workitemId: string, fields: Record<string, unknown>, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(workitemPath(organizationId, workitemId), { method: 'PUT', body: fields, timeoutMs, cmd: 'projex:workitem-update', bucket: 'write' })
}

/** 读取工作项评论列表：GET .../workitems/{idOrSerial}/comments。 */
export function requestWorkitemCommentsList(opCtx: MaybeCtx, organizationId: string, workitemIdOrSerial: string | number, query: string, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(workitemCommentsPath(organizationId, workitemIdOrSerial, query), { method: 'GET', timeoutMs, cmd: 'projex:comments-list' })
}

/** 创建工作项评论：POST .../workitems/{idOrSerial}/comments。 */
export function requestWorkitemCommentCreate(opCtx: MaybeCtx, organizationId: string, workitemIdOrSerial: string | number, content: string, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(workitemCommentsPath(organizationId, workitemIdOrSerial), { method: 'POST', body: { content, formatType: 'MARKDOWN' }, timeoutMs, cmd: 'projex:comment-create', bucket: 'write' })
}

/** 查询工作项关联关系记录：GET .../workitems/{idOrSerial}/relationRecords?relationType=...。 */
export function requestWorkitemRelationRecordsList(opCtx: MaybeCtx, organizationId: string, workitemIdOrSerial: string | number, relationType: YunxiaoRelationType, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(workitemRelationRecordsPath(organizationId, workitemIdOrSerial, 'relationType=' + encodeURIComponent(relationType)), { method: 'GET', timeoutMs, cmd: 'projex:relations-list' })
}

/** 创建工作项关联关系记录：POST .../workitems/{workitemId}/relationRecords。 */
export function requestWorkitemRelationRecordCreate(opCtx: MaybeCtx, organizationId: string, workitemId: string, relationType: YunxiaoRelationType, targetWorkitemId: string, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(workitemRelationRecordsPath(organizationId, workitemId), { method: 'POST', body: { relationType, workitemId: targetWorkitemId }, timeoutMs, cmd: 'projex:relation-create', bucket: 'write' })
}

/**
 * 删除工作项关联关系记录：DELETE .../workitems/{workitemId}/relationRecords（返回 204）。
 * relationType 与目标 workitemId 按 DeleteWorkitemRelationRecord 官方文档放在 JSON 请求体里；
 * 真机实测（缺陷 02）把二者放进查询串时服务端返回 400「Request parameters are invalid」，
 * 而这条 400 此前会被上层尽力删除的容错吞掉，导致解除父子时原生 parentId 一直清不掉。
 */
export function requestWorkitemRelationRecordDelete(opCtx: MaybeCtx, organizationId: string, workitemId: string, relationType: YunxiaoRelationType, targetWorkitemId: string, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(workitemRelationRecordsPath(organizationId, workitemId), {
    method: 'DELETE',
    body: { relationType, workitemId: targetWorkitemId },
    timeoutMs,
    cmd: 'projex:relation-delete',
    bucket: 'write',
  })
}

/** 查询项目标签列表：GET .../projects/{projectId}/labels（无标签时返回 204）。 */
export function requestProjectLabelsList(opCtx: MaybeCtx, organizationId: string, projectId: string, query: string, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(projectLabelsPath(organizationId, projectId, query), { method: 'GET', timeoutMs, cmd: 'projex:labels-list' })
}

/** 创建项目标签：POST .../projects/{projectId}/labels。 */
export function requestProjectLabelCreate(opCtx: MaybeCtx, organizationId: string, projectId: string, body: { name: string; color?: string }, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(projectLabelsPath(organizationId, projectId), { method: 'POST', body, timeoutMs, cmd: 'projex:label-create', bucket: 'write' })
}

/** 更新项目标签颜色或名称：PUT .../projects/{projectId}/labels/{labelId}。 */
export function requestProjectLabelUpdate(opCtx: MaybeCtx, organizationId: string, projectId: string, labelId: string, body: { name?: string; color?: string }, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(projectLabelItemPath(organizationId, projectId, labelId), { method: 'PUT', body, timeoutMs, cmd: 'projex:label-update', bucket: 'write' })
}

/** 查询 Codeup 代码库详情（GetRepository）：GET .../codeup/organizations/{orgId}/repositories/{idOrEncodedPath}。 */
export function requestCodeupRepositoryGet(opCtx: MaybeCtx, organizationId: string, repoIdOrPath: string | number, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(codeupRepositoryPath(organizationId, repoIdOrPath), { method: 'GET', timeoutMs, cmd: 'codeup:repo-get' })
}

export interface YunxiaoCreateRepoBody { name: string; path: string; visibility: 'private' | 'internal'; description?: string; namespaceId?: number }

/** 创建 Codeup 代码库（CreateRepository）：POST .../codeup/organizations/{orgId}/repositories?createParentPath=true。 */
export function requestCodeupRepositoryCreate(opCtx: MaybeCtx, organizationId: string, body: YunxiaoCreateRepoBody, timeoutMs: number): Promise<YunxiaoHttpResult> {
  return yunxiaoClient(opCtx).request(codeupRepositoriesCreatePath(organizationId, true), { method: 'POST', body, timeoutMs, cmd: 'codeup:repo-create', bucket: 'write' })
}
