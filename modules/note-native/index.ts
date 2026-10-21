import NoteNativeModule from './src/NoteNativeModule';
import { NativeStreamResult, NativeVideoResult, PlatformInfo } from './src/NoteNative.types';

export * from './src/NoteNative.types';
export { default as NoteNativeModule } from './src/NoteNativeModule';

/** True when this binary actually contains the NØTE native module. */
export function isNoteNativeAvailable(): boolean {
  return NoteNativeModule != null;
}

/**
 * Proof-of-connection call across the TypeScript -> Kotlin boundary.
 * Returns null instead of throwing when the native module is absent.
 */
export function getPlatformInfo(): PlatformInfo | null {
  return NoteNativeModule?.getPlatformInfo() ?? null;
}

/**
 * Resolve a YouTube video id to a playable progressive audio stream using the
 * native NewPipe Extractor.
 *
 * Never throws: a missing module or a failed extraction both come back as a
 * structured failure result.
 */
export async function resolveYouTubeStream(
  videoId: string
): Promise<NativeStreamResult> {
  const module = NoteNativeModule;
  if (!module) {
    return {
      ok: false,
      reason: 'module_unavailable',
      message: 'NoteNative is not present in this binary',
    };
  }

  try {
    return await module.resolveYouTubeStream(videoId);
  } catch (e) {
    // A bridge-level failure (rather than an extraction failure) still has to
    // arrive as data, not as a thrown error.
    return {
      ok: false,
      reason: 'unknown',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Resolve a YouTube video id to a progressive, video-only (silent) stream, up
 * to `maxHeight` pixels tall. Never throws; failures come back as data.
 *
 * A binary built before this function existed has no `resolveYouTubeVideo`,
 * which is reported as `module_unavailable` instead of crashing.
 */
export async function resolveYouTubeVideo(
  videoId: string,
  maxHeight = 720
): Promise<NativeVideoResult> {
  const module = NoteNativeModule;
  if (!module || typeof module.resolveYouTubeVideo !== 'function') {
    return {
      ok: false,
      reason: 'module_unavailable',
      message: 'Video is not available in this build',
    };
  }

  try {
    return await module.resolveYouTubeVideo(videoId, maxHeight);
  } catch (e) {
    return {
      ok: false,
      reason: 'unknown',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
