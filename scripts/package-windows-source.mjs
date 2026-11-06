import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(projectRoot, "outputs", "windows");
const archiveName = "Pixel-Brightness-Windows-V3-Source.zip";

const includedDirectories = [
  "app",
  "build",
  "config",
  "db",
  "deploy",
  "docs",
  "drizzle",
  "examples",
  "native",
  "public",
  "runtime",
  "scripts",
  "tests",
  "worker",
];

const includedFiles = [
  ".gitignore",
  ".openai/hosting.json",
  "ARCHITECTURE.md",
  "README.md",
  "WINDOWS-START-HERE.txt",
  "INSTALL-WINDOWS.cmd",
  "START-NDI-PREVIEW.cmd",
  "drizzle.config.ts",
  "eslint.config.mjs",
  "next-env.d.ts",
  "next.config.ts",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "postcss.config.mjs",
  "tsconfig.json",
  "vite.config.ts",
];

const excludedDirectoryNames = new Set([
  ".git",
  ".next",
  ".pixel-brightness",
  ".pnpm-store",
  ".vercel",
  ".vinext",
  ".wrangler",
  "cache",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "outputs",
  "work",
]);

const excludedPrefixes = [
  "native/windows/bin/",
  "native/windows/build/",
  "native/windows/out/",
  "runtime/data/",
];

const forbiddenExtensions = new Set([
  ".dmg",
  ".exe",
  ".img",
  ".iso",
  ".key",
  ".log",
  ".msi",
  ".p12",
  ".pem",
  ".pfx",
  ".zip",
]);

function posixRelative(absolutePath) {
  return path.relative(projectRoot, absolutePath).split(path.sep).join("/");
}

