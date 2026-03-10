// FsEngine — maps Node.js fs operations to R2 + DO SQLite
//
// Storage strategy (same pattern as gitmode):
//   R2 (FS_BUCKET)  — file content (blobs)
//   DO SQLite       — directory index (path, size, mode, mtime)
//                   — hot file cache (small files cached in SQLite for sub-ms reads)
//
// R2 key structure:
//   {workspace}/{path}  — file content
//
// Directory semantics:
//   R2 is flat key-value. Directory listing uses SQLite index.
//   mkdir creates a directory marker row in SQLite.
//   readdir queries SQLite for direct children only (single-level prefix).

import { validatePath } from "./validate";

export interface FileStat {
  size: number;
  mode: number;
  mtime: number;
  isDirectory: boolean;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

const MAX_CACHE_FILE_SIZE = 64 * 1024; // Cache files smaller than 64KB in SQLite
const MAX_CACHE_ENTRIES = 500; // Evict oldest entries beyond this count

export class FsEngine {
  constructor(
    private bucket: R2Bucket,
    private sql: SqlStorage,
    private workspace: string,
  ) {}

  // -- Read operations --

  async readFile(path: string): Promise<Uint8Array | null> {
    const normalized = normalizePath(path);
    validatePath(normalized);

    // Check SQLite cache first (sub-ms)
    const cached = this.sql
      .exec("SELECT data FROM file_cache WHERE path = ?", normalized)
      .toArray();
    if (cached.length > 0) {
      return new Uint8Array(cached[0].data as ArrayBuffer);
    }

    // Fall back to R2 (~10-50ms)
    const key = this.r2Key(normalized);
    const obj = await this.bucket.get(key);
    if (!obj) return null;

    const data = new Uint8Array(await obj.arrayBuffer());

    // Cache small files in SQLite for next read
    if (data.byteLength <= MAX_CACHE_FILE_SIZE) {
      this.sql.exec(
        "INSERT OR REPLACE INTO file_cache (path, data, cached_at) VALUES (?, ?, ?)",
        normalized,
        data,
        Date.now(),
      );
      this.evictCacheIfNeeded();
    }

    return data;
  }

  async readFileText(path: string): Promise<string | null> {
    const data = await this.readFile(path);
    if (!data) return null;
    return new TextDecoder().decode(data);
  }

  // Streaming read for large files — returns R2 body directly
  async readFileStream(path: string): Promise<ReadableStream | null> {
    const normalized = normalizePath(path);
    validatePath(normalized);
    const key = this.r2Key(normalized);
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return obj.body;
  }

  // -- Write operations --

  async writeFile(
    path: string,
    data: Uint8Array | string,
    mode: number = 0o644,
  ): Promise<void> {
    const normalized = normalizePath(path);
    validatePath(normalized);

    // Cannot write to a directory path
    const existing = this.stat(normalized);
    if (existing?.isDirectory) {
      throw new Error(`EISDIR: illegal operation on a directory '${path}'`);
    }

    const key = this.r2Key(normalized);
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : data;

    // Ensure parent directories exist in index
    this.ensureParentDirs(normalized);

    // Write to R2
    await this.bucket.put(key, bytes);

    // Update index
    const now = Date.now();
    this.sql.exec(
      `INSERT OR REPLACE INTO files (path, r2_key, size, mode, mtime, is_dir)
       VALUES (?, ?, ?, ?, ?, 0)`,
      normalized,
      key,
      bytes.byteLength,
      mode,
      now,
    );

    // Update cache if small enough
    if (bytes.byteLength <= MAX_CACHE_FILE_SIZE) {
      this.sql.exec(
        "INSERT OR REPLACE INTO file_cache (path, data, cached_at) VALUES (?, ?, ?)",
        normalized,
        bytes,
        now,
      );
      this.evictCacheIfNeeded();
    } else {
      // Evict from cache if file grew too large
      this.sql.exec("DELETE FROM file_cache WHERE path = ?", normalized);
    }
  }

  async appendFile(path: string, data: Uint8Array | string): Promise<void> {
    const existing = await this.readFile(path);
    const append =
      typeof data === "string" ? new TextEncoder().encode(data) : data;

    if (existing) {
      const merged = new Uint8Array(existing.byteLength + append.byteLength);
      merged.set(existing, 0);
      merged.set(append, existing.byteLength);
      // Preserve existing file mode
      const stat = this.stat(path);
      await this.writeFile(path, merged, stat?.mode);
    } else {
      await this.writeFile(path, append);
    }
  }

  // -- Delete operations --

  async unlink(path: string): Promise<void> {
    const normalized = normalizePath(path);
    validatePath(normalized);

    const existing = this.stat(normalized);
    if (existing?.isDirectory) {
      throw new Error(`EISDIR: illegal operation on a directory '${path}'`);
    }

    const key = this.r2Key(normalized);
    await this.bucket.delete(key);
    this.sql.exec("DELETE FROM files WHERE path = ?", normalized);
    this.sql.exec("DELETE FROM file_cache WHERE path = ?", normalized);
  }

