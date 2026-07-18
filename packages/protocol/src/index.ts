import { Schema } from "effect"

export const ServerStatus = Schema.Struct({
  status: Schema.Literal("connecting", "ready", "disconnected"),
})

export type ServerStatus = typeof ServerStatus.Type

export interface ClientToServerEvents {
  "system:status": (acknowledge: (status: ServerStatus) => void) => void
}

export interface ServerToClientEvents {}
