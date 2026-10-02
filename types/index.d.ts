export type NoteMode = 'view' | 'edit'

/** The open session's note as the pane draws it. */
export type NoteDoc = { sessionId: string; text: string; updatedAt: number }

/** What `$.store` keeps under `note:<sessionId>`. */
export type StoredNote = { text: string; updatedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'notes-panel': { doc: NoteDoc; mode: NoteMode }
  }
}
