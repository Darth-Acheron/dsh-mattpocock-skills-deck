/**
 * src/tracker/rooms/yunxiao/support/read-sources.ts —— Yunxiao backend 的读来源默认值（规格 #02）。
 *
 * 对齐 `src/tracker/rooms/gitlab/support/read-sources.ts` 与规格 #1681 第 3 节：
 *   读来源字段对所有后端定义，非 GitHub 后端给出本家通道的显式默认值（`channel: 'yunxiao-api'`，
 *   `completeness: 'complete'`）。键的类型为 `ReadOperationName`，少登记一条编译期即报错。
 */
import type { OwnChannelReadSource, ReadOperationName } from '../../../contract/operations-encyclopedia.js'

const DEFAULT_READ_SOURCE: OwnChannelReadSource = { channel: 'yunxiao-api', completeness: 'complete' }

export const YUNXIAO_READ_SOURCES = {
  preflight: DEFAULT_READ_SOURCE,
  list: DEFAULT_READ_SOURCE,
  get: DEFAULT_READ_SOURCE,
  getDependencies: DEFAULT_READ_SOURCE,
  getCurrentUser: DEFAULT_READ_SOURCE,
  listLabels: DEFAULT_READ_SOURCE,
  counts: DEFAULT_READ_SOURCE,
  listPage: DEFAULT_READ_SOURCE,
  getRepoPermissions: DEFAULT_READ_SOURCE,
  listSubIssues: DEFAULT_READ_SOURCE,
  listMaps: DEFAULT_READ_SOURCE,
  readBudget: DEFAULT_READ_SOURCE,
} as const satisfies Record<ReadOperationName, OwnChannelReadSource>
