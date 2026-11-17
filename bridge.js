// Discord -> OBS mute bridge
//
// Watches the mute button of the Discord desktop app and copies its state onto
// ONE audio input in OBS (your microphone). No other OBS input is touched and
// nothing is ever changed in Discord.
//
// Setup (once):
//   1. Discord Developer Portal (https://discord.com/developers/applications):
//      New Application -> OAuth2 page -> copy the Client ID, press "Reset Secret"
//      and copy the Client Secret, then under Redirects add  http://localhost
//      and save. Nothing ever opens that address, but Discord will not sign an app
//      in unless it has a redirect listed. (No bot and no bot token are needed.)
//   2. OBS: Tools -> WebSocket Server Settings -> Enable WebSocket server.
//      "Show Connect Info" shows the port and password.
//   3. npm install
//   4. npm start     (the first run creates config.json; fill it in, start again)
//   5. Click "Authorize" in the prompt that pops up inside Discord (first run only).

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OBSWebSocket, { EventSubscription } from 'obs-websocket-js';

if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error(`This script needs Node.js 20 or newer (this is ${process.version}).`);
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(HERE, 'config.json');
const TOKEN_FILE = path.join(HERE, 'discord-token.json'); // saved login, so Discord only asks once

const DEFAULT_CONFIG = {
  discordClientId: '',
  discordClientSecret: '',
  discordRedirectUri: 'http://localhost',
  obsUrl: 'ws://127.0.0.1:4455',
  obsPassword: '',
  obsMicInput: '', // exact name from the OBS Audio Mixer; leave empty to auto-detect
};

const RETRY_MS = 5_000; // pause between reconnect attempts
// Discord lets an app connect about twice a minute and makes further connections wait,
// so after a failed session the pauses grow.
const DISCORD_RETRY_MS = [5_000, 15_000, 30_000, 60_000];
const DISCORD_SCOPES = ['rpc', 'identify']; // the pair from Discord's own RPC example; this script only reads voice settings
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const RENEW_MARGIN_MS = 60 * 60 * 1000; // renew the Discord login an hour before it runs out

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

// Like log(), but stays quiet while the same message repeats (retry loops).
const lastStatus = {};
function status(side, message) {
  if (lastStatus[side] === message) return;
  lastStatus[side] = message;
  log(message);
}

