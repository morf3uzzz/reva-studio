import type { TypingRange } from "../src/types.ts";
export interface TypingActivitySample { time: number; count: number }
export function deriveTypingRanges(samples: readonly TypingActivitySample[]): TypingRange[];
