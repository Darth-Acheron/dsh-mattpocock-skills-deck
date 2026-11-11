/**
 * src/tracker/rooms/yunxiao/errors.ts —— 云效 OpenAPI 错误分类与统一失败构造器（规格 #01）。
 *
 * 为什么需要云效专有前置扩展表（YUNXIAO_ERROR_RULES）：
 *   1. 实测证实 Yunxiao Projex 的 GetProject 在项目 ID 不存在时返回 HTTP 400 InvalidIdentifier.NotFound
 *      （而非 HTTP 404）；若不设前置规则，通用表会将其落入 fallback（network），误导用户去排查网络。
 *   2. 实测证实当企业默认关系矩阵不允许某类工作项建立 DEPEND_ON 或 PARENT 层级，或工作流不允许当前状态流转时，
 *      Yunxiao Projex 返回 HTTP 400 InvaildData.Failed（"无法创建此关系" / "不能流转到目标状态"），属于业务冲突（conflict）。
 *   3. 跨组织访问时返回 HTTP 403 Forbidden.InvalidUser.UserNotInCurrentOrganization，通用表已将 403 归为 auth，
 *      而无状态码的云效令牌缺失提示与 yunxiao.yaml 本地配置错误则通过 phrase 层精准归入 auth 与 env。
 *   4. 实测证实（缺陷 02）UpdateWorkitem 对 Task 类工作项不接受 parentId 字段，毫秒级返回 HTTP 400
 *      （"workitem does not contains field : [\"parentId\"]"）；若不设前置规则，通用表会把它落入 fallback
 *      （network），写阶段回执再映射成 backend-timeout——一次服务端明确拒绝被误报成超时，把排查方向带偏到网络。
 */

import { ERROR_KIND } from '../../contract/vocabulary.js'
import type { ErrorKind } from '../../contract/identity.js'
import type { TrackerError } from '../../contract/results.js'
import { HINT_UNRECOGNIZED, HINT_UNSUPPORTED, fail } from '../../kernel/preflight.js'
import type { ClassifyCtx } from '../../kernel/preflight.js'
import { emitPassthrough, factsFromError, judgeFactsDetailed } from '../../kernel/error-rules.js'
import type { ErrorRule } from '../../kernel/error-rules.js'

const KIND_VALUES: ReadonlySet<string> = new Set(Object.values(ERROR_KIND))

/** 云效错误判档结论。 */
export interface YunxiaoVerdict {
  kind: ErrorKind
  fallback: boolean
}

/**
 * 云效前置扩展规则表（严格按 fact -> phrase 层序排列，每条配真实样本供 verify-error-rule-samples.ts 自证）。
 */
export const YUNXIAO_ERROR_RULES: readonly ErrorRule[] = [
  {
    kind: ERROR_KIND.NOTFOUND as ErrorKind,
    layer: 'fact',
    when: (f) =>
      f.status === 400 &&
      /InvalidIdentifier\.NotFound|InvalidWorkitem\.NotFound|项目不存在|工作项.*不存在/i.test(String(f.text || '')),
    example: {
      status: 400,
      text: '{"errorCode":"InvalidIdentifier.NotFound","errorMessage":"项目不存在或已经彻底删除"}',
    },
    note: '真机实测（Wayfinder #11）：Yunxiao Projex 在项目不存在时返回 HTTP 400 InvalidIdentifier.NotFound 而非 404；'
      + '必须在 fact 层精准归入 not-found，避免掉进通用表末尾的 network 兜底',
  },
  {
    kind: ERROR_KIND.CONFLICT as ErrorKind,
    layer: 'fact',
    when: (f) =>
      f.status === 400 &&
      /无法创建此关系|不满足关系对应的类型约束|不能流转到目标状态|InvaildData\.Failed|InvalidData\.Failed/i.test(
        String(f.text || ''),
      ),
    example: {
      status: 400,
      text: '{"errorCode":"InvaildData.Failed","errorMessage":"无法创建此关系, 不满足关系对应的类型约束！"}',
    },
    note: '真机实测（Wayfinder #11）：企业默认关系矩阵拒绝 DEPEND_ON / PARENT 或工作流禁止状态迁移时返回 HTTP 400，'
      + '归入 conflict 供上层触发关系降级双写或提示状态冲突',
  },
  {
    kind: ERROR_KIND.UNSUPPORTED as ErrorKind,
    layer: 'fact',
    when: (f) =>
      f.status === 400 &&
      /does not contains field/i.test(String(f.text || '')),
    example: {
      status: 400,
      text: '{"errorCode":"400","errorMessage":"workitem does not contains field : [\"parentId\"]"}',
    },
    note: '真机实测（缺陷 02，MattDemo——维护者用于真机核验的云效项目——的 Task）：UpdateWorkitem 对不含某字段的类型毫秒级返回这种 400，'
      + '这是后端明确的字段合同拒绝，归入 unsupported 让写阶段回执停（backend-unsupported）而不是误导去查网络超时；'
      + '原文里的 errorCode / errorMessage 随失败结果的 raw 原样保留',
  },
  {
    kind: ERROR_KIND.AUTH as ErrorKind,
    layer: 'errcode',
    pattern: /\b(?:InvalidToken|ExpiredTokenError|UserNotInCurrentOrganization|InvalidOrganizationMember)\b/i,
    example: {
      text: '{"errorCode":"Forbidden.InvalidUser.UserNotInCurrentOrganization","errorMessage":"Current user is not in organization"}',
    },
    note: '云效 OpenAPI 专有的认证与组织成员错误码名（排在句式层之前，按 ADR §2 第 3 条归入 errcode 层）',
  },
  {
    kind: ERROR_KIND.ENV as ErrorKind,
    layer: 'errcode',
    pattern: /\bUnsupportedInCurrentEnv\b/i,
    example: {
      text: '{"errorCode":"UnsupportedInCurrentEnv","errorMessage":"Current environment does not support this API"}',
    },
    note: '云效实例环境不支持指定 OpenAPI 时的结构化错误码名，按 ADR §2 第 3 条归入 errcode 层 env 档',
  },
  {
    kind: ERROR_KIND.AUTH as ErrorKind,
    layer: 'phrase',
    pattern: /(?:missing|invalid|empty)\s+x-yunxiao-token|YUNXIAO_TOKEN|ALIBABA_CLOUD_DEVOPS_TOKEN|企业不存在/i,
    example: {
      text: 'Missing Yunxiao token: set YUNXIAO_TOKEN or ~/.config/yunxiao/token',
    },
    note: '云效个人访问令牌缺失或企业不存在时的专有提示句式（不含通用表 auth/credential 词根），归入认证档',
  },
  {
    kind: ERROR_KIND.ENV as ErrorKind,
    layer: 'phrase',
    pattern: /docs\/agents\/yunxiao\.yaml|YUNXIAO_ORGANIZATION_ID|YUNXIAO_PROJECT_ID/i,
    example: {
      text: 'Invalid docs/agents/yunxiao.yaml: missing organizationId or projectId',
    },
    note: '云效工作区配置文件 docs/agents/yunxiao.yaml 缺失或字段非法时归入环境配置档 env',
  },
]

