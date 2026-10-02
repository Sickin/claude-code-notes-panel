import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NoteDoc, NoteMode, StoredNote } from '../types'
import {
  appendLine,
  clip,
  deleteLine,
  insertLineAfter,
  linesOf,
  parseCommand,
  replaceLine,
  segmentsOf,
  toggleTask,
} from './note'

const PANE = 'notes'
const TITLE = 'Notes'
const KEY_PREFIX = 'note:'
const SAVE_DELAY_MS = 800
const DAY_MS = 86_400_000

const EMPTY: NoteDoc = { sessionId: '', text: '', updatedAt: 0 }
const doc = atom({ plugin: 'notes-panel', key: 'doc' } as const, EMPTY)
const mode = atom({ plugin: 'notes-panel', key: 'mode' } as const, 'view' as NoteMode)

type $ = EngineInterface

const keyOf = (sessionId: string) => `${KEY_PREFIX}${sessionId}`

function asStored(value: unknown): StoredNote | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { text, updatedAt } = value as Partial<StoredNote>
  return typeof text === 'string' && typeof updatedAt === 'number' ? { text, updatedAt } : undefined
}

/** Copies the session's stored note into `$.state`, where the pane reads it. */
async function load($: $, sessionId?: string): Promise<void> {
  const id = sessionId ?? (await $.session.id())
  const stored = asStored(await $.store.get(keyOf(id)))
  await update($, doc, () => ({ sessionId: id, text: stored?.text ?? '', updatedAt: stored?.updatedAt ?? 0 }))
}

/** Writes the note in `$.state` to `$.store`; an empty note is deleted, not kept. */
async function persist($: $): Promise<void> {
  const current = await read($, doc)
  if (current.sessionId === '') return
  if (current.text === '') await $.store.delete(keyOf(current.sessionId))
  else await $.store.set(keyOf(current.sessionId), { text: current.text, updatedAt: current.updatedAt })
}

/** Applies `fn` to the note, then saves it now or after typing pauses. */
async function edit($: $, fn: (text: string) => string, when: 'now' | 'soon' = 'now'): Promise<void> {
  if ((await read($, doc)).sessionId === '') await load($)
  const now = await $.clock.now()
  await update($, doc, d => ({ ...d, text: fn(d.text), updatedAt: now }))
  if (when === 'now') {
    cancelPendingSave()
    await persist($)
  } else {
    scheduleSave($)
  }
}

let pendingSave: { cancel: () => void } | undefined
const cancelPendingSave = () => {
  pendingSave?.cancel()
  pendingSave = undefined
}
function scheduleSave($: $) {
  cancelPendingSave()
  pendingSave = $.clock.after(SAVE_DELAY_MS, () => {
    pendingSave = undefined
    return persist($)
  })
}

async function isOpen($: $): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

async function confirm($: $, question: string, yes: string): Promise<boolean> {
  try {
    return (await $.ui.ask(question, [yes, 'Cancel'])) === yes
  } catch {
    return false // dismissed, or nobody to ask (-p)
  }
}

async function prune($: $, days: number): Promise<string> {
  const current = await $.session.id()
  const cutoff = (await $.clock.now()) - days * DAY_MS
  const stale: string[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(KEY_PREFIX) || key === keyOf(current)) continue
    const stored = asStored(await $.store.get(key))
    if (!stored || stored.updatedAt < cutoff) stale.push(key)
  }
  if (stale.length === 0) return `No notes older than ${days} days.`
  const label = stale.length === 1 ? '1 note' : `${stale.length} notes`
  if (!(await confirm($, `Delete ${label} from other sessions, untouched for over ${days} days?`, 'Delete'))) {
    return 'Prune cancelled.'
  }
  for (const key of stale) await $.store.delete(key)
  return `Deleted ${label}.`
}

