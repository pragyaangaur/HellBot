const { Vec3 } = require("vec3");
const assert = require("assert");
const math = require("mineflayer/lib/math");
const conv = require("mineflayer/lib/conversions");
const { performance } = require("perf_hooks");
const { createDoneTask, createTask } = require("mineflayer/lib/promise_utils");

const { PhysicsEngine, PlayerState } = require("./src/engine.js");

module.exports = inject;

const PI = Math.PI;
const PI_2 = Math.PI * 2;
const PHYSICS_INTERVAL_MS = 50;
const PHYSICS_TIMESTEP = PHYSICS_INTERVAL_MS / 1000; // 0.05

/**
 * @param {import('mineflayer').Bot} bot
 */
function inject(bot) {
  // Disable mineflayer's built-in physics
  bot.physicsEnabled = false;
  bot._client.on("position", () => {
    bot.physicsEnabled = false;
  });

  const world = {
    getBlock: (pos) => bot.blockAt(pos, false),
  };

  const physics = new PhysicsEngine(bot.registry, world);

  const positionUpdateSentEveryTick = bot.supportFeature(
    "positionUpdateSentEveryTick",
  );

  // Jump state
  bot.jumpQueued = false;
  bot.jumpTicks = 0;

  // Control state
  const controlState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false,
  };

  // Look state
  let lastSentYaw = null;
  let lastSentPitch = null;

  // Physics timing
  let doPhysicsTimer = null;

  // Physics enabled flags
  let shouldUsePhysics = false;
  bot.ashPhysicsEnabled = true;
  let deadTicks = 21;

  // Last sent packet data
  const lastSent = {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    onGround: false,
    time: 0,
    flags: { onGround: false, hasHorizontalCollision: false },
  };

  function doPhysics() {
    const now = performance.now();
    tickPhysics(now);
  }

  function tickPhysics(now) {
    // Skip if chunk is unloaded
    if (bot.blockAt(bot.entity.position) == null) return;

    if (bot.ashPhysicsEnabled && shouldUsePhysics) {
      const state = new PlayerState(bot, controlState);

      physics.simulatePlayer(state);
      state.apply(bot);

      bot.emit("physicsTick");
      bot.emit("physicTick"); // Deprecated
    }

    if (shouldUsePhysics) {
      updatePosition(now);
    }
  }

  /**
   * Update position and send packets to server
   */
  function updatePosition(now) {
    if (isEntityRemoved()) return;

    const dYaw = deltaYaw(bot.entity.yaw, lastSentYaw);
    const dPitch = bot.entity.pitch - (lastSentPitch || 0);

    const maxDeltaYaw = PHYSICS_TIMESTEP * physics.constants.yawSpeed;
    const maxDeltaPitch = PHYSICS_TIMESTEP * physics.constants.pitchSpeed;
    lastSentYaw += math.clamp(-maxDeltaYaw, dYaw, maxDeltaYaw);
    lastSentPitch += math.clamp(-maxDeltaPitch, dPitch, maxDeltaPitch);

    const yaw = Math.fround(conv.toNotchianYaw(lastSentYaw));
    const pitch = Math.fround(conv.toNotchianPitch(lastSentPitch));
    const position = bot.entity.position;
    const onGround = bot.entity.onGround;

    const positionUpdated =
      lastSent.x !== position.x ||
      lastSent.y !== position.y ||
      lastSent.z !== position.z ||
      Math.round((now - lastSent.time) / PHYSICS_INTERVAL_MS) *
        PHYSICS_INTERVAL_MS >=
        1000;

    const lookUpdated = lastSent.yaw !== yaw || lastSent.pitch !== pitch;

    if (positionUpdated && lookUpdated) {
      sendPacketPositionAndLook(position, yaw, pitch, onGround);
      lastSent.time = now;
    } else if (positionUpdated) {
      sendPacketPosition(position, onGround);
      lastSent.time = now;
    } else if (lookUpdated) {
      sendPacketLook(yaw, pitch, onGround);
    } else if (positionUpdateSentEveryTick || onGround !== lastSent.onGround) {
      bot._client.write("flying", {
        onGround: bot.entity.onGround,
        flags: {
          onGround: bot.entity.onGround,
          hasHorizontalCollision: undefined,
        },
      });
    }

    lastSent.onGround = bot.entity.onGround;
  }

  function sendPacketPosition(position, onGround) {
    const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z);
    lastSent.x = position.x;
    lastSent.y = position.y;
    lastSent.z = position.z;
    lastSent.onGround = onGround;
    lastSent.flags = { onGround, hasHorizontalCollision: undefined };
    bot._client.write("position", lastSent);
    bot.emit("move", oldPos);
  }

  function sendPacketLook(yaw, pitch, onGround) {
    const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z);
    lastSent.yaw = yaw;
    lastSent.pitch = pitch;
    lastSent.onGround = onGround;
    lastSent.flags = { onGround, hasHorizontalCollision: undefined };
    bot._client.write("look", lastSent);
    bot.emit("move", oldPos);
  }

  function sendPacketPositionAndLook(position, yaw, pitch, onGround) {
    const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z);
    lastSent.x = position.x;
    lastSent.y = position.y;
    lastSent.z = position.z;
    lastSent.yaw = yaw;
    lastSent.pitch = pitch;
    lastSent.onGround = onGround;
    lastSent.flags = { onGround, hasHorizontalCollision: undefined };
    bot._client.write("position_look", lastSent);
    bot.emit("move", oldPos);
  }

  function deltaYaw(yaw1, yaw2) {
    let dYaw = (yaw1 - yaw2) % PI_2;
    if (dYaw < -PI) dYaw += PI_2;
    else if (dYaw > PI) dYaw -= PI_2;
    return dYaw;
  }

  function isEntityRemoved() {
    if (bot.isAlive === true) deadTicks = 0;
    if (bot.isAlive === false && deadTicks <= 20) deadTicks++;
    if (deadTicks >= 20) return true;
    return false;
  }

  function getEffectLevel(mcData, effectName, effects) {
    const effectDescriptor = mcData.effectsByName[effectName];
    if (!effectDescriptor) return 0;
    const effectInfo = effects[effectDescriptor.id];
    if (!effectInfo) return 0;
    return effectInfo.amplifier + 1;
  }

  function cleanup() {
    clearInterval(doPhysicsTimer);
    doPhysicsTimer = null;
  }

  // Expose physics engine to bot
  bot.ashPhysics = physics;

  bot.ashSetControlState = (control, state) => {
    assert.ok(control in controlState, `invalid control: ${control}`);
    assert.ok(typeof state === "boolean", `invalid state: ${state}`);
    if (controlState[control] === state) return;

    controlState[control] = state;

    if (control === "jump" && state) {
      bot.jumpQueued = true;
    } else if (control === "sprint") {
      bot._client.write("entity_action", {
        entityId: bot.entity.id,
        actionId: state ? 3 : 4,
        jumpBoost: 0,
      });
    } else if (control === "sneak") {
      bot._client.write("entity_action", {
        entityId: bot.entity.id,
        actionId: state ? 0 : 1,
        jumpBoost: 0,
      });
    }
  };

  bot.ashGetControlState = (control) => {
    assert.ok(control in controlState, `invalid control: ${control}`);
    return controlState[control];
  };

  bot.ashClearControlStates = () => {
    for (const control in controlState) {
      bot.ashSetControlState(control, false);
    }
  };

  bot.ashControlState = {};
  for (const control of Object.keys(controlState)) {
    Object.defineProperty(bot.ashControlState, control, {
      get() {
        return controlState[control];
      },
      set(state) {
        bot.ashSetControlState(control, state);
        return state;
      },
    });
  }

  let lookingTask = createDoneTask();

  bot.on("move", () => {
    if (
      !lookingTask.done &&
      Math.abs(deltaYaw(bot.entity.yaw, lastSentYaw)) < 0.001
    ) {
      lookingTask.finish();
    }
  });

  bot.look = async (yaw, pitch, force) => {
    if (!lookingTask.done) {
      lookingTask.finish();
    }
    lookingTask = createTask();

    const sensitivity = conv.fromNotchianPitch(0.15);
    const yawChange =
      Math.round((yaw - bot.entity.yaw) / sensitivity) * sensitivity;
    const pitchChange =
      Math.round((pitch - bot.entity.pitch) / sensitivity) * sensitivity;

    if (yawChange === 0 && pitchChange === 0) {
      return;
    }

    bot.entity.yaw += yawChange;
    bot.entity.pitch += pitchChange;

    if (force) {
      lastSentYaw = yaw;
      lastSentPitch = pitch;
      return;
    }

    await lookingTask.promise;
  };

  bot.lookAt = async (point, force) => {
    const delta = point.minus(
      bot.entity.position.offset(0, bot.entity.eyeHeight, 0),
    );
    const yaw = Math.atan2(-delta.x, -delta.z);
    const groundDistance = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
    const pitch = Math.atan2(delta.y, groundDistance);
    await bot.look(yaw, pitch, force);
  };

  bot.elytraFly = async () => {
    if (bot.entity.elytraFlying) {
      throw new Error("Already elytra flying");
    } else if (bot.entity.onGround) {
      throw new Error("Unable to fly from ground");
    } else if (bot.entity.isInWater) {
      throw new Error("Unable to elytra fly while in water");
    }

    const mcData = require("minecraft-data")(bot.version);
    if (getEffectLevel(mcData, "Levitation", bot.entity.effects) > 0) {
      throw new Error("Unable to elytra fly with levitation effect");
    }

    const torsoSlot = bot.getEquipmentDestSlot("torso");
    const item = bot.inventory.slots[torsoSlot];
    if (item == null || item.name !== "elytra") {
      throw new Error("Elytra must be equipped to start flying");
    }

    bot._client.write("entity_action", {
      entityId: bot.entity.id,
      actionId: 8,
      jumpBoost: 0,
    });
  };

  bot.waitForTicks = async function (ticks) {
    if (ticks <= 0) return;

    await new Promise((resolve) => {
      const tickListener = () => {
        ticks--;
        if (ticks === 0) {
          bot.removeListener("physicsTick", tickListener);
          resolve();
        }
      };
      bot.on("physicsTick", tickListener);
    });
  };

  // Deprecated event warning
  bot.on("newListener", (name) => {
    if (name === "physicTick") {
      console.warn(
        "Mineflayer: You are using a deprecated event (physicTick)! Use physicsTick instead.",
      );
    }
  });

  // Track crawling/pose state from server-confirmed entity metadata
  bot._client.on("entity_metadata", (packet) => {
    if (!bot.entity || packet.entityId !== bot.entity.id) return;

    const entity = bot.entity;

    if (bot.supportFeature("mcDataHasEntityMetadata")) {
      const metadataKeys =
        bot.registry.entitiesByName[entity.name]?.metadataKeys;
      if (!metadataKeys) return;

      const metas = Object.fromEntries(
        packet.metadata.map((e) => [metadataKeys[e.key], e.value]),
      );

      if (metas.pose != null) {
        entity._pose = metas.pose;
        entity.isElytra = metas.pose === 1;
        entity.isSwimmingPose = metas.pose === 3;
        entity.serverSideSneaking = metas.pose === 5;
        // Crawling is swimming pose but not in water
        entity.isCrawling = metas.pose === 3 && !entity.isInWater;

        bot.emit("botPoseUpdate", {
          pose: metas.pose,
          crawling: entity.isCrawling,
          swimming: entity.isSwimmingPose && entity.isInWater,
          elytra: entity.isElytra,
          trueSneaking: entity.serverSideSneaking,
        });
      }
    }
  });

  // Entity velocity — handles being pushed by players, mobs, minecarts, etc.
  //this shit does not work for mineflayer bots :(
  bot._client.on("entity_velocity", (packet) => {
    if (packet.entityId !== bot.entity.id) return;
    if (!bot.ashPhysicsEnabled) return;

    bot.entity.velocity.x += packet.velocityX / 8000;
    bot.entity.velocity.y += packet.velocityY / 8000;
    bot.entity.velocity.z += packet.velocityZ / 8000;
  });

  // Explosion knockbakc
  bot._client.on("explosion", (explosion) => {
    if (bot.ashPhysicsEnabled && bot.game.gameMode !== "creative") {
      if (explosion.playerKnockback) {
        // 1.21.3+
        bot.entity.velocity.add(
          explosion.playerMotionX,
          explosion.playerMotionY,
          explosion.playerMotionZ,
        );
      } else if ("playerMotionX" in explosion) {
        // older versions
        bot.entity.velocity.x += explosion.playerMotionX;
        bot.entity.velocity.y += explosion.playerMotionY;
        bot.entity.velocity.z += explosion.playerMotionZ;
      }
    }
  });

  // Handle player rotation packet (1.21.3+)
  bot._client.on("player_rotation", (packet) => {
    bot.entity.yaw = conv.fromNotchianYaw(packet.yaw);
    bot.entity.pitch = conv.fromNotchianPitch(packet.pitch);
  });

  // Handle position updates from server
  bot._client.on("position", (packet) => {
    bot.entity.height = 1.8;

    const vel = bot.entity.velocity;
    const pos = bot.entity.position;
    let newYaw, newPitch;

    if (bot.registry.version[">="]("1.21.3")) {
      const flags = packet.flags;
      vel.set(flags.x ? vel.x : 0, flags.y ? vel.y : 0, flags.z ? vel.z : 0);
      pos.set(
        flags.x ? pos.x + packet.x : packet.x,
        flags.y ? pos.y + packet.y : packet.y,
        flags.z ? pos.z + packet.z : packet.z,
      );
      newYaw =
        (flags.yaw ? conv.toNotchianYaw(bot.entity.yaw) : 0) + packet.yaw;
      newPitch =
        (flags.pitch ? conv.toNotchianPitch(bot.entity.pitch) : 0) +
        packet.pitch;
    } else {
      vel.set(
        packet.flags & 1 ? vel.x : 0,
        packet.flags & 2 ? vel.y : 0,
        packet.flags & 4 ? vel.z : 0,
      );
      pos.set(
        packet.flags & 1 ? pos.x + packet.x : packet.x,
        packet.flags & 2 ? pos.y + packet.y : packet.y,
        packet.flags & 4 ? pos.z + packet.z : packet.z,
      );
      newYaw =
        (packet.flags & 8 ? conv.toNotchianYaw(bot.entity.yaw) : 0) +
        packet.yaw;
      newPitch =
        (packet.flags & 16 ? conv.toNotchianPitch(bot.entity.pitch) : 0) +
        packet.pitch;
    }

    bot.entity.yaw = conv.fromNotchianYaw(newYaw);
    bot.entity.pitch = conv.fromNotchianPitch(newPitch);
    bot.entity.onGround = false;

    sendPacketPositionAndLook(pos, newYaw, newPitch, bot.entity.onGround);

    shouldUsePhysics = true;
    bot.jumpTicks = 0;
    lastSentYaw = bot.entity.yaw;
    lastSentPitch = bot.entity.pitch;

    bot.emit("forcedMove");
  });

  bot.on("mount", () => {
    shouldUsePhysics = false;
  });
  bot.on("respawn", () => {
    shouldUsePhysics = false;
  });

  bot.on("login", () => {
    shouldUsePhysics = false;
    lastSentYaw = bot.entity.yaw;
    lastSentPitch = bot.entity.pitch;
    if (doPhysicsTimer === null) {
      doPhysicsTimer = setInterval(doPhysics, PHYSICS_INTERVAL_MS);
    }
  });

  bot.on("end", cleanup);
}
