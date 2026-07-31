// Module: Storage Migration Phase 1 — the seam StorageService delegates to
// once USE_MOCK_STORAGE is off. Deliberately narrow (now 4 methods) and
// named distinctly from StorageService's own public API (uploadFile/
// getFile/checkHealth/deleteFile) so the facade and the provider are never
// confused with each other while reading a stack trace or a test file.
//
// Both S3StorageProvider and FirebaseStorageProvider implement this same
// shape; StorageService.uploadFile()/getFile()/checkHealth()/deleteFile()
// never know or care which one is active — that's selected once, at
// DI-container build time, by the STORAGE_PROVIDER env var (see
// common.module.ts).
export interface CloudStorageProvider {
  /** Uploads `buffer` at `folder/fileName`, returns the resulting URL. */
  put(
    buffer: Buffer,
    folder: string,
    fileName: string,
    contentType: string,
  ): Promise<string>;

  /** Fetches an object by its storage key (folder/fileName, or a full URL — implementations resolve either). */
  get(key: string): Promise<{ buffer: Buffer; contentType: string }>;

  /**
   * Removes an object by its storage key (folder/fileName, or a full URL).
   * Best-effort: implementations must never throw — a delete failure (the
   * object never existed, a permissions denial) must never block the
   * caller's actual action (e.g. an admin removing a gallery image from a
   * draft they're editing). Callers treat this as fire-and-forget.
   */
  remove(key: string): Promise<void>;

  /** Side-effect-free reachability check; never throws. */
  health(): Promise<{ ok: boolean; error?: string }>;
}

export const CLOUD_STORAGE_PROVIDER = Symbol('CLOUD_STORAGE_PROVIDER');
