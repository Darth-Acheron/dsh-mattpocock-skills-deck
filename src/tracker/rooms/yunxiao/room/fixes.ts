/**
 * src/tracker/rooms/yunxiao/room/fixes.ts —— Yunxiao backend 交给环境检查页的修复动作（规格 #21 / #22 / #23 / #24）。
 *
 * 三项环境检查（yunxiao:authed / yunxiao:configured / yunxiao:repoAccess）共用面板内三步向导，
 * 不再把令牌或坐标提示词注入聊天框。Object.freeze 防止运行时被意外篡改。
 */

/**
 * 三项环境检查共用的一组向导步骤：
 *   - 第 1 步（#23）：深链打开云效个人访问令牌创建页 + 3 行最小权限勾选口诀 + 掩码密码框 + wf.yunxiaoSaveToken 在线验真与 0600 落盘；
 *   - 第 2 步与第 3 步（#24）：选择云效组织与 Yunxiao Projex 项目（含 MattDemo 错位预警与自动纠偏）+ 配置或创建 Codeup 代码库（三种模式 create / bind / none + 双源命名空间聚合 + SSH 免密自动探测）。
 */
const YUNXIAO_ONBOARDING_STEPS = [
  {
    title: { zh: '连接云效个人访问令牌', en: 'Connect Yunxiao personal access token' },
    stepAction: { type: 'rpc' as const, method: 'wf.yunxiaoSaveToken' },
    schema: [
      {
        name: 'token',
        type: 'password' as const,
        required: true,
        label: { zh: '个人访问令牌 (PAT)', en: 'Personal Access Token' },
        placeholder: { zh: '粘贴 pt-... 或个人访问令牌', en: 'Paste personal access token' },
        helperLink: {
          label: { zh: '打开云效令牌创建页 ↗', en: 'Open Yunxiao token page ↗' },
          url: 'https://account-devops.aliyun.com/settings/personalAccessToken',
        },
        helperLines: [
          { zh: '1. 组织管理 / 用户信息：只读', en: '1. Organization & User info: Read-only' },
          { zh: '2. 项目协作（Projex）项目与工作项：读写，项目成员：只读', en: '2. Projex projects & workitems: Read/Write, members: Read-only' },
          { zh: '3. 代码管理（Codeup）代码库：读写（代码组只读可选）', en: '3. Codeup repositories: Read/Write (groups read-only optional)' },
        ],
      },
    ],
  },
  {
    title: { zh: '组织与 Projex 项目', en: 'Organization & Projex project' },
    schema: [
      {
        name: 'organizationId',
        type: 'select' as const,
        required: true,
        label: { zh: '云效企业组织', en: 'Yunxiao Organization' },
        readOnlyWhenSingle: true,
        rehydrateOnChange: true,
      },
      {
        name: 'projectMode',
        type: 'radio' as const,
        required: true,
        label: { zh: 'Yunxiao Projex 项目模式', en: 'Projex Project Mode' },
        defaultValue: 'create',
        options: [
          { value: 'create', label: { zh: '按模板新建同名项目', en: 'Create new project' } },
          { value: 'reuse', label: { zh: '复用已有项目', en: 'Reuse existing project' } },
        ],
      },
      {
        name: 'projectId',
        type: 'select' as const,
        required: true,
        label: { zh: '选择已有 Yunxiao Projex 项目', en: 'Existing Projex Project' },
        visibleWhen: { field: 'projectMode', in: ['reuse', 'existing'] },
      },
      {
        name: 'projectName',
        type: 'text' as const,
        required: true,
        label: { zh: '新项目名称', en: 'New Project Name' },
        defaultFrom: 'cwd-basename',
        visibleWhen: { field: 'projectMode', equals: 'create' },
      },
      {
        name: 'customCode',
        type: 'text' as const,
        required: true,
        label: { zh: '项目代号（4~6 位字母）', en: 'Project Custom Code (4-6 letters)' },
        pattern: '^[A-Za-z]{4,6}$',
        visibleWhen: { field: 'projectMode', equals: 'create' },
      },
      {
        name: 'templateId',
        type: 'select' as const,
        required: false,
        label: { zh: '项目模板（默认 Scrum 敏捷）', en: 'Project Template (Scrum default)' },
        visibleWhen: { field: 'projectMode', equals: 'create' },
      },
    ],
  },
  {
    title: { zh: 'Codeup 仓库与打通', en: 'Codeup repository & publish' },
    schema: [
      {
        name: 'repoMode',
        type: 'radio' as const,
        required: true,
        label: { zh: 'Codeup 代码库模式', en: 'Codeup Repository Mode' },
        defaultValue: 'create',
        options: [
          { value: 'create', label: { zh: '新建 Codeup 代码库并推送', en: 'Create new Codeup repo & push' } },
          { value: 'bind', label: { zh: '关联已有 Codeup 代码库', en: 'Bind existing Codeup repo' } },
          { value: 'none', label: { zh: '跳过代码库（纯规划工作区）', en: 'Skip repository (planning only)' } },
        ],
      },
      {
        name: 'repositoryId',
        type: 'select' as const,
        required: true,
        label: { zh: '目标 Codeup 代码库', en: 'Target Codeup Repository' },
        visibleWhen: { field: 'repoMode', in: ['bind', 'bind-origin', 'existing'] },
      },
      {
        name: 'name',
        type: 'text' as const,
        required: true,
        label: { zh: '新建代码库名称', en: 'New Repository Name' },
        pattern: '^[A-Za-z0-9._-]+$',
        maxLength: 100,
        defaultFrom: 'cwd-basename',
        preview: { zh: '将在 Codeup 创建代码库 {name}', en: 'Will create Codeup repository {name}' },
        visibleWhen: { field: 'repoMode', equals: 'create' },
      },
      {
        name: 'namespaceId',
        type: 'select' as const,
        required: false,
        label: { zh: '所属代码组（命名空间）', en: 'Codeup Group / Namespace' },
        readOnlyWhenSingle: true,
        visibleWhen: { field: 'repoMode', equals: 'create' },
      },
      {
        name: 'visibility',
        type: 'radio' as const,
        required: true,
        label: { zh: '可见性', en: 'Visibility' },
        defaultValue: 'private',
        options: [
          { value: 'private', label: { zh: '私有（仅成员可见）', en: 'Private' } },
          { value: 'public', label: { zh: '企业内公开（internal）', en: 'Enterprise internal' } },
        ],
        visibleWhen: { field: 'repoMode', equals: 'create' },
      },
      {
        name: 'remoteProtocol',
        type: 'radio' as const,
        required: true,
        label: { zh: '远端克隆协议', en: 'Remote Clone Protocol' },
        defaultValue: 'auto',
        options: [
          { value: 'auto', label: { zh: '自动优选（SSH 免密优先）', en: 'Auto (prefer SSH)' } },
          { value: 'ssh', label: { zh: 'SSH', en: 'SSH' } },
          { value: 'https', label: { zh: 'HTTPS', en: 'HTTPS' } },
        ],
        visibleWhen: { field: 'repoMode', in: ['create', 'bind', 'existing'] },
      },
    ],
  },
]

