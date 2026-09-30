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

/** How close, as a share of the colour wheel, a region's hue may come to the ground under it. */
const CLASH = 0.125;

/**
 * A region's hue, turned away from the colour of the ground it lies on when the two are close: a
 * yellow region over sand, or a green one over grass, reads as more ground. Ground with little
 * colour in it (stone, snow) clashes with nothing and is left alone. `ground` is HSL, 0 to 1 each.
 */
export function contrastHue(hue: number, ground?: { h: number; s: number; l: number; }): number {
  if (!ground || ground.s < 0.25) return hue;
  const apart = Math.abs(((hue - ground.h + 1.5) % 1) - 0.5);
  if (apart >= CLASH) return hue;
  // A quarter turn, on the side the hue already leans, so neighbours keep their order.
  const side = ((hue - ground.h + 1) % 1) < 0.5 ? 1 : -1;
  return (ground.h + side * 0.25 + 1) % 1;
}
