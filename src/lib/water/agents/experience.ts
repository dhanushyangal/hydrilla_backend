/**
 * Experience v0 — camera framing + named sockets. Pose stays static (no userData.tick).
 */

export type ExperienceV0 = {
  sockets: string[];
  camera: { position: [number, number, number]; target: [number, number, number]; fov: number };
  selectToAgent: true;
  idleTick: false;
};

export function experienceV0(params: {
  sockets?: string[];
  camera?: ExperienceV0["camera"];
}): ExperienceV0 {
  return {
    sockets: params.sockets || ["root"],
    camera: params.camera || {
      position: [2.4, 1.6, 2.8],
      target: [0, 0.4, 0],
      fov: 45,
    },
    selectToAgent: true,
    idleTick: false,
  };
}
