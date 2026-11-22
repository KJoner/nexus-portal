import { itemUrlKey } from '@nexus/shared';
import { describe, expect, it } from 'vitest';
import { isBackupFile, parseBookmarksHtml, previewImport, readBackup, toInputs } from './import-files';

/** EX-05 · 书签 HTML / 产品 JSON 导入预览：深层链接与分类保留，不支持的地址不导入。 */
const BOOKMARKS = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
  <DT><H3 ADD_DATE="1700000000" PERSONAL_TOOLBAR_FOLDER="true">书签栏</H3>
  <DL><p>
    <DT><A HREF="https://github.com/" ADD_DATE="1700000001">GitHub</A>
    <DT><H3>工作</H3>
    <DL><p>
      <DT><A HREF="https://docs.example.org/guide?id=7#install">安装指南</A>
      <DT><H3>周报</H3>
      <DL><p>
        <DT><A HREF="https://wiki.example.org/weekly/2026-47">第 47 周</A>
      </DL><p>
    </DL><p>
    <DT><A HREF="javascript:alert(1)">书签小工具</A>
    <DT><A HREF="place:sort=8">最近访问</A>
    <DT><A HREF="https://github.com/">GitHub（重复）</A>
  </DL><p>
</DL><p>`;

describe('bookmark import (EX-05)', () => {
  it('keeps full deep links and the folder path; drops what cannot be a bookmark here', () => {
    const { items, unsupported } = parseBookmarksHtml(BOOKMARKS);
    expect(unsupported).toBe(2);
    expect(items.map((i) => i.url)).toEqual(['https://github.com/', 'https://docs.example.org/guide?id=7#install', 'https://wiki.example.org/weekly/2026-47', 'https://github.com/']);
    expect(items[1]).toMatchObject({ title: '安装指南', path: ['工作'], tags: ['工作'] });
    // The browser's own root folder says nothing: not a tag.
    expect(items[0]!.path).toEqual([]);
    expect(items[2]).toMatchObject({ path: ['工作', '周报'], tags: ['工作', '周报'] });
  });

  it('the preview counts what is already saved and what repeats in the file', () => {
    const p = previewImport('bookmarks.html', BOOKMARKS, new Set([itemUrlKey('https://docs.example.org/guide?id=7#install')]));
    expect(p).toMatchObject({ format: 'bookmarks-html', existing: 1, repeated: 1, unsupported: 2, folders: ['工作', '周报'] });
    expect(toInputs(p.items, false).every((i) => i.tags?.length === 0)).toBe(true);
  });

  it('reads Nexus’s own export, and refuses other JSON', () => {
    const json = JSON.stringify({ format: 'nexus-collection', version: 1, items: [{ title: '文章', url: 'https://a.example.org/x?y=1#z', tags: ['读'], note: '备注', folderId: 'work' }, { title: '坏的', url: 'data:text/html,x' }] });
    const p = previewImport('nexus-collection-2026-11-21.json', json, new Set());
    expect(p.items).toEqual([{ title: '文章', url: 'https://a.example.org/x?y=1#z', path: [], tags: ['读'], note: '备注', folderId: 'work', kind: 'page' }]);
    expect(p.unsupported).toBe(1);
    expect(() => previewImport('x.json', '{"apps":[]}', new Set())).toThrow('不是 Nexus 导出的收藏文件');
  });
});

/** NEX-06：产品 JSON 是「恢复」而不是「导入网页」；客户端先做能做的检查。 */
describe('Nexus backups (NEX-06)', () => {
  const backup = { format: 'nexus-collection', version: 2, folders: [{ id: 'work-folder', label: 'Work' }], pins: ['exported-app'], items: [{ id: 'exported-app', kind: 'app', title: 'Original app', url: 'https://audit.example.org/export', folderId: 'work-folder', tags: ['keep'], note: 'keep', catalogId: 'github', pinned: true }] };

  it('is told apart from a bookmark file, read as it is, and a newer format is refused with a reason', () => {
    expect(isBackupFile('nexus-collection-2026-11-21.json', '')).toBe(true);
    expect(isBackupFile('bookmarks.html', '<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe(false);
    expect(readBackup(JSON.stringify(backup))).toMatchObject({ version: 2, items: 1, file: backup });
    // UI v2 (N2): version 3 is this release's (the group tree); 4 is newer.
    expect(readBackup(JSON.stringify({ ...backup, version: 3 }))).toMatchObject({ version: 3 });
    expect(() => readBackup(JSON.stringify({ ...backup, version: 4 }))).toThrow('更新版本');
    expect(() => readBackup('{"format":"nexus-config"}')).toThrow('不是 Nexus 导出的收藏文件');
    expect(() => readBackup('{')).toThrow('不是有效的 JSON');
  });

  it('the old import path no longer flattens kind and catalog link (审查反例: kind app → page, catalogId → null)', () => {
    const p = previewImport('x.json', JSON.stringify(backup), new Set());
    expect(toInputs(p.items, true)).toEqual([{ kind: 'app', title: 'Original app', url: 'https://audit.example.org/export', tags: ['keep'], note: 'keep', folderId: 'work-folder', catalogId: 'github' }]);
  });

  it('the preview counts what is already saved by canonical address (host case, default port)', () => {
    const p = previewImport('x.json', JSON.stringify(backup), new Set([itemUrlKey('HTTPS://AUDIT.example.org:443/export')]));
    expect(p.existing).toBe(1);
  });
});
