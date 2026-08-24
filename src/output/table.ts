import { isFlatLink } from "../core/hal.js";

/** Gap between two columns, in display cells. */
const COLUMN_GAP = 2;

/**
 * Display width of one string: East Asian wide characters count two
 * cells, combining marks count none, everything else one. An
 * approximation by design: it fixes Vietnamese NFD and CJK tables
 * without weighing the CLI down with a full Unicode width table.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (isZeroWidth(code)) {
      continue;
    }
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isZeroWidth(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f)
    || (code >= 0x200b && code <= 0x200f)
    || (code >= 0xfe00 && code <= 0xfe0f)
    || code === 0xfeff
  );
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0x303e)
    || (code >= 0x3041 && code <= 0x33ff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xa000 && code <= 0xa4cf)
    || (code >= 0xa960 && code <= 0xa97f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f64f)
    || (code >= 0x1f900 && code <= 0x1f9ff)
  );
}

/** The longest prefix of `text` that fits `target` cells, "…" if cut. */
function truncateToWidth(text: string, target: number): string {
  if (displayWidth(text) <= target) {
    return text;
  }
  let kept = "";
  let width = 0;
  for (const character of text) {
    const cell = displayWidth(character);
    if (width + cell > target - 1) {
      break;
    }
    kept += character;
    width += cell;
  }
  return kept + "…";
}

function padToWidth(text: string, target: number): string {
  return text + " ".repeat(Math.max(0, target - displayWidth(text)));
}

/**
 * Terminal width for table bounding, when stdout is a TTY. Piped and
 * captured output (tests, scripts) reports undefined and stays unbounded.
 */
export function terminalWidth(): number | undefined {
  const columns = process.stdout?.columns;
  return typeof columns === "number" && columns > 0 ? columns : undefined;
}

/**
 * Column budgets that fit `maxWidth`: the widest column yields a cell
 * at a time, so one long subject narrows instead of every column
 * starving. Headers are truncated like data; a budget never drops
 * below one cell.
 */
function shrinkColumns(
  widths: ReadonlyArray<number>,
  maxWidth: number,
): Array<number> {
  const budgets = [...widths];
  const total = (): number => budgets.reduce((sum, width) => sum + width, 0);
  while (total() > maxWidth) {
    let widest = 0;
    for (let column = 1; column < budgets.length; column += 1) {
      if (budgets[column]! > budgets[widest]!) {
        widest = column;
      }
    }
    if (budgets[widest]! <= 1) {
      break;
    }
    budgets[widest] = budgets[widest]! - 1;
  }
  return budgets;
}

export function renderTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  maxWidth?: number,
): string {
  const limit = maxWidth ?? terminalWidth();
  const naturalWidths = header.map((title, column) =>
    Math.max(
      displayWidth(title),
      ...rows.map((row) => displayWidth(row[column] ?? "")),
    ),
  );
  const unbounded = limit === undefined
    || naturalWidths.reduce((sum, width) => sum + width, 0)
      + COLUMN_GAP * Math.max(0, header.length - 1)
      <= limit;
  const widths = unbounded
    ? naturalWidths
    : shrinkColumns(naturalWidths, limit - COLUMN_GAP * Math.max(0, header.length - 1));
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => {
        const width = widths[column];
        if (width === undefined) {
          return cell;
        }
        const bounded = unbounded ? cell : truncateToWidth(cell, width);
        return column === cells.length - 1
          ? bounded
          : padToWidth(bounded, width);
      })
      .join(" ".repeat(COLUMN_GAP))
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
