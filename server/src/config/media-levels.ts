/**
 * The levels of the media ladder, one per kind of media (the ladder itself is described where the config reads it, `config/types.ts`, above its
 * re-export). Moved out of the frozen `types.ts` (bundle-70) so that file's size ratchet makes room for a field without a raised ceiling.
 */
export type ImageLevel = 'off' | 'caption' | 'recognition' | 'auto';
export type AudioLevel = 'off' | 'on' | 'auto';
export type VideoLevel = 'off' | 'audio' | 'full' | 'auto';
export type TextLevel = 'off' | 'embed' | 'chunk' | 'auto';
