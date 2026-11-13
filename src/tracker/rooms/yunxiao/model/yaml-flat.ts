/**
 * src/tracker/rooms/yunxiao/model/yaml-flat.ts —— 云效工作区扁平键值 YAML/JSON 词法解析与敏感键拦截（规格 #01 / #24 拆分）。
 *
 * 为什么从 workspace-config.ts 拆出：
 *   1. 将纯文本词法解析、YAML 别名拒绝与内联密钥拦截独立为无副作用的纯函数模块，保持云效房间单文件低于 250 有效行；
 *   2. 严格拒绝在仓库内的 docs/agents/yunxiao.yaml 中出现任何 token / pat / secret 等敏感键名。
 */

export const YUNXIAO_KNOWN_KEYS: readonly string[] = [
  'version', 'organizationId', 'projectId', 'customCode', 'repositoryId', 'namespaceId', 'templateId', 'apiBaseUrl', 'webBaseUrl',
]

const INLINE_SECRET_KEYS: ReadonlySet<string> = new Set([
  'token', 'pat', 'accesstoken', 'access_token', 'personalaccesstoken', 'personal_access_token',
  'x-yunxiao-token', 'yunxiaotoken', 'yunxiao_token', 'secret', 'password', 'authorization',
])

export type YunxiaoKeyGuardError = {
  ok: false
  reason: 'unknown-keys' | 'inline-secret'
  message: string
  keys: string[]
}

function isInlineSecretKey(key: string): boolean {
  const lower = key.trim().toLowerCase()
  return INLINE_SECRET_KEYS.has(lower) || /(?:^|[_-])(token|secret|password|pat)(?:$|[_-])/.test(lower)
}

/** 拦截内联凭证键名与未登记的未知配置键名；全部合法时返回 null。 */
export function checkAllowedKeys(doc: Record<string, unknown>): YunxiaoKeyGuardError | null {
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

/** 解析顶层扁平键值 YAML 或等价 JSON，出于安全原因一律拒绝 YAML 锚点/别名与嵌套缩进。 */
export function parseFlatYamlOrJson(text: string): { ok: true; doc: unknown } | { ok: false; reason: 'yaml-error' | 'aliases'; message: string } {
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