function isIncluded(relativePath, source) {
  const normalized = relativePath.split(path.sep).join("/");
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";

  if (segments.some((segment) => excludedDirectoryNames.has(segment))) return false;
  if (excludedPrefixes.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))) return false;
  if (basename.startsWith(".env")) return false;
  if ([".DS_Store", "known_hosts", "ssh_config", "id_rsa", "id_ed25519"].includes(basename)) return false;
  if (forbiddenExtensions.has(path.extname(basename).toLowerCase())) return false;
  if (segments.some((segment) => /^(?:private|secrets?)$/i.test(segment))) return false;
  if (/password|private[-_.]?key/i.test(basename)) return false;

  return lstat(source).then((stats) => {
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to package symbolic link: ${normalized}`);
    }
    return true;
  });
}

async function copyDirectory(relativeDirectory, stageRoot) {
  const source = path.join(projectRoot, relativeDirectory);
  const destination = path.join(stageRoot, relativeDirectory);
  await cp(source, destination, {
    recursive: true,
    preserveTimestamps: false,
    filter: async (candidate) => isIncluded(posixRelative(candidate), candidate),
  });
}

async function walkFiles(directory, relativeBase = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeBase, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Staged package contains symbolic link: ${relativePath}`);
    if (entry.isDirectory()) files.push(...await walkFiles(absolutePath, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

async function verifyManifestTree(stageRoot) {
  const manifestPath = path.join(stageRoot, "MANIFEST-SHA256.txt");
  const manifestText = await readFile(manifestPath, "utf8");
  if (!manifestText.endsWith("\n") || manifestText.includes("\r")) {
    throw new Error("Extracted source manifest is not canonical LF-terminated UTF-8 text");
  }
  const lines = manifestText.slice(0, -1).split("\n");
  if (lines.length < 1 || lines.length > 10_000) {
    throw new Error("Extracted source manifest must contain 1-10000 entries");
  }

  const expected = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) throw new Error(`Extracted source manifest contains a non-canonical line: ${line}`);
    const [, digest, relative] = match;
    const segments = relative.split("/");
    if (
      relative !== relative.trim()
      || relative.startsWith("/")
      || relative.includes("\\")
      || relative.includes(":")
      || segments.some((segment) => !segment || segment === "." || segment === "..")
      || relative.toLowerCase() === "manifest-sha256.txt"
    ) {
      throw new Error(`Extracted source manifest contains an unsafe path: ${relative}`);
    }
    const folded = relative.toLowerCase();
    if (expected.has(folded)) throw new Error(`Extracted source manifest contains a case-colliding path: ${relative}`);
    expected.set(folded, { relative, digest });
  }

  const extractedFiles = (await walkFiles(stageRoot))
    .map((file) => file.split(path.sep).join("/"))
    .filter((file) => file.toLowerCase() !== "manifest-sha256.txt");
  if (extractedFiles.length !== expected.size) {
    throw new Error(`Extracted source file count differs from manifest: expected ${expected.size}, found ${extractedFiles.length}`);
  }
  const actual = new Map();
  for (const relative of extractedFiles) {
    const folded = relative.toLowerCase();
    if (actual.has(folded)) throw new Error(`Extracted source contains a case-colliding path: ${relative}`);
    actual.set(folded, relative);
  }
  for (const [folded, entry] of expected) {
    const relative = actual.get(folded);
    if (!relative || relative !== entry.relative) {
      throw new Error(`Extracted source manifest file is missing or changed case: ${entry.relative}`);
    }
    const observed = await sha256(path.join(stageRoot, relative));
    if (observed !== entry.digest) throw new Error(`Extracted source failed its manifest digest: ${relative}`);
  }
  return {
    manifestSha256: await sha256(manifestPath),
    sourceFiles: extractedFiles.length,
  };
}

async function validateStage(stageRoot) {
  const files = (await walkFiles(stageRoot)).map((file) => file.split(path.sep).join("/")).sort();
  const lowerNames = new Map();
  const secretPatterns = [
    /-----BEGIN (?:OPENSSH|RSA|EC|DSA|ENCRYPTED)? ?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[opusr]_[A-Za-z0-9_]{30,}\b/,
  ];

  for (const file of files) {
    const folded = file.toLocaleLowerCase("en-US");
    if (lowerNames.has(folded)) throw new Error(`Case-colliding paths: ${lowerNames.get(folded)} and ${file}`);
    lowerNames.set(folded, file);

    if (file.startsWith("/") || file.split("/").includes("..")) throw new Error(`Unsafe staged path: ${file}`);
    if (file.startsWith("outputs/") || file.includes("/private/")) throw new Error(`Forbidden staged path: ${file}`);

    const contents = await readFile(path.join(stageRoot, file));
    const text = contents.toString("utf8");
    if (secretPatterns.some((pattern) => pattern.test(text))) throw new Error(`Possible credential in staged file: ${file}`);
  }

  return files;
}

async function main() {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "pixel-brightness-windows-source-"));
  const stageRoot = path.join(temporaryRoot, "Pixel-Brightness-Windows-V3-Source");
  const temporaryArchive = path.join(temporaryRoot, archiveName);

  try {
    await mkdir(stageRoot, { recursive: true });
    for (const directory of includedDirectories) await copyDirectory(directory, stageRoot);
    for (const file of includedFiles) {
      const destination = path.join(stageRoot, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(projectRoot, file), destination);
    }

    const files = await validateStage(stageRoot);
    const manifestLines = [];
    for (const file of files) manifestLines.push(`${await sha256(path.join(stageRoot, file))}  ${file}`);
    await writeFile(path.join(stageRoot, "MANIFEST-SHA256.txt"), `${manifestLines.join("\n")}\n`, { mode: 0o600 });

    await execFileAsync("zip", ["-X", "-q", "-r", temporaryArchive, path.basename(stageRoot)], {
      cwd: temporaryRoot,
      maxBuffer: 8 * 1024 * 1024,
    });

    const { stdout: archiveListing } = await execFileAsync("unzip", ["-Z1", temporaryArchive], { maxBuffer: 16 * 1024 * 1024 });
    const archiveEntries = archiveListing.trim().split(/\r?\n/).filter(Boolean);
    const archiveRoot = `${path.basename(stageRoot)}/`;
    if (archiveEntries.some((entry) => (
      entry.startsWith("/")
      || entry.split("/").includes("..")
      || (entry !== archiveRoot && !entry.startsWith(archiveRoot))
    ))) {
      throw new Error("Archive contains an unsafe or out-of-root entry");
    }
    if (!archiveEntries.includes(`${archiveRoot}MANIFEST-SHA256.txt`)) {
      throw new Error("Archive manifest is missing");
    }
    const verificationRoot = path.join(temporaryRoot, "verified-extraction");
    await mkdir(verificationRoot, { recursive: true });
    await execFileAsync("unzip", ["-q", temporaryArchive, "-d", verificationRoot], { maxBuffer: 16 * 1024 * 1024 });
    const verification = await verifyManifestTree(path.join(verificationRoot, path.basename(stageRoot)));

    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    const archivePath = path.join(outputDirectory, archiveName);
    const checksumPath = `${archivePath}.sha256`;
    await rm(archivePath, { force: true });
    await rm(checksumPath, { force: true });
    await rename(temporaryArchive, archivePath);
    await chmod(archivePath, 0o600);
    const archiveHash = await sha256(archivePath);
    await writeFile(checksumPath, `${archiveHash}  ${archiveName}\n`, { mode: 0o600 });

    console.log(JSON.stringify({
      archivePath,
      checksumPath,
      sha256: archiveHash,
      manifestSha256: verification.manifestSha256,
      sourceFiles: verification.sourceFiles,
      archiveEntries: archiveEntries.length,
    }, null, 2));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
