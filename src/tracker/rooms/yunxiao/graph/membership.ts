/**
 * src/tracker/rooms/yunxiao/graph/membership.ts —— Yunxiao Projex 父子挂载与认领指派路由（#03 实施 setAssignees，#04 实施 setParent）。
 *
 * 为什么 setParent 采用「文件头 DSH-PARENT + 原生 PARENT 关系优先 + 400 自动降级 ASSOCIATED」：
 *   1. 真机实测（Wayfinder #11）证实云效企业默认关系矩阵仅在 Req/Task 之间开启 PARENT/SUB 层级，
 *      而 Bug（缺陷）默认不支持原生 PARENT/SUB，调用 CreateWorkitemRelationRecord(PARENT) 会返回 HTTP 400
 *      （"无法创建此关系, 不满足关系对应的类型约束！"），但 ASSOCIATED（关联项）在全部 11 种类型间默认全通。
 *   2. 因此 setParent 先在子工作项正文文件头写入或移除 <!-- DSH-PARENT: <key> -->，再尝试通过
 *      CreateWorkitemRelationRecord(PARENT) 建立原生父子关系；若因企业默认矩阵限制返回 400，
 *      自动保留文件头 DSH-PARENT 并调用 CreateWorkitemRelationRecord(ASSOCIATED) 建立原生关联，
 *      使写后读回（edge-landing）与 listSubIssues 100% 成立。
 *   3. 更新工作项（UpdateWorkitem）的请求体永不携带 parentId 字段：真机实测（缺陷 02，MattDemo——维护者用于真机核验的云效项目——的 Task）
 *      对带 parentId 的更新毫秒级返回 400「workitem does not contains field : ["parentId"]」，
 *      而父子关系的原生写入由创建工作项（CreateWorkitem.parentId）与关系记录负责，更新里发它属冗余；
 *      这类被服务端明确拒绝的 400 由错误规则表归入 unsupported（回执 backend-unsupported），不再误报成超时。
 *   4. 换父（子工作项从父 A 切换到父 B）与写后读回直核：云效项目 MattDemo 真机实测证实停发 UpdateWorkitem.parentId 后，
 *      先调用 DeleteWorkitemRelationRecord(PARENT, A) 再调用 CreateWorkitemRelationRecord(PARENT, B) 会实时将
 *      GetWorkitem.parentId 与 idPath 同步为新父 B；写后读回除核对归一化 Issue.parentKey 外，还必须直核读回的
 *      原生 parentId 等于目标父项 ID（或降级关联时原生 parentId 已清空），防止 deriveYunxiaoParentKey 回退读取
 *      刚写入正文的 DSH-PARENT 标记而掩盖原生层未同步的故障。
 *
 * 为什么 setAssignees 以正文文件头 <!-- DSH-ASSIGNEES: ... --> 为契约真源：
 *   1. 真机实测证实 Yunxiao Projex 的 assignedTo 必填且不可清空（传 ""/null/"EMPTY_VALUE" 均报 400），
 *      而 participants 支持传 [] 清空为 null。
 *   2. 认领或释放时，setAssignees 先重写文件头 DSH-ASSIGNEES 标记，同时将认领人解析为云效用户 ID
 *      同步更新原生 assignedTo 与 participants（释放认领时将 participants 置为 []，原生 assignedTo 保持当前 PAT 用户），
 *      使 Deck 契约（未认领回 []）与云效网页端展示协同一致。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../../contract/entities.js'
import type { AssigneeInput, SetOpts } from '../../../contract/inputs.js'
import { TRACKER_ERROR_STAGE, type OpResult } from '../../../contract/results.js'
import { fail } from '../../../kernel/preflight.js'
import { GITLAB_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { failYunxiao, isRelationMatrixConstraintError } from '../errors.js'
import {
  classifyYunxiaoIssueInput,
  isSameYunxiaoIssueInput,
  normalizeYunxiaoParentId,
  parseHiddenParent,
  resolveYunxiaoWorkitemId,
  rewriteDescriptionWithAssignees,
  rewriteDescriptionWithHiddenParent,
} from '../model/description-markers.js'
import { bodyOfWorkitem, normalizeYunxiaoIssue } from '../model/normalize.js'
import {
  requestWorkitemRelationRecordCreate,
  requestWorkitemRelationRecordDelete,
  requestWorkitemRelationRecordsList,
  requestWorkitemUpdate,
} from '../requests.js'
import {
  checkExpectedUpdatedAt,
  errMsg,
  extractAssigneeLogins,
  extractRelationWorkitemId,
  fetchRawWorkitem,
  resolveProjectRef,
  resolveRequiredWorkitemId,
  type CtxLike,
  type RawBag,
  type RepoLike,
  type ResolvedProjectRef,
} from '../issues/shared.js'
import { resolveNativeUserIdsForAssignees } from '../issues/write.js'

export { isRelationMatrixConstraintError }

/** 收集工作项当前可能绑定的旧父工作项 26 位 ID 集合（含原生 parentId、文件头 DSH-PARENT，以及必要时子工作项上的 PARENT 关系记录）。 */
async function collectCurrentParentWorkitemIds(
  opCtx: CtxLike | null | undefined,
  proj: ResolvedProjectRef,
  child: { workitemId: string; raw: RawBag },
  opts?: { probeRelationRecords?: boolean },
): Promise<string[]> {
  const ids: string[] = []
  const addId = (id: string | null | undefined) => {
    const trimmed = typeof id === 'string' ? id.trim() : ''
    if (trimmed && !ids.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) ids.push(trimmed)
  }
  addId(normalizeYunxiaoParentId(child.raw['parentId']))
  const hiddenParent = parseHiddenParent(bodyOfWorkitem(child.raw))
  if (hiddenParent) {
    const cached = resolveYunxiaoWorkitemId(proj.refId, hiddenParent)
    if (cached) {
      addId(cached)
    } else {
      const resolved = await resolveRequiredWorkitemId(opCtx, proj, hiddenParent)
      if (resolved.ok) addId(resolved.workitemId)
    }
  }
  if (opts?.probeRelationRecords) {
    try {
      const relRes = await requestWorkitemRelationRecordsList(
        opCtx,
        proj.organizationId,
        child.workitemId,
        'PARENT',
        GITLAB_READ_TIMEOUT_MS,
      )
      if (relRes.ok && Array.isArray(relRes.data)) {
        for (const rec of relRes.data) {
          addId(extractRelationWorkitemId(rec))
        }
      }
    } catch {
      /* 探测旧父关系记录属兜底补充，接口异常时不阻断主流程，后续写后读回仍会严格核对原生 parentId */
    }
  }
  return ids
}

