/**
 * src/tracker/rooms/yunxiao/labels/list.ts —— Yunxiao Projex 项目标签列表路由（规格 #03）。
 *
 * 核心行为：
 *   1. 调用 GET .../projects/{projectId}/labels 查询项目标签；
 *   2. 真机实测（Wayfinder #11）表明当项目尚无任何标签时，云效返回 HTTP 204 No Content（空响应体），
 *      此时必须将其归一为空数组 [] 返回，而非当作 JSON 解析错误；
 *   3. 颜色经 normalizeColor 统一转为不带井号的 6 位小写十六进制字符串。
 */

import { ERROR_KIND } from '../../../contract/vocabulary.js'
import type { ErrorKind } from '../../../contract/identity.js'
import type { OpContext } from '../../../contract/contexts.js'
import type { LabelColor, RepositoryRef } from '../../../contract/entities.js'
import type { LabelListResult } from '../../../contract/results.js'
import { PAGINATION } from '../../../contract/pagination.js'
import { normalizeColor } from '../../../../shared/label-color/src/colors.js'
import { fail } from '../../../kernel/preflight.js'
import { GITLAB_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { hasNextYunxiaoPage } from '../client.js'
import { failYunxiao } from '../errors.js'
import { requestProjectLabelsList } from '../requests.js'
import { emitReadDegraded } from '../support/read-log.js'
import { errMsg, resolveProjectRef, type CtxLike, type RepoLike } from '../issues/shared.js'

/** 单页读取项目标签的条数上限。 */
export const LABEL_LIST_PER_PAGE = PAGINATION.gitlab.labelListPerPage
/** 读取项目标签的最大翻页数上限。 */
export const LABEL_LIST_MAX_PAGES = PAGINATION.gitlab.labelListMaxPages

function toLabelColor(raw: unknown): LabelColor | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const bag = raw as Record<string, unknown>
  const name = typeof bag['name'] === 'string' ? bag['name'].trim() : ''
  if (!name) return null
  const item: LabelColor = { name, color: normalizeColor(bag['color']) || '' }
  if (typeof bag['description'] === 'string' && bag['description'].trim() !== '') {
    item.description = bag['description'].trim()
  }
  return item
}

/** 列出项目全部标签及其颜色（契约操作 listLabels）：将 HTTP 204 空响应归一为 []。 */
export async function listLabels(
  repo: RepositoryRef,
  ctx: OpContext,
): Promise<LabelListResult> {
  const t0 = Date.now()
  const effective = ctx as CtxLike
  const proj = resolveProjectRef(repo as RepoLike)
  if (!proj) {
    emitReadDegraded(ctx, 'labels', 'labels:repo-ref', Date.now() - t0, ERROR_KIND.NOTFOUND)
    return fail(
      ERROR_KIND.NOTFOUND as ErrorKind,
      '未能获取全部标签：repo.refId 缺失或格式不是 organizationId/projectId',
      String(repo?.refId || ''),
    )
  }

  const all: LabelColor[] = []
  try {
    for (let page = 1; page <= LABEL_LIST_MAX_PAGES; page++) {
      const query = page === 1 ? '' : 'page=' + String(page) + '&perPage=' + String(LABEL_LIST_PER_PAGE)
      const res = await requestProjectLabelsList(effective, proj.organizationId, proj.projectId, query, GITLAB_READ_TIMEOUT_MS)
      if (!res.ok) {
        const failed = failYunxiao(res, res.stderr || res.stdout || '查询项目标签列表失败', res, ctx)
        emitReadDegraded(ctx, 'labels', 'labels:transport', Date.now() - t0, failed.error.kind)
        return failed
      }

      if (res.status === 204 || res.data === null || (res.stdout.trim() === '' && res.data === null)) {
        break
      }

      if (!Array.isArray(res.data)) {
        emitReadDegraded(ctx, 'labels', 'labels:shape', Date.now() - t0, ERROR_KIND.ENV)
        return fail(ERROR_KIND.ENV as ErrorKind, '未能获取全部标签：云效返回的标签列表不是数组', res.stdout)
      }

      for (const row of res.data as unknown[]) {
        const item = toLabelColor(row)
        if (!item) {
          emitReadDegraded(ctx, 'labels', 'labels:shape', Date.now() - t0, ERROR_KIND.ENV)
          return fail(ERROR_KIND.ENV as ErrorKind, '未能获取全部标签：标签列表项缺少有效的标签名', res.stdout)
        }
        all.push(item)
      }

      if (!hasNextYunxiaoPage(res.headers)) break
      if (page === LABEL_LIST_MAX_PAGES) {
        emitReadDegraded(ctx, 'labels', 'labels:partial', Date.now() - t0, ERROR_KIND.ENV)
        return fail(ERROR_KIND.ENV as ErrorKind, '未能获取全部标签：项目标签数量超过单次读取上限', res.stdout)
      }
    }
    return { ok: true, data: all }
  } catch (err: unknown) {
    const failed = failYunxiao(err, errMsg(err), err, ctx)
    emitReadDegraded(ctx, 'labels', 'labels:transport', Date.now() - t0, failed.error.kind)
    return failed
  }
}

export default { listLabels }
