/**
 * Tiny, safe markdown subset for answers: code fences, inline code, bold,
 * bullet lists and paragraphs. Everything is HTML-escaped before formatting.
 */
export function renderMarkdown(src: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const inline = (s: string) => s.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const parts = src.split(/```[a-zA-Z]*\n?([\s\S]*?)```/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<pre>${esc(part.trim())}</pre>`;
      return esc(part)
        .split(/\n{2,}/)
        .filter((p) => p.trim())
        .map((block) => {
          const lines = block.split("\n");
          const out: string[] = [];
          let list: string[] = [];
          let para: string[] = [];
          const flushPara = () => {
            if (para.length) out.push(`<p>${inline(para.join("<br>"))}</p>`);
            para = [];
          };
          const flushList = () => {
            if (list.length) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`);
            list = [];
          };
          for (const line of lines) {
            const m = line.match(/^\s*[-*]\s+(.*)$/);
            if (m) {
              flushPara();
              list.push(m[1]);
            } else if (line.trim()) {
              flushList();
              para.push(line);
            }
          }
          flushPara();
          flushList();
          return out.join("");
        })
        .join("");
    })
    .join("");
}
