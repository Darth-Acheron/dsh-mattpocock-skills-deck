/**
 * src/tracker/rooms/yunxiao/budget.ts —— Yunxiao backend 预算模型与额度探针（规格 #01）。
 *
 * 为什么采用 requests-only 且 readBudget 返回 known: false (reason: 'unsupported')：
 *   1. 云效 Projex 与 Codeup OpenAPI 按 HTTP 请求调用，不存在 GraphQL 点数桶，因此声明
 *      kind: 'requests-only'，由 client.ts 的 attachYunxiaoOpUsage 自动在每次成功操作上附带
 *      usage: { requests: N, points: 0 }，记入 quota-ledger.ts 的 yunxiao/requests 独立账本桶。
 *   2. 实测证实云效 OpenAPI 响应头仅返回 x-readtime / x-server-id / x-page 等分页头，不返回
 *      RateLimit-Remaining 等剩余配额水位头。按契约返回 { known: false, reason: 'unsupported' }，
 *      准入裁决（decideByBudget）在 reading.known === false 时自动放行并记为 reading-unknown。
 */

import type { BackendBudgetModel, BudgetReading } from '../../contract/budget-model.js'
import type { OpContext } from '../../contract/contexts.js'
import type { OpResult } from '../../contract/results.js'

/** Yunxiao backend 的模块级预算声明。 */
export const YUNXIAO_BUDGET_MODEL: BackendBudgetModel = Object.freeze({
  kind: 'requests-only',
  countsRequests: true,
  countsPoints: false,
  independentBuckets: false,
})

/**
 * 读取云效远端剩余配额水位。
 * 云效 OpenAPI 不提供剩余额度响应头，恒返回成功信封 { known: false, reason: 'unsupported' }。
 */
export async function readYunxiaoBudget(_ctx?: Partial<OpContext>): Promise<OpResult<BudgetReading>> {
  return {
    ok: true,
    data: {
      known: false,
      reason: 'unsupported',
    },
  }
}
