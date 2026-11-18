import { PDFParse } from 'pdf-parse';

export function validateUpload(file) {
  const extension = file.originalname.toLowerCase().match(/\.(pdf|txt)$/)?.[0];
  const contentType = extension === '.pdf' ? 'application/pdf' : extension === '.txt' ? 'text/plain' : null;
  if (!contentType || (extension === '.pdf' && file.mimetype !== 'application/pdf') || (extension === '.txt' && !['text/plain', 'application/octet-stream'].includes(file.mimetype))) throw new Error('Only text-based PDF and TXT files are supported.');
  if (!file.size) throw new Error('Choose a nonempty file.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Choose a file smaller than 5 MB.');
  if (extension === '.pdf') {
    const pdfHeaderIndex = file.buffer.indexOf(Buffer.from('%PDF-'));
    if (pdfHeaderIndex < 0 || pdfHeaderIndex > 1024) throw new Error('The file is not a valid PDF.');
  } else if (file.buffer.includes(0)) throw new Error('The TXT file contains binary data.');
  return { extension, contentType };
}
export async function extractText(buffer, contentType) {
  if (contentType === 'text/plain') {
    const text = buffer.toString('utf8').replace(/\0/g, '').replace(/\r\n/g, '\n').trim();
    if (!text) throw new Error('No readable text was found in the TXT file.');
    return text;
  }
  if (contentType !== 'application/pdf') throw new Error('Only text-based PDF and TXT files are supported.');
  const parser = new PDFParse({ data: buffer });
  let text;
  try { text = (await parser.getText()).text; } finally { await parser.destroy(); }
  text = text.replace(/\0/g, '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new Error('No readable text was found. This project supports text-based PDFs, not scanned PDFs.');
  return text;
}
