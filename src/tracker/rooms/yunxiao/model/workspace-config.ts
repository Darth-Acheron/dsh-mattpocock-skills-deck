/**
 * src/tracker/rooms/yunxiao/model/workspace-config.ts —— Yunxiao backend 工作区坐标配置解析与只读凭证加载（规格 #01 + 架构加深 Candidate 1）。
 *
 * 为什么单独建立这份配置文件（docs/agents/yunxiao.yaml）而不改动 docs/agents/workspace.yaml：
 *   上游 src/shared/config-store/src/workspace.ts 对 docs/agents/workspace.yaml 实行严格的 KNOWN_KEYS
 *   白名单校验（只认 version / backendId / pickedAt / source / layout 五个键），任何未知键都会导致
 *   整份工作区文件被判为 unknown-keys 不可读。将云效组织 ID、Yunxiao Projex 项目 ID 与 Codeup 仓库覆盖
 *   存放在独立的 docs/agents/yunxiao.yaml 中，既能随版本库共享非敏感项目坐标，又能保证现有三个后端零回归。
 *
 * 凭证红线：
 *   个人访问令牌（x-yunxiao-token）只允许从环境变量、令牌文件路径变量或用户主目录受保护文件只读加载，
 *   严禁写进仓库内的 docs/agents/yunxiao.yaml；一旦在配置文件中发现 token / pat 等敏感键名，立即报错拒绝。
 */

import type { BackendPlatform, SandboxFs } from '../../../contract/contexts.js'

export const YUNXIAO_CONFIG_REL = 'docs/agents/yunxiao.yaml'
export const YUNXIAO_KNOWN_VERSION = 1
export const DEFAULT_YUNXIAO_API_BASE_URL = 'https://openapi-rdc.aliyuncs.com'
export const DEFAULT_YUNXIAO_WEB_BASE_URL = 'https://devops.aliyun.com'
export const DEFAULT_CODEUP_HOST = 'codeup.aliyun.com'
export const MAX_YUNXIAO_CONFIG_CHARS = 65536

/** 剥离 Codeup 仓库路径或标识首尾的斜杠与末尾单个 .git 后缀（不区分大小写）。 */
export function cleanCodeupRepoPath(raw: unknown): string {
  return String(raw == null ? '' : raw).trim().replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
}

export const YUNXIAO_KNOWN_KEYS: readonly string[] = [
  'version', 'organizationId', 'projectId', 'customCode', 'repositoryId', 'namespaceId', 'templateId', 'apiBaseUrl', 'webBaseUrl',
]

const INLINE_SECRET_KEYS: ReadonlySet<string> = new Set([
  'token', 'pat', 'accesstoken', 'access_token', 'personalaccesstoken', 'personal_access_token',
  'x-yunxiao-token', 'yunxiaotoken', 'yunxiao_token', 'secret', 'password', 'authorization',
])

export interface YunxiaoWorkspaceConfig {
  version: number; organizationId: string; projectId: string; customCode?: string;
  repositoryId?: string; namespaceId?: number; templateId?: string; apiBaseUrl: string; webBaseUrl: string
}

export type YunxiaoConfigParseResult =
  | { ok: true; value: YunxiaoWorkspaceConfig; readonly: boolean; warnings: string[] }
  | { ok: false; reason: 'yaml-error' | 'oversize' | 'aliases' | 'bad-shape' | 'unknown-keys' | 'inline-secret' | 'io-error'; message: string; keys?: string[] }

export interface YunxiaoTokenResolution {
  token: string
  source: 'env:YUNXIAO_TOKEN' | 'env:ALIBABA_CLOUD_DEVOPS_TOKEN' | 'file:YUNXIAO_TOKEN_FILE' | 'home:.config/yunxiao/token' | 'home:.dsh/mattskillsdeck/yunxiao-token' | 'none'
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function isInlineSecretKey(key: string): boolean {
  const lower = key.trim().toLowerCase()
  return INLINE_SECRET_KEYS.has(lower) || /(?:^|[_-])(token|secret|password|pat)(?:$|[_-])/i.test(lower)
}

/** 规范化 HTTP(S) 基础 URL：校验协议并剥离末尾斜杠，非法 URL 返回 null。 */
export function normalizeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) return null
    return trimmed.replace(/\/+$/, '')
  } catch { return null }
}

