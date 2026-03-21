import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
export async function loadTextTree(root) {
    const files = [];
    async function walk(dir) {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
            }
            else if (entry.isFile()) {
                files.push({
                    key: `f${files.length}`,
                    path: relative(root, fullPath),
                    content: await readFile(fullPath, "utf8"),
                });
            }
        }
    }
    await walk(root);
    return files;
}
