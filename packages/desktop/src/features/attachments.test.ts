import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyAttachmentFileToManagedStorage } from "./attachments";

const originalAlpHome = process.env.ALP_HOME;
let testHome: string | null = null;

async function useTempAlpHome(): Promise<string> {
  testHome = await mkdtemp(path.join(os.tmpdir(), "alp-desktop-attachments-"));
  process.env.ALP_HOME = testHome;
  return testHome;
}

describe("desktop attachment files", () => {
  afterEach(async () => {
    if (originalAlpHome === undefined) {
      delete process.env.ALP_HOME;
    } else {
      process.env.ALP_HOME = originalAlpHome;
    }

    if (testHome) {
      await rm(testHome, { recursive: true, force: true });
      testHome = null;
    }
  });

  it("accepts dot-prefixed picker extensions for managed copies", async () => {
    const alpHome = await useTempAlpHome();
    const sourcePath = path.join(alpHome, "report.md");
    await writeFile(sourcePath, "# Report\n");

    const result = await copyAttachmentFileToManagedStorage({
      attachmentId: "att_markdown",
      sourcePath,
      extension: ".md",
    });

    expect(result).toEqual({
      path: path.join(alpHome, "desktop-attachments", "att_markdown.md"),
      byteSize: 9,
    });
    await expect(readFile(result.path, "utf8")).resolves.toBe("# Report\n");
  });

  it("normalizes legacy bare extensions for managed copies", async () => {
    const alpHome = await useTempAlpHome();
    const sourcePath = path.join(alpHome, "report.md");
    await writeFile(sourcePath, "# Report\n");

    const result = await copyAttachmentFileToManagedStorage({
      attachmentId: "att_markdown_legacy",
      sourcePath,
      extension: "md",
    });

    expect(result).toEqual({
      path: path.join(alpHome, "desktop-attachments", "att_markdown_legacy.md"),
      byteSize: 9,
    });
    await expect(readFile(result.path, "utf8")).resolves.toBe("# Report\n");
  });
});
