// scripts/real-machine/commands/yunxiao-sandbox.mts —— 受 YUNXIAO_LIVE_VERIFY=1 环境变量门控的可选云效真机沙箱冒烟脚本（规格 #05）。
//
// 为什么采用环境变量门控且放在离线验证主链之外：
//   标准验证链（npm run verify:parallel）必须在 100% 离线、零外部凭证的环境下运行通过；
//   当维护者或开发者在真实云效测试项目中核验 OpenAPI 连通性与沙箱工作项生命周期时，
//   可通过显式设置 YUNXIAO_LIVE_VERIFY=1 按需触发本脚本。
//   当 YUNXIAO_LIVE_VERIFY !== '1' 时，脚本立即输出 { ok: true, skipped: true } 并以退出码 0 结束，绝不阻塞离线主链。
//   脚本经唯一装配点 src/tracker/registry/builtins.ts 动态加载 Yunxiao 模块，不直接深引房间内部实现。
//
// 用法：
//   YUNXIAO_LIVE_VERIFY=1 node --import ./scripts/ts-hook.mts scripts/real-machine/commands/yunxiao-sandbox.mts [--cwd <工作区目录>] [--write-lifecycle]

import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { info, parseArgs, printJson, repoRoot, runCli } from '../lib/util.mts'

export interface YunxiaoLiveSmokeOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  writeLifecycle?: boolean
  fetch?: (input: string, init?: unknown) => Promise<unknown>
}

export interface YunxiaoLiveSmokeResult {
  ok: boolean
  skipped: boolean
  reason?: string
  preflightOk?: boolean
  repoRef?: { backend: string; refId: string; name: string; url: string }
  currentUser?: { login: string; name?: string }
  permissions?: { push: boolean; triage: boolean }
  issueCount?: number
  lifecycle?: {
    createdKey: string
    parentWired: boolean
    blockedWired: boolean
    commentCreated: boolean
    closedState: string
  }
  error?: string
}

async function importSource(repoDir: string, relative: string): Promise<Record<string, any>> {
  return (await import(pathToFileURL(path.join(repoDir, relative)).href)) as Record<string, any>
}

function makeNodePlatform(envMap: Record<string, string | undefined>) {
  const fsAdapter = {
    resolve: async (rel: string, opts?: { cwd?: string }) =>
      path.resolve((opts && opts.cwd) || process.cwd(), String(rel || '')),
    readText: async (target: unknown) => fs.readFileSync(String(target), 'utf8'),
    writeText: async (target: unknown, content: string) => {
      fs.mkdirSync(path.dirname(String(target)), { recursive: true })
      fs.writeFileSync(String(target), content, 'utf8')
    },
  }
  return {
    os: process.platform,
    path,
    getHome: async () => homedir(),
    fs: fsAdapter,
    env: {
      get: (key: string) => envMap[key],
      has: (key: string) => envMap[key] !== undefined,
    },
  }
}

/**
 * 执行云效真机或注入式沙箱冒烟。
 * 未设置 `YUNXIAO_LIVE_VERIFY=1` 时立即返回 `{ ok: true, skipped: true }`。
 */
