import { Dialog as RDialog } from 'radix-ui';
import { createContext, useContext, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Desktop and mobile settings share components; sizes follow R2 · 组件 (PC / 手机). */
export const CompactContext = createContext(false);
export const useCompact = () => useContext(CompactContext);

export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'amber' | 'warn' }) {
  const t = { neutral: 'bg-ink/10 text-ink/75', amber: 'bg-amber/14 text-amber-hi', warn: 'bg-warn/13 text-[#f1c690]' }[tone];
  return <span className={cn('inline-flex h-5 flex-none items-center rounded-md px-[7px] text-[11px] font-normal whitespace-nowrap', t)}>{children}</span>;
}

export const NotYet = () => <Tag>尚未实现</Tag>;

export function Group({ title, extra, children, className }: { title?: ReactNode; extra?: ReactNode; children: ReactNode; className?: string }) {
  const compact = useCompact();
  return (
    <section className={cn('flex flex-col', compact ? 'gap-2' : 'gap-2.5', className)}>
      {(title || extra) && (
        <div className={cn('flex items-center gap-3', compact ? 'px-4' : 'px-1')}>
          {title && <h2 className={cn('m-0 font-medium text-ink/52', compact ? 'text-[13px] font-normal text-ink/50' : 'text-[12.5px]')}>{title}</h2>}
          {extra}
        </div>
      )}
      <div className={cn('flex flex-col divide-y divide-ink/6 bg-ink/[0.045] shadow-[inset_0_0_0_1px_rgba(239,234,225,0.05)]', compact ? 'rounded-2xl bg-ink/6' : 'rounded-[20px]')}>{children}</div>
    </section>
  );
}

interface RowProps {
  label: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
  disabled?: boolean;
  /** Mobile: put the control under the label (segmented controls, sliders). */
  stacked?: boolean;
  className?: string;
}

