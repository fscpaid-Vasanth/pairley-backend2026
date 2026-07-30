import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

/**
 * Module 14 Phase 3C — bundled typography for banner rendering.
 *
 * **Must be imported before anything that loads `sharp`.** libvips reads its
 * fontconfig settings once, at initialisation; setting `FONTCONFIG_FILE`
 * afterwards has no effect. `main.ts` imports this first, alongside
 * `instrument.ts`, for that reason.
 *
 * Why this exists: banner text was rendering in whatever face the host
 * happened to provide. Measured on the build machine, `font-family="Arial"`
 * and `"Georgia"` resolved to distinct faces while `sans-serif`, `serif`,
 * `monospace` and a deliberately nonexistent family all collapsed to one
 * default — a monospace one. So banner layout had to be sized for the widest
 * plausible glyphs, and would have differed between local, Docker and Render.
 *
 * Two approaches were tried and rejected before this one:
 *
 *  - **`@font-face` with a base64 data URI inside the SVG.** Verified
 *    ineffective: rendering with and without the `@font-face` block produced
 *    byte-identical output. librsvg does not load webfonts.
 *  - **Google Fonts TTF endpoint.** Returns a proprietary compressed subset
 *    (header `b4f50400`, not the `00010000` of real TrueType), unusable by
 *    fontconfig.
 *
 * What works is a real TrueType file on disk plus a fontconfig config
 * pointing at it. The TTFs are converted from `@fontsource/inter`'s woff2
 * (latin subset, ~65KB per weight) and committed, so no network access or
 * conversion step is needed at build or run time.
 */

const FONT_FAMILY = 'Inter';

/**
 * `assets/fonts` sits at the project root. This module runs from `src/` under
 * ts-node and from `dist/src/` after a build, so both depths are tried rather
 * than assuming one.
 */
function locateFontDir(): string | null {
  const candidates = [
    resolve(__dirname, '..', 'assets', 'fonts'), // src/  -> project root
    resolve(__dirname, '..', '..', 'assets', 'fonts'), // dist/src/ -> project root
    resolve(process.cwd(), 'assets', 'fonts'),
  ];
  return candidates.find((dir) => existsSync(dir)) ?? null;
}

function buildFontConfig(fontDir: string, cacheDir: string): string {
  // The `sans-serif` alias matters as much as the <dir>: existing banner
  // markup asks for generic families, and on a stripped container image
  // those resolve to whatever single face is installed.
  return `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontDir}</dir>
  <cachedir>${cacheDir}</cachedir>

  <match target="pattern">
    <test qual="any" name="family"><string>sans-serif</string></test>
    <edit name="family" mode="prepend" binding="strong"><string>${FONT_FAMILY}</string></edit>
  </match>

  <alias>
    <family>sans-serif</family>
    <prefer><family>${FONT_FAMILY}</family></prefer>
  </alias>

  <alias>
    <family>system-ui</family>
    <prefer><family>${FONT_FAMILY}</family></prefer>
  </alias>
</fontconfig>
`;
}

export interface FontSetupResult {
  configured: boolean;
  fontDir: string | null;
  configPath: string | null;
  reason?: string;
}

/**
 * Idempotent and non-fatal. If the fonts can't be found or the config can't
 * be written, banner rendering falls back to whatever the host provides —
 * uglier, but the application still starts and offers still render.
 */
export function configureBundledFonts(): FontSetupResult {
  if (process.env.FONTCONFIG_FILE) {
    return {
      configured: true,
      fontDir: null,
      configPath: process.env.FONTCONFIG_FILE,
      reason: 'FONTCONFIG_FILE already set by the environment — left alone',
    };
  }

  const fontDir = locateFontDir();
  if (!fontDir) {
    return {
      configured: false,
      fontDir: null,
      configPath: null,
      reason: 'assets/fonts not found',
    };
  }

  try {
    const cacheDir = join(tmpdir(), 'pairley-fontconfig-cache');
    mkdirSync(cacheDir, { recursive: true });

    const configPath = join(tmpdir(), 'pairley-fonts.conf');
    writeFileSync(configPath, buildFontConfig(fontDir, cacheDir), 'utf-8');

    process.env.FONTCONFIG_FILE = configPath;
    // Some builds consult FONTCONFIG_PATH (a directory) instead.
    process.env.FONTCONFIG_PATH = tmpdir();

    return { configured: true, fontDir, configPath };
  } catch (err) {
    return {
      configured: false,
      fontDir,
      configPath: null,
      reason: err instanceof Error ? err.message : 'unknown error',
    };
  }
}

export const BANNER_FONT_FAMILY = FONT_FAMILY;

// Runs on import, before any sharp/libvips initialisation.
export const fontSetup = configureBundledFonts();
