import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// Exact verified public model revision; changing it requires fresh provenance.
export const modelResourceHashes = Object.freeze({
  "PiperSR_2x.mlpackage/Manifest.json": "bb4d698b552f273ef0b2b3a1898f45c3be34ea60a6315c4f0d77ca8989746222",
  "PiperSR_2x.mlpackage/Data/com.apple.CoreML/model.mlmodel": "df7fcedd18b75f7e87a9d782e65efb00a946947f30a877ee5e6ba6e23d263a9f",
  "PiperSR_2x.mlpackage/Data/com.apple.CoreML/weights/weight.bin": "470924d59790b031487863da4f0df0a394c05cb959455300e78484754841e060",
  "PiperSR-MODEL_CARD.md": "cb1fc1f1e4df82fb16cdbd191f4ed07a0d7db485740869bd665a413adda26359",
  "PiperSR-MODEL_LICENSE": "2244155d508341c6a0a9f55e931466df8b673e711c1b1f51cf31684454a64689",
});
export async function verifyModelResources(directory) {
  for (const [name, expected] of Object.entries(modelResourceHashes)) {
    const file = path.join(directory, name), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error(`Bundled model resource is invalid: ${name}`);
    if (crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex") !== expected) throw new Error(`Bundled model resource checksum failed: ${name}`);
  }
  await fs.access(path.join(directory, "PiperSR-NOTICE.txt"));
}
