import { client } from '../../infrastructure/database.js';

let socketServer;

export const workspaceRoom = workspaceId => `workspace:${workspaceId}`;
export function setProgressSocketServer(io) { socketServer = io; }

export async function reportKnowledgeProgress({ workspaceId, sourceId, objectKey, status = 'processing', progress, stage, detail, processedChunks = 0, totalChunks = 0, error = null }) {
  const safeProgress = Math.max(0, Math.min(100, Math.round(progress)));
  const rows = await client`
    UPDATE relay.knowledge_files
    SET status=${status}, progress=${safeProgress}, progress_stage=${stage}, progress_detail=${detail},
        processed_chunks=${processedChunks}, total_chunks=${totalChunks}, error_message=${error}, progress_updated_at=now()
    WHERE workspace_id=${workspaceId} AND source_id=${sourceId} AND object_key=${objectKey}
    RETURNING source_id,status,progress,progress_stage,progress_detail,processed_chunks,total_chunks,error_message
  `;
  if (!rows.length) return;
  socketServer?.to(workspaceRoom(workspaceId)).emit('knowledge:progress', toProgressEvent(rows[0]));
}

export function toProgressEvent(row) {
  return {
    sourceId: row.source_id,
    status: row.status,
    progress: row.progress,
    stage: row.progress_stage,
    detail: row.progress_detail,
    processedChunks: row.processed_chunks,
    totalChunks: row.total_chunks,
    error: row.error_message,
  };
}