// A problem that retrying cannot fix (wrong setting, declined prompt, ...).
function fatal(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function fatalError(message) {
  return Object.assign(new Error(message), { fatal: true });
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

async function loadConfig() {
  let text;
  try {
    text = await readFile(CONFIG_FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', { flag: 'wx' });
    fatal(
      `Created ${CONFIG_FILE}\n` +
        'Fill in discordClientId and discordClientSecret, and obsPassword if OBS shows one.\n' +
        'Leave obsMicInput empty to use your only microphone input, or put its exact name\n' +
        'from the OBS Audio Mixer there. Then start the bridge again.\n' +
        'Keep that file private: it holds your client secret.',
    );
  }

  let config;
  try {
    // Notepad may put a byte-order mark in front; JSON.parse does not accept it.
    config = { ...DEFAULT_CONFIG, ...JSON.parse(text.replace(/^\uFEFF/, '')) };
  } catch (err) {
    fatal(`config.json is not valid JSON: ${err.message}`);
  }

  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (typeof config[key] !== 'string') {
      fatal(`config.json: "${key}" must be text in double quotes (the client ID too, or its digits get rounded).`);
    }
    config[key] = config[key].trim();
  }
  if (!/^\d{15,22}$/.test(config.discordClientId)) {
    fatal('config.json: "discordClientId" should be the long number shown as Client ID on your app\'s OAuth2 page.');
  }
  if (!config.discordClientSecret) fatal('config.json: "discordClientSecret" is empty.');
  if (!config.discordRedirectUri) fatal('config.json: "discordRedirectUri" is empty.');
  if (!/^wss?:\/\//.test(config.obsUrl)) fatal('config.json: "obsUrl" should look like ws://127.0.0.1:4455');
  return config;
}

const config = await loadConfig();

// ---------------------------------------------------------------------------
// The sync itself: Discord's mute state -> one OBS input
// ---------------------------------------------------------------------------

const obs = new OBSWebSocket();

let discordMuted = null; // what Discord's mic button says; null = not known yet
let micInput = null; // name of the OBS input we control; null = OBS not ready

// OBS never fails a pending request when its connection drops, so every call gets a time limit.
function obsCall(requestType, requestData) {
  return withTimeout(obs.call(requestType, requestData), 5_000, `no answer to ${requestType}`);
}

// Updates run strictly one after another, so quick toggles cannot overtake each other.
let obsQueue = Promise.resolve();
function syncObs() {
  obsQueue = obsQueue.then(applyToObs);
}

async function applyToObs() {
  if (micInput === null || discordMuted === null) return;
  const inputName = micInput;
  const inputMuted = discordMuted;
  try {
    const current = await obsCall('GetInputMute', { inputName });
    if (current.inputMuted === inputMuted) return;
    await obsCall('SetInputMute', { inputName, inputMuted });
    log(`OBS: "${inputName}" ${inputMuted ? 'muted' : 'unmuted'}`);
  } catch (err) {
    log(`OBS: could not update "${inputName}" (${err.message})`);
  }
}

function onVoiceSettings(settings) {
  if (typeof settings?.mute !== 'boolean') {
    // Never guess: a missing flag must not be read as "unmuted".
    status('format', 'Discord: voice settings arrived without a mute flag; leaving OBS as it is.');
    return;
  }
  // Deafening yourself in Discord also cuts your mic there, so it counts as muted.
  const muted = settings.mute || settings.deaf === true;
  if (muted === discordMuted) return; // some other voice setting changed
  discordMuted = muted;
  log(`Discord: ${muted ? 'muted' : 'unmuted'}`);
  syncObs();
}

// ---------------------------------------------------------------------------
// OBS side
// ---------------------------------------------------------------------------

function listInputs(inputs) {
  return inputs.map((input) => `    "${input.inputName}"   (${input.unversionedInputKind ?? input.inputKind})`).join('\n');
}

// Returns the name of the one input this bridge may touch, or stops with instructions.
async function findMicInput() {
  const { inputs } = await obsCall('GetInputList');

  if (config.obsMicInput) {
    try {
      await obsCall('GetInputMute', { inputName: config.obsMicInput });
      return config.obsMicInput;
    } catch (err) {
      if (err.code !== 600) throw err; // 600 = OBS has no input with that name
      throw fatalError(
        `OBS has no audio input named "${config.obsMicInput}".\n` +
          `Set "obsMicInput" in config.json to one of these names (exact spelling):\n${listInputs(inputs)}`,
      );
    }
  }

  // No name given: only go ahead if there is exactly one microphone-type input.
  const special = await obsCall('GetSpecialInputs'); // the devices from Settings -> Audio
  const candidates = new Set([special.mic1, special.mic2, special.mic3, special.mic4].filter(Boolean));
  for (const input of inputs) {
    if (/_input_capture$/.test(input.unversionedInputKind ?? '')) candidates.add(input.inputName);
  }
  if (candidates.size === 1) return [...candidates][0];

  const found = inputs.filter((input) => candidates.has(input.inputName));
  throw fatalError(
    candidates.size === 0
      ? `Could not tell which OBS input is your microphone.\nSet "obsMicInput" in config.json to one of these names:\n${listInputs(inputs)}`
      : `OBS has more than one microphone input.\nSet "obsMicInput" in config.json to the one this bridge should control:\n${listInputs(found)}`,
  );
}

// While OBS is still loading it answers every request with code 207: wait on the same connection.
async function findMicInputWhenReady() {
  for (;;) {
    try {
      return await findMicInput();
    } catch (err) {
      if (err.code !== 207) throw err;
      status('obs', 'OBS: still starting up, waiting...');
      await sleep(2_000);
    }
  }
}

function describeObsError(err) {
  if (err.code === -1 || err.code === 1006) {
    return `OBS: not reachable at ${config.obsUrl} (is OBS running, with its WebSocket server enabled?). Will keep trying...`;
  }
  return `OBS: ${err.message || `connection failed (code ${err.code})`}. Will keep trying...`;
}

async function runObs() {
  // A different scene collection has its own inputs and mute states: look again.
  obs.on('CurrentSceneCollectionChanged', async () => {
    try {
      micInput = await findMicInput();
      syncObs();
    } catch (err) {
      micInput = null;
      log(`OBS: ${err.message}`);
    }
  });

  for (;;) {
    let onClosed;
    const closed = new Promise((resolve) => {
      onClosed = resolve;
      obs.once('ConnectionClosed', onClosed);
    });
    try {
      await withTimeout(
        obs.connect(config.obsUrl, config.obsPassword || undefined, {
          rpcVersion: 1,
          eventSubscriptions: EventSubscription.Config,
        }),
        10_000,
        'no answer from OBS',
      );
      micInput = await findMicInputWhenReady();
      status('obs', `OBS: connected. Controlling "${micInput}" and nothing else.`);
      syncObs();
      await closed;
      status('obs', 'OBS: connection closed. Waiting for OBS to come back...');
    } catch (err) {
      obs.off('ConnectionClosed', onClosed);
      if (err.fatal) fatal(err.message);
      if (err.code === 4009) {
        fatal('OBS rejected the password. Copy it from Tools -> WebSocket Server Settings -> Show Connect Info into "obsPassword" in config.json.');
      }
      status('obs', describeObsError(err));
      await obs.disconnect().catch(() => {});
    }
    micInput = null;
    await sleep(RETRY_MS);
  }
}

// ---------------------------------------------------------------------------
// Discord side: a minimal client for Discord's local RPC socket
// ---------------------------------------------------------------------------

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

// Discord answered a command with an error.
class DiscordRpcError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DiscordRpcError';
    this.code = code;
  }
}

// Where the desktop app listens: a named pipe on Windows, a Unix socket elsewhere.
function discordSocketPaths() {
  const ids = [...Array(10).keys()];
  if (process.platform === 'win32') return ids.map((id) => `\\\\?\\pipe\\discord-ipc-${id}`);

  const { XDG_RUNTIME_DIR, TMPDIR, TMP, TEMP } = process.env;
  const base = XDG_RUNTIME_DIR || TMPDIR || TMP || TEMP || '/tmp';
  const dirs = [base];
  if (process.platform === 'linux') {
    dirs.push(path.join(base, 'snap.discord'));
    for (const app of ['Discord', 'DiscordCanary', 'DiscordPTB']) {
      dirs.push(path.join(base, 'app', `com.discordapp.${app}`)); // Flatpak
    }
  }
  return dirs.flatMap((dir) => ids.map((id) => path.join(dir, `discord-ipc-${id}`)));
}

// Resolves with { socket }, or with { code } (the error code) if nothing could be opened there.
function openSocket(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.on('error', (err) => resolve({ code: err.code })); // later errors are followed by 'close'
    socket.once('connect', () => resolve({ socket }));
  });
}

