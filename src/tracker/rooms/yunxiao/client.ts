/**
 * src/tracker/rooms/yunxiao/client.ts —— Yunxiao backend 可注入 HTTP 传输底座、分页头解析与请求用量统计（规格 #01）。
 *
 * 核心设计约束：
 *   1. 零第三方 npm 依赖：默认使用 Node 24 内置 fetch 与 AbortSignal.timeout，同时支持在上下文
 *      （ctx.fetch）或调用选项中注入自定义 fetch 函数，使房间契约门禁 100% 离线确定性运行。
 *   2. 完整保留分页响应头（x-page、x-per-page、x-total、x-total-pages、x-next-page）：
 *      真机实测云效在最后一页或空结果时仍返回 x-next-page: "1" 或 "2"，因此翻页判断必须且只能用
 *      hasNextYunxiaoPage(headers)（即 xPage < xTotalPages）。
 *   3. 处理 HTTP 204 No Content 空响应（如 ListLabels 空标签列表、UpdateWorkitem、DeleteWorkitemRelationRecord）。
 *   4. 独立 yunxiao 出站超时冷却桶：接入 ctx.outbound（service: 'yunxiao'），每次真实请求计入 attachYunxiaoOpUsage。
 *   5. 凭证零回显：请求层绝不把 x-yunxiao-token 原文拼入错误消息或日志，错误文本统一经 maskSecrets 脱敏。
 */

import type { BackendContext, OpContext } from '../../contract/contexts.js'
import type { OutboundBucket, OutboundControl } from '../../contract/outbound.js'
import type { OpResult } from '../../contract/results.js'
import { maskSecrets } from '../../kernel/error-rules.js'
import { READ_TIMEOUT_MS, WRITE_TIMEOUT_MS, outboundCooldownOf, outboundFollowUpAdvice, outboundQueueTimeoutOf, queueTimeoutForTier } from '../../kernel/outbound-tiers.js'
import { DEFAULT_YUNXIAO_API_BASE_URL, loadYunxiaoToken, resolveYunxiaoCoordinates } from './model/workspace-config.js'
// @ts-expect-error 本域 tsconfig 不加载 @types/node，运行时由 Node 24 内置 node:async_hooks 提供
import { AsyncLocalStorage } from 'node:async_hooks'

export type YunxiaoFetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>

/**
 * 房间级自定义 fetch 槽位：供按需真机冒烟脚本或测试在不深引房间内部的情况下通过装配点注入传输层。
 */
let customYunxiaoFetch: YunxiaoFetchFn | null = null

export function setYunxiaoCustomFetch(fn: YunxiaoFetchFn | null): void {
  customYunxiaoFetch = fn
}

export type YunxiaoCtx = Partial<OpContext> & Partial<BackendContext> & {
  fetch?: YunxiaoFetchFn
  apiBaseUrl?: string
  token?: string
  gate?: { noteOutbound?: (entry: { requests: number; points: number }) => void } | null
}

export interface YunxiaoResponseHeaders {
  xPage: number | null
  xPerPage: number | null
  xTotal: number | null
  xTotalPages: number | null
  xNextPage: number | null
  xPrevPage: number | null
  xRequestId: string
}

export interface YunxiaoRequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  apiBaseUrl?: string
  token?: string
  timeoutMs?: number
  signal?: AbortSignal
  cmd?: string
  bucket?: OutboundBucket
  fetch?: YunxiaoFetchFn
}

export interface YunxiaoHttpResult {
  ok: boolean
  status: number
  code: number
  stdout: string
  stderr: string
  data: unknown
  headers: YunxiaoResponseHeaders
  timedOut?: boolean
  cancelled?: boolean
}

interface YunxiaoUsageBox { requests: number; points: number }
interface YunxiaoUsageStore {
  run<T>(box: YunxiaoUsageBox, fn: () => T): T
  getStore(): YunxiaoUsageBox | undefined
}

const yunxiaoUsageStore = new AsyncLocalStorage() as YunxiaoUsageStore

function noteYunxiaoUsage(): void {
  const box = yunxiaoUsageStore.getStore()
  if (box) box.requests += 1
}

/** 包装房间操作表：在异步操作的成功信封上自动附加真实 HTTP 请求用量 usage: { requests, points: 0 }。 */
export function attachYunxiaoOpUsage<T extends object>(table: T): T {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(table)) {
    const value = (table as Record<string, unknown>)[key]
    if (typeof value !== 'function') { out[key] = value; continue }
    out[key] = function (this: unknown, ...args: unknown[]): unknown {
      const box: YunxiaoUsageBox = { requests: 0, points: 0 }
      const result = yunxiaoUsageStore.run(box, function () { return (value as (...a: unknown[]) => unknown).apply(table, args) })
      if (!result || typeof (result as Promise<unknown>).then !== 'function') return result
      return (result as Promise<unknown>).then(function (envelope) {
        const reply = envelope as OpResult<unknown> | null
        if (reply && reply.ok === true) return Object.assign({}, reply, { usage: { requests: box.requests, points: box.points } })
        return reply
      })
    }
  }
  return out as T
}

