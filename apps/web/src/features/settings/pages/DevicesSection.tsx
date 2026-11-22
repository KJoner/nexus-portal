import { DEVICE_SCOPE_LABELS, PAIR_CODE, type DeviceInfo, type DeviceScope, type PairingRequest } from '@nexus/shared';
import { Puzzle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from '../../../components/toast-store';
import { devicesApi } from '../../../data/config-store';
import { formatAgo } from '../../../lib/time';
import { Button, Dialog, Group, Row, Spinner, Switch, Tag } from '../ui';

const errorText = (e: unknown) => (e instanceof Error ? e.message : '操作失败');

/** Why an account-wide revocation ended a device (server reason codes, ADR-019). */
const REVOKED_REASON: Record<string, string> = {
  'logout-all': '已在「退出 Nexus 的全部设备」时撤销',
  'all-products': '已在「退出所有产品与设备」时撤销',
  'peer-request': '已在另一个产品中「退出所有产品与设备」时撤销',
  'admin-disabled': '账号被管理员停用时撤销',
  'central-disabled': '账号在账号中心被停用时撤销',
  'account-deleted': '账号在账号中心被删除时撤销',
};

/** What a device may do, in words; an old pairing without scopes is read-only (v0.4 never widens it). */
export function describeScopes(scopes: readonly DeviceScope[] | undefined): string {
  const s = scopes?.length ? scopes : (['config:read'] as const);
  if (s.every((x) => x === 'config:read' || x === 'items:read')) return '只读同步';
  return s.filter((x) => x !== 'config:read').map((x) => DEVICE_SCOPE_LABELS[x]).join('、');
}

/** Browser name and system from a User-Agent, for the approval screen (not a security check). */
export function describeAgent(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '浏览器';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

/**
 * 浏览器扩展: devices paired for read-only sync, and the approval of a new pairing. The extension
 * opens /settings/data?pair=XXXX-XXXX; the request is shown with where it came from, and nothing
 * is granted unless the user confirms that the code matches the one in the extension.
 */
/**
 * v0.5: approving an extension and revoking one are account actions, not data-space ones — a local
 * collection whose browser is signed in passes the account's API (identity.ts) instead.
 */
export function DevicesSection({ api = devicesApi }: { api?: typeof devicesApi } = {}) {
  const [params, setParams] = useSearchParams();
  const code = (params.get('pair') ?? '').toUpperCase();
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [request, setRequest] = useState<PairingRequest | 'missing' | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<DeviceInfo | null>(null);
  // Scopes the user grants: what the extension asked for, minus anything switched off here.
  const [granted, setGranted] = useState<DeviceScope[]>([]);

  const load = () =>
    api.list().then(setDevices, () => {
      setDevices([]);
    });
  useEffect(() => void load(), []);

  useEffect(() => {
    if (!code) return setRequest(null);
    if (!PAIR_CODE.test(code)) return setRequest('missing');
    let live = true;
    api.pairing(code).then(
      (r) => {
        if (!live) return;
        setRequest(r);
        setGranted(r.scopes?.length ? r.scopes : ['config:read']);
      },
      () => live && setRequest('missing'),
    );
    return () => {
      live = false;
    };
  }, [code]);

  const close = () => {
    const next = new URLSearchParams(params);
    next.delete('pair');
    setParams(next, { replace: true });
  };

  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      await api.decide(code, approve, approve ? granted : undefined);
      toast(approve ? { msg: '已允许连接，扩展会在几秒内完成同步', tone: 'ok' } : { msg: '已拒绝连接请求', tone: 'info' });
      close();
      // The device appears once the extension has picked up its token.
      if (approve) setTimeout(() => void load(), 4000);
    } catch (e) {
      toast({ msg: errorText(e), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (d: DeviceInfo) => {
    try {
      setDevices(await api.revoke(d.id));
      toast({ msg: `已撤销「${d.name}」的访问`, tone: 'ok' });
    } catch (e) {
      toast({ msg: errorText(e), tone: 'error' });
    }
    setRevoking(null);
  };

  return (
    <>
      <Group title="浏览器扩展">
        {devices === null ? (
          <Row label={<span className="flex items-center gap-2.5"><Spinner />正在读取…</span>} />
        ) : devices.length ? (
          devices.map((d) =>
            d.revokedAt ? (
              // Revoked by an account-wide revocation (ADR-019): listed for a while, nothing left to do.
              <Row
                key={d.id}
                label={<span className="flex items-center gap-2.5 text-ink/50"><Puzzle className="size-[18px]" />{d.name}<Tag tone="warn">已撤销</Tag></span>}
                sub={`${REVOKED_REASON[d.revokedReason ?? ''] ?? '授权已被撤销'} · ${formatAgo(Date.parse(d.revokedAt))}；扩展下次联网时会提示重新连接`}
              />
            ) : (
              <Row
                key={d.id}
                label={<span className="flex items-center gap-2.5"><Puzzle className="size-[18px] text-ink/60" />{d.name}</span>}
                sub={`${describeScopes(d.scopes)} · 授权于 ${formatAgo(Date.parse(d.createdAt))} · ${d.lastUsedAt ? `最近同步 ${formatAgo(Date.parse(d.lastUsedAt))}` : '尚未同步'}`}
              >
                <Button onClick={() => setRevoking(d)}>撤销</Button>
              </Row>
            ),
          )
        ) : (
          <Row label="还没有连接的扩展" sub="在 Chrome 新标签页扩展中填写本门户的地址，再回到这里确认连接。扩展只能读取导航配置，不能修改设置。" />
        )}
        <Row label="访问范围" sub="每个扩展只能做连接时你批准的事（默认只读：应用、分类、首页设置、图标和壁纸）；拿不到你的登录凭据。「退出 Nexus 的全部设备」「退出所有产品与设备」、更改访问密码或停用账号都会撤销所有扩展，连同已批准但还没领取的授权。" />
      </Group>

      <Dialog
        open={!!request}
        onOpenChange={(o) => !o && close()}
        width={480}
        title={request === 'missing' ? '连接请求不存在或已过期' : request ? `允许「${request.name}」连接？` : ''}
        description={
          request === 'missing'
            ? '连接请求 10 分钟内有效，并且只能确认一次。请在扩展中重新发起连接。'
            : '请先确认下面的连接码与扩展中显示的完全一致；如果不是你本人发起的，请拒绝。允许后，这个扩展只能做下面勾选的事。'
        }
        footer={
          request === 'missing' ? (
            <Button className="h-10 px-[18px]" onClick={close}>
              关闭
            </Button>
          ) : (
            <>
              <Button className="h-10 px-[18px]" disabled={busy} onClick={() => void decide(false)}>
                拒绝
              </Button>
              <Button variant="primary" className="h-10 px-5" disabled={busy} onClick={() => void decide(true)}>
                连接码一致，允许连接
              </Button>
            </>
          )
        }
      >
        {request && request !== 'missing' && (
          <div className="flex flex-col gap-3">
            <div className="rounded-2xl bg-ink/5 py-4 text-center font-mono text-[28px] tracking-[0.18em] text-amber-hi" aria-label="连接码">
              {request.code}
            </div>
            <dl className="m-0 grid grid-cols-[72px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
              <dt className="text-ink/50">发起时间</dt>
              <dd className="m-0">{formatAgo(Date.parse(request.createdAt))}</dd>
              <dt className="text-ink/50">来源地址</dt>
              <dd className="m-0 font-mono text-[12.5px]">{request.ip}</dd>
              <dt className="text-ink/50">浏览器</dt>
              <dd className="m-0">{describeAgent(request.userAgent)}</dd>
            </dl>
            <div className="flex flex-col gap-1 rounded-2xl bg-ink/[0.035] px-3.5 py-2.5" aria-label="申请的权限">
              <span className="text-[12px] text-ink/50">申请的权限</span>
              {(request.scopes?.length ? request.scopes : (['config:read'] as DeviceScope[])).map((s) => (
                <div key={s} className="flex min-h-9 items-center justify-between gap-3 text-[13px]">
                  <span>{DEVICE_SCOPE_LABELS[s]}</span>
                  {s === 'config:read' ? (
                    <span className="text-[12px] text-ink/46">必需</span>
                  ) : (
                    <Switch label={DEVICE_SCOPE_LABELS[s]} checked={granted.includes(s)} onChange={(on) => setGranted((g) => (on ? [...g, s] : g.filter((x) => x !== s)))} />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={revoking ? `撤销「${revoking.name}」？` : ''}
        description="撤销后，这个扩展立即无法再同步，并会在下次联网时清除它缓存的导航数据。需要时可以在扩展中重新连接。"
        footer={
          <>
            <Button className="h-10 px-[18px]" onClick={() => setRevoking(null)}>
              取消
            </Button>
            <Button variant="danger-solid" className="h-10 px-5" onClick={() => revoking && void revoke(revoking)}>
              撤销访问
            </Button>
          </>
        }
      />
    </>
  );
}
