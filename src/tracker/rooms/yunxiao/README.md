# Yunxiao 房（云效 Projex + Codeup 后端房间）交接说明

这份文件写给「以后要改这一房的人」。房间的通用规矩（跨房引用怎么判、一次会话只改一个房间、零第三方 npm 依赖、单文件不超过 350 有效行）在上一级的 `src/tracker/rooms/README.md`，契约层的书面承诺在 `src/tracker/contract/README.md`，架构决策记录在 `docs/adr/0001-yunxiao-projex-codeup-backend-architecture.md`，这里不重复。**这一份只讲这一家与另外三家不一样的地方**。

能力账（27 条逐条登记：26 条真提供、1 条明确不支持）在 `docs/tracker/capability-yunxiao.md`。程序侧的同一份答案是 `support/capability-register.ts`，两边由门禁 `tests/verify-capability-register.ts` 逐条比对，改一边不改另一边会红。

**用户第一次在这台机器上配云效**（获取个人访问令牌、查询组织与项目 ID、配置工作区坐标）时，把同目录的 `SETUP-PROMPT.md` 整段贴进对话框即可。

## 一、这一家最要紧的六条不同

### 1. 零第三方依赖的可注入 HTTP 传输层（`client.ts`）与分页头铁律

不同于 GitHub（`gh` CLI）与 GitLab（`glab` CLI），云效没有通用官方 CLI，本房间直接通过 `client.ts` 调用云效 OpenAPI（默认 `https://openapi-rdc.aliyuncs.com`，请求头 `x-yunxiao-token`）：

- **零第三方 npm 包依赖**：使用 Node 24 内置的 `fetch` 与 `AbortSignal.timeout`，并支持经 `ctx.fetch` 注入自定义 `fetch` 实现，使 `tests/verify-yunxiao-room.ts` 能够 100% 离线确定性运行。
- **分页判断只看 `xPage < xTotalPages`**：真机实测证实，云效 OpenAPI 在单页或最后一页响应时仍会返回非空的 `x-next-page`（例如共 1 页时仍返回 `x-next-page: "1"` 或 `"2"`）。因此翻页循环必须且只能调用 `hasNextYunxiaoPage(res.headers)`（严格比较 `xPage < xTotalPages`），绝不能看 `x-next-page` 是否非空。
- **处理 `HTTP 204 No Content`**：项目标签列表（当项目尚无标签时）、更新工作项、删除工作项关联等接口会返回 `HTTP 204` 空响应体，`client.ts` 与调用方将其作为正常成功响应处理（`listLabels` 归一为 `[]`）。
- **独立出站冷却桶**：`client.ts` 调用 `ctx.outbound.acquire({ service: 'yunxiao', bucket })`，与 GitHub、GitLab、本地 Git 的 30 秒超时冷却窗口相互隔离。

### 2. 对外统一暴露纯数字 `Issue.key`，房间内双向桥接 `serialNumber` 与 26 位 `id`

- **Yunxiao Projex** 工作项同时拥有 26 位十六进制内部 `id`（`UpdateWorkitem`、关系写、工作流查询必填）与带项目前缀的 `serialNumber`（如 `DCIAFS-2`，`GetWorkitem`、评论、子项查询可用）。
- Deck 核心链路（`refresh-chain.ts`、`work-path-record.ts`、`issue-report.ts`、`SessionChainCapsule.ts`、`edge-landing.ts`）多处校验纯数字票号。因此本房间对外统一暴露剥离 `${customCode}-` 前缀后的纯数字字符串（如 `"1"`、`"2"`），并在 `model/description-markers.ts` 维护进程内映射缓存，入参同时兼容纯数字、`${customCode}-${n}` 与 26 位内部 `id`。

### 3. 以文件头 `<!-- DSH-ASSIGNEES: ... -->` 作为认领真源