  async rmdir(path: string, recursive: boolean = false): Promise<void> {
    const normalized = normalizePath(path);
    validatePath(normalized);

    const existing = this.stat(normalized);
    if (!existing) {
      throw new Error(`ENOENT: no such file or directory '${path}'`);
    }
    if (!existing.isDirectory) {
      throw new Error(`ENOTDIR: not a directory '${path}'`);
    }

    const escaped = escapeLike(normalized);

    if (recursive) {
      // Delete all children from R2 in batches of 1000
      const children = this.sql
        .exec(
          "SELECT r2_key FROM files WHERE path LIKE ? ESCAPE '\\'",
          escaped + "/%",
        )
        .toArray();

      const keys = children
        .map((c) => c.r2_key as string)
        .filter((k) => k !== "");
      for (let i = 0; i < keys.length; i += 1000) {
        await this.bucket.delete(keys.slice(i, i + 1000));
      }

      // Delete from index
      this.sql.exec(
        "DELETE FROM files WHERE path = ? OR path LIKE ? ESCAPE '\\'",
        normalized,
        escaped + "/%",
      );
      this.sql.exec(
        "DELETE FROM file_cache WHERE path = ? OR path LIKE ? ESCAPE '\\'",
        normalized,
        escaped + "/%",
      );
    } else {
      // Check if empty — only look at direct children
      const children = this.sql
        .exec(
          "SELECT COUNT(*) as cnt FROM files WHERE path LIKE ? ESCAPE '\\' AND path NOT LIKE ? ESCAPE '\\'",
          escaped + "/%",
          escaped + "/%/%",
        )
        .toArray();
      if ((children[0].cnt as number) > 0) {
        throw new Error(`ENOTEMPTY: directory not empty '${path}'`);
      }
      this.sql.exec("DELETE FROM files WHERE path = ?", normalized);
    }
  }

  // -- Directory operations --

  mkdir(path: string, recursive: boolean = false): void {
    const normalized = normalizePath(path);
    validatePath(normalized);

    // Check if a file (not directory) already exists at this path
    const existing = this.stat(normalized);
    if (existing && !existing.isDirectory) {
      throw new Error(`EEXIST: file already exists '${path}'`);
    }

    if (recursive) {
      this.ensureParentDirs(normalized);
    } else {
      // Without -p, parent must exist
      const parts = normalized.split("/");
      if (parts.length > 1) {
        const parent = parts.slice(0, -1).join("/");
        if (!this.exists(parent)) {
          throw new Error(`ENOENT: no such file or directory '${path}'`);
        }
      }
    }

    const now = Date.now();
    this.sql.exec(
      `INSERT OR IGNORE INTO files (path, r2_key, size, mode, mtime, is_dir)
       VALUES (?, '', 0, ?, ?, 1)`,
      normalized,
      0o755,
      now,
    );
  }

