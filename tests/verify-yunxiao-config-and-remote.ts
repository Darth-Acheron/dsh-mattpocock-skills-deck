#!/usr/bin/env node
/**
 * tests/verify-yunxiao-config-and-remote.ts —— Yunxiao backend 配置、脱敏、远端识别、票号标记与传输底座门禁（规格 #01）。
 *
 * 门禁归属: src/tracker/rooms/yunxiao/model/workspace-config.ts
 * 门禁归属: src/tracker/rooms/yunxiao/model/repo-identity.ts
 * 门禁归属: src/tracker/rooms/yunxiao/model/description-markers.ts
 * 门禁归属: src/tracker/rooms/yunxiao/client.ts
 * 门禁归属: src/tracker/rooms/yunxiao/queries.ts
 * 门禁归属: src/tracker/rooms/yunxiao/requests.ts
 * 门禁归属: src/tracker/rooms/yunxiao/errors.ts
 * 门禁归属: src/tracker/rooms/yunxiao/budget.ts
 * 门禁归属: src/tracker/rooms/yunxiao/support/read-log.ts
 * 门禁归属: src/tracker/kernel/error-rules.ts
 * 门禁归属: src/refresh/rooms/host/outbound-admission.ts
 *
 * 用法：node --import ./scripts/ts-hook.mts tests/verify-yunxiao-config-and-remote.ts
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { printGateResult } from './lib/gate-result.ts'

const GATE = 'verify-yunxiao-config-and-remote'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
let total = 0

function check(ok: boolean, msg: string, detail?: unknown): void {
  total += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg + (ok || detail === undefined ? '' : ' —— ' + JSON.stringify(detail)))
  if (!ok) failed += 1
}

const imp = (rel: string): Promise<any> => import(pathToFileURL(path.join(ROOT, rel)).href)

async function main(): Promise<void> {
  console.log('== Slice 1：Yunxiao 工作区配置解析、只读凭证通道与全链路脱敏 ==')
  const cfgMod = await imp('src/tracker/rooms/yunxiao/model/workspace-config.ts')
  const errRulesMod = await imp('src/tracker/kernel/error-rules.ts')

  // 1.1 标准 YAML 解析与字段归一化
  const validYaml = [
    '# 云效工作区非敏感坐标配置',
    'version: 1',
    'organizationId: 673db5665c76405a332eebc4',
    'projectId: 8efcbccd3981cb23178fc66bd1',
    'customCode: DCIAFS',
    'repositoryId: "7360166"',
    'namespaceId: 2076563',
    'apiBaseUrl: https://openapi-rdc.aliyuncs.com/',
    'webBaseUrl: https://devops.aliyun.com/',
  ].join('\n')
  const parsed1 = cfgMod.parseYunxiaoConfigText(validYaml)
  check(
    parsed1.ok === true &&
      parsed1.value.organizationId === '673db5665c76405a332eebc4' &&
      parsed1.value.projectId === '8efcbccd3981cb23178fc66bd1' &&
      parsed1.value.customCode === 'DCIAFS' &&
      parsed1.value.repositoryId === '7360166' &&
      parsed1.value.namespaceId === 2076563 &&
      parsed1.value.apiBaseUrl === 'https://openapi-rdc.aliyuncs.com' &&
      parsed1.value.webBaseUrl === 'https://devops.aliyun.com',
    '1.1 标准 docs/agents/yunxiao.yaml 解析成功并规范化结尾斜杠与数字 namespaceId',
    parsed1,
  )

  // 1.2 内联凭证字段立即拒绝（防泄漏进版本库）
  for (const secretKey of ['token', 'pat', 'accessToken', 'x-yunxiao-token']) {
    const badSecretYaml = [
      'version: 1',
      'organizationId: 673db5665c76405a332eebc4',
      'projectId: 8efcbccd3981cb23178fc66bd1',
      secretKey + ': pt-secret1234567890',
    ].join('\n')
    const r = cfgMod.parseYunxiaoConfigText(badSecretYaml)
    check(
      r.ok === false && r.reason === 'inline-secret',
      '1.2 严禁在 yunxiao.yaml 内联写入凭证键 ' + secretKey,
      r,
    )
  }

  // 1.3 未知字段立即拒绝
  const unknownKeyYaml = [
    'version: 1',
    'organizationId: 673db5665c76405a332eebc4',
    'projectId: 8efcbccd3981cb23178fc66bd1',
    'unknownField: foo',
  ].join('\n')
  const rUnknown = cfgMod.parseYunxiaoConfigText(unknownKeyYaml)
  check(
    rUnknown.ok === false && rUnknown.reason === 'unknown-keys' && Array.isArray(rUnknown.keys) && rUnknown.keys.includes('unknownField'),
    '1.3 对未知字段立即报错拒绝并列出未知键名',
    rUnknown,
  )

  // 1.4 环境变量覆盖优先级（环境变量 > yunxiao.yaml）
  const resolved = await cfgMod.resolveYunxiaoCoordinates({
    cwd: '/ws-yunxiao',
    fs: {
      resolve: async (p: string) => '/ws-yunxiao/' + p,
      readText: async () => validYaml,
      writeText: async () => {},
    },
    env: {
      get: (k: string) => {
        if (k === 'YUNXIAO_PROJECT_ID') return '25ac2befde335fcc2218d7c8bb'
        if (k === 'YUNXIAO_CUSTOM_CODE') return 'OVERRIDE'
        if (k === 'YUNXIAO_REPOSITORY_ID') return '673db5665c76405a332eebc4/Apple/repo'
        if (k === 'YUNXIAO_NAMESPACE_ID') return '999999'
        return undefined
      },
      has: () => false,
    },
  })
  check(
    resolved.ok === true &&
      resolved.value.organizationId === '673db5665c76405a332eebc4' &&
      resolved.value.projectId === '25ac2befde335fcc2218d7c8bb' &&
      resolved.value.customCode === 'OVERRIDE' &&
      resolved.value.repositoryId === '673db5665c76405a332eebc4/Apple/repo' &&
      resolved.value.namespaceId === 999999,
    '1.4 YUNXIAO_* 环境变量覆盖优先级高于 docs/agents/yunxiao.yaml',
    resolved,
  )

  // 1.4b 区分文件不存在（ENOENT 正常回退环境变量）与权限/I/O 异常（io-error 明确报错不吞异常）
  const ioErrResolved = await cfgMod.resolveYunxiaoCoordinates({
    cwd: '/ws-yunxiao',
    fs: {
      resolve: async (p: string) => '/ws-yunxiao/' + p,
      readText: async () => {
        const err = new Error("EACCES: permission denied, open '/ws-yunxiao/docs/agents/yunxiao.yaml'") as Error & { code?: string }
        err.code = 'EACCES'
        throw err
      },
      writeText: async () => {},
    },
    env: {
      get: (k: string) => {
        if (k === 'YUNXIAO_ORGANIZATION_ID') return '673db5665c76405a332eebc4'
        if (k === 'YUNXIAO_PROJECT_ID') return '8efcbccd3981cb23178fc66bd1'
        return undefined
      },
      has: () => false,
    },
  })
  check(
    ioErrResolved.ok === false && ioErrResolved.reason === 'io-error',
    '1.4b resolveYunxiaoCoordinates 在非 ENOENT 读取异常（如 EACCES）时返回 io-error 而不静默吞掉',
    ioErrResolved,
  )

  // 1.5 三层只读凭证加载通道（取首行非空文本，不拼后续注释行）
  const tokenFromEnv = await cfgMod.loadYunxiaoToken({
    env: {
      get: (k: string) => (k === 'YUNXIAO_TOKEN' ? '\n  pt-envtoken1234567890  \nsecond-line' : undefined),
      has: () => false,
    },
  })
  check(
    tokenFromEnv.token === 'pt-envtoken1234567890' && tokenFromEnv.source === 'env:YUNXIAO_TOKEN',
    '1.5a 第 1 层：从 YUNXIAO_TOKEN 读取首行非空令牌',
    tokenFromEnv,
  )

  const tokenFromFileVar = await cfgMod.loadYunxiaoToken({
    env: {
      get: (k: string) => (k === 'YUNXIAO_TOKEN_FILE' ? '/run/secrets/yx-token' : undefined),
      has: () => false,
    },
    fs: {
      resolve: async (p: string) => p,
      readText: async (p: string) => (p === '/run/secrets/yx-token' ? '  oat-filetoken9876543210\nextra\n' : ''),
      writeText: async () => {},
    },
  })
  check(
    tokenFromFileVar.token === 'oat-filetoken9876543210' && tokenFromFileVar.source === 'file:YUNXIAO_TOKEN_FILE',
    '1.5b 第 2 层：从 YUNXIAO_TOKEN_FILE 指向的文件读取首行非空令牌',
    tokenFromFileVar,
  )

  const tokenFromHome = await cfgMod.loadYunxiaoToken({
    env: { get: () => undefined, has: () => false },
    homeDir: '/Users/tester',
    fs: {
      resolve: async (p: string) => p,
      readText: async (p: string) => {
        if (p === '/Users/tester/.config/yunxiao/token') return '# 注释行\n\n  pt-hometokenabcdef123456  \n'
        throw new Error('ENOENT')
      },
      writeText: async () => {},
    },
  })
  check(
    tokenFromHome.token === 'pt-hometokenabcdef123456' && tokenFromHome.source === 'home:.config/yunxiao/token',
    '1.5c 第 3 层：从用户主目录 ~/.config/yunxiao/token 只读加载令牌（跳过注释行与空行）',
    tokenFromHome,
  )

  const tokenFromAliEnv = await cfgMod.loadYunxiaoToken({
    env: {
      get: (k: string) => (k === 'ALIBABA_CLOUD_DEVOPS_TOKEN' ? 'pt-alitoken99887766' : undefined),
      has: () => false,
    },
  })
  const tokenFromDshHome = await cfgMod.loadYunxiaoToken({
    env: { get: () => undefined, has: () => false },
    homeDir: '/Users/tester',
    fs: {
      resolve: async (p: string) => p,
      readText: async (p: string) => {
        if (p === '/Users/tester/.dsh/mattskillsdeck/yunxiao-token') return 'oat-dshhometoken12345678\n'
        throw new Error('ENOENT')
      },
      writeText: async () => {},
    },
  })
  check(
    tokenFromAliEnv.token === 'pt-alitoken99887766' &&
      tokenFromAliEnv.source === 'env:ALIBABA_CLOUD_DEVOPS_TOKEN' &&
      tokenFromDshHome.token === 'oat-dshhometoken12345678' &&
      tokenFromDshHome.source === 'home:.dsh/mattskillsdeck/yunxiao-token',
    '1.5d 兼容 ALIBABA_CLOUD_DEVOPS_TOKEN 环境变量与 ~/.dsh/mattskillsdeck/yunxiao-token 主目录回退文件',
    { tokenFromAliEnv, tokenFromDshHome },
  )

  // 1.6 maskSecrets 全链路遮蔽 x-yunxiao-token 请求头与 pt- / oat- 令牌字符串
  const rawLeak = 'curl -H "x-yunxiao-token: custom_secret_val" https://openapi-rdc.aliyuncs.com token1=pt-0fh3abcd0fbG_35af12340484 token2=oat-9988776655443322'
  const masked = errRulesMod.maskSecrets(rawLeak)
  check(
    !masked.includes('custom_secret_val') &&
      !masked.includes('pt-0fh3abcd0fbG_35af12340484') &&
      !masked.includes('oat-9988776655443322') &&
      masked.includes('x-yunxiao-token: ***（凭据已遮蔽）'),
    '1.6 maskSecrets 完整遮蔽 x-yunxiao-token 头、pt-* 与 oat-* 令牌且保持幂等',
    masked,
  )

  console.log('\n== Slice 2：Codeup 远端 URL 纯函数解析器与权威仓库身份归一化 ==')
  const repoIdMod = await imp('src/tracker/rooms/yunxiao/model/repo-identity.ts')

  // 2.1 HTTPS（含 userinfo 与端口、末尾 .git）
  const httpsParsed = repoIdMod.parseCodeupRepo(
    'https://gotUser@Codeup.Aliyun.com:443/673db5665c76405a332eebc4/Apple/enterpriseagentplatform/cdi-new-api.git',
  )
  check(
    httpsParsed !== null &&
      httpsParsed.host === 'codeup.aliyun.com' &&
      httpsParsed.fullPath === '673db5665c76405a332eebc4/Apple/enterpriseagentplatform/cdi-new-api' &&
      httpsParsed.firstSegment === '673db5665c76405a332eebc4' &&
      JSON.stringify(httpsParsed.groupSegments) === JSON.stringify(['Apple', 'enterpriseagentplatform']) &&
      httpsParsed.repoPath === 'cdi-new-api',
    '2.1 HTTPS Codeup URL 剥离 userinfo、端口与 .git，保留大小写与多层子组路径',
    httpsParsed,
  )

  // 2.2 SSH URL (ssh://git@codeup.aliyun.com:22/...) 与 scp-like (git@codeup.aliyun.com:...)
  const sshUrlParsed = repoIdMod.parseCodeupRepo(
    'ssh://git@codeup.aliyun.com:22/673db5665c76405a332eebc4/fa/zhaopin/frontend/jjg-ats.git',
  )
  const scpParsed = repoIdMod.parseCodeupRepo(
    'git@codeup.aliyun.com:myCompany/g1/g2/g3/g4/my-repo.git',
  )
  check(
    sshUrlParsed !== null &&
      sshUrlParsed.fullPath === '673db5665c76405a332eebc4/fa/zhaopin/frontend/jjg-ats' &&
      sshUrlParsed.groupSegments.length === 3 &&
      scpParsed !== null &&
      scpParsed.firstSegment === 'myCompany' &&
      scpParsed.groupSegments.length === 4 &&
      scpParsed.relativePathWithoutFirstSegment === 'g1/g2/g3/g4/my-repo',
    '2.2 SSH URL 与 scp-like 语法解析成功，支持最多 4 级嵌套代码组与企业标识名首段回退路径',
    { sshUrlParsed, scpParsed },
  )

  // 2.3 超过 4 级嵌套代码组（总段数 > 6）或少于 2 段路径应拒绝返回 null
  const tooDeep = repoIdMod.parseCodeupRepo('https://codeup.aliyun.com/org/g1/g2/g3/g4/g5/repo.git')
  const tooShallow = repoIdMod.parseCodeupRepo('https://codeup.aliyun.com/only-one-segment.git')
  check(
    tooDeep === null && tooShallow === null,
    '2.3 超过 4 级子组（>6 段）或单段路径拒绝并返回 null',
    { tooDeep, tooShallow },
  )

  // 2.4 忽略未配置的未知 SSH 主机别名与非 Codeup 域名，支持显式配置的自定义主机
  const sshAlias = repoIdMod.parseCodeupRepo('ssh://my.aliyun/673db5665c76405a332eebc4/demo.git')
  const ghHost = repoIdMod.parseCodeupRepo('git@github.com:owner/repo.git')
  const customHostOk = repoIdMod.parseCodeupRepo('git@codeup.corp.example.com:org/team/repo.git', {
    extraHosts: ['https://codeup.corp.example.com'],
  })
  check(
    sshAlias === null && ghHost === null && customHostOk !== null && customHostOk.host === 'codeup.corp.example.com',
    '2.4 未配置的 SSH 别名与 GitHub 域名返回 null，显式配置的自定义主机可正常解析',
    { sshAlias, ghHost, customHostOk },
  )

  // 2.5 Codeup repository identity 归一化（严禁使用含空格显示名 nameWithNamespace / name，兼容 string/number accessLevel）
  const canonicalRepo = repoIdMod.normalizeCodeupRepositoryIdentity({
    id: 7360166,
    name: 'dci-new-api',
    nameWithNamespace: '673db5665c76405a332eebc4 / Apple / enterpriseagentplatform / dci-new-api',
    path: 'cdi-new-api',
    pathWithNamespace: '673db5665c76405a332eebc4/Apple/enterpriseagentplatform/cdi-new-api',
    webUrl: 'https://codeup.aliyun.com/673db5665c76405a332eebc4/Apple/enterpriseagentplatform/cdi-new-api',
    httpUrlToRepo: 'https://codeup.aliyun.com/673db5665c76405a332eebc4/Apple/enterpriseagentplatform/cdi-new-api.git',
    sshUrlToRepo: 'git@codeup.aliyun.com:673db5665c76405a332eebc4/Apple/enterpriseagentplatform/cdi-new-api.git',
    accessLevel: '40',
    archived: false,
  })
  check(
    canonicalRepo !== null &&
      canonicalRepo.id === 7360166 &&
      canonicalRepo.pathWithNamespace === '673db5665c76405a332eebc4/Apple/enterpriseagentplatform/cdi-new-api' &&
      canonicalRepo.accessLevel === 40 &&
      canonicalRepo.archived === false,
    '2.5 normalizeCodeupRepositoryIdentity 锁定数字 id 与 pathWithNamespace 并把字符串 accessLevel 归一为数字',
    canonicalRepo,
  )

  console.log('\n== Slice 3：纯数字票号归一化、双标识桥接与文件头隐藏标记无损编解码 ==')
  const markersMod = await imp('src/tracker/rooms/yunxiao/model/description-markers.ts')

  // 3.1 纯数字票号、带项目前缀编号（DCIAFS-2）与 26 位内部 ID 分类与双向桥接
  const pNum = markersMod.classifyYunxiaoIssueInput('2')
  const pPadded = markersMod.classifyYunxiaoIssueInput('02')
  const pSerial = markersMod.classifyYunxiaoIssueInput('DCIAFS-2')
  const pId = markersMod.classifyYunxiaoIssueInput('25ac2befde335fcc2218d7c8bb')
  check(
    pNum?.kind === 'numeric' &&
      pNum.key === '2' &&
      pPadded?.kind === 'numeric' &&
      pPadded.key === '2' &&
      pSerial?.kind === 'serial' &&
      pSerial.key === '2' &&
      pSerial.customCode === 'DCIAFS' &&
      pId?.kind === 'internal-id' &&
      pId.id === '25ac2befde335fcc2218d7c8bb',
    '3.1 classifyYunxiaoIssueInput 准确识别纯数字、前导零数字、带前缀 serialNumber 与 26 位内部 id',
    { pNum, pPadded, pSerial, pId },
  )

  markersMod.clearYunxiaoIssueKeyCache()
  const scope = '673db5665c76405a332eebc4/8efcbccd3981cb23178fc66bd1'
  markersMod.rememberYunxiaoIssueIdentity(scope, {
    id: '25ac2befde335fcc2218d7c8bb',
    serialNumber: 'DCIAFS-2',
  })
  check(
    markersMod.resolveYunxiaoIssueKey(scope, '25ac2befde335fcc2218d7c8bb') === '2' &&
      markersMod.resolveYunxiaoIssueKey(scope, 'DCIAFS-2') === '2' &&
      markersMod.resolveYunxiaoWorkitemId(scope, '2') === '25ac2befde335fcc2218d7c8bb' &&
      markersMod.resolveYunxiaoWorkitemId(scope, 'DCIAFS-2') === '25ac2befde335fcc2218d7c8bb' &&
      markersMod.toYunxiaoSerialNumber('2', 'DCIAFS') === 'DCIAFS-2',
    '3.2 房间内双标识缓存支持纯数字 key、DCIAFS-n 与 26 位 id 双向无损反查',
  )

  // 3.3 parentId 三种空值形态归一化
  check(
    markersMod.normalizeYunxiaoParentId(null) === null &&
      markersMod.normalizeYunxiaoParentId('') === null &&
      markersMod.normalizeYunxiaoParentId('EMPTY_VALUE') === null &&
      markersMod.normalizeYunxiaoParentId('f7d327d50b8fca57a146979938') === 'f7d327d50b8fca57a146979938',
    '3.3 normalizeYunxiaoParentId 将 null、空串与 EMPTY_VALUE 统一归一为 null',
  )

  // 3.4 五类文件头隐藏标记（幂等锚、类型、认领人、父票、成对阻塞边）组合无损读写，且忽略正文中的示例注释
  let doc = '# 标题：实现云效适配器\n\n正文段落里提到的示例不应被当成文件头：\n<!-- DSH-PARENT: 999 -->\n<!-- DSH-ASSIGNEES: fake -->\n'
  doc = markersMod.withAnchor(doc, 'idem-anchor-01')
  doc = markersMod.rewriteDescriptionWithIssueKind(doc, 'spec')
  doc = markersMod.rewriteDescriptionWithAssignees(doc, ['lead', 'alice'])
  doc = markersMod.rewriteDescriptionWithHiddenParent(doc, '00')
  doc = markersMod.rewriteDescriptionWithBlockedPair(doc, ['1', '3'])

  check(
    markersMod.parseHiddenIdempotencyKey(doc) === 'idem-anchor-01' &&
      markersMod.parseHiddenIssueKind(doc) === 'spec' &&
      JSON.stringify(markersMod.parseHiddenAssignees(doc)) === JSON.stringify(['lead', 'alice']) &&
      markersMod.parseHiddenParent(doc) === '0' &&
      JSON.stringify(markersMod.parseHiddenBlockedBy(doc)) === JSON.stringify(['1', '3']) &&
      /^<!-- DSH-IDEMPOTENCY-KEY: idem-anchor-01 -->\n/.test(doc) &&
      doc.includes('Blocked by: #1, #3\n<!-- DSH-BLOCKED-BY: 1, 3 -->') &&
      doc.includes('# 标题：实现云效适配器'),
    '3.4 五类文件头隐藏标记（幂等锚、类型、认领人、父票、阻塞对）组合写入后可精确读回，且幂等锚保持在首行',
    doc,
  )

  // 3.5 释放认领与清空父票/阻塞边后，未认领返回空数组 []，正文示例保持原样
  const releasedDoc = markersMod.rewriteDescriptionWithBlockedPair(
    markersMod.rewriteDescriptionWithHiddenParent(
      markersMod.rewriteDescriptionWithAssignees(doc, []),
      null,
    ),
    [],
  )
  check(
    JSON.stringify(markersMod.parseHiddenAssignees(releasedDoc)) === '[]' &&
      markersMod.parseHiddenParent(releasedDoc) === null &&
      markersMod.parseHiddenBlockedBy(releasedDoc) === null &&
      markersMod.parseHiddenIssueKind(releasedDoc) === 'spec' &&
      markersMod.parseHiddenIdempotencyKey(releasedDoc) === 'idem-anchor-01' &&
      releasedDoc.includes('<!-- DSH-PARENT: 999 -->'),
    '3.5 清空认领人、父票与阻塞边后，文件头标记干净移除且不误读标题下方的正文示例',
    releasedDoc,
  )

  // 3.6 标题下方的旧可见 Blocked by: 行在 rewriteDescriptionWithBlockedPair 清空后一并清除，确保 parseBlockedByFallback 返回 null
  const legacyBodyWithBlockedBelowHeading = '# 存量工单标题\n\nBlocked by: #7, #8\n\n正文说明段落。\n'
  const clearedLegacyBlocked = markersMod.rewriteDescriptionWithBlockedPair(legacyBodyWithBlockedBelowHeading, [])
  check(
    markersMod.parseBlockedByFallback(legacyBodyWithBlockedBelowHeading)?.join(',') === '7,8' &&
      markersMod.parseBlockedByFallback(clearedLegacyBlocked) === null &&
      !clearedLegacyBlocked.includes('Blocked by:'),
    '3.6 rewriteDescriptionWithBlockedPair 清空标题下方的旧可见 Blocked by: 行后，parseBlockedByFallback 不再残留旧阻塞边',
    clearedLegacyBlocked,
  )

  console.log('\n== Slice 4：可注入 HTTP 传输底座、分页头判定、错误分类、预算包装与独立出站冷却隔离 ==')
  const clientMod = await imp('src/tracker/rooms/yunxiao/client.ts')
  const queriesMod = await imp('src/tracker/rooms/yunxiao/queries.ts')
  const requestsMod = await imp('src/tracker/rooms/yunxiao/requests.ts')
  const errorsMod = await imp('src/tracker/rooms/yunxiao/errors.ts')
  const budgetMod = await imp('src/tracker/rooms/yunxiao/budget.ts')
  const admissionMod = await imp('src/refresh/rooms/host/outbound-admission.ts')
  const tiersMod = await imp('src/tracker/kernel/outbound-tiers.ts')

  // 4.1 独立 yunxiao 出站超时冷却桶隔离（yunxiao 冷却不影响 github/gitlab，反之亦然）
  {
    const lane = admissionMod.createGhAdmission({ readMax: 2, writeMax: 1, cooldownMs: 60000 })
    lane.reportTransportFailure({ bucket: 'read', reason: 'timeout', cmd: 'projex:list', service: 'yunxiao' })
    const yxBlocked = await lane.acquire({ bucket: 'read', service: 'yunxiao' }).then(() => null, (e: unknown) => e)
    const ghAllowed = await lane.acquire({ bucket: 'read', service: 'github' })
    ghAllowed()
    const glabAllowed = await lane.acquire({ bucket: 'read', service: 'gitlab' })
    glabAllowed()
    check(
      Boolean(tiersMod.outboundCooldownOf(yxBlocked)) && typeof ghAllowed === 'function' && typeof glabAllowed === 'function',
      '4.1 yunxiao 独立出站冷却桶隔离：yunxiao 冷却不阻塞 github 与 gitlab，反之亦然',
      tiersMod.outboundCooldownOf(yxBlocked),
    )
    lane.reportSuccess({ bucket: 'read', service: 'yunxiao' })
    const yxAfterClear = await lane.acquire({ bucket: 'read', service: 'yunxiao' })
    yxAfterClear()
    check(typeof yxAfterClear === 'function', '4.1b yunxiao 成功响应后立即清除自身冷却桶')
  }

  // 4.2 可注入 fetch、分页响应头提取、x-page < x-total-pages 翻页判定与 HTTP 204 空响应处理
  {
    const seenRequests: Array<{ url: string; method: string; tokenHeader: string }> = []
    const fakeFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const urlStr = String(input)
      const headers = new Headers(init?.headers)
      seenRequests.push({
        url: urlStr,
        method: init?.method || 'GET',
        tokenHeader: headers.get('x-yunxiao-token') || '',
      })
      if (urlStr.endsWith('/labels')) {
        return new Response(null, { status: 204 })
      }
      return new Response(JSON.stringify([{ id: '25ac2befde335fcc2218d7c8bb', serialNumber: 'DCIAFS-2' }]), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-page': '1',
          'x-per-page': '20',
          'x-total': '1',
          'x-total-pages': '1',
          // 实测云效在最后一页仍返回 x-next-page: "1" 或 "2"
          'x-next-page': '2',
        },
      })
    }

    const mockCtx = {
      cwd: '/ws-yx',
      fetch: fakeFetch,
      platform: {
        env: {
          get: (k: string) => (k === 'YUNXIAO_TOKEN' ? 'pt-secret998877665544' : undefined),
          has: () => false,
        },
      },
    }

    const wrapped = clientMod.attachYunxiaoOpUsage({
      async runTwoCalls() {
        const r1 = await requestsMod.requestWorkitemsSearch(
          mockCtx,
          '673db5665c76405a332eebc4',
          { spaceId: '8efcbccd3981cb23178fc66bd1', category: 'Req,Task,Bug', page: 1, perPage: 20 },
          8000,
        )
        const r2 = await requestsMod.requestProjectLabelsList(
          mockCtx,
          '673db5665c76405a332eebc4',
          '8efcbccd3981cb23178fc66bd1',
          '',
          8000,
        )
        return { ok: true as const, data: { r1, r2 } }
      },
    })

    const opRes = await wrapped.runTwoCalls()
    const r1 = opRes.data.r1
    const r2 = opRes.data.r2
    check(
      opRes.ok === true &&
        opRes.usage?.requests === 2 &&
        opRes.usage?.points === 0 &&
        seenRequests.length === 2 &&
        seenRequests[0].tokenHeader === 'pt-secret998877665544' &&
        r1.status === 200 &&
        r1.headers.xPage === 1 &&
        r1.headers.xTotalPages === 1 &&
        r1.headers.xNextPage === 2 &&
        clientMod.hasNextYunxiaoPage(r1.headers) === false &&
        clientMod.hasNextYunxiaoPage({ xPage: 1, xTotalPages: 3, xNextPage: 2 }) === true &&
        r2.status === 204 &&
        r2.code === 0 &&
        r2.data === null,
      '4.2 可注入 fetch 正确携带 x-yunxiao-token、处理 HTTP 204 空响应、统计 usage.requests，且按 xPage < xTotalPages 防 x-next-page 假翻页',
      { usage: opRes.usage, r1Headers: r1.headers, r2Status: r2.status },
    )
  }

  // 4.3 Codeup 路径 URL 编码（%2F）与 .git 剥离查询构建
  {
    const encodedPath = queriesMod.codeupRepositoryPath(
      '673db5665c76405a332eebc4',
      '673db5665c76405a332eebc4/Apple/enterpriseagentplatform/cdi-new-api.git',
    )
    const numericPath = queriesMod.codeupRepositoryPath('673db5665c76405a332eebc4', 7360166)
    check(
      encodedPath ===
        '/oapi/v1/codeup/organizations/673db5665c76405a332eebc4/repositories/673db5665c76405a332eebc4%2FApple%2Fenterpriseagentplatform%2Fcdi-new-api' &&
        numericPath === '/oapi/v1/codeup/organizations/673db5665c76405a332eebc4/repositories/7360166',
      '4.3 codeupRepositoryPath 自动剥离末尾 .git 并将路径斜杠编码为 %2F',
      { encodedPath, numericPath },
    )
  }

  // 4.4 Yunxiao 专有错误分类规则（400 InvalidIdentifier.NotFound -> not-found，403 UserNotInCurrentOrganization -> auth，400 关系矩阵限制 -> conflict）
  {
    const vNotFound = errorsMod.classifyYunxiaoError({
      status: 400,
      stderr: '{"errorCode":"InvalidIdentifier.NotFound","errorMessage":"项目不存在或已经彻底删除"}',
    })
    const vOrgAuth = errorsMod.classifyYunxiaoError({
      status: 403,
      stderr: '{"errorCode":"Forbidden.InvalidUser.UserNotInCurrentOrganization","errorMessage":"The current user is not in the organization"}',
    })
    const vRelationConflict = errorsMod.classifyYunxiaoError({
      status: 400,
      stderr: '{"errorCode":"InvaildData.Failed","errorMessage":"无法创建此关系, 不满足关系对应的类型约束！"}',
    })
    const vMissingToken = errorsMod.classifyYunxiaoError({
      stderr: 'Missing Yunxiao token: set YUNXIAO_TOKEN or ~/.config/yunxiao/token',
    })
    const vBadConfig = errorsMod.classifyYunxiaoError({
      stderr: 'Invalid docs/agents/yunxiao.yaml: missing organizationId or projectId',
    })
    check(
      vNotFound.kind === 'not-found' &&
        vOrgAuth.kind === 'auth' &&
        vRelationConflict.kind === 'conflict' &&
        vMissingToken.kind === 'auth' &&
        vBadConfig.kind === 'env',
      '4.4 classifyYunxiaoError 准确映射 400 InvalidIdentifier.NotFound、403 跨组织、400 关系约束冲突、缺令牌与缺配置错误',
      { vNotFound, vOrgAuth, vRelationConflict, vMissingToken, vBadConfig },
    )
  }

  // 4.5 预算模型与 readYunxiaoBudget
  {
    const bRes = await budgetMod.readYunxiaoBudget({} as any)
    check(
      budgetMod.YUNXIAO_BUDGET_MODEL.kind === 'requests-only' &&
        budgetMod.YUNXIAO_BUDGET_MODEL.countsRequests === true &&
        budgetMod.YUNXIAO_BUDGET_MODEL.countsPoints === false &&
        bRes.ok === true &&
        bRes.data.known === false &&
        bRes.data.reason === 'unsupported',
      '4.5 YUNXIAO_BUDGET_MODEL 声明 requests-only 且 readYunxiaoBudget 返回 known:false (reason=unsupported)',
      bRes,
    )
  }

  // 4.6 请求超时自动上报 yunxiao 独立冷却桶并对错误回执脱敏
  {
    const lane = admissionMod.createGhAdmission({ readMax: 2, writeMax: 1, cooldownMs: 60000 })
    const timeoutFetch = async (): Promise<Response> => {
      const err = new Error('request timed out with x-yunxiao-token: pt-leakedtoken1234567890')
      err.name = 'TimeoutError'
      throw err
    }
    const timeoutCtx = {
      cwd: '/ws-yx-timeout',
      fetch: timeoutFetch,
      outbound: lane,
      platform: {
        env: {
          get: (k: string) => (k === 'YUNXIAO_TOKEN' ? 'pt-leakedtoken1234567890' : undefined),
          has: () => false,
        },
      },
    }
    const rTimeout = await requestsMod.requestPlatformUser(timeoutCtx, 1000)
    const fRes = errorsMod.failYunxiao(rTimeout, rTimeout.stderr)
    const blockedAfterTimeout = await lane.acquire({ bucket: 'read', service: 'yunxiao' }).then(() => null, (e: unknown) => e)
    check(
      rTimeout.ok === false &&
        rTimeout.timedOut === true &&
        !rTimeout.stderr.includes('pt-leakedtoken1234567890') &&
        fRes.ok === false &&
        fRes.error.kind === 'network' &&
        !fRes.error.message.includes('pt-leakedtoken1234567890') &&
        Boolean(tiersMod.outboundCooldownOf(blockedAfterTimeout)),
      '4.6 HTTP 请求超时自动向 outbound 上报 yunxiao 冷却、归入 network 档，且异常与失败信封全程遮蔽令牌',
      { rTimeout, fRes, blockedAfterTimeout: tiersMod.outboundCooldownOf(blockedAfterTimeout) },
    )
  }

  // 4.7 读路径日志出口（support/read-log.ts）复用已登记事件且遵循字段白名单
  {
    const readLogMod = await imp('src/tracker/rooms/yunxiao/support/read-log.ts')
    const logged: Array<{ level: string; event: string; fields: Record<string, unknown> }> = []
    const logCtx = {
      opId: 'yx-op-1',
      logEvent: (level: string, event: string, fields: Record<string, unknown>) => {
        logged.push({ level, event, fields })
      },
    }
    readLogMod.emitReadDegraded(logCtx, 'preflight', 'preflight:config', 12.8, 'env')
    readLogMod.emitPreflightGatePass(logCtx, 1, 5)
    readLogMod.emitRepoTier(logCtx, 2, true, Date.now() - 10)
    check(
      logged.length === 3 &&
        logged[0].event === 'read.degraded' &&
        logged[0].fields.op === 'preflight' &&
        logged[0].fields.reason === 'preflight:config' &&
        logged[0].fields.latencyMs === 12 &&
        logged[0].fields.opId === 'yx-op-1' &&
        logged[0].fields.kind === 'env' &&
        logged[1].event === 'preflight.gate' &&
        logged[1].fields.gate === 1 &&
        logged[1].fields.reason === 'ok' &&
        logged[2].event === 'repo.resolve.tier' &&
        logged[2].fields.tier === 2 &&
        logged[2].fields.ok === true,
      '4.7 support/read-log.ts 准确发送 read.degraded、preflight.gate 与 repo.resolve.tier 结构化诊断事件',
      logged,
    )
  }

  // 4.8 一体化开仓配置底座：templateId 解析、deriveProjectCustomCode 4~6 位大写字母派生与冲突递增、formatYunxiaoConfigYaml 往返无损及 Projex 模板/建项目端点
  {
    const code1 = typeof cfgMod.deriveProjectCustomCode === 'function' ? cfgMod.deriveProjectCustomCode('my-cool-app', 0) : ''
    const code2 = typeof cfgMod.deriveProjectCustomCode === 'function' ? cfgMod.deriveProjectCustomCode('my-cool-app', 1) : ''
    const codeShort = typeof cfgMod.deriveProjectCustomCode === 'function' ? cfgMod.deriveProjectCustomCode('x', 0) : ''
    const yamlText =
      typeof cfgMod.formatYunxiaoConfigYaml === 'function'
        ? cfgMod.formatYunxiaoConfigYaml({
            organizationId: '673db5665c76405a332eebc4',
            projectId: '8efcbccd3981cb23178fc66bd1',
            customCode: code1,
            repositoryId: '7360166',
            namespaceId: 2076563,
            templateId: 'tpl-scrum-001',
          })
        : ''
    const reparsed = yamlText ? cfgMod.parseYunxiaoConfigText(yamlText) : { ok: false }
    const tplPath = typeof queriesMod.projectTemplatesPath === 'function' ? queriesMod.projectTemplatesPath('673db5665c76405a332eebc4') : ''
    const createProjPath = typeof queriesMod.projectsCreatePath === 'function' ? queriesMod.projectsCreatePath('673db5665c76405a332eebc4') : ''
    check(
      /^[A-Z]{4,6}$/.test(code1) &&
        /^[A-Z]{4,6}$/.test(code2) &&
        code1 !== code2 &&
        /^[A-Z]{4,6}$/.test(codeShort) &&
        reparsed.ok === true &&
        reparsed.value.organizationId === '673db5665c76405a332eebc4' &&
        reparsed.value.projectId === '8efcbccd3981cb23178fc66bd1' &&
        reparsed.value.customCode === code1 &&
        reparsed.value.repositoryId === '7360166' &&
        reparsed.value.namespaceId === 2076563 &&
        reparsed.value.templateId === 'tpl-scrum-001' &&
        tplPath === '/oapi/v1/projex/organizations/673db5665c76405a332eebc4/projectTemplates' &&
        createProjPath === '/oapi/v1/projex/organizations/673db5665c76405a332eebc4/projects' &&
        typeof requestsMod.requestProjectTemplatesList === 'function' &&
        typeof requestsMod.requestProjectCreate === 'function',
      '4.8 支持 templateId 配置、deriveProjectCustomCode 4~6 位大写字母派生与冲突递增、formatYunxiaoConfigYaml 往返解析及 Projex 模板/建项目端点',
      { code1, code2, codeShort, reparsed, tplPath, createProjPath },
    )
  }

  console.log('')
  console.log(failed ? '存在失败 — ' + GATE + ' 未通过' : '全部通过（' + total + ' 项断言）')
  printGateResult(GATE, total, failed)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('执行异常：', e)
  printGateResult(GATE, total, failed + 1)
  process.exit(1)
})
