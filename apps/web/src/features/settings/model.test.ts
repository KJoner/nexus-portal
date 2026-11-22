import { describe, expect, it } from 'vitest';
import { returnedWithout } from '../auth/LoginPage';
import { GROUPS, groupOf, isPage, searchIndex, whereIs } from './model';

// UI v2（v12.0.3，spec 01 §3、06 A06/A08）：设置六组，「我的收藏」取代「网站与服务」；旧的菜单名仍能找到新位置。
describe('设置的六组', () => {
  it('首页与外观 / 搜索 / 我的收藏 / 账号与同步 / 数据与备份 / 隐私与展示；首页与外观一组三页，地址不变', () => {
    expect(GROUPS.filter((g) => !g.manage).map((g) => g.label)).toEqual(['首页与外观', '搜索', '我的收藏', '账号与同步', '数据与备份', '隐私与展示']);
    expect(GROUPS.filter((g) => g.manage)).toEqual([]);
    expect(groupOf('appearance').pages).toEqual(['appearance', 'display', 'home']);
    for (const old of ['appearance', 'display', 'home', 'favorites', 'data']) expect(isPage(old)).toBe(true);
    // 网站与服务 (/settings/apps) is no page any more: the settings page sends it to /settings/favorites.
    expect(isPage('apps')).toBe(false);
    expect(whereIs('home')).toBe('首页与外观 › 快捷方式');
    expect(whereIs('privacy')).toBe('隐私与展示');
  });

  it('旧菜单名搜得到新位置', () => {
    const first = (q: string) => searchIndex(q)[0]?.page;
    expect(first('外观与个性化')).toBe('appearance');
    expect(first('首页显示与布局')).toBe('display');
    expect(first('首页与快捷方式')).toBe('home');
    expect(first('访客模式')).toBe('privacy');
    expect(searchIndex('数据、同步与安全').map((h) => h.page)).toContain('account');
    // spec copy.json legacyAliases: 收藏库 / 网站与服务 / 应用目录 / 管理分类 → 我的收藏
    for (const q of ['收藏库', '网站与服务', '应用目录', '分类管理']) expect(first(q)).toBe('favorites');
  });
});

describe('登录没有完成时的说明', () => {
  it('说出账号中心给的具体原因，并说明本地收藏没动', () => {
    expect(returnedWithout('invite_invalid')).toBe('邀请码无效、已过期或已经用过。此浏览器的收藏没有任何改动，可以再试一次。');
    expect(returnedWithout('access_denied')).toBe('已取消登录。此浏览器的收藏没有任何改动，可以继续只在此浏览器使用。');
    expect(returnedWithout(null)).toBe('没有完成登录。此浏览器的收藏没有任何改动，可以再试一次。');
  });
});