- **Yunxiao Projex** 创建工作项时 `assignedTo` 为必填字段，且 `UpdateWorkitem` 不支持清空负责人；而 Wayfinder `frontier` 要求未认领子票的 `Issue.assignees` 必须为 `[]`。
- 创建未认领票（`assignees: []`）时，房间用 `GET /oapi/v1/platform/user` 缓存的当前令牌用户 24 位 `id` 填入原生必填字段 `assignedTo`，正文文件头不写或写空 `<!-- DSH-ASSIGNEES: -->`，读侧据此返回 `Issue.assignees = []`。
- 调用 `setAssignees` 认领或释放时，重写文件头 `<!-- DSH-ASSIGNEES: ... -->` 作为契约真源，并同步更新原生 `assignedTo` 与 `participants`（释放时将 `participants` 置 `[]`）。

### 4. 父子与阻塞关系采用「原生接口优先 + 文件头隐藏标记与 `ASSOCIATED` 自动降级双写」

- **父子关系（`setParent` / `listSubIssues`）**：成对写入文件头 `<!-- DSH-PARENT: <key> -->` 与原生 `parentId`。当 `Bug` 等类型因企业默认关系矩阵不支持原生父子层级返回 `400` 时，自动保留 `DSH-PARENT` 并建立原生 `ASSOCIATED` 关联；读侧将 `parentId` 的 `null`/`""`/`"EMPTY_VALUE"` 归一为无父项，合并原生 `SUB` 子项与 `DSH-PARENT` 扫描结果。
- **阻塞关系（`setBlockedBy` / `getDependencies`）**：先做图环检测，优先尝试原生 `DEPEND_ON`；若企业默认矩阵拒绝 `DEPEND_ON` 返回 `400`，自动回退写入成对正文标记（`Blocked by: #n` + `<!-- DSH-BLOCKED-BY: n -->`）并建立原生 `ASSOCIATED` 关联，读侧合并双源并推导反向 `blocking` 边。

### 5. 独立工作区坐标配置（`docs/agents/yunxiao.yaml`）与只读凭证红线

- 为保持 `docs/agents/workspace.yaml` 的 `KNOWN_KEYS` 零改动，云效组织 ID（`organizationId`）、**Yunxiao Projex** 项目 ID（`projectId`）、可选 `customCode`、可选 **Codeup** `repositoryId` / `namespaceId` 存放在独立的 `docs/agents/yunxiao.yaml`（或 `YUNXIAO_*` 环境变量）。
- 个人访问令牌（`x-yunxiao-token`）只允许从 `YUNXIAO_TOKEN` / `ALIBABA_CLOUD_DEVOPS_TOKEN`、`YUNXIAO_TOKEN_FILE` 或 `~/.config/yunxiao/token` 只读加载；`yunxiao.yaml` 中一旦出现 `token`/`pat` 等敏感键立即报错拒绝。

### 6. Projex 项目与 Codeup 代码库解耦，双步 `GetRepository` 解析与角色权限判定

- `RepositoryRef.refId` 固定锚定 `"${organizationId}/${projectId}"`，支持无代码库的纯 **Yunxiao Projex** 规划工作区（`preflight` 前 3 关通过即成功，`getRepoPermissions` 返回 `{ push: false, triage: true }`）。
- 关联 **Codeup** 仓库时，按「环境变量 > `yunxiao.yaml` > `git origin` > `.git/config`」四级发现，经「全路径 `%2F` 优先 → 非 24 位组织首段 `404 SYSTEM_NOT_FOUND_ERROR` 自动剥离重试」双步解析锁定权威数字 `id` 与 `pathWithNamespace`。
- 实测证实只读令牌下 `GetRepository` 的 `allowPush` 恒为 `false`，因此 `getRepoPermissions` 严格按未归档且 `Number(accessLevel) >= 30` 判定 `push` 权限。

## 二、目录树

路径相对 `src/tracker/rooms/yunxiao/`，与 GitLab 房间采用相同的按领域概念竖切结构：

