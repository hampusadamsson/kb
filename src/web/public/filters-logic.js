// Pure filter-bar logic (no DOM): label option ordering, search and negation.

/** How many labels always shown as inline checkboxes. */
export const TOP_LABELS = 5;

/** Sorted copy of label options: count desc, then name asc. */
export function sortLabelOptions(labels) {
  return [...(labels ?? [])].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The first `n` labels (by count). */
export function topLabels(labels, n = TOP_LABELS) {
  return sortLabelOptions(labels).slice(0, Math.max(0, n));
}

/** Labels matching a case-insensitive substring query ("" = all, sorted). */
export function filterLabelOptions(labels, query) {
  const q = String(query ?? "")
    .trim()
    .toLowerCase();
  const all = sortLabelOptions(labels);
  return q ? all.filter((o) => o.name.toLowerCase().includes(q)) : all;
}

/** "!bug" → "bug", "bug" → "bug". */
export const labelName = (v) => (String(v).startsWith("!") ? String(v).slice(1) : String(v));
export const isNegated = (v) => String(v).startsWith("!");

/** Selected labels without the leading "!" (selected negations cannot be merged). */
export function selectedNames(labels) {
  return (labels ?? []).filter((v) => !isNegated(v)).map((v) => labelName(v));
}

/** Counts of still-selected labels that are hidden behind the dropdown (i.e. not in `top`). */
export function hiddenSelected(labels, top) {
  const shown = new Set((top ?? []).map((o) => o.name));
  return selectedNames(labels).filter((n) => !shown.has(n)).length;
}

/**
 * New label list after toggling `name`.
 * Clicking an unchecked label replaces a same-named negation; "!" stays a separate entry.
 */
export function toggleLabel(labels, name) {
  const items = [...(labels ?? [])];
  const i = items.findIndex((v) => v === name);
  if (i >= 0) return items.filter((v) => v !== name);
  return [...items.filter((v) => v !== `!${name}`), name];
}

/** Add a negated label (`"!bug"`); replaces a same-named positive entry. */
export function addNegation(labels, name) {
  const items = [...(labels ?? [])];
  const neg = `!${name}`;
  if (items.includes(neg)) return items;
  return [...items.filter((v) => v !== name), neg];
}

/** Drop a label entry by its exact value ("bug" or "!bug"). */
export function removeLabel(labels, value) {
  return [...(labels ?? [])].filter((v) => v !== value);
}
