'use strict';

/**
 * Hellbot - Minecraft Nether Pathfinder
 *
 * Locates a Bastion Remnant or Nether Fortress, pathfinds there through
 * actual Nether terrain (building netherrack bridges over lava when needed),
 * and leaves a magenta carpet trail via block_display entities.
 *
 * Commands (type in Minecraft chat):
 *   netherpathb  - Locate and path to the nearest Bastion Remnant
 *   netherpathf  - Locate and path to the nearest Nether Fortress
 *   hellstop     - Abort navigation and remove markers
 *   hellclean    - Remove markers only
 *   hellstatus   - Report current state and position
 *
 * Usage:
 *   node index.js          <- auto-discovers open LAN game
 *   node index.js <port>   <- connects to a specific port
 *
 * NOTE: Run /op hellbot in-game after the bot first joins.
 */

const dgram    = require('node:dgram');
const mineflayer = require('mineflayer');
const { loader: baritone, goals: { GoalNear } } = require('@miner-org/mineflayer-baritone');
const { Vec3 } = require('vec3');

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = Object.freeze({
  // Drop a carpet marker every N horizontal blocks of travel.
  MARKER_INTERVAL_BLOCKS: 3,

  // How long (ms) to wait for /locate before giving up.
  LOCATE_TIMEOUT_MS: 20_000,

  // Reconnect settings after kick/disconnect.
  RECONNECT_DELAY_MS: 5_000,
  MAX_RECONNECT_ATTEMPTS: 10,

  // Pathfinder safety: prevent the bot from falling more than N blocks in one step.
  // Keeps it from leaping off Nether cliffs into lava seas.
  MAX_DROP_DOWN: 3,

  // Succeed when within this many blocks of the target.
  // Prevents GoalNear from failing when the located coordinate is inside a wall.
  GOAL_RADIUS_BLOCKS: 8,

  // How long (ms) to wait for LAN broadcast before giving up.
  LAN_DISCOVERY_TIMEOUT_MS: 60_000,
});

// ─────────────────────────────────────────────────────────────────────────────
// State machine
// ─────────────────────────────────────────────────────────────────────────────

const State = Object.freeze({
  IDLE:     'IDLE',
  LOCATING: 'LOCATING',
  PATHING:  'PATHING',
});

const runtime = {
  state:            State.IDLE,
  requestingPlayer: null,   // username who triggered navigation
  target:           null,   // { name, structureId, x, y, z }
  locateTimer:      null,   // timeout guard for /locate non-response
  lastMarkerPos:    null,   // Vec3 of last placed marker
};

let bot = null;
let reconnectAttempts = 0;

// ─────────────────────────────────────────────────────────────────────────────
// LAN auto-discovery
//
// Minecraft broadcasts LAN games via UDP multicast every ~1.5s.
// Format: [MOTD]...[/MOTD][AD]port[/AD]
// Multicast group: 224.0.2.60, port 4445
// ─────────────────────────────────────────────────────────────────────────────

