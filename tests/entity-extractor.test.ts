import { extractEntities } from "../src/services/entity-extractor";

describe("entity-extractor", () => {
  describe("file path extraction", () => {
    it("extracts .ts file paths from read output", () => {
      const result = extractEntities("read", { filePath: "src/index.ts" }, "");
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: "src/index.ts", type: "file" }),
      );
    });

    it("extracts file paths from bash ls output", () => {
      const output = "src/main.ts\nsrc/utils/helper.ts\nREADME.md";
      const result = extractEntities("bash", {}, output);
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: "src/main.ts", type: "file" }),
      );
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: "src/utils/helper.ts", type: "file" }),
      );
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: "README.md", type: "file" }),
      );
    });

    it("extracts paths from grep -r output", () => {
      const output = "src/services/user.ts:10:  class UserService {}";
      const result = extractEntities("bash", {}, output);
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: "src/services/user.ts", type: "file" }),
      );
    });
  });

  describe("symbol extraction", () => {
    it("extracts function definitions", () => {
      const output = "function processData(input: string): void {";
      const result = extractEntities("bash", {}, output);
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: "processData", type: "function" }),
      );
    });

    it("extracts arrow function variables", () => {
      const output = "const handleClick = () => {";
      const result = extractEntities("bash", {}, output);
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: "handleClick", type: "function" }),
      );
    });

    it("extracts class definitions", () => {
      const output = "export class UserService {";
      const result = extractEntities("bash", {}, output);
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: "UserService", type: "class" }),
      );
    });

    it("extracts interface definitions", () => {
      const output = "interface Repository<T> {";
      const result = extractEntities("bash", {}, output);
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: "Repository", type: "interface" }),
      );
    });
  });

  describe("module extraction", () => {
    it("extracts ES module imports", () => {
      const output = "import { useState } from 'react';";
      const result = extractEntities("bash", {}, output);
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: "react", type: "module" }),
      );
    });
  });

  describe("empty and edge cases", () => {
    it("returns empty arrays for empty output", () => {
      const result = extractEntities("bash", {}, "");
      expect(result.entities).toHaveLength(0);
      expect(result.relations).toHaveLength(0);
    });

    it("returns empty arrays for very short output", () => {
      const result = extractEntities("bash", {}, "ok");
      expect(result.entities).toHaveLength(0);
    });

    it("returns empty arrays for unknown tools with no matches", () => {
      const result = extractEntities(
        "unknown_tool",
        {},
        "some text without patterns",
      );
      expect(result.entities).toHaveLength(0);
    });
  });

  describe("relation generation", () => {
    it("creates references between file and contained symbols", () => {
      const output = "function parseData() {}\nclass DataModel {}";
      const result = extractEntities(
        "read",
        { filePath: "src/model.ts" },
        output,
      );
      // Should extract the file entity
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: "src/model.ts", type: "file" }),
      );
      // Should extract symbols from output
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: "parseData", type: "function" }),
      );
      expect(result.entities).toContainEqual(
        expect.objectContaining({ name: "DataModel", type: "class" }),
      );
      // Should create file→symbol relations
      expect(result.relations.length).toBeGreaterThan(0);
      result.relations.forEach((rel) => {
        expect(rel.sourceName).toBe("src/model.ts");
        expect(rel.relationType).toBe("references");
      });
    });
  });
});
