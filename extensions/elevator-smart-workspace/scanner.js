"use strict"

const fs = require("node:fs/promises")
const path = require("node:path")

// Never descend into dependency/build caches or virtual environments.
const SKIP = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".ipynb_checkpoints",
  ".gradle",
  ".idea",
  "target",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".cache",
  ".subtitle-workbench",
])
const SOURCES = new Map([
  [".py", "Python"],
  [".pyw", "Python"],
  [".ipynb", "Notebook"],
  [".java", "Java"],
  [".kt", "Kotlin"],
  [".scala", "Scala"],
  [".js", "JavaScript"],
  [".jsx", "JavaScript"],
  [".mjs", "JavaScript"],
  [".cjs", "JavaScript"],
  [".ts", "TypeScript"],
  [".tsx", "TypeScript"],
  [".vue", "Web"],
  [".svelte", "Web"],
  [".go", "Go"],
  [".rs", "Rust"],
  [".c", "C/C++"],
  [".cpp", "C/C++"],
  [".cc", "C/C++"],
  [".cs", "C#"],
  [".rb", "Ruby"],
  [".php", "PHP"],
  [".r", "R"],
  [".jl", "Julia"],
  [".sh", "Shell"],
  [".ps1", "PowerShell"],
])
const MARKERS = new Map([
  ["pom.xml", "Maven"],
  ["build.gradle", "Gradle"],
  ["build.gradle.kts", "Gradle"],
  ["settings.gradle", "Gradle"],
  ["settings.gradle.kts", "Gradle"],
  ["pyproject.toml", "Python"],
  ["setup.py", "Python"],
  ["setup.cfg", "Python"],
  ["requirements.txt", "Python"],
  ["pipfile", "Python"],
  ["environment.yml", "Python"],
  ["package.json", "Node"],
  ["go.mod", "Go"],
  ["cargo.toml", "Rust"],
  ["cmakelists.txt", "C/C++"],
  ["gemfile", "Ruby"],
  ["composer.json", "PHP"],
])

function normalizeInput(value) {
  let text = value.trim()
  if (/^(["']).*\1$/s.test(text)) text = text.slice(1, -1)
  if (/^[a-z]:[\\/]/i.test(text)) {
    text = "/mnt/" + text[0].toLowerCase() + "/" + text.slice(3).replaceAll("\\", "/")
  }
  if (!path.isAbsolute(text)) throw new Error("请输入绝对目录，例如 /mnt/d/课程目录。")
  return path.resolve(text)
}

class ScanCancelled extends Error {}
const posix = (value) => value.split(path.sep).join("/")
const within = (candidate, parent) => candidate === parent || candidate.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)

async function scanProjects(root, { cancelled = () => false, progress = () => {}, maxEntries = 300000 } = {}) {
  const stat = await fs.stat(root)
  if (!stat.isDirectory()) throw new Error("所选路径不是目录。")
  // Canonicalize the selected root once. Descendant symlinks are not followed.
  root = await fs.realpath(root)
  const records = []
  const warnings = []
  let entriesVisited = 0
  let lastProgress = 0
  async function visit(directory) {
    if (cancelled()) throw new ScanCancelled("扫描已取消")
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (directory === root) throw error
      warnings.push(`${posix(path.relative(root, directory))}: ${error.code}`)
      return
    }
    entriesVisited += entries.length
    if (entriesVisited > maxEntries) throw new Error(`扫描超过 ${maxEntries} 个条目，请选择更具体的目录。`)
    const record = { directory, markers: new Set(), sources: new Set(), notebooks: [] }
    records.push(record)
    for (const entry of entries) {
      if (cancelled()) throw new ScanCancelled("扫描已取消")
      if (entry.isFile()) {
        const name = entry.name.toLowerCase()
        const marker = MARKERS.get(name) || (/\.(csproj|fsproj|sln)$/.test(name) ? ".NET" : undefined)
        if (marker) record.markers.add(marker)
        const kind = SOURCES.get(path.extname(name))
        if (kind && kind !== "Notebook" && !name.endsWith(".d.ts")) record.sources.add(kind)
        if (kind === "Notebook") record.notebooks.push(path.join(directory, entry.name))
      }
    }
    if (Date.now() - lastProgress > 250) {
      progress({ directories: records.length, entries: entriesVisited, current: posix(path.relative(root, directory)) })
      lastProgress = Date.now()
    }
    // Sequential traversal keeps disk and memory load modest on /mnt/d.
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP.has(entry.name.toLowerCase())) await visit(path.join(directory, entry.name))
    }
  }
  await visit(root)
  if (cancelled()) throw new ScanCancelled("扫描已取消")
  const projects = records.filter((r) => r.markers.size).map((r) => ({ path: r.directory, types: [...r.markers], hasConfiguration: true }))
  const codeRoots = new Set(projects.map((project) => project.path))
  const insideCodeProject = (directory) => {
    while (within(directory, root)) {
      if (codeRoots.has(directory)) return true
      if (directory === root) break
      directory = path.dirname(directory)
    }
    return false
  }
  // Loose scripts need a root too. A source-containing ancestor groups
  // its unmarked descendants; explicit nested Maven/Python markers stay separate.
  const loose = records.filter((r) => r.sources.size).sort((a, b) => a.directory.length - b.directory.length)
  for (const record of loose) {
    if (!insideCodeProject(record.directory)) {
      projects.push({ path: record.directory, types: [...record.sources] })
      codeRoots.add(record.directory)
    }
  }
  // Runtime membership walks path ancestors, rather than enumerating project
  // files. Keep nested language roots, but omit redundant nested scope roots.
  const projectRoots = [...codeRoots].filter((directory) => directory === root || !insideCodeProject(path.dirname(directory))).sort()
  const allNotebooks = records.flatMap((record) => record.notebooks).sort()
  const notebooks = allNotebooks.filter((file) => !insideCodeProject(path.dirname(file)))
  // Notebook folders remain language/kernel roots without exposing siblings.
  for (const directory of new Set(notebooks.map((file) => path.dirname(file)))) {
    projects.push({ path: directory, types: ["Notebook"] })
  }
  if (projects.length > 5000) throw new Error("发现超过 5000 个项目，请选择更具体的目录。")
  return {
    root,
    projects: projects.sort((a, b) => a.path.localeCompare(b.path)),
    projectRoots,
    notebooks,
    notebookCount: allNotebooks.length,
    skipDirectories: [...SKIP].sort(),
    warnings,
    entriesVisited,
    scannedAt: new Date().toISOString(),
  }
}

function createWorkspace(scan, previous = {}) {
  return {
    ...previous,
    folders: [
      { name: path.basename(scan.root) || scan.root, path: scan.root },
      ...scan.projects
        .filter((project) => project.path !== scan.root)
        .map((project) => ({
          name: posix(path.relative(scan.root, project.path)),
          path: project.path,
        })),
    ],
    settings: {
      ...(previous.settings || {}),
      "explorer.compactFolders": false,
      "elevator.smartWorkspace": {
        root: scan.root,
        version: 2,
        projectRoots: scan.projectRoots,
        notebooks: scan.notebooks,
        skipDirectories: scan.skipDirectories,
        scannedAt: scan.scannedAt,
      },
    },
    // Metadata is a snapshot; opening from Recent never runs the scanner.
    elevatorScan: {
      projects: scan.projects,
      notebooks: scan.notebooks,
      notebookCount: scan.notebookCount,
      warnings: scan.warnings,
      scannedAt: scan.scannedAt,
    },
  }
}

module.exports = { normalizeInput, scanProjects, createWorkspace, ScanCancelled }