class DiscordIpc extends EventEmitter {
  #socket;
  #buffer = Buffer.alloc(0);
  #pending = new Map(); // nonce -> { resolve, reject }
  #closeError = null;

  static async connect(clientId) {
    // noConnection: nothing was opened, so this attempt does not count against Discord's limit.
    let lastError = Object.assign(new Error('desktop app not found (is Discord running?)'), { noConnection: true });
    for (const socketPath of discordSocketPaths()) {
      const { socket, code } = await openSocket(socketPath);
      if (code === 'EPERM' || code === 'EACCES') {
        lastError = Object.assign(
          new Error('not allowed to open the desktop app\'s pipe (run Discord and this terminal both as administrator, or both not)'),
          { noConnection: true },
        );
      }
      if (!socket) continue;
      const ipc = new DiscordIpc(socket);
      try {
        ipc.user = await ipc.#handshake(clientId);
        return ipc;
      } catch (err) {
        ipc.close();
        if (err.fatal) throw err;
        lastError = err; // something else answered on this socket: try the next one
      }
    }
    throw lastError;
  }

  constructor(socket) {
    super();
    this.#socket = socket;
    this.closed = new Promise((resolve) => socket.once('close', resolve));
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.once('close', () => {
      for (const { reject } of this.#pending.values()) reject(this.#connectionError());
      this.#pending.clear();
    });
  }

  #connectionError() {
    return this.#closeError ?? new Error('connection closed');
  }

