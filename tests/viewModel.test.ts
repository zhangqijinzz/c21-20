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
import { simulateProject } from "../src/shared/domain/simulation";
import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type RequestNode,
  type WorkspaceDocument,
} from "../src/shared/domain/types";

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
    const initial = {
      version: 1 as const,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [EXAMPLE_PROJECT],
    };
    const duplicated = duplicateProject(initial, EXAMPLE_PROJECT, 10);
    const copy = duplicated.projects[0];
    expect(copy?.nodes[2]?.dependencyIds).toEqual([copy?.nodes[0]?.id]);
    expect(copy?.nodes[4]?.fallbackNodeId).toBe(copy?.nodes[3]?.id);
    expect(copy?.id).not.toBe(EXAMPLE_PROJECT.id);
    expect(copy?.scenarios).toEqual([]);
  });

  it("inherits snapshots and remaps every node identity to the copy", () => {
    const saved = saveScenario(
      EXAMPLE_PROJECT,
      simulateProject(EXAMPLE_PROJECT),
      "基线方案",
    );
    const initial: WorkspaceDocument = {
      version: 1,
      activeProjectId: saved.id,
      projects: [saved],
    };
    const duplicated = duplicateProject(initial, saved, 20);
    const copy = duplicated.projects[0];
    if (!copy) throw new Error("copy should exist");

    expect(copy.scenarios).toHaveLength(1);
    const copiedSnapshot = copy.scenarios[0];
    if (!copiedSnapshot) throw new Error("snapshot should be inherited");
    // 快照是一份新身份，不与原项目共享 id 或对象。
    expect(copiedSnapshot.id).not.toBe(saved.scenarios[0]?.id);
    expect(copiedSnapshot).not.toBe(saved.scenarios[0]);
    expect(copiedSnapshot.nodes[0]).not.toBe(saved.scenarios[0]?.nodes[0]);
    expect(copy.nodes[0]).not.toBe(saved.nodes[0]);

    const liveIds = new Set(copy.nodes.map((node) => node.id));
    for (const node of copiedSnapshot.nodes) {
      expect(liveIds.has(node.id)).toBe(true);
      expect(saved.nodes.some((source) => source.id === node.id)).toBe(false);
      for (const dependencyId of node.dependencyIds) {
        expect(liveIds.has(dependencyId)).toBe(true);
      }
      if (node.fallbackNodeId)
        expect(liveIds.has(node.fallbackNodeId)).toBe(true);
    }
    // 关键链路同样指向副本自己的节点。
    for (const id of copiedSnapshot.criticalPath)
      expect(liveIds.has(id)).toBe(true);
    expect(copiedSnapshot.criticalPath).toHaveLength(
      saved.scenarios[0]?.criticalPath.length ?? 0,
    );
    // 预算等推演结论原样继承。
    expect(copiedSnapshot.completionMs).toBe(saved.scenarios[0]?.completionMs);
    expect(copiedSnapshot.concurrencyLimit).toBe(
      saved.scenarios[0]?.concurrencyLimit,
    );
    expect(copiedSnapshot.name).toBe("基线方案");
  });

  it("restoring an inherited snapshot only changes the copy", () => {
    const saved = saveScenario(
      EXAMPLE_PROJECT,
      simulateProject(EXAMPLE_PROJECT),
      "基线方案",
    );
    const initial: WorkspaceDocument = {
      version: 1,
      activeProjectId: saved.id,
      projects: [saved],
    };
    const copy = duplicateProject(initial, saved, 30).projects[0];
    if (!copy) throw new Error("copy should exist");
    const snapshotId = copy.scenarios[0]?.id ?? "";
    const edited: LatencyProject = {
      ...copy,
      nodes: copy.nodes.map((node) => ({ ...node, durationMs: 1 })),
    };
    const restored = restoreScenario(edited, snapshotId);

    expect(restored.nodes).toHaveLength(copy.nodes.length);
    expect(new Set(restored.nodes.map((node) => node.id))).toEqual(
      new Set(copy.nodes.map((node) => node.id)),
    );
    expect(restored.nodes[0]?.durationMs).toBe(
      copy.scenarios[0]?.nodes[0]?.durationMs,
    );
    // 原项目完全不受影响。
    expect(saved.nodes[0]?.durationMs).toBe(
      EXAMPLE_PROJECT.nodes[0]?.durationMs,
    );
    expect(
      restored.nodes.some((node) =>
        saved.nodes.some((source) => source.id === node.id),
      ),
    ).toBe(false);
    // 恢复后的图在副本里可直接推演，没有悬空依赖或降级目标。
    const resimulated = simulateProject(restored);
    expect(resimulated.entries).toHaveLength(restored.nodes.length);
    expect(
      resimulated.warnings.some((warning) => warning.includes("不存在")),
    ).toBe(false);
  });

  it("remaps nodes that only existed inside an old snapshot without duplicating ids", () => {
    const removedNode: RequestNode = {
      ...EXAMPLE_PROJECT.nodes[1]!,
      id: "removed-flags",
      dependencyIds: [],
      fallbackNodeId: undefined,
    };
    const snapshotNodes = [removedNode, ...EXAMPLE_PROJECT.nodes].filter(
      (node, index, all) =>
        all.findIndex((item) => item.id === node.id) === index,
    );
    const projectWithHistory: LatencyProject = {
      ...structuredClone(EXAMPLE_PROJECT),
      // 当前图里已经删掉了 removed-flags，但快照里还保留着它。
      nodes: structuredClone(EXAMPLE_PROJECT.nodes),
      scenarios: [
        {
          id: "old-snapshot",
          name: "历史方案",
          createdAt: 5,
          concurrencyLimit: 2,
          nodes: structuredClone(snapshotNodes),
          completionMs: 1234,
          criticalPath: ["removed-flags", "session"],
        },
      ],
    };
    const initial: WorkspaceDocument = {
      version: 1,
      activeProjectId: projectWithHistory.id,
      projects: [projectWithHistory],
    };
    const copy = duplicateProject(initial, projectWithHistory, 40).projects[0];
    if (!copy) throw new Error("copy should exist");
    const copiedSnapshot = copy.scenarios[0];
    if (!copiedSnapshot) throw new Error("snapshot should be inherited");

    const restoredOrphan = copiedSnapshot.nodes.find(
      (node) => node.name === removedNode.name && node.id === "removed-flags",
    );
    expect(restoredOrphan).toBeUndefined();
    const orphanCopy = copiedSnapshot.nodes.find(
      (node) => node.id !== "removed-flags" && node.name === removedNode.name,
    );
    expect(orphanCopy).toBeDefined();
    expect(orphanCopy?.id).not.toBe("removed-flags");
    // 恢复含孤立节点的快照后，节点 id 仍然全局唯一，没有重复节点。
    const restored = restoreScenario(copy, copiedSnapshot.id);
    const ids = restored.nodes.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(restored.nodes.some((node) => node.id === "removed-flags")).toBe(
      false,
    );
  });

  it("picks stable titles when duplicate copies collide with existing projects", () => {
    const source: LatencyProject = {
      ...structuredClone(EXAMPLE_PROJECT),
      title: "预算实验",
      id: "source-id",
    };
    let document: WorkspaceDocument = {
      version: 1,
      activeProjectId: source.id,
      projects: [source],
    };
    document = duplicateProject(document, source, 1);
    expect(document.projects[0]?.title).toBe("预算实验 · 副本");
    document = duplicateProject(document, source, 2);
    expect(document.projects[0]?.title).toBe("预算实验 · 副本 2");
    // 从一个副本继续复制，基准名也要继续避让，而不是叠床架屋。
    const firstCopy = document.projects.find(
      (project) => project.title === "预算实验 · 副本",
    );
    if (!firstCopy) throw new Error("first copy should exist");
    document = duplicateProject(document, firstCopy, 3);
    expect(document.projects[0]?.title).toBe("预算实验 · 副本 3");
    const titles = document.projects.map((project) => project.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("keeps same-named snapshots distinguishable by fresh snapshot ids", () => {
    let project: LatencyProject = {
      ...structuredClone(EXAMPLE_PROJECT),
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 2),
      scenarios: [],
    };
    project = saveScenario(project, simulateProject(project), "同名方案");
    const serialProject: LatencyProject = { ...project, concurrencyLimit: 1 };
    project = saveScenario(
      serialProject,
      simulateProject(serialProject),
      "同名方案",
    );
    const initial: WorkspaceDocument = {
      version: 1,
      activeProjectId: project.id,
      projects: [project],
    };
    const copy = duplicateProject(initial, project, 50).projects[0];
    if (!copy) throw new Error("copy should exist");
    expect(copy.scenarios.map((scenario) => scenario.name)).toEqual([
      "同名方案",
      "同名方案",
    ]);
    const snapshotIds = copy.scenarios.map((scenario) => scenario.id);
    expect(new Set(snapshotIds).size).toBe(2);
    // 再复制一次副本，快照 id 再次全部换新，不与既有副本撞 id。
    const secondDocument: WorkspaceDocument = {
      version: 1,
      activeProjectId: copy.id,
      projects: [copy, project],
    };
    const secondCopy = duplicateProject(secondDocument, copy, 60).projects[0];
    if (!secondCopy) throw new Error("second copy should exist");
    for (const scenario of secondCopy.scenarios) {
      expect(snapshotIds).not.toContain(scenario.id);
    }
    const allNodeIds = [
      ...secondCopy.nodes.map((node) => node.id),
      ...secondCopy.scenarios.flatMap((scenario) =>
        scenario.nodes.map((node) => node.id),
      ),
    ];
    // 同一逻辑节点在图与各快照间共享同一个新 id，但不与其他项目重复。
    expect(new Set(allNodeIds).size).toBe(secondCopy.nodes.length);
    // 两份同名快照在副本里仍能逐节点对比，并发差异不丢失。
    const comparison = compareScenarios(
      secondCopy.scenarios[1]!,
      secondCopy.scenarios[0]!,
    );
    expect(comparison.changes.join(" ")).toContain("并发上限");
  });

  it("duplicates deterministically while an earlier save is still in flight", () => {
    const saved = saveScenario(
      EXAMPLE_PROJECT,
      simulateProject(EXAMPLE_PROJECT),
      "基线方案",
    );
    let document: WorkspaceDocument = {
      version: 1,
      activeProjectId: saved.id,
      projects: [saved],
    };
    // 模拟“保存中”：基于同一份已提交状态连续派生两个副本，
    // 两个结果都必须自洽，后到的保存覆盖先到的也不丢快照。
    const first = duplicateProject(document, saved, 1);
    document = first;
    const activeAfterFirst =
      first.projects.find((project) => project.id === first.activeProjectId) ??
      first.projects[0];
    if (!activeAfterFirst) throw new Error("active project should exist");
    const second = duplicateProject(first, activeAfterFirst, 2);

    for (const next of [first, second]) {
      const active =
        next.projects.find((project) => project.id === next.activeProjectId) ??
        next.projects[0];
      if (!active) throw new Error("active project should exist");
      expect(active.scenarios.length).toBeGreaterThan(0);
      for (const scenario of active.scenarios) {
        const liveIds = new Set(active.nodes.map((node) => node.id));
        for (const node of scenario.nodes) {
          expect(node.id).not.toBe(saved.scenarios[0]?.nodes[0]?.id);
          expect(saved.nodes.some((source) => source.id === node.id)).toBe(
            false,
          );
          for (const dependencyId of node.dependencyIds) {
            expect(liveIds.has(dependencyId)).toBe(true);
          }
        }
      }
    }
    const projectIds = second.projects.map((project) => project.id);
    expect(new Set(projectIds).size).toBe(projectIds.length);
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
