import { hostOf, slug, TONES, UNFILED, type Category, type Icon } from '@nexus/shared';
import { ChevronDown, Upload, X } from 'lucide-react';
import { Dialog as RDialog } from 'radix-ui';
import { useEffect, useId, useState, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { uploadIcon, useConfigStore } from '../../data/config-store';
import { libraryIconUrl } from '../../icons/glyphs';
import { cn } from '../../lib/cn';
import { Segmented, Spinner } from '../settings/ui';
import { pathLabel } from './model';

/**
 * Building blocks of the 我的收藏 dialogs (UI v2): one modal that is a centred panel on a desktop
 * and a full-screen sheet on a phone (focus trapped and returned by Radix, Escape closes), and the
 * form controls the editor and the add dialog share. Colours are theme tokens (light and dark).
 */
export function Modal({ open, onClose, title, eyebrow, width, phone, children, footer, label }: { open: boolean; onClose(): void; title: ReactNode; eyebrow?: ReactNode; width: number; phone: boolean; children: ReactNode; footer?: ReactNode; label?: string }) {
  // What had the focus when the dialog was asked for (before a field inside takes it), so closing
  // gives it back there — the dialog's own record would be that field once it is gone.
  const [opener] = useState(() => (typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)));
  return (
    <RDialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-30 animate-[nx-fade_.2s_ease]" style={{ background: 'rgb(var(--nx-s0-rgb)/0.55)' }} />
        <RDialog.Content
          // A given label names the dialog (e.g. 编辑「GitHub」), not only its short title.
          aria-label={label}
          {...(label ? { 'aria-labelledby': undefined } : {})}
          onCloseAutoFocus={(e) => {
            if (opener && opener.isConnected && opener !== document.body) {
              e.preventDefault();
              opener.focus();
            }
          }}
          onEscapeKeyDown={(e) => {
            // An IME composition ends with Escape: never close the dialog then.
            if ((e as unknown as KeyboardEvent).isComposing) e.preventDefault();
          }}
          className={cn('fixed z-31 box-border flex flex-col overflow-hidden text-ink', phone ? 'inset-0' : 'top-1/2 left-1/2 max-h-[calc(100dvh-48px)] max-w-[calc(100vw-48px)] -translate-1/2 animate-pop rounded-[22px]')}
          style={{ ...(phone ? { height: '100dvh' } : { width }), background: 'rgb(var(--nx-s4-rgb)/0.99)', boxShadow: phone ? 'none' : '0 40px 100px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)' }}
        >
          <header className={cn('flex flex-none items-center gap-3 border-b border-ink/8', phone ? 'px-4 pb-3' : 'px-7 pt-6 pb-5')} style={phone ? { paddingTop: 'calc(env(safe-area-inset-top) + 10px)' } : undefined}>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {eyebrow && <span className="text-[11.5px] tracking-[0.06em] text-ink/50">{eyebrow}</span>}
              <RDialog.Title className={cn('m-0 font-semibold tracking-[-0.01em]', phone ? 'text-[19px]' : 'text-[22px]')}>{title}</RDialog.Title>
              <RDialog.Description className="sr-only">{typeof title === 'string' ? title : label}</RDialog.Description>
            </div>
            <button type="button" onClick={onClose} aria-label="关闭" className={cn('grid flex-none place-items-center rounded-full border-0 bg-ink/7 text-ink/80 hover:bg-ink/14', phone ? 'size-11' : 'size-10')}>
              <X className="size-[18px]" />
            </button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
          {footer}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

const fieldStyle = (error?: boolean) => ({ background: 'rgb(var(--nx-ink-rgb)/0.05)', boxShadow: error ? 'inset 0 0 0 1.5px rgb(var(--nx-error-rgb)/0.75)' : 'inset 0 0 0 1px rgb(var(--nx-ink-rgb)/0.1)' });

export function TextField({ label, value, onChange, onBlur, placeholder, error, hint, required, mono, inputMode, autoFocus, phone, maxLength, onPaste, id: given }: { label: ReactNode; value: string; onChange(v: string): void; onBlur?(): void; placeholder?: string; error?: string; hint?: ReactNode; required?: boolean; mono?: boolean; inputMode?: 'url' | 'text'; autoFocus?: boolean; phone?: boolean; maxLength?: number; onPaste?(text: string): void; id?: string }) {
  const auto = useId();
  const id = given ?? auto;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-ink/80">
        {label}
        {required && <span className="ml-1 text-amber" aria-hidden>*</span>}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onPaste={onPaste ? (e) => onPaste(e.clipboardData.getData('text')) : undefined}
        placeholder={placeholder}
        aria-invalid={!!error}
        aria-required={required || undefined}
        aria-describedby={error || hint ? `${id}-note` : undefined}
        inputMode={inputMode}
        autoFocus={autoFocus}
        maxLength={maxLength}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        className={cn('box-border h-11 rounded-[10px] border-0 px-3.5 text-ink caret-amber outline-none placeholder:text-ink/38 focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-amber)]', mono ? 'font-mono text-[13px]' : phone ? 'text-[16px]' : 'text-[14px]')}
        style={fieldStyle(!!error)}
      />
      {(error || hint) && (
        <span id={`${id}-note`} className={cn('text-[12.5px] leading-[1.6]', error ? 'text-danger-ink' : 'text-ink/52')}>
          {error ?? hint}
        </span>
      )}
    </div>
  );
}

export function TextArea({ label, value, onChange, hint, phone, ...rest }: { label: ReactNode; value: string; onChange(v: string): void; hint?: ReactNode; phone?: boolean } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-ink/80">
        {label}
      </label>
      <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={3} {...rest} className={cn('box-border min-h-[88px] resize-y rounded-[10px] border-0 px-3.5 py-2.5 leading-[1.6] text-ink caret-amber outline-none placeholder:text-ink/38', phone ? 'text-[16px]' : 'text-[14px]')} style={fieldStyle()} />
      {hint && <span className="text-[12.5px] leading-[1.6] text-ink/52">{hint}</span>}
    </div>
  );
}

