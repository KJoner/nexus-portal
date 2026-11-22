import { ConfigSchema, defaultConfig, localCounts, newUserConfig, normalizeConfig, type Config } from '@nexus/shared';
import { Download, HardDrive, RefreshCw, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from '../../../components/toast-store';
import { flush, useConfig, useConfigStore, useIsAdmin, useSaveState } from '../../../data/config-store';
import { webLocalTransport } from '../../../data/local/web';
import { host } from '../../../lib/host';
import { apply, patch } from '../model';
import { Button, Dialog, Group, PageHeader, Row, Switch, useCompact } from '../ui';

/** Downloads `data` as a JSON file. */
function download(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const FORMAT = 'nexus-config';

function configCounts(c: Config) {
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

/**
 * 数据与备份 (v0.5): files in and out, privacy, and resets — the account and its sync moved to
 * 账号与同步. For a local collection also its storage: what is kept where, the collection backup,
 * and deleting it (an action of its own, never part of clearing a cache).
 */
export function DataPage() {
  const config = useConfig();
  const compact = useCompact();
  const save = useSaveState();
  const space = useConfigStore((s) => s.space);
  const admin = useIsAdmin();
  const navigate = useNavigate();
  const revision = useConfigStore((s) => s.confirmed?.revision ?? 0);
  const [importing, setImporting] = useState<{ name: string; config: Config } | null>(null);
  const [reset, setReset] = useState<Reset | null>(null);
  const [typed, setTyped] = useState('');
  const [counts, setCounts] = useState<ReturnType<typeof localCounts> | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteTyped, setDeleteTyped] = useState('');
  const pr = config.settings.privacy;
  const local = space === 'local';
  // A local collection and an ordinary account start from the public template; only the operator's own
  // account has the self-hosted seed (its private services) to go back to.
  const defaults = () => (!local && admin ? defaultConfig() : newUserConfig());

  useEffect(() => {
    if (local)
      void webLocalTransport()
        .state()
        .then((s) => setCounts(localCounts(s)), () => setCounts(null));
  }, [local, revision]);

  const exportCollection = async () => {
    try {
      const file = await webLocalTransport().exportFile();
      const date = new Date().toISOString().slice(0, 10);
      download(`nexus-collection-${date}.json`, file);
      toast({ msg: `已导出 nexus-collection-${date}.json（${file.items.length} 条收藏）`, tone: 'ok' });
    } catch {
      toast({ msg: '导出失败：读取不到此浏览器的本地收藏', tone: 'error' });
    }
  };

  const deleteLocal = async () => {
    try {
      await webLocalTransport().store.clear();
      setDeleting(false);
      location.assign('/');
    } catch {
      toast({ msg: '没有删除：此浏览器现在不允许修改本地数据', tone: 'error' });
    }
  };

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
    const d = defaults();
    const label = { look: '外观', home: '首页布局', all: '全部设置' }[reset];
    const ok =
      reset === 'look'
        ? patch('look', d.settings.look, `已重置${label}`)
        : apply({ type: 'config.replace', config: reset === 'home' ? { ...config, pins: d.pins, settings: { ...config.settings, home: d.settings.home } } : d }, `已重置${label}`);
    if (ok) setReset(null);
  };

  const resetRows: { scope: Reset; label: string; sub: string; btn: string }[] = [
    { scope: 'look', label: '重置外观', sub: '壁纸、背景、主题、时间、图标与动画恢复默认', btn: '重置…' },
    { scope: 'home', label: '重置首页布局', sub: '固定顺序与布局偏好恢复默认，不影响应用列表', btn: '重置…' },
    { scope: 'all', label: '恢复全部默认设置', sub: local ? '首页、分组、搜索引擎与外观恢复为新用户的默认；收藏移到回收站' : '清除所有自定义网站、分组、引擎与外观', btn: '全部重置…' },
  ];

  return (
    <div className="flex max-w-[880px] flex-col gap-7">
      <PageHeader title="数据与备份" sub={local ? `本地收藏保存在${host.localWhere}中。清除网站数据${host.connectAccount ? '或卸载扩展' : ''}可能删除这些内容；请定期导出备份。` : '账号里的收藏与设置的导出、导入和重置；账号与同步在「账号与同步」。'} />

      {local && (
        <Group title="本地存储">
          {save.kind === 'error' ? (
            <Row label={<span className="flex items-center gap-2.5 text-danger-ink"><TriangleAlert className="size-[18px]" />没有保存</span>} sub={`${save.message} 页面上的更改还在，但关闭页面后会丢失。`}>
              <div className="flex flex-none flex-wrap gap-2">
                <Button onClick={() => void flush()}>
                  <RefreshCw className="size-[15px]" />
                  重试
                </Button>
                <Button variant="primary" onClick={() => void exportCollection()}>
                  <Download className="size-[15px]" />
                  导出备份
                </Button>
              </div>
            </Row>
          ) : (
            <Row label={<span className="flex items-center gap-2.5"><HardDrive className="size-[18px] text-ink/60" />已保存到{host.localWhere}</span>} sub={counts ? `${counts.items} 条收藏${counts.pins ? `，其中 ${counts.pins} 个固定到首页` : ''}${counts.deleted ? `；回收站 ${counts.deleted} 条` : ''}${counts.wallpapers ? `；${counts.wallpapers} 张壁纸` : ''}` : '正在读取…'} />
          )}
          <Row label="删除此处的本地收藏" sub="删除全部本地收藏、首页设置和上传的图片，无法恢复。账号里的收藏不受影响。建议先导出备份。">
            <Button variant="danger" onClick={() => (setDeleteTyped(''), setDeleting(true))}>
              <Trash2 className="size-[15px]" />
              删除…
            </Button>
          </Row>
        </Group>
      )}

      <Group title="收藏备份">
        <Row label="导出收藏" sub="全部收藏、分组、固定顺序与自定义图标（nexus-collection）；可在另一处恢复，也可登录后合并到账号">
          <Button onClick={() => (local ? void exportCollection() : navigate('/library?export=1'))}>
            <Download className="size-[15px]" />
            导出收藏
          </Button>
        </Row>
        <Row label="导入收藏或浏览器书签" sub="恢复 Nexus 收藏备份（先预览新增与重复），或导入浏览器导出的书签文件">
          <Button onClick={() => navigate('/library?import=1')}>
            <Upload className="size-[15px]" />
            去收藏库导入
          </Button>
        </Row>
      </Group>

      <Group title="外观与首页配置">
        <Row label="导出配置" sub="首页、分组、搜索引擎与外观设置（nexus-config）；不含收藏的网页、上传的图片和服务凭据">
          <Button onClick={exportConfig}>
            <Download className="size-[15px]" />
            导出 JSON
          </Button>
        </Row>
        <Row label="导入配置" sub="替换首页、分组、搜索引擎与外观；导入前显示变更摘要，导入后 6 秒内可撤销">
          <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-[10px] bg-ink/9 px-3.5 text-[13px] text-ink hover:bg-ink/15">
            <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => void pickImport(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
            <Upload className="size-[15px]" />
            选择文件
          </label>
        </Row>
      </Group>

      <Group title="隐私与展示">
        <Row label="投屏隐私" sub="隐藏服务状态、最近使用与搜索历史，适合投屏或借给他人使用（不是账号或数据模式；收藏照常保存）">
          <Switch label="投屏隐私" checked={pr.guest} onChange={(v) => patch('privacy', { guest: v })} />
        </Row>
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
            {configCounts(importing.config).map((c) => (
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
        description={reset === 'all' ? '所有自定义网站、分组、搜索引擎、外观与首页布局都会恢复为默认。建议先导出收藏和配置。' : '会恢复为默认值，6 秒内可撤销。'}
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
        open={deleting}
        onOpenChange={setDeleting}
        title="删除此处的本地收藏？"
        description={`${counts ? `${counts.items} 条收藏、` : ''}首页设置和上传的图片会从${host.localWhere}删除，无法恢复。账号里的收藏不受影响。`}
        footer={
          <>
            <Button className="h-10 px-[18px]" onClick={() => void exportCollection()}>
              <Download className="size-[15px]" />
              先导出备份
            </Button>
            <Button className="h-10 px-[18px]" onClick={() => setDeleting(false)}>
              取消
            </Button>
            <Button variant="danger-solid" className="h-10 px-5" disabled={deleteTyped.trim() !== '删除'} onClick={() => void deleteLocal()}>
              删除
            </Button>
          </>
        }
      >
        <input
          value={deleteTyped}
          onChange={(e) => setDeleteTyped(e.target.value)}
          placeholder="输入「删除」以确认"
          aria-label="输入删除以确认"
          className="box-border h-11 rounded-xl border-0 px-3.5 text-[14px] text-ink caret-amber outline-none"
          style={{ background: 'rgba(239,234,225,0.06)', boxShadow: 'inset 0 0 0 1px rgba(233,118,95,0.4)', fontSize: compact ? 16 : undefined }}
        />
      </Dialog>
    </div>
  );
}
