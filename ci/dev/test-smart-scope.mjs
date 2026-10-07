// Node 24; pass the locally checked-out VS Code source directory as argv[2].
// Load the helper directly from the patch so tests never modify build sources.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { registerHooks, createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const vscode = resolve(process.argv[2] ?? 'lib/vscode');
const ts = createRequire(pathToFileURL(resolve(vscode, 'package.json')))('typescript');
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const patch = readFileSync(resolve(source, 'patches/smart-search.diff'), 'utf8');
const helperPath = resolve(vscode, 'src/vs/workbench/services/search/common/smartSearchScope.ts');
const start = patch.indexOf('+++ code-server/lib/vscode/src/vs/workbench/services/search/common/smartSearchScope.ts');
const end = patch.indexOf('\n--- code-server.orig/', start);
assert(start >= 0 && end > start, 'Shared scope helper must be present in the patch');
const helper = patch.slice(start, end).split(/\r?\n/).filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(candidate)) || fileURLToPath(candidate) === helperPath) {
        return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      const filename = fileURLToPath(url);
      const content = filename === helperPath ? helper : readFileSync(filename, 'utf8');
      return { format: 'module', source: ts.transpileModule(content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, experimentalDecorators: true } }).outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { getSmartSearchScope, isSmartSearchResourceAllowed: allowed, restrictSmartSearchQuery: restrict } = await import(pathToFileURL(helperPath));
const { URI } = await import(pathToFileURL(resolve(vscode, 'src/vs/base/common/uri.ts')));
const glob = await import(pathToFileURL(resolve(vscode, 'src/vs/base/common/glob.ts')));
const root = URI.parse('vscode-remote://localhost/mnt/d/课程 [演示]');
const uri = path => URI.joinPath(root, path);
const scope = {
  root,
  projectRoots: [uri('周一/项目 [1]').path, uri('前端').path],
  notebooks: [uri('实验/a[1].ipynb').path, uri('实验/star*.ipynb').path],
  skipDirectories: ['.git', '.idea', 'node_modules', '.venv', 'build'],
  scannedAt: '2026-10-07T00:00:00.000Z',
};
const query = (extra = {}) => ({ folderQueries: [{ folder: root }], smartSearchScope: scope, ...extra });
const providerAllows = (limited, resource) => limited.folderQueries.some(folder => {
  const prefix = folder.folder.path + '/';
  if (!resource.path.startsWith(prefix)) return false;
  const relative = resource.path.slice(prefix.length);
  return glob.match(folder.includePattern, relative, { ignoreCase: !!limited.ignoreGlobCase }) && !glob.match(limited.excludePattern, relative) && !folder.excludePattern.some(exclude => glob.match(exclude.pattern, relative));
});

test('complete project contents, deep ancestors, isolated notebooks and path boundaries', () => {
  for (const path of ['周一/项目 [1]/assets/logo.png', '周一/项目 [1]/data/input.csv', '周一/项目 [1]/docs/readme.pdf', '周一/项目 [1]/new/deep/unknown.xyz', '周一/项目 [1]/.tours/tour.json', '周一/项目 [1]/build', '实验/a[1].ipynb', '实验/star*.ipynb']) assert(allowed(scope, uri(path)), path);
  for (const path of ['', '周一', '周一/项目 [1]', '周一/项目 [1]/new/deep', '实验']) assert(allowed(scope, uri(path), true), path);
  for (const path of ['周一/notes.md', '周一/项目 [1]2/main.py', '视频/main.py', '实验/README.md', '实验/a1.ipynb', '实验/other.ipynb', '实验/.tours/tour.json', '../outside.py']) assert(!allowed(scope, uri(path)), path);
  for (const path of ['视频', '实验/旁边']) assert(!allowed(scope, uri(path), true), path);
  assert(!allowed(scope, uri('前端/main.js').with({ authority: 'other' })));
});

test('skip directories everywhere, including case variants, editors and notebook entries', () => {
  const limited = restrict(query(), () => true);
  for (const name of scope.skipDirectories) {
    for (const spelling of [name, name.toUpperCase()]) {
      const path = `前端/nested/${spelling}/file.ipynb`;
      assert(!allowed(scope, uri(path)), path);
      assert(!allowed(scope, uri(`前端/nested/${spelling}`), true), spelling);
      assert(!providerAllows(limited, uri(path)), path);
    }
  }
  const badNotebook = { ...scope, notebooks: [uri('实验/.idea/a.ipynb').path] };
  assert(!allowed(badNotebook, uri('实验/.idea/a.ipynb')));
  assert(!providerAllows(restrict(query({ smartSearchScope: badNotebook }), () => true), uri('实验/.idea/a.ipynb')));
});

test('provider scope uses subtree globs and exact notebooks, including literal glob characters', () => {
  const limited = restrict(query({ cacheKey: 'files' }), () => true);
  assert.equal(limited.cacheKey, 'files:' + scope.scannedAt);
  assert(limited.folderQueries[0].ignoreSymlinks);
  for (const path of ['周一/项目 [1]/data/input.csv', '周一/项目 [1]/build', '前端/.git', '前端/new/deep/file.xyz', '实验/a[1].ipynb', '实验/star*.ipynb']) assert(providerAllows(limited, uri(path)), path);
  for (const path of ['周一/项目 1/main.py', '周一/项目 [1]2/main.py', '实验/a1.ipynb', '实验/star-other.ipynb', '视频/file.txt']) assert(!providerAllows(limited, uri(path)), path);
  assert(Object.keys(limited.folderQueries[0].includePattern).length < 10);
});