/** The group a favorite goes into: every group with its full path (a leaf name can repeat under different parents). */
export function GroupSelect({ categories, value, onChange, label = '分组', phone, id: given }: { categories: readonly Category[]; value: string; onChange(id: string): void; label?: string; phone?: boolean; id?: string }) {
  const auto = useId();
  const id = given ?? auto;
  const options = [...categories.filter((c) => c.id !== UNFILED).map((c) => ({ id: c.id, label: pathLabel(categories, c.id) })), { id: UNFILED, label: '未分组' }];
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-ink/80">
        {label}
      </label>
      <div className="relative">
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={cn('box-border h-11 w-full appearance-none rounded-[10px] border-0 pr-9 pl-3.5 text-ink outline-none', phone ? 'text-[16px]' : 'text-[14px]')} style={fieldStyle()}>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-ink/50" />
      </div>
    </div>
  );
}

/** A labelled on/off row (固定到首页, 自托管服务…). */
export function ToggleRow({ label, sub, checked, onChange, disabled, phone }: { label: ReactNode; sub?: ReactNode; checked: boolean; onChange(v: boolean): void; disabled?: boolean; phone?: boolean }) {
  const id = useId();
  const [w, h, k, pad] = phone ? [51, 31, 27, 2] : [42, 24, 18, 3];
  return (
    <div className={cn('flex items-center gap-4', disabled && 'opacity-55')}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={id} className="text-[13.5px] font-medium text-ink/86">
          {label}
        </span>
        {sub && <span className="text-[12.5px] leading-[1.55] text-ink/52">{sub}</span>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="relative flex-none rounded-full border-0 p-0 transition-colors duration-200 disabled:cursor-default"
        style={{ width: w, height: h, background: checked ? 'var(--color-amber)' : 'var(--nx-switch-off)' }}
      >
        <span className="absolute rounded-full bg-[#fbfaf7] transition-transform duration-200 ease-soft" style={{ top: pad, left: pad, width: k, height: k, boxShadow: '0 1px 3px rgba(0,0,0,.3)', transform: checked ? `translateX(${w - k - pad * 2}px)` : 'none' }} />
      </button>
    </div>
  );
}

/** 更多选项 / 服务选项: closed by default, the summary says what is inside. */
export function Section({ title, summary, open, onToggle, children }: { title: string; summary?: string; open: boolean; onToggle(): void; children: ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col border-t border-ink/8">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle} className="flex min-h-12 items-center gap-2.5 border-0 bg-transparent px-0 text-left text-ink">
        <span className="text-[13.5px] font-medium">{title}</span>
        {summary && !open && <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink/48">{summary}</span>}
        <span className="flex-1" />
        <ChevronDown aria-hidden className={cn('size-4 flex-none text-ink/52 transition-transform duration-150', open && 'rotate-180')} />
      </button>
      <div id={id} hidden={!open} className="flex flex-col gap-4 pb-5">
        {children}
      </div>
    </div>
  );
}

/** Short words a favorite is also found by (Enter or a comma adds one). */
export function ChipsField({ label, values, onChange, max, maxLength, placeholder, hint, phone }: { label: string; values: string[]; onChange(v: string[]): void; max: number; maxLength: number; placeholder: string; hint?: ReactNode; phone?: boolean }) {
  const [text, setText] = useState('');
  const id = useId();
  const add = () => {
    const parts = text
      .split(/[,，、]/)
      .map((s) => s.trim().slice(0, maxLength))
      .filter(Boolean);
    if (!parts.length) return;
    const next = [...values];
    for (const p of parts) if (!next.includes(p) && next.length < max) next.push(p);
    onChange(next);
    setText('');
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-ink/80">
        {label}
      </label>
      <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-[10px] px-2 py-1.5" style={fieldStyle()}>
        {values.map((v) => (
          <span key={v} className="inline-flex h-7 items-center gap-1 rounded-md bg-ink/10 pr-1 pl-2 text-[12.5px] text-ink/86">
            {v}
            <button type="button" aria-label={`移除 ${v}`} onClick={() => onChange(values.filter((x) => x !== v))} className="grid size-6 place-items-center rounded border-0 bg-transparent text-ink/55 hover:text-ink">
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add();
            } else if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1));
          }}
          onBlur={add}
          disabled={values.length >= max}
          placeholder={values.length >= max ? `最多 ${max} 个` : placeholder}
          className={cn('h-8 min-w-[8em] flex-1 border-0 bg-transparent px-1.5 text-ink caret-amber outline-none placeholder:text-ink/38', phone ? 'text-[16px]' : 'text-[13.5px]')}
        />
      </div>
      {hint && <span className="text-[12.5px] leading-[1.6] text-ink/52">{hint}</span>}
    </div>
  );
}

