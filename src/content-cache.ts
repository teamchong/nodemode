// ContentCache — hot in-memory file cache backed by zerobuf Arena
//
// Architecture:
//   zerobuf Arena (WASM Memory)  — hot tier, sub-μs reads, zero-copy views
//   SQLite file_cache            — warm tier, persists across DO evictions
//   R2                           — cold tier, durable
//
// File content is stored as raw bytes in the arena. A Map tracks
// path → {offset, length} for O(1) lookup. Reads return a Uint8Array
// view directly into WASM memory — no copies.

import { Arena } from "zerobuf";

interface CacheEntry {
  offset: number; // byte offset in WASM memory
  length: number; // byte length
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024; // 32MB hot cache
const PAGE_SIZE = 65536; // WASM page = 64KB

export class ContentCache {
  private arena: Arena;
  private entries = new Map<string, CacheEntry>();
  private totalBytes = 0;
  private maxBytes: number;

  constructor(maxBytes: number = DEFAULT_MAX_BYTES) {
    this.maxBytes = maxBytes;
    // Start with 1 page (64KB), grow as needed
    const memory = new WebAssembly.Memory({ initial: 1 });
    this.arena = new Arena(memory, 0, {
      maxPages: Math.ceil(maxBytes / PAGE_SIZE) + 1,
    });
  }

  /** Store file content in WASM memory. Returns true if cached. */
  put(path: string, data: Uint8Array): boolean {
    // Don't cache if single file exceeds budget
    if (data.byteLength > this.maxBytes / 2) return false;

    // Evict if adding this would exceed budget
    if (this.totalBytes + data.byteLength > this.maxBytes) {
      this.clear();
    }

    const offset = this.arena.allocBytes(data, 1);
    this.entries.set(path, { offset, length: data.byteLength });
    this.totalBytes += data.byteLength;
    return true;
  }

  /** Get a zero-copy Uint8Array view into WASM memory. Returns null if not cached. */
  get(path: string): Uint8Array | null {
    const entry = this.entries.get(path);
    if (!entry) return null;
    return new Uint8Array(this.arena.memory.buffer, entry.offset, entry.length);
  }

  /** Get raw location for WASM-level scanning (future SIMD). */
  getLocation(path: string): { buffer: ArrayBuffer; offset: number; length: number } | null {
    const entry = this.entries.get(path);
    if (!entry) return null;
    return { buffer: this.arena.memory.buffer, offset: entry.offset, length: entry.length };
  }

  /** Check if path is cached. */
  has(path: string): boolean {
    return this.entries.has(path);
  }

  /** Remove a single entry (on file write/delete). */
  invalidate(path: string): void {
    const entry = this.entries.get(path);
    if (entry) {
      this.totalBytes -= entry.length;
      this.entries.delete(path);
      // Arena is append-only — space is not reclaimed until clear()
    }
  }

  /** Clear entire cache, reset arena. */
  clear(): void {
    const memory = new WebAssembly.Memory({ initial: 1 });
    this.arena = new Arena(memory, 0, {
      maxPages: Math.ceil(this.maxBytes / PAGE_SIZE) + 1,
    });
    this.entries.clear();
    this.totalBytes = 0;
  }

  /** Current cache size in bytes. */
  get size(): number {
    return this.totalBytes;
  }

  /** Number of cached files. */
  get count(): number {
    return this.entries.size;
  }
}
