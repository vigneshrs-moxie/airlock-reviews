/**
 * A place (a path and its line) that, when too long for its row, is cut at its start, so the file name and the line number
 * stay in view (`.ap-end` in shared.css). The finding screen's heading and every review row use it.
 */
export function EndInView({ className, text }: { className: string; text: string }) {
  return <code className={`${className} ap-end`}><span dir="ltr">{text}</span></code>;
}