/** 图标: from the site (default), the icon library, an upload, or a letter on a colour. */
export function IconField({ icon, name, url, onChange, phone }: { icon: Icon; name: string; url: string; onChange(i: Icon): void; phone?: boolean }) {
  const [libQ, setLibQ] = useState(() => (icon.source === 'library' ? icon.ref : slug(name)));
  const [libMiss, setLibMiss] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const space = useConfigStore((s) => s.space);
  const cacheIcons = useConfigStore((s) => s.snapshot.config.settings.privacy.cacheIcons);
  useEffect(() => {
    if (icon.source !== 'library' || !libQ.trim()) return;
    const ref = libQ.trim().toLowerCase();
    const t = setTimeout(() => {
      const img = new Image();
      img.onload = () => {
        setLibMiss(false);
        if (icon.ref !== ref) onChange({ ...icon, ref });
      };
      img.onerror = () => setLibMiss(true);
      img.src = libraryIconUrl(ref, space === 'account' && cacheIcons);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libQ, icon.source]);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(svg\+xml|png|webp)$/.test(file.type)) return setErr('请使用 SVG、PNG 或 WebP');
    if (file.size > 1024 * 1024) return setErr(`文件为 ${(file.size / 1048576).toFixed(1)} MB，超过 1 MB 上限`);
    setBusy(true);
    setErr('');
    try {
      onChange({ ...icon, source: 'upload', ref: await uploadIcon(file) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : '上传失败');
    } finally {
      setBusy(false);
    }
  };
  const source = icon.source === 'builtin' ? 'auto' : icon.source;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-medium text-ink/80">图标</span>
      <Segmented
        className="self-start"
        label="图标来源"
        value={source}
        options={[
          { value: 'auto', label: '网站图标' },
          { value: 'library', label: '图标库' },
          { value: 'upload', label: '上传' },
          { value: 'letter', label: '字母' },
        ]}
        onChange={(s) => {
          setErr('');
          onChange({ ...icon, source: s, ref: s === 'library' ? libQ : s === 'upload' ? (icon.source === 'upload' ? icon.ref : '') : s === 'auto' ? '' : icon.ref });
        }}
      />
      {source === 'auto' && <span className="text-[12.5px] leading-[1.6] text-ink/52">从 {hostOf(url) || '网址'} 读取网站图标；读取失败时显示首字母。</span>}
      {source === 'library' && (
        <>
          <input value={libQ} onChange={(e) => setLibQ(e.target.value)} placeholder="图标名，例如 jellyfin" aria-label="图标名" spellCheck={false} autoCapitalize="off" className={cn('box-border h-10 rounded-[10px] border-0 px-3 font-mono text-ink outline-none', phone ? 'text-[16px]' : 'text-[12.5px]')} style={fieldStyle()} />
          <span className={cn('text-[12.5px]', libMiss ? 'text-danger-ink' : 'text-ink/52')}>{libMiss ? `图标库中没有「${libQ}」，试试英文名，或改用上传 / 字母` : libQ.trim() ? `已匹配 ${libQ.trim().toLowerCase()}.svg` : '输入图标名'}</span>
        </>
      )}
      {source === 'upload' && (
        <>
          <label className="box-border flex h-12 cursor-pointer items-center gap-3 rounded-[10px] border-[1.5px] border-dashed border-ink/24 px-4 text-[13px] text-ink/72 hover:bg-ink/4">
            <input type="file" accept="image/svg+xml,image/png,image/webp" className="sr-only" onChange={(e) => void upload(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
            {busy ? <Spinner /> : <Upload className="size-4" />}
            {busy ? '正在处理…' : icon.ref ? '已上传 · 点击更换' : '选择 SVG / PNG / WebP · ≤ 1 MB'}
          </label>
          {err && <span className="text-[12.5px] text-danger-ink">{err}</span>}
        </>
      )}
      {source === 'letter' && (
        <div className="flex flex-wrap items-center gap-2.5">
          <input value={icon.letter} maxLength={2} onChange={(e) => onChange({ ...icon, letter: e.target.value.slice(0, 2) })} placeholder={(name || 'N').slice(0, 1)} aria-label="图标字母" className="box-border h-10 w-[64px] rounded-[10px] border-0 text-center text-[15px] text-ink outline-none" style={fieldStyle()} />
          {TONES.map((t, i) => (
            <button
              key={t[0]}
              type="button"
              aria-label={`色调 ${i + 1}`}
              aria-pressed={icon.tone === i}
              onClick={() => onChange({ ...icon, tone: i })}
              className={cn('border-0', phone ? 'size-11 rounded-xl' : 'size-8 rounded-[9px]')}
              style={{ background: `linear-gradient(180deg,${t[0]},${t[1]})`, boxShadow: icon.tone === i ? '0 0 0 2px var(--nx-option-bg), 0 0 0 4px var(--color-amber)' : 'inset 0 0 0 1px rgb(var(--nx-ink-rgb)/0.14)' }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export const pinCapacityText = (used: number, limit: number) => `首页已固定 ${used} / ${limit} 个`;
