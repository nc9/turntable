import { expect, test } from "bun:test";
import { openFilesLimit, stallLine } from "../src/loop-lag";

test("an on-time tick logs nothing; a stall logs its length and the fd count", () => {
  expect(stallLine(40, 120, 1024)).toBeUndefined();
  expect(stallLine(2500.4, 120, 1024)).toBe("event loop stalled 2500 ms (fds 120/1024)");
  expect(stallLine(1500, undefined, undefined)).toBe("event loop stalled 1500 ms (fds n/a)");
});

test("the soft open-files limit is read from /proc/self/limits text", () => {
  const text =
    "Limit                     Soft Limit           Hard Limit           Units     \n" +
    "Max open files            1024                 524288               files     \n";
  expect(openFilesLimit(text)).toBe(1024);
  expect(
    openFilesLimit("Max open files            unlimited            unlimited            files\n"),
  ).toBe(Number.POSITIVE_INFINITY);
  expect(openFilesLimit("nothing here")).toBeUndefined();
});
