# Yunxiao 后端能力登记表

规格 `yunxiao-backend-spec`（`#00`–`#05`，2026-11-09）的交付物。登记口径同 GitHub 与 GitLab 那份（四类定义见 `src/tracker/contract/capability-answer.ts`）：**明确提供功能**——今天就能干活且有调用方在用；**明确不支持**——形态不合、永远不会有；**当前不支持、未来会开发**——说得通、今天没做。一条一条审过实现才落笔，不估。

实现真源：`src/tracker/rooms/yunxiao/index.ts`（工厂 26 个成员）+ 各子模块实现文件。这一家今天**没有欠账**：名录上的 27 条 = 24 条操作 + 3 条定位口，26 条真提供、1 条按设计明确不支持，名录上没有任何一条要靠注册表补桩（仅 `ensureLabelColorsFile` 按设计交由注册表补 `unsupported` 桩）。

## 操作（24 条中：23 条明确提供功能、1 条明确不支持）

| 能力 | 登记 | 依据 |
|---|---|---|
| preflight | 明确提供功能 | `preflight.ts`，四步递进式环境预检：本地坐标（`docs/agents/yunxiao.yaml` 或 `YUNXIAO_*` 环境变量）→ 平台令牌认证（`GET /oapi/v1/platform/user`）→ **Yunxiao Projex** 项目可读性（`GetProject`，缓存 `customCode`，并将 `HTTP 400 InvalidIdentifier.NotFound` 精准映射为 `not-found`）→ 按需 **Codeup** 仓库可读性（`GetRepository`，无代码库的纯规划工作区在第 3 步通过后即判成功） |
| list | 明确提供功能 | `issues/read.ts`，搜索 `category="Req,Task,Bug"` 工作项，摘要缺失完整 `description` 时自动并发调 `GetWorkitem` 补齐详情，并富化原生阻塞边 |
| get | 明确提供功能 | `issues/read.ts`，兼容纯数字、`${customCode}-${n}` 与 26 位内部 ID 三种入参，对外统一暴露纯数字 `Issue.key`，富化评论与原生阻塞边 |
| getDependencies | 明确提供功能 | `graph/read.ts`，合并原生 `DEPEND_ON` 关系与正文文件头 `DSH-BLOCKED-BY` / 可见 `Blocked by:` 标记，补齐阻塞票标题与状态并推导反向 `blocking` 边 |
| create | 明确提供功能 | `issues/write.ts` + `issues/idempotency.ts`，支持六种建票位置映射（`map`/`spec` → `Req`，`map-ticket`/`spec-ticket`/`issue` → `Task`，`bug` → `Bug` 及未启用时回退为带 `bug` 标签的 `Task`）与 `DSH-IDEMPOTENCY-KEY` 幂等防重 |
| close | 明确提供功能 | `issues/write.ts`，自动查询工作流配置并将工作项流转至 `statusStageId === "4"`（已完成）的目标状态 |
| reopen | 明确提供功能 | `issues/write.ts`，将工作项流转回初始未完成工作流阶段 |
| comment | 明确提供功能 | `comments/write.ts`，以 `formatType: "MARKDOWN"` 创建工作项评论 |
| update | 明确提供功能 | `issues/write.ts`，以 `formatType: "MARKDOWN"` 更新工作项标题与正文，保留并同步文件头隐藏标记 |
| setLabels | 明确提供功能 | `labels/assign.ts`，查询工作项类型标签字段标识并自动创建/指派或清空项目标签 |
| setAssignees | 明确提供功能 | `graph/membership.ts`，以文件头 `<!-- DSH-ASSIGNEES: ... -->` 作为契约认领真源（解决云效原生 `assignedTo` 必填且不可置空的限制），并同步维护原生 `assignedTo` 与 `participants` |
| setParent | 明确提供功能 | `graph/membership.ts`，成对写入文件头 `<!-- DSH-PARENT: <key> -->` 与原生 `parentId`；当企业默认关系矩阵拒绝 `Bug` 等类型的原生父子层级（返回 `400`）时，自动保留 `DSH-PARENT` 并建立原生 `ASSOCIATED` 关联 |
| setBlockedBy | 明确提供功能 | `graph/write.ts`，先执行整图环检测，优先尝试原生 `DEPEND_ON` 关系；若企业默认关系矩阵拒绝 `DEPEND_ON`（返回 `400`），自动回退写入成对正文标记（`Blocked by: #n` 与 `<!-- DSH-BLOCKED-BY: n -->`）并建立原生 `ASSOCIATED` 关联 |
| counts | 明确提供功能 | `issues/counts.ts`，基于分页响应头 `x-total` 与工作流阶段 `4`/`5` 统计 `open`、`closed` 与 `total` |
| listPage | 明确提供功能 | `issues/pages.ts`，分页读取工作项，严格按 `xPage < xTotalPages` 判定是否存在下一页（忽略单页时恒非空的 `x-next-page`） |
| listLabels | 明确提供功能 | `labels/list.ts`，拉取项目标签列表，将 `HTTP 204 No Content` 空响应归一为 `[]`，并归一 6 位十六进制颜色 |
| setLabelColors | 明确提供功能 | `labels/colors.ts`，按写并发上限批量更新或创建项目标签颜色，逐条返回成功与失败记账 |
| getCurrentUser | 明确提供功能 | `repo/current-user.ts`，调用 `GET /oapi/v1/platform/user` 获取当前令牌用户并缓存至 `learnedYunxiaoContext` |
| getRepoPermissions | 明确提供功能 | `repo/permissions.ts`，由 **Yunxiao Projex** 项目可读性判定 `triage`，由关联 **Codeup** 仓库未归档且 `Number(accessLevel) >= 30` 判定 `push`（不受只读令牌下 `allowPush: false` 误导；纯规划工作区返回 `{ push: false, triage: true }`） |
| listSubIssues | 明确提供功能 | `issues/sub-issues.ts`，将原生 `null`/`""`/`"EMPTY_VALUE"` 归一为无父项，合并原生 `SUB` 子工作项列表与全项目文件头 `DSH-PARENT` 回退扫描结果 |
| initProject | 明确提供功能 | `project/init-project.ts`，完成仓库名校验、Git 属主检查自愈、本地 Git 初始化与首提交、调用 **Codeup** `CreateRepository`（将 `public` 映射为企业内公开 `internal`、支持可选 `namespaceId`、避免自动生成 README 冲突）、经 `GetRepository` 回查权威克隆地址、配置 `origin` 并推送 `HEAD` |
| ensureLabelColorsFile | 明确不支持 | 这条能力承诺的是「在工作区放一份用户可以手改、**改了就生效**的标签配色文件」。**Yunxiao backend** 的标签颜色真源位于远端 **Yunxiao Projex** 项目标签，本地工作区里的配色文件没有任何读者，手改也不会影响远端标签颜色——放一份改了不算数的文件只会误导人，属于形态不合。要读颜色用 `listLabels`，要改颜色用 `setLabelColors`。理由与 GitHub、GitLab 完全一致。 |
| listMaps | 明确提供功能 | `issues/maps.ts`，按 `wayfinder:map` 标签查询全量探索地图薄行（含开启与已关闭），摘要缺失字段时自动补齐详情并按更新时间倒序排列 |
| readBudget | 明确提供功能 | `budget.ts`，云效 OpenAPI 不返回统一剩余配额响应头，诚实返回 `{ known: false, reason: 'unsupported' }`，配合 `requests-only` 预算模型按实际请求数记入 `yunxiao/requests` 账本桶 |

