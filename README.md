# Discord-OBS mute sync
A script to mute the OBS mic whenever your mic in Discord is muted.

## Why I made this
I record online meetings on Discord using OBS. Whenever I mute my mic, I also want OBS to not record its input. 
I wanted to stop having to press two buttons every time I mute/unmute, so I came up with the idea to make this 
script.

## What it does
- Watches the mute button of the Discord desktop app and copies its state onto one OBS audio input (the microphone).
- Works in one direction only: Discord to OBS. Muting in OBS does not change Discord.
- Touches no other OBS input and never changes anything in Discord.
- Counts deafening yourself in Discord as muted, since Discord cuts your mic then too.
- Can be started by OBS itself, without a window, and stops when OBS closes.

## Requirements
- [Node.js](https://nodejs.org) 20 or newer
- OBS Studio 28 or newer (the WebSocket server is built in)
- The Discord desktop app (Discord in a browser does not work)
- A Discord account to create a free developer application with

## Setup

### 1. Create a Discord application
The script talks to your own Discord app through an application that you create once.

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Open the **OAuth2** page of the new application.
3. Copy the **Client ID**.
4. Click **Reset Secret** and copy the **Client Secret**. Treat it like a password.
5. Under **Redirects**, add `http://localhost` and click **Save Changes**.

Nothing ever opens that address, but Discord will not sign an application in unless a redirect is listed.
No bot and no bot token are needed.

### 2. Turn on the OBS WebSocket server
1. In OBS, open **Tools > WebSocket Server Settings**.
2. Tick **Enable WebSocket server**.
3. Click **Show Connect Info** to see the port and the password.

### 3. Install and configure
Put `bridge.js` and `package.json` in a folder, then run in that folder:

```
npm install
npm start
```

The first start creates `config.json` and stops. Fill it in:

| Setting | Meaning |
| --- | --- |
| `discordClientId` | Client ID from step 1, in quotes |
| `discordClientSecret` | Client Secret from step 1 |
| `discordRedirectUri` | The redirect from step 1. Leave it as `http://localhost` |
| `obsUrl` | Address of the OBS WebSocket server. The default is `ws://127.0.0.1:4455` |
| `obsPassword` | Password from step 2. Leave it empty if authentication is off |
| `obsMicInput` | Name of the microphone input in the OBS Audio Mixer. Leave it empty to auto-detect |

### 4. Run it
```
npm start
```

The first time, a prompt appears inside the Discord window. Click **Authorize**. Bring Discord to the
front if you do not see the prompt. After that the login is saved in `discord-token.json` and Discord
does not ask again.

The terminal shows what happens:

```
[9:51:26 PM] OBS: connected. Controlling "Mic/Aux" and nothing else.
[9:51:27 PM] Discord: connected as [Name]. Watching the mute button.
[9:51:29 PM] Discord: muted
[9:51:29 PM] OBS: "[Mic Name]" muted
```

Press Ctrl+C to stop it.

### 5. Optional: let OBS start it
Once it works, OBS can start the script for you so that no terminal is needed.

1. Stop the script if it is running.
2. Run `node bridge.js --make-obs-script`. It writes `start-bridge-with-obs.lua`.
3. In OBS, open **Tools > Scripts**, click **+** and choose that file.

From then on:
- OBS starts the script, without a window, every time OBS starts.
- The script stops when OBS closes.
- If Discord is closed while OBS is open, the script waits and picks up again when Discord is back.
- What it does is written to `bridge.log` in the same folder, fresh for each OBS session.
- The Scripts window has a **Start the bridge now** button in case it stopped while OBS stayed open.

Run step 2 again if you move the folder or reinstall Node.js, because the paths are written into the Lua file.

## How it works
The script is a small bridge between two local APIs.

```
Discord desktop app  --(local RPC socket)-->  bridge.js  --(WebSocket)-->  OBS
   mute button                                                        mic input mute
```

### Discord side
The Discord desktop app serves a local RPC API on a socket: a named pipe on Windows
(`\\?\pipe\discord-ipc-0` to `-9`) and a Unix socket on macOS and Linux. Every packet is an opcode
(uint32, little-endian), a body length (uint32, little-endian) and a JSON body. `bridge.js` contains
its own minimal client for this protocol and does the following:

1. **Handshake.** It sends the client ID. Discord answers with a `READY` event.
2. **Login (OAuth2).** The `AUTHORIZE` command makes Discord show the Authorize prompt and return a
   one-time code. The script swaps that code for an access token at `discord.com/api/oauth2/token`,
   using the client secret, and sends the token back with `AUTHENTICATE`. The requested scopes are
   `rpc` and `identify`.
3. **Watching.** It subscribes to the `VOICE_SETTINGS_UPDATE` event and reads the current state once
   with `GET_VOICE_SETTINGS`. Each event carries the `mute` and `deaf` flags.

The token is saved in `discord-token.json`. On later starts the script reuses it, renews it with the
refresh token when it is about to run out, and only asks for authorization again if Discord no longer
accepts either one.

### OBS side
OBS is controlled over its built-in WebSocket server (obs-websocket protocol 5) with the
[obs-websocket-js](https://github.com/obs-websocket-community-projects/obs-websocket-js) library.
The script reads the microphone's state with `GetInputMute` and changes it with `SetInputMute`.
Those are the only requests that write anything, and they always name the one microphone input.

### Choosing the microphone
If `obsMicInput` is empty, the script looks for microphone-type inputs: the devices set under
**Settings > Audio** and any Audio Input Capture source. If there is exactly one, it uses that one
and prints its name. If there are none or several, it stops and lists the names so you can put the
right one in `config.json`.

### Keeping the two in sync
- When Discord's state changes, the script compares it with OBS and changes OBS only if they differ.
- Updates to OBS run strictly one after another, so quick toggling cannot end in the wrong state.
- When OBS connects, or the scene collection changes, the current Discord state is applied again.
- A manual change in OBS is left alone until the next change in Discord.
- If Discord ever sends voice settings without a mute flag, the script leaves OBS as it is instead of guessing.

### Reconnecting
- The start order does not matter. The script waits for whichever app is missing.
- If OBS or Discord restarts, the script reconnects by itself (unless OBS started it, see step 5).
- Discord lets an application connect about twice a minute and makes further connections wait.
  After a failed session the pauses between attempts grow from 5 to 60 seconds.
- Only one copy of the script runs at a time. A second copy notices the first one and exits.

## Files
| File | Purpose |
| --- | --- |
| `bridge.js` | The script |
| `package.json` | Lists the one dependency, obs-websocket-js |
| `config.json` | Your settings. Contains the client secret |
| `discord-token.json` | The saved Discord login |
| `bridge.log` | Log of the current session when OBS started the script |
| `start-bridge-with-obs.lua` | The generated OBS script. Contains paths from your computer |

`config.json` and `discord-token.json` are secrets. If you put this folder in a Git repository, add
this `.gitignore`:

```
node_modules/
config.json
discord-token.json
bridge.log
start-bridge-with-obs.lua
```

## Troubleshooting
| Message | What to do |
| --- | --- |
| `OBS: not reachable` | Start OBS and check that the WebSocket server is enabled and `obsUrl` has the right port |
| `OBS rejected the password` | Copy the password from **Show Connect Info** into `obsPassword` |
| `OBS has more than one microphone input` | Put the name of the right one in `obsMicInput` |
| `Discord: desktop app not found` | Start the Discord desktop app |
| `Invalid Client ID` | Check `discordClientId` against the OAuth2 page |
| `invalid_client` | Check `discordClientSecret`. **Reset Secret** gives a new one |
| A message mentioning `redirect` | Add `http://localhost` under **Redirects** and click **Save Changes** |
| `invalid_scope` | Discord is logged in to a different account than the one that created the application |
| `waiting for Discord to accept the connection` | Normal after several quick restarts. It can take up to a minute |
| `The bridge is already running` | OBS started it. Look at `bridge.log` |
| Nothing happens after adding the OBS script | Open **Script Log** in the Scripts window and read `bridge.log` |