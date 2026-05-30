/**
 * Baileys AuthenticationState 适配器。
 *
 * 把 CredsStore + KeysStore 包装成 Baileys 期望的 `AuthenticationState` 接口，
 * 直接传给 `makeWASocket({ auth })`。
 *
 * Baileys `AuthenticationCreds` 字段：noiseKey / signedIdentityKey / signedPreKey /
 *   registrationId / advSecretKey / me / account / signalIdentities / ...
 * Baileys `keys.get(type, ids)` / `keys.set(data)` 接口
 */

import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataSet,
  SignalDataTypeMap
} from 'baileys'

import type { CredsStore } from './creds-store.js'
import type { KeysStore, KeyType } from './keys-store.js'
import type { Logger } from '../observability/logger.js'
import { reviveJsonBuffers } from '../utils/buffer-json.js'

const KEY_TYPES: KeyType[] = [
  'pre-key',
  'session',
  'sender-key',
  'sender-key-memory',
  'app-state-sync-key',
  'app-state-sync-version'
]

export async function buildAuthState(
  accountId: string,
  credsStore: CredsStore,
  keysStore: KeysStore,
  logger: Logger,
  initial?: { creds?: Partial<AuthenticationCreds>; keys?: SignalDataSet }
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  // 初始化 creds：优先 initial > store > 全新
  let creds = reviveJsonBuffers((await credsStore.load(accountId)) as AuthenticationCreds | null)

  if (initial?.creds) {
    creds = reviveJsonBuffers({ ...(creds ?? {}), ...initial.creds } as AuthenticationCreds)
    await credsStore.save(accountId, creds as Record<string, unknown>)
  }

  if (!creds) {
    // 全新账号：交给 Baileys initAuthCreds() 初始化（上层处理）
    logger.info({ accountId }, 'no existing creds, expecting fresh init')
    // 这里返回空对象，Baileys 会自己调 initAuthCreds()
    creds = {} as AuthenticationCreds
  }

  // 如果 initial 带 keys，预热到 store
  if (initial?.keys) {
    for (const [type, idMap] of Object.entries(initial.keys) as Array<[
      KeyType,
      Record<string, SignalDataTypeMap[KeyType]> | undefined
    ]>) {
      if (!idMap) continue
      const entries = Object.entries(idMap)
        .filter(([, v]) => v != null)
        .map(([id, v]) => ({ type, id, value: v as Record<string, unknown> }))
      if (entries.length > 0) await keysStore.setMany(accountId, entries)
    }
  }

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[]
      ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
        const map = await keysStore.getMany(accountId, type as KeyType, ids)
        const result: { [id: string]: SignalDataTypeMap[T] } = {}
        for (const [id, v] of Object.entries(map)) {
          if (v != null) result[id] = reviveJsonBuffers(v) as SignalDataTypeMap[T]
        }
        return result
      },
      set: async (data: SignalDataSet): Promise<void> => {
        const entries: Array<{ type: KeyType; id: string; value: Record<string, unknown> }> = []
        for (const [type, idMap] of Object.entries(data) as Array<[
          KeyType,
          Record<string, SignalDataTypeMap[KeyType] | null> | undefined
        ]>) {
          if (!idMap) continue
          for (const [id, value] of Object.entries(idMap)) {
            if (value == null) {
              await keysStore.delete(accountId, type, id)
            } else {
              entries.push({ type, id, value: value as Record<string, unknown> })
            }
          }
        }
        if (entries.length > 0) await keysStore.setMany(accountId, entries)
      },
      clear: async (): Promise<void> => {
        await keysStore.clear(accountId)
      }
    }
  }

  const saveCreds = async (): Promise<void> => {
    await credsStore.save(accountId, state.creds as Record<string, unknown>)
  }

  return { state, saveCreds }
}

export { KEY_TYPES }