## 定位口（3 条全部提供）

| 能力 | 登记 | 依据 |
|---|---|---|
| getRepoKey | 明确提供功能 | `repo/identity.ts`，从 `YUNXIAO_*` 环境变量与 `docs/agents/yunxiao.yaml` 解析出 `{ owner: organizationId, name: projectId }` 并写入 `learnedYunxiaoContext` |
| describe | 明确提供功能 | `index.ts`，产出 `refId: "${organizationId}/${projectId}"`，`url` 优先指向关联的 **Codeup** 仓库 `webUrl`，否则指向 **Yunxiao Projex** 项目地址 |
| issueAddress | 明确提供功能 | `room/links.ts`，拼装 **Yunxiao Projex** 工作项网页详情地址 |

## 变更

- 2026-11-09（规格 `yunxiao-backend-spec` `#01`–`#05` 落地）：首次交付 **Yunxiao backend** 完整能力登记表，27 条契约能力中 26 条明确提供功能（23 条操作 + 3 条定位口），1 条（`ensureLabelColorsFile`）按设计明确不支持。

## 三条不能忘的实话

- **纯数字票号与内部双标识桥接**：**Yunxiao Projex** 工作项同时拥有 26 位十六进制内部 `id`（写接口必填）与带项目前缀的 `serialNumber`（如 `DCIAFS-2`），而 Deck 对外统一暴露剥离前缀后的纯数字 `Issue.key`（如 `"2"`）。房间内部通过 `GetProject` 缓存的 `customCode` 与 `key <-> id` 映射表自动双向桥接，入参兼容三种形态。
- **未认领状态以文件头 `DSH-ASSIGNEES` 为契约真源**：**Yunxiao Projex** 新建工作项强制要求 `assignedTo` 必填且原生接口不支持清空负责人。创建未认领工作项时，底层用当前令牌用户填充原生 `assignedTo`，同时保持正文文件头 `<!-- DSH-ASSIGNEES: -->` 为空，读侧据此返回 `Issue.assignees = []`，使未认领子票正常进入 Wayfinder `frontier`。
- **企业默认关系矩阵下的自动降级双写**：云效企业默认未开启工作项间的原生 `DEPEND_ON` 依赖关系，且 `Bug` 类型不支持原生父子层级。本房间优先尝试原生关系接口，遇到关系矩阵 `400` 拒绝时自动降级写入文件头隐藏标记（`DSH-PARENT` / `DSH-BLOCKED-BY` + `Blocked by:`）并建立原生 `ASSOCIATED` 关联，读侧合并双源，确保开箱即用。

## 交接

接手这一房的人先读 `src/tracker/rooms/yunxiao/README.md` 与 `docs/adr/0001-yunxiao-projex-codeup-backend-architecture.md`——那两份写清了这一房与 GitHub、GitLab、本地 Markdown 三个房间不一样的地方。
