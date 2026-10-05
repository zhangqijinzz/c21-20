import { describe, expect, it } from "vitest";
import {
  createProject,
  duplicateProject,
  selectProject,
} from "../src/features/projects/projectViewModel";
import {
  compareScenarios,
  restoreScenario,
  saveScenario,
} from "../src/features/scenarios/scenarioViewModel";
import { removeRequestNode } from "../src/features/graph-editor/graphViewModel";
import { simulateProject } from "../src/shared/domain/simulation";
import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type WorkspaceDocument,
} from "../src/shared/domain/types";

function workspaceOf(project: LatencyProject): WorkspaceDocument {
  return {
    version: 1,
    activeProjectId: project.id,
    projects: [project],
  };
}

describe("project and scenario view models", () => {
  it("creates a project and switches the active project", () => {
    const initial = {
      version: 1 as const,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [EXAMPLE_PROJECT],
    };
    const created = createProject(initial, 100);
    expect(created.projects).toHaveLength(2);
    expect(created.activeProjectId).not.toBe(EXAMPLE_PROJECT.id);
    expect(selectProject(created, EXAMPLE_PROJECT.id).activeProjectId).toBe(
      EXAMPLE_PROJECT.id,
    );
  });

  it("duplicates a project and remaps its dependency identities", () => {
    const initial = workspaceOf(EXAMPLE_PROJECT);
    const duplicated = duplicateProject(initial, EXAMPLE_PROJECT, 10);
    const copy = duplicated.projects[0];
    if (!copy) throw new Error("副本应当被创建");
    expect(copy.nodes[2]?.dependencyIds).toEqual([copy.nodes[0]?.id]);
    expect(copy.nodes[4]?.fallbackNodeId).toBe(copy.nodes[3]?.id);
    expect(copy.id).not.toBe(EXAMPLE_PROJECT.id);
    expect(duplicated.activeProjectId).toBe(copy.id);
  });

  it("inherits scenario snapshots and remaps snapshot nodes onto the copy", () => {
    const result = simulateProject(EXAMPLE_PROJECT);
    const withSnapshot = saveScenario(EXAMPLE_PROJECT, result, "基线方案");
    const initial = workspaceOf(withSnapshot);
    const duplicated = duplicateProject(initial, withSnapshot, 20);
    const copy = duplicated.projects[0];
    const source = duplicated.projects[1];
    if (!copy || !source) throw new Error("副本与原项目都应存在");

    expect(copy.scenarios).toHaveLength(1);
    const copiedSnapshot = copy.scenarios[0];
    if (!copiedSnapshot) throw new Error("副本应继承方案快照");
    // 快照本身是新对象，保留名称等内容，但拥有新的快照 id。
    expect(copiedSnapshot.id).not.toBe(source.scenarios[0]?.id);
    expect(copiedSnapshot.name).toBe("基线方案");
    expect(copiedSnapshot.completionMs).toBe(source.scenarios[0]?.completionMs);

    // 快照中的节点 id 与副本当前图一一对应，绝不残留原项目 id。
    const liveIds = new Set(copy.nodes.map((node) => node.id));
    for (const node of copiedSnapshot.nodes) {
      expect(liveIds.has(node.id)).toBe(true);
      expect(source.nodes.some((item) => item.id === node.id)).toBe(false);
    }
    expect(copy.nodes.length).toBe(copiedSnapshot.nodes.length);
    // 关键路径同样重新映射到副本自己的节点。
    expect(copiedSnapshot.criticalPath.every((id) => liveIds.has(id))).toBe(
      true,
    );
    // 快照里的依赖与降级目标也只在副本节点集合内闭合。
    const snapshotNode = copiedSnapshot.nodes.find(
      (node) => node.name === "个性推荐",
    );
    const liveRecommend = copy.nodes.find((node) => node.name === "个性推荐");
    expect(snapshotNode?.fallbackNodeId).toBe(liveRecommend?.fallbackNodeId);
    expect(snapshotNode?.dependencyIds.every((id) => liveIds.has(id))).toBe(
      true,
    );
  });

  it("restoring an inherited snapshot changes only the copy, not the original", () => {
    const result = simulateProject(EXAMPLE_PROJECT);
    const withSnapshot = saveScenario(EXAMPLE_PROJECT, result, "历史方案");
    const duplicated = duplicateProject(
      workspaceOf(withSnapshot),
      withSnapshot,
      30,
    );
    const copy = duplicated.projects[0];
    const source = duplicated.projects[1];
    if (!copy || !source) throw new Error("副本与原项目都应存在");
    const sourceNodeIdsBefore = source.nodes.map((node) => node.id);
    const snapshotId = copy.scenarios[0]?.id ?? "";

    // 先把副本当前图改乱，再恢复继承来的快照。
    const edited = {
      ...copy,
      nodes: copy.nodes.map((node, index) =>
        index === 0 ? { ...node, durationMs: 1 } : node,
      ),
    };
    const restored = restoreScenario(edited, snapshotId);
    expect(restored.nodes[0]?.durationMs).not.toBe(1);
    expect(restored.nodes.map((node) => node.id)).toEqual(
      copy.nodes.map((node) => node.id),
    );
    // 恢复不会凭空多出节点，也不会影响原项目。
    expect(restored.nodes).toHaveLength(copy.nodes.length);
    expect(source.nodes.map((node) => node.id)).toEqual(sourceNodeIdsBefore);
    expect(source.nodes).not.toContain(restored.nodes[0]);
  });

  it("remaps nodes that only exist inside older snapshots", () => {
    const result = simulateProject(EXAMPLE_PROJECT);
    let withSnapshot = saveScenario(EXAMPLE_PROJECT, result, "旧方案");
    // 删除当前图里的一个节点，但它仍被历史快照保留。
    const removedId = withSnapshot.nodes[0]?.id ?? "";
    withSnapshot = removeRequestNode(withSnapshot, removedId);
    expect(
      withSnapshot.scenarios[0]?.nodes.some((node) => node.id === removedId),
    ).toBe(true);

    const duplicated = duplicateProject(
      workspaceOf(withSnapshot),
      withSnapshot,
      40,
    );
    const copy = duplicated.projects[0];
    const source = duplicated.projects[1];
    if (!copy || !source) throw new Error("副本与原项目都应存在");
    const historicalNode = copy.scenarios[0]?.nodes.find(
      (node) => node.name === "会话校验",
    );
    expect(historicalNode).toBeDefined();
    expect(historicalNode?.id).not.toBe(removedId);
    expect(copy.nodes.some((node) => node.id === historicalNode?.id)).toBe(
      false,
    );
    expect(
      source.scenarios[0]?.nodes.some((node) => node.id === historicalNode?.id),
    ).toBe(false);
    // 恢复这份只存在于快照里的历史图，节点数与快照一致，无重复、无悬空 id。
    const copiedSnapshot = copy.scenarios[0];
    if (!copiedSnapshot) throw new Error("副本应继承历史快照");
    const restored = restoreScenario(copy, copiedSnapshot.id);
    expect(restored.nodes).toHaveLength(copiedSnapshot.nodes.length);
    const ids = new Set(restored.nodes.map((node) => node.id));
    expect(ids.size).toBe(restored.nodes.length);
    expect(
      restored.nodes.every((node) =>
        node.dependencyIds.every((id) => ids.has(id)),
      ),
    ).toBe(true);
  });

  it("picks a stable unique title when project names collide", () => {
    const base = structuredClone(EXAMPLE_PROJECT);
    const first = duplicateProject(workspaceOf(base), base, 1);
    expect(first.projects[0]?.title).toBe(`${base.title} · 副本`);
    // 对同一源项目反复复制，结果稳定：继续递增而不是重名或报错。
    const secondAgain = duplicateProject(first, base, 2);
    expect(secondAgain.projects[0]?.title).toBe(`${base.title} · 副本 2`);
    const thirdAgain = duplicateProject(secondAgain, base, 3);
    expect(thirdAgain.projects[0]?.title).toBe(`${base.title} · 副本 3`);
    const titles = thirdAgain.projects.map((project) => project.title);
    expect(new Set(titles).size).toBe(titles.length);

    // 复制副本本身时沿用“副本再复制”的命名，冲突时同样递增。
    const copyOfCopy = duplicateProject(
      thirdAgain,
      thirdAgain.projects.find((project) => project.title.endsWith("副本 3"))!,
      4,
    );
    expect(copyOfCopy.projects[0]?.title).toBe(`${base.title} · 副本 3 · 副本`);

    // 手动占用默认副本名时，复制会跳过冲突名称。
    const clash: LatencyProject = {
      ...structuredClone(base),
      id: "project-other",
      title: `${base.title} · 副本`,
    };
    const clashDoc: WorkspaceDocument = {
      version: 1,
      activeProjectId: base.id,
      projects: [base, clash],
    };
    const duplicated = duplicateProject(clashDoc, base, 4);
    expect(duplicated.projects[0]?.title).toBe(`${base.title} · 副本 2`);
  });

  it("keeps duplicated snapshots distinguishable while preserving names", () => {
    const result = simulateProject(EXAMPLE_PROJECT);
    const withSnapshot = saveScenario(EXAMPLE_PROJECT, result, "同名方案");
    const duplicated = duplicateProject(
      workspaceOf(withSnapshot),
      withSnapshot,
      50,
    );
    const copy = duplicated.projects[0];
    if (!copy) throw new Error("副本应当被创建");
    expect(copy.scenarios[0]?.name).toBe("同名方案");
    // 再复制一次副本：两份快照名称相同，但 id 全局不冲突。
    const nested = duplicateProject(workspaceOf(copy), copy, 51);
    const nestedCopy = nested.projects[0];
    if (!nestedCopy) throw new Error("二级副本应当被创建");
    expect(nestedCopy.scenarios[0]?.name).toBe("同名方案");
    expect(nestedCopy.scenarios[0]?.id).not.toBe(copy.scenarios[0]?.id);
  });

  it("saves a complete snapshot and restores its parameters", () => {
    const baseline = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 2),
    };
    const result = simulateProject(baseline);
    const saved = saveScenario(baseline, result, "并发方案");
    expect(saved.scenarios).toHaveLength(1);
    const changed = {
      ...saved,
      nodes: saved.nodes.map((node) => ({ ...node, durationMs: 999 })),
    };
    const restored = restoreScenario(changed, saved.scenarios[0]?.id ?? "");
    expect(restored.nodes[0]?.durationMs).toBe(baseline.nodes[0]?.durationMs);
  });

  it("describes node and concurrency differences between snapshots", () => {
    const baseline = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 2),
    };
    const baselineSnapshot = saveScenario(
      baseline,
      simulateProject(baseline),
      "不限并发",
    ).scenarios[0];
    const changed = {
      ...baseline,
      concurrencyLimit: 1,
      nodes: baseline.nodes.map((node, index) =>
        index === 0 ? { ...node, durationMs: 900 } : node,
      ),
    };
    const changedSnapshot = saveScenario(
      changed,
      simulateProject(changed),
      "串行优化",
    ).scenarios[0];
    if (!baselineSnapshot || !changedSnapshot)
      throw new Error("Scenario fixtures should be saved");
    const comparison = compareScenarios(baselineSnapshot, changedSnapshot);
    expect(comparison.deltaMs).toBeGreaterThan(0);
    expect(comparison.changes.join(" ")).toContain("并发上限");
    expect(comparison.changes.join(" ")).toContain("耗时");
  });
});
