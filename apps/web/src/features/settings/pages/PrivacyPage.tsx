import { useConfig, useConfigStore } from '../../../data/config-store';
import { patch } from '../model';
import { Group, PageHeader, Row, Switch } from '../ui';

/**
 * 隐私与展示 (v0.5 · U2b, 01-UX-PLAN §3.1): what the home shows to others and what this browser
 * keeps about use. Moved out of 数据与备份 — the switches and what they do are unchanged.
 */
export function PrivacyPage() {
  const config = useConfig();
  const local = useConfigStore((s) => s.space) === 'local';
  const pr = config.settings.privacy;
  return (
    <div className="flex max-w-[880px] flex-col gap-7">
      <PageHeader title="隐私与展示" sub="投屏或借给别人用时首页显示什么，以及这台浏览器记下哪些使用痕迹。改动即时保存。" />
      <Group title="投屏与借用">
        <Row label="投屏隐私" sub="隐藏服务状态、最近使用与搜索历史，适合投屏或借给他人使用（不是账号或数据模式；收藏照常保存）">
          <Switch label="投屏隐私" checked={pr.guest} onChange={(v) => patch('privacy', { guest: v })} />
        </Row>
      </Group>
      <Group title="使用记录与图标">
        <Row label="记录最近使用" sub="用于搜索框的「最近」；只保存在本浏览器">
          <Switch label="记录最近使用" checked={pr.recordRecent} onChange={(v) => patch('privacy', { recordRecent: v })} />
        </Row>
        {local ? (
          <Row label="网站图标" sub="本地收藏的图标直接从公共图标库和网站图标服务加载；登录并开启同步后，可改由 Nexus 服务端缓存" />
        ) : (
          <Row label="服务端缓存图标" sub="由 Nexus 服务端获取并缓存品牌图标，浏览器不再直接请求第三方图标服务；图标源故障时继续使用缓存">
            <Switch label="服务端缓存图标" checked={pr.cacheIcons} onChange={(v) => patch('privacy', { cacheIcons: v })} />
          </Row>
        )}
      </Group>
    </div>
  );
}
