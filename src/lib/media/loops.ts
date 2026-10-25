/**
 * REMOVED in R20 (owner directive): the built-in synth loops are
 * gone — the app adds no audio of its own. The only music in any
 * project is the user's own uploaded track. This module remains as
 * an empty tombstone because the snapshot push path cannot delete
 * files; nothing imports it, and loops.test.ts guards that it
 * stays empty.
 */
export {};
