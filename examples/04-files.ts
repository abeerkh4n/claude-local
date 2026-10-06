/**
 * Send files with a prompt: PDFs, images (png, jpg, gif, webp) and text files.
 *
 *   npx tsx examples/04-files.ts                      (uses the sample invoice)
 *   npx tsx examples/04-files.ts ~/Downloads/bill.pdf
 */
import { fileURLToPath } from "node:url";
import { claude } from "../src/index.js";

const path = process.argv[2] ?? fileURLToPath(new URL("./files/supplier-invoice.pdf", import.meta.url));

const summary = await claude.ask("In two lines: who is this from, what is it for, and what do we owe by when?", {
  model: "haiku",
  files: [path],
});
console.log(summary);

const invoice = await claude.json<{ supplier: string; number: string; total: number; due: string; lines: { item: string; amount: number }[] }>(
  "Extract this invoice.",
  {
    type: "object",
    properties: {
      supplier: { type: "string" },
      number: { type: "string" },
      total: { type: "number" },
      due: { type: "string" },
      lines: {
        type: "array",
        items: { type: "object", properties: { item: { type: "string" }, amount: { type: "number" } }, required: ["item", "amount"] },
      },
    },
    required: ["supplier", "number", "total", "due", "lines"],
  },
  { model: "haiku", files: [path] },
);
console.log(invoice);
