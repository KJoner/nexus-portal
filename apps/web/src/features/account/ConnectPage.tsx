import { defaultConfig, localCounts } from '@nexus/shared';
import { ArrowLeft, Check, Cloud, HardDrive, KeyRound, LogIn, Merge } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { accountLabel, applyMerge, checkIdentity, loadAuthOptions, previewMerge, useIdentity, type MergePreview } from '../../data/identity';
import { webLocalTransport } from '../../data/local/web';
import { HttpError, httpTransport, NetworkError, type RestoreDuplicates } from '../../data/transport';
import { forgetSignIn, leaveNotice, rememberSignIn, signInIntent, switchWorkspace } from '../../data/workspace';
import { useConfigStore } from '../../data/config-store';
import { cn } from '../../lib/cn';
import { useViewport } from '../../lib/hooks';
import { AUTH_ERRORS, AUTH_OFFLINE } from '../auth/LoginPage';
import { Wallpaper } from '../home/Wallpaper';
import { Segmented, Spinner } from '../settings/ui';

const LOOK = defaultConfig().settings.look;

type Step = 'signin' | 'checking' | 'choose' | 'preview' | 'merging';

/**
 * 登录同步 (v0.5 · U1, 02-LOCAL-MODE §3–4): from a local collection, the person signs in — and then
 * decides what happens to this browser's collection. Nothing is uploaded before they confirm a
 * previewed merge; 「使用账号里的收藏」 and 「暂时继续本地使用」 leave the local collection as it is
 * (it stays here and can be switched back to). The account's own pages (password, devices) stay
 * with the identity service and 账号与同步.
 */
