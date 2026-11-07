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
