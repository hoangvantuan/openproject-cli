import { describe, expect, test } from "vitest";

import { displayWidth, renderTable } from "../src/output/table.js";

describe("displayWidth", () => {
  test("ASCII counts one cell per character", () => {
    expect(displayWidth("ID  NAME")).toBe(8);
  });

  test("Vietnamese decomposed marks add no width", () => {
    // "ộ" as o + combining circumflex + combining dot below: three code
    // points, one cell.
    expect(displayWidth("o\u0302\u0323")).toBe(1);
    expect(displayWidth("lỗi")).toBe(3);
  });

  test("CJK characters count two cells", () => {
    expect(displayWidth("登入")).toBe(4);
  });
});

describe("renderTable width bounding", () => {
  const header = ["ID", "SUBJECT"];
  const rows = [["41", "Fix login redirect on the marketing site"]];

  test("without a limit the layout is unchanged", () => {
    expect(renderTable(header, rows, undefined)).toBe(
      "ID  SUBJECT\n"
      + "41  Fix login redirect on the marketing site\n",
    );
  });

  test("a wide-enough limit changes nothing", () => {
    const unbounded = renderTable(header, rows, undefined);
    expect(renderTable(header, rows, 200)).toBe(unbounded);
  });

  test("a narrow limit truncates the widest column and marks the cut", () => {
    const bounded = renderTable(header, rows, 20);
    for (const line of bounded.split("\n")) {
      expect(displayWidth(line)).toBeLessThanOrEqual(20);
    }
    expect(bounded).toContain("41");
    expect(bounded).toContain("…");
    expect(bounded).not.toContain("marketing");
  });

  test("the header yields like data cells", () => {
    const bounded = renderTable(["IDENTIFIER", "X"], [["operations", "1"]], 10);
    for (const line of bounded.split("\n")) {
      expect(displayWidth(line)).toBeLessThanOrEqual(10);
    }
  });

  test("one long column narrows instead of starving every column", () => {
    const bounded = renderTable(
      ["ID", "SUBJECT", "STATUS"],
      [["41", "a very long subject that cannot possibly fit", "In progress"]],
      30,
    );
    // The ID and STATUS columns keep room for their own content; the
    // shrink pressure lands on the subject.
    expect(bounded).toContain("41");
    expect(bounded).toContain("In progress");
    expect(bounded).not.toContain("possibly");
    for (const line of bounded.split("\n")) {
      expect(displayWidth(line)).toBeLessThanOrEqual(30);
    }
  });

  test("wide characters truncate by cells, not code points", () => {
    const bounded = renderTable(["NOTE"], [["登入頁面發生錯誤"]], 9);
    expect(displayWidth(bounded.split("\n")[1] ?? "")).toBeLessThanOrEqual(9);
    expect(bounded).toContain("…");
  });

  test("a limit at or below the minimum still renders every column", () => {
    const bounded = renderTable(["A", "B"], [["one", "two"]], 1);
    expect(bounded).toContain("A");
    expect(bounded).toContain("B");
  });
});
