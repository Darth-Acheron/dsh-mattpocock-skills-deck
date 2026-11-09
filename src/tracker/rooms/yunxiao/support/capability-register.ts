/**
 * src/tracker/rooms/yunxiao/support/capability-register.ts —— Yunxiao backend 对 27 条能力的回答（规格 #02）。
 *
 * 对齐契约层 `src/tracker/contract/capability-answer.ts` 的四档判据：
 *   1. 26 条能力登记为 `provided`（23 条异步操作 + 3 条定位口 `getRepoKey` / `describe` / `issueAddress`）；
 *   2. 仅 `ensureLabelColorsFile` 1 条登记为 `unsupported-by-design`（`stubBy: 'registry'`）：
 *      云效的标签颜色真源位于远端 Yunxiao Projex 项目标签，本地工作区中的标签配色文件没有读者，
 *      修改本地文件不会影响远端工作项颜色，因此按设计与 GitHub、GitLab 房间保持同一判定。
 *   3. 本文件仅含静态类型与数据，不包含任何运行时分支或函数（遵守 G5 红线：运行时不查能力表）。
 */
import type { CapabilityRegister } from '../../../contract/capability-answer.js'

/**
 * Yunxiao backend：27 条能力中 26 条明确提供功能，1 条按设计明确不支持。
 * 顺序严格对齐 `operations-catalog.ts`（24 条操作在前、3 条定位口在后）。
 */
export const YUNXIAO_CAPABILITY_REGISTER = {
  // —— 操作 24 条：23 条真实现，1 条按设计不支持 ——
  preflight: { tier: 'provided' },
  list: { tier: 'provided' },
  get: { tier: 'provided' },
  getDependencies: { tier: 'provided' },
  create: { tier: 'provided' },
  close: { tier: 'provided' },
  reopen: { tier: 'provided' },
  comment: { tier: 'provided' },
  update: { tier: 'provided' },
  setLabels: { tier: 'provided' },
  setAssignees: { tier: 'provided' },
  setParent: { tier: 'provided' },
  setBlockedBy: { tier: 'provided' },
  counts: { tier: 'provided' },
  listPage: { tier: 'provided' },
  listLabels: { tier: 'provided' },
  setLabelColors: { tier: 'provided' },
  getCurrentUser: { tier: 'provided' },
  getRepoPermissions: { tier: 'provided' },
  listSubIssues: { tier: 'provided' },
  initProject: { tier: 'provided' },
  ensureLabelColorsFile: { tier: 'unsupported-by-design', stubBy: 'registry' },
  listMaps: { tier: 'provided' },
  readBudget: { tier: 'provided' },

  // —— 定位口 3 条：全部提供 ——
  getRepoKey: { tier: 'provided' },
  describe: { tier: 'provided' },
  issueAddress: { tier: 'provided' },
} as const satisfies CapabilityRegister
