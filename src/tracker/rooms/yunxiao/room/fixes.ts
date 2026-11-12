/**
 * src/tracker/rooms/yunxiao/room/fixes.ts —— Yunxiao backend 交给环境检查页的修复动作（规格 #21 / #22）。
 *
 * 三项环境检查（yunxiao:authed / yunxiao:configured / yunxiao:repoAccess）共用面板内三步向导，
 * 不再把令牌或坐标提示词注入聊天框。Object.freeze 防止运行时被意外篡改。
 */

/**
 * 三项环境检查共用的一组向导步骤。本票只声明令牌、项目、仓库三个位置：
 * 密码字段与令牌落盘由 #23 接线，组织/项目/仓库发现与置备由 #24 接线。
 * 不在本票用普通文本框收集令牌，避免在主入口里引入明文凭证输入。
 */
const YUNXIAO_ONBOARDING_STEPS = [
  {
    title: { zh: '连接云效个人访问令牌', en: 'Connect Yunxiao personal access token' },
    schema: [],
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

/** 声明统一向导入口与本次检查应落到的初始步；initialStepIndex 的客户端接线由 #23 完成。 */
function yunxiaoOnboardingWizard(initialStepIndex: number) {
  return {
    type: 'wizard',
    label: { zh: '配置云效工作区', en: 'Configure Yunxiao workspace' },
    initialStepIndex,
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
