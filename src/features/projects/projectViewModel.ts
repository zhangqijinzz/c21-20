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

function uniqueCopyTitle(document: WorkspaceDocument, title: string): string {
  const usedTitles = new Set(document.projects.map((project) => project.title));
  if (!usedTitles.has(title)) return title;
  for (let index = 2; ; index += 1) {
    const candidate = `${title} ${index}`;
    if (!usedTitles.has(candidate)) return candidate;
  }
}

function remapNode(
  source: RequestNode,
  idMap: Map<string, string>,
): RequestNode {
  const remapped: RequestNode = {
    ...structuredClone(source),
    id: idMap.get(source.id) ?? crypto.randomUUID(),
    dependencyIds: source.dependencyIds
      .map((id) => idMap.get(id))
      .filter((id): id is string => Boolean(id)),
  };
  const fallbackNodeId = source.fallbackNodeId
    ? idMap.get(source.fallbackNodeId)
    : undefined;
  if (fallbackNodeId) remapped.fallbackNodeId = fallbackNodeId;
  else delete remapped.fallbackNodeId;
  return remapped;
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
  // 同一份映射贯穿当前图和所有快照：快照里的节点会指向副本自己的节点，
  // 在副本中恢复任一快照都不会触及原项目，也不会凭空生成重复节点。
  const idMap = new Map<string, string>();
  const mapId = (id: string): string => {
    const existing = idMap.get(id);
    if (existing) return existing;
    const next = crypto.randomUUID();
    idMap.set(id, next);
    return next;
  };
  project.nodes.forEach((node) => mapId(node.id));
  project.scenarios.forEach((scenario) => {
    scenario.nodes.forEach((node) => mapId(node.id));
  });

  const nodes = project.nodes.map((node) => remapNode(node, idMap));
  const scenarios = project.scenarios.map((scenario) =>
    remapScenario(scenario, idMap),
  );
  const copy: LatencyProject = {
    ...structuredClone(project),
    id: `project-${crypto.randomUUID()}`,
    title: uniqueCopyTitle(document, `${project.title}${COPY_SUFFIX}`),
    nodes,
    scenarios,
    createdAt: now,
    updatedAt: now,
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
