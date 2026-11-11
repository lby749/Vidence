import { getDb } from '@/db/db';
import { markIndexDirty } from './index-service';

/** 浏览器和独立应用共用：只删除指定视频的数据。 */
export async function deleteVideoData(videoId: string) {
  const db = getDb();
  const [evidence, keyframes, nodes, sessions, vectors, chats, requests] = await Promise.all([
    db.evidence.where('videoId').equals(videoId).primaryKeys(), db.keyframes.where('videoId').equals(videoId).primaryKeys(),
    db.nodes.where('videoId').equals(videoId).primaryKeys(), db.sessions.where('videoId').equals(videoId).primaryKeys(),
    db.vectors.where('videoId').equals(videoId).primaryKeys(), db.chats.where('videoId').equals(videoId).primaryKeys(),
    db.aiRequests.where('videoId').equals(videoId).primaryKeys(),
  ]);
  const nodeIds = new Set(nodes);
  const relatedSyncs = (await db.syncState.toArray()).filter(row => (row.entityType === 'video' && row.localId === videoId) || (row.entityType === 'node' && nodeIds.has(row.localId)));
  await db.transaction('rw', [db.videos, db.sessions, db.evidence, db.keyframes, db.nodes, db.vectors, db.chats, db.syncState, db.longMemories, db.aiRequests], async () => {
    await db.evidence.bulkDelete(evidence); await db.keyframes.bulkDelete(keyframes); await db.nodes.bulkDelete(nodes);
    await db.sessions.bulkDelete(sessions); await db.vectors.bulkDelete(vectors); await db.chats.bulkDelete(chats);
    await db.aiRequests.bulkDelete(requests); await db.longMemories.delete(videoId);
    for (const sync of relatedSyncs) await db.syncState.delete(sync.id);
    await db.videos.delete(videoId);
  });
  markIndexDirty();
  return { ok: true as const, removed: { evidence: evidence.length, keyframes: keyframes.length, nodes: nodes.length, sessions: sessions.length } };
}
