/**
 * 保存到哪里 (v0.5 · U2b): one wording for where a save goes, shared by the popup (both
 * collections), the context menu and its toolbar feedback — 「保存到：此扩展的本地收藏」 or
 * 「保存到：我的收藏（账号「…」）」 (UI v2: 我的收藏), never a vague 「已保存」 that leaves the place to guess.
 */
export const WHERE = {
  local: '此扩展的本地收藏',
  account: '账号里的「我的收藏」',
} as const;

/** The line under the popup's title: the real destination, with the account's name when known. */
export const saveTarget = (space: 'local' | 'account', accountLabel?: string | null) => (space === 'local' ? `保存到：${WHERE.local}` : accountLabel ? `保存到：我的收藏（账号「${accountLabel}」）` : `保存到：${WHERE.account}`);

/** What a finished save says (popup status and the toolbar button's title after a menu save). */
export const SAVED = {
  local: { saved: `已保存到${WHERE.local}`, updated: '已更新此扩展里的这条收藏', duplicate: `这个网址已在${WHERE.local}里`, undone: '已撤销，这条没有保存' },
  account: {
    saved: `已同步到${WHERE.account}`,
    pending: '已保存在此设备，联网后同步到账号',
    duplicate: `这个网址已在${WHERE.account}中`,
    draft: '已存为草稿：授权后再保存到账号',
  },
} as const;
