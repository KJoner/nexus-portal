import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router';

/** Batch 2 replaces this with the R2 settings centre. */
export function SettingsPlaceholder() {
  return (
    <div className="fixed inset-0 grid place-items-center bg-base p-6">
      <div className="flex max-w-md flex-col items-start gap-4 rounded-[20px] bg-ink/[0.045] p-7 shadow-[inset_0_0_0_1px_rgba(239,234,225,0.05)]">
        <h1 className="m-0 text-[22px] font-medium">设置中心</h1>
        <p className="m-0 text-[14px] leading-[1.7] text-ink/60">设置中心在第二批开发中实现。目前可以在首页通过右键菜单（手机长按）固定、隐藏和排序快捷方式，更改会保存在本浏览器。</p>
        <Link to="/" className="flex h-10 items-center gap-2 rounded-xl bg-ink/9 px-4 text-[13.5px] text-ink no-underline hover:bg-ink/15">
          <ArrowLeft className="size-4" />
          返回首页
        </Link>
      </div>
    </div>
  );
}
