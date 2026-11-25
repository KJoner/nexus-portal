import { localCounts } from '@nexus/shared';
import { Cloud, CloudOff, HardDrive, LogIn, LogOut } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from '../../../components/toast-store';
import { dismissEverywhere, lastEverywhere, useConfigStore, useSaveState } from '../../../data/config-store';
import { accountDevicesApi, accountLabel, checkIdentity, loadAuthOptions, useIdentity } from '../../../data/identity';
import { webLocalTransport } from '../../../data/local/web';
import { HttpError, httpTransport, NetworkError } from '../../../data/transport';
import { switchWorkspace } from '../../../data/workspace';
import { host } from '../../../lib/host';
import { formatHm } from '../../../lib/time';
import { SignInOptions } from '../../account/ConnectPage';
import { RevocationResult } from '../../auth/RevocationResult';
import { Button, Group, PageHeader, Row } from '../ui';
import { AccountSection, UsernameRow } from './AccountSection';
import { AdminAccountsSection } from './AdminAccountsSection';
import { DevicesSection } from './DevicesSection';
import { SyncStatus } from './SyncStatus';

/**
 * 账号与同步 (v0.5 · U1/U2): who is signed in, which collection this browser uses, and the account's
 * own controls. Kept apart from 数据与备份 (files, privacy, resets): identity and where data goes
 * are one task, backups another (01-UX-PLAN §7).
 */
export function AccountPage() {
  const space = useConfigStore((s) => s.space);
  return space === 'local' ? <LocalAccount /> : <AccountSpace />;
}

/** The account's collection is in use: the account itself, its sync, its devices — and the way back to this browser's own collection. */
function AccountSpace() {
  const [local, setLocal] = useState<ReturnType<typeof localCounts> | null>(null);
  useEffect(() => {
    void webLocalTransport()
      .state()
      .then((s) => setLocal(localCounts(s)), () => setLocal(null));
  }, []);
  return (
    <div className="flex max-w-[880px] flex-col gap-7">
      <PageHeader title="账号与同步" sub="收藏和设置保存在你的账号里，登录同一账号的设备共用；此浏览器保留一份缓存，离线时也能打开首页。" />
      <AccountSection />
      <AdminAccountsSection />
      <SyncStatus />
      <DevicesSection />
      <Group title="此浏览器的本地收藏">
        <Row
          label={<span className="flex items-center gap-2.5"><HardDrive className="size-[18px] text-ink/60" />本地收藏</span>}
          sub={`${local ? `${local.items} 条收藏${local.pins ? `、${local.pins} 个固定到首页` : ''}。` : ''}登录前保存在此浏览器的收藏，与账号分开保存，不会自动上传。切回后可随时再切回账号。`}
        >
          <Button onClick={() => switchWorkspace({ kind: 'local' })}>切回本地收藏</Button>
        </Row>
      </Group>
    </div>
  );
}

