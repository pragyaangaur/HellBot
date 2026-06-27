const Vec3 = require("vec3").Vec3;
const AABB = require("./aabb.js");
const features = require("./features.json");
const attribute = require("./attribute.js");
const { clamp } = require("./util.js");

/**
 * Main physics engine class for Minecraft player movement simulation
 */
class PhysicsEngine {
  constructor(mcData, world) {
    this.mcData = mcData;
    this.world = world;
    this.blocksByName = mcData.blocksByName;

    // Cache supportFeature once instead of recreating every tick
    this.supportFeature = this._makeSupportFeature();

    // Initialize block IDs and properties
    this._initializeBlockData();

    // Initialize physics constants
    this._initializePhysicsConstants();
  }

  /**
   * Initialize block-specific data (IDs, slipperiness, etc.)
   */
  _initializeBlockData() {
    // Block slipperiness values
    this.blockSlipperiness = this._createSlipperinessMap();

    // Special block IDs
    this.specialBlocks = {
      soulsand: this.blocksByName.soul_sand.id,
      honeyblock: this.blocksByName.honey_block?.id ?? -1,
      web: this.blocksByName.cobweb?.id ?? this.blocksByName.web.id,
      ladder: this.blocksByName.ladder.id,
      vine: this.blocksByName.vine.id,
      bubbleColumn: this.blocksByName.bubble_column?.id ?? -1,
      slime: this.blocksByName.slime_block?.id ?? this.blocksByName.slime.id,
      scaffolding: this.blocksByName.scaffolding?.id ?? -1,
    };

    // Liquid IDs
    this.waterIds = [
      this.blocksByName.water.id,
      this.blocksByName.flowing_water?.id ?? -1,
    ];

    this.lavaIds = [
      this.blocksByName.lava.id,
      this.blocksByName.flowing_lava?.id ?? -1,
    ];

    // Water-like blocks (seagrass, kelp, etc.)
    this.waterLike = this._createWaterLikeSet();

    // Trapdoor IDs
    this.trapdoorIds = this._createTrapdoorSet();
  }

  /**
   * Create slipperiness map for blocks
   */
  _createSlipperinessMap() {
    const slipperiness = {};
    const blocks = this.blocksByName;

    const slimeBlockId = blocks.slime_block?.id ?? blocks.slime.id;
    slipperiness[slimeBlockId] = 0.8;
    slipperiness[blocks.ice.id] = 0.98;
    slipperiness[blocks.packed_ice.id] = 0.98;

    if (blocks.frosted_ice) slipperiness[blocks.frosted_ice.id] = 0.98;
    if (blocks.blue_ice) slipperiness[blocks.blue_ice.id] = 0.989;

    return slipperiness;
  }

  /**
   * Create set of water-like block IDs
   */
  _createWaterLikeSet() {
    const waterLike = new Set();
    const blocks = this.blocksByName;

    if (blocks.seagrass) waterLike.add(blocks.seagrass.id);
    if (blocks.tall_seagrass) waterLike.add(blocks.tall_seagrass.id);
    if (blocks.kelp) waterLike.add(blocks.kelp.id);
    if (blocks.kelp_plant) waterLike.add(blocks.kelp_plant.id);
    if (blocks.bubble_column) waterLike.add(blocks.bubble_column.id);

    return waterLike;
  }

  /**
   * Create set of trapdoor block IDs
   */
  _createTrapdoorSet() {
    const trapdoors = new Set();
    const blocks = this.blocksByName;

    const trapdoorTypes = [
      "iron_trapdoor",
      "acacia_trapdoor",
      "birch_trapdoor",
      "jungle_trapdoor",
      "oak_trapdoor",
      "dark_oak_trapdoor",
      "spruce_trapdoor",
      "crimson_trapdoor",
      "warped_trapdoor",
      "mangrove_trapdoor",
      "cherry_trapdoor",
    ];

    trapdoorTypes.forEach((type) => {
      if (blocks[type]) trapdoors.add(blocks[type].id);
    });

    return trapdoors;
  }

  /**
   * Initialize physics constants
   */
  _initializePhysicsConstants() {
    this.constants = {
      gravity: 0.08,
      airdrag: Math.fround(1 - 0.02),
      yawSpeed: 3.0,
      pitchSpeed: 3.0,
      playerSpeed: 0.1,
      sprintSpeed: 0.3,
      // Vanilla sneak multiplier: 0.74 of base speed (applied via attribute, not input scale)
      sneakSpeed: 0.74,
      stepHeight: 0.6,
      negligeableVelocity: 0.003,
      soulsandSpeed: 0.4,
      honeyblockSpeed: 0.4,
      honeyblockJumpSpeed: 0.4,
      ladderMaxSpeed: 0.15,
      ladderClimbSpeed: 0.2,
      scaffoldingClimbSpeed: 0.15,
      playerHalfWidth: 0.3,
      playerHeight: 1.8,
      playerSneakHeight: 1.5,
      playerCrawlHeight: 0.6,
      waterInertia: 0.8,
      swimSpeed: 0.04,
      lavaInertia: 0.5,
      liquidAcceleration: 0.02,
      airborneInertia: 0.91,
      airborneAcceleration: 0.02,
      defaultSlipperiness: 0.6,
      outOfLiquidImpulse: 0.3,
      autojumpCooldown: 10,
      bubbleColumnSurfaceDrag: {
        down: 0.03,
        maxDown: -0.9,
        up: 0.1,
        maxUp: 1.8,
      },
      bubbleColumnDrag: {
        down: 0.03,
        maxDown: -0.3,
        up: 0.06,
        maxUp: 0.7,
      },
      slowFalling: 0.125,
      movementSpeedAttribute:
        this.mcData.attributesByName.movementSpeed.resource,
      sprintingUUID: "662a6b8d-da3e-4c1c-8813-96ea6097278d",
      sneakingUUID: "1eaf83ff-7207-4596-b37a-d7a07b3ec4ce",
    };

    // Set liquid gravity based on version features
    if (this.supportFeature("independentLiquidGravity")) {
      this.constants.waterGravity = 0.02;
      this.constants.lavaGravity = 0.02;
    } else if (this.supportFeature("proportionalLiquidGravity")) {
      this.constants.waterGravity = this.constants.gravity / 16;
      this.constants.lavaGravity = this.constants.gravity / 4;
    } else {
      throw new Error("No liquid gravity settings found for this version");
    }
  }

