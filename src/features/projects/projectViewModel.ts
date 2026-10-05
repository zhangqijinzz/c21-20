import {
  createEmptyProject,
  type LatencyProject,
  type RequestNode,
  type ScenarioSnapshot,
  type WorkspaceDocument,
} from "../../shared/domain/types";

export function createProject(
  document: WorkspaceDocument,
  now = Date.now(),
): WorkspaceDocument {
  const project = createEmptyProject(now);
  return {
    ...document,
    activeProjectId: project.id,
    projects: [project, ...document.projects],
  };
}

export function selectProject(
  document: WorkspaceDocument,
  projectId: string,
): WorkspaceDocument {
  return document.projects.some((project) => project.id === projectId)
    ? { ...document, activeProjectId: projectId }
    : document;
}

export function renameProject(
  project: LatencyProject,
  title: string,
  now = Date.now(),
): LatencyProject {
  return { ...project, title: title.trim() || "未命名链路", updatedAt: now };
}

const COPY_SUFFIX = " · 副本";

function uniqueCopyTitle(
  sourceTitle: string,
  existingTitles: Set<string>,
): string {
  // 复制一个副本时先剥掉既有的“ · 副本 / · 副本 2”尾巴，避免名称层层堆叠。
  const baseTitle = sourceTitle.replace(/ · 副本(?: \d+)?$/, "");
  const candidate = `${baseTitle}${COPY_SUFFIX}`;
  if (!existingTitles.has(candidate)) return candidate;
  for (let suffix = 2; ; suffix += 1) {
    const numbered = `${candidate} ${suffix}`;
    if (!existingTitles.has(numbered)) return numbered;
  }
}

/**
 * 在副本内重新生成一份节点：节点 id 取自 idMap，依赖、降级目标和关键链路
 * 都重映射到副本自己的对象，保证恢复快照只会写入副本，且不会产生重复节点。
 */
function remapNode(
  source: RequestNode,
  idMap: Map<string, string>,
): RequestNode {
  return {
    ...structuredClone(source),
    id: idMap.get(source.id) ?? crypto.randomUUID(),
    dependencyIds: source.dependencyIds
      .map((id) => idMap.get(id))
      .filter((id): id is string => Boolean(id)),
    fallbackNodeId: source.fallbackNodeId
      ? (idMap.get(source.fallbackNodeId) ?? undefined)
      : undefined,
  };
}

function remapScenario(
  source: ScenarioSnapshot,
  idMap: Map<string, string>,
): ScenarioSnapshot {
  return {
    ...structuredClone(source),
    id: crypto.randomUUID(),
    nodes: source.nodes.map((node) => remapNode(node, idMap)),
    criticalPath: source.criticalPath
      .map((id) => idMap.get(id))
      .filter((id): id is string => Boolean(id)),
  };
}

export function duplicateProject(
  document: WorkspaceDocument,
  project: LatencyProject,
  now = Date.now(),
): WorkspaceDocument {
  // 当前图节点优先占用映射，快照中已被删除的历史节点再补一个新 id，
  // 让所有对象（含孤立的快照节点）都指向副本自己的身份。
  const idMap = new Map<string, string>();
  for (const node of project.nodes) {
    idMap.set(node.id, crypto.randomUUID());
  }
  for (const scenario of project.scenarios) {
    for (const node of scenario.nodes) {
      if (!idMap.has(node.id)) idMap.set(node.id, crypto.randomUUID());
    }
  }
  const clonedNodes = project.nodes.map((node) => remapNode(node, idMap));
  const clonedScenarios = project.scenarios.map((scenario) =>
    remapScenario(scenario, idMap),
  );
  const copy: LatencyProject = {
    ...structuredClone(project),
    id: `project-${crypto.randomUUID()}`,
    title: uniqueCopyTitle(
      project.title,
      new Set(document.projects.map((item) => item.title)),
    ),
    createdAt: now,
    updatedAt: now,
    nodes: clonedNodes,
    scenarios: clonedScenarios,
  };
  return {
    ...document,
    activeProjectId: copy.id,
    projects: [copy, ...document.projects],
  };
}

export function removeProject(
  document: WorkspaceDocument,
  projectId: string,
): WorkspaceDocument {
  const projects = document.projects.filter(
    (project) => project.id !== projectId,
  );
  return {
    ...document,
    projects,
    activeProjectId:
      document.activeProjectId === projectId
        ? (projects[0]?.id ?? "")
        : document.activeProjectId,
  };
}

export function updateProject(
  document: WorkspaceDocument,
  project: LatencyProject,
): WorkspaceDocument {
  return {
    ...document,
    projects: document.projects.map((item) =>
      item.id === project.id ? project : item,
    ),
  };
}
