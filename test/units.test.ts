import { describe, expect, test } from 'bun:test'
import { classifySender, defaultAccess, issuePairingCode, pruneExpired, requiresMention, type Access } from '../src/access'
import { channelsInclude, isClaudeArgs, parsePsLine } from '../src/detect'
import { LineDecoder, encode, type HubMsg } from '../src/ipc'
import { buildTmuxArgs, detectDialog, menuKeys, pluginToolNames, tmuxNameFor, type SpawnOptions } from '../src/spawn'
import { PERMISSION_REPLY_RE, chunk, compareVersions, safeName } from '../src/util'

describe('util', () => {
  test('chunk by length', () => {
    expect(chunk('abcdef', 10, 'length')).toEqual(['abcdef'])
    expect(chunk('abcdef', 4, 'length')).toEqual(['abcd', 'ef'])
  })
  test('chunk on paragraph boundaries', () => {
    const text = 'aaaa aaaa\n\nbbbb bbbb\n\ncccc'
    const out = chunk(text, 12, 'newline')
    expect(out.every(c => c.length <= 12)).toBe(true)
    expect(out.join('')).toBe(text.replace(/\n\n/g, ''))
  })
  test('safeName strips tag-breaking chars', () => {
    expect(safeName('a<b>[c];d\n"e')).toBe('a_b__c__d__e')
    expect(safeName(undefined)).toBeUndefined()
  })
  test('permission reply regex', () => {
    expect(PERMISSION_REPLY_RE.exec('yes abcde')?.[2]).toBe('abcde')
    expect(PERMISSION_REPLY_RE.exec(' No KMNOP ')?.[2]).toBe('KMNOP')
    expect(PERMISSION_REPLY_RE.test('yes abcdl')).toBe(false) // no 'l'
    expect(PERMISSION_REPLY_RE.test('yes')).toBe(false)
    expect(PERMISSION_REPLY_RE.test('yes abcde please')).toBe(false)
  })
  test('compareVersions', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0', '0.1')).toBe(0)
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0)
  })
})

describe('access', () => {
  const base: Access = { ...defaultAccess(), allowFrom: ['owner'], channels: { chan: { allowFrom: [] }, locked: { allowFrom: ['m1'] } } }
  test('classifySender matrix', () => {
    expect(classifySender(base, 'owner', 'dm', 'D')).toBe('owner')
    expect(classifySender(base, 'x', 'dm', 'D')).toBe('unknown')
    expect(classifySender({ ...base, dmPolicy: 'allowlist' }, 'x', 'dm', 'D')).toBe('blocked')
    expect(classifySender(base, 'owner', 'chan', 'O')).toBe('owner')
    expect(classifySender(base, 'x', 'chan', 'O')).toBe('member')
    expect(classifySender(base, 'm1', 'locked', 'P')).toBe('member')
    expect(classifySender(base, 'x', 'locked', 'P')).toBe('blocked')
    expect(classifySender(base, 'owner', 'elsewhere', 'O')).toBe('blocked')
    expect(classifySender(base, 'x', 'gdm', 'G')).toBe('blocked')
    expect(classifySender({ ...base, dmPolicy: 'disabled' }, 'owner', 'dm', 'D')).toBe('blocked')
  })
  test('requiresMention defaults to true', () => {
    expect(requiresMention(base, 'chan')).toBe(true)
    expect(requiresMention({ ...base, requireMention: false }, 'chan')).toBe(false)
    expect(requiresMention({ ...base, channels: { chan: { allowFrom: [], requireMention: false } } }, 'chan')).toBe(false)
  })
  test('pairing: resend once, then silence; max 3 pending', () => {
    const a: Access = defaultAccess()
    const first = issuePairingCode(a, 's1', 'c1', 1000)!
    expect(first.isResend).toBe(false)
    expect(issuePairingCode(a, 's1', 'c1', 1001)).toEqual({ code: first.code, isResend: true })
    expect(issuePairingCode(a, 's1', 'c1', 1002)).toBeNull()
    issuePairingCode(a, 's2', 'c2', 1000)
    issuePairingCode(a, 's3', 'c3', 1000)
    expect(issuePairingCode(a, 's4', 'c4', 1000)).toBeNull()
    expect(pruneExpired(a, 1000 + 61 * 60 * 1000)).toBe(true)
    expect(Object.keys(a.pending)).toHaveLength(0)
  })
})