/** 尽力清理子工作项到旧父工作项的原生 PARENT 与 ASSOCIATED 关系记录。 */
async function removeNativeParentRelations(
  opCtx: CtxLike | null | undefined,
  proj: ResolvedProjectRef,
  childWorkitemId: string,
  oldParentIds: readonly string[],
): Promise<void> {
  for (const oldPid of oldParentIds) {
    try {
      await requestWorkitemRelationRecordDelete(
        opCtx,
        proj.organizationId,
        childWorkitemId,
        'PARENT',
        oldPid,
        GITLAB_READ_TIMEOUT_MS,
      )
    } catch {
      /* best-effort */
    }
    try {
      await requestWorkitemRelationRecordDelete(
        opCtx,
        proj.organizationId,
        childWorkitemId,
        'ASSOCIATED',
        oldPid,
        GITLAB_READ_TIMEOUT_MS,
      )
    } catch {
      /* best-effort */
    }
  }
}

/**
 * 设置或移除工作项的父工作项（契约操作 setParent）。
 *
 * 规则：
 *   1. 自环校验：parentKey 与 key 指向同一张票时立即返回 conflict（INPUT_REFUSED）；
 *   2. 绑定父项时：先验证父工作项存在并拿到其纯数字 key 与 26 位 workitemId，
 *      写入文件头 <!-- DSH-PARENT: <key> --> 并建立原生 PARENT 关系记录；
 *      若企业默认关系矩阵拒绝原生 PARENT（如 Bug 类型返回 400），自动保留 DSH-PARENT 并建立 ASSOCIATED 关联；
 *      更新请求体永不携带 parentId 字段（真机实测缺陷 02：UpdateWorkitem 对 Task 拒绝该字段），
 *      原生父子关系由创建工作项时的 parentId 与关系记录负责；读回的原生 parentId 已等于目标父票、
 *      且正文标记无需改写时（同父重复设置），更新请求与关系创建都跳过；
 *   3. 解除父项（parentKey === null）时：移除文件头 DSH-PARENT，并清理原生 PARENT / ASSOCIATED 关系，
 *      解除用的更新请求同样不带 parentId 字段；
 *   4. 写后读回核对：读回的原生 parentId（建立原生 PARENT 时须等于目标父项 ID，降级 ASSOCIATED 时须已清空）
 *      与归一化后的 Issue.parentKey 均须与期望值一致，否则返回 conflict。
 */