export default function ConnectPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { w, h } = useViewport();
  const desktop = w >= 900 && h >= 560;
  const space = useConfigStore((s) => s.space);
  const identity = useIdentity();
  const from = signInIntent()?.from ?? params.get('from') ?? '/';
  const [step, setStep] = useState<Step>(params.get('return') ? 'checking' : 'signin');
  const [error, setError] = useState(() => AUTH_ERRORS[params.get('auth_error') ?? ''] ?? '');
  const [counts, setCounts] = useState<ReturnType<typeof localCounts> | null>(null);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [duplicates, setDuplicates] = useState<RestoreDuplicates>('skip');
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const passwordInput = useRef<HTMLInputElement>(null);

  // Already using an account here: there is nothing to connect.
  useEffect(() => {
    if (space === 'account') navigate('/settings/account', { replace: true });
  }, [space, navigate]);

  useEffect(() => {
    void loadAuthOptions();
    void webLocalTransport()
      .state()
      .then((s) => setCounts(localCounts(s)), () => setCounts(null));
    // Back from the identity service, or opened while signed in (SSO): who is it?
    void checkIdentity().then((status) => {
      if (status === 'signed-in') setStep('choose');
      else {
        if (params.get('return')) setError('没有完成登录。此浏览器的收藏没有任何改动，可以再试一次。');
        setStep('signin');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (showPassword) passwordInput.current?.focus();
  }, [showPassword]);

  const back = () => {
    forgetSignIn();
    navigate(from, { replace: true });
  };

  const signIn = () => {
    if (!navigator.onLine) {
      setError(AUTH_OFFLINE);
      return;
    }
    rememberSignIn(from);
    const q = new URLSearchParams({ returnTo: `/account/connect?return=1` });
    if (invite.trim()) q.set('invite', invite.trim());
    location.assign(`/auth/login?${q}`);
  };

  const submitPassword = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      await httpTransport.login(password);
      setPassword('');
      if ((await checkIdentity()) === 'signed-in') setStep('choose');
    } catch (err) {
      setError(err instanceof HttpError ? err.message : err instanceof NetworkError ? '无法连接 Nexus 服务端，请检查网络后重试' : '登录失败，请重试');
      setPassword('');
      passwordInput.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const account = identity.me;
  const accountId = account?.account.id ?? '';
  const accountEmpty = account?.onboarding.state === 'empty_collection';
  const localEmpty = !counts || counts.items === 0;

  const useAccount = () => {
    forgetSignIn();
    leaveNotice(`已切换到账号「${accountLabel(account)}」的收藏。此浏览器的本地收藏仍保留，可在「设置 › 账号与同步」切回。`);
    switchWorkspace({ kind: 'account', id: accountId }, from);
  };

  const makePreview = async (policy: RestoreDuplicates) => {
    setBusy(true);
    setError('');
    try {
      setPreview(await previewMerge(webLocalTransport(), accountId, policy));
      setStep('preview');
    } catch (e) {
      setError(e instanceof NetworkError ? '无法连接 Nexus 服务端，暂时不能预览合并。' : e instanceof HttpError ? e.message : '预览失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  const confirmMerge = async () => {
    if (!preview) return;
    setStep('merging');
    setError('');
    const r = await applyMerge(webLocalTransport(), preview);
    if (r.ok) {
      const s = r.answer.summary;
      forgetSignIn();
      leaveNotice(`已把此浏览器的 ${s.items.create} 条收藏合并到账号「${accountLabel(account)}」${s.items.update ? `，更新 ${s.items.update} 条` : ''}${s.items.skip ? `，${s.items.skip} 条账号里已有，已跳过` : ''}。此浏览器的本地收藏仍保留，之后不会自动双向同步。`);
      switchWorkspace({ kind: 'account', id: accountId }, from);
      return;
    }
    setError(r.message);
    if (r.stale) await makePreview(preview.duplicates);
    else setStep('preview');
  };

  const host = location.host;
  const panelBg = 'rgba(26,25,22,0.62)';

  return (
    <div className="fixed inset-0 overflow-y-auto bg-base" style={{ height: '100dvh' }}>
      <Wallpaper look={LOOK} variant={desktop ? 'desktop' : 'mobile'} receded />
      <main className="relative mx-auto flex min-h-full w-full max-w-[520px] flex-col justify-center gap-4 px-4 py-[max(24px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))]">
        <div className="flex flex-col gap-4 rounded-[24px] p-5 backdrop-blur-[30px] sm:p-7" style={{ background: panelBg, boxShadow: '0 30px 80px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.07)' }}>
          <button type="button" onClick={back} className="flex h-9 items-center gap-1.5 self-start rounded-[10px] border-0 bg-transparent px-1 text-[13px] text-ink/66 hover:text-ink">
            <ArrowLeft className="size-4" />
            返回
          </button>

          {(step === 'signin' || step === 'checking') && (
            <>
              <div className="flex flex-col gap-2">
                <h1 className="m-0 text-[24px] font-medium tracking-[-0.01em]">登录以跨设备同步</h1>
                <p className="m-0 text-[14px] leading-[1.7] text-ink/66">一个账号可用于 Nexus 和 LiteSync。登录后由你决定如何处理这台浏览器里的收藏——不会自动上传。</p>
              </div>
              {step === 'checking' ? (
                <p role="status" className="m-0 flex items-center gap-2 text-[13.5px] text-ink/70">
                  <Spinner />
                  正在确认登录状态…
                </p>
              ) : (
                <SignInOptions
                  invite={invite}
                  setInvite={setInvite}
                  onSignIn={signIn}
                  showPassword={showPassword}
                  setShowPassword={setShowPassword}
                  password={password}
                  setPassword={setPassword}
                  onPassword={submitPassword}
                  busy={busy}
                  passwordInput={passwordInput}
                  hasError={!!error}
                />
              )}
              <button type="button" onClick={back} className="h-11 rounded-[14px] border-0 bg-ink/9 text-[14px] text-ink hover:bg-ink/14">
                继续仅在此浏览器使用
              </button>
            </>
          )}

          {step === 'choose' && (
            <>
              <div className="flex flex-col gap-2">
                <h1 className="m-0 text-[22px] font-medium tracking-[-0.01em]">如何使用这台浏览器里的收藏？</h1>
                <p className="m-0 text-[13.5px] leading-[1.7] text-ink/66">
                  已登录 <b className="font-medium text-ink">{accountLabel(account)}</b>（{host}）。
                  此浏览器有 {counts?.items ?? 0} 条收藏{counts?.pins ? `、${counts.pins} 个固定到首页` : ''}；账号里{accountEmpty ? '还没有收藏' : '已有收藏'}。
                </p>
              </div>
              {localEmpty && accountEmpty ? (
                <Choice icon={Cloud} title="开启同步" sub="两边都还没有收藏。之后添加的收藏保存在账号里，可在其他设备使用。" primary onClick={useAccount} />
              ) : (
                <div className="flex flex-col gap-2.5">
                  {!localEmpty && <Choice icon={Merge} title="合并到我的账号" sub="先预览新增、重复和固定到首页的变化；确认后才上传。账号里已有的内容不会被覆盖。" primary={!accountEmpty || !localEmpty} busy={busy} onClick={() => void makePreview(duplicates)} />}
                  <Choice icon={Cloud} title="使用账号里的收藏" sub="不上传此浏览器的收藏。本地收藏保留在这里，随时可以切回。" primary={localEmpty} onClick={useAccount} />
                  <Choice icon={HardDrive} title="暂时继续本地使用" sub="保持登录，但仍只保存在此浏览器；以后可在「设置 › 账号与同步」开启。" onClick={back} />
                </div>
              )}
            </>
          )}

          {(step === 'preview' || step === 'merging') && preview && (
            <MergeSummary preview={preview} duplicates={duplicates} busy={busy || step === 'merging'} accountName={accountLabel(account)} onDuplicates={(d) => (setDuplicates(d), void makePreview(d))} onConfirm={() => void confirmMerge()} onBack={() => (setStep('choose'), setPreview(null))} />
          )}

          <p id="connect-error" role="alert" className="m-0 min-h-[18px] text-[13px] leading-[1.6] text-danger-ink">
            {error}
          </p>
        </div>
      </main>
    </div>
  );
}

export function SignInOptions(p: {
  invite: string;
  setInvite(v: string): void;
  onSignIn(): void;
  showPassword: boolean;
  setShowPassword(v: boolean): void;
  password: string;
  setPassword(v: string): void;
  onPassword(e: { preventDefault(): void }): void;
  busy: boolean;
  passwordInput: React.RefObject<HTMLInputElement | null>;
  hasError: boolean;
}) {
  const options = useIdentity((s) => s.options);
  const failed = useIdentity((s) => s.optionsFailed);
  if (!options && failed)
    // Offline or the server is down: say so — the button explains why it cannot go on, 重试 asks again.
    return (
      <div className="flex flex-col gap-2.5">
        <p className="m-0 text-[13px] leading-[1.6] text-ink/70">暂时无法连接 Nexus 服务端，读取不到登录方式。此浏览器的收藏照常可用。</p>
        <button type="button" onClick={p.onSignIn} className="flex h-12 items-center justify-center gap-2.5 rounded-[16px] border-0 bg-amber text-[15px] font-semibold text-on-amber hover:bg-amber-hi">
          <LogIn className="size-[18px]" />
          登录或创建账号
        </button>
        <button type="button" onClick={() => void loadAuthOptions()} className="h-10 self-start rounded-[12px] border-0 bg-ink/9 px-4 text-[13px] text-ink">
          重试
        </button>
      </div>
    );
  if (!options) return <p className="m-0 text-[13px] text-ink/66">正在读取登录方式…</p>;
  return (
    <div className="flex flex-col gap-2.5">
      {options.oidc && (
        <>
          {options.registration === 'invite' && (
            <label className="flex flex-col gap-1.5 text-[13px] text-ink/70">
              邀请码（第一次注册时填写）
              <input value={p.invite} onChange={(e) => p.setInvite(e.target.value)} autoComplete="off" spellCheck={false} className="h-11 rounded-[14px] border-0 bg-ink/9 px-4 text-[16px] text-ink outline-none sm:text-[14.5px]" />
            </label>
          )}
          <button type="button" onClick={p.onSignIn} className="flex h-12 items-center justify-center gap-2.5 rounded-[16px] border-0 bg-amber text-[15px] font-semibold text-on-amber hover:bg-amber-hi">
            <LogIn className="size-[18px]" />
            登录或创建账号
          </button>
          <p className="m-0 text-[12.5px] leading-[1.6] text-ink/56">{options.registration === 'closed' ? '暂未开放注册，已有账号可以直接登录。' : '还没有账号？在登录页选择「注册」，验证邮箱后会回到这里。'}</p>
        </>
      )}
      {options.legacyPassword && options.oidc && !p.showPassword && (
        <button type="button" onClick={() => p.setShowPassword(true)} className="flex h-9 items-center gap-2 self-start rounded-[10px] border-0 bg-transparent px-1 text-[12.5px] text-ink/56 hover:text-ink/80">
          <KeyRound className="size-3.5" />
          管理员访问密码登录
        </button>
      )}
      {options.legacyPassword && (p.showPassword || !options.oidc) && (
        <form onSubmit={p.onPassword} className="flex flex-col gap-1.5">
          <label htmlFor="connect-password" className="text-[13px] text-ink/70">
            访问密码
          </label>
          <div className="flex gap-2.5">
            <input type="text" name="username" autoComplete="username" value="nexus" readOnly hidden />
            <input id="connect-password" ref={p.passwordInput} type="password" name="password" autoComplete="current-password" value={p.password} onChange={(e) => p.setPassword(e.target.value)} aria-invalid={p.hasError} aria-describedby="connect-error" className="h-12 min-w-0 flex-1 rounded-[16px] border-0 bg-ink/9 px-4 text-[16px] text-ink outline-none" />
            <button type="submit" disabled={!p.password || p.busy} className="h-12 rounded-[16px] border-0 bg-amber px-5 text-[14.5px] font-semibold text-on-amber disabled:opacity-45">
              {p.busy ? <Spinner className="border-on-amber/70 border-t-transparent" /> : '登录'}
            </button>
          </div>
        </form>
      )}
      {!options.oidc && !options.legacyPassword && <p className="m-0 text-[13px] text-ink/70">此部署暂时无法登录：没有配置统一账号或访问密码。</p>}
    </div>
  );
}

function Choice({ icon: Icon, title, sub, primary, busy, onClick }: { icon: typeof Cloud; title: string; sub: string; primary?: boolean; busy?: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={cn('flex min-h-[64px] items-start gap-3 rounded-[16px] border-0 p-3.5 text-left text-ink transition-colors disabled:opacity-60', primary ? 'bg-amber/16 ring-1 ring-amber/50 hover:bg-amber/22' : 'bg-ink/7 hover:bg-ink/11')}
    >
      <Icon className={cn('mt-0.5 size-5 flex-none', primary ? 'text-amber' : 'text-ink/70')} />
      <span className="flex flex-col gap-1">
        <span className="text-[15px] font-medium">{title}</span>
        <span className="text-[12.5px] leading-[1.6] text-ink/62">{sub}</span>
      </span>
      {busy && <Spinner className="mt-1 ml-auto" />}
    </button>
  );
}

function MergeSummary({ preview, duplicates, busy, accountName, onDuplicates, onConfirm, onBack }: { preview: MergePreview; duplicates: RestoreDuplicates; busy: boolean; accountName: string; onDuplicates(d: RestoreDuplicates): void; onConfirm(): void; onBack(): void }) {
  const s = preview.answer.summary;
  const lines: ReactNode[] = [];
  lines.push(`新增 ${s.items.create} 条收藏（网站 ${s.items.kinds.app}、网页 ${s.items.kinds.page}）`);
  if (s.duplicateCount) lines.push(`${s.duplicateCount} 条网址账号里已有：${duplicates === 'skip' ? '保留账号里的，不改动' : duplicates === 'update' ? '用此浏览器的标题、分组、标签和备注更新' : '两份都保留'}`);
  if (s.folders.create.length) lines.push(`新建分组：${s.folders.create.map((f) => f.label).join('、')}`);
  if (s.folders.map.length) lines.push(`对应到账号已有分组：${s.folders.map.map((f) => f.label).join('、')}`);
  if (s.pins.restore || s.pins.notPinned) lines.push(`固定到首页：${s.pins.restore} 个${s.pins.notPinned ? `；${s.pins.notPinned} 个超过 ${s.pins.limit} 个上限或不能固定，仍作为收藏保存` : ''}`);
  if (s.icons.upload || s.icons.missing) lines.push(`自定义图标：上传 ${s.icons.upload} 个${s.icons.missing ? `，${s.icons.missing} 个缺少图片，改用网站图标` : ''}`);
  if (s.items.unsupported || s.items.repeated) lines.push(`${s.items.unsupported + s.items.repeated} 条无法导入或重复，已略过`);
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-col gap-2">
        <h1 className="m-0 text-[22px] font-medium tracking-[-0.01em]">合并到「{accountName}」</h1>
        <p className="m-0 text-[13px] leading-[1.7] text-ink/62">以下是预览，确认之前账号里什么都没有改变。壁纸和首页布局不合并，账号保留自己的外观。</p>
      </div>
      <ul className="m-0 flex flex-col gap-1.5 rounded-[14px] bg-ink/7 py-3 pr-3 pl-7 text-[13.5px] leading-[1.6]">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      {s.duplicateCount > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] text-ink/62">网址相同的收藏</span>
          <Segmented<RestoreDuplicates>
            label="网址相同的收藏"
            value={duplicates}
            onChange={onDuplicates}
            options={[
              { value: 'skip', label: '保留账号里的' },
              { value: 'update', label: '用此浏览器的更新' },
              { value: 'keep-both', label: '两份都保留' },
            ]}
          />
        </div>
      )}
      <div className="flex flex-wrap gap-2.5">
        <button type="button" disabled={busy} onClick={onConfirm} className="flex h-11 items-center gap-2 rounded-[14px] border-0 bg-amber px-5 text-[14.5px] font-semibold text-on-amber disabled:opacity-50">
          {busy ? <Spinner className="border-on-amber/70 border-t-transparent" /> : <Check className="size-4" />}
          确认合并
        </button>
        <button type="button" disabled={busy} onClick={onBack} className="h-11 rounded-[14px] border-0 bg-ink/9 px-4 text-[14px] text-ink">
          返回
        </button>
      </div>
      <p className="m-0 text-[12px] leading-[1.6] text-ink/50">合并是一次性的：之后此浏览器的本地收藏与账号各自独立，不会自动双向同步。</p>
    </div>
  );
}
