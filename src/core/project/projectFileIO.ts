import { parseProject, serializeProject } from "./projectFile";
import type { ProjectDocument } from "./types";
import { readTextFile, remove, rename, stat, writeTextFile } from "@tauri-apps/plugin-fs";

export const MAX_PROJECT_FILE_BYTES = 64 * 1024 * 1024;

/** Write a sibling first, so a failed write cannot truncate the existing project. */
export async function writeProjectFile(path: string, document: ProjectDocument): Promise<void> {
  const text = serializeProject(document);
  if (new TextEncoder().encode(text).byteLength > MAX_PROJECT_FILE_BYTES) throw new Error("工程文件过大");
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  // A createNew failure may mean this path already belongs to someone else.
  // Only remove the temporary file after this call has successfully created it.
  await writeTextFile(temp, text, { createNew: true });
  try {
    await rename(temp, path);
  } finally {
    try { await remove(temp); } catch { /* renamed or cleanup unavailable */ }
  }
}

export async function readProjectFile(path: string): Promise<ProjectDocument> {
  if ((await stat(path)).size > MAX_PROJECT_FILE_BYTES) throw new Error("工程文件过大");
  const text = await readTextFile(path);
  if (new TextEncoder().encode(text).byteLength > MAX_PROJECT_FILE_BYTES) throw new Error("工程文件过大");
  return parseProject(text);
}
