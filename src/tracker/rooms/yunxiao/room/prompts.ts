/**
 * src/tracker/rooms/yunxiao/room/prompts.ts —— Yunxiao backend 交给契约注入、修复指引与体检的提示文案（规格 #02）。
 *
 * 对齐 `src/tracker/rooms/gitlab/room/prompts.ts` 与提示词门禁规则（不出现任何裸命令或插件目录解析脚本，
 * 建边、快照与体检一律走 `deck_*` 契约工具）。
 */

const yunxiaoConfigCopy = {
  zh: '请在工作区的 docs/agents/yunxiao.yaml（或环境变量 YUNXIAO_ORGANIZATION_ID、YUNXIAO_PROJECT_ID）中配置云效 24 位组织 ID 与 26 位 Yunxiao Projex 项目 ID；切勿将个人访问令牌写进仓库配置文件。配置完成后请用户点「重查」。',
  en: 'Configure the 24-character organizationId and 26-character Yunxiao Projex projectId in docs/agents/yunxiao.yaml (or via YUNXIAO_ORGANIZATION_ID and YUNXIAO_PROJECT_ID environment variables). Never write personal access tokens into repository configuration files. Then ask the user to re-check.',
}

const yunxiaoTokenCopy = {
  zh: '请配置云效个人访问令牌（x-yunxiao-token）：通过环境变量 YUNXIAO_TOKEN、YUNXIAO_TOKEN_FILE 或本机受保护文件 ~/.config/yunxiao/token 提供只读或读写令牌（需开启组织管理用户只读、项目协作项目与工作项读写、代码管理代码仓库只读或读写权限）。配置完成后请用户点「重查」。',
  en: 'Configure a Yunxiao personal access token (x-yunxiao-token) via YUNXIAO_TOKEN, YUNXIAO_TOKEN_FILE, or the protected file ~/.config/yunxiao/token with User read, Projex project/workitem read-write, and Codeup repository permissions. Then ask the user to re-check.',
}

/**
 * 云效议题跟踪器说明模板（对应 `issue-tracker-yunxiao.md` 的英文原文与中文译文）。
 * 为什么存放在此而不直接塞进 `package/bundled-skills/setup-matt-pocock-skills/`：
 *   上游同步脚本 `scripts/sync-matt-skills.mts` 会整目录重建 `bundled-skills`，且门禁
 *   `tests/verify-bundled-skills-upstream.ts` 强制校验该目录下文件集合与上游哈希清单双向差集为空。
 *   将模板作为静态常量提供给 `skillDoc.ts` 的 `CHOICE_REFS['issue-tracker.md']`，既能完整支持
 *   云效跟踪器模板浏览与生成，又保证上游捆绑技能目录 100% 零污染。
 */