export async function setParent(
  ctx: BackendContext,
  repo: RepositoryRef,
  key: string,
  parentKey: string | null,
  opts: SetOpts | undefined,
  opCtx: OpContext,
): Promise<OpResult<Issue>> {
  const effective = (opCtx || ctx) as CtxLike
  const proj = resolveProjectRef(repo as RepoLike)
  if (!proj) {
    return fail(ERROR_KIND.NOTFOUND as ErrorKind, 'setParent: repo.refId 缺失或格式不是 organizationId/projectId', '')
  }
  const k = String(key == null ? '' : key).trim()
  if (!k || !classifyYunxiaoIssueInput(k)) {
    return fail(ERROR_KIND.PARSE as ErrorKind, 'setParent: 工作项编号不能为空或格式非法', k, TRACKER_ERROR_STAGE.INPUT_REFUSED)
  }

  const rawParentInput = parentKey === null || parentKey === undefined ? '' : String(parentKey).trim()
  if (rawParentInput !== '' && !classifyYunxiaoIssueInput(rawParentInput)) {
    return fail(
      ERROR_KIND.PARSE as ErrorKind,
      'setParent: 父工作项编号格式非法：' + rawParentInput,
      rawParentInput,
      TRACKER_ERROR_STAGE.INPUT_REFUSED,
    )
  }

  try {
    const childFetched = await fetchRawWorkitem(effective, proj, k)
    if (!childFetched.ok) return { ok: false, error: childFetched.error }

    const conflict = checkExpectedUpdatedAt(opts, childFetched.raw)
    if (conflict) return conflict

    const oldBody = bodyOfWorkitem(childFetched.raw)

    /** 把正文文件头 DSH-PARENT 标记的改写落盘。请求体只有 description 与 formatType，永不带 parentId：
     * 真机实测（缺陷 02）UpdateWorkitem 对 Task 类工作项毫秒级拒绝 parentId 字段，原生父子关系由创建工作项
     * 与关系记录负责，更新里发它属冗余（见文件头第 3 条）。正文无需改写时调用方自行跳过本函数；
     * 失败按云效判档返回该失败，成功返回 null。 */
    const putDescriptionMarker = async (newBody: string, failureMessage: string): Promise<OpResult<Issue> | null> => {
      const updRes = await requestWorkitemUpdate(
        effective,
        proj.organizationId,
        childFetched.workitemId,
        { description: newBody, formatType: 'MARKDOWN' },
        GITLAB_READ_TIMEOUT_MS,
      )
      return updRes.ok ? null : failYunxiao(updRes, updRes.stderr || updRes.stdout || failureMessage, updRes, effective)
    }

    /** 写后重读子工作项，核对原生 parentId 与归一化后的 Issue.parentKey 均符合预期。 */
    const readBackAndVerifyParent = async (
      newBody: string,
      expectedParentKey: string | null,
      expectedNativeParentId: string | null,
    ): Promise<OpResult<Issue>> => {
      const after = await fetchRawWorkitem(effective, proj, childFetched.workitemId)
      const finalRaw: RawBag = after.ok
        ? after.raw
        : { ...childFetched.raw, description: newBody, parentId: expectedNativeParentId || '' }
      if (after.ok) {
        const readbackNativeParentId = normalizeYunxiaoParentId(after.raw['parentId'])
        if (expectedNativeParentId) {
          if (!readbackNativeParentId || readbackNativeParentId.toLowerCase() !== expectedNativeParentId.toLowerCase()) {
            return fail(
              ERROR_KIND.CONFLICT as ErrorKind,
              'conflict: 父工作项写后读回原生 parentId 不一致（期望 ' + expectedNativeParentId + '，实际 ' + (readbackNativeParentId || '无') + '）',
              JSON.stringify(finalRaw),
            )
          }
        } else if (readbackNativeParentId !== null) {
          return fail(
            ERROR_KIND.CONFLICT as ErrorKind,
            expectedParentKey === null
              ? 'conflict: 解除父工作项后读回仍残留原生 parentId（实际 ' + readbackNativeParentId + '）'
              : 'conflict: 父工作项降级为关联关系后读回仍残留原生 parentId（实际 ' + readbackNativeParentId + '）',
            JSON.stringify(finalRaw),
          )
        }
      }
      const updatedIssue = normalizeYunxiaoIssue(finalRaw, repo)
      if (updatedIssue.parentKey !== expectedParentKey) {
        return fail(
          ERROR_KIND.CONFLICT as ErrorKind,
          expectedParentKey === null
            ? 'conflict: 解除父工作项后读回核对不一致（期望 无，实际 #' + updatedIssue.parentKey + '）'
            : 'conflict: 父工作项写后读回核对不一致（期望 #' + expectedParentKey + '，实际 ' + (updatedIssue.parentKey ? '#' + updatedIssue.parentKey : '无') + '）',
          JSON.stringify(finalRaw),
        )
      }
      return { ok: true, data: updatedIssue }
    }

    if (rawParentInput === '') {
      const oldParentIds = await collectCurrentParentWorkitemIds(
        effective,
        proj,
        childFetched,
        { probeRelationRecords: true },
      )
      const newBody = rewriteDescriptionWithHiddenParent(oldBody, null)
      // 原生父子关系的解除由下方关系记录删除负责，这条更新请求只负责移除正文文件头 DSH-PARENT 标记
      // （请求体不带 parentId 的不变式见 putDescriptionMarker 与文件头第 3 条）。
      // 正文标记本就干净的幂等解除连这条更新请求也不发。
      await removeNativeParentRelations(effective, proj, childFetched.workitemId, oldParentIds)
      if (newBody !== oldBody) {
        const putFailure = await putDescriptionMarker(newBody, '解除父工作项失败')
        if (putFailure) return putFailure
      }
      return readBackAndVerifyParent(newBody, null, null)
    }

    // 先快速自环判断（若入参直接相等或归一化数字票号相等）
    if (
      isSameYunxiaoIssueInput(rawParentInput, k) ||
      isSameYunxiaoIssueInput(rawParentInput, childFetched.key) ||
      isSameYunxiaoIssueInput(rawParentInput, childFetched.workitemId)
    ) {
      return fail(
        ERROR_KIND.CONFLICT as ErrorKind,
        'conflict: self-parent（不能将工作项 #' + childFetched.key + ' 设为自己的父项）',
        JSON.stringify({ key: childFetched.key, parentKey: rawParentInput }),
        TRACKER_ERROR_STAGE.INPUT_REFUSED,
      )
    }

    const parentResolved = await resolveRequiredWorkitemId(effective, proj, rawParentInput)
    if (!parentResolved.ok) return parentResolved
    if (
      parentResolved.key === childFetched.key ||
      parentResolved.workitemId.toLowerCase() === childFetched.workitemId.toLowerCase()
    ) {
      return fail(
        ERROR_KIND.CONFLICT as ErrorKind,
        'conflict: self-parent（不能将工作项 #' + childFetched.key + ' 设为自己的父项）',
        JSON.stringify({ key: childFetched.key, parentKey: parentResolved.key }),
        TRACKER_ERROR_STAGE.INPUT_REFUSED,
      )
    }

    const wantParentKey = parentResolved.key
    const wantParentId = parentResolved.workitemId
    const newBody = rewriteDescriptionWithHiddenParent(oldBody, wantParentKey)
    const nativeParentId = normalizeYunxiaoParentId(childFetched.raw['parentId'])
    const parentAlreadyNative = nativeParentId !== null && nativeParentId.toLowerCase() === wantParentId.toLowerCase()

    // 若此前挂在别的父项下（或当前尚未原生指向目标父项，需兼顾已存在的 PARENT 关系记录），先移除旧父关系
    const oldParentIds = await collectCurrentParentWorkitemIds(
      effective,
      proj,
      childFetched,
      { probeRelationRecords: !parentAlreadyNative },
    )
    const staleOldParents = oldParentIds.filter((id) => id.toLowerCase() !== wantParentId.toLowerCase())
    if (staleOldParents.length > 0) {
      await removeNativeParentRelations(effective, proj, childFetched.workitemId, staleOldParents)
    }

    // 1) 更新正文文件头 DSH-PARENT 标记（请求体不带 parentId 的不变式见 putDescriptionMarker）。
    //    正文标记无需改写时（同父重复设置的幂等场景）连这条更新请求也不发。
    if (newBody !== oldBody) {
      const putFailure = await putDescriptionMarker(newBody, '写入父工作项标记失败')
      if (putFailure) return putFailure
    }

    // 2) 优先尝试建立原生 PARENT 关系记录；若因企业默认矩阵限制返回 400，则自动降级建立原生 ASSOCIATED 关联。
    //    读回的原生 parentId 已等于目标父票时原生父子关系已经成立（重复补写正是缺陷 02 的现场），
    //    不再重复创建关系记录，避免同一条 PARENT 关系被写第二遍。
    // 原生父关系最终是否指向目标父票（读回直核与读回失败拼兜底 raw 共用）：同父跳过补写视为已成立，
    // 新建 PARENT 关系成功时成立，矩阵约束降级成 ASSOCIATED 时不成立（原生 parentId 未被这次写入改动）。
    let nativeParentEstablished = parentAlreadyNative
    if (!parentAlreadyNative) {
      const relRes = await requestWorkitemRelationRecordCreate(
        effective,
        proj.organizationId,
        childFetched.workitemId,
        'PARENT',
        wantParentId,
        GITLAB_READ_TIMEOUT_MS,
      )
      if (!relRes.ok) {
        if (isRelationMatrixConstraintError(relRes)) {
          const assocRes = await requestWorkitemRelationRecordCreate(
            effective,
            proj.organizationId,
            childFetched.workitemId,
            'ASSOCIATED',
            wantParentId,
            GITLAB_READ_TIMEOUT_MS,
          )
          if (!assocRes.ok && !isRelationMatrixConstraintError(assocRes)) {
            return failYunxiao(assocRes, assocRes.stderr || assocRes.stdout || '建立父子降级关联关系失败', assocRes, effective)
          }
        } else {
          return failYunxiao(relRes, relRes.stderr || relRes.stdout || '建立原生父子关系失败', relRes, effective)
        }
      }
      nativeParentEstablished = relRes.ok
    }

    return readBackAndVerifyParent(newBody, wantParentKey, nativeParentEstablished ? wantParentId : null)
  } catch (err: unknown) {
    return failYunxiao(err, errMsg(err), err, effective)
  }
}

