import { ConfigSchema, defaultConfig, normalizeConfig, type Config } from '@nexus/shared';
import { Cloud, CloudOff, Download, LogOut, Upload } from 'lucide-react';
import { useState } from 'react';
import { toast } from '../../../components/toast-store';
import { logout, useConfig, useConfigStore, useSaveState } from '../../../data/config-store';
import { formatHm } from '../../../lib/time';
import { apply, patch } from '../model';
import { Button, Dialog, Group, PageHeader, Row, Switch, useCompact } from '../ui';
import { DevicesSection } from './DevicesSection';

const FORMAT = 'nexus-config';

function counts(c: Config) {
  return [
    { n: c.apps.filter((a) => a.kind === 'site').length, label: '网站' },
    { n: c.apps.filter((a) => a.kind === 'service').length, label: '自托管服务' },
    { n: c.categories.length, label: '分类' },
    { n: c.engines.length, label: '搜索引擎' },
  ];
}

/** Accepts our own export wrapper or a bare config; anything else is rejected with a reason. */
function parseImport(text: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('文件不是有效的 JSON');
  }
  const body = raw && typeof raw === 'object' && 'config' in raw && (raw as { format?: string }).format === FORMAT ? (raw as { config: unknown }).config : raw;
  const r = ConfigSchema.safeParse(body);
  if (!r.success) throw new Error('不是有效的 Nexus 配置文件');
  return normalizeConfig(r.data);
}

type Reset = 'look' | 'home' | 'all';