/** A local collection: where things are kept, and — only when asked — the account. */
function LocalAccount() {
  const navigate = useNavigate();
  const identity = useIdentity();
  const save = useSaveState();
  const [counts, setCounts] = useState<ReturnType<typeof localCounts> | null>(null);
  const [everywhere, setEverywhere] = useState(lastEverywhere);
  const [busy, setBusy] = useState(false);
  const extension = !!host.connectAccount;
  const [params] = useSearchParams();
  // An extension asked to connect (/settings/account?pair=…): approving it needs the account, not its collection.
  const pairing = params.get('pair');
  const here = `/settings/account${pairing ? `?pair=${encodeURIComponent(pairing)}` : ''}`;

  useEffect(() => {
    void webLocalTransport()
      .state()
      .then((s) => setCounts(localCounts(s)), () => setCounts(null));
    // Opening this page is the person asking who is signed in; nothing asks on its own.
    if (!extension) void checkIdentity();
  }, [extension]);

  const signOut = async () => {
    setBusy(true);
    try {
      await httpTransport.logout();
      await checkIdentity();
      toast({ msg: '已退出登录。此浏览器的本地收藏不受影响。', tone: 'ok' });
    } catch (e) {
      toast({ msg: e instanceof NetworkError ? '无法连接 Nexus 服务端，请稍后再试' : e instanceof HttpError ? e.message : '没有完成，请重试', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const where = host.localWhere;
  return (
    <div className="flex max-w-[880px] flex-col gap-7">
      <PageHeader title="账号与同步" sub={`现在使用的是${where}的本地收藏：不需要账号，也不会上传。登录并开启同步后，才能在其他设备使用同一份收藏。`} />

      {everywhere && (
        <Group title="退出所有产品与设备">
          <div className="flex flex-col gap-2.5 px-4 py-3.5">
            <RevocationResult result={everywhere.result} at={everywhere.at} />
            <Button className="self-start" onClick={() => (dismissEverywhere(), setEverywhere(null))}>
              知道了
            </Button>
          </div>
        </Group>
      )}

      <Group title="保存位置">
        <Row
          label={<span className="flex items-center gap-2.5"><HardDrive className="size-[18px] text-ink/60" />仅保存在{where}</span>}
          sub={`${counts ? `${counts.items} 条收藏${counts.pins ? `、${counts.pins} 个固定到首页` : ''}${counts.wallpapers ? `、${counts.wallpapers} 张壁纸` : ''}。` : ''}${save.kind === 'error' ? save.message : save.kind === 'saved' && save.at ? `上次保存 ${formatHm(save.at)}。` : ''}清除网站数据${extension ? '或卸载扩展' : ''}可能删除这些内容；可以在「数据与备份」导出备份。`}
        />
        <Row label="网页与扩展" sub="Nexus 网页和浏览器扩展各有自己的本地收藏，未登录时不会互通。需要搬到另一处时，先在一处导出备份，再在另一处导入；或者登录同一账号后各自开启同步。" />
      </Group>

      <Group title="账号">
        {extension ? (
          <Row label="连接 Nexus 账号" sub="在扩展设置里连接你的 Nexus 后，新标签页可以显示账号里的收藏；此扩展的本地收藏仍然保留。">
            <Button variant="primary" onClick={() => host.connectAccount?.()}>
              <LogIn className="size-[15px]" />
              连接账号
            </Button>
          </Row>
        ) : identity.status === 'signed-in' && identity.me ? (
          <>
            <Row label={<span className="flex items-center gap-2.5"><Cloud className="size-[18px] text-ok" />已登录 {accountLabel(identity.me)}</span>} sub="已登录，但仍在使用此浏览器的本地收藏。开启同步时可以选择合并到账号，或直接使用账号里的收藏。">
              <div className="flex flex-none flex-wrap gap-2">
                <Button variant="primary" onClick={() => navigate(`/account/connect?return=1&from=${encodeURIComponent(here)}`)}>
                  开启同步…
                </Button>
                <Button disabled={busy} onClick={() => void signOut()}>
                  <LogOut className="size-[15px]" />
                  退出登录
                </Button>
              </div>
            </Row>
            <UsernameRow username={identity.me.account.username} />
            {pairing && <DevicesSection api={accountDevicesApi} />}
          </>
        ) : pairing && identity.status !== 'offline' ? (
          <>
            <Row label="先登录你的 Nexus 账号" sub="浏览器扩展请求连接你的账号。登录后在这里核对连接码并批准；登录不会改变此浏览器的本地收藏。" />
            <InlineSignIn returnTo={here} />
          </>
        ) : (
          <Row
            label={identity.status === 'offline' ? <span className="flex items-center gap-2.5"><CloudOff className="size-[18px] text-warn" />离线</span> : '未登录'}
            sub={identity.status === 'offline' ? '现在无法连接 Nexus 服务端；本地收藏照常可用，联网后可以登录。' : pairing ? '浏览器扩展请求连接你的 Nexus 账号：先登录，再在这里批准。登录不会改变此浏览器的本地收藏。' : '一个账号可用于 Nexus 和 LiteSync。登录后先由你选择如何处理这台浏览器里的收藏，不会自动上传。'}
          >
            <Button variant="primary" onClick={() => navigate(`/account/connect?from=${encodeURIComponent(here)}`)}>
              <LogIn className="size-[15px]" />
              登录同步
            </Button>
          </Row>
        )}
      </Group>
    </div>
  );
}

/** Signing in right here (an extension waits for approval): no data-space choice, nothing uploaded. */
function InlineSignIn({ returnTo }: { returnTo: string }) {
  const [invite, setInvite] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => void loadAuthOptions(), []);
  useEffect(() => {
    if (show) input.current?.focus();
  }, [show]);
  const signIn = () => {
    const q = new URLSearchParams({ returnTo });
    if (invite.trim()) q.set('invite', invite.trim());
    location.assign(`/auth/login?${q}`);
  };
  const onPassword = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      await httpTransport.login(password);
      setPassword('');
      await checkIdentity();
    } catch (err) {
      setError(err instanceof HttpError ? err.message : err instanceof NetworkError ? '无法连接 Nexus 服务端，请检查网络后重试' : '登录失败，请重试');
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 px-4 py-3.5">
      <SignInOptions invite={invite} setInvite={setInvite} onSignIn={signIn} showPassword={show} setShowPassword={setShow} password={password} setPassword={setPassword} onPassword={onPassword} busy={busy} passwordInput={input} hasError={!!error} />
      <p id="connect-error" role="alert" className="m-0 min-h-[18px] text-[13px] text-danger-ink">
        {error}
      </p>
    </div>
  );
}
