import type { AdminRevocationStatus, AdminUser, AuthOptions, InviteResponse } from '@nexus/shared';
import { Copy, TicketPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from '../../../components/toast-store';
import { adminApi, authOptions, useAccount } from '../../../data/config-store';
import { formatAgo } from '../../../lib/time';
import { Button, Dialog, Group, Row, Spinner, Tag } from '../ui';

const MODE: Record<AuthOptions['registration'], string> = {
  closed: '暂未开放注册：只有已有账号能登录（NEXUS_REGISTRATION_MODE=closed）',
  invite: '仅限受邀：新账号第一次进入需要一次性邀请码（NEXUS_REGISTRATION_MODE=invite）',
  open: '开放注册：验证邮箱后即可建立账号（NEXUS_REGISTRATION_MODE=open）',
};

/**
 * 账号与邀请 (v0.4, administrators of a deployment with unified sign-in): who has an account,
 * invitations for invite-only registration, and disabling an account (ends its sessions and
 * devices now). Roles come only from this server — never from the identity service.
 */
export function AdminAccountsSection() {
  const me = useAccount();
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [invite, setInvite] = useState<InviteResponse | null>(null);
  const [disabling, setDisabling] = useState<AdminUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [revocation, setRevocation] = useState<AdminRevocationStatus | null>(null);
  const admin = me?.role === 'admin';

  useEffect(() => {
    if (!admin) return;
    authOptions().then(setOptions, () => setOptions(null));
    adminApi.users().then(setUsers, () => setUsers([]));
    adminApi.revocationStatus().then(setRevocation, () => setRevocation(null));
  }, [admin]);

  if (!admin || !options?.oidc) return null;

  const newInvite = async () => {
    setBusy(true);
    try {
      setInvite(await adminApi.invite(7));
    } catch {
      toast({ msg: '没有生成邀请码，请重试', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const setDisabled = async (u: AdminUser, disabled: boolean) => {
    setBusy(true);
    try {
      await adminApi.setDisabled(u.id, disabled);
      setUsers((list) => list?.map((x) => (x.id === u.id ? { ...x, disabled } : x)) ?? null);
      toast({ msg: disabled ? `已停用 ${u.email || u.displayName}，其登录与扩展已失效` : `已恢复 ${u.email || u.displayName}`, tone: 'ok' });
      setDisabling(null);
    } catch {
      toast({ msg: '操作没有完成，请重试', tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast({ msg: '已复制邀请码', tone: 'ok' });
    } catch {
      toast({ msg: '无法访问剪贴板，请手动选中复制', tone: 'error' });
    }
  };

  return (
    <>
      <Group title="账号与邀请">
        <Row label="注册方式" sub={MODE[options.registration]} />
        {revocation && <RevocationConfig status={revocation} />}
        {options.registration === 'invite' && (
          <Row label="邀请码" sub="一次性，7 天内有效；只在生成时显示一次，服务端只保存它的哈希">
            <Button disabled={busy} onClick={() => void newInvite()}>
              <TicketPlus className="size-[15px]" />
              生成邀请码
            </Button>
          </Row>
        )}
        {users === null ? (
          <Row label={<span className="flex items-center gap-2.5"><Spinner />正在读取账号…</span>} />
        ) : (
          users.map((u) => (
            <Row
              key={u.id}
              label={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 break-all">{u.email || u.displayName || u.id}</span>
                  {u.isAdmin && <Tag tone="amber">管理员</Tag>}
                  {u.disabled && <Tag tone="warn">已停用</Tag>}
                  {!u.linked && <Tag>未绑定统一账号</Tag>}
                </span>
              }
              sub={`建立于 ${formatAgo(u.createdAt)}${u.lastLoginAt ? ` · 最近登录 ${formatAgo(u.lastLoginAt)}` : ''}${u.emailVerified ? '' : ' · 邮箱未验证'}`}
            >
              {u.id !== me?.account.id &&
                (u.disabled ? (
                  <Button disabled={busy} onClick={() => void setDisabled(u, false)}>
                    恢复
                  </Button>
                ) : (
                  <Button variant="danger" disabled={busy} onClick={() => setDisabling(u)}>
                    停用…
                  </Button>
                ))}
            </Row>
          ))
        )}
      </Group>

      <Dialog
        open={!!invite}
        onOpenChange={(o) => !o && setInvite(null)}
        width={480}
        title="邀请码已生成"
        description={invite ? `把它发给受邀的人：在登录页填写邀请码，再用统一账号登录或注册。${new Date(invite.expiresAt).toLocaleDateString('zh-CN')} 前有效，用过一次即失效。关闭后无法再次查看。` : ''}
        footer={
          <Button variant="primary" className="h-10 px-5" onClick={() => setInvite(null)}>
            完成
          </Button>
        }
      >
        {invite && (
          <div className="flex items-center gap-2.5">
            <code className="min-w-0 flex-1 rounded-xl bg-ink/5 px-3.5 py-3 font-mono text-[14px] break-all text-amber-hi select-all" aria-label="邀请码">
              {invite.code}
            </code>
            <Button onClick={() => void copy(invite.code)} aria-label="复制邀请码">
              <Copy className="size-[15px]" />
            </Button>
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!disabling}
        onOpenChange={(o) => !o && !busy && setDisabling(null)}
        title={disabling ? `停用 ${disabling.email || disabling.displayName}？` : ''}
        description="这个账号在所有浏览器的登录会立即结束，已连接的扩展被撤销，之后也不能再登录 Nexus。数据保留，可以随时恢复。它在账号中心的账号不受影响。"
        footer={
          <>
            <Button className="h-10 px-[18px]" disabled={busy} onClick={() => setDisabling(null)}>
              取消
            </Button>
            <Button variant="danger-solid" className="h-10 px-5" disabled={busy} onClick={() => disabling && void setDisabled(disabling, true)}>
              停用
            </Button>
          </>
        }
      />
    </>
  );
}

/** Why a delivery to the other product failed, for the administrator (ADR-019 §6). */
const DELIVERY: Record<string, string> = {
  signature_rejected: '对方拒绝了签名：两边的撤销密钥不一致，请核对 NEXUS_PEER_REVOCATION_SECRET 与 LiteSync 的 OBSYNC_PEER_REVOCATION_SECRET',
  rejected: '对方拒绝了事件（版本或格式不符，或对方还没有这个接口）',
  expired: '7 天内一直没有送达',
  network: '连不上对方（地址或网络）',
  timeout: '对方没有及时回答',
  server_error: '对方的服务端出错',
  rate_limited: '对方限流',
};
const CHECK: Record<string, string> = {
  forbidden: '服务账号没有权限：realm 里需要给 nexus-web 的服务账号授予 realm-management 的 view-users，并加进它的作用域映射（./configure.sh revocation）',
  token: '拿不到服务账号令牌：nexus-web 没有开启服务账号（./configure.sh revocation）',
  unauthorized: '服务账号令牌被拒绝',
  network: '连不上身份服务',
  timeout: '身份服务没有及时回答',
  server_error: '身份服务出错',
  bad_response: '身份服务的回答无法识别（管理接口地址可能不对：NEXUS_IDENTITY_ADMIN_URL）',
};

/**
 * ADR-019：跨产品撤销与中心停用检查的配置状态。没有配置时如实写出后果——开放公众注册前必须配置。
 */
function RevocationConfig({ status }: { status: AdminRevocationStatus }) {
  const p = status.peer;
  const c = status.centralCheck;
  return (
    <>
      <Row
        label={<span className={p.configured && !p.failed ? '' : 'text-warn'}>跨产品撤销{p.configured ? '：已配置' : '：未配置'}</span>}
        sub={
          p.configured
            ? `用户在 Nexus 选择「退出所有产品与设备」时通知 LiteSync，LiteSync 发来的撤销也会执行。最近 7 天：等待送达 ${p.pending} 条，失败 ${p.failed} 条${p.lastError ? `；最近的问题：${DELIVERY[p.lastError] ?? p.lastError}` : ''}`
            : '「退出所有产品与设备」只能退出 Nexus 和账号中心，不会通知 LiteSync；LiteSync 发来的撤销也会被拒绝。配置 NEXUS_PEER_REVOCATION_URL 与 NEXUS_PEER_REVOCATION_SECRET（与 LiteSync 相同的 32 字节以上随机值）'
        }
      />
      <Row
        label={<span className={c.configured && !c.lastError ? '' : 'text-warn'}>中心停用检查{c.configured ? '：已开启' : '：未开启'}</span>}
        sub={
          c.configured
            ? `在账号中心停用或删除的账号，Nexus 的登录与扩展最迟 60 秒内失效。${c.lastError ? `最近一次检查失败：${CHECK[c.lastError] ?? c.lastError}（身份服务不可用超过 15 分钟时，扩展请求会暂停并保留待发内容）` : '最近的检查正常'}`
            : '在账号中心停用或删除账号后，Nexus 的网页登录最迟 5 分钟内经复核结束，但已连接的扩展仍然有效，需要在这里停用账号才会撤销。开放公众注册前必须开启：NEXUS_IDENTITY_STATUS_CHECK=on'
        }
      />
    </>
  );
}
