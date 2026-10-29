/** Text with the matched characters emphasised (search results). */
export function Highlight({ text, ranges }: { text: string; ranges?: readonly [number, number][] }) {
  if (!ranges?.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [from, to] of ranges) {
    if (from > at) parts.push(text.slice(at, from));
    parts.push(
      <mark key={from} className="bg-transparent font-semibold text-amber-hi">
        {text.slice(from, to)}
      </mark>,
    );
    at = to;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