function carriedKind(err: unknown): ErrorKind | null {
  if (!err || typeof err !== 'object') return null
  const bag = err as Record<string, unknown>
  const top = bag['kind']
  if (typeof top === 'string' && KIND_VALUES.has(top)) return top as ErrorKind
  const inner = bag['error']
  if (inner !== null && typeof inner === 'object') {
    const innerKind = (inner as Record<string, unknown>)['kind']
    if (typeof innerKind === 'string' && KIND_VALUES.has(innerKind)) return innerKind as ErrorKind
  }
  return null
}

/**
 * 将云效 HTTP 响应或异常判成契约八档错误之一。
 */
export function classifyYunxiaoError(err: unknown, ctx?: ClassifyCtx): YunxiaoVerdict {
  const carried = carriedKind(err)
  if (carried) {
    emitPassthrough(ctx, carried)
    return { kind: carried, fallback: false }
  }
  const judged = judgeFactsDetailed(factsFromError(err), YUNXIAO_ERROR_RULES, ctx)
  return { kind: judged.kind, fallback: judged.fallback }
}

/**
 * 根据判档结论挑选展示给用户或代理的提示语：兜底与 unsupported 使用全仓统一实话提示。
 */
export function hintFor(verdict: YunxiaoVerdict | null | undefined, nativeMessage: string): string {
  if (verdict && verdict.fallback) return HINT_UNRECOGNIZED
  if (verdict && verdict.kind === (ERROR_KIND.UNSUPPORTED as ErrorKind)) return HINT_UNSUPPORTED
  return nativeMessage
}

/**
 * 云效房间统一失败构造器：判档 + 挑选提示语 + 遮蔽并保留原文。
 */
export function failYunxiao(
  err: unknown,
  nativeMessage: string,
  raw?: unknown,
  ctx?: ClassifyCtx,
): { ok: false; error: TrackerError } {
  const verdict = classifyYunxiaoError(err, ctx)
  return fail(verdict.kind, hintFor(verdict, nativeMessage), arguments.length > 2 ? raw : err)
}

/** 从异常对象或未知值中提取可读错误消息。 */
export function errMsg(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'message' in (err as Record<string, unknown>)) {
    const m = (err as Record<string, unknown>)['message']
    if (typeof m === 'string' && m) return m
  }
  return String(err)
}

/** 判断未知值是否为非数组纯对象（Record）。 */
export function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  return null
}

/** 判断关系写接口失败是否属于云效企业关系矩阵类型约束限制（HTTP 400）。 */
export function isRelationMatrixConstraintError(
  res: { ok?: boolean; status?: number; stderr?: string; stdout?: string } | null | undefined,
): boolean {
  if (!res || res.ok) return false
  if (res.status !== 400) return false
  const text = String(res.stderr || res.stdout || '')
  return /无法创建此关系|不满足关系对应的类型约束|InvaildData\.Failed|InvalidData\.Failed|relation/i.test(text)
}

export default classifyYunxiaoError
