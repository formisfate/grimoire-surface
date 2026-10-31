#!/usr/bin/env node
// The MCP server.
//
// Deliberately dependency-free and build-free: the protocol a tools-only MCP server needs is
// JSON-RPC 2.0 over newline-delimited stdio, which is a few hundred lines, and pulling in an SDK
// plus a package manager would mean this cannot run by unzipping two repos. There is nothing to
// install, nothing to compile, and nothing that phones home — it reads the corpus off disk.
//
// Usage:
//   node mcp/server.mjs                          # corpus found automatically
//   GRIMOIRE_DIR=/path/to/grimoire node mcp/server.mjs
//   node mcp/server.mjs --corpus /path/to/grimoire
//   node mcp/server.mjs --bundle grimoire.min.json.gz
//
// Diagnostics go to stderr, always. stdout carries protocol frames and nothing else; a stray
// console.log here corrupts the stream and the client disconnects without explaining why.

import { createSurface } from '../src/query.mjs';
import { readBundle, bundleToCorpusInput } from '../src/bundle.mjs';
import { TOOLS } from '../src/tools.mjs';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0];
const SERVER_INFO = { name: 'grimoire', version: '1.0.0' };

function parseArgs(argv) {
  const out = { corpus: undefined, bundle: process.env.GRIMOIRE_BUNDLE, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--corpus' || a === '-c') out.corpus = argv[++i];
    else if (a === '--bundle' || a === '-b') out.bundle = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--corpus=')) out.corpus = a.slice('--corpus='.length);
    else if (a.startsWith('--bundle=')) out.bundle = a.slice('--bundle='.length);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  process.stdout.write(`grimoire MCP server

Serves the Grimoire corpus (81 files, one symbolic system each) to any MCP client.

  node mcp/server.mjs [--corpus <dir>]
  node mcp/server.mjs [--bundle grimoire.min.json[.gz]]

The corpus is a separate git repo. It is found automatically when this repo and \`grimoire\`
sit side by side, or set GRIMOIRE_DIR, or pass --corpus.

If you do not have the corpus repo at all, download the bundle from
https://ensoul.so/api/grimoire/bundle and pass it with --bundle. Same corpus, one file.

Tools: ${TOOLS.map((t) => t.name).join(', ')}
`);
  process.exit(0);
}

let surface = null;
function getSurface() {
  if (surface) return surface;
  // A bundle is the whole corpus in one file — the way in for anyone who cannot clone the private
  // corpus repo. `--corpus` and `--bundle` are mutually exclusive by precedence: an explicit bundle
  // wins, because asking for a specific file is more specific than pointing at a directory.
  if (args.bundle) {
    const bundle = readBundle(args.bundle);
    surface = createSurface(bundleToCorpusInput(bundle));
    const built = bundle.meta?.corpus;
    if (built && built !== surface.version.version) {
      log(`warning: ${args.bundle} declares corpus ${built} but its contents hash to ${surface.version.version}`);
    }
  } else {
    surface = createSurface(args.corpus);
  }
  return surface;
}

function log(...parts) {
  process.stderr.write(`[grimoire] ${parts.join(' ')}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

/**
 * A tool result. The protocol wants `content`; `isError` marks a *tool* failure (a bad id) rather
 * than a protocol failure, so the agent can read the message and try something else instead of
 * treating the session as broken.
 */
function toolResult(value) {
  const failed = value && typeof value === 'object' && value.error;
  const text = JSON.stringify(value, null, 2);
  return {
    content: [{ type: 'text', text }],
    ...(failed ? { isError: true } : {}),
  };
}

function callTool(name, input) {
  const s = getSurface();
  switch (name) {
    case 'grimoire_overview':
      return s.info();
    case 'grimoire_search':
      return s.search(input.query, input);
    case 'grimoire_lookup':
      return s.lookup(input.query, input);
    case 'grimoire_entry':
      return s.entry(input.id, input);
    case 'grimoire_related':
      return s.related(input.id, input);
    case 'grimoire_list':
      return s.list(input);
    case 'grimoire_timing':
      return s.timing(input);
    case 'grimoire_fits':
      return s.fits(input);
    default:
      return { error: { code: 'unknown_tool', message: `No tool named \`${name}\`.` } };
  }
}

function handle(message) {
  const { id, method, params } = message;

  // Notifications carry no id and must never be answered.
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    const requested = params?.protocolVersion;
    const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL;
    try {
      const s = getSurface();
      log(`corpus ${s.version.version} · ${s.corpus.stats.files} files · ${s.corpus.stats.entries} entries`);
    } catch (err) {
      // Do not fail the handshake over this; report it on the first tool call instead, where the
      // client can actually show the message to a human.
      log(`corpus not loaded: ${err.message}`);
    }
    reply(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions:
        'The Grimoire is a curated corpus of esoteric reference data. Call grimoire_overview once to see its shape, then grimoire_search or grimoire_lookup to find an entry, grimoire_entry for the full record, and grimoire_related to traverse. Provenance fields (tradition, culture, source, note) are meaningful: where traditions disagree, the entry says so rather than picking a winner. Do not present a contested correspondence as settled.',
    });
    return;
  }

  if (method === 'notifications/initialized' || method === 'initialized') return;

  if (method === 'ping') {
    if (!isNotification) reply(id, {});
    return;
  }

  if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const input = params?.arguments ?? {};
    try {
      const value = callTool(name, input);
      reply(id, toolResult(value));
    } catch (err) {
      // A missing corpus is the common real-world failure; say what to do about it.
      const hint = /Could not find the grimoire corpus/.test(String(err.message))
        ? 'Set GRIMOIRE_DIR to the grimoire repo, or clone it beside this one.'
        : undefined;
      reply(id, toolResult({ error: { code: 'tool_failed', message: err.message, ...(hint ? { hint } : {}) } }));
    }
    return;
  }

  if (method === 'resources/list') {
    reply(id, { resources: [] });
    return;
  }

  if (method === 'prompts/list') {
    reply(id, { prompts: [] });
    return;
  }

  if (!isNotification) replyError(id, -32601, `Method not found: ${method}`);
}

let buffer = '';

process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      replyError(null, -32700, 'Parse error: the frame was not valid JSON.');
      continue;
    }
    try {
      handle(message);
    } catch (err) {
      if (message?.id !== undefined) replyError(message.id, -32603, `Internal error: ${err.message}`);
    }
  }
});

process.stdin.on('end', () => process.exit(0));

process.on('SIGTERM', () => process.exit(0));
