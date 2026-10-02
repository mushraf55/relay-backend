import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '../config/env.js';

const required = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];
export function storageConfigured() { return required.every(name => env[name]?.trim()); }
export const storage = storageConfigured() ? new S3Client({
  region: 'auto', endpoint: env.R2_ENDPOINT,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
}) : null;
export const bucket = env.R2_BUCKET_NAME;
function ready() { if (!storage) throw new Error('Cloudflare R2 is not configured'); return storage; }
export async function checkStorage() { return ready().send(new HeadBucketCommand({ Bucket: bucket })); }
export async function putFile(key, body, contentType) {
  await ready().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}
export async function getFile(key) {
  const result = await ready().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await result.Body.transformToByteArray());
}
export async function deleteFile(key) { await ready().send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); }
