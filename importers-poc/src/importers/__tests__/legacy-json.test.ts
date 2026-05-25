import { describe, expect, it } from '@jest/globals'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertLegacyJsonToBaileys } from '../legacy-json.js'
import type { LegacyJsonLoginInput } from '../types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'legacy-json')

interface Fixture {
  name: string
  description: string
  input: LegacyJsonLoginInput
  expectedResult?: string
  expectedResultOneOf?: string[]
  expectedWarningsContain?: string
}

function loadFixtures(): Fixture[] {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf-8')) as Fixture)
}

describe('convertLegacyJsonToBaileys', () => {
  for (const fixture of loadFixtures()) {
    it(`[${fixture.name}] ${fixture.description}`, () => {
      const out = convertLegacyJsonToBaileys(fixture.input)
      if (fixture.expectedResult) {
        expect(out.result).toBe(fixture.expectedResult)
      } else if (fixture.expectedResultOneOf) {
        expect(fixture.expectedResultOneOf).toContain(out.result)
      }
      if (fixture.expectedWarningsContain) {
        expect(out.warnings.join(' ')).toContain(fixture.expectedWarningsContain)
      }
    })
  }

  it('returns NEED_REAUTH on empty input', () => {
    const out = convertLegacyJsonToBaileys({ accountJsonBase64: '' })
    expect(out.result).toBe('NEED_REAUTH')
  })

  it('normalizes snake_case to camelCase', () => {
    // 用 02 fixture 同款数据校验归一化
    const fixturePath = path.join(FIXTURE_DIR, '02-snake-case-partial.json')
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'))
    const out = convertLegacyJsonToBaileys(fixture.input)
    expect(out.creds?.noiseKey).toBeDefined()
    expect(out.creds?.signedIdentityKey).toBeDefined()
  })
})
