/**
 * src/tracker/rooms/yunxiao/graph/write.ts —— Yunxiao Projex 阻塞依赖关系写入路由（规格 #04）。
 *
 * 为什么采用「写前图环检测 + 原生 DEPEND_ON 优先 + 400 自动回退成对正文标记与 ASSOCIATED 关联」：
 *   1. 写阻塞边前必须先拦下自环与有向图环（cycle detection），防止把依赖图写成死锁环；
 *   2. 优先尝试通过 CreateWorkitemRelationRecord(relationType="DEPEND_ON") 建立云效原生依赖关系；
 *      若企业已开启 DEPEND_ON，则清除正文旧阻塞标记（使正文中不出现 Blocked by: #n），写后读回时
 *      edge-landing 判定为 native（落在后端原生边上）；
 *   3. 若企业默认关系矩阵拒绝 DEPEND_ON（返回 HTTP 400 "无法创建此关系, 不满足关系对应的类型约束！"），
 *      则自动回退在工作项描述文件头成对写入可见行 Blocked by: #n 与隐藏机器表 <!-- DSH-BLOCKED-BY: n -->，
 *      同时调用 CreateWorkitemRelationRecord(relationType="ASSOCIATED") 建立云效原生关联关系，
 *      使云效 Web 端关系全景图可见且 100% 通过 edge-landing 的写后读回核对（body-line）。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../../contract/entities.js'
import type { SetOpts } from '../../../contract/inputs.js'
import { TRACKER_ERROR_STAGE, type OpResult, type TrackerError } from '../../../contract/results.js'
import { fail } from '../../../kernel/preflight.js'
import { GITLAB_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { errMsg, failYunxiao, isRelationMatrixConstraintError } from '../errors.js'
import {
  classifyYunxiaoIssueInput, isSameYunxiaoIssueInput, parseBlockedByFallback, resolveYunxiaoIssueKey, rewriteDescriptionWithBlockedPair,
} from '../model/description-markers.js'
import { bodyOfWorkitem, normalizeYunxiaoIssue } from '../model/normalize.js'
import {
  requestWorkitemRelationRecordCreate, requestWorkitemRelationRecordDelete, requestWorkitemUpdate,
} from '../requests.js'
import {
  checkExpectedUpdatedAt, fetchRawWorkitem, resolveProjectRef, resolveRequiredWorkitemId,
  type CtxLike, type RawBag, type RepoLike, type ResolvedProjectRef,
} from '../issues/shared.js'
import { probeNativeRelationTargets, resolveIssueRefsWithState, scanProjectBlockingSnapshot } from './read.js'

/** 在阻塞邻接表上应用拟写入的边（startKey -> newBlockers）后执行 DFS 环检测。 */
export function hasBlockingCycle(allBlockedByMap: Map<string, string[]>, startKey: string, newBlockers: readonly string[]): boolean {
  const graph = new Map<string, string[]>()
  for (const [k, v] of allBlockedByMap.entries()) graph.set(k, [...v])
  graph.set(startKey, [...newBlockers])
  const visited = new Set<string>()
  const onStack = new Set<string>()
  const dfs = (node: string): boolean => {
    if (onStack.has(node)) return true
    if (visited.has(node)) return false
    visited.add(node)
    onStack.add(node)
    for (const nb of graph.get(node) || []) { if (dfs(nb)) return true }
    onStack.delete(node)
    return false
  }
  for (const k of graph.keys()) { if (dfs(k)) return true }
  return false
}