  /**
   * Create feature support checker
   */
  _makeSupportFeature() {
    return (feature) =>
      features.some(
        ({ name, versions }) =>
          name === feature &&
          versions.includes(this.mcData.version.majorVersion),
      );
  }

  /**
   * Get player bounding box at position
   */
  getPlayerBB(pos, crawling = false, sneaking = false) {
    const w = this.constants.playerHalfWidth;
    let height = this.constants.playerHeight;

    if (crawling) height = this.constants.playerCrawlHeight;
    else if (sneaking) height = this.constants.playerSneakHeight;

    return new AABB(-w, 0, -w, w, height, w).offset(pos.x, pos.y, pos.z);
  }

  /**
   * Set position from bounding box
   */
  setPositionToBB(bb, pos) {
    pos.x = bb.minX + this.constants.playerHalfWidth;
    pos.y = bb.minY;
    pos.z = bb.minZ + this.constants.playerHalfWidth;
  }

  /**
   * Get all block bounding boxes surrounding a query bounding box
   */
  getSurroundingBBs(queryBB, playerMinY = null, descendScaffolding = false) {
    const surroundingBBs = [];
    const cursor = new Vec3(0, 0, 0);
    const feetY = playerMinY !== null ? playerMinY : queryBB.minY;

    for (
      cursor.y = Math.floor(queryBB.minY) - 1;
      cursor.y <= Math.floor(queryBB.maxY);
      cursor.y++
    ) {
      for (
        cursor.z = Math.floor(queryBB.minZ);
        cursor.z <= Math.floor(queryBB.maxZ);
        cursor.z++
      ) {
        for (
          cursor.x = Math.floor(queryBB.minX);
          cursor.x <= Math.floor(queryBB.maxX);
          cursor.x++
        ) {
          const block = this.world.getBlock(cursor);
          if (block) {
            const blockPos = block.position;
            // Scaffolding: fully passable horizontally (no X/Z shapes).
            // Two possible vertical collision surfaces:
            //
            // 1) TOP surface (y+1): always solid — standing on top lands at blockPos.y+1
            //    exactly like any full block. Suppressed only when the block directly
            //    above is also scaffolding (you climb up through a stack).
            //
            // 2) BOTTOM floor (y+0.125): only when bottom=true (unsupported scaffolding).
            //    This is a partial floor inside the block — if you enter from below
            //    your feet stop at blockPos.y+0.125. Always injected regardless of
            //    what is above, because it only affects upward movement from inside.
            if (block.type === this.specialBlocks.scaffolding) {
              const isBottom = block.getProperties().bottom;
              const isBelowPlayer = cursor.y < Math.floor(feetY);

              if (isBelowPlayer) {
                // Player is standing on or being supported by this scaffolding.
                // Always use real block.shapes
                // Exception: if player is actively sneaking to descend, suppress
                // the top surface so they can pass through downward.
                if (!descendScaffolding) {
                  for (const shape of block.shapes) {
                    const blockBB = new AABB(
                      shape[0],
                      shape[1],
                      shape[2],
                      shape[3],
                      shape[4],
                      shape[5],
                    );
                    blockBB.offset(blockPos.x, blockPos.y, blockPos.z);
                    surroundingBBs.push(blockBB);
                  }
                }
              } else {
                // Player is inside the scaffolding block — passable horizontally.
                // Only add the inner floor for bottom=true (partial floor at y+0.125).
                if (isBottom) {
                  const innerBB = new AABB(0, 0.115, 0, 1, 0.125, 1);
                  innerBB.offset(blockPos.x, blockPos.y, blockPos.z);
                  surroundingBBs.push(innerBB);
                }
              }

              continue;
            }
            for (const shape of block.shapes) {
              const blockBB = new AABB(
                shape[0],
                shape[1],
                shape[2],
                shape[3],
                shape[4],
                shape[5],
              );
              blockBB.offset(blockPos.x, blockPos.y, blockPos.z);
              surroundingBBs.push(blockBB);
            }
          }
        }
      }
    }

    return surroundingBBs;
  }

  /**
   * Adjust position height to be on ground
   */
  adjustPositionHeight(pos) {
    const playerBB = this.getPlayerBB(pos);
    const queryBB = playerBB.clone().extend(0, -1, 0);
    const surroundingBBs = this.getSurroundingBBs(queryBB);

    let dy = -1;
    for (const blockBB of surroundingBBs) {
      dy = blockBB.computeOffsetY(playerBB, dy);
    }
    pos.y += dy;
  }

