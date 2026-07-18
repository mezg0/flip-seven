/**
 * Transport-agnostic game rules live in this package.
 *
 * Keep React, Socket.IO, Effect runtime services, and persistence out of this
 * dependency so the game engine remains deterministic and easy to test.
 */
export type GameRevision = number