```
src/tracker/rooms/yunxiao/
├── index.ts                 入口：yunxiaoBackend 模块对象、工厂 createYunxiaoBackend、matches 与 describe
├── requests.ts              请求边界：每个云效 OpenAPI 端点一个具名函数
├── client.ts                传输层：Node 24 fetch / 可注入 fetch、分页头提取、出站准入与请求记账
├── queries.ts               OpenAPI 路径与查询串拼装
├── errors.ts                错误判档唯一出口（YUNXIAO_ERROR_RULES / classifyYunxiaoError / failYunxiao）
├── preflight.ts             四步递进式环境预检探针
├── budget.ts                额度探针（requests-only 口径）
├── README.md                这份交接说明
├── SETUP-PROMPT.md          用户第一次配置云效后端的现场指引
├── model/
│   ├── normalize.ts         云效工作项原始 JSON → 契约 Issue 归一
│   ├── description-markers.ts  文件头隐藏标记（DSH-ISSUE-KIND / DSH-ASSIGNEES / DSH-PARENT / DSH-BLOCKED-BY）与票号桥接缓存
│   ├── repo-identity.ts     Codeup 远端 URL 解析（parseCodeupRepo）与 learnedYunxiaoContext 缓存
│   └── workspace-config.ts  零依赖 docs/agents/yunxiao.yaml 解析器与三层只读令牌加载
├── issues/
│   ├── read.ts              列表与单票读取、摘要详情并发补齐
│   ├── write.ts             建票（六种位置映射与 Bug 回退）、改票、关票（流转阶段 4）、重开
│   ├── shared.ts            工作项读写共用的详情拉取、评论富化与标签过滤助手
│   ├── idempotency.ts       建票幂等锚（DSH-IDEMPOTENCY-KEY）写入与回查
│   ├── counts.ts            open / closed / total 计数
│   ├── pages.ts             分页读取（严格按 xPage < xTotalPages 判尾页）
│   ├── maps.ts              探索地图薄行查询（listMaps）
│   └── sub-issues.ts        子工作项查询（原生 SUB + DSH-PARENT 合并）
├── comments/
│   └── write.ts             Markdown 评论写入
├── labels/
│   ├── assign.ts            工作项标签指派与清空
│   ├── list.ts              项目标签列表（含 HTTP 204 空响应归一）
│   └── colors.ts            批量改标签颜色与创建
├── graph/
│   ├── read.ts              阻塞依赖读取、双源合并与反向 blocking 推导
│   ├── write.ts             阻塞依赖写入、写前环检与 400 自动降级成对标记 + ASSOCIATED
│   └── membership.ts        父子挂载（setParent 双写与 400 降级）及认领指派（setAssignees）
├── repo/
│   ├── identity.ts          getRepoKey、Codeup 四级发现与双步 GetRepository 解析
│   ├── current-user.ts      当前令牌用户查询（GET /oapi/v1/platform/user）
│   └── permissions.ts       Projex + Codeup 权限判定（getRepoPermissions）
├── project/
│   └── init-project.ts      Codeup 一键开仓发布（CreateRepository + GetRepository + git push）
├── support/
│   ├── capability-register.ts  27 条能力的数据化回答（26 条 provided + 1 条 unsupported-by-design）
│   ├── read-log.ts          读路径诊断日志出口（read.degraded / preflight.gate / repo.resolve.tier）
│   └── read-sources.ts      12 条读操作的默认读来源声明
└── room/
    ├── links.ts            网页地址模板、issueAddress 与 repoSearchAddress
    ├── prompts.ts          契约注入、修复指引、体检文案与云效跟踪器模板
    └── fixes.ts            面板三项环境检查（yunxiao:configured / authed / repoAccess）的修复动作
```

## 三、改这一房之前先跑什么

- 全仓类型检查与配置校验：`npm run typecheck`
- 云效配置、远端解析与脱敏单测：`node --import ./scripts/ts-hook.mts tests/verify-yunxiao-config-and-remote.ts`
- 云效房间离线契约门禁：`node --import ./scripts/ts-hook.mts tests/verify-yunxiao-room.ts`
- 能力登记三处对齐门禁：`node --import ./scripts/ts-hook.mts tests/verify-capability-register.ts`
- 文件粒度与依赖规则门禁：`node --import ./scripts/ts-hook.mts tests/verify-file-granularity.ts` 与 `node --import ./scripts/ts-hook.mts tests/verify-dependency-rules.ts`
- 按需真机沙箱冒烟（需显式设置环境变量）：`YUNXIAO_LIVE_VERIFY=1 node --import ./scripts/ts-hook.mts scripts/real-machine/commands/yunxiao-sandbox.mts`
