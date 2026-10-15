import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { extractTextItems, getDocumentProxy } from 'unpdf';
import type { ImportFormat, ImportLine, MarkKind, TextMark } from '@classpulse/shared-types';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;
const MAX_PDF_PAGES = 500;
export type SourceFormat = ImportFormat | 'md';
export interface UploadedFile { originalname: string; mimetype: string; size: number; buffer: Buffer }

/** Multer decodes multipart filenames as latin1; browsers send UTF-8, so Vietnamese names need re-decoding. */
export function uploadName(file: UploadedFile) {
  const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
  return (/\uFFFD/.test(decoded) ? file.originalname : decoded).normalize('NFC').replace(/[\\/\0]/g, '_').slice(0, 200) || 'tai-lieu';
}
/** Detects the format from the extension and confirms it with the file signature. */
export function detectFormat(file: UploadedFile, allowed: SourceFormat[]): SourceFormat {
  if (!file?.buffer?.length) throw new BadRequestException('Vui lòng chọn một file không rỗng.');
  if (file.size > MAX_UPLOAD_BYTES) throw new PayloadTooLargeException('File không được lớn hơn 20 MB.');
  const extension = /\.([a-z0-9]+)$/i.exec(uploadName(file))?.[1]?.toLowerCase();
  const format = ({ txt: 'txt', md: 'md', docx: 'docx', xlsx: 'xlsx', csv: 'csv', pdf: 'pdf' } as Record<string, SourceFormat>)[extension ?? ''];
  if (!format || !allowed.includes(format)) {
    if (extension === 'doc' || extension === 'xls') throw new BadRequestException(`File .${extension} (định dạng cũ) chưa được hỗ trợ. Hãy mở bằng Word/Excel và lưu lại dưới dạng .${extension}x.`);
    throw new BadRequestException(`Chỉ hỗ trợ file ${allowed.map(item => `.${item}`).join(', ')}.`);
  }
  const head = file.buffer.subarray(0, 5).toString('latin1');
  if ((format === 'docx' || format === 'xlsx') && !head.startsWith('PK')) throw new BadRequestException('File Office bị hỏng hoặc không đúng định dạng.');
  if (format === 'pdf' && !head.startsWith('%PDF')) throw new BadRequestException('File PDF bị hỏng hoặc không đúng định dạng.');
  return format;
}
/** Rejects archives whose declared uncompressed size is excessive before any library inflates them. */
export function assertSafeZip(buffer: Buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > buffer.length) throw new BadRequestException('File Office bị hỏng.');
  const entries = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  let total = 0;
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new BadRequestException('File Office bị hỏng.');
    total += buffer.readUInt32LE(offset + 24);
    if (total > MAX_UNZIPPED_BYTES) throw new PayloadTooLargeException('Nội dung giải nén của file quá lớn.');
    offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
}

/** UTF-8 (with or without BOM) or UTF-16 with BOM, normalized to NFC so composed and decomposed Vietnamese compare equal. */
export function decodeText(buffer: Buffer) {
  const text = buffer[0] === 0xff && buffer[1] === 0xfe ? new TextDecoder('utf-16le').decode(buffer.subarray(2))
    : buffer[0] === 0xfe && buffer[1] === 0xff ? new TextDecoder('utf-16be').decode(buffer.subarray(2))
    : new TextDecoder('utf-8').decode(buffer).replace(/^\uFEFF/, '');
  return text.normalize('NFC');
}
export const textLines = (text: string): ImportLine[] => text.split(/\r\n?|\n/).map(line => ({ text: line }));

const XML_TOKEN = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->|([^<]+)/g;
const attribute = (attributes: string, name: string) => new RegExp(`${name.replace(':', '\\:')}\\s*=\\s*["']([^"']*)["']`).exec(attributes)?.[1];
const unescapeXml = (text: string) => text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, entity: string) => {
  const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
  return String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
});
const enabled = (attributes: string) => !/w:val\s*=\s*["'](0|false|off|none)["']/.test(attributes);
function visibleColor(value?: string) {
  if (!value || !/^[0-9a-f]{6}$/i.test(value)) return false;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16));
  return Math.max(r, g, b) > 0x50; // near-black text is ordinary text, not a marker
}
function headingStyles(stylesXml: string) {
  const levels = new Map<string, number>();
  for (const match of stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = attribute(match[1], 'w:styleId');
    const name = /<w:name\s+w:val="([^"]*)"/.exec(match[2])?.[1] ?? '';
    const outline = /<w:outlineLvl\s+w:val="(\d)"/.exec(match[2])?.[1];
    const level = /^heading\s*(\d)$/i.exec(name)?.[1] ?? (outline !== undefined ? String(Number(outline) + 1) : undefined);
    if (id && level) levels.set(id, Number(level));
  }
  return levels;
}
type Paragraph = { text: string; marks: TextMark[]; heading?: number; numbered?: boolean };
type Cell = Paragraph[];
/**
 * Reads word/document.xml directly so run formatting survives: Vietnamese question banks often mark the
 * correct option by underline, bold, red text or highlight. Table rows whose cells hold one paragraph each
 * become one tab-separated line, which keeps answer-key tables ("Câu | 1 | 2") readable.
 */
