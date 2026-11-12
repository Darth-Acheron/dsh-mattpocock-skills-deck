/**
 * src/host/yunxiaoOnboarding.ts —— 云效工作区向导宿主电话：wf.yunxiaoSaveToken 与 wf.yunxiaoDiscover（规格 #21 / #23）。
 *
 * 三条红线纪律：
 *   1. 遵守 rooms-imported-only-by-assembly：本文件绝不直接 import src/tracker/rooms/yunxiao/**，
 *      所有房间探针与配置解析能力一律由调用方（或默认通过唯一装配点 ../tracker/registry/builtins.js 的
 *      loadYunxiaoHostExtras）注入。
 *   2. 先在线验真、后原子落盘：候选令牌必须先通过 GET /oapi/v1/platform/user 在线核验，
 *      验真失败（401/403/网络异常/格式非法）时绝不创建或覆盖 ~/.config/yunxiao/token；
 *      验真通过后以 0700 目录权限 + 0600 唯一临时文件 + rename 原子替换落盘。
 *   3. 零明文泄露：返回值、错误文本与日志（仅用既有 host.call / host.call.fail 事件与白名单字段）
 *      绝不包含任何令牌原文。
 */

// @ts-expect-error 本域 tsconfig 不加载 @types/node，运行时由 Node 24 内置 node:crypto 提供
import { randomUUID } from 'node:crypto'
// @ts-expect-error 本域 tsconfig 不加载 @types/node，运行时由 Node 24 内置 node:fs/promises 提供
import { chmod as nodeChmod, mkdir as nodeMkdir, readFile as nodeReadFile, rename as nodeRename, unlink as nodeUnlink, writeFile as nodeWriteFile } from 'node:fs/promises'
// @ts-expect-error 本域 tsconfig 不加载 @types/node，运行时由 Node 24 内置 node:os 提供
import { homedir as nodeHomedir } from 'node:os'
// @ts-expect-error 本域 tsconfig 不加载 @types/node，运行时由 Node 24 内置 node:path 提供
import { join as nodeJoin } from 'node:path'

export interface TokenFsPort {
  mkdir(dir: string, opts?: { recursive?: boolean; mode?: number }): Promise<unknown>
  readFile(path: string, encoding?: string): Promise<string>
  writeFile(path: string, data: string, opts?: { encoding?: string; mode?: number; flag?: string }): Promise<unknown>
  chmod(path: string, mode: number): Promise<unknown>
  rename(oldPath: string, newPath: string): Promise<unknown>
  unlink(path: string): Promise<unknown>
}

export interface YunxiaoOnboardingDeps {
  DEFAULT_CWD?: string
  fs?: Partial<TokenFsPort> | null
  workspaceFs?: any
  getPlatform?: () => Promise<any> | any
  getHome?: () => Promise<string | null> | string | null
  homeDir?: string
  env?: { get?(name: string): string | undefined } | null
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>
  loadExtras?: () => Promise<any>
  logCtx?: { fire(level: string, event: string, fields?: unknown): void } | null
}

const DEFAULT_TOKEN_FS: TokenFsPort = {
  mkdir: nodeMkdir,
  readFile: nodeReadFile,
  writeFile: nodeWriteFile,
  chmod: nodeChmod,
  rename: nodeRename,
  unlink: nodeUnlink,
}

function hash8(s: unknown): string {
  try {
    const t = String(s || '')
    let h = 5381
    for (let i = 0; i < t.length; i++) h = (((h << 5) + h + t.charCodeAt(i)) >>> 0)
    return ('0000000' + h.toString(16)).slice(-8)
  } catch {
    return '00000000'
  }
}

function scrubToken(text: unknown, candidateToken: string): string {
  let out = String(text || '')
  if (candidateToken && candidateToken.length >= 4) {
    out = out.split(candidateToken).join('***')
  }
  return out.replace(/pt-[A-Za-z0-9._-]{4,}/g, 'pt-***')
}