function parseHeaderInt(headers: Headers, name: string): number | null {
  const raw = headers.get(name)
  if (raw == null) return null
  const trimmed = raw.trim()
  if (!trimmed || !/^-?\d+$/.test(trimmed)) return null
  const num = Number(trimmed)
  return Number.isSafeInteger(num) ? num : null
}

/** 从 Fetch Response.headers 中提取云效分页头。 */
export function extractYunxiaoHeaders(headers?: Headers | null): YunxiaoResponseHeaders {
  if (!headers || typeof headers.get !== 'function') {
    return { xPage: null, xPerPage: null, xTotal: null, xTotalPages: null, xNextPage: null, xPrevPage: null, xRequestId: '' }
  }
  return {
    xPage: parseHeaderInt(headers, 'x-page'),
    xPerPage: parseHeaderInt(headers, 'x-per-page'),
    xTotal: parseHeaderInt(headers, 'x-total'),
    xTotalPages: parseHeaderInt(headers, 'x-total-pages'),
    xNextPage: parseHeaderInt(headers, 'x-next-page'),
    xPrevPage: parseHeaderInt(headers, 'x-prev-page'),
    xRequestId: String(headers.get('x-request-id') || '').trim(),
  }
}

/** 判定云效分页响应是否还有下一页（严格以 xPage < xTotalPages 判定，忽略单页时恒非空的 x-next-page）。 */
export function hasNextYunxiaoPage(headers: Partial<YunxiaoResponseHeaders> | null | undefined): boolean {
  if (!headers) return false
  const page = typeof headers.xPage === 'number' ? headers.xPage : null
  const totalPages = typeof headers.xTotalPages === 'number' ? headers.xTotalPages : null
  return page !== null && totalPages !== null && page > 0 && totalPages > 0 && page < totalPages
}

let assembledOutbound: OutboundControl | null = null

function shapeOk(c: unknown): c is OutboundControl {
  const o = c as OutboundControl | null | undefined
  return Boolean(o) && typeof o!.acquire === 'function' &&
    typeof o!.reportTransportFailure === 'function' && typeof o!.reportSuccess === 'function'
}

export function rememberYunxiaoOutbound(control: OutboundControl | null | undefined): void {
  assembledOutbound = shapeOk(control) ? control : null
}

function getOutbound(ctx?: YunxiaoCtx | null): OutboundControl | null {
  return ctx && shapeOk(ctx.outbound) ? ctx.outbound : assembledOutbound
}

function isWriteMethod(method: string, pathStr: string): boolean {
  const m = method.toUpperCase()
  if (m === 'GET' || (m === 'POST' && pathStr.endsWith(':search'))) return false
  return m === 'POST' || m === 'PUT' || m === 'DELETE'
}

function failEnvelope(status: number, code: number, stderr: string, headers: YunxiaoResponseHeaders, flags?: { timedOut?: boolean; cancelled?: boolean }): YunxiaoHttpResult {
  return { ok: false, status, code, stdout: '', stderr, data: null, headers, ...flags }
}

