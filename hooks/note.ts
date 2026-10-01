// Pure text helpers for the notepad: no `$`, so tests can call them directly.

/** Markdown's per-element limit is 10,000 characters; leave room for the notice. */
export const MARKDOWN_MAX = 9_900

const TASK = /^(\s*)([-*+]) \[([ xX])\] (.*)$/
const FENCE = /^\s*(```|~~~)/

export type Segment =
  | { kind: 'markdown'; text: string }
  | { kind: 'task'; line: number; indent: number; isDone: boolean; label: string }

export const linesOf = (text: string): string[] => (text === '' ? [] : text.split('\n'))

/** Splits a note into markdown runs and task lines, leaving fenced code alone. */
export function segmentsOf(text: string): Segment[] {
  const segments: Segment[] = []
  let run: string[] = []
  let isInFence = false
  const flush = () => {
    if (run.length > 0) segments.push({ kind: 'markdown', text: run.join('\n') })
    run = []
  }

  linesOf(text).forEach((line, i) => {
    if (FENCE.test(line)) isInFence = !isInFence
    const task = isInFence ? null : TASK.exec(line)
    if (!task) {
      run.push(line)
      return
    }
    flush()
    segments.push({
      kind: 'task',
      line: i,
      indent: (task[1] ?? '').length,
      isDone: task[3] !== ' ',
      label: task[4] ?? '',
    })
  })
  flush()

  return segments
}

/** Flips `[ ]` and `[x]` on line `i`; any other line, fenced code included, is left as it is. */
export function toggleTask(text: string, i: number): string {
  const isTask = segmentsOf(text).some(s => s.kind === 'task' && s.line === i)
  const lines = linesOf(text)
  const task = isTask ? TASK.exec(lines[i] ?? '') : null
  if (!task) return text
  const mark = task[3] === ' ' ? 'x' : ' '
  lines[i] = `${task[1]}${task[2]} [${mark}] ${task[4]}`

  return lines.join('\n')
}

export const appendLine = (text: string, line: string): string =>
  text === '' ? line : `${text.replace(/\n+$/, '')}\n${line}`

export function replaceLine(text: string, i: number, line: string): string {
  const lines = linesOf(text)
  if (i < 0 || i >= lines.length) return text
  lines[i] = line

  return lines.join('\n')
}

export function insertLineAfter(text: string, i: number): string {
  const lines = linesOf(text)
  lines.splice(i + 1, 0, '')

  return lines.join('\n')
}

export function deleteLine(text: string, i: number): string {
  const lines = linesOf(text)
  lines.splice(i, 1)

  return lines.join('\n')
}

export const clip = (text: string): string =>
  text.length <= MARKDOWN_MAX
    ? text
    : `${text.slice(0, MARKDOWN_MAX)}\n\n*… truncated; the rest is in Edit mode.*`

export type NoteCommand =
  | { kind: 'toggle' }
  | { kind: 'mode'; mode: 'view' | 'edit' }
  | { kind: 'clear' }
  | { kind: 'prune'; days: number }
  | { kind: 'append'; text: string }
  | { kind: 'error'; message: string }

export const DEFAULT_PRUNE_DAYS = 30

/** `/note` arguments: reserved words first, `-- text` appends anything literally. */
export function parseCommand(args: string): NoteCommand {
  const trimmed = args.trim()
  if (trimmed === '') return { kind: 'toggle' }
  if (trimmed.startsWith('--')) {
    const text = trimmed.slice(2).trim()
    return text === '' ? { kind: 'error', message: 'Nothing after --.' } : { kind: 'append', text }
  }
  const [word, ...rest] = trimmed.split(/\s+/)
  switch (word) {
    case 'edit':
    case 'view':
      if (rest.length === 0) return { kind: 'mode', mode: word }
      break
    case 'clear':
      if (rest.length === 0) return { kind: 'clear' }
      break
    case 'prune': {
      if (rest.length === 0) return { kind: 'prune', days: DEFAULT_PRUNE_DAYS }
      const days = Number(rest[0])
      if (rest.length === 1 && Number.isInteger(days) && days >= 1) return { kind: 'prune', days }
      return { kind: 'error', message: 'Usage: /note prune [days], days a whole number ≥ 1.' }
    }
  }

  return { kind: 'append', text: trimmed }
}