function discoverLANPort() {
  return new Promise((resolve, reject) => {
    console.log(
      '[Hellbot] Listening for an open LAN game ' +
      `(up to ${CONFIG.LAN_DISCOVERY_TIMEOUT_MS / 1000}s)...\n` +
      '[Hellbot] In Minecraft: Esc → Open to LAN → Start LAN World'
    );

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('No open LAN game found. Open your world to LAN first.'));
    }, CONFIG.LAN_DISCOVERY_TIMEOUT_MS);

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.on('message', (msg) => {
      const portMatch = msg.toString('utf8').match(/\[AD\](\d+)\[\/AD\]/);
      if (!portMatch) return;

      const port = parseInt(portMatch[1], 10);
      clearTimeout(timer);
      socket.close();
      console.log(`[Hellbot] Found LAN game on port ${port}.`);
      resolve(port);
    });

    socket.bind(4445, '0.0.0.0', () => {
      try {
        socket.addMembership('224.0.2.60');
      } catch (err) {
        clearTimeout(timer);
        socket.close();
        reject(new Error('Failed to join LAN multicast group: ' + err.message));
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Bot factory
// ─────────────────────────────────────────────────────────────────────────────

function createBot(port) {
  bot = mineflayer.createBot({
    host: 'localhost',
    port,
    username: 'hellbot',
    // No version: auto-negotiate with the server.
  });

  bot.setMaxListeners(0);

  bot.loadPlugin(baritone);

  bot.once('spawn',       onSpawn);
  bot.on('chat',          onChat);
  bot.on('message',       onMessage);
  bot.on('move',          onMove);
  bot.on('death',         onDeath);

  bot.on('kicked', (reason) => {
    console.error('[Hellbot] Kicked:', reason);
    scheduleReconnect(port);
  });
  bot.on('error', (err) => {
    console.error('[Hellbot] Error:', err.message);
  });
  bot.on('end', (reason) => {
    console.log(`[Hellbot] Disconnected (${reason}).`);
    scheduleReconnect(port);
  });
}

function scheduleReconnect(port) {
  if (reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
    console.error('[Hellbot] Max reconnect attempts reached. Exiting.');
    process.exit(1);
  }
  reconnectAttempts++;
  console.log(
    `[Hellbot] Reconnecting in ${CONFIG.RECONNECT_DELAY_MS / 1000}s ` +
    `(${reconnectAttempts}/${CONFIG.MAX_RECONNECT_ATTEMPTS})...`
  );
  setTimeout(() => createBot(port), CONFIG.RECONNECT_DELAY_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// spawn
// ─────────────────────────────────────────────────────────────────────────────

function onSpawn() {
  console.log('[Hellbot] Spawned. Type /op hellbot in-game if you have not already.');
  reconnectAttempts = 0;
  resetState();

  // Suppress command output immediately on spawn, before any other commands run.
  // This is the root cause of the marker spam: if gamerule is set with any delay,
  // there is a window where /summon and /give produce visible chat output.
  // Setting it here, as the very first action, closes that window completely.
  bot.chat('/gamerule sendCommandFeedback false');
  bot.chat('/gamerule commandBlockOutput false');

  // Configure Nether-safe movements using Baritone pathfinder (ashfinder)
  bot.ashfinder.config.breakBlocks = true;
  bot.ashfinder.config.placeBlocks = true;
  bot.ashfinder.config.parkour = false;
  bot.ashfinder.config.maxFallDist = CONFIG.MAX_DROP_DOWN;
  bot.ashfinder.config.disposableBlocks = ['netherrack'];
  bot.ashfinder.config.blocksToAvoid = ['lava'];
  // Keep thinkTimeout low (e.g. 5s) so the bot begins moving quickly on a partial path
  // instead of standing still for a long time trying to compute the entire route at once.
  bot.ashfinder.config.thinkTimeout = 5000;

  // Bind ashfinder events here after it has been fully initialized by the plugin loader
  bot.ashfinder.on('goal-reach',  onGoalReached);
  bot.ashfinder.on('goal-reach-partial', () => {
    if (runtime.state === State.PATHING) {
      tellPlayer('Pathfinding: segment reached. Replanning...');
    }
  });
  bot.ashfinder.on('pathStarted', ({ path, status }) => {
    if (runtime.state === State.PATHING && status === 'noPath') {
      tellPlayer(
        'Pathfinding: no route found from current position. ' +
        'Route may be blocked by terrain. Retrying... Type hellstop to abort.'
      );
    }
  });

  console.log('[Hellbot] Ready. Commands: netherpathb, netherpathf, hellstop, hellclean, hellstatus');
}

// ─────────────────────────────────────────────────────────────────────────────
// chat
// ─────────────────────────────────────────────────────────────────────────────

function onChat(username, message) {
  if (username === bot.username) return;

  const msg = message.trim().toLowerCase();

  if (msg === 'netherpathb' || msg === 'netherpathf') {
    if (runtime.state !== State.IDLE) {
      tellPlayer(
        `Already navigating to ${runtime.target?.name}. Type 'hellstop' to abort first.`,
        username
      );
      return;
    }

    runtime.requestingPlayer = username;
    runtime.target = msg === 'netherpathb'
      ? { name: 'Bastion Remnant', structureId: 'bastion_remnant' }
      : { name: 'Nether Fortress',  structureId: 'fortress'        };

    beginSearch();
    return;
  }

  if (msg === 'hellstop') {
    if (runtime.state === State.IDLE) {
      tellPlayer('Not currently navigating.', username);
      return;
    }
    abortNavigation('Navigation aborted.');
    return;
  }

  if (msg === 'hellclean') {
    bot.chat('/kill @e[type=block_display,tag=hellpath]');
    tellPlayer('Carpet trail removed.', username);
    return;
  }

  if (msg === 'hellstatus') {
    if (runtime.state === State.IDLE) {
      tellPlayer('Idle. Use netherpathb or netherpathf to begin.', username);
    } else {
      const p = bot.entity.position;
      tellPlayer(
        `State: ${runtime.state} | Target: ${runtime.target?.name} | ` +
        `Bot: ${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}`,
        username
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Begin search + pathfinding sequence
// ─────────────────────────────────────────────────────────────────────────────

function beginSearch() {
  // Gamerule was already set to false in onSpawn, so all subsequent commands
  // are silent. No timing tricks needed here.

  // Bot survival effects (invisibility avoids Piglin aggression)
  bot.chat('/effect give @s minecraft:invisibility 999999 255 true');
  bot.chat('/effect give @s minecraft:fire_resistance 999999 255 true');
  bot.chat('/effect give @s minecraft:resistance 999999 4 true');

  // Player fire resistance so they can follow the trail safely
  bot.chat(`/effect give ${runtime.requestingPlayer} minecraft:fire_resistance 999999 255 true`);

  // Seed the bot with netherrack for bridging over lava gaps.
  // Silent because gamerule sendCommandFeedback is already false.
  bot.chat('/give @s minecraft:netherrack 1000');

  // Start from the player's position
  bot.chat(`/tp @s ${runtime.requestingPlayer}`);

  runtime.state = State.LOCATING;
  tellPlayer(`Ghost deployed. Locating ${runtime.target.name}...`);

  // If /locate never responds (wrong dimension, no cheats), reset cleanly.
  runtime.locateTimer = setTimeout(() => {
    if (runtime.state === State.LOCATING) {
      tellPlayer(
        '/locate timed out. Confirm you are in the Nether and /op hellbot was run. Resetting.'
      );
      resetState();
    }
  }, CONFIG.LOCATE_TIMEOUT_MS);

  // Small delay lets /tp resolve so /locate scans from the correct position
  setTimeout(() => {
    if (runtime.state === State.LOCATING) {
      bot.chat(`/locate structure minecraft:${runtime.target.structureId}`);
    }
  }, 500);
}

// ─────────────────────────────────────────────────────────────────────────────
// message (parse /locate output)
// ─────────────────────────────────────────────────────────────────────────────

function onMessage(jsonMsg) {
  if (runtime.state !== State.LOCATING) return;

  const text = jsonMsg.toString();

  // /locate returned "not found"
  if (/could not be found/i.test(text) || /no .+ was found/i.test(text)) {
    clearLocateTimer();
    tellPlayer(
      `${runtime.target.name} not found in search range. ` +
      'Explore the Nether further then try again.'
    );
    resetState();
    return;
  }

  // /locate success: "The nearest X is at [X, ~ or Y, Z]"  (1.19+ format)
  const coordMatch = text.match(/\[(-?\d+),\s*(~|-?\d+),\s*(-?\d+)\]/);
  if (!coordMatch) return;

  clearLocateTimer();

  const tx = parseInt(coordMatch[1], 10);
  const tz = parseInt(coordMatch[3], 10);

  // When y is ~, the structure is at the same y as the bot's current scan point.
  // Clamp to a safe Nether range (above lava sea at y=31, below bedrock at y=123).
  const locatedY = coordMatch[2] === '~'
    ? Math.floor(bot.entity.position.y)
    : parseInt(coordMatch[2], 10);
  const ty = Math.max(35, Math.min(115, locatedY));

  runtime.target.x = tx;
  runtime.target.y = ty;
  runtime.target.z = tz;

  const hDist = Math.round(Math.hypot(bot.entity.position.x - tx, bot.entity.position.z - tz));
  tellPlayer(
    `${runtime.target.name} found at X=${tx} Z=${tz} (~${hDist} blocks away). ` +
    'Pathfinding now. Follow the magenta carpet trail.'
  );

  runtime.state = State.PATHING;
  runtime.lastMarkerPos = null;

  bot.ashfinder.goto(new GoalNear(new Vec3(tx, ty, tz), CONFIG.GOAL_RADIUS_BLOCKS)).catch(err => {
    console.error('[Hellbot] Pathfinder error:', err.message);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// move (carpet trail markers)
// ─────────────────────────────────────────────────────────────────────────────

function onMove() {
  if (runtime.state !== State.PATHING) return;

  const pos = bot.entity.position;

  // Throttle by horizontal distance to avoid placing markers during
  // vertical movement (climbing netherrack towers, descending, etc.)
  if (runtime.lastMarkerPos) {
    const hDist = Math.hypot(
      pos.x - runtime.lastMarkerPos.x,
      pos.z - runtime.lastMarkerPos.z
    );
    if (hDist < CONFIG.MARKER_INTERVAL_BLOCKS) return;
  }

  // Find the solid block the bot is standing on.
  // bot.entity.position is the bot's feet; offset -0.1 puts us just inside
  // the block below, which blockAt() returns.
  const blockBelow = bot.blockAt(pos.offset(0, -0.1, 0));
  if (!blockBelow) return;

  // Don't mark over lava or air (bot is mid-fall or on an unsafe surface)
  const n = blockBelow.name;
  if (n === 'lava' || n === 'air' || n === 'void_air') return;

  // Place the marker at the top face of the block the bot is standing on.
  // blockBelow.position.y + 1 gives the surface level.
  const mx = Math.floor(pos.x);
  const my = blockBelow.position.y + 1;
  const mz = Math.floor(pos.z);

  // block_display is the correct entity for this use case:
  // - purely visual, no hitbox, no collision, no block updates
  // - can be bulk-removed via tag selector
  // - renders exactly like magenta carpet at the specified position
  // With gamerule sendCommandFeedback false (set on spawn), this produces zero chat output.
  bot.chat(
    `/summon block_display ${mx} ${my} ${mz} ` +
    `{Tags:["hellpath"],block_state:{Name:"minecraft:magenta_carpet"}}`
  );

  runtime.lastMarkerPos = pos.clone();

  // Refill netherrack silently if running low on bridging material.
  // The give command is silent because sendCommandFeedback is already false.
  const netherrack = bot.inventory.items().find(i => i.name === 'netherrack');
  if (!netherrack || netherrack.count < 200) {
    bot.chat('/give @s minecraft:netherrack 1000');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// goal_reached
// ─────────────────────────────────────────────────────────────────────────────

function onGoalReached() {
  if (runtime.state !== State.PATHING) return;

  tellPlayer(
    `Arrived at ${runtime.target.name}! ` +
    "Trail is live. Type 'hellclean' to remove markers when done."
  );

  runtime.state = State.IDLE;
  runtime.target = null;
  runtime.lastMarkerPos = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// death
// ─────────────────────────────────────────────────────────────────────────────

function onDeath() {
  console.log('[Hellbot] Died. Resetting state.');
  clearLocateTimer();
  if (runtime.requestingPlayer) {
    tellPlayer('Hellbot died. State reset. Run the command again to restart.');
  }
  // Partial trail remains so the player can still follow it to the last position.
  // hellclean removes it when desired.
  resetState();
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function abortNavigation(reason) {
  if (bot?.ashfinder) {
    try { bot.ashfinder.stop(); } catch (_) {}
  }
  bot.chat('/kill @e[type=block_display,tag=hellpath]');
  tellPlayer(reason);
  resetState();
}

function resetState() {
  clearLocateTimer();
  if (bot?.ashfinder) {
    try { bot.ashfinder.stop(); } catch (_) {}
  }
  runtime.state            = State.IDLE;
  runtime.requestingPlayer = null;
  runtime.target           = null;
  runtime.locateTimer      = null;
  runtime.lastMarkerPos    = null;
}

function clearLocateTimer() {
  if (runtime.locateTimer) {
    clearTimeout(runtime.locateTimer);
    runtime.locateTimer = null;
  }
}

/**
 * Send a message to a specific player (or the requesting player if omitted).
 */
function tellPlayer(message, recipient) {
  const target = recipient ?? runtime.requestingPlayer;
  if (target) {
    bot.chat(`/msg ${target} [Hellbot] ${message}`);
  } else {
    bot.chat(`[Hellbot] ${message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

const rawPort = process.argv[2];

if (rawPort) {
  // Direct port provided: connect immediately
  const port = parseInt(rawPort, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error('Error: Invalid port.');
    console.error('Usage: node index.js [LAN_PORT]');
    process.exit(1);
  }
  console.log(`[Hellbot] Connecting to localhost:${port}...`);
  createBot(port);
} else {
  // No port: auto-discover open LAN game via UDP multicast
  discoverLANPort()
    .then(port => createBot(port))
    .catch(err => {
      console.error('[Hellbot]', err.message);
      process.exit(1);
    });
}
