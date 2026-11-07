/**
 * src/tracker/rooms/yunxiao/support/read-log.ts —— Yunxiao backend 读路径降级、预检门禁与仓库发现档位日志出口（规格 #01 / #02）。
 *
 * 对齐 GitLab 房间（src/tracker/rooms/gitlab/support/read-log.ts）与内核（src/tracker/kernel/log-emit.ts）的日志纪律：
 *   1. 事件名复用全仓已登记的常驻事件（read.degraded、preflight.gate、repo.resolve.tier），
 *      字段严格遵守 tests/verify-log-fields.ts 白名单，只记短枚举、层号与毫秒耗时，绝不落盘可重放凭证、
 *      路径原文或远端响应正文。
 *   2. 统一经内核 guardEmit 与 ms 发送，日志异常绝不影响业务操作结论。
 */

import type { OpContext } from '../../../contract/contexts.js'
import { LIST_TRUNCATED_REASON } from '../../../contract/results.js'
import { guardEmit, ms } from '../../../kernel/log-emit.js'

/** Yunxiao 房间会报告读降级的操作名枚举。 */
export const READ_DEGRADED_OPS = Object.freeze([
  'matches',
  'preflight',
  'coordinates',
  'list',
  'get',
  'counts',
  'listPage',
  'labels',
  'subIssues',
  'permissions',
  'currentUser',
  'repoKey',
] as const)

/** Yunxiao 房间读路径降级原因短枚举。 */
export const READ_DEGRADED_REASONS = Object.freeze([
  'matches:fs-unavailable',
  'matches:yunxiao-config',
  'matches:git-config',
  'matches:tracker-doc',
  'matches:unknown',
  'coordinates:read-fail',
  'preflight:config',
  'preflight:auth',
  'preflight:project',
  'preflight:codeup',
  'list:repo-ref',
  'list:transport',
  'list:json',
  'list:shape',
  LIST_TRUNCATED_REASON,
  'get:repo-ref',
  'get:transport',
  'get:json',
  'get:shape',
  'counts:repo-ref',
  'counts:transport',
  'counts:json',
  'counts:shape',
  'counts:stat',
  'listPage:repo-ref',
  'listPage:transport',
  'listPage:json',
  'listPage:shape',
  'listPage:total',
  'listPage:cursor',
  'labels:repo-ref',
  'labels:transport',
  'labels:json',
  'labels:shape',
  'labels:partial',
  'subIssues:repo-ref',
  'subIssues:transport',
  'subIssues:json',
  'subIssues:shape',
  'subIssues:notfound',
  'subIssues:page-fail',
  'subIssues:truncated',
  'permissions:repo-ref',
  'permissions:transport',
  'permissions:json',
  'permissions:empty',
  'permissions:no-fields',
  'currentUser:repo-ref',
  'currentUser:transport',
  'currentUser:json',
  'currentUser:shape',
  'repoKey:notfound',
  'repoKey:unknown',
] as const)

/** 预检门禁阶段编号（1 本地坐标、2 平台用户认证、3 Projex 项目访问、4 按需 Codeup 仓库访问）。 */
export const PREFLIGHT_GATES = Object.freeze([1, 2, 3, 4] as const)

export function isPreflightGate(gate: unknown): boolean {
  return PREFLIGHT_GATES.indexOf(gate as 1) >= 0
}

/** 记录一行读路径降级或失败事件（read.degraded）。 */
export function emitReadDegraded(
  ctx: Partial<OpContext> | null | undefined,
  op: string,
  reason: string,
  latencyMs: unknown,
  kind = '',
): void {
  guardEmit(ctx as OpContext | null | undefined, (c) => {
    c.logEvent('warn', 'read.degraded', {
      op: String(op || ''),
      reason: String(reason || ''),
      latencyMs: ms(latencyMs),
      opId: String(c.opId || ''),
      kind: String(kind || ''),
    })
  })
}

/** 记录一行预检门禁通过事件（preflight.gate）。 */
export function emitPreflightGatePass(
  ctx: Partial<OpContext> | null | undefined,
  gate: number,
  latencyMs: unknown,
): void {
  guardEmit(
    ctx as OpContext | null | undefined,
    (c) => {
      c.logEvent('warn', 'preflight.gate', {
        gate: gate,
        reason: 'ok',
        latencyMs: ms(latencyMs),
        opId: String(c.opId || ''),
      })
    },
    () => isPreflightGate(gate),
  )
}

/** 记录一行仓库发现层级事件（repo.resolve.tier）。 */
export function emitRepoTier(
  ctx: Partial<OpContext> | null | undefined,
  tier: number,
  ok: boolean,
  startedAt: number,
): void {
  guardEmit(ctx as OpContext | null | undefined, (c) => {
    c.logEvent('info', 'repo.resolve.tier', {
      tier: tier,
      ok: ok === true,
      latencyMs: ms(Date.now() - startedAt),
    })
  })
}
