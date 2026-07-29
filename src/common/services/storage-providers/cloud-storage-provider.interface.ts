// Module: Storage Migration Phase 1 — the seam StorageService delegates to
// once USE_MOCK_STORAGE is off. Deliberately narrow (3 methods) and named
// distinctly from StorageService's own public API (uploadFile/getFile/
// checkHealth) so the facade and the provider are never confused with each
// other while reading a stack trace or a test file.
//
// Both S3StorageProvider and FirebaseStorageProvider implement this same
// shape; StorageService.uploadFile()/getFile()/checkHealth() never know or
// care which one is active — that's selected once, at DI-container build
// time, by the STORAGE_PROVIDER env var (see common.module.ts).
export interface CloudStorageProvider {
  /** Uploads `buffer` at `folder/fileName`, returns the resulting URL. */
  put(buffer: Buffer, folder: string, fileName: string, contentType: string): Promise<string>;

  /** Fetches an object by its storage key (folder/fileName, or a full URL — implementations resolve either). */
  get(key: string): Promise<{ buffer: Buffer; contentType: string }>;

  /** Side-effect-free reachability check; never throws. */
  health(): Promise<{ ok: boolean; error?: string }>;
}

export const CLOUD_STORAGE_PROVIDER = Symbol('CLOUD_STORAGE_PROVIDER');
