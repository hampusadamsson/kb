import { columnsFor, createKanban } from "../../core/index.js";

const uniq = (xs: string[]): string[] => [...new Set(xs)];

/** Candidates for shell completion. Never throws; returns [] on any error. */
export function complete(cwd: string, kind: string, arg?: string): string[] {
  try {
    const { config, tickets } = createKanban({ dir: cwd }).load();
    const withId = tickets.filter((t) => t.id !== undefined && t.id !== null);
    switch (kind) {
      case "ids":
        if (arg === "named") return withId.map((t) => `${String(t.id).replace(/:/g, "\\:")}:${t.name.replace(/\s+/g, " ")}`);
        return withId.map((t) => String(t.id));
      case "columns": {
        if (arg !== undefined) {
          const t = withId.find((x) => String(x.id) === arg);
          return t ? columnsFor(config, t.board) : [];
        }
        return uniq(
          createKanban({ dir: cwd })
            .boards()
            .flatMap((b) => columnsFor(config, b)),
        );
      }
      case "boards":
        return createKanban({ dir: cwd }).boards();
      case "labels":
        return uniq(tickets.flatMap((t) => t.labels)).sort();
      case "propkeys":
        return uniq(tickets.flatMap((t) => Object.keys(t.props)))
          .sort()
          .map((k) => `${k}:`);
      case "rules":
        return uniq(
          createKanban({ dir: cwd })
            .automationOverview()
            .rules.map((r) => r.name),
        ).sort();
      default:
        return [];
    }
  } catch {
    return [];
  }
}
