const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
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
const SORT_MODE_NUMBER = "number";
const SORT_MODE_RECENT = "recent";
const DEFAULT_SORT_MODE = SORT_MODE_NUMBER;
const SORT_MODE_STATE_KEY = "pintosTests.sortMode";
const PINTOS_ROOT_LAYOUTS = [
  [],
  ["pintos"],
  ["src"],
  ["pintos", "src"]
];
const CLI_COMMAND_NAMES = ["pintos-tests", "pt"];
const CLI_PROFILE_MARKER = "# Added by Pintos Test Explorer CLI installer";
const CLI_PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';
const CUSTOM_GROUPS_ROOT = path.join(".vscode", "pintos-test-explorer", "groups");
const BUILD_ERROR_RESULT = "BUILD_ERROR";
const CUSTOM_TESTS_DIR_NAME = "custom";
const CUSTOM_GROUP_KEY_PREFIX = "custom-group:";
const CUSTOM_SCAFFOLD_MARKER_LINE = "# Added by Pintos Test Explorer";
const ENABLE_LEGACY_CUSTOM_GROUP_RULES = false;
const DESCENDANT_ROOT_SEARCH_MAX_DEPTH = 4;
const DESCENDANT_ROOT_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".vscode",
  ".idea",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "build",
  "dist",
  "out"
]);
const DEFAULT_GROUP_RULES = {
  threads: [
    {
      key: "alarm-clock",
      label: "Alarm Clock",
      selectors: ["alarm-*"]
    },
    {
      key: "priority",
      label: "Priority",
      selectors: ["alarm-priority", "priority-*"]
    },
    {
      key: "mlfqs",
      label: "MLFQS",
      selectors: ["mlfqs-*"]
    }
  ]
};

let treeView = null;
let provider = null;
let outputChannel = null;
let activeDebugServer = null;
let extensionInstallPath = null;
let cliRuntimeDir = null;
let latestDebugLaunchToken = null;
let lastDebugPreparationErrorMessage = null;
let debugServerTransition = Promise.resolve();
const executableCache = new Map();

class ProjectNode {
  constructor(project, summary) {
    this.nodeType = "project";
    this.project = project;
    this.summary = summary;
  }
}

class GroupNode {
  constructor(project, groupSegments, summary, groupKind = "standard") {
    this.nodeType = "group";
    this.project = project;
    this.groupSegments = groupSegments;
    this.summary = summary;
    this.groupKind = groupKind;
  }
}

