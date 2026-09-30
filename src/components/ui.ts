// Class strings for the controls on .plain-ui pages, the regions editor and its diff, which opt out of
// the app-wide button and input styles in index.css. One vocabulary: anything that acts like a
// button looks like one, including the links to github.com.

const base = "px-2 py-1 rounded no-underline whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed";

export const BTN = {
  /** The ordinary button. */
  plain: `${base} bg-slate-700 hover:bg-slate-600 disabled:hover:bg-slate-700 text-white`,
  /** Second in line: Cancel, Discard, Done. */
  quiet: `${base} bg-slate-600 hover:bg-slate-500 disabled:hover:bg-slate-600 text-white`,
  /** The thing to do next: Save, Sign in, Open pull request. */
  go: `${base} bg-emerald-600 hover:bg-emerald-500 disabled:hover:bg-emerald-600 text-white`,
  /** Something that needs a second look: Restore a draft. */
  warn: `${base} bg-amber-600 hover:bg-amber-500 text-white`,
  /** Destroys something, armed by a first click. */
  danger: `${base} bg-red-700 hover:bg-red-600 text-white`,
  /** A small glyph beside a list row. Carries an aria-label, since the glyph is all it shows. */
  icon: "px-1 leading-none text-slate-400 hover:text-white",
  /** The same, for removing the row. */
  iconDanger: "px-1 leading-none text-slate-400 hover:text-red-400",
};

/** A text field or select on a dark panel. */
export const FIELD = "px-2 py-1 bg-slate-700 rounded border border-slate-600 focus:border-slate-400 outline-none";
