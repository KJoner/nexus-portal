import { Button, Field, Spinner } from '@web/features/settings/ui';
import { ExternalLink, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { releaseOrigin } from '../boot';
import { ApiError } from '../lib/api';
import { defaultDeviceName, pair, PairError } from '../lib/pair';
import { originPattern, parseServer } from '../lib/server';
import { connect, useExt, type SyncOutcome } from '../lib/sync';

type Step = { kind: 'form'; error?: string } | { kind: 'permission' } | { kind: 'starting' } | { kind: 'waiting'; code: string; url: string; expiresAt: number } | { kind: 'finishing' };

const message = (e: unknown) => (e instanceof PairError || e instanceof ApiError ? e.message : e instanceof Error ? e.message : '连接失败');

/**
 * 连接 Nexus Portal: the address, Chrome's permission prompt for exactly that origin, then the
 * pairing code, approved by the signed-in user on the portal page this opens.
 */
export function ConnectForm({ initial = '', onDone }: { initial?: string; onDone?(outcome: SyncOutcome): void }) {
  const [address, setAddress] = useState(initial);
  const [name, setName] = useState(defaultDeviceName);
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const ctrl = useRef<AbortController | null>(null);
  const approvalTab = useRef<number | undefined>(undefined);
  const check = parseServer(address);
  const [now, setNow] = useState(Date.now);

  useEffect(() => () => ctrl.current?.abort(), []);
  useEffect(() => {
    if (step.kind !== 'waiting') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [step.kind]);

  const openApproval = async (url: string) => {
    const tab = await chrome.tabs.create({ url, active: true });
    approvalTab.current = tab.id;
  };

  const submit = async () => {
    if (!check.ok) return setStep({ kind: 'form', error: check.error });
    const { origin } = check;
    // Chrome asks the user here (it needs this click): access to this one address, nothing else.
    setStep({ kind: 'permission' });
    const granted = await chrome.permissions.request({ origins: [originPattern(origin)] }).catch(() => false);
    if (!granted) return setStep({ kind: 'form', error: `需要允许访问 ${new URL(origin).host} 才能同步导航` });
    setStep({ kind: 'starting' });
    ctrl.current = new AbortController();
    const before = useExt.getState().server;
    try {
      const server = await pair(origin, name.trim() || defaultDeviceName(), {
        fetch: (...a) => fetch(...a),
        signal: ctrl.current.signal,
        onCode: (code, url, expiresAt) => {
          setStep({ kind: 'waiting', code, url, expiresAt });
          void openApproval(url);
        },
      });
      setStep({ kind: 'finishing' });
      const outcome = await connect(server);
      if (before && before.origin !== origin) await releaseOrigin(before.origin);
      // Back to this page; the approval tab has done its job.
      if (approvalTab.current !== undefined) await chrome.tabs.remove(approvalTab.current).catch(() => undefined);
      const self = await chrome.tabs.getCurrent();
      if (self?.id !== undefined) await chrome.tabs.update(self.id, { active: true }).catch(() => undefined);
      onDone?.(outcome);
    } catch (e) {
      if (e instanceof PairError && e.reason === 'cancelled') return;
      // Access to an address that never paired is given back.
      if (before?.origin !== origin) await releaseOrigin(origin);
      setStep({ kind: 'form', error: message(e) });
    }
  };

  const cancel = () => {
    ctrl.current?.abort();
    setStep({ kind: 'form' });
  };

  if (step.kind === 'waiting') {
    const left = Math.max(0, Math.ceil((step.expiresAt - now) / 60_000));
    return (
      <div className="flex flex-col gap-4" aria-live="polite">
        <p className="m-0 text-[14px] leading-[1.7] text-ink/72">已在新标签页打开 Nexus Portal。登录后，确认页面上的连接码与下面一致，再点「允许连接」。</p>
        <div className="rounded-2xl bg-ink/5 py-5 text-center font-mono text-[32px] tracking-[0.2em] text-amber-hi" data-testid="pair-code">
          {step.code}
        </div>
        <div className="flex items-center gap-2.5 text-[13px] text-ink/56">
          <Spinner />
          等待确认… {left} 分钟内有效
        </div>
        <div className="flex flex-wrap gap-2.5">
          <Button onClick={() => void openApproval(step.url)}>
            <ExternalLink className="size-[15px]" />
            重新打开确认页面
          </Button>
          <Button onClick={cancel}>取消</Button>
        </div>
      </div>
    );
  }

  const busy = step.kind !== 'form';
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field
        label="Nexus Portal 地址"
        placeholder="https://nexus.example.com"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        error={step.kind === 'form' ? step.error : undefined}
        warn={check.ok && check.insecure ? '这是 http:// 地址：令牌和导航数据在局域网中不加密传输，只建议在可信的家庭网络中使用' : undefined}
        hint="填写你部署的门户地址。扩展只会请求访问这一个地址。"
        inputMode="url"
        autoFocus
        disabled={busy}
      />
      <Field label="设备名称" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} hint="显示在 Nexus Portal 的设备列表中，方便以后识别和撤销。" disabled={busy} />
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" className="h-10 px-5" disabled={busy || !address.trim()}>
          {busy ? <Spinner className="border-on-amber/70 border-t-transparent" /> : <ShieldCheck className="size-[15px]" />}
          {step.kind === 'permission' ? '等待授权…' : step.kind === 'starting' ? '正在连接…' : step.kind === 'finishing' ? '正在同步…' : '连接'}
        </Button>
        <span className="text-[12.5px] leading-[1.6] text-ink/50">只读：扩展不能修改设置，也拿不到访问密码。</span>
      </div>
    </form>
  );
}