  readdir(path: string): DirEntry[] {
    const normalized = normalizePath(path) || "";
    const prefix = normalized ? normalized + "/" : "";

    // Query only direct children: entries whose path starts with prefix
    // and does NOT contain another "/" after the prefix.
    // We still need to detect implicit directories (entries deeper than
    // one level imply a directory at level 1), so we query one level
    // and also check for deeper entries.
    const escaped = escapeLike(prefix);
    const directRows = this.sql
      .exec(
        `SELECT path, is_dir FROM files
         WHERE path LIKE ? ESCAPE '\\' AND path NOT LIKE ? ESCAPE '\\'`,
        escaped + "%",
        escaped + "%/%",
      )
      .toArray();

    const entries = new Map<string, boolean>();

    // Direct children (files and explicit directories at this level)
    for (const row of directRows) {
      const fullPath = row.path as string;
      const name = fullPath.slice(prefix.length);
      if (!name) continue;
      entries.set(name, (row.is_dir as number) === 1);
    }

    // Detect implicit directories: entries deeper than one level
    // have a parent segment that is an implicit directory
    const deepRows = this.sql
      .exec(
        `SELECT DISTINCT SUBSTR(path, ?, INSTR(SUBSTR(path, ?), '/') - 1) as child_name
         FROM files
         WHERE path LIKE ? ESCAPE '\\' AND path LIKE ? ESCAPE '\\'`,
        prefix.length + 1,
        prefix.length + 1,
        escaped + "%",
        escaped + "%/%",
      )
      .toArray();

    for (const row of deepRows) {
      const name = row.child_name as string;
      if (name && !entries.has(name)) {
        entries.set(name, true);
      }
    }

    return Array.from(entries, ([name, isDirectory]) => ({
      name,
      isDirectory,
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  // -- Metadata operations --

  stat(path: string): FileStat | null {
    const normalized = normalizePath(path);
    validatePath(normalized);
    // Root directory always exists
    if (!normalized) return { size: 0, mode: 0o755, mtime: 0, isDirectory: true };
    const rows = this.sql
      .exec(
        "SELECT size, mode, mtime, is_dir FROM files WHERE path = ?",
        normalized,
      )
      .toArray();
    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      size: row.size as number,
      mode: row.mode as number,
      mtime: row.mtime as number,
      isDirectory: (row.is_dir as number) === 1,
    };
  }

  exists(path: string): boolean {
    const normalized = normalizePath(path);
    validatePath(normalized);
    if (!normalized) return true; // Root always exists
    const rows = this.sql
      .exec("SELECT 1 FROM files WHERE path = ? LIMIT 1", normalized)
      .toArray();
    return rows.length > 0;
  }

  chmod(path: string, mode: number): void {
    const normalized = normalizePath(path);
    validatePath(normalized);
    this.sql.exec("UPDATE files SET mode = ? WHERE path = ?", mode, normalized);
  }

  touch(path: string): void {
    const normalized = normalizePath(path);
    validatePath(normalized);
    this.sql.exec("UPDATE files SET mtime = ? WHERE path = ?", Date.now(), normalized);
  }

  // -- Rename --

  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldNorm = normalizePath(oldPath);
    const newNorm = normalizePath(newPath);
    validatePath(oldNorm);
    validatePath(newNorm);

    const stat = this.stat(oldNorm);
    if (!stat) throw new Error(`ENOENT: no such file '${oldPath}'`);

    // Cannot rename a directory into itself
    if (newNorm.startsWith(oldNorm + "/")) {
      throw new Error(`EINVAL: cannot move '${oldPath}' to a subdirectory of itself`);
    }

    // Remove destination if it exists (rename overwrites)
    const destStat = this.stat(newNorm);
    if (destStat) {
      if (destStat.isDirectory) {
        await this.rmdir(newNorm, true);
      } else {
        await this.unlink(newNorm);
      }
    }

    this.ensureParentDirs(newNorm);

    // Move all entries (works for both single files and directories)
    const escapedOld = escapeLike(oldNorm);
    const children = this.sql
      .exec(
        "SELECT path, r2_key FROM files WHERE path = ? OR path LIKE ? ESCAPE '\\'",
        oldNorm,
        escapedOld + "/%",
      )
      .toArray();

    for (const child of children) {
      const childPath = child.path as string;
      const childR2Key = child.r2_key as string;
      const newChildPath = newNorm + childPath.slice(oldNorm.length);
      const newChildR2Key = childR2Key ? this.r2Key(newChildPath) : "";

      if (childR2Key) {
        const obj = await this.bucket.get(childR2Key);
        if (obj) {
          await this.bucket.put(newChildR2Key, obj.body);
          await this.bucket.delete(childR2Key);
        }
      }

      this.sql.exec(
        "UPDATE files SET path = ?, r2_key = ? WHERE path = ?",
        newChildPath,
        newChildR2Key,
        childPath,
      );
    }

    this.sql.exec(
      "DELETE FROM file_cache WHERE path = ? OR path LIKE ? ESCAPE '\\'",
      oldNorm,
      escapedOld + "/%",
    );
  }

  // -- Internal helpers --

  private r2Key(normalizedPath: string): string {
    return `${this.workspace}/${normalizedPath}`;
  }

  ensureParentDirs(path: string): void {
    const parts = path.split("/");
    if (parts.length <= 1) return; // No parents needed

    // Fast path: if immediate parent exists, all ancestors must too
    const immediateParent = parts.slice(0, -1).join("/");
    if (immediateParent) {
      const exists = this.sql
        .exec("SELECT 1 FROM files WHERE path = ? LIMIT 1", immediateParent)
        .toArray();
      if (exists.length > 0) return;
    }

    const now = Date.now();
    for (let i = 1; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join("/");
      if (!dirPath) continue;
      this.sql.exec(
        `INSERT OR IGNORE INTO files (path, r2_key, size, mode, mtime, is_dir)
         VALUES (?, '', 0, ?, ?, 1)`,
        dirPath,
        0o755,
        now,
      );
    }
  }

  private evictCacheIfNeeded(): void {
    const count = this.sql
      .exec("SELECT COUNT(*) as cnt FROM file_cache")
      .toArray()[0].cnt as number;
    if (count > MAX_CACHE_ENTRIES) {
      // Delete oldest entries beyond the limit
      this.sql.exec(
        `DELETE FROM file_cache WHERE path IN (
           SELECT path FROM file_cache ORDER BY cached_at ASC LIMIT ?
         )`,
        count - MAX_CACHE_ENTRIES,
      );
    }
  }
}

export function normalizePath(path: string): string {
  const parts = path.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") { resolved.pop(); }
    else { resolved.push(part); }
  }
  return resolved.join("/");
}

// Escape LIKE pattern metacharacters so they match literally.
// Must be paired with ESCAPE '\\' in SQL (which is ESCAPE '\' in SQLite).
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}
