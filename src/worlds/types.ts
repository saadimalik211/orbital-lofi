export type WorldBackdropId = "orbital-station" | "neon-city";

export interface World {
  id: string;
  name: string;
  year: number;
  backdrop: WorldBackdropId;
  backgroundVideo?: string;
  musicPrompt: string;
}