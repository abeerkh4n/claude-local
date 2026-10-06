import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toContent } from "../src/content.js";

const dir = mkdtempSync(join(tmpdir(), "claude-local-content-"));
const file = (name: string, data: string | Uint8Array) => {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
};

describe("toContent", () => {
  it("is the plain prompt when there are no files", async () => {
    expect(await toContent("hi")).toBe("hi");
  });

  it("sends images and PDFs as blocks, text files inline with their name, and the prompt last", async () => {
    const png = file("chart.png", new Uint8Array([137, 80, 78, 71]));
    const pdf = file("invoice.pdf", "%PDF-1.4");
    const notes = file("notes.md", "# Q3\nRevenue up.");
    const content = await toContent("Summarise these.", [png, pdf, notes]);
    expect(content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw==" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from("%PDF-1.4").toString("base64") } },
      { type: "text", text: '<file name="notes.md">\n# Q3\nRevenue up.\n</file>' },
      { type: "text", text: "Summarise these." },
    ]);
  });

  it("takes bytes you already have", async () => {
    const content = await toContent("What is this?", [{ data: new Uint8Array([1, 2]), mediaType: "image/jpeg" }]);
    expect(content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AQI=" } },
      { type: "text", text: "What is this?" },
    ]);
  });

  it("refuses a binary file it can't send, naming it", async () => {
    const docx = file("plan.docx", new Uint8Array([80, 75, 3, 4, 0, 0]));
    await expect(toContent("Read this", [docx])).rejects.toThrow(/plan\.docx is not text, an image or a PDF/);
  });
});
