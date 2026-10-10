import { createHash, randomUUID } from "node:crypto";
import { open, link, unlink, lstat } from "node:fs/promises";
import path from "node:path";
import { ManagedClient, InputValidationError, RecoveryRequiredError } from "./client.js";

export async function downloadVideo(client: ManagedClient, id: string, target: string): Promise<number> {
  const state = await client.getExecution(id);
  if (state.status !== "completed" || !state.video_job) throw new InputValidationError("Video is not ready; retain the execution ID");
  const metadata = state.video_job.metadata as { sha256?: string; bytes?: number } | undefined;
  if (!metadata?.sha256 || !metadata.bytes) throw new InputValidationError("Video metadata is missing");
  try { await lstat(target); throw new InputValidationError("Destination exists; choose a new path"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temp = path.join(path.dirname(target), `.dreamlayer-video-${randomUUID()}.part`);
  const file = await open(temp, "wx", 0o600);
  let bytes = 0;
  try {
    const response = await client.videoDownloadResponse(id);
    if (!response.body) throw new RecoveryRequiredError("Missing video body; retry the same download");
    const reader = response.body.getReader();
    const hash = createHash("sha256");
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 256 * 1024 * 1024 || bytes > metadata.bytes) throw new InputValidationError("Video exceeds declared size");
        hash.update(chunk.value);
        await file.writeFile(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (bytes !== metadata.bytes || hash.digest("hex") !== metadata.sha256) throw new RecoveryRequiredError("Download checksum mismatch; retry delivery only");
    await file.sync();
    await file.close();
    await link(temp, target); // Atomic publish without overwriting an existing destination.
    return bytes;
  } finally { await file.close().catch(() => {}); await unlink(temp).catch(() => {}); }
}