  /**
   * Move entity with collision detection (internal collision function)
   */
  _moveEntityCollision(entity, dx, dy, dz) {
    const vel = entity.vel;
    const pos = entity.pos;
    const isCrawling = entity.isCrawling;
    const isSneaking =
      (entity.control.sneak && !isCrawling) || entity.trueSneaking;

    // Handle cobweb slowdown
    if (entity.isInWeb) {
      dx *= 0.25;
      dy *= 0.05;
      dz *= 0.25;
      vel.x = 0;
      vel.y = 0;
      vel.z = 0;
      entity.isInWeb = false;
    }

    let oldVelX = dx;
    const oldVelY = dy;
    let oldVelZ = dz;

    // Sneaking edge detection (not while crawling)
    if (isSneaking && entity.onGround) {
      const step = 0.05;

      for (
        ;
        dx !== 0 &&
        this.getSurroundingBBs(
          this.getPlayerBB(pos, false, true).offset(dx, 0, 0),
        ).length === 0;
        oldVelX = dx
      ) {
        if (dx < step && dx >= -step) dx = 0;
        else if (dx > 0) dx -= step;
        else dx += step;
      }

      for (
        ;
        dz !== 0 &&
        this.getSurroundingBBs(
          this.getPlayerBB(pos, false, true).offset(0, 0, dz),
        ).length === 0;
        oldVelZ = dz
      ) {
        if (dz < step && dz >= -step) dz = 0;
        else if (dz > 0) dz -= step;
        else dz += step;
      }

      while (
        dx !== 0 &&
        dz !== 0 &&
        this.getSurroundingBBs(
          this.getPlayerBB(pos, false, true).offset(dx, 0, dz),
        ).length === 0
      ) {
        if (dx < step && dx >= -step) dx = 0;
        else if (dx > 0) dx -= step;
        else dx += step;

        if (dz < step && dz >= -step) dz = 0;
        else if (dz > 0) dz -= step;
        else dz += step;

        oldVelX = dx;
        oldVelZ = dz;
      }
    }

    // Collision detection — use correct hitbox for current pose
    let playerBB = this.getPlayerBB(pos, isCrawling, isSneaking);
    const queryBB = playerBB.clone().extend(dx, dy, dz);
    const surroundingBBs = this.getSurroundingBBs(
      queryBB,
      playerBB.minY,
      entity._descendScaffolding,
    );
    const oldBB = playerBB.clone();

    for (const blockBB of surroundingBBs) {
      dy = blockBB.computeOffsetY(playerBB, dy);
    }
    playerBB.offset(0, dy, 0);

    for (const blockBB of surroundingBBs) {
      dx = blockBB.computeOffsetX(playerBB, dx);
    }
    playerBB.offset(dx, 0, 0);

    for (const blockBB of surroundingBBs) {
      dz = blockBB.computeOffsetZ(playerBB, dz);
    }
    playerBB.offset(0, 0, dz);

    // Step on block if height < stepHeight (disabled while crawling)
    if (
      !isCrawling &&
      this.constants.stepHeight > 0 &&
      (entity.onGround || (dy !== oldVelY && oldVelY < 0)) &&
      (dx !== oldVelX || dz !== oldVelZ)
    ) {
      const oldVelXCol = dx;
      const oldVelYCol = dy;
      const oldVelZCol = dz;
      const oldBBCol = playerBB.clone();

      dy = this.constants.stepHeight;
      const queryBB = oldBB.clone().extend(oldVelX, dy, oldVelZ);
      const surroundingBBs = this.getSurroundingBBs(queryBB, oldBB.minY);

      const BB1 = oldBB.clone();
      const BB2 = oldBB.clone();
      const BB_XZ = BB1.clone().extend(dx, 0, dz);

      let dy1 = dy;
      let dy2 = dy;
      for (const blockBB of surroundingBBs) {
        dy1 = blockBB.computeOffsetY(BB_XZ, dy1);
        dy2 = blockBB.computeOffsetY(BB2, dy2);
      }
      BB1.offset(0, dy1, 0);
      BB2.offset(0, dy2, 0);

      let dx1 = oldVelX;
      let dx2 = oldVelX;
      for (const blockBB of surroundingBBs) {
        dx1 = blockBB.computeOffsetX(BB1, dx1);
        dx2 = blockBB.computeOffsetX(BB2, dx2);
      }
      BB1.offset(dx1, 0, 0);
      BB2.offset(dx2, 0, 0);

      let dz1 = oldVelZ;
      let dz2 = oldVelZ;
      for (const blockBB of surroundingBBs) {
        dz1 = blockBB.computeOffsetZ(BB1, dz1);
        dz2 = blockBB.computeOffsetZ(BB2, dz2);
      }
      BB1.offset(0, 0, dz1);
      BB2.offset(0, 0, dz2);

      const norm1 = dx1 * dx1 + dz1 * dz1;
      const norm2 = dx2 * dx2 + dz2 * dz2;

      if (norm1 > norm2) {
        dx = dx1;
        dy = -dy1;
        dz = dz1;
        playerBB = BB1;
      } else {
        dx = dx2;
        dy = -dy2;
        dz = dz2;
        playerBB = BB2;
      }

      for (const blockBB of surroundingBBs) {
        dy = blockBB.computeOffsetY(playerBB, dy);
      }
      playerBB.offset(0, dy, 0);

      if (
        oldVelXCol * oldVelXCol + oldVelZCol * oldVelZCol >=
        dx * dx + dz * dz
      ) {
        dx = oldVelXCol;
        dy = oldVelYCol;
        dz = oldVelZCol;
        playerBB = oldBBCol;
      }
    }

    // Update flags
    this.setPositionToBB(playerBB, pos);
    entity.isCollidedHorizontally = dx !== oldVelX || dz !== oldVelZ;
    entity.isCollidedVertically = dy !== oldVelY;
    entity.onGround = entity.isCollidedVertically && oldVelY < 0;

    const blockAtFeet = this.world.getBlock(pos.offset(0, -0.2, 0));

    if (dx !== oldVelX) vel.x = 0;
    if (dz !== oldVelZ) vel.z = 0;
    if (dy !== oldVelY) {
      if (
        blockAtFeet &&
        blockAtFeet.type === this.specialBlocks.slime &&
        !entity.control.sneak
      ) {
        vel.y = -vel.y;
      } else {
        vel.y = 0;
      }
    }

    // Apply block collisions (web, soulsand, honey, bubble column)
    playerBB.contract(0.001, 0.001, 0.001);
    const cursor = new Vec3(0, 0, 0);
    for (
      cursor.y = Math.floor(playerBB.minY);
      cursor.y <= Math.floor(playerBB.maxY);
      cursor.y++
    ) {
      for (
        cursor.z = Math.floor(playerBB.minZ);
        cursor.z <= Math.floor(playerBB.maxZ);
        cursor.z++
      ) {
        for (
          cursor.x = Math.floor(playerBB.minX);
          cursor.x <= Math.floor(playerBB.maxX);
          cursor.x++
        ) {
          const block = this.world.getBlock(cursor);
          if (block) {
            if (this.supportFeature("velocityBlocksOnCollision")) {
              if (block.type === this.specialBlocks.soulsand) {
                vel.x *= this.constants.soulsandSpeed;
                vel.z *= this.constants.soulsandSpeed;
              } else if (block.type === this.specialBlocks.honeyblock) {
                vel.x *= this.constants.honeyblockSpeed;
                vel.z *= this.constants.honeyblockSpeed;
              }
            }
            if (block.type === this.specialBlocks.web) {
              entity.isInWeb = true;
            } else if (block.type === this.specialBlocks.bubbleColumn) {
              const down = !block.metadata;
              const aboveBlock = this.world.getBlock(cursor.offset(0, 1, 0));
              const bubbleDrag =
                aboveBlock && aboveBlock.type === 0
                  ? this.constants.bubbleColumnSurfaceDrag
                  : this.constants.bubbleColumnDrag;
              if (down) {
                vel.y = Math.max(bubbleDrag.maxDown, vel.y - bubbleDrag.down);
              } else {
                vel.y = Math.min(bubbleDrag.maxUp, vel.y + bubbleDrag.up);
              }
            }
          }
        }
      }
    }

    if (this.supportFeature("velocityBlocksOnTop")) {
      const blockBelow = this.world.getBlock(
        entity.pos.floored().offset(0, -0.5, 0),
      );
      if (blockBelow) {
        if (blockBelow.type === this.specialBlocks.soulsand) {
          vel.x *= this.constants.soulsandSpeed;
          vel.z *= this.constants.soulsandSpeed;
        } else if (blockBelow.type === this.specialBlocks.honeyblock) {
          vel.x *= this.constants.honeyblockSpeed;
          vel.z *= this.constants.honeyblockSpeed;
        }
      }
    }
  }

