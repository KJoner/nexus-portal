/**
 * Build-time check of the public 应用目录 (`npm run catalog:check`; the server build runs it too).
 * Lists every problem at once and fails without starting anything.
 */
import raw from '@nexus/shared/catalog.json';
import { validateCatalog } from '@nexus/shared';

const { errors, doc } = validateCatalog(raw);
if (!doc) throw new Error(`应用目录校验失败（${errors.length} 项）：\n- ${errors.join('\n- ')}`);
console.log(`[catalog] 校验通过：${doc.entries.length} 个条目 · ${doc.categories.length} 个分类 · 目录版本 ${doc.catalogVersion}`);
