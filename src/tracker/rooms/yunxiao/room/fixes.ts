/**
 * src/tracker/rooms/yunxiao/room/fixes.ts —— Yunxiao backend 交给环境检查页的修复指引（规格 #02）。
 *
 * 三项环境检查（yunxiao:configured / yunxiao:authed / yunxiao:repoAccess）的修复动作，
 * 使用 Object.freeze 冻结以防运行时被意外篡改。
 */
export const fixes = Object.freeze({
  'yunxiao:configured': {
    hint: {
      zh: '未配置云效组织 ID 或 Yunxiao Projex 项目 ID。点「配置指引」写入 docs/agents/yunxiao.yaml，完成后重查。',
      en: 'Yunxiao organizationId or projectId is not configured. Use the configuration guide to set up docs/agents/yunxiao.yaml, then re-check.',
    },
    actions: [
      { type: 'inject-prompt', prompt: 'yunxiaoConfigFix', label: { zh: '配置指引', en: 'Config guide' } },
      { type: 'refresh', target: 'chain' },
    ],
  },
  'yunxiao:authed': {
    hint: {
      zh: '云效个人访问令牌（x-yunxiao-token）缺失或无效。点「令牌指引」配置只读凭证文件或环境变量，完成后重查。',
      en: 'Yunxiao personal access token (x-yunxiao-token) is missing or invalid. Use the token guide to configure it, then re-check.',
    },
    actions: [
      { type: 'inject-prompt', prompt: 'yunxiaoLoginFix', label: { zh: '令牌指引', en: 'Token guide' } },
      { type: 'refresh', target: 'chain' },
    ],
  },
  'yunxiao:repoAccess': {
    hint: {
      zh: '无法访问目标 Yunxiao Projex 项目或关联的 Codeup 仓库，或尚未创建远端仓库。可点「创建并发布」新建 Codeup 仓库，或点「排查指引」核对项目坐标。',
      en: 'Cannot access the target Yunxiao Projex project or associated Codeup repository. Click "Create & publish" to create a Codeup repo, or "Troubleshoot" to verify coordinates.',
    },
    actions: [
      {
        type: 'wizard',
        label: { zh: '创建并发布', en: 'Create & publish' },
        steps: [
          {
            title: { zh: '仓库信息', en: 'Repository info' },
            schema: [
              { name: 'name', type: 'text', required: true, label: { zh: '仓库名', en: 'Repo name' }, pattern: '^[A-Za-z0-9._-]{1,100}$', defaultFrom: 'cwd-basename', preview: { zh: '将创建 https://codeup.aliyun.com/{owner}/{name}', en: 'Will create https://codeup.aliyun.com/{owner}/{name}' } },
            ],
          },
          {
            title: { zh: '可见性', en: 'Visibility' },
            schema: [
              { name: 'visibility', type: 'single', label: { zh: '可见性', en: 'Visibility' }, options: ['private', 'public'], optionSubs: { private: { zh: '仅自己与项目成员', en: 'Private' }, public: { zh: '企业内公开（internal）', en: 'Enterprise internal' } }, defaultValue: 'private' },
            ],
          },
        ],
        submitAction: { type: 'contract-op', op: 'initProject', params: {} },
      },
      { type: 'inject-prompt', prompt: 'yunxiaoRepoFix', label: { zh: '排查指引', en: 'Troubleshoot' } },
      { type: 'refresh', target: 'chain' },
    ],
  },
})
