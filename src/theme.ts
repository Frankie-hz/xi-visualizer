// Colours that mean something, in one place, so the diff, the editor and the mob list agree on
// what added, removed or a route looks like.

export const COLORS = {
  added: 0x34d399,
  removed: 0xf87171,
  reshaped: 0xfbbf24,
  unchanged: 0x64748b,
  /** Routes are violet, clear of the region hues and the cyan trails. */
  route: 0xa78bfa,
  /** A mob standing on its own fixed point. */
  fixed: 0x94a3b8,
} as const;

/** A three.js colour number as CSS. */
export const css = (color: number) => `#${color.toString(16).padStart(6, "0")}`;
