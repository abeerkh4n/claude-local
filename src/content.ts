import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

/** A file to send with a prompt: a path, or bytes you already have. */
export type FileInput = string | { data: Uint8Array; mediaType: string; name?: string };

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const PDF = "application/pdf";

/**
 * The message content for a prompt. Images and PDFs go as image and document
 * blocks; any other file must be text and goes inline, wrapped in its name.
 */
export async function toContent(prompt: string, files: readonly FileInput[] = []): Promise<string | ContentBlock[]> {
  if (!files.length) return prompt;
  const blocks = await Promise.all(files.map(fileBlock));
  return [...blocks, { type: "text", text: prompt }];
}

async function fileBlock(file: FileInput): Promise<ContentBlock> {
  const { data, mediaType, name } = typeof file === "string" ? await readPath(file) : { name: "file", ...file };
  if (mediaType.startsWith("image/")) {
    return { type: "image", source: { type: "base64", media_type: mediaType, data: base64(data) } };
  }
  if (mediaType === PDF) {
    return { type: "document", source: { type: "base64", media_type: PDF, data: base64(data) } };
  }
  if (data.includes(0)) {
    throw new Error(`${name} is not text, an image or a PDF. Convert it to one of those first.`);
  }
  return { type: "text", text: `<file name="${name}">\n${new TextDecoder().decode(data)}\n</file>` };
}

async function readPath(path: string): Promise<{ data: Uint8Array; mediaType: string; name: string }> {
  const ext = extname(path).toLowerCase();
  const mediaType = IMAGE_TYPES[ext] ?? (ext === ".pdf" ? PDF : "text/plain");
  return { data: await readFile(path), mediaType, name: basename(path) };
}

function base64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}