export async function readDocx(buffer: Buffer): Promise<ImportLine[]> {
  assertSafeZip(buffer);
  const zip = await JSZip.loadAsync(buffer).catch(() => { throw new BadRequestException('Không đọc được file Word.'); });
  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) throw new BadRequestException('File Word không có nội dung văn bản.');
  const styles = headingStyles(await zip.file('word/styles.xml')?.async('string') ?? '');
  const lines: ImportLine[] = [];
  const containers: Array<{ kind: 'body' } | { kind: 'cell'; paragraphs: Paragraph[] }> = [{ kind: 'body' }];
  const rows: Cell[][] = [];
  const paragraphs: Paragraph[] = [];
  let run: Set<MarkKind> = new Set();
  let inParagraphProps = false, inRunProps = false, inText = false, skipDepth = 0;
  const emit = (paragraph: Paragraph) => {
    let offset = 0;
    for (const piece of paragraph.text.split('\n')) {
      const end = offset + piece.length;
      lines.push({ text: piece, marks: paragraph.marks.filter(m => m.end > offset && m.start < end).map(m => ({ ...m, start: Math.max(0, m.start - offset), end: Math.min(piece.length, m.end - offset) })), heading: paragraph.heading, numbered: paragraph.numbered });
      offset = end + 1;
    }
  };
  const place = (paragraph: Paragraph) => {
    const container = containers[containers.length - 1];
    if (container.kind === 'cell') container.paragraphs.push(paragraph); else emit(paragraph);
  };
  const append = (text: string, kinds: Set<MarkKind>) => {
    const paragraph = paragraphs[paragraphs.length - 1];
    if (!paragraph) return;
    const start = paragraph.text.length;
    paragraph.text += text;
    for (const kind of kinds) paragraph.marks.push({ start, end: paragraph.text.length, kind });
  };
  for (const match of documentXml.matchAll(XML_TOKEN)) {
    const [, closing, name, attributes = '', selfClosing, text] = match;
    if (text !== undefined) { if (inText && !skipDepth) append(unescapeXml(text), run); continue; }
    if (!name) continue;
    // Alternate-content fallbacks repeat text boxes; moved-from runs duplicate moved text.
    if (name === 'mc:Fallback' || name === 'w:moveFrom') { if (!selfClosing) skipDepth += closing ? -1 : 1; continue; }
    if (skipDepth) continue;
    if (closing) {
      if (name === 'w:pPr') inParagraphProps = false;
      else if (name === 'w:rPr') inRunProps = false;
      else if (name === 'w:t' || name === 'm:t') inText = false;
      else if (name === 'w:r') run = new Set();
      else if (name === 'w:p') { const paragraph = paragraphs.pop(); if (paragraph) place(paragraph); }
      else if (name === 'w:tc') {
        const cell = containers.pop();
        if (cell?.kind === 'cell') rows[rows.length - 1]?.push(cell.paragraphs.filter(p => p.text.trim()));
      } else if (name === 'w:tr') {
        const row = rows.pop() ?? [];
        const output = row.every(cell => cell.length <= 1)
          ? [row.reduce<Paragraph>((joined, cell) => {
              const paragraph = cell[0];
              if (!paragraph) return joined;
              const offset = joined.text ? joined.text.length + 1 : 0;
              return { text: joined.text ? `${joined.text}\t${paragraph.text}` : paragraph.text, marks: [...joined.marks, ...paragraph.marks.map(m => ({ ...m, start: m.start + offset, end: m.end + offset }))], heading: joined.heading ?? paragraph.heading, numbered: joined.numbered || paragraph.numbered };
            }, { text: '', marks: [] })]
          : row.flat();
        output.forEach(place);
      }
      continue;
    }
    switch (name) {
      case 'w:p': if (selfClosing) place({ text: '', marks: [] }); else paragraphs.push({ text: '', marks: [] }); break;
      case 'w:pPr': if (!selfClosing) inParagraphProps = true; break;
      case 'w:pStyle': { const level = styles.get(attribute(attributes, 'w:val') ?? ''); if (level && inParagraphProps && paragraphs.length) paragraphs[paragraphs.length - 1].heading = level; break; }
      case 'w:outlineLvl': if (inParagraphProps && paragraphs.length) paragraphs[paragraphs.length - 1].heading = Number(attribute(attributes, 'w:val') ?? 9) + 1; break;
      case 'w:numId': if (inParagraphProps && paragraphs.length && attribute(attributes, 'w:val') !== '0') paragraphs[paragraphs.length - 1].numbered = true; break;
      case 'w:r': run = new Set(); break;
      case 'w:rPr': if (!selfClosing && !inParagraphProps) inRunProps = true; break;
      case 'w:b': if (inRunProps && enabled(attributes)) run.add('bold'); break;
      case 'w:u': if (inRunProps && enabled(attributes)) run.add('underline'); break;
      case 'w:color': if (inRunProps && visibleColor(attribute(attributes, 'w:val'))) run.add('color'); break;
      case 'w:highlight': if (inRunProps && enabled(attributes)) run.add('highlight'); break;
      case 'w:shd': { const fill = attribute(attributes, 'w:fill'); if (inRunProps && fill && !/^(auto|ffffff)$/i.test(fill)) run.add('highlight'); break; }
      case 'w:t': case 'm:t': if (!selfClosing) inText = true; break;
      case 'w:tab': if (!inParagraphProps) append('\t', run); break;
      case 'w:br': case 'w:cr': append('\n', new Set()); break;
      case 'w:tr': rows.push([]); break;
      case 'w:tc': containers.push({ kind: 'cell', paragraphs: [] }); break;
    }
  }
  return lines;
}

