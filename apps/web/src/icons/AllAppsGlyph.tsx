import type { CSSProperties } from 'react';

/** 快速打开's 3 × 3 dots, drawn in the text colour so the glyph follows 浅色 / 深色. */
export function AllAppsGlyph({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg aria-hidden viewBox="0 0 32 32" fill="currentColor" className={className} style={style}>
      {[9, 16, 23].flatMap((y) => [9, 16, 23].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r={2.1} />))}
    </svg>
  );
}
