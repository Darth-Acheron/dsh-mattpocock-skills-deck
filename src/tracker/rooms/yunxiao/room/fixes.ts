/**
 * src/tracker/rooms/yunxiao/room/fixes.ts —— Yunxiao backend 交给环境检查页的修复动作（规格 #21 / #22 / #23）。
 *
 * 三项环境检查（yunxiao:authed / yunxiao:configured / yunxiao:repoAccess）共用面板内三步向导，
 * 不再把令牌或坐标提示词注入聊天框。Object.freeze 防止运行时被意外篡改。
 */

/**
 * 三项环境检查共用的一组向导步骤：
 *   - 第 1 步（#23）：深链打开云效个人访问令牌创建页 + 3 行最小权限勾选口诀 + 掩码密码框 + wf.yunxiaoSaveToken 在线验真与 0600 落盘；
 *   - 第 2 步与第 3 步（#24 扩展组织/项目/仓库发现与置备）：配合顶层 hydrateRpc (wf.yunxiaoDiscover) 动态水合。
 */
const YUNXIAO_ONBOARDING_STEPS = [
  {
    title: { zh: '连接云效个人访问令牌', en: 'Connect Yunxiao personal access token' },
    stepAction: { type: 'rpc', method: 'wf.yunxiaoSaveToken' },
    schema: [
      {
        name: 'token',
        type: 'password',
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
    schema: [],
  },
  {
    title: { zh: 'Codeup 仓库与打通', en: 'Codeup repository & publish' },
    schema: [
      { name: 'name', type: 'text', required: true, label: { zh: '仓库名', en: 'Repo name' }, pattern: '^[A-Za-z0-9._-]{1,100}$', defaultFrom: 'cwd-basename', preview: { zh: '将在 Codeup 创建仓库 {name}', en: 'Will create Codeup repository {name}' } },
      { name: 'visibility', type: 'single', label: { zh: '可见性', en: 'Visibility' }, options: ['private', 'public'], optionSubs: { private: { zh: '仅自己与项目成员', en: 'Private' }, public: { zh: '企业内公开（internal）', en: 'Enterprise internal' } }, defaultValue: 'private' },
    ],
  },
]

/** 声明统一向导入口与本次检查应落到的初始步；支持通过 wf.yunxiaoDiscover 水合动态选项与初始步。 */
function yunxiaoOnboardingWizard(initialStepIndex: number) {
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
      yunxiaoOnboardingWizard(0),
      { type: 'refresh', target: 'chain' },
    ],
  },
  'yunxiao:configured': {
    hint: {
      zh: '令牌已有效，但尚未配置云效组织 ID 或 Yunxiao Projex 项目 ID。打开向导的项目步骤，完成后重新检查。',
      en: 'The token is valid, but the Yunxiao organization or project ID is not configured. Open the wizard at the project step, then re-check.',
    },
    actions: [
      yunxiaoOnboardingWizard(1),
      { type: 'refresh', target: 'chain' },
    ],
  },
  'yunxiao:repoAccess': {
    hint: {
      zh: '令牌与项目坐标已就绪，但无法访问目标 Yunxiao Projex 项目或关联的 Codeup 仓库。打开向导核对项目与仓库，完成后重新检查。',
      en: 'The token and project coordinates are ready, but the Yunxiao project or Codeup repository is inaccessible. Open the wizard to review them, then re-check.',
    },
    actions: [
      yunxiaoOnboardingWizard(1),
      { type: 'refresh', target: 'chain' },
    ],
  },
})