  #handshake(clientId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('no answer to the handshake'));
        this.close();
      }, 90_000); // connections over Discord's limit are answered late, not refused
      this.once('READY', (data) => {
        clearTimeout(timer);
        resolve(data?.user ?? {});
      });
      this.closed.then(() => {
        clearTimeout(timer);
        reject(this.#connectionError());
      });
      this.#send(OP.HANDSHAKE, { v: 1, client_id: clientId });
    });
  }

  // Sends a command and resolves with the "data" of Discord's answer.
  request(cmd, args = {}, evt, timeoutMs = 15_000) {
    if (this.#socket.destroyed) return Promise.reject(this.#connectionError());
    return new Promise((resolve, reject) => {
      const nonce = randomUUID();
      const timer =
        timeoutMs === Infinity
          ? undefined
          : setTimeout(() => {
              this.#pending.delete(nonce);
              reject(new Error(`no answer to ${cmd}`));
            }, timeoutMs);
      this.#pending.set(nonce, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      this.#send(OP.FRAME, { cmd, args, evt, nonce });
    });
  }

  close() {
    this.#socket.destroy();
  }

  // Every packet is: opcode (uint32 LE), body length (uint32 LE), JSON body.
  #send(op, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    const header = Buffer.alloc(8);
    header.writeUInt32LE(op, 0);
    header.writeUInt32LE(body.length, 4);
    this.#socket.write(Buffer.concat([header, body]));
  }

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 8) {
      const op = this.#buffer.readUInt32LE(0);
      const length = this.#buffer.readUInt32LE(4);
      if (this.#buffer.length < 8 + length) return; // rest of the packet has not arrived yet
      const body = this.#buffer.subarray(8, 8 + length).toString();
      this.#buffer = this.#buffer.subarray(8 + length);
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      this.#onPacket(op, message);
    }
  }

  #onPacket(op, message) {
    if (op === OP.PING) return this.#send(OP.PONG, message);
    if (op === OP.CLOSE) {
      // Discord is hanging up and says why, e.g. { code: 4000, message: "Invalid Client ID" }.
      const badClientId = message?.code === 4000;
      this.#closeError = Object.assign(
        new Error(
          `Discord refused the connection: ${message?.message} (code ${message?.code})` +
            (badClientId ? '\nCheck "discordClientId" in config.json.' : ''),
        ),
        { fatal: badClientId },
      );
      return this.close();
    }
    if (op !== OP.FRAME || !message) return;

    if (message.cmd === 'DISPATCH') {
      this.emit(message.evt, message.data); // an event, e.g. READY or VOICE_SETTINGS_UPDATE
      return;
    }
    const pending = this.#pending.get(message.nonce);
    if (!pending) return;
    this.#pending.delete(message.nonce);
    if (message.evt === 'ERROR') {
      pending.reject(new DiscordRpcError(message.data?.message ?? 'unknown error', message.data?.code));
    } else {
      pending.resolve(message.data);
    }
  }
}

// ---------------------------------------------------------------------------
// Discord login (OAuth2). The token is saved so the Authorize prompt shows once.
// ---------------------------------------------------------------------------

