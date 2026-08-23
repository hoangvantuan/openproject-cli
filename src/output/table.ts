import { isFlatLink } from "../core/hal.js";

export function renderTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = header.map((title, column) =>
    Math.max(
      title.length,
      ...rows.map((row) => row[column]?.length ?? 0),
    ),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => {
        const width = widths[column];
        return column === cells.length - 1 || width === undefined
          ? cell
          : cell.padEnd(width);
      })
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)].join("\n") + "\n";
}

/**
 * One table cell from a flattened record: links show their name (or id),
 * scalars pass through, everything else serialises as JSON.
 */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (isFlatLink(value)) {
    return value.name ?? (value.id === null ? "" : String(value.id));
  }
  return JSON.stringify(value);
}

interface StatusRow {
  readonly profile: string;
  readonly instance: string;
  readonly project: number | null;
  readonly user: string;
}

export function renderStatusTable(row: StatusRow): string {
  return renderTable(
    ["PROFILE", "INSTANCE", "PROJECT", "USER"],
    [
      [
        row.profile,
        row.instance,
        formatProject(row.project),
        row.user,
      ],
    ],
  );
}

export interface ProfilesRow {
  readonly name: string;
  readonly instance: string;
  readonly project: number | undefined;
  readonly active: boolean;
}

function formatProject(project: number | undefined | null): string {
  return project === undefined || project === null ? "" : String(project);
}

export function renderProfilesTable(rows: readonly ProfilesRow[]): string {
  return renderTable(
    ["PROFILE", "INSTANCE", "PROJECT", "ACTIVE"],
    rows.map((row) => [
      row.name,
      row.instance,
      formatProject(row.project),
      row.active ? "*" : "",
    ]),
  );
}