test('user glob filters intersect project ranges before providers run', () => {
  const paths = ['前端/main.ts', '前端/main.json', '前端/src/app.ts', '前端/src/view.tsx', '前端/src/a.json', '前端/docs/a.md', '前端/docs/deep/a.md', '周一/项目 [1]/src/main.py', '周一/项目 [1]/docs/readme.md', '实验/a[1].ipynb'];
  const patterns = ['**/*.ts', '**/src/**', '{前端/src/**,**/*.md}', '**/{src,docs}/**', '**/**/docs/*.md', '前端/*', '前端/src/*.{ts,tsx}', '**/*.ipynb', 'nothing/**'];
  for (const pattern of patterns) {
    const expression = { [pattern]: true };
    const limited = restrict(query({ includePattern: expression }), resource => glob.match(expression, resource.path.slice(root.path.length + 1)));
    for (const path of paths) assert.equal(providerAllows(limited, uri(path)), allowed(scope, uri(path)) && !!glob.match(expression, path), `${pattern}: ${path}`);
  }
  const folder = uri('前端/src');
  const limited = restrict(query({ folderQueries: [{ folder, includePattern: { '*.ts': true } }] }), () => true);
  assert(providerAllows(limited, uri('前端/src/app.ts')));
  assert(!providerAllows(limited, uri('前端/src/a.json')));
  assert(!providerAllows(limited, uri('前端/docs/app.ts')));
});

test('empty refresh, ordinary workspace, cached scopes and legacy snapshots', () => {
  const empty = { ...scope, projectRoots: [], notebooks: [] };
  assert(allowed(empty, root, true));
  assert(!allowed(empty, uri('前端/main.js')));
  assert.equal(restrict(query({ smartSearchScope: empty }), () => true).folderQueries.length, 0);
  const normal = { folderQueries: [{ folder: root }] };
  assert.equal(restrict(normal, () => true), normal);
  assert(allowed(undefined, uri('anything')));
  const snapshot = { ...scope, root: root.path };
  const configuration = { getValue: () => snapshot };
  const workspace = { getWorkspace: () => ({ folders: [{ uri: root }] }) };
  assert.equal(getSmartSearchScope(configuration, workspace), getSmartSearchScope(configuration, workspace));
  assert.equal(getSmartSearchScope(configuration, { getWorkspace: () => ({ folders: [] }) }), undefined);
  const legacy = { root, files: ['前端/main.js'], directories: ['.', '前端'] };
  assert(allowed(legacy, uri('前端/main.js')));
  assert(allowed(legacy, uri('前端'), true));
  assert(allowed(legacy, uri('前端/.tours/tour.json')));
  assert(!allowed(legacy, uri('前端/new.csv')));
  assert(providerAllows(restrict(query({ smartSearchScope: legacy }), () => true), uri('前端/main.js')));
});

const ripgrep = resolve(vscode, 'node_modules/@vscode/ripgrep/bin/rg');
test('real ripgrep file and content search obey scope with ignore settings disabled', { skip: !existsSync(ripgrep) }, () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'smart-scope-'));
  try {
    const paths = ['项目 [1]/data/input.csv', '项目 [1]/assets/logo.png', '项目 [1]/build', '项目 [1]/.git', '项目 [1]/nested/build/hidden.csv', '项目 [1]/.IDEA/hidden.csv', '项目 [1]/node_modules/hidden.csv', '项目 1/wrong.csv', '实验/a[1].ipynb', '实验/star*.ipynb', '实验/a1.ipynb', '实验/star-other.ipynb', '视频/hidden.csv'];
    for (const path of paths) {
      const destination = resolve(temporary, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, 'SMART_SCOPE_INTEGRATION');
    }
    const diskRoot = URI.file(temporary);
    const diskScope = { ...scope, root: diskRoot, projectRoots: [URI.joinPath(diskRoot, '项目 [1]').path], notebooks: ['实验/a[1].ipynb', '实验/star*.ipynb'].map(path => URI.joinPath(diskRoot, path).path) };
    const limited = restrict({ folderQueries: [{ folder: diskRoot, disregardIgnoreFiles: true }], smartSearchScope: diskScope }, () => true);
    const args = ['--hidden', '--no-ignore'];
    for (const pattern of Object.keys(limited.folderQueries[0].includePattern)) args.push('-g', pattern);
    for (const pattern of Object.keys(limited.excludePattern)) args.push('-g', '!' + pattern);
    const expected = paths.filter(path => allowed(diskScope, URI.joinPath(diskRoot, path))).sort();
    for (const command of [['--files'], ['--files-with-matches', '--fixed-strings', 'SMART_SCOPE_INTEGRATION']]) {
      const result = spawnSync(ripgrep, [...command, ...args, '.'], { cwd: temporary, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const actual = result.stdout.trim().split('\n').map(path => path.replace(/^\.\//, '')).sort();
      assert.deepEqual(actual, expected);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
