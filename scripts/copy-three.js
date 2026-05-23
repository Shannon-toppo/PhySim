// Copy the subset of three.js we need into media/three so the webview can load
// them via local file URIs (no CDN, no bundler).
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const src = path.join(root, "node_modules", "three");
const dst = path.join(root, "media", "three");

const files = [
  ["build/three.module.js",                       "three.module.js"],
  ["examples/jsm/controls/OrbitControls.js",      "addons/controls/OrbitControls.js"],
  ["examples/jsm/controls/TransformControls.js",  "addons/controls/TransformControls.js"]
];

if (!fs.existsSync(src)) {
  console.warn("[copy-three] node_modules/three not found yet. Skipping (will run again after install).");
  process.exit(0);
}

for (const [from, to] of files) {
  const srcPath = path.join(src, from);
  const dstPath = path.join(dst, to);
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  fs.copyFileSync(srcPath, dstPath);
  console.log("[copy-three]", path.relative(root, srcPath), "->", path.relative(root, dstPath));
}