/** 判断是否为中心版默认 OpenAPI 接入点。 */
export function isCentralYunxiaoApi(apiBaseUrl: string): boolean {
  try { return new URL(apiBaseUrl).hostname.toLowerCase() === 'openapi-rdc.aliyuncs.com' } catch { return true }
}

/** 校验云效 24 位组织 ID（中心版为 24 位十六进制字符串）。 */
export function isValidOrganizationId(orgId: string, apiBaseUrl = DEFAULT_YUNXIAO_API_BASE_URL): boolean {
  const trimmed = String(orgId || '').trim()
  if (!trimmed) return !isCentralYunxiaoApi(apiBaseUrl)
  return isCentralYunxiaoApi(apiBaseUrl) ? /^[0-9a-f]{24}$/i.test(trimmed) : /^[A-Za-z0-9._-]{2,64}$/.test(trimmed)
}

/** 校验 Yunxiao Projex 26 位项目 spaceId（实测为 26 位小写字母数字/十六进制字符串）。 */
export function isValidProjectId(projectId: string): boolean {
  return /^[0-9a-z]{26}$/i.test(String(projectId || '').trim())
}

function stripInlineComment(rawVal: string): string {
  let quote: string | null = null
  for (let i = 0; i < rawVal.length; i++) {
    const ch = rawVal[i]
    if (quote) {
      if (ch === '\\' && quote === '"') { i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '#' && (i === 0 || /\s/.test(rawVal[i - 1]))) return rawVal.slice(0, i).trim()
  }
  return rawVal.trim()
}

function parseYamlScalar(rawVal: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const cleaned = stripInlineComment(rawVal)
  if (cleaned === '' || cleaned === 'null' || cleaned === '~') return { ok: true, value: null }
  if (cleaned === 'true') return { ok: true, value: true }
  if (cleaned === 'false') return { ok: true, value: false }
  if (cleaned.startsWith('"')) {
    if (!cleaned.endsWith('"') || cleaned.length < 2) return { ok: false, message: '双引号字符串未闭合：' + cleaned.slice(0, 60) }
    try { return { ok: true, value: JSON.parse(cleaned) } }
    catch (e) { return { ok: false, message: '双引号字符串转义非法：' + String((e as Error).message || e) } }
  }
  if (cleaned.startsWith("'")) {
    if (!cleaned.endsWith("'") || cleaned.length < 2) return { ok: false, message: '单引号字符串未闭合：' + cleaned.slice(0, 60) }
    return { ok: true, value: cleaned.slice(1, -1).replace(/''/g, "'") }
  }
  if (/^-?\d+$/.test(cleaned)) {
    const asNum = Number(cleaned)
    if (Number.isSafeInteger(asNum)) return { ok: true, value: asNum }
  }
  return { ok: true, value: cleaned }
}

function parseFlatYamlOrJson(text: string): { ok: true; doc: unknown } | { ok: false; reason: 'yaml-error' | 'aliases'; message: string } {
  const noComments = text.replace(/(^|\s)#[^\n]*$/gm, '$1')
  if (/(^|[\s[{,])\*[A-Za-z0-9_-]+/.test(noComments)) {
    return { ok: false, reason: 'aliases', message: '配置文件中包含 YAML 别名，出于安全原因拒绝解析' }
  }
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, doc: null }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return { ok: true, doc: JSON.parse(trimmed) } }
    catch (e) { return { ok: false, reason: 'yaml-error', message: '配置文件不是合法的 JSON/YAML：' + String((e as Error).message || e).slice(0, 160) } }
  }

  const out: Record<string, unknown> = {}
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const trimmedLine = rawLine.trim()
    if (!trimmedLine || trimmedLine.startsWith('#') || trimmedLine === '---') continue
    if (/^\s+/.test(rawLine) || trimmedLine.startsWith('- ')) {
      return { ok: false, reason: 'yaml-error', message: '第 ' + (i + 1) + ' 行使用了缩进或列表语法，docs/agents/yunxiao.yaml 只允许顶层键值映射' }
    }
    const colonIdx = trimmedLine.indexOf(':')
    if (colonIdx <= 0) return { ok: false, reason: 'yaml-error', message: '第 ' + (i + 1) + ' 行缺少冒号分隔符' }
    const key = trimmedLine.slice(0, colonIdx).trim()
    if (!/^[A-Za-z0-9_-]+$/.test(key)) return { ok: false, reason: 'yaml-error', message: '第 ' + (i + 1) + ' 行键名格式非法：' + key }
    if (Object.prototype.hasOwnProperty.call(out, key)) return { ok: false, reason: 'yaml-error', message: '配置文件中存在重复键名：' + key }
    const parsedScalar = parseYamlScalar(trimmedLine.slice(colonIdx + 1))
    if (!parsedScalar.ok) return { ok: false, reason: 'yaml-error', message: '第 ' + (i + 1) + ' 行值解析失败：' + parsedScalar.message }
    out[key] = parsedScalar.value
  }
  return Object.keys(out).length > 0 ? { ok: true, doc: out } : { ok: true, doc: null }
}

