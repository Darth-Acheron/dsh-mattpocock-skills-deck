# Yunxiao 后端：把本机与工作区配好（一段可以直接贴进对话框的提示词）

<!--
这份文件本身就是提示词。用户要用阿里云效（Yunxiao Projex + Codeup）当工单与代码库后端时，
把它整段贴进对话框，当时的 AI 就会带着用户把「准备个人访问令牌 → 获取组织与项目 ID → 写入工作区配置 → 通过环境检查」走完。
-->

你要帮用户把阿里云效（**Yunxiao Projex** + **Codeup**）后端配好。按下面的顺序走，每一步都先说清「为什么做这一步」和「怎么算做完了」。

## 一、顺序

1. **请用户创建云效个人访问令牌（Personal Access Token）**。
   这一步只能由用户本人在浏览器里完成：请用户打开云效个人设置中的个人访问令牌页面（`https://account-devops.aliyun.com/settings/personalAccessToken`），新建一枚令牌，权限至少勾选：
   - **组织管理 / 用户信息**：只读（用于 `GET /oapi/v1/platform/user` 校验令牌并读取当前账号身份）；
   - **项目协作（Projex）— 项目、工作项**：读写（用于读写工作项、评论、标签、工作流状态与关联关系）；
   - **代码管理（Codeup）— 代码仓库**：日常使用选「只读」即可；若需要通过面板一键创建并发布新代码库（`initProject`），再勾上「读写」。
   **安全红线**：提醒用户**绝不要把令牌直接发在聊天记录里，也绝不要写进仓库内的任何配置文件**。让用户把 `pt-` 开头的令牌存进本机受保护文件 `~/.config/yunxiao/token`（权限设为 `600`），或在终端环境变量中设置 `YUNXIAO_TOKEN`。
   判据：`test -s ~/.config/yunxiao/token` 或环境变量 `YUNXIAO_TOKEN` 非空，且不打印令牌原文。

2. **确认云效 24 位组织 ID（`organizationId`）与 26 位项目 ID（`projectId`）**。
   - 组织 ID：调用 `GET https://openapi-rdc.aliyuncs.com/oapi/v1/platform/user`（请求头带 `x-yunxiao-token`），回包中的 `lastOrganization`（或用户在云效企业管理后台看到的 24 位十六进制字符串）即为 `organizationId`。
   - 项目 ID：调用 `POST https://openapi-rdc.aliyuncs.com/oapi/v1/projex/organizations/{organizationId}/projects:search`（或从浏览器打开目标 **Yunxiao Projex** 项目网址 `https://devops.aliyun.com/projex/project/{projectId}`），拿到 26 位项目 `id`（即 `spaceId`）与项目代号 `customCode`。
   判据：拿到 24 位十六进制 `organizationId` 与 26 位 `projectId`。

3. **写入工作区非敏感配置文件 `docs/agents/yunxiao.yaml`**。
   在工作区下创建 `docs/agents/yunxiao.yaml`（只放组织、项目与可选仓库坐标，严禁放入 `token` 字段）：
   ```yaml
   version: 1
   organizationId: "<24位云效组织ID>"
   projectId: "<26位Projex项目ID>"
   customCode: "<可选项目代号，如 DCIAFS>"
   # repositoryId: "<可选 Codeup 仓库数字 ID 或路径>"
   # namespaceId: <可选 Codeup 默认父代码组数字 ID>
   ```
   判据：`docs/agents/yunxiao.yaml` 已生成，且运行面板「环境检查」时 `yunxiao:configured`、`yunxiao:authed`、`yunxiao:repoAccess` 三项全部变绿。

## 二、常见注意事项

1. **切勿在 `docs/agents/workspace.yaml` 中添加云效自定义字段**：`workspace.yaml` 仅用于记录 `backendId: yunxiao` 等 5 个固定字段；云效的组织与项目坐标一律放在独立的 `docs/agents/yunxiao.yaml` 中。
2. **无代码库的纯规划目录同样可用**：如果当前目录只是用来跑 `/wayfinder` 或 `/to-spec` 规划、还没有关联 **Codeup** 远端仓库，不需要填 `repositoryId`，环境预检在前三关通过后就会直接放行。
3. **Codeup 企业自定义路径别名**：如果 `git remote` 里的 **Codeup** 地址首段是企业自定义别名（如 `https://codeup.aliyun.com/myCompany/group/repo.git`），**Yunxiao backend** 会自动在全路径查询 404 时剥离首段重试，无需手工改写远端地址；若使用了未在 `~/.ssh/config` 暴露域名的自定义 SSH 别名，可在 `docs/agents/yunxiao.yaml` 中显式填写 `repositoryId`。
