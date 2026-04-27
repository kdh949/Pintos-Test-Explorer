const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");

const PROJECTS = {
  threads: {
    key: "threads",
    label: "Threads",
    projectDir: ["threads"],
    buildDir: ["threads", "build"],
    kernelProgram: ["threads", "build", "kernel.o"]
  },
  userprog: {
    key: "userprog",
    label: "User Programs",
    projectDir: ["userprog"],
    buildDir: ["userprog", "build"],
    kernelProgram: ["userprog", "build", "kernel.o"]
  },
  vm: {
    key: "vm",
    label: "Virtual Memory",
    projectDir: ["vm"],
    buildDir: ["vm", "build"],
    kernelProgram: ["vm", "build", "kernel.o"]
  },
  filesys: {
    key: "filesys",
    label: "File System",
    projectDir: ["filesys"],
    buildDir: ["filesys", "build"],
    kernelProgram: ["filesys", "build", "kernel.o"]
  }
};

const PROJECT_ORDER = ["threads", "userprog", "vm", "filesys"];
const ARTIFACT_ORDER = ["output", "result", "errors"];
const HISTORY_FILE = path.join(".vscode", "pintos-test-history.json");

let treeView = null;
let provider = null;
let outputChannel = null;
let activeDebugServer = null;
let extensionInstallPath = null;

class ProjectNode {
  constructor(project, summary) {
    this.nodeType = "project";
    this.project = project;
    this.summary = summary;
  }
}

class TestNode {
  constructor(project, test, status, artifactPaths) {
    this.nodeType = "test";
    this.project = project;
    this.test = test;
    this.status = status;
    this.artifactPaths = artifactPaths;
  }
}

class ArtifactNode {
  constructor(project, test, artifactKind, filePath) {
    this.nodeType = "artifact";
    this.project = project;
    this.test = test;
    this.artifactKind = artifactKind;
    this.filePath = filePath;
  }
}

class PintosTreeProvider {
  constructor(rootPath) {
    this.rootPath = rootPath;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.testCache = new Map();
    this.checkedTestKeys = new Set();
  }

  refresh() {
    this.testCache.clear();
    this._onDidChangeTreeData.fire();
  }

  makeTestKey(project, test) {
    return `${project.key}:${test.full_name}`;
  }

  isChecked(project, test) {
    return this.checkedTestKeys.has(this.makeTestKey(project, test));
  }

  setChecked(testNode, checked) {
    const key = this.makeTestKey(testNode.project, testNode.test);
    if (checked) {
      this.checkedTestKeys.add(key);
    } else {
      this.checkedTestKeys.delete(key);
    }
  }

  clearChecked() {
    this.checkedTestKeys.clear();
    this._onDidChangeTreeData.fire();
  }

  async getCheckedNodes() {
    const selected = [];
    for (const key of PROJECT_ORDER) {
      const project = PROJECTS[key];
      const tests = await this.getTestsForProject(project);
      for (const test of tests) {
        if (this.isChecked(project, test)) {
          selected.push(this.buildTestNode(project, test));
        }
      }
    }
    return selected;
  }