/** 构建用于写前环检的完整阻塞图（合并项目快照与沿边可达节点的原生 DEPEND_ON 及正文标记）。 */
async function buildCycleCheckGraph(
  opCtx: CtxLike | null | undefined, proj: ResolvedProjectRef, repo: RepoLike, wantedKeys: readonly string[],
): Promise<{ graph: Map<string, string[]>; knownRaw: Map<string, RawBag> }> {
  const snapshot = await scanProjectBlockingSnapshot(opCtx, proj, repo)
  const { blockedByMap: graph, knownRaw } = snapshot
  const seen = new Set<string>()
  const stack = [...wantedKeys]
  while (stack.length > 0) {
    const curKey = stack.pop()!
    if (seen.has(curKey)) continue
    seen.add(curKey)
    if (graph.has(curKey)) {
      for (const nextKey of graph.get(curKey) || []) { if (!seen.has(nextKey)) stack.push(nextKey) }
      continue
    }
    let raw = knownRaw.get(curKey)
    let workitemId = raw && typeof raw['id'] === 'string' ? raw['id'].trim() : ''
    if (!raw || !workitemId) {
      const fetched = await fetchRawWorkitem(opCtx, proj, curKey)
      if (fetched.ok) {
        raw = fetched.raw; workitemId = fetched.workitemId
        knownRaw.set(fetched.key, fetched.raw); knownRaw.set(fetched.workitemId.toLowerCase(), fetched.raw)
      }
    }
    const fromBody = raw ? parseBlockedByFallback(bodyOfWorkitem(raw)) || [] : []
    const nativeKeys: string[] = []
    if (workitemId) {
      const probe = await probeNativeRelationTargets(opCtx, proj, workitemId, 'DEPEND_ON')
      if (!probe.probeFailed) {
        for (const tid of probe.targetIds) {
          let k = resolveYunxiaoIssueKey(proj.refId, tid) || ''
          if (!k) { const r = await resolveRequiredWorkitemId(opCtx, proj, tid); if (r.ok) k = r.key }
          if (k && !nativeKeys.includes(k)) nativeKeys.push(k)
        }
      }
    }
    const merged = [...new Set([...(graph.get(curKey) || []), ...fromBody, ...nativeKeys])]
    graph.set(curKey, merged)
    for (const nextKey of merged) { if (!seen.has(nextKey)) stack.push(nextKey) }
  }
  return { graph, knownRaw }
}

/** 尝试使用原生 DEPEND_ON 关系记录写入阻塞边；若遇到企业关系矩阵 400 限制则回滚本轮新增并返回 fallback: true。 */
async function tryWriteNativeDependOn(
  opCtx: CtxLike | null | undefined, proj: ResolvedProjectRef, selfWorkitemId: string,
  wantedWorkitemIds: readonly string[], currentDependOnIds: readonly string[],
): Promise<{ ok: true } | { ok: false; fallback: true } | { ok: false; fallback: false; error: TrackerError }> {
  const currentLower = new Set(currentDependOnIds.map((id) => id.toLowerCase()))
  const wantedLower = new Set(wantedWorkitemIds.map((id) => id.toLowerCase()))
  const addedIds: string[] = []
  for (const targetId of wantedWorkitemIds) {
    if (currentLower.has(targetId.toLowerCase())) continue
    const createRes = await requestWorkitemRelationRecordCreate(opCtx, proj.organizationId, selfWorkitemId, 'DEPEND_ON', targetId, GITLAB_READ_TIMEOUT_MS)
    if (!createRes.ok) {
      if (isRelationMatrixConstraintError(createRes)) {
        for (const added of addedIds) {
          try { await requestWorkitemRelationRecordDelete(opCtx, proj.organizationId, selfWorkitemId, 'DEPEND_ON', added, GITLAB_READ_TIMEOUT_MS) } catch { /* rollback */ }
        }
        return { ok: false, fallback: true }
      }
      return { ok: false, fallback: false, error: failYunxiao(createRes, createRes.stderr || createRes.stdout || '创建原生 DEPEND_ON 阻塞关系失败', createRes, opCtx ?? undefined).error }
    }
    addedIds.push(targetId)
  }
  for (const curId of currentDependOnIds) {
    if (wantedLower.has(curId.toLowerCase())) continue
    const delRes = await requestWorkitemRelationRecordDelete(opCtx, proj.organizationId, selfWorkitemId, 'DEPEND_ON', curId, GITLAB_READ_TIMEOUT_MS)
    if (!delRes.ok && !isRelationMatrixConstraintError(delRes)) {
      return { ok: false, fallback: false, error: failYunxiao(delRes, delRes.stderr || delRes.stdout || '删除原生 DEPEND_ON 阻塞关系失败', delRes, opCtx ?? undefined).error }
    }
  }
  return { ok: true }
}

/** 在回退路径下同步 ASSOCIATED 关联关系记录（使云效关系全景图可见，且删除已移除的旧阻塞关联）。 */
async function syncFallbackAssociatedRelations(
  opCtx: CtxLike | null | undefined, proj: ResolvedProjectRef, selfWorkitemId: string,
  wantedWorkitemIds: readonly string[], previousBlockerWorkitemIds: readonly string[],
): Promise<void> {
  const wantedLower = new Set(wantedWorkitemIds.map((id) => id.toLowerCase()))
  for (const targetId of wantedWorkitemIds) {
    try { await requestWorkitemRelationRecordCreate(opCtx, proj.organizationId, selfWorkitemId, 'ASSOCIATED', targetId, GITLAB_READ_TIMEOUT_MS) } catch { /* best-effort */ }
  }
  for (const oldId of previousBlockerWorkitemIds) {
    if (wantedLower.has(oldId.toLowerCase())) continue
    try { await requestWorkitemRelationRecordDelete(opCtx, proj.organizationId, selfWorkitemId, 'ASSOCIATED', oldId, GITLAB_READ_TIMEOUT_MS) } catch { /* best-effort */ }
  }
}

