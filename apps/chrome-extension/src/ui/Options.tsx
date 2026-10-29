import { ToastHost } from '@web/components/ToastHost';
import { toast } from '@web/components/toast-store';
import { Button, Dialog, Group, Row, Spinner } from '@web/features/settings/ui';
import { formatAgo } from '@web/lib/time';
import { Cloud, CloudOff, ExternalLink, RefreshCw, ShieldAlert, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { releaseOrigin } from '../boot';
import { assetStats } from '../lib/assets';
import { clearCache, disconnect, sync, useExt, type SyncOutcome } from '../lib/sync';
import { ConnectForm } from './Connect';

const SYNC_MESSAGE: Record<SyncOutcome, { msg: string; tone: 'ok' | 'info' | 'warn' | 'error' }> = {
  updated: { msg: '已同步最新导航', tone: 'ok' },
  unchanged: { msg: '导航已是最新', tone: 'ok' },
  skipped: { msg: '已是最新', tone: 'info' },
  busy: { msg: '另一个标签页正在同步', tone: 'info' },
  failed: { msg: '同步失败，继续使用本地缓存', tone: 'warn' },
  revoked: { msg: '此设备的授权已失效，请重新连接', tone: 'error' },
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
  const [dialog, setDialog] = useState<'switch' | 'disconnect' | null>(null);
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
          <Button onClick={() => window.open(`${server.origin}/settings/data`, '_blank', 'noopener')}>
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

export function Options() {
  const server = useExt((s) => s.server);
  const loaded = useExt((s) => s.loaded);
  const welcome = new URLSearchParams(location.search).has('welcome');
  const version = chrome.runtime.getManifest().version;
  if (!loaded) return null;
  const paired = server && !server.revoked;
  return (
    <div className="min-h-full bg-base px-5 py-10 text-ink sm:px-10">
      <div className="mx-auto flex max-w-[760px] flex-col gap-7">
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-[28px] font-medium tracking-[-0.01em]">{welcome && !paired ? '欢迎使用 Nexus 新标签页' : 'Nexus 新标签页'}</h1>
          <p className="m-0 text-[14px] leading-[1.7] text-ink/56">把新标签页换成你在 Nexus Portal 中的导航。导航保存在本机，打开即显示；有变化时在后台同步。应用、首页和外观请在 Nexus Portal 中编辑。</p>
        </div>

        {paired ? (
          <Connected />
        ) : (
          <Group title={server?.revoked ? '重新连接' : '连接 Nexus Portal'}>
            {server?.revoked && (
              <Row label={<span className="flex items-center gap-2.5"><ShieldAlert className="size-[18px] text-warn" />此设备的授权已失效</span>} sub="授权可能已在 Nexus Portal 中被撤销，或访问密码已更改；本地缓存的导航已清除。" />
            )}
            <div className="px-[22px] py-5">
              <ConnectForm initial={server?.origin ?? ''} onDone={(r) => toast(r === 'updated' ? { msg: '已连接并完成同步，打开新标签页即可使用', tone: 'ok' } : SYNC_MESSAGE[r])} />
            </div>
          </Group>
        )}

        <Group title="隐私与权限">
          <Row label="只读访问" sub="扩展使用专属的只读令牌，只能读取导航配置、服务状态、图标和壁纸；不能修改设置，也不会保存访问密码。可以在 Nexus Portal「数据、同步与安全 › 浏览器扩展」中随时撤销。" />
          <Row label="网站权限" sub="只在连接时请求访问你填写的这一个地址；不读取浏览记录、书签或其他网站的内容。" />
        </Group>
        <p className="m-0 text-center text-[12px] text-ink/40">扩展版本 {version}</p>
      </div>
      <ToastHost variant="desktop" />
    </div>
  );
}
