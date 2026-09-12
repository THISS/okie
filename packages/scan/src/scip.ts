import { fromBinary } from "@bufbuild/protobuf";
import { IndexSchema, type Index } from "@scip-code/scip";

/** Decode a binary SCIP index with the official generated protocol binding. */
export function decodeScipIndex(bytes: Uint8Array): Index {
  return fromBinary(IndexSchema, bytes);
}
