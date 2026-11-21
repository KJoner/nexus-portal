import type { AuthOptions } from '@nexus/shared';
import { ExternalLink, KeyRound, LogOut, MonitorX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from '../../../components/toast-store';
import { authOptions, logout, logoutEverywhere, useAccount, useSaveState } from '../../../data/config-store';
import { AUTH_ERRORS } from '../../auth/LoginPage';
import { Button, Dialog, Group, Row, Tag } from '../ui';

/** Messages for the claim flow, which returns here (`/settings/data?auth_error=…`). */
const LINK_ERRORS: Record<string, string> = {
  ...AUTH_ERRORS,
  already_linked: '这个账号已经绑定了统一账号。',
};

/**
 * 账号与登录 (v0.4): who is signed in, the identity service's account console, 旧管理员认领, and
 * the two ways out — this browser only, or every session and device of the account.
 */
export function AccountSection() {
  const me = useAccount();
  const save = useSaveState();
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [leaving, setLeaving] = useState<'here' | 'everywhere' | null>(null);
  const [linking, setLinking] = useState(false);
  const [busy, setBusy] = useState(false);

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
  const unsent = save.kind === 'offline' && save.pending ? `还有 ${save.pending} 项更改没有同步到服务端，退出后会丢失。` : '';

  const everywhere = async () => {
    setBusy(true);
    try {
      const end = await logoutEverywhere();
      // Unified sign-in: end this browser's identity-service session too.
      if (end) location.assign(end);
    } catch {
      toast({ msg: '没有完成，请检查网络后重试', tone: 'error' });
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
          <Row label="管理统一账号" sub="在账号中心修改登录密码和邮箱，查看并退出各设备上的登录">
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
        <Row label="退出此设备" sub="只退出这个浏览器；本设备缓存的配置与最近使用会被清除">
          <Button onClick={() => setLeaving('here')}>
            <LogOut className="size-[15px]" />
            退出
          </Button>
        </Row>
        <Row label="退出全部设备" sub="结束这个账号在所有浏览器的 Nexus 登录，并撤销已连接的浏览器扩展">
          <Button variant="danger" onClick={() => setLeaving('everywhere')}>
            <MonitorX className="size-[15px]" />
            全部退出…
          </Button>
        </Row>
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
        open={leaving === 'everywhere'}
        onOpenChange={(o) => !o && !busy && setLeaving(null)}
        width={480}
        title="退出全部设备？"
        description={unsent || '这个账号在所有浏览器的 Nexus 登录都会立即结束，已连接的浏览器扩展会被撤销（它们下次联网时清除缓存）。'}
        footer={
          <>
            <Button className="h-10 px-[18px]" disabled={busy} onClick={() => setLeaving(null)}>
              取消
            </Button>
            <Button variant="danger-solid" className="h-10 px-5" disabled={busy} onClick={() => void everywhere()}>
              全部退出
            </Button>
          </>
        }
      >
        {oidc && (
          <p className="m-0 text-[13px] leading-[1.7] text-ink/66">
            这个浏览器也会退出账号中心。其他浏览器如果仍登录着账号中心，可以不输密码直接重新进入 Nexus；要连那里也一并退出，请在
            {accountUrl ? (
              <a href={accountUrl} target="_blank" rel="noopener noreferrer" className="mx-1 text-amber-hi">
                账号中心
              </a>
            ) : (
              '账号中心'
            )}
            的「设备活动」中退出所有设备。
          </p>
        )}
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
            <Button variant="primary" className="h-10 px-5" onClick={() => location.assign('/auth/link/start')}>
              前往账号中心
            </Button>
          </>
        }
      />
    </>
  );
}
