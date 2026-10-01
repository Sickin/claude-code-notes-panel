import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { parseCommand, segmentsOf, toggleTask } from '../hooks/note'

const SURFACES = ['terminal', 'desktop'] as const
const PANE = {
  plugin: 'notes-panel',
  component: 'Pane',
  requestId: 'notes',
  props: { title: 'Notes', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const ID = 'session-a'
const DAY = 86_400_000

/** What sits beneath the plugin: a session id, a store we can inspect, a clock, and a person answering dialogs. */
function world(on: On, entries: Record<string, unknown> = {}, now = 0) {
  const store = new Map(Object.entries(entries))
  const person = { answer: 'Cancel', asked: 0 }
  let sessionId = ID
  const clock = mock.clock(on, { now })
  on('session.id', () => ({ value: sessionId }))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', ($, e) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  const panes = new Set<string>()
  on('ui.toast', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.open', ($, e) => (panes.add(e.id), { value: { isPlaced: true } }))
  on('ui.close', ($, e) => (panes.delete(e.id), { value: undefined }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', ($, e) => ((sessionId = e.session_id), {}))
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    person.asked += 1
    const question = e.questions[0]?.question ?? ''
    return { result: { questions: e.questions, answers: { [question]: person.answer } } }
  })
  const text = (id = ID) => (store.get(`note:${id}`) as { text: string } | undefined)?.text
  return { store, person, text, panes, clock }
}

describe('text helpers', () => {
  test('reserved words, -- escape and plain text', async () => {
    expect(parseCommand('')).toEqual({ kind: 'toggle' })
    expect(parseCommand('edit')).toEqual({ kind: 'mode', mode: 'edit' })
    expect(parseCommand('clear')).toEqual({ kind: 'clear' })
    expect(parseCommand('prune')).toEqual({ kind: 'prune', days: 30 })
    expect(parseCommand('prune 7')).toEqual({ kind: 'prune', days: 7 })
    expect(parseCommand('prune soon').kind).toBe('error')
    expect(parseCommand('-- clear')).toEqual({ kind: 'append', text: 'clear' })
    expect(parseCommand('clear the cache')).toEqual({ kind: 'append', text: 'clear the cache' })
  })

  test('tasks split out, fenced code left alone', async () => {
    const text = '# Todo\n- [ ] a\n  - [x] b\n```\n- [ ] not a task\n```'
    const kinds = segmentsOf(text).map(s => (s.kind === 'task' ? `task${s.line}` : 'md'))
    expect(kinds).toEqual(['md', 'task1', 'task2', 'md'])
    expect(toggleTask(text, 1)).toContain('- [x] a')
    expect(toggleTask(text, 2)).toContain('  - [ ] b')
    expect(toggleTask(text, 4)).toBe(text)
  })
})

describe('the notepad', () => {
  const note = (args: string) => ({ command: 'note', args }) as never

  test('/note appends to this session only and persists', async ($, on) => {
    const w = world(on, { 'note:someone-else': { text: 'theirs', updatedAt: 1 } })
    await $.command.run(note('buy milk'))
    await $.command.run(note('-- clear'))
    expect(w.text()).toBe('buy milk\nclear')
    expect(w.store.get('note:someone-else')).toEqual({ text: 'theirs', updatedAt: 1 })
  })

  test('a rendered checkbox toggles on press, on both surfaces', async ($, on) => {
    const w = world(on)
    await $.command.run(note('- [ ] ship it'))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ key: 'task-0' }))?.text).toContain('☐ ship it')
      await ui.press({ key: 'task-0' })
      expect((await ui.find({ key: 'task-0' }))?.text).toContain('☑ ship it')
      expect(w.text()).toBe('- [x] ship it')
      await ui.press({ key: 'task-0' })
      await ui.unmount()
    }
    expect(w.text()).toBe('- [ ] ship it')
  })

  test('/note toggles the pane', async ($, on) => {
    const w = world(on)
    await $.command.run(note(''))
    expect(w.panes.has('notes')).toBe(true)
    await $.command.run(note(''))
    expect(w.panes.has('notes')).toBe(false)
  })

  test('the mode button and /note edit|view switch modes', async ($, on) => {
    world(on)
    await $.command.run(note('hello'))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Markdown', text: 'hello' })).toBeDefined()
    await ui.press({ key: 'mode' })
    expect(await ui.find({ key: 'line-0' })).toBeDefined()
    await $.command.run(note('view'))
    expect(await ui.find({ key: 'line-0' })).toBeUndefined()
  })

  test('edit mode edits, inserts and deletes lines', async ($, on) => {
    const w = world(on)
    await $.command.run(note('one'))
    await $.command.run(note('edit'))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.input({ key: 'line-0', text: 'uno' })
      await ui.input({ key: 'new', text: 'dos' })
      await ui.press({ key: 'ins-0' })
      expect(w.text()).toBe('uno\n\ndos')
      await ui.press({ key: 'del-1' })
      await ui.press({ key: 'del-1' })
      await ui.input({ key: 'line-0', text: 'one' })
      await ui.unmount()
    }
    expect(w.text()).toBe('one')
  })

  test('typing saves once it pauses; Enter saves at once', async ($, on) => {
    const w = world(on)
    await $.command.run(note('draft'))
    await $.command.run(note('edit'))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.input({ key: 'line-0', text: 'drafty', kind: 'change' })
    expect(w.text()).toBe('draft')
    await w.clock.advance(800)
    expect(w.text()).toBe('drafty')
    await ui.input({ key: 'line-0', text: 'final' })
    expect(w.text()).toBe('final')
  })

  test('/note clear asks first and only clears on yes', async ($, on) => {
    const w = world(on)
    await $.command.run(note('keep me'))
    await $.command.run(note('clear'))
    expect(w.person.asked).toBe(1)
    expect(w.text()).toBe('keep me')
    w.person.answer = 'Clear'
    await $.command.run(note('clear'))
    expect(w.text()).toBeUndefined()
  })

  test('/note prune asks, then deletes only stale notes of other sessions', async ($, on) => {
    const w = world(
      on,
      { 'note:old': { text: 'old', updatedAt: 1 }, 'note:fresh': { text: 'fresh', updatedAt: 99 * DAY }, unrelated: 1 },
      100 * DAY,
    )
    await $.command.run(note('mine'))
    await $.command.run(note('prune 30'))
    expect(w.store.has('note:old')).toBe(true)
    w.person.answer = 'Delete'
    await $.command.run(note('prune 30'))
    expect(w.person.asked).toBe(2)
    expect([...w.store.keys()].sort()).toEqual(['note:fresh', `note:${ID}`, 'unrelated'])
  })

  test('/branch copies the parent note into the new session', async ($, on) => {
    const w = world(on)
    await $.command.run(note('carry me'))
    await $.session.end({ reason: 'resume', sessionId: ID, resume: { id: ID } } as never)
    await $.classic.SessionStart({ source: 'fork', session_id: 'child' } as never)
    expect(w.text('child')).toBe('carry me')
    await $.command.run(note('child only'))
    expect(w.text('child')).toBe('carry me\nchild only')
    expect(w.text()).toBe('carry me')
  })

  test('/clear switches the pane to the new session note', async ($, on) => {
    world(on, { 'note:after-clear': { text: 'fresh start', updatedAt: 5 } })
    await $.command.run(note('before'))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await $.session.end({ reason: 'clear', sessionId: ID, resume: { id: ID } } as never)
    await $.classic.SessionStart({ source: 'clear', session_id: 'after-clear' } as never)
    expect(await ui.find({ type: 'Markdown', text: 'fresh start' })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: 'before' })).toBeUndefined()
  })
})
