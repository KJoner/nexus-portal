import { defaultConfig, type AuthOptions } from '@nexus/shared';
import { ArrowRight, KeyRound, LogIn } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { authOptions, dismissEverywhere, lastEverywhere, login, useConfigStore } from '../../data/config-store';
import { switchWorkspace } from '../../data/workspace';
import { HttpError, NetworkError } from '../../data/transport';
import { cn } from '../../lib/cn';
import { useNow, useViewport } from '../../lib/hooks';
import { formatClock, formatDate } from '../../lib/time';
import { Wallpaper } from '../home/Wallpaper';
import { RevocationResult } from './RevocationResult';

const LOOK = defaultConfig().settings.look;

/** Why the identity service sent the browser back without a session (codes from /auth/callback). */
export const AUTH_ERRORS: Record<string, string> = {
  state: '登录已过期或被中断，请重新开始。',
  rejected: '登录没有完成：身份校验未通过。请重新登录。',
  unavailable: '暂时无法连接账号中心，请稍后再试。',
  registration_closed: '暂未开放注册。已有账号可以直接登录。',
  invite_required: '目前仅限受邀注册：请填写邀请码后再继续。',
  invite_invalid: '邀请码无效、已过期或已经用过。',
  disabled: '这个账号已被停用。如有疑问请联系管理员。',
  access_denied: '已取消登录。',
  idp_error: '账号中心返回了错误，请重试。',
  link_requires_password: '请先用管理员访问密码登录，再绑定统一账号。',
  identity_taken: '这个统一账号已经在使用，不能用来认领管理员账号。',
  account_linked_elsewhere: '管理员账号已经绑定了另一个统一账号。',
  session_ended: '登录已失效，请重新登录。',
};

/** Signing in needs the server and the identity service; nothing is pretended offline. */
export const AUTH_OFFLINE = '当前设备离线：统一登录需要连接 Nexus 服务端与账号中心，恢复网络后再试。';

const here = () => `${location.pathname}${location.search.replace(/[?&]auth_error=[^&]*/g, '').replace(/^&/, '?')}${location.hash}`;

/**
 * Not in the design files: built from the home page's own pieces (wallpaper, clock, search slab
 * material) so signing in feels like the same place, without exposing any private data.
 *
 * v0.4: the primary way in is the shared account (one account for Nexus and LiteSync), through the
 * identity service; the old access password stays for the legacy administrator while the server
 * allows it.
 */