export const YUNXIAO_ISSUE_TRACKER_TEMPLATE = {
  en: [
    '# Issue tracker: Yunxiao',
    '',
    'Issues and specs for this repo live as Aliyun **Yunxiao Projex** work items, and code is hosted in **Codeup** (or in a standalone planning workspace). Read and write all issues, maps, specs, and relationships exclusively through the `deck_*` tools (`deck_context`, `deck_issue_list`, `deck_issue_get`, `deck_issue_create`, `deck_issue_patch`, `deck_issue_report`, `deck_map_link`, `deck_map_plan_create`, `deck_map_snapshot`).',
    '',
    '## Workspace Configuration (`docs/agents/yunxiao.yaml`)',
    '',
    '- Configure non-sensitive workspace coordinates in `docs/agents/yunxiao.yaml` (`version: 1`) or via `YUNXIAO_*` environment variables:',
    '  - `organizationId`: 24-character hex Aliyun Yunxiao organization ID.',
    '  - `projectId`: 26-character **Yunxiao Projex** project `spaceId`.',
    '  - `customCode` (optional): project prefix (auto-discovered via `GetProject` when omitted).',
    '  - `repositoryId` (optional): **Codeup** repository ID or path override.',
    '  - `namespaceId` (optional): default **Codeup** parent group ID for `initProject`.',
    '- **Never** commit personal access tokens (`x-yunxiao-token`) to repository files. Load tokens exclusively from `YUNXIAO_TOKEN`, `ALIBABA_CLOUD_DEVOPS_TOKEN`, `YUNXIAO_TOKEN_FILE`, or `~/.config/yunxiao/token`.',
    '',
    '## Conventions',
    '',
    '- **Issue keys**: Deck exposes pure numeric issue keys (`"1"`, `"2"`) stripped of the project prefix, while accepting numeric keys, `${customCode}-${n}` serial numbers, or 26-character internal IDs on input.',
    '- **Create an issue / spec / map**: Call `deck_issue_create` with `kind` (`map` / `spec` map to Requirement `Req`; `map-ticket` / `spec-ticket` / `issue` map to Task `Task`; `bug` maps to Bug `Bug` with automatic fallback to `Task` + `bug` label).',
    '- **Read / list / comment / label / close**: Use `deck_issue_get`, `deck_issue_list`, and `deck_issue_patch` (closing transitions the work item to the workflow status in stage `4`).',
    '',
    '## Wayfinding Operations',
    '',
    '- **Map**: Created via `deck_issue_create(kind="map")` or `deck_map_plan_create`, carrying the `wayfinder:map` label.',
    '- **Child tickets & parent-child edges**: Wired via `parentKey` in `deck_issue_create` or `deck_map_link`. The **Yunxiao backend** dual-writes the `<!-- DSH-PARENT: <key> -->` header marker and native `parentId` (automatically falling back to `DSH-PARENT` + native `ASSOCIATED` relation when disallowed by the enterprise matrix).',
    '- **Blocking edges**: Wired via `blockedBy` in `deck_issue_create` or `deck_map_link`. Attempts native `DEPEND_ON` first and automatically falls back to paired markers (`Blocked by: #n` + `<!-- DSH-BLOCKED-BY: n -->`) + native `ASSOCIATED` relation.',
    '- **Claim & frontier**: Unclaimed tickets keep `<!-- DSH-ASSIGNEES: -->` empty so `Issue.assignees` is `[]` on the Wayfinder `frontier`, while satisfying **Yunxiao Projex** mandatory `assignedTo` with the current token owner. Claim and release via `deck_issue_patch(assignees=[...])`.',
    '',
  ].join('\n'),
  zh: [
    '# 议题跟踪器：Yunxiao',
    '',
    '这个仓库的议题、探索地图和规格说明都作为阿里云效 **Yunxiao Projex** 工作项托管，代码托管在 **Codeup**（或作为无代码库的纯规划工作区使用）。所有议题、地图、规格与关系读写一律通过 `deck_*` 工具完成（`deck_context`、`deck_issue_list`、`deck_issue_get`、`deck_issue_create`、`deck_issue_patch`、`deck_issue_report`、`deck_map_link`、`deck_map_plan_create`、`deck_map_snapshot`）。',
    '',
    '## 工作区配置（`docs/agents/yunxiao.yaml`）',
    '',
    '- 在 `docs/agents/yunxiao.yaml`（`version: 1`）或 `YUNXIAO_*` 环境变量中配置非敏感坐标：',
    '  - `organizationId`：24 位十六进制云效组织 ID。',
    '  - `projectId`：26 位 **Yunxiao Projex** 项目 `spaceId`。',
    '  - `customCode`（可选）：项目编号前缀（省略时由 `GetProject` 自动读取并缓存）。',
    '  - `repositoryId`（可选）：**Codeup** 代码库数字 ID 或路径覆盖。',
    '  - `namespaceId`（可选）：`initProject` 一键开仓时的默认 **Codeup** 父代码组 ID。',
    '- **严禁**将个人访问令牌（`x-yunxiao-token`）写入仓库配置文件。令牌只允许通过环境变量 `YUNXIAO_TOKEN`、`ALIBABA_CLOUD_DEVOPS_TOKEN`、`YUNXIAO_TOKEN_FILE` 或本机受保护文件 `~/.config/yunxiao/token` 提供。',
    '',
    '## 约定',
    '',
    '- **议题编号（Issue Key）**：对外统一暴露剥离项目前缀后的纯数字编号（如 `"1"`、`"2"`），入参同时兼容纯数字、`${customCode}-${n}` 序列号与 26 位内部 ID。',
    '- **创建议题 / 规格 / 地图**：使用 `deck_issue_create` 指定 `kind`（`map` 与 `spec` 映射为需求 `Req`；`map-ticket`、`spec-ticket` 与 `issue` 映射为任务 `Task`；`bug` 映射为缺陷 `Bug`，未启用缺陷类型时自动回退为带 `bug` 标签的任务）。',
    '- **读取 / 列表 / 评论 / 标签 / 关闭**：使用 `deck_issue_get`、`deck_issue_list` 与 `deck_issue_patch`（关闭时自动流转至工作流阶段为 `4` 的已完成状态）。',
    '',
    '## 寻路操作',
    '',
    '- **地图**：通过 `deck_issue_create(kind="map")` 或 `deck_map_plan_create` 创建，带 `wayfinder:map` 标签。',
    '- **子工单与父子边**：通过 `deck_issue_create` 或 `deck_map_link` 的 `parentKey` 建立。**Yunxiao backend** 成对写入文件头 `<!-- DSH-PARENT: <key> -->` 标记与原生 `parentId`（当企业默认关系矩阵拒绝原生父子层级时，自动回退为 `DSH-PARENT` 加原生 `ASSOCIATED` 关联）。',
    '- **阻塞边**：通过 `deck_issue_create` 或 `deck_map_link` 的 `blockedBy` 建立。优先尝试原生 `DEPEND_ON`，若被企业关系矩阵拒绝则自动回退写入成对正文标记（`Blocked by: #n` 与 `<!-- DSH-BLOCKED-BY: n -->`）并建立原生 `ASSOCIATED` 关联。',
    '- **认领与前沿（Frontier）**：新建未认领工单以当前令牌用户填充原生必填 `assignedTo`，同时保持文件头 `<!-- DSH-ASSIGNEES: -->` 为空，使 `Issue.assignees` 返回 `[]` 进入 `frontier`；通过 `deck_issue_patch(assignees=[...])` 认领与释放。',
    '',
  ].join('\n'),
}