function checkAllowedKeys(doc: Record<string, unknown>): Extract<YunxiaoConfigParseResult, { ok: false }> | null {
  const allKeys = Object.keys(doc)
  const secretKeys = allKeys.filter(isInlineSecretKey)
  if (secretKeys.length > 0) {
    return {
      ok: false, reason: 'inline-secret', keys: secretKeys,
      message: '严禁在 docs/agents/yunxiao.yaml 中写入凭证字段（检测到：' + secretKeys.join('、') + '）。请通过环境变量 YUNXIAO_TOKEN、YUNXIAO_TOKEN_FILE 或 ~/.config/yunxiao/token 提供令牌',
    }
  }
  const unknownKeys = allKeys.filter((k) => !YUNXIAO_KNOWN_KEYS.includes(k))
  if (unknownKeys.length > 0) {
    return { ok: false, reason: 'unknown-keys', message: 'docs/agents/yunxiao.yaml 包含未知配置字段：' + unknownKeys.join('、'), keys: unknownKeys }
  }
  return null
}

/** 校验已解析的云效工作区配置对象。 */
export function parseYunxiaoConfig(doc: unknown): YunxiaoConfigParseResult {
  if (!isRecord(doc)) return { ok: false, reason: 'bad-shape', message: 'docs/agents/yunxiao.yaml 必须是一组顶层「键 → 值」映射' }
  const keyErr = checkAllowedKeys(doc)
  if (keyErr) return keyErr

  const rawVersion = doc['version'] === undefined ? YUNXIAO_KNOWN_VERSION : doc['version']
  if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion) || rawVersion < 1) {
    return { ok: false, reason: 'bad-shape', message: 'docs/agents/yunxiao.yaml 的 version 必须是正整数（当前版本为 1）' }
  }
  const apiBaseUrl = doc['apiBaseUrl'] == null || doc['apiBaseUrl'] === '' ? DEFAULT_YUNXIAO_API_BASE_URL : normalizeBaseUrl(doc['apiBaseUrl'])
  if (!apiBaseUrl) return { ok: false, reason: 'bad-shape', message: 'docs/agents/yunxiao.yaml 的 apiBaseUrl 必须是合法的 http(s) 地址' }
  const webBaseUrl = doc['webBaseUrl'] == null || doc['webBaseUrl'] === '' ? DEFAULT_YUNXIAO_WEB_BASE_URL : normalizeBaseUrl(doc['webBaseUrl'])
  if (!webBaseUrl) return { ok: false, reason: 'bad-shape', message: 'docs/agents/yunxiao.yaml 的 webBaseUrl 必须是合法的 http(s) 地址' }

  const organizationId = doc['organizationId'] == null ? '' : String(doc['organizationId']).trim()
  if (!isValidOrganizationId(organizationId, apiBaseUrl)) {
    return {
      ok: false, reason: 'bad-shape',
      message: isCentralYunxiaoApi(apiBaseUrl) ? 'docs/agents/yunxiao.yaml 的 organizationId 必须是 24 位十六进制云效组织 ID' : 'docs/agents/yunxiao.yaml 的 organizationId 格式不合法',
    }
  }
  const projectId = doc['projectId'] == null ? '' : String(doc['projectId']).trim()
  if (!isValidProjectId(projectId)) {
    return { ok: false, reason: 'bad-shape', message: 'docs/agents/yunxiao.yaml 的 projectId 必须是 26 位 Yunxiao Projex 项目 ID（spaceId）' }
  }

  const value: YunxiaoWorkspaceConfig = { version: rawVersion, organizationId, projectId, apiBaseUrl, webBaseUrl }
  if (doc['customCode'] != null && String(doc['customCode']).trim() !== '') {
    const code = String(doc['customCode']).trim()
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(code)) return { ok: false, reason: 'bad-shape', message: 'docs/agents/yunxiao.yaml 的 customCode 只能包含字母、数字、下划线或连字符' }
    value.customCode = code
  }
  if (doc['repositoryId'] != null && String(doc['repositoryId']).trim() !== '') {
    const repoId = cleanCodeupRepoPath(doc['repositoryId'])
    if (!repoId || /\s/.test(repoId)) return { ok: false, reason: 'bad-shape', message: 'docs/agents/yunxiao.yaml 的 repositoryId 不能为空或包含空白字符' }
    value.repositoryId = repoId
  }
  if (doc['namespaceId'] != null && String(doc['namespaceId']).trim() !== '') {
    const rawNs = doc['namespaceId']
    const nsNum = typeof rawNs === 'number' ? rawNs : Number(String(rawNs).trim())
    if (!Number.isSafeInteger(nsNum) || nsNum <= 0) return { ok: false, reason: 'bad-shape', message: 'docs/agents/yunxiao.yaml 的 namespaceId 必须是正整数（Codeup 父代码组 ID）' }
    value.namespaceId = nsNum
  }
  if (doc['templateId'] != null && String(doc['templateId']).trim() !== '') {
    const tpl = String(doc['templateId']).trim()
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(tpl)) return { ok: false, reason: 'bad-shape', message: 'docs/agents/yunxiao.yaml 的 templateId 格式非法' }
    value.templateId = tpl
  }

  const readonly = rawVersion > YUNXIAO_KNOWN_VERSION
  const warnings = readonly ? ['version-newer：配置文件版本为 ' + rawVersion + '，当前仅支持到版本 1，以只读模式加载'] : []
  return { ok: true, value, readonly, warnings }
}

