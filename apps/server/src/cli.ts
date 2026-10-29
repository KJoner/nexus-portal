import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { hashPassword } from './auth/password';
import { passwordFromCompose } from './auth/compose-env';
import { MIGRATIONS } from './db';

/**
 * Helpers for deploy.sh, run inside the image (`docker run --entrypoint node … server/cli.mjs`):
 *   hash-password            password on stdin → Argon2id PHC string on stdout
 *   hash-from-compose        `docker compose config --format json` on stdin → hash of NEXUS_PASSWORD
 *   db-backup <src> <dest>   consistent copy (VACUUM INTO) of a live database + compatibility report
 *   db-check <file>          compatibility report only
 *   login-from-compose <url> compose config on stdin → a real login (then logout) with its NEXUS_PASSWORD
 * Secrets only ever travel through stdin and stdout, never through arguments or logs.
 */
const EXIT = { ok: 0, usage: 1, input: 2, newer: 3, corrupt: 4, absent: 5, login: 6 } as const;

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function fail(code: number, message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** Version and integrity of a database file, compared with what this image can read. */
function report(file: string) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const dbVersion = db.pragma('user_version', { simple: true }) as number;
    const integrity = String(db.pragma('quick_check', { simple: true }));
    const configRow = db.prepare("select count(*) n from sqlite_master where name = 'config'").get() as { n: number };
    return { dbVersion, appVersion: MIGRATIONS.length, compatible: dbVersion <= MIGRATIONS.length, integrity, hasConfig: configRow.n > 0 };
  } finally {
    db.close();
  }
}

function finish(r: ReturnType<typeof report>): never {
  process.stdout.write(`${JSON.stringify(r)}\n`);
  if (r.integrity !== 'ok') process.exit(EXIT.corrupt);
  process.exit(r.compatible ? EXIT.ok : EXIT.newer);
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'hash-password': {
    const password = (await stdin()).replace(/\r?\n$/, '');
    if (password.trim().length < 8) fail(EXIT.input, '密码至少需要 8 个字符');
    process.stdout.write(`${await hashPassword(password.trim())}\n`);
    break;
  }
  case 'hash-from-compose': {
    let found: ReturnType<typeof passwordFromCompose>;
    try {
      found = passwordFromCompose(await stdin());
    } catch {
      fail(EXIT.input, '无法读取 docker compose config 的输出');
    }
    if (found.hasHash) fail(EXIT.absent, '已经是 NEXUS_PASSWORD_HASH');
    if (!found.plain) fail(EXIT.absent, '没有明文 NEXUS_PASSWORD');
    process.stdout.write(`${await hashPassword(found.plain)}
`);
    break;
  }
  case 'login-from-compose': {
    // After migrating a plain password to a hash: prove the password from the old configuration
    // still signs in to the running server, through the same HTTP path a browser uses.
    let found: ReturnType<typeof passwordFromCompose>;
    try {
      found = passwordFromCompose(await stdin());
    } catch {
      fail(EXIT.input, '无法读取 docker compose config 的输出');
    }
    if (!found.plain) fail(EXIT.absent, '配置中没有明文 NEXUS_PASSWORD');
    const base = (args[0] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
    const headers = { 'X-Nexus-Client': '1', 'content-type': 'application/json' };
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ password: found.plain }) }).catch(() => null);
    if (res?.status !== 200) fail(EXIT.login, `登录失败（${res ? `HTTP ${res.status}` : '无法连接'}）`);
    const cookie = res.headers.get('set-cookie')?.split(';')[0];
    if (cookie) await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { ...headers, cookie } }).catch(() => undefined);
    process.stdout.write('ok\n');
    break;
  }
  case 'db-backup': {
    const [src, dest] = args;
    if (!src || !dest) fail(EXIT.usage, '用法：db-backup <数据库> <备份文件>');
    if (!existsSync(src)) fail(EXIT.absent, `没有数据库：${src}`);
    const db = new Database(src, { fileMustExist: true });
    try {
      db.pragma('busy_timeout = 10000');
      // A consistent snapshot even while the server keeps writing (WAL); never a raw file copy.
      db.exec(`vacuum into '${dest.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
    finish(report(dest));
  }
  case 'db-check': {
    const [file] = args;
    if (!file) fail(EXIT.usage, '用法：db-check <数据库>');
    if (!existsSync(file)) fail(EXIT.absent, `没有数据库：${file}`);
    finish(report(file));
  }
  default:
    fail(EXIT.usage, '用法：cli.mjs hash-password | hash-from-compose | db-backup <src> <dest> | db-check <file>');
}