/** Rebuilds lines from positioned PDF text items, inserting tabs for wide gaps such as option columns. */
export async function readPdf(buffer: Buffer): Promise<{ lines: ImportLine[]; pageCount: number; scanned: boolean }> {
  let document;
  try { document = await getDocumentProxy(new Uint8Array(buffer)); }
  catch { throw new BadRequestException('Không đọc được file PDF (file hỏng hoặc có mật khẩu).'); }
  if (document.numPages > MAX_PDF_PAGES) throw new BadRequestException(`File PDF có ${document.numPages} trang; tối đa ${MAX_PDF_PAGES} trang.`);
  const { items, totalPages } = await extractTextItems(document);
  const lines: ImportLine[] = [];
  let characters = 0;
  items.forEach((pageItems, pageIndex) => {
    let text = '', lastY: number | null = null, lastEnd: number | null = null;
    const flush = () => { if (text.trim()) lines.push({ text: text.replace(/\s+$/, ''), page: pageIndex + 1 }); text = ''; lastEnd = null; };
    for (const item of pageItems) {
      const size = item.fontSize || 10;
      if (lastY !== null && Math.abs(item.y - lastY) > Math.max(2, size * 0.5)) flush();
      if (lastEnd !== null && item.str && !/\s$/.test(text) && !/^\s/.test(item.str)) {
        const gap = item.x - lastEnd;
        if (gap > size * 1.5) text += '\t'; else if (gap > size * 0.15) text += ' ';
      }
      text += item.str;
      characters += item.str.trim().length;
      lastY = item.y; lastEnd = item.x + item.width;
      if (item.hasEOL) flush();
    }
    flush();
    lines.push({ text: '', page: pageIndex + 1 });
  });
  await document.loadingTask.destroy().catch(() => undefined);
  return { lines, pageCount: totalPages, scanned: characters < totalPages * 40 };
}

export async function readSpreadsheet(buffer: Buffer, format: 'xlsx' | 'csv'): Promise<string[][]> {
  if (format === 'csv') return parseCsv(decodeText(buffer));
  assertSafeZip(buffer);
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer as unknown as ArrayBuffer); }
  catch { throw new BadRequestException('Không đọc được file Excel.'); }
  const sheet = workbook.worksheets.find(item => item.actualRowCount > 0);
  if (!sheet) return [];
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, row => {
    const cells: string[] = [];
    for (let column = 1; column <= Math.min(row.cellCount, 40); column++) cells.push(String(row.getCell(column).text ?? '').normalize('NFC').trim());
    rows.push(cells);
  });
  return rows;
}
/** RFC 4180 CSV with comma, semicolon or tab delimiter (Excel in Vietnamese locales often uses semicolons). */
export function parseCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [';', '\t', ','].map(d => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0].d;
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (char === '"') quoted = false; else cell += char;
    } else if (char === '"' && !cell) quoted = true;
    else if (char === delimiter) { row.push(cell.trim()); cell = ''; }
    else if (char === '\n' || char === '\r') { if (char === '\r' && text[i + 1] === '\n') i++; row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.filter(item => item.some(Boolean));
}