/**
 * 覆盖式更新工作项认领人（契约操作 setAssignees）。
 */
export async function setAssignees(
  ctx: BackendContext,
  repo: RepositoryRef,
  key: string,
  assignees: AssigneeInput[],
  opts: SetOpts | undefined,
  opCtx: OpContext,
): Promise<OpResult<Issue>> {
  const effective = (opCtx || ctx) as CtxLike
  const proj = resolveProjectRef(repo as RepoLike)
  if (!proj) {
    return fail(ERROR_KIND.NOTFOUND as ErrorKind, 'setAssignees: repo.refId 缺失或格式不是 organizationId/projectId', '')
  }
  const k = String(key == null ? '' : key).trim()
  if (!k || !classifyYunxiaoIssueInput(k)) {
    return fail(ERROR_KIND.PARSE as ErrorKind, 'setAssignees: 工作项编号不能为空或格式非法', k, TRACKER_ERROR_STAGE.INPUT_REFUSED)
  }

  const wanted = extractAssigneeLogins(assignees)
  try {
    const fetched = await fetchRawWorkitem(effective, proj, k)
    if (!fetched.ok) return { ok: false, error: fetched.error }

    const conflict = checkExpectedUpdatedAt(opts, fetched.raw)
    if (conflict) return conflict

    const oldBody = bodyOfWorkitem(fetched.raw)
    const newBody = rewriteDescriptionWithAssignees(oldBody, wanted)
    const userResolved = await resolveNativeUserIdsForAssignees(effective, proj, wanted)
    if (!userResolved.ok) return userResolved

    const updateFields: Record<string, unknown> = {
      description: newBody,
      formatType: 'MARKDOWN',
      assignedTo: userResolved.primaryUserId,
      participants: wanted.length > 0 ? userResolved.participantIds : [],
    }

    const updRes = await requestWorkitemUpdate(
      effective,
      proj.organizationId,
      fetched.workitemId,
      updateFields,
      GITLAB_READ_TIMEOUT_MS,
    )
    if (!updRes.ok) {
      return failYunxiao(updRes, updRes.stderr || updRes.stdout || '更新工作项认领人失败', updRes, effective)
    }

    const after = await fetchRawWorkitem(effective, proj, fetched.workitemId)
    if (!after.ok) {
      const fallbackRaw: RawBag = { ...fetched.raw, description: newBody }
      return { ok: true, data: normalizeYunxiaoIssue(fallbackRaw, repo) }
    }
    return { ok: true, data: normalizeYunxiaoIssue(after.raw, repo) }
  } catch (err: unknown) {
    return failYunxiao(err, errMsg(err), err, effective)
  }
}

export default { setParent, setAssignees }
