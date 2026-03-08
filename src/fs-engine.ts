// FsEngine — maps Node.js fs operations to R2 + DO SQLite
//
// Storage strategy (same pattern as gitmode):
//   R2 (FS_BUCKET)  — file content (blobs)
//   DO SQLite       — directory index (path, size, mode, mtime)
//                   — hot file cache (small files cached in SQLite for <1ms reads)
//
// R2 key structure:
//   {workspace}/{path}  — file content
//
// Directory semantics:
//   R2 is flat key-value. Directory listing uses SQLite index.
//   mkdir creates a directory marker row in SQLite.
//   readdir queries SQLite for children of a path prefix.

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

const MAX_CACHE_SIZE = 64 * 1024; // Cache files < 64KB in SQLite
const PATH_SEP = "/";

export class FsEngine {
  constructor(
    private bucket: R2Bucket,
    private sql: SqlStorage,
    private workspace: string,
  ) {}

  // -- Read operations --

  async readFile(path: string): Promise<Uint8Array | null> {
    const normalized = normalizePath(path);

    // Check SQLite cache first (<1ms)
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
    if (data.byteLength <= MAX_CACHE_SIZE) {
      this.sql.exec(
        "INSERT OR REPLACE INTO file_cache (path, data, cached_at) VALUES (?, ?, ?)",
        normalized,
        data,
        Date.now(),
      );
    }

    return data;
  }

  async readFileText(path: string): Promise<string | null> {
    const data = await this.readFile(path);
    if (!data) return null;
    return new TextDecoder().decode(data);
  }

  // -- Write operations --

  async writeFile(
    path: string,
    data: Uint8Array | string,
    mode: number = 0o644,
  ): Promise<void> {
    const normalized = normalizePath(path);
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
    if (bytes.byteLength <= MAX_CACHE_SIZE) {
      this.sql.exec(
        "INSERT OR REPLACE INTO file_cache (path, data, cached_at) VALUES (?, ?, ?)",
        normalized,
        bytes,
        now,
      );
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
      await this.writeFile(path, merged);
    } else {
      await this.writeFile(path, append);
    }
  }

  // -- Delete operations --

  async unlink(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const key = this.r2Key(normalized);

    await this.bucket.delete(key);
    this.sql.exec("DELETE FROM files WHERE path = ?", normalized);
    this.sql.exec("DELETE FROM file_cache WHERE path = ?", normalized);
  }

  async rmdir(path: string, recursive: boolean = false): Promise<void> {
    const normalized = normalizePath(path);

    if (recursive) {
      // Delete all children from R2
      const children = this.sql
        .exec(
          "SELECT r2_key FROM files WHERE path LIKE ? || '/%'",
          normalized,
        )
        .toArray();

      const keys = children.map((c) => c.r2_key as string);
      // R2 delete supports up to 1000 keys at a time
      for (let i = 0; i < keys.length; i += 1000) {
        await this.bucket.delete(keys.slice(i, i + 1000));
      }

      // Delete from index
      this.sql.exec(
        "DELETE FROM files WHERE path = ? OR path LIKE ? || '/%'",
        normalized,
        normalized,
      );
      this.sql.exec(
        "DELETE FROM file_cache WHERE path LIKE ? || '/%'",
        normalized,
      );
    } else {
      // Check if empty
      const children = this.sql
        .exec(
          "SELECT COUNT(*) as cnt FROM files WHERE path LIKE ? || '/%' AND path NOT LIKE ? || '/%/%'",
          normalized,
          normalized,
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

    if (recursive) {
      this.ensureParentDirs(normalized);
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

    // Get all entries under this prefix
    const rows = this.sql
      .exec(
        `SELECT path, is_dir FROM files WHERE path LIKE ?`,
        prefix + "%",
      )
      .toArray();

    // Extract direct children by taking the first path segment after prefix
    const entries: DirEntry[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
      const fullPath = row.path as string;
      const relative = fullPath.slice(prefix.length);
      if (!relative) continue;
      const name = relative.split("/")[0];
      if (!name || seen.has(name)) continue;
      seen.add(name);

      // It's a directory if the entry itself is a dir, or if there are deeper paths
      const isDir = (row.is_dir as number) === 1 || relative.includes("/");
      entries.push({ name, isDirectory: isDir });
    }

    return entries;
  }

  // -- Metadata operations --

  stat(path: string): FileStat | null {
    const normalized = normalizePath(path);
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
    const rows = this.sql
      .exec("SELECT 1 FROM files WHERE path = ? LIMIT 1", normalized)
      .toArray();
    return rows.length > 0;
  }

  chmod(path: string, mode: number): void {
    const normalized = normalizePath(path);
    this.sql.exec("UPDATE files SET mode = ? WHERE path = ?", mode, normalized);
  }

  // -- Rename --

  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldNorm = normalizePath(oldPath);
    const newNorm = normalizePath(newPath);
    const oldKey = this.r2Key(oldNorm);
    const newKey = this.r2Key(newNorm);

    // Copy in R2
    const obj = await this.bucket.get(oldKey);
    if (!obj) throw new Error(`ENOENT: no such file '${oldPath}'`);
    await this.bucket.put(newKey, obj.body);
    await this.bucket.delete(oldKey);

    // Update index
    this.sql.exec(
      "UPDATE files SET path = ?, r2_key = ? WHERE path = ?",
      newNorm,
      newKey,
      oldNorm,
    );
    this.sql.exec("DELETE FROM file_cache WHERE path = ?", oldNorm);
  }

  // -- Bulk operations --

  async listAllFiles(prefix: string = ""): Promise<string[]> {
    const normalized = prefix ? normalizePath(prefix) : "";
    const rows = this.sql
      .exec(
        "SELECT path FROM files WHERE is_dir = 0 AND path LIKE ? || '%'",
        normalized,
      )
      .toArray();
    return rows.map((r) => r.path as string);
  }

  // -- Internal helpers --

  private r2Key(normalizedPath: string): string {
    return `${this.workspace}/${normalizedPath}`;
  }

  private ensureParentDirs(path: string): void {
    const parts = path.split(PATH_SEP);
    const now = Date.now();
    for (let i = 1; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join(PATH_SEP);
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
}

function normalizePath(path: string): string {
  // Remove leading/trailing slashes, collapse double slashes
  return path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\/+/g, "/");
}
