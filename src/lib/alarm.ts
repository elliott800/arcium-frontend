// ArciumAlarm, the Android alarm app. The phone signs in once with the person's Arcium
// account (POST /api/alarm/login) and gets a long-lived device token; only its sha256 is
// stored, in alarm_devices. Calendar commands (POST /api/alarm/command) go to Claude here,
// so the Anthropic API key (ANTHROPIC_API_KEY) never leaves the server.
//
// Every command is billed to the site's API credits, so by default only the owner (admin)
// may use it. ALARM_ACCESS=all opens it to every approved Arcium account.

import { type NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '@/lib/db';
import { hashToken, newToken } from '@/lib/auth';

const DEVICE_DAYS = 365;

export interface AlarmUser { user_id: string; username: string; email: string; role: 'admin' | 'user' }

interface AccountRow {
  user_id: string; username: string; username_email: string; role: string | null; active: number;
  approval: string; email_verified_at: unknown; demo_expires_at: unknown;
}

/** Whether this Arcium account may use the alarm app's Claude commands. */
export function mayUseAlarm(u: Pick<AccountRow, 'role' | 'active' | 'approval' | 'email_verified_at' | 'demo_expires_at'>): boolean {
  if (!u.active || u.approval !== 'approved' || !u.email_verified_at || u.demo_expires_at) return false;
  return process.env.ALARM_ACCESS === 'all' || u.role === 'admin';
}

export async function createDevice(userId: string, label: string | null): Promise<string> {
  const token = newToken();
  await getDb().prepare(`
    INSERT INTO alarm_devices (token_hash, user_id, label, expires_at)
    VALUES (?, ?, ?, now() + make_interval(days => ?))
  `).run(hashToken(token), userId, label ? label.slice(0, 120) : null, DEVICE_DAYS);
  return token;
}

export function bearer(req: NextRequest): string | undefined {
  const h = req.headers.get('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() || undefined : undefined;
}

/** The account behind a device token, sliding its expiry forward; null if invalid or no longer allowed. */
export async function deviceUser(token: string | undefined): Promise<AlarmUser | null> {
  if (!token) return null;
  const row = await getDb().prepare(`
    UPDATE alarm_devices d SET last_used_at = now(), expires_at = now() + make_interval(days => ?)
    FROM users u
    WHERE d.token_hash = ? AND d.expires_at > now() AND u.user_id = d.user_id
    RETURNING u.user_id, u.username, u.username_email, u.role, u.active, u.approval,
              u.email_verified_at, u.demo_expires_at
  `).get(DEVICE_DAYS, hashToken(token)) as AccountRow | undefined;
  if (!row || !mayUseAlarm(row)) return null;
  return { user_id: row.user_id, username: row.username, email: row.username_email, role: row.role === 'admin' ? 'admin' : 'user' };
}

export async function revokeDevice(token: string | undefined): Promise<void> {
  if (token) await getDb().prepare('DELETE FROM alarm_devices WHERE token_hash = ?').run(hashToken(token));
}

// ── Claude ────────────────────────────────────────────────────────────────

export interface CalendarActionOut {
  type: 'add' | 'remove';
  title: string; start: string; end: string; calendar_id: string; description: string;
  event_id: string; begin_ms: string;
}

export interface CommandReply { reply: string; actions: CalendarActionOut[] }

const SYSTEM = `You manage the user's Google Calendar from short spoken or typed commands sent by their phone's alarm app.

You receive the command, the current local time and timezone, the user's writable calendars, the default calendar id, and their events for roughly the next two weeks. Turn the command into calendar actions:

- "add": title, start and end as ISO-8601 local times with the UTC offset (e.g. 2026-10-22T15:00:00-04:00), calendar_id (use default_calendar_id unless the user names another calendar), and an optional description. Resolve relative dates ("tomorrow", "next Friday", "in 2 hours") from the provided current time. If no end or duration is given, make it one hour. If no time is given for a timed thing, pick a sensible time and say which in the reply.
- "remove": event_id and begin_ms copied exactly from an event in the list. Only remove events that clearly match the command. "Remove my 5pm gym" means the one occurrence, not the whole series.
- A "move"/"reschedule" request is a remove of the old occurrence plus an add of the new one, keeping the title.

Changes are applied immediately without confirmation, so if the command is ambiguous (several events could match and nothing narrows it down) or isn't a calendar request, return no actions and ask a short clarifying question in the reply.

For fields that don't apply to an action, use an empty string.

The reply is read aloud, so keep it to one short, natural sentence that confirms what you did, e.g. "Added dentist Tuesday at 3 PM." Don't use markdown.`;

const SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['add', 'remove'] },
          title: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          calendar_id: { type: 'string' },
          description: { type: 'string' },
          event_id: { type: 'string' },
          begin_ms: { type: 'string' },
        },
        required: ['type', 'title', 'start', 'end', 'calendar_id', 'description', 'event_id', 'begin_ms'],
        additionalProperties: false,
      },
    },
  },
  required: ['reply', 'actions'],
  additionalProperties: false,
};

let client: Anthropic | null = null;

export class AlarmClaudeError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Asks Claude to turn one command plus the phone's calendar context into add/remove actions. */
export async function planCalendarChanges(command: string, context: Record<string, unknown>): Promise<CommandReply> {
  if (!process.env.ANTHROPIC_API_KEY) throw new AlarmClaudeError('Claude is not configured on the server.', 503);
  client ??= new Anthropic();

  const userText = `Calendar context:\n${JSON.stringify(context, null, 2)}\n\nCommand: ${command}`;
  let message;
  try {
    message = await client.beta.messages.create({
      model: process.env.ALARM_MODEL || 'claude-opus-5-5',
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: 'user', content: userText }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      // If a safety classifier declines, the API retries on Anthropic's recommended fallback model.
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new AlarmClaudeError('Claude is busy, try again in a minute.', 503);
    if (err instanceof Anthropic.AuthenticationError) throw new AlarmClaudeError('The server\'s Claude API key was rejected.', 502);
    if (err instanceof Anthropic.APIError) throw new AlarmClaudeError(`Claude API error ${err.status ?? ''}`.trim(), 502);
    throw new AlarmClaudeError('Could not reach Claude.', 502);
  }

  if (message.stop_reason === 'refusal') return { reply: 'Claude declined that request.', actions: [] };
  if (message.stop_reason === 'max_tokens') throw new AlarmClaudeError('Claude\'s response was cut off.', 502);

  for (const block of message.content) {
    if (block.type !== 'text') continue;
    try {
      const data = JSON.parse(block.text) as CommandReply;
      if (typeof data.reply === 'string' && Array.isArray(data.actions)) return data;
    } catch { /* fall through */ }
    break;
  }
  throw new AlarmClaudeError('Unexpected response from Claude.', 502);
}