  async getTreeItem(element) {
    if (element.nodeType === "project") {
      const item = new vscode.TreeItem(
        element.project.label,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.id = `project:${element.project.key}`;
      item.description = `${element.summary.pass}/${element.summary.total} pass`;
      item.tooltip =
        `${element.project.label}\n` +
        `Total: ${element.summary.total}\n` +
        `Pass: ${element.summary.pass}\n` +
        `Fail: ${element.summary.fail}\n` +
        `Not run: ${element.summary.unknown}`;
      item.contextValue = "pintosProject";
      const projectColor =
        element.summary.fail > 0
          ? "charts.red"
          : element.summary.pass > 0
            ? "charts.green"
            : "descriptionForeground";
      item.iconPath = new vscode.ThemeIcon(
        "folder-library",
        new vscode.ThemeColor(projectColor)
      );
      return item;
    }

    if (element.nodeType === "test") {
      const hasArtifacts = ARTIFACT_ORDER.some((kind) => element.artifactPaths[kind]);
      const label = `${String(element.test.index).padStart(2, " ")}. ${element.test.short_name}`;
      const item = new vscode.TreeItem(
        label,
        hasArtifacts
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
      );
      item.id = `test:${element.project.key}:${element.test.full_name}`;
      item.description = statusLabel(element.status);
      item.tooltip = `${element.project.label}\n${element.test.full_name}`;
      item.contextValue = "pintosTest";
      item.iconPath = statusIcon(element.status);
      item.checkboxState = this.isChecked(element.project, element.test)
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
      return item;
    }

    const item = new vscode.TreeItem(
      element.artifactKind,
      vscode.TreeItemCollapsibleState.None
    );
    item.id = `artifact:${element.project.key}:${element.test.full_name}:${element.artifactKind}`;
    item.description = path.basename(element.filePath);
    item.tooltip = element.filePath;
    item.contextValue = "pintosArtifact";
    item.command = {
      command: "pintosTests.openArtifact",
      title: "Open Artifact",
      arguments: [element]
    };
    item.iconPath = artifactIcon(element.artifactKind);
    return item;
  }

  async getChildren(element) {
    if (!element) {
      const projects = await Promise.all(
        PROJECT_ORDER.map(async (key) => {
          const project = PROJECTS[key];
          const tests = await this.getTestsForProject(project);
          const nodes = tests.map((test) => this.buildTestNode(project, test));
          const summary = {
            total: nodes.length,
            pass: nodes.filter((node) => node.status === "pass").length,
            fail: nodes.filter((node) => node.status === "fail").length,
            unknown: nodes.filter((node) => node.status === "unknown").length
          };
          return new ProjectNode(project, summary);
        })
      );
      return projects;
    }

    if (element.nodeType === "project") {
      const tests = await this.getTestsForProject(element.project);
      return tests.map((test) => this.buildTestNode(element.project, test));
    }

    if (element.nodeType === "test") {
      const artifacts = [];
      for (const kind of ARTIFACT_ORDER) {
        const filePath = element.artifactPaths[kind];
        if (filePath) {
          artifacts.push(new ArtifactNode(element.project, element.test, kind, filePath));
        }
      }
      return artifacts;
    }

    return [];
  }

  async getTestsForProject(project) {
    const cached = this.testCache.get(project.key);
    if (cached) {
      return cached;
    }

    const scriptPath = bundledHelperPath("pintos-test-cli.py");
    let tests = [];
    try {
      const stdout = await execFileCapture(
        "python3",
        [scriptPath, "list", project.key, "--json", "--recent-first"],
        { cwd: this.rootPath, env: makeEnv(this.rootPath) }
      );
      tests = JSON.parse(stdout);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendOutput(`Failed to load ${project.key} tests: ${message}\n`);
    }
    this.testCache.set(project.key, tests);
    return tests;
  }

  buildTestNode(project, test) {
    const artifactPaths = {};
    for (const kind of ARTIFACT_ORDER) {
      const candidate = path.join(
        this.rootPath,
        ...project.buildDir,
        `${test.full_name}.${kind}`
      );
      artifactPaths[kind] = fs.existsSync(candidate) ? candidate : null;
    }
    const status = readResultStatus(artifactPaths.result);
    return new TestNode(project, test, status, artifactPaths);
  }
}

function statusLabel(status) {
  if (status === "pass") {
    return "PASS";
  }
  if (status === "fail") {
    return "FAIL";
  }
  return "Not run";
}

function statusIcon(status) {
  if (status === "pass") {
    return new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"));
  }
  if (status === "fail") {
    return new vscode.ThemeIcon("close", new vscode.ThemeColor("charts.red"));
  }
  return new vscode.ThemeIcon(
    "circle-large-outline",
    new vscode.ThemeColor("descriptionForeground")
  );
}

function artifactIcon(kind) {
  if (kind === "result") {
    return new vscode.ThemeIcon("checklist", new vscode.ThemeColor("charts.green"));
  }
  if (kind === "errors") {
    return new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.red"));
  }
  return new vscode.ThemeIcon("output", new vscode.ThemeColor("charts.blue"));
}

function readResultStatus(resultPath) {
  if (!resultPath || !fs.existsSync(resultPath)) {
    return "unknown";
  }
  const text = fs.readFileSync(resultPath, "utf8").trim();
  return text === "PASS" ? "pass" : "fail";
}

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders || [];
  for (const folder of folders) {
    const discovered = discoverPintosRoot(folder.uri.fsPath);
    if (discovered) {
      return discovered;
    }
  }
  return null;
}

