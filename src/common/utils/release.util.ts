export function getRelease(): string {
  return process.env.RELEASE_SHA || process.env.RENDER_GIT_COMMIT || 'unknown';
}
