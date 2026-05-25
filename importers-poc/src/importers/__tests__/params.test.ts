import { describe, expect, it } from '@jest/globals'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertParamsToBaileys } from '../params.js'
import type { ParamsLoginInput } from '../types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'params')

interface Fixture {
  name: string
  description: string
  input: ParamsLoginInput
  expectedResult: string
  expectedCredsKeys?: string[]
  expectedPlatform?: string
  expectedMissing?: string[]
}

function loadFixtures(): Fixture[] {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf-8')) as Fixture)
}

describe('convertParamsToBaileys', () => {
  for (const fixture of loadFixtures()) {
    it(`[${fixture.name}] ${fixture.description}`, () => {
      const out = convertParamsToBaileys(fixture.input)
      expect(out.result).toBe(fixture.expectedResult)

      if (fixture.expectedCredsKeys && out.creds) {
        for (const k of fixture.expectedCredsKeys) {
          expect(Object.keys(out.creds)).toContain(k)
        }
      }
      if (fixture.expectedPlatform && out.creds) {
        expect(out.creds.platform).toBe(fixture.expectedPlatform)
      }
      if (fixture.expectedMissing) {
        for (const m of fixture.expectedMissing) {
          expect(out.meta?.inputFieldsMissing ?? []).toContain(m)
        }
      }
    })
  }

  it('returns NEED_REAUTH when wid missing', () => {
    const input = { ...{} } as ParamsLoginInput
    const out = convertParamsToBaileys(input)
    expect(out.result).toBe('NEED_REAUTH')
  })
})
