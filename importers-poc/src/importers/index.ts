/**
 * 统一 importer 入口。
 * 业务侧只面对这个文件，不应直接引用 params.ts / six.ts / legacy-json.ts。
 */

import { convertParamsToBaileys } from './params.js'
import { convertSixToBaileys } from './six.js'
import { convertLegacyJsonToBaileys } from './legacy-json.js'
import type {
  ConvertOutput,
  ParamsLoginInput,
  SixLoginInput,
  LegacyJsonLoginInput
} from './types.js'

export type ImportFormat = 'params' | 'six' | 'legacy_json' | 'baileys_json'

export interface ImportRequest {
  format: ImportFormat
  body:
    | { format: 'params'; data: ParamsLoginInput }
    | { format: 'six'; data: SixLoginInput }
    | { format: 'legacy_json'; data: LegacyJsonLoginInput }
    | { format: 'baileys_json'; data: { creds: Record<string, unknown>; keys: Record<string, Record<string, unknown>> } }
}

export function importCredentials(req: ImportRequest): ConvertOutput {
  switch (req.format) {
    case 'params':
      if (req.body.format !== 'params') {
        return { result: 'UNSUPPORTED_FORMAT', warnings: ['format/body mismatch'] }
      }
      return convertParamsToBaileys(req.body.data)
    case 'six':
      if (req.body.format !== 'six') {
        return { result: 'UNSUPPORTED_FORMAT', warnings: ['format/body mismatch'] }
      }
      return convertSixToBaileys(req.body.data)
    case 'legacy_json':
      if (req.body.format !== 'legacy_json') {
        return { result: 'UNSUPPORTED_FORMAT', warnings: ['format/body mismatch'] }
      }
      return convertLegacyJsonToBaileys(req.body.data)
    case 'baileys_json':
      if (req.body.format !== 'baileys_json') {
        return { result: 'UNSUPPORTED_FORMAT', warnings: ['format/body mismatch'] }
      }
      // baileys_json 不做转换，直接透传
      return {
        result: 'CONVERTED_FULL',
        creds: req.body.data.creds,
        keys: req.body.data.keys,
        warnings: [],
        meta: { source: 'legacy_json', inputFieldsPresent: ['creds', 'keys'], inputFieldsMissing: [] }
      }
    default:
      return { result: 'UNSUPPORTED_FORMAT', warnings: [`unknown format: ${req.format}`] }
  }
}

export {
  convertParamsToBaileys,
  convertSixToBaileys,
  convertLegacyJsonToBaileys
}
export type {
  ConvertOutput,
  ParamsLoginInput,
  SixLoginInput,
  LegacyJsonLoginInput
}
