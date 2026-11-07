/**
 * src/tracker/rooms/yunxiao/issues/write.ts —— Yunxiao Projex 工作项写操作路由（规格 #03）。
 *
 * 核心行为：
 *   1. 六种建票位置映射：map 与 spec -> 需求 Req，map-ticket、spec-ticket 与 issue -> 任务 Task，
 *      bug -> 缺陷 Bug（项目未启用 Bug 类型时自动回退为带 bug 标签的 Task）；
 *   2. 幂等防重：写入文件头 DSH-IDEMPOTENCY-KEY 并经 lookupByAnchor 回查；
 *   3. 认领真源：新建未认领票用当前令牌用户填充原生必填 assignedTo，文件头不写 DSH-ASSIGNEES，读回 Issue.assignees 为 []；
 *   4. 状态流转：closeIssue 自动查询阶段 4（已完成）状态并流转，reopenIssue 查询阶段 1/2 状态流转；
 *   5. updateIssue：以 formatType: MARKDOWN 更新标题与正文。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../../contract/entities.js'
import type { CloseOpts, CreateInput, UpdatePatch } from '../../../contract/inputs.js'
import { TRACKER_ERROR_STAGE, type OpResult, type TrackerError } from '../../../contract/results.js'
import { checkIdempotencyKey } from '../../../../refresh/contract/idempotency-keys.js'
import { fail } from '../../../kernel/preflight.js'
import { GITLAB_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { asRecord, failYunxiao } from '../errors.js'
import {
  parseHiddenIssueKind, rememberYunxiaoIssueIdentity, rewriteDescriptionWithAssignees,
  rewriteDescriptionWithHiddenParent, rewriteDescriptionWithIssueKind, withAnchor,
} from '../model/description-markers.js'
import { getLearnedYunxiaoContext, learnYunxiaoContextFor } from '../model/repo-identity.js'
import { normalizeYunxiaoIssue } from '../model/normalize.js'
import {
  requestPlatformUser, requestProjectMembers, requestProjectWorkitemTypes,
  requestWorkitemCreate, requestWorkitemUpdate, requestWorkitemWorkflow,
  requestWorkitemWorkflowInfo, type YunxiaoCreateWorkitemBody,
} from '../requests.js'
import { lookupByAnchor } from './idempotency.js'
import { getIssue } from './read.js'
import {
  enrichWorkitemComments, ensureProjectLabelIdsForWrite, errMsg, extractAssigneeLogins,
  fetchRawWorkitem, normalizeLabelInputs, resolveProjectRef, resolveRequiredWorkitemId,
  type CtxLike, type RepoLike, type ResolvedProjectRef,
} from './shared.js'

/** 获取当前令牌用户的 24 位云效 userId（优先读缓存，未命中时调 GET /oapi/v1/platform/user）。 */
export async function ensureCurrentUserId(
  opCtx: CtxLike | null | undefined, proj: ResolvedProjectRef,
): Promise<{ ok: true; userId: string; name: string } | { ok: false; error: TrackerError }> {
  const learned = getLearnedYunxiaoContext(proj.refId)?.currentUser || (opCtx?.cwd ? getLearnedYunxiaoContext(opCtx.cwd)?.currentUser : undefined)
  if (learned?.id) return { ok: true, userId: learned.id, name: learned.name || learned.id }
  const res = await requestPlatformUser(opCtx, GITLAB_READ_TIMEOUT_MS)
  if (!res.ok) return failYunxiao(res, res.stderr || res.stdout || '查询当前云效用户失败', res, opCtx ?? undefined)
  const bag = asRecord(res.data)
  const id = bag && typeof bag['id'] === 'string' ? bag['id'].trim() : ''
  const name = bag && typeof bag['name'] === 'string' ? bag['name'].trim() : id
  if (!id) return fail(ERROR_KIND.PARSE as ErrorKind, 'GET /oapi/v1/platform/user 响应缺少有效的用户 id', res.stdout)
  learnYunxiaoContextFor({ cwd: opCtx?.cwd, refId: proj.refId }, { organizationId: proj.organizationId, projectId: proj.projectId, currentUser: { id, name } })
  return { ok: true, userId: id, name }
}