/** 创建云效 HTTP 客户端。 */
export function yunxiaoClient(ctx?: YunxiaoCtx | null): { request(pathOrUrl: string, opts?: YunxiaoRequestOpts): Promise<YunxiaoHttpResult> } {
  async function request(pathOrUrl: string, opts: YunxiaoRequestOpts = {}): Promise<YunxiaoHttpResult> {
    const emptyHeaders = extractYunxiaoHeaders(null)
    const method = (opts.method || 'GET').toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE'
    const isWrite = isWriteMethod(method, pathOrUrl)
    const bucket: OutboundBucket = opts.bucket || (isWrite ? 'write' : 'read')
    const tierLimit = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : isWrite ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS
    const cmdLabel = opts.cmd || 'yunxiao:' + method.toLowerCase()

    let apiBaseUrl = opts.apiBaseUrl || (typeof ctx?.apiBaseUrl === 'string' ? ctx.apiBaseUrl.trim() : '')
    if (!apiBaseUrl && ctx) {
      const coords = await resolveYunxiaoCoordinates({ cwd: ctx.cwd, fs: ctx.platform?.fs || ctx.fs || null, env: ctx.platform?.env || null })
      if (coords.ok) apiBaseUrl = coords.value.apiBaseUrl
      else if (coords.reason === 'io-error') {
        return failEnvelope(0, 1, coords.message, emptyHeaders)
      }
    }
    if (!apiBaseUrl) apiBaseUrl = DEFAULT_YUNXIAO_API_BASE_URL

    let token = typeof opts.token === 'string' ? opts.token.trim() : (typeof ctx?.token === 'string' ? ctx.token.trim() : '')
    if (!token && ctx) {
      const loaded = await loadYunxiaoToken({ env: ctx.platform?.env || null, fs: ctx.platform?.fs || ctx.fs || null, platform: ctx.platform || null })
      token = loaded.token
    }
    if (!token) return failEnvelope(401, 1, 'Missing Yunxiao token: set YUNXIAO_TOKEN or ~/.config/yunxiao/token', emptyHeaders)

    const fullUrl = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : apiBaseUrl.replace(/\/+$/, '') + '/' + pathOrUrl.replace(/^\/+/, '')
    const fetchFn: YunxiaoFetchFn | undefined = opts.fetch || ctx?.fetch || customYunxiaoFetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined)
    if (typeof fetchFn !== 'function') return failEnvelope(0, 127, 'fetch unavailable in current runtime', emptyHeaders)

    const outbound = getOutbound(ctx)
    const signal = opts.signal || ctx?.signal || undefined
    let release: (() => void) | null = null
    if (outbound) {
      try {
        release = await outbound.acquire({ bucket, service: 'yunxiao', cmd: cmdLabel, signal, waitMs: queueTimeoutForTier(tierLimit) })
      } catch (acquireErr: unknown) {
        if (typeof outbound.isCancelled === 'function' && outbound.isCancelled(acquireErr)) return failEnvelope(0, 1, '云效出站请求在排队期间被取消（' + cmdLabel + '）', emptyHeaders, { cancelled: true })
        if (outboundCooldownOf(acquireErr)) {
          return failEnvelope(0, 1, '到云效的通路现在不通（' + cmdLabel + ' 在冷却窗口内未发起请求）：' + outboundFollowUpAdvice(isWrite ? 'write' : 'read'), emptyHeaders)
        }
        if (outboundQueueTimeoutOf(acquireErr)) {
          return failEnvelope(0, 1, '等待云效出站名额超时（' + cmdLabel + '）：' + outboundFollowUpAdvice(isWrite ? 'write' : 'read'), emptyHeaders, { timedOut: true })
        }
        return failEnvelope(0, 1, maskSecrets(String((acquireErr as Error)?.message || acquireErr)), emptyHeaders)
      }
    }

    noteYunxiaoUsage()
    try { ctx?.gate?.noteOutbound?.({ requests: 1, points: 0 }) } catch { /* ignore */ }

    try {
      const reqHeaders: Record<string, string> = { Accept: 'application/json', 'x-yunxiao-token': token }
      let serializedBody: string | undefined
      if (opts.body !== undefined && opts.body !== null) {
        reqHeaders['Content-Type'] = 'application/json'
        serializedBody = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
      }
      const timeoutSig = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(tierLimit) : undefined
      const combinedSignal = signal && timeoutSig && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeoutSig]) : signal || timeoutSig

      const res = await fetchFn(fullUrl, { method, headers: reqHeaders, body: serializedBody, signal: combinedSignal })
      outbound?.reportSuccess({ bucket, service: 'yunxiao' })
      if (isWrite && res.ok && typeof outbound?.noteWrite === 'function') outbound.noteWrite()

      const parsedHeaders = extractYunxiaoHeaders(res.headers)
      if (res.status === 204) return { ok: true, status: 204, code: 0, stdout: '', stderr: '', data: null, headers: parsedHeaders }

      const rawBody = await res.text()
      const safeBody = maskSecrets(rawBody)
      let parsedData: unknown = null
      if (rawBody.trim() !== '') {
        try { parsedData = JSON.parse(rawBody) } catch { parsedData = safeBody }
      }
      if (res.ok) return { ok: true, status: res.status, code: 0, stdout: safeBody, stderr: '', data: parsedData, headers: parsedHeaders }
      return { ok: false, status: res.status, code: 1, stdout: '', stderr: safeBody || 'HTTP ' + res.status, data: parsedData, headers: parsedHeaders }
    } catch (err: unknown) {
      const errName = String((err as { name?: unknown })?.name || '')
      const errMsg = maskSecrets(String((err as Error)?.message || err))
      const isTimeout = errName === 'TimeoutError' || /timeout|timed out|aborted due to timeout/i.test(errMsg)
      const isAbort = !isTimeout && (errName === 'AbortError' || Boolean(signal?.aborted))
      if (isTimeout) outbound?.reportTransportFailure({ bucket, reason: 'timeout', cmd: cmdLabel, service: 'yunxiao' })
      return failEnvelope(0, 1, isTimeout ? '云效请求超时（' + cmdLabel + '）：' + errMsg : errMsg, emptyHeaders, { timedOut: isTimeout, cancelled: isAbort })
    } finally {
      if (release) { try { release() } catch { /* ignore */ } }
    }
  }
  return { request }
}

export default yunxiaoClient
