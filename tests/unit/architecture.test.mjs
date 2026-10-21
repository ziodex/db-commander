import { ESLint } from 'eslint'
import { expect, it } from 'vitest'

const lint = new ESLint()
for (const [filePath, source] of [
  ['src/renderer/boundary-fixture.ts', "import fs from 'node:fs'"],
  ['src/renderer/boundary-fixture.ts', "import { DriverRegistry } from '../driver/registry'"],
  ['src/renderer/boundary-fixture.ts', "import pg from 'pg'"],
  ['src/shared/boundary-fixture.ts', "import { lexSql } from '../language/completion'"],
  ['src/driver/boundary-fixture.ts', "import { app } from 'electron'"],
  ['src/preload/boundary-fixture.ts', "import { DriverRegistry } from '../driver/registry'"]
]) it(`rejects the runtime boundary violation ${filePath}: ${source}`, async () => {
  const [result] = await lint.lintText(source, { filePath })
  expect(result.messages.some(message => message.ruleId === 'no-restricted-imports')).toBe(true)
})

it('allows shared contracts and pure dialect helpers without mistaking filenames for runtime layers', async () => {
  const [result] = await lint.lintText("import type { CatalogObject } from '../shared/catalog'; import { quoteIdentifier } from '../shared/sql/common'", { filePath: 'src/renderer/boundary-fixture.ts' })
  expect(result.messages).toEqual([])
})

it('checks hook ordering and stale effect dependencies', async () => {
  const [result] = await lint.lintText(`
    import { useEffect } from 'react'
    function Fixture({ enabled, value }) {
      if (enabled) useEffect(() => { console.log(value) }, [])
      return null
    }
  `, { filePath: 'src/renderer/hooks-fixture.tsx' })
  expect(result.messages.map(message => message.ruleId)).toEqual(expect.arrayContaining(['react-hooks/rules-of-hooks', 'react-hooks/exhaustive-deps']))
})
