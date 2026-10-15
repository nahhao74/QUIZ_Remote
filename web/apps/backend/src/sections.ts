import type { DocumentSection, ImportLine } from '@classpulse/shared-types';

export interface StoredSection { title: string; start: number; end: number; pageStart: number | null; pageEnd: number | null }
const KEYWORDS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^(chương|chuong|chapter)\s+([0-9]+|[IVXLCDM]+)\b/i, label: 'chương' },
  { pattern: /^(bài|bai|lesson)\s+([0-9]+|[IVXLCDM]+)\b/i, label: 'bài' },
  { pattern: /^(chủ đề|chu de|unit|module|học phần|hoc phan|tuần|tuan|week)\s+([0-9]+|[IVXLCDM]+)\b/i, label: 'chủ đề' },
  { pattern: /^(phần|phan|part)\s+([0-9]+|[IVXLCDM]+)\b/i, label: 'phần' },
];
const NUMBERED_CAPS = /^([0-9]{1,2}|[IVX]{1,5})[.)]\s+\S/;
const TOC_LINE = /(\.{4,}|…{2,}|_{4,})|\t\s*\d{1,4}\s*$/;
const CHUNK = 15000;
const isCaps = (text: string) => { const letters = text.replace(/[^\p{L}]/gu, ''); return letters.length >= 4 && letters === letters.toUpperCase(); };

/**
 * Splits teaching material into selectable chapters. Prefers "Chương N" headings, then "Bài", "Chủ đề",
 * "Phần", Word heading styles and numbered upper-case titles; table-of-contents entries are ignored.
 * Material without headings is cut into ~15,000-character parts at paragraph breaks.
 */
export function detectSections(lines: ImportLine[]): { text: string; sections: StoredSection[] } {
  const starts: number[] = [];
  let text = '';
  for (const line of lines) { starts.push(text.length); text += `${line.text.replace(/\s+$/, '')}\n`; }
  const pageAt = (lineIndex: number) => lines[lineIndex]?.page ?? null;
  const usable = (index: number) => { const value = lines[index].text.trim(); return value.length > 0 && value.length <= 160 && !TOC_LINE.test(lines[index].text); };
  const candidates: number[][] = [
    ...KEYWORDS.map(({ pattern }) => lines.map((line, i) => (usable(i) && pattern.test(line.text.trim()) ? i : -1)).filter(i => i >= 0)),
    lines.map((line, i) => (usable(i) && line.heading === 1 ? i : -1)).filter(i => i >= 0),
    lines.map((line, i) => (usable(i) && line.heading === 2 ? i : -1)).filter(i => i >= 0),
    lines.map((line, i) => (usable(i) && NUMBERED_CAPS.test(line.text.trim()) && isCaps(line.text) ? i : -1)).filter(i => i >= 0),
  ];
  let headings: number[] = [];
  for (const list of candidates) {
    // Entries closer than 150 characters to the next heading are table-of-contents lines, not chapters.
    const spaced = list.filter((line, k) => k === list.length - 1 || starts[list[k + 1]] - starts[line] >= 150);
    if (spaced.length >= 2) { headings = spaced; break; }
  }
  const sections: StoredSection[] = [];
  const add = (title: string, fromLine: number, toLine: number) => {
    const start = starts[fromLine] ?? text.length, end = toLine < lines.length ? starts[toLine] : text.length;
    if (end - start < 1) return;
    let last = toLine - 1;
    while (last > fromLine && !lines[last].text.trim()) last--;
    sections.push({ title: title.slice(0, 200), start, end, pageStart: pageAt(fromLine), pageEnd: pageAt(last) });
  };
  if (headings.length) {
    // Short front matter (cover, foreword) joins the first chapter; long front matter becomes its own part.
    const preamble = starts[headings[0]] > 1500;
    if (preamble) add('Phần mở đầu', 0, headings[0]);
    headings.forEach((line, k) => add(lines[line].text.trim(), k === 0 && !preamble ? 0 : line, headings[k + 1] ?? lines.length));
  } else {
    let fromLine = 0, size = 0;
    lines.forEach((line, i) => {
      size += line.text.length + 1;
      const atBreak = !line.text.trim() || i === lines.length - 1;
      if ((size >= CHUNK && atBreak) || i === lines.length - 1) {
        const pages = pageAt(fromLine) ? ` (trang ${pageAt(fromLine)}–${pageAt(i)})` : '';
        add(`Phần ${sections.length + 1}${pages}`, fromLine, i + 1);
        fromLine = i + 1; size = 0;
      }
    });
  }
  return { text, sections };
}
export function sectionView(text: string, sections: StoredSection[]): DocumentSection[] {
  return sections.map((section, index) => {
    const body = text.slice(section.start, section.end);
    const preview = body.replace(/^[^\n]*\n/, '').replace(/\s+/g, ' ').trim().slice(0, 280);
    return { index, title: section.title, charCount: body.length, preview, pageStart: section.pageStart, pageEnd: section.pageEnd };
  });
}