async function loadToken() {
  try {
    const token = JSON.parse(await readFile(TOKEN_FILE, 'utf8'));
    const usable = token.client_id === config.discordClientId && token.scope === DISCORD_SCOPES.join(' ');
    return usable ? token : null;
  } catch {
    return null;
  }
}

async function requestToken(grant) {
  let response;
  try {
    response = await fetch(DISCORD_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({
        client_id: config.discordClientId,
        client_secret: config.discordClientSecret,
        ...grant,
      }),
    });
  } catch (err) {
    throw new Error(`could not reach discord.com (${err.cause?.code ?? err.message})`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = [body.error, body.error_description].filter(Boolean).join(': ') || 'no details';
    throw Object.assign(new Error(`discord.com refused the token request (${response.status} ${detail})`), {
      oauth: body.error,
      status: response.status,
    });
  }
  const token = {
    client_id: config.discordClientId,
    scope: DISCORD_SCOPES.join(' '),
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + body.expires_in * 1000,
  };
  await writeFile(TOKEN_FILE, JSON.stringify(token, null, 2) + '\n', { mode: 0o600 });
  return token;
}

const SECRET_HINT = 'Check "discordClientSecret" in config.json against the OAuth2 page of your app (Reset Secret gives a new one).';

// Gets this connection authenticated, with as little bother as possible. Returns the token in use.
async function logIn(ipc) {
  const saved = await loadToken();

  // 1. A saved access token that is still good for a while.
  if (saved && saved.expires_at - Date.now() > RENEW_MARGIN_MS) {
    try {
      await ipc.request('AUTHENTICATE', { access_token: saved.access_token });
      return saved;
    } catch (err) {
      if (!(err instanceof DiscordRpcError)) throw err; // connection trouble: try again later
    }
  }

  // 2. Swap the saved refresh token for a new access token (no prompt).
  if (saved?.refresh_token) {
    try {
      const token = await requestToken({ grant_type: 'refresh_token', refresh_token: saved.refresh_token });
      await ipc.request('AUTHENTICATE', { access_token: token.access_token });
      return token;
    } catch (err) {
      if (err.oauth === 'invalid_client') throw fatalError(`${err.message}\n${SECRET_HINT}`);
      const loginExpired = err.oauth === 'invalid_grant' || err instanceof DiscordRpcError;
      if (!loginExpired) throw err;
    }
  }

  // 3. Ask. Discord shows an Authorize prompt and hands back a one-time code, which
  //    discord.com then swaps for a token. Over the years Discord has taken that swap
  //    both with and without the app's redirect, so use the documented form first and
  //    fall back to the other one (each try needs a fresh code, hence a second prompt).
  let refusal;
  for (const redirect of [{ redirect_uri: config.discordRedirectUri }, {}]) {
    const code = await authorize(ipc);
    let token;
    try {
      token = await requestToken({ grant_type: 'authorization_code', code, ...redirect });
    } catch (err) {
      if (err.oauth === 'invalid_client') throw fatalError(`${err.message}\n${SECRET_HINT}`);
      if (err.status !== 400) throw err; // not about the form of the request: try again later
      refusal = err;
      if ('redirect_uri' in redirect) {
        log(`Discord: sign-in refused (${err.message}). Trying the other form; click "Authorize" again if Discord asks.`);
      }
      continue;
    }
    try {
      await ipc.request('AUTHENTICATE', { access_token: token.access_token });
      return token;
    } catch (err) {
      if (!(err instanceof DiscordRpcError)) throw err;
      throw fatalError(`Discord did not accept the new login: ${err.message}`);
    }
  }
  throw fatalError(
    `${refusal.message}\n` +
      `Check that the app's OAuth2 page lists this redirect, spelled exactly like this:  ${config.discordRedirectUri}`,
  );
}

