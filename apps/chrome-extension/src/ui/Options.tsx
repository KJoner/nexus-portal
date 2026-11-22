import { ToastHost } from '@web/components/ToastHost';
import { toast } from '@web/components/toast-store';
import { Button, Dialog, Group, Row, Segmented, Spinner } from '@web/features/settings/ui';
import { formatAgo } from '@web/lib/time';
import { localCounts } from '@nexus/shared';
import { Cloud, CloudOff, Download, ExternalLink, HardDrive, LibraryBig, RefreshCw, ShieldAlert, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { extLocal, readSpace, writeSpace, type ExtSpace } from '../lib/local';
import type { Area } from '../lib/storage';
import { releaseOrigin } from '../boot';
import { assetStats } from '../lib/assets';
import { clearCache, disconnect, sync, useExt, type SyncOutcome } from '../lib/sync';
import { canSave } from '../lib/storage';
import { ConnectForm } from './Connect';
import { ext } from '../lib/ext';
import { saveTarget } from '../lib/where';

const SYNC_MESSAGE: Record<SyncOutcome, { msg: string; tone: 'ok' | 'info' | 'warn' | 'error' }> = {
  updated: { msg: '已同步最新导航', tone: 'ok' },
  unchanged: { msg: '导航已是最新', tone: 'ok' },
  skipped: { msg: '已是最新', tone: 'info' },
  busy: { msg: '另一个标签页正在同步', tone: 'info' },
  failed: { msg: '同步失败，继续使用本地缓存', tone: 'warn' },
  revoked: { msg: '授权已被撤销，请重新连接（还没发送的收藏仍保存在扩展里）', tone: 'error' },
};

const mb = (n: number) => (n < 1024 * 1024 ? `${n ? Math.max(1, Math.round(n / 1024)) : 0} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Re-renders every 30 s so "x 分钟前" stays true while the page is open. */
function useTick() {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
}

function Connected() {
  const server = useExt((s) => s.server)!;
  const cache = useExt((s) => s.cache);
  const state = useExt((s) => s.sync);
  const syncing = useExt((s) => s.syncing);
  const [dialog, setDialog] = useState<'switch' | 'disconnect' | 'authorize' | null>(null);
  const [clearing, setClearing] = useState(false);
  useTick();
  const host = new URL(server.origin).host;
  const stats = assetStats();
  const configBytes = cache ? new Blob([JSON.stringify(cache.data)]).size : 0;

  const syncNow = async () => {
    const r = await sync({ force: true });
    toast(SYNC_MESSAGE[r]);
  };
  const clear = async () => {
    setClearing(true);
    const r = await clearCache();
    setClearing(false);
    toast(r === 'updated' ? { msg: '已清理缓存并重新下载导航', tone: 'ok' } : SYNC_MESSAGE[r]);
  };
  const leave = async () => {
    setDialog(null);
    const old = await disconnect();
    if (old) await releaseOrigin(old.origin);
  };

  const err = state.error;
  const statusLabel = err ? (
    <span className="flex items-center gap-2.5">
      <CloudOff className="size-[18px] text-warn" />
      {err.kind === 'offline' ? '离线 · 显示本地缓存' : '同步出错 · 显示本地缓存'}
    </span>
  ) : (
    <span className="flex items-center gap-2.5">
      <Cloud className="size-[18px] text-ok" />
      {syncing ? '正在同步…' : '已同步'}
    </span>
  );

  return (
    <>
      <Group title="连接">
        <Row label={host} sub={`设备「${server.deviceName}」· 授权于 ${server.pairedAt ? formatAgo(Date.parse(server.pairedAt)) : '—'} · 只读`}>
          <Button onClick={() => window.open(`${server.origin}/settings/account`, '_blank', 'noopener')}>
            <ExternalLink className="size-[15px]" />
            打开 Nexus 设置
          </Button>
        </Row>
        <Row label={statusLabel} sub={[err ? err.message : state.checkedAt ? `最近检查 ${formatAgo(state.checkedAt)}` : '尚未检查', cache ? `导航修订 ${cache.data.revision} · 更新于 ${formatAgo(cache.syncedAt)}` : '尚无缓存'].join(' · ')}>
          <Button onClick={() => void syncNow()} disabled={syncing}>
            {syncing ? <Spinner /> : <RefreshCw className="size-[15px]" />}
            立即同步
          </Button>
        </Row>
        <Row label="自动同步" sub="打开新标签页时先显示本地缓存，再在后台检查更新（同一时间只检查一次，30 秒内不重复）；导航未变化时服务端只返回很小的「未修改」响应。" />
      </Group>

      <Group title="本地缓存">
        <Row label="已缓存" sub={`导航配置 ${cache ? mb(configBytes) : '无'} · 图标与壁纸 ${stats.files} 个，共 ${mb(stats.bytes)}（上限 400 个图标、6 张壁纸、80 MB，最久未用的先清理）`}>
          <Button onClick={() => void clear()} disabled={clearing}>
            {clearing && <Spinner />}
            清理缓存
          </Button>
        </Row>
      </Group>

      <Group title="服务器">
        <Row label="更换服务器" sub="连接另一个 Nexus Portal；当前服务器的缓存会先被清除，不会显示在新服务器下。">
          <Button onClick={() => setDialog('switch')}>更换…</Button>
        </Row>
        <Row label="断开连接" sub="撤销此设备的令牌，并清除本地缓存的导航、图标和壁纸。">
          <Button variant="danger" onClick={() => setDialog('disconnect')}>
            <Unplug className="size-[15px]" />
            断开…
          </Button>
        </Row>
      </Group>

      {!canSave(server) && (
        <Group title="收藏网页">
          <Row label="需要新的授权" sub="这个扩展目前只能读取导航。要用工具栏按钮和右键菜单把网页存进收藏库，请在 Nexus Portal 里批准「读取与保存收藏」的权限（旧授权不会被自动扩大）。">
            <Button variant="primary" onClick={() => setDialog('authorize')}>
              授权收藏
            </Button>
          </Row>
        </Group>
      )}
      {canSave(server) && server.account && (
        <Group title="收藏网页">
          <Row label={saveTarget('account', server.account.label)} sub="点工具栏的 Nexus 按钮，或在网页、链接上右键选择「收藏到 Nexus」。离线时先保存在本机，联网后自动同步。" />
        </Group>
      )}

      <Dialog open={dialog === 'authorize'} onOpenChange={(o) => !o && setDialog(null)} width={500} title="授权收藏" description="在 Nexus Portal 里核对连接码并批准权限后，扩展会用新的授权替换旧的只读授权（旧授权随即撤销）。" footer={<Button onClick={() => setDialog(null)}>关闭</Button>}>
        <ConnectForm
          initial={server.origin}
          onDone={(r) => {
            setDialog(null);
            toast(r === 'revoked' ? SYNC_MESSAGE[r] : { msg: '已授权：现在可以把网页收藏到 Nexus 了', tone: 'ok' });
          }}
        />
      </Dialog>

      <Dialog open={dialog === 'switch'} onOpenChange={(o) => !o && setDialog(null)} width={500} title="更换服务器" description="连接成功后才会替换当前服务器。" footer={<Button onClick={() => setDialog(null)}>关闭</Button>}>
        <ConnectForm
          onDone={(r) => {
            setDialog(null);
            toast(r === 'updated' ? { msg: '已连接并完成同步', tone: 'ok' } : SYNC_MESSAGE[r]);
          }}
        />
      </Dialog>
      <Dialog
        open={dialog === 'disconnect'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`断开与 ${host} 的连接？`}
        description="新标签页将不再显示导航，直到重新连接。"
        footer={
          <>
            <Button className="h-10 px-[18px]" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button variant="danger-solid" className="h-10 px-5" onClick={() => void leave()}>
              断开连接
            </Button>
          </>
        }
      />
    </>
  );
}

/**
 * 此扩展的本地收藏 (v0.5): what is kept here, a backup of it, and — once an account is connected —
 * which of the two the new tab shows and the popup saves to.
 */
function LocalCollection({ paired, accountLabel }: { paired: boolean; accountLabel: string }) {
  const area = ext.storage.local as unknown as Area;
  const [counts, setCounts] = useState<ReturnType<typeof localCounts> | null>(null);
  const [space, setSpace] = useState<ExtSpace | null>(null);
  useEffect(() => {
    void extLocal()
      .state()
      .then((s) => setCounts(localCounts(s)), () => setCounts(null));
    void readSpace(area).then(setSpace);
  }, [area, paired]);
  const exportFile = async () => {
    try {
      const file = await extLocal().exportFile();
      const date = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
      a.download = `nexus-collection-${date}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast({ msg: `已导出 ${file.items.length} 条收藏`, tone: 'ok' });
    } catch {
      toast({ msg: '导出失败：读取不到此扩展的本地收藏', tone: 'error' });
    }
  };
  const choose = async (next: ExtSpace) => {
    await writeSpace(area, next);
    setSpace(next);
    toast({ msg: next === 'local' ? '新标签页和收藏按钮改用此扩展的本地收藏' : `新标签页和收藏按钮改用「${accountLabel}」的收藏`, tone: 'ok' });
  };
  return (
    <Group title="此扩展的本地收藏">
      <Row label={<span className="flex items-center gap-2.5"><HardDrive className="size-[18px] text-ink/60" />保存在此扩展里</span>} sub={`${counts ? `${counts.items} 条收藏${counts.pins ? `、${counts.pins} 个固定到首页` : ''}。` : ''}不需要账号，也不会上传；不使用浏览器的同步存储。卸载扩展或清除扩展数据会删除它们，请定期导出备份。`}>
        <div className="flex flex-none flex-wrap gap-2">
          <Button onClick={() => void ext.tabs.create({ url: ext.runtime.getURL('newtab.html#/library') })}>
            <LibraryBig className="size-[15px]" />
            打开收藏
          </Button>
          <Button onClick={() => void exportFile()}>
            <Download className="size-[15px]" />
            导出备份
          </Button>
        </div>
      </Row>
      <Row label="与 Nexus 网页互通" sub="网页版和扩展各有自己的本地收藏，不会自动互通：在一处导出备份，在另一处「收藏 › 导入」即可搬过去；或者登录同一账号后使用账号里的收藏。" />
      {paired && space && (
        <Row label="新标签页显示" sub="收藏按钮和右键菜单也保存到这里。切换不会删除另一边的收藏。" stacked>
          <Segmented<ExtSpace>
            label="新标签页显示"
            value={space}
            onChange={(v) => void choose(v)}
            options={[
              { value: 'local', label: '此扩展的本地收藏' },
              { value: 'account', label: `账号「${accountLabel}」` },
            ]}
          />
        </Row>
      )}
    </Group>
  );
}

