import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { env } from '../../config/env.js';

const run = promisify(execFile);

const types = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
export function validateUpload(file) {
  const extension = file.originalname.toLowerCase().match(/\.(pdf|docx|txt|md|png|jpe?g|webp)$/)?.[0];
  if (!extension || !types[extension]) throw new Error('Supported files: PDF, DOCX, TXT, Markdown, PNG, JPG and WebP.');
  if (!file.size) throw new Error('Choose a nonempty file.');
  if (file.size > 10 * 1024 * 1024) throw new Error('Choose a file smaller than 10 MB.');
  if (extension === '.pdf') {
    const pdfHeaderIndex = file.buffer.indexOf(Buffer.from('%PDF-'));
    if (pdfHeaderIndex < 0 || pdfHeaderIndex > 1024) throw new Error('The file is not a valid PDF.');
  }
  if (extension === '.docx' && file.buffer.subarray(0, 2).toString() !== 'PK') throw new Error('The file is not a valid DOCX document.');
  if (extension === '.png' && file.buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('The file is not a valid PNG image.');
  if (['.jpg', '.jpeg'].includes(extension) && file.buffer.subarray(0, 2).toString('hex') !== 'ffd8') throw new Error('The file is not a valid JPEG image.');
  if (extension === '.webp' && (file.buffer.subarray(0, 4).toString() !== 'RIFF' || file.buffer.subarray(8, 12).toString() !== 'WEBP')) throw new Error('The file is not a valid WebP image.');
  if (['.txt', '.md'].includes(extension)) {
    if (file.buffer.includes(0)) throw new Error('The text file contains unsupported binary data.');
    try { new TextDecoder('utf-8', { fatal: true }).decode(file.buffer); } catch { throw new Error('Text files must use UTF-8 encoding.'); }
  }
  return { extension, contentType: types[extension] };
}
async function ocrImage(buffer, extension) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-ocr-'));
  const input = join(dir, `source${extension || '.png'}`);
  const output = join(dir, 'ocr');
  try {
    await writeFile(input, buffer);
    await run(env.OCR_COMMAND || 'tesseract', [input, output, '-l', env.OCR_LANGUAGE || 'eng'], { timeout: 120_000, windowsHide: true });
    return await readFile(`${output}.txt`, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('OCR is not configured. Install Tesseract or set OCR_COMMAND on the backend.');
    throw new Error('OCR could not read text from this image. Try a clearer scan or upload a text PDF.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function extractText(buffer, contentType) {
  let text;
  if (contentType === 'application/pdf') {
    const parser = new PDFParse({ data: buffer });
    try { text = (await parser.getText()).text; } finally { await parser.destroy(); }
  } else if (contentType.includes('wordprocessingml')) {
    text = (await mammoth.extractRawText({ buffer })).value;
  } else if (imageTypes.has(contentType)) {
    text = await ocrImage(buffer, extname(`file.${contentType.split('/')[1] === 'jpeg' ? 'jpg' : contentType.split('/')[1]}`));
  } else text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  text = text.replace(/\0/g, '').replace(/\r\n/g, '\n').trim();
  if (!text && contentType === 'application/pdf') throw new Error('No readable text was found in this PDF. If it is scanned, export pages as PNG/JPG and upload them for OCR.');
  if (!text) throw new Error('No readable text was found in this document.');
  return text;
}