function parseRawConfigRecord(text: string): { ok: true; doc: Record<string, unknown> } | Extract<YunxiaoConfigParseResult, { ok: false }> {
  const stripped = text.replace(/^\uFEFF/, '')
  if (stripped.length > MAX_YUNXIAO_CONFIG_CHARS) {
    return { ok: false, reason: 'oversize', message: 'docs/agents/yunxiao.yaml 超过大小上限（' + stripped.length + ' > ' + MAX_YUNXIAO_CONFIG_CHARS + '）' }
  }
  const parsed = parseFlatYamlOrJson(stripped)
  if (!parsed.ok) return parsed
  if (parsed.doc === null) return { ok: false, reason: 'bad-shape', message: 'docs/agents/yunxiao.yaml 内容为空' }
  if (!isRecord(parsed.doc)) return { ok: false, reason: 'bad-shape', message: 'docs/agents/yunxiao.yaml 必须是一组顶层「键 → 值」映射' }
  const keyErr = checkAllowedKeys(parsed.doc)
  return keyErr ? keyErr : { ok: true, doc: parsed.doc }
}

/** 从原始文本解析并校验 docs/agents/yunxiao.yaml。 */
export function parseYunxiaoConfigText(text: unknown): YunxiaoConfigParseResult {
  if (typeof text !== 'string') return { ok: false, reason: 'yaml-error', message: '要解析的云效配置不是文本' }
  const pre = parseRawConfigRecord(text)
  return pre.ok ? parseYunxiaoConfig(pre.doc) : pre
}