export function DataPage() {
  const config = useConfig();
  const compact = useCompact();
  const save = useSaveState();
  const revision = useConfigStore((s) => s.confirmed?.revision ?? 0);
  const [importing, setImporting] = useState<{ name: string; config: Config } | null>(null);
  const [reset, setReset] = useState<Reset | null>(null);
  const [typed, setTyped] = useState('');
  const [leaving, setLeaving] = useState(false);
  const pr = config.settings.privacy;

  const exportConfig = () => {
    const date = new Date().toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify({ format: FORMAT, version: 1, exportedAt: new Date().toISOString(), revision, config }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nexus-config-${date}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast({ msg: `已导出 nexus-config-${date}.json`, tone: 'ok' });
  };

  const pickImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      setImporting({ name: file.name, config: parseImport(await file.text()) });
    } catch (e) {
      toast({ msg: `「${file.name}」${e instanceof Error ? e.message : '无法读取'}`, tone: 'error' });
    }
  };

  const doReset = () => {
    if (!reset) return;
    const d = defaultConfig();
    const label = { look: '外观', home: '首页布局', all: '全部设置' }[reset];
    const ok =
      reset === 'look'
        ? patch('look', d.settings.look, `已重置${label}`)
        : apply({ type: 'config.replace', config: reset === 'home' ? { ...config, pins: d.pins, settings: { ...config.settings, home: d.settings.home } } : d }, `已重置${label}`);
    if (ok) setReset(null);
  };

  const syncRow =
    save.kind === 'offline' ? (
      <Row label={<span className="flex items-center gap-2.5"><CloudOff className="size-[18px] text-warn" />离线</span>} sub={`${save.pending ? `${save.pending} 项更改保存在本设备，` : ''}恢复连接后自动同步`} />
    ) : (
      <Row
        label={<span className="flex items-center gap-2.5"><Cloud className="size-[18px] text-ok" />{save.kind === 'saving' ? '正在同步…' : '已同步到 Nexus 服务端'}</span>}
        sub={`修订 ${revision}${save.kind === 'saved' && save.at ? ` · 上次写入 ${formatHm(save.at)}` : ''} · 其他设备会在几秒内收到更新`}
      />
    );

  const resetRows: { scope: Reset; label: string; sub: string; btn: string }[] = [
    { scope: 'look', label: '重置外观', sub: '壁纸、背景、主题、时间、图标与动画恢复默认', btn: '重置…' },
    { scope: 'home', label: '重置首页布局', sub: '固定顺序与布局偏好恢复默认，不影响应用列表', btn: '重置…' },
    { scope: 'all', label: '恢复全部默认设置', sub: '清除所有自定义应用、分类、引擎与外观', btn: '全部重置…' },
  ];

  return (
    <div className="flex max-w-[880px] flex-col gap-7">
      <PageHeader title="数据、同步与安全" sub="配置保存在 Nexus 服务端，所有登录的设备共用；本设备保留一份缓存，离线时也能打开首页。" />
      <Group title={compact ? '同步与登录' : '配置同步'}>
        {syncRow}
        <Row label="多设备同时修改" sub="按操作合并（如「固定 GitHub」「移动 Notion」），不会整份覆盖；与新状态冲突的改动会被放弃并提示" />
      </Group>

      <Group title="导入与导出">
        <Row label="导出配置" sub="应用、分类、搜索引擎、首页与外观；不含上传的图片和服务凭据">
          <Button onClick={exportConfig}>
            <Download className="size-[15px]" />
            导出 JSON
          </Button>
        </Row>
        <Row label="导入配置" sub="导入前显示变更摘要；导入后 6 秒内可撤销">
          <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-[10px] bg-ink/9 px-3.5 text-[13px] text-ink hover:bg-ink/15">
            <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => void pickImport(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
            <Upload className="size-[15px]" />
            选择文件
          </label>
        </Row>
      </Group>

      <Group title="隐私">
        <Row label="访客模式" sub="隐藏服务状态、最近使用与搜索历史，适合投屏或他人使用">
          <Switch label="访客模式" checked={pr.guest} onChange={(v) => patch('privacy', { guest: v })} />
        </Row>
        <Row label="记录最近使用" sub="用于搜索框的「最近」；只保存在本浏览器">
          <Switch label="记录最近使用" checked={pr.recordRecent} onChange={(v) => patch('privacy', { recordRecent: v })} />
        </Row>
        <Row label="本地缓存图标" sub="由 Nexus 服务端获取并缓存品牌图标，浏览器不再直接请求第三方图标服务；图标源故障时继续使用缓存">
          <Switch label="本地缓存图标" checked={pr.cacheIcons} onChange={(v) => patch('privacy', { cacheIcons: v })} />
        </Row>
      </Group>

      <Group title="登录状态">
        <Row label="已登录 · 本设备" sub="会话保存在本浏览器，30 天内使用会自动续期；退出后本设备的缓存会被清除">
          <Button onClick={() => setLeaving(true)}>
            <LogOut className="size-[15px]" />
            退出登录
          </Button>
        </Row>
      </Group>

      <DevicesSection />

      <Group title="重置">
        {resetRows.map((r) => (
          <Row key={r.scope} label={r.label} sub={r.sub}>
            <Button variant={r.scope === 'all' ? 'danger' : 'secondary'} onClick={() => (setTyped(''), setReset(r.scope))}>
              {r.btn}
            </Button>
          </Row>
        ))}
      </Group>

      <Dialog
        open={!!importing}
        onOpenChange={(o) => !o && setImporting(null)}
        width={480}
        title={importing ? `导入「${importing.name}」？` : ''}
        description="导入会替换当前的应用、分类、搜索引擎、首页与外观设置。"
        footer={
          <>
            <Button className="h-10 px-[18px]" onClick={() => setImporting(null)}>
              取消
            </Button>
            <Button variant="primary" className="h-10 px-5" onClick={() => importing && apply({ type: 'config.replace', config: importing.config }, '已导入配置') && setImporting(null)}>
              替换并导入
            </Button>
          </>
        }
      >
        {importing && (
          <div className="grid grid-cols-4 gap-2">
            {counts(importing.config).map((c) => (
              <div key={c.label} className="flex flex-col gap-0.5 rounded-xl bg-ink/5 p-3">
                <span className="text-[20px] font-medium tabular-nums">{c.n}</span>
                <span className="text-[12px] text-ink/50">{c.label}</span>
              </div>
            ))}
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!reset}
        onOpenChange={(o) => !o && setReset(null)}
        title={reset ? `重置${{ look: '外观', home: '首页布局', all: '全部设置' }[reset]}？` : ''}
        description={reset === 'all' ? '所有自定义应用、分类、搜索引擎、外观与首页布局都会恢复为默认。建议先导出一份配置。' : '会恢复为默认值，6 秒内可撤销。'}
        footer={
          <>
            <Button className="h-10 px-[18px]" onClick={() => setReset(null)}>
              取消
            </Button>
            <Button variant={reset === 'all' ? 'danger-solid' : 'primary'} className="h-10 px-5" disabled={reset === 'all' && typed.trim() !== '重置'} onClick={doReset}>
              {reset === 'all' ? '全部重置' : '重置'}
            </Button>
          </>
        }
      >
        {reset === 'all' && (
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="输入「重置」以确认"
            aria-label="输入重置以确认"
            className="box-border h-11 rounded-xl border-0 px-3.5 text-[14px] text-ink caret-amber outline-none"
            style={{ background: 'rgba(239,234,225,0.06)', boxShadow: 'inset 0 0 0 1px rgba(233,118,95,0.4)', fontSize: compact ? 16 : undefined }}
          />
        )}
      </Dialog>

      <Dialog
        open={leaving}
        onOpenChange={setLeaving}
        title="退出登录？"
        description={save.kind === 'offline' && save.pending ? `还有 ${save.pending} 项更改没有同步到服务端，退出后会丢失。` : '退出后需要重新输入访问密码；本设备缓存的配置与最近使用会被清除。'}
        footer={
          <>
            <Button className="h-10 px-[18px]" onClick={() => setLeaving(false)}>
              取消
            </Button>
            <Button variant="primary" className="h-10 px-5" onClick={() => void logout()}>
              退出登录
            </Button>
          </>
        }
      />
    </div>
  );
}