/** 查询项目下指定 category（Req / Task / Bug）启用的默认工作项类型 ID。 */
export async function resolveCategoryWorkitemTypeId(
  opCtx: CtxLike | null | undefined, proj: ResolvedProjectRef, category: 'Req' | 'Task' | 'Bug',
): Promise<{ ok: true; workitemTypeId: string } | { ok: false; empty?: boolean; error: TrackerError }> {
  const res = await requestProjectWorkitemTypes(opCtx, proj.organizationId, proj.projectId, category, GITLAB_READ_TIMEOUT_MS)
  if (!res.ok) return failYunxiao(res, res.stderr || res.stdout || '查询项目工作项类型（category=' + category + '）失败', res, opCtx ?? undefined)
  if (!Array.isArray(res.data) || res.data.length === 0) {
    return { ok: false, empty: true, error: fail(ERROR_KIND.NOTFOUND as ErrorKind, '项目未启用类别为 ' + category + ' 的工作项类型', res.stdout).error }
  }
  const list = res.data as Record<string, unknown>[]
  const preferred = list.find((t) => t && t['enable'] !== false && t['defaultType'] === true && typeof t['id'] === 'string') || list.find((t) => t && t['enable'] !== false && typeof t['id'] === 'string') || list.find((t) => t && typeof t['id'] === 'string')
  const typeId = preferred && typeof preferred['id'] === 'string' ? preferred['id'].trim() : ''
  if (!typeId) return { ok: false, empty: true, error: fail(ERROR_KIND.PARSE as ErrorKind, '工作项类型列表缺少有效的 id 字段', res.stdout).error }
  return { ok: true, workitemTypeId: typeId }
}

/** 查询工作流中目标阶段（如阶段 4 已完成或阶段 1 待处理）对应的状态 ID。 */
export async function findWorkflowStatusIdByStage(
  opCtx: CtxLike | null | undefined, proj: ResolvedProjectRef, workitemId: string, workitemTypeId: string, targetStages: readonly string[],
): Promise<{ ok: true; statusId: string } | { ok: false; error: TrackerError }> {
  const stageSet = new Set(targetStages.map((s) => s.trim()))
  const extractFromPayload = (data: unknown): string => {
    const bag = asRecord(data)
    const statuses = bag && Array.isArray(bag['statuses']) ? bag['statuses'] : bag && Array.isArray(bag['workflowStatuses']) ? bag['workflowStatuses'] : Array.isArray(data) ? data : []
    for (const st of statuses) {
      const sb = asRecord(st)
      if (!sb) continue
      const stage = String(sb['statusStageId'] ?? sb['stageId'] ?? sb['stage'] ?? '').trim()
      const id = typeof sb['id'] === 'string' ? sb['id'].trim() : typeof sb['statusId'] === 'string' ? sb['statusId'].trim() : ''
      if (id && stageSet.has(stage)) return id
    }
    return ''
  }
  const wfInfoRes = await requestWorkitemWorkflowInfo(opCtx, proj.organizationId, workitemId, GITLAB_READ_TIMEOUT_MS)
  if (wfInfoRes.ok) { const found = extractFromPayload(wfInfoRes.data); if (found) return { ok: true, statusId: found } }
  if (workitemTypeId) {
    const wfTypeRes = await requestWorkitemWorkflow(opCtx, proj.organizationId, proj.projectId, workitemTypeId, GITLAB_READ_TIMEOUT_MS)
    if (wfTypeRes.ok) { const found = extractFromPayload(wfTypeRes.data); if (found) return { ok: true, statusId: found } }
  }
  return fail(ERROR_KIND.NOTFOUND as ErrorKind, '未在云效工作流中找到目标阶段（statusStageId=' + targetStages.join('/') + '）对应的状态 ID', wfInfoRes.stdout || wfInfoRes.stderr)
}

/** 将认领人标识解析为云效原生用户 ID（未认领或逻辑名回退使用当前 PAT 用户 ID）。 */
export async function resolveNativeUserIdsForAssignees(
  opCtx: CtxLike | null | undefined, proj: ResolvedProjectRef, logins: readonly string[],
): Promise<{ ok: true; primaryUserId: string; participantIds: string[] } | { ok: false; error: TrackerError }> {
  const currentUser = await ensureCurrentUserId(opCtx, proj)
  if (!currentUser.ok) return currentUser
  if (logins.length === 0) return { ok: true, primaryUserId: currentUser.userId, participantIds: [] }
  let memberMap: Map<string, string> | null = null
  const resolvedIds: string[] = []
  for (const rawLogin of logins) {
    const login = rawLogin.trim()
    if (!login) continue
    if (/^[0-9a-f]{24}$/i.test(login)) { if (!resolvedIds.includes(login)) resolvedIds.push(login); continue }
    if (login.toLowerCase() === currentUser.name.toLowerCase() || login.toLowerCase() === 'lead') {
      if (!resolvedIds.includes(currentUser.userId)) resolvedIds.push(currentUser.userId)
      continue
    }
    if (memberMap === null) {
      memberMap = new Map()
      try {
        const memRes = await requestProjectMembers(opCtx, proj.organizationId, proj.projectId, '', GITLAB_READ_TIMEOUT_MS)
        if (memRes.ok && Array.isArray(memRes.data)) {
          for (const m of memRes.data as Record<string, unknown>[]) {
            if (!m || typeof m !== 'object') continue
            const uid = typeof m['userId'] === 'string' ? m['userId'].trim() : typeof m['id'] === 'string' ? m['id'].trim() : ''
            const uname = typeof m['userName'] === 'string' ? m['userName'].trim() : typeof m['name'] === 'string' ? m['name'].trim() : ''
            if (uid && uname) memberMap.set(uname.toLowerCase(), uid)
          }
        }
      } catch { /* best-effort */ }
    }
    const matchedUid = memberMap.get(login.toLowerCase()) || currentUser.userId
    if (!resolvedIds.includes(matchedUid)) resolvedIds.push(matchedUid)
  }
  return { ok: true, primaryUserId: resolvedIds[0] || currentUser.userId, participantIds: resolvedIds }
}