/** Yunxiao 房间交给契约注入与修复指引的全部提示文案。 */
export const prompts = {
  commandVocabulary: { cli: 'yunxiao-openapi', cliBrand: 'Yunxiao' },
  yunxiaoConfigFix: { ...yunxiaoConfigCopy },
  yunxiaoLoginFix: { ...yunxiaoTokenCopy },
  cliInstall: { ...yunxiaoConfigCopy },
  cliLogin: { ...yunxiaoTokenCopy },
  yunxiaoRepoFix: {
    zh: '当前工作区未能访问目标 Yunxiao Projex 项目或关联的 Codeup 仓库。请核对：\nA. docs/agents/yunxiao.yaml 中的 organizationId 与 projectId 是否属于当前令牌所在企业；\nB. 若关联了 Codeup 代码库，核对远端地址或 repositoryId 是否有读取权限；\n完成后请用户点「重查」。',
    en: 'Cannot access the target Yunxiao Projex project or associated Codeup repository. Verify that organizationId and projectId in docs/agents/yunxiao.yaml belong to the current token organization, and check Codeup repository access if a repository is linked; then ask the user to re-check.',
  },
  subIssue: {
    zh: '建边用 deck_map_link：父子边传 parentKey、阻塞边传 blockedBy。Yunxiao backend 对父子边与阻塞边均采用「原生接口优先 + 文件头隐藏标记（DSH-PARENT / DSH-BLOCKED-BY）与 ASSOCIATED 关联自动降级双写」，确保企业默认关系矩阵下也能完整读回。建完用 deck_map_snapshot 读回地图，核对子票张数与预期一致。',
    en: 'Wire edges with deck_map_link: parentKey for parent-child edges, blockedBy for blocking edges. The Yunxiao backend dual-writes native relations first and automatically falls back to header markers (DSH-PARENT / DSH-BLOCKED-BY) plus native ASSOCIATED relations when disallowed by the enterprise matrix. Read the map back with deck_map_snapshot to confirm the child count.',
  },
  healthCheck: {
    zh: '**游离的开放票**在这条后端上的落地口径：这张票**没有关闭**、**自己不是地图**、**不在任何地图的子票里**。\n\n**动手时只做两件结构动作**，都走工具：\n1. 建边，把票挂到合适的地图下：deck_map_link 的 parentKey；\n2. 为人点过头的票开一张新地图：deck_map_plan_create 先写最小的 Destination 草稿。\n\n**本后端的能力说明**：父子关系优先写原生 parentId 并同步写文件头 DSH-PARENT 标记（缺陷类型在企业默认矩阵不支持原生父子时自动回退为 DSH-PARENT 加 ASSOCIATED 关联）。\n\n**不碰**：已关闭的票、任何票的标题与正文、标签与认领状态、别的仓库；不关票、不删评论、不改源码、不发版、不提交。',
    en: '**How "orphaned open ticket" lands on this backend**: the ticket is **not closed**, it is **not itself a map**, and it is **not inside any map as a sub-ticket**.\n\n**When acting, only two structural actions**, both through the tools:\n1. Wire the edge that attaches the ticket under a suitable map: deck_map_link with parentKey;\n2. Open a new map for a ticket the human has nodded on: deck_map_plan_create, writing only the minimal Destination draft.\n\n**Capability note**: parent-child edges dual-write native parentId and the DSH-PARENT header marker (automatically falling back to DSH-PARENT plus ASSOCIATED when disallowed by the enterprise matrix).\n\n**Never touch**: closed tickets, any ticket title or body, labels and claim state, other repositories; do not close tickets, delete comments, change source code, publish a release, or commit.',
  },
}