export function Options() {
  const server = useExt((s) => s.server);
  const loaded = useExt((s) => s.loaded);
  const welcome = new URLSearchParams(location.search).has('welcome');
  const version = ext.runtime.getManifest().version;
  if (!loaded) return null;
  const paired = server && !server.revoked;
  return (
    <div className="min-h-full bg-base px-5 py-10 text-ink sm:px-10">
      <div className="mx-auto flex max-w-[760px] flex-col gap-7">
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-[28px] font-medium tracking-[-0.01em]">{welcome && !paired ? '欢迎使用 Nexus 新标签页' : 'Nexus 新标签页'}</h1>
          <p className="m-0 text-[14px] leading-[1.7] text-ink/56">
            {paired ? '新标签页可以显示此扩展的本地收藏，或你在 Nexus 账号里的导航（只读缓存，有变化时在后台同步）。' : '新标签页已经可以使用：打开一个新标签页，就能添加网站、整理收藏、固定到首页和更换壁纸，全部保存在此扩展里，不需要账号。想在多台设备同步时，再连接你的 Nexus 账号。'}
          </p>
        </div>

        <LocalCollection paired={!!paired} accountLabel={server?.account?.label || (server ? new URL(server.origin).host : '')} />

        {paired ? (
          <Connected />
        ) : (
          <Group title={server?.revoked ? '重新连接' : '连接 Nexus 账号（可选）'}>
            {server?.revoked && (
              <Row label={<span className="flex items-center gap-2.5"><ShieldAlert className="size-[18px] text-warn" />此设备的授权已失效</span>} sub="授权已被撤销，请重新连接：可能是在 Nexus Portal 或 LiteSync 中退出了全部设备、账号被停用，或访问密码已更改；本地缓存的导航已清除，还没发送的收藏仍保存在扩展里。" />
            )}
            <div className="px-[22px] py-5">
              <ConnectForm initial={server?.origin ?? ''} onDone={(r) => toast(r === 'updated' ? { msg: '已连接并完成同步，打开新标签页即可使用', tone: 'ok' } : SYNC_MESSAGE[r])} />
            </div>
          </Group>
        )}

        <Group title="隐私与权限">
          <Row label="本地收藏" sub="只保存在此扩展的存储里，不上传、不使用浏览器的同步存储；扩展只在你点击收藏按钮或右键菜单时读取当前页面的标题和网址。" />
          <Row label="连接账号后" sub="扩展使用专属令牌：读取导航配置、服务状态、图标和壁纸，按你批准的权限保存收藏；不能修改设置，也不会保存账号密码。可以在 Nexus「设置 › 账号与同步 › 浏览器扩展」中随时撤销。" />
          <Row label="网站权限" sub="只在连接时请求访问你填写的这一个地址；不读取浏览记录、书签或其他网站的内容。" />
        </Group>
        <p className="m-0 text-center text-[12px] text-ink/40">扩展版本 {version}</p>
      </div>
      <ToastHost variant="desktop" />
    </div>
  );
}