function discoverPintosRoot(startPath) {
  let current = path.resolve(startPath);
  while (true) {
    if (isPintosRoot(current)) {
      return current;
    }
    const nested = wrappedPintosRoot(current);
    if (nested) {
      return nested;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function isPintosRoot(candidate) {
  return (
    fs.existsSync(path.join(candidate, "utils", "pintos")) &&
    fs.existsSync(path.join(candidate, "threads", "Make.vars")) &&
    fs.existsSync(path.join(candidate, "userprog", "Make.vars")) &&
    fs.existsSync(path.join(candidate, "vm", "Make.vars")) &&
    fs.existsSync(path.join(candidate, "tests", "Make.tests"))
  );
}

function wrappedPintosRoot(candidate) {
  const nested = path.join(candidate, "pintos");
  return isPintosRoot(nested) ? nested : null;
}

function bundledHelperPath(fileName) {
  if (!extensionInstallPath) {
    throw new Error("Extension install path is not initialized.");
  }
  return path.join(extensionInstallPath, "bundled", fileName);
}

function makeEnv(rootPath) {
  return {
    ...process.env,
    PATH: `${path.join(rootPath, "utils")}${path.delimiter}${process.env.PATH || ""}`,
    PINTOS_ROOT: rootPath,
    PINTOS_WORKSPACE_ROOT: rootPath
  };
}

function execFileCapture(command, args, options) {
  return new Promise((resolve, reject) => {
    cp.execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        const err = new Error(stderr || stdout || error.message);
        err.original = error;
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

function spawnStreaming(command, args, options, onData) {
  const child = cp.spawn(command, args, options);
  child.stdout.on("data", (chunk) => onData(chunk.toString(), "stdout"));
  child.stderr.on("data", (chunk) => onData(chunk.toString(), "stderr"));
  return child;
}

function appendOutput(text) {
  if (!outputChannel) {
    return;
  }
  outputChannel.append(text);
}

function loadHistory(rootPath) {
  const historyPath = path.join(rootPath, HISTORY_FILE);
  if (!fs.existsSync(historyPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(historyPath, "utf8"));
  } catch {
    return {};
  }
}

function saveHistory(rootPath, history) {
  const historyPath = path.join(rootPath, HISTORY_FILE);
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
}

function recordHistory(rootPath, project, tests, action) {
  try {
    const history = loadHistory(rootPath);
    const projectHistory = history[project.key] || {};
    const now = Date.now() / 1000;
    for (const test of tests) {
      const item = projectHistory[test.full_name] || {};
      item.count = Number(item.count || 0) + 1;
      item.last_used = now;
      item.last_action = action;
      projectHistory[test.full_name] = item;
    }
    history[project.key] = projectHistory;
    saveHistory(rootPath, history);
  } catch {
    // Ignore history write failures and keep the main workflow moving.
  }
}

function findGdbPath() {
  if (process.env.PINTOS_GDB_PATH) {
    return process.env.PINTOS_GDB_PATH;
  }
  if (fs.existsSync("/usr/bin/gdb")) {
    return "/usr/bin/gdb";
  }
  const pathEntries = (process.env.PATH || "").split(path.delimiter);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, "gdb");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function normalizeTestSelection(nodes) {
  return nodes
    .filter((node) => node && node.nodeType === "test")
    .sort((left, right) => {
      const projectDelta =
        PROJECT_ORDER.indexOf(left.project.key) - PROJECT_ORDER.indexOf(right.project.key);
      if (projectDelta !== 0) {
        return projectDelta;
      }
      return left.test.index - right.test.index;
    });
}

async function ensureProjectBuildTree(project) {
  const buildMakefile = path.join(provider.rootPath, ...project.buildDir, "Makefile");
  if (fs.existsSync(buildMakefile)) {
    return;
  }

  const projectDir = path.join(provider.rootPath, ...project.projectDir);
  appendOutput(`\n$ make -C ${projectDir}\n`);
  await execFileCapture("make", ["-C", projectDir], {
    cwd: provider.rootPath,
    env: makeEnv(provider.rootPath)
  });
}

async function runTests(nodes) {
  const tests = normalizeTestSelection(nodes);
  if (!tests.length) {
    vscode.window.showWarningMessage("Select at least one checked test.");
    return;
  }

  outputChannel.show(true);
  appendOutput(`\n=== Running ${tests.length} Pintos test(s) ===\n`);
  const testsByProject = new Map();
  for (const testNode of tests) {
    const current = testsByProject.get(testNode.project.key) || [];
    current.push(testNode.test);
    testsByProject.set(testNode.project.key, current);
  }
  for (const [projectKey, projectTests] of testsByProject.entries()) {
    recordHistory(provider.rootPath, PROJECTS[projectKey], projectTests, "run");
  }

  let failures = 0;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Running Pintos tests",
      cancellable: false
    },
    async (progress) => {
      for (let index = 0; index < tests.length; index += 1) {
        const testNode = tests[index];
        const label = `${testNode.project.key}/${testNode.test.short_name}`;
        await ensureProjectBuildTree(testNode.project);
        const buildDir = path.join(provider.rootPath, ...testNode.project.buildDir);
        progress.report({
          message: `[${index + 1}/${tests.length}] ${label}`,
          increment: Math.round(100 / tests.length)
        });
        appendOutput(`\n$ make -C ${buildDir} --no-print-directory ${testNode.test.full_name}.result\n`);

        const exitCode = await new Promise((resolve) => {
          const child = spawnStreaming(
            "make",
            [
              "-C",
              buildDir,
              "--no-print-directory",
              `${testNode.test.full_name}.result`
            ],
            {
              cwd: provider.rootPath,
              env: makeEnv(provider.rootPath)
            },
            (text) => appendOutput(text)
          );
          child.on("error", () => resolve(1));
          child.on("close", (code) => resolve(code ?? 1));
        });

        provider.refresh();
        const refreshed = provider.buildTestNode(testNode.project, testNode.test);
        if (exitCode !== 0 || refreshed.status !== "pass") {
          failures += 1;
        }
      }
    }
  );

  provider.refresh();
  const passed = tests.length - failures;
  const summary = `${passed} passed, ${failures} failed, ${tests.length} total`;
  appendOutput(`\n=== Summary: ${summary} ===\n`);

  if (failures === 0) {
    vscode.window.showInformationMessage(`Pintos tests finished: ${summary}`);
  } else {
    vscode.window.showWarningMessage(`Pintos tests finished: ${summary}`);
  }
}

async function runProject(projectNode) {
  const children = await provider.getChildren(projectNode);
  return runTests(children);
}

async function stopDebugServer() {
  if (!activeDebugServer) {
    return;
  }

  const rootPath = activeDebugServer.rootPath;
  const stopScript = bundledHelperPath("pintos-gdb-server.sh");
  await new Promise((resolve) => {
    const child = spawnStreaming(
      "bash",
      [stopScript, "stop"],
      { cwd: rootPath, env: makeEnv(rootPath) },
      (text) => appendOutput(text)
    );
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });

  activeDebugServer = null;
}

async function debugTest(testNode) {
  if (!testNode || testNode.nodeType !== "test") {
    vscode.window.showWarningMessage("Select exactly one test to debug.");
    return;
  }

  const gdbPath = findGdbPath();
  if (!gdbPath) {
    vscode.window.showErrorMessage(
      "Debugging requires `gdb`, but it was not found on PATH for the active environment. Confirm that `gdb --version` works in your Dev Container or remote environment, then try again."
    );
    return;
  }

  const rootPath = provider.rootPath;
  const gdbScript = bundledHelperPath("pintos-gdb-server.sh");
  recordHistory(rootPath, testNode.project, [testNode.test], "debug");
  await stopDebugServer();

  outputChannel.show(true);
  appendOutput(`\n=== Debugging ${testNode.project.key}/${testNode.test.short_name} ===\n`);

  const ready = await new Promise((resolve, reject) => {
    let settled = false;
    const recentOutput = [];
    const child = spawnStreaming(
      "bash",
      [gdbScript, "start", testNode.project.key, testNode.test.short_name],
      { cwd: rootPath, env: makeEnv(rootPath) },
      (text) => {
        appendOutput(text);
        recentOutput.push(...text.split(/\r?\n/).filter(Boolean));
        if (recentOutput.length > 20) {
          recentOutput.splice(0, recentOutput.length - 20);
        }
        if (!settled && text.includes("PINTOS_GDB_SERVER_READY")) {
          settled = true;
          resolve(child);
        }
      }
    );

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        const tail = recentOutput.slice(-8).join("\n");
        const detail = tail
          ? `\nRecent logs:\n${tail}`
          : "\nCheck the end of the `Pintos Tests` output channel.";
        reject(new Error(`GDB server exited early with code ${code ?? 1}.${detail}`));
      }
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  }).catch(async (error) => {
    await stopDebugServer();
    throw error;
  });

  activeDebugServer = {
    process: ready,
    rootPath
  };

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const config = {
    name: `Pintos Debug: ${testNode.project.label} / ${testNode.test.short_name}`,
    type: "cppdbg",
    request: "launch",
    program: path.join(rootPath, ...testNode.project.kernelProgram),
    cwd: path.join(rootPath, ...testNode.project.buildDir),
    MIMode: "gdb",
    miDebuggerPath: gdbPath,
    miDebuggerServerAddress: "127.0.0.1:1234",
    stopAtEntry: false,
    externalConsole: false,
    launchCompleteCommand: "exec-continue",
    setupCommands: [
      {
        description: "Enable GDB pretty printing",
        text: "-enable-pretty-printing",
        ignoreFailures: true
      }
    ],
    pintosHelperSession: true
  };

  const started = await vscode.debug.startDebugging(workspaceFolder, config);
  if (!started) {
    await stopDebugServer();
    vscode.window.showErrorMessage("VS Code could not start the GDB debug session.");
  }
}

function registerCommand(context, name, fn) {
  context.subscriptions.push(vscode.commands.registerCommand(name, fn));
}

function activate(context) {
  extensionInstallPath = context.extensionPath;
  const rootPath = getWorkspaceRoot();
  outputChannel = vscode.window.createOutputChannel("Pintos Tests");
  appendOutput("Pintos Test Explorer activating...\n");

  if (!rootPath) {
    outputChannel.appendLine("No Pintos project root could be discovered.");
    vscode.window.showWarningMessage(
      "Pintos Test Explorer: Could not find a Pintos project root. Open the repository root, the `pintos/` folder, or a child folder inside it."
    );
    return;
  }

  outputChannel.appendLine(`Pintos root: ${rootPath}`);
  outputChannel.appendLine(`Extension path: ${extensionInstallPath}`);
  provider = new PintosTreeProvider(rootPath);
  treeView = vscode.window.createTreeView("pintosTests", {
    treeDataProvider: provider,
    // Keep multi-run behavior in a single place: the tree checkboxes.
    canSelectMany: false,
    showCollapseAll: true
  });

  context.subscriptions.push(outputChannel, treeView);
  outputChannel.appendLine("Pintos Test Explorer activated.");

  if (typeof treeView.onDidChangeCheckboxState === "function") {
    context.subscriptions.push(
      treeView.onDidChangeCheckboxState((event) => {
        for (const [node, state] of event.items) {
          if (node?.nodeType === "test") {
            provider.setChecked(node, state === vscode.TreeItemCheckboxState.Checked);
          }
        }
        provider.refresh();
      })
    );
  }

  registerCommand(context, "pintosTests.refresh", () => provider.refresh());
  registerCommand(context, "pintosTests.clearChecked", () => provider.clearChecked());
  registerCommand(context, "pintosTests.runSelected", async () => {
    const checked = await provider.getCheckedNodes();
    if (!checked.length) {
      vscode.window.showWarningMessage("Select at least one checked test.");
      return;
    }
    await runTests(checked);
  });
  registerCommand(context, "pintosTests.runProject", async (projectNode) => {
    await runProject(projectNode);
  });
  registerCommand(context, "pintosTests.runTest", async (testNode) => {
    await runTests([testNode]);
  });
  registerCommand(context, "pintosTests.debugTest", async (testNode) => {
    try {
      await debugTest(testNode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Debug start failed: ${message}`);
    }
  });
  registerCommand(context, "pintosTests.openArtifact", async (artifactNode) => {
    if (!artifactNode?.filePath) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(artifactNode.filePath);
    await vscode.window.showTextDocument(document, { preview: false });
  });

  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(async (session) => {
      if (session?.configuration?.pintosHelperSession) {
        await stopDebugServer();
        provider.refresh();
      }
    })
  );
}

async function deactivate() {
  await stopDebugServer();
}

module.exports = {
  activate,
  deactivate
};