const ENV_FIELD_MAP: ReadonlyArray<readonly [string, string]> = [
  ['YUNXIAO_ORGANIZATION_ID', 'organizationId'], ['YUNXIAO_PROJECT_ID', 'projectId'],
  ['YUNXIAO_CUSTOM_CODE', 'customCode'], ['YUNXIAO_REPOSITORY_ID', 'repositoryId'],
  ['YUNXIAO_NAMESPACE_ID', 'namespaceId'], ['YUNXIAO_TEMPLATE_ID', 'templateId'],
  ['YUNXIAO_API_BASE_URL', 'apiBaseUrl'], ['YUNXIAO_WEB_BASE_URL', 'webBaseUrl'],
]

/** 合并环境变量覆盖与 docs/agents/yunxiao.yaml 工作区文件配置（优先级：YUNXIAO_* 环境变量 > docs/agents/yunxiao.yaml）。 */
export async function resolveYunxiaoCoordinates(input: {
  cwd?: string; fs?: SandboxFs | null; env?: BackendPlatform['env'] | null
}): Promise<YunxiaoConfigParseResult> {
  const cwd = String(input.cwd || '').trim()
  const fs = input.fs || null
  const env = input.env || null
  let fileDoc: Record<string, unknown> = {}
  if (fs && typeof fs.readText === 'function') {
    try {
      const target = typeof fs.resolve === 'function' ? await fs.resolve(YUNXIAO_CONFIG_REL, cwd ? { cwd } : undefined) : (cwd ? cwd.replace(/\/+$/, '') + '/' : '') + YUNXIAO_CONFIG_REL
      const rawText = await fs.readText(target)
      if (typeof rawText === 'string' && rawText.trim() !== '') {
        const pre = parseRawConfigRecord(rawText)
        if (!pre.ok) return pre
        fileDoc = { ...pre.doc }
      }
    } catch (readErr: unknown) {
      const errCode = String((readErr as { code?: unknown })?.code || '').toUpperCase()
      const errMsg = String((readErr as Error)?.message || readErr || '')
      if (!(errCode === 'ENOENT' || /\bENOENT\b|no such file|not found|不存在/i.test(errMsg))) {
        return { ok: false, reason: 'io-error', message: '读取 docs/agents/yunxiao.yaml 失败：' + errMsg.slice(0, 200) }
      }
    }
  }
  const merged: Record<string, unknown> = { ...fileDoc }
  if (merged['version'] === undefined) merged['version'] = YUNXIAO_KNOWN_VERSION
  for (const [envName, fieldName] of ENV_FIELD_MAP) {
    const v = env && typeof env.get === 'function' ? env.get(envName) : undefined
    if (typeof v === 'string' && v.trim()) merged[fieldName] = v.trim()
  }
  return parseYunxiaoConfig(merged)
}

/** 从项目名称稳定派生 4~6 位全大写字母的 Yunxiao Projex 项目代号（customCode），支持冲突时按 attempt 递增字母后缀。 */
export function deriveProjectCustomCode(name: unknown, attempt = 0): string {
  const words = String(name || '').toUpperCase().split(/[^A-Z]+/).filter(Boolean)
  let base = (words.length >= 2 ? words.map((w) => w[0]).join('') + words[words.length - 1].slice(1) : (words[0] || '')).replace(/[^A-Z]/g, '')
  while (base.length < 4) base += 'PROJ'
  const idx = Math.max(0, Math.floor(attempt))
  if (idx === 0) return base.slice(0, 6)
  const suffix = (idx > 26 ? String.fromCharCode(65 + (Math.floor((idx - 1) / 26) % 26)) : '') + String.fromCharCode(65 + ((idx - 1) % 26))
  return (base.slice(0, Math.max(4 - suffix.length, 6 - suffix.length)) + suffix).slice(0, 6)
}