export async function runYunxiaoLiveSmoke(opts: YunxiaoLiveSmokeOptions = {}): Promise<YunxiaoLiveSmokeResult> {
  const envMap: Record<string, string | undefined> = opts.env || (process.env as Record<string, string | undefined>)
  const liveFlag = String(envMap['YUNXIAO_LIVE_VERIFY'] || '').trim()
  if (liveFlag !== '1') {
    return {
      ok: true,
      skipped: true,
      reason: 'YUNXIAO_LIVE_VERIFY is not set to 1',
    }
  }

  const rootDir = repoRoot()
  const builtins = await importSource(rootDir, 'src/tracker/registry/builtins.ts')
  const errorRules = await importSource(rootDir, 'src/tracker/kernel/error-rules.ts')
  const maskSecrets = (text: string): string =>
    typeof errorRules.maskSecrets === 'function' ? String(errorRules.maskSecrets(text)) : text
  const errSummary = (res: { error?: { kind?: string; message?: string } | null }): string => {
    const kind = res.error?.kind || 'unknown'
    const msg = res.error?.message || ''
    return maskSecrets(kind + (msg ? ': ' + msg : ''))
  }

  const cwd = path.resolve(opts.cwd || process.cwd())
  const platform = makeNodePlatform(envMap)
  const opCtx: any = {
    cwd,
    platform,
    fs: platform.fs,
  }

  const extras = await builtins.loadYunxiaoHostExtras()
  if (opts.fetch) {
    extras.setYunxiaoCustomFetch(opts.fetch)
  }

  try {
    const mods = (await builtins.loadBuiltinBackendModules()) as Array<Record<string, any>>
    const yxMod = mods.find((m) => m && m.id === 'yunxiao')
    if (!yxMod) {
      return {
        ok: false,
        skipped: false,
        preflightOk: false,
        error: 'yunxiao module is not registered in loadBuiltinBackendModules()',
      }
    }

    const backend = yxMod.create(opCtx)
    const pre = await backend.preflight({ cwd }, opCtx)
    if (!pre.ok) {
      return {
        ok: false,
        skipped: false,
        preflightOk: false,
        error: errSummary(pre),
      }
    }

    const repoKey = await backend.getRepoKey(cwd, opCtx)
    if (!repoKey) {
      return {
        ok: false,
        skipped: false,
        preflightOk: true,
        error: 'getRepoKey returned null after preflight',
      }
    }

    const refId = repoKey.owner + '/' + repoKey.name
    const repoRef = yxMod.describe ? yxMod.describe({ cwd, refId }, 'yunxiao') : { backend: 'yunxiao', refId, name: refId, url: '' }

    const userRes = await backend.getCurrentUser(repoRef, opCtx)
    if (!userRes.ok) {
      return {
        ok: false,
        skipped: false,
        preflightOk: true,
        repoRef,
        error: 'getCurrentUser failed: ' + errSummary(userRes),
      }
    }

    const permRes = await backend.getRepoPermissions(repoRef, opCtx)
    if (!permRes.ok) {
      return {
        ok: false,
        skipped: false,
        preflightOk: true,
        repoRef,
        currentUser: userRes.data,
        error: 'getRepoPermissions failed: ' + errSummary(permRes),
      }
    }

    const listRes = await backend.list(repoRef, { state: 'open' }, opCtx)
    if (!listRes.ok) {
      return {
        ok: false,
        skipped: false,
        preflightOk: true,
        repoRef,
        currentUser: userRes.data,
        permissions: permRes.data,
        error: 'list failed: ' + errSummary(listRes),
      }
    }

    const result: YunxiaoLiveSmokeResult = {
      ok: true,
      skipped: false,
      preflightOk: true,
      repoRef,
      currentUser: userRes.data,
      permissions: permRes.data,
      issueCount: listRes.data.length,
    }

    const wantLifecycle = opts.writeLifecycle === true || String(envMap['YUNXIAO_LIVE_WRITE'] || '').trim() === '1'
    if (wantLifecycle) {
      const created = await backend.create(
        repoRef,
        {
          title: '[dsh-sandbox] Yunxiao smoke ticket',
          body: 'Automated sandbox smoke verification ticket.',
        },
        opCtx,
      )
      if (!created.ok) {
        return {
          ...result,
          ok: false,
          error: 'create failed: ' + errSummary(created),
        }
      }
      const key = created.data.key

      const parentCleared = await backend.setParent(repoRef, key, null, opCtx)
      if (!parentCleared.ok) {
        return {
          ...result,
          ok: false,
          error: 'setParent failed: ' + errSummary(parentCleared),
        }
      }

      const blockedCleared = await backend.setBlockedBy(repoRef, key, [], opCtx)
      if (!blockedCleared.ok) {
        return {
          ...result,
          ok: false,
          error: 'setBlockedBy failed: ' + errSummary(blockedCleared),
        }
      }

      const commented = await backend.comment(repoRef, key, 'smoke comment', opCtx)
      if (!commented.ok) {
        return {
          ...result,
          ok: false,
          error: 'comment failed: ' + errSummary(commented),
        }
      }
      const closed = await backend.close(repoRef, key, {}, opCtx)
      if (!closed.ok) {
        return {
          ...result,
          ok: false,
          error: 'close failed: ' + errSummary(closed),
        }
      }
      result.lifecycle = {
        createdKey: key,
        parentWired: true,
        blockedWired: true,
        commentCreated: true,
        closedState: closed.data.state,
      }
    }

    return result
  } finally {
    if (opts.fetch) {
      extras.setYunxiaoCustomFetch(null)
    }
  }
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)))
  } catch {
    return false
  }
})()

if (isMain) {
  runCli(async () => {
    const args = parseArgs(process.argv.slice(2))
    const cwd = args.get('cwd')
    const writeLifecycle = args.has('write-lifecycle')
    const res = await runYunxiaoLiveSmoke({ cwd, writeLifecycle })
    if (res.skipped) {
      info('跳过云效真机沙箱冒烟（未设置 YUNXIAO_LIVE_VERIFY=1）。')
      printJson(res)
      return
    }
    if (!res.ok) {
      printJson(res)
      throw new Error(res.error || '云效真机沙箱冒烟未通过')
    }
    printJson(res)
  })
}
