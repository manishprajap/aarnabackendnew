import { constants } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

const uploadRoot = path.resolve(
  process.env.UPLOAD_DIR || "/var/www/aarnexai.com/aarnexai-backend/upload",
);
const legacyRoot = path.join(uploadRoot, "upload");
let copied = 0;
let alreadyPresent = 0;
let skippedLinks = 0;

async function copyTree(sourceDirectory, relativeDirectory = "") {
  const entries = await readdir(sourceDirectory, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    const sourcePath = path.join(sourceDirectory, entry.name);
    const targetPath = path.join(uploadRoot, relativePath);

    if (entry.isSymbolicLink()) {
      skippedLinks += 1;
      continue;
    }

    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await copyTree(sourcePath, relativePath);
      continue;
    }

    if (!entry.isFile()) continue;
    await mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
      copied += 1;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        alreadyPresent += 1;
        continue;
      }
      throw error;
    }
  }
}

try {
  const legacyStats = await stat(legacyRoot);
  if (!legacyStats.isDirectory()) {
    throw new Error(`Legacy upload path is not a directory: ${legacyRoot}`);
  }

  await copyTree(legacyRoot);
  console.log(
    `Upload migration complete. Copied: ${copied}; already present: ${alreadyPresent}; skipped symlinks: ${skippedLinks}.`,
  );
  console.log(`Canonical upload root: ${uploadRoot}`);
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    console.log(`No nested upload directory found at ${legacyRoot}; nothing to migrate.`);
  } else {
    console.error("Upload migration failed:", error);
    process.exitCode = 1;
  }
}
