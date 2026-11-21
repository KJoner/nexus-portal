// Packs dist/ into nexus-portal-chrome-v<version>.zip, manifest.json at the root of the archive,
// so it can be dragged onto chrome://extensions or unpacked into a folder for 「加载已解压的扩展程序」.
// Also nexus-portal-edge-v<version>.zip: the same build for Microsoft Edge (需求 §9.2: packaged and
// verified on its own), without manifest.key, which the Edge Add-ons store assigns itself.
// No dependencies: Node's zlib does deflate and CRC-32.
// Entries are sorted and dated 1980-01-01, so the same build gives a byte-identical archive.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
// --firefox packs dist-firefox (built with NEXUS_EXT_TARGET=firefox) into the Firefox zip instead.
const firefox = process.argv.includes('--firefox');
const dist = join(root, firefox ? 'dist-firefox' : 'dist');
const out = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(root, 'release'));

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
if (!firefox && id !== EXTENSION_ID) throw new Error(`manifest.json 的 key 对应扩展 ID ${id}，应为 ${EXTENSION_ID}：改动后所有已安装的扩展都要重新连接`);

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

// Permissions are checked before anything ships (需求 §9.1: activeTab, contextMenus, storage and
// the one server origin the person grants when connecting; never history, bookmarks or all sites).
const ALLOWED = new Set(['storage', 'activeTab', 'contextMenus']);
const extra = (manifest.permissions ?? []).filter((p) => !ALLOWED.has(p));
if (extra.length) throw new Error(`manifest 申请了不在清单内的权限：${extra.join(', ')}`);

function pack(target, contentOf) {
const locals = [];
const central = [];
let offset = 0;
for (const f of files) {
  const data = contentOf(f);
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

const zip = join(out, `nexus-portal-${target}-v${pkg.version}.zip`);
mkdirSync(out, { recursive: true });
writeFileSync(zip, Buffer.concat([...locals, ...central, end]));
console.log(`${relative(process.cwd(), zip)} · ${files.length} 个文件 · ${(statSync(zip).size / 1024 / 1024).toFixed(2)} MB`);
}

if (firefox) {
  if (!manifest.browser_specific_settings?.gecko?.id) throw new Error('dist-firefox 不是 Firefox 构建（缺少 browser_specific_settings.gecko.id）');
  pack('firefox', (f) => readFileSync(f.path));
  process.exit(0);
}
pack('chrome', (f) => readFileSync(f.path));
// Edge: the same build; the Add-ons store assigns the ID itself, so manifest.key stays out.
const { key: _key, ...edgeManifest } = manifest;
pack('edge', (f) => (f.name === 'manifest.json' ? Buffer.from(`${JSON.stringify(edgeManifest, null, 2)}\n`) : readFileSync(f.path)));
