/** Generates ULIDs for history entries; `time` anchors the ULID timestamp part. */
export interface IdGenerator {
  nextUlid(time: Date): string;
}
