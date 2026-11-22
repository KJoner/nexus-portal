import type { AuthOptions, RevocationEventInfo, RevocationStatusResponse } from '@nexus/shared';
import { ExternalLink, KeyRound, LogOut, MonitorX, ShieldOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from '../../../components/toast-store';
import { authOptions, logout, logoutEverywhere, revocationApi, revokeAllProducts, useAccount, useSaveState } from '../../../data/config-store';
import { HttpError } from '../../../data/transport';
import { AUTH_ERRORS, AUTH_OFFLINE } from '../../auth/LoginPage';
import { peerLine } from '../../auth/RevocationResult';
import { formatAgo } from '../../../lib/time';
import { Button, Dialog, Group, Row, Tag } from '../ui';

/** Messages for the claim flow, which returns here (`/settings/account?auth_error=…`). */
const LINK_ERRORS: Record<string, string> = {
  ...AUTH_ERRORS,
  already_linked: '这个账号已经绑定了统一账号。',
};

type Leaving = 'here' | 'product' | 'everywhere';

const PRODUCT: Record<string, string> = { litesync: 'LiteSync', nexus: 'Nexus' };

/**
 * 跨产品撤销的真实状态（ADR-019 §2.3）：这个账号最近发出与收到的撤销事件。没有送达的可以重新发送；
 * 本部署没有配置时直接说明，不让人以为 LiteSync 也退出了。
 */
function RevocationHistory({ status, onChange }: { status: RevocationStatusResponse; onChange(s: RevocationStatusResponse): void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const resend = async (e: RevocationEventInfo) => {
    setBusy(e.eventId);
    try {
      const next = await revocationApi.retry(e.eventId);
      onChange({ ...status, events: status.events.map((x) => (x.eventId === e.eventId && x.direction === 'outgoing' ? next : x)) });
      toast(next.state === 'delivered' ? { msg: `${PRODUCT[next.product] ?? next.product} 已确认`, tone: 'ok' } : { msg: '还没有送达，会在后台继续重试', tone: 'warn' });
    } catch (err) {
      toast({ msg: err instanceof HttpError ? err.message : '没有完成，请检查网络后重试', tone: 'error' });
    } finally {
      setBusy(null);
    }
  };
  const events = status.events.slice(0, 5);
  if (!events.length) return null;
  return (
    <>
      {events.map((e) => {
        const name = PRODUCT[e.product] ?? e.product;
        if (e.direction === 'incoming')
          return <Row key={`in-${e.eventId}`} label={`在 ${name} 中执行的「退出所有产品与设备」`} sub={`${e.state === 'applied' ? 'Nexus 已撤销这个账号的全部登录与设备' : 'Nexus 没有对应的内容需要撤销'} · ${formatAgo(Date.parse(e.createdAt))}`} />;
        const line = peerLine({ product: e.product, state: e.state as 'pending' | 'delivered' | 'failed', eventId: e.eventId, attempts: e.attempts ?? 0, nextAttemptAt: e.nextAttemptAt, error: e.error, result: e.result });
        return (
          <Row key={`out-${e.eventId}`} label={<span className={line.tone === 'error' ? 'text-danger-ink' : line.tone === 'warn' ? 'text-warn' : ''}>退出所有产品与设备 · {formatAgo(Date.parse(e.createdAt))}</span>} sub={line.text}>
            {(e.state === 'pending' || e.state === 'failed') && (
              <Button disabled={busy === e.eventId} onClick={() => void resend(e)}>
                重新发送
              </Button>
            )}
          </Row>
        );
      })}
    </>
  );
}

/**
 * 账号与登录: who is signed in, the identity service's account console, 旧管理员认领, and the three
 * ways out of ADR-019, each saying exactly what it ends:
 *  A 退出此设备 — this browser's Nexus session only;
 *  B 退出 Nexus 的全部设备 — every Nexus session, extension and approved pairing; nothing else;
 *  C 退出所有产品与设备 — B, plus the identity service in every browser, plus LiteSync's B.
 */
export function AccountSection() {
  const me = useAccount();
  const save = useSaveState();
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const [linking, setLinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revocations, setRevocations] = useState<RevocationStatusResponse | null>(null);

  useEffect(() => {
    authOptions().then(setOptions, () => setOptions(null));
    // The claim flow comes back here with its outcome.
    const q = new URLSearchParams(location.search);
    const code = q.get('auth_error');
    if (code) {
      toast({ msg: LINK_ERRORS[code] ?? '没有完成绑定，请重试', tone: 'error' });
      q.delete('auth_error');
      const rest = q.toString();
      history.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
    }
  }, []);

  const oidc = me?.session === 'oidc';
  const accountUrl = options?.accountUrl ?? null;
  // 动作 C needs a unified identity: the other product and the identity service know the person by it.
  const allProducts = !!options?.oidc && !!me?.identityLinked;
  useEffect(() => {
    if (allProducts) revocationApi.status().then(setRevocations, () => setRevocations(null));
  }, [allProducts]);
  const peerMissing = revocations !== null && !revocations.peer.configured;
  const unsent = save.kind === 'offline' && save.pending ? `还有 ${save.pending} 项更改没有同步到服务端，退出后会丢失。` : '';

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      // Signed out now: the login page takes over (and shows what 动作 C did).
    } catch (e) {
      toast({ msg: e instanceof HttpError ? e.message : '没有完成，请检查网络后重试', tone: 'error' });
      setBusy(false);
    }
  };

  const who = me ? me.account.email || me.account.displayName || (me.account.id === 'legacy-admin' ? '管理员' : me.account.id) : '正在读取…';
  const how = !me ? '' : oidc ? '统一账号登录（与 LiteSync 共用）' : '访问密码登录';

  return (
    <>
      <Group title="账号与登录">
        <Row
          label={
            <span className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 break-all">{who}</span>
              {me?.role === 'admin' && <Tag tone="amber">管理员</Tag>}
            </span>
          }
          sub={me ? `${how} · 会话保存在本浏览器，30 天内使用会自动续期` : undefined}
        />
        {oidc && accountUrl && (
          <Row label="管理统一账号" sub="在账号中心修改登录密码和邮箱，查看并退出各浏览器里的登录。那里不列已连接的浏览器扩展与 Obsidian：扩展在下面「浏览器扩展」里，Obsidian 在 LiteSync 里；要一次断开全部，用「退出所有产品与设备」">
            <a href={accountUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center gap-2 rounded-[10px] bg-ink/9 px-3.5 text-[13px] text-ink no-underline hover:bg-ink/15">
              <ExternalLink className="size-[15px]" />
              打开账号中心
            </a>
          </Row>
        )}
        {me?.canLinkIdentity && (
          <Row label="绑定统一账号" sub="用账号中心的账号登录这个管理员账号；数据、设置和已连接的扩展都保持不变">
            <Button onClick={() => setLinking(true)}>
              <KeyRound className="size-[15px]" />
              绑定…
            </Button>
          </Row>
        )}
        <Row label="退出此设备" sub="只退出这个浏览器的 Nexus；本设备缓存的配置与最近使用会被清除。账号中心、LiteSync 和已连接的扩展不受影响">
          <Button onClick={() => setLeaving('here')}>
            <LogOut className="size-[15px]" />
            退出
          </Button>
        </Row>
        <Row label="退出 Nexus 的全部设备" sub="结束这个账号在所有浏览器的 Nexus 登录，撤销已连接的浏览器扩展和尚未领取的扩展授权。账号中心与 LiteSync 不受影响">
          <Button variant="danger" onClick={() => setLeaving('product')}>
            <MonitorX className="size-[15px]" />
            全部退出…
          </Button>
        </Row>
        {allProducts && (
          <Row
            label="退出所有产品与设备"
            sub={peerMissing ? '在上一项的基础上，再结束账号中心在所有浏览器的登录。本部署没有配置跨产品撤销：LiteSync 不会收到通知，需要另外在 LiteSync 中退出' : '在上一项的基础上，再结束账号中心在所有浏览器的登录，并通知 LiteSync 撤销它的网页登录、Obsidian 设备和待领取授权'}
          >
            <Button variant="danger" onClick={() => setLeaving('everywhere')}>
              <ShieldOff className="size-[15px]" />
              退出所有产品…
            </Button>
          </Row>
        )}
        {revocations && <RevocationHistory status={revocations} onChange={setRevocations} />}
      </Group>

      <Dialog
        open={leaving === 'here'}
        onOpenChange={(o) => !o && setLeaving(null)}
        title="退出此设备？"
        description={unsent || (oidc ? '退出后需要重新登录；本设备缓存的配置与最近使用会被清除。账号中心的登录状态不变。' : '退出后需要重新输入访问密码；本设备缓存的配置与最近使用会被清除。')}
        footer={
          <>
            <Button className="h-10 px-[18px]" onClick={() => setLeaving(null)}>
              取消
            </Button>
            <Button variant="primary" className="h-10 px-5" onClick={() => void logout()}>
              退出
            </Button>
          </>
        }
      />

      <Dialog
        open={leaving === 'product'}
        onOpenChange={(o) => !o && !busy && setLeaving(null)}
        width={480}
        title="退出 Nexus 的全部设备？"
        description={unsent || '这个账号在所有浏览器的 Nexus 登录会立即结束；已连接的浏览器扩展、以及已批准但扩展还没领取的授权都会被撤销（扩展下次联网时提示重新连接，未发送的收藏保留在扩展里）。'}
        footer={
          <>
            <Button className="h-10 px-[18px]" disabled={busy} onClick={() => setLeaving(null)}>
              取消
            </Button>
            <Button variant="danger-solid" className="h-10 px-5" disabled={busy} onClick={() => void run(logoutEverywhere)}>
              全部退出
            </Button>
          </>
        }
      >
        {oidc && (
          <p className="m-0 text-[13px] leading-[1.7] text-ink/66">
            账号中心与 LiteSync 不受影响：仍登录着账号中心的浏览器可以不输密码直接重新进入 Nexus。要连它们一起退出，请用「退出所有产品与设备」。
          </p>
        )}
      </Dialog>

      <Dialog
        open={leaving === 'everywhere'}
        onOpenChange={(o) => !o && !busy && setLeaving(null)}
        width={520}
        title="退出所有产品与设备？"
        description={unsent || '会依次执行三步，并逐项告诉你结果；任何一步没有完成都会如实显示，不会说「全部完成」。'}
        footer={
          <>
            <Button className="h-10 px-[18px]" disabled={busy} onClick={() => setLeaving(null)}>
              取消
            </Button>
            <Button variant="danger-solid" className="h-10 px-5" disabled={busy} onClick={() => void run(revokeAllProducts)}>
              {busy ? '正在退出…' : '退出所有产品'}
            </Button>
          </>
        }
      >
        <ol className="m-0 flex flex-col gap-1.5 pl-5 text-[13px] leading-[1.7] text-ink/72">
          <li>Nexus：结束所有浏览器的登录，撤销已连接的扩展和尚未领取的扩展授权（立即生效）。</li>
          <li>账号中心：结束你在所有浏览器的账号中心登录，之后登录任何产品都要重新输入密码。</li>
          <li>LiteSync：通知它撤销你的网页登录、Obsidian 设备和尚未兑换的连接授权。暂时连不上时会在后台继续重试，状态在这一页可以看到。</li>
        </ol>
        {peerMissing && <p className="m-0 mt-2 text-[13px] leading-[1.7] text-warn">本部署没有配置跨产品撤销（NEXUS_PEER_REVOCATION_URL / NEXUS_PEER_REVOCATION_SECRET）：第 3 步不会发生，结果里会如实显示为「未配置」。</p>}
      </Dialog>

      <Dialog
        open={linking}
        onOpenChange={setLinking}
        width={480}
        title="绑定统一账号？"
        description="接下来会打开账号中心，请登录（或注册）你要绑定的统一账号。绑定后这个管理员账号用统一账号登录，访问密码登录随之关闭（部署设置为自动时）。一个统一账号只能绑定一个 Nexus 账号，已有 Nexus 账号的统一账号不能用来绑定。"
        footer={
          <>
            <Button className="h-10 px-[18px]" onClick={() => setLinking(false)}>
              取消
            </Button>
            <Button variant="primary" className="h-10 px-5" onClick={() => (navigator.onLine ? location.assign('/auth/link/start') : toast({ msg: AUTH_OFFLINE, tone: 'error' }))}>
              前往账号中心
            </Button>
          </>
        }
      />
    </>
  );
}
