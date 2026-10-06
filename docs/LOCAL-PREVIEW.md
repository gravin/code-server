# 本地源码编译与预览

双击仓库根目录的 `build-and-start.bat` 编译并启动。
双击同目录的 `stop-code-server.bat` 停止服务。停止脚本复用启动入口的
`--stop`，无需重复维护停止逻辑。

默认读取仓库根目录的 `projects.json`，将所有 `enabled: true` 的项目
放进同一个多项目工作区，使用一个 code-server 服务、一个 8080 端口。
当前列表包含 claude_code、code-server 和 CodeTour 三个项目。
浏览器自动打开 `http://127.0.0.1:8080/?workspace=...`。
这是本机浏览器预览，服务仅监听本机。
在启动窗口中按 Ctrl+C 停止、双击 `stop-code-server.bat`，或在 PowerShell 中执行
`.\build-and-start.bat --stop`。此命令只关闭本仓库启动的 code-server，
不重新编译、不停止整个 WSL，也不会关闭其它项目的 Node 进程。
网页关闭标签页不会停止后台服务；再次双击前先停止旧服务。

## 维护项目列表

在 `projects.json` 的 `projects` 数组中添加或修改项目：

```json
{
  "projects": [
    {
      "name": "claude_code",
      "path": "D:/BaiduNetdiskDownload/智能体集/claude_code",
      "enabled": true
    },
    {
      "name": "另一个项目",
      "path": "D:/my-python-project",
      "enabled": false
    }
  ]
}
```

`name` 是文件树中的显示名称；`path` 推荐用 Windows 路径和正斜杠，
避免 JSON 的反斜杠转义。也支持 WSL 绝对路径或相对于本 JSON 的路径。
`enabled: false` 的项目不会打开，也不会检查目录是否存在。
至少启用一个项目；已启用的路径不存在、重复目录、重名或 JSON 格式错误
会明确报错并停止启动。JSON 不支持注释和尾部多余逗号。

修改列表后先停止服务，再双击启动脚本。脚本会重新生成缓存中的
`preview/projects.code-workspace`；只维护 projects.json，不编辑生成文件。
旧的 `?folder=...` 标签页仍是单目录；要看项目列表，请使用新启动打开的
`?workspace=...` 页面。各项目保留自己的 Git、.vscode 和 .tours 文件。

项目可以使用不同语言。语法高亮、补全、调试按文件语言和各项目配置工作；
某些语言的完整功能需要在 WSL 中安装相应扩展、运行时或编译器。
项目越多，索引及语言服务可能占用更多内存，可以暂时禁用不用的项目。

脚本使用 Ubuntu WSL，从当前 code-server fork 编译，不下载 code-server
发行版。同级存在 `codetour` 或 `CodeTour` 时，从它的源码编译 Node/Web
扩展、打包 VSIX，并强制安装进本次编译的 code-server。缺少此目录则跳过。
VSIX 同时保存在 CodeTour 根目录的 `codetour-local.vsix`。

新用户配置默认使用 `Courier Prime`，回退为 `Courier New`、`monospace`，
编辑器字号为 16。默认值维护在 `ci/dev/preview-settings.json`；脚本只在
用户设置文件不存在时写入，不覆盖后来修改的设置。字体需要安装在浏览器
所在的 Windows 系统中。已有配置可在用户设置 JSON 中调整
`editor.fontFamily` 和 `editor.fontSize`。

本 fork 的 `patches/workbench-scale.diff` 将整个网页工作台默认放大到
125%，包括文件树、菜单、导航栏、图标和编辑器，同时调整可用布局尺寸。
浏览器缩放保持 100% 即可；编辑器字号配置仍为 16，显示时一起放大。
修改补丁中的比例后重跑启动脚本会重新编译底层 VS Code。

本地预览启动脚本始终传入 `--disable-workspace-trust`，所有打开的工作区
自动视为可信，包括以后添加到项目列表的目录。不会进入 Restricted Mode，
扩展、任务和调试也不再因工作区信任而受限，无需逐个点击 Manage。
CodeTour 导览在 Explorer 文件树下方的 CodeTour 中查看，说明文件仍保存在
各项目目录的 `.tours/` 中。

第一次运行会安装 Ubuntu 构建依赖和私有 Node 24，拉取仓库锁定的 VS Code
子模块、应用 patches，并完成完整构建。需要联网；sudo 可能要求 Ubuntu
密码。完整 VS Code 首次构建可能很久。后续总会重新编译 code-server 和
CodeTour；未改变的 VS Code 源码及其构建产物会复用。
为控制 WSL 内存占用，构建只生成所需的浏览器服务端，不同时打包桌面版；
本地预览使用未压缩产物。构建任务调整只发生在生成缓存，完成后会还原。

修改 code-server 的 `src/` 或同级 CodeTour 的 `src/` 后直接重跑即可。
修改底层 VS Code 时，遵循 `docs/CONTRIBUTING.md` 的 quilt 流程，将改动
维护在 code-server 的 `patches/` 中；脚本会重新应用并编译补丁。

源码从 Windows fork 同步到 `~/.cache/elevator-preview/<仓库路径哈希>/`
编译，日志在其中的 `build.log`，运行数据和扩展在 `preview/`。在 Windows
fork 中修改源码，不在这个生成缓存中编辑。打开的目标代码仍是 D 盘原目录；
在浏览器中修改代码会直接保存到目标目录。构建失败会停止，不启动旧版本。

命令行指定目录时，会临时覆盖项目列表，只打开该目录；不会修改 JSON。
也可以仅验证列表/构建：

```bat
build-and-start.bat "D:\some other project"
build-and-start.bat --check
build-and-start.bat --build-only
build-and-start.bat --stop
```

可在调用前设置 `ELEVATOR_WSL_DISTRO`（默认 Ubuntu）、
`ELEVATOR_PREVIEW_PORT`（默认 8080）、`ELEVATOR_NO_PAUSE=1` 或
`ELEVATOR_NO_BROWSER=1`。bat 会自动传递需要的变量到 WSL；
默认双击运行不需要设置任何变量。
