"use strict"
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const path = require("node:path")
const os = require("node:os")
const { scanProjects, createWorkspace, normalizeInput, ScanCancelled } = require("./scanner")

test("mixed projects save compact roots and exact standalone notebooks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "smart-课程 "))
  try {
    const files = [
      "第一周/Java/pom.xml",
      "第一周/Java/src/main/java/Main.java",
      "第一周/Java/module/pom.xml",
      "第一周/Java/module/src/M.java",
      "第二周/Python/pyproject.toml",
      "第二周/Python/src/app.py",
      "第二周/Python/data/input.csv",
      "第二周/Python/assets/logo.png",
      "第二周/Python/notebooks/internal.ipynb",
      "第三周/实验/a.ipynb",
      "第三周/实验/b.ipynb",
      "第三周/实验/README.md",
      "第三周/实验/课程资料.json",
      "第四周/示例/run.py",
      "第四周/示例/课程讲义.html",
      "第四周/示例/字幕/导出.html",
      "第四周/示例/lib/helper.py",
      "第五周/前端/package.json",
      "第五周/前端/src/main.ts",
      "第五周/前端/src/App.vue",
      "第五周/前端/styles/app.scss",
      "第五周/前端/pages/index.html",
      "视频/recording.mp4",
      "只有文档/README.md",
      "只有文档/说明.html",
      "第二周/Python/.venv/ignored.py",
      "第二周/Python/.idea/hidden.ipynb",
      "第二周/Python/BUILD/hidden.py",
      "前端/node_modules/package/index.js",
    ]
    for (const file of files) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await fs.writeFile(path.join(root, file), "")
    }
    await fs.symlink(root, path.join(root, "cycle"))
    const scan = await scanProjects(root)
    assert.equal(scan.projects.length, 6)
    assert.equal(scan.notebookCount, 3)
    assert.deepEqual(scan.notebooks, [path.join(root, "第三周/实验/a.ipynb"), path.join(root, "第三周/实验/b.ipynb")])
    assert(scan.projects.some((p) => p.path.endsWith("/Java/module")))
    assert(scan.projects.some((p) => p.path.endsWith("/前端") && p.types.includes("Node")))
    assert.deepEqual(scan.projectRoots, ["第一周/Java", "第二周/Python", "第四周/示例", "第五周/前端"].map((p) => path.join(root, p)).sort())
    assert.equal(scan.directories, undefined)
    assert.equal(scan.files, undefined)
    assert(scan.skipDirectories.includes(".idea"))
    const workspace = createWorkspace(scan, { settings: { "editor.fontSize": 18 }, tasks: { version: "2.0.0" } })
    assert.equal(workspace.folders.length, 7) // common root + six language roots
    assert.equal(workspace.folders[0].path, root)
    assert.equal(workspace.settings["editor.fontSize"], 18)
    assert.equal(workspace.tasks.version, "2.0.0")
    assert.equal(workspace.settings["files.exclude"], undefined)
    const snapshot = workspace.settings["elevator.smartWorkspace"]
    assert.equal(snapshot.version, 2)
    assert.deepEqual(snapshot.projectRoots, scan.projectRoots)
    assert.deepEqual(snapshot.notebooks, scan.notebooks)
    assert.equal(snapshot.directories, undefined)
    assert.equal(snapshot.files, undefined)
    // A fresh invocation discovers new code; loading the old snapshot does not.
    await fs.writeFile(path.join(root, "只有文档/new.py"), "print(1)")
    assert(!snapshot.projectRoots.includes(path.join(root, "只有文档")))
    const rescanned = await scanProjects(root)
    assert.equal(rescanned.projects.length, 7)
    assert(rescanned.projectRoots.includes(path.join(root, "只有文档")))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("notebooks never turn source ancestors into broad project roots, and old snapshots migrate", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "smart-notebook-"))
  try {
    for (const file of ["course.ipynb", "notes.pdf", "nested/example.py", "nested/experiment.ipynb", "nested/docs/reference.pdf"]) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await fs.writeFile(path.join(root, file), "")
    }
    const scan = await scanProjects(root)
    assert.deepEqual(scan.projectRoots, [path.join(root, "nested")])
    assert.deepEqual(scan.notebooks, [path.join(root, "course.ipynb")])
    assert.equal(scan.notebookCount, 2)
    const previous = { settings: { "elevator.smartWorkspace": { directories: ["."], files: ["course.ipynb"] }, "editor.fontSize": 19 }, launch: { version: "0.2.0" } }
    const workspace = createWorkspace(scan, previous)
    assert.equal(workspace.settings["elevator.smartWorkspace"].files, undefined)
    assert.equal(workspace.settings["editor.fontSize"], 19)
    assert.equal(workspace.launch.version, "0.2.0")
    assert.equal(workspace.folders.length, 2) // top-level notebook root already registered
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("empty directories, cancellation and traversal limits never produce partial workspaces", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "smart-empty-"))
  try {
    assert.equal((await scanProjects(root)).projects.length, 0)
    await assert.rejects(scanProjects(root, { cancelled: () => true }), ScanCancelled)
    await fs.writeFile(path.join(root, "main.py"), "")
    await assert.rejects(scanProjects(root, { maxEntries: 0 }), /扫描超过/)
    await assert.rejects(scanProjects(path.join(root, "main.py")), /不是目录/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("accept Linux or quoted Windows absolute paths, including Chinese and spaces", () => {
  assert.equal(normalizeInput(' "D:\\课程 目录\\项目" '), "/mnt/d/课程 目录/项目")
  assert.equal(normalizeInput("/mnt/d/课程/../项目"), "/mnt/d/项目")
  assert.throws(() => normalizeInput("D:relative"), /绝对目录/)
  assert.throws(() => normalizeInput("relative/path"), /绝对目录/)
})