/** 声明统一向导入口与本次检查应落到的初始步；支持通过 wf.yunxiaoDiscover 水合动态选项与初始步。 */
export function buildYunxiaoSetupWizardAction(initialStepIndex = 0) {
  return {
    type: 'wizard',
    label: { zh: '配置云效工作区', en: 'Configure Yunxiao workspace' },
    initialStepIndex,
    hydrateRpc: { method: 'wf.yunxiaoDiscover' },
    steps: YUNXIAO_ONBOARDING_STEPS,
    submitAction: { type: 'contract-op', op: 'initProject', params: {} },
  }
}

export const fixes = Object.freeze({
  'yunxiao:authed': {
    hint: {
      zh: '云效个人访问令牌缺失或无效。打开云效工作区向导，从令牌步骤开始，完成后重新检查。',
      en: 'The Yunxiao personal access token is missing or invalid. Open the workspace wizard at the token step, then re-check.',
    },
    actions: [
      buildYunxiaoSetupWizardAction(0),
      { type: 'refresh', target: 'chain' as const },
    ],
  },
  'yunxiao:configured': {
    hint: {
      zh: '令牌已有效，但尚未配置云效组织 ID 或 Yunxiao Projex 项目 ID。打开向导的项目步骤，完成后重新检查。',
      en: 'The token is valid, but the Yunxiao organization or project ID is not configured. Open the wizard at the project step, then re-check.',
    },
    actions: [
      buildYunxiaoSetupWizardAction(1),
      { type: 'refresh', target: 'chain' as const },
    ],
  },
  'yunxiao:repoAccess': {
    hint: {
      zh: '令牌与项目坐标已就绪，但无法访问目标 Yunxiao Projex 项目或关联的 Codeup 仓库。打开向导核对项目与仓库，完成后重新检查。',
      en: 'The token and project coordinates are ready, but the Yunxiao project or Codeup repository is inaccessible. Open the wizard to review them, then re-check.',
    },
    actions: [
      buildYunxiaoSetupWizardAction(1),
      { type: 'refresh', target: 'chain' as const },
    ],
  },
})