// Shows the Authorize prompt inside Discord and returns the one-time code.
async function authorize(ipc) {
  log('Discord: waiting for you to click "Authorize" in the Discord window (bring Discord to the front if no prompt shows)...');
  let answer;
  try {
    // Only these two fields. Discord uses the app's registered redirect by itself and
    // refuses the request outright if one is sent along. No time limit: the user decides.
    answer = await ipc.request('AUTHORIZE', { client_id: config.discordClientId, scopes: DISCORD_SCOPES }, undefined, Infinity);
  } catch (err) {
    if (!(err instanceof DiscordRpcError)) throw err;
    throw fatalError(
      `Discord did not authorize the bridge: ${err.message}\n` +
        'If that message mentions\n' +
        `  redirect       the app's OAuth2 page needs a saved redirect: Redirects -> add  ${config.discordRedirectUri}  -> Save Changes\n` +
        '  invalid_scope  Discord is logged in to a different account than the one that created the app\n' +
        '  access_denied  the prompt was cancelled: start the bridge again and click Authorize',
    );
  }
  if (typeof answer?.code !== 'string' || !answer.code) throw new Error('Discord returned no authorization code');
  return answer.code;
}

async function runDiscord() {
  let failures = 0; // sessions in a row that ended before they were up and running
  for (;;) {
    let ipc;
    let renewTimer;
    let pause = RETRY_MS;
    const slow = setTimeout(() => {
      status('discord', 'Discord: waiting for Discord to accept the connection (it makes apps that connect often wait up to a minute)...');
    }, 5_000);
    try {
      ipc = await DiscordIpc.connect(config.discordClientId);
      clearTimeout(slow);
      const token = await logIn(ipc);
      status('discord', `Discord: connected as ${ipc.user.global_name ?? ipc.user.username ?? 'you'}. Watching the mute button.`);

      // Subscribe first, then read the current state, so no change slips in between.
      // If a change event has already arrived by the time the read is answered,
      // the event is the newer of the two and the answer is dropped.
      let gotEvent = false;
      ipc.on('VOICE_SETTINGS_UPDATE', (settings) => {
        gotEvent = true;
        // The event carries the new state. Should a Discord build leave the mute flag out, ask for it.
        if (typeof settings?.mute === 'boolean') onVoiceSettings(settings);
        else ipc.request('GET_VOICE_SETTINGS').then(onVoiceSettings, () => {});
      });
      await ipc.request('SUBSCRIBE', {}, 'VOICE_SETTINGS_UPDATE');
      const settings = await ipc.request('GET_VOICE_SETTINGS');
      if (!gotEvent) onVoiceSettings(settings);
      failures = 0;

      // Shortly before the saved login runs out, reconnect so that logIn() renews it.
      let renewing = false;
      const renewIn = Math.max(token.expires_at - Date.now() - RENEW_MARGIN_MS, 60_000);
      renewTimer = setTimeout(() => {
        renewing = true;
        ipc.close();
      }, Math.min(renewIn, 2 ** 31 - 1));

      await ipc.closed;
      if (renewing) {
        log('Discord: renewing the saved login.');
        continue;
      }
      status('discord', 'Discord: connection closed. Waiting for Discord to come back...');
    } catch (err) {
      if (err.fatal) fatal(err.message);
      status('discord', `Discord: ${err.message}. Will keep trying...`);
      if (!err.noConnection) {
        failures += 1;
        pause = DISCORD_RETRY_MS[Math.min(failures, DISCORD_RETRY_MS.length) - 1];
      }
    } finally {
      clearTimeout(slow);
      clearTimeout(renewTimer);
      ipc?.close();
    }
    await sleep(pause);
  }
}

// ---------------------------------------------------------------------------

log('Discord -> OBS mute bridge running. Press Ctrl+C to stop.');
runObs().catch((err) => fatal(`OBS side stopped unexpectedly: ${err.stack}`));
runDiscord().catch((err) => fatal(`Discord side stopped unexpectedly: ${err.stack}`));
