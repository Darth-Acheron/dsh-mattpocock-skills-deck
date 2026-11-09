/**
 * src/tracker/rooms/yunxiao/room/links.ts —— Yunxiao backend 交给界面与注册表的链接、地址与默认站点（规格 #02）。
 *
 * 为什么独立成文件：
 *   链接与地址的拼装是纯同步定位逻辑，不发起网络请求；独立在 `room/links.ts` 中，
 *   由房间入口 `index.ts` 装配并原样再导出。
 *
 * 云效网页端地址规则：
 *   1. 默认站点域名为 `https://devops.aliyun.com`（可通过 `RepositoryRef.host` 或工作区缓存的 `webBaseUrl` 覆盖）；
 *   2. `RepositoryRef.refId` 固定编码为 `${organizationId}/${projectId}`；
 *   3. 当工作区已通过 `GetProject` 缓存项目代号 `customCode` 且传入纯数字票号 `n` 时，可拼出带项目前缀的标识，
 *      否则使用传入的票号或内部标识拼装工作项详情网页地址。
 */

import type { RepositoryRef } from '../../../contract/entities.js'
import { classifyYunxiaoIssueInput, resolveYunxiaoWorkitemId, toYunxiaoSerialNumber } from '../model/description-markers.js'
import { getLearnedYunxiaoContext, parseYunxiaoRefId } from '../model/repo-identity.js'
import { DEFAULT_YUNXIAO_WEB_BASE_URL } from '../model/workspace-config.js'

/** 云效官方网页端默认地址。 */
export const DEFAULT_YUNXIAO_WEB_ORIGIN = DEFAULT_YUNXIAO_WEB_BASE_URL

function refOrigin(ref: Partial<RepositoryRef> | null | undefined, refId: string): string {
  const declared = ref && typeof ref.host === 'string' ? ref.host.trim().replace(/\/+$/, '') : ''
  if (declared) return declared
  const learned = refId ? getLearnedYunxiaoContext(refId) : null
  if (learned?.webBaseUrl) return learned.webBaseUrl.trim().replace(/\/+$/, '')
  const url = ref && typeof ref.url === 'string' ? ref.url.trim() : ''
  const m = url.match(/^([a-z][a-z0-9+.-]*):\/\/([^/\s]+)\//i)
  if (m && !/codeup\.aliyun\.com/i.test(m[2])) {
    return m[1].toLowerCase() + '://' + m[2].replace(/^[^@]*@/, '')
  }
  return DEFAULT_YUNXIAO_WEB_ORIGIN
}

/**
 * 产出云效 Projex 工作项网页地址（契约定位口 `issueAddress`）。
 *
 * `ref.refId` 必须形如 `${organizationId}/${projectId}`，缺失或格式不对时诚实返回空串 `''`。
 */
export function issueAddress(ref: Partial<RepositoryRef> | null | undefined, key: string | number): string {
  const rawRefId = ref && typeof ref.refId === 'string' ? ref.refId.trim() : ''
  const parsedRef = parseYunxiaoRefId(rawRefId)
  if (!parsedRef) return ''

  const rawKey = String(key == null ? '' : key).trim()
  if (!rawKey) return ''

  const origin = refOrigin(ref, rawRefId)
  const learned = getLearnedYunxiaoContext(rawRefId)
  const classified = classifyYunxiaoIssueInput(rawKey)

  let itemSegment = rawKey
  if (classified) {
    const cachedId = resolveYunxiaoWorkitemId(rawRefId, rawKey)
    if (cachedId) {
      itemSegment = cachedId
    } else if (classified.kind === 'numeric' && learned?.customCode) {
      itemSegment = toYunxiaoSerialNumber(classified.key, learned.customCode) || classified.key
    } else if (classified.kind === 'serial') {
      itemSegment = classified.serialNumber
    } else if (classified.kind === 'internal-id') {
      itemSegment = classified.id
    } else {
      itemSegment = classified.key
    }
  }

  return (
    origin +
    '/projex/project/' +
    encodeURIComponent(parsedRef.projectId) +
    '/workitem/' +
    encodeURIComponent(itemSegment)
  )
}

/** 按名称搜索项目的网页地址。 */
export function repoSearchAddress(
  name: string | null | undefined,
  ref?: Partial<RepositoryRef> | null,
): string {
  const rawRefId = ref && typeof ref.refId === 'string' ? ref.refId.trim() : ''
  return refOrigin(ref, rawRefId) + '/projex?search=' + encodeURIComponent(String(name || ''))
}

export const issueRefPattern = /devops\.aliyun\.com\/projex\/project\/[^\/\s]+\/workitem\/([A-Za-z0-9_-]+)/g

export const links = {
  searchUrlTemplate: 'https://devops.aliyun.com/projex?search={q}',
  linkPatternSource: 'devops\\.aliyun\\.com\\/projex\\/project\\/[^\\/\\s]+\\/workitem\\/([A-Za-z0-9_-]+)',
}
