#!/usr/bin/env node
// 应用目录联网核验（运营者手动运行，CI 不运行）：
//   1. 用 dashboard-icons / simple-icons 的公开索引核对每个 icon_ref 是否存在；
//   2. 逐个打开条目网址（GET，跟随跳转，12 秒超时），把结果写回 catalog.json 的 verification：
//      reachable = 最终状态 2xx/3xx；unreachable = 其他状态或网络失败（含被反爬拦截，note 里写原因）。
// 不读取、不发送任何用户数据；由部署配置提供地址的条目（url_from_env）不核验。
// 用法：npm run catalog:verify [-- --icons-only]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = join(import.meta.dirname, '..', 'packages', 'shared', 'src', 'catalog', 'catalog.json');
const iconsOnly = process.argv.includes('--icons-only');
const doc = JSON.parse(readFileSync(FILE, 'utf8'));

async function json(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

const [tree, si] = await Promise.all([
  json('https://raw.githubusercontent.com/homarr-labs/dashboard-icons/main/tree.json'),
  json('https://cdn.jsdelivr.net/npm/simple-icons@latest/data/simple-icons.json'),
]);
const di = new Set((tree.svg ?? []).map((n) => n.replace(/\.svg$/, '')));
const sis = new Set(si.map((x) => x.slug));
const missing = doc.entries.filter((e) => (e.icon_ref.startsWith('di:') && !di.has(e.icon_ref.slice(3))) || (e.icon_ref.startsWith('si:') && !sis.has(e.icon_ref.slice(3))));
console.log(`图标：dashboard-icons ${di.size} 个，simple-icons ${sis.size} 个；缺失 ${missing.length} 个`);
for (const e of missing) console.log(`  ✗ ${e.stable_id}: ${e.icon_ref}`);

if (!iconsOnly) {
  const today = new Date().toISOString();
  const queue = doc.entries.filter((e) => !e.url_from_env);
  let reachable = 0;
  const work = async () => {
    for (;;) {
      const e = queue.shift();
      if (!e) return;
      try {
        const res = await fetch(e.url, { redirect: 'follow', signal: AbortSignal.timeout(12_000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; NexusCatalogCheck/1.0)', accept: 'text/html,*/*' } });
        await res.body?.cancel();
        const ok = res.status < 400;
        if (ok) reachable++;
        e.verification = { status: ok ? 'reachable' : 'unreachable', checked_at: today, http_status: res.status, ...(ok ? {} : { note: res.status === 403 || res.status === 429 ? '可能被反爬策略拦截，浏览器中可正常打开时请人工确认' : '网址返回错误状态' }) };
      } catch (err) {
        e.verification = { status: 'unreachable', checked_at: today, note: `网络请求失败：${err?.cause?.code ?? err?.name ?? 'error'}` };
      }
      console.log(`  ${e.verification.status === 'reachable' ? '✓' : '✗'} ${e.stable_id} ${e.verification.http_status ?? ''} ${e.verification.note ?? ''}`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, work));
  writeFileSync(FILE, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`网址：${reachable}/${doc.entries.filter((e) => !e.url_from_env).length} 可访问；结果已写回 ${FILE}`);
}
process.exit(missing.length ? 1 : 0);