function classifyCreationKind(input: CreateInput, labelNames: readonly string[]): { targetCategory: 'Req' | 'Task' | 'Bug'; isSpec: boolean; isMap: boolean } {
  const body = typeof input.body === 'string' ? input.body : ''
  const headerKind = parseHiddenIssueKind(body)
  const lowerLabels = new Set(labelNames.map((l) => l.toLowerCase()))
  const isSpec = input.type === 'spec' || headerKind === 'spec'
  const isMap = !isSpec && (input.type === 'map' || headerKind === 'map' || lowerLabels.has('wayfinder:map'))
  const isBug = !isSpec && !isMap && (input.fileKind === 'bug' || lowerLabels.has('bug'))
  return { targetCategory: isSpec || isMap ? 'Req' : isBug ? 'Bug' : 'Task', isSpec, isMap }
}

/** 创建工作项（契约操作 create）。 */
export async function createIssue(ctx: BackendContext, repo: RepositoryRef, input: CreateInput, opCtx: OpContext): Promise<OpResult<Issue>> {
  const effective = (opCtx || ctx) as CtxLike
  const proj = resolveProjectRef(repo as RepoLike)
  if (!proj) return fail(ERROR_KIND.NOTFOUND as ErrorKind, 'create: repo.refId 缺失或格式不是 organizationId/projectId', '')
  if (!input || typeof input.title !== 'string' || !input.title.trim()) {
    return fail(ERROR_KIND.PARSE as ErrorKind, 'create: title 不能为空', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  }
  try {
    const wantKey = input.idempotencyKey === undefined || input.idempotencyKey === null ? null : checkIdempotencyKey(input.idempotencyKey)
    if (wantKey && !wantKey.ok) {
      return fail(ERROR_KIND.PARSE as ErrorKind, 'create: idempotencyKey 不能用：' + wantKey.reason, String(input.idempotencyKey), TRACKER_ERROR_STAGE.INPUT_REFUSED)
    }
    const idemKey = wantKey ? wantKey.key : ''
    if (idemKey) {
      const found = await lookupByAnchor(repo, idemKey, effective)
      if (!found.ok) return found
      if (found.hit) return { ok: true, data: found.issue }
    }
    const normalizedLabels = normalizeLabelInputs(input.labels)
    const labelNames = normalizedLabels.map((l) => l.name)
    const assigneeLogins = extractAssigneeLogins(input.assignees)
    const kindInfo = classifyCreationKind(input, labelNames)
    if (kindInfo.isMap && !labelNames.some((l) => l.toLowerCase() === 'wayfinder:map')) {
      normalizedLabels.push({ name: 'wayfinder:map', color: '' })
      labelNames.push('wayfinder:map')
    }

    let workitemTypeId = ''
    if (kindInfo.targetCategory === 'Bug') {
      const bugTypeRes = await resolveCategoryWorkitemTypeId(effective, proj, 'Bug')
      if (bugTypeRes.ok) workitemTypeId = bugTypeRes.workitemTypeId
      else if (bugTypeRes.empty) {
        const taskTypeRes = await resolveCategoryWorkitemTypeId(effective, proj, 'Task')
        if (!taskTypeRes.ok) return { ok: false, error: taskTypeRes.error }
        workitemTypeId = taskTypeRes.workitemTypeId
        if (!labelNames.some((l) => l.toLowerCase() === 'bug')) {
          normalizedLabels.push({ name: 'bug', color: '' })
          labelNames.push('bug')
        }
      } else return { ok: false, error: bugTypeRes.error }
    } else {
      const typeRes = await resolveCategoryWorkitemTypeId(effective, proj, kindInfo.targetCategory)
      if (!typeRes.ok) return { ok: false, error: typeRes.error }
      workitemTypeId = typeRes.workitemTypeId
    }

    let description = typeof input.body === 'string' ? input.body : ''
    if (kindInfo.isSpec && parseHiddenIssueKind(description) !== 'spec') description = rewriteDescriptionWithIssueKind(description, 'spec')
    else if (input.fileKind === 'spec-ticket' && parseHiddenIssueKind(description) === null) description = rewriteDescriptionWithIssueKind(description, 'ticket')
    if (assigneeLogins.length > 0) description = rewriteDescriptionWithAssignees(description, assigneeLogins)

    let nativeParentId: string | undefined
    if (input.parentKey !== undefined && input.parentKey !== null && String(input.parentKey).trim() !== '') {
      const rawParent = String(input.parentKey).trim()
      description = rewriteDescriptionWithHiddenParent(description, rawParent)
      const parentResolved = await resolveRequiredWorkitemId(effective, proj, rawParent)
      if (parentResolved.ok) nativeParentId = parentResolved.workitemId
    }
    description = withAnchor(description, idemKey)

    const userResolved = await resolveNativeUserIdsForAssignees(effective, proj, assigneeLogins)
    if (!userResolved.ok) return userResolved
    let labelIds: string[] = []
    let labelError: TrackerError | undefined
    if (normalizedLabels.length > 0) {
      const lblRes = await ensureProjectLabelIdsForWrite(effective, proj, normalizedLabels)
      if (lblRes.ok) labelIds = lblRes.labelIds
      else labelError = lblRes.error
    }

    const createBody: YunxiaoCreateWorkitemBody = {
      spaceId: proj.projectId, workitemTypeId, subject: input.title.trim(), assignedTo: userResolved.primaryUserId,
      description, formatType: 'MARKDOWN',
      ...(nativeParentId ? { parentId: nativeParentId } : {}),
      ...(labelIds.length > 0 ? { labels: labelIds } : {}),
      ...(assigneeLogins.length > 0 && userResolved.participantIds.length > 0 ? { participants: userResolved.participantIds } : {}),
    }
    const createRes = await requestWorkitemCreate(effective, proj.organizationId, createBody, GITLAB_READ_TIMEOUT_MS)
    if (!createRes.ok) return failYunxiao(createRes, createRes.stderr || createRes.stdout || '创建工作项失败', createRes, effective)

    const createdBag = asRecord(createRes.data)
    const createdId = createdBag && typeof createdBag['id'] === 'string' ? createdBag['id'].trim() : ''
    if (!createdId) return fail(ERROR_KIND.PARSE as ErrorKind, 'CreateWorkitem 响应缺少有效的 id 字段', createRes.stdout)

    const fetched = await fetchRawWorkitem(effective, proj, createdId)
    const issue = fetched.ok
      ? (await enrichWorkitemComments(effective, proj, fetched.raw, fetched.workitemId, null), normalizeYunxiaoIssue(fetched.raw, repo))
      : normalizeYunxiaoIssue({ id: createdId, subject: createBody.subject, description, formatType: 'MARKDOWN', statusStageId: '1', labels: labelError ? [] : normalizedLabels }, repo)
    if (labelError) (issue as Issue & { labelError?: TrackerError }).labelError = labelError
    return { ok: true, data: issue }
  } catch (err: unknown) {
    return failYunxiao(err, errMsg(err), err, effective)
  }
}

async function transitionWorkitemStage(
  ctx: BackendContext, repo: RepositoryRef, key: string, targetStages: readonly string[], opLabel: 'close' | 'reopen', opCtx: OpContext,
): Promise<OpResult<Issue>> {
  const effective = (opCtx || ctx) as CtxLike
  const proj = resolveProjectRef(repo as RepoLike)
  if (!proj) return fail(ERROR_KIND.NOTFOUND as ErrorKind, opLabel + ': repo.refId 缺失或格式不是 organizationId/projectId', '')
  const k = String(key == null ? '' : key).trim()
  if (!k) return fail(ERROR_KIND.PARSE as ErrorKind, opLabel + ': 工作项编号不能为空', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  try {
    const fetched = await fetchRawWorkitem(effective, proj, k)
    if (!fetched.ok) return { ok: false, error: fetched.error }
    const wtBag = asRecord(fetched.raw['workitemType'])
    const workitemTypeId = wtBag && typeof wtBag['id'] === 'string' ? wtBag['id'].trim() : ''
    const targetStatus = await findWorkflowStatusIdByStage(effective, proj, fetched.workitemId, workitemTypeId, targetStages)
    if (!targetStatus.ok) return targetStatus
    const updRes = await requestWorkitemUpdate(effective, proj.organizationId, fetched.workitemId, { status: targetStatus.statusId }, GITLAB_READ_TIMEOUT_MS)
    if (!updRes.ok) return failYunxiao(updRes, updRes.stderr || updRes.stdout || opLabel + ' 状态流转失败', updRes, effective)
    const after = await fetchRawWorkitem(effective, proj, fetched.workitemId)
    const rawOut = after.ok ? after.raw : { ...fetched.raw, statusStageId: targetStages[0] }
    return { ok: true, data: normalizeYunxiaoIssue(rawOut, repo) }
  } catch (err: unknown) {
    return failYunxiao(err, errMsg(err), err, effective)
  }
}

/** 关闭工作项（契约操作 close）：自动查询工作流中 statusStageId === "4"（已完成）的目标状态并流转。 */
export function closeIssue(ctx: BackendContext, repo: RepositoryRef, key: string, _opts: CloseOpts | undefined, opCtx: OpContext): Promise<OpResult<Issue>> {
  return transitionWorkitemStage(ctx, repo, key, ['4'], 'close', opCtx)
}

/** 重开工作项（契约操作 reopen）：自动查询工作流中 statusStageId === "1" 或 "2" 的目标状态并流转。 */
export function reopenIssue(ctx: BackendContext, repo: RepositoryRef, key: string, opCtx: OpContext): Promise<OpResult<Issue>> {
  return transitionWorkitemStage(ctx, repo, key, ['1', '2'], 'reopen', opCtx)
}

/** 更新工作项标题或正文（契约操作 update）：以 formatType: "MARKDOWN" 写入并在更新后读回最新详情。 */
export async function updateIssue(ctx: BackendContext, repo: RepositoryRef, key: string, patch: UpdatePatch, opCtx: OpContext): Promise<OpResult<Issue>> {
  const effective = (opCtx || ctx) as CtxLike
  const proj = resolveProjectRef(repo as RepoLike)
  if (!proj) return fail(ERROR_KIND.NOTFOUND as ErrorKind, 'update: repo.refId 缺失或格式不是 organizationId/projectId', '')
  const k = String(key == null ? '' : key).trim()
  if (!k) return fail(ERROR_KIND.PARSE as ErrorKind, 'update: 工作项编号不能为空', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  if (!patch || typeof patch !== 'object') return fail(ERROR_KIND.PARSE as ErrorKind, 'update: patch 不能为空', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  try {
    if ('milestone' in patch && patch.milestone !== undefined) return fail(ERROR_KIND.UNSUPPORTED as ErrorKind, 'Yunxiao Projex 暂不支持 milestone 字段更新', JSON.stringify(patch.milestone))
    if (Array.isArray(patch.customFields) && patch.customFields.length > 0) return fail(ERROR_KIND.UNSUPPORTED as ErrorKind, 'Yunxiao Projex 不支持通过契约更新 customFields', JSON.stringify(patch.customFields))
    const fields: Record<string, unknown> = {}
    if (typeof patch.title === 'string') fields['subject'] = patch.title
    if (typeof patch.body === 'string') { fields['description'] = patch.body; fields['formatType'] = 'MARKDOWN' }
    if (Object.keys(fields).length === 0) return getIssue(ctx, repo, k, {}, opCtx)
    const resolved = await resolveRequiredWorkitemId(effective, proj, k)
    if (!resolved.ok) return resolved
    const updRes = await requestWorkitemUpdate(effective, proj.organizationId, resolved.workitemId, fields, GITLAB_READ_TIMEOUT_MS)
    if (!updRes.ok) return failYunxiao(updRes, updRes.stderr || updRes.stdout || '更新工作项失败', updRes, effective)
    const after = await fetchRawWorkitem(effective, proj, resolved.workitemId)
    if (!after.ok) { rememberYunxiaoIssueIdentity(proj.refId, { id: resolved.workitemId, key: resolved.key }); return { ok: false, error: after.error } }
    await enrichWorkitemComments(effective, proj, after.raw, after.workitemId, null)
    return { ok: true, data: normalizeYunxiaoIssue(after.raw, repo) }
  } catch (err: unknown) {
    return failYunxiao(err, errMsg(err), err, effective)
  }
}

export default { createIssue, closeIssue, reopenIssue, updateIssue }
