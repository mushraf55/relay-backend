import { Router } from 'express';
import multer from 'multer';
import { createHash, randomUUID } from 'node:crypto';
import { client } from '../../infrastructure/database.js';
import { putFile, deleteFile } from '../../infrastructure/object-storage.js';
import { validateUpload } from './extraction.js';
import { jobProvider, queueEvent, indexStoredFile, removeStoredFile } from './jobs.js';
import { sharedLimit } from '../../infrastructure/rate-limits.js';
import { canEditWorkspace } from '../workspaces/permissions.js';

export const knowledgeRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: 10 * 1024 * 1024, fields: 4 } });
const safeUpload = (req, res, next) => upload.single('file')(req, res, error => {
  if (!error) return next();
  res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Choose a file smaller than 10 MB.' : 'Invalid file upload.' });
});
knowledgeRouter.post('/upload', safeUpload, async (req, res) => {
  if (!await canEditWorkspace(req)) return res.status(403).json({ error: 'Workspace editor access required' });
  const { botId, sourceId } = req.body;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(botId || '') || !/^[A-Za-z0-9_-]{1,100}$/.test(sourceId || '') || !req.file) return res.status(400).json({ error: 'Invalid file upload.' });
  const limited = await sharedLimit('upload', req.workspaceId);
  if (!limited.success) return res.status(429).json({ error: 'Upload limit reached. Try again later.' });
  let checked;
  try { checked = validateUpload(req.file); } catch (error) { return res.status(400).json({ error: error.message }); }
  const [workspace] = await client`SELECT data FROM relay.workspaces WHERE id=${req.workspaceId}`;
  const source = workspace?.data?.sources?.find(item => item.id === sourceId && item.botId === botId && item.type === 'File');
  if (!source) return res.status(404).json({ error: 'Save the file source in this workspace before uploading.' });
  const prefix = createHash('sha256').update(req.workspaceId).digest('hex').slice(0, 24);
  const objectKey = `${prefix}/${botId}/${sourceId}/${randomUUID()}${checked.extension}`;
  let persisted = false;
  try {
    await putFile(objectKey, req.file.buffer, checked.contentType);
    let oldKey;
    await client.begin(async tx => {
      const previous = await tx`SELECT object_key FROM relay.knowledge_files WHERE workspace_id=${req.workspaceId} AND source_id=${sourceId}`;
      oldKey = previous[0]?.object_key;
      await tx`INSERT INTO relay.knowledge_files(workspace_id,bot_id,source_id,object_key,filename,content_type,size_bytes,uploaded_by_user_id,status,progress,progress_stage,progress_detail,processed_chunks,total_chunks) VALUES(${req.workspaceId},${botId},${sourceId},${objectKey},${req.file.originalname.slice(0,255)},${checked.contentType},${req.file.size},${req.userId},'pending',5,'Queued','Upload complete. Waiting for the document processor.',0,0) ON CONFLICT(workspace_id,source_id) DO UPDATE SET object_key=excluded.object_key,filename=excluded.filename,content_type=excluded.content_type,size_bytes=excluded.size_bytes,uploaded_by_user_id=excluded.uploaded_by_user_id,status='pending',progress=5,progress_stage='Queued',progress_detail='Upload complete. Waiting for the document processor.',processed_chunks=0,total_chunks=0,error_message=NULL,created_at=now(),progress_updated_at=now()`;
      await tx`DELETE FROM relay.ai_chunks WHERE workspace_id=${req.workspaceId} AND source_id=${sourceId}`;
    });
    persisted = true;
    if (oldKey && oldKey !== objectKey) {
      const cleanup = { workspaceId: req.workspaceId, sourceId, objectKey: oldKey };
      if (jobProvider() === 'inline') {
        void removeStoredFile(cleanup).catch(error => console.error('Replaced file cleanup failed:', error.name));
      } else {
        void queueEvent({ name: 'relay/knowledge.file.deleted', data: cleanup }).catch(error => console.error('Replaced file cleanup enqueue failed:', error.name));
      }
    }
    const payload = { workspaceId: req.workspaceId, botId, sourceId, objectKey };
    if (jobProvider() === 'inline') {
      void indexStoredFile(payload).catch(error => console.error('Inline file processing failed:', error.name));
    } else await queueEvent({ name: 'relay/knowledge.file.uploaded', data: payload });
    res.status(202).json({ sourceId, status: 'Processing' });
  } catch (error) {
    if (persisted) {
      try { await client`UPDATE relay.knowledge_files SET status='error',error_message='Background processing could not be queued. Retry training.' WHERE workspace_id=${req.workspaceId} AND source_id=${sourceId} AND object_key=${objectKey}`; } catch { /* The stored file remains recoverable. */ }
    } else {
      try { await deleteFile(objectKey); } catch { /* Best-effort rollback; no credential logging. */ }
    }
    console.error('File upload failed:', error.name);
    res.status(503).json({ error: 'Could not store or queue this document. Please retry.' });
  }
});
