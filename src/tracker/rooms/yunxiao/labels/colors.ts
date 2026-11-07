/**
 * src/tracker/rooms/yunxiao/labels/colors.ts —— Yunxiao Projex 项目标签批量改色路由（规格 #03）。
 *
 * 核心行为：
 *   1. 将调用方传入的 6 位十六进制颜色归一化为小写，并在发往云效时补上 # 前缀（#rrggbb）；
 *   2. 先经 fetchProjectLabelNameMap 读取项目标签字典以按名称定位 labelId；若某标签已存在则调用
 *      PUT .../labels/{labelId} 更新颜色，若标签尚未存在则调用 POST .../labels 创建带该颜色的标签；
 *   3. 逐条记账到 applied / failed，确保入参每一项恰好落入其中之一。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { OpContext } from '../../../contract/contexts.js'
import type { LabelColorChange, RepositoryRef } from '../../../contract/entities.js'
import type { LabelColorBatchResult, OpResult, TrackerError } from '../../../contract/results.js'
import { PAGINATION } from '../../../contract/pagination.js'
import { normalizeColor } from '../../../../shared/label-color/src/colors.js'
import { fail } from '../../../kernel/preflight.js'
import { GITLAB_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { classifyYunxiaoError, failYunxiao } from '../errors.js'
import { requestProjectLabelCreate, requestProjectLabelUpdate } from '../requests.js'
import { emitReadDegraded } from '../support/read-log.js'
import {
  errMsg,
  fetchProjectLabelNameMap,
  resolveProjectRef,
  type CtxLike,
  type RepoLike,
} from '../issues/shared.js'

/** 批量修改项目标签颜色的最大并发数上限。 */
export const WRITE_CONCURRENCY_MAX = PAGINATION.gitlab.labelWriteConcurrencyMax
/** 批量修改项目标签颜色的默认并发数。 */
export const WRITE_CONCURRENCY_DEFAULT = PAGINATION.gitlab.labelWriteConcurrencyDefault

function changesProblem(changes: unknown): string {
  if (!Array.isArray(changes)) return '修改标签颜色需要一批「标签 → 新颜色」的改动，本次收到的内容不是数组'
  const seen = new Set<string>()
  for (const ch of changes) {
    if (!ch || typeof ch !== 'object' || Array.isArray(ch)) return '这一批改动中有一条不是对象格式'
    const bag = ch as { name?: unknown; color?: unknown }
    if (typeof bag.name !== 'string' || !bag.name.trim()) return '这一批改动中有一条未填写标签名'
    if (typeof bag.color !== 'string' || !bag.color.trim()) return '这一批改动中有一条未填写新颜色'
    const key = bag.name.trim()
    if (seen.has(key)) return '同一批改动里「' + key + '」出现了两次，一个标签在一批中只允许出现一次'
    seen.add(key)
  }
  return ''
}

function reason(kind: ErrorKind, message: string, raw: unknown): TrackerError {
  return fail(kind, message, raw).error
}

/** 批量修改项目标签颜色（契约操作 setLabelColors）：逐条记账到 applied 与 failed。 */
export async function setLabelColors(
  repo: RepositoryRef,
  changes: LabelColorChange[],
  ctx: OpContext,
): Promise<OpResult<LabelColorBatchResult>> {
  const t0 = Date.now()
  const effective = ctx as CtxLike
  try {
    const bad = changesProblem(changes)
    if (bad) return fail(ERROR_KIND.PARSE as ErrorKind, bad, changes)

    const proj = resolveProjectRef(repo as RepoLike)
    if (!proj) {
      emitReadDegraded(ctx, 'labels', 'labels:repo-ref', Date.now() - t0, ERROR_KIND.NOTFOUND)
      return fail(
        ERROR_KIND.NOTFOUND as ErrorKind,
        '修改标签颜色时未能确定云效项目标识（organizationId/projectId）',
        String(repo?.refId || ''),
      )
    }

    if (changes.length === 0) {
      return { ok: true, data: { applied: [], failed: [] } }
    }

    const mapRes = await fetchProjectLabelNameMap(effective, proj)
    const nameToId = mapRes.ok ? mapRes.nameToId : new Map<string, string>()

    const applied: { name: string; color: string }[] = []
    const failed: { name: string; reason: TrackerError }[] = []

    for (const ch of changes) {
      const wantHex = normalizeColor(ch.color)
      if (!wantHex) {
        failed.push({
          name: ch.name,
          reason: reason(ERROR_KIND.PARSE as ErrorKind, '「' + ch.name + '」的新颜色不正确：请改为六位十六进制，例如 9d7cd8。', ''),
        })
        continue
      }
      const colorWithHash = '#' + wantHex
      const labelName = ch.name.trim()
      const existingId = nameToId.get(labelName) || nameToId.get(labelName.toLowerCase()) || ''

      const res = existingId
        ? await requestProjectLabelUpdate(
            effective,
            proj.organizationId,
            proj.projectId,
            existingId,
            { name: labelName, color: colorWithHash },
            GITLAB_READ_TIMEOUT_MS,
          )
        : await requestProjectLabelCreate(
            effective,
            proj.organizationId,
            proj.projectId,
            { name: labelName, color: colorWithHash },
            GITLAB_READ_TIMEOUT_MS,
          )

      if (res.ok) {
        applied.push({ name: ch.name, color: wantHex })
      } else {
        const verdict = classifyYunxiaoError(res, ctx)
        failed.push({
          name: ch.name,
          reason: reason(verdict.kind, '修改「' + ch.name + '」的颜色失败：' + (res.stderr || res.stdout || 'HTTP ' + res.status), res),
        })
      }
    }

    return { ok: true, data: { applied, failed } }
  } catch (err: unknown) {
    return failYunxiao(err, errMsg(err), err, ctx)
  }
}

export default { setLabelColors }
