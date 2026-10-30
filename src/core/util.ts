export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "ticket";
}

export const padId = (n: number): string => String(n).padStart(3, "0");

export function filenameFor(id: number | string, name: string): string {
  return `${slugify(String(id))}-${slugify(name)}.md`;
}
