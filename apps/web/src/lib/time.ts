const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

export function formatDate(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
}

export function formatClock(d: Date, mode: '24' | '12', seconds: boolean): string {
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = seconds ? `:${String(d.getSeconds()).padStart(2, '0')}` : '';
  if (mode === '24') return `${d.getHours()}:${mm}${ss}`;
  const h = d.getHours() % 12 || 12;
  return `${d.getHours() < 12 ? '上午' : '下午'} ${h}:${mm}${ss}`;
}

export function formatAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return '刚刚';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const days = Math.floor(h / 24);
  return days === 1 ? '昨天' : `${days} 天前`;
}

export function formatHm(at: number): string {
  const d = new Date(at);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
