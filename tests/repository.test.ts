import { beforeEach, describe, expect, it } from "vitest";
import { ProjectRepository } from "../src/shared/repositories/projectRepository";
import {
  EXAMPLE_PROJECT,
  type WorkspaceDocument,
} from "../src/shared/domain/types";

class MemoryStorage {
  value: unknown = undefined;
  failWrite = false;
  async read(): Promise<unknown> {
    return this.value;
  }
  async write(value: WorkspaceDocument): Promise<void> {
    if (this.failWrite) throw new Error("simulated IndexedDB quota failure");
    this.value = structuredClone(value);
  }
}

describe("project repository recovery", () => {
  beforeEach(() => localStorage.clear());

  it("provides a usable example when both stores are empty or damaged", async () => {
    const storage = new MemoryStorage();
    storage.value = { version: 99, projects: "broken" };
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.recovered).toBe(true);
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.document.projects[0]?.nodes.length).toBeGreaterThan(0);
  });

  it("restores the local recovery copy when IndexedDB data is malformed", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const document: WorkspaceDocument = {
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [structuredClone(EXAMPLE_PROJECT)],
    };
    await repository.save(document);
    storage.value = { version: 1, projects: [{ id: 5, nodes: [] }] };
    const loaded = await repository.load();
    expect(loaded.recovered).toBe(true);
    expect(loaded.document.projects[0]?.nodes).toHaveLength(
      EXAMPLE_PROJECT.nodes.length,
    );
  });

  it("keeps readable projects while dropping malformed project rows and broken edges", async () => {
    const storage = new MemoryStorage();
    storage.value = {
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [
        {
          ...EXAMPLE_PROJECT,
          nodes: [
            { ...EXAMPLE_PROJECT.nodes[0], dependencyIds: ["missing"] },
            { damaged: true },
          ],
        },
        { id: 9, title: null },
      ],
    };
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.document.projects).toHaveLength(1);
    expect(loaded.document.projects[0]?.nodes).toHaveLength(1);
    expect(loaded.document.projects[0]?.nodes[0]?.dependencyIds).toEqual([]);
    expect(loaded.recovered).toBe(true);
  });

  it("still opens older copies that were saved without scenario snapshots", async () => {
    const storage = new MemoryStorage();
    const legacyCopy = {
      ...structuredClone(EXAMPLE_PROJECT),
      id: "project-legacy-copy",
      title: `${EXAMPLE_PROJECT.title} · 副本`,
      // 旧版本复制出来的项目：快照字段为空数组，节点 id 已重新生成。
      scenarios: [],
      nodes: EXAMPLE_PROJECT.nodes.map((node, index) => ({
        ...node,
        id: `legacy-node-${index}`,
        dependencyIds: node.dependencyIds.map(
          (id) =>
            `legacy-node-${EXAMPLE_PROJECT.nodes.findIndex(
              (item) => item.id === id,
            )}`,
        ),
        fallbackNodeId: node.fallbackNodeId
          ? `legacy-node-${EXAMPLE_PROJECT.nodes.findIndex(
              (item) => item.id === node.fallbackNodeId,
            )}`
          : undefined,
      })),
    };
    storage.value = {
      version: 1,
      activeProjectId: legacyCopy.id,
      projects: [legacyCopy],
    };
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.recovered).toBe(false);
    const project = loaded.document.projects[0];
    expect(project?.scenarios).toEqual([]);
    expect(project?.nodes).toHaveLength(EXAMPLE_PROJECT.nodes.length);
    // 旧副本的依赖与降级连线仍然闭合，可以继续编辑与推演。
    const ids = new Set(project?.nodes.map((node) => node.id));
    expect(
      project?.nodes.every((node) =>
        node.dependencyIds.every((id) => ids.has(id)),
      ),
    ).toBe(true);
    expect(
      project?.nodes.every(
        (node) => !node.fallbackNodeId || ids.has(node.fallbackNodeId),
      ),
    ).toBe(true);
  });

  it("recovers when a stored project is missing the scenarios field entirely", async () => {
    const storage = new MemoryStorage();
    storage.value = {
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [{ ...structuredClone(EXAMPLE_PROJECT), scenarios: undefined }],
    };
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.document.projects[0]?.scenarios).toEqual([]);
  });
});