/** 将云效工作区非敏感坐标序列化为标准 docs/agents/yunxiao.yaml 文本。 */
export function formatYunxiaoConfigYaml(input: {
  organizationId: string; projectId: string; customCode?: string; repositoryId?: string | number;
  namespaceId?: number; templateId?: string; apiBaseUrl?: string; webBaseUrl?: string
}): string {
  const lines = [
    '# 云效工作区非敏感坐标配置（由 Deck 管理，请勿在此写入 token/pat 凭证）',
    'version: 1',
    'organizationId: ' + String(input.organizationId || '').trim(),
    'projectId: ' + String(input.projectId || '').trim(),
  ]
  if (input.customCode && String(input.customCode).trim()) lines.push('customCode: ' + String(input.customCode).trim())
  if (input.repositoryId != null && String(input.repositoryId).trim()) lines.push('repositoryId: ' + JSON.stringify(String(input.repositoryId).trim()))
  if (typeof input.namespaceId === 'number' && Number.isSafeInteger(input.namespaceId) && input.namespaceId > 0) lines.push('namespaceId: ' + String(input.namespaceId))
  if (input.templateId && String(input.templateId).trim()) lines.push('templateId: ' + String(input.templateId).trim())
  if (input.apiBaseUrl && input.apiBaseUrl !== DEFAULT_YUNXIAO_API_BASE_URL) lines.push('apiBaseUrl: ' + input.apiBaseUrl.replace(/\/+$/, ''))
  if (input.webBaseUrl && input.webBaseUrl !== DEFAULT_YUNXIAO_WEB_BASE_URL) lines.push('webBaseUrl: ' + input.webBaseUrl.replace(/\/+$/, ''))
  return lines.join('\n') + '\n'
}

/** 取多行文本中的第一行非空内容（剥离首尾空白，忽略空行与以 # 开头的注释行）。 */
export function firstNonEmptyLine(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#')) return trimmed
  }
  return ''
}

/** 从三层只读通道加载云效个人访问令牌（x-yunxiao-token）。 */
export async function loadYunxiaoToken(input: {
  env?: BackendPlatform['env'] | null; fs?: SandboxFs | null; platform?: Partial<BackendPlatform> | null; homeDir?: string
}): Promise<YunxiaoTokenResolution> {
  const env = input.env || input.platform?.env || null
  const fs = input.fs || input.platform?.fs || null
  const readEnv = (name: string): string => (env && typeof env.get === 'function' ? firstNonEmptyLine(env.get(name)) : '')
  const directYx = readEnv('YUNXIAO_TOKEN')
  if (directYx) return { token: directYx, source: 'env:YUNXIAO_TOKEN' }
  const directAli = readEnv('ALIBABA_CLOUD_DEVOPS_TOKEN')
  if (directAli) return { token: directAli, source: 'env:ALIBABA_CLOUD_DEVOPS_TOKEN' }

  const readTokenFile = async (filePath: string): Promise<string> => {
    if (!fs || typeof fs.readText !== 'function' || !filePath) return ''
    try {
      const resolved = typeof fs.resolve === 'function' ? await fs.resolve(filePath) : filePath
      return firstNonEmptyLine(await fs.readText(resolved))
    } catch { return '' }
  }

  const tokenFilePath = env && typeof env.get === 'function' ? String(env.get('YUNXIAO_TOKEN_FILE') || '').trim() : ''
  if (tokenFilePath) {
    const fromFile = await readTokenFile(tokenFilePath)
    if (fromFile) return { token: fromFile, source: 'file:YUNXIAO_TOKEN_FILE' }
  }

  let home = String(input.homeDir || '').trim()
  if (!home && input.platform && typeof input.platform.getHome === 'function') {
    try { home = String((await input.platform.getHome()) || '').trim() } catch { home = '' }
  }
  if (!home && env && typeof env.get === 'function') home = String(env.get('HOME') || env.get('USERPROFILE') || '').trim()
  if (home) {
    const cleanHome = home.replace(/[\\/]+$/, '')
    const candidates: Array<{ rel: string; source: YunxiaoTokenResolution['source'] }> = [
      { rel: '.config/yunxiao/token', source: 'home:.config/yunxiao/token' },
      { rel: '.dsh/mattskillsdeck/yunxiao-token', source: 'home:.dsh/mattskillsdeck/yunxiao-token' },
    ]
    for (const cand of candidates) {
      const joined = input.platform?.path && typeof input.platform.path.join === 'function' ? input.platform.path.join(cleanHome, cand.rel) : cleanHome + '/' + cand.rel
      const tok = await readTokenFile(joined)
      if (tok) return { token: tok, source: cand.source }
    }
  }
  return { token: '', source: 'none' }
}