export function LoginPage({ reauth = false }: { reauth?: boolean }) {
  // v0.5: shown only for an account whose sign-in ended; its unsent changes stay kept for it.
  const pending = useConfigStore((s) => s.pending.length + s.held.length);
  const { w, h } = useViewport();
  const desktop = w >= 900 && h >= 560;
  const now = useNow(false);
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [optionsError, setOptionsError] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() => AUTH_ERRORS[new URLSearchParams(location.search).get('auth_error') ?? ''] ?? '');
  // 退出所有产品与设备 just signed this browser out: what happened to each part stays on screen.
  const [everywhere, setEverywhere] = useState(lastEverywhere);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    authOptions().then(
      (o) => {
        setOptions(o);
        if (!o.oidc) setShowPassword(true);
      },
      // An older server without /api/v2: the password form, as before.
      (e) => (e instanceof HttpError && e.status === 404 ? (setOptions({ oidc: false, legacyPassword: true, registration: 'closed', accountUrl: null }), setShowPassword(true)) : setOptionsError(true)),
    );
  }, []);
  useEffect(() => {
    if (showPassword) input.current?.focus();
  }, [showPassword]);

  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      await login(password);
    } catch (err) {
      setError(err instanceof HttpError ? err.message : err instanceof NetworkError ? '无法连接 Nexus 服务端，请检查网络后重试' : '登录失败，请重试');
      setPassword('');
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  /**
   * A full-page navigation: the server talks to the identity service, the browser never sees a token.
   * Offline it would only reach the browser's error page (the Service Worker never answers /auth/*
   * with the app, NEX-01): say so here instead.
   */
  const signIn = () => {
    if (!navigator.onLine) {
      setError(AUTH_OFFLINE);
      return;
    }
    const q = new URLSearchParams({ returnTo: here() });
    if (invite.trim()) q.set('invite', invite.trim());
    location.assign(`/auth/login?${q}`);
  };

  const panel = 'rgba(26,25,22,0.48)';
  return (
    <div className="fixed inset-0 overflow-clip bg-base" style={{ height: '100dvh' }}>
      <Wallpaper look={LOOK} variant={desktop ? 'desktop' : 'mobile'} receded={false} />
      <main
        className={cn('absolute flex flex-col', desktop ? 'left-1/2 w-[440px] -translate-x-1/2' : 'right-2.5 left-2.5')}
        style={desktop ? { top: h >= 900 ? 228 : Math.round(h * 0.24) } : { bottom: 'max(12px, calc(env(safe-area-inset-bottom) - 10px))' }}
      >
        {desktop ? (
          <div className="flex items-baseline gap-4 px-2 pb-5">
            <span className="text-[60px] leading-none font-light tracking-[-0.035em] tabular-nums">{formatClock(now, '24', false)}</span>
            <span className="text-[15px] text-ink/66">{formatDate(now)}</span>
          </div>
        ) : (
          <div className="fixed top-[calc(max(env(safe-area-inset-top),20px)+25px)] left-[26px] flex flex-col gap-1.5">
            <span className="text-[58px] leading-none font-light tracking-[-0.04em] tabular-nums">{formatClock(now, '24', false)}</span>
            <span className="text-[14px] text-ink/70">{formatDate(now)}</span>
          </div>
        )}
        <div
          className={cn('flex flex-col gap-3 p-5 backdrop-blur-[32px] backdrop-saturate-[1.15]', desktop ? 'rounded-3xl' : 'rounded-[34px] px-4 pb-4')}
          style={{ background: desktop ? panel : 'rgba(26,25,22,0.5)', boxShadow: '0 30px 80px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.07)' }}
        >
          <div className="flex items-center gap-2.5 px-1 text-[15px] font-semibold">
            <span className="size-2 rounded-full bg-amber" style={{ boxShadow: '0 0 14px rgba(230,192,138,0.75)' }} />
            Nexus
            <span className="text-[13px] font-normal text-ink/50">{reauth ? '需要重新登录' : options?.oidc ? '登录或注册以继续' : '输入访问密码以继续'}</span>
          </div>
          {reauth && (
            <p className="m-0 px-1 text-[12.5px] leading-[1.6] text-ink/62">
              这个账号在此浏览器的登录已失效，账号里的收藏暂时隐藏。{pending ? `${pending} 项更改尚未同步，仍保留在此浏览器，重新登录同一账号后继续发送。` : ''}
            </p>
          )}

          {everywhere && (
            <div className="flex flex-col gap-2 rounded-[18px] px-3.5 py-3" style={{ background: 'rgba(239,234,225,0.06)' }}>
              <RevocationResult result={everywhere.result} at={everywhere.at} />
              <p className="m-0 text-[12px] text-ink/50">登录后可以在「设置 › 数据、同步与安全」查看最新状态，并重新发送没有送达的通知。</p>
              <button type="button" onClick={() => (dismissEverywhere(), setEverywhere(null))} className="h-8 self-start rounded-[10px] border-0 bg-ink/9 px-3 text-[12.5px] text-ink hover:bg-ink/15">
                知道了
              </button>
            </div>
          )}

          {optionsError && <p className="m-0 px-1 text-[13px] text-ink/70">无法连接 Nexus 服务端，请检查网络后刷新页面。</p>}

          {options?.oidc && (
            <div className="flex flex-col gap-2.5">
              {options.registration === 'invite' && (
                <input
                  value={invite}
                  onChange={(e) => setInvite(e.target.value)}
                  placeholder="邀请码（第一次注册时填写）"
                  aria-label="邀请码"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-11 rounded-[14px] border-0 px-4 text-[14.5px] text-ink caret-amber outline-none"
                  style={{ background: 'rgba(239,234,225,0.07)', boxShadow: 'inset 0 0 0 1px rgba(239,234,225,0.06)' }}
                />
              )}
              <button type="button" onClick={signIn} className="flex h-[52px] items-center justify-center gap-2.5 rounded-[18px] border-0 bg-amber text-[15.5px] font-semibold text-on-amber transition-colors hover:bg-amber-hi">
                <LogIn className="size-[18px]" />
                使用统一账号登录
              </button>
              <p className="m-0 px-1 text-[12.5px] leading-[1.6] text-ink/56">
                {options.registration === 'closed' ? '暂未开放注册，已有账号可以直接登录。' : '还没有账号？在账号中心选择「注册」，验证邮箱后回到这里。'}同一个账号也可以登录 LiteSync。
              </p>
            </div>
          )}

          {options?.oidc && options.legacyPassword && !showPassword && (
            <button type="button" onClick={() => setShowPassword(true)} className="flex h-9 items-center gap-2 self-start rounded-[10px] border-0 bg-transparent px-1 text-[12.5px] text-ink/56 hover:text-ink/80">
              <KeyRound className="size-3.5" />
              管理员访问密码登录
            </button>
          )}

          {options?.legacyPassword && showPassword && (
            <form onSubmit={submit} className="flex flex-col gap-2">
              <input type="text" name="username" autoComplete="username" value="nexus" readOnly hidden />
              <div className="flex gap-2.5">
                <input
                  ref={input}
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  enterKeyHint="go"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="访问密码"
                  aria-label="访问密码"
                  aria-invalid={!!error}
                  aria-describedby={error ? 'login-error' : undefined}
                  className="h-[52px] min-w-0 flex-1 rounded-[18px] border-0 px-4 text-[16px] text-ink caret-amber outline-none"
                  style={{ background: 'rgba(239,234,225,0.09)', boxShadow: error ? 'inset 0 0 0 1.5px rgba(233,118,95,0.7)' : 'inset 0 0 0 1px rgba(239,234,225,0.06)' }}
                />
                <button
                  type="submit"
                  disabled={!password || busy}
                  aria-label="进入"
                  className={cn('grid size-[52px] flex-none place-items-center rounded-[18px] border-0 transition-opacity disabled:opacity-45', options.oidc ? 'bg-ink/12 text-ink hover:bg-ink/18' : 'bg-amber text-on-amber hover:bg-amber-hi')}
                >
                  {busy ? <span className="size-4 animate-spin-slow rounded-full border-2 border-current/70 border-t-transparent" /> : <ArrowRight className="size-5" />}
                </button>
              </div>
            </form>
          )}

          {options && !options.oidc && !options.legacyPassword && <p className="m-0 px-1 text-[13px] text-ink/70">此部署暂时无法登录：没有配置访问密码或统一账号，请联系管理员。</p>}

          <p id="login-error" role="alert" className="m-0 min-h-[18px] px-1 text-[12.5px] text-danger-ink">
            {error}
          </p>
          {reauth && (
            <button type="button" onClick={() => switchWorkspace({ kind: 'local' })} className="h-10 rounded-[14px] border-0 bg-ink/9 px-4 text-[13.5px] text-ink hover:bg-ink/14">
              改用此浏览器的本地收藏
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
