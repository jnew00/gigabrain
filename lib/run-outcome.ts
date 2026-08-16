// One definition of what winning a dungeon run means, shared by every place
// that files a run to history.
//
// There used to be two. The automation called a run won only at a full clear
// (`finalRoom >= 16`), while the manual UI called it won whenever the player
// finished alive. Every row recorded so far ends at 0 HP, so the two agreed by
// accident — but they disagree the moment a run ends alive short of the last
// room, which is exactly what taking the ladder does. Two record paths
// disagreeing about the same run is the kind of thing that only shows up once
// the history is being used for advice.

/** 4 floors, 4 rooms each — a full clear (GAME_SYSTEMS.md, Combat / Dungeons). */
export const DUNGEON_ROOMS = 16;

/**
 * Did the player walk out of this run alive?
 *
 * Death is the only loss. Clearing the last room wins, and so does banking
 * progress via the ladder with health left — that run kept its loot and cost
 * the same energy, so counting it as a defeat would understate the dungeon.
 *
 * `finalHp` is nullable because the run object is sometimes already gone by the
 * time the outcome is read. Room count is checked first so a full clear still
 * registers when health is unknown; an unknown health short of the last room is
 * treated as a loss, which matches how those runs actually end.
 */
export function didWinRun(
  finalHp: number | null | undefined,
  roomsCleared: number
): boolean {
  if (roomsCleared >= DUNGEON_ROOMS) return true;
  return finalHp != null && finalHp > 0;
}

/**
 * Is there enough of a run here to be worth filing?
 *
 * `inRun` can flicker true against a stale dungeon state and clear before any
 * room or player data arrives. Filing that wrote an all-zero row named
 * "Unknown" — 166 of them accumulated, roughly one per app load, and every stat
 * reading the table counted each one as a defeat. A run that left no trace is
 * not a defeat, it is an absence.
 *
 * The test is the run's own data, deliberately not its name: the name is held
 * in a ref that survives the run that set it, so after one real run a flicker
 * would inherit "Forbidden Woods" and file a phantom under a real dungeon. Any
 * genuine run has a player object behind it, and every one of the 755 real rows
 * recorded so far carries a non-zero max HP.
 */
export function isRecordableRun(roomsCleared: number, maxHp: number): boolean {
  return roomsCleared > 0 || maxHp > 0;
}
