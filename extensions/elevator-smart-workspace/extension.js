"use strict"

const vscode = require("vscode")
const fs = require("node:fs/promises")
const path = require("node:path")
const crypto = require("node:crypto")
const { normalizeInput, scanProjects, createWorkspace, ScanCancelled } = require("./scanner")

function activate(context) {
  const output = vscode.window.createOutputChannel("Open Folder Smartly")
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("elevator.openFolderSmartly", async () => {
      const current =
        vscode.workspace.getConfiguration("elevator").get("smartWorkspace", {}).root ||
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
        "/mnt/d/"
      try {
        const pickerBase =
          vscode.workspace.workspaceFolders?.[0]?.uri || vscode.workspace.workspaceFile || context.globalStorageUri
        const defaultUri = pickerBase.with({ path: normalizeInput(current), query: "", fragment: "" })
        // Reuse VS Code's remote folder picker for browsing, completion and cancel.
        const selected = await vscode.window.showOpenDialog({
          title: "Open Folder Smartly",
          defaultUri,
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "扫描并打开",
        })
        if (!selected?.length) return
        const scan = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "扫描代码项目",
            cancellable: true,
          },
          (progress, token) =>
            scanProjects(normalizeInput(selected[0].fsPath), {
              cancelled: () => token.isCancellationRequested,
              progress: (state) =>
                progress.report({ message: `${state.directories} 个目录，${state.entries} 个条目：${state.current}` }),
            }),
        )
        output.clear()
        output.appendLine(
          `Root: ${scan.root}\nScanned: ${scan.scannedAt}\nProjects: ${scan.projects.length}\nNotebooks: ${scan.notebooks.length}`,
        )
        for (const project of scan.projects) output.appendLine(`[${project.types.join(", ")}] ${project.path}`)
        for (const warning of scan.warnings) output.appendLine(`Skipped: ${warning}`)
        if (!scan.projects.length) {
          await vscode.window.showInformationMessage("没有发现代码项目或 Notebook，当前工作区保持不变。")
          return
        }
        const storage = context.globalStorageUri.fsPath
        await fs.mkdir(storage, { recursive: true })
        const suffix = crypto.createHash("sha256").update(scan.root).digest("hex").slice(0, 12)
        const filename = `${path.basename(scan.root).replace(/[\\/:*?"<>|]/g, "_")}-${suffix}.code-workspace`
        const destination = path.join(storage, filename)
        let previous = {}
        try {
          previous = JSON.parse(await fs.readFile(destination, "utf8"))
        } catch (error) {
          if (error.code !== "ENOENT") throw new Error(`无法读取已有工作区：${error.message}`)
        }
        const temporary = destination + ".tmp"
        await fs.writeFile(temporary, JSON.stringify(createWorkspace(scan, previous), null, 2) + "\n")
        await fs.rename(temporary, destination)
        output.appendLine(`Workspace: ${destination}`)
        if (scan.warnings.length) {
          await vscode.window.showWarningMessage(
            `发现 ${scan.projects.length} 个项目；${scan.warnings.length} 个目录无法读取，详情见 Open Folder Smartly 输出。`,
          )
        }
        // Use the current remote authority when operating in the browser's WSL host.
        const base = vscode.workspace.workspaceFolders?.[0]?.uri || vscode.workspace.workspaceFile
        const uri =
          base && base.scheme !== "file"
            ? base.with({ path: destination, query: "", fragment: "" })
            : vscode.Uri.file(destination)
        await vscode.commands.executeCommand("vscode.openFolder", uri, { forceReuseWindow: true })
      } catch (error) {
        if (error instanceof ScanCancelled) return
        output.appendLine(error.stack || String(error))
        await vscode.window.showErrorMessage(`Open Folder Smartly: ${error.message}`)
      }
    }),
  )
}

module.exports = { activate }
