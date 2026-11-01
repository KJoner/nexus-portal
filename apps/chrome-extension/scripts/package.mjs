// Packs dist/ into nexus-portal-chrome-v<version>.zip, manifest.json at the root of the archive,
// so it can be dragged onto chrome://extensions or unpacked into a folder for 「加载已解压的扩展程序」.
// No dependencies: Node's zlib does deflate and CRC-32.
// Entries are sorted and dated 1980-01-01, so the same build gives a byte-identical archive.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const out = resolve(process.argv[2] ?? join(root, 'release'));

const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error(`manifest ${manifest.version} ≠ package.json ${pkg.version}`);
if (manifest.host_permissions) throw new Error('dist/ is a test build (host_permissions present): run `npm run build` first');

// Chrome keeps the connection, cache and granted site access under the extension ID, and without
// manifest.key that ID comes from the install path, which is random for a dropped ZIP. Losing or
// replacing the key turns the next update into a separate, unconnected extension.
const EXTENSION_ID = 'fofncjblmjaocmkmmkdnjdejkgjelcck';
const hash = createHash('sha256').update(Buffer.from(manifest.key ?? '', 'base64')).digest('hex');
const id = [...hash.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
if (id !== EXTENSION_ID) throw new Error(`manifest.json 的 key 对应扩展 ID ${id}，应为 ${EXTENSION_ID}：改动后所有已安装的扩展都要重新连接`);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(dist)
  .map((p) => ({ path: p, name: relative(dist, p).split('\\').join('/') }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));

const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const locals = [];
const central = [];
let offset = 0;
for (const f of files) {
  const data = readFileSync(f.path);
  const packed = deflateRawSync(data, { level: 9 });
  const stored = packed.length >= data.length;
  const body = stored ? data : packed;
  const name = Buffer.from(f.name, 'utf8');
  const crc = crc32(data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0x0800, 6); // UTF-8 names
  head.writeUInt16LE(stored ? 0 : 8, 8);
  head.writeUInt16LE(0, 10);
  head.writeUInt16LE(DOS_DATE, 12);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(body.length, 18);
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28);
  locals.push(head, name, body);
  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(20, 4);
  dir.writeUInt16LE(20, 6);
  dir.writeUInt16LE(0x0800, 8);
  dir.writeUInt16LE(stored ? 0 : 8, 10);
  dir.writeUInt16LE(0, 12);
  dir.writeUInt16LE(DOS_DATE, 14);
  dir.writeUInt32LE(crc, 16);
  dir.writeUInt32LE(body.length, 20);
  dir.writeUInt32LE(data.length, 24);
  dir.writeUInt16LE(name.length, 28);
  dir.writeUInt32LE(offset, 42);
  central.push(dir, name);
  offset += head.length + name.length + body.length;
}
const centralSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

const zip = join(out, `nexus-portal-chrome-v${pkg.version}.zip`);
mkdirSync(out, { recursive: true });
writeFileSync(zip, Buffer.concat([...locals, ...central, end]));
console.log(`${relative(process.cwd(), zip)} · ${files.length} 个文件 · ${(statSync(zip).size / 1024 / 1024).toFixed(2)} MB`);
