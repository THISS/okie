import { describe, expect, it } from 'vitest';
import { appliesRemoteMigrations } from '../scripts/deployCore.mjs';
import { csvField, deleteOutputUnreadableMessage, deleteSql, EXPORT_COLUMNS, exportSql, parseUsersArgs, sqlString, toCsv, wranglerRows } from '../scripts/usersCore.mjs';
import { edgeEnv } from './helpers';

describe('operator users scripts (CLA-316)', () => {
  it('parses export and delete arguments, refusing unknown environments and malformed ids/emails', () => {
    expect(parseUsersArgs(['export', 'production'])).toEqual({ command: 'export', env: 'production', optedIn: false });
    expect(parseUsersArgs(['export', 'staging', '--opted-in'])).toEqual({ command: 'export', env: 'staging', optedIn: true });
    expect(parseUsersArgs(['delete', 'production', '--github-id', '123'])).toEqual({ command: 'delete', env: 'production', githubId: 123 });
    expect(parseUsersArgs(['delete', 'production', '--github-id', '0'])).toEqual({ command: 'delete', env: 'production', githubId: 0 });
    expect(parseUsersArgs(['delete', 'staging', '--email', 'Some.One+x@example.co.uk'])).toEqual({ command: 'delete', env: 'staging', email: 'Some.One+x@example.co.uk' });
    for (const argv of [
      [], ['export'], ['export', 'local'], ['export', 'production', '--all'], ['drop', 'production'],
      ['delete', 'production'], ['delete', 'production', '--github-id'], ['delete', 'production', '--github-id', '1 OR 1=1'],
      ['delete', 'production', '--github-id', '-1'], ['delete', 'production', '--github-id', '1.5'], ['delete', 'production', '--github-id', '0x10'],
      ['delete', 'production', '--github-id', '99999999999999999999'],
      ['delete', 'production', '--email', "x'@example.com"], ['delete', 'production', '--email', 'a@b.com; DROP TABLE users'],
      ['delete', 'production', '--email', 'no-at-sign'], ['delete', 'production', '--email', 'a b@example.com'],
      ['delete', 'production', '--github-id', '1', '--email', 'a@example.com'],
    ]) {
      expect(parseUsersArgs(argv), argv.join(' ')).toHaveProperty('error');
    }
  });

  it('builds the SQL, which runs against the real schema', async () => {
    expect(exportSql(false)).toBe(`SELECT ${EXPORT_COLUMNS.join(', ')} FROM users ORDER BY github_id;`);
    expect(exportSql(true)).toContain('WHERE product_updates_opt_in = 1 AND email IS NOT NULL');
    expect(deleteSql({ githubId: 42 })).toBe('DELETE FROM users WHERE github_id = 42 RETURNING github_id;');
    expect(deleteSql({ email: 'A@Example.com' })).toBe("DELETE FROM users WHERE lower(email) = lower('A@Example.com') RETURNING github_id;");
    expect(() => deleteSql({ email: "x'--@example.com" })).toThrow();
    expect(() => deleteSql({ githubId: -1 })).toThrow();
    expect(sqlString("it's")).toBe("'it''s'");

    const db = edgeEnv.USERS_DB!;
    // Ids of this file's own (other test files share the database: never clear the table).
    await db.exec('DELETE FROM users WHERE github_id >= 900000');
    const insert = db.prepare("INSERT INTO users (github_id, github_login, email, email_verified, created_at, last_sign_in_at, privacy_version, product_updates_opt_in) VALUES (?1, ?2, ?3, 1, 't', 't', 'v', ?4)");
    await db.batch([insert.bind(900001, 'a', 'a@example.com', 1), insert.bind(900002, 'b', 'b@example.com', 0), insert.bind(900003, 'c', null, 1)]);
    const mine = (rows: Array<Record<string, unknown>>) => rows.map(row => row.github_id).filter(id => Number(id) >= 900000);
    expect(mine((await db.prepare(exportSql(true)).all()).results)).toEqual([900001]);
    expect(mine((await db.prepare(exportSql(false)).all()).results)).toEqual([900001, 900002, 900003]);
    expect((await db.prepare(deleteSql({ email: 'B@EXAMPLE.COM' })).all()).results).toEqual([{ github_id: 900002 }]);
    expect((await db.prepare(deleteSql({ githubId: 900003 })).all()).results).toEqual([{ github_id: 900003 }]);
    expect((await db.prepare(deleteSql({ githubId: 900003 })).all()).results).toEqual([]);
  });

  it('reads wrangler --json output and writes CSV (quoted, formula-safe, nulls empty)', () => {
    const stdout = JSON.stringify([{ results: [{ github_id: 1, github_login: 'a', email: null }], success: true, meta: { changes: 0 } }]);
    expect(wranglerRows(stdout)).toEqual([{ github_id: 1, github_login: 'a', email: null }]);
    expect(wranglerRows(`some banner\n${stdout}`)).toHaveLength(1);
    expect(() => wranglerRows(JSON.stringify([{ success: false, results: [] }]))).toThrow();
    expect(() => wranglerRows('no json')).toThrow();
    expect(csvField(null)).toBe('');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField('+1')).toBe("'+1");
    expect(toCsv([{ github_id: 1, github_login: 'a', email: 'a@example.com' }], ['github_id', 'github_login', 'email', 'missing'])).toBe('github_id,github_login,email,missing\r\n1,a,a@example.com,\r\n');
    expect(toCsv([]).split('\r\n')[0]).toBe(EXPORT_COLUMNS.join(','));
  });

  it('shows wrangler\'s raw output when a DELETE\'s result cannot be read, warning rows may be gone', () => {
    const message = deleteOutputUnreadableMessage('▲ [WARNING] something odd\n{"partial":');
    expect(message).toMatch(/^the DELETE may still have run: rows may have been deleted/);
    expect(message).toContain('▲ [WARNING] something odd\n{"partial":');
  });

  it('deploy.mjs applies remote migrations except on --dry-run', () => {
    expect(appliesRemoteMigrations([])).toBe(true);
    expect(appliesRemoteMigrations(['--minify'])).toBe(true);
    expect(appliesRemoteMigrations(['--dry-run', '--outdir', 'x'])).toBe(false);
  });
});
