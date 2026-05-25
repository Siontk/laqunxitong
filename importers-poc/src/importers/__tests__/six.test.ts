import { describe, expect, it } from '@jest/globals'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertSixToBaileys } from '../six.js'
import type { SixLoginInput } from '../types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'six')

interface Fixture {
  name: string
  description: string
  input: SixLoginInput
  expectedResult: string
  expectedPlatform?: string
  expectedWarningsContain?: string
  expectedMissing?: string[]
}

function loadFixtures(): Fixture[] {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf-8')) as Fixture)
}

describe('convertSixToBaileys', () => {
  for (const fixture of loadFixtures()) {
    it(`[${fixture.name}] ${fixture.description}`, () => {
      const out = convertSixToBaileys(fixture.input)
      expect(out.result).toBe(fixture.expectedResult)

      if (fixture.expectedPlatform && out.creds) {
        expect(out.creds.platform).toBe(fixture.expectedPlatform)
      }
      if (fixture.expectedWarningsContain) {
        expect(out.warnings.join(' ')).toContain(fixture.expectedWarningsContain)
      }
      if (fixture.expectedMissing) {
        for (const m of fixture.expectedMissing) {
          expect(out.meta?.inputFieldsMissing ?? []).toContain(m)
        }
      }
    })
  }

  it('returns NEED_REAUTH when wid missing', () => {
    const input = {} as SixLoginInput
    const out = convertSixToBaileys(input)
    expect(out.result).toBe('NEED_REAUTH')
  })
})
