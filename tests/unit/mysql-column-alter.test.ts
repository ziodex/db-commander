import { describe, expect, it } from 'vitest'
import type { ObjectDetail } from '../../src/shared/catalog'
import { mysqlModifiedColumn } from '../../src/schema/mysql-column'

const object = { schema: 'db', name: 't', kind: 'table' as const, identity: 't' }
const definition = (sql: string): ObjectDetail => ({ object, source: 'catalog-connection', fetchedAt: '', sections: [], definition: { sql, source: 'native' } })
describe('MySQL native column alteration', () => {
  const ddl = definition("CREATE TABLE `t` (\n  `odd``name` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT 'a,b' COMMENT 'NOT NULL; z',\n  `other` int NOT NULL,\n  CHECK ((`other` > 0))\n) ENGINE=InnoDB")
  it('retains collation, default and comments while changing type or nullability', () => {
    expect(mysqlModifiedColumn(ddl, 'odd`name', 'varchar(20)', { kind: 'type', sql: 'VARCHAR(40)' }, true).sql).toBe("`odd``name` VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT 'a,b' COMMENT 'NOT NULL; z'")
    expect(mysqlModifiedColumn(ddl, 'odd`name', 'varchar(20)', { kind: 'nullability', nullable: false }, true).sql).toBe("`odd``name` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'a,b' COMMENT 'NOT NULL; z'")
    expect(mysqlModifiedColumn(ddl, 'other', 'int', { kind: 'nullability', nullable: true }, false).sql).toBe('`other` int NULL')
  })
  it('refuses ambiguous metadata or definitions depending on string escape mode', () => {
    expect(() => mysqlModifiedColumn(ddl, 'other', 'bigint', { kind: 'type', sql: 'BIGINT' }, false)).toThrow(/does not match/)
    expect(() => mysqlModifiedColumn(ddl, 'missing', 'int', { kind: 'type', sql: 'BIGINT' }, false)).toThrow(/missing or ambiguous/)
    expect(() => mysqlModifiedColumn({ ...ddl, definition: { ...ddl.definition, truncated: true } }, 'other', 'int', { kind: 'type', sql: 'BIGINT' }, false)).toThrow(/complete native/)
    const versioned = definition('CREATE TABLE `t` (`c` int /*!80023 INVISIBLE */)')
    expect(() => mysqlModifiedColumn(versioned, 'c', 'int', { kind: 'type', sql: 'BIGINT' }, true)).toThrow(/executable version comments/)
    const modeDependent = definition("CREATE TABLE `t` (`c` varchar(20) DEFAULT 'a\\b')")
    expect(() => mysqlModifiedColumn(modeDependent, 'c', 'varchar(20)', { kind: 'type', sql: 'TEXT' }, true)).toThrow(/SQL mode/)
    const ambiguous = definition("CREATE TABLE `t` (`c` varchar(20) DEFAULT 'a\\'b')")
    expect(() => mysqlModifiedColumn(ambiguous, 'c', 'varchar(20)', { kind: 'type', sql: 'TEXT' }, true)).toThrow()
  })
  it('replaces only the generated expression and preserves native attributes', () => {
    const generated = definition("CREATE TABLE `t` (`v` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin GENERATED ALWAYS AS ((concat(`a`, ',)'))) STORED COMMENT 'keep; AS (x)', `a` int)")
    expect(mysqlModifiedColumn(generated, 'v', 'varchar(30)', { kind: 'expression', sql: 'concat(`a`, 2)', storage: 'stored' }, true).sql).toBe("`v` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin GENERATED ALWAYS AS (concat(`a`, 2)) STORED COMMENT 'keep; AS (x)'")
    expect(() => mysqlModifiedColumn(generated, 'v', 'varchar(30)', { kind: 'expression', sql: '2', storage: 'virtual' }, true)).toThrow(/ambiguous/)
    expect(() => mysqlModifiedColumn(ddl, 'other', 'int', { kind: 'expression', sql: '2', storage: 'stored' }, false)).toThrow(/incomplete or ambiguous/)
    const executable = definition('CREATE TABLE `t` (`v` int GENERATED ALWAYS AS (1) VIRTUAL /*!80000 INVISIBLE */)')
    expect(() => mysqlModifiedColumn(executable, 'v', 'int', { kind: 'expression', sql: '2', storage: 'virtual' }, true)).toThrow(/executable version comments/)
  })
  it('adds or removes AUTO_INCREMENT without discarding native attributes', () => {
    const before = definition("CREATE TABLE `t` (`id` int unsigned NOT NULL COMMENT 'keep', PRIMARY KEY (`id`))")
    const added = mysqlModifiedColumn(before, 'id', 'int unsigned', { kind: 'identity', enabled: true }, false).sql
    expect(added).toBe("`id` int unsigned NOT NULL AUTO_INCREMENT COMMENT 'keep'")
    const after = definition(`CREATE TABLE \`t\` (${added}, PRIMARY KEY (\`id\`))`)
    expect(mysqlModifiedColumn(after, 'id', 'int unsigned', { kind: 'identity', enabled: false }, false).sql).toBe("`id` int unsigned NOT NULL COMMENT 'keep'")
    expect(() => mysqlModifiedColumn(before, 'id', 'int unsigned', { kind: 'identity', enabled: true }, true)).toThrow(/NOT NULL/)
    expect(() => mysqlModifiedColumn(definition('CREATE TABLE `t` (`id` int NOT NULL DEFAULT 5)'), 'id', 'int', { kind: 'identity', enabled: true }, false)).toThrow(/no default/)
    expect(() => mysqlModifiedColumn(before, 'id', 'int unsigned', { kind: 'identity', enabled: false }, false)).toThrow(/missing or ambiguous/)
    expect(() => mysqlModifiedColumn(definition('CREATE TABLE `t` (`id` int GENERATED ALWAYS AS (1) STORED NOT NULL)'), 'id', 'int', { kind: 'identity', enabled: true }, false)).toThrow(/generated or ambiguous/)
  })
})