class TestNode {
  constructor(project, test, status, artifactPaths, groupSegments, statusDetail, isCustomTest) {
    this.nodeType = "test";
    this.project = project;
    this.test = test;
    this.status = status;
    this.artifactPaths = artifactPaths;
    this.groupSegments = groupSegments;
    this.statusDetail = statusDetail;
    this.isCustomTest = Boolean(isCustomTest);
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
  constructor(rootPath, sortMode = DEFAULT_SORT_MODE) {
    this.rootPath = rootPath;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.testCache = new Map();
    this.testNodeCache = new Map();
    this.customGroupCache = new Map();
    this.checkedTestKeys = new Set();
    this.sortMode = normalizeSortMode(sortMode);
  }

  refresh(options = {}) {
    if (options.clearChecked) {
      this.checkedTestKeys.clear();
    }
    this.testCache.clear();
    this.testNodeCache.clear();
    this.customGroupCache.clear();
    this._onDidChangeTreeData.fire();
  }

  getSortMode() {
    return this.sortMode;
  }

  setSortMode(sortMode) {
    const nextSortMode = normalizeSortMode(sortMode);
    if (this.sortMode === nextSortMode) {
      return false;
    }
    this.sortMode = nextSortMode;
    this.refresh();
    return true;
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

  async setCheckedForNode(node, checked) {
    const testNodes = await this.getDescendantTestNodes(node);
    for (const testNode of testNodes) {
      this.setChecked(testNode, checked);
    }
  }

  clearChecked() {
    this.refresh({ clearChecked: true });
  }

  clearCheckedNodes(nodes) {
    for (const node of nodes) {
      if (node?.nodeType === "test") {
        this.checkedTestKeys.delete(this.makeTestKey(node.project, node.test));
      }
    }
    this.refresh();
  }

  async getCheckedNodes() {
    const selected = [];
    for (const key of PROJECT_ORDER) {
      const project = PROJECTS[key];
      const testNodes = await this.getTestNodesForProject(project);
      for (const testNode of testNodes) {
        if (this.isChecked(testNode.project, testNode.test)) {
          selected.push(testNode);
        }
      }
    }
    return selected;
  }

  summarizeTestNodes(nodes) {
    const summary = {
      total: nodes.length,
      pass: 0,
      fail: 0,
      buildError: 0,
      unknown: 0,
      checked: 0
    };

    for (const node of nodes) {
      if (node.status === "pass") {
        summary.pass += 1;
      } else if (node.status === "build_error") {
        summary.buildError += 1;
      } else if (node.status === "fail") {
        summary.fail += 1;
      } else {
        summary.unknown += 1;
      }

      if (this.isChecked(node.project, node.test)) {
        summary.checked += 1;
      }
    }

    return summary;
  }

  async getTreeItem(element) {
    if (element.nodeType === "project") {
      const item = new vscode.TreeItem(
        element.project.label,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.id = `project:${element.project.key}`;
      item.description = summaryDescription(element.summary);
      item.tooltip = summaryTooltip(element.project.label, element.summary);
      item.contextValue = "pintosProject";
      item.checkboxState = summaryCheckboxState(element.summary);
      item.iconPath = new vscode.ThemeIcon(
        "folder-library",
        new vscode.ThemeColor(summaryColor(element.summary))
      );
      return item;
    }

    if (element.nodeType === "group") {
      const item = new vscode.TreeItem(
        groupLabel(element.groupSegments),
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.id = `group:${element.project.key}:${groupPathKey(element.groupSegments)}`;
      item.description = summaryDescription(element.summary);
      item.tooltip = summaryTooltip(
        `${element.project.label} / ${groupPathLabel(element.groupSegments)}`,
        element.summary
      );
      item.contextValue =
        element.groupKind === "custom-test"
          ? "pintosCustomTestGroup"
          : element.groupKind === "custom-group-rule"
            ? "pintosCustomGroupRule"
            : "pintosGroup";
      item.checkboxState = summaryCheckboxState(element.summary);
      item.iconPath = new vscode.ThemeIcon(
        "folder",
        new vscode.ThemeColor(summaryColor(element.summary))
      );
      return item;
    }

    if (element.nodeType === "test") {
      const hasArtifacts = ARTIFACT_ORDER.some((kind) => element.artifactPaths[kind]);
      const label = `${String(element.test.index).padStart(2, " ")}. ${testLeafName(element.test)}`;
      const item = new vscode.TreeItem(
        label,
        hasArtifacts
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
      );
      item.id = `test:${element.project.key}:${element.test.full_name}`;
      item.description = statusLabel(element.status);
      item.tooltip = buildTestTooltip(element);
      item.contextValue = element.isCustomTest ? "pintosCustomTest" : "pintosTest";
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
          const nodes = await this.getTestNodesForProject(project);
          return new ProjectNode(project, this.summarizeTestNodes(nodes));
        })
      );
      return projects;
    }

    if (element.nodeType === "project") {
      const testNodes = await this.getTestNodesForProject(element.project);
      return this.buildGroupChildren(element.project, [], testNodes);
    }

    if (element.nodeType === "group") {
      const testNodes = await this.getTestNodesForProject(element.project);
      return this.buildGroupChildren(element.project, element.groupSegments, testNodes);
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

  buildGroupChildren(project, parentSegments, allTestNodes) {
    const { groups, tests } = partitionGroupChildren(allTestNodes, parentSegments);
    const groupNodes = groups.map(
      (group) =>
        new GroupNode(
          project,
          group.groupSegments,
          this.summarizeTestNodes(group.testNodes),
          inferGroupKind(group.groupSegments)
        )
    );
    return [...groupNodes, ...tests];
  }

  getCustomGroupsForProject(project) {
    if (!ENABLE_LEGACY_CUSTOM_GROUP_RULES) {
      return [];
    }
    const cached = this.customGroupCache.get(project.key);
    if (cached) {
      return cached;
    }

    const groups = loadCustomGroups(this.rootPath, project);
    this.customGroupCache.set(project.key, groups);
    return groups;
  }

  async getDescendantTestNodes(node) {
    if (!node) {
      return [];
    }
    if (node.nodeType === "test") {
      return [node];
    }
    if (node.nodeType === "artifact") {
      return [];
    }

    const testNodes = await this.getTestNodesForProject(node.project);
    if (node.nodeType === "project") {
      return testNodes;
    }
    if (node.nodeType === "group") {
      return testNodes.filter((testNode) =>
        hasGroupPrefix(testNode.groupSegments, node.groupSegments)
      );
    }

    return [];
  }

  async getTestsForProject(project) {
    const cached = this.testCache.get(project.key);
    if (cached) {
      return cached;
    }

    let tests = [];
    try {
      const args = ["list", project.key, "--json"];
      if (this.sortMode === SORT_MODE_RECENT) {
        args.push("--recent-first");
      }
      const stdout = await runBundledCli(args, {
        cwd: this.rootPath,
        env: makeEnv(this.rootPath)
      });
      tests = JSON.parse(stdout);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendOutput(`Failed to load ${project.key} tests: ${message}\n`);
    }
    this.testCache.set(project.key, tests);
    return tests;
  }

  async getTestNodesForProject(project) {
    const cached = this.testNodeCache.get(project.key);
    if (cached) {
      return cached;
    }

    const tests = await this.getTestsForProject(project);
    const customGroups = this.getCustomGroupsForProject(project);
    const assignments = assignGroupsToTests(project, tests, customGroups);
    const nodes = tests.map((test) =>
      this.buildTestNode(project, test, assignments.get(test.full_name) || [])
    );
    this.testNodeCache.set(project.key, nodes);
    return nodes;
  }

  buildTestNode(project, test, groupSegments = []) {
    const artifactPaths = {};
    const candidates = artifactPathsForTest(this.rootPath, project, test);
    for (const kind of ARTIFACT_ORDER) {
      const candidate = candidates[kind];
      artifactPaths[kind] = fs.existsSync(candidate) ? candidate : null;
    }
    const { status, detail } = readResultStatus(artifactPaths.result, artifactPaths.errors);
    return new TestNode(
      project,
      test,
      status,
      artifactPaths,
      groupSegments,
      detail,
      isDeletableCustomTest(this.rootPath, project, test.short_name)
    );
  }
}

function statusLabel(status) {
  if (status === "pass") {
    return "PASS";
  }
  if (status === "build_error") {
    return "Build error";
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
  if (status === "build_error") {
    return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
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

function normalizeSortMode(sortMode) {
  return sortMode === SORT_MODE_RECENT ? SORT_MODE_RECENT : SORT_MODE_NUMBER;
}

function sortModeLabel(sortMode) {
  return sortMode === SORT_MODE_RECENT ? "Latest first" : "Number order";
}

function isArtifactFile(filePath) {
  return ARTIFACT_ORDER.some((kind) => filePath.endsWith(`.${kind}`));
}

function isWorkspaceArtifactFile(rootPath, filePath) {
  if (!filePath || !isArtifactFile(filePath)) {
    return false;
  }
  const relative = path.relative(rootPath, filePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function collectArtifactFiles(dirPath, files = []) {
  if (!fs.existsSync(dirPath)) {
    return files;
  }

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const childPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectArtifactFiles(childPath, files);
    } else if (entry.isFile() && isArtifactFile(childPath)) {
      files.push(childPath);
    }
  }
  return files;
}

function findWorkspaceArtifactFiles(rootPath) {
  const files = [];
  for (const key of PROJECT_ORDER) {
    const project = PROJECTS[key];
    const testsDir = path.join(rootPath, ...project.buildDir, "tests");
    collectArtifactFiles(testsDir, files);
  }
  return files;
}

function artifactPathsForTest(rootPath, project, test) {
  const artifactPaths = {};
  for (const kind of ARTIFACT_ORDER) {
    artifactPaths[kind] = path.join(
      rootPath,
      ...project.buildDir,
      `${test.full_name}.${kind}`
    );
  }
  return artifactPaths;
}

function ensureTestBuildOutputDirectories(rootPath, project, tests) {
  const buildRoot = path.join(rootPath, ...project.buildDir);
  if (!fs.existsSync(buildRoot)) {
    return;
  }

  for (const test of tests) {
    if (!test?.full_name) {
      continue;
    }
    const outputDir = path.join(buildRoot, path.dirname(test.full_name));
    fs.mkdirSync(outputDir, { recursive: true });
  }
}

function findNodeArtifactFiles(nodes) {
  const files = new Set();
  for (const node of normalizeTestSelection(nodes)) {
    for (const kind of ARTIFACT_ORDER) {
      const filePath = node?.artifactPaths?.[kind];
      if (filePath && fs.existsSync(filePath)) {
        files.add(filePath);
      }
    }
  }
  return [...files];
}

function removeArtifactFiles(filePaths) {
  let removedCount = 0;
  const failures = [];
  const seen = new Set();

  for (const filePath of filePaths) {
    if (!filePath || seen.has(filePath) || !fs.existsSync(filePath)) {
      continue;
    }
    seen.add(filePath);
    try {
      fs.unlinkSync(filePath);
      removedCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${filePath}: ${message}`);
    }
  }

  return { removedCount, failures };
}

function ensureFailedRunArtifacts(rootPath, project, test, detailText) {
  const artifactPaths = artifactPathsForTest(rootPath, project, test);
  fs.mkdirSync(path.dirname(artifactPaths.result), { recursive: true });
  fs.writeFileSync(artifactPaths.result, `${BUILD_ERROR_RESULT}\n`);

  if (!fs.existsSync(artifactPaths.errors)) {
    const details = detailText?.trim()
      ? detailText.trimEnd()
      : "Run failed before Pintos could produce an errors artifact.";
    fs.writeFileSync(artifactPaths.errors, `${details}\n`);
  }
}

function writeArtifactCleanupSummary({ closedTabCount, removedCount, failures, scopeLabel }) {
  outputChannel.appendLine(
    `${scopeLabel}: removed ${removedCount} artifact file(s), closed ${closedTabCount} artifact tab(s).`
  );
  if (!failures.length) {
    return;
  }
  outputChannel.appendLine("Some artifacts could not be removed:");
  for (const failure of failures) {
    outputChannel.appendLine(`- ${failure}`);
  }
}

async function closeOpenArtifactTabs(rootPath, artifactFiles = null) {
  if (!vscode.window.tabGroups?.all || typeof vscode.window.tabGroups.close !== "function") {
    return 0;
  }

  const allowedFiles = artifactFiles ? new Set(artifactFiles) : null;
  const tabsToClose = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (
        input instanceof vscode.TabInputText &&
        isWorkspaceArtifactFile(rootPath, input.uri.fsPath) &&
        (!allowedFiles || allowedFiles.has(input.uri.fsPath))
      ) {
        tabsToClose.push(tab);
      }
    }
  }

  if (!tabsToClose.length) {
    return 0;
  }

  await vscode.window.tabGroups.close(tabsToClose, true);
  return tabsToClose.length;
}

function makeGroupSegment(key, label = humanizeGroupKey(key)) {
  return { key, label };
}

function makeCustomGroupSegment(key, label = humanizeGroupKey(key)) {
  return { key: `${CUSTOM_GROUP_KEY_PREFIX}${key}`, label };
}

function isCustomGroupSegment(segment) {
  return typeof segment?.key === "string" && segment.key.startsWith(CUSTOM_GROUP_KEY_PREFIX);
}

function customGroupSegmentPathPart(segment) {
  return isCustomGroupSegment(segment)
    ? segment.key.slice(CUSTOM_GROUP_KEY_PREFIX.length)
    : segment?.key || "";
}

function isCustomGroupRuleSegments(groupSegments) {
  return Array.isArray(groupSegments) && groupSegments.length > 0 && groupSegments.every(isCustomGroupSegment);
}

function isCustomTestGroupSegments(groupSegments) {
  return Array.isArray(groupSegments) && groupSegments[0]?.key === CUSTOM_TESTS_DIR_NAME;
}

function inferGroupKind(groupSegments) {
  if (isCustomGroupRuleSegments(groupSegments)) {
    return "custom-group-rule";
  }
  if (isCustomTestGroupSegments(groupSegments)) {
    return "custom-test";
  }
  return "standard";
}

function humanizeGroupKey(key) {
  const normalized = String(key || "")
    .trim()
    .replace(/\.json$/i, "");
  if (!normalized) {
    return "Other";
  }

  const explicit = {
    mlfqs: "MLFQS",
    rox: "ROX",
    cwd: "CWD",
    dir: "Directories",
    grow: "Growing Files"
  };
  const explicitLabel = explicit[normalized.toLowerCase()];
  if (explicitLabel) {
    return explicitLabel;
  }

  return normalized
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (explicit[lower]) {
        return explicit[lower];
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function groupPathKey(groupSegments) {
  return groupSegments.map((segment) => segment.key).join("/");
}

function groupLabel(groupSegments) {
  return groupSegments[groupSegments.length - 1]?.label || "Other";
}

function groupPathLabel(groupSegments) {
  return groupSegments.map((segment) => segment.label).join(" / ");
}

function hasGroupPrefix(groupSegments, prefixSegments) {
  if (prefixSegments.length > groupSegments.length) {
    return false;
  }
  return prefixSegments.every(
    (segment, index) => groupSegments[index]?.key === segment.key
  );
}

function partitionGroupChildren(testNodes, parentSegments) {
  const groups = new Map();
  const tests = [];

  for (const node of testNodes) {
    if (!hasGroupPrefix(node.groupSegments, parentSegments)) {
      continue;
    }

    if (node.groupSegments.length === parentSegments.length) {
      tests.push(node);
      continue;
    }

    const childSegments = node.groupSegments.slice(0, parentSegments.length + 1);
    const key = groupPathKey(childSegments);
    const bucket = groups.get(key) || {
      groupSegments: childSegments,
      testNodes: []
    };
    bucket.testNodes.push(node);
    groups.set(key, bucket);
  }

  return {
    groups: [...groups.values()],
    tests
  };
}

function summaryDescription(summary) {
  if (summary.total === 0) {
    return "No tests";
  }

  return `${summary.pass}/${summary.total} passed`;
}

function summaryTooltip(title, summary) {
  return [
    title,
    `Total: ${summary.total}`,
    `Pass: ${summary.pass}`,
    `Fail: ${summary.fail}`,
    `Build error: ${summary.buildError}`,
    `Not run: ${summary.unknown}`,
    `Checked: ${summary.checked}`
  ].join("\n");
}

function summaryColor(summary) {
  if (summary.fail > 0 || summary.buildError > 0) {
    return "charts.red";
  }
  if (summary.pass > 0) {
    return "charts.green";
  }
  return "descriptionForeground";
}

function summaryCheckboxState(summary) {
  return summary.total > 0 && summary.checked === summary.total
    ? vscode.TreeItemCheckboxState.Checked
    : vscode.TreeItemCheckboxState.Unchecked;
}

function testLeafName(test) {
  return test.short_name.split("/").pop() || test.short_name;
}

function buildTestTooltip(testNode) {
  const lines = [
    testNode.project.label,
    testNode.test.full_name
  ];

  if (testNode.status === "build_error" && testNode.statusDetail) {
    lines.push("", "Recent build output:", testNode.statusDetail);
  }

  return lines.join("\n");
}

function readArtifactPreview(filePath, maxLines = 6) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    const lines = fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, maxLines);
    return lines.length ? lines.join("\n") : null;
  } catch {
    return null;
  }
}

function looksLikeBuildError(detailText) {
  if (!detailText) {
    return false;
  }

  return /(make(\[\d+\])?: \*\*\*|: error:|fatal error:|undefined reference|collect2:|ld:|cc1:)/i.test(
    detailText
  );
}

function readResultStatus(resultPath, errorsPath) {
  if (!resultPath || !fs.existsSync(resultPath)) {
    return { status: "unknown", detail: null };
  }

  const text = fs.readFileSync(resultPath, "utf8").trim();
  const detail = readArtifactPreview(errorsPath);
  if (text === "PASS") {
    return { status: "pass", detail };
  }
  if (text === BUILD_ERROR_RESULT) {
    return { status: "build_error", detail };
  }
  if (looksLikeBuildError(detail)) {
    return { status: "build_error", detail };
  }
  return { status: "fail", detail };
}

function collectJsonFiles(dirPath, files = []) {
  if (!fs.existsSync(dirPath)) {
    return files;
  }

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const childPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectJsonFiles(childPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(childPath);
    }
  }

  return files;
}

function loadCustomGroups(rootPath, project) {
  const projectGroupsDir = path.join(rootPath, CUSTOM_GROUPS_ROOT, project.key);
  const files = collectJsonFiles(projectGroupsDir).sort((left, right) =>
    left.localeCompare(right)
  );
  const groups = [];

  for (const filePath of files) {
    try {
      const relativePath = path.relative(projectGroupsDir, filePath);
      const pathSegments = relativePath.split(path.sep);
      const baseName = path.basename(filePath, ".json");
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const selectors = Array.isArray(raw?.selectors)
        ? raw.selectors.filter((value) => typeof value === "string" && value.trim())
        : [];

      if (!selectors.length) {
        appendOutput(
          `Ignored custom group file ${filePath}: add a non-empty "selectors" array.\n`
        );
        continue;
      }

      const parentSegments = pathSegments
        .slice(0, -1)
        .map((segment) => makeCustomGroupSegment(segment));
      const leafLabel =
        typeof raw.label === "string" && raw.label.trim()
          ? raw.label.trim()
          : humanizeGroupKey(baseName);

      groups.push({
        filePath,
        selectors,
        groupSegments: [...parentSegments, makeCustomGroupSegment(baseName, leafLabel)]
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendOutput(`Failed to load custom group file ${filePath}: ${message}\n`);
    }
  }

  return groups;
}

function hasWildcard(pattern) {
  return /[*?[]/.test(pattern);
}

function escapeRegexChar(char) {
  return /[\\^$+?.()|{}]/.test(char) ? `\\${char}` : char;
}

function globToRegExp(pattern) {
  let result = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      result += ".*";
      continue;
    }
    if (char === "?") {
      result += ".";
      continue;
    }
    if (char === "[") {
      const closing = pattern.indexOf("]", index + 1);
      if (closing > index + 1) {
        result += pattern.slice(index, closing + 1);
        index = closing;
        continue;
      }
    }
    result += escapeRegexChar(char);
  }
  result += "$";
  return new RegExp(result);
}

function matchesSelector(test, selector, maxIndex) {
  const token = String(selector || "").trim();
  if (!token) {
    return false;
  }
  if (token === "all") {
    return true;
  }
  if (/^\d+$/.test(token)) {
    return test.index === Number(token);
  }
  if (/^\d+-\d+$/.test(token)) {
    const [start, end] = token.split("-").map(Number);
    return start <= end && test.index >= start && test.index <= Math.min(end, maxIndex);
  }
  if (
    token === test.short_name ||
    token === test.full_name ||
    token === testLeafName(test)
  ) {
    return true;
  }
  if (hasWildcard(token)) {
    const matcher = globToRegExp(token);
    return (
      matcher.test(test.short_name) ||
      matcher.test(test.full_name) ||
      matcher.test(testLeafName(test))
    );
  }
  return false;
}

function matchDefaultGroup(project, test, maxIndex) {
  const rules = DEFAULT_GROUP_RULES[project.key] || [];
  for (const rule of rules) {
    if (rule.selectors.some((selector) => matchesSelector(test, selector, maxIndex))) {
      return [makeGroupSegment(rule.key, rule.label)];
    }
  }
  return [];
}

function segmentsFromTestPath(test) {
  const parts = test.short_name.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return [];
  }
  return parts.slice(0, -1).map((segment) => makeGroupSegment(segment));
}

function fallbackFamilyKey(test) {
  const leaf = testLeafName(test);
  if (!leaf.includes("-")) {
    return null;
  }
  return leaf.split("-", 1)[0] || null;
}

function assignGroupsToTests(project, tests, customGroups) {
  const assignments = new Map();
  const assigned = new Set();

  for (const group of customGroups) {
    for (const test of tests) {
      if (assigned.has(test.full_name)) {
        continue;
      }
      if (!group.selectors.some((selector) => matchesSelector(test, selector, tests.length))) {
        continue;
      }
      assignments.set(test.full_name, group.groupSegments);
      assigned.add(test.full_name);
    }
  }

  const familyCounts = new Map();
  for (const test of tests) {
    if (assigned.has(test.full_name)) {
      continue;
    }
    const familyKey = fallbackFamilyKey(test);
    if (!familyKey) {
      continue;
    }
    familyCounts.set(familyKey, (familyCounts.get(familyKey) || 0) + 1);
  }

  for (const test of tests) {
    if (assigned.has(test.full_name)) {
      continue;
    }

    let groupSegments = segmentsFromTestPath(test);
    if (!groupSegments.length) {
      groupSegments = matchDefaultGroup(project, test, tests.length);
    }
    if (!groupSegments.length) {
      const familyKey = fallbackFamilyKey(test);
      if (familyKey && (familyCounts.get(familyKey) || 0) > 1) {
        groupSegments = [makeGroupSegment(familyKey)];
      } else {
        groupSegments = [makeGroupSegment("other", "Other")];
      }
    }

    assignments.set(test.full_name, groupSegments);
  }

  return assignments;
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

function pintosRootSearchHelpText() {
  return "Open the Pintos root, a nested folder like `*/pintos/` or `*/pintos/src/`, or a child folder inside one of them.";
}

function discoverPintosRoot(startPath) {
  const resolvedStartPath = path.resolve(startPath);
  let current = resolvedStartPath;
  while (true) {
    for (const candidate of pintosRootCandidates(current)) {
      if (isPintosRoot(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return findDescendantPintosRoot(resolvedStartPath);
}

function pintosRootCandidates(basePath) {
  return PINTOS_ROOT_LAYOUTS.map((segments) => path.join(basePath, ...segments));
}

function findDescendantPintosRoot(startPath, maxDepth = DESCENDANT_ROOT_SEARCH_MAX_DEPTH) {
  const queue = [{ dir: startPath, depth: 0 }];
  const visited = new Set();

  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    if (visited.has(dir)) {
      continue;
    }
    visited.add(dir);

    for (const candidate of pintosRootCandidates(dir)) {
      if (isPintosRoot(candidate)) {
        return candidate;
      }
    }

    if (depth >= maxDepth) {
      continue;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink()) {
        continue;
      }
      if (DESCENDANT_ROOT_IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      queue.push({
        dir: path.join(dir, entry.name),
        depth: depth + 1
      });
    }
  }

  return null;
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

function bundledHelperPath(fileName) {
  if (!extensionInstallPath) {
    throw new Error("Extension install path is not initialized.");
  }
  return path.join(extensionInstallPath, "bundled", fileName);
}

function bundledCliPath(commandName) {
  if (!cliRuntimeDir) {
    throw new Error("CLI runtime directory is not initialized.");
  }
  return path.join(cliRuntimeDir, commandName);
}

function isRunnableFile(filePath) {
  try {
    fs.accessSync(
      filePath,
      process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK
    );
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function commandPathCandidates(commandName) {
  if (process.platform !== "win32" || path.extname(commandName)) {
    return [commandName];
  }

  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  return [commandName, ...extensions.map((ext) => `${commandName}${ext}`)];
}

function resolveCommandPath(commandName) {
  const cacheKey = `command:${commandName}`;
  if (executableCache.has(cacheKey)) {
    return executableCache.get(cacheKey);
  }

  let resolved = null;
  if (commandName) {
    const hasSeparator =
      commandName.includes(path.sep) || commandName.includes(path.posix.sep);
    if (hasSeparator || path.isAbsolute(commandName)) {
      resolved = isRunnableFile(commandName) ? commandName : null;
    } else {
      const pathEntries = (process.env.PATH || "")
        .split(path.delimiter)
        .filter(Boolean);
      outer: for (const entry of pathEntries) {
        for (const candidate of commandPathCandidates(commandName)) {
          const candidatePath = path.join(entry, candidate);
          if (isRunnableFile(candidatePath)) {
            resolved = candidatePath;
            break outer;
          }
        }
      }
    }
  }

  executableCache.set(cacheKey, resolved);
  return resolved;
}

function resolvePythonRuntime() {
  if (executableCache.has("pythonRuntime")) {
    return executableCache.get("pythonRuntime");
  }

  let runtime = null;
  const configuredPath = process.env.PINTOS_PYTHON_PATH;
  if (configuredPath) {
    const resolvedConfiguredPath = resolveCommandPath(configuredPath);
    if (resolvedConfiguredPath) {
      runtime = { command: resolvedConfiguredPath, args: [] };
    }
  }

  if (!runtime && process.platform === "win32") {
    const pyLauncher = resolveCommandPath("py");
    if (pyLauncher) {
      runtime = { command: pyLauncher, args: ["-3"] };
    }
  }

  if (!runtime) {
    const python3Path = resolveCommandPath("python3");
    if (python3Path) {
      runtime = { command: python3Path, args: [] };
    }
  }

  if (!runtime) {
    const pythonPath = resolveCommandPath("python");
    if (pythonPath) {
      runtime = { command: pythonPath, args: [] };
    }
  }

  executableCache.set("pythonRuntime", runtime);
  return runtime;
}

function resolveBashPath() {
  if (executableCache.has("bashPath")) {
    return executableCache.get("bashPath");
  }

  const configuredPath = process.env.PINTOS_BASH_PATH;
  const candidates = configuredPath
    ? [configuredPath]
    : ["bash", "/usr/bin/bash", "/bin/bash"];
  const resolved = candidates
    .map((candidate) => resolveCommandPath(candidate))
    .find(Boolean) || null;

  executableCache.set("bashPath", resolved);
  return resolved;
}

function runBundledCli(args, options) {
  const pythonRuntime = resolvePythonRuntime();
  if (!pythonRuntime) {
    return Promise.reject(
      new Error(
        "Could not find a Python interpreter. Install Python 3 or set PINTOS_PYTHON_PATH."
      )
    );
  }

  return execFileCapture(
    pythonRuntime.command,
    [...pythonRuntime.args, bundledHelperPath("pintos-test-cli.py"), ...args],
    options
  );
}

async function runBundledCliJson(args, options) {
  const stdout = await runBundledCli(args, options);
  return JSON.parse(stdout);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function writeWindowsCliWrappers(targetDir) {
  const pintosTestsWrapper = [
    "@echo off",
    "setlocal",
    "set \"SCRIPT_DIR=%~dp0\"",
    "if defined PINTOS_PYTHON_PATH (",
    "  \"%PINTOS_PYTHON_PATH%\" \"%SCRIPT_DIR%pintos-test-cli.py\" %*",
    "  exit /b %errorlevel%",
    ")",
    "where py >nul 2>nul",
    "if not errorlevel 1 (",
    "  py -3 \"%SCRIPT_DIR%pintos-test-cli.py\" %*",
    "  exit /b %errorlevel%",
    ")",
    "where python3 >nul 2>nul",
    "if not errorlevel 1 (",
    "  python3 \"%SCRIPT_DIR%pintos-test-cli.py\" %*",
    "  exit /b %errorlevel%",
    ")",
    "where python >nul 2>nul",
    "if not errorlevel 1 (",
    "  python \"%SCRIPT_DIR%pintos-test-cli.py\" %*",
    "  exit /b %errorlevel%",
    ")",
    ">&2 echo Could not find a Python interpreter. Install Python 3 or set PINTOS_PYTHON_PATH.",
    "exit /b 127",
    ""
  ].join("\r\n");
  const ptWrapper = [
    "@echo off",
    "setlocal",
    "call \"%~dp0pintos-tests.cmd\" %*",
    "exit /b %errorlevel%",
    ""
  ].join("\r\n");

  fs.writeFileSync(path.join(targetDir, "pintos-tests.cmd"), pintosTestsWrapper, "utf8");
  fs.writeFileSync(path.join(targetDir, "pt.cmd"), ptWrapper, "utf8");
}

function ensureCliRuntimeFiles(context) {
  const baseDir = context.globalStorageUri?.fsPath;
  if (!baseDir) {
    throw new Error("Global storage is not available for CLI runtime files.");
  }

  const targetDir = path.join(baseDir, "cli");
  const fileNames = [
    "pintos-test-cli.py",
    "pintos-gdb-server.sh",
    "pintos-tests",
    "pt"
  ];

  fs.mkdirSync(targetDir, { recursive: true });
  for (const fileName of fileNames) {
    const sourcePath = bundledHelperPath(fileName);
    const targetPath = path.join(targetDir, fileName);
    fs.copyFileSync(sourcePath, targetPath);
    fs.chmodSync(targetPath, 0o755);
  }

  if (process.platform === "win32") {
    writeWindowsCliWrappers(targetDir);
  }

  cliRuntimeDir = targetDir;
}

function configureTerminalCli(context) {
  const bundledDir = path.dirname(bundledCliPath("pt"));
  context.environmentVariableCollection.clear();
  context.environmentVariableCollection.prepend(
    "PATH",
    `${bundledDir}${path.delimiter}`
  );
}

function detectProfileFile() {
  const shellName = path.basename(process.env.SHELL || "bash");
  const homeDir = os.homedir();

  switch (shellName) {
    case "zsh":
      return path.join(homeDir, ".zshrc");
    case "bash": {
      const bashProfile = path.join(homeDir, ".bash_profile");
      const bashRc = path.join(homeDir, ".bashrc");
      if (fs.existsSync(bashProfile) || !fs.existsSync(bashRc)) {
        return bashProfile;
      }
      return bashRc;
    }
    default:
      return path.join(homeDir, ".profile");
  }
}

function ensurePathLine(profileFile) {
  fs.mkdirSync(path.dirname(profileFile), { recursive: true });
  if (!fs.existsSync(profileFile)) {
    fs.writeFileSync(profileFile, "", "utf8");
  }

  const existing = fs.readFileSync(profileFile, "utf8");
  const lines = existing.split(/\r?\n/);
  if (lines.includes(CLI_PATH_LINE)) {
    return;
  }

  const addition = `\n${CLI_PROFILE_MARKER}\n${CLI_PATH_LINE}\n`;
  fs.appendFileSync(profileFile, addition, "utf8");
}

function installCliWrappers() {
  const homeDir = os.homedir();
  if (!homeDir) {
    throw new Error("Could not determine the current home directory.");
  }

  const binDir = path.join(homeDir, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });

  for (const commandName of CLI_COMMAND_NAMES) {
    const targetPath = path.join(binDir, commandName);
    const bundledPath = bundledCliPath(commandName);
    const wrapper = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `exec ${shellQuote(bundledPath)} "$@"`,
      ""
    ].join("\n");
    fs.writeFileSync(targetPath, wrapper, "utf8");
    fs.chmodSync(targetPath, 0o755);
  }

  const profileFile = detectProfileFile();
  ensurePathLine(profileFile);

  return { binDir, profileFile };
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
    const configuredPath = resolveCommandPath(process.env.PINTOS_GDB_PATH);
    if (configuredPath) {
      return configuredPath;
    }
  }
  return resolveCommandPath("gdb");
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
    const tests = await provider.getTestsForProject(project);
    ensureTestBuildOutputDirectories(provider.rootPath, project, tests);
    return;
  }

  const projectDir = path.join(provider.rootPath, ...project.projectDir);
  appendOutput(`\n$ make -C ${projectDir}\n`);
  await execFileCapture("make", ["-C", projectDir], {
    cwd: provider.rootPath,
    env: makeEnv(provider.rootPath)
  });
  const tests = await provider.getTestsForProject(project);
  ensureTestBuildOutputDirectories(provider.rootPath, project, tests);
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
  const buildPreparationErrors = new Map();
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
        let buildPreparationError = buildPreparationErrors.get(testNode.project.key);
        if (buildPreparationError === undefined) {
          try {
            await ensureProjectBuildTree(testNode.project);
            buildPreparationError = null;
          } catch (error) {
            buildPreparationError = error instanceof Error ? error.message : String(error);
            appendOutput(`${buildPreparationError}\n`);
          }
          buildPreparationErrors.set(testNode.project.key, buildPreparationError);
        }

        if (buildPreparationError) {
          failures += 1;
          ensureFailedRunArtifacts(
            provider.rootPath,
            testNode.project,
            testNode.test,
            buildPreparationError
          );
          provider.refresh();
          continue;
        }

        const buildDir = path.join(provider.rootPath, ...testNode.project.buildDir);
        progress.report({
          message: `[${index + 1}/${tests.length}] ${label}`,
          increment: Math.round(100 / tests.length)
        });
        appendOutput(`\n$ make -C ${buildDir} --no-print-directory ${testNode.test.full_name}.result\n`);

        const { failures: cleanupFailures } = removeArtifactFiles(
          Object.values(artifactPathsForTest(provider.rootPath, testNode.project, testNode.test))
        );
        if (cleanupFailures.length) {
          failures += 1;
          appendOutput("Could not remove existing artifacts before rerun:\n");
          for (const failure of cleanupFailures) {
            appendOutput(`- ${failure}\n`);
          }
          ensureFailedRunArtifacts(
            provider.rootPath,
            testNode.project,
            testNode.test,
            [
              "Run failed before execution because existing artifacts could not be removed.",
              ...cleanupFailures.map((failure) => `- ${failure}`)
            ].join("\n")
          );
          continue;
        }

        const runLog = [];
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
            (text) => {
              appendOutput(text);
              runLog.push(text);
            }
          );
          child.on("error", () => resolve(1));
          child.on("close", (code) => resolve(code ?? 1));
        });

        if (exitCode !== 0) {
          ensureFailedRunArtifacts(
            provider.rootPath,
            testNode.project,
            testNode.test,
            runLog.join("").trim()
              ? runLog.join("")
              : `make exited with ${exitCode}`
          );
        }

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
  const tests = await provider.getDescendantTestNodes(projectNode);
  return runTests(tests);
}

async function runGroup(groupNode) {
  const tests = await provider.getDescendantTestNodes(groupNode);
  return runTests(tests);
}

function createDebugLaunchToken() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function queueDebugServerOperation(operation) {
  const next = debugServerTransition.catch(() => {}).then(operation);
  debugServerTransition = next.catch(() => {});
  return next;
}

async function stopDebugServerUnlocked() {
  if (!activeDebugServer) {
    return;
  }

  const rootPath = activeDebugServer.rootPath;
  const bashPath = resolveBashPath();
  if (!bashPath) {
    appendOutput("Could not stop the Pintos GDB server because `bash` was not found.\n");
    activeDebugServer = null;
    return;
  }
  await new Promise((resolve) => {
    const child = spawnStreaming(
      bashPath,
      [bundledHelperPath("pintos-gdb-server.sh"), "stop"],
      { cwd: rootPath, env: makeEnv(rootPath) },
      (text) => appendOutput(text)
    );
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });

  activeDebugServer = null;
}

async function stopDebugServer() {
  await queueDebugServerOperation(async () => {
    await stopDebugServerUnlocked();
  });
}

async function startDebugServerUnlocked(rootPath, projectKey, testName) {
  const bashPath = resolveBashPath();
  if (!bashPath) {
    throw new Error(
      "Debugging requires `bash`, but it was not found on PATH for the active environment. Install bash or set PINTOS_BASH_PATH, then try again."
    );
  }

  const ready = await new Promise((resolve, reject) => {
    let settled = false;
    const recentOutput = [];
    const child = spawnStreaming(
      bashPath,
      [bundledHelperPath("pintos-gdb-server.sh"), "start", projectKey, testName],
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
    await stopDebugServerUnlocked();
    throw error;
  });

  activeDebugServer = {
    process: ready,
    rootPath
  };

  return ready;
}

async function prepareDebugServerForConfiguration(config) {
  const rootPath = config?.pintosRootPath || provider?.rootPath;
  const project = PROJECTS[config?.pintosProjectKey];
  const testName = config?.pintosTestName;

  if (!rootPath || !project || !testName) {
    throw new Error("Missing Pintos debug metadata for this session.");
  }

  await queueDebugServerOperation(async () => {
    await stopDebugServerUnlocked();
    outputChannel.show(true);
    appendOutput(`\n=== Debugging ${project.key}/${testName} ===\n`);
    await ensureProjectBuildTree(project);
    await startDebugServerUnlocked(rootPath, project.key, testName);
  });
}

function buildPintosDebugConfiguration(rootPath, testNode, gdbPath) {
  return {
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
    pintosHelperSession: true,
    pintosRootPath: rootPath,
    pintosProjectKey: testNode.project.key,
    pintosTestName: testNode.test.short_name
  };
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
  recordHistory(rootPath, testNode.project, [testNode.test], "debug");

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const config = buildPintosDebugConfiguration(rootPath, testNode, gdbPath);

  const started = await vscode.debug.startDebugging(workspaceFolder, config);
  if (!started && !lastDebugPreparationErrorMessage) {
    await stopDebugServer();
    vscode.window.showErrorMessage("VS Code could not start the GDB debug session.");
  }
  lastDebugPreparationErrorMessage = null;
}

async function clearCheckedArtifacts() {
  const checked = await provider.getCheckedNodes();
  if (!checked.length) {
    vscode.window.showWarningMessage("Select at least one checked test to reset.");
    return;
  }

  const artifactFiles = findNodeArtifactFiles(checked);
  const closedTabCount = await closeOpenArtifactTabs(provider.rootPath, artifactFiles);
  const { removedCount, failures } = removeArtifactFiles(artifactFiles);

  writeArtifactCleanupSummary({
    closedTabCount,
    removedCount,
    failures,
    scopeLabel: "Reset checked tests"
  });
  if (failures.length) {
    outputChannel.show(true);
  }

  provider.clearCheckedNodes(checked);

  if (failures.length) {
    vscode.window.showWarningMessage(
      `Reset checked tests, closed ${closedTabCount} artifact tab(s), and removed ${removedCount} artifact file(s), but ${failures.length} file(s) could not be deleted.`
    );
    return;
  }

  vscode.window.showInformationMessage(
    removedCount > 0
      ? `Reset checked tests and removed ${removedCount} artifact file(s).`
      : closedTabCount > 0
        ? `Reset checked tests and closed ${closedTabCount} artifact tab(s).`
        : "Reset checked tests. No artifact files were found."
  );
}

async function clearAllArtifacts() {
  const artifactFiles = findWorkspaceArtifactFiles(provider.rootPath);
  const closedTabCount = await closeOpenArtifactTabs(provider.rootPath);
  const { removedCount, failures } = removeArtifactFiles(artifactFiles);

  outputChannel.clear();
  writeArtifactCleanupSummary({
    closedTabCount,
    removedCount,
    failures,
    scopeLabel: "Reset all tests"
  });
  if (failures.length) {
    outputChannel.show(true);
  }

  provider.refresh({ clearChecked: true });

  if (failures.length) {
    vscode.window.showWarningMessage(
      `Reset all tests, closed ${closedTabCount} artifact tab(s), and removed ${removedCount} artifact file(s), but ${failures.length} file(s) could not be deleted.`
    );
    return;
  }

  vscode.window.showInformationMessage(
    removedCount > 0
      ? `Reset all tests and removed ${removedCount} artifact file(s).`
      : closedTabCount > 0
        ? `Reset all tests and closed ${closedTabCount} artifact tab(s).`
        : "Reset all tests. No artifact files were found."
  );
}

function customGroupPlaceholderSelector(project) {
  return `tests/${project.key}/${CUSTOM_TESTS_DIR_NAME}/example-test`;
}

function normalizeCustomGroupInput(rawValue) {
  return String(rawValue || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function normalizeCustomTestInput(rawValue) {
  return String(rawValue || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.(c|ck)$/i, "");
}

function groupNodeStartsWithCustom(node) {
  return (
    node?.nodeType === "group" &&
    Array.isArray(node.groupSegments) &&
    node.groupSegments[0]?.key === CUSTOM_TESTS_DIR_NAME
  );
}

function groupNodeIsCustomRule(node) {
  return node?.nodeType === "group" && isCustomGroupRuleSegments(node.groupSegments);
}

function suggestedCustomGroupPath(node) {
  if (groupNodeIsCustomRule(node)) {
    const pathParts = node.groupSegments.map(customGroupSegmentPathPart);
    const groupRootDir = provider?.rootPath ? customGroupRootDir(provider.rootPath, node.project) : null;
    const leafJsonPath =
      groupRootDir && pathParts.length
        ? path.join(groupRootDir, ...pathParts) + ".json"
        : null;
    const parentParts =
      leafJsonPath && fs.existsSync(leafJsonPath) ? pathParts.slice(0, -1) : pathParts;
    return [...parentParts, "new-group"].join("/");
  }
  if (groupNodeStartsWithCustom(node)) {
    return [...node.groupSegments.map((segment) => segment.key), "new-group"].join("/");
  }
  return `${CUSTOM_TESTS_DIR_NAME}/new-group`;
}

function suggestedCustomTestPath(node) {
  if (groupNodeStartsWithCustom(node)) {
    return [...node.groupSegments.map((segment) => segment.key), "new-test"].join("/");
  }
  if (
    node?.nodeType === "test" &&
    Array.isArray(node.groupSegments) &&
    node.groupSegments[0]?.key === CUSTOM_TESTS_DIR_NAME
  ) {
    return [...node.groupSegments.map((segment) => segment.key), "new-test"].join("/");
  }
  return `${CUSTOM_TESTS_DIR_NAME}/new-test`;
}

function validateRelativeTestPath(value) {
  const normalized = normalizeCustomTestInput(value);
  if (!normalized) {
    return "Enter at least one file or folder name.";
  }
  if (normalized.split("/").includes("..")) {
    return "Parent directory segments are not allowed.";
  }
  if (!/^[A-Za-z0-9/_-]+$/.test(normalized)) {
    return "Use only letters, numbers, hyphens, underscores, and /.";
  }
  return null;
}

function validateManagedCustomPath(value) {
  const baseError = validateRelativeTestPath(value);
  if (baseError) {
    return baseError;
  }

  const normalized = normalizeCustomTestInput(value);
  if (!looksLikeCustomTestPath(normalized)) {
    return `Custom paths must live under ${CUSTOM_TESTS_DIR_NAME}/...`;
  }

  return null;
}

function customTestsProjectDir(rootPath, project) {
  return path.join(rootPath, "tests", project.key);
}

function customTestAbsoluteBasePath(rootPath, project, relativeTestPath) {
  return path.join(customTestsProjectDir(rootPath, project), ...relativeTestPath.split("/"));
}

function customTestFullName(project, relativeTestPath) {
  return `tests/${project.key}/${relativeTestPath}`;
}

function looksLikeCustomTestPath(relativeTestPath) {
  return relativeTestPath === CUSTOM_TESTS_DIR_NAME || relativeTestPath.startsWith(`${CUSTOM_TESTS_DIR_NAME}/`);
}

function customTestRegistrationLines(project, relativeTestPath) {
  const fullName = customTestFullName(project, relativeTestPath);
  return isUserProgramStyleProject(project)
    ? [
        `tests/${project.key}_TESTS += ${fullName}`,
        `${fullName}_SRC = ${fullName}.c`
      ]
    : [
        `tests/${project.key}_TESTS += ${fullName}`,
        `tests/${project.key}_SRC += ${fullName}.c`
      ];
}

function customTestMakeTestsPath(rootPath, project) {
  return path.join(rootPath, "tests", project.key, "Make.tests");
}

function isManagedCustomTest(rootPath, project, relativeTestPath) {
  const makeTestsPath = customTestMakeTestsPath(rootPath, project);
  if (!fs.existsSync(makeTestsPath)) {
    return false;
  }

  const lines = customTestRegistrationLines(project, relativeTestPath);
  const text = fs.readFileSync(makeTestsPath, "utf8");
  return text.includes(CUSTOM_SCAFFOLD_MARKER_LINE) && lines.every((line) => text.includes(line));
}

function isDeletableCustomTest(rootPath, project, relativeTestPath) {
  return looksLikeCustomTestPath(relativeTestPath) || isManagedCustomTest(rootPath, project, relativeTestPath);
}

function isUserProgramStyleProject(project) {
  return project.key !== "threads";
}

function threadTestFunctionName(relativeTestPath) {
  const normalized = relativeTestPath
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `test_${normalized || "custom"}`;
}

function appendBlockIfMissing(filePath, sentinel, blockText) {
  const existing = fs.readFileSync(filePath, "utf8");
  if (existing.includes(sentinel)) {
    return false;
  }

  const prefix = existing.endsWith("\n") ? existing : `${existing}\n`;
  const next = `${prefix}${blockText.trimEnd()}\n`;
  fs.writeFileSync(filePath, next, "utf8");
  return true;
}

function registerCustomTestInMakeTests(rootPath, project, relativeTestPath) {
  const makeTestsPath = customTestMakeTestsPath(rootPath, project);
  if (!fs.existsSync(makeTestsPath)) {
    throw new Error(`Could not find ${makeTestsPath}.`);
  }

  const lines = [CUSTOM_SCAFFOLD_MARKER_LINE, ...customTestRegistrationLines(project, relativeTestPath), ""];

  appendBlockIfMissing(
    makeTestsPath,
    customTestFullName(project, relativeTestPath),
    lines.join("\n")
  );
}

function validateCustomTestScaffoldTargets(rootPath, project, relativeTestPath) {
  const basePath = customTestAbsoluteBasePath(rootPath, project, relativeTestPath);
  const cFilePath = `${basePath}.c`;
  const ckFilePath = `${basePath}.ck`;
  const makeTestsPath = customTestMakeTestsPath(rootPath, project);

  if (fs.existsSync(cFilePath)) {
    throw new Error(`A test source file already exists at ${cFilePath}`);
  }
  if (isUserProgramStyleProject(project) && fs.existsSync(ckFilePath)) {
    throw new Error(`A checker file already exists at ${ckFilePath}`);
  }
  if (!fs.existsSync(makeTestsPath)) {
    throw new Error(`Could not find ${makeTestsPath}.`);
  }

  if (project.key === "threads") {
    const headerPath = path.join(rootPath, "tests", "threads", "tests.h");
    const sourcePath = path.join(rootPath, "tests", "threads", "tests.c");
    if (!fs.existsSync(headerPath)) {
      throw new Error(`Could not find ${headerPath}.`);
    }
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Could not find ${sourcePath}.`);
    }
  }
}

function escapeRegExpLiteral(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeExactLineIfPresent(filePath, lineText) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const pattern = new RegExp(`^${escapeRegExpLiteral(lineText)}\\r?\\n?`, "m");
  const text = fs.readFileSync(filePath, "utf8");
  if (!pattern.test(text)) {
    return false;
  }

  const next = text.replace(pattern, "").replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(filePath, next, "utf8");
  return true;
}

function removeCustomTestFromMakeTests(rootPath, project, relativeTestPath) {
  const makeTestsPath = customTestMakeTestsPath(rootPath, project);
  if (!fs.existsSync(makeTestsPath)) {
    return false;
  }

  const lines = customTestRegistrationLines(project, relativeTestPath);
  const blockLines = [CUSTOM_SCAFFOLD_MARKER_LINE, ...lines];
  const blockPattern = new RegExp(
    `(?:^|\\n)${blockLines.map(escapeRegExpLiteral).join("\\n")}\\n?`,
    "m"
  );

  let text = fs.readFileSync(makeTestsPath, "utf8");
  let changed = false;

  if (blockPattern.test(text)) {
    text = text.replace(blockPattern, (match, offset) => (offset === 0 ? "" : "\n"));
    changed = true;
  }

  for (const line of lines) {
    const pattern = new RegExp(`^${escapeRegExpLiteral(line)}\\r?\\n?`, "m");
    if (pattern.test(text)) {
      text = text.replace(pattern, "");
      changed = true;
    }
  }

  if (!changed) {
    return false;
  }

  fs.writeFileSync(makeTestsPath, text.replace(/\n{3,}/g, "\n\n"), "utf8");
  return true;
}

function unlinkIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

function pruneEmptyDirectories(startDir, stopDir) {
  const limit = path.resolve(stopDir);
  let current = path.resolve(startDir);

  while (current.startsWith(limit) && current !== limit) {
    if (!fs.existsSync(current)) {
      current = path.dirname(current);
      continue;
    }
    if (fs.readdirSync(current).length > 0) {
      break;
    }
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function removeThreadRegistration(rootPath, relativeTestPath, functionName) {
  const headerPath = path.join(rootPath, "tests", "threads", "tests.h");
  const sourcePath = path.join(rootPath, "tests", "threads", "tests.c");
  removeExactLineIfPresent(headerPath, `void ${functionName} (void);`);
  removeExactLineIfPresent(sourcePath, `    {"${relativeTestPath}", ${functionName}},`);
}

function deleteCustomTestDefinition(rootPath, project, relativeTestPath) {
  const basePath = customTestAbsoluteBasePath(rootPath, project, relativeTestPath);
  const cFilePath = `${basePath}.c`;
  const ckFilePath = `${basePath}.ck`;
  const pseudoTest = {
    full_name: customTestFullName(project, relativeTestPath),
    short_name: relativeTestPath
  };

  unlinkIfExists(cFilePath);
  if (isUserProgramStyleProject(project)) {
    unlinkIfExists(ckFilePath);
  } else {
    removeThreadRegistration(rootPath, relativeTestPath, threadTestFunctionName(relativeTestPath));
  }

  removeCustomTestFromMakeTests(rootPath, project, relativeTestPath);

  const artifactPaths = artifactPathsForTest(rootPath, project, pseudoTest);
  for (const kind of ARTIFACT_ORDER) {
    unlinkIfExists(artifactPaths[kind]);
  }

  pruneEmptyDirectories(path.dirname(basePath), customTestsProjectDir(rootPath, project));
}

async function confirmDelete(message, detail) {
  const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, "Delete");
  return choice === "Delete";
}

function ensureThreadPrototype(rootPath, functionName) {
  const headerPath = path.join(rootPath, "tests", "threads", "tests.h");
  if (!fs.existsSync(headerPath)) {
    throw new Error(`Could not find ${headerPath}.`);
  }

  const prototype = `void ${functionName} (void);`;
  const text = fs.readFileSync(headerPath, "utf8");
  if (text.includes(prototype)) {
    return;
  }

  const endifIndex = text.lastIndexOf("#endif");
  const insertion = `${prototype}\n`;
  const next =
    endifIndex >= 0
      ? `${text.slice(0, endifIndex)}${insertion}${text.slice(endifIndex)}`
      : `${text}${text.endsWith("\n") ? "" : "\n"}${insertion}`;
  fs.writeFileSync(headerPath, next, "utf8");
}

function ensureThreadRegistration(rootPath, relativeTestPath, functionName) {
  const sourcePath = path.join(rootPath, "tests", "threads", "tests.c");
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Could not find ${sourcePath}.`);
  }

  const text = fs.readFileSync(sourcePath, "utf8");
  const entryText = `{"${relativeTestPath}", ${functionName}}`;
  if (text.includes(entryText)) {
    return;
  }

  const arrayStart = text.indexOf("static const struct test tests[]");
  if (arrayStart < 0) {
    throw new Error(`Could not find the thread test registry in ${sourcePath}.`);
  }

  const arrayEnd = text.indexOf("};", arrayStart);
  if (arrayEnd < 0) {
    throw new Error(`Could not find the end of the thread test registry in ${sourcePath}.`);
  }

  const insertion = `    {"${relativeTestPath}", ${functionName}},\n`;
  const next = `${text.slice(0, arrayEnd)}${insertion}${text.slice(arrayEnd)}`;
  fs.writeFileSync(sourcePath, next, "utf8");
}

function renderThreadTestTemplate(project, relativeTestPath) {
  const functionName = threadTestFunctionName(relativeTestPath);
  return `/* TODO: describe this custom thread test. */

#include "tests/threads/tests.h"

void
${functionName} (void)
{
  pass ();
}
`;
}

function renderUserStyleCTestTemplate(project, relativeTestPath) {
  const label = testLeafName({ short_name: relativeTestPath });
  return `/* TODO: describe this custom ${project.key} test. */

#include "tests/lib.h"
#include "tests/main.h"

void
test_main (void)
{
  msg ("TODO: implement ${label}");
}
`;
}

function renderUserStyleCheckTemplate(project, relativeTestPath) {
  return `# -*- perl -*-
use strict;
use warnings;
use tests::tests;

# TODO: tighten this checker with check_expected(), check_archive(), etc.
pass;
`;
}

function writeNewFileOrThrow(filePath, contents) {
  if (fs.existsSync(filePath)) {
    throw new Error(`Refusing to overwrite an existing file: ${filePath}`);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

async function promptForProject(projectHint, placeHolder = "Choose a Pintos project") {
  if (projectHint) {
    return projectHint;
  }

  const picked = await vscode.window.showQuickPick(
    PROJECT_ORDER.map((key) => ({
      label: PROJECTS[key].label,
      description: key,
      project: PROJECTS[key]
    })),
    {
      placeHolder
    }
  );

  return picked?.project || null;
}

function customNodeTargetPath(node) {
  if (node?.nodeType === "test") {
    return node.test.short_name;
  }
  if (node?.nodeType === "group" && inferGroupKind(node.groupSegments) === "custom-test") {
    return groupPathKey(node.groupSegments);
  }
  return null;
}

async function createCustomGroupFile(node) {
  const project = await promptForProject(
    node?.project,
    "Choose a Pintos project for the custom folder rule"
  );
  if (!project) {
    return;
  }

  const suggestedPath = suggestedCustomGroupPath(node);
  const relativePath = await vscode.window.showInputBox({
    prompt: `File path inside ${path.join(CUSTOM_GROUPS_ROOT, project.key)}`,
    value: suggestedPath,
    validateInput: (value) => {
      const normalized = normalizeCustomGroupInput(value);
      if (!normalized) {
        return "Enter at least one folder or file name.";
      }
      if (normalized.split("/").includes("..")) {
        return "Parent directory segments are not allowed.";
      }
      return null;
    }
  });
  if (!relativePath) {
    return;
  }

  const normalized = normalizeCustomGroupInput(relativePath);
  const withoutExtension = normalized.replace(/\.json$/i, "");
  const targetPath = path.join(
    provider.rootPath,
    CUSTOM_GROUPS_ROOT,
    project.key,
    ...withoutExtension.split("/").filter(Boolean)
  );
  const filePath = `${targetPath}.json`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const created = !fs.existsSync(filePath);
  if (!fs.existsSync(filePath)) {
    const label = humanizeGroupKey(path.basename(withoutExtension));
    const template = {
      label,
      selectors: [customGroupPlaceholderSelector(project)]
    };
    fs.writeFileSync(filePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  }

  const document = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(document, { preview: false });
  if (!created) {
    vscode.window.showInformationMessage("Opened the existing custom folder rule file without changing it.");
  }
  provider.refresh();
}

async function createCustomTestCase(node) {
  const project = await promptForProject(
    node?.project,
    "Choose a Pintos project for the custom test case"
  );
  if (!project) {
    return;
  }

  const suggestedPath = suggestedCustomTestPath(node);
  const relativePath = await vscode.window.showInputBox({
    prompt: `Test path inside tests/${project.key}/ (no extension)`,
    value: suggestedPath,
    validateInput: validateManagedCustomPath
  });
  if (!relativePath) {
    return;
  }

  const normalized = normalizeCustomTestInput(relativePath);
  const payload = await runBundledCliJson(
    ["custom", "create", project.key, normalized, "--json"],
    {
      cwd: provider.rootPath,
      env: makeEnv(provider.rootPath)
    }
  );

  const primaryFilePath = Array.isArray(payload.files) ? payload.files.find((filePath) => filePath.endsWith(".c")) : null;
  if (!primaryFilePath) {
    throw new Error("The custom test was created, but no source file path was returned.");
  }

  const primaryDocument = await vscode.workspace.openTextDocument(primaryFilePath);
  await vscode.window.showTextDocument(primaryDocument, { preview: false });
  ensureTestBuildOutputDirectories(provider.rootPath, project, [
    { full_name: payload.full_name || customTestFullName(project, normalized) }
  ]);
  vscode.window.showInformationMessage(
    `Created custom test ${payload.full_name || customTestFullName(project, normalized)}.`
  );
  provider.refresh();
}

function customGroupRootDir(rootPath, project) {
  return path.join(rootPath, CUSTOM_GROUPS_ROOT, project.key);
}

function customGroupNodePathParts(node) {
  return Array.isArray(node?.groupSegments)
    ? node.groupSegments.map(customGroupSegmentPathPart).filter(Boolean)
    : [];
}

async function deleteCustomGroupNode(node) {
  if (!ENABLE_LEGACY_CUSTOM_GROUP_RULES) {
    vscode.window.showWarningMessage("Legacy custom folder rules are disabled in this version.");
    return;
  }
  if (node?.nodeType === "group" && inferGroupKind(node.groupSegments) === "custom-test") {
    await deleteCustomTestNode(node);
    return;
  }

  if (!groupNodeIsCustomRule(node)) {
    vscode.window.showWarningMessage("Select a custom folder rule to delete.");
    return;
  }

  const groupRootDir = customGroupRootDir(provider.rootPath, node.project);
  const relativeParts = customGroupNodePathParts(node);
  const relativeLabel = relativeParts.join("/");
  const jsonPath = path.join(groupRootDir, ...relativeParts) + ".json";
  const dirPath = path.join(groupRootDir, ...relativeParts);
  const targetPath = fs.existsSync(jsonPath) ? jsonPath : dirPath;

  if (!fs.existsSync(targetPath)) {
    vscode.window.showWarningMessage("That custom folder rule no longer exists on disk.");
    provider.refresh();
    return;
  }

  const confirmed = await confirmDelete(
    `Delete custom folder rule ${relativeLabel}?`,
    "This removes the saved tree grouping definition from .vscode/pintos-test-explorer/groups."
  );
  if (!confirmed) {
    return;
  }

  fs.rmSync(targetPath, { recursive: true, force: true });
  pruneEmptyDirectories(path.dirname(targetPath), groupRootDir);
  provider.refresh();
  vscode.window.showInformationMessage(`Deleted custom folder rule ${relativeLabel}.`);
}

async function deleteCustomTestNode(node) {
  const isCustomGroup = node?.nodeType === "group" && inferGroupKind(node.groupSegments) === "custom-test";
  const isCustomTest = node?.nodeType === "test" && node.isCustomTest;

  if (!isCustomGroup && !isCustomTest) {
    vscode.window.showWarningMessage("Select a custom test or custom test folder to delete.");
    return;
  }

  const testNodes = isCustomGroup ? await provider.getDescendantTestNodes(node) : [node];
  const blocked = testNodes.filter(
    (testNode) => !isDeletableCustomTest(provider.rootPath, testNode.project, testNode.test.short_name)
  );
  if (blocked.length) {
    const names = blocked.slice(0, 5).map((testNode) => testNode.test.short_name).join(", ");
    vscode.window.showErrorMessage(
      `Could not delete this folder because it includes non-custom tests: ${names}`
    );
    return;
  }

  const descriptor = isCustomGroup
    ? `${node.project.label} / ${groupPathLabel(node.groupSegments)}`
    : testNodes[0].test.short_name;
  const confirmed = await confirmDelete(
    isCustomGroup
      ? `Delete ${testNodes.length} custom test(s) in ${descriptor}?`
      : `Delete custom test ${descriptor}?`,
    "This removes the test files, unregisters them from Make.tests, and deletes their artifacts."
  );
  if (!confirmed) {
    return;
  }

  const targetPath = isCustomGroup ? customNodeTargetPath(node) : testNodes[0].test.short_name;
  await runBundledCliJson(
    ["custom", "delete", testNodes[0].project.key, targetPath, "--json"],
    {
      cwd: provider.rootPath,
      env: makeEnv(provider.rootPath)
    }
  );

  provider.clearCheckedNodes(testNodes);
  vscode.window.showInformationMessage(
    isCustomGroup
      ? `Deleted ${testNodes.length} custom test(s) from ${descriptor}.`
      : `Deleted custom test ${descriptor}.`
  );
}

async function renameCustomTestNode(node) {
  const currentPath = customNodeTargetPath(node);
  const project = node?.project;
  if (!currentPath || !project) {
    vscode.window.showWarningMessage("Select a custom test or custom test folder to rename.");
    return;
  }

  const newPath = await vscode.window.showInputBox({
    prompt: `New path inside tests/${project.key}/ (no extension)`,
    value: currentPath,
    validateInput: validateManagedCustomPath
  });
  if (!newPath) {
    return;
  }

  const normalized = normalizeCustomTestInput(newPath);
  const payload = await runBundledCliJson(
    ["custom", "rename", project.key, currentPath, normalized, "--json"],
    {
      cwd: provider.rootPath,
      env: makeEnv(provider.rootPath)
    }
  );

  const renamedTests = Array.isArray(payload.renamed_tests)
    ? payload.renamed_tests.map((entry) => ({
      full_name: customTestFullName(project, entry.to)
    }))
    : [{ full_name: customTestFullName(project, normalized) }];
  ensureTestBuildOutputDirectories(provider.rootPath, project, renamedTests);
  provider.refresh();
  const renamedCount = Array.isArray(payload.renamed_tests) ? payload.renamed_tests.length : 1;
  vscode.window.showInformationMessage(
    renamedCount > 1
      ? `Renamed ${renamedCount} custom tests into ${normalized}.`
      : `Renamed custom test to ${normalized}.`
  );
}

function registerCommand(context, name, fn) {
  context.subscriptions.push(vscode.commands.registerCommand(name, fn));
}

function syncSortModeState(context, sortMode) {
  const normalized = normalizeSortMode(sortMode);
  if (treeView) {
    treeView.description = sortModeLabel(normalized);
  }
  void context.workspaceState.update(SORT_MODE_STATE_KEY, normalized);
  void vscode.commands.executeCommand("setContext", SORT_MODE_STATE_KEY, normalized);
}

function registerPintosDebugConfigurationProvider(context) {
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider("cppdbg", {
      async resolveDebugConfigurationWithSubstitutedVariables(_folder, config) {
        if (!config?.pintosHelperSession) {
          return config;
        }

        config.pintosLaunchToken = createDebugLaunchToken();
        latestDebugLaunchToken = config.pintosLaunchToken;
        lastDebugPreparationErrorMessage = null;

        try {
          await prepareDebugServerForConfiguration(config);
          return config;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          lastDebugPreparationErrorMessage = message;
          appendOutput(`${message}\n`);
          outputChannel.show(true);
          vscode.window.showErrorMessage(`Debug start failed: ${message}`);
          return undefined;
        }
      }
    })
  );
}

function activate(context) {
  extensionInstallPath = context.extensionPath;
  const rootPath = getWorkspaceRoot();
  outputChannel = vscode.window.createOutputChannel("Pintos Tests");
  appendOutput("Pintos Test Explorer activating...\n");

  if (!rootPath) {
    outputChannel.appendLine("No Pintos project root could be discovered.");
    vscode.window.showWarningMessage(
      `Pintos Test Explorer: Could not find a Pintos project root. ${pintosRootSearchHelpText()}`
    );
    return;
  }

  outputChannel.appendLine(`Pintos root: ${rootPath}`);
  outputChannel.appendLine(`Extension path: ${extensionInstallPath}`);
  ensureCliRuntimeFiles(context);
  configureTerminalCli(context);
  const initialSortMode = normalizeSortMode(
    context.workspaceState.get(SORT_MODE_STATE_KEY)
  );
  provider = new PintosTreeProvider(rootPath, initialSortMode);
  treeView = vscode.window.createTreeView("pintosTests", {
    treeDataProvider: provider,
    // Keep multi-run behavior in a single place: the tree checkboxes.
    canSelectMany: false,
    manageCheckboxStateManually: true,
    showCollapseAll: false
  });
  syncSortModeState(context, initialSortMode);

  context.subscriptions.push(outputChannel, treeView);
  outputChannel.appendLine("Pintos Test Explorer activated.");
  registerPintosDebugConfigurationProvider(context);

  if (typeof treeView.onDidChangeCheckboxState === "function") {
    context.subscriptions.push(
      treeView.onDidChangeCheckboxState(async (event) => {
        for (const [node, state] of event.items) {
          await provider.setCheckedForNode(
            node,
            state === vscode.TreeItemCheckboxState.Checked
          );
        }
        provider.refresh();
      })
    );
  }

  const watchers = [
    vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(rootPath, "tests/**/Make.tests")
    )
  ];
  if (ENABLE_LEGACY_CUSTOM_GROUP_RULES) {
    watchers.unshift(
      vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(rootPath, `${CUSTOM_GROUPS_ROOT}/**/*.json`)
      )
    );
  }
  for (const watcher of watchers) {
    context.subscriptions.push(
      watcher,
      watcher.onDidCreate(() => provider.refresh()),
      watcher.onDidChange(() => provider.refresh()),
      watcher.onDidDelete(() => provider.refresh())
    );
  }

  registerCommand(context, "pintosTests.refresh", () => provider.refresh());
  registerCommand(context, "pintosTests.collapseAll", async () => {
    await vscode.commands.executeCommand(
      "workbench.actions.treeView.pintosTests.collapseAll"
    );
  });
  registerCommand(context, "pintosTests.toggleSortOrder", () => {
    const nextSortMode =
      provider.getSortMode() === SORT_MODE_RECENT
        ? SORT_MODE_NUMBER
        : SORT_MODE_RECENT;
    provider.setSortMode(nextSortMode);
    syncSortModeState(context, nextSortMode);
  });
  registerCommand(context, "pintosTests.clearChecked", async () => {
    await clearCheckedArtifacts();
  });
  registerCommand(context, "pintosTests.clearAll", async () => {
    await clearAllArtifacts();
  });
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
  registerCommand(context, "pintosTests.runGroup", async (groupNode) => {
    await runGroup(groupNode);
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
  registerCommand(context, "pintosTests.createCustomTestCase", async (node) => {
    try {
      await createCustomTestCase(node);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Could not create the custom test case: ${message}`);
    }
  });
  registerCommand(context, "pintosTests.renameCustomTest", async (node) => {
    try {
      await renameCustomTestNode(node);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Could not rename the custom test path: ${message}`);
    }
  });
  registerCommand(context, "pintosTests.installCliWrappers", async () => {
    try {
      const { binDir, profileFile } = installCliWrappers();
      vscode.window.showInformationMessage(
        [
          "Installed Pintos CLI wrappers.",
          `New shells will pick up ${binDir} from ${profileFile}.`,
          "In VS Code, open a new integrated terminal if `pt` is not visible yet."
        ].join(" ")
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`CLI install failed: ${message}`);
    }
  });
  registerCommand(context, "pintosTests.openArtifact", async (artifactNode) => {
    if (!artifactNode?.filePath) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(artifactNode.filePath);
    await vscode.window.showTextDocument(document, { preview: false });
  });
  registerCommand(context, "pintosTests.deleteCustomTest", async (node) => {
    try {
      await deleteCustomTestNode(node);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Could not delete the custom test: ${message}`);
    }
  });

  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(async (session) => {
      if (session?.configuration?.pintosHelperSession) {
        if (!latestDebugLaunchToken || session.configuration.pintosLaunchToken === latestDebugLaunchToken) {
          await stopDebugServer();
        }
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