  /**
   * Get looking direction vector
   */
  _getLookingVector(entity) {
    const { yaw, pitch } = entity;
    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    const sinPitch = Math.sin(pitch);
    const cosPitch = Math.cos(pitch);
    const lookX = -sinYaw * cosPitch;
    const lookY = sinPitch;
    const lookZ = -cosYaw * cosPitch;
    const lookDir = new Vec3(lookX, lookY, lookZ);

    return {
      yaw,
      pitch,
      sinYaw,
      cosYaw,
      sinPitch,
      cosPitch,
      lookX,
      lookY,
      lookZ,
      lookDir,
    };
  }

  /**
   * Apply heading to velocity
   */
  _applyHeading(entity, strafe, forward, multiplier) {
    let speed = Math.sqrt(strafe * strafe + forward * forward);
    if (speed < 0.01) return new Vec3(0, 0, 0);

    speed = multiplier / Math.max(speed, 1);

    strafe *= speed;
    forward *= speed;

    const yaw = Math.PI - entity.yaw;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);

    const vel = entity.vel;
    vel.x -= strafe * cos + forward * sin;
    vel.z += forward * cos - strafe * sin;
  }

  /**
   * Check if on ladder
   */
  _isOnLadder(pos) {
    const block = this.world.getBlock(pos);

    if (!block) return false;

    if (
      block.type === this.specialBlocks.ladder ||
      block.type === this.specialBlocks.vine
    ) {
      return true;
    }

    if (
      this.supportFeature("climbableTrapdoor") &&
      this.trapdoorIds.has(block.type)
    ) {
      const blockBelow = this.world.getBlock(pos.offset(0, -1, 0));
      if (!blockBelow || blockBelow.type !== this.specialBlocks.ladder)
        return false;

      const blockProperties = block._properties;
      if (!blockProperties.open) return false;
      if (blockProperties.facing !== blockBelow.getProperties().facing)
        return false;

      return true;
    }

    return false;
  }

  /**
   * Check if inside or standing on top of scaffolding
   */
  _isOnScaffolding(pos, onGround = false) {
    if (this.specialBlocks.scaffolding === -1) return false;
    // Inside the scaffolding block (climbing)
    const block = this.world.getBlock(pos);
    if (block?.type === this.specialBlocks.scaffolding) return true;
    // Standing on top: feet are at blockPos.y+1 so check the block below
    if (onGround) {
      const blockBelow = this.world.getBlock(pos.offset(0, -1, 0));
      if (blockBelow?.type === this.specialBlocks.scaffolding) return true;
    }
    return false;
  }

  /**
   * Check if position doesn't collide
   */
  _doesNotCollide(pos) {
    const pBB = this.getPlayerBB(pos);
    return (
      !this.getSurroundingBBs(pBB).some((x) => pBB.intersects(x)) &&
      this._getWaterInBB(pBB).length === 0
    );
  }

  /**
   * Get rendered depth of liquid block
   */
  _getRenderedDepth(block) {
    if (!block) return -1;
    if (this.waterLike.has(block.type)) return 0;
    if (block.isWaterlogged) return 0;
    if (!this.waterIds.includes(block.type)) return -1;
    const meta = block.metadata;
    return meta >= 8 ? 0 : meta;
  }

  /**
   * Get liquid height percent
   */
  _getLiquidHeightPcent(block) {
    return (this._getRenderedDepth(block) + 1) / 9;
  }

  /**
   * Get flow vector for liquid
   */
  _getFlow(block) {
    const curlevel = this._getRenderedDepth(block);
    const flow = new Vec3(0, 0, 0);

    for (const [dx, dz] of [
      [0, 1],
      [-1, 0],
      [0, -1],
      [1, 0],
    ]) {
      const adjBlock = this.world.getBlock(block.position.offset(dx, 0, dz));
      const adjLevel = this._getRenderedDepth(adjBlock);

      if (adjLevel < 0) {
        if (adjBlock && adjBlock.boundingBox !== "empty") {
          const adjLevel = this._getRenderedDepth(
            this.world.getBlock(block.position.offset(dx, -1, dz)),
          );
          if (adjLevel >= 0) {
            const f = adjLevel - (curlevel - 8);
            flow.x += dx * f;
            flow.z += dz * f;
          }
        }
      } else {
        const f = adjLevel - curlevel;
        flow.x += dx * f;
        flow.z += dz * f;
      }
    }

    if (block.metadata >= 8) {
      for (const [dx, dz] of [
        [0, 1],
        [-1, 0],
        [0, -1],
        [1, 0],
      ]) {
        const adjBlock = this.world.getBlock(block.position.offset(dx, 0, dz));
        const adjUpBlock = this.world.getBlock(
          block.position.offset(dx, 1, dz),
        );
        if (
          (adjBlock && adjBlock.boundingBox !== "empty") ||
          (adjUpBlock && adjUpBlock.boundingBox !== "empty")
        ) {
          flow.normalize().translate(0, -6, 0);
        }
      }
    }

    return flow.normalize();
  }

  /**
   * Get water blocks in bounding box
   */
  _getWaterInBB(bb) {
    const waterBlocks = [];
    const cursor = new Vec3(0, 0, 0);

    for (
      cursor.y = Math.floor(bb.minY);
      cursor.y <= Math.floor(bb.maxY);
      cursor.y++
    ) {
      for (
        cursor.z = Math.floor(bb.minZ);
        cursor.z <= Math.floor(bb.maxZ);
        cursor.z++
      ) {
        for (
          cursor.x = Math.floor(bb.minX);
          cursor.x <= Math.floor(bb.maxX);
          cursor.x++
        ) {
          const block = this.world.getBlock(cursor);
          if (
            block &&
            (this.waterIds.includes(block.type) ||
              this.waterLike.has(block.type) ||
              block.isWaterlogged)
          ) {
            const waterLevel = cursor.y + 1 - this._getLiquidHeightPcent(block);
            if (Math.ceil(bb.maxY) >= waterLevel) waterBlocks.push(block);
          }
        }
      }
    }
    return waterBlocks;
  }

  /**
   * Check if in water and apply current
   */
  _isInWaterApplyCurrent(bb, vel) {
    const acceleration = new Vec3(0, 0, 0);
    const waterBlocks = this._getWaterInBB(bb);
    const isInWater = waterBlocks.length > 0;

    for (const block of waterBlocks) {
      const flow = this._getFlow(block);
      acceleration.add(flow);
    }

    const len = acceleration.norm();
    if (len > 0) {
      vel.x += (acceleration.x / len) * 0.014;
      vel.y += (acceleration.y / len) * 0.014;
      vel.z += (acceleration.z / len) * 0.014;
    }
    return isInWater;
  }

  /**
   * Check if in material
   */
  _isMaterialInBB(queryBB, types) {
    const cursor = new Vec3(0, 0, 0);

    for (
      cursor.y = Math.floor(queryBB.minY);
      cursor.y <= Math.floor(queryBB.maxY);
      cursor.y++
    ) {
      for (
        cursor.z = Math.floor(queryBB.minZ);
        cursor.z <= Math.floor(queryBB.maxZ);
        cursor.z++
      ) {
        for (
          cursor.x = Math.floor(queryBB.minX);
          cursor.x <= Math.floor(queryBB.maxX);
          cursor.x++
        ) {
          const block = this.world.getBlock(cursor);
          if (block && types.includes(block.type)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Move entity based on strafe and forward input
   */
  _moveEntityWithHeading(entity, strafe, forward) {
    const vel = entity.vel;
    const pos = entity.pos;
    const isCrawling = entity.isCrawling;
    const isSneaking =
      (entity.control.sneak && !isCrawling) || entity.trueSneaking;

    const gravityMultiplier =
      vel.y <= 0 && entity.slowFalling > 0 ? this.constants.slowFalling : 1;

    if (entity.isInWater || entity.isInLava) {
      // Water / Lava movement
      const lastY = pos.y;
      let acceleration = this.constants.liquidAcceleration;
      const inertia = entity.isInWater
        ? this.constants.waterInertia
        : this.constants.lavaInertia;
      let horizontalInertia = inertia;

      if (entity.isInWater) {
        let strider = Math.min(entity.depthStrider, 3);
        if (!entity.onGround) {
          strider *= 0.5;
        }
        if (strider > 0) {
          horizontalInertia += ((0.546 - horizontalInertia) * strider) / 3;
          acceleration += ((0.7 - acceleration) * strider) / 3;
        }

        if (entity.dolphinsGrace > 0) horizontalInertia = 0.96;
      }

      // Swimming pose: move in look direction including pitch
      if (entity.isSwimmingPose && entity.isInWater) {
        const { lookDir } = this._getLookingVector(entity);
        const swimAccel = this.constants.swimSpeed;

        // Apply vertical component from pitch
        if (entity.control.forward) {
          vel.y += lookDir.y * swimAccel * 0.5;
        }

        // Sneak = sink, jump = rise
        if (entity.control.sneak) {
          vel.y -= swimAccel;
        }
        if (entity.control.jump) {
          vel.y += swimAccel;
        }

        // Boost horizontal speed while swimming
        acceleration = this.constants.swimSpeed;
      }

      this._applyHeading(entity, strafe, forward, acceleration);
      this._moveEntityCollision(entity, vel.x, vel.y, vel.z);
      vel.y *= inertia;
      vel.y -=
        (entity.isInWater
          ? this.constants.waterGravity
          : this.constants.lavaGravity) * gravityMultiplier;
      vel.x *= horizontalInertia;
      vel.z *= horizontalInertia;

      if (
        entity.isCollidedHorizontally &&
        this._doesNotCollide(
          pos.offset(vel.x, vel.y + 0.6 - pos.y + lastY, vel.z),
        )
      ) {
        vel.y = this.constants.outOfLiquidImpulse;
      }
    } else if (entity.elytraFlying) {
      // Elytra flying
      const { pitch, sinPitch, cosPitch, lookDir } =
        this._getLookingVector(entity);
      const horizontalSpeed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
      const cosPitchSquared = cosPitch * cosPitch;

      vel.y +=
        this.constants.gravity *
        gravityMultiplier *
        (-1.0 + cosPitchSquared * 0.75);

      if (vel.y < 0.0 && cosPitch > 0.0) {
        const movingDownSpeedModifier = vel.y * -0.1 * cosPitchSquared;
        vel.x += (lookDir.x * movingDownSpeedModifier) / cosPitch;
        vel.y += movingDownSpeedModifier;
        vel.z += (lookDir.z * movingDownSpeedModifier) / cosPitch;
      }

      if (pitch < 0.0 && cosPitch > 0.0) {
        const lookDownSpeedModifier = horizontalSpeed * -sinPitch * 0.04;
        vel.x += (-lookDir.x * lookDownSpeedModifier) / cosPitch;
        vel.y += lookDownSpeedModifier * 3.2;
        vel.z += (-lookDir.z * lookDownSpeedModifier) / cosPitch;
      }

      if (cosPitch > 0.0) {
        vel.x += ((lookDir.x / cosPitch) * horizontalSpeed - vel.x) * 0.1;
        vel.z += ((lookDir.z / cosPitch) * horizontalSpeed - vel.z) * 0.1;
      }

      vel.x *= 0.99;
      vel.y *= 0.98;
      vel.z *= 0.99;
      this._moveEntityCollision(entity, vel.x, vel.y, vel.z);

      if (entity.onGround) {
        entity.elytraFlying = false;
      }
    } else {
      // Normal movement
      let acceleration = 0.0;
      let inertia = 0.0;
      const blockUnder = this.world.getBlock(pos.offset(0, -1, 0));

      if (entity.onGround && blockUnder) {
        // Clone so we never mutate the live bot.entity.attributes object
        let playerSpeedAttribute = entity.attributes?.[
          this.constants.movementSpeedAttribute
        ]
          ? JSON.parse(
              JSON.stringify(
                entity.attributes[this.constants.movementSpeedAttribute],
              ),
            )
          : attribute.createAttributeValue(this.constants.playerSpeed);

        // Remove sprint/sneak modifiers before re-applying
        playerSpeedAttribute = attribute.deleteAttributeModifier(
          playerSpeedAttribute,
          this.constants.sprintingUUID,
        );
        playerSpeedAttribute = attribute.deleteAttributeModifier(
          playerSpeedAttribute,
          this.constants.sneakingUUID,
        );

        // Apply Speed / Slowness effects
        if (entity.speed > 0) {
          playerSpeedAttribute = attribute.addAttributeModifier(
            playerSpeedAttribute,
            {
              uuid: "91AEAA56-376B-4498-935B-2F7F68070635",
              amount: 0.2 * entity.speed,
              operation: 2,
            },
          );
        }
        if (entity.slowness > 0) {
          playerSpeedAttribute = attribute.addAttributeModifier(
            playerSpeedAttribute,
            {
              uuid: "7107DE5E-7CE8-4030-940E-514C1F160890",
              amount: -0.15 * entity.slowness,
              operation: 2,
            },
          );
        }

        // Client-side sprinting modifier
        if (entity.control.sprint) {
          if (
            !attribute.checkAttributeModifier(
              playerSpeedAttribute,
              this.constants.sprintingUUID,
            )
          ) {
            playerSpeedAttribute = attribute.addAttributeModifier(
              playerSpeedAttribute,
              {
                uuid: this.constants.sprintingUUID,
                amount: this.constants.sprintSpeed,
                operation: 2,
              },
            );
          }
        }

        // Sneaking or crawling speed modifier (same reduction in vanilla)
        if (isSneaking || isCrawling) {
          playerSpeedAttribute = attribute.addAttributeModifier(
            playerSpeedAttribute,
            {
              uuid: this.constants.sneakingUUID,
              amount: -0.7, // operation 1 on base: 0.1 * (1 - 0.7) = 0.03, matches vanilla sneak speed
              operation: 1,
            },
          );
        }

        const attributeSpeed =
          attribute.getAttributeValue(playerSpeedAttribute);
        inertia =
          (this.blockSlipperiness[blockUnder.type] ||
            this.constants.defaultSlipperiness) * 0.91;
        acceleration =
          attributeSpeed * (0.1627714 / (inertia * inertia * inertia));
        if (acceleration < 0) acceleration = 0;
      } else {
        acceleration = this.constants.airborneAcceleration;
        inertia = this.constants.airborneInertia;

        if (entity.control.sprint) {
          const airSprintFactor = this.constants.airborneAcceleration * 0.3;
          acceleration += airSprintFactor;
        }
      }

      this._applyHeading(entity, strafe, forward, acceleration);

      if (this._isOnLadder(pos)) {
        vel.x = clamp(
          -this.constants.ladderMaxSpeed,
          vel.x,
          this.constants.ladderMaxSpeed,
        );
        vel.z = clamp(
          -this.constants.ladderMaxSpeed,
          vel.z,
          this.constants.ladderMaxSpeed,
        );
        vel.y = Math.max(
          vel.y,
          entity.control.sneak ? 0 : -this.constants.ladderMaxSpeed,
        );
      }

      // Scaffolding: sneak to descend, jump to ascend, otherwise slow fall
      const onScaffolding = this._isOnScaffolding(pos, entity.onGround);
      if (onScaffolding) {
        vel.x = clamp(
          -this.constants.ladderMaxSpeed,
          vel.x,
          this.constants.ladderMaxSpeed,
        );
        vel.z = clamp(
          -this.constants.ladderMaxSpeed,
          vel.z,
          this.constants.ladderMaxSpeed,
        );
        if (entity.control.sneak) {
          // Sneak while on scaffolding = descend
          vel.y = -this.constants.scaffoldingClimbSpeed;
        } else if (entity.control.jump) {
          // Jump while on scaffolding = ascend
          vel.y = this.constants.scaffoldingClimbSpeed;
        } else {
          // Slow fall through scaffolding
          vel.y = Math.max(vel.y, -this.constants.scaffoldingClimbSpeed);
        }
      }

      // Flag for getSurroundingBBs: suppress scaffolding top surface so player
      // can descend through it when sneaking on top.
      entity._descendScaffolding = onScaffolding && entity.control.sneak;

      this._moveEntityCollision(entity, vel.x, vel.y, vel.z);

      if (
        this._isOnLadder(pos) &&
        (entity.isCollidedHorizontally ||
          (this.supportFeature("climbUsingJump") && entity.control.jump))
      ) {
        vel.y = this.constants.ladderClimbSpeed;
      }

      // Apply friction and gravity
      if (entity.levitation > 0) {
        vel.y += (0.05 * entity.levitation - vel.y) * 0.2;
      } else {
        vel.y -= this.constants.gravity * gravityMultiplier;
      }
      vel.y *= this.constants.airdrag;
      vel.x *= inertia;
      vel.z *= inertia;
    }
  }

  /**
   * Main simulation step
   */
  simulatePlayer(entity) {
    const vel = entity.vel;
    const pos = entity.pos;
    const isCrawling = entity.isCrawling;
    const isSneaking =
      (entity.control.sneak && !isCrawling) || entity.trueSneaking;

    // Swimming uses crawl hitbox (0.6 height horizontal)
    const isSwimming = entity.isSwimmingPose && entity.isInWater;
    const useCrawlBB = isCrawling || isSwimming;

    // Use correct bounding box for pose
    const waterBB = this.getPlayerBB(pos, useCrawlBB, isSneaking).contract(
      0.001,
      0.401,
      0.001,
    );
    const lavaBB = this.getPlayerBB(pos, useCrawlBB, isSneaking).contract(
      0.1,
      0.4,
      0.1,
    );

    entity.isInWater = this._isInWaterApplyCurrent(waterBB, vel);
    entity.isInLava = this._isMaterialInBB(lavaBB, this.lavaIds);

    // Reset velocity component if it falls under threshold
    if (Math.abs(vel.x) < this.constants.negligeableVelocity) vel.x = 0;
    if (Math.abs(vel.y) < this.constants.negligeableVelocity) vel.y = 0;
    if (Math.abs(vel.z) < this.constants.negligeableVelocity) vel.z = 0;

    // Handle jumping (can't jump while crawling)
    if (!isCrawling) {
      this._handleJumping(entity);
    }

    // Calculate movement input (no sprinting while crawling)
    let strafe = (entity.control.right - entity.control.left) * 0.98;
    let forward = (entity.control.forward - entity.control.back) * 0.98;

    // Handle elytra flying
    this._handleElytraFlying(entity);

    // Move with heading
    this._moveEntityWithHeading(entity, strafe, forward);

    return entity;
  }

  /**
   * Handle jumping logic
   */
  _handleJumping(entity) {
    if (entity.control.jump || entity.jumpQueued) {
      if (entity.jumpTicks > 0) entity.jumpTicks--;

      if (entity.isInWater || entity.isInLava) {
        entity.vel.y += 0.04;
      } else if (entity.onGround && entity.jumpTicks === 0) {
        const blockBelow = this.world.getBlock(
          entity.pos.floored().offset(0, -0.5, 0),
        );
        const jumpMultiplier =
          blockBelow && blockBelow.type === this.specialBlocks.honeyblock
            ? this.constants.honeyblockJumpSpeed
            : 1;

        entity.vel.y = Math.fround(0.42) * jumpMultiplier;

        if (entity.jumpBoost > 0) {
          entity.vel.y += 0.1 * entity.jumpBoost;
        }

        if (entity.control.sprint) {
          const yaw = Math.PI - entity.yaw;
          entity.vel.x -= Math.sin(yaw) * 0.2;
          entity.vel.z += Math.cos(yaw) * 0.2;
        }

        entity.jumpTicks = this.constants.autojumpCooldown;
      }
    } else {
      entity.jumpTicks = 0;
    }

    entity.jumpQueued = false;
  }

  /**
   * Handle elytra flying physics
   */
  _handleElytraFlying(entity) {
    entity.elytraFlying =
      entity.elytraFlying &&
      entity.elytraEquipped &&
      !entity.onGround &&
      !entity.levitation;

    if (entity.fireworkRocketDuration > 0) {
      if (!entity.elytraFlying) {
        entity.fireworkRocketDuration = 0;
      } else {
        const { lookDir } = this._getLookingVector(entity);
        entity.vel.x +=
          lookDir.x * 0.1 + (lookDir.x * 1.5 - entity.vel.x) * 0.5;
        entity.vel.y +=
          lookDir.y * 0.1 + (lookDir.y * 1.5 - entity.vel.y) * 0.5;
        entity.vel.z +=
          lookDir.z * 0.1 + (lookDir.z * 1.5 - entity.vel.z) * 0.5;
        entity.fireworkRocketDuration--;
      }
    }
  }
}

/**
 * Player state class for managing entity state
 */
class PlayerState {
  constructor(bot, control) {
    const mcData = require("minecraft-data")(bot.version);
    const nbt = require("prismarine-nbt");

    // Position and velocity
    this.pos = bot.entity.position.clone();
    this.vel = bot.entity.velocity.clone();

    // State flags
    this.onGround = bot.entity.onGround;
    this.isInWater = bot.entity.isInWater;
    this.isInLava = bot.entity.isInLava;
    this.isInWeb = bot.entity.isInWeb;
    this.isCollidedHorizontally = bot.entity.isCollidedHorizontally;
    this.isCollidedVertically = bot.entity.isCollidedVertically;
    this.elytraFlying = bot.entity.elytraFlying;

    // Crawling / pose state from server-confirmed metadata
    this.isCrawling = bot.entity.isCrawling ?? false;
    this.isSwimmingPose = bot.entity.isSwimmingPose ?? false;
    this.trueSneaking = bot.entity.serverSideSneaking ?? false;

    // Jump state
    this.jumpTicks = bot.jumpTicks;
    this.jumpQueued = bot.jumpQueued;
    this.fireworkRocketDuration = bot.fireworkRocketDuration;

    // Input
    this.attributes = bot.entity.attributes;
    this.yaw = bot.entity.yaw;
    this.pitch = bot.entity.pitch;
    this.control = control;

    // Effects
    this._loadEffects(bot, mcData);

    // Enchantments
    this._loadEnchantments(bot, mcData, nbt);

    // Equipment
    this._loadEquipment(bot);
  }

  /**
   * Load effect levels from bot
   */
  _loadEffects(bot, mcData) {
    const effects = bot.entity.effects;

    this.jumpBoost = getEffectLevel(mcData, "JumpBoost", effects);
    this.speed = getEffectLevel(mcData, "Speed", effects);
    this.slowness = getEffectLevel(mcData, "Slowness", effects);
    this.dolphinsGrace = getEffectLevel(mcData, "DolphinsGrace", effects);
    this.slowFalling = getEffectLevel(mcData, "SlowFalling", effects);
    this.levitation = getEffectLevel(mcData, "Levitation", effects);
  }

  /**
   * Load enchantments from armor
   */
  _loadEnchantments(bot, mcData, nbt) {
    const boots = bot.inventory.slots[8];

    if (boots && boots.nbt) {
      const simplifiedNbt = nbt.simplify(boots.nbt);
      const enchantments =
        simplifiedNbt.Enchantments ?? simplifiedNbt.ench ?? [];
      this.depthStrider = getEnchantmentLevel(
        mcData,
        "depth_strider",
        enchantments,
      );
    } else {
      this.depthStrider = 0;
    }
  }

  /**
   * Load equipment info
   */
  _loadEquipment(bot) {
    const chestplate = bot.inventory.slots[6];
    this.elytraEquipped = chestplate != null && chestplate.name === "elytra";
  }

  /**
   * Apply this state to a bot
   */
  apply(bot) {
    bot.entity.position = this.pos;
    bot.entity.velocity = this.vel;
    bot.entity.onGround = this.onGround;
    bot.entity.isInWater = this.isInWater;
    bot.entity.isInLava = this.isInLava;
    bot.entity.isInWeb = this.isInWeb;
    bot.entity.isCollidedHorizontally = this.isCollidedHorizontally;
    bot.entity.isCollidedVertically = this.isCollidedVertically;
    bot.entity.elytraFlying = this.elytraFlying;
    bot.jumpTicks = this.jumpTicks;
    bot.jumpQueued = this.jumpQueued;
    bot.fireworkRocketDuration = this.fireworkRocketDuration;
  }
}

function getEffectLevel(mcData, effectName, effects) {
  const effectDescriptor = mcData.effectsByName[effectName];
  if (!effectDescriptor) return 0;

  const effectInfo = effects[effectDescriptor.id];
  if (!effectInfo) return 0;

  return effectInfo.amplifier + 1;
}

function getEnchantmentLevel(mcData, enchantmentName, enchantments) {
  const enchantmentDescriptor = mcData.enchantmentsByName[enchantmentName];
  if (!enchantmentDescriptor) return 0;

  for (const enchInfo of enchantments) {
    if (typeof enchInfo.id === "string") {
      if (enchInfo.id.includes(enchantmentName)) {
        return enchInfo.lvl;
      }
    } else if (enchInfo.id === enchantmentDescriptor.id) {
      return enchInfo.lvl;
    }
  }

  return 0;
}

module.exports = { PhysicsEngine, PlayerState };
