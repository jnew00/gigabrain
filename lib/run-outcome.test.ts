import { describe, it, expect } from "vitest";
import { didWinRun, isRecordableRun, DUNGEON_ROOMS } from "./run-outcome";

describe("didWinRun", () => {
  it("counts a full clear as a win", () => {
    expect(didWinRun(12, DUNGEON_ROOMS)).toBe(true);
  });

  it("counts death as a loss however deep it got", () => {
    expect(didWinRun(0, 15)).toBe(false);
  });

  // The case the two old definitions disagreed on: the automation called this a
  // loss because it wasn't a full clear, the manual UI called it a win because
  // the player lived. It is a win — the loot is banked and the energy is spent.
  it("counts a ladder exit with health left as a win", () => {
    expect(didWinRun(8, 9)).toBe(true);
  });

  it("treats unknown health short of the last room as a loss", () => {
    expect(didWinRun(null, 9)).toBe(false);
    expect(didWinRun(undefined, 9)).toBe(false);
  });

  it("still credits a full clear when health is unknown", () => {
    expect(didWinRun(null, DUNGEON_ROOMS)).toBe(true);
  });
});

describe("isRecordableRun", () => {
  it("rejects the all-zero phantom that inRun flicker produces", () => {
    expect(isRecordableRun(0, 0)).toBe(false);
  });

  it("keeps a run that reached a room", () => {
    expect(isRecordableRun(3, 0)).toBe(true);
  });

  // Every real row has a player object behind it, so max HP is the signal that
  // survives even when the room counter hasn't ticked yet.
  it("keeps a run with a real player behind it", () => {
    expect(isRecordableRun(0, 34)).toBe(true);
  });
});
