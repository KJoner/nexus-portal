import type { IdentityCenterError, PeerRevocationState, RevokeEverywhereResponse } from '@nexus/shared';
import { CircleAlert, CircleCheck, Clock, ExternalLink } from 'lucide-react';
import { formatHm } from '../../lib/time';

/** Why the identity-service part of 退出所有产品与设备 did not happen, in words (ADR-019 §6). */
export const IDENTITY_CENTER_ERRORS: Record<IdentityCenterError, string> = {
  not_configured: '本部署没有配置统一身份。',
  no_identity: '这个账号没有绑定统一账号。',
  no_identity_session: '这个浏览器是用访问密码登录的，没有可用的账号中心会话，无法替你结束账号中心的登录。',
  session_expired: '这个浏览器的账号中心会话已经结束或过期，无法确认其他浏览器的登录也已结束。',
  forbidden: '账号中心拒绝了请求：身份服务还没有授予「管理自己的账号」权限（管理员需要按 infra/identity 的说明更新 realm）。',
  not_supported: '身份服务不支持按账号结束全部会话。',
  unavailable: '暂时连不上账号中心。',
};

/** Error categories of a cross-product revocation event (never a token or an address). */
export const PEER_ERRORS: Record<string, string> = {
  network: '连不上对方的服务端',
  timeout: '对方没有及时回答',
  server_error: '对方的服务端暂时出错',
  rate_limited: '对方暂时限流',
  signature_rejected: '对方拒绝了签名：两边的撤销密钥不一致，需要管理员核对',
  rejected: '对方拒绝了这条事件（格式或版本不符）',
  expired: '7 天内一直没有送达',
};

const PRODUCT: Record<string, string> = { litesync: 'LiteSync', nexus: 'Nexus' };

export function peerLine(p: PeerRevocationState): { tone: 'ok' | 'warn' | 'error'; text: string } {
  const name = PRODUCT[p.product] ?? p.product;
  if (p.state === 'not_configured') return { tone: 'warn', text: `${name}：本部署没有配置跨产品撤销，${name} 没有收到通知。请到 ${name} 的账户页执行「退出本产品的全部设备」。` };
  if (p.state === 'delivered') return { tone: 'ok', text: p.result === 'unknown-identity' ? `${name}：已送达（${name} 中没有这个账号，没有需要撤销的内容）` : `${name}：已送达，它的网页登录、设备与待领取授权已撤销` };
  const why = p.error ? PEER_ERRORS[p.error] ?? p.error : '';
  if (p.state === 'pending') return { tone: 'warn', text: `${name}：还没有确认（已尝试 ${p.attempts} 次${why ? `，${why}` : ''}）。会在后台继续重试${p.nextAttemptAt ? `，下次 ${formatHm(Date.parse(p.nextAttemptAt))}` : ''}。` };
  return { tone: 'error', text: `${name}：没有送达${why ? `（${why}）` : ''}，不会再自动重试。登录后可以在「设置 › 数据、同步与安全」重新发送。` };
}

const ICON = { ok: CircleCheck, warn: Clock, error: CircleAlert } as const;
const TONE = { ok: 'text-ok', warn: 'text-warn', error: 'text-danger-ink' } as const;

function Line({ tone, children }: { tone: 'ok' | 'warn' | 'error'; children: React.ReactNode }) {
  const Icon = ICON[tone];
  return (
    <li className="flex items-start gap-2.5">
      <Icon className={`mt-[3px] size-4 flex-none ${TONE[tone]}`} />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/**
 * 退出所有产品与设备的真实结果（ADR-019 R-5）：三部分逐项说明，只有全部完成时才说「全部完成」。
 */
export function RevocationResult({ result, at }: { result: RevokeEverywhereResponse; at?: number }) {
  const l = result.local;
  const ic = result.identityCenter;
  return (
    <section aria-label="退出所有产品与设备的结果" className="flex flex-col gap-2 text-[13px] leading-[1.65] text-ink/80">
      <p className="m-0 font-medium text-ink">{result.ok ? '已退出所有产品与设备' : '已退出 Nexus；其余部分见下方'}{at ? <span className="ml-2 font-normal text-ink/50">{formatHm(at)}</span> : null}</p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        <Line tone="ok">
          Nexus：已完成，结束 {l.revokedSessions} 个网页登录，撤销 {l.revokedDevices} 台已连接的扩展{l.revokedGrants ? `和 ${l.revokedGrants} 个尚未领取的扩展授权` : ''}
        </Line>
        {ic.state === 'done' ? (
          <Line tone="ok">账号中心：已结束你在所有浏览器的登录</Line>
        ) : (
          <Line tone="error">
            账号中心：没有完成。{IDENTITY_CENTER_ERRORS[ic.error]}
            {ic.accountUrl && (
              <>
                请打开
                <a href={ic.accountUrl} target="_blank" rel="noopener noreferrer" className="mx-1 inline-flex items-center gap-1 text-amber-hi">
                  账号中心
                  <ExternalLink className="size-3" />
                </a>
                在「设备活动」中退出所有设备。
              </>
            )}
          </Line>
        )}
        {result.peers.map((p) => {
          const line = peerLine(p);
          return (
            <Line key={p.product} tone={line.tone}>
              {line.text}
            </Line>
          );
        })}
      </ul>
    </section>
  );
}