/** 覆盖式设置工作项的阻塞依赖列表（契约操作 setBlockedBy）。 */
export async function setBlockedBy(
  ctx: BackendContext, repo: RepositoryRef, key: string, blockers: string[], opts: SetOpts | undefined, opCtx: OpContext,
): Promise<OpResult<Issue>> {
  const effective = (opCtx || ctx) as CtxLike
  const proj = resolveProjectRef(repo as RepoLike)
  if (!proj) return fail(ERROR_KIND.NOTFOUND as ErrorKind, 'setBlockedBy: repo.refId 缺失或格式不是 organizationId/projectId', '')
  const k = String(key == null ? '' : key).trim()
  if (!k || !classifyYunxiaoIssueInput(k)) {
    return fail(ERROR_KIND.PARSE as ErrorKind, 'setBlockedBy: 工作项编号不能为空或格式非法', k, TRACKER_ERROR_STAGE.INPUT_REFUSED)
  }
  const rawBlockers = Array.isArray(blockers) ? [...new Set(blockers.map((b) => String(b == null ? '' : b).trim()).filter(Boolean))] : []
  for (const rb of rawBlockers) {
    if (!classifyYunxiaoIssueInput(rb)) {
      return fail(ERROR_KIND.PARSE as ErrorKind, 'setBlockedBy: 阻塞项编号格式非法：' + rb, rb, TRACKER_ERROR_STAGE.INPUT_REFUSED)
    }
  }
  for (const rb of rawBlockers) {
    if (isSameYunxiaoIssueInput(k, rb)) {
      return fail(ERROR_KIND.CONFLICT as ErrorKind, 'conflict: self-loop ' + k, JSON.stringify({ key: k, blockers: rawBlockers }), TRACKER_ERROR_STAGE.INPUT_REFUSED)
    }
  }

  try {
    const selfFetched = await fetchRawWorkitem(effective, proj, k)
    if (!selfFetched.ok) return { ok: false, error: selfFetched.error }
    const conflict = checkExpectedUpdatedAt(opts, selfFetched.raw)
    if (conflict) return conflict
    const { key: selfKey, workitemId: selfId } = selfFetched

    const wantedKeys: string[] = []
    const wantedIds: string[] = []
    for (const rb of rawBlockers) {
      const resolved = await resolveRequiredWorkitemId(effective, proj, rb)
      if (!resolved.ok) return resolved
      if (resolved.key === selfKey || resolved.workitemId.toLowerCase() === selfId.toLowerCase()) {
        return fail(ERROR_KIND.CONFLICT as ErrorKind, 'conflict: self-loop ' + selfKey, JSON.stringify({ key: selfKey, blockers: rawBlockers }), TRACKER_ERROR_STAGE.INPUT_REFUSED)
      }
      if (!wantedKeys.includes(resolved.key)) { wantedKeys.push(resolved.key); wantedIds.push(resolved.workitemId) }
    }

    const { graph, knownRaw } = await buildCycleCheckGraph(effective, proj, repo, wantedKeys)
    if (hasBlockingCycle(graph, selfKey, wantedKeys)) {
      return fail(ERROR_KIND.CONFLICT as ErrorKind, 'conflict: cycle detected for #' + selfKey + ' -> [' + wantedKeys.join(', ') + ']', JSON.stringify({ key: selfKey, wanted: wantedKeys, observed: Array.from(graph.entries()) }), TRACKER_ERROR_STAGE.INPUT_REFUSED)
    }

    const oldBody = bodyOfWorkitem(selfFetched.raw)
    const oldBodyBlockerKeys = parseBlockedByFallback(oldBody) || []
    const oldBodyBlockerIds: string[] = []
    for (const obk of oldBodyBlockerKeys) {
      const r = await resolveRequiredWorkitemId(effective, proj, obk)
      if (r.ok && !oldBodyBlockerIds.includes(r.workitemId)) oldBodyBlockerIds.push(r.workitemId)
    }

    const nativeProbe = await probeNativeRelationTargets(effective, proj, selfId, 'DEPEND_ON')
    let usedNative = false
    if (!nativeProbe.probeFailed && (wantedIds.length > 0 || nativeProbe.targetIds.length > 0)) {
      const nativeWrite = await tryWriteNativeDependOn(effective, proj, selfId, wantedIds, nativeProbe.targetIds)
      if (!nativeWrite.ok && !nativeWrite.fallback) return { ok: false, error: nativeWrite.error }
      if (nativeWrite.ok) usedNative = true
    }

    if (usedNative) {
      const cleanedBody = rewriteDescriptionWithBlockedPair(oldBody, [])
      if (cleanedBody !== oldBody) {
        const cleanUpd = await requestWorkitemUpdate(effective, proj.organizationId, selfId, { description: cleanedBody, formatType: 'MARKDOWN' }, GITLAB_READ_TIMEOUT_MS)
        if (!cleanUpd.ok) return failYunxiao(cleanUpd, cleanUpd.stderr || cleanUpd.stdout || '清理旧正文阻塞标记失败', cleanUpd, effective)
      }
      if (oldBodyBlockerIds.length > 0) {
        await syncFallbackAssociatedRelations(effective, proj, selfId, [], oldBodyBlockerIds)
      }
      const backProbe = await probeNativeRelationTargets(effective, proj, selfId, 'DEPEND_ON')
      if (backProbe.probeFailed) {
        return fail(ERROR_KIND.CONFLICT as ErrorKind, 'conflict: 原生 DEPEND_ON 写后读回失败', JSON.stringify({ key: selfKey, wanted: wantedKeys }))
      }
      const backLower = new Set(backProbe.targetIds.map((id) => id.toLowerCase()))
      const wantedLower = new Set(wantedIds.map((id) => id.toLowerCase()))
      const missingNative = wantedKeys.filter((_, idx) => !backLower.has(wantedIds[idx].toLowerCase()))
      const extraNative = backProbe.targetIds.filter((tid) => !wantedLower.has(tid.toLowerCase()))
      if (missingNative.length > 0 || extraNative.length > 0) {
        return fail(ERROR_KIND.CONFLICT as ErrorKind, 'conflict: 原生 DEPEND_ON 写后读回不一致（missing ' + (missingNative.join(', ') || '无') + ', extra ' + (extraNative.join(', ') || '无') + '）', JSON.stringify({ key: selfKey, wanted: wantedKeys, backIds: backProbe.targetIds }))
      }
      const afterNative = await fetchRawWorkitem(effective, proj, selfId)
      const issue = normalizeYunxiaoIssue(afterNative.ok ? afterNative.raw : { ...selfFetched.raw, description: cleanedBody }, repo)
      issue.blockedBy = await resolveIssueRefsWithState(effective, proj, wantedKeys, knownRaw)
      return { ok: true, data: issue }
    }

    const newBody = rewriteDescriptionWithBlockedPair(oldBody, wantedKeys)
    if (newBody !== oldBody) {
      const putRes = await requestWorkitemUpdate(effective, proj.organizationId, selfId, { description: newBody, formatType: 'MARKDOWN' }, GITLAB_READ_TIMEOUT_MS)
      if (!putRes.ok) return failYunxiao(putRes, putRes.stderr || putRes.stdout || '写入阻塞依赖正文标记失败', putRes, effective)
    }
    await syncFallbackAssociatedRelations(effective, proj, selfId, wantedIds, oldBodyBlockerIds)

    const afterFallback = await fetchRawWorkitem(effective, proj, selfId)
    const issue = normalizeYunxiaoIssue(afterFallback.ok ? afterFallback.raw : { ...selfFetched.raw, description: newBody }, repo)
    issue.blockedBy = await resolveIssueRefsWithState(effective, proj, wantedKeys, knownRaw)
    const writtenKeys = issue.blockedBy.map((b) => b.key)
    const missing = wantedKeys.filter((w) => !writtenKeys.includes(w))
    const extra = writtenKeys.filter((w) => !wantedKeys.includes(w))
    if (missing.length > 0 || extra.length > 0) {
      return fail(ERROR_KIND.CONFLICT as ErrorKind, 'conflict: 阻塞依赖写后读回核对不一致（missing ' + (missing.join(', ') || '无') + ', extra ' + (extra.join(', ') || '无') + '）', JSON.stringify({ key: selfKey, wanted: wantedKeys, written: writtenKeys }))
    }
    return { ok: true, data: issue }
  } catch (err: unknown) {
    return failYunxiao(err, errMsg(err), err, effective)
  }
}

export default { setBlockedBy }
