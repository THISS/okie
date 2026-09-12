import assert from "node:assert/strict";
import test from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { IndexSchema } from "@scip-code/scip";
import { decodeScipIndex } from "./scip.js";

test("decodeScipIndex uses the generated SCIP binding for binary indexes", () => {
  const bytes = toBinary(IndexSchema, create(IndexSchema, {
    metadata: { projectRoot: "file:///repo", toolInfo: { name: "rust-analyzer", version: "1.87.0" } },
    documents: [{ relativePath: "src/lib.rs", language: "rust" }],
  }));
  const index = decodeScipIndex(bytes);
  assert.equal(index.metadata?.projectRoot, "file:///repo");
  assert.equal(index.metadata?.toolInfo?.name, "rust-analyzer");
  assert.equal(index.documents[0]?.relativePath, "src/lib.rs");
});
