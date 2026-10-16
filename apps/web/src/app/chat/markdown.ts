/** The block structure of the Markdown agents write (see RichText). Pure, no React. */

export type ListItem = { text: string; children: Block[] };
export type Block =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'rule' }
  | { kind: 'paragraph'; text: string };

const BULLET = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const indentOf = (line: string) => line.replace(/\t/g, '    ').match(/^ */)![0].length;
const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());

/** Parses the lines of one list (all at or deeper than `base`), nested lists by indentation. */
function parseList(lines: string[], start: number, base: number): { block: Block; next: number } {
  const first = BULLET.exec(lines[start])!;
  const ordered = /\d/.test(first[2]);
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const bullet = BULLET.exec(line);
    const indent = indentOf(line);
    if (bullet && indent === base && /\d/.test(bullet[2]) === ordered) {
      items.push({ text: bullet[3], children: [] });
      i++;
      continue;
    }
    if (bullet && indent > base && items.length) {
      const nested = parseList(lines, i, indent);
      items.at(-1)!.children.push(nested.block);
      i = nested.next;
      continue;
    }
    // A wrapped line of the item above.
    if (!bullet && line.trim() && indent > base && items.length) {
      const item = items.at(-1)!;
      if (item.children.length) break;
      item.text += ` ${line.trim()}`;
      i++;
      continue;
    }
    break;
  }
  return { block: { kind: 'list', ordered, start: ordered ? Number.parseInt(first[2], 10) || 1 : 1, items }, next: i };
}

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join('\n') }); paragraph = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith(fence[1])) body.push(lines[j++]);
      blocks.push({ kind: 'code', lang: fence[2], text: body.join('\n') });
      i = j;
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { flush(); blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] }); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ kind: 'rule' }); continue; }
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().startsWith('|')) rows.push(cells(lines[j++]));
      blocks.push({ kind: 'table', head, rows });
      i = j - 1;
      continue;
    }
    if (BULLET.test(line)) {
      flush();
      const { block, next } = parseList(lines, i, indentOf(line));
      blocks.push(block);
      i = next - 1;
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      const last = blocks.at(-1);
      if (last?.kind === 'quote') last.text += `\n${quote[1]}`;
      else blocks.push({ kind: 'quote', text: quote[1] });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    paragraph.push(line);
  }
  flush();
  return blocks;
}
