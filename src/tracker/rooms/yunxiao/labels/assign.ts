/**
 * src/tracker/rooms/yunxiao/labels/assign.ts —— Yunxiao Projex 工作项标签覆盖指派路由（规格 #03）。
 *
 * 核心行为：
 *   1. 支持 expectedUpdatedAt 乐观并发前置校验；
 *   2. 将传入的标签名（或带色对象）经 ensureProjectLabelIdsForWrite 对齐到项目标签 ID（不存在时自动调用 CreateLabel 创建，失败如实报错）；
 *   3. 按工作项类型字段配置（GetWorkitemTypeFieldConfig）识别标签字段标识（优先取匹配的 identifier || id，默认回退 labels），
 *      并通过 UpdateWorkitem 整集替换工作项标签（支持传 [] 清空标签）。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../../contract/entities.js'
import type { LabelInput, SetOpts } from '../../../contract/inputs.js'
import { TRACKER_ERROR_STAGE, type OpResult } from '../../../contract/results.js'
import { fail } from '../../../kernel/preflight.js'
import { GITLAB_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { asRecord, failYunxiao } from '../errors.js'
import { normalizeYunxiaoIssue } from '../model/normalize.js'
import { requestWorkitemFieldConfig, requestWorkitemUpdate } from '../requests.js'
import {
  checkExpectedUpdatedAt,
  ensureProjectLabelIdsForWrite,
  errMsg,
  fetchRawWorkitem,
  normalizeLabelInputs,
  resolveProjectRef,
  type CtxLike,
  type RawBag,
  type RepoLike,
} from '../issues/shared.js'

function extractLabelFieldKey(fieldData: unknown): string {
  if (!Array.isArray(fieldData)) return 'labels'
  for (const item of fieldData) {
    const bag = asRecord(item)
    if (!bag) continue
    const cls = typeof bag['className'] === 'string' ? bag['className'].trim().toLowerCase() : ''
    const id = typeof bag['id'] === 'string' ? bag['id'].trim() : ''
    const identifier = typeof bag['identifier'] === 'string' ? bag['identifier'].trim() : ''
    if (cls === 'tag' || id === 'tag' || id === 'labels' || identifier === 'labels' || identifier === 'tag') {
      return identifier || id || 'labels'
    }
  }
  return 'labels'
}

/** 整集替换工作项标签（契约操作 setLabels）：支持自动创建缺失标签与传空数组清空标签。 */
export async function setLabels(
  ctx: BackendContext,
  repo: RepositoryRef,
  key: string,
  labels: LabelInput[],
  opts: SetOpts | undefined,
  opCtx: OpContext,
): Promise<OpResult<Issue>> {
  const effective = (opCtx || ctx) as CtxLike
  const proj = resolveProjectRef(repo as RepoLike)
  if (!proj) {
    return fail(ERROR_KIND.NOTFOUND as ErrorKind, 'setLabels: repo.refId 缺失或格式不是 organizationId/projectId', '')
  }
  const k = String(key == null ? '' : key).trim()
  if (!k) {
    return fail(ERROR_KIND.PARSE as ErrorKind, 'setLabels: 工作项编号不能为空', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  }

  const wanted = normalizeLabelInputs(labels)
  try {
    const fetched = await fetchRawWorkitem(effective, proj, k)
    if (!fetched.ok) return { ok: false, error: fetched.error }

    const conflict = checkExpectedUpdatedAt(opts, fetched.raw)
    if (conflict) return conflict

    let labelFieldKey = 'labels'
    const wtBag = asRecord(fetched.raw['workitemType'])
    const workitemTypeId = wtBag && typeof wtBag['id'] === 'string' ? wtBag['id'].trim() : ''
    if (workitemTypeId) {
      try {
        const fcRes = await requestWorkitemFieldConfig(effective, proj.organizationId, proj.projectId, workitemTypeId, GITLAB_READ_TIMEOUT_MS)
        if (fcRes.ok) labelFieldKey = extractLabelFieldKey(fcRes.data)
      } catch {
        // best-effort 字段配置查询
      }
    }

    const lblRes = await ensureProjectLabelIdsForWrite(effective, proj, wanted)
    if (!lblRes.ok) return lblRes

    const updRes = await requestWorkitemUpdate(
      effective,
      proj.organizationId,
      fetched.workitemId,
      { [labelFieldKey]: lblRes.labelIds },
      GITLAB_READ_TIMEOUT_MS,
    )
    if (!updRes.ok) {
      return failYunxiao(updRes, updRes.stderr || updRes.stdout || '更新工作项标签失败', updRes, effective)
    }

    const after = await fetchRawWorkitem(effective, proj, fetched.workitemId)
    if (!after.ok) {
      const fallbackRaw: RawBag = { ...fetched.raw, labels: wanted }
      return { ok: true, data: normalizeYunxiaoIssue(fallbackRaw, repo) }
    }
    return { ok: true, data: normalizeYunxiaoIssue(after.raw, repo) }
  } catch (err: unknown) {
    return failYunxiao(err, errMsg(err), err, effective)
  }
}

export default { setLabels }
