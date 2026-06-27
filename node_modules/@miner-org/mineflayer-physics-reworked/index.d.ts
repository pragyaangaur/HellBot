import { PhysicsEngine } from "./src/engine";

interface ControlState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sneak: boolean;
}

declare module "@miner-org/mineflayer-physics-reworked" {
  export default function inject(bot: Bot): void;
}

declare module "mineflayer" {
  interface Bot {
    ashPhysics: PhysicsEngine;
    ashPhysicsEnabled: boolean;
    ashControlState: ControlState;
    ashGetControlState(): ControlState;
    ashClearControlStates(): void;
    ashSetControlState(
      control: "forward" | "back" | "left" | "right" | "jump" | "sneak",
      value: boolean,
    ): void;
  }
}