export function createYunxiaoOnboarding(deps: YunxiaoOnboardingDeps = {}) {
  const DEFAULT_CWD = String(deps.DEFAULT_CWD || '')
  const tokenFs: TokenFsPort = {
    mkdir: deps.fs?.mkdir || DEFAULT_TOKEN_FS.mkdir,
    readFile: deps.fs?.readFile || DEFAULT_TOKEN_FS.readFile,
    writeFile: deps.fs?.writeFile || DEFAULT_TOKEN_FS.writeFile,
    chmod: deps.fs?.chmod || DEFAULT_TOKEN_FS.chmod,
    rename: deps.fs?.rename || DEFAULT_TOKEN_FS.rename,
    unlink: deps.fs?.unlink || DEFAULT_TOKEN_FS.unlink,
  }
  const logCtx = deps.logCtx || null

  let _extrasP: Promise<any> | null = null
  function getExtras(): Promise<any> {
    if (typeof deps.loadExtras === 'function') return Promise.resolve(deps.loadExtras())
    if (!_extrasP) {
      _extrasP = import('../tracker/registry/builtins.js').then((m) => m.loadYunxiaoHostExtras())
    }
    return _extrasP
  }

  async function resolveRuntimeEnvAndFs(): Promise<{ env: { get(k: string): string | undefined }; wsFs: any; home: string }> {
    let plat: any = null
    if (typeof deps.getPlatform === 'function') {
      try { plat = await deps.getPlatform() } catch { plat = null }
    }
    const envObj = deps.env || (plat && plat.env) || null
    const env = {
      get(k: string): string | undefined {
        if (envObj && typeof envObj.get === 'function') return envObj.get(k)
        return undefined
      },
    }
    const wsFs = deps.workspaceFs || (plat && plat.fs) || {
      resolve: async (rel: string, opts?: { cwd?: string }) => (opts?.cwd ? nodeJoin(opts.cwd, rel) : rel),
      readText: async (target: string) => tokenFs.readFile(String(target), 'utf8'),
    }
    let home = String(deps.homeDir || '').trim()
    if (!home && typeof deps.getHome === 'function') {
      try { home = String((await deps.getHome()) || '').trim() } catch { home = '' }
    }
    if (!home && plat && typeof plat.getHome === 'function') {
      try { home = String((await plat.getHome()) || '').trim() } catch { home = '' }
    }
    if (!home) {
      home = String(env.get('HOME') || env.get('USERPROFILE') || '').trim()
    }
    if (!home && typeof nodeHomedir === 'function') {
      try { home = String(nodeHomedir() || '').trim() } catch { home = '' }
    }
    return { env, wsFs, home }
  }

  function phoneLog(method: string, kind: string, t0: number, res: any, err?: unknown): void {
    if (!logCtx || typeof logCtx.fire !== 'function') return
    try {
      if (err !== undefined && err !== null) {
        logCtx.fire('warn', 'host.call.fail', {
          method,
          kind,
          errorKind: 'internal',
          errorHash: hash8(String((err as Error)?.message || err)),
        })
      } else if (res && res.ok === true) {
        logCtx.fire('info', 'host.call', {
          method,
          latencyMs: Date.now() - t0,
          ok: true,
          kind,
        })
      } else {
        const errorKind = String((res && res.errorKind) || 'unknown')
        logCtx.fire('warn', 'host.call.fail', {
          method,
          kind,
          errorKind,
          errorHash: hash8(String((res && res.error) || errorKind)),
        })
      }
    } catch {}
  }

  async function handleYunxiaoSaveTokenRaw(args?: { cwd?: string; token?: unknown } | null): Promise<any> {
    const cwd = String((args && args.cwd) || DEFAULT_CWD).trim()
    const rawInput = typeof args?.token === 'string' ? args.token : ''
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(rawInput)) {
      return {
        ok: false,
        errorKind: 'parse',
        error: '个人访问令牌包含非法控制字符，请重新复制粘贴。',
      }
    }

    const extras = await getExtras()
    const candidate: string = typeof extras.firstNonEmptyLine === 'function'
      ? extras.firstNonEmptyLine(rawInput)
      : rawInput.trim()

    if (!candidate) {
      return {
        ok: false,
        errorKind: 'parse',
        error: '个人访问令牌不能为空，请粘贴有效的云效个人访问令牌。',
      }
    }
    if (/\s/.test(candidate) || /[\x00-\x1f\x7f]/.test(candidate)) {
      return {
        ok: false,
        errorKind: 'parse',
        error: '个人访问令牌格式不合法（不能包含空格或控制字符）。',
      }
    }

    const { env, wsFs, home } = await resolveRuntimeEnvAndFs()
    if (!home) {
      return {
        ok: false,
        errorKind: 'env',
        error: '无法解析当前用户主目录，无法保存 ~/.config/yunxiao/token。',
      }
    }

    const baseUrlsRes = await extras.resolveYunxiaoBaseUrls({ cwd, fs: wsFs, env })
    if (!baseUrlsRes || !baseUrlsRes.ok) {
      return {
        ok: false,
        errorKind: 'env',
        error: scrubToken((baseUrlsRes && baseUrlsRes.message) || '读取云效服务地址配置失败', candidate),
      }
    }
    const apiBaseUrl: string = baseUrlsRes.value.apiBaseUrl

    const probeRes = await extras.probeYunxiaoPlatformUser(
      {
        cwd,
        apiBaseUrl,
        token: candidate,
        fetch: deps.fetch,
        platform: { fs: wsFs, env } as any,
      },
      undefined,
      { cwd, apiBaseUrl, token: candidate },
    )

    if (!probeRes || !probeRes.ok) {
      const resp = probeRes?.response
      const status = typeof resp?.status === 'number' ? resp.status : 0
      const verdict = typeof extras.classifyYunxiaoError === 'function'
        ? extras.classifyYunxiaoError({ status, message: resp?.stderr || 'auth failed' })
        : { kind: status === 401 || status === 403 ? 'auth' : 'network' }
      const errorKind = status === 401 || status === 403 ? 'auth' : String(verdict.kind || 'auth')
      const detailMsg = status === 401 || status === 403
        ? '云效个人访问令牌无效或已过期（HTTP ' + String(status) + '），请核对令牌及「组织管理/用户信息：只读」权限后重试。'
        : '在线校验云效个人访问令牌失败（' + scrubToken(resp?.stderr || '网络或服务异常', candidate).slice(0, 160) + '）。'
      return {
        ok: false,
        errorKind,
        error: detailMsg,
      }
    }

    const configDir = nodeJoin(home, '.config', 'yunxiao')
    const targetPath = nodeJoin(configDir, 'token')
    const tmpPath = nodeJoin(configDir, 'token.tmp.' + String(randomUUID()))

    try {
      await tokenFs.mkdir(configDir, { recursive: true, mode: 0o700 })
      await tokenFs.writeFile(tmpPath, candidate + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await tokenFs.chmod(tmpPath, 0o600)
      await tokenFs.rename(tmpPath, targetPath)
    } catch (ioErr: unknown) {
      try { await tokenFs.unlink(tmpPath) } catch {}
      return {
        ok: false,
        errorKind: 'env',
        error: '写入 ~/.config/yunxiao/token 失败：' + scrubToken((ioErr as Error)?.message || ioErr, candidate).slice(0, 160),
      }
    }

    const envYx = String(env.get('YUNXIAO_TOKEN') || '').trim()
    const envAli = String(env.get('ALIBABA_CLOUD_DEVOPS_TOKEN') || '').trim()
    const envShadowWarning = Boolean(envYx || envAli)
    const shadowedVar = envYx ? 'YUNXIAO_TOKEN' : (envAli ? 'ALIBABA_CLOUD_DEVOPS_TOKEN' : '')
    const warningText = envShadowWarning
      ? {
          zh: '令牌已保存至 ~/.config/yunxiao/token，但检测到当前进程设置了环境变量 ' + shadowedVar + '；运行时环境变量优先级更高。',
          en: 'Token saved to ~/.config/yunxiao/token, but environment variable ' + shadowedVar + ' is set and takes precedence at runtime.',
        }
      : undefined

    const u = probeRes.user
    return {
      ok: true,
      user: {
        id: u.id,
        name: u.name,
        login: u.login,
        ...(u.username ? { username: u.username } : {}),
        ...(u.lastOrganization ? { lastOrganization: u.lastOrganization } : {}),
      },
      tokenFilePath: '~/.config/yunxiao/token',
      envShadowWarning,
      ...(warningText ? { warningText } : {}),
    }
  }

  async function handleYunxiaoDiscoverRaw(args?: { cwd?: string; organizationId?: string; projectId?: string } | null): Promise<any> {
    const cwd = String((args && args.cwd) || DEFAULT_CWD).trim()
    const extras = await getExtras()
    if (typeof extras.discoverYunxiaoWorkspace === 'function') {
      return extras.discoverYunxiaoWorkspace({
        cwd,
        organizationId: args?.organizationId,
        projectId: args?.projectId,
        deps,
      })
    }

    const { env, wsFs, home } = await resolveRuntimeEnvAndFs()
    const baseUrlsRes = await extras.resolveYunxiaoBaseUrls({ cwd, fs: wsFs, env })
    const apiBaseUrl = baseUrlsRes && baseUrlsRes.ok ? baseUrlsRes.value.apiBaseUrl : undefined
    const tokRes = await extras.loadYunxiaoToken({
      env,
      fs: wsFs,
      homeDir: home,
      platform: {
        env,
        fs: wsFs,
        getHome: async () => home,
        path: { join: (...parts: string[]) => nodeJoin(...parts) },
      } as any,
    })

    if (!tokRes || !tokRes.token) {
      return {
        ok: true,
        authenticated: false,
        initialStepIndex: 0,
        optionsByField: {},
        defaultsByField: {},
        bannersByField: {},
      }
    }

    const probeRes = await extras.probeYunxiaoPlatformUser(
      {
        cwd,
        apiBaseUrl,
        token: tokRes.token,
        fetch: deps.fetch,
        platform: { fs: wsFs, env } as any,
      },
      undefined,
      { cwd, apiBaseUrl, token: tokRes.token },
    )

    if (!probeRes || !probeRes.ok) {
      return {
        ok: true,
        authenticated: false,
        initialStepIndex: 0,
        optionsByField: {},
        defaultsByField: {},
        bannersByField: {},
      }
    }

    const defaultsByField: Record<string, string> = {}
    if (probeRes.user?.lastOrganization) {
      defaultsByField.organizationId = probeRes.user.lastOrganization
    }
    return {
      ok: true,
      authenticated: true,
      initialStepIndex: 1,
      user: {
        id: probeRes.user.id,
        name: probeRes.user.name,
        login: probeRes.user.login,
        ...(probeRes.user.lastOrganization ? { lastOrganization: probeRes.user.lastOrganization } : {}),
      },
      optionsByField: {},
      defaultsByField,
      bannersByField: {},
    }
  }

  return {
    async handleYunxiaoSaveToken(args?: { cwd?: string; token?: unknown } | null): Promise<any> {
      const t0 = Date.now()
      try {
        const res = await handleYunxiaoSaveTokenRaw(args)
        phoneLog('wf.yunxiaoSaveToken', 'yunxiao-onboarding', t0, res)
        return res
      } catch (e) {
        phoneLog('wf.yunxiaoSaveToken', 'yunxiao-onboarding', t0, null, e)
        throw e
      }
    },
    async handleYunxiaoDiscover(args?: { cwd?: string; organizationId?: string; projectId?: string } | null): Promise<any> {
      const t0 = Date.now()
      try {
        const res = await handleYunxiaoDiscoverRaw(args)
        phoneLog('wf.yunxiaoDiscover', 'yunxiao-onboarding', t0, res)
        return res
      } catch (e) {
        phoneLog('wf.yunxiaoDiscover', 'yunxiao-onboarding', t0, null, e)
        throw e
      }
    },
  }
}