export const register: Register = on => {
  // The id that /branch or /resume just left, so a branch can copy its note.
  let endedSessionId: string | undefined

  on('session.start', async ($, e, next) => {
    await load($)
    try {
      await $.command.register({
        name: 'note',
        description: 'Session notepad: toggle the pane, or append a line',
        argumentHint: '[text | edit | view | clear | prune [days] | -- text]',
        immediate: true,
      })
    } catch (error) {
      $.ui.log(`notes-panel: /note not registered: ${String(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    cancelPendingSave()
    await persist($)
    endedSessionId = e.sessionId
    return next(e)
  })

  // /clear, /resume and /branch switch the session id and reset $.state without session.start.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    const id = e.session_id
    if (e.source === 'fork' && endedSessionId !== undefined && endedSessionId !== id) {
      const parent = await $.store.get(keyOf(endedSessionId))
      const own = await $.store.get(keyOf(id))
      if (asStored(parent) && !asStored(own)) await $.store.set(keyOf(id), parent)
    }
    endedSessionId = undefined
    await load($, id)
    return next(e)
  })

  on('command.run', { command: 'note' }, async ($, e) => {
    const command = parseCommand(e.args)
    switch (command.kind) {
      case 'toggle':
        if (await isOpen($)) await $.ui.close({ id: PANE })
        else await $.ui.open({ id: PANE, title: TITLE })
        return {}
      case 'mode':
        await update($, mode, () => command.mode)
        if (!(await isOpen($))) await $.ui.open({ id: PANE, title: TITLE })
        return {}
      case 'append':
        await edit($, text => appendLine(text, command.text))
        $.ui.toast('Added to notes')
        return {}
      case 'clear': {
        if ((await read($, doc)).text === '') {
          $.ui.toast('Notes are already empty')
          return {}
        }
        const isSure = await confirm($, "Clear this session's notes?", 'Clear')
        if (isSure) await edit($, () => '')
        $.ui.toast(isSure ? 'Notes cleared' : 'Clear cancelled')
        return {}
      }
      case 'prune':
        $.ui.toast(await prune($, command.days))
        return {}
      case 'error':
        $.ui.toast(command.message)
        return {}
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = elements
    const note = await read($, doc)
    const current = await read($, mode)
    const lines = linesOf(note.text)
    const toggleMode = () => update($, mode, m => (m === 'view' ? 'edit' : 'view'))

    const header = (
      <Box flexDirection="row" columnGap={2}>
        <Button
          key="mode"
          label={current === 'view' ? 'Edit' : 'View'}
          hotkey={current === 'view' ? 'e' : 'v'}
          plain
          onPress={toggleMode}
        />
        <Text dimColor>{lines.length === 1 ? '1 line' : `${lines.length} lines`}</Text>
      </Box>
    )

    if (current === 'view') {
      const body =
        lines.length === 0
          ? [<Text dimColor>Empty. /note text adds a line; press e to edit.</Text>]
          : segmentsOf(note.text).map((segment, i) =>
              segment.kind === 'markdown' ? (
                <Markdown key={`md-${i}`} text={clip(segment.text)} />
              ) : (
                <Box paddingLeft={segment.indent}>
                  <Button
                    key={`task-${segment.line}`}
                    label={`${segment.isDone ? '☑' : '☐'} ${segment.label.slice(0, 500)}`}
                    plain
                    dimColor={segment.isDone}
                    onPress={() => edit($, text => toggleTask(text, segment.line))}
                  />
                </Box>
              ),
            )
      return (
        <Box flexDirection="column">
          {header}
          {body}
        </Box>
      )
    }

    if (!('Input' in elements)) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>Editing needs the terminal or the Desktop app.</Text>
        </Box>
      )
    }
    const { Input } = elements

    return (
      <Box flexDirection="column">
        {header}
        {lines.map((line, i) => (
          <Box flexDirection="row" columnGap={1}>
            <Button key={`del-${i}`} label="x" plain onPress={() => edit($, text => deleteLine(text, i))} />
            <Button key={`ins-${i}`} label="+" plain onPress={() => edit($, text => insertLineAfter(text, i))} />
            <Input
              key={`line-${i}`}
              value={line}
              submitLabel="save"
              onInput={value => edit($, text => replaceLine(text, i, value), 'soon')}
              onSubmit={value => edit($, text => replaceLine(text, i, value))}
            />
          </Box>
        ))}
        <Input
          key="new"
          value=""
          placeholder="New line, Enter to add"
          submitLabel="add"
          autoFocus
          onSubmit={value => edit($, text => appendLine(text, value))}
        />
      </Box>
    )
  })
}
