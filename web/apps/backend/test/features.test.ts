import 'reflect-metadata';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, HeadingLevel } from 'docx';
import { parseQuestionLines, type QuestionType } from '@classpulse/shared-types';
import { parseCsv, readDocx, readPdf, readSpreadsheet, assertSafeZip } from '../src/extract';
import { chunkText, ImportService, questionsFromRows } from '../src/imports';
import { detectSections } from '../src/sections';
import { allocate } from '@classpulse/shared-types';
import { planBatches } from '../src/generation';
import { ruleIssues, type ReviewQuestion } from '../src/quality';
import { remapLetterReferences, sessionQuestionsFrom } from '../src/sessions';
import { rosterFromRows } from '../src/classes';
import { sessionScores } from '../src/analytics';

/** Minimal single-font PDF with one text line per entry; offsets in the xref table are computed exactly. */
function pdfWithLines(lines: string[]) {
  const stream = `BT /F1 12 Tf 14 TL 50 780 Td ${lines.map(line => `(${line.replace(/[()\\]/g, '\\$&')}) Tj T*`).join(' ')} ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => { const offset = body.length; body += `${i + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

describe('document readers', () => {
  it('reads Word formatting marks, headings and answer-key tables', async () => {
    const doc = new Document({ sections: [{ children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Chương 1: Mạng')] }),
      new Paragraph({ children: [new TextRun('Câu 1: Giao thức nào dùng broker?')] }),
      new Paragraph({ children: [new TextRun('A. HTTP')] }),
      new Paragraph({ children: [new TextRun({ text: 'B. MQTT', underline: {} })] }),
      new Paragraph({ children: [new TextRun('C. FTP')] }), new Paragraph({ children: [new TextRun('D. SMTP')] }),
      new Paragraph({ children: [new TextRun('Câu 2: Số chẵn?')] }),
      new Paragraph({ children: [new TextRun('A. 1'), new TextRun({ text: '\tB. 2', color: 'FF0000' }), new TextRun('\tC. 3\tD. 5')] }),
      new Paragraph({ children: [new TextRun('Câu 3: Chọn tất cả số nguyên tố')] }),
      new Paragraph({ children: [new TextRun('A. 2')] }), new Paragraph({ children: [new TextRun('B. 3')] }), new Paragraph({ children: [new TextRun('C. 4')] }), new Paragraph({ children: [new TextRun('D. 9')] }),
      new Paragraph({ children: [new TextRun('BẢNG ĐÁP ÁN')] }),
      new Table({ rows: [
        new TableRow({ children: ['Câu', '3'].map(text => new TableCell({ children: [new Paragraph(text)] })) }),
        new TableRow({ children: ['Đáp án', 'AB'].map(text => new TableCell({ children: [new Paragraph(text)] })) }),
      ] }),
    ] }] });
    const lines = await readDocx(await Packer.toBuffer(doc));
    expect(lines.find(line => line.text.startsWith('Chương'))?.heading).toBe(1);
    const parsed = parseQuestionLines(lines);
    expect(parsed.questions.map(q => [q.correctAnswer, q.type, q.topic])).toEqual([['B', 'SINGLE', 'Chương 1: Mạng'], ['B', 'SINGLE', 'Chương 1: Mạng'], ['AB', 'MULTIPLE', 'Chương 1: Mạng']]);
  });
  it('reads text-layer PDFs line by line', async () => {
    const pdf = await readPdf(pdfWithLines(['Cau 1: 2 + 2 = ?', 'A. 3', 'B. 4', 'C. 5', 'D. 6', 'Dap an: B', 'Cau 2: Thu do?', 'A. Ha Noi    B. Hue    C. Vinh    D. Hai Phong', 'Dap an: A']));
    expect(pdf).toMatchObject({ pageCount: 1, scanned: false });
    expect(parseQuestionLines(pdf.lines).questions.map(q => [q.content, q.optionB, q.correctAnswer])).toEqual([['2 + 2 = ?', '4', 'B'], ['Thu do?', 'Hue', 'A']]);
  });
  it('round-trips the Excel template and reads CSV with semicolons', async () => {
    const service = new ImportService({} as never, { register: () => undefined } as never);
    const rows = await readSpreadsheet(await service.excelTemplate(), 'xlsx');
    const result = questionsFromRows(rows, 'mau.xlsx');
    expect(result.questions.map(q => [q.correctAnswer, q.type, q.difficulty, q.durationSeconds])).toEqual([['B', 'SINGLE', 'EASY', 30], ['AB', 'MULTIPLE', 'MEDIUM', 45], ['C', 'SINGLE', 'EASY', 20]]);
    expect(result.warnings).toEqual([]);
    expect(parseCsv('Câu hỏi;A;B;C;D;Đáp án\n"Có ""dấu"" ; không?";1;2;3;4;2')).toEqual([['Câu hỏi', 'A', 'B', 'C', 'D', 'Đáp án'], ['Có "dấu" ; không?', '1', '2', '3', '4', '2']]);
    expect(questionsFromRows(parseCsv('Nội dung;Phương án A;Phương án B;Phương án C;Phương án D;Đáp án đúng\nX?;a;b;c;d;3'), 'x.csv').questions[0].correctAnswer).toBe('C');
  });
  it('rejects zip archives that inflate beyond the limit', () => {
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt32LE(300 * 1024 * 1024, 24);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 10); end.writeUInt32LE(0, 16);
    expect(() => assertSafeZip(Buffer.concat([entry, end]))).toThrow('quá lớn');
  });
  it('chunks long text before a question marker', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Câu ${i + 1}: ${'x'.repeat(90)}\nA. 1\nB. 2\nC. 3\nD. 4`).join('\n');
    const chunks = chunkText(text, 1500);
    expect(chunks.join('')).toBe(text);
    expect(chunks.slice(1).every(chunk => /^\nCâu \d+/.test(chunk))).toBe(true);
  });
});

describe('teaching material chapters', () => {
  it('uses "Chương" headings and skips the table of contents', () => {
    const body = (n: number) => Array.from({ length: 8 }, () => `Nội dung chương ${n} về IoT và cảm biến.`).join(' ');
    const lines = ['MỤC LỤC', 'Chương 1. Giới thiệu ........ 3', 'Chương 2. MQTT ........ 9', '', 'Chương 1. Giới thiệu', body(1), 'Bài 1. Khái niệm', body(1), 'Chương 2. MQTT', body(2), 'Bài 2. Broker', body(2)].map(text => ({ text }));
    const { text, sections } = detectSections(lines);
    expect(sections.map(s => s.title)).toEqual(['Chương 1. Giới thiệu', 'Chương 2. MQTT']);
    expect(text.slice(sections[0].start, sections[0].end)).toContain('MỤC LỤC');
    expect(text.slice(sections[1].start, sections[1].end)).toContain('Bài 2. Broker');
  });
  it('splits material without headings into parts and keeps page numbers', () => {
    const lines = Array.from({ length: 60 }, (_, i) => ({ text: i % 10 === 9 ? '' : 'x'.repeat(600), page: Math.floor(i / 20) + 1 }));
    const { sections } = detectSections(lines);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections[0]).toMatchObject({ pageStart: 1 });
    expect(sections[0].title).toMatch(/^Phần 1 \(trang 1–/);
  });
});

describe('AI generation plan', () => {
  it('allocates exact counts and mixes difficulties in every batch', () => {
    expect(allocate(10, [30, 50, 20])).toEqual([3, 5, 2]);
    expect(allocate(7, [34, 33, 33])).toEqual([3, 2, 2]);
    const plans = planBatches(30, [40, 40, 20], 20, 12);
    expect(plans.map(p => p.size)).toEqual([12, 12, 6]);
    expect(plans.reduce((sum, p) => sum + p.counts.EASY, 0)).toBe(12);
    expect(plans.reduce((sum, p) => sum + p.counts.HARD, 0)).toBe(6);
    expect(plans.reduce((sum, p) => sum + p.multiple, 0)).toBe(6);
    expect(plans.every(p => p.counts.EASY > 0 && p.counts.MEDIUM > 0 && p.counts.HARD > 0)).toBe(true);
    const slots = plans.flatMap(p => p.slots);
    expect(slots.filter(slot => slot.multiple).every(slot => slot.key === null)).toBe(true);
    const keys = slots.filter(slot => !slot.multiple).map(slot => slot.key);
    expect(keys).toHaveLength(24);
    expect(['A', 'B', 'C', 'D'].map(letter => keys.filter(key => key === letter).length)).toEqual([6, 6, 6, 6]);
  });
});

describe('quality rules', () => {
  const base = { optionA: 'Một', optionB: 'Hai', optionC: 'Ba', optionD: 'Bốn', type: 'SINGLE' as QuestionType, correctAnswer: 'A', knowledge: '', topic: '', difficulty: null };
  it('flags identical options, negative stems, figures, cues and duplicates', () => {
    const questions: ReviewQuestion[] = [
      { ...base, id: '1', content: 'Phát biểu nào sau đây không đúng về MQTT?', optionB: 'một' },
      { ...base, id: '2', content: 'Dựa vào hình sau, cho biết điện áp tại điểm A?' },
      { ...base, id: '3', content: 'Đặc điểm của giao thức MQTT trong IoT là gì?', optionA: 'Dùng mô hình publish/subscribe thông qua broker trung gian, tiết kiệm băng thông', optionB: 'Chậm', optionC: 'Đắt', optionD: 'Cũ' },
      { ...base, id: '4', content: 'Đặc điểm của giao thức MQTT trong IoT là gì?', optionA: 'Chậm', optionB: 'Đắt', optionC: 'Cũ', optionD: 'Dùng mô hình publish/subscribe thông qua broker trung gian, tiết kiệm băng thông', correctAnswer: 'D' },
      { ...base, id: '5', content: 'Chọn số nguyên tố', type: 'MULTIPLE', correctAnswer: 'AB' },
    ];
    const issues = ruleIssues(questions);
    const of = (n: number) => issues.filter(i => i.number === n).map(i => i.category);
    expect(of(1)).toEqual(expect.arrayContaining(['FORMAT', 'LANGUAGE']));
    expect(of(2)).toContain('MISSING_DATA');
    expect(of(3)).toContain('ANSWER_CUE');
    expect(issues.find(i => i.category === 'DUPLICATE')).toMatchObject({ number: 4, related: [3], severity: 'HIGH' });
    expect(of(5)).toContain('FORMAT');
  });
});

describe('shuffled sessions', () => {
  it('reorders options, remaps keys and letter references in explanations', () => {
    const source = [{ id: 'q', content: 'Q', optionA: 'a', optionB: 'b', optionC: 'c', optionD: 'd', type: 'MULTIPLE' as const, correctAnswer: 'AC', explanation: 'Đáp án đúng là A và phương án C cũng đúng; câu B sai.', knowledge: '', topic: '', difficulty: null, durationSeconds: 30 }];
    const [question] = sessionQuestionsFrom(source, [{ index: 0, order: 'CADB' }]);
    expect(question).toMatchObject({ optionA: 'c', optionB: 'a', optionC: 'd', optionD: 'b', correctAnswer: 'AB', optionOrder: 'CADB', sourceQuestionId: 'q' });
    expect(question.explanation).toBe('Đáp án đúng là B và phương án A cũng đúng; câu B sai.');
    expect(remapLetterReferences('Chọn D.', 'ABCD')).toBe('Chọn D.');
  });
  it('scores students on the 10-point scale with exact multi-answer matching', () => {
    const { students, summary } = sessionScores({ questions: [{ id: 'a', correctAnswer: 'B' }, { id: 'b', correctAnswer: 'AC' }],
      participants: [{ id: 'p1', studentCode: '01', answers: [{ questionId: 'a', answer: 'B' }, { questionId: 'b', answer: 'AC' }] }, { id: 'p2', studentCode: '02', answers: [{ questionId: 'b', answer: 'A' }] }] });
    expect(students.map(s => s.score)).toEqual([10, 0]);
    expect(summary).toMatchObject({ count: 2, mean: 5, passRate: 50 });
  });
});

describe('class roster import', () => {
  it('maps STT to keypad codes and fills missing or duplicate codes', () => {
    const result = rosterFromRows([['DANH SÁCH LỚP 10A1'], ['STT', 'Họ và tên', 'Mã HS'], ['1', 'Nguyễn An', 'HS001'], ['1', 'Trần Bình', 'HS002'], ['', 'Lê Chi', '']]);
    expect(result.students).toEqual([{ code: '01', name: 'Nguyễn An', externalId: 'HS001' }, { code: '02', name: 'Trần Bình', externalId: 'HS002' }, { code: '03', name: 'Lê Chi', externalId: '' }]);
    expect(result.warnings).toHaveLength(2);
  });
});

describe('structured output schemas sent to Claude', () => {
  it('stay within the supported JSON Schema subset', async () => {
    const { betaZodOutputFormat } = await import('@anthropic-ai/sdk/helpers/beta/zod');
    const { GeneratedSchema } = await import('../src/generation');
    const { ExtractionSchema } = await import('../src/imports');
    const { ReviewSchema } = await import('../src/quality');
    const { InsightSchema } = await import('../src/analytics');
    const unsupported = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems'];
    const visit = (node: unknown, path: string): string[] => {
      if (!node || typeof node !== 'object') return [];
      const schema = node as Record<string, unknown>;
      const problems = unsupported.filter(key => key in schema).map(key => `${path}: ${key}`);
      if (schema.type === 'object') {
        const properties = Object.keys((schema.properties ?? {}) as object);
        if (schema.additionalProperties !== false) problems.push(`${path}: additionalProperties`);
        if (properties.some(key => !(schema.required as string[] | undefined)?.includes(key))) problems.push(`${path}: optional property`);
      }
      return [...problems, ...Object.entries(schema).flatMap(([key, value]) => visit(value, `${path}.${key}`))];
    };
    for (const [name, zodSchema] of Object.entries({ GeneratedSchema, ExtractionSchema, ReviewSchema, InsightSchema })) {
      expect(visit(betaZodOutputFormat(zodSchema).schema, name)).toEqual([]);
    }
  });
});

describe('AI provider selection', () => {
  const keys = ['AI_DISABLED', 'AI_PROVIDER', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'OLLAMA_URL', 'OLLAMA_MODEL', 'OLLAMA_NUM_CTX'];
  it('prefers the free Gemini tier, honours AI_PROVIDER and stays off without configuration', async () => {
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const { AiService } = await import('../src/ai');
    const ai = new AiService();
    const set = (values: Record<string, string>) => { for (const key of keys) delete process.env[key]; Object.assign(process.env, values); };
    try {
      set({});
      expect(ai.status()).toEqual({ enabled: false, provider: null, model: '', fallback: null });
      set({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' });
      expect(ai.status()).toEqual({ enabled: true, provider: 'gemini', model: 'gemini-3.8-flash', fallback: null });
      set({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', AI_PROVIDER: 'anthropic' });
      expect(ai.status()).toEqual({ enabled: true, provider: 'anthropic', model: 'claude-opus-5-5', fallback: null });
      set({ OLLAMA_URL: 'http://localhost:11434', OLLAMA_MODEL: 'gemma4:e4b' });
      expect(ai.status()).toEqual({ enabled: true, provider: 'ollama', model: 'gemma4:e4b', fallback: null });
      set({ GEMINI_API_KEY: 'g', OLLAMA_URL: 'http://localhost:11434' });
      expect(ai.status()).toEqual({ enabled: true, provider: 'gemini', model: 'gemini-3.8-flash', fallback: { provider: 'ollama', model: 'qwen3:4b-instruct' } });
      set({ AI_PROVIDER: 'gemini' });
      expect(ai.status().enabled).toBe(false);
      set({ GEMINI_API_KEY: 'g', AI_DISABLED: 'true' });
      expect(ai.status().enabled).toBe(false);
    } finally { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
  });
  it('gives Gemini and Ollama JSON schemas with real enum constraints in the supported subset', async () => {
    const { jsonSchema } = await import('../src/ai-providers');
    const { GeneratedSchema } = await import('../src/generation');
    const { ExtractionSchema } = await import('../src/imports');
    const { ReviewSchema } = await import('../src/quality');
    const { InsightSchema } = await import('../src/analytics');
    const supported = new Set(['$id', '$defs', '$ref', '$anchor', 'type', 'format', 'title', 'description', 'enum', 'items', 'prefixItems', 'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'oneOf', 'properties', 'additionalProperties', 'required', 'propertyOrdering']);
    const keysOf = (node: unknown, inProperties = false): string[] => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return Array.isArray(node) ? node.flatMap(item => keysOf(item)) : [];
      return Object.entries(node).flatMap(([key, value]) => [...(inProperties ? [] : [key]), ...keysOf(value, key === 'properties' && !inProperties)]);
    };
    for (const schema of [GeneratedSchema, ExtractionSchema, ReviewSchema, InsightSchema]) {
      expect(keysOf(jsonSchema(schema)).filter(key => !supported.has(key))).toEqual([]);
    }
    expect(JSON.stringify(jsonSchema(GeneratedSchema))).toContain('"enum":["EASY","MEDIUM","HARD"]');
    expect(GeneratedSchema.shape.questions.element.shape.difficulty.safeParse('Easy').success).toBe(true);
  });
  it('reads Ollama NDJSON streams split mid-character and explains common failures', async () => {
    const { AiTaskError, OllamaProvider } = await import('../src/ai-providers');
    const { InsightSchema } = await import('../src/analytics');
    const answer = JSON.stringify({ summary: 'Lớp làm tốt phần broker.', strengths: ['Câu 1'], weaknesses: [], questionFlags: [{ number: 3, issue: 'Độ phân biệt âm', recommendation: 'Kiểm tra lại đáp án' }], recommendations: ['Ôn tập QoS'], classComparison: '' });
    const requests: Array<{ model: string; stream: boolean; format: { properties: Record<string, unknown> }; messages: Array<{ content: string }>; options: Record<string, number> }> = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        requests.push(body);
        if (body.model === 'missing') { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'model "missing" not found, try pulling it first' })); return; }
        if (body.model === 'big') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'model requires more system memory (7.9 GiB) than is available (5.2 GiB)' })); return; }
        if (body.model === 'killed') { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); res.end(`${JSON.stringify({ message: { role: 'assistant', content: '{"summary":"Lớp' }, done: false })}\n`); return; }
        const events = [...answer.match(/[\s\S]{1,7}/g)!.map(content => ({ message: { role: 'assistant', content }, done: false })), { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 812, eval_count: 95 }];
        const bytes = Buffer.from(events.map(event => `${JSON.stringify(event)}\n`).join(''));
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        for (let i = 0; i < bytes.length; i += 13) res.write(bytes.subarray(i, i + 13));
        res.end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ask = (provider: InstanceType<typeof OllamaProvider>, text = 'Kết quả lớp 10A1') => provider.generate({ system: 'Analyst.', content: [{ type: 'text', text }], schema: InsightSchema, maxTokens: 32000 });
    try {
      const { data, usage } = await ask(new OllamaProvider('qwen3:4b-instruct', url, 32768));
      expect(data.summary).toBe('Lớp làm tốt phần broker.');
      expect(data.questionFlags[0].number).toBe(3);
      expect(usage).toEqual({ inputTokens: 812, outputTokens: 95 });
      expect(requests[0]).toMatchObject({ model: 'qwen3:4b-instruct', stream: true, options: { num_ctx: 32768, num_predict: 16000 } });
      expect(Object.keys(requests[0].format.properties)).toContain('questionFlags');
      expect(requests[0].messages[0].content).toContain('"questionFlags"');
      // A smaller context (to save RAM) still serves short prompts; output shrinks to the room left.
      await ask(new OllamaProvider('qwen3:4b-instruct', url, 8192));
      expect(requests[1].options.num_predict).toBeGreaterThan(2000);
      expect(requests[1].options.num_predict).toBeLessThan(8192);
      expect([new OllamaProvider('m', url, 32768).chunkChars, new OllamaProvider('m', url, 8192).chunkChars, new OllamaProvider('m', url, 131072).chunkChars]).toEqual([29491, 7372, 30000]);
      await expect(ask(new OllamaProvider('missing', url, 32768))).rejects.toThrow('ollama pull missing');
      await expect(ask(new OllamaProvider('big', url, 32768))).rejects.toThrow('không đủ RAM cho big với OLLAMA_NUM_CTX=32768');
      await expect(ask(new OllamaProvider('killed', url, 32768))).rejects.toThrow('Ollama dừng giữa chừng');
      await expect(ask(new OllamaProvider('qwen3:4b-instruct', url, 4096), 'x'.repeat(30000))).rejects.toThrow('OLLAMA_NUM_CTX');
      await expect(new OllamaProvider('qwen3:4b-instruct', url, 32768).generate({ system: 's', content: [{ type: 'pdf', data: 'JVBERi0=', title: 'scan' }], schema: InsightSchema })).rejects.toBeInstanceOf(AiTaskError);
      await expect(ask(new OllamaProvider('qwen3:4b-instruct', 'http://127.0.0.1:9', 32768))).rejects.toThrow('Không kết nối được Ollama');
      expect(requests).toHaveLength(5);
    } finally { server.close(); }
  });
  it('falls back to Ollama when the cloud quota is used up and labels the job with the model that answered', async () => {
    const { AiJobsService, AiService } = await import('../src/ai');
    const { InsightSchema } = await import('../src/analytics');
    const hits: string[] = [];
    const insight = JSON.stringify({ summary: 'Ổn định.', strengths: [], weaknesses: [], questionFlags: [], recommendations: [], classComparison: '' });
    const server = createServer((req, res) => {
      hits.push(req.url ?? '');
      req.resume();
      req.on('end', () => {
        if (req.url?.startsWith('/v1/messages')) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after-ms': '1' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Quota exceeded' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.end(`${JSON.stringify({ message: { content: insight }, done: false })}\n${JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 12 })}\n`);
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const keys = ['AI_DISABLED', 'AI_PROVIDER', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'OLLAMA_URL', 'OLLAMA_MODEL', 'OLLAMA_NUM_CTX'];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: url, OLLAMA_URL: url });
    try {
      const ai = new AiService();
      expect(ai.status()).toEqual({ enabled: true, provider: 'anthropic', model: 'claude-opus-5-5', fallback: { provider: 'ollama', model: 'qwen3:4b-instruct' } });
      const record = { id: 'job-1', teacherId: 't', kind: 'ANALYZE_SESSION' };
      const updates: Array<Record<string, unknown>> = [];
      const db = { aiJob: { count: async () => 0, create: async () => ({ ...record, status: 'QUEUED', progress: 0, error: null, result: null, input: {}, documentId: null, quizId: null, sessionId: null, examId: null, model: ai.model, inputTokens: 0, outputTokens: 0, createdAt: new Date(), startedAt: null, finishedAt: null }),
        update: async ({ data }: { data: Record<string, unknown> }) => { updates.push(data); return record; } } };
      const jobs = new AiJobsService(db as never, ai);
      const ask = () => ai.structured({ system: 'Analyst.', content: [{ type: 'text', text: 'Kết quả' }], schema: InsightSchema });
      jobs.register('ANALYZE_SESSION', async () => { const first = await ask(); await ask(); return { result: first.data, usage: first.usage }; });
      expect((await jobs.enqueue('t', 'ANALYZE_SESSION', {}, {})).model).toBe('claude-opus-5-5');
      await vi.waitFor(() => expect(updates.find(update => update.status === 'SUCCEEDED' || update.status === 'FAILED')?.status).toBe('SUCCEEDED'), { timeout: 10000 });
      expect(updates.find(update => update.status === 'SUCCEEDED')?.model).toBe('qwen3:4b-instruct');
      // One Claude attempt plus three SDK retries, then the second call skips the paused cloud provider.
      expect(hits.filter(hit => hit.startsWith('/v1/messages'))).toHaveLength(4);
      expect(hits.filter(hit => hit === '/api/chat')).toHaveLength(2);
    } finally {
      server.close();
      for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    }
  });
});
