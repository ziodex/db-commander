import { describe, expect, it } from 'vitest'
import { splitOracleScript } from '../../src/shared/sql/oracle'
import { oracleConnectionOptions } from '../../src/driver/oracle'
import { oracleDateText } from '../../src/driver/oracle-values'
import { tablePreviewSql } from '../../src/shared/sql/common'
import { connectionSchema, legacyWorkspaceSchema as workspaceSchema } from '../../src/shared/contracts'

describe('Oracle scripts and profiles', () => {
  it('decodes TTC timestamps without losing nanoseconds, early years or offsets', () => {
    expect(oracleDateText(Buffer.from('64650101010101', 'hex'))).toBe('0001-01-01 00:00:00')
    expect(oracleDateText(Buffer.from('787e0a0c0d2339075bcd15', 'hex'))).toBe('2026-10-12 12:34:56.123456789')
    expect(oracleDateText(Buffer.from('787e0a0c080539075bcd15195a', 'hex'))).toBe('2026-10-12 12:34:56.123456789 +05:30')
    expect(oracleDateText(Buffer.from('787e0a0c0b2339075bcd158650', 'hex'))).toBe('2026-10-12 10:34:56.123456789 +00:00')
    expect(oracleDateText(Buffer.from('787e0101010101075bcd150f1e', 'hex'))).toBe('2025-12-31 18:30:00.123456789 -05:30')
    expect(oracleDateText(Buffer.from('787e0101010101075bcd15', 'hex'), true, { dbTzOffset: 330 })).toBe('2025-12-31 18:30:00.123456789 +00:00')
    expect(() => oracleDateText(Buffer.alloc(3))).toThrow('encoding')
    expect(() => oracleDateText(Buffer.from('787e0101010101', 'hex'), true, { dbTzRegion: 'Europe/Madrid' })).toThrow('TO_CHAR')
  })
  it('keeps PL/SQL blocks and stored units intact between slash lines', () => {
    const parts = splitOracleScript(`SELECT 1 FROM dual;
      DECLARE n NUMBER := 1; BEGIN IF n=1 THEN NULL; END IF; END;
      / -- block
      CREATE OR REPLACE EDITIONABLE PROCEDURE p AS BEGIN NULL; END;
      /
      SELECT 2 FROM dual;`)
    expect(parts).toHaveLength(4)
    expect(parts[1]).toContain('END IF; END;')
    expect(parts[2]).toContain('PROCEDURE p')
    expect(splitOracleScript('BEGIN NULL; END;')).toEqual(['BEGIN NULL; END;'])
  })
  it('handles q quotes, national strings, escaped quotes, identifiers and comments', () => {
    expect(splitOracleScript(`SELECT q'[it\'s; /]', nq'{it's;a;b}', q'!a;b!', 'it''s;', "a;b" FROM dual; /* ; */ SELECT 2 FROM dual; -- tail`)).toHaveLength(2)
    expect(splitOracleScript('BEGIN\n -- /\n NULL; /* / */ END;\n/')).toHaveLength(1)
    expect(splitOracleScript('; /* empty */ -- tail')).toEqual([])
  })
  it('never replays the last SQL statement when a slash follows a semicolon', () => {
    expect(splitOracleScript('INSERT INTO t VALUES(1);\n/\nSELECT 1/2 FROM dual;')).toHaveLength(2)
  })
  it('rejects malformed quotes, external binds and SQL*Plus commands before side effects', () => {
    for (const tail of ["SELECT q'[broken' FROM dual", "SELECT 'broken", '/* broken']) expect(() => splitOracleScript(`DELETE FROM t; ${tail}`)).toThrow('Unterminated')
    for (const tail of ['SELECT :id FROM dual', 'SELECT :"id" FROM dual', 'BEGIN :result := 1; END;']) expect(() => splitOracleScript(`DELETE FROM t; ${tail}`)).toThrow('Bind')
    for (const tail of ['SET DEFINE OFF', 'SPOOL output.csv', '@file.sql', '-- comment\n@file.sql', 'EXEC p', 'VARIABLE n NUMBER']) expect(() => splitOracleScript(`DELETE FROM t; ${tail}`)).toThrow('SQL*Plus')
    expect(splitOracleScript('SET TRANSACTION READ ONLY;')).toHaveLength(1)
    expect(splitOracleScript('CREATE TRIGGER t BEFORE INSERT ON test FOR EACH ROW BEGIN :NEW.n := 1; END;\n/')).toHaveLength(1)
  })
  it('quotes Oracle previews and validates credential-free service profiles', () => {
    expect(tablePreviewSql('Mixed', 'a"b', 'oracle')).toBe('SELECT *\nFROM "Mixed"."a""b"\nFETCH FIRST 1000 ROWS ONLY;')
    const profile = { engine: 'oracle', name: 'Oracle', host: 'localhost', port: 1521, database: 'FREEPDB1', user: 'dbcommander', tls: 'verify-full' }
    const config = connectionSchema.parse({ ...profile, password: 'secret' })
    expect(workspaceSchema.safeParse({ sql: '', profile }).success).toBe(true)
    expect(workspaceSchema.safeParse({ sql: '', profile: config }).success).toBe(false)
    expect(oracleConnectionOptions(config)).toMatchObject({ connectString: 'tcps://localhost:1521/FREEPDB1', retryCount: 0, sslServerDNMatch: true, sslAllowWeakDNMatch: false })
    expect(oracleConnectionOptions({ ...config, host: '::1', tls: 'disable' }).connectString).toBe('tcp://[::1]:1521/FREEPDB1')
    for (const database of ['FREEPDB1?ssl_server_dn_match=no', '(DESCRIPTION=...)', 'config-file:///tmp/a']) expect(() => oracleConnectionOptions({ ...config, database })).toThrow('service name')
    expect(() => oracleConnectionOptions({ ...config, ca: 'not supported' })).toThrow('NODE_EXTRA_CA_CERTS')
  })
})