export function Row({ label, sub, children, disabled, stacked, className }: RowProps) {
  const compact = useCompact();
  return (
    <div
      className={cn(
        'flex box-border',
        stacked && compact ? 'flex-col gap-2.5 px-4 pt-3 pb-3.5' : cn('items-center', compact ? 'min-h-[52px] gap-3 px-4 py-2' : 'min-h-16 gap-5 px-5 py-3'),
        disabled && 'opacity-60',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className={cn('flex items-center gap-2', compact ? 'text-[15px]' : 'text-[14.5px]')}>{label}</span>
        {sub && <span className={cn('leading-[1.5] text-ink/50', compact ? 'text-[12.5px]' : 'text-[12.5px]')}>{sub}</span>}
      </div>
      {children}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange?: (v: boolean) => void; label: string; disabled?: boolean }) {
  const compact = useCompact();
  const [w, h, k, pad] = compact ? [51, 31, 27, 2] : [44, 26, 20, 3];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className="relative flex-none rounded-full border-0 p-0 transition-colors duration-200 disabled:cursor-default"
      style={{ width: w, height: h, background: checked ? '#e6c08a' : 'rgba(239,234,225,0.16)' }}
    >
      <span
        className="absolute rounded-full transition-transform duration-200 ease-soft"
        style={{ top: pad, left: pad, width: k, height: k, background: disabled ? '#c9c3b8' : '#f7f3ec', boxShadow: disabled ? 'none' : '0 1px 3px rgba(0,0,0,.35)', transform: checked ? `translateX(${w - k - pad * 2}px)` : 'none' }}
      />
    </button>
  );
}

export interface SegOption<T> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

/** 2–4 mutually exclusive options; the selected one is never amber (R2 · 分段控件). */
export function Segmented<T extends string | number>({ value, options, onChange, label, size, className }: { value: T; options: SegOption<T>[]; onChange(v: T): void; label: string; size?: 'sm'; className?: string }) {
  const compact = useCompact();
  return (
    <div role="radiogroup" aria-label={label} className={cn('flex flex-none gap-0.5 rounded-[11px] bg-ink/6 p-[3px]', compact && !size && 'w-full rounded-xl bg-ink/7', className)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-[9px] border-0 whitespace-nowrap transition-colors duration-140 disabled:cursor-default disabled:opacity-40',
            size === 'sm' ? 'h-[30px] px-3 text-[12.5px]' : compact ? 'h-[38px] flex-1 rounded-[10px] text-[14px]' : 'h-8 px-3.5 text-[13px]',
            o.value === value ? 'bg-ink/14 text-ink' : 'bg-transparent text-ink/62 hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({ value, min, max, onChange, label, unit }: { value: number; min: number; max: number; onChange(v: number): void; label: string; unit: string }) {
  const compact = useCompact();
  return (
    <>
      <input type="range" className={cn('nx-range min-w-0 flex-1', compact && 'nx-range-lg w-full')} min={min} max={max} step={1} value={value} aria-label={label} aria-valuetext={`${value}${unit}`} onChange={(e) => onChange(Number(e.target.value))} />
      {!compact && <span className="w-[52px] flex-none text-right text-[13px] text-ink/78 tabular-nums">{`${value}${unit}`}</span>}
    </>
  );
}

type Variant = 'primary' | 'secondary' | 'text' | 'danger' | 'danger-solid' | 'ghost';

export function Button({ variant = 'secondary', size, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'lg' }) {
  const v: Record<Variant, string> = {
    primary: 'bg-amber text-on-amber font-semibold hover:bg-amber-hi',
    secondary: 'bg-ink/9 text-ink hover:bg-ink/15',
    text: 'bg-transparent text-amber-hi hover:bg-amber/10',
    danger: 'bg-error/14 text-[#f4b2a3] hover:bg-error/22',
    'danger-solid': 'bg-error/90 text-[#1f1512] font-semibold hover:bg-error',
    ghost: 'bg-transparent text-ink/75 hover:bg-ink/8',
  };
  const s = size === 'sm' ? 'h-8 rounded-[9px] px-3 text-[12.5px]' : size === 'lg' ? 'h-[50px] rounded-[15px] px-4 text-[16px]' : 'h-9 rounded-[10px] px-3.5 text-[13px]';
  return <button type="button" {...rest} className={cn('inline-flex flex-none items-center justify-center gap-2 border-0 transition-colors duration-140 disabled:cursor-default disabled:opacity-45', s, v[variant], className)} />;
}

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode;
  error?: string;
  warn?: string;
  hint?: ReactNode;
  mono?: boolean;
}

/** Errors show only after blur or a save attempt (the caller decides); warnings never block. */
export function Field({ label, error, warn, hint, mono, className, ...input }: FieldProps) {
  const id = useId();
  return (
    <label htmlFor={id} className={cn('flex flex-col gap-2', className)}>
      {label && <span className="text-[13px] text-ink/72">{label}</span>}
      <input
        id={id}
        aria-invalid={!!error}
        spellCheck={false}
        autoComplete="off"
        {...input}
        className={cn('box-border h-11 rounded-xl border-0 px-3.5 text-ink caret-amber outline-none placeholder:text-ink/38', mono ? 'font-mono text-[13px]' : 'text-[14.5px]')}
        style={{ background: 'rgba(239,234,225,0.06)', boxShadow: error ? 'inset 0 0 0 1.5px rgba(233,118,95,0.7)' : 'inset 0 0 0 1px rgba(239,234,225,0.08)' }}
      />
      {error && <span className="text-[12.5px] text-danger-ink">{error}</span>}
      {!error && warn && <span className="text-[12.5px] text-[#f1c690]">{warn}</span>}
      {hint && !error && !warn && <span className="text-[12.5px] leading-[1.6] text-ink/50">{hint}</span>}
    </label>
  );
}

interface DialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  description?: ReactNode;
  width?: number;
  children?: ReactNode;
  footer: ReactNode;
}

/** R2 · 对话框: 440–520 px, radius 24; focus is trapped and returned by Radix. */
export function Dialog({ open, onOpenChange, title, description, width = 440, children, footer }: DialogProps) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-30 animate-[nx-fade_.2s_ease]" style={{ background: 'rgba(10,9,8,0.55)' }} />
        <RDialog.Content
          className="fixed top-1/2 left-1/2 z-31 box-border flex max-h-[calc(100dvh-32px)] max-w-[calc(100vw-32px)] -translate-1/2 animate-pop flex-col gap-4 overflow-y-auto rounded-3xl p-6 text-ink"
          style={{ width, background: 'rgba(40,38,34,0.98)', boxShadow: '0 40px 100px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.07)' }}
        >
          <RDialog.Title className="m-0 text-[18px] font-medium">{title}</RDialog.Title>
          {description ? (
            <RDialog.Description className="m-0 text-[13.5px] leading-[1.7] text-ink/66">{description}</RDialog.Description>
          ) : (
            <RDialog.Description className="sr-only">{typeof title === 'string' ? title : ''}</RDialog.Description>
          )}
          {children}
          <div className="mt-1 flex justify-end gap-2.5">{footer}</div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  const compact = useCompact();
  if (compact) return null;
  return (
    <div className="flex items-end gap-4">
      <div className="flex flex-1 flex-col gap-2">
        <h1 className="m-0 text-[28px] font-medium tracking-[-0.01em]">{title}</h1>
        {sub && <p className="m-0 text-[14px] leading-[1.7] text-ink/56">{sub}</p>}
      </div>
      {actions}
    </div>
  );
}

export const Spinner = ({ className }: { className?: string }) => <span className={cn('inline-block size-3.5 flex-none animate-spin-slow rounded-full border-2 border-ink/60 border-t-transparent', className)} />;
