# HellBot

An open-source Minecraft Nether navigation bot that automatically locates **Bastion Remnants** and **Nether Fortresses**, pathfinds through real Nether terrain, builds bridges across lava when necessary, and leaves a visible **magenta carpet trail** for players to follow.

Built using **Mineflayer** and **Baritone (ashfinder)**.

Check out how it works (the GIF may take a moment to load...):

<p align="center"> <img src="Assets/HellBot.gif" alt="GIF loading..." width="800"></p>

---

## Overview

Finding structures in the Nether can involve thousands of blocks of travel across difficult terrain.

HellBot automates the entire process by:

- Locating the nearest Bastion Remnant or Nether Fortress using Minecraft's `/locate` command.
- Teleporting to the requesting player.
- Calculating a traversable route through actual Nether terrain.
- Placing netherrack bridges across lava when required.
- Leaving a continuous magenta carpet trail using `block_display` entities.
- Providing simple chat commands for navigation and management.

Unlike coordinate-only tools, HellBot performs real pathfinding through the world, navigating cliffs, lava lakes, and natural terrain while continuously updating its route.

---

## Features

- Automatic LAN world discovery
- Bastion Remnant and Nether Fortress support
- Terrain-aware Nether pathfinding
- Automatic lava bridging using netherrack
- Magenta carpet breadcrumb trail
- Automatic Fire Resistance, Resistance, and Invisibility effects
- Automatic reconnection after disconnects
- Status reporting and cleanup commands
- Open source and designed for community contributions

---

## Requirements

- Minecraft Java Edition
- An Open-to-LAN world
- Operator permissions (`/op hellbot`)
- Node.js
- npm

---

## Installation

Clone the repository and install the required dependencies.

```bash
git clone https://github.com/pragyaangaur/HellBot.git
cd HellBot
npm install
```

---

## Running

Automatically discover an open LAN world:

```bash
node index.js
```

Or connect directly to a known LAN port:

```bash
node index.js <port>
```

Example:

```bash
node index.js 51234
```

Once the bot joins the game, run:

```mcfunction
/op hellbot
```

The bot will automatically configure the required gamerules before beginning navigation.

---

## Commands

| Command | Description |
|----------|-------------|
| `netherpathb` | Locate and navigate to the nearest Bastion Remnant |
| `netherpathf` | Locate and navigate to the nearest Nether Fortress |
| `hellstatus` | Display the current bot status |
| `hellstop` | Abort the current navigation and remove markers |
| `hellclean` | Remove all carpet markers without stopping the bot |

---

## How It Works

1. A player requests a destination through chat.
2. HellBot teleports to the player's position.
3. Minecraft's `/locate` command finds the nearest structure.
4. Baritone computes a traversable path through the Nether.
5. Netherrack is automatically placed whenever bridges are needed.
6. Magenta carpet markers are spawned along the path using `block_display` entities.
7. Players simply follow the trail to reach the destination.

---

## Current Limitations

HellBot is still under active development, and several improvements are planned:

- Proper dimension checking before navigation begins
- Better handling of unloaded chunks
- Improved hazard avoidance (Soul Sand, fire, etc.)
- Queueing multiple player navigation requests
- Support for additional Nether structures
- Smarter recovery from impossible paths
- Reduce chat being spammed with commands

If you'd like to contribute to any of these areas, pull requests are always welcome.
