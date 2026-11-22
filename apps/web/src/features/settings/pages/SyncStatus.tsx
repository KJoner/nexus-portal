import { Cloud, CloudOff } from 'lucide-react';
import { useState } from 'react';
import { toast } from '../../../components/toast-store';
import { discardHeld, resolveHeld, retryHeld, useConfigStore, useSaveState, type ConflictChoice, type HeldBatch } from '../../../data/config-store';
import { formatHm } from '../../../lib/time';
import { Button, Dialog, Group, Row, useCompact } from '../ui';

/**
 * 同步 of an account's collection (moved from 数据、同步与安全 in v0.5): state, changes another device
 * got ahead of (NEX-04), and changes held over a limit (TN-07). A local collection has none of it.
 */
export function SyncStatus() {
  const compact = useCompact();
  const save = useSaveState();
  const revision = useConfigStore((s) => s.confirmed?.revision ?? 0);
  const allHeld = useConfigStore((s) => s.held);
  const held = allHeld.filter((h) => h.reason !== 'conflict');
  const conflicts = allHeld.map((h, index) => ({ h, index })).filter((x) => x.h.reason === 'conflict');
  const [dropping, setDropping] = useState(false);

  const syncRow =
    save.kind === 'offline' ? (
      <Row label={<span className="flex items-center gap-2.5"><CloudOff className="size-[18px] text-warn" />离线</span>} sub={`${save.pending ? `${save.pending} 项更改保存在本设备，` : ''}恢复连接后自动同步`} />
    ) : (
      <Row
        label={<span className="flex items-center gap-2.5"><Cloud className="size-[18px] text-ok" />{save.kind === 'saving' ? '正在同步…' : '已同步到你的账号'}</span>}
        sub={`修订 ${revision}${save.kind === 'saved' && save.at ? ` · 上次写入 ${formatHm(save.at)}` : ''} · 其他设备会在几秒内收到更新`}
      />
    );

  return (
    <>
      <Group title={compact ? '同步' : '账号同步'}>
        {syncRow}
        <Row label="多设备同时修改" sub="按操作合并（如「固定 GitHub」「移动 Notion」），同一网站的不同字段逐项合并；同一字段在别处也改了、或已在别处删除时，这项更改保留在本机由你决定，不会覆盖别处的修改，也不会让删除的收藏自动回来" />
        {conflicts.map(({ h, index }) => (
          <ConflictRow key={`${h.batch.id}-${index}`} held={h} index={index} />
        ))}
        {held.length > 0 && (
          <Row label={<span className="text-warn">{held.length} 项更改因超过上限没有保存</span>} sub={`${held.at(-1)!.message}。这些更改保留在本机：删除一些内容腾出空间后重试，或放弃它们。`}>
            <div className="flex flex-none gap-2">
              <Button
                onClick={() => {
                  const failed = retryHeld().filter((r) => !r.ok).length;
                  toast(failed ? { msg: `仍有 ${failed} 项超过上限，已继续保留`, tone: 'warn' } : { msg: '已重新提交', tone: 'ok' });
                }}
              >
                重试
              </Button>
              <Button variant="danger" onClick={() => setDropping(true)}>
                放弃…
              </Button>
            </div>
          </Row>
        )}
      </Group>
      <Dialog
        open={dropping}
        onOpenChange={setDropping}
        title="放弃未保存的更改？"
        description={`${held.length} 项因超过上限没有保存的更改会从本机删除，无法恢复。`}
        footer={
          <>
            <Button className="h-10 px-[18px]" onClick={() => setDropping(false)}>
              取消
            </Button>
            <Button
              variant="danger-solid"
              className="h-10 px-5"
              onClick={() => {
                discardHeld();
                setDropping(false);
              }}
            >
              放弃
            </Button>
          </>
        }
      />
    </>
  );
}

/** What each kind of conflict lets the person do (NEX-04); every choice is an ordinary, synced change. */
const CHOICES: Record<string, { choice: ConflictChoice; label: string; tone?: 'primary' | 'danger' }[]> = {
  ITEM_DELETED: [
    { choice: 'mine', label: '恢复并应用我的修改', tone: 'primary' },
    { choice: 'copy', label: '另存为新收藏' },
    { choice: 'discard', label: '放弃我的修改', tone: 'danger' },
  ],
  FIELD_CONFLICT: [
    { choice: 'mine', label: '用我的修改', tone: 'primary' },
    { choice: 'copy', label: '另存为新收藏' },
    { choice: 'discard', label: '保留别处的修改', tone: 'danger' },
  ],
  REVISION_CONFLICT: [
    { choice: 'mine', label: '仍然执行', tone: 'primary' },
    { choice: 'discard', label: '保持现状', tone: 'danger' },
  ],
};

const DONE: Record<ConflictChoice, string> = { mine: '已按你的选择重新提交', copy: '已另存为新收藏', discard: '已放弃这项更改' };

/** One change another device got ahead of: what happened, and what to do with it. */
function ConflictRow({ held, index }: { held: HeldBatch; index: number }) {
  const hasEdit = held.batch.ops.some((o) => o.type === 'app.upsert');
  const choices = (CHOICES[held.code ?? ''] ?? CHOICES.REVISION_CONFLICT!).filter((c) => c.choice !== 'copy' || hasEdit);
  const decide = (choice: ConflictChoice) => {
    const r = resolveHeld(index, choice);
    toast(r.ok ? { msg: DONE[choice], tone: 'ok' } : { msg: `没有完成：${r.error.message}`, tone: 'warn' });
  };
  return (
    <Row label={<span className="text-warn">有一项更改与别处的修改冲突</span>} sub={`${held.message}。这项更改保留在本机，直到你决定。`}>
      <div className="flex flex-none flex-wrap gap-2">
        {choices.map((c) => (
          <Button key={c.choice} variant={c.tone === 'danger' ? 'danger' : c.tone === 'primary' ? 'primary' : 'secondary'} onClick={() => decide(c.choice)}>
            {c.label}
          </Button>
        ))}
      </div>
    </Row>
  );
}
