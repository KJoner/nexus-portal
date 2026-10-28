import { defaultConfig } from '@nexus/shared';
import { ArrowRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { login } from '../../data/config-store';
import { HttpError, NetworkError } from '../../data/transport';
import { cn } from '../../lib/cn';
import { useNow, useViewport } from '../../lib/hooks';
import { formatClock, formatDate } from '../../lib/time';
import { Wallpaper } from '../home/Wallpaper';

const LOOK = defaultConfig().settings.look;

/**
 * Not in the design files: built from the home page's own pieces (wallpaper, clock, search slab
 * material) so signing in feels like the same place, without exposing any private data.
 */
export function LoginPage() {
  const { w, h } = useViewport();
  const desktop = w >= 900 && h >= 560;
  const now = useNow(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

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
        <form
          onSubmit={submit}
          className={cn('flex flex-col gap-3 p-5 backdrop-blur-[32px] backdrop-saturate-[1.15]', desktop ? 'rounded-3xl' : 'rounded-[34px] px-4 pb-4')}
          style={{ background: desktop ? 'rgba(26,25,22,0.48)' : 'rgba(26,25,22,0.5)', boxShadow: '0 30px 80px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.07)' }}
        >
          <div className="flex items-center gap-2.5 px-1 text-[15px] font-semibold">
            <span className="size-2 rounded-full bg-amber" style={{ boxShadow: '0 0 14px rgba(230,192,138,0.75)' }} />
            Nexus
            <span className="text-[13px] font-normal text-ink/50">输入访问密码以继续</span>
          </div>
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
              className="grid size-[52px] flex-none place-items-center rounded-[18px] border-0 bg-amber text-on-amber transition-opacity hover:bg-amber-hi disabled:opacity-45"
            >
              {busy ? <span className="size-4 animate-spin-slow rounded-full border-2 border-on-amber/70 border-t-transparent" /> : <ArrowRight className="size-5" />}
            </button>
          </div>
          <p id="login-error" role="alert" className="m-0 min-h-[18px] px-1 text-[12.5px] text-danger-ink">
            {error}
          </p>
        </form>
      </main>
    </div>
  );
}