describe('detect', () => {
  test('isClaudeArgs', () => {
    expect(isClaudeArgs('claude --channels plugin:x@y')).toBe(true)
    expect(isClaudeArgs('/Users/me/.local/bin/claude')).toBe(true)
    expect(isClaudeArgs('node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBe(true)
    expect(isClaudeArgs('bun run --cwd /x start')).toBe(false)
  })
  test('channelsInclude', () => {
    expect(channelsInclude('claude --dangerously-load-development-channels plugin:mattermost@claude-mattermost', 'mattermost')).toBe(true)
    expect(channelsInclude('claude --channels plugin:telegram@a plugin:mattermost@b --resume x', 'mattermost')).toBe(true)
    expect(channelsInclude('claude --channels=plugin:mattermost@b', 'mattermost')).toBe(true)
    expect(channelsInclude('claude --channels plugin:telegram@a --dangerously-load-development-channels server:mattermost', 'mattermost')).toBe(true)
    expect(channelsInclude('claude --channels plugin:telegram@a', 'mattermost')).toBe(false)
    expect(channelsInclude('claude -n mattermost', 'mattermost')).toBe(false)
    expect(channelsInclude('claude', 'mattermost')).toBe(false)
  })
  test('parsePsLine', () => {
    expect(parsePsLine('  83429 claude --allow-dangerously-skip-permissions')).toEqual({ ppid: 83429, args: 'claude --allow-dangerously-skip-permissions' })
    expect(parsePsLine('')).toBeNull()
  })
})

describe('ipc', () => {
  test('LineDecoder handles split and joined frames', () => {
    const d = new LineDecoder<HubMsg>()
    const a = encode({ t: 'waiting', reason: 'x' })
    const b = encode({ t: 'result', id: 1, ok: true, text: 'line\nbreak' })
    expect(d.push(a.slice(0, 5))).toEqual([])
    const out = d.push(a.slice(5) + b + 'garbage\n')
    expect(out).toEqual([{ t: 'waiting', reason: 'x' }, { t: 'result', id: 1, ok: true, text: 'line\nbreak' }])
  })
})

describe('spawn', () => {
  const opts: SpawnOptions = {
    tmuxName: tmuxNameFor('abcdefghijklmnop'),
    cwd: '/w/api',
    threadId: 'abcdefghijklmnop',
    sessionId: 'uuid-1',
    resume: false,
    displayName: 'mm:api',
    permissionMode: 'acceptEdits',
    channelFlag: 'dev',
    pluginRef: 'plugin:mattermost@claude-mattermost',
    claudeBin: '/bin/claude',
    extraArgs: ['--model', 'opus'],
    env: { MATTERMOST_THREAD_ID: 'abcdefghijklmnop' },
  }
  test('tmux command', () => {
    expect(buildTmuxArgs(opts)).toEqual([
      'tmux', 'new-session', '-d', '-s', 'mm-abcdefgh', '-x', '200', '-y', '50', '-c', '/w/api',
      '-e', 'MATTERMOST_THREAD_ID=abcdefghijklmnop',
      '/bin/claude', '--session-id', 'uuid-1', '-n', 'mm:api', '--permission-mode', 'acceptEdits',
      '--dangerously-load-development-channels', 'plugin:mattermost@claude-mattermost', '--model', 'opus',
    ])
  })
  test('pre-approved plugin tools', () => {
    const tools = pluginToolNames('plugin:mattermost@claude-mattermost')
    expect(tools).toContain('mcp__plugin_mattermost_mattermost__reply')
    expect(tools).toHaveLength(5)
    const argv = buildTmuxArgs({ ...opts, allowedTools: tools })
    const i = argv.indexOf('--allowedTools')
    expect(argv[i + 1]).toBe(tools.join(','))
    // must come before the variadic channel flag so it isn't swallowed as a channel
    expect(i).toBeLessThan(argv.indexOf('--dangerously-load-development-channels'))
  })
  test('resume + --channels', () => {
    const argv = buildTmuxArgs({ ...opts, resume: true, channelFlag: 'channels', extraArgs: [] })
    expect(argv).toContain('--resume')
    expect(argv).not.toContain('--session-id')
    expect(argv).toContain('--channels')
  })

  // Screens captured from Claude Code 2.1.322 in a tmux pane.
  const TRUST = [
    ' Accessing workspace:',
    ' /tmp/probe-ws',
    ' Quick safety check: Is this a project you created or one you trust?',
    ' Claude Code\'ll be able to read, edit, and execute files here.',
    ' Security guide',
    ' ❯ No, exit',
    '   Yes, I trust this folder',
    ' Enter to confirm · Esc to cancel',
  ].join('\n')
  const DEV = [
    '  WARNING: Loading development channels',
    '  --dangerously-load-development-channels is for local channel development only.',
    '  Channels: server:probe',
    '  ❯ 1. I am using this for local development',
    '    2. Exit',
    '  Enter to confirm · Esc to cancel',
  ].join('\n')
  const MAIN = [
    '▎ Channels (experimental) messages from server:probe inject directly in this session',
    '❯ Try "edit <filepath> to..."',
  ].join('\n')

  test('trust dialog → Down, Enter', () => {
    expect(detectDialog(TRUST)).toEqual({ name: 'trust', keys: ['Down', 'Enter'] })
  })
  test('dev-channel dialog → Enter', () => {
    expect(detectDialog(DEV)).toEqual({ name: 'dev-channels', keys: ['Enter'] })
  })
  test('main screen is not a dialog', () => {
    expect(detectDialog(MAIN)).toBeNull()
  })
  test('menuKeys moves up when needed', () => {
    expect(menuKeys('  a\n  b target\n❯ c', 'target')).toEqual(['Up', 'Enter'])
    expect(menuKeys('nothing here', 'target')).toBeNull()
  })
})
